import { DEFAULT_AGENT_VIEWPORT, repinViewport } from "./viewport.ts";
import type { ViewportSize } from "./viewport.ts";
import { targetCreationCapability } from "./internal-capability.ts";
import type { BrowserConnection } from "./connection.ts";
import type { CdpUnsubscribe } from "./cdp-protocol.ts";
import type { OmOPage } from "./core.ts";

type Page = InstanceType<typeof OmOPage>;

export interface AgentTabManagerOptions {
  viewport?: Partial<ViewportSize> | undefined;
  closeTimeoutMs?: number | undefined;
}

export interface CreateAgentTabOptions {
  viewport?: Partial<ViewportSize> | undefined;
  browserContextId?: string | undefined;
}

export interface AdoptAgentTabOptions {
  viewport?: Partial<ViewportSize> | undefined;
}

export interface CloseAgentTabOptions {
  timeoutMs?: number | undefined;
  runBeforeUnload?: boolean | undefined;
}

export interface DisposeAgentTabsOptions extends CloseAgentTabOptions {
  closeOwned?: boolean | undefined;
}

/** An owned tab whose page is attached. */
export interface AgentTab {
  readonly targetId: string;
  readonly page: Page;
  readonly viewport: ViewportSize;
  readonly close: (options?: CloseAgentTabOptions) => Promise<unknown>;
}

/** An owned tab view: its page is null while another adopt() is still attaching it. */
export interface AgentTabView extends Omit<AgentTab, "page"> {
  readonly page: Page | null;
}

interface TabRecord {
  targetId: string;
  page: Page | null;
  viewport: Readonly<ViewportSize>;
  repinQueue: Promise<unknown>;
  navigationOff?: (() => void) | undefined;
}

interface ClosingEntry {
  promise: Promise<unknown>;
  reject: (reason: unknown) => void;
}

const managers = new WeakMap<BrowserConnection, AgentTabManager>();
const CAPABILITY = targetCreationCapability;

function optionsKey(options: AgentTabManagerOptions = {}) {
  return JSON.stringify({
    viewport: { ...DEFAULT_AGENT_VIEWPORT, ...options.viewport },
    closeTimeoutMs: options.closeTimeoutMs ?? 5_000,
  });
}

export class AgentTabManager {
  #connection: BrowserConnection;
  #owned = new Map<string, TabRecord>();
  #unsubscribers: Array<CdpUnsubscribe | undefined> = [];
  #disposed = false;
  #closing = new Map<string, ClosingEntry>();
  viewport: Readonly<ViewportSize>;
  closeTimeoutMs: number;
  ready: Promise<unknown>;
  declare readonly _optionsKey: string;

