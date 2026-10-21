import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { connect } from "./connection.js";

const RECORD_VERSION = 1;
const DEFAULT_REGISTRY_ROOT = path.join(
  os.homedir(),
  ".local",
  "share",
  "omowright",
  "instances",
);
const DEFAULT_PROBE_TIMEOUT_MS = 1_000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const localLocks = new Map();

function normalizeName(name) {
  if (
    typeof name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
  ) {
    throw new TypeError(
      "instance name must start with a letter or number and contain only letters, numbers, dots, dashes, or underscores",
    );
  }
  return name;
}

function registryPaths(registryRoot, name) {
  const root = path.resolve(registryRoot ?? DEFAULT_REGISTRY_ROOT);
  return {
    root,
    recordPath: path.join(root, `${name}.json`),
    lockPath: path.join(root, `${name}.lock`),
  };
}

async function ensureRegistryRoot(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
}

function isRecord(value, expectedName) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.version === RECORD_VERSION &&
    value.name === expectedName &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.endpoint === "string" &&
    value.endpoint.length > 0 &&
    (typeof value.profileDir === "string" || value.profileDir === null) &&
    typeof value.browserPath === "string" &&
    value.browserPath.length > 0 &&
    typeof value.startedAt === "string" &&
    !Number.isNaN(Date.parse(value.startedAt))
  );
}

async function readRecord(recordPath, expectedName) {
  let text;
  try {
    text = await readFile(recordPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, record: null };
    throw error;
  }

  try {
    const record = JSON.parse(text);
    return {
      exists: true,
      record: isRecord(record, expectedName) ? record : null,
    };
  } catch {
    return { exists: true, record: null };
  }
}

async function writeRecordAtomic(root, recordPath, record) {
  const tempPath = path.join(
    root,
    `.${record.name}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.close();
    handle = null;
    await chmod(tempPath, 0o600);
    await rename(tempPath, recordPath);
    await chmod(recordPath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function readLockIdentity(lockPath) {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8"));
    if (!Number.isInteger(value?.pid) || value.pid <= 0) return null;
    return {
      pid: value.pid,
      nonce: typeof value.nonce === "string" ? value.nonce : null,
    };
  } catch {
    return null;
  }
}

async function waitForLockRelease(lockPath, timeoutMs, holderPid) {
  try {
    await stat(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      watcher.close();
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      stat(lockPath).catch((error) => {
        if (error?.code === "ENOENT") finish();
        else finish(error);
      });
    };
    const watcher = watch(path.dirname(lockPath), (event, filename) => {
      if (
        (event === "rename" || event === "change") &&
        (!filename || filename.toString() === path.basename(lockPath))
      ) {
        check();
      }
    });
    const timeout = setTimeout(() => {
      finish(
        new Error(
          `timed out waiting for instance lock held by pid ${holderPid}`,
        ),
      );
    }, timeoutMs);
    check();
  });
}

async function acquireLock(lockPath, timeoutMs) {
  for (;;) {
    const nonce = randomUUID();
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, nonce })}\n`,
          "utf8",
        );
        await handle.close();
        await chmod(lockPath, 0o600);
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
        throw error;
      }
      // Post-acquire verification: if a reclaimer removed a stale lock under
      // us and another owner already created a fresh one, the file at this
      // path is no longer ours — abandon it and retry instead of proceeding
      // (which would allow two concurrent holders).
      const readback = await readLockIdentity(lockPath);
      if (readback?.nonce !== nonce) {
        await waitForLockRelease(lockPath, timeoutMs, readback?.pid ?? process.pid);
        continue;
      }
      return async () => {
        await unlink(lockPath).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const holderIdentity = await readLockIdentity(lockPath);
    if (holderIdentity === null || !isPidAlive(holderIdentity.pid)) {
      // Narrow the reclaim race: only unlink when the file still shows the
      // same dead holder. A fresh owner that slips in between is protected by
      // its own post-acquire nonce verification above, so a stolen unlink can
      // never produce two concurrent holders.
      const recheck = await readLockIdentity(lockPath);
      if (recheck?.pid === holderIdentity?.pid) {
        await unlink(lockPath).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      }
      continue;
    }
    await waitForLockRelease(lockPath, timeoutMs, holderIdentity.pid);
  }
}

