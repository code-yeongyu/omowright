import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AsideReplError, connectAside } from "../src/index.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-aside-repl.mjs");
const asideCommand = [process.execPath, FAKE];

// The Aside engine's public contract over the REPL protocol: one child keeps state across
// calls, multi-line source runs as one call, results come back as JSON values separate
// from console output, and the banner names the account.
test("connectAside keeps one REPL session and returns each call's value apart from its logs", async () => {
  const aside = await connectAside({ asideCommand, account: "u1" });
  try {
    assert.equal(aside.engine, "aside");
    assert.equal(aside.account, "u1");
    assert.equal(await aside.run("globalThis.omowCount = 41;\nreturn null;"), null);
    const { value, logs } = await aside.runWithLogs('console.log("from the page");\nreturn { next: globalThis.omowCount + 1 };');
    assert.deepEqual(value, { next: 42 });
    assert.deepEqual(logs, ["from the page"]);
  } finally {
    await aside.close();
  }
});

// The REPL's [error] marker is the only failure signal; a call that throws must reject with
// the REPL's own message, and the session must stay usable for the next call.
test("a failing call rejects with AsideReplError and the session keeps working", async () => {
  const aside = await connectAside({ asideCommand });
  try {
    await assert.rejects(aside.run('throw new Error("no such tab")'), (error) => {
      assert.ok(error instanceof AsideReplError);
      assert.equal(error.code, "repl_error");
      assert.match(error.message, /no such tab/);
      return true;
    });
    assert.equal(await aside.run("return 7"), 7);
    await assert.rejects(aside.run("return () => 1"), (error) => error instanceof AsideReplError && error.code === "repl_unserializable");
    assert.equal(await aside.run("return 8"), 8);
  } finally {
    await aside.close();
  }
});

// open() makes the tab the REPL's current page, and snapshot({ find }) applies omowright's
// search to Aside's tree, so the agent reads only the matching lines.
test("open and snapshot with find narrow Aside's tree to the matching lines", async () => {
  const aside = await connectAside({ asideCommand });
  try {
    await assert.rejects(aside.snapshot(), /no current page/);
    assert.deepEqual(await aside.open("https://example.com/"), { url: "https://example.com/", title: "Title of https://example.com/" });
    const full = await aside.snapshot();
    assert.equal(full.tree.split("\n").length, 4);
    assert.equal(full.diff, "");
    assert.deepEqual(await aside.snapshot({ find: "pay", context: 0 }), {
      tree: '- link "Pay later" [ref=e1]\n...\n- button "Pay now" [ref=e2]',
      find: { query: "pay", matches: 2 },
    });
    await assert.rejects(aside.snapshot({ context: 1 }), TypeError);
  } finally {
    await aside.close();
  }
});

// Page output can contain the prompt text, and the pipe can split right after it; the call
// must still end at its own [ok] marker, and the next call must read its own answer.
test("output that contains the prompt text and arrives split keeps calls in step", async () => {
  const aside = await connectAside({ asideCommand });
  try {
    const { value, logs } = await aside.runWithLogs('await splitWrite("tricky repl > ", "tail\\n");\nreturn 5;');
    assert.equal(value, 5);
    assert.deepEqual(logs, ["tricky repl > tail"]);
    assert.equal(await aside.run("return 6"), 6);
  } finally {
    await aside.close();
  }
});

// A call that outlives its budget leaves the REPL mid-evaluation, so the session must fail
// it with a timeout and refuse later calls instead of reading a stale answer.
test("a call past its timeout fails and closes the session", async () => {
  const aside = await connectAside({ asideCommand, callTimeoutMs: 300 });
  await assert.rejects(aside.run("await new Promise(() => {});\nreturn 1;"), (error) => error instanceof AsideReplError && error.code === "repl_timeout");
  await assert.rejects(aside.run("return 1"), (error) => error instanceof AsideReplError && error.code === "repl_closed");
  await aside.close();
});

test("connectAside names the missing CLI instead of failing to spawn", async () => {
  await assert.rejects(connectAside({ autoSetup: false, env: { PATH: "" }, home: "/nonexistent" }), (error) => error instanceof AsideReplError && error.code === "aside_not_found");
});
