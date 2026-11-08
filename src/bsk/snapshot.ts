// OmOWright-style {tree, refs} snapshot from a BrowserSkill session without
// leaving a trace in the page: the page bundle assigns `globalThis.__omowright`
// exactly once, so shadowing `globalThis` with a local object keeps the real
// window untouched, and the css paths let a ref be clicked through the
// daemon's `selector` target (no DOM attribute is written).
import { pageBundle } from "../injected.ts";
import { readProperty } from "../read-property.ts";
import { optionalProperty } from "./reply-fields.ts";
import type { BskSession } from "./session.ts";

const CSS_PATH_FN = String(function cssPath(el: unknown) {
  if (!(el instanceof Element)) return null;
  if (el.getRootNode() !== document) return null;
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    let part = node.localName;
    if (node.id && /^[A-Za-z_][\w-]*$/.test(node.id) && document.querySelectorAll("#" + node.id).length === 1) {
      parts.unshift("#" + node.id);
      return parts.join(" > ");
    }
    const parent: HTMLElement | null = node.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.localName === part);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  parts.unshift("html");
  return parts.join(" > ");
});

export type EvaluateSession = Pick<BskSession, "evaluate">;

export interface BskSnapshotOptions {
  tabId?: number;
  timeoutMs?: number;
  context?: string;
  dependsOn?: readonly string[];
  [option: string]: unknown;
}

export interface BskSnapshot {
  tree: string;
  refs: unknown;
  css: unknown;
}

export function buildSnapshotExpression(options: Record<string, unknown> = {}): string {
  return `(function () {
  const globalThis = {};
  ${pageBundle}
  const api = globalThis.__omowright;
  const result = api.takeSnapshot(${JSON.stringify(options)});
  const cssPath = ${CSS_PATH_FN};
  const css = {};
  for (const ref of Object.keys(result.refs || {})) css[ref] = cssPath(api.elementRegistry.get(ref));
  return { tree: result.tree, refs: result.refs || {}, css, error: result.error };
})()`;
}

export async function bskSnapshot(
  session: EvaluateSession,
  { tabId, timeoutMs, context, dependsOn, ...snapshotOptions }: BskSnapshotOptions = {},
): Promise<BskSnapshot> {
  const reply = await session.evaluate(buildSnapshotExpression(snapshotOptions), {
    tabId,
    timeoutMs,
    context,
    dependsOn,
    awaitPromise: false,
    returnByValue: true,
  });
  if (!reply || readProperty(reply, "ok") === false) {
    const text = optionalProperty(optionalProperty(reply, "error"), "text") ?? "unknown error";
    throw new Error(`bskSnapshot failed inside the page: ${text}`);
  }
  const value = readProperty(reply, "value");
  const tree = value ? readProperty(value, "tree") : undefined;
  if (!value || typeof tree !== "string") throw new Error("bskSnapshot: page returned no tree");
  const error = readProperty(value, "error");
  if (error) throw new Error(`bskSnapshot: ${error}`);
  return { tree, refs: readProperty(value, "refs"), css: readProperty(value, "css") };
}
