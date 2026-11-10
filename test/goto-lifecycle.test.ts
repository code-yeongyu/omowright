import { test } from "node:test";
import assert from "node:assert/strict";
import { OmOPage } from "../src/core.ts";
import type { PageFrameManager, PageHost } from "../src/core.ts";
import type { CdpEventMeta, CdpEventPayload, CdpResult, CdpSendOptions, CdpUnsubscribe } from "../src/cdp-protocol.ts";

type Listener = (event: unknown, meta: { sessionId: string }) => unknown;

class NavigationCdp {
  listeners = new Map<string, Set<Listener>>();
  errorText: string | undefined;
  emitCommit = false;
  on<E extends string>(name: E, listener: (event: CdpEventPayload<E>, meta: CdpEventMeta) => unknown): CdpUnsubscribe;
  on(name: string, listener: Listener) {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
    return () => listeners.delete(listener);
  }
  send<M extends string>(name: M, params?: object, sessionId?: string, options?: CdpSendOptions): Promise<CdpResult<M>>;
  async send(name: string): Promise<unknown> {
    if (name === "Page.navigate") {
      if (this.errorText) return { errorText: this.errorText };
      if (this.emitCommit)
        for (const listener of this.listeners.get("Page.frameNavigated") ?? [])
          listener({ frame: { id: "f1", url: "https://example.test/" } }, { sessionId: "s1" });
      return { frameId: "f1" };
    }
    if (name === "Page.getFrameTree") return { frameTree: { frame: { id: "f1", url: "https://example.test/" } } };
    if (name === "Runtime.evaluate") return { result: { value: true } };
    return {};
  }
  async discoverTargets() {
    return [];
  }
}

function pageFor(cdp: NavigationCdp) {
  const frames: PageFrameManager = {
    mainFrameId: "f1",
    getFrame: () => null,
    frames: new Map(),
    hasSession: () => true,
    collectDescendantFrames: () => [],
    ensureInjected: async () => null,
    invalidateContext: () => {},
    resolveFrameIdForSnapshotPrefix: () => null,
    setSnapshotFramePrefixMap: () => {},
  };
  const host: PageHost = {
    extensionBridgeRoute: {},
    page: null,
    resolvePageSession: async () => "s1",
    resolvePath: (value) => value,
    ensurePath: async (value) => value,
    registerReadableDownloadPath: (value) => value,
    resolvePopup: async () => null,
    openPopupTab: async () => null,
    closeTab: async () => null,
  };
  return new OmOPage(cdp, frames, "t1", "s1", host);
}

// CDP can deliver the committed frame before or after Page.navigate's reply.
// The public URL contract must hold at goto resolution in either ordering.
// Live cookie coverage only happened to exercise one ordering; no production seam is added.
for (const emitCommit of [false, true]) {
  test(`goto reports the committed URL with early commit event=${emitCommit}`, async () => {
    const cdp = new NavigationCdp();
    cdp.emitCommit = emitCommit;
    const page = pageFor(cdp);
    try {
      await page.goto("https://example.test", { waitUntil: "commit" });
      assert.equal(page.url(), "https://example.test/");
    } finally {
      await page.dispose();
    }
  });
}

// A rejected navigation owns and stops its speculative readiness work before returning.
// Otherwise disposing the page after catching the navigation error creates an orphaned
// rejection. Listener ownership detects the leak without sleeps or a test-only hook.
for (const waitUntil of ["interactive", "stable"] as const) {
  test(`failed ${waitUntil} goto releases readiness before disposal`, async () => {
    const cdp = new NavigationCdp();
    const page = pageFor(cdp);
    const before = [...cdp.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
    cdp.errorText = "net::ERR_CONNECTION_REFUSED";
    try {
      await assert.rejects(page.goto("https://example.test", { waitUntil }), /net::ERR_CONNECTION_REFUSED/);
      const after = [...cdp.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
      assert.equal(after, before, "failed goto releases all speculative readiness listeners");
    } finally {
      await page.dispose();
    }
  });
}
