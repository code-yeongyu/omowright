import { readProperty } from "../read-property.ts";
import { BskIpcClient, BskRpcError } from "./ipc-client.ts";
import type { BskClient } from "./ipc-client.ts";
import { listOrEmpty, optionalProperty } from "./reply-fields.ts";
import { BskSession } from "./session.ts";
import { compact } from "./targets.ts";

const DEFAULT_WAIT_FOR_BROWSER_MS = 15_000;

// BrowserSkill extension 0.4.0 put every task tab into a native "BrowserSkill" tab group. Chrome saves and syncs
// native groups, so each task leaves a group in the user's own browser (and in every browser signed into the same
// account) after it ends. Upstream removed the grouping in 0.4.1 and does not delete groups already saved.
const TAB_GROUPING_EXTENSION_VERSIONS: ReadonlySet<unknown> = new Set(["0.4.0"]);

export function isTabGroupingExtension(browser: unknown): boolean {
  return TAB_GROUPING_EXTENSION_VERSIONS.has(optionalProperty(browser, "extension_version"));
}

export const TAB_GROUPING_EXTENSION_STEP =
  'Update the BrowserSkill extension to 0.4.1 or later (chrome://extensions -> Developer mode -> Update, or wait for the store update). Version 0.4.0 puts each task\'s tabs into a "BrowserSkill" tab group that the browser saves and syncs, so the group stays after the task ends; delete any saved "BrowserSkill" tab groups by hand.';

function outdatedError(browser: unknown): BskRpcError {
  return new BskRpcError(
    "extension_outdated",
    `the BrowserSkill extension in ${readProperty(browser, "browser_name") ?? "the browser"} [${readProperty(browser, "instance_id")}] is 0.4.0, which leaves a "BrowserSkill" tab group behind in the user's browser after each task. ${TAB_GROUPING_EXTENSION_STEP}`,
  );
}

function namesBrowser(b: unknown, browser: unknown): boolean {
  return (
    readProperty(b, "instance_id") === browser ||
    Boolean(readProperty(b, "label") && readProperty(b, "label") === browser)
  );
}

// A named browser on 0.4.0 is refused; with no browser named, an up-to-date one is chosen over a 0.4.0 one.
function chooseBrowser(browser: string | null | undefined, browsers: unknown[]): unknown {
  const resolved = resolveBrowser(browser, browsers);
  if (resolved !== undefined && resolved !== null) {
    const entry = browsers.find((b) => namesBrowser(b, resolved));
    if (entry && isTabGroupingExtension(entry)) throw outdatedError(entry);
    return resolved;
  }
  const outdated = browsers.filter(isTabGroupingExtension);
  if (outdated.length === 0) return resolved;
  const usable = browsers.find((b) => !isTabGroupingExtension(b));
  if (!usable) throw outdatedError(outdated[0]);
  return readProperty(usable, "instance_id");
}

export async function listBrowsers(
  client: BskClient,
  { waitForBrowserMs }: { waitForBrowserMs?: number } = {},
): Promise<unknown[]> {
  const status = await client.call("system.status", compact({ wait_for_browser_ms: waitForBrowserMs }), {
    idPrefix: "status",
  });
  return listOrEmpty(readProperty(status, "browsers"), "system.status browsers");
}

// session.start matches only an instance id or a unique label; a browser name such as "chrome"
// (what bskDoctor reports) maps to the one connected browser with that name.
function resolveBrowser(browser: string | null | undefined, browsers: unknown[]): unknown {
  if (browser === undefined || browser === null) return browser;
  if (browsers.some((b) => namesBrowser(b, browser))) return browser;
  const named = browsers.filter((b) => readProperty(b, "browser_name") === browser);
  if (named.length > 1) {
    throw new BskRpcError(
      "invalid_params",
      `browser "${browser}" matches ${named.length} connected browsers (${named.map((b) => textField(b, "instance_id") ?? "unknown id").join(", ")}); pass the instance id instead`,
    );
  }
  return named.length === 1 ? readProperty(named[0], "instance_id") : browser;
}

