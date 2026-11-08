import { compact, optionalTarget, resolveTarget } from "./targets.ts";
import type { Target } from "./targets.ts";
import { captureScreenshot } from "./screenshot.ts";
import type { Screenshot, ScreenshotOptions } from "./screenshot.ts";
import type { BskClient } from "./ipc-client.ts";

const SESSION_STOP_TIMEOUT_MS = 3_600_000;

export interface SharedTabOptions {
  context?: string | undefined;
  dependsOn?: readonly string[] | undefined;
}

export interface BskSessionInit {
  sessionId?: unknown;
  browserInstanceId?: unknown;
  agentWindowId?: unknown;
  interaction?: unknown;
}

export interface NavigationOptions extends SharedTabOptions {
  tabId?: number;
  waitUntil?: string;
  timeoutMs?: number;
}

export interface TabTimeoutOptions extends SharedTabOptions {
  tabId?: number | undefined;
  timeoutMs?: number | undefined;
}

export interface EvaluateOptions extends TabTimeoutOptions {
  awaitPromise?: boolean;
  returnByValue?: boolean;
}

// BrowserSkill 0.4 refuses a page action (cooperation_sync_required) unless it
// carries the single-use context_id of the latest tool.cooperate sync, and the
// daemon never fills it in for the caller. Any other key left over after a method's own options
// is a misspelling (for example `contextId`) that would otherwise send no context, so it throws.
function sharedTab({ context, dependsOn, ...unknown }: SharedTabOptions): {
  context_id: string | undefined;
  depends_on: readonly string[] | undefined;
} {
  const extra = Object.keys(unknown);
  if (extra.length > 0) {
    throw new TypeError(
      `unknown option ${extra.map((key) => JSON.stringify(key)).join(", ")}: a shared-tab action takes { context, dependsOn } besides its own options`,
    );
  }
  return { context_id: context, depends_on: dependsOn };
}

export class BskSession {
  #client: BskClient;
  #stopped = false;
  declare sessionId: string;
  declare browserInstanceId: unknown;
  declare agentWindowId: unknown;
  declare interaction: unknown;

  constructor(
    client: BskClient,
    { sessionId, browserInstanceId = null, agentWindowId = null, interaction = null }: BskSessionInit = {},
  ) {
    if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("BskSession requires a sessionId");
    this.#client = client;
    this.sessionId = sessionId;
    this.browserInstanceId = browserInstanceId;
    this.agentWindowId = agentWindowId;
    this.interaction = interaction;
  }

  get client(): BskClient {
    return this.#client;
  }
  get stopped(): boolean {
    return this.#stopped;
  }

