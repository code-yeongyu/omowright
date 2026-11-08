import { urlMatches } from "./url-match.ts";
import type { CdpEventMeta, CdpEventPayload, CdpResponse, CdpRequest, CdpTransport } from "./cdp-protocol.ts";

type NetworkMethod =
  | "Network.requestWillBeSent"
  | "Network.responseReceived"
  | "Network.loadingFinished"
  | "Network.loadingFailed";

interface NetworkState {
  users: number;
  ready?: Promise<unknown>;
}

/** Releases one hold on the session's Network domain; `ready` settles once Network.enable has. */
export type NetworkRelease = (() => void) & { ready: Promise<unknown> | undefined };

export interface NetworkBodyReaders {
  body(): Promise<Buffer>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface NetworkRequest extends NetworkBodyReaders {
  url(): string;
  method(): string;
  headers(): Record<string, string>;
}

export interface NetworkResponse extends NetworkBodyReaders {
  url(): string;
  method(): string;
  headers(): Record<string, string>;
  /** Undefined only when Chromium sent a responseReceived without a response. */
  status(): number | undefined;
  ok(): boolean;
}

export interface NetworkRecord {
  exposed: boolean;
  finish(failure: Error | null): void;
  rawBody(): Promise<{ body: string; base64Encoded: boolean }>;
  request: NetworkRequest;
  response?: NetworkResponse;
  setResponse(response: Partial<CdpResponse>): void;
}

/** The record each event carries: requestWillBeSent always makes one; later events find it only while it is in flight. */
type RecordFor<M extends NetworkMethod> = M extends "Network.requestWillBeSent"
  ? NetworkRecord
  : NetworkRecord | undefined;

export type NetworkObserver = {
  [M in NetworkMethod]?: (params: CdpEventPayload<M>, record: RecordFor<M>) => void;
};

export interface NetworkPage {
  cdp: Pick<CdpTransport, "send" | "on">;
  resolveSessionId(): Promise<string> | string;
}

export interface NetworkEventsPage extends NetworkPage {
  events: { emit(name: "request" | "response", value: NetworkRequest | NetworkResponse | undefined): Promise<unknown> };
}

interface NetworkStream {
  observers: Set<NetworkObserver>;
  close(force?: boolean): void;
  inflight: Map<string, NetworkRecord>;
  ready: Promise<void>;
}

type NetworkEvent = { [M in NetworkMethod]: { method: M; params: CdpEventPayload<M> } }[NetworkMethod];

const sessions = new WeakMap<object, Map<string | undefined, NetworkState>>();
const streams = new WeakMap<NetworkPage, NetworkStream>();

// Readiness tracking and user-facing capture share ownership of the domain.
// A refused enable is not a page-setup failure (embedded transports may refuse it).
export function acquireNetwork(cdp: Pick<CdpTransport, "send">, sessionId: string | undefined): NetworkRelease {
  let active = sessions.get(cdp);
  if (!active) sessions.set(cdp, (active = new Map()));
  let state = active.get(sessionId);
  if (!state) {
    state = { users: 0 };
    active.set(sessionId, state);
    state.ready = cdp.send("Network.enable", undefined, sessionId).catch(() => {});
  }
  state.users++;
  const held = state;
  const activeSessions = active;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (--held.users) return;
    activeSessions.delete(sessionId);
    // Order disable before a subsequent acquire's enable, even if the first
    // enable has not completed yet.
    cdp.send("Network.disable", undefined, sessionId).catch(() => {});
  };
  release.ready = held.ready;
  return release;
}

export class NetworkBodyUnavailableError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "NetworkBodyUnavailableError";
  }
}

function headers(values: Record<string, unknown> = {}) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]));
}

function bodyReaders(body: () => Promise<Buffer>): NetworkBodyReaders {
  return {
    body,
    async text() {
      return (await body()).toString("utf8");
    },
    async json(): Promise<unknown> {
      return JSON.parse(await this.text());
    },
  };
}

