import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AsideReplError,
  AsideSession,
  BskSession,
  ENGINE_ORDER,
  NoBrowserEngineError,
  connectBrowser,
} from "../src/index.ts";
import { stubClient } from "./fixtures/bsk-stub-client.ts";

const FAKE_ASIDE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-aside-repl.ts");
const bskWithBrowser = () =>
  stubClient({
    "system.status": { browsers: [{ instance_id: "b1", browser_name: "chrome" }] },
    "session.start": { session_id: "s1", browser_instance_id: "b1" },
  });

// The priority order is the contract agents are steered by: the user's agent browsers first,
// then the user's own browser, then the owned CloakBrowser.
test("connectBrowser takes the first engine in priority order and reports each attempt", async () => {
  assert.deepEqual(ENGINE_ORDER, ["aside", "ego", "bsk", "cloak"]);
  const { engine, handle, attempts } = await connectBrowser({
    aside: { asideCommand: [process.execPath, FAKE_ASIDE] },
    bsk: { client: bskWithBrowser() },
  });
  try {
    assert.equal(engine, "aside");
    assert.ok(handle instanceof AsideSession);
    assert.equal(attempts.length, 4);
    const [aside, ...rest] = attempts;
    assert.equal(aside?.ok, true);
    assert.equal(aside?.verified, "aside repl evaluated a probe call");
    assert.ok(Number.isInteger(aside?.ms) && (aside?.ms ?? -1) >= 0);
    assert.deepEqual(
      rest.map((a) => [a.engine, a.ok, a.reason]),
      [
        ["ego", false, "not tried: aside connected first"],
        ["bsk", false, "not tried: aside connected first"],
        ["cloak", false, "not tried: aside connected first"],
      ],
    );
  } finally {
    if (handle instanceof AsideSession) await handle.close();
  }
});

// An engine the user has not set up is skipped with the step only they can take, and the next
// engine in order connects; the caller gets both so it can relay that step.
test("a skipped engine carries its reason and the next engine connects", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "omow-pick-"));
  try {
    const { engine, handle, attempts } = await connectBrowser({
      aside: { home, env: { PATH: "" } },
      bsk: { client: bskWithBrowser() },
    });
    assert.equal(engine, "bsk");
    assert.ok(handle instanceof BskSession);
    assert.deepEqual(
      attempts.map((a) => [a.engine, a.ok]),
      [
        ["aside", false],
        ["ego", false],
        ["bsk", true],
        ["cloak", false],
      ],
    );
    assert.equal(attempts[2]?.verified, "BrowserSkill started session s1 in browser b1");
    assert.match(attempts[0]?.reason ?? "", /Aside/);
    assert.match(attempts[1]?.reason ?? "", /ego-browser nodejs/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// allow keeps an engine from running at all (the owned browser must never stand in for the
// user's session silently), prefer moves one engine first, and an all-failed run names every reason.
test("allow and prefer shape the order, and an all-failed run throws with every attempt", async () => {
  const { engine, handle, attempts } = await connectBrowser({
    prefer: "bsk",
    aside: { asideCommand: [process.execPath, FAKE_ASIDE] },
    bsk: { client: bskWithBrowser() },
  });
  assert.equal(engine, "bsk");
  assert.deepEqual(
    attempts.map((a) => [a.engine, a.ok]),
    [
      ["bsk", true],
      ["aside", false],
      ["ego", false],
      ["cloak", false],
    ],
  );
  assert.ok(handle instanceof BskSession);

  const home = mkdtempSync(path.join(tmpdir(), "omow-pick-"));
  try {
    await assert.rejects(
      connectBrowser({
        allow: ["aside", "ego", "bsk"],
        aside: { home, env: { PATH: "" } },
        bsk: { client: stubClient({ "system.status": { browsers: [] } }), waitForBrowserMs: 0 },
      }),
      (error) => {
        assert.ok(error instanceof NoBrowserEngineError);
        assert.deepEqual(
          error.attempts.map((a) => [a.engine, a.ok]),
          [
            ["aside", false],
            ["ego", false],
            ["bsk", false],
            ["cloak", false],
          ],
        );
        assert.match(error.attempts[2]?.reason ?? "", /no_browser_connected/);
        assert.equal(error.attempts[3]?.reason, "not allowed by the caller");
        return true;
      },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  await assert.rejects(connectBrowser({ prefer: "chrome" }), TypeError);
});

// crossCheck keeps going after the primary: every allowed engine that attaches comes back as a
// separate handle for comparison, attached lists all of them, and an engine that fails keeps
// its reason. The primary stays the first in priority order.
test("crossCheck attaches the remaining allowed engines, keeps every failure's reason, and closeAll closes them all", async () => {
  const bsk = bskWithBrowser();
  const result = await connectBrowser({
    crossCheck: true,
    allow: ["aside", "ego", "bsk"],
    aside: { asideCommand: [process.execPath, FAKE_ASIDE] },
    bsk: { client: bsk },
  });
  const { engine, handle, attempts, attached, crossCheck } = result;
  try {
    assert.equal(engine, "aside");
    assert.ok(handle instanceof AsideSession);
    assert.deepEqual(attached, ["aside", "bsk"]);
    assert.equal(crossCheck.length, 1);
    assert.equal(crossCheck[0]?.engine, "bsk");
    assert.ok(crossCheck[0]?.handle instanceof BskSession);
    assert.deepEqual(
      attempts.map((a) => [a.engine, a.ok]),
      [
        ["aside", true],
        ["ego", false],
        ["bsk", true],
        ["cloak", false],
      ],
    );
    assert.match(attempts[1]?.reason ?? "", /ego-browser nodejs/);
    assert.equal(attempts[3]?.reason, "not allowed by the caller");
  } finally {
    await result.closeAll();
  }
  assert.ok(bsk.calls.some((call) => call.method === "session.stop" && call.params?.["session_id"] === "s1"));
  assert.ok(handle instanceof AsideSession);
  await assert.rejects(
    handle.run("return 1"),
    (error: unknown) => error instanceof AsideReplError && error.code === "repl_closed",
  );
});
