/**
 * Request interception via the CDP Fetch domain.
 *
 * Enabling Fetch changes request timing and blocking patterns that bot
 * defenses can fingerprint. Keep interception off by default and scope
 * patterns tightly.
 */

function globToRegExp(glob) {
  let source = "";
  for (const char of glob) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else if ("\\^$+{}[]()|.".includes(char)) source += `\\${char}`;
    else source += char;
  }
  return new RegExp(`^${source}$`);
}

function hasGlobChars(value) {
  return value.includes("*") || value.includes("?");
}

function matches(match, request) {
  if (typeof match === "function") {
    return Boolean(match({
      url: request.url,
      method: request.method,
      resourceType: request.resourceType,
      headers: request.headers,
    }));
  }
  if (match instanceof RegExp) return match.test(request.url);
  if (typeof match === "string") {
    if (hasGlobChars(match)) return globToRegExp(match).test(request.url);
    return request.url.includes(match);
  }
  return false;
}

function sameMatch(left, right) {
  if (left === right) return true;
  if (left instanceof RegExp && right instanceof RegExp) return left.source === right.source && left.flags === right.flags;
  return false;
}

function toHeaderEntries(headers) {
  if (!headers) return [];
  if (Array.isArray(headers)) {
    return headers.map(header => ({ name: String(header.name), value: String(header.value ?? "") }));
  }
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value ?? "") }));
}

function encodeBody(body) {
  if (body == null) return "";
  if (Buffer.isBuffer(body)) return body.toString("base64");
  if (body instanceof Uint8Array) return Buffer.from(body).toString("base64");
  return Buffer.from(String(body)).toString("base64");
}

function buildContinue(requestId, { url, method, headers, postData } = {}) {
  const params = { requestId };
  if (url !== undefined) params.url = url;
  if (method !== undefined) params.method = method;
  if (headers !== undefined) params.headers = toHeaderEntries(headers);
  if (postData !== undefined) params.postData = encodeBody(postData);
  return params;
}

function buildFulfill(requestId, { status = 200, headers = {}, contentType, body = "" } = {}) {
  const responseHeaders = toHeaderEntries(headers);
  if (contentType != null && String(contentType).length > 0) {
    const hasType = responseHeaders.some(header => header.name.toLowerCase() === "content-type");
    if (!hasType) responseHeaders.push({ name: "content-type", value: String(contentType) });
  }
  return {
    requestId,
    responseCode: status,
    responseHeaders,
    body: encodeBody(body),
  };
}

export function createRoutes(page) {
  if (!page?.cdp) throw new TypeError("createRoutes requires a page with cdp");

  const entries = [];
  const warned = new WeakSet();
  const settledIds = new Set();
  let enabled = false;
  let sessionId;
  let unsubscribe = null;
  let enablePromise = null;

  function warnOnce(handler, error) {
    if (typeof handler === "function") {
      if (warned.has(handler)) return;
      warned.add(handler);
    }
    if (error) console.warn("[routes] route handler failed; continuing request", error);
    else console.warn("[routes] route handler did not settle the request; continuing");
  }

  function findHandler(request) {
    for (const entry of entries) {
      if (matches(entry.match, request)) return entry.handler;
    }
    return undefined;
  }

  async function handlePaused(params, meta) {
    if (!sessionId || meta?.sessionId !== sessionId) return;
    const requestId = params?.requestId;
    if (!requestId || settledIds.has(requestId)) return;

    const request = {
      url: params.request?.url ?? "",
      method: params.request?.method ?? "GET",
      headers: params.request?.headers ?? {},
      postData: params.request?.postData,
      resourceType: params.resourceType,
    };

    let settled = false;
    const settle = (method, cdpParams) => {
      if (settled) return Promise.resolve();
      settled = true;
      settledIds.add(requestId);
      return page.cdp.send(method, cdpParams, sessionId);
    };

    const route = {
      request,
      continue(overrides = {}) {
        return settle("Fetch.continueRequest", buildContinue(requestId, overrides));
      },
      fulfill(options = {}) {
        return settle("Fetch.fulfillRequest", buildFulfill(requestId, options));
      },
      abort(errorReason = "Failed") {
        return settle("Fetch.failRequest", { requestId, errorReason });
      },
    };

    const handler = findHandler(request);
    if (!handler) {
      await settle("Fetch.continueRequest", { requestId });
      return;
    }

    try {
      await handler(route);
    } catch (error) {
      warnOnce(handler, error);
    }
    if (!settled) {
      warnOnce(handler);
      await settle("Fetch.continueRequest", { requestId });
    }
  }

  function onPaused(params, meta) {
    void handlePaused(params, meta).catch(error => {
      console.warn("[routes] requestPaused handling failed", error);
    });
  }

  async function ensureEnabled() {
    if (enabled) return;
    if (!enablePromise) {
      enablePromise = (async () => {
        sessionId = await page.resolveSessionId();
        if (!unsubscribe) unsubscribe = page.cdp.on("Fetch.requestPaused", onPaused);
        await page.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId);
        enabled = true;
      })();
    }
    try {
      await enablePromise;
    } catch (error) {
      enablePromise = null;
      throw error;
    }
  }

  async function disableFetch() {
    const pending = enablePromise;
    enablePromise = null;
    if (pending) await pending.catch(() => {});
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (!enabled) return;
    enabled = false;
    await page.cdp.send("Fetch.disable", {}, sessionId);
  }

  async function route(match, handler) {
    if (typeof handler !== "function") throw new TypeError("handler must be a function");
    entries.push({ match, handler });
    await ensureEnabled();
  }

  async function unroute(match) {
    if (match === undefined) entries.length = 0;
    else {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (sameMatch(entries[index].match, match)) entries.splice(index, 1);
      }
    }
    if (entries.length === 0) await disableFetch();
  }

  async function dispose() {
    entries.length = 0;
    await disableFetch();
  }

  return {
    route,
    unroute,
    dispose,
    get enabled() {
      return enabled;
    },
  };
}
