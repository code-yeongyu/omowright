import type { CdpEventMeta, CdpRemoteObject, CdpUnsubscribe } from "./cdp-protocol.ts";

/** Runtime.consoleAPICalled as Chromium sends it (the fields this module reads). */
export interface ConsoleApiCalledEvent {
  type: string;
  args?: CdpRemoteObject[];
}

export interface ConsoleMessage {
  type(): string;
  text(): string;
}

export interface ConsoleEventsPage {
  cdp: {
    on(
      event: "Runtime.consoleAPICalled",
      handler: (event: ConsoleApiCalledEvent, metadata: CdpEventMeta) => unknown,
    ): CdpUnsubscribe;
  };
  frameManager: { hasSession(sessionId: string): boolean };
  events: { emit(name: "console", payload: ConsoleMessage): Promise<unknown> };
}

export function subscribeConsoleEvents(page: ConsoleEventsPage) {
  return page.cdp.on("Runtime.consoleAPICalled", (event, metadata) => {
    if (!metadata.sessionId || !page.frameManager.hasSession(metadata.sessionId)) return;
    const text = (event.args ?? [])
      .map((arg) => {
        if (arg.unserializableValue !== undefined) return arg.unserializableValue;
        if (arg.value !== undefined) return typeof arg.value === "string" ? arg.value : String(arg.value);
        return arg.description ?? arg.type;
      })
      .join(" ");
    page.events
      .emit("console", { type: () => event.type, text: () => text })
      .catch((error: unknown) => console.warn("[console] page event listener failed", error));
  });
}