// Only a string or a finite number from the daemon is printed: any other value (an object, possibly with a broken
// toString) is skipped, so a malformed entry can never replace the coded error with a TypeError.
function textField(b: unknown, key: string): string | undefined {
  const value = optionalProperty(b, key);
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function describeBrowser(b: unknown): string {
  const name = textField(b, "browser_name");
  const parts = [
    `${textField(b, "label") || name || "browser"} [${textField(b, "instance_id") ?? "unknown id"}]`,
    [name, textField(b, "browser_version")].filter(Boolean).join(" "),
  ];
  const sessions = optionalProperty(b, "session_count");
  if (typeof sessions === "number" && Number.isFinite(sessions))
    parts.push(`${sessions} session${sessions === 1 ? "" : "s"}`);
  // An out-of-range or non-numeric time would make toISOString() throw and hide the real error.
  const since = optionalProperty(b, "connected_at_ms");
  if (typeof since === "number" && Number.isFinite(since) && Math.abs(since) <= 8.64e15) {
    parts.push(`online since ${new Date(since).toISOString()}`);
  }
  return parts.filter(Boolean).join(", ");
}

// The daemon's message names a CLI flag and no instance; a library caller needs the option and the candidates.
function multipleBrowsersError(error: BskRpcError, statusBrowsers: unknown[]): BskRpcError {
  const listed = optionalProperty(error.data, "browsers");
  const browsers: unknown[] = Array.isArray(listed) ? listed : statusBrowsers;
  const data: unknown = error.data;
  const extra = typeof data === "object" && data !== null ? data : {};
  return new BskRpcError(
    error.code,
    `more than one browser is online; pass browser: "<instance_id or label>" to connectBrowserSkill(). Online: ${browsers.map(describeBrowser).join("; ")}. Tabs are only visible inside a session: ask the user which browser holds the page, or open a session per browser and read tabList({ scope: "user" }) before stopping it.`,
    { ...extra, browsers },
  );
}

export interface ConnectBrowserSkillOptions {
  client?: BskClient;
  home?: string;
  env?: NodeJS.ProcessEnv;
  sockPath?: string;
  autoStart?: boolean;
  timeoutMs?: number;
  bskBin?: string;
  name?: string;
  browser?: string | null | undefined;
  width?: number;
  height?: number;
  focused?: boolean;
  waitForBrowserMs?: number;
}

export async function connectBrowserSkill({
  client,
  home,
  env,
  sockPath,
  autoStart,
  timeoutMs,
  bskBin,
  name,
  browser,
  width,
  height,
  focused = false,
  waitForBrowserMs = DEFAULT_WAIT_FOR_BROWSER_MS,
}: ConnectBrowserSkillOptions = {}): Promise<BskSession> {
  const ipc = client ?? new BskIpcClient({ home, env, sockPath, autoStart, timeoutMs, bskBin });
  const browsers = await listBrowsers(ipc, { waitForBrowserMs });
  if (browsers.length === 0) {
    throw new BskRpcError(
      "no_browser_connected",
      "the BrowserSkill daemon is up but no browser extension is connected; open the browser that has the BrowserSkill extension enabled (bskDoctor() explains the remaining step); never substitute another browser for the user's without telling them",
    );
  }
  const browserInstanceId = chooseBrowser(browser, browsers);
  let started: unknown;
  try {
    started = await ipc.call(
      "session.start",
      compact({
        task_name: name,
        browser_instance_id: browserInstanceId,
        width,
        height,
        focused,
      }),
      { idPrefix: "session-start" },
    );
  } catch (error) {
    if (error instanceof BskRpcError && error.code === "multiple_browsers_online") {
      throw multipleBrowsersError(error, browsers);
    }
    throw error;
  }
  return new BskSession(ipc, {
    sessionId: readProperty(started, "session_id"),
    browserInstanceId: readProperty(started, "browser_instance_id") ?? null,
    agentWindowId: readProperty(started, "agent_window_id") ?? null,
    interaction: readProperty(started, "interaction") ?? null,
  });
}
