import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, globSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectPipe, createAgentTabs } from "../src/index.js";
import { createNetworkSnoop, collectWhileScrolling } from "../src/network-snoop.js";
import { startSnoopServer } from "./fixtures/snoop-server.mjs";

function findHeadlessShell() {
  const candidates = globSync(
    path.join(process.env.HOME, "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
  );
  if (candidates.length > 0) return candidates.sort().at(-1);
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chrome)) return chrome;
  return null;
}

const SHELL = process.env.SHELL_BIN ?? findHeadlessShell();

class FakeCdp {
  constructor() {
    this.calls = [];
    this.bodies = new Map();
    this.listeners = new Map();
  }
  on(method, listener) {
    const set = this.listeners.get(method) ?? new Set();
    set.add(listener);
    this.listeners.set(method, set);
    return () => set.delete(listener);
  }
  emit(method, params, meta = { sessionId: "s1" }) {
    for (const listener of [...this.listeners.get(method) ?? []]) listener(params, meta);
  }
  listenerCount() {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
  async send(method, params, sessionId) {
    this.calls.push({ method, params, sessionId });
    if (method === "Network.getResponseBody") return this.bodies.get(params.requestId) ?? { body: "", base64Encoded: false };
    return {};
  }
}

const fakePage = cdp => ({ cdp, resolveSessionId: async () => "s1" });
// setImmediate is a macrotask boundary: it drains every already-resolved microtask
// the snoop queued (session resolution, body fetches), without waiting on the clock.
const flush = () => new Promise(resolve => setImmediate(resolve));

function sendRequest(cdp, requestId, options = {}, meta) {
  const { url = "https://x.test/api/items", method = "GET", type = "XHR", postData = null } = options;
  cdp.emit("Network.requestWillBeSent", {
    requestId,
    request: { url, method, headers: { accept: "*/*" }, postData },
    type,
    wallTime: 1_700_000_000,
    timestamp: 1234.5,
  }, meta);
}

function sendResponse(cdp, requestId, options = {}, meta) {
  const { status = 200, statusText = "OK", mimeType = "application/json" } = options;
  cdp.emit("Network.responseReceived", {
    requestId,
    type: "XHR",
    response: { status, statusText, mimeType, headers: { "content-type": mimeType }, remoteIPAddress: "127.0.0.1" },
  }, meta);
}

function sendFinished(cdp, requestId, encodedDataLength = 12, meta) {
  cdp.emit("Network.loadingFinished", { requestId, encodedDataLength }, meta);
}

async function roundTrip(cdp, requestId, request = {}, response = {}, encodedDataLength = 12, meta) {
  sendRequest(cdp, requestId, request, meta);
  sendResponse(cdp, requestId, response, meta);
  sendFinished(cdp, requestId, encodedDataLength, meta);
  await flush();
}

test("snoop records a full request lifecycle and fetches the response body", async () => {
  const cdp = new FakeCdp();
  cdp.bodies.set("r1", { body: '{"ok":true}', base64Encoded: false });
  const snoop = createNetworkSnoop(fakePage(cdp));
  await flush();

  await roundTrip(cdp, "r1", { url: "https://x.test/api/items", method: "POST", postData: '{"q":1}' }, {}, 11);

  const entries = snoop.peek();
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.requestId, "r1");
  assert.equal(entry.url, "https://x.test/api/items");
  assert.equal(entry.method, "POST");
  assert.equal(entry.resourceType, "XHR");
  assert.equal(entry.status, 200);
  assert.equal(entry.statusText, "OK");
  assert.equal(entry.mimeType, "application/json");
  assert.deepEqual(entry.requestHeaders, { accept: "*/*" });
  assert.deepEqual(entry.responseHeaders, { "content-type": "application/json" });
  assert.equal(entry.postData, '{"q":1}');
  assert.equal(entry.encodedDataLength, 11);
  assert.equal(entry.body, '{"ok":true}');
  assert.equal(entry.base64Encoded, false);
  assert.equal(entry.bodySkipped, false);
  assert.equal(entry.failed, false);
  assert.equal(entry.errorText, null);
  assert.equal(typeof entry.startedAt, "number");
  assert.ok(entry.finishedAt >= entry.startedAt);

  const bodyCalls = cdp.calls.filter(call => call.method === "Network.getResponseBody");
  assert.equal(bodyCalls.length, 1);
  assert.deepEqual(bodyCalls[0].params, { requestId: "r1" });
  assert.equal(bodyCalls[0].sessionId, "s1");
  assert.equal(snoop.peek().length, 1, "peek does not consume");
  snoop.dispose();
});

