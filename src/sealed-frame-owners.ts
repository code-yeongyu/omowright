// #379 (#392 audit): a frame's markup can come from its owner element's attribute: srcdoc, or a
// data: or javascript: URL in <iframe src>, <frame src>, <object data> or <embed src>. An owner is
// withheld (src, srcdoc and data read as the placeholder in serialized HTML and getAttribute, and
// its document counts as holding sealed content for the selector guard) when its loaded frame, or
// any frame below it, holds sealed markup. That is decided from the loaded frame tree, never by
// reading the attribute text. A frame whose document cannot be read counts as holding it, and an
// owner with no loaded frame is withheld when its attribute carries markup itself (srcdoc, or a
// data: or javascript: URL), since that source cannot be checked.

import type { CdpDomNode } from "./cdp-protocol.ts";
import type { SealCdp, SealableFrames } from "./sensitive-guard.ts";

export interface OwnerFrames extends SealableFrames {
  collectDescendantFrames(frameId: string | null): ReadonlyArray<{ frameId: string; parentFrameId: string | null }>;
}

export const WITHHELD_OWNER_ATTRIBUTES = ["src", "srcdoc", "data"];

// Whether the document holds sealed markup itself: a marker anywhere, open shadow roots and
// <template> content included.
const HOLDS_SEALED_MARKUP_FN = `function() {
  const marked = (el) => { const v = el.getAttribute('data-sensitive'); return v !== null && v !== 'false'; };
  const visit = (root) => Array.from(root.querySelectorAll('*')).some((el) =>
    marked(el) || (!!el.shadowRoot && visit(el.shadowRoot)) || (el.tagName === 'TEMPLATE' && visit(el.content)));
  return visit(document);
}`;

// The document's frame owners in document order, open shadow roots included. Both the probe below
// and the page-side clone (sensitiveElementGuard) use this one traversal, so indices agree.
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

// index < 0 returns how many frame owners the document holds; index >= 0 returns that owner.
const FRAME_OWNER_FN = `function(index) {
  const owners = (${FRAME_OWNERS_SOURCE})();
  return index < 0 ? owners.length : (owners[index] ?? null);
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

// The frames below `frameId` whose own document, or a frame below them, holds sealed markup.
async function contentSealedFrames(cdp: SealCdp, frames: OwnerFrames, frameId: string) {
  const below = frames.collectDescendantFrames(frameId).slice(1);
  const own = await Promise.all(
    below.map(async (entry) => [entry, await holdsSealedMarkup(cdp, frames, entry.frameId)] as const),
  );
  const sealed = new Set(own.flatMap(([entry, holds]) => (holds ? [entry.frameId] : [])));
  for (const { frameId: child, parentFrameId } of below.toReversed())
    if (sealed.has(child) && parentFrameId && parentFrameId !== frameId) sealed.add(parentFrameId);
  return sealed;
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

function withheld(node: CdpDomNode, frames: SealableFrames, sealed: ReadonlySet<string>) {
  const loaded = node.frameId !== undefined && !!frames.getFrame(node.frameId);
  return loaded ? sealed.has(node.frameId ?? "") : carriesMarkup(node);
}

/**
 * Indices, in the document-order owner traversal FRAME_OWNER_FN and the page-side
 * __omowFrameOwners share, of the frame owners in `frameId`'s document to withhold. Indices rather
 * than remote objects let the page function that applies them run in either JS world. A document
 * that cannot be listed yields `all: true`: every owner is withheld.
 */
export async function withheldFrameOwners(cdp: SealCdp, frames: OwnerFrames, frameId: string | null | undefined) {
  const indices: number[] = [];
  const context = frameId ? await frameContext(frames, frameId) : null;
  if (!frameId || !context) return { indices, all: true };
  try {
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
    const count = (await call(-1, true)).result.value;
    if (typeof count !== "number") return { indices, all: true };
    if (count === 0) return { indices, all: false };
    const sealed = await contentSealedFrames(cdp, frames, frameId);
    for (let index = 0; index < count; index++) {
      const { result } = await call(index, false);
      if (!result.objectId) continue;
      try {
        const { node } = await cdp.send("DOM.describeNode", { objectId: result.objectId }, context.sessionId);
        if (withheld(node, frames, sealed)) indices.push(index);
      } finally {
        await cdp.send("Runtime.releaseObject", { objectId: result.objectId }, context.sessionId).catch(() => {});
      }
    }
    return { indices, all: false };
  } catch {
    return { indices: [], all: true };
  }
}

export async function holdsWithheldOwner(cdp: SealCdp, frames: OwnerFrames, frameId: string | null | undefined) {
  const owners = await withheldFrameOwners(cdp, frames, frameId);
  return owners.all || owners.indices.length > 0;
}

export async function isWithheldOwner(
  cdp: SealCdp,
  frames: OwnerFrames,
  element: { objectId: string; frameId?: string | undefined; frameSessionId?: string | undefined },
) {
  try {
    const { node } = await cdp.send("DOM.describeNode", { objectId: element.objectId }, element.frameSessionId);
    if (!/^(IFRAME|FRAME|OBJECT|EMBED)$/.test(node.nodeName.toUpperCase())) return false;
    if (node.frameId === undefined || !frames.getFrame(node.frameId)) return carriesMarkup(node);
    if (await holdsSealedMarkup(cdp, frames, node.frameId)) return true;
    return (await contentSealedFrames(cdp, frames, node.frameId)).size > 0;
  } catch {
    return true;
  }
}
