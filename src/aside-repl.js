import { spawn } from "node:child_process";

export const ASIDE_REPL_TIMEOUT_MS = 125_000;

const ANSI_ESCAPE = /\u001B\[[0-9;]*m/g;
const RESULT_MARKER = /^\[(ok|error) \| (\d+)ms\]$/;

export class AsideUnavailable extends Error {
  constructor(message, { bin } = {}) {
    super(message);
    this.name = "AsideUnavailable";
    this.bin = bin;
  }
}

export class AsideReplError extends Error {
  constructor(message, { output = "", code = null } = {}) {
    super(message);
    this.name = "AsideReplError";
    this.output = output;
    this.code = code;
  }
}

/**
 * `aside repl` prints a trailing `[ok | 12ms]` / `[error | 16ms]` marker and
 * exits 0 either way, so the exit code alone never reports a failed script.
 */
export function parseAsideRepl(stdout, exitCode = 0) {
  const lines = String(stdout ?? "")
    .replace(ANSI_ESCAPE, "")
    .split("\n")
    .map((line) => line.trimEnd());
  const markerAt = lines.findIndex((line) => RESULT_MARKER.test(line.trim()));
  const marker = markerAt === -1 ? null : RESULT_MARKER.exec(lines[markerAt].trim());
  const body = (markerAt === -1 ? lines : lines.slice(0, markerAt)).filter((line) => line.trim() !== "");
  const status = marker ? marker[1] : exitCode === 0 ? "unknown" : "error";
  return {
    status,
    ok: status === "ok",
    ms: marker ? Number(marker[2]) : null,
    output: body.join("\n"),
    lines: body,
  };
}

export function runAside({
  bin = "aside",
  args = [],
  timeoutMs = ASIDE_REPL_TIMEOUT_MS,
  env = process.env,
  spawnProcess = spawn,
} = {}) {
  const [command, ...prefix] = Array.isArray(bin) ? bin : [bin];
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawnProcess(command, [...prefix, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      windowsHide: true,
    });
    child.stdout?.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-1_000_000);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-1_000_000);
    });
    child.on("error", (error) => {
      resolve({ code: -1, signal: null, timedOut: false, stdout, stderr: stderr || error.message });
    });
    child.on("close", (code, signal) => {
      resolve({ code, signal, timedOut: signal === "SIGTERM", stdout, stderr });
    });
  });
}

export async function asideAvailable({
  bin = "aside",
  timeoutMs = 10_000,
  runProcess = runAside,
} = {}) {
  const result = await runProcess({ bin, args: ["--version"], timeoutMs });
  const version = result.stdout.trim();
  if (result.code !== 0 || version === "") {
    return {
      available: false,
      bin,
      version: null,
      reason: (result.stderr.trim() || `aside --version exited ${result.code}`).split("\n")[0],
    };
  }
  return { available: true, bin, version, reason: null };
}

export class AsideRepl {
  #bin;
  #host;
  #account;
  #timeoutMs;
  #runProcess;

  constructor({ bin, host, account, timeoutMs, runProcess }) {
    this.#bin = bin;
    this.#host = host;
    this.#account = account;
    this.#timeoutMs = timeoutMs;
    this.#runProcess = runProcess;
  }

  get engine() {
    return "aside";
  }

  #argv(code) {
    const scoped = [];
    if (this.#host) scoped.push("--host", this.#host);
    if (this.#account) scoped.push("--account", this.#account);
    return ["repl", ...scoped, code];
  }

  async run(code) {
    if (typeof code !== "string" || code.trim() === "") {
      throw new AsideReplError("aside repl needs the JavaScript to run as its argument");
    }
    const result = await this.#runProcess({
      bin: this.#bin,
      args: this.#argv(code),
      timeoutMs: this.#timeoutMs,
    });
    return {
      ...parseAsideRepl(result.stdout, result.code),
      code: result.code,
      stderr: result.stderr,
      timedOut: result.timedOut,
    };
  }

  async title(url) {
    if (typeof url !== "string" || url === "") {
      throw new AsideReplError("title(url) needs a URL");
    }
    const result = await this.run(
      `const page = await openTab(${JSON.stringify(url)}); console.log(await page.title());`,
    );
    if (!result.ok) {
      throw new AsideReplError(
        `aside repl failed for ${url}: ${result.output.split("\n")[0] || `status ${result.status}`}`,
        { output: result.output, code: result.code },
      );
    }
    return result.lines.at(-1) ?? "";
  }

  async close() {}
}

export async function connectAside({
  bin = "aside",
  host,
  account,
  timeoutMs = ASIDE_REPL_TIMEOUT_MS,
  runProcess = runAside,
} = {}) {
  const probe = await asideAvailable({ bin, runProcess });
  if (!probe.available) {
    throw new AsideUnavailable(
      `aside is not usable here (${probe.reason}); install it, sign in with \`aside login\`, or fall to a lower-ranked engine with a declared reason`,
      { bin },
    );
  }
  return new AsideRepl({ bin, host, account, timeoutMs, runProcess });
}
