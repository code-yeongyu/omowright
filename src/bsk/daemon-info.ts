// Discovery of a running BrowserSkill daemon: `$BSK_HOME/daemon.json` is the
// file the daemon writes at start-up (`crates/bsk-cli/src/daemon/info.rs`)
// and the CLI reads to find the IPC socket. Nothing here talks to the socket.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { windowsSystemTool } from "../owner-only.ts";

export interface DaemonInfo {
  sock_path: string;
  [field: string]: unknown;
}

export interface StartDaemonOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  bskBin?: string;
  timeoutMs?: number;
}

interface ExitResult {
  code: number | null;
  output: string;
}

function isDaemonInfo(value: unknown): value is DaemonInfo {
  if (!value || typeof value !== "object" || !("sock_path" in value)) return false;
  return typeof value.sock_path === "string" && value.sock_path.length > 0;
}

export function resolveBskHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["BSK_HOME"];
  if (typeof override === "string" && override.length > 0) return override;
  const home = env["HOME"] && env["HOME"].length > 0 ? env["HOME"] : homedir();
  return path.join(home, ".bsk");
}

export function daemonInfoPath(home: string): string {
  return path.join(home, "daemon.json");
}

export function readDaemonInfo(home: string): DaemonInfo | null {
  let raw: string;
  try {
    raw = readFileSync(daemonInfoPath(home), "utf8");
  } catch {
    return null;
  }
  let info: unknown;
  try {
    info = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isDaemonInfo(info)) return null;
  return info;
}

export function findBskBinary(env: NodeJS.ProcessEnv = process.env): string {
  const home = env["HOME"] && env["HOME"].length > 0 ? env["HOME"] : homedir();
  const candidates = [
    env["BSK_BIN"],
    path.join(home, ".local", "bin", process.platform === "win32" ? "bsk.exe" : "bsk"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return "bsk";
}

// bsk refuses to detach its daemon when the caller's Job Object forbids breakaway, as agent
// sandboxes on Windows do, and asks for `bsk daemon start --foreground` in a persistent host task.
const NO_BREAKAWAY = /Job Object/;

export function windowsDaemonTaskName(home: string): string {
  return `bsk-daemon-${createHash("sha256").update(path.resolve(home).toLowerCase()).digest("hex").slice(0, 12)}`;
}

// Task Scheduler starts the action outside the caller's job. conhost --headless gives the console
// program a console without a window; a task that starts bsk directly opens one in the default
// terminal, and Windows Terminal ignores the hidden-window flag a task or PowerShell passes.
// The home and binary travel as PowerShell single-quoted literals inside -EncodedCommand: conhost
// re-parses a cmd.exe line and drops it at the first &, (, ^ or |, and cmd.exe expands % in quotes.
const powershellLiteral = (value: string) =>
  `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, (quote) => quote + quote)}'`;

function windowsDaemonLaunch(home: string, bskBin: string): string {
  const script = `$env:BSK_HOME = ${powershellLiteral(home)}; & ${powershellLiteral(bskBin)} daemon start --foreground; exit $LASTEXITCODE`;
  return `--headless "${windowsSystemTool("WindowsPowerShell\\v1.0\\powershell.exe")}" -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

function startDaemonInWindowsTask({
  home,
  bskBin,
  timeoutMs,
}: {
  home: string;
  bskBin: string;
  timeoutMs: number;
}): Promise<ExitResult> {
  const script = [
    "$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\\conhost.exe') -Argument $env:BSK_TASK_ARGUMENT",
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew",
    "Register-ScheduledTask -TaskName $env:BSK_TASK_NAME -Action $action -Settings $settings -Force | Out-Null",
    "Start-ScheduledTask -TaskName $env:BSK_TASK_NAME",
  ].join("; ");
  return runToExit(
    windowsSystemTool("WindowsPowerShell\\v1.0\\powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: {
        ...process.env,
        BSK_TASK_NAME: windowsDaemonTaskName(home),
        BSK_TASK_ARGUMENT: windowsDaemonLaunch(home, bskBin),
      },
      timeoutMs,
      label: "registering the bsk daemon task",
    },
  );
}

function runToExit(
  command: string,
  args: string[],
  { env, timeoutMs, label }: { env: NodeJS.ProcessEnv; timeoutMs: number; label: string },
): Promise<ExitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    const keep = (chunk: Buffer) => {
      output = (output + chunk).slice(-4096);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${label} did not return within ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`could not run ${command}: ${error.message}`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output: output.trim() });
    });
  });
}

export async function startDaemonWithCli({
  home,
  env = process.env,
  bskBin = findBskBinary(env),
  timeoutMs = 20_000,
}: StartDaemonOptions = {}): Promise<void> {
  const status = await runToExit(bskBin, ["status", "--json"], {
    env: { ...env, BSK_HOME: home },
    timeoutMs,
    label: "bsk status",
  });
  if (status.code === 0) return;
  if (process.platform === "win32" && NO_BREAKAWAY.test(status.output)) {
    // path.resolve rejected a missing home here before the types made it explicit.
    if (home === undefined) throw new TypeError("startDaemonWithCli needs a home to register the Windows daemon task");
    const task = await startDaemonInWindowsTask({ home, bskBin, timeoutMs });
    if (task.code === 0) return;
    // Keep bsk's refusal in the message: it is why a retry cannot help, and bskDoctor reads it.
    throw new Error(
      `${status.output}; registering the bsk daemon task exited with ${task.code}${task.output ? `: ${task.output}` : ""}`,
    );
  }
  throw new Error(`bsk status exited with ${status.code}${status.output ? `: ${status.output}` : ""}`);
}
