import { parse } from "acorn";

const CLIENTS = {
  tls: new Set(["connect", "createConnection", "TLSSocket", "createSecureContext", "checkServerIdentity"]),
  https: new Set(["request", "get", "Agent", "globalAgent"]),
  http2: new Set(["connect"]),
  Bun: new Set(["connect"]),
};

function nodes(tree) {
  const result = [];
  const visit = node => {
    if (!node || typeof node.type !== "string") return;
    result.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(tree);
  return result;
}

function literal(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral") {
    let value = node.quasis[0].value.cooked;
    for (let i = 0; i < node.expressions.length; i++) {
      const part = literal(node.expressions[i]);
      if (part === undefined) return undefined;
      value += part + node.quasis[i + 1].value.cooked;
    }
    return value;
  }
  if (node?.type === "BinaryExpression" && node.operator === "+") {
    const left = literal(node.left), right = literal(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
}

function unwrap(node) {
  return node?.type === "ChainExpression" ? unwrap(node.expression) : node;
}

function member(node) {
  node = unwrap(node);
  if (node?.type !== "MemberExpression") return undefined;
  return node.computed ? literal(node.property) : node.property.name;
}

function normalizeNode(node, content) {
  const spans = nodes(node).filter(n => n.type === "Literal" || n.type === "TemplateElement")
    .sort((a, b) => a.start - b.start);
  const plain = text => text.replace(/\s+/g, " ").replace(/\(\s+/g, "(")
    .replace(/,\s*([)}])/g, "$1").replace(/\s+([)}])/g, "$1");
  let end = node.start, text = "";
  for (const span of spans) {
    if (span.start < end) continue;
    text += plain(content.slice(end, span.start)) + content.slice(span.start, span.end);
    end = span.end;
  }
  return (text + plain(content.slice(end, node.end))).trim().replace(/;$/, "");
}

