import { DEFAULT_AGENT_VIEWPORT, repinViewport } from "./viewport.ts";
import type { ViewportPage, ViewportSize } from "./viewport.ts";
import type { CdpTransport } from "./cdp-protocol.ts";
import { targetCreationCapability } from "./internal-capability.ts";

export interface AgentTabPage extends ViewportPage {
  cdp: { send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> };
  on?(
    event: "framenavigated",
    listener: (event: { frameId: string; parentFrameId?: string | null }) => void,
  ): (() => unknown) | undefined;
}

export interface AgentTabConnection<Page extends AgentTabPage = AgentTabPage> {
  cdp: Pick<CdpTransport, "send" | "on" | "transportEvents" | "isHeadless"> & { ensureConnected?(): Promise<void> };
  attachPage(targetId: string): Promise<Page>;
}

export interface AgentTabsOptions {
  viewport?: Partial<ViewportSize>;
  closeTimeoutMs?: number;
}

export interface AgentTabCreateOptions {
  viewport?: Partial<ViewportSize>;
}

export interface AgentTabCloseOptions {
  timeoutMs?: number;
  runBeforeUnload?: boolean;
}

export interface AgentTabDisposeOptions extends AgentTabCloseOptions {
  closeOwned?: boolean;
}

export interface AgentTab<Page extends AgentTabPage | null = AgentTabPage> {
  readonly targetId: string;
  readonly page: Page;
  readonly viewport: ViewportSize;
  readonly close: (options?: AgentTabCloseOptions) => Promise<void>;
}

type TabRef = string | { targetId?: string } | null | undefined;

interface OwnedTab<Page extends AgentTabPage> {
  targetId: string;
  page: Page | null;
  viewport: Readonly<ViewportSize>;
  repinQueue: Promise<unknown>;
  navigationOff?: (() => unknown) | undefined;
}

interface ClosingEntry {
  promise: Promise<void>;
  reject: (reason: unknown) => void;
}

const managers = new WeakMap<AgentTabConnection, AgentTabManager>();
const CAPABILITY = targetCreationCapability;

function optionsKey(options: AgentTabsOptions = {}) {
  return JSON.stringify({
    viewport: { ...DEFAULT_AGENT_VIEWPORT, ...options.viewport },
    closeTimeoutMs: options.closeTimeoutMs ?? 5_000,
  });
}

export class AgentTabManager<Page extends AgentTabPage = AgentTabPage> {
  #connection: AgentTabConnection<Page>;
  #owned = new Map<string, OwnedTab<Page>>();
  #unsubscribers: Array<(() => unknown) | undefined> = [];
  #disposed = false;
  #closing = new Map<string, ClosingEntry>();
  viewport: Readonly<ViewportSize>;
  closeTimeoutMs: number;
  ready: Promise<void>;
  declare readonly _optionsKey: string | undefined;

  constructor(connection: AgentTabConnection<Page>, options: AgentTabsOptions = {}) {
    if (!connection?.cdp) throw new TypeError("createAgentTabs requires a browser connection");
    this.#connection = connection;
    this.viewport = Object.freeze({ ...DEFAULT_AGENT_VIEWPORT, ...options.viewport });
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
    this.#unsubscribers.push(connection.cdp.on("Target.targetDestroyed", (info) => this.#destroyed(info?.targetId)));
    this.#unsubscribers.push(connection.cdp.on("Target.targetCrashed", (info) => this.#destroyed(info?.targetId)));
    this.#unsubscribers.push(
      connection.cdp.transportEvents?.on?.("disconnected", () => {
        for (const id of this.#owned.keys()) this.#destroyed(id, Error("Browser transport disconnected"));
      }),
    );
    this.ready = Promise.resolve(connection.cdp.ensureConnected?.());
  }

  async create(url = "about:blank", options: AgentTabCreateOptions = {}): Promise<AgentTab<Page>> {
    if (this.#disposed) throw Error("Agent tab manager is disposed");
    await this.ready;
    const viewport = { ...this.viewport, ...options.viewport };
    const result = await this.#connection.cdp.send("Target.createTarget", { url, background: true }, undefined, {
      capability: CAPABILITY,
    });
    const targetId = result.targetId;
    // CloakBrowser headless defers renderer startup for background targets until
    // activation; activating before attach avoids Page.enable timing out.
    if (await this.#isHeadless()) await this.#connection.cdp.send("Target.activateTarget", { targetId });
    const record: OwnedTab<Page> = {
      targetId,
      page: null,
      viewport: Object.freeze({ ...viewport }),
      repinQueue: Promise.resolve(),
    };
    this.#owned.set(targetId, record);
    try {
      const page = await this.#connection.attachPage(targetId);
      record.page = page;
      await repinViewport(page, record.viewport);
      record.navigationOff = page.on?.("framenavigated", (event) => {
        if (!event.parentFrameId) this.#repin(record);
      });
      return this.#public(record, page);
    } catch (error) {
      await this.#connection.cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      throw error;
    }
  }

