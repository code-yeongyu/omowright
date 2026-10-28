import { BskIpcClient, BskRpcError } from "./ipc-client.js";
import { BskSession } from "./session.js";
import { compact } from "./targets.js";

const DEFAULT_WAIT_FOR_BROWSER_MS = 15_000;

export async function listBrowsers(client, { waitForBrowserMs } = {}) {
  const status = await client.call("system.status", compact({ wait_for_browser_ms: waitForBrowserMs }), { idPrefix: "status" });
  return status.browsers ?? [];
}

function describeBrowser(b) {
  const parts = [`${b.label || b.browser_name || "browser"} [${b.instance_id}]`, [b.browser_name, b.browser_version].filter(Boolean).join(" ")];
  if (typeof b.session_count === "number") parts.push(`${b.session_count} session${b.session_count === 1 ? "" : "s"}`);
  // An out-of-range or non-numeric time would make toISOString() throw and hide the real error.
  if (Number.isFinite(b.connected_at_ms) && Math.abs(b.connected_at_ms) <= 8.64e15) parts.push(`online since ${new Date(b.connected_at_ms).toISOString()}`);
  return parts.filter(Boolean).join(", ");
}

// The daemon's message names a CLI flag and no instance; a library caller needs the option and the candidates.
function multipleBrowsersError(error, statusBrowsers) {
  const browsers = Array.isArray(error.data?.browsers) ? error.data.browsers : statusBrowsers;
  return new BskRpcError(error.code, `more than one browser is online; pass browser: "<instance_id or label>" to connectBrowserSkill(). Online: ${browsers.map(describeBrowser).join("; ")}. Tabs are only visible inside a session: ask the user which browser holds the page, or open a session per browser and read tabList({ scope: "user" }) before stopping it.`, { ...error.data, browsers });
}

export async function connectBrowserSkill({
  client, home, env, sockPath, autoStart, timeoutMs, bskBin,
  name, browser, width, height, focused = false,
  waitForBrowserMs = DEFAULT_WAIT_FOR_BROWSER_MS,
} = {}) {
  const ipc = client ?? new BskIpcClient({ home, env, sockPath, autoStart, timeoutMs, bskBin });
  const browsers = await listBrowsers(ipc, { waitForBrowserMs });
  if (browsers.length === 0) {
    throw new BskRpcError("no_browser_connected", "the BrowserSkill daemon is up but no browser extension is connected; open the browser that has the BrowserSkill extension enabled (bskDoctor() explains the remaining step) instead of falling back to a headless browser");
  }
  let started;
  try {
    started = await ipc.call("session.start", compact({
      task_name: name,
      browser_instance_id: browser,
      width, height, focused,
    }), { idPrefix: "session-start" });
  } catch (error) {
    if (error?.code === "multiple_browsers_online") throw multipleBrowsersError(error, browsers);
    throw error;
  }
  return new BskSession(ipc, {
    sessionId: started.session_id,
    browserInstanceId: started.browser_instance_id ?? null,
    agentWindowId: started.agent_window_id ?? null,
    interaction: started.interaction ?? null,
  });
}
