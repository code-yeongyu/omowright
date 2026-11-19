// ESTree helpers for the module-mock rule and its node:test context resolution.
export type Node = {
  readonly type: string;
  readonly [key: string]: unknown;
};

export const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string";

export const child = (node: Node, key: string): Node | undefined => {
  const value = node[key];
  return isNode(value) ? value : undefined;
};

// A child the node type always has (a call's callee, a member's object): its absence is a parser bug.
export const field = (node: Node, key: string): Node => {
  const value = child(node, key);
  if (value === undefined) throw new Error(`${node.type} has no ${key}`);
  return value;
};

export const nodes = (node: Node, key: string): readonly Node[] => {
  const value = node[key];
  const values: readonly unknown[] = Array.isArray(value) ? value : [];
  return values.filter(isNode);
};

export const unwrap = (initial: Node): Node => {
  let node = initial;
  while (
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSTypeAssertion" ||
    node.type === "ParenthesizedExpression" ||
    node.type === "AwaitExpression"
  ) {
    node = field(node, node.type === "AwaitExpression" ? "argument" : "expression");
  }
  return node;
};

export const nameOf = (node: Node | undefined): string | null => {
  if (node?.type === "Identifier") return String(node["name"]);
  return node?.type === "Literal" && typeof node["value"] === "string" ? node["value"] : null;
};

export const propertyName = (member: Node): string | null => {
  const property = child(member, "property");
  if (member["computed"] !== true) return property?.type === "Identifier" ? String(property["name"]) : null;
  return property?.type === "Literal" ? nameOf(property) : null;
};

export const identifier = (node: Node | undefined): string | null => {
  const target = node === undefined ? undefined : unwrap(node);
  return target?.type === "Identifier" ? String(target["name"]) : null;
};
