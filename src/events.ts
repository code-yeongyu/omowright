import type {
  CdpDownloadWillBegin,
  CdpEventMeta,
  CdpEventPayload,
  CdpTargetInfo,
  CdpTransport,
} from "./cdp-protocol.ts";

export type BrowserEventName =
  | "tabOpened"
  | "tabClosed"
  | "popupOpened"
  | "downloadStarted"
  | "downloadProgress"
  | "downloadFinished";
const EVENT_NAMES: readonly BrowserEventName[] = [
  "tabOpened",
  "tabClosed",
  "popupOpened",
  "downloadStarted",
  "downloadProgress",
  "downloadFinished",
];
export const BROWSER_EVENT_NAMES: readonly BrowserEventName[] = Object.freeze([...EVENT_NAMES]);
const DEFAULT_TIMEOUT = 30_000;
const TERMINAL_LIMIT = 4_096;

export type DownloadBehavior = "default" | "allow" | "deny" | "allowAndName";
type CdpDownloadState = CdpEventPayload<"Browser.downloadProgress">["state"];

export interface BrowserEventsOptions {
  downloadBehavior?: DownloadBehavior;
  /** Absolute path; required when `downloadBehavior` is "allow". */
  downloadPath?: string | undefined;
}

export interface BrowserEventsConnection {
  readonly cdp: Pick<CdpTransport, "ensureConnected" | "on" | "send" | "transportEvents">;
}

export interface BrowserTabTarget {
  targetId: string;
  type: "page";
  url: string;
  title: string;
  openerId: string | null;
  openerFrameId: string | null;
  browserContextId: string | null;
  attached: boolean;
  subtype: string | null;
}

export interface BrowserDownloadError {
  code: "browserDisconnected";
  message: string;
}

export interface BrowserEventPayloads {
  tabOpened: BrowserTabTarget & { popup: boolean; initial: boolean };
  tabClosed: {
    targetId: string;
    reason: "crashed" | "destroyed";
    lastKnown: BrowserTabTarget;
    crash: TargetCrash | null;
  };
  popupOpened: {
    targetId: string;
    openerTargetId: string | null;
    openerFrameId: string | null;
    url: string;
    title: string;
    initial: boolean;
  };
  downloadStarted: {
    guid: string;
    url: string | null;
    suggestedFilename: string;
    frameId: string | null;
    targetId: string | null;
  };
  downloadProgress: {
    guid: string;
    totalBytes: number;
    receivedBytes: number;
    state: CdpDownloadState | undefined;
    filePath: string | null;
    targetId: string | null;
  };
  downloadFinished: {
    guid: string;
    totalBytes: number;
    receivedBytes: number;
    state: "completed" | "canceled" | "failed";
    cdpState: CdpDownloadState | null;
    filePath: string | null;
    targetId: string | null;
    error: BrowserDownloadError | null;
  };
}

export type BrowserEventListener<N extends BrowserEventName> = (payload: BrowserEventPayloads[N]) => unknown;

export interface WaitForBrowserEventOptions<N extends BrowserEventName> {
  timeout?: number;
  predicate?: (payload: BrowserEventPayloads[N]) => unknown;
}

interface TargetCrash {
  status: string;
  errorCode: number;
}

interface DownloadRecord {
  guid: string;
  url: string | null;
  suggestedFilename: string;
  frameId: string | null;
  targetId: string | null;
  totalBytes: number;
  receivedBytes: number;
  filePath: string | null;
}

/** A target as CDP reports it, either bare (Target.getTargets) or wrapped (Target.targetCreated). */
type TargetEventInfo = Partial<CdpTargetInfo> & { targetInfo?: Partial<CdpTargetInfo> };
type PageTargetInfo = Partial<CdpTargetInfo> & { targetId: string };
/** Frame events may carry the session inline as well as in the envelope meta. */
type InlineSession = { sessionId?: string };
type BrowserEventListeners = { [N in BrowserEventName]: Set<BrowserEventListener<N>> };

function emptyListeners(): BrowserEventListeners {
  return {
    tabOpened: new Set(),
    tabClosed: new Set(),
    popupOpened: new Set(),
    downloadStarted: new Set(),
    downloadProgress: new Set(),
    downloadFinished: new Set(),
  };
}

