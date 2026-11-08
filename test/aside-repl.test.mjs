import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AsideReplError,
  AsideUnavailable,
  asideAvailable,
  connectAside,
  parseAsideRepl,
} from "../src/aside-repl.js";

// Captured from `aside repl` 1.26.916.1741 on 2026-11-08, ANSI escapes included.
const CAPTURED_TITLE = `\u001B[2m✔︎ Opened a new tab and set it active: tabs[0], page → Example Domain (https://example.com/)\u001B[0m\nExample Domain\n\u001B[2m[ok | 1304ms]\u001B[0m`;
const CAPTURED_ERROR = `\u001B[31mReferenceError: 'getTabs' is not defined\n    at <eval> (repl.js:1:20)\u001B[0m\n\u001B[31m[error | 16ms]\u001B[0m`;

function stubDir(t, body) {
  const dir = mkdtempSync(path.join(tmpdir(), "omowright-aside-"));
  const file = path.join(dir, "aside-stub.mjs");
  writeFileSync(file, body);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return [process.execPath, file];
}

const ECHO_ARGV = `const args = process.argv.slice(2);
console.log(JSON.stringify(args));
console.log("[ok | 1ms]");
`;

test("the trailing marker decides success, not the exit code", () => {
  const ok = parseAsideRepl(CAPTURED_TITLE, 0);
  assert.equal(ok.ok, true);
  assert.equal(ok.ms, 1304);
  assert.equal(ok.lines.at(-1), "Example Domain");
  assert.ok(!ok.output.includes("\u001B["), "ANSI escapes are stripped before anyone prints this");

  const failed = parseAsideRepl(CAPTURED_ERROR, 0);
  assert.equal(failed.ok, false);
  assert.equal(failed.ms, 16);
  assert.match(failed.output, /ReferenceError: 'getTabs' is not defined/);
});

test("output with no marker is not a success, even at exit 0", () => {
  assert.equal(parseAsideRepl("", 0).status, "unknown");
  assert.equal(parseAsideRepl("garbage", 0).ok, false);
  assert.equal(parseAsideRepl("garbage", 1).status, "error");
});

test("aside --version is the availability probe", async (t) => {
  const ok = await asideAvailable({ bin: stubDir(t, `console.log("1.26.916.1741");\n`) });
  assert.equal(ok.available, true);
  assert.equal(ok.version, "1.26.916.1741");

  const missing = await asideAvailable({ bin: path.join(tmpdir(), "omowright-aside-does-not-exist") });
  assert.equal(missing.available, false);
  assert.ok(missing.reason.length > 0);
});

test("connectAside refuses an unusable CLI instead of handing back a session", async () => {
  await assert.rejects(
    connectAside({ bin: path.join(tmpdir(), "omowright-aside-does-not-exist") }),
    AsideUnavailable,
  );
});

test("the code runs as the last repl argument, after any host and account flags", async (t) => {
  const bin = stubDir(t, ECHO_ARGV);
  const plain = await connectAside({ bin });
  assert.deepEqual(JSON.parse((await plain.run("1+1")).output), ["repl", "1+1"]);

  const scoped = await connectAside({ bin, host: "my-macbook", account: "u1" });
  assert.deepEqual(JSON.parse((await scoped.run("1+1")).output), [
    "repl",
    "--host",
    "my-macbook",
    "--account",
    "u1",
    "1+1",
  ]);
});

test("title() returns the printed title and refuses an error marker", async (t) => {
  const bin = stubDir(t, `console.log("Example Domain");\nconsole.log("[ok | 9ms]");\n`);
  assert.equal(await (await connectAside({ bin })).title("https://example.com"), "Example Domain");

  const failing = stubDir(t, `console.log("ReferenceError: openTab is not defined");\nconsole.log("[error | 2ms]");\n`);
  const session = await connectAside({ bin: failing });
  await assert.rejects(session.title("https://example.com"), AsideReplError);
});

test("a repl script that fails is reported with its own output", async (t) => {
  const bin = stubDir(t, `console.log("boom");\nconsole.log("[error | 3ms]");\n`);
  const result = await (await connectAside({ bin })).run("throw new Error('boom')");
  assert.equal(result.ok, false);
  assert.equal(result.output, "boom");
});
