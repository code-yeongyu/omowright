import { compact, optionalElementTarget, resolveElementTarget, resolveTarget } from "./targets.ts";
import type { ElementTargetInput, Target } from "./targets.ts";
import { captureScreenshot } from "./screenshot.ts";
import type { Screenshot, ScreenshotOptions } from "./screenshot.ts";
import { BskRpcError } from "./ipc-client.ts";
import type { BskClient } from "./ipc-client.ts";
import { redactValue } from "../redact-value.ts";
import { optionalProperty } from "./reply-fields.ts";
import { sharedTab } from "./shared-tab.ts";
import type { MetadataKey, SharedTabMethod, SharedTabOptions, ToolMethod, WireParams } from "./shared-tab.ts";
import { isBootstrapRefusal, settleInitialTab } from "./first-navigate.ts";
import { extractItems, readNodes, waitForElement } from "./dom-reads.ts";
import type { ExtractOptions, ReadOptions, WaitForElementOptions } from "./dom-reads.ts";
import type {
  ControlPolicy,
  CooperateAction,
  DragMode,
  DragPoint,
  DragTarget,
  EmulateOverrides,
  ExtractAction,
  HelpCompletionCriteria,
  KeyModifier,
  MouseButton,
  TabScope,
  WaitUntil,
} from "./protocol/params.generated.ts";

export type { SharedTabOptions } from "./shared-tab.ts";

const SESSION_STOP_TIMEOUT_MS = 3_600_000;

// A target-policy sync answers the observation id actions accept at the top level and a legacy ref-map token under
// observation.observation_id; a strict sync sends only the nested one (measured on BrowserSkill 0.5.0).
// tool.cooperate's result schema is open (AnyValue), so only the fields an action needs are parsed; the rest of the
// daemon's reply is kept as it came.
export interface CooperateReply {
  readonly context_id: string | undefined;
  readonly observation_id: string | undefined;
  readonly [field: string]: unknown;
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function cooperateReply(reply: unknown): CooperateReply {
  const fields = typeof reply === "object" && reply !== null ? reply : {};
  const nested = optionalProperty(optionalProperty(reply, "observation"), "observation_id");
  return {
    ...fields,
    context_id: text(optionalProperty(reply, "context_id")),
    observation_id: text(optionalProperty(reply, "observation_id")) ?? text(nested),
  };
}

export interface BskSessionInit {
  sessionId?: unknown;
  browserInstanceId?: unknown;
  agentWindowId?: unknown;
  interaction?: unknown;
}

export interface NavigationOptions extends SharedTabOptions {
  tabId?: number;
  waitUntil?: WaitUntil;
  timeoutMs?: number;
}

export interface TabTimeoutOptions extends SharedTabOptions {
  tabId?: number | undefined;
  timeoutMs?: number | undefined;
}

export interface EvaluateOptions extends TabTimeoutOptions {
  awaitPromise?: boolean;
  returnByValue?: boolean;
  unverified?: boolean;
}

export class BskSession {
  #client: BskClient;
  #stopped = false;
  // Set once a guarded page action has been sent: only a session's first one can meet the bootstrap refusal.
  #acted = false;
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

