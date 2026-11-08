import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectCloakProfile, findCloakBrowserPath } from "../src/index.ts";

type SmokeContext = { profileDir: string; url: string };
type EvalPage = { evaluate(expression: string): Promise<unknown> };
type ProbeState = { webdriver?: boolean; value?: string | null };

// newTab(url) resolves once the target is attached, which can be before the smoke server's document
// commits; on the initial opaque origin localStorage throws SecurityError. The profile contract is
// about the smoke origin, so every probe waits until the page reports that origin and a parsed document.
async function waitForSmokeOrigin(page: EvalPage, url: string, deadline = Date.now() + 15_000): Promise<void> {
  const expected = new URL(url).origin;
  const state = (await page
    .evaluate("({ origin: location.origin, ready: document.readyState })")
    .catch(() => null)) as { origin?: string; ready?: string } | null;
  if (state?.origin === expected && state.ready !== "loading") return;
  if (Date.now() >= deadline) throw Error(`page never reached ${expected}: last state ${JSON.stringify(state)}`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return waitForSmokeOrigin(page, url, deadline);
}

async function openSmokePage(connection: { newTab(url: string): Promise<EvalPage> }, url: string): Promise<EvalPage> {
  const page = await connection.newTab(url);
  await waitForSmokeOrigin(page, url);
  return page;
}

async function withSmokeServer(run: (context: SmokeContext) => Promise<void>) {
  const profileDir = mkdtempSync(path.join(tmpdir(), "omowright-cloak-e2e-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>profile smoke</title><main>ready</main>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run({ profileDir, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(profileDir, { recursive: true, force: true });
  }
}

let cloakBrowser: string | undefined;
try {
  cloakBrowser = findCloakBrowserPath();
} catch {
  cloakBrowser = undefined;
}
const BROWSER = process.env.CLOAKBROWSER_BIN ?? cloakBrowser;

const probe = `(() => ({ webdriver: navigator.webdriver, value: localStorage.getItem("omowright-profile-smoke") }))()`;

// connectCloakProfile resolves CLOAKBROWSER_BIN first, so this contract runs on any Chromium (CI uses chrome-headless-shell).
test(
  "a cloak profile reuses site state and its fingerprint seed across reloads",
  { skip: !BROWSER && "no Chromium binary found", timeout: 60000 },
  async () => {
    await withSmokeServer(async ({ profileDir, url }) => {
      const first = await connectCloakProfile({ profileDir, fingerprintSeed: 31415 });
      const firstPage = await openSmokePage(first, url);
      await firstPage.evaluate(`localStorage.setItem("omowright-profile-smoke", "persisted")`);
      await first.close();

      const second = await connectCloakProfile({ profileDir });
      const secondState = (await (await openSmokePage(second, url)).evaluate(probe)) as ProbeState;
      await second.close();

      const metadata = JSON.parse(readFileSync(path.join(profileDir, ".omowright-cloak.json"), "utf8"));
      assert.equal(secondState.value, "persisted");
      assert.equal(metadata.fingerprintSeed, 31415);
    });
  },
);

// navigator.webdriver === false is CloakBrowser's own patch; a stock Chromium reports true, so this needs the real binary.
test(
  "CloakBrowser hides navigator.webdriver on a reused profile",
  { skip: !cloakBrowser && "no CloakBrowser binary installed", timeout: 60000 },
  async () => {
    await withSmokeServer(async ({ profileDir, url }) => {
      const first = await connectCloakProfile({ browserPath: cloakBrowser, profileDir, fingerprintSeed: 31415 });
      const firstState = await (
        await openSmokePage(first, url)
      ).evaluate(`(() => { localStorage.setItem("omowright-profile-smoke", "persisted"); return ${probe}; })()`);
      await first.close();

      const second = await connectCloakProfile({ browserPath: cloakBrowser, profileDir });
      const secondState = await (await openSmokePage(second, url)).evaluate(probe);
      await second.close();

      assert.deepEqual(firstState, { webdriver: false, value: "persisted" });
      assert.deepEqual(secondState, { webdriver: false, value: "persisted" });
    });
  },
);
