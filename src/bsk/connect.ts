import { BskIpcClient, BskRpcError } from "./ipc-client.js";
import { BskSession } from "./session.js";
import { compact } from "./targets.js";

const DEFAULT_WAIT_FOR_BROWSER_MS = 15_000;

export async function listBrowsers(client, { waitForBrowserMs } = {}) {
  const status = await client.call("system.status", compact({ wait_for_browser_ms: waitForBrowserMs }), { idPrefix: "status" });
  return status.browsers ?? [];
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
  const started = await ipc.call("session.start", compact({
    task_name: name,
    browser_instance_id: browser,
    width, height, focused,
  }), { idPrefix: "session-start" });
  return new BskSession(ipc, {
    sessionId: started.session_id,
    browserInstanceId: started.browser_instance_id ?? null,
    agentWindowId: started.agent_window_id ?? null,
    interaction: started.interaction ?? null,
  });
}