test("snoop ignores other CDP sessions and pop consumes once", async () => {
  const cdp = new FakeCdp();
  const snoop = createNetworkSnoop(fakePage(cdp));
  await flush();

  await roundTrip(cdp, "other", { url: "https://other.test/api/items" }, {}, 12, { sessionId: "other" });
  await roundTrip(cdp, "r1", { url: "https://x.test/api/items" });

  const first = snoop.pop();
  assert.equal(first.length, 1);
  assert.equal(first[0].requestId, "r1");
  assert.deepEqual(snoop.pop(), []);
  assert.deepEqual(snoop.peek(), []);
  snoop.dispose();
});

test("popJson parses json bodies and silently drops unparsable or non-json entries", async () => {
  const cdp = new FakeCdp();
  cdp.bodies.set("r1", { body: '[{"id":1}]', base64Encoded: false });
  cdp.bodies.set("r2", { body: "not json at all", base64Encoded: false });
  cdp.bodies.set("r3", { body: "<html></html>", base64Encoded: false });
  cdp.bodies.set("r4", { body: Buffer.from('{"a":2}').toString("base64"), base64Encoded: true });
  const snoop = createNetworkSnoop(fakePage(cdp));
  await flush();

  await roundTrip(cdp, "r1", { url: "https://x.test/api/items" });
  await roundTrip(cdp, "r2", { url: "https://x.test/api/broken" });
  await roundTrip(cdp, "r3", { url: "https://x.test/page" }, { mimeType: "text/html" });
  await roundTrip(cdp, "r4", { url: "https://x.test/api/ld" }, { mimeType: "application/ld+json" });

  assert.deepEqual(snoop.popJson(), [[{ id: 1 }], { a: 2 }]);
  assert.deepEqual(snoop.pop(), [], "popJson drains the buffer");
  snoop.dispose();
});

test("an instance match filters which entries are buffered", async () => {
  const cdp = new FakeCdp();
  const snoop = createNetworkSnoop(fakePage(cdp), {
    match: { url: "/api/", method: "get", mimeType: /json/, resourceType: "xhr" },
    bodies: false,
  });
  await flush();

  await roundTrip(cdp, "r1", { url: "https://x.test/api/items" });
  await roundTrip(cdp, "r2", { url: "https://x.test/page" });
  await roundTrip(cdp, "r3", { url: "https://x.test/api/items", method: "POST" });
  await roundTrip(cdp, "r4", { url: "https://x.test/api/items" }, { mimeType: "text/html" });

  assert.deepEqual(snoop.pop().map(entry => entry.requestId), ["r1"]);
  snoop.dispose();
});

test("waitFor resolves on a later matching entry and rejects on timeout", async () => {
  const cdp = new FakeCdp();
  cdp.bodies.set("r2", { body: '{"ok":true}', base64Encoded: false });
  const snoop = createNetworkSnoop(fakePage(cdp));
  await flush();

  await roundTrip(cdp, "r0", { url: "https://x.test/api/click" });
  const pending = snoop.waitFor({ url: "/api/click" }, { timeoutMs: 5000 });
  await roundTrip(cdp, "r1", { url: "https://x.test/api/items" });
  await roundTrip(cdp, "r2", { url: "https://x.test/api/click" });

  const entry = await pending;
  assert.equal(entry.requestId, "r2", "only entries finishing after the call resolve the waiter");
  assert.equal(entry.body, '{"ok":true}');

  await assert.rejects(
    snoop.waitFor(candidate => candidate.url.includes("never-happens"), { timeoutMs: 20 }),
    error => error.message.startsWith("Timed out waiting for network response"),
  );
  snoop.dispose();
});

test("summary prints one line per entry, oldest first, and truncates", async () => {
  const cdp = new FakeCdp();
  const snoop = createNetworkSnoop(fakePage(cdp), { bodies: false });
  await flush();

  await roundTrip(cdp, "r1", { url: "https://x.test/api/1" }, {}, 120);
  await roundTrip(cdp, "r2", { url: "https://x.test/api/2", method: "POST" }, { status: 404, statusText: "Not Found" }, 33);
  await roundTrip(cdp, "r3", { url: "https://x.test/api/3" }, { mimeType: "text/html" }, 7);

  assert.equal(snoop.summary(), [
    "GET 200 application/json 120B https://x.test/api/1",
    "POST 404 application/json 33B https://x.test/api/2",
    "GET 200 text/html 7B https://x.test/api/3",
  ].join("\n"));
  assert.equal(snoop.summary({ max: 2 }), [
    "GET 200 application/json 120B https://x.test/api/1",
    "POST 404 application/json 33B https://x.test/api/2",
    "... +1 more",
  ].join("\n"));
  snoop.dispose();
});

