import type { AnyNode } from "acorn";
import { analyzeScopes } from "../source-scope.ts";

// Checks that test/skill-docs.test.ts applies to the js examples the package ships. Each example is parsed
// as a module: text inside a comment or a string is never mistaken for code, and a call is read as a call
// however it is laid out (#352, #362, #366).

export const PLATFORM_GLOBALS: ReadonlySet<string> = new Set([
  // the language and the runtimes an example runs on (Node, Bun)
  ..."globalThis undefined NaN Infinity Object Array String Number Boolean Symbol BigInt Math JSON Date RegExp".split(" "),
  ..."Error TypeError RangeError AggregateError Promise Map Set WeakMap WeakSet Reflect Proxy Intl".split(" "),
  ..."parseInt parseFloat isNaN structuredClone encodeURIComponent decodeURIComponent URL URLSearchParams".split(" "),
  ..."TextEncoder TextDecoder AbortController AbortSignal fetch console performance crypto atob btoa".split(" "),
  ..."setTimeout clearTimeout setInterval clearInterval queueMicrotask Uint8Array ArrayBuffer Buffer process Bun".split(" "),
  // the helpers of the eval kernel the skill is written for
  ..."tool print display env read write parallel log".split(" "),
  // a page, inside a function handed to evaluate() or waitForFunction()
  ..."window document location navigator history localStorage sessionStorage innerWidth innerHeight".split(" "),
  ..."scrollX scrollY scrollTo scrollBy getComputedStyle matchMedia MutationObserver IntersectionObserver".split(" "),
  ..."ResizeObserver requestAnimationFrame HTMLElement Element Node Event CustomEvent KeyboardEvent MouseEvent CSS".split(" "),
]);

const SLEEP_FUNCTIONS = new Set(["sleep"]);
const SLEEP_METHODS = new Set(["waitForTimeout"]);
const SLEEP_MEMBERS = new Set(["Bun.sleep", "Bun.sleepSync", "scheduler.wait", "Atomics.wait"]);
const TIMERS = new Set(["setTimeout", "setInterval"]);
const TIMER_HOLDERS = new Set(["globalThis", "window", "self"]);

function isNode(value: unknown): value is AnyNode {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function everyNode(root: AnyNode, visit: (node: AnyNode) => void) {
  visit(root);
  for (const value of Object.values(root)) {
    for (const item of Array.isArray(value) ? value : [value]) if (isNode(item)) everyNode(item, visit);
  }
}

function numericValue(node: AnyNode | undefined): number | undefined {
  if (node?.type === "UnaryExpression" && node.operator === "+") return numericValue(node.argument);
  if (node?.type !== "Literal") return undefined;
  if (typeof node.value === "number") return node.value;
  return typeof node.value === "bigint" ? Number(node.value) : undefined;
}

type Clock = "sleep" | "timer" | undefined;

function clockOf(callee: AnyNode): Clock {
  if (callee.type === "Identifier") {
    if (TIMERS.has(callee.name)) return "timer";
    return SLEEP_FUNCTIONS.has(callee.name) ? "sleep" : undefined;
  }
  if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier") return undefined;
  const method = callee.property.name;
  if (SLEEP_METHODS.has(method)) return "sleep";
  if (callee.object.type !== "Identifier") return undefined;
  if (SLEEP_MEMBERS.has(`${callee.object.name}.${method}`)) return "sleep";
  return TIMER_HOLDERS.has(callee.object.name) && TIMERS.has(method) ? "timer" : undefined;
}

// A timer waits on a clock when its delay is a positive number, or when its callback is a bare name (it
// only settles a promise) and the delay is anything but zero. `setTimeout(ms)` is the promise form.
function timerWaits(parts: readonly AnyNode[]) {
  const [first, second] = parts;
  if (second === undefined) return (numericValue(first) ?? 0) > 0;
  const delay = numericValue(second);
  return delay === undefined ? first?.type === "Identifier" : delay > 0;
}

export function parseFailure(example: string): string | undefined {
  try {
    analyzeScopes(example);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * The lines of one example that wait on a clock: a call to `sleep`, `Bun.sleep`, `Bun.sleepSync`,
 * `scheduler.wait`, `Atomics.wait` or any `waitForTimeout`, and a `setTimeout` or `setInterval` (bare or on
 * `globalThis`, `window`, `self`) that `timerWaits` accepts. A delay kept in a variable and an alias of a
 * timer are outside this check. An example that does not parse is reported whole.
 */
export function fixedDelays(example: string): string[] {
  const failure = parseFailure(example);
  if (failure !== undefined) return [`unparseable example (${failure})`];
  const lines = example.split("\n");
  const found: string[] = [];
  everyNode(analyzeScopes(example).ast, (node) => {
    if (node.type !== "CallExpression") return;
    const clock = clockOf(node.callee);
    if (clock === "sleep" || (clock === "timer" && timerWaits(node.arguments))) {
      found.push((lines[(node.loc?.start.line ?? 1) - 1] ?? "").trim());
    }
  });
  return found;
}

function assignedOnGlobalThis(root: AnyNode) {
  const names: string[] = [];
  everyNode(root, (node) => {
    if (node.type !== "AssignmentExpression" || node.left.type !== "MemberExpression") return;
    const { object, property, computed } = node.left;
    if (object.type === "Identifier" && object.name === "globalThis" && !computed && property.type === "Identifier") {
      names.push(property.name);
    }
  });
  return names;
}

/**
 * The names the examples of one document use without accounting for them, in document order. An example
 * runs as written in an eval cell, so each name is one of: declared in this example or an earlier one of
 * the document (a declaration, an import, an assignment on `globalThis`), a platform global, or listed in a
 * `// given: a, b` comment, which is how an example names what its reader supplies (only the comma-separated
 * names count; words after them are a note for the reader). A given name holds for the rest of the document,
 * as a declaration does. Examples that do not parse are skipped here.
 */
export function unaccountedNames(examples: readonly string[], platform = PLATFORM_GLOBALS): string[] {
  const known = new Set<string>();
  const missing = new Set<string>();
  for (const example of examples) {
    if (parseFailure(example) !== undefined) continue;
    for (const given of example.matchAll(/\/\/\s*given:\s*([\w$]+(?:\s*,\s*[\w$]+)*)/g)) {
      for (const name of (given[1] ?? "").split(",")) known.add(name.trim());
    }
    const analysis = analyzeScopes(example);
    const here = new Set([...analysis.declared, ...assignedOnGlobalThis(analysis.ast)]);
    for (const { name } of analysis.free) {
      if (!known.has(name) && !here.has(name) && !platform.has(name)) missing.add(name);
    }
    for (const name of here) known.add(name);
  }
  return [...missing];
}
