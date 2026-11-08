import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentTabs } from "../src/index.ts";
import { reconcileFrames, snapshotWithFrames } from "../src/frames-snapshot.ts";
import {
  SHELL,
  childFrameOf,
  clickUntilChildObserves,
  launch,
  startFixtureServers,
  waitForChildContent,
  waitUntil,
} from "./fixtures/oopif-harness.ts";

type RefMeta = { name?: string; tagName?: string };
type PageSnapshot = { tree: string; refs: Record<string, RefMeta>; missingFrames?: unknown };

const live = { skip: !SHELL && "no chromium binary found", timeout: 60_000 };

test("fresh navigation keeps the OOPIF child stitched and clickable", live, async () => {
  const fixtures = await startFixtureServers();
  const { connection, cleanup } = await launch();
  try {
    const { page } = await createAgentTabs(connection).create("about:blank");
    await page.goto(fixtures.urlFor("oopif-parent.html"));
    const child = await waitForChildContent(page);

    // The frame was attached while the page was already under FrameManager control,
    // so there is nothing to reconcile: this guards against double-attaching.
    assert.deepEqual(await reconcileFrames(page), []);

    const snapshot = await snapshotWithFrames<PageSnapshot>(page);
    assert.match(snapshot.tree, /- iframe \[ref=e\d+\]:/, snapshot.tree);
    assert.ok(snapshot.tree.includes(`button "Inside" [ref=f1e1]`), snapshot.tree);
    assert.equal(snapshot.refs.f1e1?.name, "Inside");
    assert.equal(snapshot.refs.f1e1?.tagName, "BUTTON");
    assert.equal(snapshot.missingFrames, undefined);

    assert.equal(await clickUntilChildObserves(page, "f1e1", child.frameId, "data-clicked"), "1");

    const scoped = await snapshotWithFrames<PageSnapshot>(page, { ref: "f1e1" });
    assert.ok(scoped.tree.includes(`button "Inside" [ref=f1e1]`), scoped.tree);
    assert.ok(!scoped.tree.includes("Outside"), scoped.tree);
  } finally {
    await cleanup();
    await fixtures.close();
  }
});

test("open shadow roots are pierced, closed shadow roots stay opaque", live, async () => {
  const fixtures = await startFixtureServers();
  const { connection, cleanup } = await launch();
  try {
    const { page } = await createAgentTabs(connection).create("about:blank");
    await page.goto(fixtures.urlFor("oopif-shadow.html"));

    const snapshot = await snapshotWithFrames<PageSnapshot>(page);
    assert.ok(snapshot.tree.includes(`button "Shadow"`), snapshot.tree);
    assert.ok(snapshot.tree.includes(`button "Light"`), snapshot.tree);
    assert.ok(!snapshot.tree.includes("Closed"), snapshot.tree);
    assert.equal(childFrameOf(page), null);

    const shadowRef = Object.entries(snapshot.refs).find(([, meta]) => meta.name === "Shadow")?.[0];
    assert.ok(shadowRef, JSON.stringify(snapshot.refs));
    await page.locator(shadowRef).click();
    const clicked = await waitUntil(() => page.evaluate(() => document.body.getAttribute("data-shadow-clicked")), {
      label: "body[data-shadow-clicked]",
      timeoutMs: 10_000,
    });
    assert.equal(clicked, "1");
  } finally {
    await cleanup();
    await fixtures.close();
  }
});