test("maxEntries evicts the oldest entries and bodies:false skips body fetches", async () => {
  const cdp = new FakeCdp();
  const snoop = createNetworkSnoop(fakePage(cdp), { maxEntries: 2, bodies: false });
  await flush();

  await roundTrip(cdp, "r1", { url: "https://x.test/api/1" });
  await roundTrip(cdp, "r2", { url: "https://x.test/api/2" });
  await roundTrip(cdp, "r3", { url: "https://x.test/api/3" });

  assert.deepEqual(snoop.peek().map(entry => entry.requestId), ["r2", "r3"]);
  assert.equal(cdp.calls.filter(call => call.method === "Network.getResponseBody").length, 0);
  snoop.dispose();
});

test("oversized bodies are skipped and failed requests are recorded", async () => {
  const cdp = new FakeCdp();
  cdp.bodies.set("r1", { body: "x".repeat(50), base64Encoded: false });
  const snoop = createNetworkSnoop(fakePage(cdp), { maxBodyBytes: 10 });
  await flush();

  await roundTrip(cdp, "r1", { url: "https://x.test/api/big" }, {}, 999);
  sendRequest(cdp, "r2", { url: "https://x.test/api/dead" });
  cdp.emit("Network.loadingFailed", { requestId: "r2", errorText: "net::ERR_ABORTED", encodedDataLength: 0 });
  await flush();

  const [big, dead] = snoop.pop();
  assert.equal(big.bodySkipped, true);
  assert.equal(big.body, null);
  assert.equal(cdp.calls.filter(call => call.method === "Network.getResponseBody").length, 0);
  assert.equal(dead.failed, true);
  assert.equal(dead.errorText, "net::ERR_ABORTED");
  assert.equal(dead.status, null);
  snoop.dispose();
});

test("dispose rejects pending waiters and removes every subscription", async () => {
  const cdp = new FakeCdp();
  const snoop = createNetworkSnoop(fakePage(cdp));
  await flush();
  assert.ok(cdp.listenerCount() >= 4);

  const pending = snoop.waitFor({ url: "/never" }, { timeoutMs: 5000 });
  snoop.dispose();
  await assert.rejects(pending, /disposed/);
  assert.equal(cdp.listenerCount(), 0);
  snoop.dispose();
});

test(
  "snoop captures live traffic and collectWhileScrolling harvests paged items",
  { skip: !SHELL && "no chromium binary found", timeout: 120_000 },
  async () => {
    const server = await startSnoopServer();
    const userDataDir = mkdtempSync(path.join(tmpdir(), "omowright-snoop-test-"));
    let connection = null;
    let snoop = null;
    try {
      connection = await connectPipe({
        browserPath: SHELL,
        browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${userDataDir}`],
        storageRoot: userDataDir,
      });
      const page = (await createAgentTabs(connection).create("about:blank")).page;
      snoop = createNetworkSnoop(page);
      await page.goto(server.url);

      const clicked = snoop.waitFor({ url: "/api/click" }, { timeoutMs: 20_000 });
      await page.locator("#ping").click();
      const entry = await clicked;
      assert.equal(entry.status, 200);
      assert.equal(entry.method, "GET");
      assert.equal(entry.mimeType, "application/json");
      assert.deepEqual(JSON.parse(entry.body), { ok: true });

      const items = [];
      const generator = collectWhileScrolling(page, snoop, { minItems: 15, maxScrolls: 10, settleMs: 500 });
      let result;
      for (;;) {
        const next = await generator.next();
        if (next.done) {
          result = next.value;
          break;
        }
        items.push(next.value);
      }
      assert.ok(items.length >= 15, `collected ${items.length} items while scrolling`);
      assert.equal(result.stoppedBecause, "minItems");
      assert.equal(result.total, items.length);
      assert.ok(result.rounds >= 1);
      assert.ok(items.every(item => Number.isInteger(item.id)));
    } finally {
      snoop?.dispose();
      await connection?.close();
      rmSync(userDataDir, { recursive: true, force: true });
      await server.close();
    }
  },
);