export function findRawTlsClients(content, file = "source.js") {
  let tree;
  try {
    tree = parse(content, { ecmaVersion: "latest", sourceType: "module", locations: true,
      allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
  } catch (error) {
    throw new SyntaxError(file + ": " + error.message, { cause: error });
  }
  const list = nodes(tree);
  const bindings = new Map([...Object.keys(CLIENTS), "globalThis"].map(name => [name, name]));
  const requireNames = new Set(["require", "__require"]);
  const requireFactories = new Set();
  const builtinNames = new Set();
  const kind = expression => {
    const node = unwrap(expression);
    if (node?.type === "Identifier") return bindings.get(node.name);
    if (node?.type === "AwaitExpression") return kind(node.argument);
    if (node?.type === "ImportExpression") return literal(node.source)?.replace(/^node:/, "");
    if (node?.type === "CallExpression") {
      const callee = unwrap(node.callee);
      const name = member(callee) ?? callee.name;
      if (name === "get" && unwrap(callee.object)?.name === "Reflect"
        && kind(node.arguments[0]) === "globalThis" && literal(node.arguments[1]) === "Bun") return "Bun";
      const factory = callee.type === "CallExpression" && requireFactories.has(callee.callee.name);
      const call = member(callee) === "call" && requireNames.has(callee.object?.name);
      if (requireNames.has(name) || name === "getBuiltinModule" || builtinNames.has(name) || factory || call) {
        return literal(node.arguments[call ? 1 : 0])?.replace(/^node:/, "");
      }
    }
    if (node?.type === "MemberExpression") {
      const base = kind(node.object), property = member(node);
      if (base === "globalThis") return bindings.get(property);
      if (CLIENTS[base]?.has(property)) return base + "#" + property;
      if (base?.includes("#") && (property === "call" || property === "apply")) return base;
    }
  };
  for (const node of list) {
    if (node.type !== "ImportDeclaration") continue;
    const specifier = literal(node.source), module = specifier?.replace(/^node:/, "");
    for (const spec of node.specifiers) {
      const imported = spec.imported?.name ?? spec.imported?.value;
      if (module === "module" && imported === "createRequire") requireFactories.add(spec.local.name);
      if (CLIENTS[module]) bindings.set(spec.local.name,
        imported && imported !== "default" ? module + "#" + imported : module);
    }
  }
  let changed;
  do {
    changed = false;
    const bind = (name, value) => {
      if (value && !bindings.has(name)) { bindings.set(name, value); changed = true; }
    };
    for (const node of list) {
      if (node.type !== "VariableDeclarator" || !node.init) continue;
      if (node.init.type === "CallExpression" && requireFactories.has(node.init.callee.name)) {
        requireNames.add(node.id.name);
      }
      const value = kind(node.init);
      if (node.id.type === "Identifier") bind(node.id.name, value);
      if (node.id.type === "ObjectPattern") for (const prop of node.id.properties) {
        const name = prop.key?.name ?? literal(prop.key);
        if (node.init.type === "Identifier" && node.init.name === "process" && name === "getBuiltinModule") builtinNames.add(prop.value.name);
        if (name === "default" && CLIENTS[value]) bind(prop.value.name, value);
        else if (CLIENTS[value]?.has(name)) bind(prop.value.name, value + "#" + name);
      }
    }
  } while (changed);
  const hits = [], seen = new Set();
  const calledMembers = new Set(list.filter(n => ["CallExpression", "NewExpression"].includes(n.type))
    .map(n => unwrap(n.callee)));
  const add = node => {
    if (seen.has(node.start)) return;
    seen.add(node.start);
    hits.push({ line: node.loc.start.line, text: normalizeNode(node, content) });
  };
  for (const node of list) {
    if (node.type === "AssignmentExpression" && node.left.type === "ObjectPattern" && kind(node.right) === "Bun"
      && node.left.properties.some(p => (p.key?.name ?? literal(p.key)) === "connect")) add(node);
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)
      && CLIENTS[literal(node.source)?.replace(/^node:/, "")]) add(node);
    if (node.type === "ImportExpression" && CLIENTS[kind(node)]) add(node);
    if (node.type === "CallExpression" && CLIENTS[kind(node)] && kind(node) !== "Bun") add(node);
    if (["CallExpression", "NewExpression"].includes(node.type)) {
      const value = kind(node.callee);
      const [base, property] = value?.split("#") ?? [];
      if (CLIENTS[base]?.has(property)) add(node);
    }
    if (node.type === "MemberExpression" && kind(node) === "Bun#connect") {
      if (!calledMembers.has(node)) add(node);
    }
    if (node.type === "VariableDeclarator" && node.id.type === "ObjectPattern" && kind(node.init) === "Bun"
      && node.id.properties.some(p => (p.key?.name ?? literal(p.key)) === "connect")) add(node);
    if (node.type === "Property" && (node.key.name ?? literal(node.key)) === "checkServerIdentity") add(node);
    if (node.type === "AssignmentExpression" && member(node.left) === "checkServerIdentity") add(node);
  }
  return hits;
}

export function isScannedSourceFile(file) {
  return /\.(?:[cm]?js|jsx|tsx?)$/.test(file) &&
    !/\.(?:test|spec)\.[^/]+$/.test(file) && !file.endsWith(".d.ts") &&
    !file.split("/").some(segment => [
      "test", "tests", "__tests__", "fixtures", "__fixtures__", "test-support", "test-fixtures",
      "node_modules", ".git",
    ].includes(segment));
}

export function evaluateShippedSource(scan, allowlist) {
  const offenders = [];
  const counts = new Map(allowlist.map(entry => [entry, 0]));
  const calls = new Map(allowlist.map(entry => [entry,
    normalizeNode(parse(entry.call, { ecmaVersion: "latest", sourceType: "module" }), entry.call)]));
  for (const item of scan) {
    for (const hit of findRawTlsClients(item.content, item.path)) {
      const entry = allowlist.find(candidate => candidate.file === item.path && calls.get(candidate) === hit.text);
      if (entry) counts.set(entry, counts.get(entry) + 1);
      else offenders.push(`${item.path}:${hit.line}  ${hit.text}`);
    }
  }
  const stale = [];
  for (const entry of allowlist) {
    if (!scan.some(item => item.path === entry.file)) stale.push(`${entry.file}: no longer scanned`);
    if (counts.get(entry) !== entry.count) {
      stale.push(`${entry.file}: expected ${entry.call} x${entry.count}, found x${counts.get(entry)}`);
    }
    if (!entry.reason?.trim() || !Number.isInteger(entry.count) || entry.count < 1) {
      stale.push(`${entry.file}: requires positive count and reviewed host provenance`);
    }
  }
  return { offenders, stale };
}
