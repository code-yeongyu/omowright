import { after, before, test } from "node:test";
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
// The browser and the fixture server start once for the file and each test opens its own agent tab: launching a
// browser inside a test that also navigated four times outran the runner's limit on a loaded host (#352).
type Connection = Awaited<ReturnType<typeof connectPipe>>;
type Live = {
  readonly connection: Connection;
  readonly tabs: ReturnType<typeof createAgentTabs>;
  readonly first: string;
  readonly second: string;
};

const skip = !SHELL && "no chromium binary found";
const server = createServer((_request, response) => {
  response.setHeader("content-type", "text/html");
  response.end('<!doctype html><meta name="viewport" content="width=device-width"><p>page</p>');
});
const repins: Array<() => void> = [];
let profile: string | undefined;
let live: Live | undefined;

before(async () => {
  if (!SHELL) return;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "the fixture server has no TCP port");
  profile = mkdtempSync(path.join(tmpdir(), "omowright-emulate-nav-test-"));
  const connection = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${profile}`],
    storageRoot: profile,
  });
  const send = connection.cdp.send.bind(connection.cdp);
  Reflect.set(connection.cdp, "send", async (method: string, params?: object, sessionId?: string, options?: object) => {
    const result = await send(method, params, sessionId, options);
    if (method === "Emulation.setDeviceMetricsOverride") repins.shift()?.();
    return result;
  });
  live = {
    connection,
    tabs: createAgentTabs(connection),
    first: `http://127.0.0.1:${address.port}`,
    second: `http://localhost:${address.port}`,
  };
});

after(async () => {
  if (live) await live.connection.close();
  if (profile !== undefined) removeTreeSync(profile);
  server.close();
});

async function openAgentTab() {
  assert.ok(live, "the shared browser did not start");
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

test("an emulated device survives same-origin and cross-origin navigation", { skip }, async () => {
  const { page, widthAfterGoto, first, second } = await openAgentTab();
  try {
    await emulate(page, "iphone-14");

    assert.equal(await widthAfterGoto(`${first}/same-origin`), 390, "same-origin goto kept the device");
    assert.equal(await widthAfterGoto(`${second}/cross-origin`), 390, "cross-origin goto kept the device");
  } finally {
    await page.close();
  }
});

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
