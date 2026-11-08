// CDP over Ego Lite's native bindings (globalThis.ego inside `ego-browser nodejs`).
// ego.sendCDPMessage takes JSON text for a browser-level CDP session with flattened
// target sessions, answers through ego.onCDPMessage, and reports sends it refused before
// they reached CDP (user control, no task space) through ego.onSendCDPMessageError.
import { BrowserConnection } from "../connection.js";
import { Dialog, answerWithPolicy, normalizeDialogPolicy } from "../dialog-policy.js";
import { SerialEmitter as Emittery } from "../serial-emitter.js";
import { CdpCommandTimeoutError, CdpSessionCrashedError, CdpSessionDetachedError } from "../cdp-errors.js";
import { randomInt } from "node:crypto";
import { targetCreationCapability } from "../internal-capability.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export class EgoCdpError extends Error {
  constructor(code, message, { method } = {}) {
    super(message);
    this.name = "EgoCdpError";
    this.code = code;
    if (method) this.method = method;
  }
}

export class EgoCdpClient {
  #ego;
  // CDP ids are int32; a random base keeps two clients on one Ego session from reusing an id.
  #seq = randomInt(1, 2 ** 30);
  #onMessageHandler = (payload) => this.#onMessage(payload);
  #onSendErrorHandler = (message, code) => this.#onSendError(message, code);
  #pending = new Map();
  #closedSessions = new Set();
  #events = new Emittery();
  #connected = false;
  #commandTimeoutMs;
  #dialogPolicy;
  transportEvents = new Emittery();
  logId;
  isHeadless = false;

  constructor({ ego = globalThis.ego, commandTimeoutMs, logId, dialogPolicy } = {}) {
    if (!ego || typeof ego.sendCDPMessage !== "function") {
      throw new EgoCdpError("ego_unavailable", "Ego Lite bindings are unavailable: run inside `ego-browser nodejs`, or pass { ego }");
    }
    this.#ego = ego;
    this.#commandTimeoutMs = commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.logId = logId ?? `cdp-ego-${Date.now()}`;
    this.#dialogPolicy = normalizeDialogPolicy(dialogPolicy);
  }

  get isConnected() { return this.#connected; }
  get dialogPolicy() { return this.#dialogPolicy; }

  setDialogPolicy(policy) {
    this.#dialogPolicy = normalizeDialogPolicy(policy);
  }

  async ensureConnected() {
    if (this.#connected) return;
    if (this.#ego.onCDPMessage || this.#ego.onSendCDPMessageError) {
      throw new EgoCdpError("ego_busy", "another client already holds Ego's CDP callbacks in this runtime; close it first");
    }
    this.#ego.onCDPMessage = this.#onMessageHandler;
    this.#ego.onSendCDPMessageError = this.#onSendErrorHandler;
    this.#connected = true;
    await this.#dispatch("Target.setDiscoverTargets", { discover: true }).catch(() => {});
    await this.transportEvents.emit("connected");
  }

  async send(method, params, sessionId, opts = {}) {
    if (method === "Target.createTarget" && opts.capability !== targetCreationCapability) throw Error("Target.createTarget is reserved for createAgentTabs");
    if (String(method).startsWith("OmO.")) throw Error(`Extension commands are unavailable over the Ego transport: ${method}`);
    await this.ensureConnected();
    return this.#dispatch(method, params, sessionId, opts);
  }

  #dispatch(method, params, sessionId, opts = {}) {
    if (!this.#connected) return Promise.reject(new EgoCdpError("ego_closed", `Ego CDP client is closed: ${method}`, { method }));
    if (sessionId && this.#closedSessions.has(sessionId) && method !== "Page.close") {
      return Promise.reject(new CdpSessionDetachedError(`Page closed: ${method}`, { method, sessionId }));
    }
    const id = this.#seq++;
    const message = { id, method };
    if (params !== undefined) message.params = params;
    if (sessionId) message.sessionId = sessionId;
    const { promise, resolve, reject } = Promise.withResolvers();
    const timeoutMs = opts.timeoutMs ?? this.#commandTimeoutMs;
    const timeout = timeoutMs > 0
      ? setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpCommandTimeoutError(`CDP command timeout: ${method}`, { method, sessionId: sessionId ?? null }));
      }, timeoutMs)
      : undefined;
    this.#pending.set(id, { method, sessionId, resolve, reject, timeout });
    try {
      this.#ego.sendCDPMessage(JSON.stringify(message));
    } catch (error) {
      this.#take(id);
      return Promise.reject(new EgoCdpError(error?.error_code ?? "ego_send_failed", error?.message ?? String(error), { method }));
    }
    return promise;
  }

  on(method, fn) {
    return this.#events.on(method, ({ data }) => fn(data.payload, data.meta));
  }

  async discoverTargets() {
    const { targetInfos } = await this.send("Target.getTargets");
    return targetInfos.map((t) => ({
      id: t.targetId,
      type: t.type,
      url: t.url ?? "",
      title: t.title ?? "",
      description: t.description,
      faviconUrl: t.faviconUrl,
      parentId: t.openerId,
    }));
  }

  closeSession(sessionId) {
    this.#closedSessions.add(sessionId);
    this.#failWhere((entry) => entry.sessionId === sessionId, (entry) => new CdpSessionDetachedError(`Page closed: ${entry.method}`, { method: entry.method, sessionId }));
  }

