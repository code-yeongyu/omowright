// Ported from interfere-inc/landmines 0.1.0 (MIT, Copyright (c) 2026 Interfere, Inc.),
// packages/landmines/src/rules/no-flake-masking.ts. Detection is unchanged; the upstream per-file
// allowlist option is dropped because this repo pins per-file counts in the lint ratchet.
type Node = {
  readonly type: string;
  readonly [key: string]: unknown;
};

type RuleContext = {
  readonly report: (problem: { readonly node: Node; readonly messageId: string }) => void;
};

const testFunctions = new Set(["test", "it", "describe", "suite"]);
const configTimeouts = new Set(["testTimeout", "hookTimeout"]);
const testTimeouts = new Set(["timeout"]);

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string";

const child = (node: Node, key: string): Node | undefined => {
  const value = node[key];
  return isNode(value) ? value : undefined;
};

// A child the node type always has (a call's callee, a member's object): its absence is a parser bug.
const field = (node: Node, key: string): Node => {
  const value = child(node, key);
  if (value === undefined) throw new Error(`${node.type} has no ${key}`);
  return value;
};

const elements = (node: Node, key: string): readonly unknown[] => {
  const value = node[key];
  return Array.isArray(value) ? value : [];
};

const argumentsOf = (node: Node): (Node | undefined)[] => {
  return elements(node, "arguments").map((value) => (isNode(value) ? value : undefined));
};

const propertiesOf = (node: Node): readonly Node[] => {
  return elements(node, "properties").filter(isNode);
};

const keyName = (property: Node): string | null => {
  if (property.type !== "Property" || property["computed"] === true) return null;

  const key = child(property, "key");
  if (key?.type === "Identifier") return String(key["name"]);
  return key?.type === "Literal" ? String(key["value"]) : null;
};

const rootName = (initial: Node): string | null => {
  let node = initial;

  while (node.type === "MemberExpression" || node.type === "CallExpression") {
    node = field(node, node.type === "MemberExpression" ? "object" : "callee");
  }

  return node.type === "Identifier" ? String(node["name"]) : null;
};

const memberName = (node: Node): string | null =>
  node.type === "MemberExpression" && node["computed"] !== true && child(node, "property")?.type === "Identifier"
    ? String(child(node, "property")?.["name"])
    : null;

const testCall = (node: Node): boolean => {
  const callee = field(node, "callee");
  const name = rootName(callee);
  const member = memberName(callee);

  return (
    name !== null &&
    testFunctions.has(name) &&
    member !== "each" &&
    member !== "for" &&
    member !== "extend" &&
    member !== "scoped" &&
    member !== "override"
  );
};

const configCall = (node: Node): boolean => {
  const callee = child(node, "callee");
  return (
    callee?.type === "MemberExpression" &&
    child(callee, "object")?.type === "Identifier" &&
    child(callee, "object")?.["name"] === "vi" &&
    memberName(callee) === "setConfig"
  );
};

const noFlakeMasking = {
  meta: {
    type: "problem" as const,
    docs: {
      description:
        "Fix flaky tests at their cause instead of retrying them or raising their timeouts (landmines no-flake-masking).",
    },
    messages: {
      retry:
        "Do not retry tests. A test that passes on rerun is a flake: wait on the event it depends on and file the failure under the flaky-test tracker.",
      timeout:
        "Do not raise a test's timeout. Wait on the event the test depends on, or move slow shared setup into a beforeAll hook.",
    },
  },
  create: (context: RuleContext) => {
    const inspect = (node: Node | undefined, keys: ReadonlySet<string>): void => {
      if (node?.type !== "ObjectExpression") return;

      for (const property of propertiesOf(node)) {
        const key = keyName(property);

        if (key === "retry") {
          context.report({ node: property, messageId: "retry" });
        } else if (key !== null && keys.has(key)) {
          context.report({ node: property, messageId: "timeout" });
        }
      }
    };

    return {
      CallExpression: (node: Node) => {
        if (configCall(node)) {
          inspect(argumentsOf(node)[0], configTimeouts);

          return;
        }

        if (!testCall(node)) return;

        const [, second, third] = argumentsOf(node);

        inspect(second, testTimeouts);

        inspect(third, testTimeouts);

        if (
          third !== undefined &&
          second?.type !== "ObjectExpression" &&
          third.type !== "ObjectExpression" &&
          third.type !== "ArrowFunctionExpression" &&
          third.type !== "FunctionExpression"
        ) {
          context.report({ node: third, messageId: "timeout" });
        }
      },
      Property: (node: Node) => {
        const value = child(node, "value");

        if (keyName(node) === "test" && value?.type === "ObjectExpression") {
          for (const property of propertiesOf(value)) {
            if (keyName(property) === "retry") {
              context.report({ node: property, messageId: "retry" });
            }
          }
        }
      },
    };
  },
};

export default noFlakeMasking;
