import { WebSocket } from "ws";
import * as z from "zod";
import path from "node:path";
import { copyFile, mkdir, unlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { pageBundle } from "./injected.ts";
import { targetCreationCapability } from "./internal-capability.ts";
import type {
  CdpDownloadWillBegin,
  CdpEventMeta,
  CdpEventPayload,
  CdpFrameTree,
  CdpResult,
  CdpSendOptions,
  CdpTransport,
  CdpUnsubscribe,
} from "./cdp-protocol.ts";

export interface ConsoleLogEntry {
  level: string;
  message: string;
  timestamp: string;
}

export interface ConsoleDrainOptions {
  levels?: string[];
  filter?: string;
  limit?: number;
}

declare global {
  interface Window {
    __omowrightConsole?: {
      logs: ConsoleLogEntry[];
      drain(options?: ConsoleDrainOptions): ConsoleLogEntry[];
      clear(): void;
    };
  }
}

const __defProp = Object.defineProperty;
const __exportAll = <D extends Record<string, () => unknown>>(definitions: D, namespace?: boolean) => {
  const exports: Record<string, unknown> = {};
  for (const name in definitions) __defProp(exports, name, { get: definitions[name], enumerable: true });
  if (!namespace) __defProp(exports, Symbol.toStringTag, { value: "Module" });
  return exports as { readonly [K in keyof D]: ReturnType<D[K]> };
};

const __esmMin =
  <T>(factory: ((ignored: 0) => T) | 0, value?: T, error?: [unknown]) =>
  (): T | undefined => {
    if (error) throw error[0];
    try {
      return (factory && (value = factory((factory = 0))), value);
    } catch (caught) {
      error = [caught];
      throw caught;
    }
  };

function unsetResolver(): void {}

if (!Promise.withResolvers) {
  Promise.withResolvers = <T>() => {
    let resolve: (value: T | PromiseLike<T>) => void = unsetResolver;
    let reject: (reason?: unknown) => void = unsetResolver;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

interface EmitteryEvent<D> {
  data: D;
  eventName: string;
}

class Emittery<D = void> {
  #listeners = new Map<string, Set<(event: EmitteryEvent<D>) => unknown>>();
  on(name: string, listener: (event: EmitteryEvent<D>) => unknown) {
    const listeners = this.#listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(name, listeners);
    return () => {
      listeners.delete(listener);
    };
  }
  async emit(name: string, data: D) {
    const event = { data, eventName: name };
    await Promise.all([...(this.#listeners.get(name) ?? [])].map((listener) => listener(event)));
  }
  clearListeners() {
    this.#listeners.clear();
  }
}

const { object, string: string$2, number: number$2, array, union: union$1, unknown: unknown$1, null: _null } = z;
const OMOWRIGHT_BROWSER_CDP_HOST = "127.0.0.1:9222";
const SESSION_ARTIFACTS_DIR = path.join(tmpdir(), "omowright-artifacts");

const noop = () => {};
const init_emittery = noop,
  init_zod = noop,
  init_context = noop,
  init_utils$13 = noop,
  init_config = noop,
  init_extension_bridge = noop,
  init_commands$1 = noop,
  init_directory = noop,
  init_process = noop,
  init_event_bus = noop,
  init_state_db = noop,
  init_schema = noop,
  init_store$1 = noop,
  init_drizzle_orm = noop,
  init_types$8 = noop,
  init_nanoid = noop;

function sleep$12(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? Error("Aborted"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function getCurrentReplAbortSignal(): AbortSignal | undefined {
  return undefined;
}

function withCurrentReplAbort<T>(fn: () => T) {
  return fn();
}
function withoutReplContext<T>(fn: () => T) {
  return fn();
}
function replPrint(...values: unknown[]) {
  console.warn(...values);
}
async function sendCommandToExtension(
  command: { method: string; params?: unknown },
  _options?: object,
): Promise<never> {
  throw new UnsupportedOperationError(`Extension command is unavailable: ${command.method}`);
}
class UnsupportedOperationError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "UnsupportedOperationError";
  }
}

const stateDb = (..._args: unknown[]): never => {
  throw new UnsupportedOperationError("Daemon persistence is unavailable");
};

function spawnCommand(..._args: unknown[]): never {
  throw new UnsupportedOperationError("Video recording is unavailable");
}
async function waitForExitCode(..._args: unknown[]) {
  return 1;
}
function isWebSocketUrl(xn: string) {
  return xn.startsWith(`ws://`) || xn.startsWith(`wss://`);
}
interface StatusCarrier {
  status?: unknown;
  response?: { status?: unknown };
  error?: { status?: unknown; message?: unknown };
  cause?: { status?: unknown; message?: unknown };
}
function isAuthorizationError(xn: unknown) {
  let jn = xn instanceof Error ? xn.message : String(xn),
    Vn: StatusCarrier = (typeof xn == `object` && xn !== null) || typeof xn == `function` ? xn : {};
  return (
    jn.includes(`401`) ||
    jn.includes(`403`) ||
    jn.includes(`Missing or invalid Authorization header.`) ||
    jn.includes(`Unauthorized`) ||
    jn.includes(`Forbidden`) ||
    (typeof Vn.status == `number` && (Vn.status === 401 || Vn.status === 403)) ||
    (typeof Vn.response?.status == `number` && (Vn.response.status === 401 || Vn.response.status === 403)) ||
    (typeof Vn.error?.status == `number` && (Vn.error.status === 401 || Vn.error.status === 403)) ||
    (typeof Vn.cause?.status == `number` && (Vn.cause.status === 401 || Vn.cause.status === 403)) ||
    String(Vn.error?.message ?? ``).includes(`Missing or invalid Authorization header.`) ||
    String(Vn.cause?.message ?? ``).includes(`Missing or invalid Authorization header.`)
  );
}
function normalizeBaseUrl(xn: string) {
  return xn.replace(/\/$/, ``);
}
function createAbortError$1() {
  let xn = Error(`Operation aborted`);
  return ((xn.name = `AbortError`), xn);
}

export interface CdpDiscoveryOptions {
  forceRefresh?: boolean;
}

export interface CdpAuthorizer {
  resolveAuthorization(options: CdpDiscoveryOptions): Promise<string>;
}

export interface CdpClientOptions {
  cdpUrl?: string;
  logId?: string;
  authorizer?: CdpAuthorizer;
  commandTimeoutMs?: number;
  reconnectDelaysMs?: number[];
}

interface PendingCdpCommand {
  method: string;
  reject: (reason: unknown) => void;
  resolve: (value: unknown) => void;
  timeout: ReturnType<typeof setTimeout> | undefined;
}

interface CdpEventEnvelope {
  payload: unknown;
  meta: CdpEventMeta;
}

interface CdpWireCommand {
  id: number;
  method: string;
  params?: object;
  sessionId?: string;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 3e4;
const DEFAULT_RECONNECT_DELAYS_MS = [0, 250, 750, 1500, 3e3];
const jsonVersionSchema = object({
  Browser: string$2().optional(),
  "Protocol-Version": string$2().optional(),
  "User-Agent": string$2().optional(),
  "V8-Version": string$2().optional(),
  "WebKit-Version": string$2().optional(),
  webSocketDebuggerUrl: string$2(),
}).loose();
const jsonTargetSchema = object({
  description: string$2().optional(),
  devtoolsFrontendUrl: string$2().optional(),
  faviconUrl: string$2().optional(),
  id: string$2(),
  parentId: string$2().optional(),
  title: string$2().default(``),
  type: string$2(),
  url: string$2().default(``),
  webSocketDebuggerUrl: string$2().optional(),
}).loose();
const cdpWireMessageSchema = union$1([
  object({
    id: number$2(),
    sessionId: string$2().optional(),
    error: object({ code: number$2().optional(), data: unknown$1().optional(), message: string$2() })
      .loose()
      .optional(),
    result: unknown$1().optional(),
  }).loose(),
  object({ method: string$2(), params: unknown$1().optional(), sessionId: string$2().optional() }).loose(),
  _null(),
]);
type CdpWireMessage = NonNullable<z.output<typeof cdpWireMessageSchema>>;
type CdpWireResponse = Extract<CdpWireMessage, { id: number }>;
function isCdpWireResponse(message: CdpWireMessage): message is CdpWireResponse {
  return typeof message.id == `number`;
}
const BrowserCdpCommandError = class extends Error {
  method: string;
  code: number | undefined;
  data: unknown;
  constructor(xn: string, jn?: number, Vn?: unknown, qn?: string) {
    super(qn ?? `CDP command failed: ${xn}`);
    ((this.method = xn), (this.code = jn), (this.data = Vn));
  }
};
type BrowserCdpCommandError = InstanceType<typeof BrowserCdpCommandError>;
const CdpClient = class {
  cdpUrl: string;
  logId: string;
  #e: CdpAuthorizer | undefined;
  #t: number;
  #n: number[];
  #r: WebSocket | null = null;
  #i: Promise<void> | null = null;
  #a: ReturnType<typeof setTimeout> | null = null;
  #o = !1;
  #s = 1;
  #c = new Map<number, PendingCdpCommand>();
  #l = new Emittery<CdpEventEnvelope>();
  #u = !1;
  transportEvents = new Emittery();
  constructor(xn: CdpClientOptions = {}) {
    ((this.cdpUrl = normalizeBaseUrl(xn.cdpUrl ?? `http://${OMOWRIGHT_BROWSER_CDP_HOST}`)),
      (this.logId = xn.logId ?? `cdp-${Date.now()}`),
      (this.#e = xn.authorizer),
      (this.#t = xn.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS),
      (this.#n = xn.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS));
  }
  get isConnected() {
    return this.#r?.readyState === WebSocket.OPEN;
  }
  start() {
    this.#o ||
      ((this.#o = !0),
      this.ensureConnected().catch((xn) => {
        (console.warn(`[${this.logId}] Initial CDP connect failed`, xn), this.#b());
      }));
  }
  async discoverVersion(xn: CdpDiscoveryOptions = {}) {
    return await this.#f(this.#d(`/json/version`), jsonVersionSchema, xn);
  }
  async discoverTargets(xn: CdpDiscoveryOptions = {}) {
    return await this.#f(this.#d(`/json/list`), array(jsonTargetSchema), xn);
  }
  async ensureConnected() {
    if (((this.#o = !0), this.isConnected)) return;
    if (this.#i) {
      await this.#i;
      return;
    }
    let xn = this.#g();
    this.#i = xn;
    try {
      await xn;
    } finally {
      this.#i === xn && (this.#i = null);
    }
  }
  async send<M extends string>(xn: M, jn?: object, Vn?: string, qn: CdpSendOptions = {}): Promise<CdpResult<M>> {
    if (xn === `Target.createTarget` && qn.capability !== targetCreationCapability)
      throw Error(`Target.createTarget is reserved for createAgentTabs`);
    let Jn = getCurrentReplAbortSignal();
    if (Jn?.aborted) throw createAbortError$1();
    if (xn.startsWith(`OmO.`)) {
      let Vn = await sendCommandToExtension({ method: xn, params: jn }, { ...qn.extensionBridge, signal: Jn });
      if (Jn?.aborted) throw createAbortError$1();
      return Vn;
    }
    await this.ensureConnected();
    let Yn = this.#r;
    if (!Yn || Yn.readyState !== WebSocket.OPEN) throw Error(`CDP websocket is not connected`);
    let Zn = this.#s++,
      Qn: CdpWireCommand = { id: Zn, method: xn };
    (jn !== void 0 && (Qn.params = jn), Vn && (Qn.sessionId = Vn));
    let { promise: ei, reject: ti, resolve: ni } = Promise.withResolvers<unknown>(),
      ri = qn.timeoutMs ?? this.#t,
      ii =
        ri > 0
          ? setTimeout(() => {
              (this.#c.delete(Zn), ti(Error(`CDP command timeout: ${String(xn)}`)));
            }, ri)
          : void 0,
      ai = Jn
        ? () => {
            (ii && clearTimeout(ii), this.#c.delete(Zn), ti(createAbortError$1()));
          }
        : void 0;
    if (
      (this.#c.set(Zn, { method: String(xn), reject: ti, resolve: ni, timeout: ii }),
      ai && Jn?.addEventListener(`abort`, ai, { once: !0 }),
      Jn?.aborted)
    )
      return (ai?.(), (await ei) as CdpResult<M>);
    try {
      Yn.send(JSON.stringify(Qn));
    } catch (xn) {
      throw (
        ii && clearTimeout(ii),
        this.#c.delete(Zn),
        ai && Jn?.removeEventListener(`abort`, ai),
        xn instanceof Error ? xn : Error(String(xn))
      );
    }
    try {
      return (await ei) as CdpResult<M>;
    } finally {
      ai && Jn?.removeEventListener(`abort`, ai);
    }
  }
  on<E extends string>(xn: E, jn: (payload: CdpEventPayload<E>, meta: CdpEventMeta) => unknown) {
    return this.#l.on(xn, ({ data: xn }) => jn(xn.payload as CdpEventPayload<E>, xn.meta));
  }
  async close() {
    ((this.#o = !1), (this.#a &&= (clearTimeout(this.#a), null)));
    let xn = this.#r;
    ((this.#r = null), this.#x(Error(`CDP client closed`)));
    if (xn && xn.readyState <= WebSocket.OPEN)
      try {
        xn.close(1e3, `client closing`);
      } catch {}
  }
  #d(xn: string) {
    let jn = new URL(this.cdpUrl);
    return isWebSocketUrl(this.cdpUrl)
      ? ((jn.protocol = jn.protocol === `wss:` ? `https:` : `http:`),
        (jn.pathname = xn),
        (jn.search = ``),
        jn.toString())
      : ((jn.pathname = xn), (jn.search = ``), jn.toString());
  }
  async #f<S extends z.ZodType>(xn: string, jn: S, Vn: CdpDiscoveryOptions = {}): Promise<z.output<S>> {
    let qn = await this.#p(Vn),
      Jn = await fetch(xn, { headers: qn });
    if ((Jn.status === 401 || Jn.status === 403) && this.#e && !Vn.forceRefresh)
      return await this.#f(xn, jn, { forceRefresh: !0 });
    if (!Jn.ok) throw Error(`CDP discovery request failed (${Jn.status} ${Jn.statusText})`);
    return jn.parse(await Jn.json());
  }
  async #p(xn: CdpDiscoveryOptions = {}): Promise<Record<string, string>> {
    return this.#e ? { Authorization: await this.#e.resolveAuthorization(xn) } : {};
  }
  async #m(xn: CdpDiscoveryOptions = {}) {
    let jn = await this.#p(xn);
    return isWebSocketUrl(this.cdpUrl)
      ? { headers: jn, wsUrl: this.cdpUrl }
      : { headers: jn, wsUrl: (await this.discoverVersion(xn)).webSocketDebuggerUrl };
  }
  async #g() {
    let xn: unknown = null,
      jn = !1;
    for (let Vn of this.#n) {
      Vn > 0 && (await sleep$12(Vn));
      try {
        await this.#_({ forceRefresh: jn });
        return;
      } catch (Vn) {
        let qn = Vn ?? Error(`Unknown error`);
        ((xn = qn), isAuthorizationError(qn) && (jn = !0));
      }
    }
    throw xn instanceof Error ? xn : Error(String(xn ?? `Failed to connect CDP websocket`));
  }
  async #_(xn: CdpDiscoveryOptions = {}) {
    let { headers: jn, wsUrl: Vn } = await this.#m(xn);
    await new Promise<void>((xn, qn) => {
      let Jn = new WebSocket(Vn, { headers: jn }),
        Yn = !1,
        Zn = (xn: unknown) => {
          Yn || ((Yn = !0), qn(xn));
        };
      (Jn.addEventListener(`open`, () => {
        Yn || ((Yn = !0), this.#v(Jn), xn());
      }),
        Jn.addEventListener(`message`, (xn) => {
          this.#r === Jn && this.#S(xn.data).catch(() => {});
        }),
        Jn.addEventListener(`close`, (xn) => {
          (this.#r === Jn && this.#y(Jn),
            Yn || Zn(Error(`CDP websocket closed during connect (${xn.code} ${xn.reason || `no reason`})`)));
        }),
        Jn.addEventListener(`error`, () => {
          Zn(Error(`Failed to connect CDP websocket: ${Vn}`));
        }));
    });
  }
  #v(xn: WebSocket) {
    this.#a &&= (clearTimeout(this.#a), null);
    let jn = this.#r;
    ((this.#r = xn),
      this.send(`Target.setDiscoverTargets`, { discover: !0 }).catch(() => {}),
      this.transportEvents.emit(this.#u ? `reconnected` : `connected`).catch((xn) => {
        console.warn(`[${this.logId}] CDP transport listener failed`, xn);
      }),
      (this.#u = !0));
    if (jn && jn !== xn && jn.readyState <= WebSocket.OPEN)
      try {
        jn.close(1e3, `replaced`);
      } catch {}
  }
  #y(xn: WebSocket) {
    this.#r === xn &&
      ((this.#r = null),
      this.#x(Error(`CDP websocket disconnected`)),
      this.transportEvents.emit(`disconnected`).catch((xn) => {
        console.warn(`[${this.logId}] CDP disconnect listener failed`, xn);
      }),
      this.#o &&
        this.ensureConnected().catch((xn) => {
          (console.warn(`[${this.logId}] CDP reconnect failed`, xn), this.#b());
        }));
  }
  #b() {
    if (!this.#o || this.isConnected || this.#i || this.#a) return;
    let xn = this.#n[this.#n.length - 1] ?? 3e3;
    this.#a = setTimeout(() => {
      ((this.#a = null),
        this.ensureConnected().catch((xn) => {
          (console.warn(`[${this.logId}] Scheduled CDP reconnect failed`, xn), this.#b());
        }));
    }, xn);
  }
  #x(xn: unknown) {
    for (let jn of this.#c.values()) (jn.timeout && clearTimeout(jn.timeout), jn.reject(xn));
    this.#c.clear();
  }
  async #S(xn: string | Blob | ArrayBuffer | ArrayBufferView) {
    let jn = typeof xn == `string` ? xn : xn instanceof Blob ? await xn.text() : new TextDecoder().decode(xn),
      { data: Vn } = cdpWireMessageSchema.safeParse(JSON.parse(jn));
    if (Vn) {
      if (isCdpWireResponse(Vn)) {
        let xn = this.#c.get(Vn.id);
        if (!xn) return;
        if ((this.#c.delete(Vn.id), xn.timeout && clearTimeout(xn.timeout), Vn.error)) {
          let jn = Vn.error;
          xn.reject(
            new BrowserCdpCommandError(xn.method, jn.code, jn.data, jn.message ?? `CDP command failed: ${xn.method}`),
          );
          return;
        }
        xn.resolve(Vn.result);
        return;
      }
      if (typeof Vn.method == `string`) {
        let xn = Vn.method;
        if (xn === `Page.javascriptDialogOpening` && Vn.sessionId) {
          let xn = this.#r;
          xn?.readyState === WebSocket.OPEN &&
            xn.send(
              JSON.stringify({
                id: this.#s++,
                method: `Page.handleJavaScriptDialog`,
                params: { accept: !0 },
                sessionId: Vn.sessionId,
              }),
            );
        }
        let jn: CdpEventEnvelope = { payload: Vn.params, meta: { sessionId: Vn.sessionId } };
        this.#l.emit(xn, jn).catch((jn) => {
          console.warn(`[${this.logId}] CDP event listener failed for ${xn}`, jn);
        });
      }
    }
  }
};
type CdpClient = InstanceType<typeof CdpClient>;
var init_client$6 = __esmMin(() => {
  (init_emittery(),
    init_zod(),
    init_context(),
    init_utils$13(),
    init_config(),
    init_extension_bridge(),
    init_commands$1());
});
const SessionManager = class {
  #e: CdpTransport;
  #t = new Map<string, string>();
  #n = new Map<string, string>();
  #r = new Map<string, Promise<string>>();
  #i = new Set<string>();
  #a: CdpUnsubscribe[];
  constructor(xn: CdpTransport) {
    ((this.#e = xn),
      (this.#a = [
        this.#e.on(`Target.attachedToTarget`, (xn) => {
          let jn = xn.targetInfo.targetId;
          jn && this.#s(jn, xn.sessionId);
        }),
        this.#e.on(`Target.detachedFromTarget`, (xn) => {
          let jn = xn.targetId ?? this.#n.get(xn.sessionId);
          (this.#n.delete(xn.sessionId), jn && this.#t.get(jn) === xn.sessionId && this.#t.delete(jn));
        }),
      ]));
  }
  clear() {
    (this.#t.clear(), this.#n.clear(), this.#r.clear());
  }
  async dispose() {
    for (let xn of this.#a) xn();
    (await Promise.allSettled(
      [...this.#i].map((xn) => this.#e.send(`Target.detachFromTarget`, { sessionId: xn }).catch(() => {})),
    ),
      this.#i.clear(),
      this.clear());
  }
  async discoverTargets() {
    return await this.#e.discoverTargets();
  }
  async getPageTarget(xn: string) {
    return (await this.discoverTargets()).find((jn) => jn.id === xn && jn.type === `page`) ?? null;
  }
  hasTargetSession(xn: string, jn: string | undefined) {
    return this.#t.get(xn) === jn;
  }
  getTargetSession(xn: string) {
    return this.#t.get(xn);
  }
  async resolvePageSession(xn: string, jn?: string): Promise<string> {
    if (jn && this.hasTargetSession(xn, jn)) return jn;
    let Vn = this.#t.get(xn);
    if (Vn) return Vn;
    let qn = this.#r.get(xn);
    if (qn) return await qn;
    let Jn = this.#o(xn).finally(() => {
      this.#r.delete(xn);
    });
    return (this.#r.set(xn, Jn), await Jn);
  }
  async #o(xn: string) {
    if (!(await this.getPageTarget(xn))) throw Error(`Tab ${xn} is no longer available.`);
    let jn = await this.#e.send(`Target.attachToTarget`, { targetId: xn, flatten: !0 });
    return (this.#i.add(jn.sessionId), this.#s(xn, jn.sessionId), jn.sessionId);
  }
  #s(xn: string, jn: string) {
    (this.#t.set(xn, jn), this.#n.set(jn, xn));
  }
};
type SessionManager = InstanceType<typeof SessionManager>;
var init_session_manager = __esmMin(() => {
  init_client$6();
});
var init_cdp = __esmMin(() => {
  (init_client$6(), init_session_manager(), new CdpClient());
});
const BUNDLE$1 = pageBundle;
var init_omowright_world_bundle = __esmMin(() => {});
const MAX_BUFFER_SIZE = 1e3;
const CONSOLE_INTERCEPTOR_SCRIPT = `(function(){
  if(window.__omowrightConsole)return;
  var logs=[];
  var orig={log:console.log,info:console.info,warn:console.warn,error:console.error,debug:console.debug};
  function ser(a){
    var r=[];
    for(var i=0;i<a.length;i++){
      var v=a[i];
      try{
        if(v===null){r.push('null');continue}
        if(v===void 0){r.push('undefined');continue}
        if(typeof v==='string'){r.push(v);continue}
        if(v instanceof Error){r.push(v.name+': '+v.message);continue}
        r.push(JSON.stringify(v));
      }catch(e){r.push(String(v))}
    }
    return r.join(' ');
  }
  function cap(level,args){
    if(logs.length>=${MAX_BUFFER_SIZE})logs.shift();
    logs.push({level:level,message:ser(args),timestamp:new Date().toISOString()});
  }
  ['log','info','warn','error','debug'].forEach(function(l){
    console[l]=function(){cap(l,arguments);return orig[l].apply(console,arguments)};
  });
  window.__omowrightConsole={
    logs:logs,
    drain:function(o){
      o=o||{};
      var r=logs;
      if(o.levels&&o.levels.length)r=r.filter(function(e){return o.levels.indexOf(e.level)>=0});
      if(o.filter)r=r.filter(function(e){return e.message.indexOf(o.filter)>=0});
      if(o.limit)r=r.slice(-o.limit);
      return r;
    },
    clear:function(){logs.length=0}
  };
})();`;
interface ConsolePage {
  evaluate<A, R>(pageFunction: (arg: A) => R, arg: A): Promise<Awaited<R>>;
  evaluate(expression: string): Promise<unknown>;
}
const PageConsole = class {
  #e: ConsolePage;
  constructor(xn: ConsolePage) {
    this.#e = xn;
  }
  async logs(xn: ConsoleDrainOptions = {}) {
    return await this.#e.evaluate((xn: ConsoleDrainOptions) => window.__omowrightConsole?.drain(xn) ?? [], xn);
  }
  async clear() {
    await this.#e.evaluate(`(window).__omowrightConsole?.clear()`);
  }
};
var init_console_capture = __esmMin(() => {});
function isContextDestroyedError(xn: unknown) {
  let jn = xn instanceof Error ? xn.message : String(xn);
  return jn.includes(`Cannot find context with specified id`) || jn.includes(`Execution context was destroyed`);
}

export interface FrameRecord {
  frameId: string;
  parentFrameId: string | null;
  url: string;
  name: string;
  sessionId: string;
  isolatedContextId?: number;
}

export interface FrameWalkEntry {
  frameId: string;
  parentFrameId: string | null;
  depth: number;
}

const ISOLATED_WORLD_NAME = `__omowright_utility`;
const FrameManager = class {
  cdp: CdpTransport;
  targetId: string;
  frames = new Map<string, FrameRecord>();
  #e = new Set<number>();
  #t = new Set<string>();
  #n = new Map<string, Promise<number | null>>();
  #r: Map<string, string> | null = null;
  #i: string | null = null;
  #a: string;
  #o: string | null = null;
  #s: string | null = null;
  #c: CdpUnsubscribe[] = [];
  onSessionInitialized: ((sessionId: string) => void) | undefined;
  constructor(xn: CdpTransport, jn: string, Vn: string) {
    ((this.cdp = xn), (this.targetId = jn), (this.#a = Vn));
  }
  #l<E extends string>(xn: E, jn: (payload: CdpEventPayload<E>) => void) {
    return this.cdp.on(xn, (xn, Vn) => {
      this.#v(Vn.sessionId) && jn(xn);
    });
  }
  async initialize() {
    this.#c.push(
      this.#l(`Target.attachedToTarget`, (xn) => {
        if (xn.targetInfo.type !== `iframe`) return;
        let jn = xn.targetInfo.targetId,
          Vn = this.frames.get(jn) ?? {
            frameId: jn,
            parentFrameId: xn.targetInfo.parentFrameId ?? null,
            url: xn.targetInfo.url ?? ``,
            name: xn.targetInfo.title ?? ``,
            sessionId: xn.sessionId,
          };
        (this.frames.set(jn, Vn),
          (Vn.sessionId = xn.sessionId),
          this.#p(xn.sessionId)
            .then(async () => {
              this.onSessionInitialized?.(xn.sessionId);
              let jn = await this.#m(xn.sessionId, Vn.parentFrameId ?? xn.targetInfo.parentFrameId ?? null);
              await this.ensureInjected(jn);
            })
            .catch(() => {}));
      }),
    );
    await this.#p(this.#a);
    let { identifier: xn } = await this.#f(`Page.addScriptToEvaluateOnNewDocument`, {
      source: BUNDLE$1,
      worldName: ISOLATED_WORLD_NAME,
      runImmediately: !0,
    });
    this.#o = xn;
    let { identifier: jn } = await this.#f(`Page.addScriptToEvaluateOnNewDocument`, {
      source: CONSOLE_INTERCEPTOR_SCRIPT,
      runImmediately: !0,
    });
    ((this.#s = jn),
      this.#c.push(
        this.#l(`Page.frameAttached`, (xn) => {
          let jn = this.frames.get(xn.frameId);
          this.frames.set(xn.frameId, {
            frameId: xn.frameId,
            parentFrameId: xn.parentFrameId,
            url: jn?.url ?? ``,
            name: jn?.name ?? ``,
            sessionId: jn?.sessionId ?? this.#a,
            isolatedContextId: jn?.isolatedContextId,
          });
        }),
      ),
      this.#c.push(
        this.#l(`Page.frameNavigated`, (xn) => {
          let jn = xn.frame,
            Vn = this.frames.get(jn.id);
          (Vn?.isolatedContextId && this.#e.delete(Vn.isolatedContextId),
            this.#n.delete(jn.id),
            this.frames.set(jn.id, {
              frameId: jn.id,
              parentFrameId: jn.parentId ?? null,
              url: jn.url,
              name: jn.name ?? ``,
              sessionId: Vn?.sessionId ?? this.#a,
              isolatedContextId: void 0,
            }),
            jn.parentId || (this.#i = jn.id),
            this.ensureInjected(jn.id));
        }),
      ),
      this.#c.push(
        this.#l(`Page.frameDetached`, (xn) => {
          let jn = this.frames.get(xn.frameId);
          if (
            (jn?.isolatedContextId && this.#e.delete(jn.isolatedContextId),
            this.#n.delete(xn.frameId),
            xn.reason === `swap`)
          ) {
            jn && delete jn.isolatedContextId;
            return;
          }
          (jn?.sessionId && this.#t.delete(jn.sessionId),
            this.frames.delete(xn.frameId),
            this.#i === xn.frameId && (this.#i = null));
        }),
      ));
    let { frameTree: Vn } = await this.#f(`Page.getFrameTree`);
    (this.#d(Vn, null), await this.#u());
  }
  async #u() {
    await Promise.all([...this.frames.keys()].map((xn) => this.ensureInjected(xn)));
  }
  get mainFrameId() {
    return this.#i;
  }
  getFrame(xn: string | null) {
    return (xn === null ? void 0 : this.frames.get(xn)) ?? null;
  }
  hasSession(xn: string) {
    if (this.#a === xn) return !0;
    for (let jn of this.frames.values()) if (jn.sessionId === xn) return !0;
    return !1;
  }
  async ensureInjected(xn: string | null): Promise<number | null> {
    if (xn === null) return null;
    let jn = this.frames.get(xn);
    if (!jn) return null;
    if (jn.isolatedContextId && this.#e.has(jn.isolatedContextId)) return jn.isolatedContextId;
    let Vn = this.#n.get(xn);
    if (Vn) return await Vn;
    let qn = this.#h(xn);
    this.#n.set(xn, qn);
    try {
      return await qn;
    } finally {
      this.#n.get(xn) === qn && this.#n.delete(xn);
    }
  }
  collectDescendantFrames(xn: string | null): FrameWalkEntry[] {
    if (xn === null || !this.frames.has(xn)) return [];
    let jn = new Map<string, string[]>();
    for (let xn of this.frames.values()) {
      if (!xn.parentFrameId) continue;
      let Vn = jn.get(xn.parentFrameId) ?? [];
      (Vn.push(xn.frameId), jn.set(xn.parentFrameId, Vn));
    }
    let Vn: FrameWalkEntry[] = [],
      qn: FrameWalkEntry[] = [{ frameId: xn, parentFrameId: this.frames.get(xn)?.parentFrameId ?? null, depth: 0 }],
      Jn = new Set<string>();
    for (; qn.length > 0;) {
      let xn = qn.shift();
      if (!xn) break;
      if (Jn.has(xn.frameId)) continue;
      (Jn.add(xn.frameId), Vn.push(xn));
      let Yn = jn.get(xn.frameId) ?? [];
      for (let jn of Yn) qn.push({ frameId: jn, parentFrameId: xn.frameId, depth: xn.depth + 1 });
    }
    return Vn;
  }
  resolveFrameIdForSnapshotPrefix(xn: string) {
    if (this.#r) {
      let jn = this.#r.get(xn);
      if (jn && this.frames.has(jn)) return jn;
      if (xn) return null;
    }
    return !xn && this.#i && this.frames.has(this.#i) ? this.#i : null;
  }
  setSnapshotFramePrefixMap(xn: Map<string, string> | null) {
    this.#r = xn;
  }
  invalidateContext(xn: string) {
    let jn = this.frames.get(xn);
    jn && this.#_(jn);
  }
  async dispose() {
    for (let xn of this.#c) xn();
    this.#c = [];
    for (let xn of [this.#o, this.#s])
      xn &&
        (await this.cdp.send(`Page.removeScriptToEvaluateOnNewDocument`, { identifier: xn }, this.#a).catch(() => {}));
    ((this.#o = null), (this.#s = null));
  }
  async reconnect(xn: string) {
    (await this.dispose(),
      this.frames.clear(),
      this.#e.clear(),
      this.#t.clear(),
      this.#n.clear(),
      (this.#r = null),
      (this.#i = null),
      (this.#a = xn),
      await this.initialize());
  }
  #d(xn: CdpFrameTree, jn: string | null) {
    let { frame: Vn } = xn,
      qn = this.frames.get(Vn.id);
    (this.frames.set(Vn.id, {
      frameId: Vn.id,
      parentFrameId: jn,
      url: Vn.url,
      name: Vn.name ?? ``,
      sessionId: qn?.sessionId ?? this.#a,
      isolatedContextId: qn?.isolatedContextId,
    }),
      jn || (this.#i = Vn.id));
    for (let jn of xn.childFrames ?? []) this.#d(jn, Vn.id);
  }
  async #f<M extends string>(xn: M, jn?: object) {
    return await this.cdp.send(xn, jn, this.#a);
  }
  async #p(xn: string) {
    this.#t.has(xn) ||
      (await this.cdp.send(`Page.enable`, void 0, xn),
      await this.cdp.send(`DOM.enable`, void 0, xn),
      await this.cdp.send(`Network.enable`, void 0, xn),
      await this.cdp.send(`Inspector.enable`, void 0, xn).catch(() => {}),
      await this.cdp.send(`Page.setWebLifecycleState`, { state: `active` }, xn).catch(() => {}),
      await this.cdp.send(`Emulation.setFocusEmulationEnabled`, { enabled: !0 }, xn).catch(() => {}),
      await this.cdp.send(`Target.setAutoAttach`, { autoAttach: !0, waitForDebuggerOnStart: !1, flatten: !0 }, xn),
      this.#t.add(xn));
  }
  async #m(xn: string, jn: string | null) {
    let { frameTree: Vn } = await this.cdp.send(`Page.getFrameTree`, void 0, xn),
      qn = Vn.frame.parentId ?? jn ?? null;
    return (this.#d(Vn, qn), Vn.frame.id);
  }
  async #h(xn: string): Promise<number | null> {
    let jn = this.frames.get(xn);
    if (!jn) return null;
    if (jn.isolatedContextId) {
      if (await this.#g(jn)) return (this.#e.add(jn.isolatedContextId), jn.isolatedContextId);
      this.#_(jn);
    }
    try {
      let { executionContextId: Vn } = await this.cdp.send(
        `Page.createIsolatedWorld`,
        { frameId: xn, worldName: ISOLATED_WORLD_NAME },
        jn.sessionId || this.#a,
      );
      jn.isolatedContextId = Vn;
    } catch {
      return null;
    }
    try {
      await this.cdp.send(
        `Runtime.evaluate`,
        { expression: BUNDLE$1, contextId: jn.isolatedContextId },
        jn.sessionId || this.#a,
      );
    } catch (xn) {
      if (isContextDestroyedError(xn)) return (this.#_(jn), null);
    }
    return (await this.#g(jn)) ? (this.#e.add(jn.isolatedContextId), jn.isolatedContextId) : (this.#_(jn), null);
  }
  async #g(xn: FrameRecord) {
    if (!xn.isolatedContextId) return !1;
    let { result: jn } = await this.cdp
      .send(
        `Runtime.callFunctionOn`,
        {
          functionDeclaration: `function() { return typeof globalThis.__omowright; }`,
          executionContextId: xn.isolatedContextId,
          returnByValue: !0,
        },
        xn.sessionId || this.#a,
      )
      .catch(() => ({ result: { value: `error` } }));
    return jn.value === `object`;
  }
  #_(xn: FrameRecord) {
    xn.isolatedContextId && (this.#e.delete(xn.isolatedContextId), delete xn.isolatedContextId);
  }
  #v(xn: string | undefined) {
    if (!xn) return !1;
    if (xn === this.#a) return !0;
    for (let jn of this.frames.values()) if (jn.sessionId === xn) return !0;
    return !1;
  }
};
type FrameManager = InstanceType<typeof FrameManager>;
var init_frame_manager = __esmMin(() => {
  (init_client$6(), init_omowright_world_bundle(), init_console_capture());
});
export interface NotificationGrant {
  origin: string;
  grantedAt: string;
  grantedBySessionId: string | null;
  revokedAt: string | null;
}
interface NotificationGrantUpsert {
  accountId: number;
  origin: string;
  grantedAt?: string;
  grantedBySessionId?: string | null;
  preserveAttribution?: boolean;
}
function upsertNotificationGrant(xn: NotificationGrantUpsert) {
  let jn = xn.grantedAt ?? new Date().toISOString(),
    Vn = xn.preserveAttribution ? getNotificationGrantRecord(xn.accountId, xn.origin) : void 0,
    qn = xn.preserveAttribution
      ? (Vn?.grantedBySessionId ?? xn.grantedBySessionId ?? null)
      : (xn.grantedBySessionId ?? null);
  return (
    stateDb(xn.accountId, { origin: xn.origin, grantedAt: jn, grantedBySessionId: qn, revokedAt: null }),
    getNotificationGrant(xn.accountId, xn.origin)
  );
}
function getNotificationGrantRecord(xn: number, jn: string): NotificationGrant | undefined {
  return stateDb(xn, jn);
}
function getNotificationGrant(xn: number, jn: string): NotificationGrant | undefined {
  return stateDb(xn, jn);
}
var init_notification_grants = __esmMin(() => {
  (init_drizzle_orm(), init_schema(), init_state_db());
});
interface RuntimeCallFrameLike {
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  functionName?: string;
}
interface RuntimeExceptionLike {
  text?: unknown;
  exception?: { description?: unknown; value?: unknown };
  stackTrace?: { callFrames?: RuntimeCallFrameLike[] };
}
function formatCallFrame(xn: RuntimeCallFrameLike) {
  let jn = xn.url ? `${xn.url}:${(xn.lineNumber ?? 0) + 1}:${(xn.columnNumber ?? 0) + 1}` : null;
  if (!jn) return null;
  let Vn = xn.functionName?.trim();
  return Vn ? `at ${Vn} (${jn})` : `at ${jn}`;
}
function formatRuntimeException(xn: RuntimeExceptionLike | null | undefined, jn: string) {
  if (!xn) return jn;
  let Vn =
      (typeof xn.exception?.description == `string` && xn.exception.description.trim()) ||
      (typeof xn.exception?.value == `string` && xn.exception.value.trim()) ||
      (typeof xn.text == `string` && xn.text.trim()) ||
      jn,
    qn = xn.stackTrace?.callFrames?.map(formatCallFrame).filter((xn): xn is string => !!xn) ?? [],
    Jn = qn.some((xn) => Vn.includes(xn));
  return qn.length > 0 && !Jn
    ? `${Vn}\n${qn.join(`
`)}`
    : Vn;
}
var init_errors$3 = __esmMin(() => {});
const TRACKING_PARAMS = new Set([
  `utm_source`,
  `utm_medium`,
  `utm_campaign`,
  `utm_term`,
  `utm_content`,
  `gclid`,
  `gclsrc`,
  `fbclid`,
  `mc_cid`,
  `mc_eid`,
  `msclkid`,
  `twclid`,
  `li_fat_id`,
  `_ga`,
  `_gl`,
  `_t`,
  `_ts`,
  `_nc`,
]);
var init_tracking_params = __esmMin(() => {});
function truncateUrlForLLM(xn: string, jn?: { maxLength?: number; currentOrigin?: string }) {
  let Vn = jn?.maxLength ?? 128,
    qn: URL;
  try {
    qn = new URL(xn);
  } catch {
    return xn.length > Vn ? xn.slice(0, Vn) + `…` : xn;
  }
  for (let xn of qn.searchParams.keys()) TRACKING_PARAMS.has(xn.toLowerCase()) && qn.searchParams.delete(xn);
  if (jn?.currentOrigin)
    try {
      let xn = new URL(jn.currentOrigin);
      if (qn.origin === xn.origin) {
        let xn = qn.pathname + qn.search + qn.hash;
        return xn.length > Vn ? truncateQuery(xn, Vn) : xn;
      }
    } catch {}
  let Jn = qn.toString();
  return Jn.length <= Vn ? Jn : truncateQuery(Jn, Vn);
}
function truncateQuery(xn: string, jn: number) {
  let Vn = xn.indexOf(`?`);
  return Vn === -1 || Vn >= jn ? (xn.length > jn ? xn.slice(0, jn) + `…` : xn) : xn.slice(0, jn) + `…`;
}
var init_utils$4 = __esmMin(() => {
  init_tracking_params();
});
async function ensureDirForFile$1(xn: string) {
  await mkdir(path.dirname(xn), { recursive: !0 });
}
export interface DownloadInit {
  guid: string;
  startedAfterMs: number;
  suggestedFilename: string;
  url: string;
  sourcePath?: string;
}
const OmODownload = class {
  #e: OmOPage;
  #t: string;
  #n: number;
  #r: string;
  #i: string;
  #a: Promise<string> | null = null;
  #o = !1;
  constructor(xn: OmOPage, jn: DownloadInit) {
    ((this.#e = xn),
      (this.#t = jn.guid),
      (this.#n = jn.startedAfterMs),
      (this.#r = jn.suggestedFilename),
      (this.#i = jn.url),
      (this.#a = jn.sourcePath ? Promise.resolve(jn.sourcePath) : null));
  }
  page() {
    return this.#e;
  }
  suggestedFilename() {
    return this.#r;
  }
  url() {
    return this.#i;
  }
  async path() {
    return (this.#c(), await this.#s());
  }
  async saveAs(xn: string) {
    this.#c();
    let jn = await this.#s(),
      Vn = path.isAbsolute(xn) ? xn : path.join(SESSION_ARTIFACTS_DIR, xn),
      qn = await this.#e.browser.ensurePath(Vn, `write`, `download.saveAs`);
    path.resolve(jn) !== path.resolve(qn) && (await ensureDirForFile$1(qn), await copyFile(jn, qn));
  }
  async createReadStream() {
    return (this.#c(), createReadStream(await this.#s()));
  }
  async failure() {
    try {
      return (await this.#s(), null);
    } catch (xn) {
      return xn instanceof Error ? xn.message : String(xn);
    }
  }
  async cancel() {}
  async delete() {
    (this.#c(), (this.#o = !0));
  }
  async #s() {
    return (
      (this.#a ||= this.#e.cdp
        .send(
          `OmO.waitForDownload`,
          { startedAfterMs: this.#n, expectedFilename: this.#r, referrerUrl: this.#e.url() },
          void 0,
          { extensionBridge: this.#e.browser.extensionBridgeRoute },
        )
        .then((xn) => xn.absolutePath)),
      this.#e.browser.registerReadableDownload(await this.#a)
    );
  }
  #c() {
    if (this.#o) throw Error(`Download has been deleted.`);
  }
  get guid() {
    return this.#t;
  }
};
type OmODownload = InstanceType<typeof OmODownload>;
var init_download = __esmMin(() => {
  init_directory();
});
const RefStaleError = class extends Error {
  constructor(xn: string) {
    super(`Ref "${xn}" is stale — the element was removed or the page changed. Take a new snapshot and retry.`);
    this.name = `RefStaleError`;
  }
};
var init_types$4 = __esmMin(() => {});
export interface KeyDescriptor {
  key: string;
  code: string;
  keyCode: number;
  keyCodeWithoutLocation: number;
  text: string;
  location: number;
  shifted?: KeyDescriptor;
}
export interface PageSendOptions extends CdpSendOptions {
  preferredSessionId?: string;
}
export interface InputTarget {
  _sendToTarget<M extends string>(method: M, params?: object, options?: PageSendOptions): Promise<CdpResult<M>>;
}
function resolveSmartModifierString(xn: string) {
  if (xn.length === 1) return xn;
  let jn = xn.trim();
  return jn.toLowerCase() === `controlormeta` ? (process.platform === `darwin` ? `Meta` : `Control`) : jn;
}
function setKey(xn: string, jn: KeyDescriptor) {
  KEYBOARD_LAYOUT[xn] = jn;
}
function addKey(xn: KeyDescriptor, jn: readonly string[] = []) {
  (setKey(xn.key, xn), xn.code !== xn.key && setKey(xn.code, xn));
  for (let Vn of jn) setKey(Vn, xn);
}
function addCodeOnlyKey(xn: KeyDescriptor, jn: readonly string[] = []) {
  setKey(xn.code, xn);
  for (let Vn of jn) setKey(Vn, xn);
}
function linkShifted(xn: KeyDescriptor, jn: string) {
  let Vn = { ...xn, key: jn, text: jn };
  return { ...xn, shifted: Vn };
}
function keyCommands(xn: string, jn: readonly string[]) {
  if (process.platform !== `darwin`) return [];
  let Vn = [...[`Shift`, `Control`, `Alt`, `Meta`].filter((xn) => jn.includes(xn)), xn].join(`+`),
    qn = MAC_EDITING_COMMANDS.get(Vn);
  return (Array.isArray(qn) ? qn : qn ? [qn] : [])
    .filter((xn) => !xn.startsWith(`insert`))
    .map((xn) => xn.replace(/:$/, ``));
}
function lookupKeyDescriptor(xn: string) {
  let jn = resolveSmartModifierString(xn);
  return KEYBOARD_LAYOUT[jn] ?? KEYBOARD_LAYOUT[jn.toLowerCase()] ?? KEYBOARD_LAYOUT[jn.toUpperCase()];
}
function resolveKeyDescriptor(xn: string, jn: { modifiers?: Iterable<string> } = {}): KeyDescriptor {
  let Vn = lookupKeyDescriptor(xn);
  if (!Vn) throw Error(`Unknown key: ${xn}`);
  let qn = new Set(
      [...(jn.modifiers ?? [])].map((xn) => resolveSmartModifierString(xn)).filter((xn) => MODIFIER_KEYS.has(xn)),
    ),
    Jn = qn.has(`Shift`) && Vn.shifted ? Vn.shifted : Vn;
  return Jn.text.length === 0 || qn.size === 0 || (qn.size === 1 && qn.has(`Shift`)) ? Jn : { ...Jn, text: `` };
}
function splitKeyCombo(xn: string) {
  if (xn.length === 1 && KEYBOARD_LAYOUT[xn]) return [xn];
  let jn = xn.trim();
  if (!jn) return [];
  let Vn: string[] = [],
    qn = ``;
  for (let xn of jn) {
    if (xn !== `+`) {
      qn += xn;
      continue;
    }
    if (qn.trim()) {
      (Vn.push(qn.trim()), (qn = ``));
      continue;
    }
    Vn.push(`+`);
  }
  return (qn.trim() && Vn.push(qn.trim()), Vn);
}
async function shouldUseDomInputFallback(xn: { evaluate<R>(pageFunction: () => R): Promise<R> }) {
  return await xn.evaluate(() => document.visibilityState !== `visible` || !document.hasFocus());
}
const KEYBOARD_LAYOUT: Record<string, KeyDescriptor | undefined> = {};
const MODIFIER_KEYS = new Set([`Alt`, `Control`, `Meta`, `Shift`]);
const BUTTON_MASKS = new Map([
  [`left`, 1],
  [`right`, 2],
  [`middle`, 4],
  [`back`, 8],
  [`forward`, 16],
]);
const MAC_EDITING_COMMANDS = new Map<string, string | string[]>([
  [`Meta+KeyA`, `selectAll:`],
  [`Meta+KeyC`, `copy:`],
  [`Meta+KeyV`, `paste:`],
  [`Meta+KeyX`, `cut:`],
  [`Meta+KeyZ`, `undo:`],
  [`Shift+Meta+KeyZ`, `redo:`],
]);
const NAMED_KEYS: Array<[KeyDescriptor, string[]?]> = [
  [{ key: `Backspace`, code: `Backspace`, keyCode: 8, keyCodeWithoutLocation: 8, text: ``, location: 0 }],
  [{ key: `Tab`, code: `Tab`, keyCode: 9, keyCodeWithoutLocation: 9, text: `	`, location: 0 }, [`	`]],
  [
    { key: `Enter`, code: `Enter`, keyCode: 13, keyCodeWithoutLocation: 13, text: `\r`, location: 0 },
    [
      `Return`,
      `
`,
      `\r`,
    ],
  ],
  [{ key: `Escape`, code: `Escape`, keyCode: 27, keyCodeWithoutLocation: 27, text: ``, location: 0 }, [`Esc`]],
  [{ key: `Delete`, code: `Delete`, keyCode: 46, keyCodeWithoutLocation: 46, text: ``, location: 0 }, [`Del`]],
  [{ key: `Insert`, code: `Insert`, keyCode: 45, keyCodeWithoutLocation: 45, text: ``, location: 0 }, [`Ins`]],
  [{ key: `Home`, code: `Home`, keyCode: 36, keyCodeWithoutLocation: 36, text: ``, location: 0 }],
  [{ key: `End`, code: `End`, keyCode: 35, keyCodeWithoutLocation: 35, text: ``, location: 0 }],
  [{ key: `PageUp`, code: `PageUp`, keyCode: 33, keyCodeWithoutLocation: 33, text: ``, location: 0 }],
  [{ key: `PageDown`, code: `PageDown`, keyCode: 34, keyCodeWithoutLocation: 34, text: ``, location: 0 }],
  [{ key: `ArrowUp`, code: `ArrowUp`, keyCode: 38, keyCodeWithoutLocation: 38, text: ``, location: 0 }, [`Up`]],
  [{ key: `ArrowDown`, code: `ArrowDown`, keyCode: 40, keyCodeWithoutLocation: 40, text: ``, location: 0 }, [`Down`]],
  [{ key: `ArrowLeft`, code: `ArrowLeft`, keyCode: 37, keyCodeWithoutLocation: 37, text: ``, location: 0 }, [`Left`]],
  [
    { key: `ArrowRight`, code: `ArrowRight`, keyCode: 39, keyCodeWithoutLocation: 39, text: ``, location: 0 },
    [`Right`],
  ],
  [{ key: `Shift`, code: `ShiftLeft`, keyCode: 16, keyCodeWithoutLocation: 16, text: ``, location: 1 }],
  [{ key: `Control`, code: `ControlLeft`, keyCode: 17, keyCodeWithoutLocation: 17, text: ``, location: 1 }, [`Ctrl`]],
  [{ key: `Alt`, code: `AltLeft`, keyCode: 18, keyCodeWithoutLocation: 18, text: ``, location: 1 }, [`Option`]],
  [
    { key: `Meta`, code: `MetaLeft`, keyCode: 91, keyCodeWithoutLocation: 91, text: ``, location: 1 },
    [`Command`, `Cmd`, `OS`],
  ],
  [{ key: `ContextMenu`, code: `ContextMenu`, keyCode: 93, keyCodeWithoutLocation: 93, text: ``, location: 0 }],
  [{ key: `CapsLock`, code: `CapsLock`, keyCode: 20, keyCodeWithoutLocation: 20, text: ``, location: 0 }],
  [{ key: `NumLock`, code: `NumLock`, keyCode: 144, keyCodeWithoutLocation: 144, text: ``, location: 0 }],
  [{ key: `ScrollLock`, code: `ScrollLock`, keyCode: 145, keyCodeWithoutLocation: 145, text: ``, location: 0 }],
  [{ key: `Pause`, code: `Pause`, keyCode: 19, keyCodeWithoutLocation: 19, text: ``, location: 0 }],
  [{ key: `PrintScreen`, code: `PrintScreen`, keyCode: 44, keyCodeWithoutLocation: 44, text: ``, location: 0 }],
  [{ key: `Space`, code: `Space`, keyCode: 32, keyCodeWithoutLocation: 32, text: ` `, location: 0 }, [` `]],
];
const NUMPAD_OPERATOR_KEYS: Array<[string, number, number, string]> = [
  [`NumpadMultiply`, 106, 56, `*`],
  [`NumpadAdd`, 107, 187, `+`],
  [`NumpadSubtract`, 109, 189, `-`],
  [`NumpadDecimal`, 110, 190, `.`],
  [`NumpadDivide`, 111, 191, `/`],
  [`NumpadEnter`, 13, 13, `\r`],
];
var shiftedDigits: string[];
const ModifierState = class {
  #e = new Set<string>();
  #t = new Set<string>();
  down(xn: string) {
    MODIFIER_KEYS.has(xn) && this.#e.add(xn);
  }
  up(xn: string) {
    this.#e.delete(xn);
  }
  has(xn: string) {
    return this.#e.has(xn);
  }
  modifiers() {
    return [...this.#e];
  }
  mouseDown(xn: string) {
    this.#t.add(xn);
  }
  mouseUp(xn: string) {
    this.#t.delete(xn);
  }
  toModifiersMask() {
    let xn = 0;
    return (
      this.#e.has(`Alt`) && (xn |= 1),
      this.#e.has(`Control`) && (xn |= 2),
      this.#e.has(`Meta`) && (xn |= 4),
      this.#e.has(`Shift`) && (xn |= 8),
      xn
    );
  }
  toButtonsMask() {
    let xn = 0;
    for (let jn of this.#t) xn |= BUTTON_MASKS.get(jn) ?? 0;
    return xn;
  }
};
type ModifierState = InstanceType<typeof ModifierState>;
const OmOKeyboard = class {
  context: InputTarget;
  modifierState: ModifierState;
  #e = new Set<string>();
  constructor(xn: InputTarget, jn: ModifierState) {
    ((this.context = xn), (this.modifierState = jn));
  }
  async down(xn: string) {
    await this.#n(xn);
  }
  async up(xn: string) {
    await this.#r(xn);
  }
  async insertText(xn: string) {
    await this.#t(xn);
  }
  async press(xn: string, jn: { delay?: number } = {}, Vn?: string) {
    let qn = splitKeyCombo(xn),
      Yn = qn[qn.length - 1];
    if (Yn === undefined) throw Error(`Key combo is empty`);
    let Jn = qn.slice(0, -1),
      Zn: string[] = [],
      Qn: unknown;
    try {
      for (let xn of Jn) (await this.#n(xn, Vn), Zn.push(xn));
      let delay = jn.delay ?? 0;
      (await this.#n(Yn, Vn), delay > 0 && (await sleep$12(delay)), await this.#r(Yn, Vn));
    } catch (xn) {
      Qn = xn;
    }
    let ei: unknown;
    for (let xn of Zn.toReversed())
      try {
        await this.#r(xn, Vn);
      } catch (xn) {
        ei ??= xn;
      }
    if (Qn) throw Qn;
    if (ei) throw ei;
  }
  async type(xn: string, jn?: { delay?: number }, Vn?: string) {
    let qn = jn?.delay ?? 0;
    for (let jn of xn) {
      if (
        jn ===
          `
` ||
        jn === `\r` ||
        !lookupKeyDescriptor(jn)
      ) {
        (qn > 0 && (await sleep$12(qn)), await this.#t(jn, Vn));
        continue;
      }
      await this.#a(jn, qn, Vn);
    }
  }
  async #t(xn: string, jn?: string) {
    await this.context._sendToTarget(`Input.insertText`, { text: xn }, this.#i(jn));
  }
  async #n(xn: string, jn?: string) {
    let Vn = resolveKeyDescriptor(xn, { modifiers: this.modifierState.modifiers() }),
      qn = this.#e.has(Vn.code),
      Jn = this.modifierState.has(Vn.key);
    (this.#e.add(Vn.code), this.modifierState.down(Vn.key));
    let Yn = keyCommands(Vn.code, this.modifierState.modifiers());
    try {
      await this.context._sendToTarget(
        `Input.dispatchKeyEvent`,
        {
          type: Vn.text ? `keyDown` : `rawKeyDown`,
          key: Vn.key,
          code: Vn.code,
          commands: Yn,
          text: Vn.text,
          unmodifiedText: Vn.text,
          windowsVirtualKeyCode: Vn.keyCodeWithoutLocation,
          autoRepeat: qn,
          location: Vn.location,
          isKeypad: Vn.location === 3,
          modifiers: this.modifierState.toModifiersMask(),
        },
        this.#i(jn),
      );
    } catch (xn) {
      throw (qn || this.#e.delete(Vn.code), Jn || this.modifierState.up(Vn.key), xn);
    }
    return Vn;
  }
  async #r(xn: string, jn?: string) {
    let Vn = resolveKeyDescriptor(xn, { modifiers: this.modifierState.modifiers() }),
      qn = this.#e.has(Vn.code),
      Jn = this.modifierState.has(Vn.key);
    (this.#e.delete(Vn.code), this.modifierState.up(Vn.key));
    try {
      await this.context._sendToTarget(
        `Input.dispatchKeyEvent`,
        {
          type: `keyUp`,
          key: Vn.key,
          code: Vn.code,
          windowsVirtualKeyCode: Vn.keyCodeWithoutLocation,
          location: Vn.location,
          modifiers: this.modifierState.toModifiersMask(),
        },
        this.#i(jn),
      );
    } catch (xn) {
      throw (qn && this.#e.add(Vn.code), Jn && this.modifierState.down(Vn.key), xn);
    }
  }
  #i(xn?: string) {
    return xn === void 0 ? void 0 : { preferredSessionId: xn };
  }
  async #a(xn: string, jn: number, Vn?: string) {
    (await this.#n(xn, Vn), jn > 0 && (await sleep$12(jn)), await this.#r(xn, Vn));
  }
};
type OmOKeyboard = InstanceType<typeof OmOKeyboard>;
var init_keyboard = __esmMin(() => {
  init_utils$13();
  for (let xn = 0; xn < 26; xn += 1) {
    let jn = String.fromCharCode(97 + xn),
      Vn = jn.toUpperCase(),
      qn = 65 + xn,
      Jn = linkShifted(
        { key: jn, code: `Key${Vn}`, keyCode: qn, keyCodeWithoutLocation: qn, text: jn, location: 0 },
        Vn,
      );
    (addKey(Jn), setKey(Vn, Jn.shifted));
  }
  shiftedDigits = [` )`, `!`, `@`, `#`, `$`, `%`, `^`, `&`, `*`, `(`].map((xn) => xn.trimStart());
  for (let [xn, shifted] of shiftedDigits.entries()) {
    let jn = String(xn),
      Vn = 48 + xn,
      qn = linkShifted(
        { key: jn, code: `Digit${jn}`, keyCode: Vn, keyCodeWithoutLocation: Vn, text: jn, location: 0 },
        shifted,
      );
    (addKey(qn), setKey(qn.shifted.key, qn.shifted));
  }
  for (let { key: xn, shifted: jn, code: Vn, keyCode: qn } of [
    { key: "`", shifted: `~`, code: `Backquote`, keyCode: 192 },
    { key: `-`, shifted: `_`, code: `Minus`, keyCode: 189 },
    { key: `=`, shifted: `+`, code: `Equal`, keyCode: 187 },
    { key: `[`, shifted: `{`, code: `BracketLeft`, keyCode: 219 },
    { key: `]`, shifted: `}`, code: `BracketRight`, keyCode: 221 },
    { key: `\\`, shifted: `|`, code: `Backslash`, keyCode: 220 },
    { key: `;`, shifted: `:`, code: `Semicolon`, keyCode: 186 },
    { key: `'`, shifted: `"`, code: `Quote`, keyCode: 222 },
    { key: `,`, shifted: `<`, code: `Comma`, keyCode: 188 },
    { key: `.`, shifted: `>`, code: `Period`, keyCode: 190 },
    { key: `/`, shifted: `?`, code: `Slash`, keyCode: 191 },
  ]) {
    let Jn = linkShifted({ key: xn, code: Vn, keyCode: qn, keyCodeWithoutLocation: qn, text: xn, location: 0 }, jn);
    (addKey(Jn), setKey(jn, Jn.shifted));
  }
  for (let [xn, jn] of NAMED_KEYS) addKey(xn, jn);
  for (let xn = 1; xn <= 12; xn += 1) {
    let jn = `F${xn}`;
    addKey({ key: jn, code: jn, keyCode: 111 + xn, keyCodeWithoutLocation: 111 + xn, text: ``, location: 0 });
  }
  for (let xn = 0; xn <= 9; xn += 1)
    addCodeOnlyKey({
      key: String(xn),
      code: `Numpad${xn}`,
      keyCode: 96 + xn,
      keyCodeWithoutLocation: 48 + xn,
      text: String(xn),
      location: 3,
    });
  for (let [xn, jn, Vn, qn] of NUMPAD_OPERATOR_KEYS)
    addCodeOnlyKey({ key: qn || xn, code: xn, keyCode: jn, keyCodeWithoutLocation: Vn, text: qn, location: 3 });
});
export interface PageProbeCounts {
  bodyExists: boolean;
  interactiveCount: number;
  landmarkCount: number;
  textChars: number;
}
export type PageProbeState = "ready" | "sparse" | "missing-body";
export interface PageProbe extends PageProbeCounts {
  state: PageProbeState;
}
interface DomMonitorSnapshot {
  mutationCount: number;
  totalNodes: number;
}
export type NavigationReadinessMode = "interactive" | "stable";
export interface ActionWaitOptions {
  timeoutMs?: number;
  frameSessionId?: string;
  hookWindowMs?: number;
  requestTrackingBudgetMs?: number;
  postSettleMs?: number;
}
export interface DomQuietOptions {
  budgetMs?: number;
  sampleIntervalMs?: number;
  quietMutationRatio?: number;
  quietSampleCount?: number;
}
interface ExpressionEvaluator {
  evaluate(expression: string): Promise<unknown>;
}
function isTransientEvaluationError(xn: unknown) {
  if (!(xn instanceof Error)) return !1;
  let jn = xn.message.toLowerCase();
  return (
    jn.includes(`execution context was destroyed`) ||
    jn.includes(`cannot find context with specified id`) ||
    jn.includes(`cannot find object with given id`) ||
    jn.includes(`most likely because of a navigation`) ||
    jn.includes(`inspected target navigated or closed`) ||
    jn.includes(`target page, context or browser has been closed`)
  );
}
function isDomReadyTimeoutError(xn: unknown) {
  return xn instanceof Error && xn.message.includes(`Timed out waiting for document readiness`);
}
function isPdfViewerUrl(xn: string) {
  return xn.startsWith(PDF_VIEWER_EXTENSION_PREFIX) || xn.endsWith(`.pdf`);
}
function getProbeState(xn: PageProbeCounts): PageProbeState {
  return xn.bodyExists
    ? xn.interactiveCount > 0 || xn.landmarkCount > 0 || xn.textChars >= MIN_PROBE_TEXT_CHARS
      ? `ready`
      : `sparse`
    : `missing-body`;
}
function getNaiveRegistrableDomain(xn: string) {
  try {
    let jn = new URL(xn).hostname.toLowerCase(),
      Vn = jn.split(`.`).filter(Boolean);
    return Vn.length <= 2 ? jn : Vn.slice(-2).join(`.`);
  } catch {
    return ``;
  }
}
function isSameSite(xn: string, jn: string) {
  return jn ? xn === jn || xn.endsWith(`.${jn}`) : !1;
}
async function waitForDomReady(xn: ExpressionEvaluator, jn = DOM_READY_TIMEOUT_MS) {
  let Vn = Date.now() + jn;
  for (; Date.now() < Vn;) {
    try {
      if ((await xn.evaluate(`document.readyState`)) !== `loading`) return;
    } catch (xn) {
      if (!isTransientEvaluationError(xn)) throw xn;
    }
    await sleep$12(50);
  }
  throw Error(`Timed out waiting for document readiness after ${jn}ms`);
}
async function takePageProbe(xn: ExpressionEvaluator): Promise<PageProbe> {
  let jn = (await xn.evaluate(`(() => {
    const isVisibleElement = (element) => {
      const style = window.getComputedStyle(element);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        Number.parseFloat(style.opacity || '1') === 0
      ) {
        return false;
      }

      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    const body = document.body;
    if (!body) {
      return {
        bodyExists: false,
        interactiveCount: 0,
        landmarkCount: 0,
        textChars: 0,
      };
    }

    const interactiveSelector = [
      'a[href]',
      'button',
      'input:not([type="hidden"])',
      'textarea',
      'select',
      'summary',
      '[role="button"]',
      '[role="link"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[tabindex]:not([tabindex="-1"])',
      '[contenteditable="true"]',
    ].join(',');
    const landmarkSelector = [
      'main',
      'nav',
      'header',
      'footer',
      'aside',
      'form',
      '[role="main"]',
      '[role="navigation"]',
      '[role="banner"]',
      '[role="contentinfo"]',
      '[role="complementary"]',
      '[role="form"]',
    ].join(',');

    return {
      bodyExists: true,
      interactiveCount: Array.from(document.querySelectorAll(interactiveSelector))
        .filter((element) => isVisibleElement(element))
        .slice(0, 25).length,
      landmarkCount: Array.from(document.querySelectorAll(landmarkSelector))
        .filter((element) => isVisibleElement(element))
        .slice(0, 10).length,
      textChars: body.innerText.replace(/\\s+/g, ' ').trim().length,
    };
  })()`)) as PageProbeCounts;
  return { ...jn, state: getProbeState(jn) };
}
async function ensureDomMonitor(xn: ExpressionEvaluator) {
  await xn.evaluate(`(() => {
    const key = ${JSON.stringify(DOM_MONITOR_KEY)};
    const target = globalThis;
    if (target[key]) {
      return;
    }

    let mutationCount = 0;
    const observer = new MutationObserver((mutations) => {
      mutationCount += mutations.length;
    });

    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
    });

    target[key] = {
      observer,
      takeSnapshot() {
        const snapshot = {
          mutationCount,
          totalNodes: Math.max(document.getElementsByTagName('*').length, 1),
        };
        mutationCount = 0;
        return snapshot;
      },
    };
  })()`);
}
async function readDomMonitor(xn: ExpressionEvaluator) {
  return (await xn.evaluate(`(() => {
    const key = ${JSON.stringify(DOM_MONITOR_KEY)};
    const target = globalThis;
    const monitor = target[key];

    if (!monitor?.takeSnapshot) {
      return {
        mutationCount: 0,
        totalNodes: Math.max(document.getElementsByTagName('*').length, 1),
      };
    }

    return monitor.takeSnapshot();
  })()`)) as DomMonitorSnapshot;
}
function collectTrackedSessionIds(xn: OmOPage, jn: string | undefined) {
  let Vn = new Set<string>();
  jn && Vn.add(jn);
  for (let jn of xn.frameManager.frames.values()) Vn.add(jn.sessionId);
  return Vn;
}
async function waitForNavigationReadiness(
  xn: OmOPage,
  jn: NavigationReadinessMode = `interactive`,
  Vn = ACTION_MAX_WAIT_MS,
): Promise<PageProbe> {
  return await Promise.race([
    waitForNavigationReadinessInner(xn, jn, Vn),
    sleep$12(Vn + 1e3).then((): never => {
      throw new NavigationReadinessTimeoutError(jn, Vn);
    }),
  ]);
}
async function waitForNavigationReadinessInner(
  xn: OmOPage,
  jn: NavigationReadinessMode,
  Vn: number,
): Promise<PageProbe> {
  if (isPdfViewerUrl(xn.url()))
    return (
      await waitForDomReady(xn, Math.min(DOM_READY_TIMEOUT_MS, Vn)).catch(() => {}),
      { bodyExists: !0, interactiveCount: 0, landmarkCount: 0, textChars: 0, state: `ready` }
    );
  let qn = Date.now() + Vn,
    Jn = 0,
    Yn = collectTrackedSessionIds(xn, await xn.resolveSessionId().catch(() => void 0)),
    Zn = new NetworkTracker(xn.cdp, Yn),
    Qn: number | null = null,
    ei = !1,
    ti: number | null = null,
    ni: CdpUnsubscribe | null = null;
  try {
    for (
      await waitForDomReady(xn, Math.min(DOM_READY_TIMEOUT_MS, Vn)).catch(() => {}),
        jn === `stable` && (await ensureDomMonitor(xn).catch(() => {})),
        ni = xn.cdp.on(`Page.frameNavigated`, (xn, jn) => {
          !jn.sessionId || !Yn.has(jn.sessionId) || xn.frame.parentId || (ei = !0);
        });
      Date.now() < qn;
    ) {
      await sleep$12(PROBE_INTERVAL_MS);
      try {
        if (ei) {
          ((ei = !1),
            (Jn = 0),
            (Qn = null),
            (ti = null),
            await waitForDomReady(xn, Math.min(DOM_READY_TIMEOUT_MS, Math.max(qn - Date.now(), 0))).catch(() => {}),
            jn === `stable` && (await ensureDomMonitor(xn).catch(() => {})));
          continue;
        }
        let Vn = await takePageProbe(xn);
        if (Vn.state !== `ready`) {
          ((Jn = 0), (Qn = null), (ti = null));
          continue;
        }
        if (
          Zn.captureTrackedRequests(xn.url()).size > 0 &&
          ((Qn ||= Date.now()), Date.now() - Qn < NAVIGATION_NETWORK_BUDGET_MS)
        ) {
          Jn = 0;
          continue;
        }
        if (Vn.interactiveCount === 0 && ((ti ||= Date.now()), Date.now() - ti < REDIRECT_GUARD_MS)) continue;
        if (jn === `interactive`) return Vn;
        let Yn = await readDomMonitor(xn);
        if (((Jn = Yn.mutationCount / Yn.totalNodes <= QUIET_MUTATION_RATIO ? Jn + 1 : 0), Jn >= QUIET_SAMPLE_COUNT))
          return Vn;
      } catch (jn) {
        if (!isTransientEvaluationError(jn)) throw jn;
        ((Jn = 0), (Qn = null), (ti = null));
        let Vn = Math.max(qn - Date.now(), 0);
        await waitForDomReady(xn, Math.min(DOM_READY_TIMEOUT_MS, Vn));
      }
    }
    throw new NavigationReadinessTimeoutError(jn, Vn);
  } finally {
    (ni?.(), Zn.dispose());
  }
}
async function waitForDomQuiet(xn: ExpressionEvaluator, jn: DomQuietOptions = {}) {
  let Vn = jn.budgetMs ?? QUIET_WINDOW_MS,
    qn = jn.sampleIntervalMs ?? QUIET_SAMPLE_INTERVAL_MS,
    Jn = jn.quietMutationRatio ?? QUIET_MUTATION_RATIO,
    Yn = jn.quietSampleCount ?? QUIET_SAMPLE_COUNT,
    Zn = Date.now() + Vn,
    Qn = 0;
  try {
    for (
      await waitForDomReady(xn, Math.min(DOM_READY_TIMEOUT_MS, Vn)).catch(() => {}),
        await ensureDomMonitor(xn).catch(() => {});
      Date.now() < Zn;
    ) {
      await sleep$12(qn);
      let jn = await readDomMonitor(xn);
      if (((Qn = jn.mutationCount / jn.totalNodes <= Jn ? Qn + 1 : 0), Qn >= Yn)) return !0;
    }
  } catch (xn) {
    if (!isTransientEvaluationError(xn)) throw xn;
  }
  return !1;
}
async function performActionAndWait<T>(xn: OmOPage, jn: () => T | Promise<T>, Vn: ActionWaitOptions = {}): Promise<T> {
  let qn = Vn.timeoutMs ?? ACTION_MAX_WAIT_MS,
    Jn = Date.now() + qn,
    Yn = collectTrackedSessionIds(
      xn,
      Vn.frameSessionId ? await xn.resolveSessionId(Vn.frameSessionId) : await xn.resolveSessionId(),
    ),
    Zn = new NetworkTracker(xn.cdp, Yn),
    Qn = { navigated: !1 },
    ei: T,
    ti = await xn.evaluate(() => location.href).catch(() => xn.url()),
    ni = xn.cdp.on(`Page.frameNavigated`, (xn, jn) => {
      !jn.sessionId || !Yn.has(jn.sessionId) || xn.frame.parentId || (Qn.navigated = !0);
    });
  try {
    ei = await jn();
    try {
      let jn = Math.max(Jn - Date.now(), 0);
      await waitForDomReady(xn, Math.min(DOM_READY_TIMEOUT_MS, jn));
    } catch (xn) {
      if (!isTransientEvaluationError(xn) && !isDomReadyTimeoutError(xn)) throw xn;
    }
    await sleep$12(Vn.hookWindowMs ?? ACTION_HOOK_WINDOW_MS);
    let qn = Zn.captureTrackedRequests(xn.url()),
      Yn = Math.min(Date.now() + (Vn.requestTrackingBudgetMs ?? ACTION_REQUEST_TRACKING_BUDGET_MS), Jn);
    for (; qn.size > 0 && Date.now() < Yn && !Qn.navigated;) {
      for (let xn of qn) Zn.isFinished(xn) && qn.delete(xn);
      qn.size > 0 && (await sleep$12(NETWORK_TRACK_POLL_MS));
    }
    if (Qn.navigated)
      return (await waitForNavigationReadiness(xn, `interactive`, Math.max(Jn - Date.now(), DOM_READY_TIMEOUT_MS)), ei);
    let ni = (await xn.evaluate(() => location.href).catch(() => xn.url())) !== ti,
      ri = Math.min(
        Vn.postSettleMs ?? (ni ? SPA_URL_CHANGE_POST_SETTLE_MS : ACTION_POST_SETTLE_MS),
        Math.max(Jn - Date.now(), 0),
      );
    if (ri > 0) {
      let jn = ni ? Math.min(SPA_URL_CHANGE_MIN_DWELL_MS, ri) : 0;
      ni && (await sleep$12(jn));
      let Vn = Math.max(ri - jn, 0);
      (await waitForDomQuiet(xn, { budgetMs: Vn, sampleIntervalMs: 50, quietSampleCount: 1 }).catch(() => !1)) ||
        (await sleep$12(Vn));
    }
    return ei;
  } finally {
    (ni(), Zn.dispose());
  }
}
const DOM_READY_TIMEOUT_MS = 2e3;
const PROBE_INTERVAL_MS = 100;
const QUIET_MUTATION_RATIO = 0.01;
const QUIET_WINDOW_MS = 350;
const QUIET_SAMPLE_INTERVAL_MS = 100;
const QUIET_SAMPLE_COUNT = 2;
const MIN_PROBE_TEXT_CHARS = 20;
const ACTION_HOOK_WINDOW_MS = 150;
const ACTION_REQUEST_TRACKING_BUDGET_MS = 1200;
const ACTION_POST_SETTLE_MS = 300;
const SPA_URL_CHANGE_MIN_DWELL_MS = 500;
const SPA_URL_CHANGE_POST_SETTLE_MS = 750;
const ACTION_MAX_WAIT_MS = 8e3;
const NETWORK_TRACK_POLL_MS = 50;
const NAVIGATION_NETWORK_BUDGET_MS = 1500;
const REDIRECT_GUARD_MS = 1e3;
const DOM_MONITOR_KEY = `__omowrightWaitDomMonitor`;
const REQUEST_SKIP_TYPES = new Set([`WebSocket`, `EventSource`, `Ping`, `Prefetch`, `CSPViolationReport`]);
const NavigationReadinessTimeoutError = class extends Error {
  mode: NavigationReadinessMode;
  timeoutMs: number;
  constructor(xn: NavigationReadinessMode, jn: number) {
    super(`Timed out waiting for ${xn} page after ${jn}ms`);
    ((this.name = `NavigationReadinessTimeoutError`), (this.mode = xn), (this.timeoutMs = jn));
  }
};
const PDF_VIEWER_EXTENSION_PREFIX = `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai`;
interface TrackedRequest {
  hostname: string;
  resourceType: string;
  finished: boolean;
  startedAt: number;
}
const NetworkTracker = class {
  #e = new Map<string, TrackedRequest>();
  #t: CdpUnsubscribe[] = [];
  #n: Set<string>;
  constructor(xn: CdpTransport, jn: Iterable<string>) {
    ((this.#n = new Set(jn)),
      this.#t.push(
        xn.on(`Network.requestWillBeSent`, (xn, jn) => {
          if (!jn.sessionId || !this.#n.has(jn.sessionId)) return;
          let Vn = ``;
          try {
            Vn = new URL(xn.request.url).hostname.toLowerCase();
          } catch {
            return;
          }
          this.#e.set(xn.requestId, {
            hostname: Vn,
            resourceType: xn.type ?? `Other`,
            finished: !1,
            startedAt: Date.now(),
          });
        }),
      ));
    let Vn = (xn: string) => {
      let jn = this.#e.get(xn);
      jn && (jn.finished = !0);
    };
    (this.#t.push(
      xn.on(`Network.loadingFinished`, (xn, jn) => {
        jn.sessionId && this.#n.has(jn.sessionId) && Vn(xn.requestId);
      }),
    ),
      this.#t.push(
        xn.on(`Network.loadingFailed`, (xn, jn) => {
          jn.sessionId && this.#n.has(jn.sessionId) && Vn(xn.requestId);
        }),
      ));
  }
  captureTrackedRequests(xn: string) {
    let jn = new Set<string>(),
      Vn = getNaiveRegistrableDomain(xn);
    for (let [xn, qn] of this.#e)
      qn.finished || (isSameSite(qn.hostname, Vn) && (REQUEST_SKIP_TYPES.has(qn.resourceType) || jn.add(xn)));
    return jn;
  }
  isFinished(xn: string) {
    return this.#e.get(xn)?.finished ?? !0;
  }
  dispose() {
    for (let xn of this.#t) xn();
    this.#t.length = 0;
  }
};
var init_wait = __esmMin(() => {
  init_utils$13();
});
export interface ElementTarget {
  objectId: string;
  frameId?: string | null;
  frameSessionId?: string;
  contextId?: number;
}
export interface Point {
  x: number;
  y: number;
}
export interface PointerDispatchTarget {
  point: Point;
  sessionId: string;
}
export interface ClickOptions {
  modifiers?: string[];
  force?: boolean;
  moveBeforeClick?: boolean;
  dblClick?: boolean;
  waitAfter?: boolean;
}
export interface DragOptions {
  force?: boolean;
  trial?: boolean;
  steps?: number;
  sourcePosition?: Point;
  targetPosition?: Point;
}
export interface FilePayload {
  name: string;
  mimeType?: string;
  base64: string;
}
interface ReadyCheckResult {
  ok: boolean;
  error?: string;
}
interface ClickTargetState {
  checked: boolean | null;
  isComboboxLike: boolean;
  isCheckable: boolean;
  isRadio: boolean;
  popupUrl: string | null;
  prefersDomActivation: boolean;
  expanded: string | null;
}
interface FillPlan {
  mode: `setvalue` | `needsinput`;
  kind: `input` | `textarea` | `contenteditable`;
  expectedValue: string;
  error?: string;
}
type Quad = [number, number, number, number, number, number, number, number];
function isQuad(xn: readonly number[]): xn is Quad {
  return xn.length === 8;
}
function contentEditableValueMatches(xn: string, jn: string) {
  if (xn === jn) return !0;
  let Vn = (xn: string) =>
    xn
      .replace(/\u00a0/g, ` `)
      .replace(
        /\r\n/g,
        `
`,
      )
      .replace(/\n+$/g, ``);
  return Vn(xn) === Vn(jn);
}
function isStaleObjectError(xn: unknown) {
  let jn = xn instanceof Error ? xn.message : String(xn);
  return (
    jn.includes(`Cannot find object with given id`) ||
    jn.includes(`Cannot find context with specified id`) ||
    jn.includes(`Object reference chain is too long`)
  );
}
function quadArea(xn: readonly number[]) {
  if (!isQuad(xn)) return 0;
  let [x0, y0, x1, y1, x2, y2, x3, y3] = xn,
    Vn = 0;
  ((Vn += x0 * y1 - x1 * y0), (Vn += x1 * y2 - x2 * y1), (Vn += x2 * y3 - x3 * y2), (Vn += x3 * y0 - x0 * y3));
  return Math.abs(Vn / 2);
}
function quadCenter(xn: Quad) {
  return { x: (xn[0] + xn[2] + xn[4] + xn[6]) / 4, y: (xn[1] + xn[3] + xn[5] + xn[7]) / 4 };
}
async function resolveActionSessionId(xn: OmOPage, jn: ElementTarget | undefined) {
  return await xn.resolveSessionId(jn?.frameSessionId);
}
async function callOnElement<R = unknown>(xn: OmOPage, jn: ElementTarget, Vn: string, ...qn: unknown[]): Promise<R> {
  try {
    let Jn = qn.map((xn) => ({ value: xn })),
      Yn = await resolveActionSessionId(xn, jn),
      { result: Zn, exceptionDetails: Qn } = await xn.cdp.send(
        `Runtime.callFunctionOn`,
        {
          objectId: jn.objectId,
          functionDeclaration: Vn,
          arguments: Jn,
          returnByValue: !0,
          awaitPromise: !0,
          userGesture: !0,
        },
        Yn,
      );
    if (Qn) throw Error(formatRuntimeException(Qn, `Runtime.callFunctionOn failed`));
    return Zn.value as R;
  } catch (xn) {
    throw isStaleObjectError(xn) ? new RefStaleError(jn.objectId) : xn;
  }
}
async function callOnElementSync<R = unknown>(
  xn: OmOPage,
  jn: ElementTarget,
  Vn: string,
  ...qn: unknown[]
): Promise<R> {
  try {
    let Jn = qn.map((xn) => ({ value: xn })),
      Yn = await resolveActionSessionId(xn, jn),
      { result: Zn, exceptionDetails: Qn } = await xn.cdp.send(
        `Runtime.callFunctionOn`,
        {
          objectId: jn.objectId,
          functionDeclaration: Vn,
          arguments: Jn,
          returnByValue: !0,
          awaitPromise: !1,
          userGesture: !0,
        },
        Yn,
      );
    if (Qn) throw Error(formatRuntimeException(Qn, `Runtime.callFunctionOn failed`));
    return Zn.value as R;
  } catch (xn) {
    throw isStaleObjectError(xn) ? new RefStaleError(jn.objectId) : xn;
  }
}
async function callOnElementHandle(
  xn: OmOPage,
  jn: ElementTarget,
  Vn: string,
  ...qn: unknown[]
): Promise<ElementTarget> {
  try {
    let Jn = qn.map((xn) => ({ value: xn })),
      Yn = await resolveActionSessionId(xn, jn),
      { result: Zn, exceptionDetails: Qn } = await xn.cdp.send(
        `Runtime.callFunctionOn`,
        {
          objectId: jn.objectId,
          functionDeclaration: Vn,
          arguments: Jn,
          returnByValue: !1,
          awaitPromise: !0,
          userGesture: !0,
        },
        Yn,
      );
    if (Qn) throw Error(formatRuntimeException(Qn, `Runtime.callFunctionOn failed`));
    if (!Zn.objectId) throw Error(`Runtime.callFunctionOn did not return an object handle`);
    return { objectId: Zn.objectId, frameId: jn.frameId, frameSessionId: jn.frameSessionId, contextId: jn.contextId };
  } catch (xn) {
    throw isStaleObjectError(xn) ? new RefStaleError(jn.objectId) : xn;
  }
}
async function resolveClickTarget(xn: OmOPage, jn: ElementTarget) {
  return await callOnElementHandle(
    xn,
    jn,
    `function() {
      const root = globalThis.__omowright?.retarget(this, 'none') || this;

      // Some sites expose refs that point at semantic wrappers while the actual hit
       // target lives on an inner combobox-like trigger. Resolve that trigger once here so the click path stays generic.
      const triggerSelector = '[role="combobox"], [aria-haspopup="listbox"], summary';
      if (root.matches?.(triggerSelector)) {
        return root;
      }

      const nestedTrigger = root.querySelector?.(triggerSelector);
      if (nestedTrigger) {
        return nestedTrigger;
      }

      return globalThis.__omowright?.resolvePointerTarget?.(root) || root;
    }`,
  );
}
async function readClickTargetState(xn: OmOPage, jn: ElementTarget) {
  return await callOnElementSync<ClickTargetState>(
    xn,
    jn,
    `function() {
      const isComboboxLike = !!this.matches?.('[role="combobox"], [aria-haspopup="listbox"], summary');
      const isLink = this.tagName?.toUpperCase() === 'A';
      const href = isLink ? (this.getAttribute?.('href') || '') : '';
      const absoluteHref = isLink ? this.href : '';
      const role = String(this.getAttribute?.('role') || '').toLowerCase();
      const nativeCheckable = this instanceof HTMLInputElement
        ? this
        : this instanceof HTMLLabelElement
          ? this.control
          : null;
      const nativeType = nativeCheckable instanceof HTMLInputElement ? String(nativeCheckable.type || '').toLowerCase() : '';
      const isNativeCheckable = nativeType === 'checkbox' || nativeType === 'radio';
      const ariaChecked = this.getAttribute?.('aria-checked');
      const checked = isNativeCheckable
        ? !!nativeCheckable.checked
        : ariaChecked === 'true'
          ? true
          : ariaChecked === 'false'
            ? false
            : null;
      // Use JS .click() for <a> links with real hrefs — coordinate-based CDP
      // dispatch can miss the link when a child element (icon span, image) at
      // the click point absorbs the event without triggering default navigation.
      const prefersDomActivation =
        (isLink && !!href && !href.startsWith('#') && !href.startsWith('javascript:')) ||
        // Native checkbox/radio filters frequently hide the real state carrier
        // behind labels or framework wrappers. DOM activation plus post-check
        // verification is more reliable than CDP coordinates for these controls.
        isNativeCheckable;
      return {
        checked,
        isComboboxLike,
        isCheckable: isNativeCheckable || checked !== null,
        isRadio: nativeType === 'radio' || role === 'radio',
        popupUrl: prefersDomActivation && this.target === '_blank' ? absoluteHref : null,
        prefersDomActivation,
        expanded: isComboboxLike ? this.getAttribute?.('aria-expanded') ?? null : null,
      };
    }`,
  );
}
async function domClickTarget(xn: OmOPage, jn: ElementTarget) {
  await callOnElementSync(
    xn,
    jn,
    `function() {
      if (typeof this.click === 'function') {
        this.click();
      }
    }`,
  );
}
async function ensurePointerActionable(xn: OmOPage, jn: ElementTarget) {
  for (let Vn of ACTIONABILITY_RETRY_DELAYS_MS) {
    Vn > 0 && (await sleep$12(Vn));
    let qn = await callOnElement<ReadyCheckResult>(
      xn,
      jn,
      `function(checks) {
        return globalThis.__omowright.waitForReady(this, checks);
      }`,
      [`attached`, `visible`, `stable`, `enabled`],
    );
    if (!qn.ok) {
      if (
        (qn.error?.includes(`moving`) || qn.error?.includes(`obscured`)) &&
        Vn !== ACTIONABILITY_RETRY_DELAYS_MS[ACTIONABILITY_RETRY_DELAYS_MS.length - 1]
      )
        continue;
      throw Error(qn.error || `Element is not ready for click`);
    }
    let Jn = await getLocalClickPoint(xn, jn),
      Yn = await callOnElementSync<ReadyCheckResult>(
        xn,
        jn,
        `function(clickPoint) {
        return globalThis.__omowright.checkHitTarget(this, clickPoint);
      }`,
        Jn,
      );
    if (Yn.ok) return await resolvePointerDispatchTarget(xn, jn, Jn);
    if (
      !(
        Yn.error?.includes(`obscured`) && Vn !== ACTIONABILITY_RETRY_DELAYS_MS[ACTIONABILITY_RETRY_DELAYS_MS.length - 1]
      )
    )
      throw Error(Yn.error || `Element is not receiving pointer events`);
  }
  throw Error(`Element did not become clickable in time`);
}
async function resolvePointerDispatchTarget(xn: OmOPage, jn: ElementTarget, Vn: Point): Promise<PointerDispatchTarget> {
  let qn = await findFrameOwnerContentOffset(xn, jn.frameId);
  return qn
    ? { point: { x: Vn.x + qn.x, y: Vn.y + qn.y }, sessionId: await xn.resolveSessionId() }
    : { point: Vn, sessionId: await resolveActionSessionId(xn, jn) };
}
async function findFrameOwnerContentOffset(xn: OmOPage, jn: string | null | undefined) {
  let Vn = await xn.resolveSessionId(),
    { root: qn } = await xn.cdp.send(`DOM.getDocument`, { depth: -1, pierce: !0 }, Vn),
    { nodeIds: Jn } = await xn.cdp.send(`DOM.querySelectorAll`, { nodeId: qn.nodeId, selector: `iframe,frame` }, Vn);
  for (let qn of Jn) {
    let { node: Jn } = await xn.cdp.send(`DOM.describeNode`, { nodeId: qn }, Vn);
    if (Jn.frameId !== jn) continue;
    let { object: Yn } = await xn.cdp.send(`DOM.resolveNode`, { nodeId: qn }, Vn);
    if (Yn.objectId)
      try {
        let { result: jn, exceptionDetails: qn } = await xn.cdp.send(
          `Runtime.callFunctionOn`,
          {
            objectId: Yn.objectId,
            functionDeclaration: `function() {
            const rect = this.getBoundingClientRect();
            return { x: rect.left, y: rect.top };
          }`,
            returnByValue: !0,
            awaitPromise: !0,
            userGesture: !1,
          },
          Vn,
        );
        if (qn) throw Error(formatRuntimeException(qn, `Unable to read frame owner rect`));
        let Jn = jn.value as Point;
        if (Number.isFinite(Jn.x) && Number.isFinite(Jn.y)) return { x: Jn.x, y: Jn.y };
      } finally {
        await xn.cdp.send(`Runtime.releaseObject`, { objectId: Yn.objectId }, Vn).catch(() => {});
      }
  }
  return null;
}
async function getLocalClickPoint(xn: OmOPage, jn: ElementTarget) {
  let Vn = await resolveActionSessionId(xn, jn);
  try {
    await xn.cdp.send(`DOM.scrollIntoViewIfNeeded`, { objectId: jn.objectId }, Vn);
  } catch {
    await callOnElementSync(
      xn,
      jn,
      `function() {
        if (this && this.scrollIntoView) {
          this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        }
      }`,
    ).catch(() => {});
  }
  let qn = await callOnElementSync<Point & { ok: boolean }>(
    xn,
    jn,
    `function() {
      const rect = this.getBoundingClientRect();
      const ok = rect.width > 0 && rect.height > 0;
      return {
        ok,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    }`,
  );
  if (qn.ok) return { x: qn.x, y: qn.y };
  let { quads: Jn } = await xn.cdp.send(`DOM.getContentQuads`, { objectId: jn.objectId }, Vn);
  for (let xn of Jn ?? []) if (isQuad(xn) && !(quadArea(xn) < 0.99)) return quadCenter(xn);
  throw Error(`No valid clickable point found for element`);
}
async function getPointerDispatchTarget(xn: OmOPage, jn: ElementTarget) {
  return await resolvePointerDispatchTarget(xn, jn, await getLocalClickPoint(xn, jn));
}
async function keyDown(xn: OmOPage, jn: string | undefined, Vn: string, qn: ModifierState) {
  let Jn = resolveKeyDescriptor(Vn, { modifiers: qn.modifiers() }),
    Yn = qn.has(Jn.key);
  qn.down(Jn.key);
  try {
    await xn.cdp.send(
      `Input.dispatchKeyEvent`,
      {
        type: Jn.text ? `keyDown` : `rawKeyDown`,
        key: Jn.key,
        code: Jn.code,
        commands: keyCommands(Jn.code, qn.modifiers()),
        text: Jn.text,
        unmodifiedText: Jn.text,
        windowsVirtualKeyCode: Jn.keyCodeWithoutLocation,
        location: Jn.location,
        isKeypad: Jn.location === 3,
        modifiers: qn.toModifiersMask(),
      },
      jn,
    );
  } catch (xn) {
    throw (Yn || qn.up(Jn.key), xn);
  }
}
async function keyUp(xn: OmOPage, jn: string | undefined, Vn: string, qn: ModifierState) {
  let Jn = resolveKeyDescriptor(Vn, { modifiers: qn.modifiers() }),
    Yn = qn.has(Jn.key);
  qn.up(Jn.key);
  try {
    await xn.cdp.send(
      `Input.dispatchKeyEvent`,
      {
        type: `keyUp`,
        key: Jn.key,
        code: Jn.code,
        windowsVirtualKeyCode: Jn.keyCodeWithoutLocation,
        location: Jn.location,
        modifiers: qn.toModifiersMask(),
      },
      jn,
    );
  } catch (xn) {
    throw (Yn && qn.down(Jn.key), xn);
  }
}
async function focusElement(xn: OmOPage, jn: ElementTarget, Vn = !1) {
  await callOnElementSync(
    xn,
    jn,
    `function(resetSelection) {
      const target = globalThis.__omowright?.retarget(this, 'follow-label') || this;
      const wasFocused = target?.ownerDocument?.activeElement === target;
      if (target && 'focus' in target && typeof target.focus === 'function') {
        target.focus();
      }
      // Playwright resets a newly-focused input so sequential typing starts at the beginning.
      if (resetSelection && !wasFocused && target?.tagName === 'INPUT') {
        try {
          target.setSelectionRange(0, 0);
        } catch {
          // Some input types do not support text selection.
        }
      }
    }`,
    Vn,
  );
}
async function blurElement(xn: OmOPage, jn: ElementTarget) {
  await callOnElementSync(
    xn,
    jn,
    `function() {
      const target = globalThis.__omowright?.retarget(this, 'follow-label') || this;
      if (target && 'blur' in target && typeof target.blur === 'function') {
        target.blur();
      }
    }`,
  );
}
async function readComboboxState(xn: OmOPage, jn: ElementTarget) {
  let Vn = await readClickTargetState(xn, jn);
  return { hasComboboxTarget: Vn.isComboboxLike, expanded: Vn.expanded };
}
async function clickComboboxFallback(xn: OmOPage, jn: ElementTarget) {
  await domClickTarget(xn, jn);
}
async function clickElement(
  xn: OmOPage,
  jn: ElementTarget,
  Vn: ClickOptions = {},
  qn: ModifierState = defaultModifierState,
) {
  let Jn = await resolveClickTarget(xn, jn),
    Yn = Vn.modifiers ?? [],
    Zn: string[] = [],
    Qn = await xn.resolveSessionId(),
    ei = await readComboboxState(xn, Jn).catch(() => ({ hasComboboxTarget: !1, expanded: null })),
    ti = await readClickTargetState(xn, Jn).catch((): ClickTargetState => ({
      expanded: null,
      checked: null,
      isComboboxLike: !1,
      isCheckable: !1,
      isRadio: !1,
      popupUrl: null,
      prefersDomActivation: !1,
    }));
  try {
    let jn = async () => {
      let jn = async () =>
          !ti.isCheckable || ti.checked === null || (ti.isRadio && ti.checked)
            ? !0
            : (await readClickTargetState(xn, Jn).catch(() => null))?.checked !== ti.checked,
        ni = async () => {
          if (ti.popupUrl && xn.openPopupUrl) {
            await xn.openPopupUrl(ti.popupUrl);
            return;
          }
          await domClickTarget(xn, Jn);
        };
      if (ti.prefersDomActivation) {
        if ((await ni(), !(await jn()))) throw Error(`Checkbox click did not change checked state`);
        return;
      }
      let ri: Point;
      try {
        let jn = Vn.force ? await getPointerDispatchTarget(xn, Jn) : await ensurePointerActionable(xn, Jn);
        ((ri = jn.point), (Qn = jn.sessionId));
      } catch (qn) {
        let Yn = qn instanceof Error ? qn.message : String(qn);
        if (ti.isCheckable && ((await jn()) || (await ni(), await jn()))) return;
        if (!Vn.force && Yn.includes(`obscured`)) {
          await domClickTarget(xn, Jn);
          return;
        }
        throw qn;
      }
      let { x: ii, y: ai } = ri;
      try {
        for (let jn of Yn) (await keyDown(xn, Qn, jn, qn), Zn.push(jn));
        Vn.moveBeforeClick !== !1 &&
          (await xn.cdp.send(
            `Input.dispatchMouseEvent`,
            { type: `mouseMoved`, x: ii, y: ai, button: `none`, modifiers: qn.toModifiersMask() },
            Qn,
          ));
        let jn = Vn.dblClick ? 2 : 1;
        await xn.prepareForPotentialFileChooser?.();
        for (let Vn = 1; Vn <= jn; Vn += 1)
          (await xn.cdp.send(
            `Input.dispatchMouseEvent`,
            {
              type: `mousePressed`,
              x: ii,
              y: ai,
              button: `left`,
              buttons: 1,
              clickCount: Vn,
              modifiers: qn.toModifiersMask(),
            },
            Qn,
          ),
            await xn.cdp.send(
              `Input.dispatchMouseEvent`,
              {
                type: `mouseReleased`,
                x: ii,
                y: ai,
                button: `left`,
                buttons: 0,
                clickCount: Vn,
                modifiers: qn.toModifiersMask(),
              },
              Qn,
            ));
      } catch (xn) {
        if (ti.isCheckable && ((await jn()) || (await ni(), await jn()))) return;
        throw xn;
      }
      ei.hasComboboxTarget && ei.expanded === `false` && (await sleep$12(80));
      let oi = await readComboboxState(xn, Jn).catch(() => ({ hasComboboxTarget: !1, expanded: null }));
      if (
        (ei.hasComboboxTarget &&
          ei.expanded === `false` &&
          oi.expanded === `false` &&
          (await clickComboboxFallback(xn, Jn)),
        !(await jn()) && (await ni(), !(await jn())))
      )
        throw Error(`Checkbox click did not change checked state`);
    };
    if (Vn.waitAfter === !1) await jn();
    else
      try {
        await performActionAndWait(xn, jn, { frameSessionId: Jn.frameSessionId });
      } catch (xn) {
        if (xn instanceof NavigationReadinessTimeoutError && xn.mode === `interactive`) {
          replPrint(`[warning] Waited ${xn.timeoutMs}ms for the page to become ready after the click.`);
          return;
        }
        throw xn;
      }
  } finally {
    for (let jn of Zn.toReversed()) await keyUp(xn, Qn, jn, qn).catch(() => {});
  }
}
async function fillElement(xn: OmOPage, jn: ElementTarget, Vn: unknown) {
  let qn = await resolveActionSessionId(xn, jn),
    Jn = await callOnElementSync<FillPlan>(
      xn,
      jn,
      `function(nextValue, setValueTypes, typeIntoTypes) {
      const target = globalThis.__omowright?.retarget(this, 'follow-label');
      if (!target) {
        return { mode: 'needsinput', kind: 'input', expectedValue: '', error: 'Unable to retarget element' };
      }

      const editable = globalThis.__omowright?.checkEditable(target);
      if (!editable?.ok) {
        return {
          mode: 'needsinput',
          kind: 'input',
          expectedValue: '',
          error: editable?.error || 'Element is not editable',
        };
      }

      const tagName = target.tagName.toUpperCase();
      if (tagName === 'INPUT') {
        const inputType = String(target.type || '').toLowerCase();
        if (!setValueTypes.includes(inputType) && !typeIntoTypes.includes(inputType)) {
          return {
            mode: 'needsinput',
            kind: 'input',
            expectedValue: '',
            error: 'Input of type "' + inputType + '" cannot be filled',
          };
        }

        let expectedValue = String(nextValue ?? '');
        if (inputType === 'number') {
          expectedValue = expectedValue.trim();
          if (Number.isNaN(Number(expectedValue))) {
            return {
              mode: 'needsinput',
              kind: 'input',
              expectedValue,
              error: 'Cannot type text into input[type=number]',
            };
          }
        }
        if (inputType === 'color') expectedValue = expectedValue.toLowerCase();

        if (setValueTypes.includes(inputType)) {
          expectedValue = expectedValue.trim();
          target.focus();
          target.value = expectedValue;
          if (target.value !== expectedValue) {
            return { mode: 'setvalue', kind: 'input', expectedValue, error: 'Malformed value' };
          }
          target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
          return { mode: 'setvalue', kind: 'input', expectedValue };
        }

        target.select();
        target.focus();
        return { mode: 'needsinput', kind: 'input', expectedValue };
      }

      if (tagName === 'TEXTAREA') {
        target.selectionStart = 0;
        target.selectionEnd = target.value.length;
        target.focus();
        return { mode: 'needsinput', kind: 'textarea', expectedValue: String(nextValue ?? '') };
      }

      if (target.isContentEditable) {
        target.focus();
        const selection = target.ownerDocument.getSelection();
        if (selection) {
          const range = target.ownerDocument.createRange();
          range.selectNodeContents(target);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        return { mode: 'needsinput', kind: 'contenteditable', expectedValue: String(nextValue ?? '') };
      }

      return {
        mode: 'needsinput',
        kind: 'input',
        expectedValue: '',
        error: 'Element is not an <input>, <textarea> or [contenteditable] element',
      };
    }`,
      Vn,
      kSetValueInputTypes,
      kTypeIntoInputTypes,
    );
  if (Jn.error) throw Error(Jn.error);
  if (Jn.mode === `setvalue`) return;
  Jn.expectedValue
    ? await xn.cdp.send(`Input.insertText`, { text: Jn.expectedValue }, qn)
    : (await keyDown(xn, qn, `Delete`, defaultModifierState), await keyUp(xn, qn, `Delete`, defaultModifierState));
  let Yn = async () =>
      await callOnElementSync<string>(
        xn,
        jn,
        `function(kind) {
        const target = globalThis.__omowright?.retarget(this, 'follow-label') || this;
        if (kind === 'contenteditable') return target.innerText || '';
        return typeof target.value === 'string' ? target.value : '';
      }`,
        Jn.kind,
      ),
    Zn = await Yn();
  if (
    Zn !== Jn.expectedValue &&
    !(Jn.kind === `contenteditable` && contentEditableValueMatches(Zn, Jn.expectedValue))
  ) {
    if (Jn.kind === `contenteditable`) throw Error(`Fill did not set the expected contenteditable value`);
    if (
      !(await callOnElementSync(
        xn,
        jn,
        `function(nextValue) {
      const target = globalThis.__omowright?.retarget(this, 'follow-label') || this;
      const tagName = target.tagName ? target.tagName.toUpperCase() : '';
      if (tagName !== 'INPUT' && tagName !== 'TEXTAREA') return false;

      const previousValue = target.value;
      let prototype = Object.getPrototypeOf(target);
      let descriptor;
      while (prototype && !descriptor) {
        descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        prototype = Object.getPrototypeOf(prototype);
      }
      if (!descriptor || typeof descriptor.set !== 'function') return false;

      descriptor.set.call(target, String(nextValue ?? ''));
      const tracker = target._valueTracker;
      if (tracker && typeof tracker.setValue === 'function') tracker.setValue(String(previousValue));
      target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      return true;
    }`,
        Jn.expectedValue,
      ))
    )
      throw Error(`Fill fallback could not update the target`);
    if ((await Yn()) !== Jn.expectedValue) throw Error(`Fill did not set the expected value`);
  }
}
async function selectOptionElement(xn: OmOPage, jn: ElementTarget, Vn: unknown) {
  return await performActionAndWait(
    xn,
    async () =>
      await callOnElementSync<string[]>(
        xn,
        jn,
        `function(requested) {
          const target = globalThis.__omowright?.retarget(this, 'follow-label') || this;
          if (!target || !target.tagName || target.tagName.toUpperCase() !== 'SELECT') {
            throw new Error('Element is not a <select>');
          }

          const select = target;
          const wanted = Array.isArray(requested) ? requested : [requested];
          const matched = new Set();

          for (let index = 0; index < select.options.length; index += 1) {
            const option = select.options[index];
            const matches = wanted.some((token) => {
              if (token && typeof token === 'object') {
                if (typeof token.value === 'string' && token.value === option.value) return true;
                if (typeof token.label === 'string' && token.label === option.label) return true;
                if (typeof token.index === 'number' && token.index === index) return true;
                return false;
              }
              const candidate = String(token);
              return candidate === option.value || candidate === option.label || candidate === String(index);
            });
            if (matches) {
              matched.add(option.value);
            }
            option.selected = matches;
          }

          if (!select.multiple && matched.size > 1) {
            const first = Array.from(select.options).find((option) => matched.has(option.value));
            for (const option of select.options) {
              option.selected = option === first;
            }
          }

          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return Array.from(select.selectedOptions).map((option) => option.value);
        }`,
        Vn,
      ),
    { frameSessionId: jn.frameSessionId },
  );
}
async function checkElement(xn: OmOPage, jn: ElementTarget, Vn = !0) {
  let qn = await callOnElementSync<{ checked: boolean | null; isRadio: boolean; prefersLabelClick: boolean }>(
    xn,
    jn,
    `function() {
      const target = globalThis.__omowright?.retarget(this, 'follow-label') || this;
      const role = String(target.getAttribute?.('role') || '').toLowerCase();
      const isNativeInput = target.tagName?.toUpperCase() === 'INPUT';
      const type = String(target.type || '').toLowerCase();
      const prefersLabelClick = isNativeInput &&
        (type === 'checkbox' || type === 'radio') &&
        Array.from(target.labels ?? []).some((label) => {
          const style = label.ownerDocument?.defaultView?.getComputedStyle?.(label);
          if (style && (style.display === 'none' || style.visibility === 'hidden')) {
            return false;
          }
          const rect = label.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });

      const nativeChecked = isNativeInput && (type === 'checkbox' || type === 'radio')
        ? !!target.checked
        : null;
      const ariaChecked = target.getAttribute?.('aria-checked');

      if (nativeChecked !== null) {
        return { checked: nativeChecked, isRadio: type === 'radio', prefersLabelClick };
      }
      if (ariaChecked === 'true') {
        return { checked: true, isRadio: role === 'radio', prefersLabelClick };
      }
      if (ariaChecked === 'false') {
        return { checked: false, isRadio: role === 'radio', prefersLabelClick };
      }
      return { checked: null, isRadio: role === 'radio', prefersLabelClick };
    }`,
  );
  if (qn.checked !== Vn) {
    if (qn.isRadio && Vn === !1) throw Error(`Radio buttons cannot be unchecked directly`);
    try {
      await clickElement(xn, jn);
    } catch (Vn) {
      if (
        !qn.prefersLabelClick ||
        !(await callOnElementSync(
          xn,
          jn,
          `function() {
        const target = globalThis.__omowright?.retarget(this, 'follow-label') || this;
        if (!(target instanceof HTMLInputElement) || (target.type !== 'checkbox' && target.type !== 'radio')) {
          return false;
        }

        const label = Array.from(target.labels ?? []).find((candidate) => {
          const style = candidate.ownerDocument?.defaultView?.getComputedStyle?.(candidate);
          if (style && (style.display === 'none' || style.visibility === 'hidden')) {
            return false;
          }
          const rect = candidate.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });

        if (!label) {
          return false;
        }

        label.click();
        return true;
      }`,
        ))
      )
        throw Vn;
    }
    try {
      if (
        (await callOnElementSync(
          xn,
          jn,
          `function() {
        const target = globalThis.__omowright?.retarget(this, 'follow-label') || this;
        if (target.tagName?.toUpperCase() === 'INPUT') {
          const type = String(target.type || '').toLowerCase();
          if (type === 'checkbox' || type === 'radio') {
            return !!target.checked;
          }
        }
        const ariaChecked = target.getAttribute?.('aria-checked');
        if (ariaChecked === 'true') return true;
        if (ariaChecked === 'false') return false;
        return null;
      }`,
        )) !== Vn
      )
        throw Error(`Element checked state did not change to ${Vn}`);
    } catch (xn) {
      if (xn instanceof RefStaleError) return;
      throw xn;
    }
  }
}
function requireResolvedFrameSession(xn: OmOPage, jn: ElementTarget) {
  if (!jn.frameSessionId || !xn.frameManager.hasSession(jn.frameSessionId))
    throw Error(`Frame is stale or detached: CDP session ${jn.frameSessionId ?? `missing`} is unavailable`);
  return jn.frameSessionId;
}
async function pressElement(xn: OmOPage, jn: ElementTarget, Vn: string, qn: OmOKeyboard) {
  let Jn = requireResolvedFrameSession(xn, jn);
  (await focusElement(xn, jn, !0), await qn.press(Vn, {}, Jn));
}
async function focusResolvedElement(xn: OmOPage, jn: ElementTarget) {
  await focusElement(xn, jn);
}
async function blurResolvedElement(xn: OmOPage, jn: ElementTarget) {
  await blurElement(xn, jn);
}
async function pressSequentiallyElement(
  xn: OmOPage,
  jn: ElementTarget,
  Vn: string,
  qn: number | undefined,
  Jn: OmOKeyboard,
) {
  let Yn = requireResolvedFrameSession(xn, jn);
  (await focusElement(xn, jn, !0), await Jn.type(Vn, { delay: qn }, Yn));
}
async function hoverElement(xn: OmOPage, jn: ElementTarget) {
  let Vn = await callOnElement<ReadyCheckResult>(
    xn,
    jn,
    `function() {
      return globalThis.__omowright.waitForReady(this, ['visible']);
    }`,
  );
  if (!Vn.ok) throw Error(Vn.error || `Element is not visible`);
  let qn = await getPointerDispatchTarget(xn, jn),
    { x: Jn, y: Yn } = qn.point;
  await xn.cdp.send(
    `Input.dispatchMouseEvent`,
    { type: `mouseMoved`, x: Jn, y: Yn, button: `none`, modifiers: defaultModifierState.toModifiersMask() },
    qn.sessionId,
  );
}
async function tapElement(xn: OmOPage, jn: ElementTarget) {
  await clickElement(xn, jn);
}
async function scrollIntoViewElement(xn: OmOPage, jn: ElementTarget) {
  let Vn = await resolveActionSessionId(xn, jn);
  try {
    await xn.cdp.send(`DOM.scrollIntoViewIfNeeded`, { objectId: jn.objectId }, Vn);
  } catch {
    await callOnElementSync(
      xn,
      jn,
      `function() {
        if (this && this.scrollIntoView) {
          this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        }
      }`,
    );
  }
}
async function evaluateOnElement<R = unknown>(xn: OmOPage, jn: ElementTarget, Vn: string, qn?: unknown): Promise<R> {
  let Jn = `function(...__args) { return (${Vn}).call(this, this, ...__args); }`;
  return qn === void 0 ? await callOnElementSync<R>(xn, jn, Jn) : await callOnElementSync<R>(xn, jn, Jn, qn);
}
async function boundingBoxElement(xn: OmOPage, jn: ElementTarget) {
  try {
    let Vn = await callOnElementSync<{ x: number; y: number; width: number; height: number } | null>(
      xn,
      jn,
      `function() {
        const rect = this.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          return null;
        }
        return {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        };
      }`,
    );
    if (Vn) return Vn;
    let qn = await resolveActionSessionId(xn, jn),
      { model: Jn } = await xn.cdp.send(`DOM.getBoxModel`, { objectId: jn.objectId }, qn),
      Yn = Jn.border;
    if (!Yn || !isQuad(Yn)) return null;
    let Zn = [Yn[0], Yn[2], Yn[4], Yn[6]],
      Qn = [Yn[1], Yn[3], Yn[5], Yn[7]],
      ei = Math.min(...Zn),
      ti = Math.max(...Zn),
      ni = Math.min(...Qn),
      ri = Math.max(...Qn);
    return { x: ei, y: ni, width: ti - ei, height: ri - ni };
  } catch {
    return null;
  }
}
async function isCheckedElement(xn: OmOPage, jn: ElementTarget) {
  return await evaluateOnElement<boolean>(
    xn,
    jn,
    `function() {
      return !!this.checked;
    }`,
  );
}
async function inputValueElement(xn: OmOPage, jn: ElementTarget) {
  return await evaluateOnElement<string>(
    xn,
    jn,
    `function() {
      return this.value || '';
    }`,
  );
}
async function innerHTMLElement(xn: OmOPage, jn: ElementTarget) {
  return await evaluateOnElement<string>(
    xn,
    jn,
    `function() {
      return this.innerHTML;
    }`,
  );
}
async function innerTextElement(xn: OmOPage, jn: ElementTarget) {
  return await evaluateOnElement<string>(
    xn,
    jn,
    `function() {
      if (typeof this.innerText === 'string') {
        return this.innerText;
      }
      return this.textContent || '';
    }`,
  );
}
async function textContentElement(xn: OmOPage, jn: ElementTarget) {
  return await evaluateOnElement<string | null>(
    xn,
    jn,
    `function() {
      return this.textContent ?? null;
    }`,
  );
}
async function getAttributeElement(xn: OmOPage, jn: ElementTarget, Vn: string) {
  return await evaluateOnElement<string | null>(
    xn,
    jn,
    `function(_, attributeName) {
      return this.getAttribute(attributeName);
    }`,
    Vn,
  );
}
async function isDisabledElement(xn: OmOPage, jn: ElementTarget) {
  return await evaluateOnElement<boolean>(
    xn,
    jn,
    `function() {
      const formControls = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'OPTGROUP'];
      if (formControls.includes(this.tagName)) {
        if (this.disabled) return true;
        const fieldset = this.closest?.('fieldset:disabled');
        if (fieldset) {
          const legend = fieldset.querySelector?.(':scope > legend');
          if (!legend || !legend.contains(this)) return true;
        }
      }

      let current = this;
      while (current) {
        if (current.getAttribute?.('aria-disabled') === 'true') return true;
        current = current.parentElement;
      }
      return false;
    }`,
  );
}
async function isEnabledElement(xn: OmOPage, jn: ElementTarget) {
  return !(await isDisabledElement(xn, jn));
}
async function isVisibleElement(xn: OmOPage, jn: ElementTarget) {
  return await evaluateOnElement<boolean>(
    xn,
    jn,
    `function() {
      if (!this.isConnected) return false;
      const rect = this.getBoundingClientRect();
      return (
        this.checkVisibility?.({ checkOpacity: false, checkVisibilityCSS: true }) !== false &&
        rect.width > 0 &&
        rect.height > 0
      );
    }`,
  );
}
async function isHiddenElement(xn: OmOPage, jn: ElementTarget) {
  return !(await isVisibleElement(xn, jn));
}
async function isEditableElement(xn: OmOPage, jn: ElementTarget) {
  return await evaluateOnElement<boolean>(
    xn,
    jn,
    `function() {
      const target = globalThis.__omowright?.retarget(this, 'follow-label') || this;
      return globalThis.__omowright?.checkEditable(target).ok === true;
    }`,
  );
}
async function dispatchEventElement(xn: OmOPage, jn: ElementTarget, Vn: string, qn?: unknown) {
  await callOnElementSync(
    xn,
    jn,
    `function(eventType, init) {
      const name = String(eventType || '').toLowerCase();
      const constructors = {
        click: 'MouseEvent',
        dblclick: 'MouseEvent',
        mousedown: 'MouseEvent',
        mouseup: 'MouseEvent',
        mousemove: 'MouseEvent',
        mouseenter: 'MouseEvent',
        mouseleave: 'MouseEvent',
        mouseover: 'MouseEvent',
        mouseout: 'MouseEvent',
        contextmenu: 'MouseEvent',
        auxclick: 'MouseEvent',
        keydown: 'KeyboardEvent',
        keyup: 'KeyboardEvent',
        keypress: 'KeyboardEvent',
        focus: 'FocusEvent',
        blur: 'FocusEvent',
        focusin: 'FocusEvent',
        focusout: 'FocusEvent',
        input: 'InputEvent',
        beforeinput: 'InputEvent',
        pointerdown: 'PointerEvent',
        pointerup: 'PointerEvent',
        pointermove: 'PointerEvent',
        pointerenter: 'PointerEvent',
        pointerleave: 'PointerEvent',
        pointerover: 'PointerEvent',
        pointerout: 'PointerEvent',
        pointercancel: 'PointerEvent',
        wheel: 'WheelEvent',
        drag: 'DragEvent',
        dragstart: 'DragEvent',
        dragend: 'DragEvent',
        dragenter: 'DragEvent',
        dragexit: 'DragEvent',
        dragleave: 'DragEvent',
        dragover: 'DragEvent',
        drop: 'DragEvent',
        touchstart: 'TouchEvent',
        touchmove: 'TouchEvent',
        touchend: 'TouchEvent',
        touchcancel: 'TouchEvent',
      };
      const constructorName = constructors[name] || 'Event';
      const Constructor = globalThis[constructorName] || Event;
      const event = new Constructor(eventType, init || undefined);
      this.dispatchEvent(event);
    }`,
    Vn,
    qn,
  );
}
async function setInputFilesElement(xn: OmOPage, jn: ElementTarget, Vn: string[] | FilePayload[]) {
  let qn = await callOnElementHandle(
    xn,
    jn,
    `function() {
      const target = globalThis.__omowright?.retarget(this, 'follow-label') || this;
      if (target?.tagName?.toUpperCase() === 'INPUT' && String(target.type || '').toLowerCase() === 'file') {
        return target;
      }
      const label = this.closest('label');
      const nearby = label?.querySelector('input[type=file]')
        || this.parentElement?.querySelector('input[type=file]')
        || this.closest('[role=dialog], [role=region], section, form, main')?.querySelector('input[type=file]');
      if (nearby) return nearby;
      throw new Error('Element is not an <input type="file">');
    }`,
  );
  try {
    if (Vn.length === 0 || typeof Vn[0] == `string`) {
      let jn = await resolveActionSessionId(xn, qn);
      await xn.cdp.send(`DOM.setFileInputFiles`, { objectId: qn.objectId, files: Vn }, jn);
      return;
    }
    await callOnElementSync(
      xn,
      qn,
      `function(payloads) {
        const input = this;
        const transfer = new DataTransfer();
        for (const payload of payloads) {
          const binary = atob(payload.base64);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
          }
          transfer.items.add(new File([bytes], payload.name, { type: payload.mimeType || '' }));
        }
        input.files = transfer.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
      Vn,
    );
  } finally {
    let jn = await resolveActionSessionId(xn, qn).catch(() => null);
    jn && (await xn.cdp.send(`Runtime.releaseObject`, { objectId: qn.objectId }, jn).catch(() => {}));
  }
}
async function dragToElement(xn: OmOPage, jn: ElementTarget, Vn: ElementTarget, qn: DragOptions = {}) {
  let Jn = qn.force ? await getPointerDispatchTarget(xn, jn) : await ensurePointerActionable(xn, jn),
    Yn = qn.force ? await getPointerDispatchTarget(xn, Vn) : await ensurePointerActionable(xn, Vn),
    Zn = Jn.sessionId === Yn.sessionId ? Jn.sessionId : await xn.resolveSessionId(),
    Qn = Jn.point,
    ei = Yn.point,
    ti = qn.sourcePosition ? { x: Qn.x + qn.sourcePosition.x, y: Qn.y + qn.sourcePosition.y } : Qn,
    ni = qn.targetPosition ? { x: ei.x + qn.targetPosition.x, y: ei.y + qn.targetPosition.y } : ei;
  if (qn.trial) return;
  let ri = Math.max(qn.steps ?? 1, 1);
  (await xn.cdp.send(
    `Input.dispatchMouseEvent`,
    {
      type: `mouseMoved`,
      x: ti.x,
      y: ti.y,
      button: `none`,
      buttons: 0,
      modifiers: defaultModifierState.toModifiersMask(),
    },
    Zn,
  ),
    await xn.cdp.send(
      `Input.dispatchMouseEvent`,
      {
        type: `mousePressed`,
        x: ti.x,
        y: ti.y,
        button: `left`,
        buttons: 1,
        clickCount: 1,
        modifiers: defaultModifierState.toModifiersMask(),
      },
      Zn,
    ));
  for (let jn = 1; jn <= ri; jn += 1) {
    let Vn = jn / ri;
    await xn.cdp.send(
      `Input.dispatchMouseEvent`,
      {
        type: `mouseMoved`,
        x: ti.x + (ni.x - ti.x) * Vn,
        y: ti.y + (ni.y - ti.y) * Vn,
        button: `left`,
        buttons: 1,
        modifiers: defaultModifierState.toModifiersMask(),
      },
      Zn,
    );
  }
  (await xn.cdp.send(
    `Input.dispatchMouseEvent`,
    {
      type: `mouseReleased`,
      x: ni.x,
      y: ni.y,
      button: `left`,
      buttons: 0,
      clickCount: 1,
      modifiers: defaultModifierState.toModifiersMask(),
    },
    Zn,
  ),
    jn.frameSessionId === Vn.frameSessionId &&
      (await callOnElementSync(
        xn,
        jn,
        `function() {
        const dataTransfer = new DataTransfer();
        globalThis.__omowrightDragDataTransfer = dataTransfer;
        this.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
        this.dispatchEvent(new DragEvent('drag', { bubbles: true, cancelable: true, dataTransfer }));
      }`,
      ).catch(() => {}),
      await callOnElementSync(
        xn,
        Vn,
        `function() {
        const dataTransfer = globalThis.__omowrightDragDataTransfer;
        if (!dataTransfer) {
          return;
        }
        this.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer }));
        this.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
        this.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
      }`,
      ).catch(() => {}),
      await callOnElementSync(
        xn,
        jn,
        `function() {
        const dataTransfer = globalThis.__omowrightDragDataTransfer;
        if (!dataTransfer) {
          return;
        }
        this.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }));
        delete globalThis.__omowrightDragDataTransfer;
      }`,
      ).catch(() => {})));
}
const defaultModifierState = new ModifierState();
const kSetValueInputTypes = [`color`, `date`, `datetime-local`, `month`, `range`, `time`, `week`];
const kTypeIntoInputTypes = [``, `email`, `number`, `password`, `search`, `tel`, `text`, `url`];
const ACTIONABILITY_RETRY_DELAYS_MS = [0, 100, 200];
var init_actions = __esmMin(() => {
  (init_context(), init_utils$13(), init_errors$3(), init_types$4(), init_keyboard(), init_wait());
});
export type PageFunction = string | ((...args: never[]) => unknown);
export interface FrameScope {
  resolveFrameId(): Promise<string>;
  label(): string;
}
export interface TextMatchOptions {
  exact?: boolean;
}
const frame_exports = __exportAll({ OmOFrame: () => OmOFrame, FrameLocator: () => FrameLocator });
const OmOFrame = class xn {
  #e: OmOPage;
  frameId: string;
  constructor(xn: OmOPage, jn: string) {
    ((this.#e = xn), (this.frameId = jn));
  }
  async resolveFrameId() {
    return this.frameId;
  }
  label() {
    let xn = this.#t();
    return `frame ${xn.name || xn.url || xn.frameId}`;
  }
  locator(xn: string, jn: LocatorFilterOptions = {}): Locator {
    return new Locator(this.#e, xn, this).filter(jn);
  }
  getByRole(xn: string, jn: RoleSelectorOptions = {}) {
    return this.locator(Locator.createRoleSelector(xn, jn));
  }
  getByLabel(xn: string | RegExp, jn: TextMatchOptions = {}) {
    if (xn instanceof RegExp) return this.locator(`internal:label=/${xn.source}/${xn.flags}`);
    let Vn = JSON.stringify(xn);
    return this.locator(jn.exact ? `internal:label:exact:${Vn}` : `internal:label:${Vn}`);
  }
  getByText(xn: string | RegExp, jn: TextMatchOptions = {}) {
    if (xn instanceof RegExp) return this.locator(`text:/${xn.source}/${xn.flags}`);
    let Vn = JSON.stringify(xn);
    return this.locator(jn.exact ? `text:exact:${Vn}` : `text:${Vn}`);
  }
  frameLocator(xn: string): FrameLocator {
    return new FrameLocator(this.#e, this, xn);
  }
  async evaluate(xn: PageFunction, jn?: unknown) {
    return await this.#e.evaluateInFrame(this.frameId, xn, jn);
  }
  async $$eval(xn: string, jn: PageFunction, Vn?: unknown) {
    return await this.locator(xn).evaluateAll(jn, Vn);
  }
  url() {
    return this.#t().url;
  }
  name() {
    return this.#t().name;
  }
  parentFrame(): OmOFrame | null {
    let jn = this.#t().parentFrameId;
    return jn ? new xn(this.#e, jn) : null;
  }
  #t() {
    let xn = this.#e.frameManager.getFrame(this.frameId);
    if (!xn) throw Error(`Frame is no longer available: ${this.frameId}`);
    return xn;
  }
};
type OmOFrame = InstanceType<typeof OmOFrame>;
const FrameLocator = class xn {
  #e: OmOPage;
  #t: FrameScope;
  #n: string;
  constructor(xn: OmOPage, jn: FrameScope, Vn: string) {
    ((this.#e = xn), (this.#t = jn), (this.#n = Vn));
  }
  async resolveFrameId() {
    let xn = await this.#t.resolveFrameId(),
      jn = await new OmOFrame(this.#e, xn)
        .locator(this.#n)
        .elementHandle()
        .then((xn) => xn.contentFrame());
    if (!jn) throw Error(`Frame locator "${this.#n}" did not resolve to an iframe`);
    return jn.frameId;
  }
  label() {
    return `frameLocator(${this.#n})`;
  }
  locator(xn: string, jn: LocatorFilterOptions = {}): Locator {
    return new Locator(this.#e, xn, this).filter(jn);
  }
  getByRole(xn: string, jn: RoleSelectorOptions = {}) {
    return this.locator(Locator.createRoleSelector(xn, jn));
  }
  getByLabel(xn: string | RegExp, jn: TextMatchOptions = {}) {
    if (xn instanceof RegExp) return this.locator(`internal:label=/${xn.source}/${xn.flags}`);
    let Vn = JSON.stringify(xn);
    return this.locator(jn.exact ? `internal:label:exact:${Vn}` : `internal:label:${Vn}`);
  }
  getByText(xn: string | RegExp, jn: TextMatchOptions = {}) {
    if (xn instanceof RegExp) return this.locator(`text:/${xn.source}/${xn.flags}`);
    let Vn = JSON.stringify(xn);
    return this.locator(jn.exact ? `text:exact:${Vn}` : `text:${Vn}`);
  }
  frameLocator(jn: string): FrameLocator {
    return new xn(this.#e, this, jn);
  }
  owner() {
    return new Locator(this.#e, this.#n, this.#t);
  }
  first() {
    return this.nth(0);
  }
  nth(jn: number | string): FrameLocator {
    return new xn(this.#e, this.#t, `${this.#n}:nth(${jn})`);
  }
  last(): FrameLocator {
    return new xn(this.#e, this.#t, `${this.#n}:nth(last)`);
  }
};
type FrameLocator = InstanceType<typeof FrameLocator>;
var init_frame = __esmMin(() => {
  init_locator();
});
function isRegExpLike(xn: unknown): xn is RegExp {
  return Object.prototype.toString.call(xn) === `[object RegExp]`;
}
function parseBackendNodeSelector(xn: string) {
  if (!xn.startsWith(BACKEND_NODE_SELECTOR_PREFIX)) return null;
  let jn = xn.slice(25),
    Vn = jn.indexOf(`:`);
  if (Vn <= 0) throw Error(`Invalid backend node selector: ${xn}`);
  let qn = jn.slice(0, Vn),
    Jn = Number(jn.slice(Vn + 1));
  if (!Number.isInteger(Jn) || Jn <= 0) throw Error(`Invalid backend node selector: ${xn}`);
  return { frameId: qn, backendNodeId: Jn };
}
function createBackendNodeLocatorSelector(xn: string, jn: number) {
  return `${BACKEND_NODE_SELECTOR_PREFIX}${xn}:${jn}`;
}
function isLocatorResolutionMiss(xn: unknown) {
  return xn instanceof RefStaleError
    ? !0
    : xn instanceof Error
      ? xn.message.startsWith(`Selector "`) || xn.message.startsWith(`Role selector not found: `)
      : !1;
}
export interface RoleSelectorOptions {
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  includeHidden?: boolean;
  level?: number;
  pressed?: boolean;
  selected?: boolean;
  name?: string | RegExp;
  exact?: boolean;
}
export interface LocatorFilterOptions {
  hasText?: string | RegExp;
}
interface RoleQuery {
  role: string;
  nth: number | `last`;
  regexSource?: string;
  regexFlags?: string;
  name?: string;
  exact?: boolean;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  includeHidden?: boolean;
  level?: number;
  pressed?: boolean;
  selected?: boolean;
}
export type LocatorWaitState = `attached` | `detached` | `visible` | `hidden`;
export interface InputFilePayload {
  name: string;
  mimeType?: string;
  buffer: Uint8Array;
}
export type InputFiles = string | string[] | InputFilePayload[];
export interface LocatorScreenshotOptions {
  margin?: number;
  path?: string;
  quality?: number;
  timeout?: number;
  type?: ScreenshotType;
}
function isStringList(xn: string[] | InputFilePayload[]): xn is string[] {
  return typeof xn[0] == `string`;
}
const REF_PATTERN = /^(f\d+)?e\d+$/;
const REF_SELECTOR_ALIAS_PATTERN = /^\[ref=((?:f\d+)?e\d+)\]$/;
const BACKEND_NODE_SELECTOR_PREFIX = `internal:backend-node-id:`;
const DEFAULT_SCREENSHOT_MARGIN = 8;
const DEFAULT_LOCATOR_WAIT_TIMEOUT_MS = 3e3;
const LOCATOR_WAIT_POLL_INTERVALS = [0, 20, 50, 100, 100, 500];
const LOCATOR_WAIT_STATES = new Set<string>([`attached`, `detached`, `visible`, `hidden`]);
const NTH_SELECTOR_PATTERN = /:nth\((\d+|last)\)$/;
const isRef = (xn: string) => /^(f\d+)?e\d+$/.test(xn);
const isRoleSelector = (xn: string) => xn.startsWith(`role:`);
const isTextSelector = (xn: string) => xn.startsWith(`text:`);
const Locator = class xn {
  #e: OmOPage;
  #t: string;
  #n: FrameScope | undefined;
  constructor(xn: OmOPage, jn: string, Vn?: FrameScope) {
    if (typeof jn != `string` || jn.trim().length === 0)
      throw Error(`Locator selector must be a non-empty string. Take a fresh snapshot and verify the ref exists.`);
    ((this.#e = xn), (this.#n = Vn));
    let qn = jn.trim();
    this.#t = qn.replace(REF_SELECTOR_ALIAS_PATTERN, `$1`);
  }
  static createRoleSelector(xn: string, jn: RoleSelectorOptions = {}) {
    let Vn = `role:${xn}`,
      qn = (xn: string, jn: string) => {
        Vn += `[${xn}=${jn}]`;
      };
    if (
      (jn.checked !== void 0 && qn(`checked`, String(jn.checked)),
      jn.disabled !== void 0 && qn(`disabled`, String(jn.disabled)),
      jn.expanded !== void 0 && qn(`expanded`, String(jn.expanded)),
      jn.includeHidden !== void 0 && qn(`include-hidden`, String(jn.includeHidden)),
      jn.level !== void 0 && qn(`level`, String(jn.level)),
      jn.pressed !== void 0 && qn(`pressed`, String(jn.pressed)),
      jn.selected !== void 0 && qn(`selected`, String(jn.selected)),
      jn.name !== void 0)
    ) {
      let xn = jn.name;
      if (isRegExpLike(xn)) {
        let jn = xn;
        (qn(`name-regex`, encodeURIComponent(jn.source)),
          jn.flags && qn(`name-regex-flags`, encodeURIComponent(jn.flags)));
      } else qn(jn.exact ? `name` : `name*`, encodeURIComponent(String(xn)));
    }
    return Vn;
  }
  async #r(): Promise<ElementTarget> {
    let xn = parseBackendNodeSelector(this.#t);
    return xn
      ? await this.#o(xn)
      : isRef(this.#t)
        ? await this.#a(this.#t)
        : isRoleSelector(this.#t)
          ? await this.#l(this.#t)
          : await this.#c(this.#t);
  }
  async #i(xn: string) {
    try {
      let jn = await this.#r();
      if (xn === `attached`) return !0;
      if (xn === `detached`) return !1;
      let Vn = await isVisibleElement(this.#e, jn);
      return xn === `visible` ? Vn : !Vn;
    } catch (jn) {
      if (!isLocatorResolutionMiss(jn)) throw jn;
      return xn === `detached` || xn === `hidden`;
    }
  }
  async click(xn?: ClickOptions) {
    let jn = await this.#r();
    await clickElement(this.#e, jn, xn, this.#e.modifierState);
  }
  async fill(xn: string) {
    let jn = await this.#r();
    await fillElement(this.#e, jn, xn);
  }
  async selectOption(xn: unknown) {
    let jn = await this.#r();
    return await selectOptionElement(this.#e, jn, xn);
  }
  async check(xn?: { checked?: boolean }) {
    let jn = await this.#r();
    await checkElement(this.#e, jn, xn?.checked);
  }
  async scrollIntoViewIfNeeded() {
    let xn = await this.#r();
    await scrollIntoViewElement(this.#e, xn);
  }
  async press(xn: string) {
    let jn = await this.#r();
    await pressElement(this.#e, jn, xn, this.#e.keyboard);
  }
  async pressSequentially(xn: string, jn: { delay?: number } = {}) {
    let Vn = await this.#r();
    await pressSequentiallyElement(this.#e, Vn, xn, jn.delay, this.#e.keyboard);
  }
  async hover() {
    let xn = await this.#r();
    await hoverElement(this.#e, xn);
  }
  async dblclick(xn?: ClickOptions) {
    let jn = await this.#r();
    await clickElement(this.#e, jn, { ...xn, dblClick: !0 }, this.#e.modifierState);
  }
  async focus() {
    let xn = await this.#r();
    await focusResolvedElement(this.#e, xn);
  }
  async blur() {
    let xn = await this.#r();
    await blurResolvedElement(this.#e, xn);
  }
  async tap() {
    let xn = await this.#r();
    await tapElement(this.#e, xn);
  }
  async clear() {
    await this.fill(``);
  }
  async type(xn: string, jn: { delay?: number } = {}) {
    await this.pressSequentially(xn, jn);
  }
  async uncheck() {
    let xn = await this.#r();
    await checkElement(this.#e, xn, !1);
  }
  async setChecked(xn: boolean) {
    if (xn) {
      await this.check();
      return;
    }
    await this.uncheck();
  }
  async setInputFiles(xn: InputFiles | null) {
    let jn = await this.#r();
    if (xn === null) {
      await setInputFilesElement(this.#e, jn, []);
      return;
    }
    if (typeof xn == `string`) {
      let Vn = await this.#e.browser.ensurePath(xn, `read`, `locator.setInputFiles`);
      await setInputFilesElement(this.#e, jn, [Vn]);
      return;
    }
    if (xn.length === 0) {
      await setInputFilesElement(this.#e, jn, []);
      return;
    }
    if (isStringList(xn)) {
      let Vn = await Promise.all(xn.map((xn) => this.#e.browser.ensurePath(xn, `read`, `locator.setInputFiles`)));
      await setInputFilesElement(this.#e, jn, Vn);
      return;
    }
    await setInputFilesElement(
      this.#e,
      jn,
      xn.map((xn) => ({
        name: xn.name,
        mimeType: xn.mimeType,
        base64: Buffer.from(xn.buffer).toString(`base64`),
      })),
    );
  }
  async dragTo(xn: Locator, jn: DragOptions = {}) {
    let Vn = await this.#r(),
      qn = await xn.#r();
    await dragToElement(this.#e, Vn, qn, jn);
  }
  async evaluate(xn: PageFunction, jn?: unknown) {
    let Vn = await this.#r(),
      qn = typeof xn == `function` ? xn.toString() : xn;
    return await evaluateOnElement(this.#e, Vn, qn, jn);
  }
  async evaluateAll(xn: PageFunction, jn?: unknown) {
    if (isRoleSelector(this.#t))
      throw Error(`locator.evaluateAll() does not support role selectors yet; use a CSS selector.`);
    let Vn = isRef(this.#t) || parseBackendNodeSelector(this.#t) ? [this] : await this.all(),
      qn = await Promise.all(Vn.map((xn) => xn.#r())),
      Jn = qn[0] ?? (await this.#s());
    if (qn.some((xn) => xn.contextId !== Jn.contextId))
      throw Error(`locator.evaluateAll() cannot pass elements from multiple frames to one page function.`);
    let Yn = typeof xn == `function` ? xn.toString() : xn,
      Zn = [{ value: jn }, ...qn.map((xn) => ({ objectId: xn.objectId }))],
      { result: Qn, exceptionDetails: ei } = await this.#e.cdp.send(
        `Runtime.callFunctionOn`,
        {
          functionDeclaration: `async function(arg, ...elements) {
        var __name = (target) => target;
        const pageFunction = (${Yn});
        if (typeof pageFunction !== 'function') {
          throw new Error('$$eval pageFunction must evaluate to a function');
        }
        return await pageFunction(elements, arg);
      }`,
          arguments: Zn,
          executionContextId: Jn.contextId,
          returnByValue: !0,
          awaitPromise: !0,
          userGesture: !1,
        },
        await this.#e.resolveSessionId(Jn.frameSessionId),
      );
    if (ei) throw Error(formatRuntimeException(ei, `$$eval failed`));
    return Qn.value;
  }
  async boundingBox() {
    let xn = await this.#r();
    return await boundingBoxElement(this.#e, xn);
  }
  async screenshot(xn: LocatorScreenshotOptions = {}) {
    let jn = xn.margin ?? DEFAULT_SCREENSHOT_MARGIN;
    if (!Number.isFinite(jn) || jn < 0) throw Error(`locator.screenshot: margin must be a non-negative number`);
    let Vn = await this.#r(),
      qn = await evaluateOnElement<ScreenshotClip | null>(
        this.#e,
        Vn,
        `function(margin) {
        const rect = this.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          return null;
        }

        const left = Math.max(0, rect.left - margin);
        const top = Math.max(0, rect.top - margin);
        const right = Math.min(window.innerWidth, rect.right + margin);
        const bottom = Math.min(window.innerHeight, rect.bottom + margin);
        const width = right - left;
        const height = bottom - top;
        if (width <= 0 || height <= 0) {
          return null;
        }

        return {
          x: left,
          y: top,
          width,
          height,
        };
      }`,
        jn,
      );
    if (!qn) throw Error(`locator.screenshot: element is not visible in the viewport`);
    let { path: Jn, quality: Yn, timeout: Zn, type: Qn = `webp` } = xn;
    return await this.#e.screenshot({ path: Jn, quality: Yn, timeout: Zn, type: Qn, clip: qn });
  }
  async isChecked() {
    let xn = await this.#r();
    return await isCheckedElement(this.#e, xn);
  }
  async inputValue() {
    let xn = await this.#r();
    return await inputValueElement(this.#e, xn);
  }
  async innerHTML() {
    let xn = await this.#r();
    return await innerHTMLElement(this.#e, xn);
  }
  async innerText() {
    let xn = await this.#r();
    return await innerTextElement(this.#e, xn);
  }
  async textContent() {
    let xn = await this.#r();
    return await textContentElement(this.#e, xn);
  }
  async elementHandle() {
    return new ElementHandle(this.#e, await this.#r());
  }
  async count() {
    if (isRef(this.#t))
      try {
        return (await this.#a(this.#t), 1);
      } catch (xn) {
        if (xn instanceof RefStaleError) return 0;
        throw xn;
      }
    if (isRoleSelector(this.#t)) {
      let xn = NTH_SELECTOR_PATTERN.test(this.#t),
        { nth: jn, ...Vn } = this.#p(this.#t),
        qn = await this.#d(),
        Jn = 0;
      for (let { frameId: xn } of qn) {
        let jn = this.#e.frameManager.getFrame(xn);
        jn?.isolatedContextId &&
          (Jn += await this.#m(await this.#e.resolveSessionId(jn.sessionId), jn.isolatedContextId, Vn));
      }
      return xn ? +(Jn > 0 && (jn === `last` || jn < Jn)) : Jn;
    }
    let xn = NTH_SELECTOR_PATTERN.test(this.#t),
      jn = this.#f(this.#t),
      Vn = await this.#u();
    return await this.#e.evaluateInFrame<number>(
      Vn,
      `function(query) {
        const normalizeText = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
        const parseTextMatcher = (raw) => {
          if (!raw) return null;
          if (raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
            const lastSlash = raw.lastIndexOf('/');
            return new RegExp(raw.slice(1, lastSlash), raw.slice(lastSlash + 1));
          }
          const parseLiteral = (value) => {
            try {
              return JSON.parse(value);
            } catch {
              return value;
            }
          };
          if (raw.startsWith('exact:')) {
            return { exact: parseLiteral(raw.slice(6)) };
          }
          return { contains: parseLiteral(raw) };
        };
        const matchesText = (node, matcher) => {
          const text = normalizeText(node.textContent);
          if (matcher instanceof RegExp) return matcher.test(text);
          if ('exact' in matcher) return text === matcher.exact;
          return text.includes(matcher.contains);
        };
        const splitSteps = (value) => value.split(/\\s*>>\\s*/).map((step) => step.trim()).filter(Boolean);
        const parseStep = (rawStep) => {
          const nthMatch = rawStep.match(/^(.*):nth\\((\\d+|last)\\)$/s);
          const rawBase = nthMatch ? (nthMatch[1] || '').trim() || '*' : rawStep;
          const nth = nthMatch ? nthMatch[2] === 'last' ? 'last' : Number.parseInt(nthMatch[2], 10) : null;
          const hasTextMatch = rawBase.match(/^(.*):has-text\\((.*)\\)$/s);
          const base = hasTextMatch ? (hasTextMatch[1] || '').trim() || '*' : rawBase;
          const hasText = hasTextMatch ? parseTextMatcher((hasTextMatch[2] || '').trim()) : null;
          if (base.startsWith('text:')) {
            return {
              kind: 'text',
              matcher: parseTextMatcher(base.slice(5)),
              hasText,
              nth,
            };
          }
          if (base.startsWith('internal:label:')) {
            return {
              kind: 'label',
              matcher: parseTextMatcher(base.slice(15)),
              hasText,
              nth,
            };
          }
          return {
            kind: 'css',
            selector: base,
            hasText,
            nth,
          };
        };
        const descendants = (root) => Array.from((root instanceof Document ? root : root).querySelectorAll('*'));
        const textMatches = (root, matcher) => {
          const matches = descendants(root).filter((node) => matcher && matchesText(node, matcher));
          return matches.filter((node) => !Array.from(node.children).some((child) => matchesText(child, matcher)));
        };
        // Some sites duplicate the same visible label onto hidden or zero-sized inputs.
        // Prefer the actionable associated control so getByLabel() doesn't latch onto
        // an inert duplicate and fail later in the actionability pipeline.
        const labelMatches = (root, matcher) => {
          const labels = Array.from((root instanceof Document ? root : root).querySelectorAll('label'))
            .filter((label) => matcher && matchesText(label, matcher));
          const controlSelector = 'input:not([type="hidden"]), textarea, select';
          const seen = new Set();
          const controls = [];
          for (const label of labels) {
            const explicitControl = label.control || (label.htmlFor ? document.getElementById(label.htmlFor) : null);
            // Virginia DMV's Bootstrap form uses a label with no htmlFor, followed
            // immediately by its input in the same row.
            const siblingControl = label.nextElementSibling?.matches?.(controlSelector) ? label.nextElementSibling : null;
            const control = explicitControl || siblingControl;
            if (!control || seen.has(control)) continue;
            seen.add(control);
            controls.push(control);
          }
          controls.sort((a, b) => {
            const rank = (node) => {
              let score = 0;
              if (node.isConnected) score += 100;
              const style = node.ownerDocument?.defaultView?.getComputedStyle?.(node);
              if (style && style.display !== 'none' && style.visibility !== 'hidden') {
                score += 10;
              }
              const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
              if (rect && rect.width > 0 && rect.height > 0) {
                score += 1;
              }
              return score;
            };
            return rank(b) - rank(a);
          });
          return controls;
        };
        const queryAll = (value) => {
          const steps = splitSteps(value);
          let roots = [document];
          for (const rawStep of steps) {
            const step = parseStep(rawStep);
            const next = [];
            const seen = new Set();
            for (const root of roots) {
              let matches = step.kind === 'text'
                ? textMatches(root, step.matcher)
                : step.kind === 'label'
                  ? labelMatches(root, step.matcher)
                  : Array.from((root instanceof Document ? root : root).querySelectorAll(step.selector));
              if (step.hasText) {
                matches = matches.filter((node) => matchesText(node, step.hasText));
              }
              if (step.nth !== null) {
                const index = step.nth === 'last' ? matches.length - 1 : step.nth;
                matches = matches[index] ? [matches[index]] : [];
              }
              for (const node of matches) {
                if (seen.has(node)) continue;
                seen.add(node);
                next.push(node);
              }
            }
            roots = next;
          }
          return roots;
        };
        const nodes = queryAll(query.selector);
        const index = query.nth === 'last' ? nodes.length - 1 : query.nth;
        return query.hasNth ? (nodes[index] ? 1 : 0) : nodes.length;
      }`,
      { selector: jn.selector, nth: jn.nth, hasNth: xn },
    );
  }
  async getAttribute(xn: string) {
    let jn = await this.#r();
    return await getAttributeElement(this.#e, jn, xn);
  }
  async isDisabled() {
    let xn = await this.#r();
    return await isDisabledElement(this.#e, xn);
  }
  async isEditable() {
    let xn = await this.#r();
    return await isEditableElement(this.#e, xn);
  }
  async isEnabled() {
    let xn = await this.#r();
    return await isEnabledElement(this.#e, xn);
  }
  async isHidden() {
    let xn = await this.#r();
    return await isHiddenElement(this.#e, xn);
  }
  async isVisible() {
    let xn = await this.#r();
    return await isVisibleElement(this.#e, xn);
  }
  async dispatchEvent(xn: string, jn?: unknown) {
    let Vn = await this.#r();
    await dispatchEventElement(this.#e, Vn, xn, jn);
  }
  async waitFor(xn: { state?: LocatorWaitState; timeout?: number } = {}) {
    let jn = xn.state ?? `visible`;
    if (!LOCATOR_WAIT_STATES.has(jn)) throw Error(`locator.waitFor: invalid state "${jn}"`);
    let Vn = xn.timeout ?? DEFAULT_LOCATOR_WAIT_TIMEOUT_MS;
    if (!Number.isFinite(Vn) || Vn < 0) throw Error(`locator.waitFor: timeout must be a non-negative number`);
    let qn = Date.now(),
      Jn = 0;
    for (;;) {
      if (await this.#i(jn)) return;
      if (Date.now() - qn >= Vn)
        throw Error(`locator.waitFor: timed out after ${Vn}ms waiting for ${this} to be ${jn}`);
      await sleep$12(LOCATOR_WAIT_POLL_INTERVALS[Math.min(Jn++, LOCATOR_WAIT_POLL_INTERVALS.length - 1)] ?? 0);
    }
  }
  first(): Locator {
    return new xn(this.#e, `${this.#t}:nth(0)`, this.#n);
  }
  nth(jn: number): Locator {
    return new xn(this.#e, `${this.#t}:nth(${jn})`, this.#n);
  }
  last(): Locator {
    return isRef(this.#t) || parseBackendNodeSelector(this.#t)
      ? new xn(this.#e, this.#t, this.#n)
      : new xn(this.#e, `${this.#t}:nth(last)`, this.#n);
  }
  locator(jn: string, Vn: LocatorFilterOptions = {}): Locator {
    return new xn(this.#e, `${this.#t} >> ${jn}`, this.#n).filter(Vn);
  }
  filter(jn: LocatorFilterOptions): Locator {
    let Vn = this.#t;
    if (jn.hasText !== void 0) {
      let xn = isRegExpLike(jn.hasText) ? `/${jn.hasText.source}/${jn.hasText.flags}` : JSON.stringify(jn.hasText);
      Vn += `:has-text(${xn})`;
    }
    return new xn(this.#e, Vn, this.#n);
  }
  async all(): Promise<Locator[]> {
    if (isRef(this.#t) || isRoleSelector(this.#t) || isTextSelector(this.#t) || parseBackendNodeSelector(this.#t))
      return [this];
    let xn = await this.#u(),
      jn = await this.#e.evaluateInFrame<number>(
        xn,
        `function(selector) {
        const normalizeText = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
        const parseTextMatcher = (raw) => {
          if (!raw) return null;
          if (raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
            const lastSlash = raw.lastIndexOf('/');
            return new RegExp(raw.slice(1, lastSlash), raw.slice(lastSlash + 1));
          }
          const parseLiteral = (value) => {
            try {
              return JSON.parse(value);
            } catch {
              return value;
            }
          };
          if (raw.startsWith('exact:')) {
            return { exact: parseLiteral(raw.slice(6)) };
          }
          return { contains: parseLiteral(raw) };
        };
        const matchesText = (node, matcher) => {
          const text = normalizeText(node.textContent);
          if (matcher instanceof RegExp) return matcher.test(text);
          if ('exact' in matcher) return text === matcher.exact;
          return text.includes(matcher.contains);
        };
        const splitSteps = (value) => value.split(/\\s*>>\\s*/).map((step) => step.trim()).filter(Boolean);
        const parseStep = (rawStep) => {
          const nthMatch = rawStep.match(/^(.*):nth\\((\\d+|last)\\)$/s);
          const rawBase = nthMatch ? (nthMatch[1] || '').trim() || '*' : rawStep;
          const nth = nthMatch ? nthMatch[2] === 'last' ? 'last' : Number.parseInt(nthMatch[2], 10) : null;
          const hasTextMatch = rawBase.match(/^(.*):has-text\\((.*)\\)$/s);
          const base = hasTextMatch ? (hasTextMatch[1] || '').trim() || '*' : rawBase;
          const hasText = hasTextMatch ? parseTextMatcher((hasTextMatch[2] || '').trim()) : null;
          if (base.startsWith('text:')) {
            return {
              kind: 'text',
              matcher: parseTextMatcher(base.slice(5)),
              hasText,
              nth,
            };
          }
          if (base.startsWith('internal:label:')) {
            return {
              kind: 'label',
              matcher: parseTextMatcher(base.slice(15)),
              hasText,
              nth,
            };
          }
          return {
            kind: 'css',
            selector: base,
            hasText,
            nth,
          };
        };
        const descendants = (root) => Array.from((root instanceof Document ? root : root).querySelectorAll('*'));
        const textMatches = (root, matcher) => {
          const matches = descendants(root).filter((node) => matcher && matchesText(node, matcher));
          return matches.filter((node) => !Array.from(node.children).some((child) => matchesText(child, matcher)));
        };
        // Keep label-based locators resilient when one label name points at both
        // hidden template inputs and the visible live control.
        const labelMatches = (root, matcher) => {
          const labels = Array.from((root instanceof Document ? root : root).querySelectorAll('label'))
            .filter((label) => matcher && matchesText(label, matcher));
          const controlSelector = 'input:not([type="hidden"]), textarea, select';
          const seen = new Set();
          const controls = [];
          for (const label of labels) {
            const explicitControl = label.control || (label.htmlFor ? document.getElementById(label.htmlFor) : null);
            // Virginia DMV's Bootstrap form uses a label with no htmlFor, followed
            // immediately by its input in the same row.
            const siblingControl = label.nextElementSibling?.matches?.(controlSelector) ? label.nextElementSibling : null;
            const control = explicitControl || siblingControl;
            if (!control || seen.has(control)) continue;
            seen.add(control);
            controls.push(control);
          }
          controls.sort((a, b) => {
            const rank = (node) => {
              let score = 0;
              if (node.isConnected) score += 100;
              const style = node.ownerDocument?.defaultView?.getComputedStyle?.(node);
              if (style && style.display !== 'none' && style.visibility !== 'hidden') {
                score += 10;
              }
              const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
              if (rect && rect.width > 0 && rect.height > 0) {
                score += 1;
              }
              return score;
            };
            return rank(b) - rank(a);
          });
          return controls;
        };
        const queryAll = (value) => {
          const steps = splitSteps(value);
          let roots = [document];
          for (const rawStep of steps) {
            const step = parseStep(rawStep);
            const next = [];
            const seen = new Set();
            for (const root of roots) {
              let matches = step.kind === 'text'
                ? textMatches(root, step.matcher)
                : step.kind === 'label'
                  ? labelMatches(root, step.matcher)
                  : Array.from((root instanceof Document ? root : root).querySelectorAll(step.selector));
              if (step.hasText) {
                matches = matches.filter((node) => matchesText(node, step.hasText));
              }
              if (step.nth !== null) {
                const index = step.nth === 'last' ? matches.length - 1 : step.nth;
                matches = matches[index] ? [matches[index]] : [];
              }
              for (const node of matches) {
                if (seen.has(node)) continue;
                seen.add(node);
                next.push(node);
              }
            }
            roots = next;
          }
          return roots;
        };
        return queryAll(selector).length;
      }`,
        this.#t,
      );
    return Array.from({ length: jn }, (xn, jn) => this.nth(jn));
  }
  toString() {
    return `Locator@${this.#t}`;
  }
  async #a(xn: string): Promise<ElementTarget> {
    if (this.#n)
      throw Error(`Snapshot refs already include frame identity; use page.locator(ref) instead of frame.locator(ref).`);
    let jn = xn.match(REF_PATTERN);
    if (!jn) throw Error(`Invalid ref format: ${xn}`);
    let Vn = jn[1] ?? ``,
      qn = this.#e.frameManager.resolveFrameIdForSnapshotPrefix(Vn);
    if (!qn) throw new RefStaleError(xn);
    let Jn = Vn ? 3 : 1;
    for (let jn = 0; jn < Jn; jn++) {
      jn > 0 && (await new Promise((xn) => setTimeout(xn, 50 * jn)));
      let Vn = this.#e.frameManager.getFrame(qn);
      if (!Vn || (!Vn.isolatedContextId && (await this.#e.frameManager.ensureInjected(qn), !Vn.isolatedContextId)))
        throw new RefStaleError(xn);
      try {
        let { result: jn } = await this.#e.cdp.send(
          `Runtime.callFunctionOn`,
          {
            functionDeclaration: `function(refId) { return globalThis.__omowright?.deref(refId) ?? null; }`,
            arguments: [{ value: xn }],
            executionContextId: Vn.isolatedContextId,
            returnByValue: !1,
            awaitPromise: !1,
            userGesture: !1,
          },
          await this.#e.resolveSessionId(Vn.sessionId),
        );
        if (jn.objectId)
          return {
            objectId: jn.objectId,
            frameId: qn,
            frameSessionId: Vn.sessionId,
            contextId: Vn.isolatedContextId,
          };
      } catch {
        this.#e.frameManager.invalidateContext(qn);
      }
    }
    throw new RefStaleError(xn);
  }
  async #o(xn: { frameId: string; backendNodeId: number }): Promise<ElementTarget> {
    let jn = this.#e.frameManager.getFrame(xn.frameId),
      Vn = await this.#e.frameManager.ensureInjected(xn.frameId);
    if (!jn || !Vn) throw Error(`File chooser element is no longer available`);
    let qn = await this.#e.resolveSessionId(jn.sessionId),
      { object: Jn } = await this.#e.cdp.send(
        `DOM.resolveNode`,
        { backendNodeId: xn.backendNodeId, executionContextId: Vn },
        qn,
      );
    if (!Jn.objectId) throw Error(`File chooser element is no longer available`);
    return { objectId: Jn.objectId, frameId: xn.frameId, frameSessionId: jn.sessionId, contextId: Vn };
  }
  async #s() {
    let xn = await this.#u(),
      jn = this.#e.frameManager.getFrame(xn),
      Vn = await this.#e.frameManager.ensureInjected(xn);
    if (!jn || !Vn) throw Error(`${this.#n?.label() ?? `Main frame`} isolated world is not ready`);
    return { contextId: Vn, frameSessionId: jn.sessionId };
  }
  async #c(xn: string): Promise<ElementTarget> {
    let jn = await this.#u(),
      Vn = this.#e.frameManager.getFrame(jn),
      qn = await this.#e.frameManager.ensureInjected(jn);
    if (!Vn || !qn) throw Error(`${this.#n?.label() ?? `Main frame`} isolated world is not ready`);
    let Jn = this.#f(xn),
      { result: Yn } = await this.#e.cdp.send(
        `Runtime.callFunctionOn`,
        {
          functionDeclaration: `function(query) {
        const normalizeText = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
        const parseTextMatcher = (raw) => {
          if (!raw) return null;
          if (raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
            const lastSlash = raw.lastIndexOf('/');
            return new RegExp(raw.slice(1, lastSlash), raw.slice(lastSlash + 1));
          }
          const parseLiteral = (value) => {
            try {
              return JSON.parse(value);
            } catch {
              return value;
            }
          };
          if (raw.startsWith('exact:')) {
            return { exact: parseLiteral(raw.slice(6)) };
          }
          return { contains: parseLiteral(raw) };
        };
        const matchesText = (node, matcher, useInnerText = false) => {
          const text = normalizeText(useInnerText ? node.innerText : node.textContent);
          if (matcher instanceof RegExp) return matcher.test(text);
          if ('exact' in matcher) return text === matcher.exact;
          return text.includes(matcher.contains);
        };
        const splitSteps = (selector) => selector.split(/\\s*>>\\s*/).map((step) => step.trim()).filter(Boolean);
        const parseStep = (rawStep) => {
          const nthMatch = rawStep.match(/^(.*):nth\\((\\d+|last)\\)$/s);
          const rawBase = nthMatch ? (nthMatch[1] || '').trim() || '*' : rawStep;
          const nth = nthMatch ? nthMatch[2] === 'last' ? 'last' : Number.parseInt(nthMatch[2], 10) : null;
          const hasTextMatch = rawBase.match(/^(.*):has-text\\((.*)\\)$/s);
          const base = hasTextMatch ? (hasTextMatch[1] || '').trim() || '*' : rawBase;
          const hasText = hasTextMatch ? parseTextMatcher((hasTextMatch[2] || '').trim()) : null;
          if (base.startsWith('text:')) {
            return {
              kind: 'text',
              matcher: parseTextMatcher(base.slice(5)),
              hasText,
              nth,
            };
          }
          if (base.startsWith('internal:label:')) {
            return {
              kind: 'label',
              matcher: parseTextMatcher(base.slice(15)),
              hasText,
              nth,
            };
          }
          return {
            kind: 'css',
            selector: base,
            hasText,
            nth,
          };
        };
        const descendants = (root) => Array.from((root instanceof Document ? root : root).querySelectorAll('*'));
        const textMatches = (root, matcher) => {
          const matches = descendants(root).filter((node) => matcher && matchesText(node, matcher));
          // Text selectors should resolve to the innermost visible text element,
          // not broad ancestors like <body>; click actionability depends on that.
          return matches.filter((node) => !Array.from(node.children).some((child) => matchesText(child, matcher)));
        };
        // Keep label selectors aligned with what a human can actually click when
        // pages duplicate label text across hidden template controls.
        const labelMatches = (root, matcher) => {
          const labels = Array.from((root instanceof Document ? root : root).querySelectorAll('label'))
            .filter((label) => matcher && matchesText(label, matcher));
          const controlSelector = 'input:not([type="hidden"]), textarea, select';
          const seen = new Set();
          const controls = [];
          for (const label of labels) {
            const explicitControl = label.control || (label.htmlFor ? document.getElementById(label.htmlFor) : null);
            // Virginia DMV's Bootstrap form uses a label with no htmlFor, followed
            // immediately by its input in the same row.
            const siblingControl = label.nextElementSibling?.matches?.(controlSelector) ? label.nextElementSibling : null;
            const control = explicitControl || siblingControl;
            if (!control || seen.has(control)) continue;
            seen.add(control);
            controls.push(control);
          }
          controls.sort((a, b) => {
            const rank = (node) => {
              let score = 0;
              if (node.isConnected) score += 100;
              const style = node.ownerDocument?.defaultView?.getComputedStyle?.(node);
              if (style && style.display !== 'none' && style.visibility !== 'hidden') {
                score += 10;
              }
              const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
              if (rect && rect.width > 0 && rect.height > 0) {
                score += 1;
              }
              return score;
            };
            return rank(b) - rank(a);
          });
          return controls;
        };
        const queryAll = (selector) => {
          const steps = splitSteps(selector);
          let roots = [document];
          for (const rawStep of steps) {
            const step = parseStep(rawStep);
            const next = [];
            const seen = new Set();
            for (const root of roots) {
              let matches = step.kind === 'text'
                ? textMatches(root, step.matcher)
                : step.kind === 'label'
                  ? labelMatches(root, step.matcher)
                  : Array.from((root instanceof Document ? root : root).querySelectorAll(step.selector));
              if (step.hasText) {
                matches = matches.filter((node) => matchesText(node, step.hasText));
              }
              if (step.nth !== null) {
                const index = step.nth === 'last' ? matches.length - 1 : step.nth;
                matches = matches[index] ? [matches[index]] : [];
              }
              for (const node of matches) {
                if (seen.has(node)) continue;
                seen.add(node);
                next.push(node);
              }
            }
            roots = next;
          }
          return roots;
        };
        const nodes = queryAll(query.selector);
        const index = query.nth === 'last' ? nodes.length - 1 : query.nth;
        return nodes[index] ?? null;
      }`,
          arguments: [{ value: Jn }],
          executionContextId: qn,
          returnByValue: !1,
          awaitPromise: !1,
          userGesture: !1,
        },
        await this.#e.resolveSessionId(Vn.sessionId),
      );
    if (!Yn.objectId) throw Error(`Selector "${xn}" not found`);
    return { objectId: Yn.objectId, frameId: jn, frameSessionId: Vn.sessionId, contextId: qn };
  }
  async #l(xn: string): Promise<ElementTarget> {
    let jn = this.#p(xn),
      Vn = await this.#d(),
      { nth: qn, ...Jn } = jn,
      Yn: number;
    if (qn === `last`) {
      Yn = 0;
      for (let { frameId: xn } of Vn) {
        let jn = this.#e.frameManager.getFrame(xn);
        jn?.isolatedContextId &&
          (Yn += await this.#m(await this.#e.resolveSessionId(jn.sessionId), jn.isolatedContextId, Jn));
      }
      --Yn;
    } else Yn = qn;
    if (Yn < 0) throw Error(`Role selector not found: ${xn}`);
    for (let { frameId: xn } of Vn) {
      let Vn = this.#e.frameManager.getFrame(xn);
      if (!Vn?.isolatedContextId) continue;
      let qn = await this.#e.resolveSessionId(Vn.sessionId),
        Zn = await this.#m(qn, Vn.isolatedContextId, Jn);
      if (Zn <= 0) continue;
      if (Yn >= Zn) {
        Yn -= Zn;
        continue;
      }
      let { result: Qn } = await this.#e.cdp.send(
        `Runtime.callFunctionOn`,
        {
          functionDeclaration: `function(query) {
              const normalizeText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
              const getRole = (node) => {
                const explicit = node.getAttribute?.('role');
                if (explicit) {
                  return explicit.split(/\\s+/)[0] || 'generic';
                }

                const tag = String(node.tagName || '').toLowerCase();
                if (tag === 'input') {
                  const type = String(node.getAttribute?.('type') || '').toLowerCase();
                  if (type === 'checkbox') return 'checkbox';
                  if (type === 'radio') return 'radio';
                  if (type === 'range') return 'slider';
                  if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
                  return 'textbox';
                }
                if (tag === 'button') return 'button';
                if (tag === 'a' && node.hasAttribute?.('href')) return 'link';
                if (tag === 'select') return node.multiple || node.size > 1 ? 'listbox' : 'combobox';
                if (tag === 'textarea') return 'textbox';
                if (tag === 'img') return 'img';
                if (tag === 'option') return 'option';
                if (tag === 'summary') return 'button';
                return 'generic';
              };

              const getAccessibleName = (node) => {
                const ariaLabel = normalizeText(node.getAttribute?.('aria-label'));
                if (ariaLabel) return ariaLabel;

                const labelledBy = normalizeText(node.getAttribute?.('aria-labelledby'));
                if (labelledBy) {
                  const labelText = labelledBy
                    .split(/\\s+/)
                    .map((id) => normalizeText(node.ownerDocument?.getElementById(id)?.textContent))
                    .filter(Boolean)
                    .join(' ');
                  if (labelText) return labelText;
                }

                if (typeof node.labels?.length === 'number' && node.labels.length > 0) {
                  const labelText = Array.from(node.labels)
                    .map((label) => normalizeText(label.textContent))
                    .filter(Boolean)
                    .join(' ');
                  if (labelText) return labelText;
                }

                const title = normalizeText(node.getAttribute?.('title'));
                if (title) return title;

                const alt = normalizeText(node.getAttribute?.('alt'));
                if (alt) return alt;

                const placeholder = normalizeText(node.getAttribute?.('placeholder'));
                if (placeholder) return placeholder;

                const value = normalizeText(node.value);
                if (value) return value;

                return normalizeText(node.textContent).slice(0, 100);
              };

              const isHidden = (node) => {
                if (!node.isConnected) return true;
                if (node.getAttribute?.('hidden') !== null) return true;
                if (node.getAttribute?.('aria-hidden') === 'true') return true;
                const style = node.ownerDocument?.defaultView?.getComputedStyle?.(node);
                if (!style) return false;
                return style.display === 'none' || style.visibility === 'hidden';
              };

              const getAriaBoolean = (value) => {
                if (value === 'true') return true;
                if (value === 'false') return false;
                return null;
              };

              const getDisabled = (node) => {
                if ('disabled' in node && typeof node.disabled === 'boolean') {
                  return node.disabled;
                }
                let current = node;
                while (current) {
                  if (current.getAttribute?.('aria-disabled') === 'true') {
                    return true;
                  }
                  current = current.parentElement;
                }
                return false;
              };

              const getChecked = (node) => {
                const tag = String(node.tagName || '').toLowerCase();
                if (tag === 'input') {
                  const type = String(node.getAttribute?.('type') || '').toLowerCase();
                  if (type === 'checkbox' || type === 'radio') {
                    return !!node.checked;
                  }
                }
                return getAriaBoolean(node.getAttribute?.('aria-checked'));
              };

              const getExpanded = (node) => getAriaBoolean(node.getAttribute?.('aria-expanded'));
              const getPressed = (node) => getAriaBoolean(node.getAttribute?.('aria-pressed'));
              const getSelected = (node) => {
                const tag = String(node.tagName || '').toLowerCase();
                if (tag === 'option') {
                  return !!node.selected;
                }
                return getAriaBoolean(node.getAttribute?.('aria-selected'));
              };

              const getLevel = (node) => {
                const ariaLevel = Number.parseInt(String(node.getAttribute?.('aria-level') || ''), 10);
                if (!Number.isNaN(ariaLevel)) {
                  return ariaLevel;
                }
                const tag = String(node.tagName || '').toLowerCase();
                const headingMatch = tag.match(/^h([1-6])$/);
                return headingMatch ? Number.parseInt(headingMatch[1], 10) : null;
              };

              const nameMatches = (name) => {
                if (query.regexSource) {
                  const re = new RegExp(query.regexSource, query.regexFlags ?? '');
                  return re.test(name);
                }
                if (query.name === undefined) {
                  return true;
                }
                return query.exact ? name === query.name : name.includes(query.name);
              };

              const matchesState = (node) => {
                if (query.includeHidden !== true && isHidden(node)) {
                  return false;
                }
                if (query.checked !== undefined && getChecked(node) !== query.checked) {
                  return false;
                }
                if (query.disabled !== undefined && getDisabled(node) !== query.disabled) {
                  return false;
                }
                if (query.expanded !== undefined && getExpanded(node) !== query.expanded) {
                  return false;
                }
                if (query.level !== undefined && getLevel(node) !== query.level) {
                  return false;
                }
                if (query.pressed !== undefined && getPressed(node) !== query.pressed) {
                  return false;
                }
                if (query.selected !== undefined && getSelected(node) !== query.selected) {
                  return false;
                }
                return true;
              };

              const root = document.documentElement || document.body;
              if (!root) {
                return null;
              }

              const matches = [];
              const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
              let current = root;
              while (current) {
                if (matchesState(current) && getRole(current) === query.role) {
                  const name = getAccessibleName(current);
                  if (nameMatches(name)) {
                    matches.push(current);
                  }
                }
                current = walker.nextNode();
              }

              return matches[query.nth] ?? null;
            }`,
          arguments: [{ value: { ...jn, nth: Yn } }],
          executionContextId: Vn.isolatedContextId,
          returnByValue: !1,
          awaitPromise: !1,
          userGesture: !1,
        },
        qn,
      );
      if (Qn.objectId)
        return {
          objectId: Qn.objectId,
          frameId: xn,
          frameSessionId: Vn.sessionId,
          contextId: Vn.isolatedContextId,
        };
    }
    throw Error(`Role selector not found: ${xn}`);
  }
  async #u() {
    return this.#n ? await this.#n.resolveFrameId() : this.#e.frameManager.mainFrameId;
  }
  async #d(): Promise<FrameWalkEntry[]> {
    if (this.#n) {
      let xn = await this.#n.resolveFrameId(),
        jn = this.#e.frameManager.getFrame(xn);
      return jn ? [{ frameId: xn, parentFrameId: jn.parentFrameId, depth: 0 }] : [];
    }
    return this.#e.frameManager.collectDescendantFrames(this.#e.frameManager.mainFrameId);
  }
  #f(xn: string): { selector: string; nth: number | `last` } {
    let jn = xn.match(/^(.*):nth\((\d+|last)\)$/);
    if (!jn) return { selector: xn, nth: 0 };
    let Vn = jn[2] ?? ``;
    return { selector: (jn[1] ?? ``).trim(), nth: Vn === `last` ? `last` : Number.parseInt(Vn, 10) };
  }
  #p(xn: string): RoleQuery {
    let jn = xn.match(NTH_SELECTOR_PATTERN),
      Vn = jn?.[1],
      qn: number | `last` = Vn === `last` ? `last` : Vn ? Number.parseInt(Vn, 10) : 0,
      Jn = jn ? xn.slice(0, jn.index) : xn,
      Yn = Jn.match(/^role:([^[]+)/);
    if (!Yn) throw Error(`Invalid role selector: ${xn}`);
    let Zn: RoleQuery = { role: (Yn[1] ?? ``).trim(), nth: qn },
      Qn = Jn.slice(Yn[0].length),
      ei = /\[([a-z-]+)(\*?)=(.*?)\]/g,
      ti: RegExpExecArray | null;
    for (; (ti = ei.exec(Qn));) {
      let [, xn, jn, Vn] = ti,
        qn = xn,
        Jn = (Vn ?? ``).trim();
      if (qn === `name-regex`) {
        Zn.regexSource = decodeURIComponent(Jn);
        continue;
      }
      if (qn === `name-regex-flags`) {
        Zn.regexFlags = decodeURIComponent(Jn);
        continue;
      }
      if (qn === `name`) {
        ((Zn.name = decodeURIComponent(Jn)), (Zn.exact = jn !== `*`));
        continue;
      }
      (qn === `checked` && (Zn.checked = Jn === `true`),
        qn === `disabled` && (Zn.disabled = Jn === `true`),
        qn === `expanded` && (Zn.expanded = Jn === `true`),
        qn === `include-hidden` && (Zn.includeHidden = Jn === `true`),
        qn === `level` && (Zn.level = Number.parseInt(Jn, 10)),
        qn === `pressed` && (Zn.pressed = Jn === `true`),
        qn === `selected` && (Zn.selected = Jn === `true`));
    }
    return Zn;
  }
  async #m(xn: string, jn: number, Vn: Omit<RoleQuery, `nth`>): Promise<number> {
    let { result: qn, exceptionDetails: Jn } = await this.#e.cdp.send(
      `Runtime.callFunctionOn`,
      {
        functionDeclaration: `function(query) {
          const normalizeText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
          const getRole = (node) => {
            const explicit = node.getAttribute?.('role');
            if (explicit) {
              return explicit.split(/\\s+/)[0] || 'generic';
            }

            const tag = String(node.tagName || '').toLowerCase();
            if (tag === 'input') {
              const type = String(node.getAttribute?.('type') || '').toLowerCase();
              if (type === 'checkbox') return 'checkbox';
              if (type === 'radio') return 'radio';
              if (type === 'range') return 'slider';
              if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
              return 'textbox';
            }
            if (tag === 'button') return 'button';
            if (tag === 'a' && node.hasAttribute?.('href')) return 'link';
            if (tag === 'select') return node.multiple || node.size > 1 ? 'listbox' : 'combobox';
            if (tag === 'textarea') return 'textbox';
            if (tag === 'img') return 'img';
            if (tag === 'option') return 'option';
            if (tag === 'summary') return 'button';
            return 'generic';
          };

          const getAccessibleName = (node) => {
            const ariaLabel = normalizeText(node.getAttribute?.('aria-label'));
            if (ariaLabel) return ariaLabel;

            const labelledBy = normalizeText(node.getAttribute?.('aria-labelledby'));
            if (labelledBy) {
              const labelText = labelledBy
                .split(/\\s+/)
                .map((id) => normalizeText(node.ownerDocument?.getElementById(id)?.textContent))
                .filter(Boolean)
                .join(' ');
              if (labelText) return labelText;
            }

            if (typeof node.labels?.length === 'number' && node.labels.length > 0) {
              const labelText = Array.from(node.labels)
                .map((label) => normalizeText(label.textContent))
                .filter(Boolean)
                .join(' ');
              if (labelText) return labelText;
            }

            const title = normalizeText(node.getAttribute?.('title'));
            if (title) return title;

            const alt = normalizeText(node.getAttribute?.('alt'));
            if (alt) return alt;

            const placeholder = normalizeText(node.getAttribute?.('placeholder'));
            if (placeholder) return placeholder;

            const value = normalizeText(node.value);
            if (value) return value;

            return normalizeText(node.textContent).slice(0, 100);
          };

          const isHidden = (node) => {
            if (!node.isConnected) return true;
            if (node.getAttribute?.('hidden') !== null) return true;
            if (node.getAttribute?.('aria-hidden') === 'true') return true;
            const style = node.ownerDocument?.defaultView?.getComputedStyle?.(node);
            if (!style) return false;
            return style.display === 'none' || style.visibility === 'hidden';
          };

          const getAriaBoolean = (value) => {
            if (value === 'true') return true;
            if (value === 'false') return false;
            return null;
          };

          const getDisabled = (node) => {
            if ('disabled' in node && typeof node.disabled === 'boolean') {
              return node.disabled;
            }
            let current = node;
            while (current) {
              if (current.getAttribute?.('aria-disabled') === 'true') {
                return true;
              }
              current = current.parentElement;
            }
            return false;
          };

          const getChecked = (node) => {
            const tag = String(node.tagName || '').toLowerCase();
            if (tag === 'input') {
              const type = String(node.getAttribute?.('type') || '').toLowerCase();
              if (type === 'checkbox' || type === 'radio') {
                return !!node.checked;
              }
            }
            return getAriaBoolean(node.getAttribute?.('aria-checked'));
          };

          const getExpanded = (node) => getAriaBoolean(node.getAttribute?.('aria-expanded'));
          const getPressed = (node) => getAriaBoolean(node.getAttribute?.('aria-pressed'));
          const getSelected = (node) => {
            const tag = String(node.tagName || '').toLowerCase();
            if (tag === 'option') {
              return !!node.selected;
            }
            return getAriaBoolean(node.getAttribute?.('aria-selected'));
          };

          const getLevel = (node) => {
            const ariaLevel = Number.parseInt(String(node.getAttribute?.('aria-level') || ''), 10);
            if (!Number.isNaN(ariaLevel)) {
              return ariaLevel;
            }
            const tag = String(node.tagName || '').toLowerCase();
            const headingMatch = tag.match(/^h([1-6])$/);
            return headingMatch ? Number.parseInt(headingMatch[1], 10) : null;
          };

          const nameMatches = (name) => {
            if (query.regexSource) {
              const re = new RegExp(query.regexSource, query.regexFlags ?? '');
              return re.test(name);
            }
            if (query.name === undefined) {
              return true;
            }
            return query.exact ? name === query.name : name.includes(query.name);
          };

          const matchesState = (node) => {
            if (query.includeHidden !== true && isHidden(node)) {
              return false;
            }
            if (query.checked !== undefined && getChecked(node) !== query.checked) {
              return false;
            }
            if (query.disabled !== undefined && getDisabled(node) !== query.disabled) {
              return false;
            }
            if (query.expanded !== undefined && getExpanded(node) !== query.expanded) {
              return false;
            }
            if (query.level !== undefined && getLevel(node) !== query.level) {
              return false;
            }
            if (query.pressed !== undefined && getPressed(node) !== query.pressed) {
              return false;
            }
            if (query.selected !== undefined && getSelected(node) !== query.selected) {
              return false;
            }
            return true;
          };

          const root = document.documentElement || document.body;
          if (!root) {
            return 0;
          }

          let count = 0;
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          let current = root;
          while (current) {
            if (matchesState(current) && getRole(current) === query.role) {
              const name = getAccessibleName(current);
              if (nameMatches(name)) {
                count += 1;
              }
            }
            current = walker.nextNode();
          }

          return count;
        }`,
        arguments: [{ value: Vn }],
        executionContextId: jn,
        returnByValue: !0,
        awaitPromise: !1,
        userGesture: !1,
      },
      xn,
    );
    if (Jn) throw Error(Jn.text ?? `Role selector count failed`);
    return Number(qn.value ?? 0);
  }
};
type Locator = InstanceType<typeof Locator>;
const ElementHandle = class {
  #e: OmOPage;
  #t: ElementTarget;
  constructor(xn: OmOPage, jn: ElementTarget) {
    ((this.#e = xn), (this.#t = jn));
  }
  async contentFrame(): Promise<OmOFrame | null> {
    let { node: xn } = await this.#e.cdp.send(
      `DOM.describeNode`,
      { objectId: this.#t.objectId, depth: 0 },
      await this.#e.resolveSessionId(this.#t.frameSessionId),
    );
    if (!xn.frameId || !this.#e.frameManager.getFrame(xn.frameId)) return null;
    let { OmOFrame: jn } = await Promise.resolve().then(() => (init_frame(), frame_exports));
    return new jn(this.#e, xn.frameId);
  }
};
type ElementHandle = InstanceType<typeof ElementHandle>;
var init_locator = __esmMin(() => {
  (init_utils$13(), init_errors$3(), init_types$4(), init_actions());
});
const FileChooser = class {
  page: OmOPage;
  #e: string;
  #t: number;
  #n: boolean;
  #r: Locator | null = null;
  constructor(xn: OmOPage, jn: string, Vn: number, qn: boolean) {
    ((this.page = xn), (this.#e = jn), (this.#t = Vn), (this.#n = qn));
  }
  element() {
    return ((this.#r ??= new Locator(this.page, createBackendNodeLocatorSelector(this.#e, this.#t))), this.#r);
  }
  isMultiple() {
    return this.#n;
  }
  async setFiles(xn: string | string[] | InputFilePayload | InputFilePayload[]) {
    await this.element().setInputFiles(Array.isArray(xn) || typeof xn == `string` ? xn : [xn]);
  }
};
type FileChooser = InstanceType<typeof FileChooser>;
var init_file_chooser = __esmMin(() => {
  init_locator();
});
export interface MouseButtonOptions {
  button?: string;
  clickCount?: number;
}
export interface MouseClickOptions extends MouseButtonOptions {
  delay?: number;
  steps?: number;
}
interface MouseDispatch {
  x?: number;
  y?: number;
  button?: string;
  buttons?: number;
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  force?: number;
  modifiers?: number;
}
type DomMouseEventType = `move` | `down` | `up` | `wheel`;
interface DomMouseEvent {
  eventType: DomMouseEventType;
  x: number;
  y: number;
  button?: string;
  buttons?: number;
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
}
const OmOMouse = class {
  context: OmOPage;
  modifierState: ModifierState;
  #e = 0;
  #t = 0;
  #n = `none`;
  constructor(xn: OmOPage, jn: ModifierState) {
    ((this.context = xn), (this.modifierState = jn));
  }
  async move(xn: number, jn: number, Vn: { steps?: number } = {}) {
    let qn = this.#e,
      Jn = this.#t,
      Yn = Math.max(Vn.steps ?? 1, 1),
      Zn = this.modifierState.toButtonsMask(),
      Qn = await shouldUseDomInputFallback(this.context);
    for (let Vn = 1; Vn <= Yn; Vn += 1) {
      let ei = qn + (xn - qn) * (Vn / Yn),
        ti = Jn + (jn - Jn) * (Vn / Yn);
      if (Qn) {
        await this.#i(`move`, { x: ei, y: ti, button: this.#n, buttons: Zn });
        continue;
      }
      await this.#r(`mouseMoved`, {
        x: ei,
        y: ti,
        button: this.#n,
        buttons: Zn,
        modifiers: this.modifierState.toModifiersMask(),
        force: Zn > 0 ? 0.5 : 0,
      });
    }
    ((this.#e = xn), (this.#t = jn));
  }
  async down(xn: MouseButtonOptions = {}) {
    let jn = xn.button ?? `left`,
      Vn = xn.clickCount ?? 1;
    if (((this.#n = jn), this.modifierState.mouseDown(jn), await shouldUseDomInputFallback(this.context))) {
      await this.#i(`down`, {
        x: this.#e,
        y: this.#t,
        button: jn,
        buttons: this.modifierState.toButtonsMask(),
        clickCount: Vn,
      });
      return;
    }
    await this.#r(`mousePressed`, {
      button: jn,
      buttons: this.modifierState.toButtonsMask(),
      clickCount: Vn,
      modifiers: this.modifierState.toModifiersMask(),
      force: this.modifierState.toButtonsMask() > 0 ? 0.5 : 0,
    });
  }
  async up(xn: MouseButtonOptions = {}) {
    let jn = xn.button ?? `left`,
      Vn = xn.clickCount ?? 1;
    if (((this.#n = `none`), this.modifierState.mouseUp(jn), await shouldUseDomInputFallback(this.context))) {
      await this.#i(`up`, {
        x: this.#e,
        y: this.#t,
        button: jn,
        buttons: this.modifierState.toButtonsMask(),
        clickCount: Vn,
      });
      return;
    }
    await this.#r(`mouseReleased`, {
      button: jn,
      buttons: this.modifierState.toButtonsMask(),
      clickCount: Vn,
      modifiers: this.modifierState.toModifiersMask(),
    });
  }
  async click(xn: number, jn: number, Vn: MouseClickOptions = {}) {
    let qn = Vn.button ?? `left`,
      Jn = Vn.clickCount ?? 1,
      Yn = Vn.delay ?? 0;
    (await this.move(xn, jn, { steps: Vn.steps }), await this.context.prepareForPotentialFileChooser?.());
    for (let xn = 1; xn <= Jn; xn += 1)
      (await this.down({ button: qn, clickCount: xn }),
        Yn > 0 && (await sleep$12(Yn)),
        await this.up({ button: qn, clickCount: xn }),
        Yn > 0 && xn < Jn && (await sleep$12(Yn)));
  }
  async dblclick(xn: number, jn: number, Vn: MouseClickOptions = {}) {
    await this.click(xn, jn, {
      button: Vn.button ?? `left`,
      clickCount: 2,
      delay: Vn.delay ?? 0,
      steps: Vn.steps,
    });
  }
  async wheel(xn: number, jn: number) {
    if (await shouldUseDomInputFallback(this.context)) {
      await this.#i(`wheel`, { x: this.#e, y: this.#t, deltaX: xn, deltaY: jn });
      return;
    }
    await this.#r(`mouseWheel`, { deltaX: xn, deltaY: jn, modifiers: this.modifierState.toModifiersMask() });
  }
  async #r(xn: string, jn: MouseDispatch) {
    await this.context._sendToTarget(`Input.dispatchMouseEvent`, {
      type: xn,
      x: Math.floor(jn.x ?? this.#e),
      y: Math.floor(jn.y ?? this.#t),
      button: jn.button,
      buttons: jn.buttons,
      clickCount: jn.clickCount,
      deltaX: jn.deltaX,
      deltaY: jn.deltaY,
      force: jn.force,
      modifiers: jn.modifiers ?? this.modifierState.toModifiersMask(),
    });
  }
  async #i(xn: DomMouseEventType, jn: Omit<DomMouseEvent, `eventType`>) {
    await this.context.evaluate(
      (xn: DomMouseEvent) => {
        let { eventType: jn, x: Vn, y: qn, button: Jn, buttons: Yn, clickCount: Zn, deltaX: Qn, deltaY: ei } = xn,
          ti =
            document.elementFromPoint(Vn, qn) ?? document.scrollingElement ?? document.documentElement ?? document.body,
          ni = Jn === `right` ? 2 : +(Jn === `middle`);
        if (jn === `wheel`) {
          (ti.dispatchEvent(
            new WheelEvent(`wheel`, {
              clientX: Vn,
              clientY: qn,
              deltaX: Qn ?? 0,
              deltaY: ei ?? 0,
              bubbles: !0,
              cancelable: !0,
              composed: !0,
            }),
          ),
            window.scrollBy(Qn ?? 0, ei ?? 0));
          return;
        }
        let ri = jn === `move` ? `mousemove` : jn === `down` ? `mousedown` : `mouseup`;
        (ti.dispatchEvent(
          new MouseEvent(ri, {
            clientX: Vn,
            clientY: qn,
            button: ni,
            buttons: Yn ?? 0,
            detail: Zn ?? 0,
            bubbles: !0,
            cancelable: !0,
            composed: !0,
            view: window,
          }),
        ),
          jn === `up` &&
            (ti.dispatchEvent(
              new MouseEvent(`click`, {
                clientX: Vn,
                clientY: qn,
                button: ni,
                buttons: Yn ?? 0,
                detail: Zn ?? 1,
                bubbles: !0,
                cancelable: !0,
                composed: !0,
                view: window,
              }),
            ),
            (Zn ?? 0) === 2 &&
              ti.dispatchEvent(
                new MouseEvent(`dblclick`, {
                  clientX: Vn,
                  clientY: qn,
                  button: ni,
                  buttons: Yn ?? 0,
                  detail: 2,
                  bubbles: !0,
                  cancelable: !0,
                  composed: !0,
                  view: window,
                }),
              )));
      },
      { eventType: xn, ...jn },
    );
  }
};
type OmOMouse = InstanceType<typeof OmOMouse>;
var init_mouse = __esmMin(() => {
  (init_utils$13(), init_keyboard());
});
const PASSWORD_MANAGER_EXTENSION_ID = `clcdgiameigmljcbkkcbjiljinmfkncl`;
const PASSWORD_MANAGER_EXTENSION_ORIGIN = `chrome-extension://${PASSWORD_MANAGER_EXTENSION_ID}`;
var init_extension_ids = __esmMin(() => {});
export interface SnapshotOptions {
  ref?: string;
  selector?: string;
  interactive?: boolean;
  maxDepth?: number;
  maxChars?: number;
  showHidden?: boolean;
}
export interface SnapshotRefInfo {
  tagName: string;
  [field: string]: unknown;
}
export interface SnapshotResult {
  tree: string;
  refs: Record<string, SnapshotRefInfo>;
}
interface FrameSnapshotResult extends SnapshotResult {
  error?: string;
}
function getKnownIframeOriginLabel(xn: string) {
  return KNOWN_IFRAME_ORIGINS.find(({ urlPrefix: jn }) => xn.startsWith(jn))?.label ?? null;
}
function formatIframeOriginLabel(xn: string | null | undefined) {
  return xn ? ` [origin="${xn.replace(/"/g, `\\"`)}"]` : ``;
}
function tagIframeLine(xn: string, jn: string, Vn: string) {
  return xn
    .split(`
`)
    .map((xn) => {
      let qn = xn.match(/^(\s*)- iframe(?:.*? )?\[ref=([^\]]*)\]/);
      return !qn || qn[2] !== jn || xn.includes(` [origin=`)
        ? xn
        : xn.replace(/^(\s*)- iframe/, `$1- iframe${formatIframeOriginLabel(Vn)}`);
    }).join(`
`);
}
function getCdpNodeAttribute(xn: string[] | undefined, jn: string) {
  if (!xn) return null;
  for (let Vn = 0; Vn < xn.length; Vn += 2) if (xn[Vn] === jn) return xn[Vn + 1] ?? ``;
  return null;
}
function inlineChildTree(xn: string, jn: string, Vn: string) {
  return xn
    .split(`
`)
    .flatMap((xn) => {
      let qn = xn.match(/^(\s*)- iframe(?:.*? )?\[ref=([^\]]*)\]/);
      if (!qn || qn[2] !== jn) return [xn];
      let Jn = qn[1] ?? ``,
        Yn = Vn.split(`
`).map((xn) => `${Jn}  ${xn}`);
      return [Vn.length > 0 ? `${xn}:` : xn].concat(Yn);
    }).join(`
`);
}
function appendOrphanChildTree(xn: string, jn: string, Vn: string | null) {
  if (!jn) return xn;
  let qn = jn
    .split(`
`)
    .map((xn) => `  ${xn}`);
  return `${xn}\n- iframe${formatIframeOriginLabel(Vn)}:\n${qn.join(`
`)}`;
}
function getRefPrefix(xn: string) {
  return xn.match(/^(f\d+)?e\d+$/)?.[1] ?? ``;
}
async function takeSnapshot(xn: CdpTransport, jn: FrameManager, Vn: SnapshotOptions = {}): Promise<SnapshotResult> {
  let qn = jn.mainFrameId,
    Jn = jn.collectDescendantFrames(qn),
    Yn = new Map<string, string>(),
    Zn = new Map<string, string>(),
    Qn = 1;
  for (let xn of Jn) {
    let jn = xn.frameId === qn ? `` : `f${Qn++}`;
    (Yn.set(xn.frameId, jn), Zn.set(jn, xn.frameId));
  }
  jn.setSnapshotFramePrefixMap(Zn);
  let ei = (() => {
    if (!Vn.ref) return qn;
    let xn = getRefPrefix(Vn.ref);
    return Jn.find(({ frameId: jn }) => (Yn.get(jn) ?? ``) === xn)?.frameId ?? null;
  })();
  if (!ei) throw Error(`Ref "${Vn.ref}" points to a frame that is no longer available. Take a new snapshot.`);
  let ti = jn.collectDescendantFrames(ei),
    ni = new Map<string, FrameSnapshotResult>(),
    ri: unknown;
  await Promise.all(
    ti.map(async ({ frameId: qn }) => {
      let Jn = qn === ei,
        Zn = Jn ? SNAPSHOT_MAX_RETRIES : 1,
        Qn: unknown;
      for (let ti = 0; ti < Zn; ti++) {
        ti > 0 && (await sleep$12(SNAPSHOT_RETRY_DELAY_MS));
        let ii = await jn.ensureInjected(qn).catch((xn) => ((Qn = xn), null));
        if (!ii) {
          if (Jn && ti < Zn - 1) continue;
          Jn && (ri = Qn);
          return;
        }
        let ai = {
          interactive: Vn.interactive,
          maxDepth: Vn.maxDepth,
          maxChars: Vn.maxChars,
          refId: qn === ei ? Vn.ref : void 0,
          selector: qn === ei ? Vn.selector : void 0,
          showHidden: Vn.showHidden,
          refPrefix: Yn.get(qn) ?? ``,
        };
        try {
          let { result: Vn } = await xn.send(
              `Runtime.callFunctionOn`,
              {
                functionDeclaration: `function(opts) {
              return globalThis.__omowright.takeSnapshot(opts);
            }`,
                arguments: [{ value: ai }],
                executionContextId: ii,
                returnByValue: !0,
                awaitPromise: !1,
                userGesture: !1,
              },
              jn.getFrame(qn)?.sessionId,
            ),
            Yn = Vn.value as FrameSnapshotResult | null | undefined;
          if (Yn) {
            if (Yn.error) {
              Jn && (ri = Yn.error);
              return;
            }
            ni.set(qn, Yn);
            return;
          }
        } catch (xn) {
          ((Qn = xn), isContextDestroyedError(xn) && jn.invalidateContext(qn));
        }
        Jn && Zn - 1;
      }
      Jn && (ri = Qn);
    }),
  );
  let ii = ni.get(ei);
  if (!ii) {
    let xn = ri;
    throw xn instanceof Error
      ? xn
      : typeof xn == `string` && xn.length > 0
        ? Error(xn)
        : Error(ei === qn ? `Main frame snapshot failed` : `Ref subtree snapshot failed`);
  }
  let ai = new Map<string, Map<string, string>>(),
    oi = new Map<string, Map<string, string>>();
  await Promise.all(
    ti.map(async ({ frameId: Vn }) => {
      let qn = ni.get(Vn),
        Jn = jn.getFrame(Vn);
      if (!qn || !Jn?.isolatedContextId) return;
      let Yn = Object.entries(qn.refs)
        .filter(([, xn]) => xn.tagName.toLowerCase() === `iframe`)
        .map(([xn]) => xn);
      if (Yn.length === 0) return;
      let Zn = await Promise.all(
          Yn.map(async (qn) => {
            let { result: Yn } = await xn
                .send(
                  `Runtime.callFunctionOn`,
                  {
                    functionDeclaration: `function(ref) {
                return globalThis.__omowright.elementRegistry.get(ref);
              }`,
                    arguments: [{ value: qn }],
                    executionContextId: Jn.isolatedContextId,
                    returnByValue: !1,
                  },
                  Jn.sessionId,
                )
                .catch((xn) => (isContextDestroyedError(xn) && jn.invalidateContext(Vn), { result: {} })),
              Zn = typeof Yn == `object` && Yn && `objectId` in Yn ? Yn.objectId : void 0;
            if (!Zn) return null;
            try {
              let { node: Vn } = await xn.send(`DOM.describeNode`, { objectId: Zn }, Jn.sessionId),
                Yn = Vn.frameId ? jn.getFrame(Vn.frameId)?.url : null,
                Qn = getCdpNodeAttribute(Vn.attributes, `src`),
                ei = getKnownIframeOriginLabel(Yn ?? ``) ?? getKnownIframeOriginLabel(Qn ?? ``);
              return { childFrameId: Vn.frameId, iframeRef: qn, originLabel: ei };
            } catch {
              return null;
            } finally {
              await xn.send(`Runtime.releaseObject`, { objectId: Zn }, Jn.sessionId).catch(() => {});
            }
          }),
        ),
        Qn = new Map<string, string>(),
        ei = new Map<string, string>();
      for (let xn of Zn)
        xn &&
          (xn.childFrameId && Qn.set(xn.childFrameId, xn.iframeRef),
          xn.originLabel && ei.set(xn.iframeRef, xn.originLabel));
      (ai.set(Vn, Qn), ei.size > 0 && oi.set(Vn, ei));
    }),
  );
  let si = ti.toSorted((xn, jn) => jn.depth - xn.depth),
    ci: Record<string, SnapshotRefInfo> = {};
  for (let xn of ni.values()) Object.assign(ci, xn.refs);
  for (let [xn, jn] of oi) {
    let Vn = ni.get(xn);
    if (Vn) for (let [xn, qn] of jn) Vn.tree = tagIframeLine(Vn.tree, xn, qn);
  }
  for (let xn of si) {
    if (xn.frameId === qn || !xn.parentFrameId) continue;
    let Vn = ni.get(xn.frameId),
      Jn = ni.get(xn.parentFrameId);
    if (!Vn || !Jn || !Vn.tree) continue;
    let Yn = ai.get(xn.parentFrameId)?.get(xn.frameId),
      Zn = getKnownIframeOriginLabel(jn.getFrame(xn.frameId)?.url ?? ``);
    Jn.tree = Yn ? inlineChildTree(Jn.tree, Yn, Vn.tree) : appendOrphanChildTree(Jn.tree, Vn.tree, Zn);
  }
  return { tree: ii.tree, refs: ci };
}
const KNOWN_IFRAME_ORIGINS = [
  { urlPrefix: `chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/`, label: `1Password` },
  { urlPrefix: `chrome-extension://nngceckbapebfimnlniiiahkandclblb/`, label: `Bitwarden` },
  { urlPrefix: `chrome-extension://fdjamakpfbbddfjaooikfcpapjohcfmg/`, label: `Dashlane` },
  { urlPrefix: `chrome-extension://hdokiejnpimakedhajhdlcegeplioahd/`, label: `LastPass` },
  { urlPrefix: `${PASSWORD_MANAGER_EXTENSION_ORIGIN}/`, label: `OmO Password Manager` },
];
const SNAPSHOT_RETRY_DELAY_MS = 300;
const SNAPSHOT_MAX_RETRIES = 3;
var init_snapshot = __esmMin(() => {
  (init_extension_ids(), init_utils$13(), init_client$6(), init_frame_manager());
});
var init_diff = __esmMin(() => {});
var init_session_tab_queries = __esmMin(() => {
  (init_drizzle_orm(),
    init_event_bus(),
    init_extension_bridge(),
    init_schema(),
    init_state_db(),
    init_nanoid(),
    init_utils$13(),
    init_store$1());
});
var init_annotate_screenshot = __esmMin(() => {});
const AI_TAB_STABLE_VIEWPORT = { width: 1440, height: 900 };
var init_browser: () => void = __esmMin(() => {
  (init_context(),
    init_cdp(),
    init_directory(),
    init_event_bus(),
    init_extension_bridge(),
    init_diff(),
    init_utils$13(),
    init_session_tab_queries(),
    init_store$1(),
    init_types$8(),
    init_utils$4(),
    init_annotate_screenshot(),
    init_frame_manager(),
    init_page(),
    init_snapshot());
});
export type VideoFormat = `webm` | `mp4`;
export interface VideoSize {
  width: number;
  height: number;
}
export interface VideoStartOptions {
  path?: string;
  format?: VideoFormat;
  size?: VideoSize;
  quality?: number;
  framerate?: number;
}
interface VideoProcess {
  stdin: NodeJS.WritableStream | null;
  stderr: NodeJS.ReadableStream | null;
}
function endProcessInput(..._args: unknown[]): never {
  throw new UnsupportedOperationError("Video recording is unavailable");
}
function writeProcessChunk(..._args: unknown[]): never {
  throw new UnsupportedOperationError("Video recording is unavailable");
}
async function readProcessStream(..._args: unknown[]): Promise<string> {
  throw new UnsupportedOperationError("Video recording is unavailable");
}
function defaultVideoSize(xn: VideoSize): VideoSize {
  let jn = Math.min(1, DEFAULT_VIDEO_MAX_EDGE / xn.width, DEFAULT_VIDEO_MAX_EDGE / xn.height),
    Vn = Math.max(2, Math.round(xn.width * jn)),
    qn = Math.max(2, Math.round(xn.height * jn));
  return { height: qn % 2 == 0 ? qn : qn + 1, width: Vn % 2 == 0 ? Vn : Vn + 1 };
}
function inferVideoFormat(xn: { format?: VideoFormat; path?: string }): VideoFormat {
  return xn.format ? xn.format : xn.path?.toLowerCase().endsWith(`.mp4`) ? `mp4` : DEFAULT_VIDEO_FORMAT;
}
async function ensureDirForFile(xn: string) {
  await mkdir(path.dirname(xn), { recursive: !0 });
}
async function readProcessStderr(xn: VideoProcess) {
  return await readProcessStream(xn.stderr).catch(() => ``);
}
const DEFAULT_VIDEO_FORMAT: VideoFormat = `webm`;
const DEFAULT_VIDEO_FRAMERATE = 25;
const DEFAULT_VIDEO_JPEG_QUALITY = 90;
const DEFAULT_VIDEO_MAX_EDGE = 800;
const FfmpegVideoRecorder = class {
  #e: number;
  #t: VideoProcess;
  #n = 0;
  #r = !1;
  #i: { buffer: Buffer; frameNumber: number; timestamp: number } | null = null;
  #a = Promise.resolve();
  #o = 0;
  #s: Buffer[] = [];
  constructor(xn: string, jn: VideoSize, Vn: number, qn: VideoFormat) {
    this.#e = Vn;
    let Jn =
      qn === `mp4`
        ? [`-c:v`, `libx264`, `-movflags`, `+faststart`]
        : [
            `-c:v`,
            `libvpx`,
            `-qmin`,
            `0`,
            `-qmax`,
            `50`,
            `-crf`,
            `8`,
            `-deadline`,
            `realtime`,
            `-speed`,
            `8`,
            `-b:v`,
            `1M`,
          ];
    this.#t = spawnCommand(
      [
        `ffmpeg`,
        `-loglevel`,
        `error`,
        `-f`,
        `image2pipe`,
        `-avioflags`,
        `direct`,
        `-fpsprobesize`,
        `0`,
        `-probesize`,
        `32`,
        `-analyzeduration`,
        `0`,
        `-c:v`,
        `mjpeg`,
        `-i`,
        `pipe:0`,
        `-y`,
        `-an`,
        `-r`,
        String(Vn),
        ...Jn,
        `-threads`,
        `1`,
        `-vf`,
        `scale=${jn.width}:${jn.height}:force_original_aspect_ratio=decrease,pad=${jn.width}:${jn.height}:(ow-iw)/2:(oh-ih)/2:gray`,
        `-pix_fmt`,
        `yuv420p`,
        xn,
      ],
      { stdio: [`pipe`, `ignore`, `pipe`] },
    );
  }
  writeFrame(xn: Buffer, jn: number) {
    if (this.#r) return;
    this.#n ||= jn;
    let Vn = Math.floor((jn - this.#n) * this.#e);
    if (this.#i) {
      let xn = Vn - this.#i.frameNumber;
      for (let jn = 0; jn < xn; jn += 1) this.#s.push(this.#i.buffer);
      this.#a = this.#a.then(() => this.#c());
    }
    ((this.#i = { buffer: xn, frameNumber: Vn, timestamp: jn }), (this.#o = Date.now()));
  }
  async stop(xn?: Buffer) {
    if (this.#r) return;
    if (!this.#i) {
      if (!xn) throw Error(`Video recorder did not capture any frames.`);
      this.writeFrame(xn, Date.now() / 1e3);
    }
    let jn = this.#i;
    if (!jn) throw Error(`Video recorder did not capture any frames.`);
    let Vn = Math.max((Date.now() - this.#o) / 1e3, 1);
    if (
      (this.writeFrame(Buffer.from([]), jn.timestamp + Vn),
      (this.#r = !0),
      await withCurrentReplAbort(async () => await this.#a),
      !this.#t.stdin)
    )
      throw Error(`ffmpeg stdin is unavailable.`);
    let qn = this.#t.stdin;
    await withCurrentReplAbort(async () => await endProcessInput(qn));
    let Jn = await withCurrentReplAbort(async () => await waitForExitCode(this.#t));
    if (Jn !== 0) {
      let xn = await readProcessStderr(this.#t);
      throw Error(xn.trim() || `ffmpeg exited with code ${Jn}`);
    }
  }
  async #c() {
    if (!this.#t.stdin) throw Error(`ffmpeg stdin is unavailable.`);
    let xn = this.#t.stdin;
    for (; this.#s.length > 0;) {
      let jn = this.#s.shift();
      if (!(!jn || jn.length === 0))
        try {
          await withCurrentReplAbort(async () => await writeProcessChunk(xn, jn));
        } catch (xn) {
          let jn = (await readProcessStderr(this.#t)).trim();
          throw Error(
            jn.length > 0 ? `ffmpeg rejected video frame input: ${jn}` : xn instanceof Error ? xn.message : String(xn),
            { cause: xn },
          );
        }
    }
  }
};
interface ActiveVideoRecording {
  completion: Promise<string>;
  format: VideoFormat;
  outputPath: string;
  pendingCopies: Set<string>;
  recorder: InstanceType<typeof FfmpegVideoRecorder>;
  rejectCompletion: (reason: unknown) => void;
  resolveCompletion: (path: string) => void;
  sessionId: string;
  unsubscribe: CdpUnsubscribe;
}
const OmOVideo = class {
  #e: OmOPage;
  #t: ActiveVideoRecording | null = null;
  #n: string | null = null;
  constructor(xn: OmOPage) {
    this.#e = xn;
  }
  async start(xn: VideoStartOptions = {}) {
    return await withCurrentReplAbort(async () => {
      if (this.#t) throw Error(`Video recording is already active.`);
      let jn = await this.#e.resolveSessionId(),
        Vn =
          this.#e.viewportSize() ?? (await this.#e.refreshViewportSize().catch(() => null)) ?? AI_TAB_STABLE_VIEWPORT,
        qn = inferVideoFormat(xn),
        Jn = xn.size ?? defaultVideoSize(Vn),
        Yn = await this.#e.browser.ensurePath(xn.path ?? `video-${Date.now()}.${qn}`, `write`, `page.video.start`),
        Zn = xn.quality ?? DEFAULT_VIDEO_JPEG_QUALITY,
        Qn = xn.framerate ?? DEFAULT_VIDEO_FRAMERATE;
      await ensureDirForFile(Yn);
      let ei = new FfmpegVideoRecorder(Yn, Jn, Qn, qn),
        { promise: ti, resolve: ni, reject: ri } = Promise.withResolvers<string>(),
        ii = this.#e.cdp.on(`Page.screencastFrame`, (xn, Vn) => {
          if (Vn.sessionId !== jn) return;
          let qn = Buffer.from(xn.data, `base64`),
            Jn = xn.metadata?.timestamp ?? Date.now() / 1e3;
          (ei.writeFrame(qn, Jn),
            this.#e.cdp.send(`Page.screencastFrameAck`, { sessionId: xn.sessionId }, jn).catch(() => {}));
        });
      ((this.#t = {
        completion: ti,
        format: qn,
        outputPath: Yn,
        pendingCopies: new Set(),
        recorder: ei,
        rejectCompletion: ri,
        resolveCompletion: ni,
        sessionId: jn,
        unsubscribe: ii,
      }),
        (this.#n = Yn));
      try {
        await this.#e.cdp.send(
          `Page.startScreencast`,
          { everyNthFrame: 1, format: `jpeg`, maxHeight: Jn.height, maxWidth: Jn.width, quality: Zn },
          jn,
        );
      } catch (xn) {
        throw (ii(), (this.#t = null), (this.#n = null), ri(xn), xn);
      }
    });
  }
  async stop(xn: { path?: string } = {}) {
    return await withCurrentReplAbort(async () => {
      let jn = this.#t;
      if (!jn) throw Error(`Video recording has not been started.`);
      ((this.#t = null),
        jn.unsubscribe(),
        await this.#e.cdp.send(`Page.stopScreencast`, void 0, jn.sessionId).catch(() => {}));
      try {
        let Vn = await this.#e.screenshot({ type: `jpeg` }).catch(() => void 0),
          qn = xn.path ? await this.#e.browser.ensurePath(xn.path, `write`, `page.video.stop`) : jn.outputPath;
        (await jn.recorder.stop(Vn),
          qn !== jn.outputPath && (await ensureDirForFile(qn), await copyFile(jn.outputPath, qn)),
          (this.#n = qn));
        for (let xn of jn.pendingCopies) {
          let jn = await this.#e.browser.ensurePath(xn, `write`, `page.video.saveAs`);
          jn !== qn && (await ensureDirForFile(jn), await copyFile(qn, jn));
        }
        jn.resolveCompletion(qn);
      } catch (xn) {
        throw (jn.rejectCompletion(xn), xn);
      }
    });
  }
  async path() {
    if (this.#t) return this.#t.outputPath;
    if (this.#n) return this.#n;
    throw Error(`Video recording has not been started.`);
  }
  async saveAs(xn: string) {
    return await withCurrentReplAbort(async () => {
      let jn = await this.#e.browser.ensurePath(xn, `write`, `page.video.saveAs`);
      if (this.#t) {
        (this.#t.pendingCopies.add(xn), await this.#t.completion);
        return;
      }
      if (!this.#n) throw Error(`Video recording has not been started.`);
      (await ensureDirForFile(jn), await copyFile(this.#n, jn));
    });
  }
  async delete() {
    return await withCurrentReplAbort(async () => {
      if ((this.#t && (await this.stop()), !this.#n)) throw Error(`Video recording has not been started.`);
      let xn = this.#n;
      ((this.#n = null), await unlink(xn).catch(() => {}));
    });
  }
};
type OmOVideo = InstanceType<typeof OmOVideo>;
var init_video: () => void = __esmMin(() => {
  (init_context(), init_process(), init_browser());
});
export interface EvaluateOptions {
  userGesture?: boolean;
}
export type ScreenshotType = `png` | `jpeg` | `webp`;
export interface ScreenshotClip {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ScreenshotOptions {
  path?: string;
  quality?: number;
  timeout?: number;
  type?: ScreenshotType;
  clip?: ScreenshotClip;
  fullPage?: boolean;
}
interface CaptureClip extends ScreenshotClip {
  scale: number;
}
function isOmOEvaluateOptions(xn: unknown): xn is EvaluateOptions {
  if (typeof xn != `object` || !xn || Array.isArray(xn)) return !1;
  let jn = Object.keys(xn);
  return jn.length === 1 && jn[0] === `userGesture`;
}
function resolveEvaluateCall(
  xn: PageFunction,
  jn: unknown,
  Vn: unknown,
): { actualArg: unknown; evaluateOptions: EvaluateOptions } {
  if (Vn !== void 0 && !isOmOEvaluateOptions(Vn))
    throw Error(
      `page.evaluate() accepts a single optional argument. Pass multiple values as one object or array, e.g. page.evaluate(fn, [a, b]).`,
    );
  return typeof xn == `string` && isOmOEvaluateOptions(jn)
    ? { actualArg: void 0, evaluateOptions: jn }
    : { actualArg: jn, evaluateOptions: isOmOEvaluateOptions(Vn) ? Vn : {} };
}
function clampScreenshotClipToTextureLimit(xn: CaptureClip, jn: number) {
  let Vn = Math.max(1, Math.floor(MAX_SCREENSHOT_TEXTURE_SIZE / (Number.isFinite(jn) && jn > 0 ? jn : 1)));
  return { ...xn, width: Math.max(1, Math.min(xn.width, Vn)), height: Math.max(1, Math.min(xn.height, Vn)) };
}
function normalizeScreenshotTimeout(xn: number | undefined) {
  if (xn !== void 0) {
    if (!Number.isFinite(xn) || xn < 0) throw Error(`page.screenshot: timeout must be a non-negative number`);
    return xn;
  }
}
function screenshotCaptureLabel(xn: ScreenshotOptions) {
  return xn.clip ? `clipped screenshot` : xn.fullPage ? `full-page screenshot` : `viewport screenshot`;
}
function formatScreenshotError(xn: unknown) {
  return xn instanceof Error ? xn.message : String(xn);
}
function rewriteCaptureScreenshotError(xn: unknown, jn: number | undefined, Vn: string) {
  let qn = formatScreenshotError(xn);
  if (qn !== `CDP command timeout: Page.captureScreenshot`) return xn instanceof Error ? xn : Error(qn);
  let Jn =
    jn === void 0
      ? `the default screenshot timeout`
      : jn === 0
        ? `a disabled page.screenshot timeout`
        : `the requested ${jn}ms page.screenshot timeout`;
  return Error(`page.screenshot: browser CDP command timed out while capturing ${Vn} before ${Jn} completed`);
}
function isCaptureScreenshotTimeout(xn: unknown) {
  let jn = formatScreenshotError(xn);
  return (
    jn === `CDP command timeout: Page.captureScreenshot` ||
    jn.startsWith(`page.screenshot: browser CDP command timed out while capturing `)
  );
}
function formatPdfLength(xn: number | string | undefined) {
  if (xn !== void 0) return typeof xn == `number` ? `${xn}px` : xn;
}
export interface PageHost {
  daemonSession: { accountId: number; id: string };
  extensionBridgeRoute: object;
  page: OmOPage | null;
  resolvePageSession(targetId: string, preferredSessionId?: string): Promise<string>;
  resolvePath(value: string): string;
  ensurePath(value: string, mode?: string, operation?: string): Promise<string>;
  registerReadableDownload(path: string): string;
  openPopupTab(url: string, openerTargetId: string): Promise<void>;
  closeTab(page: OmOPage, options?: { runBeforeUnload?: boolean }): Promise<void>;
}
export interface PageDialogEvent {
  type: string;
  message: string;
  defaultPrompt: string;
  url: string;
}
export interface PageEventMap {
  load: undefined;
  domcontentloaded: undefined;
  dialog: PageDialogEvent;
  filechooser: FileChooser;
  frameattached: { frameId: string; parentFrameId: string };
  framedetached: { frameId: string };
  framenavigated: { frameId: string; url: string; name: string; parentFrameId?: undefined };
  download: OmODownload;
  popup: { url: string; windowName: string };
  crash: undefined;
  close: undefined;
}
export type PageEventPayload<E extends string> = E extends keyof PageEventMap ? PageEventMap[E] : unknown;
export type PageEventListener<E extends string> = (payload: PageEventPayload<E>) => unknown;
export interface WaitForEventOptions<E extends string> {
  timeout?: number;
  predicate?: (payload: PageEventPayload<E>) => unknown;
}
export type GotoWaitUntil = `commit` | `interactive` | `stable` | `networkidle` | `load` | `domcontentloaded`;
export type LoadState = GotoWaitUntil;
export interface PdfMargin {
  top?: number | string;
  bottom?: number | string;
  left?: number | string;
  right?: number | string;
}
export interface PdfOptions {
  [option: string]: unknown;
  path?: string;
  width?: number | string;
  height?: number | string;
  margin?: PdfMargin;
  printBackground?: boolean;
}
const DEFAULT_WAIT_TIMEOUT_MS = 3e4;
const NETWORK_IDLE_MS = 500;
const MAX_SCREENSHOT_TEXTURE_SIZE = 16384;
const FILECHOOSER_OOPIF_FALLBACK_MS = 2e3;
var init_page: () => void = __esmMin(() => {
  (init_emittery(),
    init_context(),
    init_extension_bridge(),
    init_notification_grants(),
    init_utils$13(),
    init_client$6(),
    init_errors$3(),
    init_utils$4(),
    init_console_capture(),
    init_download(),
    init_file_chooser(),
    init_frame(),
    init_frame_manager(),
    init_keyboard(),
    init_locator(),
    init_mouse(),
    init_snapshot(),
    init_video(),
    init_wait());
});
class OmOPage {
  cdp: CdpTransport;
  frameManager: FrameManager;
  targetId: string;
  modifierState: ModifierState;
  mouse: OmOMouse;
  keyboard: OmOKeyboard;
  events = new Emittery<PageEventMap[keyof PageEventMap] | void>();
  browser: PageHost;
  #e = new Map<string, WeakMap<object, () => void>>();
  #t: InstanceType<typeof PageConsole> | null = null;
  #n: string;
  #r = ``;
  #i: VideoSize | null = null;
  #a: CdpUnsubscribe[] = [];
  #o: OmOVideo | null = null;
  #s = !1;
  #c = 0;
  constructor(xn: CdpTransport, jn: FrameManager, Vn: string, qn: string, Jn: PageHost) {
    ((this.cdp = xn),
      (this.frameManager = jn),
      (this.targetId = Vn),
      (this.modifierState = new ModifierState()),
      (this.mouse = new OmOMouse(this, this.modifierState)),
      (this.keyboard = new OmOKeyboard(this, this.modifierState)),
      (this.browser = Jn),
      (this.#n = qn),
      (this.#r = this.frameManager.getFrame(this.frameManager.mainFrameId)?.url ?? ``),
      this.#l());
  }
  #l() {
    let xn = new Set<string>(),
      jn = (xn: unknown) => {
        replPrint(`[error] page event listener threw: ${xn instanceof Error ? xn.message : xn}`);
      };
    (this.#u(`Page.frameNavigated`, (xn) => {
      xn.frame.parentId || (this.#r = xn.frame.url);
    }),
      this.#u(`Page.loadEventFired`, () => {
        this.events.emit(`load`).catch(jn);
      }),
      this.#u(`Page.domContentEventFired`, () => {
        this.events.emit(`domcontentloaded`).catch(jn);
      }),
      this.#u(`Page.javascriptDialogOpening`, (xn) => {
        this.events
          .emit(`dialog`, {
            type: xn.type,
            message: xn.message,
            defaultPrompt: xn.defaultPrompt ?? ``,
            url: xn.url,
          })
          .catch(jn);
      }),
      this.#a.push(
        this.cdp.on(`Page.fileChooserOpened`, (xn, Vn) => {
          !Vn.sessionId ||
            !xn.backendNodeId ||
            this.events
              .emit(`filechooser`, new FileChooser(this, xn.frameId, xn.backendNodeId, xn.mode === `selectMultiple`))
              .catch(jn);
        }),
      ),
      this.#u(`Page.frameAttached`, (xn) => {
        this.events.emit(`frameattached`, { frameId: xn.frameId, parentFrameId: xn.parentFrameId }).catch(jn);
      }),
      this.#u(`Page.frameDetached`, (xn) => {
        this.events.emit(`framedetached`, { frameId: xn.frameId }).catch(jn);
      }),
      this.#u(`Page.frameNavigated`, (xn) => {
        this.events
          .emit(`framenavigated`, { frameId: xn.frame.id, url: xn.frame.url, name: xn.frame.name ?? `` })
          .catch(jn);
      }));
    let Vn = (Vn: CdpDownloadWillBegin) => {
      xn.has(Vn.guid) ||
        (this.frameManager.getFrame(Vn.frameId) &&
          (xn.add(Vn.guid),
          this.events
            .emit(
              `download`,
              new OmODownload(this, {
                guid: Vn.guid,
                startedAfterMs: Date.now(),
                suggestedFilename: Vn.suggestedFilename,
                url: Vn.url,
              }),
            )
            .catch(jn)));
    };
    (this.#a.push(this.cdp.on(`Browser.downloadWillBegin`, (xn) => Vn(xn))),
      this.#u(`Page.downloadWillBegin`, (xn) => {
        Vn(xn);
      }),
      this.#a.push(
        this.cdp.on(`Page.windowOpen`, (xn, Vn) => {
          !Vn.sessionId ||
            !this.frameManager.hasSession(Vn.sessionId) ||
            this.events.emit(`popup`, { url: xn.url, windowName: xn.windowName }).catch(jn);
        }),
      ),
      this.#u(`Inspector.targetCrashed`, () => {
        this.events.emit(`crash`).catch(jn);
      }),
      (this.frameManager.onSessionInitialized = (xn) => {
        this.#c > 0 && this.#p(!0, [xn]);
      }));
  }
  #u<E extends string>(xn: E, jn: (payload: CdpEventPayload<E>) => void) {
    this.#a.push(
      this.cdp.on(xn, (xn, Vn) => {
        Vn.sessionId === this.#n && jn(xn);
      }),
    );
  }
  on<E extends string>(xn: E, jn: PageEventListener<E>) {
    let Vn = this.#e.get(xn) ?? new WeakMap<object, () => void>(),
      qn = this.events.on(xn, ({ data: xn }) => jn(xn as PageEventPayload<E>));
    return (
      Vn.set(jn, qn),
      this.#e.set(xn, Vn),
      xn === `filechooser` && this.#m(),
      () => {
        (qn(), Vn.delete(jn), xn === `filechooser` && this.#h());
      }
    );
  }
  off<E extends string>(xn: E, jn: PageEventListener<E>) {
    let Vn = this.#e.get(xn),
      qn = Vn?.get(jn);
    (qn?.(), Vn?.delete(jn), qn && xn === `filechooser` && this.#h());
  }
  async waitForEvent<E extends string>(xn: E, jn: WaitForEventOptions<E> = {}): Promise<PageEventPayload<E>> {
    let Vn = jn.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
    if (xn === `download`) {
      let qn = Date.now();
      return await new Promise<PageEventPayload<E>>((Jn, Yn) => {
        let Zn = !1,
          Qn = () => {
            (ri(), clearTimeout(ni));
          },
          ei = (xn: () => void) => {
            Zn || ((Zn = !0), Qn(), xn());
          },
          ti = (xn: unknown) => {
            (async () => {
              try {
                if (jn.predicate && !(await jn.predicate(xn as PageEventPayload<E>))) return;
                ei(() => Jn(xn as PageEventPayload<E>));
              } catch (xn) {
                ei(() => Yn(xn instanceof Error ? xn : Error(String(xn))));
              }
            })();
          },
          ni = setTimeout(() => {
            ei(() => Yn(Error(`Timed out waiting for page event "${String(xn)}"`)));
          }, Vn),
          ri = this.on(`download`, ti);
        this.cdp
          .send(`OmO.waitForDownload`, { startedAfterMs: qn, timeoutMs: Vn }, void 0, {
            extensionBridge: this.browser.extensionBridgeRoute,
          })
          .then((xn) => {
            ti(
              new OmODownload(this, {
                guid: String(xn.downloadId),
                sourcePath: xn.absolutePath,
                startedAfterMs: qn,
                suggestedFilename: path.basename(xn.absolutePath),
                url: this.url(),
              }),
            );
          })
          .catch(() => {});
      });
    }
    return await new Promise<PageEventPayload<E>>((qn, Jn) => {
      let Yn = !1,
        Zn: ReturnType<typeof setTimeout> | null = null,
        Qn = () => {
          (ni(), clearTimeout(ti), Zn && clearTimeout(Zn));
        },
        ei = (xn: () => void) => {
          Yn || ((Yn = !0), Qn(), xn());
        },
        ti = setTimeout(() => {
          ei(() => Jn(Error(`Timed out waiting for page event "${String(xn)}"`)));
        }, Vn);
      xn === `filechooser` &&
        Vn > FILECHOOSER_OOPIF_FALLBACK_MS &&
        (Zn = setTimeout(() => {
          Yn ||
            this.#g().then((xn) => {
              xn && !Yn && ei(() => qn(xn as PageEventPayload<E>));
            });
        }, FILECHOOSER_OOPIF_FALLBACK_MS));
      let ni = this.on(xn, (xn) => {
        (async () => {
          try {
            if (jn.predicate && !(await jn.predicate(xn))) return;
            ei(() => qn(xn));
          } catch (xn) {
            ei(() => Jn(xn instanceof Error ? xn : Error(String(xn))));
          }
        })();
      });
    });
  }
  #d() {
    for (let xn of this.#a) xn();
    this.#a = [];
  }
  async dispose() {
    this.#s ||
      ((this.#s = !0),
      await this.#o?.stop().catch(() => {}),
      this.#d(),
      (this.#c = 0),
      await this.events.emit(`close`),
      this.events.clearListeners(),
      this.#e.clear());
  }
  reconnect(xn: string) {
    ((this.#n = xn),
      (this.#s = !1),
      this.#d(),
      this.#l(),
      (this.#r = this.frameManager.getFrame(this.frameManager.mainFrameId)?.url ?? this.#r),
      this.#c > 0 && this.#p(!0));
  }
  #f() {
    return [...new Set([this.#n, ...[...this.frameManager.frames.values()].map((xn) => xn.sessionId)])];
  }
  async prepareForPotentialFileChooser() {
    this.#c !== 0 && (await this.#p(!0));
  }
  #p(xn: boolean, jn: string[] = this.#f()) {
    return withoutReplContext(async () => {
      await Promise.allSettled(
        jn.map((jn) => this.cdp.send(`Page.setInterceptFileChooserDialog`, { enabled: xn }, jn)),
      );
    });
  }
  #m() {
    ((this.#c += 1), this.#c === 1 && this.#p(!0));
  }
  #h() {
    this.#c !== 0 && (--this.#c, this.#c === 0 && this.#p(!1));
  }
  async #g(): Promise<FileChooser | null> {
    for (let xn of this.frameManager.frames.values())
      if (xn.sessionId !== this.#n)
        try {
          let { root: jn } = await this.cdp.send(`DOM.getDocument`, { depth: 0 }, xn.sessionId),
            { nodeIds: Vn } = await this.cdp.send(
              `DOM.querySelectorAll`,
              { nodeId: jn.nodeId, selector: `input[type=file]` },
              xn.sessionId,
            );
          if (Vn.length === 0) continue;
          let qn = Vn[Vn.length - 1],
            { node: Jn } = await this.cdp.send(`DOM.describeNode`, { nodeId: qn }, xn.sessionId),
            Yn = (Jn.attributes ?? []).includes(`multiple`);
          return new FileChooser(this, xn.frameId, Jn.backendNodeId, Yn);
        } catch {}
    return null;
  }
  async resolveSessionId(xn?: string): Promise<string> {
    if (xn && this.frameManager.hasSession(xn)) return xn;
    let jn = await this.browser.resolvePageSession(this.targetId, this.#n);
    return (jn !== this.#n && (this.#n = jn), jn);
  }
  async goto(xn: string, jn: { waitUntil?: GotoWaitUntil } = {}) {
    let Vn = jn.waitUntil ?? `interactive`,
      qn = await this.resolveSessionId(this.#n),
      Jn: () => void = () => {},
      Yn: Promise<void> | null =
        Vn === `commit`
          ? null
          : Vn === `interactive` || Vn === `stable`
            ? waitForNavigationReadiness(this, Vn, DEFAULT_WAIT_TIMEOUT_MS).then(() => {})
            : Vn === `networkidle`
              ? this.#S(DEFAULT_WAIT_TIMEOUT_MS)
              : new Promise<void>((xn, jn) => {
                  let Yn = !1,
                    Zn: ReturnType<typeof setTimeout> | undefined,
                    Qn: () => void = () => {},
                    ei = (xn: () => void) => {
                      Yn || ((Yn = !0), clearTimeout(Zn), Qn(), xn());
                    };
                  Zn = setTimeout(() => {
                    ei(() => jn(Error(`Timed out waiting for "${Vn}" after goto`)));
                  }, DEFAULT_WAIT_TIMEOUT_MS);
                  let ti = Vn === `load` ? `Page.loadEventFired` : `Page.domContentEventFired`;
                  ((Qn = this.cdp.on(ti, (jn, Vn) => {
                    Vn.sessionId === qn && ei(xn);
                  })),
                    (Jn = () => ei(xn)));
                }),
      Zn = await this.cdp.send(`Page.navigate`, { url: xn }, qn);
    if (Zn.errorText) throw Error(Zn.errorText);
    if (((this.#r = xn), Vn === `domcontentloaded` && Yn)) {
      if (!Zn.loaderId) {
        (Jn(), await this.#v(`Timed out waiting for "${Vn}" after goto`));
        return;
      }
      try {
        await Yn;
      } catch (xn) {
        if (await this.#_()) return;
        throw xn;
      }
      return;
    }
    Yn && (await Yn);
  }
  async goBack() {
    let xn = await this._sendToTarget(`Page.getNavigationHistory`),
      jn = xn.currentIndex - 1;
    if (jn < 0) return;
    let Vn = xn.entries[jn];
    if (!Vn) return;
    let qn = this.#C();
    (await this._sendToTarget(`Page.navigateToHistoryEntry`, { entryId: Vn.id }), await qn);
  }
  async goForward() {
    let xn = await this._sendToTarget(`Page.getNavigationHistory`),
      jn = xn.currentIndex + 1;
    if (jn >= xn.entries.length) return;
    let Vn = xn.entries[jn];
    if (!Vn) return;
    let qn = this.#C();
    (await this._sendToTarget(`Page.navigateToHistoryEntry`, { entryId: Vn.id }), await qn);
  }
  async reload() {
    let xn = this.#C();
    (await this._sendToTarget(`Page.reload`), await xn);
  }
  async waitForLoadState(xn: LoadState = `interactive`, jn = DEFAULT_WAIT_TIMEOUT_MS) {
    if (xn === `interactive` || xn === `stable`) {
      await waitForNavigationReadiness(this, xn, jn);
      return;
    }
    if (xn === `networkidle` || xn === `load`) {
      (replPrint(
        `[system] this is redundant wait; openTab() already waits for the page to become usable. Falling back to 'stable' with 5s timeout.`,
      ),
        await waitForNavigationReadiness(this, `stable`, 5e3).catch(() => {}));
      return;
    }
    if (await this.#_()) return;
    let qn = await this.resolveSessionId(this.#n);
    await new Promise<void>((jn, Vn) => {
      let Jn = setTimeout(() => {
          (Yn(), Vn(Error(`Timed out waiting for load state "${xn}"`)));
        }, DEFAULT_WAIT_TIMEOUT_MS),
        Yn = this.cdp.on(`Page.domContentEventFired`, (xn, Vn) => {
          Vn.sessionId === qn && (clearTimeout(Jn), Yn(), jn());
        });
    });
  }
  async #_() {
    return (await this.evaluate(`document.readyState`).catch(() => `loading`)) !== `loading`;
  }
  async #v(xn: string, jn = DEFAULT_WAIT_TIMEOUT_MS) {
    let Vn = Date.now();
    for (; Date.now() - Vn < jn;) {
      if (await this.#_()) return;
      await sleep$12(50);
    }
    throw Error(xn);
  }
  async waitForURL(xn: string | RegExp, jn: { timeout?: number } = {}) {
    let Vn = jn.timeout ?? DEFAULT_WAIT_TIMEOUT_MS,
      qn = Date.now();
    for (; Date.now() - qn < Vn;) {
      let jn = this.url();
      if (typeof xn == `string` ? jn === xn : xn.test(jn)) return;
      await sleep$12(100);
    }
    throw Error(`Timed out waiting for URL match: ${String(xn)}`);
  }
  async waitForSelector(xn: string, jn: { state?: LocatorWaitState; timeout?: number } = {}) {
    let Vn = jn.state ?? `visible`,
      qn = jn.timeout ?? 3e3,
      Jn = [0, 20, 50, 100, 100, 500],
      Yn = Date.now(),
      Zn = 0;
    for (;;) {
      if (Date.now() - Yn >= qn)
        throw Error(`waitForSelector: timed out after ${qn}ms waiting for "${xn}" to be ${Vn}`);
      let jn = await this.evaluate((xn: string) => {
        let jn = document.querySelector(xn);
        if (!jn) return { attached: !1, visible: !1 };
        let Vn = jn.getBoundingClientRect(),
          qn = window.getComputedStyle(jn);
        return {
          attached: !0,
          visible:
            qn.visibility !== `hidden` &&
            qn.display !== `none` &&
            parseFloat(qn.opacity) !== 0 &&
            Vn.width > 0 &&
            Vn.height > 0,
        };
      }, xn);
      if (
        Vn === `attached` ? jn.attached : Vn === `detached` ? !jn.attached : Vn === `visible` ? jn.visible : !jn.visible
      )
        return;
      let Qn = Jn[Math.min(Zn++, Jn.length - 1)] ?? 0;
      await sleep$12(Qn);
    }
  }
  locator(xn: string, jn: LocatorFilterOptions = {}): Locator {
    return new Locator(this, xn).filter(jn);
  }
  async click(xn: string, jn?: ClickOptions) {
    await this.locator(xn).click(jn);
  }
  async fill(xn: string, jn: string) {
    await this.locator(xn).fill(jn);
  }
  async $(xn: string) {
    return (
      replPrint(`warn`, `page.$() is deprecated in OmOWright — use page.locator(selector).first() instead`),
      this.locator(xn).first()
    );
  }
  async $$(xn: string) {
    return (
      replPrint(`warn`, `page.$$() is deprecated in OmOWright — use page.locator(selector).all() instead`),
      await this.locator(xn).all()
    );
  }
  async $$eval(xn: string, jn: PageFunction, Vn?: unknown) {
    return await this.locator(xn).evaluateAll(jn, Vn);
  }
  getByRole(xn: string, jn: RoleSelectorOptions = {}) {
    return new Locator(this, Locator.createRoleSelector(xn, jn));
  }
  getByLabel(xn: string | RegExp, jn: TextMatchOptions = {}) {
    if (xn instanceof RegExp) return new Locator(this, `internal:label=/${xn.source}/${xn.flags}`);
    let Vn = JSON.stringify(xn);
    return new Locator(this, jn.exact ? `internal:label:exact:${Vn}` : `internal:label:${Vn}`);
  }
  getByText(xn: string | RegExp, jn: TextMatchOptions = {}) {
    if (xn instanceof RegExp) return new Locator(this, `text:/${xn.source}/${xn.flags}`);
    let Vn = JSON.stringify(xn);
    return new Locator(this, jn.exact ? `text:exact:${Vn}` : `text:${Vn}`);
  }
  frameLocator(xn: string) {
    return new FrameLocator(this, this.mainFrame(), xn);
  }
  evaluate<R>(xn: () => R): Promise<Awaited<R>>;
  evaluate<A, R>(xn: (arg: A) => R, jn: A, Vn?: EvaluateOptions): Promise<Awaited<R>>;
  evaluate(xn: string, jn?: unknown, Vn?: EvaluateOptions): Promise<unknown>;
  async evaluate(xn: PageFunction, jn?: unknown, Vn?: unknown): Promise<unknown> {
    let { actualArg: qn, evaluateOptions: Jn } = resolveEvaluateCall(xn, jn, Vn);
    if (typeof xn == `string` && qn === void 0) {
      let { result: jn, exceptionDetails: Vn } = await this._sendToTarget(`Runtime.evaluate`, {
        expression: xn,
        returnByValue: !0,
        awaitPromise: !0,
        userGesture: Jn.userGesture,
      });
      if (Vn) throw Error(formatRuntimeException(Vn, `Evaluation failed`));
      return jn.value;
    }
    let Yn = typeof xn == `function` ? xn.toString() : xn,
      Zn = await this.#x();
    try {
      let { result: xn, exceptionDetails: jn } = await this._sendToTarget(`Runtime.callFunctionOn`, {
        objectId: Zn,
        functionDeclaration: `function(arg) { var __name = (t) => t; return (${Yn})(arg); }`,
        arguments: [{ value: qn }],
        returnByValue: !0,
        awaitPromise: !0,
        userGesture: Jn.userGesture,
      });
      if (jn) throw Error(formatRuntimeException(jn, `Evaluation failed`));
      return xn.value;
    } finally {
      await this._sendToTarget(`Runtime.releaseObject`, { objectId: Zn }).catch(() => {});
    }
  }
  async evaluateInFrame<R = unknown>(xn: string | null, jn: PageFunction, Vn?: unknown, qn?: unknown): Promise<R> {
    let Jn = this.frameManager.getFrame(xn);
    if (!Jn) throw Error(`Frame is not available: ${xn}`);
    let { actualArg: Yn, evaluateOptions: Zn } = resolveEvaluateCall(jn, Vn, qn),
      Qn = await this.resolveSessionId(Jn.sessionId);
    if (typeof jn == `string` && Yn === void 0) {
      let Vn = await this.frameManager.ensureInjected(xn);
      if (!Vn) throw Error(`Frame isolated world is not ready: ${xn}`);
      let { result: qn, exceptionDetails: Jn } = await this.cdp.send(
        `Runtime.evaluate`,
        { expression: jn, contextId: Vn, returnByValue: !0, awaitPromise: !0, userGesture: Zn.userGesture },
        Qn,
      );
      if (Jn) throw Error(formatRuntimeException(Jn, `Evaluation failed`));
      return qn.value as R;
    }
    let ei = typeof jn == `function` ? jn.toString() : jn,
      ti = await this.frameManager.ensureInjected(xn);
    if (!ti) throw Error(`Frame isolated world is not ready: ${xn}`);
    let { result: ni, exceptionDetails: ri } = await this.cdp.send(
      `Runtime.callFunctionOn`,
      {
        functionDeclaration: `function(arg) { var __name = (t) => t; return (${ei})(arg); }`,
        arguments: [{ value: Yn }],
        executionContextId: ti,
        returnByValue: !0,
        awaitPromise: !0,
        userGesture: Zn.userGesture,
      },
      Qn,
    );
    if (ri) throw Error(formatRuntimeException(ri, `Evaluation failed`));
    return ni.value as R;
  }
  async grantNotificationPermission() {
    await sendCommandToExtension(
      { method: `OmO.grantNotificationPermission`, params: { targetId: this.targetId } },
      this.browser.extensionBridgeRoute,
    );
    let xn = new URL(this.#r).origin,
      jn = this.browser.daemonSession;
    upsertNotificationGrant({ accountId: jn.accountId, origin: xn, grantedBySessionId: jn.id });
  }
  url({ truncate: xn = !1 }: { truncate?: boolean } = {}) {
    return xn ? truncateUrlForLLM(this.#r) : this.#r;
  }
  async title() {
    return (await this.evaluate(`document.title`).catch(() => ``)) as string;
  }
  async content() {
    return (await this.evaluate(`document.documentElement.outerHTML`)) as string;
  }
  async screenshot(xn: ScreenshotOptions = {}): Promise<Buffer> {
    let jn = normalizeScreenshotTimeout(xn.timeout),
      Vn = jn && jn > 0 ? Date.now() + jn : void 0,
      qn: CaptureClip | undefined;
    if (xn.clip) qn = { x: xn.clip.x, y: xn.clip.y, width: xn.clip.width, height: xn.clip.height, scale: 1 };
    else if (xn.fullPage) {
      let xn = await this._sendToTarget(`Page.getLayoutMetrics`),
        jn = xn.cssContentSize ?? xn.contentSize;
      qn = { x: 0, y: 0, width: jn.width, height: jn.height, scale: 1 };
    }
    qn &&= clampScreenshotClipToTextureLimit(qn, await this.#y());
    let Jn = {
        format: xn.type ?? `png`,
        captureBeyondViewport: !!xn.fullPage,
        quality: xn.quality,
        ...(qn ? { clip: qn } : {}),
      },
      Yn: string;
    try {
      ({ data: Yn } = await this.#b(Jn, jn, screenshotCaptureLabel(xn)));
    } catch (jn) {
      if (!xn.fullPage || xn.clip || !isCaptureScreenshotTimeout(jn)) throw jn;
      let qn = Vn ? Math.max(0, Vn - Date.now()) : void 0;
      if (qn === 0) throw jn;
      let Jn = { format: xn.type ?? `png`, captureBeyondViewport: !1, quality: xn.quality };
      try {
        (({ data: Yn } = await this.#b(Jn, qn, `viewport fallback screenshot`)),
          replPrint(`[system] full-page screenshot failed; returned viewport fallback. ${formatScreenshotError(jn)}`));
      } catch (xn) {
        throw Error(`${formatScreenshotError(jn)}\nViewport fallback also failed: ${formatScreenshotError(xn)}`, {
          cause: xn,
        });
      }
    }
    let Zn = Buffer.from(Yn, `base64`);
    if (xn.path)
      if (xn.path.startsWith(`/tmp`)) {
        let jn = this.browser.resolvePath(`tmp`),
          Vn = path.join(jn, path.basename(xn.path));
        (await mkdir(path.dirname(Vn), { recursive: !0 }),
          await writeFile(Vn, Zn),
          replPrint(`[WARN] Use ${jn} instead of /tmp. Saved it to ${Vn}`));
      } else {
        let jn = this.browser.resolvePath(xn.path);
        (await mkdir(path.dirname(jn), { recursive: !0 }), await writeFile(jn, Zn));
      }
    return Zn;
  }
  async #y() {
    return (await this.evaluate(`window.devicePixelRatio`).catch(() => 1)) as number;
  }
  async #b(xn: object, jn: number | undefined, Vn: string) {
    try {
      return await this._sendToTarget(`Page.captureScreenshot`, xn, { timeoutMs: jn });
    } catch (xn) {
      throw rewriteCaptureScreenshotError(xn, jn, Vn);
    }
  }
  async snapshot(xn: SnapshotOptions = {}) {
    return await takeSnapshot(this.cdp, this.frameManager, xn);
  }
  frames() {
    return this.frameManager
      .collectDescendantFrames(this.frameManager.mainFrameId)
      .map(({ frameId: xn }) => new OmOFrame(this, xn));
  }
  mainFrame() {
    let xn = this.frameManager.getFrame(this.frameManager.mainFrameId);
    if (!xn) throw Error(`Main frame is not available`);
    return new OmOFrame(this, xn.frameId);
  }
  async bringToFront() {
    ((this.browser.page = this), replPrint(`page is now [${await this.title().catch(() => ``)}](${this.url()})`));
  }
  async openPopupUrl(xn: string) {
    await this.browser.openPopupTab(xn, this.targetId);
  }
  get console() {
    return (this.#t ??= new PageConsole(this));
  }
  video() {
    return this.#w();
  }
  viewportSize() {
    return this.#i ? { ...this.#i } : null;
  }
  async refreshViewportSize() {
    let xn = await this.evaluate(() => ({
      width: Math.round(globalThis.visualViewport?.width ?? globalThis.innerWidth ?? 0),
      height: Math.round(globalThis.visualViewport?.height ?? globalThis.innerHeight ?? 0),
    }));
    if (xn.width <= 0 || xn.height <= 0) throw Error(`Measured viewport size is invalid: ${JSON.stringify(xn)}`);
    return ((this.#i = xn), xn);
  }
  setCachedViewportSize(xn: VideoSize | null | undefined) {
    this.#i = xn ? { ...xn } : null;
  }
  async pdf(xn: PdfOptions = {}) {
    let jn = xn.path ? await this.browser.ensurePath(xn.path, `write`, `page.pdf`) : void 0,
      Vn = {
        ...xn,
        height: formatPdfLength(xn.height),
        margin: xn.margin
          ? {
              bottom: formatPdfLength(xn.margin.bottom),
              left: formatPdfLength(xn.margin.left),
              right: formatPdfLength(xn.margin.right),
              top: formatPdfLength(xn.margin.top),
            }
          : void 0,
        printBackground: xn.printBackground ?? !0,
        transferMode: `ReturnAsBase64`,
        width: formatPdfLength(xn.width),
      },
      { data: qn } = await this._sendToTarget(`Page.printToPDF`, Vn),
      Jn = Buffer.from(qn, `base64`);
    return (jn && (await mkdir(path.dirname(jn), { recursive: !0 }).catch(() => {}), await writeFile(jn, Jn)), Jn);
  }
  async close(xn: { runBeforeUnload?: boolean } = {}) {
    if (
      (await this.#w()
        .stop()
        .catch(() => {}),
      xn.runBeforeUnload)
    ) {
      let jn = await this.resolveSessionId(this.#n);
      await this.cdp.send(`Page.close`, void 0, jn).catch(async () => {
        await this.browser.closeTab(this, xn);
      });
      return;
    }
    await this.browser.closeTab(this, xn);
  }
  async #x() {
    let { result: xn, exceptionDetails: jn } = await this._sendToTarget(`Runtime.evaluate`, {
      expression: `globalThis`,
      serializationOptions: { serialization: `idOnly` },
    });
    if (jn) throw Error(formatRuntimeException(jn, `Failed to resolve main world`));
    if (!xn.objectId) throw Error(`Main world object is not available`);
    return xn.objectId;
  }
  async #S(xn: number) {
    await this._sendToTarget(`Network.enable`).catch(() => {});
    let jn = await this.resolveSessionId(this.#n);
    await new Promise<void>((Vn, qn) => {
      let Jn = new Set<string>(),
        Yn: ReturnType<typeof setTimeout> | null = null,
        Zn: ReturnType<typeof setTimeout> | null = null,
        Qn = () => {
          (ti(), ri(), ii(), (Yn &&= (clearTimeout(Yn), null)), (Zn &&= (clearTimeout(Zn), null)));
        },
        ei = () => {
          (Yn && clearTimeout(Yn),
            Jn.size === 0 &&
              (Yn = setTimeout(() => {
                (Qn(), Vn());
              }, NETWORK_IDLE_MS)));
        },
        ti = this.cdp.on(`Network.requestWillBeSent`, (xn, Vn) => {
          Vn.sessionId === jn && (xn.request.url.startsWith(`data:`) || Jn.add(xn.requestId));
        }),
        ni = (xn: string) => {
          (Jn.delete(xn), ei());
        },
        ri = this.cdp.on(`Network.loadingFinished`, (xn, Vn) => {
          Vn.sessionId === jn && ni(xn.requestId);
        }),
        ii = this.cdp.on(`Network.loadingFailed`, (xn, Vn) => {
          Vn.sessionId === jn && ni(xn.requestId);
        });
      ((Zn = setTimeout(() => {
        (Qn(), qn(Error(`Timed out waiting for load state "networkidle"`)));
      }, xn)),
        ei());
    });
  }
  async #C() {
    let xn = await this.resolveSessionId(this.#n);
    await new Promise<void>((jn, Vn) => {
      let qn = setTimeout(() => {
          (Jn(), Vn(Error(`Timed out waiting for navigation`)));
        }, DEFAULT_WAIT_TIMEOUT_MS),
        Jn = this.cdp.on(`Page.frameNavigated`, (Vn, Yn) => {
          Yn.sessionId === xn && (Vn.frame.parentId || (clearTimeout(qn), Jn(), jn()));
        });
    });
  }
  async _sendToTarget<M extends string>(xn: M, jn?: object, Vn: PageSendOptions = {}): Promise<CdpResult<M>> {
    if (this.#s) throw Error(`Page ${this.targetId} is disposed`);
    let { preferredSessionId: qn, ...Jn } = Vn;
    if (qn !== void 0) {
      if (!this.frameManager.hasSession(qn))
        throw Error(`Frame is stale or detached: CDP session ${qn} is unavailable`);
      return await this.cdp.send(xn, jn, qn, Jn);
    }
    let Yn = await this.resolveSessionId(this.#n);
    return await this.cdp.send(xn, jn, Yn, Jn);
  }
  #w() {
    return ((this.#o ??= new OmOVideo(this)), this.#o);
  }
}

init_client$6();
init_session_manager();
init_frame_manager();
init_page();

export {
  OmOKeyboard,
  OmOMouse,
  OmOPage,
  BrowserCdpCommandError,
  CdpClient,
  ElementHandle,
  FrameLocator,
  FrameManager,
  Locator,
  ModifierState,
  SessionManager,
  UnsupportedOperationError,
  takeSnapshot,
};
