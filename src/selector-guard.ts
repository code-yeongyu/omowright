// Self-contained: locator queries, scoped snapshots and selector waits serialize this factory into
// the document's world.
//
// #379: in a document holding sealed (data-sensitive) content, a CSS selector whose match could
// depend on a sealed element's attribute values (#386), language or form state (#387) is refused,
// so a match count or a found/not-found answer cannot confirm a guessed secret. The refusal depends
// only on whether sealed content exists, which every snapshot already shows. Presence selectors,
// ids, classes, the marker and the test id still run, as do the structural and interaction
// pseudo-classes below; anything else (:lang, :placeholder-shown, :invalid, :empty, :checked, and
// any pseudo-class added later) is refused.
//
// The engine parses the selector: a constructable sheet (never adopted, so the page is untouched)
// serializes it canonically, with comments dropped, escapes decoded and every comparison written
// `[name op "value"]`. A selector the engine rejects as a style rule is judged on its raw text: an
// attribute selector or a pseudo-class cannot exist without a literal `[` or `:`.

// sealedFrames: the document holds a frame owner whose loaded frame holds sealed markup, decided
// from the frame tree by sealed-frame-owners.ts (a frame's source can carry its markup).
export function createSelectorGuard(sealedDocument = false, testIdAttribute = "data-testid", sealedFrames = false) {
  const structural = new Set([
    "is",
    "where",
    "not",
    "has",
    "scope",
    "root",
    "first-child",
    "last-child",
    "only-child",
    "first-of-type",
    "last-of-type",
    "only-of-type",
    "nth-child",
    "nth-last-child",
    "nth-of-type",
    "nth-last-of-type",
    "hover",
    "active",
    "focus",
    "focus-visible",
    "focus-within",
    "target",
    "link",
    "any-link",
    "enabled",
    "disabled",
    "required",
    "optional",
    "read-only",
    "read-write",
    "defined",
    "host",
    "host-context",
    "popover-open",
    "modal",
    "open",
  ]);
  const holdsMarker = (root: Document | ShadowRoot): boolean =>
    Array.from(root.querySelectorAll("*")).some((element) => {
      const marker = element.getAttribute("data-sensitive");
      return (marker !== null && marker !== "false") || (!!element.shadowRoot && holdsMarker(element.shadowRoot));
    });
  const holdsSealed = (root: Document) => sealedDocument || sealedFrames || holdsMarker(root);
  // The part of the selector that can depend on sealed content, or null. The canonical text is
  // scanned outside strings: inside a bracket, the text before the first `=` is the serialized name
  // plus operator, and only the exact serialized marker or test id name is exempt (a raw role
  // attribute is not in the redacted snapshot, #390); outside brackets, every single-colon pseudo-class name is checked
  // against the allowlist, including those nested in :is(), :has() or ::slotted().
  const revealingPart = (selector: string): string | null => {
    let canonical: string | null = null;
    try {
      const sheet = new CSSStyleSheet();
      sheet.insertRule(`${selector}{}`);
      const rule = sheet.cssRules[0];
      if (rule instanceof CSSStyleRule) canonical = rule.selectorText;
    } catch {
      canonical = null;
    }
    if (canonical === null) return /[[:]/.test(selector) ? selector : null;
    const exempt = new Set(["data-sensitive", testIdAttribute].map((name) => CSS.escape(name)));
    let quote = "";
    let escaped = false;
    let body: string | null = null;
    for (let index = 0; index < canonical.length; index++) {
      const char = canonical.charAt(index);
      if (escaped || char === "\\" || quote || char === '"' || char === "'") {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (quote) quote = char === quote ? "" : quote;
        else quote = char;
        if (body !== null) body += char;
      } else if (body !== null) {
        if (char !== "]") body += char;
        else {
          const operator = body.indexOf("=");
          const name = body
            .slice(0, Math.max(operator, 0))
            .replace(/[~|^$*]$/, "")
            .trim();
          if (operator >= 0 && !exempt.has(name)) return `[${body}]`;
          body = null;
        }
      } else if (char === "[") body = "";
      else if (char === ":" && canonical.charAt(index + 1) === ":") index++;
      else if (char === ":") {
        const name = (/^[-\w]*/.exec(canonical.slice(index + 1))?.[0] ?? "").toLowerCase();
        if (!structural.has(name)) return `:${name}`;
      }
    }
    return null;
  };
  const assertSelectorAllowed = (selector: string, document: Document) => {
    const part = revealingPart(selector);
    if (part !== null && holdsSealed(document))
      throw new Error(
        `Selector "${selector}" can depend on sealed content (${part}) in a document with data-sensitive content; use a ref, getByRole, test id, id, class or structural selector instead`,
      );
  };
  return { assertSelectorAllowed };
}
