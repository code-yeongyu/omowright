// Every event page.on / page.off / page.waitForEvent accepts. Each name is delivered by the page or by the module
// that owns it (console-events.js, network-events.js); this is the one public list.
import type { CdpEventMeta, CdpExceptionDetails, CdpRemoteObject, CdpUnsubscribe } from "./cdp-protocol.ts";

export const PAGE_EVENT_NAMES = Object.freeze([
  "close",
  "console",
  "crash",
  "dialog",
  "domcontentloaded",
  "download",
  "filechooser",
  "frameattached",
  "framedetached",
  "framenavigated",
  "load",
  "pageerror",
  "popup",
  "request",
  "response",
] as const);

export type PageEventName = (typeof PAGE_EVENT_NAMES)[number];

const PAGE_EVENT_NAME_SET: ReadonlySet<unknown> = new Set(PAGE_EVENT_NAMES);

/** Runtime.exceptionThrown as Chromium sends it (the field this module reads). */
export interface ExceptionThrownEvent {
  exceptionDetails?: Partial<CdpExceptionDetails>;
}

export interface PageErrorsPage {
  cdp: {
    on(
      event: "Runtime.exceptionThrown",
      handler: (event: ExceptionThrownEvent, meta: CdpEventMeta | undefined) => unknown,
    ): CdpUnsubscribe;
  };
  frameManager: {
    hasSession(sessionId: string): boolean;
    frames: ReadonlyMap<string, { sessionId: string; isolatedContextId?: number | undefined }>;
  };
  events: { emit(name: "pageerror", payload: Error): Promise<unknown> };
}

// Events that need the Runtime domain. Pages can detect Runtime.enable, so the page holds it only while one of
// these has a listener.
export const RUNTIME_PAGE_EVENTS: ReadonlySet<string> = new Set(["console", "pageerror"]);

export function assertPageEvent(name: unknown): asserts name is PageEventName {
  if (!PAGE_EVENT_NAME_SET.has(name)) {
    throw new TypeError(`Unknown page event: ${String(name)}. Supported events: ${PAGE_EVENT_NAMES.join(", ")}`);
  }
}

function pageError(details: Partial<CdpExceptionDetails> = {}) {
  const exception: Partial<CdpRemoteObject> = details.exception ?? {};
  const description = typeof exception.description === "string" ? exception.description : "";
  if (exception.subtype !== "error" || !description) {
    const text =
      exception.value !== undefined ? String(exception.value) : description || details.text || "Uncaught exception";
    return new Error(text);
  }
  const name = exception.className ?? "Error";
  // split() always yields at least one element.
  const head = description.split(/\n\s+at /)[0] ?? description;
  const error = new Error(head === name ? "" : head.startsWith(`${name}: `) ? head.slice(name.length + 2) : head);
  error.name = name;
  error.stack = description;
  return error;
}

// Runtime.exceptionThrown arrives only while the page holds Runtime for a console or pageerror listener.
export function subscribePageErrors(page: PageErrorsPage) {
  return page.cdp.on("Runtime.exceptionThrown", (event, meta) => {
    if (!meta?.sessionId || !page.frameManager.hasSession(meta.sessionId)) return;
    const details = event.exceptionDetails ?? {};
    // The page's own isolated world is not the page's code.
    for (const frame of page.frameManager.frames.values()) {
      if (frame.sessionId === meta.sessionId && frame.isolatedContextId === details.executionContextId) return;
    }
    page.events
      .emit("pageerror", pageError(details))
      .catch((error: unknown) => console.warn("[pageerror] page event listener failed", error));
  });
}
