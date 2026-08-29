import { DEFAULT_AGENT_VIEWPORT, repinViewport } from "./viewport.js";

const managers = new WeakMap();
const CAPABILITY = Symbol.for("omowright.targetCreationCapability");

export class AgentTabManager {
  #connection; #owned = new Map(); #unsubscribers = []; #disposed = false; #closing = new Map();
  viewport; closeTimeoutMs; ready;
  constructor(connection, options = {}) {
    if (!connection?.cdp) throw new TypeError("createAgentTabs requires a browser connection");
    this.#connection = connection; this.viewport = Object.freeze({ ...DEFAULT_AGENT_VIEWPORT, ...(options.viewport ?? {}) }); this.closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
    this.#unsubscribers.push(connection.cdp.on("Target.targetDestroyed", info => this.#destroyed(info?.targetId)));
    this.#unsubscribers.push(connection.cdp.on("Target.targetCrashed", info => this.#destroyed(info?.targetId)));
    this.#unsubscribers.push(connection.cdp.transportEvents?.on?.("disconnected", () => { for (const id of [...this.#owned.keys()]) this.#destroyed(id, Error("Browser transport disconnected")); }));
    this.ready = Promise.resolve(connection.cdp.ensureConnected?.());
  }
  async create(url = "about:blank", options = {}) {
    if (this.#disposed) throw Error("Agent tab manager is disposed");
    await this.ready; const viewport = { ...this.viewport, ...(options.viewport ?? {}) };
    const result = await this.#connection.cdp.send("Target.createTarget", { url, background: true }, undefined, { capability: CAPABILITY });
    const targetId = result.targetId; const record = { targetId, page: null, viewport: Object.freeze({ ...viewport }) }; this.#owned.set(targetId, record);
    try {
      record.page = await this.#connection.attachPage(targetId);
      await repinViewport(record.page, record.viewport);
      record.navigationOff = record.page.on?.("framenavigated", event => { if (!event.parentFrameId) this.#repin(record); });
      return this.#public(record);
    } catch (error) {
      this.#owned.delete(targetId); await this.#connection.cdp.send("Target.closeTarget", { targetId }).catch(() => {}); throw error;
    }
  }
  #public(record) { return Object.freeze({ targetId: record.targetId, page: record.page, viewport: { ...record.viewport }, close: options => this.close(record.targetId, options) }); }
  get(targetId) { const record = this.#owned.get(targetId); return record ? this.#public(record) : null; }
  list() { return [...this.#owned.values()].map(record => this.#public(record)); }
  async #repin(record) { try { await repinViewport(record.page, record.viewport); } catch (error) { console.warn(`[agent-tabs] viewport repin failed for ${record.targetId}`, error); } }
  async repin(tabOrTargetId, viewport = this.viewport) { const id = typeof tabOrTargetId === "string" ? tabOrTargetId : tabOrTargetId?.targetId; const record = this.#owned.get(id); if (!record) throw Error(`Target ${id} is not owned by this manager`); const size = { ...viewport }; await repinViewport(record.page, size); record.viewport = Object.freeze(size); return { ...size }; }
  async close(tabOrTargetId, options = {}) {
    const id = typeof tabOrTargetId === "string" ? tabOrTargetId : tabOrTargetId?.targetId; const record = this.#owned.get(id); if (!record) throw Error(`Target ${id} is not owned by this manager`);
    if (this.#closing.has(id)) return this.#closing.get(id);
    const operation = this.#close(record, options).finally(() => this.#closing.delete(id)); this.#closing.set(id, operation); return operation;
  }
  async #close(record, options) {
    let resolveDestroy, rejectDestroy;
    const destroyed = new Promise((resolve, reject) => { resolveDestroy = resolve; rejectDestroy = reject; });
    const timeout = setTimeout(() => rejectDestroy(Error(`Timed out waiting for target ${record.targetId} to close`)), options.timeoutMs ?? this.closeTimeoutMs);
    const off = this.#connection.cdp.on("Target.targetDestroyed", info => { if (info?.targetId === record.targetId) resolveDestroy(); });
    const offDisconnect = this.#connection.cdp.transportEvents?.on?.("disconnected", () => rejectDestroy(Error("Browser transport disconnected")));
    try {
      if (options.runBeforeUnload && record.page) await record.page.cdp.send("Page.close", undefined, await record.page.resolveSessionId()).catch(() => this.#connection.cdp.send("Target.closeTarget", { targetId: record.targetId }));
      else await this.#connection.cdp.send("Target.closeTarget", { targetId: record.targetId });
      if (this.#owned.has(record.targetId)) await destroyed;
    } finally { clearTimeout(timeout); off(); offDisconnect?.(); this.#destroyed(record.targetId); }
  }
  #destroyed(id, error) { const record = this.#owned.get(id); if (!record) return; record.navigationOff?.(); this.#owned.delete(id); const pending = this.#closing.get(id); if (pending && error) {} }
  async closeAll(options = {}) { const results = await Promise.allSettled([...this.#owned.keys()].map(id => this.close(id, options))); const failures = results.filter(result => result.status === "rejected").map(result => result.reason); if (failures.length) throw new AggregateError(failures, "Failed to close one or more agent tabs"); }
  async dispose(options = { closeOwned: true }) { if (this.#disposed) return; if (options.closeOwned !== false) await this.closeAll(options).catch(() => {}); this.#disposed = true; for (const off of this.#unsubscribers) off(); this.#unsubscribers = []; }
}
export function createAgentTabs(connection, options = {}) { const current = managers.get(connection); if (current) { if (JSON.stringify(current.viewport) !== JSON.stringify({ ...DEFAULT_AGENT_VIEWPORT, ...(options.viewport ?? {}) })) throw new TypeError("Conflicting AgentTabManager options"); return current; } const manager = new AgentTabManager(connection, options); managers.set(connection, manager); return manager; }
