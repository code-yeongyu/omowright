/**
 * Request interception via the CDP Fetch domain.
 *
 * Enabling Fetch changes request timing and blocking patterns that bot
 * defenses can fingerprint. Keep interception off by default and scope
 * patterns tightly.
 */
import type { CdpEventMeta, CdpEventPayload, CdpTransport, CdpUnsubscribe } from "./cdp-protocol.ts";

/** What a route handler and a match predicate see of a paused request. */
export interface RouteRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData: string | undefined;
  resourceType: string;
}

export type RouteMatchPredicate = (
  request: Pick<RouteRequest, "url" | "method" | "resourceType" | "headers">,
) => unknown;
/** A glob (`*`, `?`), a substring, a RegExp, or a predicate. */
export type RouteMatch = string | RegExp | RouteMatchPredicate;

/** Headers as a name/value list or a record; every name and value is stringified. */
export type RouteHeaders = Array<{ name: unknown; value?: unknown }> | Record<string, unknown>;

export interface RouteContinueOverrides {
  url?: string | undefined;
  method?: string | undefined;
  headers?: RouteHeaders | undefined;
  postData?: unknown;
}

export interface RouteFulfillOptions {
  status?: number | undefined;
  headers?: RouteHeaders | undefined;
  contentType?: unknown;
  body?: unknown;
}

export interface Route {
  request: RouteRequest;
  continue(overrides?: RouteContinueOverrides): Promise<unknown>;
  fulfill(options?: RouteFulfillOptions): Promise<unknown>;
  abort(errorReason?: string): Promise<unknown>;
  fallback(): Promise<void>;
}

export type RouteHandler = (route: Route) => unknown;

export interface RouteOptions {
  times?: number | undefined;
  prepend?: boolean | undefined;
}

export interface RoutesController {
  route(match: RouteMatch, handler: RouteHandler, options?: RouteOptions): Promise<void>;
  unroute(match?: RouteMatch, handler?: RouteHandler): Promise<void>;
  dispose(): Promise<void>;
  readonly enabled: boolean;
}

/** The page surface routes need: its CDP transport and its session id. */
export interface RoutesPage {
  cdp: Pick<CdpTransport, "send" | "on">;
  resolveSessionId(): Promise<string>;
}

interface RouteEntry {
  match: RouteMatch;
  handler: RouteHandler;
  remaining: number;
}

interface HeaderEntry {
  name: string;
  value: string;
}

type FetchSettleMethod = "Fetch.continueRequest" | "Fetch.fulfillRequest" | "Fetch.failRequest";

const controllers = new WeakMap<RoutesPage, RoutesController>();

function globToRegExp(glob: string) {
  let source = "";
  for (const char of glob) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else if ("\\^$+{}[]()|.".includes(char)) source += `\\${char}`;
    else source += char;
  }
  return new RegExp(`^${source}$`);
}

function hasGlobChars(value: string) {
  return value.includes("*") || value.includes("?");
}

function matches(match: RouteMatch, request: RouteRequest) {
  if (typeof match === "function") {
    return Boolean(
      match({
        url: request.url,
        method: request.method,
        resourceType: request.resourceType,
        headers: request.headers,
      }),
    );
  }
  if (match instanceof RegExp) return match.test(request.url);
  if (typeof match === "string") {
    if (hasGlobChars(match)) return globToRegExp(match).test(request.url);
    return request.url.includes(match);
  }
  return false;
}

function sameMatch(left: RouteMatch | undefined, right: RouteMatch) {
  if (left === right) return true;
  if (left instanceof RegExp && right instanceof RegExp)
    return left.source === right.source && left.flags === right.flags;
  return false;
}

function toHeaderEntries(headers: RouteHeaders | null | undefined): HeaderEntry[] {
  if (!headers) return [];
  if (Array.isArray(headers)) {
    return headers.map((header) => ({ name: String(header.name), value: String(header.value ?? "") }));
  }
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value ?? "") }));
}

function encodeBody(body: unknown) {
  if (body == null) return "";
  if (Buffer.isBuffer(body)) return body.toString("base64");
  if (body instanceof Uint8Array) return Buffer.from(body).toString("base64");
  return Buffer.from(String(body)).toString("base64");
}

function buildContinue(requestId: string, { url, method, headers, postData }: RouteContinueOverrides = {}) {
  const params: { requestId: string; url?: string; method?: string; headers?: HeaderEntry[]; postData?: string } = {
    requestId,
  };
  if (url !== undefined) params.url = url;
  if (method !== undefined) params.method = method;
  if (headers !== undefined) params.headers = toHeaderEntries(headers);
  if (postData !== undefined) params.postData = encodeBody(postData);
  return params;
}

function buildFulfill(
  requestId: string,
  { status = 200, headers = {}, contentType, body = "" }: RouteFulfillOptions = {},
) {
  const responseHeaders = toHeaderEntries(headers);
  if (contentType != null && String(contentType).length > 0) {
    const hasType = responseHeaders.some((header) => header.name.toLowerCase() === "content-type");
    if (!hasType) responseHeaders.push({ name: "content-type", value: String(contentType) });
  }
  return {
    requestId,
    responseCode: status,
    responseHeaders,
    body: encodeBody(body),
  };
}

