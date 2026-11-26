import { readProperty } from "../read-property.ts";
import { BskRpcError } from "./ipc-client.ts";
import { listOrEmpty, optionalProperty } from "./reply-fields.ts";

// BrowserSkill 0.5.0 lets a session's first navigate through without a cooperate context only while the
// agent-created tab is still an initial blank with no pending URL (ext-v0.5.0 cooperation/controller.ts,
// bootstrap()). A tab caught while its initial document commits fails that check and the navigate is refused
// before anything reaches the page; the page is not observable yet, so cooperate wait/sync cannot help either.
const BOOTSTRAP_REFUSAL = "The initial task tab changed; synchronize before acting";
// tool.wait_for_navigation reads the tab's pendingUrl: it waits for a pending document and answers after a short
// grace once the tab is settled. This bounds how long a refused first navigate waits for that.
export const BOOTSTRAP_SETTLE_TIMEOUT_MS = 10_000;
// The URLs tab_list reports for an initial blank task tab (empty while the first document has not committed).
const INITIAL_BLANK_URLS: ReadonlySet<unknown> = new Set(["", "about:blank"]);

export function isBootstrapRefusal(error: unknown): error is BskRpcError {
  return (
    error instanceof BskRpcError &&
    error.code === "permission_denied" &&
    error.message === BOOTSTRAP_REFUSAL &&
    optionalProperty(error.data, "reason") === "cooperation_sync_required" &&
    optionalProperty(error.data, "effect_state") === "none"
  );
}

export interface SettleSession {
  waitForNavigation(options: { tabId?: number; waitUntil: "load"; timeoutMs: number }): Promise<unknown>;
  tabList(options: { scope: "agent" }): Promise<unknown>;
}

function taskTab(tabs: unknown, tabId: number | undefined): unknown {
  const list = listOrEmpty(readProperty(tabs, "tabs"), "tab_list tabs");
  return tabId === undefined
    ? list.find((tab) => optionalProperty(tab, "active") === true)
    : list.find((tab) => optionalProperty(tab, "tab_id") === tabId);
}

// Resolves when the refused tab has settled as an initial blank, so the same navigate can be sent once more;
// otherwise rejects with the refusal, extended by the tab state that ruled a retry out.
export async function settleInitialTab(
  session: SettleSession,
  refusal: BskRpcError,
  tabId: number | undefined,
): Promise<void> {
  const waited = await session.waitForNavigation({
    ...(tabId === undefined ? {} : { tabId }),
    waitUntil: "load",
    timeoutMs: BOOTSTRAP_SETTLE_TIMEOUT_MS,
  });
  const reached = optionalProperty(waited, "reached");
  const tab = taskTab(await session.tabList({ scope: "agent" }), tabId);
  const url = optionalProperty(tab, "url");
  if (reached === "load" && INITIAL_BLANK_URLS.has(url)) return;
  const where =
    tab === undefined
      ? "no task tab is listed"
      : `tab ${String(optionalProperty(tab, "tab_id"))} is at ${url === "" ? "(no URL yet)" : String(url)}`;
  throw new BskRpcError(
    refusal.code,
    `${refusal.message}: the first navigate was refused before the task tab settled, and it was not sent again because wait_for_navigation reached ${JSON.stringify(reached)} and ${where}`,
    refusal.data,
  );
}
