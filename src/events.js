const EVENT_NAMES = ["tabOpened", "tabClosed", "popupOpened", "downloadStarted", "downloadProgress", "downloadFinished"];
export const BROWSER_EVENT_NAMES = Object.freeze([...EVENT_NAMES]);
const DEFAULT_TIMEOUT = 30_000;
const TERMINAL_LIMIT = 4_096;

function pageTarget(info) { return info?.type === "page" && info?.targetId ? info : null; }
function normalizeTarget(info) {
  return { targetId: String(info.targetId), type: "page", url: info.url ?? "about:blank", title: info.title ?? "", openerId: info.openerId ?? null, openerFrameId: info.openerFrameId ?? null, browserContextId: info.browserContextId ?? null, attached: Boolean(info.attached), subtype: info.subtype ?? null };
}
function errorValue(value) { return value instanceof Error ? value : Error(String(value)); }

class BrowserEventBridge {
  #cdp; #options; #listeners = new Map(); #unsubscribers = [];
  #targetInfos = new Map(); #crashes = new Map(); #downloads = new Map(); #terminalDownloads = new Map(); #terminal = new Set();
  #frameToTarget = new Map(); #sessionToTarget = new Map(); #waits = new Set(); #disposed = false; #explicitDispose = false;
  ready;
  constructor(connection, options) {
    if (!connection?.cdp) throw new TypeError("createEvents requires a browser connection");
    this.#cdp = connection.cdp; this.#options = this.#validate(options); this.#register(); this.ready = this.#initialize();
  }
  #validate(options) {
    const behavior = options.downloadBehavior ?? "default";
    if (!["default", "allow", "deny", "allowAndName"].includes(behavior)) throw new TypeError("Invalid downloadBehavior");
    if (behavior === "allow" && !pathIsAbsolute(options.downloadPath)) throw new TypeError("downloadPath must be an absolute path for allow");
    return { ...options, downloadBehavior: behavior };
  }
  #register() {
    const on = (method, fn) => this.#unsubscribers.push(this.#cdp.on(method, fn));
    on("Target.targetCreated", info => this.#created(info, false));
    on("Target.targetDestroyed", info => this.#destroyed(info));
    on("Target.targetInfoChanged", info => { const target = pageTarget(info?.targetInfo); if (target && this.#targetInfos.has(target.targetId)) this.#targetInfos.set(target.targetId, normalizeTarget(target)); });
    on("Target.targetCrashed", info => { if (info?.targetId) this.#crashes.set(info.targetId, { status: info.status ?? "", errorCode: info.errorCode ?? 0 }); });
    on("Target.attachedToTarget", (info, meta) => { const targetId = info?.targetInfo?.targetId; const sessionId = info?.sessionId ?? meta?.sessionId; if (targetId && sessionId) { this.#sessionToTarget.set(sessionId, targetId); } });
    on("Target.detachedFromTarget", (info, meta) => { const sessionId = info?.sessionId ?? meta?.sessionId; if (sessionId) this.#sessionToTarget.delete(sessionId); });
    on("Browser.downloadWillBegin", info => this.#downloadBegin(info));
    on("Browser.downloadProgress", info => this.#downloadProgress(info));
    on("Page.frameAttached", (info, meta) => { const sessionId = info?.sessionId ?? meta?.sessionId; if (sessionId && info?.frameId) this.#mapFrame(info.frameId, sessionId); });
    on("Page.frameNavigated", (info, meta) => { const sessionId = info?.sessionId ?? meta?.sessionId; if (sessionId && info?.frame?.id) this.#mapFrame(info.frame.id, sessionId); });
    if (this.#cdp.transportEvents?.on) {
      this.#unsubscribers.push(this.#cdp.transportEvents.on("disconnected", () => { this.#disconnectDownloads(); this.#cancelWaits(Error("Browser transport disconnected")); }));
      this.#unsubscribers.push(this.#cdp.transportEvents.on("reconnected", () => { this.#reconcile().catch(error => console.warn("[events] target reconciliation failed", error)); this.#configureDownloads().catch(error => console.warn("[events] download reconfiguration failed", error)); }));
    }
  }
  async #initialize() {
    await this.#cdp.ensureConnected(); await this.#cdp.send("Target.setDiscoverTargets", { discover: true });
    const result = await this.#cdp.send("Target.getTargets"); await this.#configureDownloads();
    const targets = (result?.targetInfos ?? []).filter(info => pageTarget(info));
    targets.sort((a, b) => Boolean(a.openerId) - Boolean(b.openerId));
    for (const info of targets) this.#created(info, true);
  }
  async #reconcile() {
    const result = await this.#cdp.send("Target.getTargets");
    const current = new Set((result?.targetInfos ?? []).filter(info => pageTarget(info)).map(info => String(info.targetId)));
    for (const id of [...this.#targetInfos.keys()]) if (!current.has(id)) this.#destroyed({ targetId: id });
    const targets = (result?.targetInfos ?? []).filter(info => pageTarget(info));
    targets.sort((a, b) => Boolean(a.openerId) - Boolean(b.openerId));
    for (const info of targets) this.#created(info, true);
  }
  async #configureDownloads() {
    const params = { behavior: this.#options.downloadBehavior, eventsEnabled: true };
    if (this.#options.downloadBehavior === "allow" || this.#options.downloadBehavior === "allowAndName") params.downloadPath = this.#options.downloadPath;
    await this.#cdp.send("Browser.setDownloadBehavior", params);
  }
  #mapFrame(frameId, sessionId) {
    const targetId = this.#sessionToTarget.get(sessionId) ?? [...this.#targetInfos.values()].find(info => info.attached && info.targetId === sessionId)?.targetId;
    if (targetId) this.#frameToTarget.set(frameId, targetId);
  }
  #created(info, initial) {
    const target = pageTarget(info?.targetInfo ?? info); if (!target) return;
    const normalized = normalizeTarget(target); const id = normalized.targetId;
    if (this.#targetInfos.has(id)) return;
    this.#targetInfos.set(id, normalized);
    const popup = Boolean(normalized.openerId && this.#targetInfos.has(normalized.openerId));
    this.#dispatch("tabOpened", { ...normalized, popup, initial: Boolean(initial) });
    if (popup) this.#dispatch("popupOpened", { targetId: id, openerTargetId: normalized.openerId, openerFrameId: normalized.openerFrameId, url: normalized.url, title: normalized.title, initial: Boolean(initial) });
  }
  #destroyed(info) {
    const id = info?.targetId; const last = this.#targetInfos.get(id); if (!last) return;
    this.#targetInfos.delete(id); const crash = this.#crashes.get(id) ?? null; this.#crashes.delete(id);
    for (const [frame, targetId] of this.#frameToTarget) if (targetId === id) this.#frameToTarget.delete(frame);
    this.#dispatch("tabClosed", { targetId: id, reason: crash ? "crashed" : "destroyed", lastKnown: last, crash });
  }
  #rememberTerminal(guid) { this.#terminal.delete(guid); this.#terminal.add(guid); if (this.#terminal.size > TERMINAL_LIMIT) { const oldest = this.#terminal.values().next().value; this.#terminal.delete(oldest); this.#terminalDownloads.delete(oldest); } }
  #downloadBegin(info = {}) {
    if (!info.guid || this.#terminal.has(info.guid)) return;
    const record = { guid: info.guid, url: info.url ?? null, suggestedFilename: info.suggestedFilename ?? "", frameId: info.frameId ?? null, targetId: this.#frameToTarget.get(info.frameId) ?? null, totalBytes: 0, receivedBytes: 0, filePath: null };
    this.#downloads.set(info.guid, record); this.#dispatch("downloadStarted", { guid: record.guid, url: record.url, suggestedFilename: record.suggestedFilename, frameId: record.frameId, targetId: record.targetId });
  }
  #downloadProgress(info = {}) {
    if (!info.guid) return;
    const alreadyTerminal = this.#terminal.has(info.guid);
    const record = this.#downloads.get(info.guid) ?? this.#terminalDownloads.get(info.guid); if (!record) return;
    Object.assign(record, { totalBytes: Number(info.totalBytes ?? 0), receivedBytes: Number(info.receivedBytes ?? 0), filePath: info.filePath ?? null });
    this.#dispatch("downloadProgress", { guid: info.guid, totalBytes: record.totalBytes, receivedBytes: record.receivedBytes, state: info.state, filePath: record.filePath, targetId: record.targetId });
    if ((info.state === "completed" || info.state === "canceled") && !alreadyTerminal) { this.#rememberTerminal(info.guid); this.#downloads.delete(info.guid); this.#terminalDownloads.set(info.guid, record); this.#dispatch("downloadFinished", { guid: info.guid, totalBytes: record.totalBytes, receivedBytes: record.receivedBytes, state: info.state, cdpState: info.state, filePath: record.filePath, targetId: record.targetId, error: null }); }
  }
  #disconnectDownloads() {
    if (this.#explicitDispose) return;
    for (const record of this.#downloads.values()) { this.#rememberTerminal(record.guid); this.#dispatch("downloadFinished", { guid: record.guid, totalBytes: record.totalBytes, receivedBytes: record.receivedBytes, state: "failed", cdpState: null, filePath: record.filePath, targetId: record.targetId, error: { code: "browserDisconnected", message: "Browser transport disconnected" } }); }
    this.#downloads.clear();
  }
  #dispatch(name, payload) { const listeners = [...this.#listeners.get(name) ?? []]; Promise.allSettled(listeners.map(listener => Promise.resolve().then(() => listener(payload)))).then(results => results.filter(r => r.status === "rejected").forEach(r => console.warn(`[events] ${name} listener failed`, r.reason))); }
  on(name, listener) { this.#assertName(name); if (typeof listener !== "function") throw new TypeError("listener must be a function"); const set = this.#listeners.get(name) ?? new Set(); set.add(listener); this.#listeners.set(name, set); return () => this.off(name, listener); }
  off(name, listener) { this.#assertName(name); this.#listeners.get(name)?.delete(listener); }
  #cancelWaits(error) { for (const cancel of this.#waits) cancel(error); this.#waits.clear(); }
  waitForEvent(name, options = {}) { this.#assertName(name); if (this.#disposed) return Promise.reject(Error("Events bridge is disposed")); const timeout = options.timeout ?? DEFAULT_TIMEOUT; return new Promise((resolve, reject) => { let done = false; let timer; const off = this.on(name, async value => { try { if (options.predicate && !await options.predicate(value)) return; if (done) return; done = true; clearTimeout(timer); this.#waits.delete(cancel); off(); resolve(value); } catch (error) { if (!done) { done = true; clearTimeout(timer); this.#waits.delete(cancel); off(); reject(errorValue(error)); } } }); const cancel = error => { if (!done) { done = true; clearTimeout(timer); this.#waits.delete(cancel); off(); reject(error ?? Error("Events bridge disposed")); } }; this.#waits.add(cancel); timer = setTimeout(() => cancel(Error(`Timed out waiting for browser event "${name}"`)), timeout); }); }
  #assertName(name) { if (!EVENT_NAMES.includes(name)) throw new TypeError(`Unknown browser event: ${String(name)}`); }
  async dispose() { if (this.#disposed) return; this.#disposed = true; this.#explicitDispose = true; this.#cancelWaits(); for (const off of this.#unsubscribers) off(); this.#unsubscribers = []; this.#listeners.clear(); await this.ready.catch(() => {}); }
}
function pathIsAbsolute(value) { return typeof value === "string" && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)); }
export function createEvents(connection, options = {}) { return new BrowserEventBridge(connection, options); }
