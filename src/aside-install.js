import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAsideRepl, runAside } from "./aside-repl.js";

export const ASIDE_INSTALL_URL = "https://releases.aside.com/install.sh";
export const ASIDE_INSTALL_COMMAND = `curl -fsSL ${ASIDE_INSTALL_URL} | bash`;

const VERIFY_CODE = `const page = await openTab("about:blank"); console.log(await page.title());`;
const SIGN_IN_HINT = /signed (?:in|out)|sign-?in|log ?in|account/i;
const INSTALLER_PLATFORMS = new Set(["darwin", "linux"]);

export function asidePaths({ home = os.homedir(), appPath = "/Applications/Aside.app", platform = process.platform } = {}) {
  const commandPath = path.join(home, ".local", "bin", "aside");
  if (platform === "darwin") {
    const cliApp = path.join(home, ".aside", "cli", "Aside CLI.app");
    return {
      platform,
      appPath,
      cliApp,
      commandPath,
      appExecutable: path.join(appPath, "Contents", "MacOS", "Aside"),
      cliExecutable: path.join(cliApp, "Contents", "MacOS", "aside"),
    };
  }
  if (platform === "linux") {
    return {
      platform,
      appPath: null,
      cliApp: null,
      commandPath,
      appExecutable: null,
      cliExecutable: path.join(home, ".aside", "cli", "aside"),
    };
  }
  return { platform, appPath: null, cliApp: null, commandPath: null, appExecutable: null, cliExecutable: null };
}

export function resolveOnPath({
  command = "aside",
  envPath = process.env.PATH ?? "",
  delimiter = path.delimiter,
  exists = existsSync,
} = {}) {
  for (const dir of envPath.split(delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function detectAsideInstall({ paths = asidePaths(), exists = existsSync, envPath } = {}) {
  const app = paths.appPath ? exists(paths.appPath) : false;
  const bundle = paths.cliApp ? exists(paths.cliApp) : false;
  const command = paths.commandPath ? exists(paths.commandPath) : false;
  const onPath = resolveOnPath({ exists, ...(envPath === undefined ? {} : { envPath }) });
  const executable = bundle ? paths.cliExecutable : command ? paths.commandPath : onPath;
  const where = bundle ? "cli-bundle" : command ? "install-link" : onPath ? "path" : null;
  const state = app && executable ? "app-and-cli" : app ? "app-only" : executable ? "cli-only" : "absent";
  return { state, app, bundle, command, executable, where };
}

export async function installAsideCli({
  paths = asidePaths(),
  execute = false,
  command = ASIDE_INSTALL_COMMAND,
  timeoutMs = 300_000,
  env,
  runProcess = runAside,
} = {}) {
  if (!execute) {
    return { executed: false, ok: false, command, paths, detail: "pass execute: true to run the vendor installer" };
  }
  const result = await runProcess({ bin: "bash", args: ["-c", command], timeoutMs, ...(env ? { env } : {}) });
  const output = `${result.stdout}${result.stderr}`.trim();
  return { executed: true, ok: result.code === 0, code: result.code, command, output, paths };
}

/**
 * `aside --version` only proves a binary exists; a real `repl` round trip proves
 * the browser behind it answers and the account is signed in.
 */
export async function verifyAside({ bin = "aside", timeoutMs = 30_000, runProcess = runAside } = {}) {
  const result = await runProcess({ bin, args: ["repl", VERIFY_CODE], timeoutMs });
  const parsed = parseAsideRepl(result.stdout, result.code);
  const detail = parsed.output.split("\n")[0] || `${result.stderr.trim() || parsed.status}`;
  return {
    usable: parsed.ok,
    ms: parsed.ms,
    output: parsed.output,
    needsSignIn: !parsed.ok && SIGN_IN_HINT.test(`${parsed.output}\n${result.stderr}`),
    detail,
  };
}

const SIGN_IN_INSTRUCTION =
  "Run `aside login`, then approve the code in Aside > Settings > Account > Devices; the CLI is installed and only the sign-in is missing.";

const ACCOUNT_LINE = /^\*?\s*(u\d+)\s+(\S+)\s+(signed in|signed out)/m;

export async function asideAccount({ bin = "aside", timeoutMs = 15_000, runProcess = runAside } = {}) {
  const result = await runProcess({ bin, args: ["account", "status"], timeoutMs });
  const line = ACCOUNT_LINE.exec(result.stdout ?? "");
  if (!line) {
    return {
      known: false,
      signedIn: null,
      account: null,
      detail: (result.stderr || result.stdout || "no account status").trim().split("\n")[0],
    };
  }
  return { known: true, signedIn: line[3] === "signed in", account: line[1], detail: line[0].trim() };
}

function missingInstallInstruction({ detected, platform }) {
  if (!INSTALLER_PLATFORMS.has(platform)) {
    return `The Aside CLI installer for ${platform} is not wired up in this library yet (Windows ships a signed install.ps1); a follow-up, not a guess.`;
  }
  const installLine = `Install the Aside CLI: ${ASIDE_INSTALL_COMMAND}`;
  return detected.app
    ? installLine
    : `Install Aside from https://aside.com first, then run the CLI installer (${ASIDE_INSTALL_COMMAND}).`;
}

export async function ensureAside({
  install = "never",
  platform,
  paths,
  exists = existsSync,
  envPath,
  runProcess = runAside,
  timeoutMs = 30_000,
  installTimeoutMs = 300_000,
} = {}) {
  const resolvedPlatform = platform ?? paths?.platform ?? process.platform;
  const resolvedPaths = paths ?? asidePaths({ platform: resolvedPlatform });
  const steps = [];
  const detected = detectAsideInstall({ paths: resolvedPaths, exists, ...(envPath === undefined ? {} : { envPath }) });
  const installed = detected.executable !== null;
  steps.push({ step: "detect", ok: installed, detail: detected.state, where: detected.where });

  let current = detected;
  if (!current.executable && install === "run" && INSTALLER_PLATFORMS.has(resolvedPlatform)) {
    const installer = await installAsideCli({ paths: resolvedPaths, execute: true, timeoutMs: installTimeoutMs, runProcess });
    steps.push({ step: "install", ok: installer.ok, detail: installer.ok ? "vendor installer finished" : installer.output });
    if (installer.ok) current = detectAsideInstall({ paths: resolvedPaths, exists, ...(envPath === undefined ? {} : { envPath }) });
  } else if (!current.executable) {
    const offered = install === "offer" ? ASIDE_INSTALL_COMMAND : "install was not permitted";
    steps.push({ step: "install", ok: false, detail: INSTALLER_PLATFORMS.has(resolvedPlatform) ? offered : "no installer wired up for this platform" });
  }

  if (!current.executable) {
    return {
      usable: false,
      state: current.state,
      platform: resolvedPlatform,
      steps,
      instruction: missingInstallInstruction({ detected: current, platform: resolvedPlatform }),
    };
  }

  const verified = await verifyAside({ bin: current.executable, timeoutMs, runProcess });
  steps.push({ step: "verify", ok: verified.usable, detail: verified.detail });

  const account = verified.usable ? null : await asideAccount({ bin: current.executable, runProcess });
  const needsSignIn = account?.known ? account.signedIn === false : verified.needsSignIn;

  return {
    usable: verified.usable,
    state: verified.usable ? "ready" : "installed-unverified",
    platform,
    bin: current.executable,
    account,
    steps,
    ms: verified.ms,
    ...(verified.usable ? {} : { instruction: needsSignIn ? SIGN_IN_INSTRUCTION : verified.detail }),
  };
}
