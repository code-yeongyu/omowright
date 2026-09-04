const SNAPSHOT_PARSE_ERROR =
  "compactSnapshot expected a snapshot() result (JSON string or {tree, refs} object)";

export function compactSnapshot(snapshot) {
  const obj = typeof snapshot === "string" ? JSON.parse(snapshot) : snapshot;
  if (!obj || typeof obj.tree !== "string") throw new TypeError(SNAPSHOT_PARSE_ERROR);
  return obj.tree;
}

export function snapshotTokens(snapshot) {
  const text = typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot);
  return { bytes: Buffer.byteLength(text, "utf8"), estTokens: Math.ceil(Buffer.byteLength(text, "utf8") / 4) };
}

export const toolSchemas = [
  {
    name: "newTab",
    description: "Open a tab and return its page. Waits for interactivity.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "attachPage",
    description: "Attach to an existing tab by targetId from listTargets().",
    parameters: { type: "object", properties: { targetId: { type: "string" } }, required: ["targetId"] },
  },
  {
    name: "page.goto",
    description: "Navigate the page; resolves when the page looks interactive.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "page.snapshot",
    description: "PRIMARY page read. Returns a compact a11y tree; interactive elements carry [ref=eN] ids for page.locator. Options: maxDepth, maxChars, interactive, showHidden, selector, ref.",
    parameters: { type: "object", properties: { options: { type: "object" } } },
  },
  {
    name: "page.locator",
    description: "Resolve a ref id (e.g. 'e1') or CSS selector to a Locator: click, fill, press, hover, check, selectOption, dragTo, setInputFiles, textContent, isVisible, waitFor.",
    parameters: { type: "object", properties: { selectorOrRef: { type: "string" } }, required: ["selectorOrRef"] },
  },
  {
    name: "page.evaluate",
    description: "Run JS in the page and return the result.",
    parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
  },
  {
    name: "page.screenshot",
    description: "Capture page image bytes (path, fullPage, clip, type, quality).",
    parameters: { type: "object", properties: { options: { type: "object" } } },
  },
  {
    name: "page.pdf",
    description: "Print the page to PDF bytes (path, format, margin, printBackground).",
    parameters: { type: "object", properties: { options: { type: "object" } } },
  },
  {
    name: "compactSnapshot",
    description: "Pass page.snapshot() output through this before reading: returns the raw tree without the refs map (refs resolve in-page; the map is ~54% of bytes on real pages).",
    parameters: { type: "object", properties: { snapshot: {} }, required: ["snapshot"] },
  },
  {
    name: "createCua",
    description: "Coordinate fallback for UI that refs cannot target: click/doubleClick/drag/move/scroll/type/keypress at viewport points, getVisibleScreenshot() as base64 PNG.",
    parameters: { type: "object", properties: { page: {} }, required: ["page"] },
  },
  {
    name: "createCaptcha",
    description: "Captcha helpers: click(bounds) and drag(from,to) return a post-action snapshot tree; readText(bounds?) OCRs a screenshot region (macOS Vision default, custom ocr injectable).",
    parameters: { type: "object", properties: { page: {}, options: { type: "object" } }, required: ["page"] },
  },
  {
    name: "createChromeApi",
    description: "Chrome MV3-shaped APIs: tabs.query/get, windows.*, bookmarks/history/topSites (read-only from profile files), downloads.search/download. Writes throw UnsupportedOperationError.",
    parameters: { type: "object", properties: { connection: {}, options: { type: "object" } }, required: ["connection"] },
  },
  {
    name: "injectCookies",
    description: "Inject raw cookie exports into a page with CDP sanitization handled (negative expires dropped, __Host- forced secure+root path+url-scoped, SameSite=None dropped when not secure, name+domain deduped).",
    parameters: { type: "object", properties: { page: {}, cookies: { type: "array" } }, required: ["page", "cookies"] },
  },
];
