import { parse } from "acorn";
import type { AnyNode, Comment } from "acorn";
import { analyzeScopes } from "../source-scope.ts";

// Checks that test/skill-docs.test.ts applies to the js examples the package ships. Each example is parsed
// as a module: text inside a comment or a string is never mistaken for code, and a call is read as a call
// however it is laid out (#352, #362, #366).

// Names an example may use without declaring them, by where the code runs.
// The language: valid in the example and inside a function handed to the page.
const LANGUAGE_GLOBALS = new Set([
  ..."globalThis undefined NaN Infinity Object Array String Number Boolean Symbol BigInt Math JSON Date RegExp".split(
    " ",
  ),
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
  ..."ResizeObserver requestAnimationFrame HTMLElement Element Node Event CustomEvent KeyboardEvent MouseEvent CSS".split(
    " ",
  ),
]);
const PAGE_CALLS = new Set([
  "evaluate",
  "evaluateHandle",
  "evaluateAll",
  "waitForFunction",
  "addInitScript",
  "$eval",
  "$$eval",
]);

// Callee paths, written without a leading globalThis/window/self.
const SLEEP_PATHS = new Set(["sleep", "Bun.sleep", "Bun.sleepSync", "scheduler.wait"]);
const SLEEP_METHODS = new Set(["waitForTimeout"]);
const TIMER_PATHS = new Set(["setTimeout", "setInterval"]);
const FUTEX_PATH = "Atomics.wait";
const GLOBAL_HOLDERS = new Set(["globalThis", "window", "self"]);

