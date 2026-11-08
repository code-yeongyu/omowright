// Aside engine: drives the user's Aside browser through one long-lived `aside repl`
// process. Each call is one stdin line; Aside answers with the line's output and
// then a `[ok | Nms]` or `[error | Nms]` marker, and `const` bindings persist for the
// life of the process. A fresh `aside repl "<code>"` per call would start a new
// session every time and lose `page`, so the session keeps one child.
// Only `aside repl` is ever run: `aside exec` hands the task to Aside's own model.
import { spawn as spawnChild } from "node:child_process";
import { randomBytes } from "node:crypto";
import { findSnapshotLines, validateSnapshotOptions } from "../snapshot-diff.ts";
import { asideOnboard } from "./onboard.ts";
import type { AsideOnboardReport } from "./onboard.ts";
import { findAsideBinary } from "./cli-binary.ts";
import type {
  AsideChildProcess,
  AsideReplErrorOptions,
  AsideSessionOptions,
  AsideSnapshotOptions,
  ConnectAsideOptions,
  Waiter,
} from "./session-types.ts";

export { findAsideBinary } from "./cli-binary.ts";

type JsonObject = Readonly<Record<string, unknown>>;
const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null;

const DEFAULT_START_TIMEOUT_MS = 15_000;
// Aside stops a REPL evaluation after 120 s; wait a little longer for its own error.
const DEFAULT_CALL_TIMEOUT_MS = 125_000;
const CLOSE_TIMEOUT_MS = 5_000;
const PROMPT = "repl > ";
const MARKER = /^\[(ok|error) \| \d+ms\]$/;
// Aside colours its banner, prompt and markers even on a pipe.
const ANSI = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;
const plain = (text: string) => text.replace(ANSI, "");
// Every call ends with its own result line and then [ok] (errors are caught into the result
// line); page logs can print markers and prompts of their own, so the result line decides.
const finished = (lines: string[], tag: string) =>
  MARKER.test(lines.at(-1) ?? "") && (lines.at(-2) ?? "").startsWith(tag);

export class AsideReplError extends Error {
  declare code: string;
  declare output: string[];
  declare setup?: AsideOnboardReport;

  constructor(code: string, message: string, { output = [], setup }: AsideReplErrorOptions = {}) {
    super(message);
    this.name = "AsideReplError";
    this.code = code;
    this.output = output;
    if (setup) this.setup = setup;
  }
}

export class AsideSession {
  #child: AsideChildProcess;
  #buffer = "";
  #lines: string[] = [];
  #waiter: Waiter | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  #exit: Promise<void>;
  #callTimeoutMs: number;
  declare engine: "aside";
  declare account: string | null;
  declare sessionDir: string | null;

