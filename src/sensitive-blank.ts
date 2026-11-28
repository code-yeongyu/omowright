// #380: pixels are not text. A page seals a subtree with data-sensitive (any value except the
// exact string "false", the marker #379 introduced); the text surfaces replace it with a
// placeholder, and here the pixel surfaces do their part: before every capture the page gets a
// temporary style element that renders each marked element as an opaque black block of its own
// box, the capture runs, and the style is removed in a finally so the page is exactly restored
// even when the capture fails. A marked element gets a black background and filter:
// brightness(0), which turns every pixel it paints black: its text, input values, children,
// pseudo-element content, the content of a replaced element (img, canvas, video, a frame of any
// origin) and the rendered shadow tree of a marked host (open or closed). Descendants are also
// hidden so nothing overflowing the box shows. The style is injected into the document, every
// open shadow root and every same-origin iframe document, because a light-DOM stylesheet
// reaches none of those; a shadow root's copy blanks content under a marked host through
// :host(). A capture on a page without a marked element mutates nothing. Two limits are stated
// in TOOLS.md: a marker inside a cross-origin frame's own document is unreachable from the
// parent page (marking the iframe itself does blank it), and an author `!important` inline
// style on a marked element outranks any stylesheet, so a page can defeat the blanking by
// fighting its own marker. The BSK daemon capture is the one path that does not go through
// this: its screenshot tool is a cooperation-exempt read while evaluate is a gated action
// needing the single-use context of the latest cooperate sync, so blanking there cannot run
// without invalidating the caller's own context (TOOLS.md carries that caveat).

export const SENSITIVE_BLANK_STYLE_ID = "omowright-sensitive-blank";

const SENSITIVE_BLANK_MARKER = `[data-sensitive]:not([data-sensitive="false"])`;

const SENSITIVE_BLANK_CSS = [
  `${SENSITIVE_BLANK_MARKER} {`,
  `  color: transparent !important;`,
  `  -webkit-text-fill-color: transparent !important;`,
  `  caret-color: transparent !important;`,
  `  text-shadow: none !important;`,
  `  background: #000 !important;`,
  `  border-color: #000 !important;`,
  `  outline-color: #000 !important;`,
  `  box-shadow: none !important;`,
  `  filter: brightness(0) !important;`,
  `  opacity: 1 !important;`,
  `  mix-blend-mode: normal !important;`,
  `}`,
  `${SENSITIVE_BLANK_MARKER} *,`,
  `${SENSITIVE_BLANK_MARKER}::before,`,
  `${SENSITIVE_BLANK_MARKER}::after {`,
  `  visibility: hidden !important;`,
  `}`,
  `:host(${SENSITIVE_BLANK_MARKER}) * {`,
  `  visibility: hidden !important;`,
  `}`,
].join("\n");

// One reference count for the whole page, kept on the top document's style element, so
// overlapping holders share one blanking: every acquire ensures the style in every root that
// exists at that moment (roots appearing between captures included) and raises the count, and
// a release removes the style from every root only when the count reaches zero.
const SENSITIVE_BLANK_COUNT = "data-omowright-count";

// Collects every root a light-DOM stylesheet cannot reach: the document, open shadow roots
// and same-origin iframe documents, recursively; cross-origin frame documents are unreachable
// and stay unstyled (TOOLS.md).
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

// capture: a screenshot's hold, skipped on a page with no marked element.
// recording: a video's hold, taken even before any marker exists, since one may appear later.
// refresh: re-ensure the style in roots that appeared during a recording (or after it
//   navigated) without taking another hold; the recording's own hold is restored to at least 1.
export type SensitiveBlankMode = "capture" | "recording" | "refresh";

// Evaluates to true when the page is blanked and holds, false when a capture found nothing to
// blank (nothing mutated), or an "error: ..." string when the page threw, so a page fault is
// told apart from a transport failure. The count changes last, after every style is in place.
export function sensitiveBlankInjectExpression(mode: SensitiveBlankMode = "capture"): string {
  return `(() => { try {${SENSITIVE_BLANK_ROOT_WALK}
  const id = ${JSON.stringify(SENSITIVE_BLANK_STYLE_ID)};
  const css = ${JSON.stringify(SENSITIVE_BLANK_CSS)};
  if (${mode === "capture"} && !roots.some((root) => root.querySelector(${JSON.stringify(SENSITIVE_BLANK_MARKER)}))) return false;
  let top = null;
  for (const root of roots) {
    let style = root.querySelector("#" + id);
    if (!style) {
      const owner = root.nodeType === 9 ? root : (root.host && root.host.ownerDocument) || document;
      style = owner.createElement("style");
      style.id = id;
      style.textContent = css;
      (root.head || root.documentElement || root).appendChild(style);
    }
    if (root === document) top = style;
  }
  const count = Number(top.getAttribute(${JSON.stringify(SENSITIVE_BLANK_COUNT)}) || "0");
  top.setAttribute(${JSON.stringify(SENSITIVE_BLANK_COUNT)}, String(${mode === "refresh"} ? Math.max(count, 1) : count + 1));
  return true;
} catch (error) { return "error: " + String(error && error.message || error); } })()`;
}

