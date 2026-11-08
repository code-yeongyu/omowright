// CDP over Ego Lite's native bindings (globalThis.ego inside `ego-browser nodejs`).
// ego.sendCDPMessage takes JSON text for a browser-level CDP session with flattened
// target sessions, answers through ego.onCDPMessage, and reports sends it refused before
// they reached CDP (user control, no task space) through ego.onSendCDPMessageError.
import { Dialog, answerWithPolicy, dialogPolicyParams, normalizeDialogPolicy } from "../dialog-policy.ts";
import type { CdpEventPayload, CdpResult, CdpTargetSummary } from "../cdp-protocol.ts";
import type {
  DialogPolicyInput,
  EgoCdpBindings,
  EgoCdpClientOptions,
  EgoEvent,
  EgoEventMeta,
  EgoSendOptions,
  PendingCommand,
} from "./bindings.ts";
import { EgoCdpError, requireEgo } from "./errors.ts";
import { SerialEmitter as Emittery } from "../serial-emitter.ts";
import { CdpCommandTimeoutError, CdpSessionCrashedError, CdpSessionDetachedError } from "../cdp-errors.ts";
import { randomInt } from "node:crypto";
import { targetCreationCapability } from "../internal-capability.ts";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

type JsonObject = Readonly<Record<string, unknown>>;
const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null;
const sessionIdOf = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const stringOr = <T>(value: unknown, fallback: T): string | T => (typeof value === "string" ? value : fallback);

export class EgoCdpClient {
  #ego: EgoCdpBindings;
  // CDP ids are int32; a random base keeps two clients on one Ego session from reusing an id.
  #seq = randomInt(1, 2 ** 30);
  #onMessageHandler = (payload: string) => this.#onMessage(payload);
  #onSendErrorHandler = (message: string, code?: string) => this.#onSendError(message, code);
  #pending = new Map<number, PendingCommand>();
  #closedSessions = new Set<string>();
  #events = new Emittery<EgoEvent>();
  #connected = false;
  #commandTimeoutMs: number;
  #dialogPolicy;
  transportEvents = new Emittery();
  logId: string;
  isHeadless = false;

  constructor({ ego = globalThis.ego, commandTimeoutMs, logId, dialogPolicy }: EgoCdpClientOptions = {}) {
    this.#ego = requireEgo(ego);
    this.#commandTimeoutMs = commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.logId = logId ?? `cdp-ego-${Date.now()}`;
    this.#dialogPolicy = normalizeDialogPolicy(dialogPolicy);
  }

  get isConnected() {
    return this.#connected;
  }
  get dialogPolicy() {
    return this.#dialogPolicy;
  }

  setDialogPolicy(policy: DialogPolicyInput) {
    this.#dialogPolicy = normalizeDialogPolicy(policy);
  }

