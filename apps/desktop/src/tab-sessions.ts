/**
 * Desktop F06: host-neutral document/session state, shared by a future Tauri UI.
 * No HTTP side effects in restoration. Persistence contains ONLY redacted response
 * snapshots; unsaved user edits and request buffers remain in memory.
 */
export type DesktopTabKind = 'request' | 'response';
export interface DesktopTab {
  readonly id: string;
  readonly kind: DesktopTabKind;
  readonly title: string;
  readonly requestPath: string | null;
  readonly content: string;
  readonly dirty: boolean;
  readonly running: boolean;
  readonly responseTo: string | null;
}
export interface PersistedTab {
  readonly id: string;
  readonly kind: DesktopTabKind;
  readonly title: string;
  readonly requestPath: string | null;
  /** Only an engine-produced redacted JSON response, never raw editor text. */
  readonly responseSnapshot?: string;
  readonly responseTo: string | null;
}
export interface PersistedWorkspaceSession {
  readonly version: 1;
  readonly activeTabId: string | null;
  readonly tabs: readonly PersistedTab[];
}
export interface SessionStore {
  read(): Promise<unknown>;
  write(snapshot: PersistedWorkspaceSession): Promise<void>;
}
export interface DesktopRunResult {
  readonly json: string;
  readonly warnings: readonly string[];
}
export interface DesktopEngineBridge {
  readRequest(filePath: string): Promise<string>;
  runRequest(
    requestPath: string,
    contents: string,
    signal: AbortSignal,
    progress: (message: string) => void,
  ): Promise<DesktopRunResult>;
  saveAs(path: string, content: string): Promise<void>;
}
export class DesktopSessionError extends Error {
  constructor(
    public readonly code: 'INVALID_TAB' | 'INVALID_SNAPSHOT' | 'BUSY' | 'UNSAVED_RESPONSE',
    message: string,
  ) {
    super(message);
    this.name = 'DesktopSessionError';
  }
}
const MAX_TABS = 32;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const isTab = (x: unknown): x is PersistedTab =>
  isObject(x) &&
  typeof x.id === 'string' &&
  x.id.length < 100 &&
  (x.kind === 'request' || x.kind === 'response') &&
  typeof x.title === 'string' &&
  x.title.length < 260 &&
  (x.requestPath === null || (typeof x.requestPath === 'string' && x.requestPath.length < 4096)) &&
  (x.responseTo === null || (typeof x.responseTo === 'string' && x.responseTo.length < 100)) &&
  (x.responseSnapshot === undefined ||
    (typeof x.responseSnapshot === 'string' && x.responseSnapshot.length < MAX_SNAPSHOT_BYTES));