  tool(name: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.#stopped) return Promise.reject(new Error(`BrowserSkill session ${this.sessionId} is stopped`));
    return this.#client.call(`tool.${name}`, compact({ session_id: this.sessionId, ...params }), {
      idPrefix: name.replace(/_/g, "-"),
    });
  }

  cooperate(
    action: string,
    { tabId, timeoutMs, maxTokens }: { tabId?: number; timeoutMs?: number; maxTokens?: number } = {},
  ): Promise<unknown> {
    return this.tool("cooperate", { action, tab_id: tabId, timeout_ms: timeoutMs, max_tokens: maxTokens });
  }

  navigate(url: string, { tabId, waitUntil, timeoutMs, ...shared }: NavigationOptions = {}): Promise<unknown> {
    return this.tool("navigate", {
      url,
      tab_id: tabId,
      wait_until: waitUntil,
      timeout_ms: timeoutMs,
      ...sharedTab(shared),
    });
  }
  back({ tabId, waitUntil, timeoutMs, ...shared }: NavigationOptions = {}): Promise<unknown> {
    return this.tool("navigate_back", {
      tab_id: tabId,
      wait_until: waitUntil,
      timeout_ms: timeoutMs,
      ...sharedTab(shared),
    });
  }
  forward({ tabId, waitUntil, timeoutMs, ...shared }: NavigationOptions = {}): Promise<unknown> {
    return this.tool("navigate_forward", {
      tab_id: tabId,
      wait_until: waitUntil,
      timeout_ms: timeoutMs,
      ...sharedTab(shared),
    });
  }
  reload({
    tabId,
    waitUntil,
    timeoutMs,
    hard,
    ...shared
  }: NavigationOptions & { hard?: boolean } = {}): Promise<unknown> {
    return this.tool("reload", {
      tab_id: tabId,
      wait_until: waitUntil,
      timeout_ms: timeoutMs,
      hard,
      ...sharedTab(shared),
    });
  }

  observe({
    cursor,
    tabId,
    maxDepth,
    maxTokens,
    debugSurfaces,
    probeHover,
    ...shared
  }: SharedTabOptions & {
    cursor?: string;
    tabId?: number;
    maxDepth?: number;
    maxTokens?: number;
    debugSurfaces?: boolean;
    probeHover?: boolean;
  } = {}): Promise<unknown> {
    return this.tool("observe", {
      cursor,
      tab_id: tabId,
      max_depth: maxDepth,
      max_tokens: maxTokens,
      debug_surfaces: debugSurfaces,
      probe_hover: probeHover,
      ...sharedTab(shared),
    });
  }
  snapshot({
    tabId,
    maxDepth,
    maxTokens,
  }: { tabId?: number; maxDepth?: number; maxTokens?: number } = {}): Promise<unknown> {
    return this.tool("snapshot", { tab_id: tabId, max_depth: maxDepth, max_tokens: maxTokens });
  }
  getHtml({ ref, tabId, maxBytes }: { ref?: string; tabId?: number; maxBytes?: number } = {}): Promise<unknown> {
    return this.tool("get_html", { ref, tab_id: tabId, max_bytes: maxBytes });
  }
  screenshot(options?: ScreenshotOptions): Promise<Screenshot> {
    return captureScreenshot(this, options);
  }

  click(
    target: Target,
    {
      button,
      clickCount,
      modifiers,
      tabId,
      timeoutMs,
      ...shared
    }: TabTimeoutOptions & { button?: string | undefined; clickCount?: number; modifiers?: string[] } = {},
  ): Promise<unknown> {
    return this.tool("click", {
      ...resolveTarget(target),
      button,
      click_count: clickCount,
      modifiers,
      tab_id: tabId,
      timeout_ms: timeoutMs,
      ...sharedTab(shared),
    });
  }
  hover(
    target: Target,
    {
      modifiers,
      settleMs,
      tabId,
      timeoutMs,
      ...shared
    }: TabTimeoutOptions & { modifiers?: string[]; settleMs?: number } = {},
  ): Promise<unknown> {
    return this.tool("hover", {
      ...resolveTarget(target),
      modifiers,
      settle_ms: settleMs,
      tab_id: tabId,
      timeout_ms: timeoutMs,
      ...sharedTab(shared),
    });
  }
  focus(target: Target, { tabId, timeoutMs, ...shared }: TabTimeoutOptions = {}): Promise<unknown> {
    return this.tool("focus", { ...resolveTarget(target), tab_id: tabId, timeout_ms: timeoutMs, ...sharedTab(shared) });
  }
  blur(target: Target, { tabId, timeoutMs, ...shared }: TabTimeoutOptions = {}): Promise<unknown> {
    return this.tool("blur", { ...resolveTarget(target), tab_id: tabId, timeout_ms: timeoutMs, ...sharedTab(shared) });
  }
  fill(
    target: Target,
    value: string,
    { clearBefore, tabId, timeoutMs, ...shared }: TabTimeoutOptions & { clearBefore?: boolean } = {},
  ): Promise<unknown> {
    return this.tool("fill", {
      ...resolveTarget(target),
      value,
      clear_before: clearBefore,
      tab_id: tabId,
      timeout_ms: timeoutMs,
      ...sharedTab(shared),
    });
  }
  press(
    key: string,
    {
      target,
      modifiers,
      holdMs,
      tabId,
      timeoutMs,
      ...shared
    }: TabTimeoutOptions & { target?: Target; modifiers?: string[]; holdMs?: number } = {},
  ): Promise<unknown> {
    return this.tool("press", {
      key,
      ...optionalTarget(target),
      modifiers,
      hold_ms: holdMs,
      tab_id: tabId,
      timeout_ms: timeoutMs,
      ...sharedTab(shared),
    });
  }
  select(
    target: Target,
    values: string | string[],
    { tabId, timeoutMs, ...shared }: TabTimeoutOptions = {},
  ): Promise<unknown> {
    return this.tool("select", {
      ...resolveTarget(target),
      values: Array.isArray(values) ? values : [values],
      tab_id: tabId,
      timeout_ms: timeoutMs,
      ...sharedTab(shared),
    });
  }
  scrollTo(target: Target, { tabId, timeoutMs, ...shared }: TabTimeoutOptions = {}): Promise<unknown> {
    return this.tool("scroll_to", {
      ...resolveTarget(target),
      tab_id: tabId,
      timeout_ms: timeoutMs,
      ...sharedTab(shared),
    });
  }
  wheel({
    deltaX = 0,
    deltaY = 0,
    target,
    modifiers,
    tabId,
    timeoutMs,
    ...shared
  }: TabTimeoutOptions & {
    deltaX?: number;
    deltaY?: number;
    target?: Target;
    modifiers?: string[];
  } = {}): Promise<unknown> {
    return this.tool("wheel", {
      ...optionalTarget(target),
      delta_x: deltaX,
      delta_y: deltaY,
      modifiers,
      tab_id: tabId,
      timeout_ms: timeoutMs,
      ...sharedTab(shared),
    });
  }

  evaluate(
    expression: string,
    { tabId, awaitPromise, returnByValue, timeoutMs, ...shared }: EvaluateOptions = {},
  ): Promise<unknown> {
    return this.tool("evaluate", {
      expression,
      tab_id: tabId,
      await_promise: awaitPromise,
      return_by_value: returnByValue,
      timeout_ms: timeoutMs,
      ...sharedTab(shared),
    });
  }

  tabList({ scope }: { scope?: string } = {}): Promise<unknown> {
    return this.tool("tab_list", { scope });
  }
  tabCreate({ url, active, index }: { url?: string; active?: boolean; index?: number } = {}): Promise<unknown> {
    return this.tool("tab_create", { url, active, index });
  }
  tabClose(tabId: number, shared: SharedTabOptions = {}): Promise<unknown> {
    return this.tool("tab_close", { tab_id: tabId, ...sharedTab(shared) });
  }
  tabSelect(tabId: number): Promise<unknown> {
    return this.tool("tab_select", { tab_id: tabId });
  }
  tabBorrow(tabId: number, { confirmationTimeoutMs }: { confirmationTimeoutMs?: number } = {}): Promise<unknown> {
    return this.tool("tab_borrow", { tab_id: tabId, confirmation_timeout_ms: confirmationTimeoutMs });
  }
  tabReturn(tabId: number): Promise<unknown> {
    return this.tool("tab_return", { tab_id: tabId });
  }

  waitForNavigation({
    tabId,
    waitUntil,
    timeoutMs,
  }: { tabId?: number; waitUntil?: string; timeoutMs?: number } = {}): Promise<unknown> {
    return this.tool("wait_for_navigation", { tab_id: tabId, wait_until: waitUntil, timeout_ms: timeoutMs });
  }
  requestHelp({
    prompt,
    title,
    targets,
    completionCriteria,
    tabId,
    timeoutMs,
  }: {
    prompt?: string;
    title?: string;
    targets?: Target[];
    completionCriteria?: unknown;
    tabId?: number;
    timeoutMs?: number;
  } = {}): Promise<unknown> {
    return this.tool("request_help", {
      prompt,
      title,
      tab_id: tabId,
      timeout_ms: timeoutMs,
      targets: targets?.map((t) => resolveTarget(t)),
      completion_criteria: completionCriteria,
    });
  }
  console({
    tabId,
    since,
    limit,
    maxTextChars,
    includeStack,
  }: {
    tabId?: number;
    since?: number;
    limit?: number;
    maxTextChars?: number;
    includeStack?: boolean;
  } = {}): Promise<unknown> {
    return this.tool("console", {
      tab_id: tabId,
      since,
      limit,
      max_text_chars: maxTextChars,
      include_stack: includeStack,
    });
  }
  network({
    tabId,
    since,
    limit,
    maxTextChars,
  }: { tabId?: number; since?: number; limit?: number; maxTextChars?: number } = {}): Promise<unknown> {
    return this.tool("network", { tab_id: tabId, since, limit, max_text_chars: maxTextChars });
  }
  resize(width: number, height: number, shared: SharedTabOptions = {}): Promise<unknown> {
    return this.tool("window_resize", { width, height, ...sharedTab(shared) });
  }
  emulate({
    tabId,
    off,
    overrides,
    ...shared
  }: SharedTabOptions & { tabId?: number; off?: boolean; overrides?: Record<string, unknown> } = {}): Promise<unknown> {
    return this.tool("emulate", { tab_id: tabId, off, overrides, ...sharedTab(shared) });
  }

  async stop(): Promise<unknown> {
    if (this.#stopped) return null;
    this.#stopped = true;
    return this.#client.call(
      "session.stop",
      { session_id: this.sessionId },
      { idPrefix: "session-stop", timeoutMs: SESSION_STOP_TIMEOUT_MS },
    );
  }
}
