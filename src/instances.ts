import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { profileDirFromArgs, terminateChild } from "./browser-process.ts";
import { openConnection } from "./connection.ts";
import type { BrowserConnection, ConnectOptions } from "./connection.ts";
import type { DialogPolicy } from "./dialog-policy.ts";
import { isPidAlive, unlinkIfPresent, withLock } from "./instance-lock.ts";
import { assertLaunchedBrowser, discoverLaunchedEndpoint, snapshotActivePort } from "./launch-endpoint.ts";
import { restrictToOwner } from "./owner-only.ts";
import { readProperty } from "./read-property.ts";
import { acquireSharedConnection } from "./shared-connections.ts";

const RECORD_VERSION = 2;
const DEFAULT_REGISTRY_ROOT = path.join(os.homedir(), ".local", "share", "omowright", "instances");
const DEFAULT_PROBE_TIMEOUT_MS = 1_000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const BROWSER_CLOSE_TIMEOUT_MS = 2_000;
// Waiting for the lock has to outlast the slowest honest critical section
// (probe + launch + CDP attach); a shorter budget makes a second caller give up
// at the exact moment the first one is about to publish its record.
const LOCK_TIMEOUT_MARGIN_MS = 5_000;
// Same sum the per-call resolver below computes, for callers with no overrides.
const DEFAULT_LOCK_TIMEOUT_MS = resolveLockTimeoutMs({});

/** The registry entry a named browser is published under (`<registryRoot>/<name>.json`). */
export interface InstanceRecord {
  version: number;
  name: string;
  pid: number;
  endpoint: string;
  webSocketDebuggerUrl: string;
  profileDir: string | null;
  browserPath: string;
  startedAt: string;
}

export interface InstanceStatus extends InstanceRecord {
  alive: boolean;
  responsive: boolean;
}

export interface ListInstancesOptions {
  registryRoot?: string | undefined;
  probeTimeoutMs?: number | undefined;
}

interface TimeoutOptions {
  probeTimeoutMs?: number | undefined;
  connectTimeoutMs?: number | undefined;
  launchTimeoutMs?: number | undefined;
  lockTimeoutMs?: number | undefined;
}

export interface ConnectNamedOptions extends ListInstancesOptions, TimeoutOptions {
  /** Required to launch: attaching to a healthy registered instance needs no browserPath. */
  browserPath?: string | undefined;
  browserArgs?: readonly string[] | undefined;
  profileDir?: string | undefined;
  /** Spawn options for the browser process; `stdio` is always owned by the registry. */
  spawnOptions?: Omit<SpawnOptions, "stdio"> | undefined;
  storageRoot?: string | undefined;
  /** Base options for the CDP connection; `storageRoot`, `client` and `dialogPolicy` above override it. */
  connectionOptions?: ConnectOptions | undefined;
  client?: ConnectOptions["client"];
  dialogPolicy?: DialogPolicy;
}

interface RegistryPaths {
  root: string;
  recordPath: string;
  lockPath: string;
}

interface LoadedRecord {
  exists: boolean;
  record: InstanceRecord | null;
}

interface BrowserVersion {
  webSocketDebuggerUrl: string;
}

function errorCode(error: unknown): unknown {
  return error === null || error === undefined ? undefined : readProperty(error, "code");
}

function normalizeName(name: unknown): string {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new TypeError(
      "instance name must start with a letter or number and contain only letters, numbers, dots, dashes, or underscores",
    );
  }
  return name;
}

function registryPaths(registryRoot: string | undefined, name: string): RegistryPaths {
  const root = path.resolve(registryRoot ?? DEFAULT_REGISTRY_ROOT);
  return {
    root,
    recordPath: path.join(root, `${name}.json`),
    lockPath: path.join(root, `${name}.flock`),
  };
}

async function ensureRegistryRoot(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await restrictToOwner(root, "directory");
}

function isRecord(value: unknown, expectedName: string): value is InstanceRecord {
  if (value === null || typeof value !== "object") return false;
  const pid = readProperty(value, "pid");
  const endpoint = readProperty(value, "endpoint");
  const webSocketDebuggerUrl = readProperty(value, "webSocketDebuggerUrl");
  const profileDir = readProperty(value, "profileDir");
  const browserPath = readProperty(value, "browserPath");
  const startedAt = readProperty(value, "startedAt");
  return (
    readProperty(value, "version") === RECORD_VERSION &&
    readProperty(value, "name") === expectedName &&
    typeof pid === "number" &&
    Number.isInteger(pid) &&
    pid > 0 &&
    typeof endpoint === "string" &&
    endpoint.length > 0 &&
    typeof webSocketDebuggerUrl === "string" &&
    webSocketDebuggerUrl.length > 0 &&
    (typeof profileDir === "string" || profileDir === null) &&
    typeof browserPath === "string" &&
    browserPath.length > 0 &&
    typeof startedAt === "string" &&
    !Number.isNaN(Date.parse(startedAt))
  );
}

