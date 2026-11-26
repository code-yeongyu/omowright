import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { connectPipe, createAgentTabs } from "../src/index.ts";
import { emulate } from "../src/emulate.ts";
import { SHELL } from "./fixtures/oopif-harness.ts";
import { removeTreeSync } from "./fixtures/remove-tree.ts";

// Public contract (#338): a device set with emulate() stays the page's viewport across same-origin and
// cross-origin navigation until emulate(page, null). Each read waits for the agent tab's own viewport
// re-pin after the navigation, the command that used to put the desktop default back.
// One browser and one fixture server serve the file, started by the first test that runs and released in
// after(). Not in a before() hook: bun gives hooks the test limit and ignores a hook's timeout option, and
// that hook timed out on a Windows runner. Not while the module loads either: a run whose filter selects
// no test here would launch a browser and leave its profile behind (#352, #362).
// Each resource is registered for release the moment it exists, and release runs newest first through
// every step even when one throws, so a failure half way through startup or teardown strands nothing (#366).
const skip = !SHELL && "no chromium binary found";
const repins: Array<() => void> = [];
type Release = () => unknown;

async function releaseAll(steps: readonly Release[]) {
  const failures: unknown[] = [];
  for (const step of steps.toReversed()) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "the navigation fixture did not release cleanly");
}

async function start(browserPath: string, release: Release[]) {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end('<!doctype html><meta name="viewport" content="width=device-width"><p>page</p>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  release.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "the fixture server has no TCP port");
  const profile = mkdtempSync(path.join(tmpdir(), "omowright-emulate-nav-test-"));
  release.push(() => removeTreeSync(profile));
  const connection = await connectPipe({
    browserPath,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${profile}`],
    storageRoot: profile,
  });
  release.push(() => connection.close());
  const send = connection.cdp.send.bind(connection.cdp);
  Reflect.set(connection.cdp, "send", async (method: string, params?: object, sessionId?: string, options?: object) => {
    const result = await send(method, params, sessionId, options);
    if (method === "Emulation.setDeviceMetricsOverride") repins.shift()?.();
    return result;
  });
  return {
    tabs: createAgentTabs(connection),
    first: `http://127.0.0.1:${address.port}`,
    second: `http://localhost:${address.port}`,
  };
}

const acquired: Release[] = [];
let shared: ReturnType<typeof start> | undefined;

after(async () => {
  await shared?.catch(() => undefined);
  await releaseAll(acquired);
});

async function openAgentTab() {
  assert.ok(SHELL, "no chromium binary found");
  shared ??= start(SHELL, acquired);
  const live = await shared;
  const page = (await live.tabs.create("about:blank")).page;
  const widthAfterGoto = async (url: string) => {
    const signal = AbortSignal.timeout(10_000);
    const repinned = new Promise<void>((resolve, reject) => {
      repins.push(resolve);
      signal.addEventListener("abort", () => reject(new Error(`no viewport re-pin after goto ${url}`)));
    });
    // domcontentloaded is event-driven; the default "interactive" readiness adds a fixed DOM-quiet window per
    // navigation, which is not under test.
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await repinned;
    return await page.evaluate(() => innerWidth);
  };
  return { page, widthAfterGoto, first: live.first, second: live.second };
}

test("emulate(page, null) gives the agent tab its default viewport back on the next navigation", { skip }, async () => {
  const { page, widthAfterGoto, first } = await openAgentTab();
  try {
    await emulate(page, "iphone-14");
    assert.equal(await widthAfterGoto(`${first}/emulated`), 390, "the device is in force after a goto");

    await emulate(page, null);

    assert.equal(await widthAfterGoto(`${first}/restored`), 1440, "emulate(page, null) gave the default back");
  } finally {
    await page.close();
  }
});

test("an emulated device survives same-origin and cross-origin navigation", { skip }, async () => {
  const { page, widthAfterGoto, first, second } = await openAgentTab();
  try {
    assert.equal(await widthAfterGoto(`${first}/start`), 1440, "the agent tab starts at its default viewport");

    await emulate(page, "iphone-14");

    assert.equal(await widthAfterGoto(`${first}/same-origin`), 390, "same-origin goto kept the device");
    assert.equal(await widthAfterGoto(`${second}/cross-origin`), 390, "cross-origin goto kept the device");
  } finally {
    await page.close();
  }
});
