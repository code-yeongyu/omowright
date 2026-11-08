import { test } from "node:test";
import assert from "node:assert/strict";
import { toHar } from "../src/har.js";

const JSON_BODY = '{"ok":true}';
const PNG_BASE64 = Buffer.from("\x89PNG\r\n\x1a\n", "binary").toString("base64");

function entry(overrides = {}) {
  return {
    requestId: "r1",
    url: "https://x.test/api/items?page=2&q=hello%20world",
    method: "GET",
    resourceType: "XHR",
    status: 200,
    statusText: "OK",
    mimeType: "application/json",
    requestHeaders: { accept: "*/*", "x-trace": "1" },
    responseHeaders: { "content-type": "application/json", "content-length": "11" },
    postData: null,
    encodedDataLength: 11,
    body: JSON_BODY,
    base64Encoded: false,
    bodySkipped: false,
    failed: false,
    errorText: null,
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_000_250,
    ...overrides,
  };
}

test("toHar builds a HAR 1.2 log with creator and pages", () => {
  const har = toHar([entry()]);
  assert.equal(har.log.version, "1.2");
  assert.equal(har.log.creator.name, "omowright");
  assert.equal(typeof har.log.creator.version, "string");
  assert.deepEqual(har.log.pages, []);
  assert.equal(har.log.entries.length, 1);
  assert.deepEqual(toHar([]), {
    log: { version: "1.2", creator: har.log.creator, pages: [], entries: [] },
  });

  const custom = toHar([], { creator: { name: "custom", version: "9.9.9" }, pages: [{ id: "page_1" }] });
  assert.deepEqual(custom.log.creator, { name: "custom", version: "9.9.9" });
  assert.deepEqual(custom.log.pages, [{ id: "page_1" }]);
});

test("toHar maps a request onto the HAR request shape", () => {
  const [har] = toHar([entry()]).log.entries;
  assert.equal(har.startedDateTime, new Date(1_700_000_000_000).toISOString());
  assert.equal(har.time, 250);
  assert.equal(har.request.method, "GET");
  assert.equal(har.request.url, "https://x.test/api/items?page=2&q=hello%20world");
  assert.equal(har.request.httpVersion, "HTTP/1.1");
  assert.deepEqual(har.request.cookies, []);
  assert.deepEqual(har.request.headers, [
    { name: "accept", value: "*/*" },
    { name: "x-trace", value: "1" },
  ]);
  assert.deepEqual(har.request.queryString, [
    { name: "page", value: "2" },
    { name: "q", value: "hello world" },
  ]);
  assert.equal(har.request.headersSize, -1);
  assert.equal(har.request.bodySize, 0);
  assert.equal(har.request.postData, undefined);
  assert.deepEqual(har.cache, {});
  assert.deepEqual(har.timings, { send: 0, wait: 250, receive: 0 });
});

test("toHar maps a response onto the HAR response shape", () => {
  const [har] = toHar([entry()]).log.entries;
  assert.equal(har.response.status, 200);
  assert.equal(har.response.statusText, "OK");
  assert.equal(har.response.httpVersion, "HTTP/1.1");
  assert.deepEqual(har.response.cookies, []);
  assert.deepEqual(har.response.headers, [
    { name: "content-type", value: "application/json" },
    { name: "content-length", value: "11" },
  ]);
  assert.equal(har.response.content.size, 11);
  assert.equal(har.response.content.mimeType, "application/json");
  assert.equal(har.response.content.text, JSON_BODY);
  assert.deepEqual(JSON.parse(har.response.content.text), { ok: true });
  assert.equal(har.response.content.encoding, undefined);
  assert.equal(har.response.redirectURL, "");
  assert.equal(har.response.headersSize, -1);
  assert.equal(har.response.bodySize, 11);
  assert.equal(har._errorText, undefined);
});

test("toHar flags base64 bodies and carries redirect locations", () => {
  const [har] = toHar([entry({
    url: "https://x.test/pixel.png",
    mimeType: "image/png",
    responseHeaders: { "content-type": "image/png", location: "https://x.test/moved.png" },
    status: 302,
    statusText: "Found",
    body: PNG_BASE64,
    base64Encoded: true,
    encodedDataLength: 8,
  })]).log.entries;
  assert.equal(har.response.content.encoding, "base64");
  assert.equal(har.response.content.text, PNG_BASE64);
  assert.equal(har.response.content.mimeType, "image/png");
  assert.equal(har.response.redirectURL, "https://x.test/moved.png");
  assert.deepEqual(har.request.queryString, []);
});

test("toHar writes postData with the request content type", () => {
  const [har] = toHar([entry({
    method: "POST",
    postData: '{"q":1}',
    requestHeaders: { "content-type": "application/json; charset=utf-8" },
  })]).log.entries;
  assert.equal(har.request.bodySize, 7);
  assert.deepEqual(har.request.postData, {
    mimeType: "application/json; charset=utf-8",
    text: '{"q":1}',
  });
});

test("toHar gives failed entries status 0 and _errorText", () => {
  const [har] = toHar([entry({
    status: null,
    statusText: null,
    mimeType: null,
    responseHeaders: null,
    body: null,
    failed: true,
    errorText: "net::ERR_ABORTED",
    encodedDataLength: 0,
    finishedAt: 1_700_000_000_000,
  })]).log.entries;
  assert.equal(har.response.status, 0);
  assert.equal(har.response.statusText, "");
  assert.deepEqual(har.response.headers, []);
  assert.equal(har.response.content.size, 0);
  assert.equal(har.response.content.text, undefined);
  assert.equal(har._errorText, "net::ERR_ABORTED");
  assert.equal(har.time, 0);
});

test("toHar never emits negative times for unfinished or clock-skewed entries", () => {
  const entries = toHar([
    entry({ finishedAt: null }),
    entry({ finishedAt: 1_699_999_999_000 }),
  ]).log.entries;
  assert.equal(entries.length, 2);
  for (const har of entries) {
    assert.equal(har.time, 0);
    assert.deepEqual(har.timings, { send: 0, wait: 0, receive: 0 });
  }
});
