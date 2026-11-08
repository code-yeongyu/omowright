import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { restoreRcFiles, runDefault, snapshotRcFiles } from "../bsk/install-cli.ts";
import { findAsideBinary } from "./cli-binary.ts";
import type { AsideCommand } from "./cli-binary.ts";

export interface AsideRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type AsideCliRunner = (
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
) => Promise<AsideRunResult>;

export interface AsideCliInstallCommand {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}

export interface InstallAsideCliOptions {
  home?: string;
  run?: AsideCliRunner;
}

// A type alias (not an interface) so it also satisfies the open AsideCliInstallOutcome shape.
export type InstallAsideCliResult = {
  installed: boolean;
  asideBin: string | null;
  code: number | null;
  stdout: string;
  stderr: string;
  restoredRcFiles: string[];
};

// Open: a caller's own installer may report more fields, and asideOnboard reads only these.
export type AsideCliInstallOutcome = { installed: boolean; asideBin?: string | null; [key: string]: unknown };

export interface AsideCliReport {
  installed: boolean;
  bin: string | null;
  version: string | null;
}

export interface AsideAuthReport {
  signedIn: boolean;
  account: string | null;
}

export interface AsideAppReport {
  installed: boolean | null;
  path: string | null;
  version: string | null | undefined;
}

export interface AsideDoctorReport {
  platform: string;
  app: AsideAppReport;
  cli: AsideCliReport;
  auth: AsideAuthReport;
  ready: boolean;
  nextStep: string | null;
}

export interface AsideOnboardReport extends AsideDoctorReport {
  install: AsideCliInstallOutcome | null;
}

export interface FindAsideAppOptions {
  platform?: string;
  home?: string;
  exists?: (file: string) => boolean;
}

export interface AsideDoctorOptions extends FindAsideAppOptions {
  env?: NodeJS.ProcessEnv;
  asideCommand?: AsideCommand | undefined;
  account?: string | undefined;
}

export interface AsideOnboardOptions extends AsideDoctorOptions {
  installOnlyWithApp?: boolean;
  installCli?: (options: { home: string }) => Promise<AsideCliInstallOutcome>;
}

interface CliReportOptions {
  asideCommand: AsideCommand | undefined;
  env: NodeJS.ProcessEnv;
  home: string;
  account: string | undefined;
}

const INSTALL_SH = "https://releases.aside.com/install.sh";
const APP_STEP =
  "Ask the user to install the Aside browser (aside.com, macOS 15+ or Windows 10 22H2+) and sign in, then re-run asideOnboard().";
const loginStep = (bin: string | null, account: string | null) =>
  `Ask the user to sign the CLI in: run \`${bin}${account ? ` --account ${account}` : ""} login\` in their terminal and approve the 8-digit code in Aside > Settings > Account > Devices. Then re-run asideOnboard().`;
const WINDOWS_CLI_STEP =
  "Ask the user to install the Aside CLI from Aside > Settings > Developers, then re-run asideOnboard().";

export function asideCliInstallCommand(): AsideCliInstallCommand {
  return { command: "bash", args: ["-c", `curl -fsSL ${INSTALL_SH} | bash`], env: {} };
}

// The CLI's installer may append a PATH line to shell rc files; the user's rc files stay as
// they were, and connectAside finds the binary at its install path instead.
export async function installAsideCli({
  home = homedir(),
  run = runDefault,
}: InstallAsideCliOptions = {}): Promise<InstallAsideCliResult> {
  const spec = asideCliInstallCommand();
  const rcBefore = snapshotRcFiles(home);
  const result = await run(spec.command, spec.args, spec.env);
  const restoredRcFiles = restoreRcFiles(rcBefore);
  const asideBin = path.join(home, ".local", "bin", "aside");
  const installed = result.code === 0 && existsSync(asideBin);
  return {
    installed,
    asideBin: installed ? asideBin : null,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    restoredRcFiles,
  };
}

function capture(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<string | null>((resolve) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      out += chunk;
    });
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code === 0 ? out : null));
  });
}