  constructor(child: AsideChildProcess, { callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS }: AsideSessionOptions = {}) {
    this.#child = child;
    this.#callTimeoutMs = callTimeoutMs;
    this.engine = "aside";
    this.account = null;
    this.sessionDir = null;
    this.#exit = new Promise<void>((resolve) =>
      child.once("exit", (code, signal) => {
        this.#closed = true;
        this.#settle(
          new AsideReplError("repl_closed", `aside repl exited (code ${code}, signal ${signal})`, {
            output: this.#lines.splice(0),
          }),
        );
        resolve();
      }),
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#onData(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => this.#onData(chunk));
    // A write that races the child's death raises EPIPE on stdin. The exit listener above already
    // settles the waiting call with repl_closed, so the stream error is the same event one layer
    // down; without a listener Node treats it as an uncaught exception and takes the host down.
    child.stdin.on?.("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") this.#settle(new AsideReplError("repl_closed", `aside repl stdin failed: ${error.message}`, { output: this.#lines.splice(0) }));
    });
  }

  async ready(timeoutMs = DEFAULT_START_TIMEOUT_MS) {
    const banner = await this.#waitFor((pending) => pending.endsWith(PROMPT), timeoutMs, "repl_start_timeout");
    for (const line of banner) {
      const account = /^account: (\S+)/.exec(line)?.[1];
      if (account !== undefined) this.account = account;
      const dir = /^sessionDir: (.+)$/.exec(line)?.[1];
      if (dir !== undefined) this.sessionDir = dir.trim();
    }
    return this;
  }

  // State the code keeps on globalThis survives between calls; its locals do not.
  async run(code: string): Promise<unknown> {
    return (await this.runWithLogs(code)).value;
  }

  async runWithLogs(code: string): Promise<{ value: unknown; logs: string[] }> {
    if (typeof code !== "string" || code.trim() === "") throw new TypeError("run() needs JavaScript source");
    const tag = `OMOW_RESULT_${randomBytes(6).toString("hex")}:`;
    // One line per call: Aside evaluates each stdin line on its own, so the source travels
    // as a JSON string literal and a direct eval runs it in the REPL's scope (page, tabs, snapshot).
    const body = `(async () => {\n${code}\n})()`;
    const line = `try { const omowValue = await eval(${JSON.stringify(body)}); const omowJson = JSON.stringify(omowValue ?? null); console.log(${JSON.stringify(tag)} + (omowJson === undefined ? '{"unserializable":true}' : '{"value":' + omowJson + '}')); } catch (omowError) { console.log(${JSON.stringify(tag)} + JSON.stringify({ error: String(omowError?.stack ?? omowError) })); }`;
    const output = await this.#call(line, tag);
    const logs: string[] = [];
    let value: unknown;
    let found = false;
    for (const entry of output) {
      if (entry.startsWith(tag)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(entry.slice(tag.length));
        } catch {
          parsed = { unserializable: true };
        }
        const result: JsonObject = isObject(parsed) ? parsed : {};
        if (result.error !== undefined) throw new AsideReplError("repl_error", String(result.error), { output: logs });
        if (result.unserializable)
          throw new AsideReplError(
            "repl_unserializable",
            "the code returned a value with no JSON form (a function, symbol or undefined member); return plain data",
            { output },
          );
        value = result.value;
        found = true;
      } else {
        logs.push(entry);
      }
    }
    if (!found)
      throw new AsideReplError("repl_no_result", "aside repl finished the call without a result line", { output });
    return { value, logs };
  }

  async open(url: string) {
    return this.run(
      `const omowTab = await openTab(${JSON.stringify(String(url))});\nreturn { url: omowTab.url(), title: await omowTab.title() };`,
    );
  }

  // Refs in the tree are Aside refs, valid for page.locator() inside run().
  async snapshot({ find, context, interactive, showHidden, selector, ref }: AsideSnapshotOptions = {}) {
    validateSnapshotOptions({ find, context });
    const options = Object.fromEntries(
      Object.entries({ interactive, showHidden, selector, ref }).filter(([, value]) => value !== undefined),
    );
    const result = await this.run(
      `if (!page) throw new Error("no current page: call open(url) first");\nconst omowSnap = await snapshot(page, ${JSON.stringify(options)});\nreturn { tree: omowSnap.tree, diff: omowSnap.diff };`,
    );
    if (find === undefined) return result;
    const tree = isObject(result) && typeof result.tree === "string" ? result.tree : undefined;
    const found = findSnapshotLines({ tree, refs: {} }, find, context);
    return { tree: found.tree, find: found.find };
  }

  async close() {
    if (this.#closed) return;
    this.#child.stdin.end("exit\n");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), CLOSE_TIMEOUT_MS);
    });
    const late = await Promise.race([this.#exit.then(() => false), timedOut]);
    clearTimeout(timer);
    if (late) {
      this.#child.kill();
      await this.#exit;
    }
  }

  #call(line: string, tag: string): Promise<string[]> {
    const run = this.#queue.then(async () => {
      if (this.#closed) throw new AsideReplError("repl_closed", "aside repl session is closed");
      this.#child.stdin.write(`${line}\n`);
      // Page output can contain the prompt text and arrive split right after it, so a call is
      // finished only once its last complete line is the [ok|error] marker and a prompt follows.
      const output = await this.#waitFor(
        (pending, lines) => pending.endsWith(PROMPT) && finished(lines, tag),
        this.#callTimeoutMs,
        "repl_timeout",
      );
      const markerAt = output.findLastIndex((entry) => MARKER.test(entry));
      if (markerAt === -1)
        throw new AsideReplError("repl_protocol", "aside repl answered without an [ok|error] marker", { output });
      const body = output.slice(0, markerAt);
      if (output[markerAt]?.startsWith("[error")) {
        throw new AsideReplError("repl_error", body.join("\n") || "aside repl reported an error", { output: body });
      }
      return body;
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  #onData(chunk: string) {
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

  #waitFor(isDone: Waiter["isDone"], timeoutMs: number, timeoutCode: string) {
    return new Promise<string[]>((resolve, reject) => {
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

  #settle(error: unknown) {
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
}: ConnectAsideOptions = {}) {
  let command = asideCommand;
  if (!command && autoSetup) {
    const setup = await asideOnboard({ env, account, installOnlyWithApp: true, ...(home ? { home } : {}) });
    if (!setup.ready) throw new AsideReplError("aside_not_ready", String(setup.nextStep), { setup });
    command = [setup.cli.bin];
  }
  command ??= [findAsideBinary({ env, ...(home ? { home } : {}) })];
  const [bin, ...lead] = command;
  if (!bin) {
    throw new AsideReplError(
      "aside_not_found",
      "the Aside CLI is not installed: install it from Aside Settings > Developers, or set ASIDE_BIN",
    );
  }
  const args = [...lead, "repl"];
  if (account) args.push("--account", account);
  if (host) args.push("--host", host);
  const child = spawn(bin, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const spawned = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) =>
      reject(new AsideReplError("repl_start_failed", `could not start aside repl: ${error.message}`)),
    );
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
