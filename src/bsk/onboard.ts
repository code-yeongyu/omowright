import { homedir } from "node:os";
import { findBskBinary } from "./daemon-info.js";
import { BskIpcClient } from "./ipc-client.js";
import { listBrowsers } from "./connect.js";
import {
  catalogBrowsers,
  externalExtensionEntry,
  registerExternalExtension,
  STORE_PAGE_URLS,
} from "./external-extension.js";
import { probeBrowserSignals } from "./browser-signals.js";
import { identifyBrowser } from "./identify-browser.js";
import { existsSync, readFileSync } from "node:fs";
import { cliVersionDefault, installBskCli } from "./install-cli.js";
import type { BskClient } from "./ipc-client.js";
import type { CatalogBrowser } from "./browsers.js";
import type { ExtensionEntry, ExtensionRegistration } from "./external-extension.js";
import type { BrowserSignals, ProbeBrowserSignalsOptions } from "./browser-signals.js";
import type { Identification, IdentifySignals } from "./identify-browser.js";

type CliVersion = (bskBin: string) => Promise<string | null>;
type ProbeSignals = (options: ProbeBrowserSignalsOptions) => Promise<BrowserSignals>;
type Exists = (file: string) => boolean;

export interface CliReport {
  installed: boolean;
  bskBin: string | null;
  version: string | null;
}

export interface DaemonReport {
  running: boolean;
  version?: unknown;
  protocolVersion?: unknown;
  error?: string;
  code?: unknown;
  browsers: unknown[];
  sessions: unknown[];
}

export type RegisteredBrowser = CatalogBrowser & { registration: ExtensionEntry; extensionRegistered: boolean };

export type BrowserIdentification = Omit<Identification<RegisteredBrowser>, "primary"> & {
  registeredElsewhere: string[];
};

export interface InstallOutcome {
  installed: boolean;
  bskBin: string | null;
  [field: string]: unknown;
}

export type InstallCli = (options: { platform: string; home: string; installDir?: string }) => Promise<InstallOutcome>;

export interface HumanStepEvent {
  browser: string;
  step: string;
  registered: boolean;
  needsRestart: boolean;
}

interface IdentifyInput {
  platform: string;
  home: string;
  env: NodeJS.ProcessEnv;
  exists: Exists;
  browser: string | undefined;
  signals: IdentifySignals | undefined;
  probeSignals: ProbeSignals;
  now: number;
}

interface StatusReply {
  daemon_version?: unknown;
  protocol_version?: unknown;
  browsers?: unknown[];
  sessions?: unknown[];
}

export interface BskDoctorOptions {
  platform?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  client?: BskClient;
  bskBin?: string | null;
  cliVersion?: CliVersion;
  waitForBrowserMs?: number;
  exists?: Exists;
  browser?: string;
  signals?: IdentifySignals;
  probeSignals?: ProbeSignals;
  now?: number;
}

export interface BskDoctorReport {
  cli: CliReport;
  daemon: DaemonReport;
  browsers: RegisteredBrowser[];
  primary: RegisteredBrowser | null;
  identification: BrowserIdentification;
  browsersConnected: unknown[];
  ready: boolean;
  nextStep?: string | null;
}

export interface BskOnboardOptions extends BskDoctorOptions {
  installDir?: string;
  installCli?: InstallCli;
  onHumanStep?: (event: HumanStepEvent) => void;
  waitTotalMs?: number;
}

export interface BskOnboardReport {
  cli: CliReport;
  install: InstallOutcome | null;
  daemon: DaemonReport;
  browsers: RegisteredBrowser[];
  primary: RegisteredBrowser | null;
  identification: BrowserIdentification;
  needsChoice: boolean;
  registrations: Array<{ browser: string } & ExtensionRegistration>;
  humanStep: string | null;
  browsersConnected: unknown[];
  ready: boolean;
}

// identifyBrowser returns a primary whenever it does not ask for a choice; reading one that is
// missing failed with a TypeError before the types made the invariant explicit.
function requirePrimary(primary: RegisteredBrowser | null | undefined): RegisteredBrowser {
  if (!primary) throw new TypeError("identifyBrowser chose no primary browser without asking for a choice");
  return primary;
}

const DEFAULT_WAIT_TOTAL_MS = 180_000;

