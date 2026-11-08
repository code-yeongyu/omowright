import { spawn, type ChildProcess, type SpawnOptions, type StdioOptions } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type {
  CdpEventMeta,
  CdpEventPayload,
  CdpResult,
  CdpSendOptions,
  CdpTargetInfo,
  CdpTargetSummary,
  CdpTransport,
} from "./cdp-protocol.ts";
import { BrowserConnection } from "./connection.ts";
import type { OmOPage } from "./core.ts";
import {
  normalizeDialogPolicy,
  resolveDialogAction,
  type DialogOpeningParams,
  type DialogPolicy,
} from "./dialog-policy.ts";
import { targetCreationCapability } from "./internal-capability.ts";

class Emittery<D = void> {
  #listeners = new Map<string, Array<(data: D) => unknown>>();
  on(event: string, fn: (data: D) => unknown) {
    const list = this.#listeners.get(event) ?? [];
    list.push(fn);
    this.#listeners.set(event, list);
    return () => {
      const cur = this.#listeners.get(event) ?? [];
      this.#listeners.set(
        event,
        cur.filter((f) => f !== fn),
      );
    };
  }
  async emit(event: string, data: D) {
    for (const fn of this.#listeners.get(event) ?? []) await fn(data);
  }
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
const GRACEFUL_CLOSE_TIMEOUT_MS = 2_000;
const STDIO_TAIL_LIMIT = 16_384;

export interface PipeCdpClientOptions {
  browserPath: string;
  browserArgs?: readonly string[];
  /** Spawn options for the browser process; `stdio` is always owned by the client. */
  spawnOptions?: Omit<SpawnOptions, "stdio">;
  commandTimeoutMs?: number;
  readinessTimeoutMs?: number;
  logId?: string;
  dialogPolicy?: DialogPolicy;
}

export interface ConnectPipeOptions extends PipeCdpClientOptions {
  storageRoot?: string;
}

interface PendingPipeCommand {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout> | undefined;
}

interface PipeEventEnvelope {
  data: { payload: unknown; meta: CdpEventMeta };
}

interface PipeWireCommand {
  id: number;
  method: string;
  params?: object;
  sessionId?: string;
}

/** One NUL-delimited CDP frame as the browser writes it; parsed JSON, so every field is checked before use. */
interface PipeWireMessage {
  id?: unknown;
  method?: unknown;
  sessionId?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
}

/** Chromium's TargetInfo plus the two `/json/list` fields `discoverTargets` has always forwarded when present. */
interface PipeTargetInfo extends CdpTargetInfo {
  description?: string;
  faviconUrl?: string;
}

export class PipeCdpClient implements CdpTransport {
  #child: ChildProcess | undefined;
  #writeStream: Writable | undefined;
  #buffer = Buffer.alloc(0);
  #seq = 1;
  #pending = new Map<number, PendingPipeCommand>();
  #events = new Emittery<PipeEventEnvelope>();
  #connected = false;
  #commandTimeoutMs: number;
  #readinessTimeoutMs: number;
  #browserPath: string;
  #browserArgs: readonly string[];
  #spawnOptions: Omit<SpawnOptions, "stdio">;
  #stdioTail = "";
  #dialogPolicy: ReturnType<typeof normalizeDialogPolicy>;
  transportEvents = new Emittery();
  logId: string;

  constructor({
    browserPath,
    browserArgs = [],
    spawnOptions = {},
    commandTimeoutMs,
    readinessTimeoutMs,
    logId,
    dialogPolicy,
  }: PipeCdpClientOptions) {
    if (!browserPath) throw new TypeError("PipeCdpClient requires browserPath");
    this.#browserPath = browserPath;
    this.#browserArgs = browserArgs;
    this.#spawnOptions = spawnOptions;
    this.#commandTimeoutMs = commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.#readinessTimeoutMs = readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.logId = logId ?? `cdp-pipe-${Date.now()}`;
    this.#dialogPolicy = normalizeDialogPolicy(dialogPolicy);
  }

  get isConnected() {
    return this.#connected;
  }
  get isHeadless() {
    return this.#browserArgs.some((arg) => /^--headless(?:=|$)/.test(arg));
  }
  get childProcess() {
    return this.#child;
  }
  get dialogPolicy() {
    return this.#dialogPolicy;
  }

  setDialogPolicy(policy: DialogPolicy) {
    this.#dialogPolicy = normalizeDialogPolicy(policy);
  }

  async ensureConnected() {
    if (this.#connected) return;
    // Never inherit stdout/stderr: Chromium writes startup noise to both (e.g.
    // the PartitionAlloc shim's "Trying to load the allocator multiple times"
    // line and GoogleUpdater child logs), and inherited fds would spray it raw
    // onto the caller's tty (it corrupted the senpi TUI). Pipe + drain into a
    // bounded tail kept for launch diagnostics.
    const stdio: StdioOptions = ["ignore", "pipe", "pipe", "pipe", "pipe"];
    const child = spawn(this.#browserPath, [...this.#browserArgs, "--remote-debugging-pipe"], {
      ...this.#spawnOptions,
      stdio,
    });
    this.#child = child;
    this.#stdioTail = "";
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        this.#stdioTail = (this.#stdioTail + chunk).slice(-STDIO_TAIL_LIMIT);
      });
      stream.on("error", () => {});
    }
    // fd 3 is the browser's CDP input, fd 4 its output; with "pipe" both are sockets.
    const writeStream = child.stdio[3];
    const readStream = child.stdio[4];
    if (!(writeStream instanceof Writable) || !(readStream instanceof Readable)) {
      throw new TypeError("CDP pipe stdio was not created");
    }
    this.#writeStream = writeStream;
    readStream.on("data", (chunk: Buffer) => this.#onData(chunk));
    // A killed browser resets its end of the CDP pipes (ECONNRESET/EPIPE on Linux);
    // without a listener Node rethrows that as an uncaught exception in the caller.
    for (const stream of [writeStream, readStream]) {
      stream.on("error", (error: NodeJS.ErrnoException) =>
        this.#failAll(Error(`CDP pipe error: ${error.code ?? error.message}`)),
      );
    }
    child.on("exit", () => {
      this.#connected = false;
      this.#failAll(Error("CDP pipe browser exited"));
      this.transportEvents.emit("disconnected").catch(() => {});
    });
    this.#connected = true;
    await this.#awaitReady();
    await this.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
    await this.transportEvents.emit("connected");
  }

  async #awaitReady() {
    const deadline = Date.now() + this.#readinessTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await this.send("Browser.getVersion", undefined, undefined, { timeoutMs: 1000 });
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const lastMessage =
      typeof lastError === "object" && lastError !== null && "message" in lastError ? lastError.message : undefined;
    const reason = lastError ? String(lastMessage ?? lastError) : "no response";
    const tail = this.#stdioTail.trim();
    throw Error(
      `Browser did not become ready over the CDP pipe (${reason})` + (tail ? `\nBrowser stdio tail:\n${tail}` : ""),
    );
  }

  async send<M extends string>(
    method: M,
    params?: object,
    sessionId?: string,
    opts: CdpSendOptions = {},
  ): Promise<CdpResult<M>> {
    if (method === "Target.createTarget" && opts.capability !== targetCreationCapability)
      throw Error("Target.createTarget is reserved for createAgentTabs");
    if (String(method).startsWith("OmO.")) {
      throw Error(`Extension commands are unavailable over pipe transport: ${method}`);
    }
    await this.ensureConnected();
    const id = this.#seq++;
    const msg: PipeWireCommand = { id, method };
    if (params !== undefined) msg.params = params;
    if (sessionId) msg.sessionId = sessionId;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timeoutMs = opts.timeoutMs ?? this.#commandTimeoutMs;
    const timeout =
      timeoutMs > 0
        ? setTimeout(() => {
            this.#pending.delete(id);
            reject(Error(`CDP command timeout: ${method}`));
          }, timeoutMs)
        : undefined;
    this.#pending.set(id, { method, resolve, reject, timeout });
    this.#writeStream?.write(JSON.stringify(msg) + "\0");
    // Wire boundary: the browser's JSON result is trusted to match the protocol table for `method`.
    return promise as Promise<CdpResult<M>>;
  }

  on<E extends string>(method: E, fn: (payload: CdpEventPayload<E>, meta: CdpEventMeta) => unknown) {
    // Wire boundary: the event's JSON params are trusted to match the protocol table for `method`.
    return this.#events.on(method, ({ data }) => fn(data.payload as CdpEventPayload<E>, data.meta));
  }

  async discoverTargets(): Promise<CdpTargetSummary[]> {
    const { targetInfos }: { targetInfos: PipeTargetInfo[] } = await this.send("Target.getTargets");
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

  async close() {
    const child = this.#child;
    this.#child = undefined;
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      if (this.#connected) {
        await Promise.race([
          this.send("Browser.close", undefined, undefined, {
            timeoutMs: GRACEFUL_CLOSE_TIMEOUT_MS,
          }).catch(() => {}),
          exited,
        ]);
      }
      this.#connected = false;
      this.#failAll(Error("CDP pipe client closed"));
      if (child.exitCode === null) {
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, GRACEFUL_CLOSE_TIMEOUT_MS))]);
      }
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {}
        await exited;
      }
      return;
    }
    this.#connected = false;
    this.#failAll(Error("CDP pipe client closed"));
  }

  #onData(chunk: Buffer) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    let idx;
    while ((idx = this.#buffer.indexOf(0)) !== -1) {
      const raw = this.#buffer.subarray(0, idx).toString("utf8");
      this.#buffer = this.#buffer.subarray(idx + 1);
      if (raw.length === 0) continue;
      let msg: PipeWireMessage;
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      this._handleTransportMessage(msg);
    }
  }

  _handleTransportMessage(msg: PipeWireMessage) {
    if (typeof msg.id === "number") {
      const entry = this.#pending.get(msg.id);
      if (!entry) return;
      this.#pending.delete(msg.id);
      if (entry.timeout) clearTimeout(entry.timeout);
      if (msg.error) {
        const err = Object.assign(Error(msg.error.message ?? `CDP command failed: ${entry.method}`), {
          code: msg.error.code,
          data: msg.error.data,
        });
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === "string") {
      const handled =
        msg.method === "Page.javascriptDialogOpening" && msg.sessionId
          ? // Wire boundary: dialog params are trusted to match Page.javascriptDialogOpening.
            this.#handleJavaScriptDialog(msg.params as DialogOpeningParams | undefined, msg.sessionId).catch(() => {})
          : undefined;
      this.#events
        .emit(msg.method, { data: { payload: msg.params, meta: { sessionId: msg.sessionId } } })
        .catch(() => {});
      return handled;
    }
  }

  async #handleJavaScriptDialog(dialog: DialogOpeningParams | undefined, sessionId: string) {
    const params = await resolveDialogAction(this.#dialogPolicy, dialog);
    await this.send("Page.handleJavaScriptDialog", params, sessionId);
  }

  #failAll(err: Error) {
    for (const entry of this.#pending.values()) {
      if (entry.timeout) clearTimeout(entry.timeout);
      entry.reject(err);
    }
    this.#pending.clear();
  }
}

export async function connectPipe(options?: ConnectPipeOptions) {
  // JavaScript callers may omit the options entirely; keep the same TypeError the constructor raises.
  if (!options) throw new TypeError("PipeCdpClient requires browserPath");
  const {
    browserPath,
    browserArgs = [],
    spawnOptions,
    storageRoot,
    commandTimeoutMs,
    readinessTimeoutMs,
    logId,
    dialogPolicy,
  } = options;
  const client = new PipeCdpClient({
    browserPath,
    browserArgs,
    spawnOptions,
    commandTimeoutMs,
    readinessTimeoutMs,
    logId,
    dialogPolicy,
  });
  await client.ensureConnected();
  const connection: BrowserConnection = new BrowserConnection(client, { storageRoot });
  await connection.initialize();
  return Object.assign(connection, {
    browserProcess: client.childProcess,
    newTab: async (url = "about:blank"): Promise<OmOPage> => {
      const { createAgentTabs } = await import("./agent-tabs.ts");
      return (await createAgentTabs(connection).create(url)).page;
    },
  });
}