  constructor(connection: BrowserConnection, options: AgentTabManagerOptions = {}) {
    if (!connection?.cdp) throw new TypeError("createAgentTabs requires a browser connection");
    this.#connection = connection;
    this.viewport = Object.freeze({ ...DEFAULT_AGENT_VIEWPORT, ...options.viewport });
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
    this.#unsubscribers.push(connection.cdp.on("Target.targetDestroyed", (info) => this.#destroyed(info?.targetId)));
    this.#unsubscribers.push(connection.cdp.on("Target.targetCrashed", (info) => this.#destroyed(info?.targetId)));
    this.#unsubscribers.push(
      connection.cdp.transportEvents?.on?.("disconnected", () => {
        for (const id of [...this.#owned.keys()]) this.#destroyed(id, Error("Browser transport disconnected"));
      }),
    );
    this.ready = Promise.resolve(connection.cdp.ensureConnected?.());
  }

  async create(url = "about:blank", options: CreateAgentTabOptions = {}): Promise<AgentTab> {
    if (this.#disposed) throw Error("Agent tab manager is disposed");
    await this.ready;
    const viewport = { ...this.viewport, ...options.viewport };
    // A headed browser keeps a background tab in a shared window hidden: it never
    // paints (Page.captureScreenshot hangs) and requestAnimationFrame never fires.
    // Its own window doesn't take focus from the user's tab, and the tab renders
    // (verified headed on Linux and macOS).
    const result = await this.#connection.cdp.send(
      "Target.createTarget",
      {
        url: "about:blank",
        background: true,
        newWindow: true,
        ...(options.browserContextId ? { browserContextId: options.browserContextId } : {}),
      },
      undefined,
      { capability: CAPABILITY },
    );
    const targetId = result.targetId;
    // CloakBrowser headless defers renderer startup for background targets until
    // activation; activating before attach avoids Page.enable timing out.
    if (await this.#isHeadless()) await this.#connection.cdp.send("Target.activateTarget", { targetId });
    // Finish session/domain setup on a stable document before starting a
    // navigation that can replace the renderer or its execution contexts.
    const tab = await this.adopt(targetId, { viewport });
    if (tab.page === null) throw new TypeError(`Target ${targetId} is still being adopted`);
    if (url !== "about:blank") await tab.page.goto(url);
    return Object.freeze({ ...tab, page: tab.page });
  }

  async adopt(targetId: string, options: AdoptAgentTabOptions = {}): Promise<AgentTabView> {
    if (this.#disposed) throw Error("Agent tab manager is disposed");
    const existing = this.#owned.get(targetId);
    if (existing) return this.#public(existing);
    const viewport = { ...this.viewport, ...options.viewport };
    const record: TabRecord = {
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

  #public(record: TabRecord): AgentTabView;
  #public(record: TabRecord, page: Page): AgentTab;
  #public(record: TabRecord, page: Page | null = record.page): AgentTabView {
    return Object.freeze({
      targetId: record.targetId,
      page,
      viewport: { ...record.viewport },
      close: (options?: CloseAgentTabOptions) => this.close(record.targetId, options),
    });
  }
  get(targetId: string | undefined): AgentTabView | null {
    const record = targetId === undefined ? undefined : this.#owned.get(targetId);
    return record ? this.#public(record) : null;
  }
  list(): AgentTabView[] {
    return [...this.#owned.values()].map((record) => this.#public(record));
  }
  async #isHeadless() {
    if (typeof this.#connection.cdp.isHeadless === "boolean") return this.#connection.cdp.isHeadless;
    const version = await this.#connection.cdp.send("Browser.getVersion").catch(() => null);
    return /Headless/i.test(version?.product ?? "");
  }
  #queueRepin(record: TabRecord, viewport: Readonly<ViewportSize>, reportErrors = false): Promise<ViewportSize> {
    const size = { ...viewport };
    const operation = record.repinQueue.then(async () => {
      try {
        // A record is repinned only after adopt() attached its page; the JS original threw here otherwise.
        if (record.page === null) throw new TypeError("Cannot read properties of null (reading 'resolveSessionId')");
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
  async #repin(record: TabRecord) {
    await this.#queueRepin(record, record.viewport, true);
  }
  async repin(
    tabOrTargetId: string | { targetId: string } | null | undefined,
    viewport: Readonly<ViewportSize> = this.viewport,
  ) {
    const id = typeof tabOrTargetId === "string" ? tabOrTargetId : tabOrTargetId?.targetId;
    const record = id === undefined ? undefined : this.#owned.get(id);
    if (!record) throw Error(`Target ${id} is not owned by this manager`);
    return this.#queueRepin(record, viewport);
  }

  async close(
    tabOrTargetId: string | { targetId: string } | null | undefined,
    options: CloseAgentTabOptions = {},
  ): Promise<unknown> {
    const id = typeof tabOrTargetId === "string" ? tabOrTargetId : tabOrTargetId?.targetId;
    const record = id === undefined ? undefined : this.#owned.get(id);
    if (!record || id === undefined) throw Error(`Target ${id} is not owned by this manager`);
    const existing = this.#closing.get(id);
    if (existing) return existing.promise;
    const { promise, resolve: resolveOperation, reject: rejectOperation } = Promise.withResolvers<unknown>();
    const entry: ClosingEntry = { promise, reject: rejectOperation };
    this.#closing.set(id, entry);
    this.#close(record, options)
      .then(resolveOperation, rejectOperation)
      .finally(() => {
        if (this.#closing.get(id) === entry) this.#closing.delete(id);
      });
    return promise;
  }

  async #close(record: TabRecord, options: CloseAgentTabOptions) {
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
    if (id === undefined) return;
    const record = this.#owned.get(id);
    if (!record) return;
    record.navigationOff?.();
    this.#owned.delete(id);
    if (error) this.#closing.get(id)?.reject(error);
  }
  async closeAll(options: CloseAgentTabOptions = {}) {
    const results = await Promise.allSettled([...this.#owned.keys()].map((id) => this.close(id, options)));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, "Failed to close one or more agent tabs");
  }
  async dispose(options: DisposeAgentTabsOptions = { closeOwned: true }) {
    if (this.#disposed) return;
    let failure: unknown;
    if (options.closeOwned !== false)
      try {
        await this.closeAll(options);
      } catch (error) {
        failure = error;
      }
    this.#disposed = true;
    for (const off of this.#unsubscribers) {
      // FINDING: a transport without transportEvents.on leaves undefined here, and
      // the JS original threw this TypeError calling it; kept as is.
      if (off === undefined) throw new TypeError("off is not a function");
      off();
    }
    this.#unsubscribers = [];
    if (failure) throw failure;
  }
}

export function getAgentTabs(connection: BrowserConnection) {
  return managers.get(connection);
}

export function createAgentTabs(connection: BrowserConnection, options: AgentTabManagerOptions = {}) {
  const current = managers.get(connection);
  if (current) {
    if (current._optionsKey !== optionsKey(options)) throw new TypeError("Conflicting AgentTabManager options");
    return current;
  }
  const manager = new AgentTabManager(connection, options);
  Object.defineProperty(manager, "_optionsKey", { value: optionsKey(options) });
  managers.set(connection, manager);
  return manager;
}
