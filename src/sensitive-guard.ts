// #379: an element the page seals with data-sensitive (any value except the exact string
// "false", which is inert and does not unseal a marked ancestor) makes every read omowright
// formats from it return the placeholder instead of its text, value or attribute values —
// including a read of an ancestor, which substitutes the placeholder for the sealed subtree.
// The walk crosses shadow boundaries. innerText on a subtree containing sealed elements
// falls back to the walker's text form, so its whitespace can differ from layout innerText.
//
// A sealed <iframe>/<frame>/<object>/<embed> seals the document it hosts, and that document
// seals every frame below it: the whole sub-frame chain is sealed content. Element checks run
// inside one document, so frame sealing is decided here from the owner elements in the
// parent document, using only CDP methods the scoped page path already allows.

import type { CdpSend } from "./cdp-protocol.ts";
import { CARRIES_MARKUP_SOURCE, FRAME_OWNERS_SOURCE } from "./sealed-frame-owners.ts";
import { createSelectorGuard } from "./selector-guard.ts";

export const SENSITIVE_PLACEHOLDER = `[redacted: sensitive]`;

const SENSITIVE_ELEMENT_FN = `(element) => {
  for (let current = element; current; ) {
    const value = current.getAttribute ? current.getAttribute('data-sensitive') : null;
    if (value !== null && value !== 'false') return true;
    const parent = current.parentElement;
    if (parent) { current = parent; continue; }
    const root = typeof current.getRootNode === 'function' ? current.getRootNode() : null;
    current = root && typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}`;

export const sensitiveElementGuard = `const __omowSensitive = ${SENSITIVE_ELEMENT_FN};
const __omowSensitiveTextOf = (root) => {
  const parts = [];
  const visit = (node) => {
    if (node.nodeType === 3) parts.push(node.nodeValue || '');
    else if (node.nodeType === 1) {
      if (__omowSensitive(node)) { parts.push(${JSON.stringify(SENSITIVE_PLACEHOLDER)}); return; }
      for (const child of node.childNodes) visit(child);
    }
  };
  visit(root);
  return parts.join('');
};
// Serialized HTML also carries <template> content, which the element walk does not reach, and the
// src/srcdoc/data of frame owners whose loaded frames hold sealed markup. Those owners are decided
// from the frame tree (sealed-frame-owners.ts) and arrive as a WithheldOwners value: indices into
// __omowFrameOwners(), the owner count they were computed against, and all. A count that no longer
// matches (the DOM changed in between) or all withholds every owner that carries markup.
const __omowFrameOwners = ${FRAME_OWNERS_SOURCE};
// A frame owner inside <template> content never loads a frame, so its source cannot be checked:
// a srcdoc, or a data: or javascript: source, is withheld there.
const __omowCarriesMarkup = ${CARRIES_MARKUP_SOURCE};
const __omowTemplateSealed = (template) =>
  __omowHasSensitive(template.content) ||
  Array.from(template.content.querySelectorAll('iframe, frame, object, embed')).some(__omowCarriesMarkup);
const __omowHasSensitive = (root) =>
  __omowSensitive(root) ||
  (root.tagName === 'TEMPLATE' && __omowTemplateSealed(root)) ||
  Array.from(root.querySelectorAll('[data-sensitive], template')).some((el) =>
    el.tagName === 'TEMPLATE' ? __omowTemplateSealed(el) : el.getAttribute('data-sensitive') !== 'false');
const __omowWithheldOwners = (root, withheld) => {
  const owners = __omowFrameOwners();
  const all = !withheld || withheld.all || owners.length !== withheld.total;
  const picked = all ? owners.filter(__omowCarriesMarkup) : withheld.indices.map((index) => owners[index]);
  return picked.filter((el) => el && (el === root || root.contains(el)));
};
const __omowNeedsRedaction = (root, withheld) => __omowHasSensitive(root) || __omowWithheldOwners(root, withheld).length > 0;
const __omowRedactedClone = (root, withheld) => {
  const pathOf = (el) => {
    const path = [];
    for (let node = el; node !== root; node = node.parentNode) path.unshift(Array.prototype.indexOf.call(node.parentNode.childNodes, node));
    return path;
  };
  const paths = __omowWithheldOwners(root, withheld).map(pathOf);
  const clone = root.cloneNode(true);
  for (const path of paths) {
    const owner = path.reduce((node, index) => node && node.childNodes[index], clone);
    for (const name of ['src', 'srcdoc', 'data']) if (owner && owner.hasAttribute(name)) owner.setAttribute(name, ${JSON.stringify(SENSITIVE_PLACEHOLDER)});
  }
  const strip = (node, inTemplate) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== 1) continue;
      if (__omowSensitive(child)) node.replaceChild(document.createTextNode(${JSON.stringify(SENSITIVE_PLACEHOLDER)}), child);
      else {
        if (inTemplate && __omowCarriesMarkup(child))
          for (const name of ['src', 'srcdoc', 'data']) if (child.hasAttribute(name)) child.setAttribute(name, ${JSON.stringify(SENSITIVE_PLACEHOLDER)});
        if (child.tagName === 'TEMPLATE') strip(child.content, true);
        strip(child, inTemplate);
      }
    }
  };
  // A <template> root keeps its children in .content, which the walk below does not enter.
  if (clone.tagName === 'TEMPLATE') strip(clone.content, true);
  strip(clone);
  return clone;
};`;

