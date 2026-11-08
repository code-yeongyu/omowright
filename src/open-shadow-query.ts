// Self-contained because locator queries serialize this into the frame's page or isolated world.
// Order matches the CSS locator traversal: the scope's own matches, then each open shadow root below
// it, depth first in document order, nested roots included. Closed roots stay excluded.
// A selector with combinators also matches across open shadow boundaries (a host is the parent of its
// shadow root's top-level children), but matching never climbs above the scope, and an element scope
// anchors the selector to itself: `:scope` and leading compounds resolve inside it, not against its ancestors.
interface SelectorPart {
  selector: string;
  combinator: string;
}

// A node's root: a ShadowRoot carries its host, a Document or detached subtree does not.
interface HostScope extends Node {
  readonly host?: Element;
}

export function queryOpenShadowAll(root: Document | Element, selector: string): Element[] {
  // Throws the TypeError reading `reading` off a missing entry always raised; kept inside so the source stays serializable.
  const defined = <T>(value: T | undefined, reading: string): T => {
    if (value === undefined) throw new TypeError(`Cannot read properties of undefined (reading '${reading}')`);
    return value;
  };
  const groups: SelectorPart[][] = [];
  let parts: SelectorPart[] = [],
    token = "",
    depth = 0,
    quote = "",
    escaped = false,
    combinator = " ";
  const flush = () => {
    if (!token.trim()) return;
    parts.push({ selector: token.trim(), combinator });
    token = "";
    combinator = " ";
  };
  for (const char of selector) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      token += char;
      escaped = true;
      continue;
    }
    if (quote) {
      token += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      token += char;
      continue;
    }
    if (char === "[" || char === "(") depth++;
    if (char === "]" || char === ")") depth--;
    if (!depth && (char === "," || char === ">" || char === "+" || char === "~" || /\s/.test(char))) {
      flush();
      if (char === ",") {
        groups.push(parts);
        parts = [];
        combinator = " ";
      } else if (!/\s/.test(char)) combinator = char;
    } else token += char;
  }
  flush();
  groups.push(parts);
  // One compound per group matches the same nodes in every tree scope, so each scope stays a native query.
  const simple = groups.every(
    (group) => group.length === 1 && !/^:scope\b/.test(defined(group[0], "selector").selector),
  );
  let rootSelector = selector;
  if (!simple && root instanceof Element) {
    const scopedSelectors: string[] = [];
    for (const group of groups) {
      const first = defined(group[0], "selector").selector;
      const rest = group
        .slice(1)
        .map((part) => `${part.combinator} ${part.selector}`)
        .join(" ");
      const scoped = /^:scope\b/.test(first);
      scopedSelectors.push(`${scoped ? "" : ":scope "}${first} ${rest}`);
      if (!scoped && group.length > 1 && root.matches(first)) scopedSelectors.push(`:scope ${rest}`);
    }
    rootSelector = scopedSelectors.join(", ");
  }
  const rootElements = root.querySelectorAll("*");
  const rootMatches = rootSelector === "*" ? rootElements : root.querySelectorAll(rootSelector);
  // A stack of open roots, popped depth first; the scope's own shadow root comes first.
  const pending: ShadowRoot[] = [];
  for (let index = rootElements.length - 1; index >= 0; index--) {
    const element = defined(rootElements[index], "shadowRoot");
    if (element.shadowRoot) pending.push(element.shadowRoot);
  }
  if (root instanceof Element && root.shadowRoot) pending.push(root.shadowRoot);
  if (pending.length === 0) return Array.from(rootMatches);
  const results: Element[] = [];
  // Index loops, never spread: a scope can hold more nodes than the engine's argument limit.
  for (let index = 0; index < rootMatches.length; index++) results.push(defined(rootMatches[index], "index"));
  const rootOf = (node: Node): HostScope => node.getRootNode();
  const parent = (node: Element) => node.parentElement ?? rootOf(node).host ?? null;
  const scope = root instanceof Element ? root : root.documentElement;
  const matches = (node: Element, group: SelectorPart[], index: number): boolean => {
    if (node === root && index > 0) return false;
    const part = defined(group[index], "selector");
    const scoped = /^:scope\b/.test(part.selector);
    const compound = scoped ? part.selector.replace(/^:scope\b/, "*") : part.selector;
    if (scoped && node !== scope) return false;
    if (!node.matches(compound)) return false;
    if (index === 0) return true;
    if (part.combinator === ">") {
      const ancestor = parent(node);
      return !!ancestor && matches(ancestor, group, index - 1);
    }
    if (part.combinator === "+")
      return !!node.previousElementSibling && matches(node.previousElementSibling, group, index - 1);
    if (part.combinator === "~") {
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (matches(sibling, group, index - 1)) return true;
      }
      return false;
    }
    for (let ancestor = parent(node); ancestor; ancestor = parent(ancestor)) {
      if (matches(ancestor, group, index - 1)) return true;
      if (ancestor === root) break;
    }
    return false;
  };
  while (pending.length) {
    const shadow = defined(pending.pop(), "querySelectorAll");
    const elements = shadow.querySelectorAll("*");
    for (let index = elements.length - 1; index >= 0; index--) {
      const element = defined(elements[index], "shadowRoot");
      if (element.shadowRoot) pending.push(element.shadowRoot);
    }
    if (simple) {
      const found = selector === "*" ? elements : shadow.querySelectorAll(selector);
      for (let index = 0; index < found.length; index++) results.push(defined(found[index], "index"));
      continue;
    }
    for (let index = 0; index < elements.length; index++) {
      const node = defined(elements[index], "index");
      if (groups.some((group) => matches(node, group, group.length - 1))) results.push(node);
    }
  }
  return results;
}
