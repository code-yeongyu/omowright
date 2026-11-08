import type { CdpEventPayload, CdpResponse, CdpTransport } from "./cdp-protocol.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const JSON_MIME = /^application\/json\s*(;|$)|\+json\s*(;|$)/i;

export interface NetworkSnoopPage {
  readonly cdp: Pick<CdpTransport, "on" | "send">;
  resolveSessionId(): string | Promise<string>;
}

export interface NetworkEntry {
  requestId: string;
  url: string;
  method: string;
  resourceType: string | null;
  status: number | null;
  statusText: string | null;
  mimeType: string | null;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string> | null;
  remoteIPAddress: string | null;
  postData: string | null;
  encodedDataLength: number;
  body: string | null;
  base64Encoded: boolean;
  bodySkipped: boolean;
  failed: boolean;
  errorText: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export type NetworkEntryPredicate = (entry: NetworkEntry) => unknown;

export interface NetworkMatchDescriptor {
  url?: string | RegExp;
  method?: string;
  mimeType?: string | RegExp;
  resourceType?: string;
}

export type NetworkMatch = NetworkEntryPredicate | NetworkMatchDescriptor | null | undefined;

export interface NetworkSnoopOptions {
  match?: NetworkMatch;
  bodies?: boolean;
  maxEntries?: number;
  maxBodyBytes?: number;
}

type SnoopEvent =
  | "Network.requestWillBeSent"
  | "Network.responseReceived"
  | "Network.loadingFinished"
  | "Network.loadingFailed";
/** Chromium omits encodedDataLength on loadingFailed; the field is read only if a sender ever adds it. */
type LoadingFailedParams = CdpEventPayload<"Network.loadingFailed"> & { encodedDataLength?: number };

interface SnoopWaiter {
  resolve: (entry: NetworkEntry) => void;
  reject: (error: Error) => void;
  test: (entry: NetworkEntry) => boolean;
}

function matchesText(value: string | null | undefined, pattern: string | RegExp | undefined) {
  if (pattern === undefined) return true;
  if (value === null || value === undefined) return false;
  if (pattern instanceof RegExp) return pattern.test(String(value));
  return String(value).includes(String(pattern));
}

function matchesToken(value: string | null | undefined, expected: string | undefined) {
  if (expected === undefined) return true;
  if (value === null || value === undefined) return false;
  return String(value).toLowerCase() === String(expected).toLowerCase();
}

function toPredicate(match: NetworkMatch): NetworkEntryPredicate {
  if (match === undefined || match === null) return () => true;
  if (typeof match === "function") return match;
  if (typeof match !== "object") throw new TypeError("match must be a predicate function or a descriptor object");
  return (entry: NetworkEntry) =>
    matchesText(entry.url, match.url) &&
    matchesToken(entry.method, match.method) &&
    matchesText(entry.mimeType, match.mimeType) &&
    matchesToken(entry.resourceType, match.resourceType);
}

function startedAtOf(params: { wallTime?: number } | undefined) {
  const wallTime = Number(params?.wallTime);
  return Number.isFinite(wallTime) && wallTime > 0 ? Math.round(wallTime * 1000) : Date.now();
}

function decodeBody(entry: NetworkEntry) {
  if (typeof entry.body !== "string") return null;
  return entry.base64Encoded ? Buffer.from(entry.body, "base64").toString("utf8") : entry.body;
}

/**
 * Buffers CDP network traffic for a single page session.
 *
 * Entries are tracked while in flight and committed to the buffer once they finish
 * (or fail), so filters may depend on response-only fields such as status or mimeType.
 */
export function createNetworkSnoop(page: NetworkSnoopPage, options: NetworkSnoopOptions = {}) {
  if (!page?.cdp || typeof page.resolveSessionId !== "function") {
    throw new TypeError("createNetworkSnoop requires a page with cdp and resolveSessionId");
  }
  const { match, bodies = true, maxEntries = 500, maxBodyBytes = 5_000_000 } = options;
  const wanted = toPredicate(match);

  const inflight = new Map<string, NetworkEntry>();
  const buffer: NetworkEntry[] = [];
  const waiters = new Set<SnoopWaiter>();
  const unsubscribers: Array<() => unknown> = [];
  let sessionId: string | null = null;
  let disposed = false;
  let queue: Promise<unknown> = Promise.resolve();

  const ready = Promise.resolve(page.resolveSessionId()).then((id) => {
    sessionId = id;
  });
  ready.catch((error) => console.warn("[network-snoop] failed to resolve the page session", error));

  function subscribe<E extends SnoopEvent>(method: E, handler: (params: CdpEventPayload<E>) => void) {
    unsubscribers.push(
      page.cdp.on(method, (params, meta) => {
        if (disposed) return;
        if (sessionId === null) {
          // The session id resolves asynchronously; queue early events in arrival order.
          ready
            .then(() => {
              if (!disposed && meta?.sessionId === sessionId) handler(params);
            })
            .catch(() => {});
          return;
        }
        if (meta?.sessionId !== sessionId) return;
        handler(params);
      }),
    );
  }

  function enqueue(task: () => Promise<void>) {
    queue = queue.then(task).catch((error) => console.warn("[network-snoop] entry processing failed", error));
  }

  async function loadBody(entry: NetworkEntry) {
    if (entry.encodedDataLength > maxBodyBytes) {
      entry.bodySkipped = true;
      return;
    }
    try {
      const result = await page.cdp.send(
        "Network.getResponseBody",
        { requestId: entry.requestId },
        sessionId ?? undefined,
      );
      entry.body = result?.body ?? null;
      entry.base64Encoded = Boolean(result?.base64Encoded);
    } catch {
      // Bodies expire with the network cache; keep the entry, drop the body.
      entry.body = null;
    }
  }

  function commit(entry: NetworkEntry) {
    buffer.push(entry);
    while (buffer.length > maxEntries) buffer.shift();
    for (const waiter of [...waiters]) if (waiter.test(entry)) waiter.resolve(entry);
  }

  subscribe("Network.requestWillBeSent", (params) => {
    const requestId = params?.requestId;
    if (!requestId) return;
    inflight.set(requestId, {
      requestId,
      url: params.request?.url ?? params.documentURL ?? "",
      method: params.request?.method ?? "GET",
      resourceType: params.type ?? null,
      status: null,
      statusText: null,
      mimeType: null,
      requestHeaders: params.request?.headers ?? {},
      responseHeaders: null,
      remoteIPAddress: null,
      postData: params.request?.postData ?? null,
      encodedDataLength: 0,
      body: null,
      base64Encoded: false,
      bodySkipped: false,
      failed: false,
      errorText: null,
      startedAt: startedAtOf(params),
      finishedAt: null,
    });
  });

  subscribe("Network.responseReceived", (params) => {
    const entry = inflight.get(params?.requestId);
    if (!entry) return;
    const response: Partial<CdpResponse> = params.response ?? {};
    entry.status = response.status ?? null;
    entry.statusText = response.statusText ?? "";
    entry.mimeType = response.mimeType ?? null;
    entry.responseHeaders = response.headers ?? {};
    entry.remoteIPAddress = response.remoteIPAddress ?? null;
    if (params.type) entry.resourceType = params.type;
  });

  subscribe("Network.loadingFinished", (params) => {
    const entry = inflight.get(params?.requestId);
    if (!entry) return;
    inflight.delete(entry.requestId);
    entry.encodedDataLength = Number(params.encodedDataLength ?? 0);
    entry.finishedAt = Date.now();
    enqueue(async () => {
      if (!wanted(entry)) return;
      if (bodies) await loadBody(entry);
      commit(entry);
    });
  });

  subscribe("Network.loadingFailed", (params: LoadingFailedParams) => {
    const entry = inflight.get(params?.requestId);
    if (!entry) return;
    inflight.delete(entry.requestId);
    entry.failed = true;
    entry.errorText = params.errorText ?? "";
    entry.encodedDataLength = Number(params.encodedDataLength ?? entry.encodedDataLength);
    entry.finishedAt = Date.now();
    enqueue(async () => {
      if (wanted(entry)) commit(entry);
    });
  });

  function pop() {
    return buffer.splice(0, buffer.length);
  }

  function peek() {
    return [...buffer];
  }

  function popJson() {
    const values: unknown[] = [];
    for (const entry of pop()) {
      if (!JSON_MIME.test(String(entry.mimeType ?? ""))) continue;
      const text = decodeBody(entry);
      if (text === null) continue;
      try {
        values.push(JSON.parse(text));
      } catch {
        // Truncated or non-JSON payload on a JSON content type: drop it silently.
      }
    }
    return values;
  }

  function waitFor(
    waitMatch: NetworkMatch,
    { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {},
  ): Promise<NetworkEntry> {
    if (disposed) return Promise.reject(Error("Network snoop is disposed"));
    const predicate = toPredicate(waitMatch);
    return new Promise<NetworkEntry>((resolve, reject) => {
      let settled = false;
      const finish =
        <T>(callback: (value: T) => void) =>
        (value: T) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          waiters.delete(waiter);
          callback(value);
        };
      const waiter: SnoopWaiter = {
        resolve: finish<NetworkEntry>(resolve),
        reject: finish<Error>(reject),
        test: (entry) => {
          try {
            return Boolean(predicate(entry));
          } catch (error) {
            waiter.reject(error instanceof Error ? error : Error(String(error)));
            return false;
          }
        },
      };
      const timer = setTimeout(
        () => waiter.reject(Error(`Timed out waiting for network response after ${timeoutMs}ms`)),
        timeoutMs,
      );
      waiters.add(waiter);
    });
  }

  function summary({ max = 50 }: { max?: number } = {}) {
    const shown = buffer.slice(0, max);
    const lines = shown.map((entry) =>
      [
        entry.method,
        entry.status ?? (entry.failed ? "FAILED" : "-"),
        entry.mimeType ?? "-",
        `${entry.encodedDataLength}B`,
        entry.url,
      ].join(" "),
    );
    const hidden = buffer.length - shown.length;
    if (hidden > 0) lines.push(`... +${hidden} more`);
    return lines.join("\n");
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const off of unsubscribers.splice(0, unsubscribers.length)) off();
    for (const waiter of [...waiters]) waiter.reject(Error("Network snoop disposed"));
    waiters.clear();
    inflight.clear();
  }

  return { pop, peek, popJson, waitFor, summary, dispose };
}
