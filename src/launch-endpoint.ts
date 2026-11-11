import type { ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import type { FSWatcher, Stats } from "node:fs";
import type { Readable } from "node:stream";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { readProperty } from "./read-property.ts";

/** Where a launched browser says its DevTools endpoint is; `browserPath` is the `/devtools/browser/<guid>` path. */
export interface LaunchReport {
  endpoint: string;
  browserPath: string | null;
}

interface ActivePortIdentity {
  ino: number;
  mtimeMs: number;
  size: number;
}

export interface ActivePortSnapshot extends ActivePortIdentity {
  text: string;
}

export interface DiscoverLaunchOptions {
  profileDir?: string | null | undefined;
  timeoutMs?: number | undefined;
  previousActivePort?: ActivePortSnapshot | null | undefined;
}

function errorCode(error: unknown): unknown {
  return error === null || error === undefined ? undefined : readProperty(error, "code");
}

// fs.watch can drop or delay directory events on a loaded host (seconds, or
// never), so the file is also re-read on this interval until the launch settles.
const ACTIVE_PORT_POLL_MS = 100;

function httpEndpointFromWebSocket(webSocketUrl: string) {
  const endpoint = new URL(webSocketUrl);
  endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
  endpoint.pathname = "/";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.toString().replace(/\/$/, "");
}

// Chromium writes `<port>\n/devtools/browser/<guid>`; the second line names the browser.
function parseActivePort(text: string): LaunchReport | null {
  const [portLine, browserPath] = text.trim().split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    browserPath: browserPath?.trim() || null,
  };
}

function activePortIdentity(info: Stats): ActivePortIdentity {
  return { ino: info.ino, mtimeMs: info.mtimeMs, size: info.size };
}

// A DevToolsActivePort that is already there before the spawn was written by
// an earlier run or by another browser on the same profile (#74). Taken before
// the spawn, so discovery can tell it from the file the new browser writes.
// The bytes are kept as well as the identity: an identity change does not prove
// the bytes changed (Linux updates mtime before it copies a write's data, and a
// touch or an in-place rewrite moves it too), and stale bytes name another
// browser whose id the launch check would then compare against itself (#107).
export async function snapshotActivePort(profileDir: string | null | undefined): Promise<ActivePortSnapshot | null> {
  if (!profileDir) return null;
  const activePortPath = path.join(profileDir, "DevToolsActivePort");
  try {
    const identity = activePortIdentity(await stat(activePortPath));
    return { ...identity, text: await readFile(activePortPath, "utf8") };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function isSameFile(info: ActivePortIdentity, previous: ActivePortSnapshot | null) {
  return (
    previous !== null && info.ino === previous.ino && info.mtimeMs === previous.mtimeMs && info.size === previous.size
  );
}

// The endpoint is the launched browser's only if it answers with the browser id
// that browser reported, and the browser is still the one we spawned.
/** The child-process members launch discovery reads; a spawned ChildProcess (or an EventEmitter stub) satisfies it. */
export interface LaunchedChild {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stderr: Readable;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export function assertLaunchedBrowser(child: ChildProcess, report: LaunchReport, webSocketDebuggerUrl: string) {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`browser exited before its DevTools endpoint ${report.endpoint} could be verified`);
  }
  const answered = new URL(webSocketDebuggerUrl).pathname;
  if (report.browserPath === null || answered !== report.browserPath) {
    throw new Error(
      `DevTools endpoint ${report.endpoint} answers as ${answered}, not as the launched browser (${report.browserPath ?? "no browser id reported"})`,
    );
  }
}

// Resolves undefined only if `finish` is handed a falsy error value, which no
// caller below produces (every error is an Error object).
export async function discoverLaunchedEndpoint(
  child: LaunchedChild,
  { profileDir, timeoutMs, previousActivePort = null }: DiscoverLaunchOptions = {},
): Promise<LaunchReport | undefined> {
  const activePortPath = profileDir ? path.join(profileDir, "DevToolsActivePort") : null;

  return new Promise<LaunchReport | undefined>((resolve, reject) => {
    let settled = false;
    let stderr = "";
    let activePortWatcher: FSWatcher | undefined;
    let activePortReading = false;
    let activePortChangedWhileReading = false;
    const cleanups: Array<() => void> = [];

    const finish = (error: unknown, endpoint?: LaunchReport) => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
      activePortWatcher?.close();
      if (error) reject(error);
      else resolve(endpoint);
    };

    const readActivePort = async (portPath: string) => {
      const info = await stat(portPath);
      if (isSameFile(activePortIdentity(info), previousActivePort)) return;
      const text = await readFile(portPath, "utf8");
      if (previousActivePort !== null && text === previousActivePort.text) return;
      const report = parseActivePort(text);
      if (report) finish(null, report);
    };

    const tryActivePort = async () => {
      if (!activePortPath || settled) return;
      if (activePortReading) {
        activePortChangedWhileReading = true;
        return;
      }
      activePortReading = true;
      try {
        do {
          activePortChangedWhileReading = false;
          await readActivePort(activePortPath);
        } while (activePortChangedWhileReading && !settled);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") finish(error);
      } finally {
        activePortReading = false;
      }
    };

    const onStderr = (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      // The capture group always takes part in a match.
      const webSocketUrl = match?.[1];
      if (webSocketUrl !== undefined) {
        finish(null, {
          endpoint: httpEndpointFromWebSocket(webSocketUrl),
          browserPath: new URL(webSocketUrl).pathname,
        });
      } else void tryActivePort();
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(
        new Error(
          `browser exited before exposing DevTools (code ${code}, signal ${signal ?? "none"})${stderr ? `\n${stderr}` : ""}`,
        ),
      );
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
    cleanups.push(() => child.stderr.off("data", onStderr));
    cleanups.push(() => child.off("error", onError));
    cleanups.push(() => child.off("exit", onExit));

    // activePortPath is set exactly when profileDir is.
    if (activePortPath && profileDir) {
      try {
        activePortWatcher = watch(profileDir, (event, filename) => {
          if (
            (event === "rename" || event === "change") &&
            (!filename || filename.toString() === path.basename(activePortPath))
          ) {
            void tryActivePort();
          }
        });
      } catch (error) {
        if (errorCode(error) !== "ENOENT") finish(error);
      }
      void tryActivePort();
      const poll = setInterval(() => void tryActivePort(), ACTIVE_PORT_POLL_MS);
      cleanups.push(() => clearInterval(poll));
    }

    const timeout = setTimeout(() => {
      finish(
        new Error(`browser did not expose a DevTools endpoint within ${timeoutMs}ms${stderr ? `\n${stderr}` : ""}`),
      );
    }, timeoutMs);
    cleanups.push(() => clearTimeout(timeout));
  });
}