  async ensureConnected() {
    if (this.#connected) return;
    if (this.#ego.onCDPMessage || this.#ego.onSendCDPMessageError) {
      throw new EgoCdpError(
        "ego_busy",
        "another client already holds Ego's CDP callbacks in this runtime; close it first",
      );
    }
    this.#ego.onCDPMessage = this.#onMessageHandler;
    this.#ego.onSendCDPMessageError = this.#onSendErrorHandler;
    this.#connected = true;
    await this.#dispatch("Target.setDiscoverTargets", { discover: true }).catch(() => {});
    await this.transportEvents.emit("connected", undefined);
  }

  /**
   * Overload declaration + loose implementation, the repo's idiom for a generic
   * transport surface: a concrete client cannot return a caller-chosen CdpResult<M>
   * from a concrete body, and a cast to fake it is banned by the lint ratchet.
   */
  send<M extends string>(method: M, params?: object, sessionId?: string, opts?: EgoSendOptions): Promise<CdpResult<M>>;
  async send(method: string, params?: unknown, sessionId?: string, opts: EgoSendOptions = {}): Promise<unknown> {
    if (method === "Target.createTarget" && opts.capability !== targetCreationCapability)
      throw Error("Target.createTarget is reserved for createAgentTabs");
    if (String(method).startsWith("OmO."))
      throw Error(`Extension commands are unavailable over the Ego transport: ${method}`);
    await this.ensureConnected();
    return this.#dispatch(method, params, sessionId, opts);
  }

  #dispatch(method: string, params?: unknown, sessionId?: string, opts: EgoSendOptions = {}): Promise<unknown> {
    if (!this.#connected)
      return Promise.reject(new EgoCdpError("ego_closed", `Ego CDP client is closed: ${method}`, { method }));
    if (sessionId && this.#closedSessions.has(sessionId) && method !== "Page.close") {
      return Promise.reject(new CdpSessionDetachedError(`Page closed: ${method}`, { method, sessionId }));
    }
    const id = this.#seq++;
    const message: { id: number; method: string; params?: unknown; sessionId?: string } = { id, method };
    if (params !== undefined) message.params = params;
    if (sessionId) message.sessionId = sessionId;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timeoutMs = opts.timeoutMs ?? this.#commandTimeoutMs;
    const timeout =
      timeoutMs > 0
        ? setTimeout(() => {
            this.#pending.delete(id);
            reject(
              new CdpCommandTimeoutError(`CDP command timeout: ${method}`, { method, sessionId: sessionId ?? null }),
            );
          }, timeoutMs)
        : undefined;
    this.#pending.set(id, { method, sessionId, resolve, reject, timeout });
    try {
      this.#ego.sendCDPMessage(JSON.stringify(message));
    } catch (error) {
      this.#take(id);
      const errorCode = isObject(error) ? error.error_code : undefined;
      const errorMessage = isObject(error) ? error.message : undefined;
      return Promise.reject(
        new EgoCdpError(String(errorCode ?? "ego_send_failed"), String(errorMessage ?? String(error)), { method }),
      );
    }
    return promise;
  }

  /** Overload declaration + loose body, same idiom as send: no cast needed. */
  on<E extends string>(event: E, handler: (payload: CdpEventPayload<E>, meta: EgoEventMeta) => unknown): () => void;
  on(method: string, fn: (payload: unknown, meta: EgoEventMeta) => unknown) {
    return this.#events.on(method, ({ data }: EgoEvent) => fn(data.payload, data.meta));
  }

  async discoverTargets(): Promise<CdpTargetSummary[]> {
    const result = await this.send("Target.getTargets");
    const targetInfos = isObject(result) ? result.targetInfos : undefined;
    if (!Array.isArray(targetInfos)) throw new TypeError("Target.getTargets returned no targetInfos array");
    return targetInfos.map((t: unknown) => {
      const info = isObject(t) ? t : {};
      return {
        id: stringOr(info.targetId, ""),
        type: stringOr(info.type, ""),
        url: stringOr(info.url, ""),
        title: stringOr(info.title, ""),
        description: stringOr(info.description, undefined),
        faviconUrl: stringOr(info.faviconUrl, undefined),
        parentId: stringOr(info.openerId, undefined),
      };
    });
  }

  closeSession(sessionId: string) {
    this.#closedSessions.add(sessionId);
    this.#failWhere(
      (entry) => entry.sessionId === sessionId,
      (entry) => new CdpSessionDetachedError(`Page closed: ${entry.method}`, { method: entry.method, sessionId }),
    );
  }

