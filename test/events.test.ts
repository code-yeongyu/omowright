import { test } from "node:test";
import assert from "node:assert/strict";
import { createEvents, BROWSER_EVENT_NAMES, CdpClient } from "../src/index.ts";
import type { BrowserEventPayloads, BrowserEventsConnection } from "../src/events.ts";
import type { CdpEventMeta, CdpEventPayload, CdpResult, CdpSendOptions } from "../src/cdp-protocol.ts";

// A method signature, so typed CDP handlers can be stored beside each other (method parameters are bivariant).
type Listener = { handle(...args: unknown[]): unknown }["handle"];
type CdpCall = {
  method: string;
  params?: Record<string, unknown> | undefined;
  sessionId?: string | undefined;
  options?: CdpSendOptions | undefined;
};
// The production guard against unknown event names is the contract under test, so the name reaches it untyped.
type UntypedEventSubscriber = { on(name: unknown, listener: () => unknown): unknown };

class FakeEmitter {
  #listeners = new Map<string, Set<Listener>>();
  on(name: string, listener: Listener) {
    const set = this.#listeners.get(name) ?? new Set();
    set.add(listener);
    this.#listeners.set(name, set);
    return () => set.delete(listener);
  }
  emit(name: string, ...args: unknown[]) {
    for (const listener of Array.from(this.#listeners.get(name) ?? [])) listener(...args);
  }
}
class FakeCdp {
  calls: CdpCall[];
  events: FakeEmitter;
  transportEvents: FakeEmitter;
  targetInfos: unknown[];
  constructor(targetInfos: unknown[] = []) {
    this.calls = [];
    this.events = new FakeEmitter();
    this.transportEvents = new FakeEmitter();
    this.targetInfos = targetInfos;
  }
  async ensureConnected() {}
  // The fake answers only the commands the event bridge drives; the overload is the generic CdpSend contract.
  send<M extends string>(
    method: M,
    params?: object,
    sessionId?: string,
    options?: CdpSendOptions,
  ): Promise<CdpResult<M>>;
  async send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    options?: CdpSendOptions,
  ): Promise<unknown> {
    this.calls.push({ method, params, sessionId, options });
    if (method === "Target.getTargets") return { targetInfos: this.targetInfos };
    return {};
  }
  on<E extends string>(method: E, listener: (payload: CdpEventPayload<E>, meta: CdpEventMeta) => unknown) {
    return this.events.on(method, listener);
  }
  emit(method: string, params: unknown, meta = {}) {
    this.events.emit(method, params, meta);
  }
}
function asEventsConnection(cdp: FakeCdp): BrowserEventsConnection {
  return { cdp };
}
const page = (targetId: string, extra = {}) => ({
  targetId,
  type: "page",
  url: "about:blank",
  title: "",
  openerId: undefined,
  openerFrameId: undefined,
  attached: false,
  subtype: undefined,
  browserContextId: undefined,
  ...extra,
});

test("events startup, filtering, popup classification, close and waits", async () => {
  const cdp = new FakeCdp([page("a"), { targetId: "worker", type: "service_worker" }]);
  const events = createEvents(asEventsConnection(cdp));
  const opened: BrowserEventPayloads["tabOpened"][] = [],
    popups: BrowserEventPayloads["popupOpened"][] = [],
    closed: BrowserEventPayloads["tabClosed"][] = [];
  events.on("tabOpened", (value) => opened.push(value));
  events.on("popupOpened", (value) => popups.push(value));
  events.on("tabClosed", (value) => closed.push(value));
  await events.ready;
  assert.deepEqual(BROWSER_EVENT_NAMES, [
    "tabOpened",
    "tabClosed",
    "popupOpened",
    "downloadStarted",
    "downloadProgress",
    "downloadFinished",
  ]);
  assert.equal(opened.length, 1);
  assert.equal(opened[0]?.initial, true);
  assert.equal(cdp.calls.find((call) => call.method === "Target.setDiscoverTargets")?.params?.["discover"], true);
  const getTargets = cdp.calls.find((call) => call.method === "Target.getTargets");
  assert.ok(getTargets);
  assert.equal(getTargets.sessionId, undefined);
  cdp.emit("Target.targetCreated", page("b", { url: "https://b.test", openerId: "a", openerFrameId: "frame-a" }));
  await Promise.resolve();
  assert.equal(opened.length, 2);
  assert.equal(popups.length, 1);
  assert.equal(popups[0]?.openerTargetId, "a");
  cdp.emit("Target.targetInfoChanged", { targetInfo: page("b", { url: "https://updated.test" }) });
  cdp.emit("Target.targetCrashed", { targetId: "b", status: "crashed", errorCode: 9 });
  cdp.emit("Target.targetDestroyed", { targetId: "b" });
  cdp.emit("Target.targetDestroyed", { targetId: "b" });
  await Promise.resolve();
  assert.equal(closed.length, 1);
  assert.equal(closed[0]?.reason, "crashed");
  assert.equal(closed[0]?.lastKnown?.url, "https://updated.test");
  await assert.rejects(events.waitForEvent("tabOpened", { timeout: 1 }), /Timed out waiting/);
  const wait = events.waitForEvent("tabOpened", { timeout: 1000 });
  cdp.transportEvents.emit("disconnected");
  await assert.rejects(wait, /disconnected/);
  await events.dispose();
  await events.dispose();
});

test("downloads map progress and fail in-flight work on disconnect", async () => {
  const cdp = new FakeCdp([page("a")]);
  const events = createEvents(asEventsConnection(cdp), { downloadBehavior: "allow", downloadPath: "/tmp/downloads" });
  const started: BrowserEventPayloads["downloadStarted"][] = [],
    progress: BrowserEventPayloads["downloadProgress"][] = [],
    finished: BrowserEventPayloads["downloadFinished"][] = [];
  events.on("downloadStarted", (value) => started.push(value));
  events.on("downloadProgress", (value) => progress.push(value));
  events.on("downloadFinished", (value) => finished.push(value));
  await events.ready;
  cdp.emit("Target.attachedToTarget", { targetInfo: { targetId: "a" } }, { sessionId: "session-a" });
  cdp.emit("Page.frameAttached", { frameId: "mapped" }, { sessionId: "session-a" });
  cdp.emit("Browser.downloadWillBegin", {
    guid: "g",
    url: "https://x/file",
    suggestedFilename: "file",
    frameId: "mapped",
  });
  cdp.emit("Browser.downloadProgress", { guid: "g", totalBytes: 4, receivedBytes: 2, state: "inProgress" });
  cdp.emit("Browser.downloadProgress", {
    guid: "g",
    totalBytes: 4,
    receivedBytes: 4,
    state: "completed",
    filePath: "/tmp/downloads/file",
  });
  cdp.emit("Browser.downloadProgress", { guid: "g", totalBytes: 4, receivedBytes: 4, state: "completed" });
  await Promise.resolve();
  assert.equal(started[0]?.targetId, "a");
  assert.equal(progress.length, 3);
  assert.equal(finished.length, 1);
  assert.equal(finished[0]?.state, "completed");
  cdp.emit("Browser.downloadWillBegin", { guid: "pending", url: "https://x/p", suggestedFilename: "p" });
  assert.equal(started.at(-1)?.targetId, "a");
  cdp.transportEvents.emit("disconnected");
  await Promise.resolve();
  assert.equal(finished.at(-1)?.state, "failed");
  assert.equal(finished.at(-1)?.error?.code, "browserDisconnected");
  cdp.emit("Browser.downloadWillBegin", { guid: "pending" });
  assert.equal(started.filter((value) => value.guid === "pending").length, 1);
  cdp.emit("Browser.downloadProgress", { guid: "pending", state: "completed" });
  assert.equal(finished.filter((value) => value.guid === "pending").length, 1);
  const allow = cdp.calls.filter((call) => call.method === "Browser.setDownloadBehavior");
  const lastAllow = allow.at(-1);
  assert.ok(lastAllow);
  assert.equal(lastAllow.sessionId, undefined);
  cdp.transportEvents.emit("reconnected");
  assert.equal(cdp.calls.filter((call) => call.method === "Browser.setDownloadBehavior").length, allow.length + 1);
  await events.dispose();
});

test("raw target creation rejects the global-registry symbol", async () => {
  const client = new CdpClient({ cdpUrl: "http://127.0.0.1:1" });
  await assert.rejects(
    client.send("Target.createTarget", { url: "about:blank" }, undefined, {
      capability: Symbol.for("omowright.targetCreationCapability"),
    }),
    /reserved/,
  );
});

test("unknown events fail synchronously and listener errors are isolated", async () => {
  const cdp = new FakeCdp();
  const events = createEvents(asEventsConnection(cdp));
  await events.ready;
  // An unknown name on purpose: the runtime guard is the contract under test.
  const untyped: UntypedEventSubscriber = events;
  assert.throws(() => untyped.on("nope", () => {}), TypeError);
  let called = false;
  events.on("tabOpened", () => {
    throw Error("bad");
  });
  events.on("tabOpened", () => {
    called = true;
  });
  cdp.emit("Target.targetCreated", page("x"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(called, true);
  await events.dispose();
});
