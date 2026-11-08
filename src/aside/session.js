// Aside engine: drives the user's Aside browser through one long-lived `aside repl`
// process. Each call is one stdin line; Aside answers with the line's output and
// then a `[ok | Nms]` or `[error | Nms]` marker, and `const` bindings persist for the
// life of the process. A fresh `aside repl "<code>"` per call would start a new
// session every time and lose `page`, so the session keeps one child.
// Only `aside repl` is ever run: `aside exec` hands the task to Aside's own model.
import { spawn as spawnChild } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { findSnapshotLines, validateSnapshotOptions } from "../snapshot-diff.js";
import { asideOnboard } from "./onboard.js";

const DEFAULT_START_TIMEOUT_MS = 15_000;
// Aside stops a REPL evaluation after 120 s; wait a little longer for its own error.
const DEFAULT_CALL_TIMEOUT_MS = 125_000;
const CLOSE_TIMEOUT_MS = 5_000;
const PROMPT = "repl > ";
const MARKER = /^\[(ok|error) \| \d+ms\]$/;
// Aside colours its banner, prompt and markers even on a pipe.
const ANSI = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;
const plain = (text) => text.replace(ANSI, "");

export class AsideReplError extends Error {
  constructor(code, message, { output = [], setup } = {}) {
    super(message);
    this.name = "AsideReplError";
    this.code = code;
    this.output = output;
    if (setup) this.setup = setup;
  }
}

export function findAsideBinary({ env = process.env, home = homedir(), exists = existsSync } = {}) {
  if (env.ASIDE_BIN) return env.ASIDE_BIN;
  const candidates = [path.join(home, ".local", "bin", process.platform === "win32" ? "aside.exe" : "aside")];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, process.platform === "win32" ? "aside.exe" : "aside"));
  }
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

export class AsideSession {
  #child;
  #buffer = "";
  #lines = [];
  #waiter = null;
  #queue = Promise.resolve();
  #closed = false;
  #exit;
  #callTimeoutMs;