async function acquireLocalLock(key) {
  const previous = localLocks.get(key) ?? Promise.resolve();
  let releaseCurrent;
  const current = new Promise((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.then(() => current);
  localLocks.set(key, tail);
  await previous;
  return () => {
    releaseCurrent();
    if (localLocks.get(key) === tail) localLocks.delete(key);
  };
}

function isConnectionRefused(error) {
  for (let cause = error; cause; cause = cause?.cause) {
    if (
      cause.code === "ECONNREFUSED" ||
      cause.code === "ENOTFOUND" ||
      // Bun's fetch reports refused connections with this code.
      cause.code === "ConnectionRefused"
    ) {
      return true;
    }
  }
  return false;
}

async function probeEndpoint(endpoint, timeoutMs) {
  const versionUrl = new URL("/json/version", endpoint);
  const response = await fetch(versionUrl, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `CDP discovery request failed (${response.status} ${response.statusText})`,
    );
  }
  const version = await response.json();
  if (
    typeof version?.webSocketDebuggerUrl !== "string" ||
    version.webSocketDebuggerUrl.length === 0
  ) {
    throw new Error("CDP discovery response lacks webSocketDebuggerUrl");
  }
  return version;
}

function profileDirFromArgs(browserArgs) {
  for (let index = 0; index < browserArgs.length; index += 1) {
    const argument = browserArgs[index];
    if (argument === "--user-data-dir" && browserArgs[index + 1]) {
      return path.resolve(browserArgs[index + 1]);
    }
    if (argument.startsWith("--user-data-dir=")) {
      return path.resolve(argument.slice("--user-data-dir=".length));
    }
  }
  return null;
}

function httpEndpointFromWebSocket(webSocketUrl) {
  const endpoint = new URL(webSocketUrl);
  endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
  endpoint.pathname = "/";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.toString().replace(/\/$/, "");
}

function parseActivePort(text) {
  const [portLine] = text.trim().split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return `http://127.0.0.1:${port}`;
}

async function terminateBrowser(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  let forceTimer;
  const force = new Promise((resolve) => {
    forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 5_000);
  });
  await Promise.race([exited, force]);
  clearTimeout(forceTimer);
  if (child.exitCode === null && child.signalCode === null) await exited;
}

async function discoverLaunchedEndpoint(
  child,
  { profileDir, timeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS } = {},
) {
  const activePortPath = profileDir
    ? path.join(profileDir, "DevToolsActivePort")
    : null;

  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";
    let activePortWatcher;
    let activePortRead = false;
    const cleanups = [];

    const finish = (error, endpoint) => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
      activePortWatcher?.close();
      if (error) reject(error);
      else resolve(endpoint);
    };

    const tryActivePort = async () => {
      if (!activePortPath || activePortRead || settled) return;
      activePortRead = true;
      try {
        const endpoint = parseActivePort(
          await readFile(activePortPath, "utf8"),
        );
        if (endpoint) finish(null, endpoint);
      } catch (error) {
        if (error?.code !== "ENOENT") finish(error);
      } finally {
        activePortRead = false;
      }
    };

    const onStderr = (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (match) finish(null, httpEndpointFromWebSocket(match[1]));
      else void tryActivePort();
    };
    const onError = (error) => finish(error);
    const onExit = (code, signal) => {
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

    if (activePortPath) {
      try {
        activePortWatcher = watch(profileDir, (event, filename) => {
          if (
            (event === "rename" || event === "change") &&
            (!filename ||
              filename.toString() === path.basename(activePortPath))
          ) {
            void tryActivePort();
          }
        });
      } catch (error) {
        if (error?.code !== "ENOENT") finish(error);
      }
      void tryActivePort();
    }

    const timeout = setTimeout(() => {
      finish(
        new Error(
          `browser did not expose a DevTools endpoint within ${timeoutMs}ms${stderr ? `\n${stderr}` : ""}`,
        ),
      );
    }, timeoutMs);
    cleanups.push(() => clearTimeout(timeout));
  });
}

function connectionOptions(options, profileDir) {
  const result = { ...(options.connectionOptions ?? {}) };
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
  return result;
}

