// Self-contained because role locator queries serialize this into the frame's isolated world.
// Port of Playwright's isElementHiddenForAria (packages/injected/src/roleUtils.ts): getByRole skips the elements it
// reports unless includeHidden is set. `cache` memoizes the ancestor walk for one query.
export function isElementHiddenForAria(element: Element, cache: Map<Node, boolean>): boolean {
  // Inline type guards: this function is serialized, so it can reference nothing outside itself.
  const isElement = (node: Node): node is Element => node.nodeType === 1;
  const isFragment = (node: Node | null): node is DocumentFragment & { host?: Element } => node?.nodeType === 11;
  const getStyle = (node: Element) => node.ownerDocument?.defaultView?.getComputedStyle(node);
  const isVisibleTextNode = (text: Node) => {
    // Only text nodes reach here, and a text node always has an owner document.
    const ownerDocument = text.ownerDocument;
    if (ownerDocument === null) throw new TypeError("Cannot read properties of null (reading 'createRange')");
    const range = ownerDocument.createRange();
    range.selectNode(text);
    const rect = range.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const belongsToDisplayNoneOrAriaHiddenOrNonSlotted = (node: Element): boolean => {
    let hidden = cache.get(node);
    if (hidden === undefined) {
      // Light-DOM children of a shadow host render only when a slot takes them.
      hidden = !!(node.parentElement && node.parentElement.shadowRoot && !node.assignedSlot);
      if (!hidden) {
        const style = getStyle(node);
        hidden = !style || style.display === "none" || node.getAttribute("aria-hidden")?.toLowerCase() === "true";
      }
      if (!hidden) {
        const parentNode = node.parentNode;
        const parent = node.parentElement ?? (isFragment(parentNode) ? parentNode.host : null);
        if (parent) hidden = belongsToDisplayNoneOrAriaHiddenOrNonSlotted(parent);
      }
      cache.set(node, hidden);
    }
    return hidden;
  };
  // A form's named controls can shadow its tagName.
  const tagName = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "FORM";
  if (["STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE"].includes(tagName)) return true;
  const style = getStyle(element);
  const isSlot = element.nodeName === "SLOT";
  if (style?.display === "contents" && !isSlot) {
    // display:contents is not rendered itself, but its child nodes are.
    for (let child = element.firstChild; child; child = child.nextSibling) {
      if (isElement(child) && !isElementHiddenForAria(child, cache)) return false;
      if (child.nodeType === 3 && isVisibleTextNode(child)) return false;
    }
    return true;
  }
  // <option> inside <select> and <slot> ignore visibility and content-visibility; checkVisibility() covers
  // content-visibility and closed <details> up the flat tree.
  const isOptionInsideSelect = element.nodeName === "OPTION" && !!element.closest("select");
  if (!isOptionInsideSelect && !isSlot && style && (!element.checkVisibility() || style.visibility !== "visible"))
    return true;
  return belongsToDisplayNoneOrAriaHiddenOrNonSlotted(element);
}
