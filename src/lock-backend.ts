import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { readProperty } from "./read-property.ts";

// xnu bsd/sys/fcntl.h: O_EXLOCK and O_NONBLOCK. Node does not export O_EXLOCK.
const DARWIN_EXCLUSIVE_NONBLOCK = 0x20 | 0x4;
// libuv include/uv/win.h: UV_FS_O_EXLOCK makes CreateFile's share mode zero.
const WINDOWS_EXCLUSIVE = 0x10000000;
/** An acquired instance lock; release() closes the handle that holds it. */
export interface HeldLock {
  release(): Promise<void> | void;
}

const probedPaths = new Set<string>();
const DARWIN_BUSY_CODES: readonly unknown[] = ["EAGAIN", "EWOULDBLOCK"];

async function lockLinux(fd: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const child = spawn("flock", ["-n", "3"], {
      stdio: ["ignore", "ignore", "pipe", fd],
    });
    let stderr = "";
    // stdio[2] is "pipe", so stderr is always a stream here; the JS original hit a
    // TypeError at this point otherwise, and so does this check.
    const stderrStream = child.stderr;
    if (stderrStream === null) throw new TypeError("flock child has no stderr pipe");
    stderrStream.setEncoding("utf8");
    stderrStream.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT"
        ? new Error(`instance lock needs the flock utility (util-linux or busybox) on Linux: ${error.message}`, { cause: error })
        : error);
    });
    // close follows exit and drains stderr, so real utility errors are intact.
    child.once("close", (code, signal) => {
      if (code === 0) resolve(true);
      // util-linux and BusyBox are silent on EWOULDBLOCK. BusyBox also
      // returns 1 for real errors, but prints their errno description.
      else if (code === 1 && stderr.trim() === "") resolve(false);
      else reject(Object.assign(
        new Error(`instance lock flock failed (${signal ?? code}): ${stderr.trim()}`),
        { code: "ERR_INSTANCE_LOCK" },
      ));
    });
  });
}

export async function tryAcquire(lockPath: string): Promise<HeldLock | null> {
  const platform = process.platform;
  // Bun on Windows drops libuv's exclusive-open bit. Use the same kernel
  // share reservation directly; Node and non-Windows runtimes never load FFI.
  if (platform === "win32" && process.versions.bun) {
    const { tryAcquireWindows } = await import("./lock-backend-win32.js");
    return tryAcquireWindows(lockPath);
  }
  let flags = constants.O_RDWR | constants.O_CREAT;
  if (platform === "darwin") flags |= DARWIN_EXCLUSIVE_NONBLOCK;
  else if (platform === "win32") flags |= WINDOWS_EXCLUSIVE;
  else if (platform !== "linux") throw new Error(`instance lock is unsupported on ${platform}`);

  let handle: FileHandle;
  try {
    handle = await open(lockPath, flags, 0o600);
  } catch (error) {
    if (platform === "darwin" && DARWIN_BUSY_CODES.includes(readProperty(error, "code"))) return null;
    if (platform === "win32" && readProperty(error, "code") === "EBUSY") return null;
    throw error;
  }
  try {
    if (platform === "linux" && !await lockLinux(handle.fd)) {
      await handle.close();
      return null;
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
  // The runtime opens close-on-exec; only the one-shot flock child receives it.
  // Never unlink: another opener must always reach the same kernel object.
  return { release: () => handle.close() };
}

export async function probeOnce(lockPath: string) {
  if (probedPaths.has(lockPath)) return;
  const second = await tryAcquire(lockPath);
  if (second !== null) {
    await second.release();
    throw new Error(`instance lock is not enforced for ${lockPath} on this runtime and filesystem`);
  }
  probedPaths.add(lockPath);
}