async function readRecord(recordPath: string, expectedName: string): Promise<LoadedRecord> {
  let text;
  try {
    text = await readFile(recordPath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { exists: false, record: null };
    throw error;
  }

  try {
    const record: unknown = JSON.parse(text);
    return {
      exists: true,
      record: isRecord(record, expectedName) ? record : null,
    };
  } catch {
    return { exists: true, record: null };
  }
}

/** A record as launchNamed writes it: `pid` comes straight from the spawned child. */
type LaunchedRecord = Omit<InstanceRecord, "pid"> & { pid: number | undefined };

async function writeRecordAtomic(root: string, recordPath: string, record: LaunchedRecord) {
  const tempPath = path.join(root, `.${record.name}.${process.pid}.${randomUUID()}.tmp`);
  let handle: FileHandle | null | undefined;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.close();
    handle = null;
    await restrictToOwner(tempPath, "file");
    await rename(tempPath, recordPath);
    await restrictToOwner(recordPath, "file");
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

function isConnectionRefused(error: unknown) {
  for (let cause: unknown = error; cause; cause = readProperty(cause, "cause")) {
    const code = readProperty(cause, "code");
    if (
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      // Bun's fetch reports refused connections with this code.
      code === "ConnectionRefused"
    ) {
      return true;
    }
  }
  return false;
}

function isBrowserVersion(value: unknown): value is BrowserVersion {
  if (value === null || value === undefined) return false;
  const webSocketDebuggerUrl = readProperty(value, "webSocketDebuggerUrl");
  return typeof webSocketDebuggerUrl === "string" && webSocketDebuggerUrl.length > 0;
}

async function probeEndpoint(endpoint: string, timeoutMs: number): Promise<BrowserVersion> {
  const versionUrl = new URL("/json/version", endpoint);
  const response = await fetch(versionUrl, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`CDP discovery request failed (${response.status} ${response.statusText})`);
  }
  const version: unknown = await response.json();
  if (!isBrowserVersion(version)) {
    throw new Error("CDP discovery response lacks webSocketDebuggerUrl");
  }
  return version;
}

function resolveConnectTimeoutMs(options: TimeoutOptions) {
  return options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
}

function resolveLockTimeoutMs(options: TimeoutOptions) {
  if (options.lockTimeoutMs !== undefined) return options.lockTimeoutMs;
  return (
    (options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS) +
    (options.probeTimeoutMs ?? resolveConnectTimeoutMs(options)) +
    resolveConnectTimeoutMs(options) +
    LOCK_TIMEOUT_MARGIN_MS
  );
}

function nameLockOptions(options: TimeoutOptions) {
  return {
    timeoutMs: resolveLockTimeoutMs(options),
  };
}

// `/json/version` answering proves nothing about the WebSocket upgrade behind
// it, so the session handshake carries its own bound.
async function connectWithin(endpoint: string, options: ConnectOptions, timeoutMs: number) {
  const pending = openConnection(endpoint, options);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${timeoutMs}ms opening a CDP session on ${endpoint}`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    // A session that lands after the bound would otherwise hold a live socket.
    pending.then(
      (connection) => connection.close().catch(() => {}),
      () => {},
    );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function removeOwnedRecord(recordPath: string, name: string, pid: number | undefined) {
  const loaded = await readRecord(recordPath, name);
  if (loaded.record?.pid !== pid) return;
  await unlinkIfPresent(recordPath);
}

function connectionOptions(options: ConnectNamedOptions, profileDir: string | null | undefined): ConnectOptions {
  const result: ConnectOptions = { ...(options.connectionOptions ?? {}) };
  if (options.storageRoot !== undefined) result.storageRoot = options.storageRoot;
  else if (result.storageRoot === undefined && profileDir) {
    result.storageRoot = profileDir;
  }
  if (options.client !== undefined) {
    result.client = {
      ...(result.client ?? {}),
      ...options.client,
    };
  }
  // Part of the sharing key too: callers asking for different dialog policies
  // never share one connection.
  if (options.dialogPolicy !== undefined) result.dialogPolicy = options.dialogPolicy;
  return result;
}

// Asked over CDP first, as the pipe transport does: on Windows no signal can
// ask a browser to quit, and Chrome cleans up only on a clean quit. Only a live
// browser on a live socket is asked: CdpClient.send would otherwise reconnect
// through the recorded port, which is not an identity (another process may
// hold it by now). The connection is closed as soon as the request is answered,
// before the quitting browser drops its socket: a drop on an open client starts
// its auto-reconnect loop, which would keep the caller's process alive. Then,
// like the pipe transport, the browser gets a bounded wait to exit before
// terminateChild steps in.
async function askBrowserToQuit(connection: BrowserConnection, child: ChildProcess, disconnect: () => Promise<void>) {
  if (child.exitCode !== null || child.signalCode !== null || !readProperty(connection.cdp, "isConnected")) {
    await disconnect();
    return false;
  }
  const exited = new Promise<unknown>((resolve) => child.once("exit", resolve));
  const quitRequested = await Promise.race([
    connection.cdp.send("Browser.close", undefined, undefined, { timeoutMs: BROWSER_CLOSE_TIMEOUT_MS }).then(
      () => true,
      () => false,
    ),
    exited.then(() => true),
  ]);
  await disconnect();
  if (child.exitCode === null && child.signalCode === null) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(resolve, BROWSER_CLOSE_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
  }
  return quitRequested;
}

async function launchNamed(name: string, { root, recordPath, lockPath }: RegistryPaths, options: ConnectNamedOptions) {
  if (typeof options.browserPath !== "string" || options.browserPath.length === 0) {
    throw new TypeError(`connectNamed("${name}") requires browserPath when no healthy instance is registered`);
  }
  const browserArgs = [...(options.browserArgs ?? [])];
  const profileDir = options.profileDir ? path.resolve(options.profileDir) : profileDirFromArgs(browserArgs);
  const previousActivePort = await snapshotActivePort(profileDir);
  const child = spawn(
    options.browserPath,
    [...browserArgs, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"],
    {
      // A named browser is shared through the registry, so it has to outlive
      // the process that launched it. On Windows libuv puts every non-detached
      // child in a kill-on-close job object, which kills the browser the
      // moment its launcher exits (#90); detached keeps it out of that job
      // (DETACHED_PROCESS also gives a console-subsystem browser no console).
      // No windowsHide: it would start a headful browser's window hidden.
      ...(process.platform === "win32" ? { detached: true } : {}),
      ...(options.spawnOptions ?? {}),
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  let connection: BrowserConnection | undefined;
  try {
    const launchTimeoutMs = options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
    const report = await discoverLaunchedEndpoint(child, {
      profileDir,
      timeoutMs: launchTimeoutMs,
      previousActivePort,
    });
    // Only a falsy rejection value inside discovery resolves undefined; the JS
    // original threw a TypeError destructuring it, and so does this check.
    if (report === undefined) throw new TypeError("launch endpoint discovery settled without a report");
    const { endpoint } = report;
    // The browser's own WebSocket URL carries its GUID: recording it makes a
    // later attach prove it reached this browser and not whatever else ends up
    // on the port once this pid is gone.
    const { webSocketDebuggerUrl } = await probeEndpoint(endpoint, launchTimeoutMs);
    assertLaunchedBrowser(child, report, webSocketDebuggerUrl);
    const opened = await connectWithin(
      endpoint,
      connectionOptions(options, profileDir),
      resolveConnectTimeoutMs(options),
    );
    connection = opened;
    const record: LaunchedRecord = {
      version: RECORD_VERSION,
      name,
      pid: child.pid,
      endpoint,
      webSocketDebuggerUrl,
      profileDir,
      browserPath: path.resolve(options.browserPath),
      startedAt: new Date().toISOString(),
    };
    await writeRecordAtomic(root, recordPath, record);
    opened.browserProcess = child;
    const disconnect = opened.close.bind(opened);
    opened.close = async () => {
      let failure: unknown;
      const quitRequested = await askBrowserToQuit(opened, child, async () => {
        try {
          await disconnect();
        } catch (error) {
          failure = error;
        }
      });
      await terminateChild(child, { quitRequested });
      // The browser this record points at is gone, so the record goes with it
      // instead of waiting for the next caller to clean it up.
      try {
        await withLock(lockPath, nameLockOptions(options), () => removeOwnedRecord(recordPath, name, child.pid));
      } catch (error) {
        failure ??= error;
      }
      if (failure) throw failure;
    };
    return opened;
  } catch (error) {
    await connection?.close().catch(() => {});
    await terminateChild(child);
    throw error;
  }
}

export async function withEngineLock<T>(
  registryRoot: string | undefined,
  engineKey: string,
  run: () => Promise<T>,
): Promise<T> {
  const root = path.resolve(registryRoot ?? DEFAULT_REGISTRY_ROOT);
  await ensureRegistryRoot(root);
  const digest = createHash("sha256").update(path.resolve(engineKey)).digest("hex").slice(0, 16);
  const lockPath = path.join(root, `_engine-${digest}.flock`);
  return withLock(lockPath, { timeoutMs: DEFAULT_LOCK_TIMEOUT_MS }, run);
}

export async function connectNamed(name: string, options: ConnectNamedOptions = {}): Promise<BrowserConnection> {
  const normalizedName = normalizeName(name);
  const paths = registryPaths(options.registryRoot, normalizedName);
  await ensureRegistryRoot(paths.root);
  return withLock(paths.lockPath, nameLockOptions(options), () => attachOrLaunch(normalizedName, paths, options));
}

async function attachOrLaunch(
  normalizedName: string,
  paths: RegistryPaths,
  options: ConnectNamedOptions,
): Promise<BrowserConnection> {
  const loaded = await readRecord(paths.recordPath, normalizedName);
  if (loaded.record) {
    await restrictToOwner(paths.recordPath, "file");
    if (isPidAlive(loaded.record.pid)) {
      let version: BrowserVersion | null = null;
      try {
        version = await probeEndpoint(
          loaded.record.endpoint,
          // Attaching is not a one-second listInstances health check. A
          // healthy holder may still be busy finishing startup under load.
          options.probeTimeoutMs ?? resolveConnectTimeoutMs(options),
        );
      } catch (error) {
        if (!isConnectionRefused(error)) {
          throw new Error(
            `unresponsive holder "${normalizedName}" pid ${loaded.record.pid} endpoint ${loaded.record.endpoint}: ${readProperty(error, "message")}`,
            { cause: error },
          );
        }
        // A live pid whose recorded debug port refuses connections is a
        // reused pid, not a holder: the record is stale and the launch
        // below reclaims it.
      }
      // A pid that came back and a port any local process can rebind are
      // not an identity. Only the recorded WebSocket URL (it carries the
      // browser GUID) says this is our browser; anything else answering
      // there is a stranger, so the record is stale, not a holder.
      if (version?.webSocketDebuggerUrl === loaded.record.webSocketDebuggerUrl) {
        // Connecting to the recorded GUID URL, not the port, keeps the shared
        // connection's auto-reconnect from landing on a different browser.
        const { webSocketDebuggerUrl } = loaded.record;
        const timeoutMs = resolveConnectTimeoutMs(options);
        try {
          return await acquireSharedConnection(
            webSocketDebuggerUrl,
            connectionOptions(options, loaded.record.profileDir),
            {
              open: (shared) => connectWithin(webSocketDebuggerUrl, shared, timeoutMs),
              timeoutMs,
            },
          );
        } catch (error) {
          throw new Error(
            `unresponsive holder "${normalizedName}" pid ${loaded.record.pid} endpoint ${loaded.record.endpoint}: ${readProperty(error, "message")}`,
            { cause: error },
          );
        }
      }
    }
  }

  if (loaded.exists) {
    await unlink(paths.recordPath).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  }
  return await launchNamed(normalizedName, paths, options);
}

export async function listInstances(options: ListInstancesOptions = {}): Promise<InstanceStatus[]> {
  const root = path.resolve(options.registryRoot ?? DEFAULT_REGISTRY_ROOT);
  await ensureRegistryRoot(root);
  const entries = await readdir(root, { withFileTypes: true });
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry): Promise<InstanceStatus | null> => {
        const expectedName = entry.name.slice(0, -".json".length);
        const recordPath = path.join(root, entry.name);
        const { record } = await readRecord(recordPath, expectedName);
        if (!record) return null;
        await restrictToOwner(recordPath, "file");
        const alive = isPidAlive(record.pid);
        let responsive = false;
        if (alive) {
          responsive = await probeEndpoint(record.endpoint, options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS).then(
            (version) => version.webSocketDebuggerUrl === record.webSocketDebuggerUrl,
            () => false,
          );
        }
        return { ...record, alive, responsive };
      }),
  );
  return records
    .filter((record) => record !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}
