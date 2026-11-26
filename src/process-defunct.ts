import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Whether `pid` names a process that has exited and waits for its parent to collect it (a zombie). Such an
// entry still answers kill(pid, 0) but runs nothing and holds no files. False when the process is running,
// is gone, or the platform cannot say: a caller that must not mistake a live process for a dead one treats
// "cannot say" as live. Windows has no such state.
export async function processIsDefunct(pid: number): Promise<boolean> {
  if (process.platform === "win32") return false;
  if (process.platform === "linux") {
    try {
      const text = await readFile(`/proc/${pid}/stat`, "utf8");
      // Field 3 (state) is the first one after the parenthesised comm.
      return text.slice(text.lastIndexOf(")") + 2).startsWith("Z");
    } catch {
      return false;
    }
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "stat=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C" },
    });
    return stdout.trim().startsWith("Z");
  } catch {
    return false;
  }
}
