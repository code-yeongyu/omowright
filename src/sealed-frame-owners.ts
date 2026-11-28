// #379 (#392 audit): a frame's markup can come from its owner element's attribute: srcdoc, or a
// data: or javascript: URL in <iframe src>, <frame src>, <object data> or <embed src>. Only such an
// owner can leak frame markup through its attribute, so only such owners are candidates; an http(s)
// source carries no markup and is never withheld. A candidate is withheld (src, srcdoc and data read
// as the placeholder in serialized HTML, getAttribute and attribute matchers, and its document
// counts as holding sealed content for the selector guard) when its loaded frame, or any frame
// below it, holds sealed markup. That is decided from the loaded frame tree, never by reading the
// attribute text. A candidate whose frame is not loaded or cannot be read is withheld too.

import type { CdpDomNode } from "./cdp-protocol.ts";
import type { SealCdp, SealableFrames } from "./sensitive-guard.ts";

export interface OwnerFrames extends SealableFrames {
  collectDescendantFrames(frameId: string | null): ReadonlyArray<{ frameId: string; parentFrameId: string | null }>;
}

export const WITHHELD_OWNER_ATTRIBUTES = ["src", "srcdoc", "data"];

// The document's frame owners in document order, open shadow roots included, and whether an
// owner's attribute carries markup (a srcdoc, or a data: or javascript: source; the scheme is
// read, not the markup). The probe below and every page-side consumer use these, so indices agree.
export const FRAME_OWNERS_SOURCE = `() => {
  const owners = [];
  const visit = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (/^(IFRAME|FRAME|OBJECT|EMBED)$/.test(el.tagName)) owners.push(el);
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(document);
  return owners;
}`;
export const CARRIES_MARKUP_SOURCE = `(el) => /^(IFRAME|FRAME|OBJECT|EMBED)$/.test(el.tagName) &&
  (el.hasAttribute('srcdoc') || ['src', 'data'].some((name) => /^\\s*(data|javascript):/i.test(el.getAttribute(name) || '')))`;

// The withheld owners a page function applies: indices into FRAME_OWNERS_SOURCE's list, the list
// length they were computed against, and all = withhold every owner. A page function whose owner
// count differs from total withholds every owner, so a DOM change between probe and use fails closed.
export interface WithheldOwners {
  indices: number[];
  total: number;
  all: boolean;
}

// index < 0 returns { total, candidates }; index >= 0 returns that owner.
const FRAME_OWNER_FN = `function(index) {
  const owners = (${FRAME_OWNERS_SOURCE})();
  const carries = ${CARRIES_MARKUP_SOURCE};
  if (index >= 0) return owners[index] ?? null;
  return { total: owners.length, candidates: owners.flatMap((el, at) => (carries(el) ? [at] : [])) };
}`;

// Whether the document holds sealed markup itself: a marker anywhere, open shadow roots and
// <template> content included.
const HOLDS_SEALED_MARKUP_FN = `function() {
  const marked = (el) => { const v = el.getAttribute('data-sensitive'); return v !== null && v !== 'false'; };
  const visit = (root) => Array.from(root.querySelectorAll('*')).some((el) =>
    marked(el) || (!!el.shadowRoot && visit(el.shadowRoot)) || (el.tagName === 'TEMPLATE' && visit(el.content)));
  return visit(document);
}`;

async function frameContext(frames: SealableFrames, frameId: string) {
  const frame = frames.getFrame(frameId);
  const contextId = frame?.isolatedContextId ?? (await frames.ensureInjected(frameId).catch(() => null));
  return frame && contextId ? { sessionId: frame.sessionId, contextId } : null;
}

async function holdsSealedMarkup(cdp: SealCdp, frames: SealableFrames, frameId: string) {
  try {
    const context = await frameContext(frames, frameId);
    if (!context) return true;
    const { result } = await cdp.send(
      "Runtime.callFunctionOn",
      { functionDeclaration: HOLDS_SEALED_MARKUP_FN, executionContextId: context.contextId, returnByValue: true },
      context.sessionId,
    );
    return result.value !== false;
  } catch {
    return true;
  }
}

// Whether the frame loaded for this owner node, or any frame below it, holds sealed markup; an
// owner with no loaded frame, or a frame that cannot be read, counts as holding it.
async function ownerFrameSealed(cdp: SealCdp, frames: OwnerFrames, node: CdpDomNode) {
  if (node.frameId === undefined || !frames.getFrame(node.frameId)) return true;
  const subtree = frames.collectDescendantFrames(node.frameId);
  const holds = await Promise.all(subtree.map(({ frameId }) => holdsSealedMarkup(cdp, frames, frameId)));
  return holds.some(Boolean);
}

