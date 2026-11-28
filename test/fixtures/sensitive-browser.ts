import assert from "node:assert/strict";
import { globSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectPipe } from "../../src/index.ts";
import { removeTreeSync } from "./remove-tree.ts";

// The live browser the data-sensitive (#379) test files share. A file starts it from its first
// test, not a before() hook: bun gives hooks the test limit and ignores a hook's timeout option
// (killed at 5003 ms on bun 1.4.5 in both argument orders), and that hook timed out on a Windows
// runner. Not while the module loads either: a run whose filter selects no test would launch a
// browser and leave its profile behind. Each file passes releaseSensitiveBrowser to after(): it
// releases newest first, the browser before its user-data dir, collecting failures instead of
// stranding the rest.

function findHeadlessShell() {
  const home = process.env["HOME"] ?? "";
  const candidates = [
    ...globSync(
      path.join(
        home,
        "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell",
      ),
    ),
    ...globSync(
      path.join(
        home,
        ".cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell",
      ),
    ),
  ];
  return candidates.toSorted().at(-1);
}

const SHELL = process.env["SHELL_BIN"] ?? findHeadlessShell();

export const skipWithoutShell = !SHELL && "no chromium binary found";

export const PLACEHOLDER = "[redacted: sensitive]";

type PipeBrowser = Awaited<ReturnType<typeof connectPipe>>;
export type PipePage = Awaited<ReturnType<PipeBrowser["newTab"]>>;

type Release = () => unknown;
const releases: Release[] = [];
let shared: Promise<PipeBrowser> | undefined;

async function start(): Promise<PipeBrowser> {
  assert.ok(SHELL, "no chromium binary found");
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-sensitive-"));
  releases.push(() => removeTreeSync(ud));
  const browser = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
    storageRoot: ud,
  });
  releases.push(() => browser.close());
  return browser;
}

export async function releaseSensitiveBrowser() {
  await shared?.catch(() => undefined);
  shared = undefined;
  const failures: unknown[] = [];
  for (const step of releases.splice(0).toReversed()) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, "the sensitive-redaction fixture did not release cleanly");
}

export async function openSensitiveTab(): Promise<PipePage> {
  shared ??= start();
  const browser = await shared;
  return await browser.newTab("about:blank");
}

export function assertNoWords(what: string, value: unknown, words: readonly string[]) {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  for (const word of words) assert.ok(!text.includes(word), `${what} leaked "${word}": ${text}`);
}
