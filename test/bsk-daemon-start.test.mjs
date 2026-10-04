import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startDaemonWithCli } from "../src/bsk/daemon-info.js";

// Platform contract: when bsk cannot detach its daemon from the caller's Job Object, the start
// must still succeed through a scheduled task, and that task must not open a console window.
const REFUSAL = "cannot start an independent Windows daemon; the host may prohibit Job Object breakaway";
const refusingStatus = `data:text/javascript,console.log(${encodeURIComponent(JSON.stringify(JSON.stringify({ message: REFUSAL, exit_code: 2 })))});process.exit(2)`;

function powershell(command) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8" }).trim();
}

test("a refused breakaway on Windows registers a headless scheduled task for the daemon", { skip: process.platform !== "win32" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bsk-task-"));
  const home = path.join(dir, "home");
  const findTask = `Get-ScheduledTask -TaskName 'bsk-daemon-*' | Where-Object { $_.Actions[0].Arguments -like '*${home}*' }`;
  try {
    await startDaemonWithCli({ home, bskBin: "node", env: { ...process.env, NODE_OPTIONS: `--import=${refusingStatus}` } });
    const [execute, args] = powershell(`$a = @(${findTask})[0].Actions[0]; $a.Execute + '|' + $a.Arguments`).split("|");
    assert.match(execute, /\\conhost\.exe$/i);
    assert.equal(args, `--headless cmd.exe /d /c set BSK_HOME=${home}&& "node" daemon start --foreground`);
  } finally {
    powershell(`${findTask} | Unregister-ScheduledTask -Confirm:$false; exit 0`);
    rmSync(dir, { recursive: true, force: true });
  }
});
