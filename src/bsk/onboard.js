import { homedir } from "node:os";
import { findBskBinary } from "./daemon-info.js";
import { BskIpcClient } from "./ipc-client.js";
import { listBrowsers } from "./connect.js";
import { detectBrowsers, externalExtensionEntry, registerExternalExtension, STORE_PAGE_URLS } from "./external-extension.js";
import { existsSync, readFileSync } from "node:fs";
import { cliVersionDefault, installBskCli } from "./install-cli.js";

const DEFAULT_WAIT_TOTAL_MS = 180_000;

function resolveBskBin(bskBin, env) {
  if (bskBin === null) return null;
  return bskBin ?? findBskBinary(env);
}

async function cliReport({ bskBin, env, cliVersion }) {
  const bin = resolveBskBin(bskBin, env);
  if (!bin) return { installed: false, bskBin: null, version: null };
  const raw = await cliVersion(bin);
  return raw ? { installed: true, bskBin: bin, version: raw.replace(/^bsk\s+/, "") } : { installed: false, bskBin: bin, version: null };
}

async function daemonReport(client, waitForBrowserMs) {
  try {
    const status = await client.call("system.status", waitForBrowserMs > 0 ? { wait_for_browser_ms: waitForBrowserMs } : {}, { idPrefix: "status" });
    return { running: true, version: status.daemon_version, protocolVersion: status.protocol_version, browsers: status.browsers ?? [], sessions: status.sessions ?? [] };
  } catch (error) {
    return { running: false, error: error.message, code: error.code, browsers: [], sessions: [] };
  }
}

function browserRows({ platform, home, env }) {
  return detectBrowsers({ platform, home, env }).map((browser) => {
    const entry = externalExtensionEntry({ platform, browser });
    const extensionRegistered = entry.kind === "file" && existsSync(entry.path) && readFileSync(entry.path, "utf8") === entry.content;
    return { ...browser, registration: entry, extensionRegistered };
  });
}

function nextStepFor({ cli, daemon, browsers, browsersConnected }) {
  if (browsersConnected.length > 0) return null;
  if (!cli.installed) return "Install the bsk CLI (bskOnboard() runs the official installer).";
  if (!daemon.running) return "Start the BrowserSkill daemon: run `bsk status` once, or `bsk daemon start` in the environment that owns it.";
  if (browsers.length === 0) return `No Chromium-family browser profile was found; install Chrome or Edge and add the extension from ${STORE_PAGE_URLS.chrome}.`;
  const unregistered = browsers.find((b) => !b.extensionRegistered);
  if (unregistered) return `Register the BrowserSkill extension for ${unregistered.id} (bskOnboard() does this), then let the user enable it.`;
  return browsers[0].registration.humanStep;
}

export async function bskDoctor({ platform = process.platform, home = homedir(), env = process.env, client, bskBin, cliVersion = cliVersionDefault, waitForBrowserMs = 0 } = {}) {
  const cli = await cliReport({ bskBin, env, cliVersion });
  const ipc = client ?? new BskIpcClient({ env, bskBin: cli.bskBin ?? undefined, autoStart: false });
  const daemon = await daemonReport(ipc, waitForBrowserMs);
  const browsers = browserRows({ platform, home, env });
  const browsersConnected = daemon.browsers;
  const report = { cli, daemon, browsers, browsersConnected, ready: browsersConnected.length > 0 };
  report.nextStep = nextStepFor(report);
  return report;
}

export async function bskOnboard({
  platform = process.platform, home = homedir(), env = process.env, client, bskBin, installDir,
  installCli = installBskCli, cliVersion = cliVersionDefault, onHumanStep = () => {},
  waitForBrowserMs = 15_000, waitTotalMs = DEFAULT_WAIT_TOTAL_MS,
} = {}) {
  let cli = await cliReport({ bskBin, env, cliVersion });
  let install = null;
  if (!cli.installed) {
    install = await installCli({ platform, home, installDir });
    cli = install.installed ? await cliReport({ bskBin: install.bskBin, env, cliVersion }) : cli;
  }
  const ipc = client ?? new BskIpcClient({ env, bskBin: cli.bskBin ?? undefined, autoStart: true });
  let daemon = await daemonReport(ipc, 0);
  const browsers = browserRows({ platform, home, env });
  const registrations = [];
  let humanStep = null;
  if (daemon.browsers.length === 0) {
    for (const browser of browsers) {
      const registration = await registerExternalExtension({ platform, browser });
      registrations.push({ browser: browser.id, ...registration });
      if (!humanStep) humanStep = registration.humanStep;
      onHumanStep({ browser: browser.id, step: registration.humanStep, registered: registration.registered, needsRestart: registration.needsRestart });
    }
    if (browsers.length === 0) humanStep = `No Chromium-family browser profile was found. Install Chrome or Edge, then add the extension from ${STORE_PAGE_URLS.chrome}.`;
  }
  const deadline = Date.now() + waitTotalMs;
  let browsersConnected = daemon.browsers;
  while (browsersConnected.length === 0 && daemon.running && Date.now() < deadline) {
    browsersConnected = await listBrowsers(ipc, { waitForBrowserMs });
    if (waitForBrowserMs === 0) break;
  }
  daemon = { ...daemon, browsers: browsersConnected };
  const ready = browsersConnected.length > 0;
  return { cli, install, daemon, browsers, registrations, humanStep: ready ? null : humanStep, browsersConnected, ready };
}
