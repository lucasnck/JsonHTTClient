#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{
  io::{BufRead, BufReader, Write},
  path::{Path, PathBuf},
  process::{Child, ChildStdin, Command, Stdio},
  sync::Mutex,
  thread,
};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

struct SidecarProcess {
  child: Child,
  input: ChildStdin,
}
#[derive(Default)]
struct DesktopHost {
  process: Mutex<Option<SidecarProcess>>,
}

fn node_binary(app: &AppHandle) -> Result<PathBuf, String> {
  #[cfg(debug_assertions)]
  { let _ = app; Ok(PathBuf::from("node")) }
  #[cfg(not(debug_assertions))]
  {
    let root = app.path().resource_dir().map_err(|_| "RESOURCE_DIR_UNAVAILABLE")?;
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let bin = root.join("runtime").join(name);
    if !bin.is_file() { return Err("BUNDLED_NODE_MISSING".into()); }
    Ok(bin)
  }
}
fn sidecar_entry(app: &AppHandle) -> Result<PathBuf, String> {
  #[cfg(debug_assertions)]
  {
    let _ = app;
    Ok(Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("../../../dist/apps/desktop/src/sidecar.js"))
  }
  #[cfg(not(debug_assertions))]
  {
    let root = app.path().resource_dir().map_err(|_| "RESOURCE_DIR_UNAVAILABLE")?;
    Ok(root.join("dist/apps/desktop/src/sidecar.js"))
  }
}
fn start_sidecar(app: &AppHandle, workspace: &Path) -> Result<SidecarProcess, String> {
  let root = workspace.canonicalize().map_err(|_| "WORKSPACE_UNAVAILABLE")?;
  if !root.is_dir() {return Err("WORKSPACE_NOT_DIRECTORY".into());}
  let app_data = app.path().app_data_dir().map_err(|_| "APP_DATA_UNAVAILABLE")?;
  std::fs::create_dir_all(&app_data).map_err(|_| "APP_DATA_NOT_WRITABLE")?;
  let executable = node_binary(app)?;
  let script = sidecar_entry(app)?;
  if !script.is_file() {return Err("SIDECAR_NOT_COMPILED".into());}
  // Browser webview receives only message-based Tauri commands. The engine is
  // a host child process, not an HTTP service or an independently installed CLI.
  let mut child = Command::new(executable)
    .arg(script)
    .arg("--root").arg(root)
    .arg("--app-data").arg(app_data)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn().map_err(|_| "SIDECAR_START_FAILED")?;
  let input = child.stdin.take().ok_or("SIDECAR_STDIN_UNAVAILABLE")?;
  let output = child.stdout.take().ok_or("SIDECAR_STDOUT_UNAVAILABLE")?;
  let handle = app.clone();
  thread::spawn(move || {
    for line in BufReader::new(output).lines() {
      let Ok(raw) = line else {break};
      // Never echo invalid/error payloads into a privileged command.
      if raw.len()>2*1024*1024 {continue;}
      if let Ok(message) = serde_json::from_str::<Value>(&raw) {
        let _=handle.emit("desktop-message", message);
      }
    }
    let _=handle.emit("desktop-disconnected", Value::Null);
  });
  Ok(SidecarProcess {child,input})
}

#[tauri::command]
async fn desktop_choose_workspace(app: AppHandle, state: State<'_, DesktopHost>) -> Result<Option<String>, String> {
  // Workspace consent is owned by an OS-native directory picker.
  let picked = tauri::async_runtime::spawn_blocking(||rfd::FileDialog::new().pick_folder())
    .await.map_err(|_| "NATIVE_DIALOG_FAILED")?;
  let Some(path) = picked else {return Ok(None)};
  let physical = path.canonicalize().map_err(|_| "WORKSPACE_UNAVAILABLE")?;
  let process = start_sidecar(&app,&physical)?;
  let mut guard = state.process.lock().map_err(|_| "SIDECAR_LOCK_ERROR")?;
  if let Some(mut current) = guard.take() {let _=current.child.kill();let _=current.child.wait();}
  *guard = Some(process);
  Ok(Some(physical.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn desktop_choose_save_file() -> Result<Option<String>, String> {
  // Sidecar enforces authorized workspace root and rejects existing files.
  // An explicit native chooser does not grant broad filesystem write access.
  let path = tauri::async_runtime::spawn_blocking(||rfd::FileDialog::new()
    .add_filter("JSON", &["json"])
    .save_file())
    .await.map_err(|_| "NATIVE_DIALOG_FAILED")?;
  Ok(path.map(|p|p.to_string_lossy().into_owned()))
}

#[tauri::command]
fn desktop_send(state: State<'_, DesktopHost>, packet: Value) -> Result<(), String> {
  let Some(obj) = packet.as_object() else {return Err("INVALID_PACKET".into())};
  let Some(id) = obj.get("id").and_then(Value::as_str) else {return Err("INVALID_PACKET".into())};
  let Some(op) = obj.get("op").and_then(Value::as_str) else {return Err("INVALID_PACKET".into())};
  if id.len()>90 || !id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_') {
    return Err("INVALID_PACKET".into());
  }
  const OPERATIONS:&[&str]=&[
    "restore","state","list","open","edit","select","run","stop","close",
    "saveAs","importPreview","importApply","activateVariables","deactivateVariables",
  ];
  if !OPERATIONS.contains(&op){return Err("INVALID_OPERATION".into());}
  let serialized=serde_json::to_string(&packet).map_err(|_| "INVALID_JSON")?;
  if serialized.len()>2*1024*1024 {return Err("PACKET_TOO_LARGE".into());}
  let mut guard=state.process.lock().map_err(|_| "SIDECAR_LOCK_ERROR")?;
  let Some(sidecar)=guard.as_mut() else {return Err("OPEN_WORKSPACE_FIRST".into())};
  sidecar.input.write_all(serialized.as_bytes()).map_err(|_| "SIDECAR_DISCONNECTED")?;
  sidecar.input.write_all(b"\n").map_err(|_| "SIDECAR_DISCONNECTED")?;
  sidecar.input.flush().map_err(|_| "SIDECAR_DISCONNECTED")?;
  Ok(())
}

fn main() {
  tauri::Builder::default()
    .manage(DesktopHost::default())
    .invoke_handler(tauri::generate_handler![
      desktop_choose_workspace,
      desktop_choose_save_file,
      desktop_send,
    ])
    .on_window_event(|window,event| {
      if let tauri::WindowEvent::Destroyed = event {
        let state = window.state::<DesktopHost>();
        if let Ok(mut guard) = state.process.lock() {
          if let Some(mut current) = guard.take() {
            let _=current.child.kill();let _=current.child.wait();
          }
        }
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running JSON HTTP Client desktop");
}