function isPageTarget(info: Partial<CdpTargetInfo> | undefined): info is PageTargetInfo {
  return info?.type === "page" && Boolean(info?.targetId);
}
function pageTarget(info: Partial<CdpTargetInfo> | undefined) {
  return isPageTarget(info) ? info : null;
}
function normalizeTarget(info: PageTargetInfo): BrowserTabTarget {
  return {
    targetId: String(info.targetId),
    type: "page",
    url: info.url ?? "about:blank",
    title: info.title ?? "",
    openerId: info.openerId ?? null,
    openerFrameId: info.openerFrameId ?? null,
    browserContextId: info.browserContextId ?? null,
    attached: Boolean(info.attached),
    subtype: info.subtype ?? null,
  };
}
function errorValue(value: unknown) {
  return value instanceof Error ? value : Error(String(value));
}
function byOpenerLast(a: Partial<CdpTargetInfo>, b: Partial<CdpTargetInfo>) {
  return Number(Boolean(a.openerId)) - Number(Boolean(b.openerId));
}

class BrowserEventBridge {
  #cdp: BrowserEventsConnection["cdp"];
  #options: BrowserEventsOptions & { downloadBehavior: DownloadBehavior };
  #listeners = emptyListeners();
  #unsubscribers: Array<() => unknown> = [];
  #targetInfos = new Map<string, BrowserTabTarget>();
  #crashes = new Map<string, TargetCrash>();
  #downloads = new Map<string, DownloadRecord>();
  #terminalDownloads = new Map<string, DownloadRecord>();
  #terminal = new Set<string>();
  #frameToTarget = new Map<string, string>();
  #sessionToTarget = new Map<string, string>();
  #waits = new Set<(error?: Error) => void>();
  #disposed = false;
  #explicitDispose = false;
  ready: Promise<void>;
  constructor(connection: BrowserEventsConnection, options: BrowserEventsOptions) {
    if (!connection?.cdp) throw new TypeError("createEvents requires a browser connection");
    this.#cdp = connection.cdp;
    this.#options = this.#validate(options);
    this.#register();
    this.ready = this.#initialize();
  }
  #validate(options: BrowserEventsOptions) {
    const behavior = options.downloadBehavior ?? "default";
    if (!["default", "allow", "deny", "allowAndName"].includes(behavior))
      throw new TypeError("Invalid downloadBehavior");
    if (behavior === "allow" && !pathIsAbsolute(options.downloadPath))
      throw new TypeError("downloadPath must be an absolute path for allow");
    return { ...options, downloadBehavior: behavior };
  }
  #register() {
    const on = <E extends string>(method: E, fn: (payload: CdpEventPayload<E>, meta: CdpEventMeta) => unknown) =>
      this.#unsubscribers.push(this.#cdp.on(method, fn));
    on("Target.targetCreated", (info: TargetEventInfo) => this.#created(info, false));
    on("Target.targetDestroyed", (info) => this.#destroyed(info));
    on("Target.targetInfoChanged", (info) => {
      const target = pageTarget(info?.targetInfo);
      if (target && this.#targetInfos.has(target.targetId))
        this.#targetInfos.set(target.targetId, normalizeTarget(target));
    });
    on("Target.targetCrashed", (info) => {
      if (info?.targetId)
        this.#crashes.set(info.targetId, { status: info.status ?? "", errorCode: info.errorCode ?? 0 });
    });
    on("Target.attachedToTarget", (info, meta) => {
      const targetId = info?.targetInfo?.targetId;
      const sessionId = info?.sessionId ?? meta?.sessionId;
      if (targetId && sessionId) {
        this.#sessionToTarget.set(sessionId, targetId);
      }
    });
    on("Target.detachedFromTarget", (info, meta) => {
      const sessionId = info?.sessionId ?? meta?.sessionId;
      if (sessionId) this.#sessionToTarget.delete(sessionId);
    });
    on("Browser.downloadWillBegin", (info) => this.#downloadBegin(info));
    on("Browser.downloadProgress", (info) => this.#downloadProgress(info));
    on("Page.frameAttached", (info: CdpEventPayload<"Page.frameAttached"> & InlineSession, meta) => {
      const sessionId = info?.sessionId ?? meta?.sessionId;
      if (sessionId && info?.frameId) this.#mapFrame(info.frameId, sessionId);
    });
    on("Page.frameNavigated", (info: CdpEventPayload<"Page.frameNavigated"> & InlineSession, meta) => {
      const sessionId = info?.sessionId ?? meta?.sessionId;
      if (sessionId && info?.frame?.id) this.#mapFrame(info.frame.id, sessionId);
    });
    if (this.#cdp.transportEvents?.on) {
      this.#unsubscribers.push(
        this.#cdp.transportEvents.on("disconnected", () => {
          this.#disconnectDownloads();
          this.#cancelWaits(Error("Browser transport disconnected"));
        }),
      );
      this.#unsubscribers.push(
        this.#cdp.transportEvents.on("reconnected", () => {
          this.#reconcile().catch((error) => console.warn("[events] target reconciliation failed", error));
          this.#configureDownloads().catch((error) => console.warn("[events] download reconfiguration failed", error));
        }),
      );
    }
  }
  async #initialize() {
    await this.#cdp.ensureConnected();
    await this.#cdp.send("Target.setDiscoverTargets", { discover: true });
    const result = await this.#cdp.send("Target.getTargets");
    await this.#configureDownloads();
    const targets = (result?.targetInfos ?? []).filter((info) => pageTarget(info));
    targets.sort(byOpenerLast);
    for (const info of targets) this.#created(info, true);
  }
  async #reconcile() {
    const result = await this.#cdp.send("Target.getTargets");
    const current = new Set(
      (result?.targetInfos ?? []).filter((info) => pageTarget(info)).map((info) => String(info.targetId)),
    );
    for (const id of [...this.#targetInfos.keys()]) if (!current.has(id)) this.#destroyed({ targetId: id });
    const targets = (result?.targetInfos ?? []).filter((info) => pageTarget(info));
    targets.sort(byOpenerLast);
    for (const info of targets) this.#created(info, true);
  }
  async #configureDownloads() {
    const params: { behavior: DownloadBehavior; eventsEnabled: boolean; downloadPath?: string | undefined } = {
      behavior: this.#options.downloadBehavior,
      eventsEnabled: true,
    };
    if (this.#options.downloadBehavior === "allow" || this.#options.downloadBehavior === "allowAndName")
      params.downloadPath = this.#options.downloadPath;
    await this.#cdp.send("Browser.setDownloadBehavior", params);
  }
  #mapFrame(frameId: string, sessionId: string) {
    const targetId =
      this.#sessionToTarget.get(sessionId) ??
      [...this.#targetInfos.values()].find((info) => info.attached && info.targetId === sessionId)?.targetId;
    if (targetId) this.#frameToTarget.set(frameId, targetId);
  }
  #created(info: TargetEventInfo | undefined, initial: boolean) {
    const target = pageTarget(info?.targetInfo ?? info);
    if (!target) return;
    const normalized = normalizeTarget(target);
    const id = normalized.targetId;
    if (this.#targetInfos.has(id)) return;
    this.#targetInfos.set(id, normalized);
    const popup = Boolean(normalized.openerId && this.#targetInfos.has(normalized.openerId));
    this.#dispatch("tabOpened", { ...normalized, popup, initial: Boolean(initial) });
    if (popup)
      this.#dispatch("popupOpened", {
        targetId: id,
        openerTargetId: normalized.openerId,
        openerFrameId: normalized.openerFrameId,
        url: normalized.url,
        title: normalized.title,
        initial: Boolean(initial),
      });
  }
  #destroyed(info: { targetId?: string } | undefined) {
    // Keys are always strings, so a missing id finds nothing, exactly as a Map lookup of undefined would.
    const id = info?.targetId;
    if (id === undefined) return;
    const last = this.#targetInfos.get(id);
    if (!last) return;
    this.#targetInfos.delete(id);
    const crash = this.#crashes.get(id) ?? null;
    this.#crashes.delete(id);
    for (const [frame, targetId] of this.#frameToTarget) if (targetId === id) this.#frameToTarget.delete(frame);
    this.#dispatch("tabClosed", { targetId: id, reason: crash ? "crashed" : "destroyed", lastKnown: last, crash });
  }
  #rememberTerminal(guid: string) {
    this.#terminal.delete(guid);
    this.#terminal.add(guid);
    if (this.#terminal.size > TERMINAL_LIMIT) {
      const oldest = this.#terminal.values().next().value;
      if (oldest !== undefined) {
        this.#terminal.delete(oldest);
        this.#terminalDownloads.delete(oldest);
      }
    }
  }
  #downloadBegin(info: Partial<CdpDownloadWillBegin> = {}) {
    if (!info.guid || this.#terminal.has(info.guid)) return;
    const targetId = info.frameId === undefined ? undefined : this.#frameToTarget.get(info.frameId);
    const record: DownloadRecord = {
      guid: info.guid,
      url: info.url ?? null,
      suggestedFilename: info.suggestedFilename ?? "",
      frameId: info.frameId ?? null,
      targetId: targetId ?? null,
      totalBytes: 0,
      receivedBytes: 0,
      filePath: null,
    };
    this.#downloads.set(info.guid, record);
    this.#dispatch("downloadStarted", {
      guid: record.guid,
      url: record.url,
      suggestedFilename: record.suggestedFilename,
      frameId: record.frameId,
      targetId: record.targetId,
    });
  }
  #downloadProgress(info: Partial<CdpEventPayload<"Browser.downloadProgress">> = {}) {
    if (!info.guid) return;
    const alreadyTerminal = this.#terminal.has(info.guid);
    const record = this.#downloads.get(info.guid) ?? this.#terminalDownloads.get(info.guid);
    if (!record) return;
    Object.assign(record, {
      totalBytes: Number(info.totalBytes ?? 0),
      receivedBytes: Number(info.receivedBytes ?? 0),
      filePath: info.filePath ?? null,
    });
    this.#dispatch("downloadProgress", {
      guid: info.guid,
      totalBytes: record.totalBytes,
      receivedBytes: record.receivedBytes,
      state: info.state,
      filePath: record.filePath,
      targetId: record.targetId,
    });
    if ((info.state === "completed" || info.state === "canceled") && !alreadyTerminal) {
      this.#rememberTerminal(info.guid);
      this.#downloads.delete(info.guid);
      this.#terminalDownloads.set(info.guid, record);
      this.#dispatch("downloadFinished", {
        guid: info.guid,
        totalBytes: record.totalBytes,
        receivedBytes: record.receivedBytes,
        state: info.state,
        cdpState: info.state,
        filePath: record.filePath,
        targetId: record.targetId,
        error: null,
      });
    }
  }
  #disconnectDownloads() {
    if (this.#explicitDispose) return;
    for (const record of this.#downloads.values()) {
      this.#rememberTerminal(record.guid);
      this.#dispatch("downloadFinished", {
        guid: record.guid,
        totalBytes: record.totalBytes,
        receivedBytes: record.receivedBytes,
        state: "failed",
        cdpState: null,
        filePath: record.filePath,
        targetId: record.targetId,
        error: { code: "browserDisconnected", message: "Browser transport disconnected" },
      });
    }
    this.#downloads.clear();
  }
  #dispatch<N extends BrowserEventName>(name: N, payload: BrowserEventPayloads[N]) {
    const listeners = [...this.#listeners[name]];
    Promise.allSettled(listeners.map((listener) => Promise.resolve().then(() => listener(payload)))).then((results) =>
      results
        .filter((r) => r.status === "rejected")
        .forEach((r) => console.warn(`[events] ${name} listener failed`, r.reason)),
    );
  }
  on<N extends BrowserEventName>(name: N, listener: BrowserEventListener<N>) {
    this.#assertName(name);
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    this.#listeners[name].add(listener);
    return () => this.off(name, listener);
  }
  off<N extends BrowserEventName>(name: N, listener: BrowserEventListener<N>) {
    this.#assertName(name);
    this.#listeners[name].delete(listener);
  }
  #cancelWaits(error?: Error) {
    for (const cancel of this.#waits) cancel(error);
    this.#waits.clear();
  }
  waitForEvent<N extends BrowserEventName>(
    name: N,
    options: WaitForBrowserEventOptions<N> = {},
  ): Promise<BrowserEventPayloads[N]> {
    this.#assertName(name);
    if (this.#disposed) return Promise.reject(Error("Events bridge is disposed"));
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    return new Promise((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const off = this.on(name, async (value) => {
        try {
          if (options.predicate && !(await options.predicate(value))) return;
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.#waits.delete(cancel);
          off();
          resolve(value);
        } catch (error) {
          if (!done) {
            done = true;
            clearTimeout(timer);
            this.#waits.delete(cancel);
            off();
            reject(errorValue(error));
          }
        }
      });
      const cancel = (error?: Error) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          this.#waits.delete(cancel);
          off();
          reject(error ?? Error("Events bridge disposed"));
        }
      };
      this.#waits.add(cancel);
      timer = setTimeout(() => cancel(Error(`Timed out waiting for browser event "${name}"`)), timeout);
    });
  }
  #assertName(name: string) {
    if (!EVENT_NAMES.some((known) => known === name)) throw new TypeError(`Unknown browser event: ${String(name)}`);
  }
  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#explicitDispose = true;
    this.#cancelWaits();
    for (const off of this.#unsubscribers) off();
    this.#unsubscribers = [];
    this.#listeners = emptyListeners();
    await this.ready.catch(() => {});
  }
}
function pathIsAbsolute(value: unknown) {
  return typeof value === "string" && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value));
}
export function createEvents(connection: BrowserEventsConnection, options: BrowserEventsOptions = {}) {
  return new BrowserEventBridge(connection, options);
}