function recordFor(
  cdp: Pick<CdpTransport, "send">,
  sessionId: string | undefined,
  params: CdpEventPayload<"Network.requestWillBeSent">,
): NetworkRecord {
  const request: Partial<CdpRequest> = params.request ?? {};
  const finished = Promise.withResolvers<Error | null>();
  let rawBody: Promise<{ body: string; base64Encoded: boolean }> | undefined;
  const record: NetworkRecord = {
    exposed: false,
    finish: finished.resolve,
    rawBody() {
      return (rawBody ??= finished.promise.then(async (failure) => {
        try {
          if (failure) throw failure;
          return await cdp.send("Network.getResponseBody", { requestId: params.requestId }, sessionId);
        } catch (cause) {
          throw new NetworkBodyUnavailableError(`Response body is unavailable for ${request.url}`, cause);
        }
      }));
    },
    request: {
      url: () => request.url ?? params.documentURL ?? "",
      method: () => request.method ?? "GET",
      headers: () => headers(request.headers),
      ...bodyReaders(async () => Buffer.from(request.postData ?? "", "utf8")),
    },
    setResponse: (response) => {
      record.response = {
        url: () => response.url ?? record.request.url(),
        method: record.request.method,
        headers: () => headers(response.headers),
        status: () => response.status,
        ok: () => response.status !== undefined && response.status >= 200 && response.status <= 299,
        ...bodyReaders(async () => {
          const result = await record.rawBody();
          return Buffer.from(result.body ?? "", result.base64Encoded ? "base64" : "utf8");
        }),
      };
    },
  };
  return record;
}

// One CDP event path per page, shared by page events, snoops and traces.
// Network.enable itself is shared per session with the readiness tracker.
export function subscribeNetwork(page: NetworkPage, handlers: NetworkObserver) {
  let stream = streams.get(page);
  if (!stream) {
    const observers = new Set<NetworkObserver>();
    const inflight = new Map<string, NetworkRecord>();
    const unsubscribers: Array<() => void> = [];
    let sessionId: string | undefined;
    let release: NetworkRelease | undefined;
    let closed = false;
    const ready = Promise.resolve(page.resolveSessionId()).then(async (id) => {
      sessionId = id;
      if (!closed) {
        release = acquireNetwork(page.cdp, id);
        await release.ready;
      }
    });
    ready.catch(() => {});
    const close = (force = false) => {
      if (closed || (!force && (observers.size || inflight.size))) return;
      closed = true;
      for (const record of inflight.values()) record.finish(Error("Page network capture disposed"));
      inflight.clear();
      observers.clear();
      for (const off of unsubscribers) off();
      release?.();
      streams.delete(page);
    };
    const notify = <M extends NetworkMethod>(method: M, params: CdpEventPayload<M>, record: RecordFor<M>) => {
      for (const observer of observers) observer[method]?.(params, record);
    };
    const dispatch = (event: NetworkEvent) => {
      const { params } = event;
      let record = inflight.get(params.requestId);
      if (event.method === "Network.requestWillBeSent") {
        // Redirects reuse request ids; the previous hop has no readable body.
        record?.finish(Error("Request redirected"));
        const created = recordFor(page.cdp, sessionId, event.params);
        record = created;
        inflight.set(params.requestId, created);
        notify(event.method, event.params, created);
      } else if (event.method === "Network.responseReceived") {
        record?.setResponse(event.params.response ?? {});
        notify(event.method, event.params, record);
      } else if (event.method === "Network.loadingFailed") {
        record?.finish(Error(event.params.errorText ?? "Request failed"));
        notify(event.method, event.params, record);
      } else {
        record?.finish(null);
        notify(event.method, event.params, record);
      }
      if (event.method === "Network.loadingFinished" || event.method === "Network.loadingFailed") {
        // Preserve bodies for returned response objects before the last
        // listener releases the domain (disable clears the browser cache).
        const done = record?.exposed && record.response ? record.rawBody().catch(() => {}) : Promise.resolve();
        done.finally(() => {
          if (inflight.get(params.requestId) === record) inflight.delete(params.requestId);
          close();
        });
      }
    };
    const onEvent = (event: NetworkEvent, meta: CdpEventMeta | undefined) => {
      if (closed) return;
      if (sessionId === undefined) {
        ready
          .then(() => {
            if (!closed && meta?.sessionId === sessionId) dispatch(event);
          })
          .catch(() => {});
      } else if (meta?.sessionId === sessionId) dispatch(event);
    };
    unsubscribers.push(
      page.cdp.on("Network.requestWillBeSent", (params, meta) =>
        onEvent({ method: "Network.requestWillBeSent", params }, meta),
      ),
      page.cdp.on("Network.responseReceived", (params, meta) =>
        onEvent({ method: "Network.responseReceived", params }, meta),
      ),
      page.cdp.on("Network.loadingFinished", (params, meta) =>
        onEvent({ method: "Network.loadingFinished", params }, meta),
      ),
      page.cdp.on("Network.loadingFailed", (params, meta) =>
        onEvent({ method: "Network.loadingFailed", params }, meta),
      ),
    );
    stream = { observers, close, inflight, ready };
    streams.set(page, stream);
  }
  const subscribed = stream;
  subscribed.observers.add(handlers);
  return () => {
    subscribed.observers.delete(handlers);
    // Unobserved requests without a returned response need no further work.
    for (const [id, record] of subscribed.inflight) {
      if (!record.exposed && !subscribed.observers.size) {
        record.finish(Error("Network capture disposed"));
        subscribed.inflight.delete(id);
      }
    }
    subscribed.close();
  };
}