function plistString(file: string, key: string) {
  try {
    const text = readFileSync(file, "utf8");
    const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function findAsideApp({
  platform = process.platform,
  home = homedir(),
  exists = existsSync,
}: FindAsideAppOptions = {}): AsideAppReport {
  if (platform !== "darwin") return { installed: null, path: null, version: null };
  for (const dir of ["/Applications", path.join(home, "Applications")]) {
    const app = path.join(dir, "Aside.app");
    if (!exists(app)) continue;
    const info = path.join(app, "Contents", "Info.plist");
    return { installed: true, path: app, version: plistString(info, "CFBundleShortVersionString") };
  }
  return { installed: false, path: null, version: null };
}

// `aside account status` prints one line per account, `[*] <id>  <name>  signed in|signed out ...`,
// with `*` on the active one; `--account <id>` narrows it to that account's line.
export function parseAccountStatus(output: string, account?: string): AsideAuthReport {
  const rows: { active: boolean; id: string; signedIn: boolean }[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\*\s+)?(\S+)\s.*\bsigned (in|out)\b/.exec(line);
    // Group 2 always takes part in a match; the check only tells the type system so.
    const id = match?.[2];
    if (match && id !== undefined) rows.push({ active: Boolean(match[1]), id, signedIn: match[3] === "in" });
  }
  const row = account ? rows.find((r) => r.id === account) : rows.find((r) => r.active);
  return row ? { signedIn: row.signedIn, account: row.id } : { signedIn: false, account: account ?? null };
}

async function cliReport({
  asideCommand,
  env,
  home,
  account,
}: CliReportOptions): Promise<{ cli: AsideCliReport; auth: AsideAuthReport }> {
  const command: AsideCommand = asideCommand ?? [findAsideBinary({ env, home })];
  const [bin, ...lead] = command;
  if (!bin) return { cli: { installed: false, bin: null, version: null }, auth: { signedIn: false, account: null } };
  const version = await capture(bin, [...lead, "--version"], env);
  if (version === null)
    return { cli: { installed: false, bin, version: null }, auth: { signedIn: false, account: null } };
  const status = await capture(bin, [...lead, ...(account ? ["--account", account] : []), "account", "status"], env);
  return {
    cli: { installed: true, bin, version: version.trim() },
    auth: status === null ? { signedIn: false, account: account ?? null } : parseAccountStatus(status, account),
  };
}

function nextStepFor({ platform, app, cli, auth }: AsideDoctorReport) {
  if (app.installed === false) return APP_STEP;
  if (!cli.installed)
    return platform === "win32"
      ? WINDOWS_CLI_STEP
      : "Install the Aside CLI (asideOnboard() runs the official installer).";
  if (!auth.signedIn) return loginStep(cli.bin, auth.account);
  return null;
}

export async function asideDoctor({
  platform = process.platform,
  home = homedir(),
  env = process.env,
  exists = existsSync,
  asideCommand,
  account,
}: AsideDoctorOptions = {}): Promise<AsideDoctorReport> {
  const app = findAsideApp({ platform, home, exists });
  const { cli, auth } = await cliReport({ asideCommand, env, home, account });
  // nextStep is filled in below from the finished report, as before.
  const report: AsideDoctorReport = {
    platform,
    app,
    cli,
    auth,
    ready: app.installed !== false && cli.installed && auth.signedIn,
    nextStep: null,
  };
  report.nextStep = nextStepFor(report);
  return report;
}

// asideDoctor plus every step a program can take: a missing CLI is installed with Aside's
// official installer (macOS and Linux), never when the Aside app is known to be missing.
// installOnlyWithApp (connectAside's setup) installs only when the app was actually found.
// Steps only a person can take come back in nextStep.
export async function asideOnboard({
  platform = process.platform,
  home = homedir(),
  env = process.env,
  exists = existsSync,
  asideCommand,
  account,
  installOnlyWithApp = false,
  installCli = installAsideCli,
}: AsideOnboardOptions = {}): Promise<AsideOnboardReport> {
  let report = await asideDoctor({ platform, home, env, exists, asideCommand, account });
  let install: AsideCliInstallOutcome | null = null;
  const appAllows = installOnlyWithApp ? report.app.installed === true : report.app.installed !== false;
  if (!report.cli.installed && platform !== "win32" && appAllows) {
    install = await installCli({ home });
    if (install.installed)
      report = await asideDoctor({ platform, home, env, exists, asideCommand: [install.asideBin], account });
  }
  return { ...report, install };
}
