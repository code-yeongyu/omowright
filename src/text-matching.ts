// Self-contained: locator queries serialize this factory into the document's world.
// Playwright's selectorUtils/createTextMatcher and roleUtils define the matching and naming rules.

export type TextMatcher = RegExp | { exact: string } | { contains: string };

// Members the matcher reads that only some node kinds carry; any Node or Element satisfies these shapes.
interface MatchNode extends Node {
  readonly shadowRoot?: ShadowRoot | null;
}
interface MatchElement extends Element {
  readonly labels?: NodeListOf<HTMLLabelElement> | null;
}
interface SlotChild extends Node {
  readonly assignedSlot?: HTMLSlotElement | null;
}
interface IdScope extends Node {
  readonly getElementById?: (elementId: string) => Element | null;
}

export function createTextMatching(
  isHidden: (element: Element) => boolean = () => false,
  getRole: (element: Element) => string = () => "",
  includeHidden = false,
) {
  // Predicates live inside the factory so the serialized source stays self-contained.
  const isElement = (node: Node): node is Element => node.nodeType === 1;
  const isInput = (node: Node): node is HTMLInputElement => node.nodeName === "INPUT";
  const isSlot = (node: Node): node is HTMLSlotElement => node.nodeName === "SLOT";
  const isFormField = (node: Node): node is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement =>
    node.nodeName === "INPUT" || node.nodeName === "TEXTAREA" || node.nodeName === "SELECT";
  // Throws the TypeError reading getComputedStyle off a null defaultView always raised.
  const viewOf = (document: Document) => {
    const view = document.defaultView;
    if (view === null) throw new TypeError("Cannot read properties of null (reading 'getComputedStyle')");
    return view;
  };
  const scopeOf = (node: Node): IdScope => node.getRootNode();
  const buttonDefaults: Record<string, string> = { submit: "Submit", reset: "Reset" };
  const nativeCaptions: Record<string, string> = {
    FIELDSET: "LEGEND",
    FIGURE: "FIGCAPTION",
    TABLE: "CAPTION",
    SVG: "title",
  };
  const normalize = (value: unknown) =>
    String(value ?? "")
      .replace(/[\u200b\u00ad]/g, "")
      .trim()
      .replace(/\s+/g, " ");
  const matches = (value: string, matcher: TextMatcher) => {
    if (matcher instanceof RegExp) {
      matcher.lastIndex = 0;
      return matcher.test(value);
    }
    const text = normalize(value);
    return "exact" in matcher
      ? text === normalize(matcher.exact)
      : text.toLowerCase().includes(normalize(matcher.contains).toLowerCase());
  };
  const skipped = (node: Node) =>
    ["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(node.nodeName) || !!node.ownerDocument?.head?.contains(node);
  const textCache = new Map<Node, string>();
  const text = (node: MatchNode): string => {
    const cached = textCache.get(node);
    if (cached !== undefined) return cached;
    let value = "";
    if (!skipped(node)) {
      if (isInput(node) && ["submit", "button", "reset"].includes(node.type)) value = node.value;
      else {
        for (const child of node.childNodes) {
          if (child.nodeType === 3) value += child.nodeValue;
          else if (isElement(child)) value += text(child);
        }
        if (node.shadowRoot) value += text(node.shadowRoot);
      }
    }
    textCache.set(node, value);
    return value;
  };
  const matchesText = (node: MatchNode, matcher: TextMatcher) => !skipped(node) && matches(text(node), matcher);
  const labelledBy = (node: Element) => {
    const refs =
      node.ariaLabelledByElements ??
      (node.getAttribute("aria-labelledby") ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => scopeOf(node).getElementById?.(id))
        .filter(Boolean);
    return refs.length ? [...new Set(refs)] : null;
  };
  const labels = (node: MatchElement) => {
    const refs = labelledBy(node);
    if (refs) return refs.map(text);
    const ariaLabel = node.getAttribute("aria-label");
    if (ariaLabel?.trim()) return [ariaLabel];
    return Array.from(node.labels ?? [], text);
  };
  const contentRoles = new Set([
    "button",
    "cell",
    "checkbox",
    "columnheader",
    "gridcell",
    "heading",
    "link",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "radio",
    "row",
    "rowheader",
    "switch",
    "tab",
    "tooltip",
    "treeitem",
  ]);
  const prohibitedRoles = new Set([
    "caption",
    "code",
    "definition",
    "deletion",
    "emphasis",
    "generic",
    "insertion",
    "mark",
    "paragraph",
    "presentation",
    "strong",
    "subscript",
    "suggestion",
    "superscript",
    "term",
    "time",
  ]);
  const accessibleName = (node: Element) => {
    const visited = new Set<Element>();
    const alternative = (
      element: MatchElement,
      referenced = false,
      hiddenReference = false,
      descendant = false,
      inLabelledBy = false,
    ): string => {
      if (visited.has(element) || skipped(element)) return "";
      if (!includeHidden && !hiddenReference && isHidden(element)) return "";
      visited.add(element);
      const refs = labelledBy(element);
      if (refs && !inLabelledBy) {
        const value = refs.map((ref) => alternative(ref, true, isHidden(ref), false, true)).join(" ");
        if (value) return value;
      }
      const ariaLabel = element.getAttribute("aria-label");
      if (ariaLabel?.trim()) return ariaLabel;
      const tag = element.nodeName;
      if (isInput(element) && ["button", "submit", "reset"].includes(element.type))
        return element.value || buttonDefaults[element.type] || element.getAttribute("title") || "";
      if (element.labels?.length && !inLabelledBy)
        return Array.from(element.labels, (label) => alternative(label, true, isHidden(label))).join(" ");
      if (tag === "IMG" || tag === "AREA" || (isInput(element) && element.type === "image"))
        return element.getAttribute("alt") || element.getAttribute("title") || (tag === "INPUT" ? "Submit" : "");
      if (isFormField(element)) {
        if (descendant && ["INPUT", "TEXTAREA"].includes(tag)) return element.value;
        if (tag === "INPUT" && element.type === "file") return "Choose File";
        const usePlaceholder =
          tag === "TEXTAREA" || ["text", "password", "number", "search", "tel", "email", "url"].includes(element.type);
        return element.getAttribute("title") || (usePlaceholder ? element.getAttribute("placeholder") : "") || "";
      }
      const nativeChild = nativeCaptions[tag];
      const child = nativeChild && Array.from(element.children).find((child) => child.nodeName === nativeChild);
      if (child) return alternative(child, true, isHidden(child));
      if (referenced || descendant || tag === "SUMMARY" || contentRoles.has(getRole(element))) {
        let value = "";
        const assigned = isSlot(element) ? element.assignedNodes() : [];
        const children: readonly SlotChild[] = assigned.length
          ? assigned
          : [...element.childNodes, ...(element.shadowRoot?.childNodes ?? [])];
        for (const child of children) {
          if (!assigned.length && child.assignedSlot) continue;
          if (child.nodeType === 3) value += child.nodeValue;
          else if (isElement(child)) {
            const token = alternative(child, referenced, hiddenReference, true, inLabelledBy);
            const display = viewOf(child.ownerDocument).getComputedStyle(child).display;
            value += display !== "inline" || child.nodeName === "BR" ? ` ${token} ` : token;
          }
        }
        if (normalize(value)) return value;
      }
      return element.getAttribute("title") || "";
    };
    return prohibitedRoles.has(getRole(node)) ? "" : normalize(alternative(node));
  };
  return { normalize, matches, skipped, text, matchesText, labels, accessibleName };
}
