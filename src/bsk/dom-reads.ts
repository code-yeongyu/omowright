import { optionalElementTarget, resolveElementTarget } from "./targets.ts";
import type { ElementTargetInput } from "./targets.ts";
import type { ToolSession } from "./shared-tab.ts";
import type { ElementState, ExtractAction, ExtractField, ReadField } from "./protocol/params.generated.ts";

export interface ReadOptions {
  fields?: readonly ReadField[];
  maxNodes?: number;
  maxBytes?: number;
  tabId?: number;
  timeoutMs?: number;
  context?: string;
}

export interface ExtractOptions {
  target?: ElementTargetInput;
  itemSelector?: string;
  fields?: readonly ExtractField[];
  maxRows?: number;
  maxColumns?: number;
  maxBytes?: number;
  targetId?: string;
  tabId?: number;
  timeoutMs?: number;
}

export interface WaitForElementOptions {
  state: ElementState;
  pollMs?: number;
  tabId?: number;
  timeoutMs?: number;
}

export function readNodes(
  session: ToolSession<"read">,
  target: ElementTargetInput | undefined,
  { fields, maxNodes, maxBytes, tabId, timeoutMs, context }: ReadOptions = {},
): Promise<unknown> {
  return session.tool("read", {
    ...optionalElementTarget(target),
    fields,
    max_nodes: maxNodes,
    max_bytes: maxBytes,
    tab_id: tabId,
    timeout_ms: timeoutMs,
    context_id: context,
  });
}

export function extractItems(
  session: ToolSession<"extract">,
  action: ExtractAction,
  { target, itemSelector, fields, maxRows, maxColumns, maxBytes, targetId, tabId, timeoutMs }: ExtractOptions = {},
): Promise<unknown> {
  return session.tool("extract", {
    action,
    ...optionalElementTarget(target),
    item_selector: itemSelector,
    fields,
    max_rows: maxRows,
    max_columns: maxColumns,
    max_bytes: maxBytes,
    target_id: targetId,
    tab_id: tabId,
    timeout_ms: timeoutMs,
  });
}

export function waitForElement(
  session: ToolSession<"wait_for_element">,
  target: ElementTargetInput,
  { state, pollMs, tabId, timeoutMs }: WaitForElementOptions,
): Promise<unknown> {
  return session.tool("wait_for_element", {
    ...resolveElementTarget(target),
    state,
    poll_ms: pollMs,
    tab_id: tabId,
    timeout_ms: timeoutMs,
  });
}
