// The piped `aside repl` protocol of Aside CLIs up to 1.26.916: a banner, then a `repl > `
// prompt; each stdin line is evaluated on its own and answered with the line's output and
// then a `[ok | Nms]` or `[error | Nms]` marker, and `const` bindings persist for the life
// of the process. Calls must be serialized by the caller.
import { AsideReplError } from "./errors.ts";
import type { AsideChildProcess, AsideTransportInfo, Waiter } from "./session-types.ts";

const CLOSE_TIMEOUT_MS = 5_000;
const PROMPT = "repl > ";
const MARKER = /^\[(ok|error) \| \d+ms\]$/;
// Aside colours its banner, prompt and markers even on a pipe.
// oxlint-disable-next-line no-control-regex -- the pattern exists to strip the ESC byte of ANSI colour codes.
const ANSI = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;
const plain = (text: string) => text.replace(ANSI, "");
// Every call ends with its own result line and then [ok] (errors are caught into the result
// line); page logs can print markers and prompts of their own, so the result line decides.
const finished = (lines: string[], tag: string) =>
  MARKER.test(lines.at(-1) ?? "") && (lines.at(-2) ?? "").startsWith(tag);

export class LineTransport {
  #child: AsideChildProcess;
  #buffer = "";
  #lines: string[] = [];
  #waiter: Waiter | null = null;
  #closed = false;
  #exit: Promise<void>;

  constructor(child: AsideChildProcess) {
    this.#child = child;
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
    child.stdin.on?.("error", (error) => {
      if (error.code !== "EPIPE") {
        this.#settle(
          new AsideReplError("repl_closed", `aside repl stdin failed: ${error.message}`, {
            output: this.#lines.splice(0),
          }),
        );
      }
    });
  }

  async ready(timeoutMs: number): Promise<AsideTransportInfo> {
    const banner = await this.#waitFor((pending) => pending.endsWith(PROMPT), timeoutMs, "repl_start_timeout");
    const info: AsideTransportInfo = {};
    for (const line of banner) {
      const account = /^account: (\S+)/.exec(line)?.[1];
      if (account !== undefined) info.account = account;
      const dir = /^sessionDir: (.+)$/.exec(line)?.[1];
      if (dir !== undefined) info.sessionDir = dir.trim();
    }
    return info;
  }

  async call(line: string, { tag, timeoutMs }: { tag: string; timeoutMs: number }): Promise<string[]> {
    if (this.#closed) throw new AsideReplError("repl_closed", "aside repl session is closed");
    this.#child.stdin.write(`${line}\n`);
    // Page output can contain the prompt text and arrive split right after it, so a call is
    // finished only once its last complete line is the [ok|error] marker and a prompt follows.
    const output = await this.#waitFor(
      (pending, lines) => pending.endsWith(PROMPT) && finished(lines, tag),
      timeoutMs,
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
  }

  async close(): Promise<void> {
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