function isNode(value: unknown): value is AnyNode {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function everyNode(root: AnyNode, visit: (node: AnyNode) => void) {
  visit(root);
  for (const value of Object.values(root)) {
    for (const item of Array.isArray(value) ? value : [value]) if (isNode(item)) everyNode(item, visit);
  }
}

// The name a member access reads when it is written out: `a.name`, or `a["name"]` with a plain or a
// template string that has no placeholders.
function memberName(node: AnyNode): string | undefined {
  if (node.type !== "MemberExpression") return undefined;
  const { property } = node;
  if (!node.computed) return property.type === "Identifier" ? property.name : undefined;
  if (property.type === "Literal") return typeof property.value === "string" ? property.value : undefined;
  if (property.type !== "TemplateLiteral" || property.expressions.length > 0) return undefined;
  return property.quasis[0]?.value.cooked ?? undefined;
}

// The dotted path a callee is written as (`Bun.sleep`), without leading globalThis/window/self; undefined
// when a part of it is not a written-out name.
function calleePath(callee: AnyNode): string | undefined {
  const segments: string[] = [];
  let node = callee;
  while (node.type === "MemberExpression" || node.type === "ChainExpression") {
    if (node.type === "ChainExpression") {
      node = node.expression;
      continue;
    }
    const name = memberName(node);
    if (name === undefined) return undefined;
    segments.unshift(name);
    node = node.object;
  }
  if (node.type !== "Identifier") return undefined;
  segments.unshift(node.name);
  while (segments.length > 1 && GLOBAL_HOLDERS.has(segments[0] ?? "")) segments.shift();
  return segments.join(".");
}

// The number an argument is written as: a numeric literal, with a sign, or arithmetic on such numbers
// (`60 * 1000`). Undefined for anything that is only known at run time.
function numericValue(node: AnyNode | undefined): number | undefined {
  if (node?.type === "UnaryExpression" && (node.operator === "+" || node.operator === "-")) {
    const operand = numericValue(node.argument);
    if (operand === undefined) return undefined;
    return node.operator === "-" ? -operand : operand;
  }
  if (node?.type === "BinaryExpression" && node.left.type !== "PrivateIdentifier") {
    const left = numericValue(node.left);
    const right = numericValue(node.right);
    if (left === undefined || right === undefined) return undefined;
    if (node.operator === "*") return left * right;
    if (node.operator === "+") return left + right;
    if (node.operator === "-") return left - right;
    return node.operator === "/" ? left / right : undefined;
  }
  if (node?.type !== "Literal") return undefined;
  if (typeof node.value === "number") return node.value;
  return typeof node.value === "bigint" ? Number(node.value) : undefined;
}

// A timer waits on a clock when its delay is a positive number, or when its callback is a bare name (it
// only settles a promise) and the delay is anything but a written zero. `setTimeout(ms)` is the promise form.
function timerWaits(parts: readonly AnyNode[]) {
  const [first, second] = parts;
  if (second === undefined) return (numericValue(first) ?? 0) > 0;
  const delay = numericValue(second);
  return delay === undefined ? first?.type === "Identifier" : delay > 0;
}

// Whether a call waits on a clock. A sleep does unless its delay is a written zero, which only yields.
// `Atomics.wait` waits on shared memory; it is a clock wait only when it carries a timeout, its 4th argument.
function waitsOnAClock(callee: AnyNode, parts: readonly AnyNode[]) {
  const path = calleePath(callee);
  const method = memberName(callee);
  if ((method !== undefined && SLEEP_METHODS.has(method)) || (path !== undefined && SLEEP_PATHS.has(path))) {
    return numericValue(parts[0]) !== 0;
  }
  if (path === FUTEX_PATH) return parts.length >= 4;
  return path !== undefined && TIMER_PATHS.has(path) && timerWaits(parts);
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
 * The lines of one example that wait on a clock. A line is reported for a call, written with dots or with
 * strings in brackets and with or without a leading `globalThis`, `window` or `self`, to:
 * - `sleep`, `Bun.sleep`, `Bun.sleepSync`, `scheduler.wait`, or a method named `waitForTimeout` on any
 *   receiver, unless its delay is a written zero;
 * - `Atomics.wait` with a timeout (a fourth argument);
 * - `setTimeout` or `setInterval` that `timerWaits` accepts.
 * Outside this check: an alias of one of these functions (an import under another name, `.call`, `.apply`,
 * `.bind`), a name built at run time, and a timer with an inline callback whose delay is not written as a
 * number. An example that does not parse yields one entry that says so, not its lines.
 */
export function fixedDelays(example: string): string[] {
  const failure = parseFailure(example);
  if (failure !== undefined) return [`unparseable example (${failure})`];
  const lines = example.split("\n");
  const found: string[] = [];
  everyNode(analyzeScopes(example).ast, (node) => {
    if (node.type !== "CallExpression" || !waitsOnAClock(node.callee, node.arguments)) return;
    found.push((lines[(node.loc?.start.line ?? 1) - 1] ?? "").trim());
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
    const list =
      comment.type === "Line" ? /^\s*given:\s*([\w$]+(?:\s*,\s*[\w$]+)*)/.exec(comment.value)?.[1] : undefined;
    for (const name of list?.split(",") ?? []) names.push(name.trim());
  }
  return names;
}

function isFunction(node: AnyNode) {
  return node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression";
}

// Source ranges of the functions handed to the page (an argument of one of PAGE_CALLS, written inline or
// declared in the same example and passed by name): their bodies run in the browser.
function pageFunctionRanges(root: AnyNode) {
  const declared = new Map<string, readonly [start: number, end: number]>();
  everyNode(root, (node) => {
    if (node.type === "FunctionDeclaration" && node.id !== null) declared.set(node.id.name, [node.start, node.end]);
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init && isFunction(node.init)) {
      declared.set(node.id.name, [node.init.start, node.init.end]);
    }
  });
  const ranges: Array<readonly [start: number, end: number]> = [];
  everyNode(root, (node) => {
    if (node.type !== "CallExpression") return;
    const method = memberName(node.callee);
    if (method === undefined || !PAGE_CALLS.has(method)) return;
    for (const argument of node.arguments) {
      if (isFunction(argument)) ranges.push([argument.start, argument.end]);
      const byName = argument.type === "Identifier" ? declared.get(argument.name) : undefined;
      if (byName !== undefined) ranges.push(byName);
    }
  });
  return ranges;
}

/**
 * The names the examples of one document use without accounting for them, in document order. An example
 * runs as written in an eval cell, so each free name must be one of: declared in this example or an earlier
 * one of the document (a declaration, an import, an assignment on `globalThis`); a language global; a host
 * global, outside a function handed to the page; a page global, inside one (written inline as an argument
 * of `evaluate`, `waitForFunction` and the like, or declared in the same example and passed by name); or
 * listed in a `// given: a, b` line comment, which is how an example names what its reader supplies. A given name holds for the rest of the
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
