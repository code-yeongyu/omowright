// node:test reaches `mock` three more ways than its `mock` export: through the test function
// (`test.mock === it.mock === mock`), through the default export (which is `test`), and through the
// TestContext each test and hook callback receives as its first parameter (`t.mock`).
import { child, field, identifier, type Node, nodes, propertyName, unwrap } from "./ast.ts";

// node:test exports that are the test function and so carry `mock` themselves.
export const NODE_TEST_RUNNERS: ReadonlySet<string> = new Set(["test", "it"]);
// node:test hooks: their callbacks receive a TestContext too.
export const NODE_TEST_HOOKS: ReadonlySet<string> = new Set(["before", "after", "beforeEach", "afterEach"]);
const MODIFIERS = new Set(["only", "skip", "todo"]);
const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]);

// Whether a callee is a node:test test or hook: a runner bound to node:test (`test`, a default import,
// `require("node:test")`), a hook imported from it, `<namespace>.test`, or any of them with .only/.skip/.todo.
export const givesContext = (
  initial: Node,
  isNodeTest: (node: Node) => boolean,
  hooks: ReadonlySet<string>,
): boolean => {
  const node = unwrap(initial);
  if (node.type === "Identifier") return isNodeTest(node) || hooks.has(String(node["name"]));
  if (node.type !== "MemberExpression") return false;
  const property = propertyName(node) ?? "";
  const object = field(node, "object");
  if (MODIFIERS.has(property)) return givesContext(object, isNodeTest, hooks);
  return (NODE_TEST_RUNNERS.has(property) || NODE_TEST_HOOKS.has(property)) && isNodeTest(object);
};

// The nearest function that declares `name` as a parameter, and that parameter's position.
const parameterBinding = (node: Node, name: string): { readonly fn: Node; readonly index: number } | undefined => {
  for (let current = child(node, "parent"); current !== undefined; current = child(current, "parent")) {
    if (!FUNCTIONS.has(current.type)) continue;
    const index = nodes(current, "params").findIndex((param) => identifier(param) === name);
    if (index !== -1) return { fn: current, index };
  }
  return undefined;
};

// `t.mock.module(...)` where `t` is the first parameter of a callback passed straight to a node:test
// test or hook. A `t` re-declared inside that callback is not tracked.
export const isContextMockModule = (call: Node, isRunner: (callee: Node) => boolean): boolean => {
  const callee = unwrap(field(call, "callee"));
  const mock = unwrap(field(callee, "object"));
  if (propertyName(callee) !== "module" || mock.type !== "MemberExpression" || propertyName(mock) !== "mock")
    return false;
  const name = identifier(field(mock, "object"));
  const binding = name === null ? undefined : parameterBinding(call, name);
  if (binding === undefined || binding.index !== 0) return false;
  const runner = child(binding.fn, "parent");
  return (
    runner?.type === "CallExpression" &&
    nodes(runner, "arguments").includes(binding.fn) &&
    isRunner(field(runner, "callee"))
  );
};
