import { homedir } from "node:os";
import { readProperty } from "../read-property.ts";
import { findBskBinary } from "./daemon-info.ts";
import { BskIpcClient } from "./ipc-client.ts";
import type { BskClient } from "./ipc-client.ts";
import { isTabGroupingExtension, listBrowsers, TAB_GROUPING_EXTENSION_STEP } from "./connect.ts";
import {
  catalogBrowsers,
  externalExtensionEntry,
  registerExternalExtension,
  STORE_PAGE_URLS,
} from "./external-extension.ts";
import type { ExtensionEntry, ExtensionRegistration } from "./external-extension.ts";
import { probeBrowserSignals } from "./browser-signals.ts";
import type { BrowserSignals, ProbeBrowserSignalsOptions } from "./browser-signals.ts";
import { identifyBrowser } from "./identify-browser.ts";
import type { Identification, IdentifySignals } from "./identify-browser.ts";
import type { CatalogBrowser, Exists } from "./browsers.ts";
import { existsSync, readFileSync } from "node:fs";
import { cliVersionDefault, installBskCli } from "./install-cli.ts";
import { listOrEmpty } from "./reply-fields.ts";

type CliVersion = (bskBin: string) => Promise<string | null>;
type ProbeSignals = (options: ProbeBrowserSignalsOptions) => Promise<BrowserSignals>;

export interface CliReport {
  installed: boolean;
  bskBin: string | null;
  version: string | null;
}

export interface DaemonReport {
  running: boolean;
  version?: unknown;
  protocolVersion?: unknown;
  error?: unknown;
  code?: unknown;
  startBlocked?: boolean;
  browsers: unknown[];
  sessions: unknown;
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

export type InstallCli = (options: {
  platform: string;
  home: string;
  installDir?: string | undefined;
}) => Promise<InstallOutcome>;

export interface HumanStepEvent {
  browser: unknown;
  step: string;
  registered: boolean;
  needsRestart: boolean;
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
  outdatedExtensions: unknown[];
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
  nextStep: string | null;
  browsersConnected: unknown[];
  outdatedExtensions: unknown[];
  ready: boolean;
}

type NextStepInput = Pick<BskDoctorReport, "cli" | "daemon" | "browsers" | "browsersConnected" | "identification"> & {
  primary: RegisteredBrowser | null | undefined;
};

// identifyBrowser returns a primary whenever it does not ask for a choice; reading one that is
// missing failed with a TypeError before the types made the invariant explicit.
function requirePrimary(primary: RegisteredBrowser | null | undefined): RegisteredBrowser {
  if (!primary) throw new TypeError("identifyBrowser chose no primary browser without asking for a choice");
  return primary;
}

const DEFAULT_WAIT_TOTAL_MS = 180_000;

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
    const status = await client.call(
      "system.status",
      waitForBrowserMs > 0 ? { wait_for_browser_ms: waitForBrowserMs } : {},
      { idPrefix: "status" },
    );
    return {
      running: true,
      version: readProperty(status, "daemon_version"),
      protocolVersion: readProperty(status, "protocol_version"),
      browsers: listOrEmpty(readProperty(status, "browsers"), "system.status browsers"),
      sessions: readProperty(status, "sessions") ?? [],
    };
  } catch (error) {
    const message = readProperty(error, "message");
    return {
      running: false,
      error: message,
      code: readProperty(error, "code"),
      startBlocked: NO_BREAKAWAY.test(String(message)),
      browsers: [],
      sessions: [],
    };
  }
}

// bsk's refusal when the host's Windows Job Object forbids breakaway: a detached start fails the same way every retry.
const NO_BREAKAWAY = /Job Object|breakaway/i;
const FOREGROUND_STEP =
  "run `bsk daemon start --foreground` in a persistent background session of the agent host (one that outlives the command, not a one-shot shell call), then check it with `bsk status` from a separate call";

