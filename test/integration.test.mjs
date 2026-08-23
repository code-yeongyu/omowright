import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, globSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { connectPipe, compactSnapshot } from "../src/index.js";

function findHeadlessShell() {
  const home = process.env.HOME;
  const candidates = globSync(
    path.join(home, "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
  );
  if (candidates.length > 0) return candidates.sort().at(-1);
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chrome)) return chrome;
  return null;
}

const SHELL = process.env.SHELL_BIN ?? findHeadlessShell();

test("pipe transport drives Chromium with zero listening TCP ports", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const ud = mkdtempSync(path.join(tmpdir(), "asidewright-test-"));
  const connection = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
    storageRoot: ud,
  });
  try {
    const pid = connection.browserProcess?.pid;
    assert.ok(pid > 0, "browser process pid");

    let listenOutput = "";
    try {
      listenOutput = execFileSync("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", String(pid)], { encoding: "utf8" });
    } catch (error) {
      assert.equal(error.status, 1, "lsof found no listening ports");
    }
    assert.equal(listenOutput.trim(), "", "browser must not listen on any TCP port");

    const page = await connection.newTab("about:blank");
    await page.goto("https://example.com");
    assert.equal(await page.title(), "Example Domain");
    assert.equal(page.url(), "https://example.com/");

    const snapshot = await page.snapshot();
    const tree = compactSnapshot(snapshot);
    assert.ok(tree.includes('heading "Example Domain"'));
    assert.ok(tree.includes("[ref=e1]"));

    const fullBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    const compactBytes = Buffer.byteLength(tree, "utf8");
    assert.ok(compactBytes < fullBytes, "compact tree smaller than full snapshot");

    const locator = page.locator("e1");
    assert.equal(typeof locator.click, "function");
  } finally {
    await connection.close();
    rmSync(ud, { recursive: true, force: true });
  }
});
