const EVENT_NAMES = [
  "tabOpened", "tabClosed", "popupOpened",
  "downloadStarted", "downloadProgress", "downloadFinished",
];
export const BROWSER_EVENT_NAMES = Object.freeze([...EVENT_NAMES]);

const DEFAULT_TIMEOUT = 30_000;

function pageTarget(info) {
  return info?.type === "page" && info?.targetId ? info : null;
}
function normalizeTarget(info) {
  return {
    targetId: String(info.targetId), type: "page", url: info.url ?? "about:blank",
    title: info.title ?? "", openerId: info.openerId ?? null,
    openerFrameId: info.openerFrameId ?? null, browserContextId: info.browserContextId ?? null,
    attached: Boolean(info.attached), subtype: info.subtype ?? null,
  };
}
function errorValue(value) { return value instanceof Error ? value : Error(String(value)); }

class BrowserEventBridge {
  #cdp; #options; #listeners = new Map(); #unsubscribers = [];
  #targetInfos = new Map(); #crashes = new Map(); #downloads = new Map(); #terminal = new Set();
  #frameToTarget = new Map(); #waits = new Set(); #disposed = false; #explicitDispose = false;
  ready;
  constructor(connection, options) {
    if (!connection?.cdp) throw new TypeError("createEvents requires a browser connection");
    this.#cdp = connection.cdp; this.#options = this.#validate(options);
    this.#register(); this.ready = this.#initialize();
  }
  #validate(options) {
    const behavior = options.downloadBehavior ?? "default";
    if (!["default", "allow", "deny", "allowAndName"].includes(behavior)) throw new TypeError("Invalid downloadBehavior");
    if (behavior === "allow" && (!pathIsAbsolute(options.downloadPath))) throw new TypeError("downloadPath must be an absolute path for allow");
    return { ...options, downloadBehavior: behavior };
  }
  #register() {
    const on = (method, fn) => this.#unsubscribers.push(this.#cdp.on(method, fn));
    on("Target.targetCreated", info => this.#created(info, false));
    on("Target.targetDestroyed", info => this.#destroyed(info));
    on("Target.targetInfoChanged", info => { const target = pageTarget(info?.targetInfo); if (target && this.#targetInfos.has(target.targetId)) this.#targetInfos.set(target.targetId, normalizeTarget(target)); });
    on("Target.targetCrashed", info => { if (info?.targetId) this.#crashes.set(info.targetId, { status: info.status ?? "", errorCode: info.errorCode ?? 0 }); });
    on("Browser.downloadWillBegin", info => this.#downloadBegin(info));
    on("Browser.downloadProgress", info => this.#downloadProgress(info));
    on("Page.frameAttached", (info, meta) => { if (meta?.sessionId && info?.frameId) this.#mapFrame(info.frameId, meta.sessionId); });
    on("Page.frameNavigated", (info, meta) => { if (meta?.sessionId && info?.frame?.id) this.#mapFrame(info.frame.id, meta.sessionId); });
    if (this.#cdp.transportEvents?.on) {
      this.#unsubscribers.push(this.#cdp.transportEvents.on("disconnected", () => this.#disconnectDownloads()));
      this.#unsubscribers.push(this.#cdp.transportEvents.on("reconnected", () => { this.#configureDownloads().catch(error => console.warn("[events] download reconfiguration failed", error)); }));
    }
  }
  async #initialize() {
    await this.#cdp.ensureConnected();
    await this.#cdp.send("Target.setDiscoverTargets", { discover: true });
    const result = await this.#cdp.send("Target.getTargets");
    await this.#configureDownloads();
    for (const info of result?.targetInfos ?? []) this.#created(info, true);
  }
  async #configureDownloads() {
    const params = { behavior: this.#options.downloadBehavior, eventsEnabled: true };
    if (this.#options.downloadBehavior === "allow" || this.#options.downloadBehavior === "allowAndName") params.downloadPath = this.#options.downloadPath;
    await this.#cdp.send("Browser.setDownloadBehavior", params);
  }
  #mapFrame(frameId, sessionId) {
    const target = [...this.#targetInfos.values()].find(info => info.attached && info.targetId === sessionId) ?? null;
    if (target) this.#frameToTarget.set(frameId, target.targetId);
  }
  #created(info, initial) {
    const target = pageTarget(info?.targetInfo ?? info); if (!target) return;
    const normalized = normalizeTarget(target); const id = normalized.targetId;
    if (this.#targetInfos.has(id)) return;
    this.#targetInfos.set(id, normalized);
    const payload = { ...normalized, popup: Boolean(normalized.openerId && this.#targetInfos.has(normalized.openerId)), initial: Boolean(initial) };
    this.#dispatch("tabOpened", payload);
    if (payload.popup) this.#dispatch("popupOpened", { targetId: id, openerTargetId: normalized.openerId, openerFrameId: normalized.openerFrameId, url: normalized.url, title: normalized.title, initial: Boolean(initial) });
  }
  #destroyed(info) {
    const id = info?.targetId; const last = this.#targetInfos.get(id); if (!last) return;
    this.#targetInfos.delete(id); const crash = this.#crashes.get(id) ?? null; this.#crashes.delete(id);
    this.#dispatch("tabClosed", { targetId: id, reason: crash ? "crashed" : "destroyed", lastKnown: last, crash });
  }
  #downloadBegin(info = {}) {
    if (!info.guid || this.#terminal.has(info.guid)) return;
    const record = { guid: info.guid, url: info.url ?? null, suggestedFilename: info.suggestedFilename ?? "", frameId: info.frameId ?? null, targetId: this.#frameToTarget.get(info.frameId) ?? null, totalBytes: 0, receivedBytes: 0, filePath: null };
    this.#downloads.set(info.guid, record);
    this.#dispatch("downloadStarted", { guid: record.guid, url: record.url, suggestedFilename: record.suggestedFilename, frameId: record.frameId, targetId: record.targetId });
  }
  #downloadProgress(info = {}) {
    if (!info.guid) return;
    const alreadyTerminal = this.#terminal.has(info.guid);
    const record = this.#downloads.get(info.guid) ?? { guid: info.guid, url: null, suggestedFilename: "", frameId: null, targetId: null, totalBytes: 0, receivedBytes: 0, filePath: null };
    Object.assign(record, { totalBytes: Number(info.totalBytes ?? 0), receivedBytes: Number(info.receivedBytes ?? 0), filePath: info.filePath ?? null });
    this.#downloads.set(info.guid, record);
    const state = info.state;
    this.#dispatch("downloadProgress", { guid: info.guid, totalBytes: record.totalBytes, receivedBytes: record.receivedBytes, state, filePath: record.filePath, targetId: record.targetId });
    if ((state === "completed" || state === "canceled") && !alreadyTerminal) {
      this.#terminal.add(info.guid); this.#downloads.delete(info.guid);
      this.#dispatch("downloadFinished", { guid: info.guid, totalBytes: record.totalBytes, receivedBytes: record.receivedBytes, state, cdpState: state, filePath: record.filePath, targetId: record.targetId, error: null });
    }
  }
  #disconnectDownloads() {
    if (this.#explicitDispose) return;
    for (const record of this.#downloads.values()) this.#dispatch("downloadFinished", { guid: record.guid, totalBytes: record.totalBytes, receivedBytes: record.receivedBytes, state: "failed", cdpState: null, filePath: record.filePath, targetId: record.targetId, error: { code: "browserDisconnected", message: "Browser transport disconnected" } });
    this.#downloads.clear();
  }
  #dispatch(name, payload) {
    const listeners = [...this.#listeners.get(name) ?? []];
    Promise.allSettled(listeners.map(listener => Promise.resolve().then(() => listener(payload)))).then(results => results.filter(r => r.status === "rejected").forEach(r => console.warn(`[events] ${name} listener failed`, r.reason)));
  }
  on(name, listener) { this.#assertName(name); if (typeof listener !== "function") throw new TypeError("listener must be a function"); const set = this.#listeners.get(name) ?? new Set(); set.add(listener); this.#listeners.set(name, set); return () => this.off(name, listener); }
  off(name, listener) { this.#assertName(name); this.#listeners.get(name)?.delete(listener); }
  waitForEvent(name, options = {}) { this.#assertName(name); if (this.#disposed) return Promise.reject(Error("Events bridge is disposed")); const timeout = options.timeout ?? DEFAULT_TIMEOUT; return new Promise((resolve, reject) => { let done = false; let timer; const off = this.on(name, async value => { try { if (options.predicate && !await options.predicate(value)) return; if (done) return; done = true; clearTimeout(timer); this.#waits.delete(cancel); off(); resolve(value); } catch (error) { if (!done) { done = true; clearTimeout(timer); this.#waits.delete(cancel); off(); reject(errorValue(error)); } } }); const cancel = () => { if (!done) { done = true; clearTimeout(timer); off(); reject(Error("Events bridge disposed")); } }; this.#waits.add(cancel); timer = setTimeout(() => { if (!done) { done = true; this.#waits.delete(cancel); off(); reject(Error(`Timed out waiting for browser event "${name}"`)); } }, timeout); }); }
  #assertName(name) { if (!EVENT_NAMES.includes(name)) throw new TypeError(`Unknown browser event: ${String(name)}`); }
  async dispose() { if (this.#disposed) return; this.#disposed = true; this.#explicitDispose = true; for (const cancel of this.#waits) cancel(); this.#waits.clear(); for (const off of this.#unsubscribers) off(); this.#unsubscribers = []; this.#listeners.clear(); await this.ready.catch(() => {}); }
}
function pathIsAbsolute(value) { return typeof value === "string" && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)); }
export function createEvents(connection, options = {}) { return new BrowserEventBridge(connection, options); }