/** Browser/Node independent: UI and IPC host implement the bridge and the store. */
export class DesktopTabSessions {
  private tabs: DesktopTab[] = [];
  private sanitized = new Map<string, string>();
  private active: string | null = null;
  private executions = new Map<string, AbortController>();
  private counter = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  constructor(
    private readonly bridge: DesktopEngineBridge,
    private readonly store: SessionStore,
  ) {}
  get openTabs(): readonly DesktopTab[] {
    return [...this.tabs];
  }
  get activeTabId(): string | null {
    return this.active;
  }
  get isRunning(): boolean {
    return this.executions.size > 0;
  }
  private nextId(): string {
    return `tab-${Date.now().toString(36)}-${++this.counter}`;
  }
  private persist(): Promise<void> {
    const snapshot: PersistedWorkspaceSession = {
      version: 1,
      activeTabId: this.active,
      tabs: this.tabs.map((tab) => ({
        id: tab.id,
        kind: tab.kind,
        title: tab.title,
        requestPath: tab.requestPath,
        responseTo: tab.responseTo,
        ...(tab.kind === 'response' && this.sanitized.has(tab.id)
          ? { responseSnapshot: this.sanitized.get(tab.id)! }
          : {}),
      })),
    };
    // Serializing store writes prevents a delayed stale save from reopening closed tabs.
    this.writeQueue = this.writeQueue.catch(() => undefined).then(() => this.store.write(snapshot));
    return this.writeQueue;
  }
  async restore(): Promise<void> {
    if (this.tabs.length || this.executions.size)
      throw new DesktopSessionError('BUSY', 'Cannot restore over active session');
    const state = await this.store.read();
    if (state === null || state === undefined) return;
    if (
      !isObject(state) ||
      state.version !== 1 ||
      !Array.isArray(state.tabs) ||
      state.tabs.length > MAX_TABS ||
      !state.tabs.every(isTab) ||
      !(
        state.activeTabId === null ||
        (typeof state.activeTabId === 'string' && state.activeTabId.length < 100)
      )
    )
      throw new DesktopSessionError('INVALID_SNAPSHOT', 'Invalid desktop session');
    const ids = new Set<string>();
    const restored: DesktopTab[] = [];
    for (const tab of state.tabs as PersistedTab[]) {
      if (ids.has(tab.id)) throw new DesktopSessionError('INVALID_SNAPSHOT', 'Duplicate tab id');
      ids.add(tab.id);
      if (tab.kind === 'request') {
        if (!tab.requestPath) continue;
        try {
          const content = await this.bridge.readRequest(tab.requestPath);
          restored.push({
            id: tab.id,
            kind: 'request',
            title: tab.title,
            requestPath: tab.requestPath,
            content,
            dirty: false,
            running: false,
            responseTo: null,
          });
        } catch {
          /* File removed or no longer authorized: do not recreate */
        }
      } else if (tab.responseSnapshot !== undefined) {
        // Restoring is a display operation. No runRequest() or network calls here.
        restored.push({
          id: tab.id,
          kind: 'response',
          title: tab.title,
          requestPath: null,
          content: tab.responseSnapshot,
          dirty: false,
          running: false,
          responseTo: tab.responseTo,
        });
        this.sanitized.set(tab.id, tab.responseSnapshot);
      }
    }
    this.tabs = restored;
    this.active = restored.some((x) => x.id === state.activeTabId)
      ? (state.activeTabId as string)
      : (restored.at(-1)?.id ?? null);
    await this.persist();
  }
  async openRequest(path: string): Promise<string> {
    const existing = this.tabs.find((x) => x.kind === 'request' && x.requestPath === path);
    if (existing) {
      this.active = existing.id;
      await this.persist();
      return existing.id;
    }
    if (this.tabs.length >= MAX_TABS) throw new DesktopSessionError('BUSY', 'Too many open tabs');
    const content = await this.bridge.readRequest(path);
    const id = this.nextId();
    this.tabs.push({
      id,
      kind: 'request',
      title: path.split(/[\\/]/).at(-1) ?? path,
      requestPath: path,
      content,
      dirty: false,
      running: false,
      responseTo: null,
    });
    this.active = id;
    await this.persist();
    return id;
  }
  async selectTab(id: string): Promise<void> {
    if (!this.tabs.some((x) => x.id === id)) throw new DesktopSessionError('INVALID_TAB', 'Tab not found');
    this.active = id;
    await this.persist();
  }
  /** Editing response tabs never modifies the engine's stored redacted snapshot. */
  editTab(id: string, text: string): void {
    const index = this.tabs.findIndex((x) => x.id === id);
    if (index < 0) throw new DesktopSessionError('INVALID_TAB', 'Tab not found');
    const tab = this.tabs[index]!;
    if (tab.running) throw new DesktopSessionError('BUSY', 'Request is running');
    this.tabs[index] = { ...tab, content: text, dirty: true };
  }
  async run(id: string, onProgress: (message: string) => void = () => {}): Promise<string> {
    const i = this.tabs.findIndex((x) => x.id === id);
    const tab = this.tabs[i];
    if (!tab || tab.kind !== 'request' || !tab.requestPath)
      throw new DesktopSessionError('INVALID_TAB', 'Run requires a request tab');
    if (this.executions.has(id)) throw new DesktopSessionError('BUSY', 'Request already running');
    const controller = new AbortController();
    this.executions.set(id, controller);
    this.tabs[i] = { ...tab, running: true };
    let result: DesktopRunResult;
    try {
      result = await this.bridge.runRequest(tab.requestPath, tab.content, controller.signal, onProgress);
    } finally {
      this.executions.delete(id);
      this.tabs = this.tabs.map((x) => (x.id === id ? { ...x, running: false } : x));
    }
    if (controller.signal.aborted) throw new DesktopSessionError('BUSY', 'Execution cancelled');
    if (this.tabs.length >= MAX_TABS) throw new DesktopSessionError('BUSY', 'Too many open tabs');
    if (result.json.length > MAX_SNAPSHOT_BYTES)
      throw new DesktopSessionError('INVALID_SNAPSHOT', 'Response too large for snapshot');
    const responseId = this.nextId();
    this.tabs.push({
      id: responseId,
      kind: 'response',
      title: `Response · ${tab.title}`,
      requestPath: null,
      content: result.json,
      dirty: false,
      running: false,
      responseTo: id,
    });
    // bridge.runRequest returns only the canonical redacted JSON, never original auth headers.
    this.sanitized.set(responseId, result.json);
    this.active = responseId;
    await this.persist();
    return responseId;
  }
  stop(id: string): boolean {
    const controller = this.executions.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
  }
  async saveResponseAs(id: string, destination: string): Promise<void> {
    const tab = this.tabs.find((x) => x.id === id);
    if (!tab || tab.kind !== 'response')
      throw new DesktopSessionError('INVALID_TAB', 'Only response tabs can be saved');
    // No special validation of user-edited response JSON — normal Save As semantics.
    await this.bridge.saveAs(destination, tab.content);
    this.tabs = this.tabs.map((x) => (x.id === id ? { ...x, dirty: false } : x));
  }
  async close(id: string): Promise<void> {
    if (this.executions.has(id)) this.stop(id);
    this.tabs = this.tabs.filter((t) => t.id !== id);
    this.sanitized.delete(id); // never resurrect closed responses
    if (this.active === id) this.active = this.tabs.at(-1)?.id ?? null;
    await this.persist();
  }
  async clear(): Promise<void> {
    for (const id of this.executions.keys()) this.stop(id);
    this.tabs = [];
    this.sanitized.clear();
    this.active = null;
    await this.persist();
  }
}
