// OOPIF-aware snapshots.
//
// core.js already snapshots every frame its FrameManager knows about, prefixes child refs
// with f<N>, stitches the child trees into the parent tree and routes page.locator("f1e1")
// to the owning session. What it misses is an out-of-process iframe that already existed
// when the page was attached (attach-to-existing-tab, reconnect): FrameManager.initialize()
// sends Target.setAutoAttach before it registers its Target.attachedToTarget listener, and
// the parent's Page.getFrameTree never lists OOPIF children, so nothing backfills them.
//
// reconcileFrames() closes that gap from the outside, using only public members, and
// snapshotWithFrames() is reconcile + page.snapshot(). Refs stay page-level: use
// page.locator(ref), not frame.locator(ref).

const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true };
const REF_PATTERN = /^(f\d+)?e\d+$/;

function detach(page, sessionId) {
  return page.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
}

async function iframeTargets(page) {
  const { targetInfo } = await page.cdp.send("Target.getTargetInfo", { targetId: page.targetId });
  const browserContextId = targetInfo?.browserContextId;
  const { targetInfos } = await page.cdp.send("Target.getTargets", { filter: [{ type: "iframe" }] });
  return targetInfos.filter(info => info.type === "iframe"
    && (!browserContextId || !info.browserContextId || info.browserContextId === browserContextId));
}

// Attach, then ask the child itself who its parent is: Page.getFrameTree on the child
// session is the only reliable attribution for an iframe target.
async function describeTarget(page, targetId) {
  const { sessionId } = await page.cdp.send("Target.attachToTarget", { targetId, flatten: true });
  try {
    await page.cdp.send("Page.enable", undefined, sessionId);
    const { frameTree } = await page.cdp.send("Page.getFrameTree", undefined, sessionId);
    return { sessionId, frame: frameTree.frame };
  } catch (error) {
    await detach(page, sessionId);
    throw error;
  }
}

async function adopt(page, sessionId, frame, parentFrameId) {
  await page.cdp.send("DOM.enable", undefined, sessionId);
  // Nested OOPIFs then arrive through core's own Target.attachedToTarget handler, which
  // accepts the event once one of its frames carries this session.
  await page.cdp.send("Target.setAutoAttach", AUTO_ATTACH, sessionId).catch(() => {});
  page.frameManager.frames.set(frame.id, {
    frameId: frame.id,
    parentFrameId,
    url: frame.url ?? "",
    name: frame.name ?? "",
    sessionId,
  });
  const isolatedContextId = await page.frameManager.ensureInjected(frame.id);
  return { frameId: frame.id, parentFrameId, url: frame.url ?? "", sessionId, isolatedContextId };
}

/**
 * Adopt every iframe target of this page that FrameManager does not know yet.
 * Returns the frames that were added (empty when there was nothing to recover).
 */
export async function reconcileFrames(page) {
  const fm = page.frameManager;
  const added = [];
  let pending = (await iframeTargets(page)).filter(info => !fm.frames.has(info.targetId));
  let progress = true;
  while (progress && pending.length > 0) {
    progress = false;
    const retry = [];
    for (const target of pending) {
      if (fm.frames.has(target.targetId)) continue;
      const { sessionId, frame } = await describeTarget(page, target.targetId);
      const parentFrameId = frame.parentId ?? null;
      if (!parentFrameId || !fm.frames.has(parentFrameId)) {
        // Not ours (another tab), or its parent is itself still pending: never adopt a
        // frame we cannot attribute to this page.
        await detach(page, sessionId);
        if (parentFrameId) retry.push(target);
        continue;
      }
      added.push(await adopt(page, sessionId, frame, parentFrameId));
      progress = true;
    }
    pending = retry;
  }
  return added;
}

// Mirrors core's prefix assignment: main frame "", the remaining frames f1..fN in the
// BFS order of collectDescendantFrames.
function framePrefixes(fm) {
  let counter = 1;
  return fm.collectDescendantFrames(fm.mainFrameId)
    .map(({ frameId }) => ({ frameId, prefix: frameId === fm.mainFrameId ? "" : `f${counter++}` }));
}

// Diagnostics only: a frame that contributed no ref *and* has no isolated world is a frame
// the snapshot could not enter. Frames that are merely empty keep their world, so they are
// not reported.
function collectMissingFrames(page, refs) {
  const seen = new Set(Object.keys(refs ?? {}).map(ref => ref.match(REF_PATTERN)?.[1] ?? ""));
  const missing = [];
  for (const { frameId, prefix } of framePrefixes(page.frameManager)) {
    if (prefix === "" || seen.has(prefix)) continue;
    const frame = page.frameManager.getFrame(frameId);
    if (frame?.isolatedContextId) continue;
    missing.push({ frameId, url: frame?.url ?? "", injected: false });
  }
  return missing;
}

/**
 * page.snapshot() with pre-existing out-of-process iframes recovered first.
 * Adds `missingFrames` only when a frame could not be entered at all.
 */
export async function snapshotWithFrames(page, opts = {}) {
  await reconcileFrames(page);
  const result = await page.snapshot(opts);
  const missingFrames = collectMissingFrames(page, result.refs);
  return missingFrames.length > 0 ? { ...result, missingFrames } : result;
}
