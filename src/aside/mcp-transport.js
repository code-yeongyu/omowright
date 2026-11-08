// The REPL session behind `aside mcp`, for Aside CLIs whose piped `aside repl` runs stdin as one
// script at EOF (1.26.1107 on). `aside mcp` is an MCP (JSON-RPC 2.0) server on stdio; its `repl`
// tool runs code in one REPL session the server keeps for the life of the process, so `page`,
// tabs and globals persist between calls as they did in a line-protocol `aside repl`. A tool
// result's text parts are the call's console output. Calls must be serialized by the caller.
import { AsideReplError } from "./errors.js";

const PROTOCOL_VERSION = "2025-06-18";
const CLOSE_TIMEOUT_MS = 5_000;
// After SIGTERM, how long `aside mcp` gets to exit before SIGKILL.
const KILL_GRACE_MS = 2_000;
const STDERR_LINES = 50;

export class McpTransport {
  #child;
  #buffer = "";
  #nextId = 1;
  #pending = new Map();
  #stderr = [];
  #closed = false;
  #exited = false;
  #terminated = false;
  #exit;

  constructor(child) {
    this.#child = child;
    this.#exit = new Promise((resolve) => child.once("exit", (code, signal) => {
      this.#closed = true;
      this.#exited = true;
      const error = new AsideReplError("repl_closed", `aside mcp exited (code ${code}, signal ${signal})`, { output: this.#stderr.splice(0) });
      for (const { reject, timer } of this.#pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      this.#pending.clear();
      resolve();
    }));
    // A write after the CLI died fails with EPIPE; the exit handler above already failed the call.
    child.stdin.on?.("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#onData(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      this.#stderr.push(...chunk.split(/\r?\n/).filter(Boolean));
      this.#stderr.splice(0, Math.max(0, this.#stderr.length - STDERR_LINES));
    });
  }

  async ready(timeoutMs) {
    const init = await this.#request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "omowright", version: "1" } }, timeoutMs, "repl_start_timeout");
    this.#send({ method: "notifications/initialized" });
    const version = init?.serverInfo?.version ?? "of unknown version";
    const listed = await this.#request("tools/list", {}, timeoutMs, "repl_start_timeout");
    if (!(listed?.tools ?? []).some((tool) => tool.name === "repl")) {
      throw new AsideReplError("repl_unsupported_cli", `Aside CLI ${version} runs a piped \`aside repl\` as one script at EOF and its \`aside mcp\` has no repl tool, so omowright cannot keep a REPL session with it; update the Aside CLI (\`aside --update\`)`);
    }
    // Start the REPL session now, so an Aside that cannot run code fails the connect, not the first call.
    try {
      await this.call("void 0", { timeoutMs, timeoutCode: "repl_start_timeout" });
    } catch (error) {
      if (error.code !== "repl_error") throw error;
      throw new AsideReplError("repl_start_failed", `aside mcp could not start a REPL session: ${error.message}`, { output: error.output });
    }
    return { version };
  }

  async call(code, { timeoutMs, timeoutCode = "repl_timeout" }) {
    const result = await this.#request("tools/call", { name: "repl", arguments: { title: "omowright", code } }, timeoutMs, timeoutCode);
    const output = (result?.content ?? [])
      .filter((part) => part.type === "text" && part.text)
      .flatMap((part) => part.text.replace(/\r?\n$/, "").split(/\r?\n/));
    if (result?.isError) throw new AsideReplError("repl_error", output.join("\n") || "aside repl reported an error", { output });
    return output;
  }

  // Closing stdin ends `aside mcp`, which closes its REPL session on the way out. close() returns
  // only once the process is gone: SIGTERM if stdin EOF did not end it (or a call timeout already
  // sent it), then SIGKILL for a CLI that ignores SIGTERM.
  async close() {
    this.#closed = true;
    if (this.#exited) return;
    if (!this.#terminated) {
      this.#child.stdin.end();
      if (await this.#exitsWithin(CLOSE_TIMEOUT_MS)) return;
      this.#terminate();
    }
    if (await this.#exitsWithin(KILL_GRACE_MS)) return;
    this.#child.kill("SIGKILL");
    await this.#exit;
  }

  async #exitsWithin(ms) {
    let timer;
    const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); });
    const exited = await Promise.race([this.#exit.then(() => true), timedOut]);
    clearTimeout(timer);
    return exited;
  }

  #terminate() {
    this.#terminated = true;
    this.#child.stdin.end();
    this.#child.kill();
  }

  #send(message) {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  #request(method, params, timeoutMs, timeoutCode) {
    if (this.#closed) return Promise.reject(new AsideReplError("repl_closed", "aside repl session is closed"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        // A call that never finished leaves the REPL mid-evaluation; nothing after it can be trusted.
        this.#closed = true;
        this.#terminate();
        reject(new AsideReplError(timeoutCode, `aside mcp did not answer ${method} within ${timeoutMs} ms`, { output: this.#stderr.splice(0) }));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      this.#send({ id, method, params });
    });
  }

  #onData(chunk) {
    this.#buffer += chunk;
    let newline;
    while ((newline = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message === null || typeof message !== "object") continue;
      // The server's own requests share no id space with ours: answer them, never settle a call.
      if (message.method !== undefined) {
        this.#answer(message);
        continue;
      }
      if (!("result" in message) && !("error" in message)) continue;
      const pending = this.#pending.get(message.id);
      if (!pending) continue;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new AsideReplError("repl_protocol", `aside mcp refused ${pending.method}: ${message.error.message ?? JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
    }
  }

  // JSON-RPC: a request with an id gets a response; `ping` gets an empty result, any other method
  // (omowright declares no client capabilities) gets method-not-found. Notifications get nothing.
  #answer({ id, method }) {
    if (id === undefined || id === null || this.#closed) return;
    if (method === "ping") this.#send({ id, result: {} });
    else this.#send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}