  // The user's browser stays open: closing drops this client's callbacks and pending commands only.
  async close() {
    if (!this.#connected) return;
    this.#connected = false;
    if (this.#ego.onCDPMessage === this.#onMessageHandler) this.#ego.onCDPMessage = undefined;
    if (this.#ego.onSendCDPMessageError === this.#onSendErrorHandler) this.#ego.onSendCDPMessageError = undefined;
    this.#failWhere(() => true, (entry) => new EgoCdpError("ego_closed", `Ego CDP client closed: ${entry.method}`, { method: entry.method }));
    await this.transportEvents.emit("disconnected").catch(() => {});
  }

  #take(id) {
    const entry = this.#pending.get(id);
    if (!entry) return null;
    this.#pending.delete(id);
    if (entry.timeout) clearTimeout(entry.timeout);
    return entry;
  }

  #failWhere(match, makeError) {
    for (const [id, entry] of this.#pending) {
      if (!match(entry)) continue;
      this.#take(id);
      entry.reject(makeError(entry));
    }
  }

  #onSendError(message, code) {
    let id;
    try { id = JSON.parse(message)?.id; } catch { id = undefined; }
    const reason = `Ego refused the CDP send (${code ?? "unknown"})`;
    if (typeof id === "number") {
      const entry = this.#take(id);
      if (entry) entry.reject(new EgoCdpError(code ?? "ego_send_refused", `${reason}: ${entry.method}`, { method: entry.method }));
      return;
    }
    // Without an id to match, every pending command was sent under the same refused task.
    this.#failWhere(() => true, (entry) => new EgoCdpError(code ?? "ego_send_refused", `${reason}: ${entry.method}`, { method: entry.method }));
  }

  #onMessage(payload) {
    let msg;
    try { msg = JSON.parse(payload); } catch { return undefined; }
    if (typeof msg.id === "number") {
      const entry = this.#take(msg.id);
      if (!entry) return undefined;
      if (msg.error) {
        const error = Error(msg.error.message ?? `CDP command failed: ${entry.method}`);
        error.code = msg.error.code;
        error.data = msg.error.data;
        entry.reject(error);
      } else {
        entry.resolve(msg.result);
      }
      return undefined;
    }
    if (typeof msg.method !== "string") return undefined;
    if (msg.method === "Target.detachedFromTarget" && msg.params?.sessionId) {
      const sessionId = msg.params.sessionId;
      this.#failWhere((entry) => entry.sessionId === sessionId, (entry) => new CdpSessionDetachedError(`CDP session detached: ${entry.method}`, { method: entry.method, sessionId }));
    } else if (msg.method === "Inspector.targetCrashed" && msg.sessionId) {
      // Same as PipeCdpClient: a pending reload brings the target back, everything else fails now.
      this.#failWhere((entry) => entry.sessionId === msg.sessionId && entry.method !== "Page.reload", (entry) => new CdpSessionCrashedError(`CDP session crashed: ${entry.method}`, { method: entry.method, sessionId: msg.sessionId }));
    }
    const meta = { sessionId: msg.sessionId };
    if (msg.method === "Page.javascriptDialogOpening" && msg.sessionId) {
      meta.dialog = new Dialog(msg.params, (action) => this.send("Page.handleJavaScriptDialog", action, msg.sessionId));
    }
    const emitted = this.#events.emit(msg.method, { data: { payload: msg.params, meta } }).catch(() => {});
    return meta.dialog ? emitted.then(() => answerWithPolicy(meta.dialog, this.#dialogPolicy, msg.params)).catch(() => {}) : undefined;
  }
}

// Ego sends raw CDP only for the task space the script selected and the agent owns. By default a
// new agent task space is created; pass `taskSpace` (a numeric id the agent already claimed) to reuse one.
async function selectTaskSpace(ego, { taskSpace, taskName, profileId }) {
  if (taskSpace !== undefined) {
    if (!Number.isInteger(taskSpace)) throw new TypeError("taskSpace is Ego's numeric task-space id (ego.listTaskSpaces()[i].id)");
    ego.useTaskSpace(taskSpace);
    return { id: taskSpace };
  }
  if (typeof ego.createTaskSpace !== "function" || typeof ego.useTaskSpace !== "function") {
    throw new EgoCdpError("ego_task_space_unsupported", "this Ego runtime has no createTaskSpace/useTaskSpace; pass taskSpace with an id the agent already claimed");
  }
  const created = await ego.createTaskSpace(taskName ?? `omowright-${Date.now()}`, ...(profileId ? [profileId] : []));
  if (!created || created.error) {
    throw new EgoCdpError(created?.error_code ?? "ego_task_space_failed", `Ego could not create a task space: ${created?.error ?? "no result"}`);
  }
  ego.useTaskSpace(created.id);
  return created;
}

export async function connectEgo({ ego = globalThis.ego, taskSpace, taskName, profileId, storageRoot, commandTimeoutMs, logId, dialogPolicy } = {}) {
  const client = new EgoCdpClient({ ego, commandTimeoutMs, logId, dialogPolicy });
  const space = await selectTaskSpace(ego, { taskSpace, taskName, profileId });
  await client.ensureConnected();
  const connection = new BrowserConnection(client, { storageRoot });
  await connection.initialize();
  connection.engine = "ego";
  connection.taskSpace = space;
  return connection;
}