  constructor(child, { callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS } = {}) {
    this.#child = child;
    this.#callTimeoutMs = callTimeoutMs;
    this.engine = "aside";
    this.account = null;
    this.sessionDir = null;
    this.#exit = new Promise((resolve) => child.once("exit", (code, signal) => {
      this.#closed = true;
      this.#settle(new AsideReplError("repl_closed", `aside repl exited (code ${code}, signal ${signal})`, { output: this.#lines.splice(0) }));
      resolve();
    }));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#onData(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => this.#onData(chunk));
  }

  async ready(timeoutMs = DEFAULT_START_TIMEOUT_MS) {
    const banner = await this.#waitFor((pending) => pending.endsWith(PROMPT), timeoutMs, "repl_start_timeout");
    for (const line of banner) {
      const account = /^account: (\S+)/.exec(line);
      if (account) this.account = account[1];
      const dir = /^sessionDir: (.+)$/.exec(line);
      if (dir) this.sessionDir = dir[1].trim();
    }
    return this;
  }

  // State the code keeps on globalThis survives between calls; its locals do not.
  async run(code) {
    return (await this.runWithLogs(code)).value;
  }

  async runWithLogs(code) {
    if (typeof code !== "string" || code.trim() === "") throw new TypeError("run() needs JavaScript source");
    const tag = `OMOW_RESULT_${randomBytes(6).toString("hex")}:`;
    // One line per call: Aside evaluates each stdin line on its own, so the source travels
    // as a JSON string literal and a direct eval runs it in the REPL's scope (page, tabs, snapshot).
    const body = `(async () => {\n${code}\n})()`;
    const line = `console.log(${JSON.stringify(tag)} + JSON.stringify((await eval(${JSON.stringify(body)})) ?? null))`;
    const output = await this.#call(line);
    const logs = [];
    let value;
    let found = false;
    for (const entry of output) {
      if (entry.startsWith(tag)) {
        try {
          value = JSON.parse(entry.slice(tag.length));
        } catch {
          throw new AsideReplError("repl_unserializable", "the code returned a value with no JSON form (a function, symbol or undefined member); return plain data", { output });
        }
        found = true;
      } else {
        logs.push(entry);
      }
    }
    if (!found) throw new AsideReplError("repl_no_result", "aside repl finished the call without a result line", { output });
    return { value, logs };
  }

  async open(url) {
    return this.run(`const omowTab = await openTab(${JSON.stringify(String(url))});\nreturn { url: omowTab.url(), title: await omowTab.title() };`);
  }

  // Refs in the tree are Aside refs, valid for page.locator() inside run().
  async snapshot({ find, context, interactive, showHidden, selector, ref } = {}) {
    validateSnapshotOptions({ find, context });
    const options = Object.fromEntries(Object.entries({ interactive, showHidden, selector, ref }).filter(([, value]) => value !== undefined));
    const result = await this.run(`if (!page) throw new Error("no current page: call open(url) first");\nconst omowSnap = await snapshot(page, ${JSON.stringify(options)});\nreturn { tree: omowSnap.tree, diff: omowSnap.diff };`);
    if (find === undefined) return result;
    const found = findSnapshotLines({ tree: result.tree, refs: {} }, find, context);
    return { tree: found.tree, find: found.find };
  }

  async close() {
    if (this.#closed) return;
    this.#child.stdin.end("exit\n");
    let timer;
    const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(true), CLOSE_TIMEOUT_MS); });
    const late = await Promise.race([this.#exit.then(() => false), timedOut]);
    clearTimeout(timer);
    if (late) {
      this.#child.kill();
      await this.#exit;
    }
  }

  #call(line) {
    const run = this.#queue.then(async () => {
      if (this.#closed) throw new AsideReplError("repl_closed", "aside repl session is closed");
      this.#child.stdin.write(`${line}\n`);
      // Page output can contain the prompt text and arrive split right after it, so a call is
      // finished only once its last complete line is the [ok|error] marker and a prompt follows.
      const output = await this.#waitFor((pending, lines) => pending.endsWith(PROMPT) && MARKER.test(lines.at(-1) ?? ""), this.#callTimeoutMs, "repl_timeout");
      const markerAt = output.findLastIndex((entry) => MARKER.test(entry));
      if (markerAt === -1) throw new AsideReplError("repl_protocol", "aside repl answered without an [ok|error] marker", { output });
      const body = output.slice(0, markerAt);
      if (output[markerAt].startsWith("[error")) {
        throw new AsideReplError("repl_error", body.join("\n") || "aside repl reported an error", { output: body });
      }
      return body;
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  #onData(chunk) {
    this.#buffer += chunk;
    let newline;
    while ((newline = this.#buffer.indexOf("\n")) !== -1) {
      let line = plain(this.#buffer.slice(0, newline)).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      while (line.startsWith(PROMPT)) line = line.slice(PROMPT.length);
      this.#lines.push(line);
    }
    this.#check();
  }

  #waitFor(isDone, timeoutMs, timeoutCode) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiter = null;
        const output = this.#lines.splice(0);
        reject(new AsideReplError(timeoutCode, `aside repl did not answer within ${timeoutMs} ms`, { output }));
        // A call that never finished leaves the REPL mid-evaluation; nothing after it can be trusted.
        this.#child.kill();
      }, timeoutMs);
      this.#waiter = { isDone, resolve, reject, timer };
      this.#check();
    });
  }

  #check() {
    const waiter = this.#waiter;
    if (!waiter || !waiter.isDone(plain(this.#buffer), this.#lines)) return;
    this.#waiter = null;
    clearTimeout(waiter.timer);
    this.#buffer = "";
    waiter.resolve(this.#lines.splice(0));
  }

  #settle(error) {
    const waiter = this.#waiter;
    if (!waiter) return;
    this.#waiter = null;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}

export async function connectAside({
  account,
  host,
  asideCommand,
  autoSetup = true,
  env = process.env,
  home,
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  spawn = spawnChild,
} = {}) {
  let command = asideCommand;
  if (!command && autoSetup) {
    const setup = await asideOnboard({ env, account, installOnlyWithApp: true, ...(home ? { home } : {}) });
    if (!setup.ready) throw new AsideReplError("aside_not_ready", setup.nextStep, { setup });
    command = [setup.cli.bin];
  }
  command ??= [findAsideBinary({ env, ...(home ? { home } : {}) })];
  if (!command[0]) {
    throw new AsideReplError("aside_not_found", "the Aside CLI is not installed: install it from Aside Settings > Developers, or set ASIDE_BIN");
  }
  const args = [...command.slice(1), "repl"];
  if (account) args.push("--account", account);
  if (host) args.push("--host", host);
  const child = spawn(command[0], args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const spawned = new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) => reject(new AsideReplError("repl_start_failed", `could not start aside repl: ${error.message}`)));
  });
  await spawned;
  const session = new AsideSession(child, { callTimeoutMs });
  try {
    return await session.ready(startTimeoutMs);
  } catch (error) {
    child.kill();
    throw error;
  }
}
