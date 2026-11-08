import { BskIpcClient, BskRpcError } from "./ipc-client.js";
import type { BskClient } from "./ipc-client.js";
import { BskSession } from "./session.js";
import { compact } from "./targets.js";

const DEFAULT_WAIT_FOR_BROWSER_MS = 15_000;

interface StatusReply {
  browsers?: unknown[];
}

interface SessionStartReply {
  session_id?: unknown;
  browser_instance_id?: string | null;
  agent_window_id?: number | null;
  interaction?: unknown;
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
  browser?: string;
  width?: number;
  height?: number;
  focused?: boolean;
  waitForBrowserMs?: number;
}

export async function listBrowsers(
  client: BskClient,
  { waitForBrowserMs }: { waitForBrowserMs?: number } = {},
): Promise<unknown[]> {
  const status = (await client.call("system.status", compact({ wait_for_browser_ms: waitForBrowserMs }), {
    idPrefix: "status",
  })) as StatusReply;
  return status.browsers ?? [];
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
      "the BrowserSkill daemon is up but no browser extension is connected; open the browser that has the BrowserSkill extension enabled (bskDoctor() explains the remaining step) instead of falling back to a headless browser",
    );
  }
  const started = (await ipc.call(
    "session.start",
    compact({
      task_name: name,
      browser_instance_id: browser,
      width,
      height,
      focused,
    }),
    { idPrefix: "session-start" },
  )) as SessionStartReply;
  return new BskSession(ipc, {
    sessionId: started.session_id,
    browserInstanceId: started.browser_instance_id ?? null,
    agentWindowId: started.agent_window_id ?? null,
    interaction: started.interaction ?? null,
  });
}
