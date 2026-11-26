import { parse } from "acorn";
import type { AnyNode, Comment } from "acorn";
import { analyzeScopes } from "../source-scope.ts";

// Checks that test/skill-docs.test.ts applies to the js examples the package ships. Each example is parsed
// as a module: text inside a comment or a string is never mistaken for code, and a call is read as a call
// however it is laid out (#352, #362, #366).

// Names an example may use without declaring them, by where the code runs.
// The language: valid in the example and inside a function handed to the page.
const LANGUAGE_GLOBALS = new Set([
  ..."globalThis undefined NaN Infinity Object Array String Number Boolean Symbol BigInt Math JSON Date RegExp".split(" "),
  ..."Error TypeError RangeError AggregateError Promise Map Set WeakMap WeakSet Reflect Proxy Intl".split(" "),
  ..."parseInt parseFloat isNaN structuredClone encodeURIComponent decodeURIComponent URL URLSearchParams".split(" "),
  ..."TextEncoder TextDecoder AbortController AbortSignal fetch console performance crypto atob btoa".split(" "),
  ..."setTimeout clearTimeout setInterval clearInterval queueMicrotask Uint8Array ArrayBuffer".split(" "),
]);
// The host: Node or Bun, and the helpers of the eval kernel the skill is written for.
const HOST_GLOBALS = new Set("Buffer process Bun tool print display env read write parallel log".split(" "));
// A page: only inside a function handed to one of PAGE_CALLS, which runs in the browser.
const PAGE_GLOBALS = new Set([
  ..."window document location navigator history localStorage sessionStorage innerWidth innerHeight".split(" "),
  ..."scrollX scrollY scrollTo scrollBy getComputedStyle matchMedia MutationObserver IntersectionObserver".split(" "),
  ..."ResizeObserver requestAnimationFrame HTMLElement Element Node Event CustomEvent KeyboardEvent MouseEvent CSS".split(" "),
]);
const PAGE_CALLS = new Set(["evaluate", "evaluateHandle", "waitForFunction", "addInitScript"]);

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

// The name a member access reads when it is written out: `a.name` or `a["name"]`.
function memberName(node: AnyNode): string | undefined {
  if (node.type !== "MemberExpression") return undefined;
  if (!node.computed) return node.property.type === "Identifier" ? node.property.name : undefined;
  return node.property.type === "Literal" && typeof node.property.value === "string" ? node.property.value : undefined;
}

function numericValue(node: AnyNode | undefined): number | undefined {
  if (node?.type === "UnaryExpression" && (node.operator === "+" || node.operator === "-")) {
    const operand = numericValue(node.argument);
    if (operand === undefined) return undefined;
    return node.operator === "-" ? -operand : operand;
  }
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
  if (callee.type !== "MemberExpression") return undefined;
  const method = memberName(callee);
  if (method === undefined) return undefined;
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
 * The lines of one example that wait on a clock. A line is reported for a call, written with a dot or with a
 * string in brackets, to `sleep`, `Bun.sleep`, `Bun.sleepSync`, `scheduler.wait`, `Atomics.wait` or any
 * `waitForTimeout`, and for a `setTimeout` or `setInterval` (bare or on `globalThis`, `window`, `self`)
 * that `timerWaits` accepts. Outside this check: an alias of one of these functions, a name built at run time,
 * and a timer with an inline callback whose delay is a variable. An example that does not parse yields one
 * entry that says so, not its lines.
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
    const name = memberName(node.left);
    if (node.left.object.type === "Identifier" && node.left.object.name === "globalThis" && name !== undefined) {
      names.push(name);
    }
  });
  return names;
}

// Names listed in `// given: a, b` line comments. Only the comma-separated names count; words after them
// are a note for the reader. The comments come from the parser, so the same text inside a string is not one.
function givenNames(example: string) {
  const comments: Comment[] = [];
  parse(example, { ecmaVersion: "latest", sourceType: "module", onComment: comments });
  const names: string[] = [];
  for (const comment of comments) {
    const list = comment.type === "Line" ? /^\s*given:\s*([\w$]+(?:\s*,\s*[\w$]+)*)/.exec(comment.value)?.[1] : undefined;
    for (const name of list?.split(",") ?? []) names.push(name.trim());
  }
  return names;
}

// Source ranges of the functions handed to the page (the arguments of PAGE_CALLS): their bodies run in the browser.
function pageFunctionRanges(root: AnyNode) {
  const ranges: Array<readonly [start: number, end: number]> = [];
  everyNode(root, (node) => {
    if (node.type !== "CallExpression") return;
    const method = memberName(node.callee);
    if (method === undefined || !PAGE_CALLS.has(method)) return;
    for (const argument of node.arguments) {
      if (argument.type === "ArrowFunctionExpression" || argument.type === "FunctionExpression") {
        ranges.push([argument.start, argument.end]);
      }
    }
  });
  return ranges;
}

/**
 * The names the examples of one document use without accounting for them, in document order. An example
 * runs as written in an eval cell, so each free name must be one of: declared in this example or an earlier
 * one of the document (a declaration, an import, an assignment on `globalThis`); a language global; a host
 * global, outside a function handed to the page; a page global, inside one; or listed in a `// given: a, b`
 * comment, which is how an example names what its reader supplies. A given name holds for the rest of the
 * document, as a declaration does. Not modelled: a function handed to the page cannot see the example's own
 * variables, and code passed to the page as a string is not read. Examples that do not parse are skipped here.
 */
export function unaccountedNames(examples: readonly string[]): string[] {
  const known = new Set<string>();
  const missing = new Set<string>();
  for (const example of examples) {
    if (parseFailure(example) !== undefined) continue;
    for (const name of givenNames(example)) known.add(name);
    const analysis = analyzeScopes(example);
    const here = new Set([...analysis.declared, ...assignedOnGlobalThis(analysis.ast)]);
    const inPage = pageFunctionRanges(analysis.ast);
    for (const { name, node } of analysis.free) {
      if (known.has(name) || here.has(name) || LANGUAGE_GLOBALS.has(name)) continue;
      const onPage = inPage.some(([start, end]) => node.start >= start && node.end <= end);
      if (!(onPage ? PAGE_GLOBALS : HOST_GLOBALS).has(name)) missing.add(name);
    }
    for (const name of here) known.add(name);
  }
  return [...missing];
}
