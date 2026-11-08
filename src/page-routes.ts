import { readFile } from "node:fs/promises";
import { createRoutes } from "./routes.ts";
import type {
  Route,
  RouteContinueOverrides,
  RouteFulfillOptions,
  RouteHandler,
  RouteMatch,
  RouteMatchPredicate,
  RoutesPage,
} from "./routes.ts";

/** Playwright-style request view handed to a page.route() handler. */
export interface PageRouteRequest {
  url(): string;
  method(): string;
  headers(): Record<string, string>;
  postData(): string | null;
  resourceType(): string;
}

export interface PageRouteFulfillOptions extends RouteFulfillOptions {
  json?: unknown;
  path?: string | undefined;
}

export interface PageRoute {
  request(): PageRouteRequest;
  continue(overrides?: RouteContinueOverrides): Promise<unknown>;
  fallback(): Promise<void>;
  abort(errorCode?: string): Promise<unknown>;
  fulfill(options?: PageRouteFulfillOptions): Promise<unknown>;
}

export type PageRouteHandler = (route: PageRoute, request: PageRouteRequest) => unknown;
export type PageRouteUrlPredicate = (url: URL) => unknown;
/** A glob (`*`, `**`, `{a,b}`), a RegExp, or a predicate over the parsed URL. */
export type PageRouteUrl = string | RegExp | PageRouteUrlPredicate;

export interface PageRouteOptions {
  times?: number | undefined;
}

const predicates = new WeakMap<PageRouteUrlPredicate, RouteMatchPredicate>();
const handlers = new WeakMap<PageRouteHandler, RouteHandler>();
const abortReasons: Readonly<Record<string, string>> = {
  aborted: "Aborted",
  accessdenied: "AccessDenied",
  addressunreachable: "AddressUnreachable",
  blockedbyclient: "BlockedByClient",
  blockedbyresponse: "BlockedByResponse",
  connectionaborted: "ConnectionAborted",
  connectionclosed: "ConnectionClosed",
  connectionfailed: "ConnectionFailed",
  connectionrefused: "ConnectionRefused",
  connectionreset: "ConnectionReset",
  internetdisconnected: "InternetDisconnected",
  namenotresolved: "NameNotResolved",
  timedout: "TimedOut",
  failed: "Failed",
};

function urlMatcher(match: PageRouteUrl): RouteMatch {
  if (typeof match === "function") {
    let predicate = predicates.get(match);
    if (!predicate) {
      predicate = (request) => match(new URL(request.url));
      predicates.set(match, predicate);
    }
    return predicate;
  }
  if (match instanceof RegExp) {
    // Avoid stateful /g and /y matching while keeping unroute's pattern identity.
    return new RegExp(match.source, match.flags.replace(/[gy]/g, ""));
  }
  if (typeof match !== "string") throw new TypeError("url must be a glob string, RegExp or predicate");
  let source = "";
  let groups = 0;
  for (let index = 0; index < match.length; index += 1) {
    const char = match.charAt(index);
    if (char === "\\") {
      const literal = match[++index] ?? "\\";
      source += literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (char === "*") {
      const start = index;
      while (match[index + 1] === "*") index += 1;
      const deep =
        index > start &&
        (start === 0 || match[start - 1] === "/") &&
        (index + 1 === match.length || match[index + 1] === "/");
      if (deep && match[index + 1] === "/") {
        source += "(?:.*/)?";
        index += 1;
      } else source += deep ? ".*" : "[^/]*";
    } else if (char === "{") {
      source += "(?:";
      groups += 1;
    } else if (char === "}" && groups > 0) {
      source += ")";
      groups -= 1;
    } else if (char === "," && groups > 0) source += "|";
    else source += char.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function adaptHandler(handler: PageRouteHandler): RouteHandler {
  if (typeof handler !== "function") throw new TypeError("handler must be a function");
  const adapted = handlers.get(handler);
  if (adapted) return adapted;
  const created = (raw: Route) => {
    const request: PageRouteRequest = {
      url: () => raw.request.url,
      method: () => raw.request.method,
      headers: () =>
        Object.fromEntries(Object.entries(raw.request.headers).map(([key, value]) => [key.toLowerCase(), value])),
      postData: () => raw.request.postData ?? null,
      resourceType: () => raw.request.resourceType?.toLowerCase(),
    };
    const route: PageRoute = {
      request: () => request,
      continue: (overrides) => raw.continue(overrides),
      fallback: () => raw.fallback(),
      abort(errorCode = "failed") {
        const reason = abortReasons[errorCode];
        if (!reason) throw new TypeError(`Unknown error code: ${errorCode}`);
        return raw.abort(reason);
      },
      async fulfill(options = {}) {
        let { body, contentType } = options;
        if (options.json !== undefined) {
          body = JSON.stringify(options.json);
          contentType ??= "application/json";
        } else if (options.path !== undefined) {
          body = await readFile(options.path);
        }
        return raw.fulfill({ ...options, body, contentType });
      },
    };
    return handler(route, request);
  };
  handlers.set(handler, created);
  return created;
}

export function pageRoute(
  page: RoutesPage,
  match: PageRouteUrl,
  handler: PageRouteHandler,
  options: PageRouteOptions = {},
) {
  return createRoutes(page).route(urlMatcher(match), adaptHandler(handler), { times: options.times, prepend: true });
}

export function pageUnroute(page: RoutesPage, match: PageRouteUrl, handler?: PageRouteHandler) {
  return createRoutes(page).unroute(urlMatcher(match), handler === undefined ? undefined : adaptHandler(handler));
}

export function pageUnrouteAll(page: RoutesPage) {
  return createRoutes(page).unroute();
}