// Asks the daemon again, one status call after another, until a browser connects or the deadline
// passes; a zero per-call wait means a single look.
async function waitForConnectedBrowsers(
  ipc: BskClient,
  waitForBrowserMs: number,
  deadline: number,
  connected: unknown[],
): Promise<unknown[]> {
  if (connected.length > 0 || Date.now() >= deadline) return connected;
  const next = await listBrowsers(ipc, { waitForBrowserMs });
  if (waitForBrowserMs === 0) return next;
  return waitForConnectedBrowsers(ipc, waitForBrowserMs, deadline, next);
}

function resolveBskBin(bskBin: string | null | undefined, env: NodeJS.ProcessEnv): string | null {
  if (bskBin === null) return null;
  return bskBin ?? findBskBinary(env);
}

async function cliReport({
  bskBin,
  env,
  cliVersion,
}: {
  bskBin: string | null | undefined;
  env: NodeJS.ProcessEnv;
  cliVersion: CliVersion;
}): Promise<CliReport> {
  const bin = resolveBskBin(bskBin, env);
  if (!bin) return { installed: false, bskBin: null, version: null };
  const raw = await cliVersion(bin);
  return raw
    ? { installed: true, bskBin: bin, version: raw.replace(/^bsk\s+/, "") }
    : { installed: false, bskBin: bin, version: null };
}

async function daemonReport(client: BskClient, waitForBrowserMs: number): Promise<DaemonReport> {
  try {
    const status = (await client.call(
      "system.status",
      waitForBrowserMs > 0 ? { wait_for_browser_ms: waitForBrowserMs } : {},
      { idPrefix: "status" },
    )) as StatusReply;
    return {
      running: true,
      version: status.daemon_version,
      protocolVersion: status.protocol_version,
      browsers: status.browsers ?? [],
      sessions: status.sessions ?? [],
    };
  } catch (error) {
    const failure = error as { message?: string; code?: unknown };
    return { running: false, error: failure.message, code: failure.code, browsers: [], sessions: [] };
  }
}

const NO_BROWSER_STEP = `No Chromium-family browser was found. Install one (Chrome, Edge, Brave, Arc, ...), then add the extension from ${STORE_PAGE_URLS.chrome}.`;

function withRegistration(platform: string, browser: CatalogBrowser): RegisteredBrowser {
  const entry = externalExtensionEntry({ platform, browser });
  const extensionRegistered =
    entry.kind === "file" && existsSync(entry.path) && readFileSync(entry.path, "utf8") === entry.content;
  return { ...browser, registration: entry, extensionRegistered };
}

async function identify({ platform, home, env, exists, browser, signals, probeSignals, now }: IdentifyInput): Promise<{
  browsers: RegisteredBrowser[];
  identification: BrowserIdentification;
  primary: RegisteredBrowser | null;
}> {
  const catalog = catalogBrowsers({ platform, home, env, exists }).map((b) => withRegistration(platform, b));
  const observed = signals ?? (await probeSignals({ platform, home, browsers: catalog.filter((b) => b.hasProfile) }));
  const explicit = browser ?? env.OMOWRIGHT_BROWSER ?? null;
  const { primary, ...identification } = identifyBrowser({
    catalog,
    signals: observed,
    explicit: explicit || null,
    now,
  });
  const browsers = catalog.filter((b) => b.installed);
  const registeredElsewhere = browsers
    .filter((b) => b.extensionRegistered && b.id !== identification.primaryId)
    .map((b) => b.id);
  return { browsers, identification: { ...identification, registeredElsewhere }, primary };
}

function choiceStep(identification: Pick<BrowserIdentification, "candidates" | "suggested" | "reason">): string {
  const listed = identification.candidates
    .map((c) => `${c.label} [${c.id}]${c.signals.length ? ` — ${c.signals.join(", ")}` : ""}`)
    .join("; ");
  const hint = identification.suggested ? ` Likely ${identification.suggested}, but confirm first.` : "";
  return `Ask the user which browser they actually use (${identification.reason}). Candidates: ${listed}.${hint} Then re-run with browser: "<id>"; register nothing until they answer.`;
}