// index < 0 returns how many sealed frame owners the document holds; index >= 0 returns that
// owner element. Open shadow roots are searched too.
const SEALED_OWNER_FN = `function(index) {
  const sensitive = ${SENSITIVE_ELEMENT_FN};
  const owners = [];
  const visit = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (/^(IFRAME|FRAME|OBJECT|EMBED)$/.test(el.tagName) && sensitive(el)) owners.push(el);
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(document);
  return index < 0 ? owners.length : (owners[index] ?? null);
}`;

// A page expression that throws when `selector` could confirm a sealed attribute value (see
// assertSelectorAllowed), for selector waits that run outside the locator query.
export function selectorGuardExpression(selector: string, testIdAttribute: string, sealedFrames: boolean) {
  return `(${createSelectorGuard.toString()})(false, ${JSON.stringify(testIdAttribute)}, ${sealedFrames}).assertSelectorAllowed(${JSON.stringify(selector)}, document)`;
}

interface SealableFrame {
  readonly parentFrameId: string | null;
  readonly sessionId: string;
  readonly isolatedContextId?: number | null | undefined;
  // Set once an owner check proves the frame sealed: frame.name() then reads the placeholder.
  sealedOwner?: boolean | undefined;
}

export interface SealableFrames {
  getFrame(frameId: string | null): SealableFrame | null | undefined;
  ensureInjected(frameId: string): Promise<number | null>;
}

export interface SealCdp {
  send: CdpSend;
}

/** Frame ids hosted by sealed owner elements in `frameId`'s document; null when it cannot be read. */
async function sealedChildFrames(cdp: SealCdp, frames: SealableFrames, frameId: string) {
  try {
    const frame = frames.getFrame(frameId);
    const contextId = frame?.isolatedContextId ?? (await frames.ensureInjected(frameId));
    if (!frame || !contextId) return null;
    const call = (index: number, returnByValue: boolean) =>
      cdp.send(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: SEALED_OWNER_FN,
          arguments: [{ value: index }],
          executionContextId: contextId,
          returnByValue,
        },
        frame.sessionId,
      );
    const counted = await call(-1, true);
    const count = counted.result.value;
    if (typeof count !== "number") return null;
    const sealed = new Set<string>();
    for (let index = 0; index < count; index++) {
      const { result } = await call(index, false);
      if (!result.objectId) continue;
      try {
        const { node } = await cdp.send("DOM.describeNode", { objectId: result.objectId }, frame.sessionId);
        if (node.frameId) sealed.add(node.frameId);
      } finally {
        await cdp.send("Runtime.releaseObject", { objectId: result.objectId }, frame.sessionId).catch(() => {});
      }
    }
    return sealed;
  } catch {
    return null;
  }
}

/**
 * The sealed frames among `entries` (parents listed before children, as collectDescendantFrames
 * returns them). A frame is sealed when its owner element is sealed, when its parent frame is
 * sealed, or when its parent's owners cannot be read: an unverifiable frame is withheld.
 */
export async function collectSealedFrames(
  cdp: SealCdp,
  frames: SealableFrames,
  entries: ReadonlyArray<{ frameId: string; parentFrameId: string | null }>,
) {
  const parents = [...new Set(entries.flatMap(({ parentFrameId }) => (parentFrameId ? [parentFrameId] : [])))];
  const owned = new Map(
    await Promise.all(parents.map(async (parent) => [parent, await sealedChildFrames(cdp, frames, parent)] as const)),
  );
  const sealed = new Set<string>();
  for (const { frameId, parentFrameId } of entries) {
    if (!parentFrameId) continue;
    const children = owned.get(parentFrameId);
    if (sealed.has(parentFrameId) || !children || children.has(frameId)) sealed.add(frameId);
  }
  for (const frameId of sealed) {
    const record = frames.getFrame(frameId);
    if (record) record.sealedOwner = true;
  }
  return sealed;
}

export async function isInSealedFrame(cdp: SealCdp, frames: SealableFrames, frameId: string | undefined) {
  for (let child = frameId; child;) {
    const parent = frames.getFrame(child)?.parentFrameId;
    if (!parent) return false;
    const children = await sealedChildFrames(cdp, frames, parent);
    if (!children || children.has(child)) {
      const record = frameId ? frames.getFrame(frameId) : undefined;
      if (record) record.sealedOwner = true;
      return true;
    }
    child = parent;
  }
  return false;
}
