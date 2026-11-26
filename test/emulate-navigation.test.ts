import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { connectPipe, createAgentTabs } from "../src/index.ts";
import { emulate } from "../src/emulate.ts";
import { SHELL } from "./fixtures/oopif-harness.ts";
import { removeTreeSync } from "./fixtures/remove-tree.ts";

type AgentTabPage = Awaited<ReturnType<ReturnType<typeof createAgentTabs>["create"]>>["page"];
type Origins = { readonly first: string; readonly second: string };
type WidthAfterGoto = (url: string) => Promise<number>;

// Public contract (#338): a device set with emulate() stays the page's viewport across same-origin and
// cross-origin navigation until emulate(page, null). Each read waits for the agent tab's own viewport
// re-pin after the navigation, the command that used to put the desktop default back. One behavior per
// test: a single test with a live browser and four navigations outran the runner's limit on a loaded host (#352).
async function withAgentTab(
  run: (page: AgentTabPage, widthAfterGoto: WidthAfterGoto, origins: Origins) => Promise<void>,
): Promise<void> {
  assert.ok(SHELL, "live test ran without a Chromium binary");
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end('<!doctype html><meta name="viewport" content="width=device-width"><p>page</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "the fixture server has no TCP port");
  const origins = { first: `http://127.0.0.1:${address.port}`, second: `http://localhost:${address.port}` };
  let connection;
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-emulate-nav-test-"));
  try {
    connection = await connectPipe({
      browserPath: SHELL,
      browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
      storageRoot: ud,
    });
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    const send = connection.cdp.send.bind(connection.cdp);
    const repins: Array<() => void> = [];
    Reflect.set(
      connection.cdp,
      "send",
      async (method: string, params?: object, sessionId?: string, options?: object) => {
        const result = await send(method, params, sessionId, options);
        if (method === "Emulation.setDeviceMetricsOverride") repins.shift()?.();
        return result;
      },
    );
    const widthAfterGoto: WidthAfterGoto = async (url) => {
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
    await run(page, widthAfterGoto, origins);
  } finally {
    if (connection) await connection.close();
    removeTreeSync(ud);
    server.close();
  }
}

test(
  "an emulated device survives same-origin and cross-origin navigation",
  { skip: !SHELL && "no chromium binary found" },
  async () => {
    await withAgentTab(async (page, widthAfterGoto, origins) => {
      await emulate(page, "iphone-14");

      assert.equal(await widthAfterGoto(`${origins.first}/same-origin`), 390, "same-origin goto kept the device");
      assert.equal(await widthAfterGoto(`${origins.second}/cross-origin`), 390, "cross-origin goto kept the device");
    });
  },
);

test(
  "emulate(page, null) gives the agent tab its default viewport back on the next navigation",
  { skip: !SHELL && "no chromium binary found" },
  async () => {
    await withAgentTab(async (page, widthAfterGoto, origins) => {
      await emulate(page, "iphone-14");
      assert.equal(await widthAfterGoto(`${origins.first}/emulated`), 390, "the device is in force after a goto");

      await emulate(page, null);

      assert.equal(await widthAfterGoto(`${origins.first}/restored`), 1440, "emulate(page, null) gave the default back");
    });
  },
);
