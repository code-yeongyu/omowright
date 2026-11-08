import { unlink } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { probeOnce, tryAcquire } from "./lock-backend.ts";
import type { HeldLock } from "./lock-backend.ts";
import { readProperty } from "./read-property.ts";

const localLocks = new Map<string, Promise<unknown>>();

function errorCode(error: unknown): unknown {
  return error === null || error === undefined ? undefined : readProperty(error, "code");
}

export function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "EPERM") return true;
    if (errorCode(error) === "ESRCH") return false;
    throw error;
  }
}

export async function unlinkIfPresent(target: string) {
  await unlink(target).catch((error: unknown) => {
    if (errorCode(error) !== "ENOENT") throw error;
  });
}

async function acquireLock(lockPath: string, timeoutMs: number): Promise<HeldLock> {
  const deadline = performance.now() + timeoutMs;
  let delay = 10;
  for (;;) {
    const held = await tryAcquire(lockPath);
    if (held) {
      try {
        await probeOnce(lockPath);
        return held;
      } catch (error) {
        await held.release();
        throw error;
      }
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error(`timed out waiting for instance lock ${lockPath}`);
    await sleep(Math.min(remaining, delay * (0.75 + Math.random() * 0.5)));
    delay = Math.min(delay * 2, 250);
  }
}

async function acquireLocalLock(key: string) {
  const previous = localLocks.get(key) ?? Promise.resolve();
  let releaseCurrent: (value: void) => void;
  const current = new Promise<void>((resolve) => {
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

// The kernel owns exclusion and crash release; the local FIFO avoids polling
// between callers in this process. Neither acquisition nor release removes files.
export async function withLock<T>(
  lockPath: string,
  { timeoutMs }: { timeoutMs: number },
  run: () => Promise<T>,
): Promise<T> {
  const releaseLocal = await acquireLocalLock(lockPath);
  try {
    const held = await acquireLock(lockPath, timeoutMs);
    try {
      return await run();
    } finally {
      await held.release();
    }
  } finally {
    releaseLocal();
  }
}
