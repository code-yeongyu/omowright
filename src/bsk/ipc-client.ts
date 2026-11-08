// CLI-shaped client for the BrowserSkill daemon IPC: one Unix-socket
// connection per call, one JSON Lines request frame out, one response frame
// back (`crates/bsk-cli/src/ipc_client.rs`, `crates/bsk-protocol/src/frame.rs`).
// `cancel` opens a second connection exactly as the CLI's SIGINT path does.
import { connect } from "node:net";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { readProperty } from "../read-property.ts";
import { readDaemonInfo, resolveBskHome, startDaemonWithCli } from "./daemon-info.ts";
import type { DaemonInfo } from "./daemon-info.ts";
import { optionalProperty } from "./reply-fields.ts";

export { readDaemonInfo, resolveBskHome } from "./daemon-info.ts";

const DEFAULT_TIMEOUT_MS = 35_000; // daemon tool budget 30s + grace, as cli/mod.rs
const DISCOVERY_RETRY_MS = 250;
const DISCOVERY_BUDGET_MS = 15_000;
// A tool call that names its own budget (timeout_ms, or confirmation_timeout_ms for a tab borrow)
// gets that budget plus this grace on the IPC wait.
const TOOL_TIMEOUT_GRACE_MS = 5_000;
// Tools that wait for a person: the daemon owns their deadline, so with no budget from the caller the
// client only keeps a long backstop, and it never cancels them (that would tear down the user's overlay).
const HUMAN_WAIT_METHODS = new Set(["tool.request_help", "tool.tab_borrow"]);
const HUMAN_WAIT_BACKSTOP_MS = 3_600_000;

function ownBudgetMs(params: unknown): number | undefined {
  const budgets = [optionalProperty(params, "timeout_ms"), optionalProperty(params, "confirmation_timeout_ms")].filter(
    (value): value is number => typeof value === "number",
  );
  return budgets.length > 0 ? Math.max(...budgets) + TOOL_TIMEOUT_GRACE_MS : undefined;
}
const PROBE_TIMEOUT_MS = 2_000;

export interface BskCallOptions {
  idPrefix?: string;
  timeoutMs?: number;
}

// The call surface a session or onboarding step needs; BskIpcClient implements it and tests stub it.
export interface BskClient {
  call(method: string, params?: unknown, options?: BskCallOptions): Promise<unknown>;
}

export interface BskCallHandle {
  rpcId: string;
  promise: Promise<unknown>;
  abort: () => void;
}

export interface BskIpcClientOptions {
  home?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  sockPath?: string | undefined;
  autoStart?: boolean | undefined;
  startDaemon?: () => Promise<unknown>;
  timeoutMs?: number | undefined;
  bskBin?: string | undefined;
}

interface StaleRecord {
  info: DaemonInfo;
  code: string | undefined;
}

// Where the daemon listens when it was started with the default layout
// (`crates/bsk-cli/src/daemon/paths.rs`): `$BSK_HOME/run/daemon.sock`, or on Windows the named pipe
// `render_pipe_name` derives from USERNAME and the home.
export function defaultSocketPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== "win32") return path.join(home, "run", "daemon.sock");
  return `\\\\.\\pipe\\bsk-daemon-${rustStrHash(env["USERNAME"] ?? "default", home)}`;
}

// Rust's DefaultHasher (SipHash-1-3, zero keys) over each value's UTF-8 bytes plus the 0xff
// terminator `str::hash` writes, which is how bsk hashes the pipe name.
function rustStrHash(...values: string[]): string {
  const bytes = Buffer.concat(values.flatMap((value) => [Buffer.from(value, "utf8"), Buffer.from([0xff])]));
  const mask = (1n << 64n) - 1n;
  const rotl = (x: bigint, b: bigint) => ((x << b) | (x >> (64n - b))) & mask;
  let [v0, v1, v2, v3] = [0x736f6d6570736575n, 0x646f72616e646f6dn, 0x6c7967656e657261n, 0x7465646279746573n];
  const round = () => {
    v0 = (v0 + v1) & mask;
    v1 = rotl(v1, 13n) ^ v0;
    v0 = rotl(v0, 32n);
    v2 = (v2 + v3) & mask;
    v3 = rotl(v3, 16n) ^ v2;
    v0 = (v0 + v3) & mask;
    v3 = rotl(v3, 21n) ^ v0;
    v2 = (v2 + v1) & mask;
    v1 = rotl(v1, 17n) ^ v2;
    v2 = rotl(v2, 32n);
  };
  const compress = (word: bigint) => {
    v3 ^= word;
    round();
    v0 ^= word;
  };
  const whole = bytes.length - (bytes.length % 8);
  for (let i = 0; i < whole; i += 8) compress(bytes.readBigUInt64LE(i));
  let last = BigInt(bytes.length & 0xff) << 56n;
  for (let i = whole; i < bytes.length; i += 1) last |= BigInt(bytes.readUInt8(i)) << BigInt(8 * (i - whole));
  compress(last);
  v2 ^= 0xffn;
  round();
  round();
  round();
  return ((v0 ^ v1 ^ v2 ^ v3) & mask).toString(16).padStart(16, "0");
}

