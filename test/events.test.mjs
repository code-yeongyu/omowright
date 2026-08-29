import { test } from "node:test";
import assert from "node:assert/strict";
import { createEvents, BROWSER_EVENT_NAMES } from "../src/index.js";

class FakeEmitter {
  #listeners = new Map();
  on(name, listener) {
    const set = this.#listeners.get(name) ?? new Set();
    set.add(listener); this.#listeners.set(name, set);
    return () => set.delete(listener);
  }
  emit(name, ...args) { for (const listener of [...this.#listeners.get(name) ?? []]) listener(...args); }
}
class FakeCdp {
  constructor(targetInfos = []) { this.calls = []; this.events = new FakeEmitter(); this.transportEvents = new FakeEmitter(); this.targetInfos = targetInfos; }
  async ensureConnected() {}
  async send(method, params, sessionId, options) {
    this.calls.push({ method, params, sessionId, options });
    if (method === "Target.getTargets") return { targetInfos: this.targetInfos };
    return {};
  }
  on(method, listener) { return this.events.on(method, listener); }
  emit(method, params, meta = {}) { this.events.emit(method, params, meta); }
}
const page = (targetId, extra = {}) => ({ targetId, type: "page", url: "about:blank", title: "", openerId: undefined, openerFrameId: undefined, attached: false, subtype: undefined, browserContextId: undefined, ...extra });

test("events startup, filtering, popup classification, close and waits", async () => {
  const cdp = new FakeCdp([page("a"), { targetId: "worker", type: "service_worker" }]);
  const connection = { cdp };
  const events = createEvents(connection);
  const opened = [], popups = [], closed = [];
  events.on("tabOpened", value => opened.push(value));
  events.on("popupOpened", value => popups.push(value));
  events.on("tabClosed", value => closed.push(value));
  await events.ready;
  assert.deepEqual(BROWSER_EVENT_NAMES, ["tabOpened", "tabClosed", "popupOpened", "downloadStarted", "downloadProgress", "downloadFinished"]);
  assert.equal(opened.length, 1); assert.equal(opened[0].initial, true);
  assert.equal(cdp.calls.find(call => call.method === "Target.setDiscoverTargets").params.discover, true);
  assert.equal(cdp.calls.find(call => call.method === "Target.getTargets").sessionId, undefined);
  cdp.emit("Target.targetCreated", page("b", { url: "https://b.test", openerId: "a", openerFrameId: "frame-a" }));
  await Promise.resolve();
  assert.equal(opened.length, 2); assert.equal(popups.length, 1); assert.equal(popups[0].openerTargetId, "a");
  cdp.emit("Target.targetInfoChanged", { targetInfo: page("b", { url: "https://updated.test" }) });
  cdp.emit("Target.targetCrashed", { targetId: "b", status: "crashed", errorCode: 9 });
  cdp.emit("Target.targetDestroyed", { targetId: "b" });
  cdp.emit("Target.targetDestroyed", { targetId: "b" });
  await Promise.resolve();
  assert.equal(closed.length, 1); assert.equal(closed[0].reason, "crashed"); assert.equal(closed[0].lastKnown.url, "https://updated.test");
  await assert.rejects(events.waitForEvent("tabOpened", { timeout: 1 }), /Timed out waiting/);
  await events.dispose(); await events.dispose();
});

test("downloads map progress and fail in-flight work on disconnect", async () => {
  const cdp = new FakeCdp();
  const events = createEvents({ cdp }, { downloadBehavior: "allow", downloadPath: "/tmp/downloads" });
  const started = [], progress = [], finished = [];
  events.on("downloadStarted", value => started.push(value)); events.on("downloadProgress", value => progress.push(value)); events.on("downloadFinished", value => finished.push(value));
  await events.ready;
  cdp.emit("Browser.downloadWillBegin", { guid: "g", url: "https://x/file", suggestedFilename: "file", frameId: "f" });
  cdp.emit("Browser.downloadProgress", { guid: "g", totalBytes: 4, receivedBytes: 2, state: "inProgress" });
  cdp.emit("Browser.downloadProgress", { guid: "g", totalBytes: 4, receivedBytes: 4, state: "completed", filePath: "/tmp/downloads/file" });
  cdp.emit("Browser.downloadProgress", { guid: "g", totalBytes: 4, receivedBytes: 4, state: "completed" });
  await Promise.resolve();
  assert.equal(started[0].targetId, null); assert.equal(progress.length, 3); assert.equal(finished.length, 1); assert.equal(finished[0].state, "completed");
  cdp.emit("Browser.downloadWillBegin", { guid: "pending", url: "https://x/p", suggestedFilename: "p" });
  cdp.transportEvents.emit("disconnected");
  await Promise.resolve();
  assert.equal(finished.at(-1).state, "failed"); assert.equal(finished.at(-1).error.code, "browserDisconnected");
  const allow = cdp.calls.filter(call => call.method === "Browser.setDownloadBehavior");
  assert.equal(allow.at(-1).sessionId, undefined); cdp.transportEvents.emit("reconnected");
  assert.equal(cdp.calls.filter(call => call.method === "Browser.setDownloadBehavior").length, allow.length + 1);
  await events.dispose();
});

test("unknown events fail synchronously and listener errors are isolated", async () => {
  const cdp = new FakeCdp(); const events = createEvents({ cdp }); await events.ready;
  assert.throws(() => events.on("nope", () => {}), TypeError);
  let called = false; events.on("tabOpened", () => { throw Error("bad"); }); events.on("tabOpened", () => { called = true; });
  cdp.emit("Target.targetCreated", page("x")); await Promise.resolve(); await Promise.resolve(); assert.equal(called, true);
  await events.dispose();
});
