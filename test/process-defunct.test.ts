import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { processIsDefunct } from "../src/process-defunct.ts";

// Holds one child uncollected: the child exits at once, the parent waits for the kernel's own notice of that
// exit (SIGCHLD, blocked so nothing collects the child), prints the child's pid, then waits for stdin to close.
const HOLDER = [
  "import os, signal, sys",
  "signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGCHLD})",
  "child = os.fork()",
  "if child == 0: os._exit(0)",
  "signal.sigwait({signal.SIGCHLD})",
  "print(child, flush=True)",
  "sys.stdin.read()",
].join("\n");

function skipReason() {
  if (process.platform === "win32") return "Windows has no defunct process state";
  return spawnSync("python3", ["--version"]).status === 0 ? false : "needs python3 to hold a child uncollected";
}

// Platform contract (#369): an exited process its parent has not collected still answers kill(pid, 0). It
// holds no files, so the orphan reap has to tell it apart from a browser that is still running.
test("a process that exited without being collected is defunct; a running one is not", { skip: skipReason() }, async () => {
  const holder = spawn("python3", ["-c", HOLDER], { stdio: ["pipe", "pipe", "inherit"] });
  const exited = once(holder, "exit");
  try {
    const [line] = await once(holder.stdout, "data");
    const child = Number(String(line).trim());
    assert.ok(Number.isInteger(child) && child > 0, `the holder printed no child pid: ${String(line)}`);
    assert.ok(holder.pid !== undefined, "the holder process has no pid");

    assert.equal(await processIsDefunct(holder.pid), false);
    assert.equal(await processIsDefunct(child), true);
  } finally {
    holder.stdin.end();
    await exited;
  }
});
