// Aside engine: drives the user's Aside browser through one long-lived Aside CLI process that
// keeps one REPL session, so `const` bindings, `page` and globals persist between calls. A
// fresh `aside repl "<code>"` per call would start a new session every time and lose `page`.
// Which process that is depends on the CLI (cli-contract.js): a piped `aside repl` evaluating
// one stdin line per call (line-transport.js), or `aside mcp`'s `repl` tool where a piped
// `aside repl` runs stdin as one script at EOF (mcp-transport.js, #255).
// Only `aside repl` and `aside mcp`'s `repl` tool run code: `aside exec` hands the task to Aside's own model.
import { spawn as spawnChild } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { findSnapshotLines, validateSnapshotOptions } from "../snapshot-diff.js";
import { asideCliVersion, replTransportFor } from "./cli-contract.js";
import { AsideReplError } from "./errors.js";
import { LineTransport } from "./line-transport.js";
import { McpTransport } from "./mcp-transport.js";
import { asideOnboard } from "./onboard.js";

export { AsideReplError };

const DEFAULT_START_TIMEOUT_MS = 15_000;
// Aside stops a REPL evaluation after 120 s; wait a little longer for its own error.
const DEFAULT_CALL_TIMEOUT_MS = 125_000;
const VERSION_TIMEOUT_MS = 5_000;

export function findAsideBinary({ env = process.env, home = homedir(), exists = existsSync } = {}) {
  if (env.ASIDE_BIN) return env.ASIDE_BIN;
  const candidates = [path.join(home, ".local", "bin", process.platform === "win32" ? "aside.exe" : "aside")];
  // Aside's Windows installer (install.ps1) puts the CLI here, off PATH with -SkipPathUpdate.
  if (process.platform === "win32" && env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, "Aside", "CLI", "current", "aside.exe"));
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, process.platform === "win32" ? "aside.exe" : "aside"));
  }
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

export class AsideSession {
  #transport;
  #queue = Promise.resolve();
  #callTimeoutMs;

  // protocol "line" drives a piped `aside repl` child, "mcp" an `aside mcp` child.
  constructor(child, { callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS, protocol = "line", account = null } = {}) {
    this.#transport = protocol === "mcp" ? new McpTransport(child) : new LineTransport(child);
    this.#callTimeoutMs = callTimeoutMs;
    this.engine = "aside";
    this.account = account;
    this.sessionDir = null;
  }

  async ready(timeoutMs = DEFAULT_START_TIMEOUT_MS) {
    const { account, sessionDir } = await this.#transport.ready(timeoutMs);
    if (account) this.account = account;
    if (sessionDir) this.sessionDir = sessionDir;
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
    const line = `try { const omowValue = await eval(${JSON.stringify(body)}); const omowJson = JSON.stringify(omowValue ?? null); console.log(${JSON.stringify(tag)} + (omowJson === undefined ? '{"unserializable":true}' : '{"value":' + omowJson + '}')); } catch (omowError) { console.log(${JSON.stringify(tag)} + JSON.stringify({ error: String(omowError?.stack ?? omowError) })); }`;
    const output = await this.#call(line, tag);
    const logs = [];
    let value;
    let found = false;
    for (const entry of output) {
      if (entry.startsWith(tag)) {
        let result;
        try {
          result = JSON.parse(entry.slice(tag.length));
        } catch {
          result = { unserializable: true };
        }
        if (result.error !== undefined) throw new AsideReplError("repl_error", result.error, { output: logs });
        if (result.unserializable) throw new AsideReplError("repl_unserializable", "the code returned a value with no JSON form (a function, symbol or undefined member); return plain data", { output });
        value = result.value;
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
    await this.#transport.close();
  }

  #call(line, tag) {
    const run = this.#queue.then(() => this.#transport.call(line, { tag, timeoutMs: this.#callTimeoutMs }));
    this.#queue = run.catch(() => {});
    return run;
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
  const cli = { spawn, command, env };
  const protocol = await replTransportFor({ ...cli, timeoutMs: startTimeoutMs });
  const args = [...command.slice(1), protocol === "mcp" ? "mcp" : "repl"];
  if (account) args.push("--account", account);
  if (host) args.push("--host", host);
  // `aside mcp` releases its REPL session after 30 idle minutes by default, which would drop `page`
  // and every global; a piped `aside repl` kept its session for the life of the process.
  const childEnv = protocol === "mcp" && env.ASIDE_MCP_REPL_IDLE_TIMEOUT_MS === undefined ? { ...env, ASIDE_MCP_REPL_IDLE_TIMEOUT_MS: "0" } : env;
  const child = spawn(command[0], args, { env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const spawned = new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) => reject(new AsideReplError("repl_start_failed", `could not start aside ${protocol === "mcp" ? "mcp" : "repl"}: ${error.message}`)));
  });
  await spawned;
  const session = new AsideSession(child, { callTimeoutMs, protocol, account: account ?? null });
  try {
    return await session.ready(startTimeoutMs);
  } catch (error) {
    child.kill();
    if (error.code !== "repl_start_timeout") throw error;
    const version = await asideCliVersion({ ...cli, timeoutMs: VERSION_TIMEOUT_MS });
    throw new AsideReplError("repl_start_timeout", `aside ${protocol === "mcp" ? "mcp" : "repl"} (Aside CLI ${version ?? "of unknown version"}) did not answer within ${startTimeoutMs} ms`, { output: error.output });
  }
}