function nextStepFor({
  cli,
  daemon,
  browsers,
  browsersConnected,
  identification,
  primary: chosen,
}: BskDoctorReport): string | null {
  if (browsersConnected.length > 0) return null;
  if (!cli.installed) return "Install the bsk CLI (bskOnboard() runs the official installer).";
  if (!daemon.running)
    return "Start the BrowserSkill daemon: run `bsk status` once, or `bsk daemon start` in the environment that owns it.";
  if (browsers.length === 0 && !chosen) return NO_BROWSER_STEP;
  if (identification.needsChoice) return choiceStep(identification);
  const primary = requirePrimary(chosen);
  if (!primary.extensionRegistered && primary.registration.kind !== "store")
    return `Register the BrowserSkill extension for ${primary.label} (bskOnboard() does this), then let the user enable it.`;
  return primary.registration.humanStep;
}

export async function bskDoctor({
  platform = process.platform,
  home = homedir(),
  env = process.env,
  client,
  bskBin,
  cliVersion = cliVersionDefault,
  waitForBrowserMs = 0,
  exists = existsSync,
  browser,
  signals,
  probeSignals = probeBrowserSignals,
  now = Date.now(),
}: BskDoctorOptions = {}): Promise<BskDoctorReport> {
  const cli = await cliReport({ bskBin, env, cliVersion });
  const ipc = client ?? new BskIpcClient({ env, bskBin: cli.bskBin ?? undefined, autoStart: false });
  const daemon = await daemonReport(ipc, waitForBrowserMs);
  const { browsers, identification, primary } = await identify({
    platform,
    home,
    env,
    exists,
    browser,
    signals,
    probeSignals,
    now,
  });
  const browsersConnected = daemon.browsers;
  const report: BskDoctorReport = {
    cli,
    daemon,
    browsers,
    primary: primary ?? null,
    identification,
    browsersConnected,
    ready: browsersConnected.length > 0,
  };
  report.nextStep = nextStepFor(report);
  return report;
}

export async function bskOnboard({
  platform = process.platform,
  home = homedir(),
  env = process.env,
  client,
  bskBin,
  installDir,
  installCli = installBskCli,
  cliVersion = cliVersionDefault,
  onHumanStep = () => {},
  waitForBrowserMs = 15_000,
  waitTotalMs = DEFAULT_WAIT_TOTAL_MS,
  exists = existsSync,
  browser,
  signals,
  probeSignals = probeBrowserSignals,
  now = Date.now(),
}: BskOnboardOptions = {}): Promise<BskOnboardReport> {
  let cli = await cliReport({ bskBin, env, cliVersion });
  let install: InstallOutcome | null = null;
  if (!cli.installed) {
    install = await installCli({ platform, home, installDir });
    cli = install.installed ? await cliReport({ bskBin: install.bskBin, env, cliVersion }) : cli;
  }
  const ipc = client ?? new BskIpcClient({ env, bskBin: cli.bskBin ?? undefined, autoStart: true });
  let daemon = await daemonReport(ipc, 0);
  const { browsers, identification, primary } = await identify({
    platform,
    home,
    env,
    exists,
    browser,
    signals,
    probeSignals,
    now,
  });
  const registrations: BskOnboardReport["registrations"] = [];
  let humanStep: string | null = null;
  let needsChoice = false;
  if (daemon.browsers.length === 0) {
    if (browsers.length === 0 && !primary) {
      humanStep = NO_BROWSER_STEP;
    } else if (identification.needsChoice) {
      needsChoice = true;
      humanStep = choiceStep(identification);
    } else {
      const chosen = requirePrimary(primary);
      const registration = await registerExternalExtension({ platform, browser: chosen });
      registrations.push({ browser: chosen.id, ...registration });
      humanStep = registration.humanStep;
      onHumanStep({
        browser: chosen.id,
        step: registration.humanStep,
        registered: registration.registered,
        needsRestart: registration.needsRestart,
      });
    }
  }
  const deadline = Date.now() + waitTotalMs;
  let browsersConnected = daemon.browsers;
  if (!needsChoice && daemon.running)
    browsersConnected = await waitForConnectedBrowsers(ipc, waitForBrowserMs, deadline, browsersConnected);
  daemon = { ...daemon, browsers: browsersConnected };
  const ready = browsersConnected.length > 0;
  return {
    cli,
    install,
    daemon,
    browsers,
    primary: primary ?? null,
    identification,
    needsChoice,
    registrations,
    humanStep: ready ? null : humanStep,
    browsersConnected,
    ready,
  };
}
