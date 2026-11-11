import manifest from "../package.json" with { type: "json" };

const HTTP_VERSION = "HTTP/1.1";
const CREATOR = Object.freeze({ name: "omowright", version: manifest.version });

export type HeaderMap = Readonly<Record<string, unknown>>;

export interface HarSourceEntry {
  startedAt?: unknown;
  finishedAt?: unknown;
  method?: string;
  url?: string;
  postData?: string | null;
  requestHeaders?: HeaderMap | null;
  responseHeaders?: HeaderMap | null;
  encodedDataLength?: number | null;
  mimeType?: string | null;
  body?: unknown;
  base64Encoded?: boolean;
  failed?: boolean;
  status?: number | null;
  statusText?: string | null;
  errorText?: string | null;
}

export interface HarNameValue {
  name: string;
  value: string;
}

export interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  cookies: HarNameValue[];
  headers: HarNameValue[];
  queryString: HarNameValue[];
  headersSize: number;
  bodySize: number;
  postData?: { mimeType: string; text: string };
}

export interface HarContent {
  size: number;
  mimeType: string;
  text?: string;
  encoding?: string;
}

export interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  cookies: HarNameValue[];
  headers: HarNameValue[];
  content: HarContent;
  redirectURL: string;
  headersSize: number;
  bodySize: number;
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
  _errorText?: string;
}

export interface HarCreator {
  name: string;
  version: string;
}

export interface ToHarOptions {
  creator?: HarCreator;
  pages?: unknown[];
}

function headerList(headers: HeaderMap | null | undefined): HarNameValue[] {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value: String(value) }));
}

function headerValue(headers: HeaderMap | null | undefined, name: string) {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name) return String(value);
  }
  return null;
}

function queryString(url: unknown): HarNameValue[] {
  try {
    return [...new URL(String(url)).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    // Non-absolute or malformed urls carry no parsable query.
    return [];
  }
}

function elapsed(entry: HarSourceEntry) {
  const started = Number(entry.startedAt);
  const finished = Number(entry.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return 0;
  return Math.max(0, finished - started);
}

function requestOf(entry: HarSourceEntry): HarRequest {
  const postData = entry.postData ?? null;
  const request: HarRequest = {
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

function contentOf(entry: HarSourceEntry): HarContent {
  const content: HarContent = {
    size: Number(entry.encodedDataLength ?? 0),
    mimeType: entry.mimeType ?? "",
  };
  if (typeof entry.body === "string") content.text = entry.body;
  if (entry.base64Encoded) content.encoding = "base64";
  return content;
}

function responseOf(entry: HarSourceEntry): HarResponse {
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
export function toHar(
  entries: Iterable<HarSourceEntry> | null | undefined,
  { creator = CREATOR, pages = [] }: ToHarOptions = {},
) {
  const log = {
    version: "1.2",
    creator,
    pages,
    entries: [...(entries ?? [])].map((entry) => {
      const time = elapsed(entry);
      const har: HarEntry = {
        startedDateTime: new Date(Number(entry.startedAt) || 0).toISOString(),
        time,
        request: requestOf(entry),
        response: responseOf(entry),
        cache: {},
        timings: { send: 0, wait: time, receive: 0 },
      };
      if (entry.failed) Object.assign(har, { _errorText: entry.errorText ?? "" });
      return har;
    }),
  };
  return { log };
}