// Node's existsSync cannot see a named pipe, so on Windows the pipe namespace is listed instead;
// a listing that fails counts as no pipe, so discovery falls back to starting the daemon.
function socketExists(sockPath: string): boolean {
  if (process.platform !== "win32") return existsSync(sockPath);
  try {
    return readdirSync("\\\\.\\pipe\\").includes(path.win32.basename(sockPath));
  } catch {
    return false;
  }
}

// True when something answers system.ping on `sockPath`: a live daemon whose daemon.json was lost.
function probeSocket(sockPath: string): Promise<boolean> {
  if (!socketExists(sockPath)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = connect(sockPath);
    const done = (alive: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => done(false), PROBE_TIMEOUT_MS);
    socket.on("error", () => done(false));
    socket.on("connect", () => socket.write(JSON.stringify({ id: "probe-orphan", method: "system.ping" }) + "\n"));
    socket.on("data", () => done(true));
  });
}

export class BskRpcError extends Error {
  declare code: string;
  declare data: unknown;

  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = "BskRpcError";
    this.code = code;
    this.data = data;
  }
}

const noop = (): void => {};

function shortId(): string {
  return randomBytes(6).toString("hex");
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// daemon.json outlives a daemon that was killed, as when a host closes the job it ran in. Only its socket
// says so: a connect that fails with one of these reached no listener. Its pid cannot, since a client in
// another PID namespace sees a live daemon's pid as gone and a reused pid makes a dead one look alive.
const NO_LISTENER = new Set(["ENOENT", "ECONNREFUSED"]);

function sameRecord(info: DaemonInfo, stale: StaleRecord | undefined): boolean {
  return Boolean(stale) && JSON.stringify(info) === JSON.stringify(stale?.info);
}

export class BskIpcClient {
  #home: string;
  #env: NodeJS.ProcessEnv;
  #sockPath: string | null;
  #autoStart: boolean;
  #startDaemon: () => Promise<unknown>;
  #timeoutMs: number;
  #starting: Promise<unknown> | null = null;

  constructor({
    home,
    env = process.env,
    sockPath,
    autoStart,
    startDaemon,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    bskBin,
  }: BskIpcClientOptions = {}) {
    this.#home = home ?? resolveBskHome(env);
    this.#sockPath = sockPath ?? null;
    this.#autoStart = autoStart ?? env["BSK_AUTO_START"] !== "0";
    this.#startDaemon = startDaemon ?? (() => startDaemonWithCli({ home: this.#home, env, bskBin }));
    this.#timeoutMs = timeoutMs;
    this.#env = env;
  }

  get home(): string {
    return this.#home;
  }

  // `stale` is a daemon.json record ({info, code}) whose socket refused a connect; it is skipped until rewritten.
  async resolveSocket({
    isAborted = () => false,
    stale,
  }: { isAborted?: () => boolean; stale?: StaleRecord | undefined } = {}): Promise<string> {
    if (this.#sockPath) return this.#sockPath;
    const found = readDaemonInfo(this.#home);
    if (found && !sameRecord(found, stale)) return found.sock_path;
    // daemon.json can vanish while the daemon keeps running; starting another one then fails on the held port.
    const orphan = defaultSocketPath(this.#home, this.#env);
    // Probe only when the socket file exists, so a fresh home starts its daemon in the same tick as before.
    if (socketExists(orphan)) {
      if (await probeSocket(orphan)) return orphan;
      if (isAborted()) throw new BskRpcError("cancelled", "cancelled before the daemon was located");
    }
    if (!this.#autoStart) {
      if (stale) {
        throw new BskRpcError(
          "no_daemon",
          `${this.#home}/daemon.json names a BrowserSkill daemon at ${stale.info.sock_path} that is no longer listening (${stale.code}) and automatic start is disabled (BSK_AUTO_START=0); run \`bsk daemon start\` in the environment that owns it`,
        );
      }
      throw new BskRpcError(
        "no_daemon",
        `no BrowserSkill daemon published at ${this.#home}/daemon.json and automatic start is disabled (BSK_AUTO_START=0); run \`bsk daemon start\` in the environment that owns it`,
      );
    }
    if (!this.#starting)
      this.#starting = this.#startDaemon().finally(() => {
        this.#starting = null;
      });
    await this.#starting;
    const deadline = Date.now() + DISCOVERY_BUDGET_MS;
    while (Date.now() < deadline && !isAborted()) {
      const info = readDaemonInfo(this.#home);
      if (info && !sameRecord(info, stale)) return info.sock_path;
      await sleep(DISCOVERY_RETRY_MS);
    }
    if (isAborted())
      throw new BskRpcError("cancelled", "cancelled while waiting for the daemon to publish daemon.json");
    throw new BskRpcError("no_daemon", `daemon start was requested but ${this.#home}/daemon.json never appeared`);
  }

  call(method: string, params?: unknown, options: BskCallOptions = {}): Promise<unknown> {
    return this.callWithHandle(method, params, options).promise;
  }

  // {rpcId, promise, abort()} — rpcId is known before the frame is sent so a
  // caller can cancel a long tool call from another connection.
  callWithHandle(
    method: string,
    params?: unknown,
    { idPrefix = method.replace(/[^a-z0-9]+/gi, "-"), timeoutMs }: BskCallOptions = {},
  ): BskCallHandle {
    const ownBudget = ownBudgetMs(params);
    const humanWait = HUMAN_WAIT_METHODS.has(method);
    // An explicit timeoutMs is a floor, never a cut below the tool's own budget.
    const waitMs =
      humanWait && ownBudget === undefined && timeoutMs === undefined
        ? HUMAN_WAIT_BACKSTOP_MS
        : Math.max(timeoutMs ?? this.#timeoutMs, ownBudget ?? 0);
    const rpcId = `${idPrefix}-${shortId()}`;
    const frame: { id: string; method: string; params?: unknown } = { id: rpcId, method };
    if (params !== undefined) frame.params = params;
    let aborted = false;
    let abortSocket: () => void = noop;
    const exchange = (sockPath: string, onNoListener: (code: string) => void) =>
      new Promise<unknown>((resolve, reject) => {
        const socket = connect(sockPath);
        let buffer = "";
        let settled = false;
        const finish = (fn: (value: unknown) => void, value: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          fn(value);
        };
        const timer = setTimeout(() => {
          const cancels = method !== "cancel" && !humanWait;
          finish(
            reject,
            new BskRpcError(
              "timeout",
              `${method} did not answer within ${waitMs}ms${cancels ? "; a cancel was requested at the daemon" : ""}`,
            ),
          );
          // The daemon would otherwise keep running it and hold the session for the next call.
          if (cancels) this.cancel(rpcId).catch(() => {});
        }, waitMs);
        abortSocket = () => finish(reject, new BskRpcError("cancelled", `${method} cancelled by caller`));
        socket.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code !== undefined && NO_LISTENER.has(error.code)) onNoListener(error.code);
          finish(reject, new BskRpcError("no_daemon", `IPC socket ${sockPath}: ${error.code ?? error.message}`));
        });
        socket.setEncoding("utf8");
        socket.on("connect", () => socket.write(JSON.stringify(frame) + "\n"));
        socket.on("data", (chunk) => {
          buffer += chunk;
          const idx = buffer.indexOf("\n");
          if (idx === -1) return;
          try {
            finish(resolve, decodeResponse(buffer.slice(0, idx), rpcId, method));
          } catch (error) {
            finish(reject, error);
          }
        });
        socket.on("close", () =>
          finish(reject, new BskRpcError("protocol_error", `${method}: daemon closed the connection without a reply`)),
        );
      });
    const promise = (async () => {
      let stale: StaleRecord | undefined;
      for (;;) {
        const sockPath = await this.resolveSocket({ isAborted: () => aborted, stale });
        if (aborted) throw new BskRpcError("cancelled", `${method} cancelled by caller`);
        let refused: string | undefined;
        try {
          return await exchange(sockPath, (code) => {
            refused = code;
          });
        } catch (error) {
          // The frame never left, so one retry past the stale record sends nothing twice.
          const info = refused && !stale && !this.#sockPath ? readDaemonInfo(this.#home) : null;
          if (info?.sock_path !== sockPath) throw error;
          stale = { info, code: refused };
        }
      }
    })();
    return {
      rpcId,
      promise,
      abort: () => {
        aborted = true;
        abortSocket();
      },
    };
  }

  async cancel(rpcId: string): Promise<unknown> {
    return this.call("cancel", { rpc_id: rpcId }, { idPrefix: "cancel", timeoutMs: 2_000 });
  }
}

function decodeResponse(line: string, rpcId: string, method: string): unknown {
  let reply: unknown;
  try {
    reply = JSON.parse(line);
  } catch {
    throw new BskRpcError("protocol_error", `${method}: daemon reply is not JSON: ${line.slice(0, 120)}`);
  }
  // The daemon answers a frame it could not decode under id "0".
  const replyId = readProperty(reply, "id");
  const replyError = readProperty(reply, "error");
  const undecodableFrame = replyId === "0" && replyError;
  if (replyId !== rpcId && !undecodableFrame) {
    throw new BskRpcError("protocol_error", `${method}: reply id ${replyId} does not match request ${rpcId}`);
  }
  if (replyError) {
    const code = readProperty(replyError, "code");
    const message = readProperty(replyError, "message");
    throw new BskRpcError(
      code === undefined ? "protocol_error" : String(code),
      message === undefined ? "daemon error" : String(message),
      readProperty(replyError, "data"),
    );
  }
  return readProperty(reply, "result");
}
