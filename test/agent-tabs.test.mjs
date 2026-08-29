import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentTabs, DEFAULT_AGENT_VIEWPORT } from "../src/index.js";

class Emitter { constructor() { this.map = new Map(); } on(n, f) { const s = this.map.get(n) ?? new Set(); s.add(f); this.map.set(n, s); return () => s.delete(f); } emit(n, p, m = {}) { for (const f of [...this.map.get(n) ?? []]) f(p, m); } }
function connection() {
  const calls = []; const cdp = { calls, transportEvents: new Emitter(), on: (n, f) => cdp.events.on(n, f), events: new Emitter(), ensureConnected: async () => {}, send: async (method, params, sessionId, options) => { calls.push({ method, params, sessionId, options }); if (method === "Target.createTarget") return { targetId: "owned" }; return {}; } };
  const page = { targetId: "owned", cdp, events: new Emitter(), resolveSessionId: async () => "session", setCachedViewportSize(size) { this.viewport = size; }, on(name, fn) { return this.events.on(name, fn); }, async dispose() {} };
  return { cdp, page, attachPage: async () => page };
}
test("creates owned background tab and repins after main navigation", async () => {
  const c = connection(); const tabs = createAgentTabs(c); await tabs.ready;
  const tab = await tabs.create();
  assert.deepEqual(tab.viewport, DEFAULT_AGENT_VIEWPORT); assert.deepEqual(tabs.get("owned").viewport, tab.viewport);
  const create = c.cdp.calls.find(call => call.method === "Target.createTarget");
  assert.deepEqual(create.params, { url: "about:blank", background: true }); assert.ok(create.options?.capability);
  assert.equal(c.cdp.calls.some(call => call.method === "Target.activateTarget"), true);
  c.page.events.emit("framenavigated", { frameId: "main", parentFrameId: null });
  await Promise.resolve();
  assert.equal(c.cdp.calls.filter(call => call.method === "Emulation.setDeviceMetricsOverride").length, 2);
  c.page.events.emit("framenavigated", { frameId: "child", parentFrameId: "main" }); await Promise.resolve();
  assert.equal(c.cdp.calls.filter(call => call.method === "Emulation.setDeviceMetricsOverride").length, 2);
  await tabs.dispose({ closeOwned: false }); assert.rejects(tabs.create(), /disposed/);
});

test("factory rejects close timeout conflicts and activation precedes attach", async () => {
  const c = connection(); const tabs = createAgentTabs(c, { closeTimeoutMs: 100 }); await tabs.ready; await tabs.create();
  assert.equal(c.cdp.calls.some(call => call.method === "Target.activateTarget"), true);
  assert.throws(() => createAgentTabs(c, { closeTimeoutMs: 200 }), /Conflicting/);
});

test("close waits for matching destruction and retains ownership after timeout", async () => {
  const c = connection(); const tabs = createAgentTabs(c); await tabs.ready; const tab = await tabs.create("https://x.test");
  const createCall = c.cdp.calls.find(call => call.method === "Target.createTarget");
  assert.ok(createCall.options.capability, "creation uses the internal capability marker");
  const closing = tabs.close(tab, { timeoutMs: 100 });
  await Promise.resolve(); c.cdp.events.emit("Target.targetDestroyed", { targetId: "owned" }); await closing;
  assert.equal(tabs.list().length, 0);
});

test("close failure leaves target owned and dispose reports close failures", async () => {
  const c = connection(); const tabs = createAgentTabs(c, { closeTimeoutMs: 10 }); await tabs.ready; const tab = await tabs.create();
  await assert.rejects(tabs.close(tab), /Timed out/); assert.ok(tabs.get(tab.targetId));
  await assert.rejects(tabs.dispose(), AggregateError); assert.ok(tabs.get(tab.targetId));
});