async function launchNamed(
  name,
  { root, recordPath },
  options,
) {
  if (typeof options.browserPath !== "string" || options.browserPath.length === 0) {
    throw new TypeError(
      `connectNamed("${name}") requires browserPath when no healthy instance is registered`,
    );
  }
  const browserArgs = [...(options.browserArgs ?? [])];
  const profileDir = options.profileDir
    ? path.resolve(options.profileDir)
    : profileDirFromArgs(browserArgs);
  const child = spawn(
    options.browserPath,
    [
      ...browserArgs,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
    ],
    {
      ...(options.spawnOptions ?? {}),
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  let connection;
  try {
    const endpoint = await discoverLaunchedEndpoint(child, {
      profileDir,
      timeoutMs: options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS,
    });
    connection = await connect(
      endpoint,
      connectionOptions(options, profileDir),
    );
    const record = {
      version: RECORD_VERSION,
      name,
      pid: child.pid,
      endpoint,
      profileDir,
      browserPath: path.resolve(options.browserPath),
      startedAt: new Date().toISOString(),
    };
    await writeRecordAtomic(root, recordPath, record);
    connection.browserProcess = child;
    const disconnect = connection.close.bind(connection);
    connection.close = async () => {
      let disconnectError;
      try {
        await disconnect();
      } catch (error) {
        disconnectError = error;
      }
      await terminateBrowser(child);
      if (disconnectError) throw disconnectError;
    };
    return connection;
  } catch (error) {
    await connection?.close().catch(() => {});
    await terminateBrowser(child);
    throw error;
  }
}

export async function withEngineLock(registryRoot, engineKey, run) {
  const root = path.resolve(registryRoot ?? DEFAULT_REGISTRY_ROOT);
  await ensureRegistryRoot(root);
  const digest = createHash("sha256")
    .update(path.resolve(engineKey))
    .digest("hex")
    .slice(0, 16);
  const lockPath = path.join(root, `_engine-${digest}.lock`);
  const releaseLocal = await acquireLocalLock(lockPath);
  try {
    const release = await acquireLock(lockPath, DEFAULT_LOCK_TIMEOUT_MS);
    try {
      return await run();
    } finally {
      await release();
    }
  } finally {
    releaseLocal();
  }
}

export async function connectNamed(name, options = {}) {
  const normalizedName = normalizeName(name);
  const paths = registryPaths(options.registryRoot, normalizedName);
  await ensureRegistryRoot(paths.root);
  const releaseLocal = await acquireLocalLock(paths.lockPath);

  try {
    const release = await acquireLock(
      paths.lockPath,
      options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    );
    try {
      const loaded = await readRecord(paths.recordPath, normalizedName);
      if (loaded.record) {
        await chmod(paths.recordPath, 0o600);
        if (isPidAlive(loaded.record.pid)) {
          let healthy = false;
          try {
            await probeEndpoint(
              loaded.record.endpoint,
              options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
            );
            healthy = true;
          } catch (error) {
            if (!isConnectionRefused(error)) {
              throw new Error(
                `unresponsive holder "${normalizedName}" pid ${loaded.record.pid} endpoint ${loaded.record.endpoint}: ${error.message}`,
                { cause: error },
              );
            }
            // A live pid whose recorded debug port refuses connections is a
            // reused pid, not a holder: the record is stale and the launch
            // below reclaims it.
          }
          if (healthy) {
            return await connect(
              loaded.record.endpoint,
              connectionOptions(options, loaded.record.profileDir),
            );
          }
        }
      }

      if (loaded.exists) {
        await unlink(paths.recordPath).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      }
      return await launchNamed(normalizedName, paths, options);
    } finally {
      await release();
    }
  } finally {
    releaseLocal();
  }
}

export async function listInstances(options = {}) {
  const root = path.resolve(options.registryRoot ?? DEFAULT_REGISTRY_ROOT);
  await ensureRegistryRoot(root);
  const entries = await readdir(root, { withFileTypes: true });
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const expectedName = entry.name.slice(0, -".json".length);
        const recordPath = path.join(root, entry.name);
        const loaded = await readRecord(recordPath, expectedName);
        if (!loaded.record) return null;
        await chmod(recordPath, 0o600);
        const alive = isPidAlive(loaded.record.pid);
        let responsive = false;
        if (alive) {
          responsive = await probeEndpoint(
            loaded.record.endpoint,
            options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
          ).then(
            () => true,
            () => false,
          );
        }
        return { ...loaded.record, alive, responsive };
      }),
  );
  return records
    .filter((record) => record !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}
