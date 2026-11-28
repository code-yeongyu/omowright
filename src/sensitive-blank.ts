// #380: pixels are not text. A page seals a subtree with data-sensitive (any value except the
// exact string "false", the marker #379 introduced); the text surfaces replace it with a
// placeholder, and here the pixel surfaces do their part: before every capture the page gets a
// temporary style element that renders each marked element as an opaque black block of its own
// box — its text, input values, children, images and pseudo-element content all invisible —
// the capture runs, and the style is removed in a finally so the page is exactly restored even
// when the capture fails. The style is injected into the document, every open shadow root and
// every same-origin iframe document, because a light-DOM stylesheet reaches none of those and
// a marked host seals its shadow content. A capture on a page without a marked element mutates
// nothing. Two limits are stated in TOOLS.md: cross-origin frame content is unreachable from
// the parent page, and an author `!important` inline style on a marked element outranks any
// stylesheet, so a page can defeat the blanking by fighting its own marker. The BSK daemon
// capture is the one path that does not go through this: its screenshot tool is a
// cooperation-exempt read while evaluate is a gated action needing the single-use context of
// the latest cooperate sync, so blanking there cannot run without invalidating the caller's
// own context (TOOLS.md carries that caveat).

export const SENSITIVE_BLANK_STYLE_ID = "omowright-sensitive-blank";

const SENSITIVE_BLANK_CSS = [
  `[data-sensitive]:not([data-sensitive="false"]) {`,
  `  color: transparent !important;`,
  `  -webkit-text-fill-color: transparent !important;`,
  `  caret-color: transparent !important;`,
  `  text-shadow: none !important;`,
  `  background: #000 !important;`,
  `  border-color: #000 !important;`,
  `  outline-color: #000 !important;`,
  `  box-shadow: none !important;`,
  `  filter: none !important;`,
  `  opacity: 1 !important;`,
  `  mix-blend-mode: normal !important;`,
  `}`,
  `[data-sensitive]:not([data-sensitive="false"]) * {`,
  `  visibility: hidden !important;`,
  `}`,
  `[data-sensitive]:not([data-sensitive="false"])::before,`,
  `[data-sensitive]:not([data-sensitive="false"])::after {`,
  `  visibility: hidden !important;`,
  `}`,
].join("\n");

// The style element carries a reference count so concurrent captures on one page share one
// blanking: the first inject creates it, later injects raise the count, and a removal only
// takes the element off at zero, so no capture in flight can lose the blanking to another
// capture's cleanup.
const SENSITIVE_BLANK_COUNT = "data-omowright-count";

const SENSITIVE_BLANK_MARKER = `[data-sensitive]:not([data-sensitive="false"])`;

// Collects every root a light-DOM stylesheet cannot reach: the document, open shadow roots
// and same-origin iframe documents, recursively; cross-origin frames are unreachable and stay
// unstyled (TOOLS.md).
const SENSITIVE_BLANK_ROOT_WALK = `
  const roots = [];
  const visit = (root) => {
    roots.push(root);
    const elements = root.querySelectorAll("*");
    for (let i = 0; i < elements.length; i += 1) {
      const element = elements[i];
      if (element.shadowRoot) visit(element.shadowRoot);
      if (element.tagName === "IFRAME" || element.tagName === "FRAME") {
        let inner = null;
        try { inner = element.contentDocument; } catch (error) { inner = null; }
        if (inner) visit(inner);
      }
    }
  };
  visit(document);`;

export function sensitiveBlankInjectExpression(): string {
  return `(() => {${SENSITIVE_BLANK_ROOT_WALK}
  const id = ${JSON.stringify(SENSITIVE_BLANK_STYLE_ID)};
  const css = ${JSON.stringify(SENSITIVE_BLANK_CSS)};
  if (!roots.some((root) => root.querySelector(${JSON.stringify(SENSITIVE_BLANK_MARKER)}))) return false;
  for (const root of roots) {
    const existing = root.querySelector("#" + id);
    if (existing) {
      const count = Number(existing.getAttribute(${JSON.stringify(SENSITIVE_BLANK_COUNT)}) || "0") + 1;
      existing.setAttribute(${JSON.stringify(SENSITIVE_BLANK_COUNT)}, String(count));
      continue;
    }
    const owner = root.nodeType === 9 ? root : (root.host && root.host.ownerDocument) || document;
    const style = owner.createElement("style");
    style.id = id;
    style.setAttribute(${JSON.stringify(SENSITIVE_BLANK_COUNT)}, "1");
    style.textContent = css;
    (root.head || root.documentElement || root).appendChild(style);
  }
  return true;
})()`;
}

export function sensitiveBlankRemoveExpression(): string {
  return `(() => {${SENSITIVE_BLANK_ROOT_WALK}
  const id = ${JSON.stringify(SENSITIVE_BLANK_STYLE_ID)};
  let removed = 0;
  for (const root of roots) {
    const existing = root.querySelector("#" + id);
    if (!existing) continue;
    const count = Number(existing.getAttribute(${JSON.stringify(SENSITIVE_BLANK_COUNT)}) || "0") - 1;
    if (count > 0) {
      existing.setAttribute(${JSON.stringify(SENSITIVE_BLANK_COUNT)}, String(count));
      continue;
    }
    existing.remove();
    removed += 1;
  }
  return removed;
})()`;
}

export type SensitiveBlankEvaluate = (expression: string) => Promise<unknown>;

// Runs capture() with every reachable data-sensitive element blanked, restoring the page
// exactly afterwards — also when the capture throws. A page with no marked element pays one
// read-only evaluate and no mutation. Callers pass their own evaluate so the helper owns no
// transport; core.ts routes every Page.captureScreenshot through it, which is the single
// place a CDP capture exists.
export async function withSensitiveBlanking<T>(
  evaluate: SensitiveBlankEvaluate,
  capture: () => Promise<T>,
): Promise<T> {
  const blanked = await evaluate(sensitiveBlankInjectExpression());
  if (blanked !== true) return await capture();
  try {
    return await capture();
  } finally {
    // A removal that fails means the page — and the style with it — is already gone; this is
    // the same dead-target cleanup readCapture performs for screenshot_release.
    await evaluate(sensitiveBlankRemoveExpression()).catch(() => {});
  }
}
