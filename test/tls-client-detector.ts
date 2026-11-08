import { execFileSync } from "node:child_process";
import * as nodeModule from "node:module";
import { parse } from "acorn";
import type { AnyNode } from "acorn";

export interface TlsClientHit {
  line: number;
  text: string;
}

export interface ScannedSource {
  path: string;
  content: string;
}

export interface TlsAllowlistEntry {
  file: string;
  call: string;
  count: number;
  reason?: string;
}

type MaybeNode = AnyNode | null | undefined;

const CLIENTS: Record<string, ReadonlySet<string | undefined>> = {
  tls: new Set(["connect", "createConnection", "TLSSocket", "createSecureContext", "checkServerIdentity"]),
  https: new Set(["request", "get", "Agent", "globalAgent"]),
  http2: new Set(["connect"]),
  Bun: new Set(["connect"]),
};

// Property-key lookup, coerced exactly like the bracket access it stands for.
const clientsOf = (key: string | undefined): ReadonlySet<string | undefined> | undefined => CLIENTS[String(key)];

// TypeScript sources are type-stripped before acorn reads them. Node's strip mode blanks
// every type with whitespace, so offsets, lines and the normalized call text match the file.
const TYPESCRIPT_SOURCE = /\.(?:[cm]?ts|tsx)$/;
const STRIP_PROGRAM = `import { stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";
const sources = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(sources.map((code) => {
  try { return { code: stripTypeScriptTypes(code) }; } catch (error) { return { error: String(error?.message ?? error) }; }
})));`;

type StripOutcome = { code: string } | { error: string };