function daemonStep(daemon: DaemonReport): string {
  if (daemon.startBlocked)
    return `Start the BrowserSkill daemon: this host does not let a command detach it (Windows Job Object breakaway is prohibited), so retrying \`bsk status\` or \`bsk daemon start\` fails the same way; ${FOREGROUND_STEP}.`;
  return `Start the BrowserSkill daemon: bskOnboard() (or \`bsk status\` once) starts it. If the host reaps background processes or the start fails, ${FOREGROUND_STEP}; do not retry a detached \`bsk daemon start\`.`;
}

const NO_BROWSER_STEP = `No Chromium-family browser was found. Install one (Chrome, Edge, Brave, Arc, ...), then add the extension from ${STORE_PAGE_URLS.chrome}.`;

function withRegistration(platform: string, browser: CatalogBrowser): RegisteredBrowser {
  const entry = externalExtensionEntry({ platform, browser });
  const extensionRegistered =
    entry.kind === "file" && existsSync(entry.path) && readFileSync(entry.path, "utf8") === entry.content;
  return { ...browser, registration: entry, extensionRegistered };
}

interface IdentifyInput {
  platform: string;
  home: string;
  env: NodeJS.ProcessEnv;
  exists: Exists;
  browser: string | undefined;
  connected: unknown[];
  signals: IdentifySignals | undefined;
  probeSignals: ProbeSignals;
  now: number;
}

async function identify({
  platform,
  home,
  env,
  exists,
  browser,
  connected,
  signals,
  probeSignals,
  now,
}: IdentifyInput): Promise<{
  browsers: RegisteredBrowser[];
  identification: BrowserIdentification;
  primary: RegisteredBrowser | null;
}> {
  const catalog = catalogBrowsers({ platform, home, env, exists }).map((b) => withRegistration(platform, b));
  const observed = signals ?? (await probeSignals({ platform, home, browsers: catalog.filter((b) => b.hasProfile) }));
  const explicit = browser ?? env["OMOWRIGHT_BROWSER"] ?? null;
  const { primary, ...identification } = identifyBrowser({
    catalog,
    signals: observed,
    explicit: explicit || null,
    connected,
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
}: NextStepInput): string | null {
  if (browsersConnected.length > 0)
    return browsersConnected.every(isTabGroupingExtension) ? TAB_GROUPING_EXTENSION_STEP : null;
  if (!cli.installed) return "Install the bsk CLI (bskOnboard() runs the official installer).";
  if (!daemon.running) return daemonStep(daemon);
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
    connected: daemon.browsers.map((b) => readProperty(b, "browser_name")),
    signals,
    probeSignals,
    now,
  });
  const browsersConnected = daemon.browsers;
  const outdatedExtensions = browsersConnected.filter(isTabGroupingExtension);
  const report: BskDoctorReport = {
    cli,
    daemon,
    browsers,
    primary: primary ?? null,
    identification,
    browsersConnected,
    outdatedExtensions,
    ready: browsersConnected.length > outdatedExtensions.length,
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
    connected: daemon.browsers.map((b) => readProperty(b, "browser_name")),
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
    } else if (daemon.running) {
      // A down daemon hides whether the extension is already enabled, so no step goes to the user until it is up.
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
  while (!needsChoice && browsersConnected.length === 0 && daemon.running && Date.now() < deadline) {
    browsersConnected = await listBrowsers(ipc, { waitForBrowserMs });
    if (waitForBrowserMs === 0) break;
  }
  daemon = { ...daemon, browsers: browsersConnected };
  // An installed 0.4.0 extension needs the user to update it, not another registration: see bskDoctor.
  const outdatedExtensions = browsersConnected.filter(isTabGroupingExtension);
  const ready = browsersConnected.length > outdatedExtensions.length;
  if (!ready && outdatedExtensions.length > 0) {
    humanStep = TAB_GROUPING_EXTENSION_STEP;
    onHumanStep({
      browser: readProperty(outdatedExtensions[0], "browser_name"),
      step: humanStep,
      registered: true,
      needsRestart: false,
    });
  }
  const nextStep = ready
    ? null
    : (humanStep ?? nextStepFor({ cli, daemon, browsers, browsersConnected, identification, primary }));
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
    nextStep,
    browsersConnected,
    outdatedExtensions,
    ready,
  };
}
