import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentTabs, DEFAULT_AGENT_VIEWPORT } from "../src/index.ts";
import { BrowserConnection } from "../src/connection.ts";
import type { CdpEventMeta, CdpEventPayload, CdpResult, CdpSend, CdpSendOptions } from "../src/cdp-protocol.ts";
import { field } from "./fixtures/read-field.ts";

// A method signature, so typed CDP handlers can be stored beside each other (method parameters are bivariant).
type Listener = { handle(payload: unknown, meta: unknown): void }["handle"];
type Call = {
  method: string;
  params?: unknown;
  sessionId?: unknown;
  options?: { capability?: unknown };
  url?: string;
  targetId?: string;
};
type Send = (method: string, params?: unknown, sessionId?: unknown, options?: Call["options"]) => Promise<unknown>;
// The fake answers only the commands agent tabs drive; the overload is the generic CdpSend contract.
function cdpSend(reply: Send): CdpSend {
  function send<M extends string>(
    method: M,
    params?: object,
    sessionId?: string,
    options?: CdpSendOptions,
  ): Promise<CdpResult<M>>;
  function send(method: string, params?: object, sessionId?: string, options?: CdpSendOptions): Promise<unknown> {
    return reply(method, params, sessionId, options);
  }
  return send;
}
// The fake page stands in for OmOPage; attachPage is replaced on this one connection.
function withFakeAttach(handle: BrowserConnection, attach: (targetId: string) => Promise<unknown>) {
  const attachable: { attachPage(targetId: string): Promise<unknown> } = handle;
  attachable.attachPage = attach;
  return handle;
}
type Viewport = { width: number; height: number };
interface FakePage {
  targetId: string;
  cdp: unknown;
  events: Emitter;
  viewport?: Viewport;
  resolveSessionId(): Promise<string>;
  setCachedViewportSize(size: Viewport): void;
  on(name: string, fn: Listener): () => boolean;
  goto(url: string): Promise<void>;
  dispose(): Promise<void>;
}
class Emitter {
  declare map: Map<string, Set<Listener>>;
  constructor() {
    this.map = new Map();
  }
  on(n: string, f: Listener) {
    const s = this.map.get(n) ?? new Set();
    s.add(f);
    this.map.set(n, s);
    return () => s.delete(f);
  }
  emit(n: string, p: unknown, m: unknown = {}) {
    for (const f of [...(this.map.get(n) ?? [])]) f(p, m);
  }
}
function connection({ headless = true, send = null }: { headless?: boolean; send?: Send | null } = {}) {
  const calls: Call[] = [];
  const cdp = {
    calls,
    isHeadless: headless,
    transportEvents: new Emitter(),
    on: <E extends string>(n: E, f: (payload: CdpEventPayload<E>, meta: CdpEventMeta) => unknown) =>
      cdp.events.on(n, f),
    events: new Emitter(),
    ensureConnected: async () => {},
    discoverTargets: async () => [],
    close: async () => {},
    send: cdpSend(
      send ??
        (async (method: string, params?: unknown, sessionId?: unknown, options?: Call["options"]) => {
          calls.push({ method, params, sessionId, options });
          if (method === "Target.createTarget") return { targetId: "owned" };
          return {};
        }),
    ),
  };
  const page: FakePage = {
    targetId: "owned",
    cdp,
    events: new Emitter(),
    resolveSessionId: async () => "session",
    setCachedViewportSize(size) {
      this.viewport = size;
    },
    on(name, fn) {
      return this.events.on(name, fn);
    },
    async goto(url) {
      calls.push({ method: "goto", url });
    },
    async dispose() {},
  };
  return {
    cdp,
    page,
    connection: withFakeAttach(new BrowserConnection(cdp), async () => {
      calls.push({ method: "attachPage" });
      return page;
    }),
  };
}
test("creates owned background tab and repins after main navigation", async () => {
  const c = connection();
  const tabs = createAgentTabs(c.connection);
  await tabs.ready;
  const tab = await tabs.create();
  assert.deepEqual(tab.viewport, DEFAULT_AGENT_VIEWPORT);
  assert.deepEqual(tabs.get("owned")?.viewport, tab.viewport);
  const create = c.cdp.calls.find((call) => call.method === "Target.createTarget");
  assert.deepEqual(create?.params, { url: "about:blank", background: true, newWindow: true });
  assert.ok(create?.options?.capability);
  assert.equal(
    c.cdp.calls.some((call) => call.method === "Target.activateTarget"),
    true,
  );
  c.page.events.emit("framenavigated", { frameId: "main", parentFrameId: null });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(c.cdp.calls.filter((call) => call.method === "Emulation.setDeviceMetricsOverride").length, 2);
  c.page.events.emit("framenavigated", { frameId: "child", parentFrameId: "main" });
  await Promise.resolve();
  assert.equal(c.cdp.calls.filter((call) => call.method === "Emulation.setDeviceMetricsOverride").length, 2);
  await tabs.dispose({ closeOwned: false });
  await assert.rejects(tabs.create(), /disposed/);
});

test("headed creation attaches directly without stealing focus", async () => {
  const c = connection({ headless: false });
  const tabs = createAgentTabs(c.connection);
  await tabs.ready;
  await tabs.create();
  assert.equal(
    c.cdp.calls.some((call) => call.method === "Target.activateTarget"),
    false,
  );
});

