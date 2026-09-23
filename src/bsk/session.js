import { compact, optionalTarget, resolveTarget } from "./targets.js";
import { captureScreenshot } from "./screenshot.js";

const SESSION_STOP_TIMEOUT_MS = 3_600_000;

export class BskSession {
  #client; #stopped = false;

  constructor(client, { sessionId, browserInstanceId = null, agentWindowId = null, interaction = null } = {}) {
    if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("BskSession requires a sessionId");
    this.#client = client;
    this.sessionId = sessionId;
    this.browserInstanceId = browserInstanceId;
    this.agentWindowId = agentWindowId;
    this.interaction = interaction;
  }

  get client() { return this.#client; }
  get stopped() { return this.#stopped; }

  tool(name, params = {}) {
    if (this.#stopped) return Promise.reject(new Error(`BrowserSkill session ${this.sessionId} is stopped`));
    return this.#client.call(`tool.${name}`, compact({ session_id: this.sessionId, ...params }), { idPrefix: name.replace(/_/g, "-") });
  }

  navigate(url, { tabId, waitUntil, timeoutMs } = {}) {
    return this.tool("navigate", { url, tab_id: tabId, wait_until: waitUntil, timeout_ms: timeoutMs });
  }
  back({ tabId, waitUntil, timeoutMs } = {}) {
    return this.tool("navigate_back", { tab_id: tabId, wait_until: waitUntil, timeout_ms: timeoutMs });
  }
  forward({ tabId, waitUntil, timeoutMs } = {}) {
    return this.tool("navigate_forward", { tab_id: tabId, wait_until: waitUntil, timeout_ms: timeoutMs });
  }
  reload({ tabId, waitUntil, timeoutMs, hard } = {}) {
    return this.tool("reload", { tab_id: tabId, wait_until: waitUntil, timeout_ms: timeoutMs, hard });
  }

  observe({ cursor, tabId, maxDepth, maxTokens, debugSurfaces, probeHover } = {}) {
    return this.tool("observe", { cursor, tab_id: tabId, max_depth: maxDepth, max_tokens: maxTokens, debug_surfaces: debugSurfaces, probe_hover: probeHover });
  }
  snapshot({ tabId, maxDepth, maxTokens } = {}) {
    return this.tool("snapshot", { tab_id: tabId, max_depth: maxDepth, max_tokens: maxTokens });
  }
  getHtml({ ref, tabId, maxBytes } = {}) {
    return this.tool("get_html", { ref, tab_id: tabId, max_bytes: maxBytes });
  }
  screenshot(options) { return captureScreenshot(this, options); }

  click(target, { button, clickCount, modifiers, tabId, timeoutMs } = {}) {
    return this.tool("click", { ...resolveTarget(target), button, click_count: clickCount, modifiers, tab_id: tabId, timeout_ms: timeoutMs });
  }
  hover(target, { modifiers, settleMs, tabId, timeoutMs } = {}) {
    return this.tool("hover", { ...resolveTarget(target), modifiers, settle_ms: settleMs, tab_id: tabId, timeout_ms: timeoutMs });
  }
  focus(target, { tabId, timeoutMs } = {}) {
    return this.tool("focus", { ...resolveTarget(target), tab_id: tabId, timeout_ms: timeoutMs });
  }
  blur(target, { tabId, timeoutMs } = {}) {
    return this.tool("blur", { ...resolveTarget(target), tab_id: tabId, timeout_ms: timeoutMs });
  }
  fill(target, value, { clearBefore, tabId, timeoutMs } = {}) {
    return this.tool("fill", { ...resolveTarget(target), value, clear_before: clearBefore, tab_id: tabId, timeout_ms: timeoutMs });
  }
  press(key, { target, modifiers, holdMs, tabId, timeoutMs } = {}) {
    return this.tool("press", { key, ...optionalTarget(target), modifiers, hold_ms: holdMs, tab_id: tabId, timeout_ms: timeoutMs });
  }
  select(target, values, { tabId, timeoutMs } = {}) {
    return this.tool("select", { ...resolveTarget(target), values: Array.isArray(values) ? values : [values], tab_id: tabId, timeout_ms: timeoutMs });
  }
  scrollTo(target, { tabId, timeoutMs } = {}) {
    return this.tool("scroll_to", { ...resolveTarget(target), tab_id: tabId, timeout_ms: timeoutMs });
  }
  wheel({ deltaX = 0, deltaY = 0, target, modifiers, tabId, timeoutMs } = {}) {
    return this.tool("wheel", { ...optionalTarget(target), delta_x: deltaX, delta_y: deltaY, modifiers, tab_id: tabId, timeout_ms: timeoutMs });
  }

  evaluate(expression, { tabId, awaitPromise, returnByValue, timeoutMs } = {}) {
    return this.tool("evaluate", { expression, tab_id: tabId, await_promise: awaitPromise, return_by_value: returnByValue, timeout_ms: timeoutMs });
  }

  tabList({ scope } = {}) { return this.tool("tab_list", { scope }); }
  tabCreate({ url, active, index } = {}) { return this.tool("tab_create", { url, active, index }); }
  tabClose(tabId) { return this.tool("tab_close", { tab_id: tabId }); }
  tabSelect(tabId) { return this.tool("tab_select", { tab_id: tabId }); }
  tabBorrow(tabId, { confirmationTimeoutMs } = {}) {
    return this.tool("tab_borrow", { tab_id: tabId, confirmation_timeout_ms: confirmationTimeoutMs });
  }
  tabReturn(tabId) { return this.tool("tab_return", { tab_id: tabId }); }

  waitForNavigation({ tabId, waitUntil, timeoutMs } = {}) {
    return this.tool("wait_for_navigation", { tab_id: tabId, wait_until: waitUntil, timeout_ms: timeoutMs });
  }
  requestHelp({ prompt, title, targets, completionCriteria, tabId, timeoutMs } = {}) {
    return this.tool("request_help", {
      prompt, title, tab_id: tabId, timeout_ms: timeoutMs,
      targets: targets?.map((t) => resolveTarget(t)),
      completion_criteria: completionCriteria,
    });
  }
  console({ tabId, since, limit, maxTextChars, includeStack } = {}) {
    return this.tool("console", { tab_id: tabId, since, limit, max_text_chars: maxTextChars, include_stack: includeStack });
  }
  network({ tabId, since, limit, maxTextChars } = {}) {
    return this.tool("network", { tab_id: tabId, since, limit, max_text_chars: maxTextChars });
  }
  resize(width, height) { return this.tool("window_resize", { width, height }); }
  emulate({ tabId, off, overrides } = {}) { return this.tool("emulate", { tab_id: tabId, off, overrides }); }

  async stop() {
    if (this.#stopped) return null;
    this.#stopped = true;
    return this.#client.call("session.stop", { session_id: this.sessionId }, { idPrefix: "session-stop", timeoutMs: SESSION_STOP_TIMEOUT_MS });
  }
}
