// Aside engine: drives the user's Aside browser through one long-lived Aside CLI process that
// keeps one REPL session, so `const` bindings, `page` and globals persist between calls. A
// fresh `aside repl "<code>"` per call would start a new session every time and lose `page`.
// Which process that is depends on the CLI (cli-contract.ts): a piped `aside repl` evaluating
// one stdin line per call (line-transport.ts), or `aside mcp`'s `repl` tool where a piped
// `aside repl` runs stdin as one script at EOF (mcp-transport.ts, #255).
// Only `aside repl` and `aside mcp`'s `repl` tool run code: `aside exec` hands the task to Aside's own model.
import { spawn as spawnChild } from "node:child_process";
import { randomBytes } from "node:crypto";
import { findSnapshotLines, validateSnapshotOptions } from "../snapshot-diff.ts";
import { asideCliVersion, replTransportFor } from "./cli-contract.ts";
import { AsideReplError } from "./errors.ts";
import { LineTransport } from "./line-transport.ts";
import { McpTransport } from "./mcp-transport.ts";
import { asideOnboard } from "./onboard.ts";
import { findAsideBinary } from "./cli-binary.ts";
import type {
  AsideChildProcess,
  AsideSessionOptions,
  AsideSnapshotOptions,
  AsideSpawnedProcess,
  ConnectAsideOptions,
} from "./session-types.ts";

export { AsideReplError } from "./errors.ts";
export { findAsideBinary } from "./cli-binary.ts";

type JsonObject = Readonly<Record<string, unknown>>;
const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null;
const hasPipes = (child: AsideSpawnedProcess): child is AsideChildProcess =>
  child.stdin !== null && child.stdout !== null;

const DEFAULT_START_TIMEOUT_MS = 15_000;
// Aside stops a REPL evaluation after 120 s; wait a little longer for its own error.
const DEFAULT_CALL_TIMEOUT_MS = 125_000;
// Budget for each short CLI probe (`--version`, `repl --help`, `mcp --help`), apart from startTimeoutMs.
const CLI_PROBE_TIMEOUT_MS = 5_000;

export class AsideSession {
  #transport: LineTransport | McpTransport;
  #queue: Promise<unknown> = Promise.resolve();
  #callTimeoutMs: number;
  declare engine: "aside";
  declare account: string | null;
  declare sessionDir: string | null;

  // protocol "line" drives a piped `aside repl` child, "mcp" an `aside mcp` child.
  constructor(
    child: AsideChildProcess,
    { callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS, protocol = "line", account = null }: AsideSessionOptions = {},
  ) {
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
        if (result["error"] !== undefined)
          throw new AsideReplError("repl_error", String(result["error"]), { output: logs });
        if (result["unserializable"])
          throw new AsideReplError(
            "repl_unserializable",
            "the code returned a value with no JSON form (a function, symbol or undefined member); return plain data",
            { output },
          );
        value = result["value"];
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
    const tree = isObject(result) && typeof result["tree"] === "string" ? result["tree"] : undefined;
    const found = findSnapshotLines({ tree, refs: {} }, find, context);
    return { tree: found.tree, find: found.find };
  }

  async close() {
    await this.#transport.close();
  }

  #call(line: string, tag: string): Promise<string[]> {
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
  const cliCommand: readonly [string, ...string[]] = [bin, ...lead];
  const cli = { spawn, command: cliCommand, env };
  const protocol = await replTransportFor({ ...cli, timeoutMs: CLI_PROBE_TIMEOUT_MS });
  const subcommand = protocol === "mcp" ? "mcp" : "repl";
  const args = [...lead, subcommand];
  if (account) args.push("--account", account);
  if (host) args.push("--host", host);
  // `aside mcp` releases its REPL session after 30 idle minutes by default, which would drop `page`
  // and every global; a piped `aside repl` kept its session for the life of the process.
  const childEnv =
    protocol === "mcp" && env["ASIDE_MCP_REPL_IDLE_TIMEOUT_MS"] === undefined
      ? { ...env, ASIDE_MCP_REPL_IDLE_TIMEOUT_MS: "0" }
      : env;
  const child = spawn(bin, args, { env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const spawned = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) =>
      reject(new AsideReplError("repl_start_failed", `could not start aside ${subcommand}: ${error.message}`)),
    );
  });
  await spawned;
  if (!hasPipes(child)) {
    child.kill();
    throw new AsideReplError("repl_start_failed", `aside ${subcommand} started without stdin and stdout pipes`);
  }
  const session = new AsideSession(child, { callTimeoutMs, protocol, account: account ?? null });
  try {
    return await session.ready(startTimeoutMs);
  } catch (error) {
    await session.close();
    if (!(error instanceof AsideReplError) || error.code !== "repl_start_timeout") throw error;
    const version = await asideCliVersion({ ...cli, timeoutMs: CLI_PROBE_TIMEOUT_MS });
    throw new AsideReplError(
      "repl_start_timeout",
      `aside ${subcommand} (Aside CLI ${version ?? "of unknown version"}) did not answer within ${startTimeoutMs} ms`,
      { output: error.output },
    );
  }
}