test("factory rejects close timeout conflicts and activation precedes attach", async () => {
  const c = connection();
  const tabs = createAgentTabs(c.connection, { closeTimeoutMs: 100 });
  await tabs.ready;
  await tabs.create();
  const order = c.cdp.calls.map((call) => call.method);
  assert.ok(
    order.indexOf("Target.activateTarget") >= 0 && order.indexOf("Target.activateTarget") < order.indexOf("attachPage"),
    `activation must precede attach: ${order.join(", ")}`,
  );
  assert.throws(() => createAgentTabs(c.connection, { closeTimeoutMs: 200 }), /Conflicting/);
});

test("close resolves once the matching target is destroyed and releases ownership", async () => {
  const c = connection();
  const tabs = createAgentTabs(c.connection);
  await tabs.ready;
  const tab = await tabs.create("https://x.test");
  const closing = tabs.close(tab, { timeoutMs: 100 });
  await Promise.resolve();
  c.cdp.events.emit("Target.targetDestroyed", { targetId: "owned" });
  await closing;
  assert.equal(tabs.list().length, 0);
});

test("navigation and explicit repins are serialized in request order", async () => {
  const pending: Array<(value?: unknown) => void> = [];
  let pinCount = 0;
  let firstStarted = () => {};
  let secondStarted = () => {};
  const firstStartedPromise = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const secondStartedPromise = new Promise<void>((resolve) => {
    secondStarted = resolve;
  });
  const c = connection({
    send: async (method, params, sessionId, options) => {
      c.cdp.calls.push({ method, params, sessionId, options });
      if (method === "Target.createTarget") return { targetId: "owned" };
      if (method === "Emulation.setDeviceMetricsOverride" && pinCount++ > 0) {
        if (pinCount === 2) firstStarted();
        else secondStarted();
        await new Promise((resolve) => pending.push(resolve));
      }
      return {};
    },
  });
  const tabs = createAgentTabs(c.connection);
  await tabs.ready;
  const tab = await tabs.create();
  const first = tabs.repin(tab, { width: 800, height: 600 });
  await firstStartedPromise;
  const second = tabs.repin(tab, { width: 1024, height: 768 });
  assert.equal(pending.length, 1);
  const releaseFirst = pending.shift();
  assert.ok(releaseFirst);
  releaseFirst();
  await secondStartedPromise;
  assert.equal(pending.length, 1);
  const releaseSecond = pending.shift();
  assert.ok(releaseSecond);
  releaseSecond();
  await Promise.all([first, second]);
  const sizes = c.cdp.calls
    .filter((call) => call.method === "Emulation.setDeviceMetricsOverride")
    .map((call) => call.params);
  assert.deepEqual(
    sizes.slice(-2).map((size) => ({ width: field(size, "width"), height: field(size, "height") })),
    [
      { width: 800, height: 600 },
      { width: 1024, height: 768 },
    ],
  );
  assert.deepEqual(tabs.get("owned")?.viewport, { width: 1024, height: 768 });
});

test("close failure leaves target owned and dispose reports close failures", async () => {
  const c = connection();
  const tabs = createAgentTabs(c.connection, { closeTimeoutMs: 10 });
  await tabs.ready;
  const tab = await tabs.create();
  await assert.rejects(tabs.close(tab), /Timed out/);
  assert.ok(tabs.get(tab.targetId));
  await assert.rejects(tabs.dispose(), AggregateError);
  assert.ok(tabs.get(tab.targetId));
});

test("BrowserConnection exposes newTab on the attach path", async () => {
  // newTab is a BrowserConnection class method, not a connectPipe instance
  // patch, so connect()-style attach clients get the launch path's tab API.
  const calls: Call[] = [];
  const cdp = {
    isHeadless: true,
    transportEvents: new Emitter(),
    events: new Emitter(),
    on: <E extends string>(name: E, listener: (payload: CdpEventPayload<E>, meta: CdpEventMeta) => unknown) =>
      cdp.events.on(name, listener),
    ensureConnected: async () => {},
    discoverTargets: async () => [],
    close: async () => {},
    send: cdpSend(async (method, params, sessionId, options) => {
      calls.push({ method, params, sessionId, options });
      if (method === "Target.createTarget") return { targetId: "attached-tab" };
      if (method === "Target.closeTarget")
        cdp.events.emit("Target.targetDestroyed", { targetId: field(params, "targetId") });
      return {};
    }),
  };
  const page = {
    targetId: "attached-tab",
    cdp,
    resolveSessionId: async () => "session",
    setCachedViewportSize() {},
    on: () => () => {},
    async dispose() {},
  };
  const attached = withFakeAttach(new BrowserConnection(cdp), async (targetId) => {
    calls.push({ method: "attachPage", targetId });
    return page;
  });

  const opened = await attached.newTab();
  assert.equal(opened, page);
  const create = calls.find((call) => call.method === "Target.createTarget");
  assert.deepEqual(create?.params, { url: "about:blank", background: true, newWindow: true });
  assert.ok(create?.options?.capability, "createTarget must carry the reserved capability");
  const order = calls.map((call) => call.method);
  assert.ok(
    order.indexOf("Target.activateTarget") < order.indexOf("attachPage"),
    `activation must precede attach: ${order.join(", ")}`,
  );
  assert.ok(order.includes("Emulation.setDeviceMetricsOverride"), "newTab must repin the viewport");
  assert.equal(
    createAgentTabs(attached).get("attached-tab")?.page,
    page,
    "newTab must register with the per-connection manager",
  );
  await attached.close();
  assert.equal(
    calls.some((call) => call.method === "Target.closeTarget"),
    false,
    "disconnect must leave ordinary newTab targets open",
  );
});