  // The user's browser stays open: closing drops this client's callbacks and pending commands only.
  async close() {
    if (!this.#connected) return;
    this.#connected = false;
    if (this.#ego.onCDPMessage === this.#onMessageHandler) this.#ego.onCDPMessage = undefined;
    if (this.#ego.onSendCDPMessageError === this.#onSendErrorHandler) this.#ego.onSendCDPMessageError = undefined;
    this.#failWhere(
      () => true,
      (entry) => new EgoCdpError("ego_closed", `Ego CDP client closed: ${entry.method}`, { method: entry.method }),
    );
    await this.transportEvents.emit("disconnected", undefined).catch(() => {});
  }

  #take(id: number): PendingCommand | null {
    const entry = this.#pending.get(id);
    if (!entry) return null;
    this.#pending.delete(id);
    if (entry.timeout) clearTimeout(entry.timeout);
    return entry;
  }

  #failWhere(match: (entry: PendingCommand) => boolean, makeError: (entry: PendingCommand) => Error) {
    for (const [id, entry] of this.#pending) {
      if (!match(entry)) continue;
      this.#take(id);
      entry.reject(makeError(entry));
    }
  }

  #onSendError(message: string, code?: string) {
    let id: unknown;
    try {
      const parsed: unknown = JSON.parse(message);
      id = isObject(parsed) ? parsed.id : undefined;
    } catch {
      id = undefined;
    }
    const reason = `Ego refused the CDP send (${code ?? "unknown"})`;
    if (typeof id === "number") {
      const entry = this.#take(id);
      if (entry)
        entry.reject(
          new EgoCdpError(code ?? "ego_send_refused", `${reason}: ${entry.method}`, { method: entry.method }),
        );
      return;
    }
    // Without an id to match, every pending command was sent under the same refused task.
    this.#failWhere(
      () => true,
      (entry) => new EgoCdpError(code ?? "ego_send_refused", `${reason}: ${entry.method}`, { method: entry.method }),
    );
  }

  #onMessage(payload: string) {
    let msg: unknown;
    try {
      msg = JSON.parse(payload);
    } catch {
      return undefined;
    }
    if (msg === null) throw new TypeError("Cannot read properties of null (reading 'id')");
    if (!isObject(msg)) return undefined;
    if (typeof msg.id === "number") {
      const entry = this.#take(msg.id);
      if (!entry) return undefined;
      if (msg.error) {
        const cdpError = isObject(msg.error) ? msg.error : {};
        const error = Object.assign(Error(String(cdpError.message ?? `CDP command failed: ${entry.method}`)), {
          code: cdpError.code,
          data: cdpError.data,
        });
        entry.reject(error);
      } else {
        entry.resolve(msg.result);
      }
      return undefined;
    }
    const method = msg.method;
    if (typeof method !== "string") return undefined;
    const params = msg.params;
    const sessionId = sessionIdOf(msg.sessionId);
    const detachedSessionId = isObject(params) ? params.sessionId : undefined;
    if (method === "Target.detachedFromTarget" && detachedSessionId) {
      this.#failWhere(
        (entry) => entry.sessionId === detachedSessionId,
        (entry) =>
          new CdpSessionDetachedError(`CDP session detached: ${entry.method}`, {
            method: entry.method,
            sessionId: detachedSessionId,
          }),
      );
    } else if (method === "Inspector.targetCrashed" && sessionId) {
      // Same as PipeCdpClient: a pending reload brings the target back, everything else fails now.
      this.#failWhere(
        (entry) => entry.sessionId === sessionId && entry.method !== "Page.reload",
        (entry) =>
          new CdpSessionCrashedError(`CDP session crashed: ${entry.method}`, { method: entry.method, sessionId }),
      );
    }
    const meta: EgoEventMeta = { sessionId };
    const dialog =
      method === "Page.javascriptDialogOpening" && sessionId
        ? new Dialog(dialogPolicyParams(params), (action: object | undefined) =>
            this.send("Page.handleJavaScriptDialog", action, sessionId),
          )
        : undefined;
    if (dialog) meta.dialog = dialog;
    const emitted = this.#events.emit(method, { data: { payload: params, meta } }).catch(() => {});
    return dialog
      ? emitted.then(() => answerWithPolicy(dialog, this.#dialogPolicy, dialogPolicyParams(params))).catch(() => {})
      : undefined;
  }
}
