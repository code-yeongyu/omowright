import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { restoreRcFiles, runDefault, snapshotRcFiles } from "../bsk/install-cli.js";
import { findAsideBinary } from "./session.js";

const INSTALL_SH = "https://releases.aside.com/install.sh";
const APP_STEP = "Ask the user to install the Aside browser (aside.com, macOS 15+ or Windows 10 22H2+) and sign in, then re-run asideOnboard().";
const LOGIN_STEP = "Ask the user to sign the CLI in: run `aside login` in their terminal and approve the 8-digit code in Aside > Settings > Account > Devices. Then re-run asideOnboard().";
const WINDOWS_CLI_STEP = "Ask the user to install the Aside CLI from Aside > Settings > Developers, then re-run asideOnboard().";

export function asideCliInstallCommand() {
  return { command: "bash", args: ["-c", `curl -fsSL ${INSTALL_SH} | bash`], env: {} };
}

// The CLI's installer may append a PATH line to shell rc files; the user's rc files stay as
// they were, and connectAside finds the binary at its install path instead.
export async function installAsideCli({ home = homedir(), run = runDefault } = {}) {
  const spec = asideCliInstallCommand();
  const rcBefore = snapshotRcFiles(home);
  const result = await run(spec.command, spec.args, spec.env);
  const restoredRcFiles = restoreRcFiles(rcBefore);
  const asideBin = path.join(home, ".local", "bin", "aside");
  const installed = result.code === 0 && existsSync(asideBin);
  return { installed, asideBin: installed ? asideBin : null, code: result.code, stdout: result.stdout, stderr: result.stderr, restoredRcFiles };
}

function capture(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code === 0 ? out : null));
  });
}

function plistString(file, key) {
  try {
    const text = readFileSync(file, "utf8");
    const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function findAsideApp({ platform = process.platform, home = homedir(), exists = existsSync } = {}) {
  if (platform !== "darwin") return { installed: null, path: null, version: null };
  for (const dir of ["/Applications", path.join(home, "Applications")]) {
    const app = path.join(dir, "Aside.app");
    if (!exists(app)) continue;
    const info = path.join(app, "Contents", "Info.plist");
    return { installed: true, path: app, version: plistString(info, "CFBundleShortVersionString") };
  }
  return { installed: false, path: null, version: null };
}

// `aside account status` prints the active account as `* <id>  <name>  signed in|signed out ...`.
export function parseAccountStatus(output) {
  const active = output.split("\n").find((line) => line.trimStart().startsWith("*"));
  if (!active) return { signedIn: false, account: null };
  const account = /^\s*\*\s+(\S+)/.exec(active)[1];
  return { signedIn: /\bsigned in\b/.test(active), account };
}

async function cliReport({ asideCommand, env, home }) {
  const command = asideCommand ?? [findAsideBinary({ env, home })];
  if (!command[0]) return { cli: { installed: false, bin: null, version: null }, auth: { signedIn: false, account: null } };
  const [bin, ...lead] = command;
  const version = await capture(bin, [...lead, "--version"], env);
  if (version === null) return { cli: { installed: false, bin, version: null }, auth: { signedIn: false, account: null } };
  const status = await capture(bin, [...lead, "account", "status"], env);
  return { cli: { installed: true, bin, version: version.trim() }, auth: status === null ? { signedIn: false, account: null } : parseAccountStatus(status) };
}

function nextStepFor({ platform, app, cli, auth }) {
  if (app.installed === false) return APP_STEP;
  if (!cli.installed) return platform === "win32" ? WINDOWS_CLI_STEP : "Install the Aside CLI (asideOnboard() runs the official installer).";
  if (!auth.signedIn) return LOGIN_STEP;
  return null;
}

export async function asideDoctor({ platform = process.platform, home = homedir(), env = process.env, exists = existsSync, asideCommand } = {}) {
  const app = findAsideApp({ platform, home, exists });
  const { cli, auth } = await cliReport({ asideCommand, env, home });
  const report = { platform, app, cli, auth, ready: app.installed !== false && cli.installed && auth.signedIn };
  report.nextStep = nextStepFor(report);
  return report;
}

// asideDoctor plus every step a program can take: a missing CLI is installed with Aside's
// official installer (macOS and Linux). Steps only a person can take come back in nextStep.
export async function asideOnboard({ platform = process.platform, home = homedir(), env = process.env, exists = existsSync, asideCommand, installCli = installAsideCli } = {}) {
  let report = await asideDoctor({ platform, home, env, exists, asideCommand });
  let install = null;
  if (!report.cli.installed && platform !== "win32") {
    install = await installCli({ home });
    if (install.installed) report = await asideDoctor({ platform, home, env, exists, asideCommand: [install.asideBin] });
  }
  return { ...report, install };
}
