import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserConnection } from "../src/index.js";

class Emitter {
  constructor() { this.map = new Map(); }
  on(name, fn) {
    const set = this.map.get(name) ?? new Set();
    set.add(fn);
    this.map.set(name, set);
    return () => set.delete(fn);
  }
}

// Fake CDP client shaped like the HTTP-attach transport: it can create and
// attach targets but offers no tab helpers of its own.
function fakeClient() {
  const calls = [];
  const events = new Emitter();
  const cdp = {
    calls,
    isHeadless: true,
    transportEvents: new Emitter(),
    on: (name, fn) => events.on(name, fn),
    ensureConnected: async () => {},
    send: async (method, params, sessionId, options) => {
      calls.push({ method, params, sessionId, options });
      if (method === "Target.createTarget") return { targetId: "attached-tab" };
      return {};
    },
  };
  return cdp;
}

function fakePage(cdp) {
  return {
    targetId: "attached-tab",
    cdp,
    viewport: null,
    resolveSessionId: async () => "session",
    setCachedViewportSize(size) { this.viewport = size; },
    on() { return () => {}; },
    async dispose() {},
  };
}

test("BrowserConnection exposes newTab that opens a tab through createAgentTabs", async () => {
  const cdp = fakeClient();
  const connection = new BrowserConnection(cdp);
  await connection.initialize();
  // Guards the attach-path contract: connect() must offer the same tab
  // opener the README quickstart teaches on connectPipe().
  assert.equal(typeof connection.newTab, "function");
  let attached = null;
  connection.attachPage = async (targetId) => {
    assert.equal(targetId, "attached-tab");
    attached = fakePage(cdp);
    return attached;
  };
  const opened = await connection.newTab("https://x.test");
  assert.equal(opened, attached);
  const create = cdp.calls.find((call) => call.method === "Target.createTarget");
  assert.ok(create, "expected a Target.createTarget call");
  assert.deepEqual(create.params, { url: "https://x.test", background: true });
  assert.ok(create.options?.capability, "Target.createTarget must carry the internal capability");

  // Options object invocation
  const openedWithOptions = await connection.newTab({ url: "https://y.test", viewport: { width: 800, height: 600 } });
  assert.equal(openedWithOptions, attached);
  const createWithOptions = cdp.calls.filter((call) => call.method === "Target.createTarget")[1];
  assert.ok(createWithOptions, "expected a second Target.createTarget call");
  assert.deepEqual(createWithOptions.params, { url: "https://y.test", background: true });

  // Default invocation
  const openedDefault = await connection.newTab();
  assert.equal(openedDefault, attached);
  const createDefault = cdp.calls.filter((call) => call.method === "Target.createTarget")[2];
  assert.ok(createDefault, "expected a third Target.createTarget call");
  assert.deepEqual(createDefault.params, { url: "about:blank", background: true });
});