export function createRoutes(page: RoutesPage): RoutesController {
  if (!page?.cdp) throw new TypeError("createRoutes requires a page with cdp");
  const existing = controllers.get(page);
  if (existing) return existing;

  const entries: RouteEntry[] = [];
  const warned = new WeakSet<RouteHandler>();
  const settledIds = new Set<string>();
  let enabled = false;
  let sessionId: string | undefined;
  let unsubscribe: CdpUnsubscribe | null = null;
  let lifecycle = Promise.resolve();
  let activeRequests = 0;

  function warnOnce(handler: RouteHandler | undefined, error?: unknown) {
    if (typeof handler === "function") {
      if (warned.has(handler)) return;
      warned.add(handler);
    }
    if (error) console.warn("[routes] route handler failed; continuing request", error);
    else console.warn("[routes] route handler did not settle the request; continuing");
  }

  async function handlePaused(params: CdpEventPayload<"Fetch.requestPaused">, meta: CdpEventMeta) {
    if (!sessionId || meta?.sessionId !== sessionId) return;
    const requestId = params?.requestId;
    if (!requestId || settledIds.has(requestId)) return;
    settledIds.add(requestId);
    activeRequests += 1;

    const request: RouteRequest = {
      url: params.request?.url ?? "",
      method: params.request?.method ?? "GET",
      headers: params.request?.headers ?? {},
      postData: params.request?.postData,
      resourceType: params.resourceType,
    };

    let settled = false;
    const settle = (method: FetchSettleMethod, cdpParams: object): Promise<unknown> => {
      if (settled) return Promise.resolve();
      settled = true;
      settledIds.add(requestId);
      return page.cdp.send(method, cdpParams, sessionId);
    };

    const candidates = entries.slice();
    let index = 0;
    async function dispatch(): Promise<void> {
      while (index < candidates.length) {
        const entry = candidates[index++];
        // index < candidates.length was just checked.
        if (entry === undefined) break;
        if (!entries.includes(entry) || !matches(entry.match, request)) continue;
        if (--entry.remaining === 0) entries.splice(entries.indexOf(entry), 1);
        let acted = false;
        let fallbackPromise: Promise<void> | undefined;
        const pausedRoute: Route = {
          request,
          continue(overrides = {}) {
            acted = true;
            return settle("Fetch.continueRequest", buildContinue(requestId, overrides));
          },
          fulfill(options = {}) {
            acted = true;
            return settle("Fetch.fulfillRequest", buildFulfill(requestId, options));
          },
          abort(errorReason = "Failed") {
            acted = true;
            return settle("Fetch.failRequest", { requestId, errorReason });
          },
          fallback() {
            if (acted || settled) return Promise.resolve();
            acted = true;
            fallbackPromise = dispatch();
            return fallbackPromise;
          },
        };
        try {
          await entry.handler(pausedRoute);
          await fallbackPromise;
        } catch (error) {
          warnOnce(entry.handler, error);
        }
        if (!acted && !settled) warnOnce(entry.handler);
        break;
      }
      if (!settled) await settle("Fetch.continueRequest", { requestId });
    }
    try {
      await dispatch();
    } catch (error) {
      warnOnce(undefined, error);
      if (!settled) await settle("Fetch.continueRequest", { requestId });
    } finally {
      activeRequests -= 1;
      if (entries.length === 0 && activeRequests === 0) await syncFetch();
    }
  }

  function onPaused(params: CdpEventPayload<"Fetch.requestPaused">, meta: CdpEventMeta) {
    void handlePaused(params, meta).catch((error: unknown) => {
      console.warn("[routes] requestPaused handling failed", error);
    });
  }

  function syncFetch(): Promise<void> {
    const operation = lifecycle.then(async () => {
      if (entries.length > 0) {
        if (enabled) return;
        sessionId = await page.resolveSessionId();
        if (!unsubscribe) unsubscribe = page.cdp.on("Fetch.requestPaused", onPaused);
        try {
          await page.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId);
        } catch (error) {
          unsubscribe?.();
          unsubscribe = null;
          throw error;
        }
        enabled = true;
      } else if (enabled) {
        await page.cdp.send("Fetch.disable", {}, sessionId);
        enabled = false;
        // enabled is only ever true while a subscription is held.
        unsubscribe?.();
        unsubscribe = null;
        settledIds.clear();
      }
    });
    lifecycle = operation.catch(() => {});
    return operation;
  }

  async function route(
    match: RouteMatch,
    handler: RouteHandler,
    { times = Infinity, prepend = false }: RouteOptions = {},
  ) {
    if (typeof handler !== "function") throw new TypeError("handler must be a function");
    if (times !== Infinity && (!Number.isInteger(times) || times < 1))
      throw new TypeError("times must be a positive integer");
    const entry: RouteEntry = { match, handler, remaining: times };
    if (prepend) entries.unshift(entry);
    else entries.push(entry);
    try {
      await syncFetch();
    } catch (error) {
      const index = entries.indexOf(entry);
      if (index !== -1) entries.splice(index, 1);
      throw error;
    }
  }

  async function unroute(match?: RouteMatch, handler?: RouteHandler) {
    if (match === undefined) entries.length = 0;
    else {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (sameMatch(entries[index]?.match, match) && (handler === undefined || entries[index]?.handler === handler))
          entries.splice(index, 1);
      }
    }
    await syncFetch();
  }

  async function dispose() {
    entries.length = 0;
    await syncFetch();
  }

  const controller: RoutesController = {
    route,
    unroute,
    dispose,
    get enabled() {
      return enabled;
    },
  };
  controllers.set(page, controller);
  return controller;
}
