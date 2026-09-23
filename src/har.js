const HTTP_VERSION = "HTTP/1.1";
// Kept in sync with package.json; har.js stays pure so it never reads the manifest from disk.
const CREATOR = Object.freeze({ name: "omowright", version: "0.0.1" });

function headerList(headers) {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value: String(value) }));
}

function headerValue(headers, name) {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name) return String(value);
  }
  return null;
}

function queryString(url) {
  try {
    return [...new URL(String(url)).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    // Non-absolute or malformed urls carry no parsable query.
    return [];
  }
}

function elapsed(entry) {
  const started = Number(entry.startedAt);
  const finished = Number(entry.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return 0;
  return Math.max(0, finished - started);
}

function requestOf(entry) {
  const postData = entry.postData ?? null;
  const request = {
    method: entry.method ?? "GET",
    url: entry.url ?? "",
    httpVersion: HTTP_VERSION,
    cookies: [],
    headers: headerList(entry.requestHeaders),
    queryString: queryString(entry.url),
    headersSize: -1,
    bodySize: postData === null ? 0 : Buffer.byteLength(postData),
  };
  if (postData !== null) {
    request.postData = {
      mimeType: headerValue(entry.requestHeaders, "content-type") ?? "",
      text: postData,
    };
  }
  return request;
}

function contentOf(entry) {
  const content = {
    size: Number(entry.encodedDataLength ?? 0),
    mimeType: entry.mimeType ?? "",
  };
  if (typeof entry.body === "string") content.text = entry.body;
  if (entry.base64Encoded) content.encoding = "base64";
  return content;
}

function responseOf(entry) {
  return {
    status: entry.failed ? 0 : Number(entry.status ?? 0),
    statusText: entry.statusText ?? "",
    httpVersion: HTTP_VERSION,
    cookies: [],
    headers: headerList(entry.responseHeaders),
    content: contentOf(entry),
    redirectURL: headerValue(entry.responseHeaders, "location") ?? "",
    headersSize: -1,
    bodySize: Number(entry.encodedDataLength ?? 0),
  };
}

/**
 * Converts network snoop entries into a HAR 1.2 log.
 *
 * Pure: it touches no disk and mutates nothing, so callers can serialize the result
 * themselves or embed it in a larger artifact.
 */
export function toHar(entries, { creator = CREATOR, pages = [] } = {}) {
  const log = {
    version: "1.2",
    creator,
    pages,
    entries: [...entries ?? []].map(entry => {
      const time = elapsed(entry);
      const har = {
        startedDateTime: new Date(Number(entry.startedAt) || 0).toISOString(),
        time,
        request: requestOf(entry),
        response: responseOf(entry),
        cache: {},
        timings: { send: 0, wait: time, receive: 0 },
      };
      if (entry.failed) har._errorText = entry.errorText ?? "";
      return har;
    }),
  };
  return { log };
}