function stripOutcomes(contents: readonly string[]): StripOutcome[] {
  const strip: unknown = nodeModule.stripTypeScriptTypes;
  if (typeof strip === "function") {
    return contents.map((code) => {
      try {
        return { code: String(strip(code)) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });
  }
  const output = execFileSync("node", ["--no-warnings", "--input-type=module", "-e", STRIP_PROGRAM], {
    input: JSON.stringify(contents),
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  const outcomes: StripOutcome[] = JSON.parse(output);
  return outcomes;
}

function stripTypes(sources: readonly ScannedSource[]): string[] {
  if (sources.length === 0) return [];
  let outcomes: StripOutcome[];
  try {
    outcomes = stripOutcomes(sources.map((source) => source.content));
  } catch (error) {
    const files = sources.map((source) => source.path).join(", ");
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${files}: TypeScript stripping needs Node.js >= 22.13 on PATH: ${reason}`, { cause: error });
  }
  return sources.map((source, index) => {
    const outcome = outcomes[index];
    if (!outcome || "error" in outcome) {
      throw new SyntaxError(source.path + ": " + (outcome?.error ?? "type stripping returned no result"));
    }
    if (outcome.code.length !== source.content.length) {
      throw new Error(source.path + ": type stripping moved source positions");
    }
    return outcome.code;
  });
}

function isNode(value: unknown): value is AnyNode {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function nodes(tree: AnyNode): AnyNode[] {
  const result: AnyNode[] = [];
  const visit = (node: unknown) => {
    if (!isNode(node)) return;
    result.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(tree);
  return result;
}

function literal(node: MaybeNode): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral") {
    let value = node.quasis[0]?.value.cooked;
    if (value == null) return undefined;
    for (let i = 0; i < node.expressions.length; i++) {
      const part = literal(node.expressions[i]);
      if (part === undefined) return undefined;
      value += part + node.quasis[i + 1]?.value.cooked;
    }
    return value;
  }
  if (node?.type === "BinaryExpression" && node.operator === "+") {
    const left = literal(node.left),
      right = literal(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}

function unwrap(node: MaybeNode): MaybeNode {
  return node?.type === "ChainExpression" ? unwrap(node.expression) : node;
}

function nameOf(node: MaybeNode): string | undefined {
  return node?.type === "Identifier" || node?.type === "PrivateIdentifier" ? node.name : undefined;
}

function member(input: MaybeNode): string | undefined {
  const node = unwrap(input);
  if (node?.type !== "MemberExpression") return undefined;
  return node.computed ? literal(node.property) : nameOf(node.property);
}

function keyName(property: AnyNode): string | undefined {
  return property.type === "Property" ? (nameOf(property.key) ?? literal(property.key)) : undefined;
}

function plain(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/,\s*([)}])/g, "$1")
    .replace(/\s+([)}])/g, "$1");
}

function normalizeNode(node: AnyNode, content: string): string {
  const spans = nodes(node)
    .filter((n) => n.type === "Literal" || n.type === "TemplateElement")
    .toSorted((a, b) => a.start - b.start);
  let end = node.start,
    text = "";
  for (const span of spans) {
    if (span.start < end) continue;
    text += plain(content.slice(end, span.start)) + content.slice(span.start, span.end);
    end = span.end;
  }
  return (text + plain(content.slice(end, node.end))).trim().replace(/;$/, "");
}

function scanJavaScript(content: string, file: string): TlsClientHit[] {
  let tree: AnyNode;
  try {
    tree = parse(content, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch (error) {
    throw new SyntaxError(file + ": " + (error instanceof Error ? error.message : String(error)), { cause: error });
  }
  const list = nodes(tree);
  const bindings = new Map<string | undefined, string>(
    [...Object.keys(CLIENTS), "globalThis"].map((name) => [name, name]),
  );
  const requireNames = new Set<string | undefined>(["require", "__require"]);
  const requireFactories = new Set<string | undefined>();
  const builtinNames = new Set<string | undefined>();
  const kind = (expression: MaybeNode): string | undefined => {
    const node = unwrap(expression);
    if (node?.type === "Identifier") return bindings.get(node.name);
    if (node?.type === "AwaitExpression") return kind(node.argument);
    if (node?.type === "ImportExpression") return literal(node.source)?.replace(/^node:/, "");
    if (node?.type === "CallExpression") {
      const callee = unwrap(node.callee);
      const name = member(callee) ?? nameOf(callee);
      if (
        name === "get" &&
        callee?.type === "MemberExpression" &&
        nameOf(unwrap(callee.object)) === "Reflect" &&
        kind(node.arguments[0]) === "globalThis" &&
        literal(node.arguments[1]) === "Bun"
      )
        return "Bun";
      const factory = callee?.type === "CallExpression" && requireFactories.has(nameOf(callee.callee));
      const call =
        member(callee) === "call" && callee?.type === "MemberExpression" && requireNames.has(nameOf(callee.object));
      if (requireNames.has(name) || name === "getBuiltinModule" || builtinNames.has(name) || factory || call) {
        return literal(node.arguments[call ? 1 : 0])?.replace(/^node:/, "");
      }
    }
    if (node?.type === "MemberExpression") {
      const base = kind(node.object),
        property = member(node);
      if (base === "globalThis") return bindings.get(property);
      if (clientsOf(base)?.has(property)) return base + "#" + property;
      if (base?.includes("#") && (property === "call" || property === "apply")) return base;
    }
    return undefined;
  };
  for (const node of list) {
    if (node.type !== "ImportDeclaration") continue;
    const specifier = literal(node.source),
      module = specifier?.replace(/^node:/, "");
    for (const spec of node.specifiers) {
      const imported =
        spec.type === "ImportSpecifier"
          ? spec.imported.type === "Identifier"
            ? spec.imported.name
            : literal(spec.imported)
          : undefined;
      if (module === "module" && imported === "createRequire") requireFactories.add(spec.local.name);
      if (clientsOf(module))
        bindings.set(spec.local.name, imported && imported !== "default" ? module + "#" + imported : String(module));
    }
  }
  let changed;
  do {
    changed = false;
    const bind = (name: string | undefined, value: string | undefined) => {
      if (value && !bindings.has(name)) {
        bindings.set(name, value);
        changed = true;
      }
    };
    for (const node of list) {
      if (node.type !== "VariableDeclarator" || !node.init) continue;
      if (node.init.type === "CallExpression" && requireFactories.has(nameOf(node.init.callee))) {
        requireNames.add(nameOf(node.id));
      }
      const value = kind(node.init);
      if (node.id.type === "Identifier") bind(node.id.name, value);
      if (node.id.type === "ObjectPattern")
        for (const prop of node.id.properties) {
          const name = keyName(prop);
          const local = prop.type === "Property" ? nameOf(prop.value) : undefined;
          if (node.init.type === "Identifier" && node.init.name === "process" && name === "getBuiltinModule")
            builtinNames.add(local);
          if (name === "default" && clientsOf(value)) bind(local, value);
          else if (clientsOf(value)?.has(name)) bind(local, value + "#" + name);
        }
    }
  } while (changed);
  const hits: TlsClientHit[] = [],
    seen = new Set<number>();
  const calledMembers = new Set<MaybeNode>(
    list.flatMap((n) => (n.type === "CallExpression" || n.type === "NewExpression" ? [unwrap(n.callee)] : [])),
  );
  const add = (node: AnyNode) => {
    if (seen.has(node.start)) return;
    seen.add(node.start);
    if (!node.loc) throw new Error(file + ": parser returned a node without a location");
    hits.push({ line: node.loc.start.line, text: normalizeNode(node, content) });
  };
  for (const node of list) {
    if (
      node.type === "AssignmentExpression" &&
      node.left.type === "ObjectPattern" &&
      kind(node.right) === "Bun" &&
      node.left.properties.some((p) => keyName(p) === "connect")
    )
      add(node);
    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      clientsOf(literal(node.source)?.replace(/^node:/, ""))
    )
      add(node);
    if (node.type === "ImportExpression" && clientsOf(kind(node))) add(node);
    if (node.type === "CallExpression" && clientsOf(kind(node)) && kind(node) !== "Bun") add(node);
    if (node.type === "CallExpression" || node.type === "NewExpression") {
      const value = kind(node.callee);
      const [base, property] = value?.split("#") ?? [];
      if (clientsOf(base)?.has(property)) add(node);
    }
    if (node.type === "MemberExpression" && kind(node) === "Bun#connect") {
      if (!calledMembers.has(node)) add(node);
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "ObjectPattern" &&
      kind(node.init) === "Bun" &&
      node.id.properties.some((p) => keyName(p) === "connect")
    )
      add(node);
    if (node.type === "Property" && keyName(node) === "checkServerIdentity") add(node);
    if (node.type === "AssignmentExpression" && member(node.left) === "checkServerIdentity") add(node);
  }
  return hits;
}

export function findRawTlsClients(content: string, file = "source.js"): TlsClientHit[] {
  const [code = content] = TYPESCRIPT_SOURCE.test(file) ? stripTypes([{ path: file, content }]) : [];
  return scanJavaScript(code, file);
}

export function isScannedSourceFile(file: string): boolean {
  return (
    /\.(?:[cm]?js|jsx|tsx?)$/.test(file) &&
    !/\.(?:test|spec)\.[^/]+$/.test(file) &&
    !file.endsWith(".d.ts") &&
    !file
      .split("/")
      .some((segment) =>
        [
          "test",
          "tests",
          "__tests__",
          "fixtures",
          "__fixtures__",
          "test-support",
          "test-fixtures",
          "node_modules",
          ".git",
        ].includes(segment),
      )
  );
}

export function evaluateShippedSource(
  scan: readonly ScannedSource[],
  allowlist: readonly TlsAllowlistEntry[],
): { offenders: string[]; stale: string[] } {
  const offenders: string[] = [];
  const counts = new Map<TlsAllowlistEntry, number>(allowlist.map((entry) => [entry, 0]));
  const calls = new Map(
    allowlist.map((entry) => [
      entry,
      normalizeNode(parse(entry.call, { ecmaVersion: "latest", sourceType: "module" }), entry.call),
    ]),
  );
  const typescript = scan.filter((item) => TYPESCRIPT_SOURCE.test(item.path));
  const stripped = new Map(stripTypes(typescript).map((code, index) => [typescript[index], code]));
  for (const item of scan) {
    for (const hit of scanJavaScript(stripped.get(item) ?? item.content, item.path)) {
      const entry = allowlist.find((candidate) => candidate.file === item.path && calls.get(candidate) === hit.text);
      if (entry) counts.set(entry, (counts.get(entry) ?? 0) + 1);
      else offenders.push(`${item.path}:${hit.line}  ${hit.text}`);
    }
  }
  const stale: string[] = [];
  for (const entry of allowlist) {
    if (!scan.some((item) => item.path === entry.file)) stale.push(`${entry.file}: no longer scanned`);
    if (counts.get(entry) !== entry.count) {
      stale.push(`${entry.file}: expected ${entry.call} x${entry.count}, found x${counts.get(entry)}`);
    }
    if (!entry.reason?.trim() || !Number.isInteger(entry.count) || entry.count < 1) {
      stale.push(`${entry.file}: requires positive count and reviewed host provenance`);
    }
  }
  return { offenders, stale };
}
