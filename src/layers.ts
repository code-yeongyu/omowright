export async function describeLayers(page, { grid = 5 } = {}) {
  return page.evaluate(gridSize => {
    const width = Math.round(globalThis.visualViewport?.width ?? globalThis.innerWidth ?? 0);
    const height = Math.round(globalThis.visualViewport?.height ?? globalThis.innerHeight ?? 0);
    const viewport = { width, height };
    const total = gridSize * gridSize;
    const hits = new Map();

    function pierceTopmost(x, y) {
      const stack = document.elementsFromPoint(x, y);
      let el = stack[0] ?? null;
      const seen = new Set();
      while (el?.shadowRoot && typeof el.shadowRoot.elementsFromPoint === "function") {
        if (seen.has(el)) break;
        seen.add(el);
        const inner = el.shadowRoot.elementsFromPoint(x, y) ?? [];
        const next = inner.find(node => node && node !== el);
        if (!next) break;
        el = next;
      }
      return el;
    }

    function parentOf(node) {
      if (!node) return null;
      if (node.parentElement) return node.parentElement;
      const root = node.getRootNode?.();
      return root?.host ?? null;
    }

    function promote(el) {
      const minArea = 0.5 * width * height;
      let node = el;
      while (node && node.nodeType === 1) {
        const position = getComputedStyle(node).position;
        if (position === "fixed" || position === "sticky" || position === "absolute") {
          const rect = node.getBoundingClientRect();
          if (rect.width * rect.height >= minArea) return node;
        }
        node = parentOf(node);
      }
      return el;
    }

    function labelledByText(el) {
      const ids = (el.getAttribute("aria-labelledby") || "").trim();
      if (!ids) return "";
      return ids.split(/\s+/).map(id => document.getElementById(id)?.textContent?.trim() ?? "").filter(Boolean).join(" ");
    }

    function elementName(el) {
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) return ariaLabel;
      const labelled = labelledByText(el);
      if (labelled) return labelled;
      const heading = el.querySelector("h1,h2,h3,h4,h5,h6")?.textContent?.trim();
      if (heading) return heading;
      return ((el.innerText || el.textContent || "").trim().replace(/\s+/g, " ")).slice(0, 80);
    }

    function selectorHint(el) {
      if (el.id) return `#${el.id}`;
      const classes = [...el.classList].join(".");
      return classes ? `${el.tagName.toLowerCase()}.${classes}` : el.tagName.toLowerCase();
    }

    function describe(el, coverage) {
      return {
        tagName: el.tagName,
        role: el.getAttribute("role") || "",
        name: elementName(el),
        coverage,
        position: getComputedStyle(el).position,
        selectorHint: selectorHint(el),
        ariaModal: el.getAttribute("aria-modal") === "true",
      };
    }

    function isMainContent(el) {
      if (el === document.documentElement || el === document.body) return true;
      if (el.tagName === "MAIN") return true;
      return (el.getAttribute("role") || "").toLowerCase() === "main";
    }

    function isBlocking(el, info) {
      if (info.coverage < 0.6) return false;
      if (getComputedStyle(el).pointerEvents === "none") return false;
      const role = (info.role || "").toLowerCase();
      if (role === "dialog" || role === "alertdialog") return true;
      if (info.ariaModal) return true;
      if (isMainContent(el)) return false;
      return info.position === "fixed" || info.position === "absolute";
    }

    const insetX = width * 0.05;
    const insetY = height * 0.05;
    const spanX = width * 0.9;
    const spanY = height * 0.9;
    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        const x = insetX + ((col + 0.5) * spanX) / gridSize;
        const y = insetY + ((row + 0.5) * spanY) / gridSize;
        const top = pierceTopmost(x, y);
        if (!top) continue;
        const candidate = promote(top);
        hits.set(candidate, (hits.get(candidate) ?? 0) + 1);
      }
    }

    const candidates = [...hits.entries()]
      .map(([el, count]) => {
        const info = describe(el, total > 0 ? count / total : 0);
        return { el, info };
      })
      .sort((a, b) => b.info.coverage - a.info.coverage);

    const blockingEntry = candidates.find(entry => isBlocking(entry.el, entry.info));
    return {
      blocking: blockingEntry ? blockingEntry.info : null,
      candidates: candidates.map(entry => entry.info),
      viewport,
    };
  }, grid);
}

export function layersHeader(result) {
  const blocking = result?.blocking;
  if (!blocking) return "@layers none";
  const who = blocking.role || blocking.tagName;
  const pct = Math.round(blocking.coverage * 100);
  return `@layers blocking=${who} "${blocking.name}" coverage=${pct}% hint=${blocking.selectorHint}`;
}

export async function snapshotWithLayers(page, snapshotOptions) {
  const snapshot = await page.snapshot(snapshotOptions);
  const layers = await describeLayers(page);
  return { ...snapshot, layers, tree: `${layersHeader(layers)}\n${snapshot.tree}` };
}