  #public<P extends Page | null>(record: OwnedTab<Page>, page: P): AgentTab<P> {
    return Object.freeze({
      targetId: record.targetId,
      page,
      viewport: { ...record.viewport },
      close: (options?: AgentTabCloseOptions) => this.close(record.targetId, options),
    });
  }
  get(targetId: string) {
    const record = this.#owned.get(targetId);
    return record ? this.#public(record, record.page) : null;
  }
  list() {
    return [...this.#owned.values()].map((record) => this.#public(record, record.page));
  }
  async #isHeadless() {
    if (typeof this.#connection.cdp.isHeadless === "boolean") return this.#connection.cdp.isHeadless;
    const version = await this.#connection.cdp.send("Browser.getVersion").catch(() => null);
    return /Headless/i.test(version?.product ?? "");
  }
  #ownedRecord(tabOrTargetId: TabRef) {
    const id = typeof tabOrTargetId === "string" ? tabOrTargetId : tabOrTargetId?.targetId;
    const record = id === undefined ? undefined : this.#owned.get(id);
    if (!record) throw Error(`Target ${id} is not owned by this manager`);
    return record;
  }
  #queueRepin(record: OwnedTab<Page>, viewport: ViewportSize, reportErrors = false) {
    const size = { ...viewport };
    const operation = record.repinQueue.then(async () => {
      try {
        if (!record.page) throw new TypeError(`Target ${record.targetId} has no attached page to repin`);
        await repinViewport(record.page, size);
      } catch (error) {
        if (reportErrors) console.warn(`[agent-tabs] viewport repin failed for ${record.targetId}`, error);
        else throw error;
      }
      record.viewport = Object.freeze(size);
      return { ...size };
    });
    record.repinQueue = operation.catch(() => {});
    return operation;
  }
  async #repin(record: OwnedTab<Page>) {
    await this.#queueRepin(record, record.viewport, true);
  }
  async repin(tabOrTargetId: TabRef, viewport: ViewportSize = this.viewport) {
    return this.#queueRepin(this.#ownedRecord(tabOrTargetId), viewport);
  }

  async close(tabOrTargetId: TabRef, options: AgentTabCloseOptions = {}): Promise<void> {
    const record = this.#ownedRecord(tabOrTargetId);
    const id = record.targetId;
    const existing = this.#closing.get(id);
    if (existing) return existing.promise;
    const { promise, resolve: resolveOperation, reject: rejectOperation } = Promise.withResolvers<void>();
    const entry: ClosingEntry = { promise, reject: rejectOperation };
    this.#closing.set(id, entry);
    this.#close(record, options)
      .then(resolveOperation, rejectOperation)
      .finally(() => {
        if (this.#closing.get(id) === entry) this.#closing.delete(id);
      });
    return promise;
  }

  async #close(record: OwnedTab<Page>, options: AgentTabCloseOptions) {
    const { promise: destroyed, resolve: resolveDestroy, reject: rejectDestroy } = Promise.withResolvers<void>();
    const timeout = setTimeout(
      () => rejectDestroy(Error(`Timed out waiting for target ${record.targetId} to close`)),
      options.timeoutMs ?? this.closeTimeoutMs,
    );
    const off = this.#connection.cdp.on("Target.targetDestroyed", (info) => {
      if (info?.targetId === record.targetId) resolveDestroy();
    });
    const offDisconnect = this.#connection.cdp.transportEvents?.on?.("disconnected", () =>
      rejectDestroy(Error("Browser transport disconnected")),
    );
    try {
      if (options.runBeforeUnload && record.page)
        await record.page.cdp
          .send("Page.close", undefined, await record.page.resolveSessionId())
          .catch(() => this.#connection.cdp.send("Target.closeTarget", { targetId: record.targetId }));
      else await this.#connection.cdp.send("Target.closeTarget", { targetId: record.targetId });
      if (this.#owned.has(record.targetId)) await destroyed;
    } finally {
      clearTimeout(timeout);
      off();
      offDisconnect?.();
      // Ownership is removed only by Target.targetDestroyed (or transport loss).
      if (!this.#owned.has(record.targetId)) record.navigationOff?.();
    }
  }

  #destroyed(id: string | undefined, error?: Error) {
    const record = id === undefined ? undefined : this.#owned.get(id);
    if (!record) return;
    record.navigationOff?.();
    this.#owned.delete(record.targetId);
    if (error) this.#closing.get(record.targetId)?.reject(error);
  }
  async closeAll(options: AgentTabCloseOptions = {}) {
    const results = await Promise.allSettled([...this.#owned.keys()].map((id) => this.close(id, options)));
    const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, "Failed to close one or more agent tabs");
  }
  async dispose(options: AgentTabDisposeOptions = { closeOwned: true }) {
    if (this.#disposed) return;
    let failure: unknown;
    if (options.closeOwned !== false)
      try {
        await this.closeAll(options);
      } catch (error) {
        failure = error;
      }
    this.#disposed = true;
    for (const off of this.#unsubscribers) off?.();
    this.#unsubscribers = [];
    if (failure) throw failure;
  }
}

export function createAgentTabs<Page extends AgentTabPage>(
  connection: AgentTabConnection<Page>,
  options: AgentTabsOptions = {},
): AgentTabManager<Page> {
  const current = managers.get(connection);
  if (current) {
    if (current._optionsKey !== optionsKey(options)) throw new TypeError("Conflicting AgentTabManager options");
    // Identity cache: the manager stored under this connection was built from it, so it carries this Page type.
    return current as AgentTabManager<Page>;
  }
  const manager = new AgentTabManager(connection, options);
  Object.defineProperty(manager, "_optionsKey", { value: optionsKey(options) });
  managers.set(connection, manager);
  return manager;
}
