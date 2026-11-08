import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { windowsSystemTool } from "../owner-only.ts";

const INSTALL_SH = "https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.sh";
const INSTALL_PS1 = "https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.ps1";
const RC_FILES = [".zshrc", ".bashrc", ".profile"];

export type InstallEnv = Record<string, string | undefined>;

export interface InstallCommand {
  command: string;
  args: string[];
  env: InstallEnv;
}

export interface InstallRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type InstallRunner = (command: string, args: string[], env: InstallEnv) => Promise<InstallRunResult>;

export interface InstallBskCliOptions {
  platform?: string;
  home?: string;
  installDir?: string | undefined;
  version?: string;
  run?: InstallRunner;
}

// A type alias (not an interface) so it also satisfies onboarding's open InstallOutcome shape.
export type InstallBskCliResult = {
  installed: boolean;
  bskBin: string | null;
  code: number | null;
  stdout: string;
  stderr: string;
  restoredRcFiles: string[];
};

// A PowerShell 7 parent hands its own module dirs to the Windows PowerShell 5.1
// child through PSModulePath. They shadow 5.1's Microsoft.PowerShell.Utility, so
// Get-FileHash is missing and the installer dies at checksum verification. Keep
// every entry except PowerShell 7's (...\PowerShell\..., never ...\WindowsPowerShell\...).
function windowsPowerShellEnv(env: InstallEnv): InstallEnv {
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === "PSMODULEPATH");
  if (!key) return env;
  const value = process.env[key];
  // A listed key always has a string value; reading one without failed with a TypeError before the types made it explicit.
  if (value === undefined) throw new TypeError(`${key} has no value`);
  const kept = value.split(";").filter((entry) => entry && !/[\\/]PowerShell[\\/]/i.test(entry));
  return { ...env, [key]: kept.length > 0 ? kept.join(";") : undefined };
}

export function cliInstallCommand({
  platform = process.platform,
  installDir,
  version,
}: { platform?: string; installDir?: string; version?: string | undefined } = {}): InstallCommand {
  const env: InstallEnv = { BSK_INSTALL_DIR: installDir };
  if (version) env["BSK_VERSION"] = version;
  if (platform === "win32") {
    return {
      command: windowsSystemTool("WindowsPowerShell\\v1.0\\powershell.exe"),
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm ${INSTALL_PS1} | iex`],
      env: windowsPowerShellEnv(env),
    };
  }
  return { command: "sh", args: ["-c", `curl -fsSL ${INSTALL_SH} | sh`], env };
}

export function runDefault(command: string, args: string[], env: InstallEnv): Promise<InstallRunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout = (stdout + c).slice(-8192);
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr = (stderr + c).slice(-8192);
    });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

export function snapshotRcFiles(home: string): Map<string, Buffer | null> {
  const snapshot = new Map<string, Buffer | null>();
  for (const name of RC_FILES) {
    const file = path.join(home, name);
    snapshot.set(file, existsSync(file) ? readFileSync(file) : null);
  }
  return snapshot;
}

export function restoreRcFiles(snapshot: ReadonlyMap<string, Buffer | null>): string[] {
  const restored: string[] = [];
  for (const [file, before] of snapshot) {
    const after = existsSync(file) ? readFileSync(file) : null;
    if (before === null && after === null) continue;
    if (before !== null && after !== null && before.equals(after)) continue;
    if (before === null) rmSync(file, { force: true });
    else writeFileSync(file, before);
    restored.push(file);
  }
  return restored;
}

export async function installBskCli({
  platform = process.platform,
  home = homedir(),
  installDir = path.join(home, ".local", "bin"),
  version,
  run = runDefault,
}: InstallBskCliOptions = {}): Promise<InstallBskCliResult> {
  const spec = cliInstallCommand({ platform, installDir, version });
  const rcBefore = platform === "win32" ? new Map<string, Buffer | null>() : snapshotRcFiles(home);
  const result = await run(spec.command, spec.args, spec.env);
  const restoredRcFiles = restoreRcFiles(rcBefore);
  const bskBin = path.join(installDir, platform === "win32" ? "bsk.exe" : "bsk");
  const installed = result.code === 0 && existsSync(bskBin);
  return {
    installed,
    bskBin: installed ? bskBin : null,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    restoredRcFiles,
  };
}

export function cliVersionDefault(bskBin: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(bskBin, ["--version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c;
    });
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code === 0 ? out.trim() : null));
  });
}