// Evaluates to the number of style elements removed: 0 while another holder still holds.
export function sensitiveBlankRemoveExpression(): string {
  return `(() => {${SENSITIVE_BLANK_ROOT_WALK}
  const id = ${JSON.stringify(SENSITIVE_BLANK_STYLE_ID)};
  const top = document.querySelector("#" + id);
  const count = Number((top && top.getAttribute(${JSON.stringify(SENSITIVE_BLANK_COUNT)})) || "0") - 1;
  if (top && count > 0) {
    top.setAttribute(${JSON.stringify(SENSITIVE_BLANK_COUNT)}, String(count));
    return 0;
  }
  let removed = 0;
  for (const root of roots) {
    const existing = root.querySelector("#" + id);
    if (!existing) continue;
    existing.remove();
    removed += 1;
  }
  return removed;
})()`;
}

export type SensitiveBlankEvaluate = (expression: string) => Promise<unknown>;

async function acquireSensitiveBlanking(evaluate: SensitiveBlankEvaluate, mode: SensitiveBlankMode) {
  let result: unknown;
  try {
    result = await evaluate(sensitiveBlankInjectExpression(mode));
  } catch (error) {
    // A transport failure (a timeout on a busy renderer) does not stop the injection from
    // running later; a release queued behind it on the same session undoes it in order, so a
    // late injection never stays in the page. It is not awaited: the caller's budget is spent.
    void evaluate(sensitiveBlankRemoveExpression()).catch(() => {});
    throw error;
  }
  if (typeof result === "string") throw new Error(`sensitive blanking failed in the page: ${result}`);
  return result === true;
}

async function releaseSensitiveBlanking(evaluate: SensitiveBlankEvaluate) {
  // A removal that fails means the page (and the style with it) is already gone, or the page is
  // busy and the queued removal still runs; this is the same dead-target cleanup readCapture
  // performs for screenshot_release.
  await evaluate(sensitiveBlankRemoveExpression()).catch(() => {});
}

// Runs capture() with every reachable data-sensitive element blanked, restoring the page
// exactly afterwards, also when the capture throws. A page with no marked element pays one
// read-only evaluate and no mutation; a capture that cannot blank fails instead of capturing.
// Callers pass their own evaluate (bounded by their own timeout) so the helper owns no
// transport; core.ts routes every Page.captureScreenshot through it.
export async function withSensitiveBlanking<T>(
  evaluate: SensitiveBlankEvaluate,
  capture: () => Promise<T>,
): Promise<T> {
  if (!(await acquireSensitiveBlanking(evaluate, "capture"))) return await capture();
  try {
    return await capture();
  } finally {
    await releaseSensitiveBlanking(evaluate);
  }
}

export interface SensitiveBlankHold {
  // Call on every streamed frame; one refresh runs at a time and a frame arriving while one is
  // in flight is covered by the next.
  refresh(): void;
  release(): Promise<void>;
}

// A video recording streams frames the compositor produces on its own schedule, so it cannot
// blank per frame: it holds the blanking for its whole lifetime, taken before the first frame.
// Markers added to an existing root are blanked at once (the stylesheet is live); a shadow root
// or same-origin frame created during the recording, or a new document after a navigation, is
// blanked by the refresh its next frame triggers (TOOLS.md states that window).
// Page.startScreencast opens with the last frame the compositor produced, which predates the
// injected style until the page paints again, so the hold resolves only after two animation
// frames have run with the style in place (the first paints it, the second follows its commit).
// A page whose animation frames never run (a hidden tab) streams no frames either; the timer
// keeps the start from hanging there.
const SENSITIVE_BLANK_PAINTED = `new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), 1000);
  requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(true); }));
})`;

export async function holdSensitiveBlanking(evaluate: SensitiveBlankEvaluate): Promise<SensitiveBlankHold> {
  await acquireSensitiveBlanking(evaluate, "recording");
  try {
    await evaluate(SENSITIVE_BLANK_PAINTED);
  } catch (error) {
    await releaseSensitiveBlanking(evaluate);
    throw error;
  }
  let refreshing = false;
  return {
    refresh() {
      if (refreshing) return;
      refreshing = true;
      void evaluate(sensitiveBlankInjectExpression("refresh"))
        .catch(() => {})
        .finally(() => {
          refreshing = false;
        });
    },
    release: async () => await releaseSensitiveBlanking(evaluate),
  };
}
