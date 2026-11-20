import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { NativeDesktopBridge } from './native';
import type { DesktopState, DesktopTab, ExplorerItem, ExplorerListing } from './native';

interface ImportPreview {
  planId: string;
  plan: {
    operations: Array<{ filename: string; file: { request: { method: string; url: string } } }>;
    warnings: Array<{ message: string }>;
  };
}
export function App() {
  const api = useMemo(() => new NativeDesktopBridge(), []);
  const [ready, setReady] = useState(false);
  const [root, setRoot] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [items, setItems] = useState<ExplorerItem[]>([]);
  const [session, setSession] = useState<DesktopState>({ tabs: [], activeTabId: null });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [format, setFormat] = useState<'curl' | 'bash' | 'openapi'>('curl');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const active = session.tabs.find((t) => t.id === session.activeTabId) ?? null;
  const requestInProgress = session.tabs.find((t) => t.running) || null;
  const currentText = active ? (drafts[active.id] ?? active.content) : '';
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    let cancelled = false;
    void api
      .connect()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    const unsubscribe = api.onProgress((message) => setProgress(message));
    return () => {
      cancelled = true;
      unsubscribe();
      api.dispose();
    };
  }, [api]);
  const call = useCallback(
    async <T,>(op: string, args: Record<string, unknown> = {}): Promise<T> => {
      try {
        setError('');
        return await api.send<T>(op, args);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    [api],
  );
  const refresh = useCallback(
    async (path: string) => {
      const listing = await call<ExplorerListing>('list', { folder: path });
      setFolder(listing.folder);
      setItems(listing.items);
    },
    [call],
  );
  const choose = async () => {
    if (!ready) return;
    const selected = await api.selectWorkspace();
    if (!selected) return;
    setRoot(selected);
    setFolder(selected);
    setDrafts({});
    setSession({ tabs: [], activeTabId: null });
    setBusy(true);
    try {
      const initial = await call<DesktopState>('restore');
      setSession(initial);
      await refresh(selected);
    } finally {
      setBusy(false);
    }
  };
  const open = async (item: ExplorerItem) => {
    if (item.kind === 'folder') {
      await refresh(item.path);
      return;
    }
    if (item.kind === 'variables') return;
    const state = await call<DesktopState>('open', { path: item.path });
    setSession(state);
  };
  const flush = async (tab: DesktopTab | null) => {
    if (!tab) return;
    const text = drafts[tab.id];
    if (text === undefined) return;
    const state = await call<DesktopState>('edit', { tabId: tab.id, content: text });
    setSession(state);
    setDrafts((previous) => {
      const next = { ...previous };
      delete next[tab.id];
      return next;
    });
  };
  const run = async () => {
    if (!active || active.kind !== 'request' || busy) return;
    setBusy(true);
    setProgress('Iniciando request...');
    try {
      await flush(active);
      const next = await call<DesktopState>('run', { tabId: active.id });
      setSession(next);
      setProgress('Execução concluída');
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    const running = sessionRef.current.tabs.find((t) => t.running) || active;
    if (!running) return;
    try {
      await call('stop', { tabId: running.id });
      setProgress('Cancelando...');
    } catch {
      // The request may have finished before the Stop command reached the host.
    }
  };
  const select = async (tab: DesktopTab) => {
    const state = await call<DesktopState>('select', { tabId: tab.id });
    setSession(state);
  };
  const close = async (tab: DesktopTab) => {
    if (drafts[tab.id] !== undefined || tab.dirty) {
      if (!window.confirm('Descartar alterações não salvas desta aba?')) return;
    }
    const state = await call<DesktopState>('close', { tabId: tab.id });
    setSession(state);
    setDrafts((current) => {
      const next = { ...current };
      delete next[tab.id];
      return next;
    });
  };
  const save = async () => {
    if (!active || active.kind !== 'response') return;
    await flush(active);
    const destination = await api.selectSaveDestination();
    if (!destination) return;
    const state = await call<DesktopState>('saveAs', { tabId: active.id, path: destination });
    setSession(state);
    setProgress('Response salva');
  };
  const activate = async (item: ExplorerItem, enabled: boolean) => {
    await call(enabled ? 'activateVariables' : 'deactivateVariables', { path: item.path });
    if (folder) await refresh(folder);
  };
  const doPreview = async () => {
    setPreview(null);
    const result = await call<ImportPreview>('importPreview', { format, text: importText });
    setPreview(result);
  };
  const doApply = async () => {
    if (!preview || !folder) return;
    const result = await call<{ files: string[] }>('importApply', { planId: preview.planId, folder });
    setImportOpen(false);
    setPreview(null);
    setProgress(`${result.files.length} request(s) criada(s)`);
    await refresh(folder);
  };
  const back = async () => {
    if (!folder || !root || folder === root) return;
    const parent = folder.replace(/[\\/][^\\/]+$/, '');
    await refresh(parent.startsWith(root) ? parent : root);
  };
  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">{'{}'}</span>
          <strong>HTTP Client</strong>
          <span className="dev-tag">DESKTOP</span>
        </div>
        <div className="top-actions">
          <button type="button" onClick={() => void choose()} disabled={!ready}>
            Abrir workspace
          </button>
          <button type="button" onClick={() => setImportOpen(true)} disabled={!root}>
            Importar
          </button>
          <button
            className="primary"
            type="button"
            disabled={busy || !active || active.kind !== 'request'}
            onClick={() => void run()}
          >
            ▶ Run
          </button>
          <button type="button" disabled={!requestInProgress && !busy} onClick={() => void stop()}>
            ■ Stop
          </button>
          <button type="button" disabled={!active || active.kind !== 'response'} onClick={() => void save()}>
            Salvar Response
          </button>
        </div>
      </header>
      <div className="work-area">
        <aside className="sidebar" aria-label="Explorer de requests">
          <div className="panel-title">WORKSPACE</div>
          {root ? (
            <>
              <div className="folder-header">
                <button type="button" onClick={() => void back()} disabled={folder === root}>
                  ←
                </button>
                <span title={folder ?? ''}>
                  {folder?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'workspace'}
                </span>
              </div>
              <ul className="file-tree">
                {items.map((item) => (
                  <li key={item.path}>
                    <button
                      type="button"
                      className="file-item"
                      onClick={() => void open(item)}
                      title={item.path}
                    >
                      <span className={item.kind === 'request' ? 'method-icon' : 'file-icon'}>
                        {item.kind === 'folder' ? '▸' : item.kind === 'variables' ? '◇' : '↗'}
                      </span>
                      <span className="filename">{item.name}</span>
                    </button>
                    {item.kind === 'variables' && (
                      <div className="inline-actions">
                        <button type="button" onClick={() => void activate(item, true)}>
                          Ativar
                        </button>
                        <button type="button" onClick={() => void activate(item, false)}>
                          Desativar
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="sidebar-empty">Selecione uma pasta para abrir suas requests e variáveis.</p>
          )}
        </aside>
        <section className="workspace-area">
          {session.tabs.length > 0 && (
            <nav className="tabs" aria-label="Abas abertas">
              {session.tabs.map((tab) => (
                <div key={tab.id} className={'tab' + (session.activeTabId === tab.id ? ' active' : '')}>
                  <button type="button" className="tab-label" onClick={() => void select(tab)}>
                    {tab.kind === 'request' ? '↗' : '{}'} {tab.title}
                    {(tab.dirty || drafts[tab.id] !== undefined) && ' •'}
                    {tab.running && ' ⏳'}
                  </button>
                  <button
                    type="button"
                    className="tab-close"
                    aria-label={`Fechar ${tab.title}`}
                    onClick={() => void close(tab)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </nav>
          )}
          {active ? (
            <div className="editor-holder">
              <div className="editor-caption">
                {active.kind === 'response' ? 'RESPONSE JSON — EDITÁVEL' : 'REQUEST JSON'}{' '}
                <span>{active.requestPath ?? 'Documento temporário'}</span>
              </div>
              <Editor
                path={`inmemory://${active.id}.json`}
                language="json"
                theme="vs-dark"
                value={currentText}
                options={{
                  automaticLayout: true,
                  minimap: { enabled: false },
                  fontSize: 13,
                  wordWrap: 'on',
                  scrollBeyondLastLine: false,
                }}
                onChange={(value) => setDrafts((old) => ({ ...old, [active.id]: value ?? '' }))}
              />
            </div>
          ) : (
            <div className="empty-view">
              <span className="empty-icon">{'{}'}</span>
              <h2>JSON HTTP Client</h2>
              <p>Abra uma request no Explorer para começar.</p>
            </div>
          )}
          <footer className="statusbar">
            <span>{progress || 'Pronto'}</span>
            <span>{root ?? 'Nenhum workspace aberto'}</span>
          </footer>
        </section>
      </div>
      {error && (
        <div role="alert" className="error-toast">
          <strong>Operação não concluída</strong>
          <span>{error}</span>
          <button type="button" onClick={() => setError('')}>
            Fechar
          </button>
        </div>
      )}
      {importOpen && (
        <div className="overlay" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-label="Importar request">
            <div className="modal-heading">
              <h2>Importar requests</h2>
              <button
                onClick={() => {
                  setImportOpen(false);
                  setPreview(null);
                }}
              >
                ×
              </button>
            </div>
            <p>Prévia estática: nenhum comando Bash é executado e nenhum HTTP é enviado.</p>
            <label>
              Origem{' '}
              <select
                value={format}
                onChange={(e) => {
                  setFormat(e.target.value as typeof format);
                  setPreview(null);
                }}
              >
                <option value="curl">cURL</option>
                <option value="bash">Bash (cURL literal)</option>
                <option value="openapi">OpenAPI JSON</option>
              </select>
            </label>
            <textarea
              value={importText}
              onChange={(e) => {
                setImportText(e.target.value);
                setPreview(null);
              }}
              rows={8}
              placeholder="Cole aqui o comando cURL ou documento OpenAPI JSON"
            />
            {preview && (
              <div className="preview">
                <strong>{preview.plan.operations.length} requests no plano</strong>
                <ul>
                  {preview.plan.operations.map((op) => (
                    <li key={op.filename}>
                      {op.file.request.method} {op.filename}
                    </li>
                  ))}
                </ul>
                {preview.plan.warnings.map((warning, i) => (
                  <p key={i}>{warning.message}</p>
                ))}
              </div>
            )}
            <div className="modal-actions">
              <button onClick={() => void doPreview()}>Gerar prévia</button>
              <button className="primary" disabled={!preview} onClick={() => void doApply()}>
                Aplicar arquivos
              </button>
            </div>
            <small>
              Aplicar requer autorização de escrita do host. Arquivos existentes não são sobrescritos.
            </small>
          </section>
        </div>
      )}
    </main>
  );
}