function carriesMarkup(node: CdpDomNode) {
  const attributes = node.attributes ?? [];
  for (let index = 0; index < attributes.length; index += 2) {
    const name = (attributes[index] ?? "").toLowerCase();
    const value = (attributes[index + 1] ?? "").trim().toLowerCase();
    if (name === "srcdoc") return true;
    if ((name === "src" || name === "data") && (value.startsWith("data:") || value.startsWith("javascript:")))
      return true;
  }
  return false;
}

/** The frame owners in `frameId`'s document to withhold; a document that cannot be listed withholds all. */
export async function withheldFrameOwners(
  cdp: SealCdp,
  frames: OwnerFrames,
  frameId: string | null | undefined,
): Promise<WithheldOwners> {
  const context = frameId ? await frameContext(frames, frameId) : null;
  if (!context) return { indices: [], total: 0, all: true };
  const call = (index: number, returnByValue: boolean) =>
    cdp.send(
      "Runtime.callFunctionOn",
      {
        functionDeclaration: FRAME_OWNER_FN,
        arguments: [{ value: index }],
        executionContextId: context.contextId,
        returnByValue,
      },
      context.sessionId,
    );
  try {
    const listed: unknown = (await call(-1, true)).result.value;
    const total = typeof listed === "object" && listed ? Reflect.get(listed, "total") : undefined;
    const candidates = typeof listed === "object" && listed ? Reflect.get(listed, "candidates") : undefined;
    if (typeof total !== "number" || !Array.isArray(candidates)) return { indices: [], total: 0, all: true };
    const indices: number[] = [];
    for (const index of candidates) {
      if (typeof index !== "number") return { indices: [], total, all: true };
      const { result } = await call(index, false);
      if (!result.objectId) return { indices: [], total, all: true };
      try {
        const { node } = await cdp.send("DOM.describeNode", { objectId: result.objectId }, context.sessionId);
        if (await ownerFrameSealed(cdp, frames, node)) indices.push(index);
      } finally {
        await cdp.send("Runtime.releaseObject", { objectId: result.objectId }, context.sessionId).catch(() => {});
      }
    }
    return { indices, total, all: false };
  } catch {
    return { indices: [], total: 0, all: true };
  }
}

// Whether the owner probe must run for a selector. Skipping it is an optimization, so every doubt
// falls toward probing. Raw CSS (waitForSelector, scoped snapshots) cannot hold an attribute
// selector or pseudo-class without a literal `[` or `:`, so any such character probes, comments
// included. A locator selector is split into steps the way the page splits it; a text or label
// step never reads an owner's source and an attribute-engine step only does on src/srcdoc/data,
// and any step holding a CSS comment probes. This reads the caller's selector, never page content.
export function cssNeedsOwnerCheck(selector: string) {
  return /[[:]/.test(selector);
}

export function selectorNeedsOwnerCheck(selector: string) {
  if (selector.includes("/*")) return true;
  return selector.split(/\s*>>\s*/).some((step) => {
    const base = step
      .trim()
      .replace(/:nth\((?:\d+|last)\)$/, "")
      .replace(/:has-text\(.*\)$/s, "")
      .trim();
    if (/^(text:|internal:label:)/.test(base)) return false;
    const attribute = /^internal:attr=\[([^=\]]+)=/.exec(base)?.[1];
    if (attribute !== undefined) return WITHHELD_OWNER_ATTRIBUTES.includes(attribute.toLowerCase());
    return cssNeedsOwnerCheck(base);
  });
}

export function holdsWithheld(owners: WithheldOwners) {
  return owners.all || owners.indices.length > 0;
}

export async function holdsWithheldOwner(cdp: SealCdp, frames: OwnerFrames, frameId: string | null | undefined) {
  return holdsWithheld(await withheldFrameOwners(cdp, frames, frameId));
}

export async function isWithheldOwner(
  cdp: SealCdp,
  frames: OwnerFrames,
  element: { objectId: string; frameSessionId?: string | undefined },
) {
  try {
    const { node } = await cdp.send("DOM.describeNode", { objectId: element.objectId }, element.frameSessionId);
    if (!/^(IFRAME|FRAME|OBJECT|EMBED)$/.test(node.nodeName.toUpperCase()) || !carriesMarkup(node)) return false;
    return await ownerFrameSealed(cdp, frames, node);
  } catch {
    return true;
  }
}

/**
 * A frame or page URL with its markup payload withheld when it can carry markup (data: or
 * javascript:). url() and frames() are synchronous, so the frame tree cannot be checked there.
 */
export function withheldMarkupUrl(url: string, placeholder: string) {
  const trimmed = url.trimStart();
  const scheme = /^(data|javascript):/i.exec(trimmed)?.[0];
  if (!scheme) return url;
  if (scheme.toLowerCase() === "javascript:") return `javascript:${placeholder}`;
  const comma = trimmed.indexOf(",");
  return `${comma < 0 ? trimmed : trimmed.slice(0, comma)},${placeholder}`;
}
