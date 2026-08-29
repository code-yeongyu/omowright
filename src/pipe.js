import { spawn } from "node:child_process";
import { BrowserConnection } from "./connection.js";
import { targetCreationCapability } from "./internal-capability.js";

class Emittery {
  #listeners = new Map();
  on(event, fn) {
    const list = this.#listeners.get(event) ?? [];
    list.push(fn);
    this.#listeners.set(event, list);
    return () => {
      const cur = this.#listeners.get(event) ?? [];
      this.#listeners.set(event, cur.filter(f => f !== fn));
    };
  }
  async emit(event, data) {
    for (const fn of this.#listeners.get(event) ?? []) await fn(data);
  }
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
const GRACEFUL_CLOSE_TIMEOUT_MS = 2_000;
const STDIO_TAIL_LIMIT = 16_384;

export class PipeCdpClient {
  #child;
  #writeStream;
  #readStream;
  #buffer = Buffer.alloc(0);
  #seq = 1;
  #pending = new Map();
  #events = new Emittery();
  #connected = false;
  #commandTimeoutMs;
  #readinessTimeoutMs;
  #browserPath;
  #browserArgs;
  #spawnOptions;
  #stdioTail = "";
  transportEvents = new Emittery();
  logId;

  constructor({ browserPath, browserArgs = [], spawnOptions = {}, commandTimeoutMs, readinessTimeoutMs, logId }) {
    if (!browserPath) throw new TypeError("PipeCdpClient requires browserPath");
    this.#browserPath = browserPath;
    this.#browserArgs = browserArgs;
    this.#spawnOptions = spawnOptions;
    this.#commandTimeoutMs = commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.#readinessTimeoutMs = readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.logId = logId ?? `cdp-pipe-${Date.now()}`;
  }

  get isConnected() { return this.#connected; }
  get isHeadless() { return this.#browserArgs.some(arg => /^--headless(?:=|$)/.test(arg)); }
  get childProcess() { return this.#child; }

  async ensureConnected() {
    if (this.#connected) return;
    // Never inherit stdout/stderr: Chromium writes startup noise to both (e.g.
    // the PartitionAlloc shim's "Trying to load the allocator multiple times"
    // line and GoogleUpdater child logs), and inherited fds would spray it raw
    // onto the caller's tty (it corrupted the senpi TUI). Pipe + drain into a
    // bounded tail kept for launch diagnostics.
    const stdio = ["ignore", "pipe", "pipe", "pipe", "pipe"];
    this.#child = spawn(this.#browserPath, [...this.#browserArgs, "--remote-debugging-pipe"], {
      ...this.#spawnOptions,
      stdio,
    });
    this.#stdioTail = "";
    for (const stream of [this.#child.stdout, this.#child.stderr]) {
      if (!stream) continue;
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        this.#stdioTail = (this.#stdioTail + chunk).slice(-STDIO_TAIL_LIMIT);
      });
      stream.on("error", () => {});
    }
    this.#writeStream = this.#child.stdio[3];
    this.#readStream = this.#child.stdio[4];
    this.#readStream.on("data", chunk => this.#onData(chunk));
    this.#child.on("exit", () => {
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
    let lastError;
    while (Date.now() < deadline) {
      try {
        await this.send("Browser.getVersion", undefined, undefined, { timeoutMs: 1000 });
        return;
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    const reason = lastError ? String(lastError.message ?? lastError) : "no response";
    const tail = this.#stdioTail.trim();
    throw Error(
      `Browser did not become ready over the CDP pipe (${reason})` +
      (tail ? `\nBrowser stdio tail:\n${tail}` : ""),
    );
  }

  async send(method, params, sessionId, opts = {}) {
    if (method === "Target.createTarget" && opts.capability !== targetCreationCapability) throw Error("Target.createTarget is reserved for createAgentTabs");
    if (String(method).startsWith("Aside.")) {
      throw Error(`Aside.* extension commands are unavailable over pipe transport: ${method}`);
    }
    await this.ensureConnected();
    const id = this.#seq++;
    const msg = { id, method };
    if (params !== undefined) msg.params = params;
    if (sessionId) msg.sessionId = sessionId;
    const { promise, resolve, reject } = Promise.withResolvers();
    const timeoutMs = opts.timeoutMs ?? this.#commandTimeoutMs;
    const timeout = timeoutMs > 0
      ? setTimeout(() => { this.#pending.delete(id); reject(Error(`CDP command timeout: ${method}`)); }, timeoutMs)
      : undefined;
    this.#pending.set(id, { method, resolve, reject, timeout });
    this.#writeStream.write(JSON.stringify(msg) + "\0");
    return promise;
  }

  on(method, fn) {
    return this.#events.on(method, ({ data }) => fn(data.payload, data.meta));
  }

  async discoverTargets() {
    const { targetInfos } = await this.send("Target.getTargets");
    return targetInfos.map(t => ({
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
      const exited = new Promise(resolve => child.once("exit", resolve));
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
        await Promise.race([
          exited,
          new Promise(resolve => setTimeout(resolve, GRACEFUL_CLOSE_TIMEOUT_MS)),
        ]);
      }
      if (child.exitCode === null) {
        try { child.kill("SIGKILL"); } catch {}
        await exited;
      }
      return;
    }
    this.#connected = false;
    this.#failAll(Error("CDP pipe client closed"));
  }

  #onData(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    let idx;
    while ((idx = this.#buffer.indexOf(0)) !== -1) {
      const raw = this.#buffer.subarray(0, idx).toString("utf8");
      this.#buffer = this.#buffer.subarray(idx + 1);
      if (raw.length === 0) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      this.#route(msg);
    }
  }

  #route(msg) {
    if (typeof msg.id === "number") {
      const entry = this.#pending.get(msg.id);
      if (!entry) return;
      this.#pending.delete(msg.id);
      if (entry.timeout) clearTimeout(entry.timeout);
      if (msg.error) {
        const err = Error(msg.error.message ?? `CDP command failed: ${entry.method}`);
        err.code = msg.error.code;
        err.data = msg.error.data;
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === "string") {
      if (msg.method === "Page.javascriptDialogOpening" && msg.sessionId) {
        this.send("Page.handleJavaScriptDialog", { accept: true }, msg.sessionId).catch(() => {});
      }
      this.#events.emit(msg.method, { data: { payload: msg.params, meta: { sessionId: msg.sessionId } } }).catch(() => {});
    }
  }

  #failAll(err) {
    for (const entry of this.#pending.values()) {
      if (entry.timeout) clearTimeout(entry.timeout);
      entry.reject(err);
    }
    this.#pending.clear();
  }
}

export async function connectPipe({ browserPath, browserArgs = [], spawnOptions, storageRoot, commandTimeoutMs, readinessTimeoutMs, logId } = {}) {
  const client = new PipeCdpClient({ browserPath, browserArgs, spawnOptions, commandTimeoutMs, readinessTimeoutMs, logId });
  await client.ensureConnected();
  const connection = new BrowserConnection(client, { storageRoot });
  await connection.initialize();
  connection.browserProcess = client.childProcess;
  connection.newTab = async (url = "about:blank") => {
    const { createAgentTabs } = await import("./agent-tabs.js");
    return (await createAgentTabs(connection).create(url)).page;
  };
  return connection;
}