  #call<M extends ToolMethod>(name: M, params: WireParams<M>): Promise<unknown> {
    return this.tool(name, params);
  }
  #act<M extends SharedTabMethod>(
    name: M,
    params: Omit<WireParams<M>, MetadataKey>,
    shared: SharedTabOptions,
  ): Promise<unknown> {
    const wire = { ...params, ...sharedTab(shared) };
    this.#acted = true;
    return this.tool(name, wire);
  }

  tool(name: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.#stopped) return Promise.reject(new Error(`BrowserSkill session ${this.sessionId} is stopped`));
    return this.#client.call(`tool.${name}`, compact({ session_id: this.sessionId, ...params }), {
      idPrefix: name.replace(/_/g, "-"),
    });
  }

  cooperate(
    action: CooperateAction,
    {
      tabId,
      timeoutMs,
      maxTokens,
      controlPolicy,
    }: { tabId?: number; timeoutMs?: number; maxTokens?: number; controlPolicy?: ControlPolicy } = {},
  ): Promise<CooperateReply> {
    // An extension before 0.4.0 has no shared control: it answers unknown_method here and runs actions without a
    // context. Degrade to "no context, ready" so a sync-then-act caller works unchanged; an absent context is
    // dropped from the wire by compact(). Every other error still rejects.
    return this.#call("cooperate", {
      action,
      tab_id: tabId,
      timeout_ms: timeoutMs,
      max_tokens: maxTokens,
      control_policy: controlPolicy,
    }).then(cooperateReply, (error: unknown) => {
      if (error instanceof BskRpcError && error.code === "unknown_method")
        return { context_id: undefined, observation_id: undefined, supported: false, ready: true };
      throw error;
    });
  }

  // A session's first navigate can meet BrowserSkill's initial-tab bootstrap refusal (see first-navigate.ts). Only
  // that refusal, with nothing sent to the page, on the session's first page action and without a caller context,
  // is sent once more after the tab settles.
  async navigate(url: string, { tabId, waitUntil, timeoutMs, ...shared }: NavigationOptions = {}): Promise<unknown> {
    const send = () =>
      this.#act("navigate", { url, tab_id: tabId, wait_until: waitUntil, timeout_ms: timeoutMs }, shared);
    const first = !this.#acted && shared.context === undefined;
    try {
      return await send();
    } catch (error) {
      if (!first || !isBootstrapRefusal(error)) throw error;
      await settleInitialTab(this, error, tabId);
      return send();
    }
  }
  back({ tabId, waitUntil, timeoutMs, ...shared }: NavigationOptions = {}): Promise<unknown> {
    return this.#act("navigate_back", { tab_id: tabId, wait_until: waitUntil, timeout_ms: timeoutMs }, shared);
  }
  forward({ tabId, waitUntil, timeoutMs, ...shared }: NavigationOptions = {}): Promise<unknown> {
    return this.#act("navigate_forward", { tab_id: tabId, wait_until: waitUntil, timeout_ms: timeoutMs }, shared);
  }
  reload({
    tabId,
    waitUntil,
    timeoutMs,
    hard,
    ...shared
  }: NavigationOptions & { hard?: boolean } = {}): Promise<unknown> {
    return this.#act("reload", { tab_id: tabId, wait_until: waitUntil, timeout_ms: timeoutMs, hard }, shared);
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
    return this.#act(
      "observe",
      {
        cursor,
        tab_id: tabId,
        max_depth: maxDepth,
        max_tokens: maxTokens,
        debug_surfaces: debugSurfaces,
        probe_hover: probeHover,
      },
      shared,
    );
  }
  snapshot({
    tabId,
    maxDepth,
    maxTokens,
  }: { tabId?: number; maxDepth?: number; maxTokens?: number } = {}): Promise<unknown> {
    return this.#call("snapshot", { tab_id: tabId, max_depth: maxDepth, max_tokens: maxTokens });
  }
  getHtml({ ref, tabId, maxBytes }: { ref?: string; tabId?: number; maxBytes?: number } = {}): Promise<unknown> {
    return this.#call("get_html", { ref, tab_id: tabId, max_bytes: maxBytes });
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
    }: TabTimeoutOptions & {
      button?: MouseButton | undefined;
      clickCount?: number;
      modifiers?: readonly KeyModifier[];
    } = {},
  ): Promise<unknown> {
    return this.#act(
      "click",
      { ...resolveTarget(target), button, click_count: clickCount, modifiers, tab_id: tabId, timeout_ms: timeoutMs },
      shared,
    );
  }
  hover(
    target: ElementTargetInput,
    {
      modifiers,
      settleMs,
      tabId,
      timeoutMs,
      ...shared
    }: TabTimeoutOptions & { modifiers?: readonly KeyModifier[]; settleMs?: number } = {},
  ): Promise<unknown> {
    return this.#act(
      "hover",
      { ...resolveElementTarget(target), modifiers, settle_ms: settleMs, tab_id: tabId, timeout_ms: timeoutMs },
      shared,
    );
  }
  focus(target: ElementTargetInput, { tabId, timeoutMs, ...shared }: TabTimeoutOptions = {}): Promise<unknown> {
    return this.#act("focus", { ...resolveElementTarget(target), tab_id: tabId, timeout_ms: timeoutMs }, shared);
  }
  blur(target: ElementTargetInput, { tabId, timeoutMs, ...shared }: TabTimeoutOptions = {}): Promise<unknown> {
    return this.#act("blur", { ...resolveElementTarget(target), tab_id: tabId, timeout_ms: timeoutMs }, shared);
  }
  fill(
    target: ElementTargetInput,
    value: string,
    { clearBefore, tabId, timeoutMs, ...shared }: TabTimeoutOptions & { clearBefore?: boolean } = {},
  ): Promise<unknown> {
    return this.#act(
      "fill",
      { ...resolveElementTarget(target), value, clear_before: clearBefore, tab_id: tabId, timeout_ms: timeoutMs },
      shared,
    ).catch((error: unknown) => {
      throw redactValue(error, value);
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
    }: TabTimeoutOptions & { target?: ElementTargetInput; modifiers?: readonly KeyModifier[]; holdMs?: number } = {},
  ): Promise<unknown> {
    return this.#act(
      "press",
      { key, ...optionalElementTarget(target), modifiers, hold_ms: holdMs, tab_id: tabId, timeout_ms: timeoutMs },
      shared,
    );
  }
  select(
    target: ElementTargetInput,
    values: string | string[],
    { tabId, timeoutMs, ...shared }: TabTimeoutOptions = {},
  ): Promise<unknown> {
    return this.#act(
      "select",
      {
        ...resolveElementTarget(target),
        values: Array.isArray(values) ? values : [values],
        tab_id: tabId,
        timeout_ms: timeoutMs,
      },
      shared,
    );
  }
  scrollTo(target: ElementTargetInput, { tabId, timeoutMs, ...shared }: TabTimeoutOptions = {}): Promise<unknown> {
    return this.#act("scroll_to", { ...resolveElementTarget(target), tab_id: tabId, timeout_ms: timeoutMs }, shared);
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
    target?: ElementTargetInput;
    modifiers?: readonly KeyModifier[];
  } = {}): Promise<unknown> {
    return this.#act(
      "wheel",
      {
        ...optionalElementTarget(target),
        delta_x: deltaX,
        delta_y: deltaY,
        modifiers,
        tab_id: tabId,
        timeout_ms: timeoutMs,
      },
      shared,
    );
  }

  evaluate(
    expression: string,
    { tabId, awaitPromise, returnByValue, timeoutMs, unverified, ...shared }: EvaluateOptions = {},
  ): Promise<unknown> {
    return this.#act(
      "evaluate",
      {
        expression,
        tab_id: tabId,
        await_promise: awaitPromise,
        return_by_value: returnByValue,
        timeout_ms: timeoutMs,
        unverified,
      },
      shared,
    );
  }

  // Reads need no cooperate sync; a given context is checked without renewing control.
  read(target?: ElementTargetInput, options?: ReadOptions): Promise<unknown> {
    return readNodes(this, target, options);
  }
  extract(action: ExtractAction, options?: ExtractOptions): Promise<unknown> {
    return extractItems(this, action, options);
  }
  waitForElement(target: ElementTargetInput, options: WaitForElementOptions): Promise<unknown> {
    return waitForElement(this, target, options);
  }
  drag(
    source: DragTarget,
    {
      target,
      delta,
      mode,
      button,
      durationMs,
      holdMs,
      modifiers,
      tabId,
      timeoutMs,
      ...shared
    }: TabTimeoutOptions & {
      target?: DragTarget;
      delta?: DragPoint;
      mode?: DragMode;
      button?: MouseButton;
      durationMs?: number;
      holdMs?: number;
      modifiers?: readonly KeyModifier[];
    } = {},
  ): Promise<unknown> {
    return this.#act(
      "drag",
      {
        source,
        target,
        delta,
        mode,
        button,
        duration_ms: durationMs,
        hold_ms: holdMs,
        modifiers,
        tab_id: tabId,
        timeout_ms: timeoutMs,
      },
      shared,
    );
  }

  tabList({ scope }: { scope?: TabScope } = {}): Promise<unknown> {
    return this.#call("tab_list", { scope });
  }
  tabCreate({ url, active, index }: { url?: string; active?: boolean; index?: number } = {}): Promise<unknown> {
    return this.#call("tab_create", { url, active, index });
  }
  tabClose(tabId: number, shared: SharedTabOptions = {}): Promise<unknown> {
    return this.#act("tab_close", { tab_id: tabId }, shared);
  }
  tabSelect(tabId: number): Promise<unknown> {
    return this.#call("tab_select", { tab_id: tabId });
  }
  tabBorrow(tabId: number, { confirmationTimeoutMs }: { confirmationTimeoutMs?: number } = {}): Promise<unknown> {
    return this.#call("tab_borrow", { tab_id: tabId, confirmation_timeout_ms: confirmationTimeoutMs });
  }
  tabReturn(tabId: number): Promise<unknown> {
    return this.#call("tab_return", { tab_id: tabId });
  }

  waitForNavigation({
    tabId,
    waitUntil,
    timeoutMs,
  }: { tabId?: number; waitUntil?: WaitUntil; timeoutMs?: number } = {}): Promise<unknown> {
    return this.#call("wait_for_navigation", { tab_id: tabId, wait_until: waitUntil, timeout_ms: timeoutMs });
  }
  requestHelp({
    prompt,
    title,
    targets,
    completionCriteria,
    tabId,
    timeoutMs,
  }: {
    prompt: string;
    title?: string;
    targets?: ElementTargetInput[];
    completionCriteria?: HelpCompletionCriteria;
    tabId?: number;
    timeoutMs?: number;
  }): Promise<unknown> {
    return this.#call("request_help", {
      prompt,
      title,
      tab_id: tabId,
      timeout_ms: timeoutMs,
      targets: targets?.map((t) => resolveElementTarget(t)),
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
    return this.#call("console", {
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
    return this.#call("network", { tab_id: tabId, since, limit, max_text_chars: maxTextChars });
  }
  resize(width: number, height: number, shared: SharedTabOptions = {}): Promise<unknown> {
    return this.#act("window_resize", { width, height }, shared);
  }
  emulate({
    tabId,
    off,
    overrides,
    ...shared
  }: SharedTabOptions & { tabId?: number; off?: boolean; overrides?: EmulateOverrides } = {}): Promise<unknown> {
    return this.#act("emulate", { tab_id: tabId, off, overrides }, shared);
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
