// Checks that test/skill-docs.test.ts applies to the js examples the package ships. They read an example
// as text: a snippet may be a fragment that no parser accepts.

const NUMERIC_LITERAL =
  /^(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)$/;
const SLEEP_CALL = /\b(?:Bun\.sleep(?:Sync)?|waitForTimeout)\s*\(|(?<![\w.])sleep\s*\(/g;
const TIMER_CALL = /\bsetTimeout\s*\(/g;
const QUOTES = new Set(['"', "'", "`"]);

function positiveLiteral(text: string) {
  return NUMERIC_LITERAL.test(text) && Number(text.replaceAll("_", "")) > 0;
}

function lineAround(source: string, index: number) {
  const start = source.lastIndexOf("\n", index) + 1;
  const end = source.indexOf("\n", index);
  return source.slice(start, end === -1 ? source.length : end).trim();
}

// The arguments of the call whose "(" is at `open`, split at its own commas: text inside a string, a
// comment or a nested bracket belongs to the argument it sits in. Undefined when the call never closes.
function callArguments(source: string, open: number): string[] | undefined {
  const parts: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let at = open + 1; at < source.length; at += 1) {
    const char = source.charAt(at);
    if (QUOTES.has(char)) {
      at += 1;
      while (at < source.length && source.charAt(at) !== char) at += source.charAt(at) === "\\" ? 2 : 1;
    } else if (source.startsWith("//", at)) {
      const newline = source.indexOf("\n", at);
      at = newline === -1 ? source.length : newline;
    } else if (source.startsWith("/*", at)) {
      const close = source.indexOf("*/", at + 2);
      at = close === -1 ? source.length : close + 1;
    } else if (char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) {
        parts.push(source.slice(start, at));
        return parts.map((part) => part.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").trim());
      }
      depth -= 1;
    } else if (char === "," && depth === 0) {
      parts.push(source.slice(start, at));
      start = at + 1;
    }
  }
  return undefined;
}

/**
 * The lines of one example that wait on a clock: a sleep call, a timer that only settles a promise (its
 * callback is a bare name), a timer whose delay is a positive number in any spelling (`1000`, `1_000`,
 * `1e3`, `0x3e8`, `1.5`) whatever follows it, and the promise form `setTimeout(ms)`. A timer call is read
 * whole, across lines; one that never closes is reported too.
 */
export function fixedDelays(example: string): string[] {
  const found: string[] = [];
  for (const call of example.matchAll(SLEEP_CALL)) found.push(lineAround(example, call.index));
  for (const call of example.matchAll(TIMER_CALL)) {
    const parts = callArguments(example, call.index + call[0].length - 1);
    const [first = "", delay] = parts ?? [];
    const settlesAPromise = delay !== undefined && /^[\w$]+$/.test(first);
    const waits = positiveLiteral(delay ?? first);
    if (parts === undefined || settlesAPromise || waits) found.push(lineAround(example, call.index));
  }
  return found;
}

const NODE_MODULES = ["fs", "os", "path"];

function declares(example: string, name: string) {
  return new RegExp(
    `\\b(?:const|let|var)\\s+${name}\\s*=|\\bimport\\s+(?:\\*\\s+as\\s+)?${name}\\s+from\\b|\\{[^{}]*\\b${name}\\b[^{}]*\\}\\s*=`,
  ).test(example);
}

/**
 * The Node modules (`fs`, `os`, `path`) the examples of one document call without declaring them. An
 * example runs as written in an eval cell, where no Node module is in scope, so a call needs a
 * declaration in its own example or in an earlier one of the same document.
 */
export function undeclaredNodeModules(examples: readonly string[]): string[] {
  const declared = new Set<string>();
  const missing = new Set<string>();
  for (const example of examples) {
    for (const name of NODE_MODULES) {
      if (declares(example, name)) declared.add(name);
      if (new RegExp(`(?<![\\w.$])${name}\\s*\\.\\s*\\w+\\s*\\(`).test(example) && !declared.has(name)) missing.add(name);
    }
  }
  return [...missing];
}
