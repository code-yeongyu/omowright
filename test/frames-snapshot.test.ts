import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentTabs } from "../src/index.ts";
import { reconcileFrames, snapshotWithFrames } from "../src/frames-snapshot.ts";
import type { FramesPage } from "../src/frames-snapshot.ts";
import type { OmOPage } from "../src/index.ts";
import {
  SHELL,
  childFrameOf,
  clickUntilChildObserves,
  launch,
  startFixtureServers,
  waitForChildContent,
  waitUntil,
} from "./fixtures/oopif-harness.ts";
import { field } from "./fixtures/read-field.ts";

const live = { skip: !SHELL && "no chromium binary found", timeout: 60_000 };

type PageSnapshot = Awaited<ReturnType<OmOPage["snapshot"]>>;
type TreeSnapshot = Extract<PageSnapshot, { tree: string }>;
type PageSnapshotOptions = Parameters<OmOPage["snapshot"]>[0];

function isTreeSnapshot(result: PageSnapshot): result is TreeSnapshot {
  return "tree" in result && typeof result.tree === "string";
}

// page.snapshot() answers a union (full tree, diff, text); these tests take no diff/text option,
// so every snapshot must be the full tree shape, and a different shape fails here.
function treeOf(result: PageSnapshot): TreeSnapshot {
  assert.ok(isTreeSnapshot(result), "page.snapshot() returned the full tree shape");
  return result;
}

// The page as reconcileFrames/snapshotWithFrames see it, with snapshot() narrowed to the tree shape.
// Every other member reads through to the live page.
function treeFramesPage(page: OmOPage): FramesPage<TreeSnapshot> {
  return {
    get targetId() {
      return page.targetId;
    },
    get cdp() {
      return page.cdp;
    },
    get frameManager() {
      return page.frameManager;
    },
    snapshot: async (options?: PageSnapshotOptions) => treeOf(await page.snapshot(options)),
  };
}

test("navigation drops the previous document's iframe before resolving roles", live, async () => {
  const fixtures = await startFixtureServers();
  let launched;
  try {
    launched = await launch();
    const { connection } = launched;
    const { page } = await createAgentTabs(connection).create("about:blank");
    const url = fixtures.urlFor("oopif-parent.html").replace("localhost", "127.0.0.1");
    await page.goto(url, { waitUntil: "load" });
    await Promise.all(page.frames().map((frame) => page.frameManager.ensureInjected(frame.frameId)));
    assert.equal(await page.getByRole("button", { name: "Inside", exact: true }).count(), 1);
    const previous = page.frames().find((frame) => frame.url() === fixtures.childUrl);
    assert.ok(previous);

    await page.goto(`${url}?second`, { waitUntil: "load" });
    await Promise.all(page.frames().map((frame) => page.frameManager.ensureInjected(frame.frameId)));
    assert.equal(await page.getByRole("button", { name: "Inside", exact: true }).count(), 1);
    assert.equal(page.frames().length, 2);
    assert.ok(!page.frames().some((frame) => frame.frameId === previous.frameId));
  } finally {
    await launched?.cleanup();
    await fixtures.close();
  }
});

test("fresh navigation keeps the OOPIF child stitched and clickable", live, async () => {
  const fixtures = await startFixtureServers();
  let launched;
  try {
    launched = await launch();
    const { connection } = launched;
    const { page } = await createAgentTabs(connection).create("about:blank");
    await page.goto(fixtures.urlFor("oopif-parent.html"));
    const framesPage = treeFramesPage(page);
    const child = await waitForChildContent(page);

    // The frame was attached while the page was already under FrameManager control,
    // so there is nothing to reconcile: this guards against double-attaching.
    assert.deepEqual(await reconcileFrames(framesPage), []);

    const snapshot = await snapshotWithFrames(framesPage);
    assert.match(snapshot.tree, /- iframe \[ref=e\d+\]:/, snapshot.tree);
    assert.ok(snapshot.tree.includes(`button "Inside" [ref=f1e1]`), snapshot.tree);
    assert.ok(snapshot.refs, "the snapshot carries refs");
    assert.equal(snapshot.refs["f1e1"]?.["name"], "Inside");
    assert.equal(snapshot.refs["f1e1"]?.tagName, "BUTTON");
    assert.equal(field(snapshot, "missingFrames"), undefined);

    assert.equal(await clickUntilChildObserves(page, "f1e1", child.frameId, "data-clicked"), "1");

    const scoped = await snapshotWithFrames(framesPage, { ref: "f1e1" });
    assert.ok(scoped.tree.includes(`button "Inside" [ref=f1e1]`), scoped.tree);
    assert.ok(!scoped.tree.includes("Outside"), scoped.tree);
  } finally {
    await launched?.cleanup();
    await fixtures.close();
  }
});

test("open shadow roots are pierced, closed shadow roots stay opaque", live, async () => {
  const fixtures = await startFixtureServers();
  let launched;
  try {
    launched = await launch();
    const { connection } = launched;
    const { page } = await createAgentTabs(connection).create("about:blank");
    await page.goto(fixtures.urlFor("oopif-shadow.html"));

    const snapshot = await snapshotWithFrames(treeFramesPage(page));
    assert.ok(snapshot.tree.includes(`button "Shadow"`), snapshot.tree);
    assert.ok(snapshot.tree.includes(`button "Light"`), snapshot.tree);
    assert.ok(!snapshot.tree.includes("Closed"), snapshot.tree);
    assert.equal(childFrameOf(page), null);

    assert.ok(snapshot.refs, "the snapshot carries refs");
    const shadowRef = Object.entries(snapshot.refs).find(([, meta]) => field(meta, "name") === "Shadow")?.[0];
    assert.ok(shadowRef, JSON.stringify(snapshot.refs));
    await page.locator(shadowRef).click();
    const clicked = await waitUntil(() => page.evaluate(() => document.body.getAttribute("data-shadow-clicked")), {
      label: "body[data-shadow-clicked]",
      timeoutMs: 10_000,
    });
    assert.equal(clicked, "1");
  } finally {
    await launched?.cleanup();
    await fixtures.close();
  }
});