// Holds the shared stream for one navigation call. A frame's document records
// are exposed so bodies stay readable after the domain is released.
// frameId is null before the main frame is known: no Document request matches it, so nothing is tracked.
export function trackDocumentResponses(page: NetworkPage, frameId: string | null) {
  const documents = new Map<string, NetworkRecord>();
  const dispose = subscribeNetwork(page, {
    "Network.requestWillBeSent": (params, record) => {
      if (params.type !== "Document" || params.frameId !== frameId) return;
      record.exposed = true;
      // Redirect hops share the loader id; the last hop carries the final response.
      documents.set(params.loaderId, record);
    },
  });
  return {
    ready: networkReady(page),
    // Page.navigate omits loaderId for a same-document navigation; no record is keyed by it.
    response: (loaderId: string | undefined) =>
      loaderId === undefined ? null : (documents.get(loaderId)?.response ?? null),
    dispose,
  };
}

export function disposeNetwork(page: NetworkPage) {
  streams.get(page)?.close(true);
}

export function networkReady(page: NetworkPage) {
  return streams.get(page)?.ready;
}

export function subscribePageNetworkEvents(page: NetworkEventsPage) {
  const emit = (name: "request" | "response", value: NetworkRequest | NetworkResponse | undefined) =>
    page.events
      .emit(name, value)
      .catch((error: unknown) => console.warn("[network] page event listener failed", error));
  return subscribeNetwork(page, {
    "Network.requestWillBeSent": (_params, record) => emit("request", record.request),
    "Network.responseReceived": (_params, record) => {
      if (!record) return;
      record.exposed = true;
      emit("response", record.response);
    },
  });
}

/** What page.waitForRequest/waitForResponse and network snoops accept as a filter. */
export type NetworkMatch<T extends NetworkRequest | NetworkResponse = NetworkRequest | NetworkResponse> =
  | string
  | RegExp
  | ((value: T) => unknown);

export function networkPredicate<T extends NetworkRequest | NetworkResponse = NetworkRequest | NetworkResponse>(
  match: NetworkMatch<T>,
): (value: T) => unknown {
  if (typeof match === "function") return match;
  if (match instanceof RegExp)
    return (value) => {
      match.lastIndex = 0;
      return match.test(value.url());
    };
  if (typeof match === "string") return (value) => urlMatches(value.url(), match);
  throw new TypeError("urlOrPredicate must be a URL string, RegExp or predicate");
}
