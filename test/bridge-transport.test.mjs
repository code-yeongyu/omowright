import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createNativeMessagingHost, encodeFrame, decodeFrames, installNativeMessagingHost, ExtensionHelloSchema, EventSchema, createChromeApi, BridgeProtocolError } from "../src/index.js";

const extensionId = "a".repeat(32);
const hello = { protocol: 1, type: "hello", role: "extension", connectionId: "c1", extensionId, extensionVersion: "0.1.0", events: ["tabs.activated"], commands: ["bookmarks.create"], maxMessageBytes: 1024 * 1024 };
function streams() { return { input: new PassThrough(), output: new PassThrough(), error: new PassThrough() }; }
function readOne(stream) { return new Promise((resolve, reject) => { const chunks = []; const onData = chunk => { chunks.push(chunk); const parsed = decodeFrames(Buffer.concat(chunks)); if (parsed.frames.length) { stream.off("data", onData); resolve(parsed.frames[0]); } }; stream.on("data", onData); stream.once("error", reject); }); }

test("native frames support splits and multiple messages with exact binary contract", () => {
  const frame = encodeFrame({ ok: true });
  assert.equal(frame.readUInt32LE(0), frame.length - 4);
  assert.equal(frame.at(-1), 0x7d);
  assert.equal(frame.includes(0x0a), false);
  for (let i = 0; i <= frame.length; i++) { const first = decodeFrames(frame.subarray(0, i)); const second = decodeFrames(Buffer.concat([first.remainder, frame.subarray(i)])); assert.deepEqual([...first.frames, ...second.frames], [{ ok: true }]); }
  assert.deepEqual(decodeFrames(Buffer.concat([frame, frame])).frames, [{ ok: true }, { ok: true }]);
});

test("native frame parser rejects malformed and oversized messages", () => {
  assert.throws(() => decodeFrames(Buffer.from([0, 0, 0, 0])), BridgeProtocolError);
  assert.throws(() => decodeFrames(Buffer.from([1, 0, 0, 0, 0xff])), BridgeProtocolError);
  assert.throws(() => encodeFrame({ x: "x" }, 1), BridgeProtocolError);
});

test("strict schemas reject unknown names and fields", () => {
  assert.equal(ExtensionHelloSchema.safeParse(hello).success, true);
  assert.equal(ExtensionHelloSchema.safeParse({ ...hello, extra: true }).success, false);
  assert.equal(EventSchema.safeParse({ protocol: 1, type: "event", connectionId: "c1", seq: 1, occurredAt: 1, name: "tabs.activated", payload: { tabId: 2, windowId: 1, extra: true } }).success, false);
});

test("host validates hello, negotiates capabilities, correlates response, and forwards events", async () => {
  const s = streams(); const events = [];
  const host = createNativeMessagingHost({ stdin: s.input, stdout: s.output, stderr: s.error, extensionId, onEvent: event => events.push(event) });
  s.input.write(encodeFrame(hello));
  const hostHello = await readOne(s.output);
  assert.equal(hostHello.protocol, 1); assert.equal(hostHello.type, "hello"); assert.equal(hostHello.role, "host"); assert.equal(typeof hostHello.connectionId, "string"); assert.equal(hostHello.hostName, "com.omowright.cloakbridge"); assert.deepEqual(hostHello.commands, ["bookmarks.create"]);
  const request = host.request("bookmarks.create", { details: { title: "x" } });
  const sent = await readOne(s.output);
  assert.equal(sent.name, "bookmarks.create");
  s.input.write(encodeFrame({ protocol: 1, type: "response", requestId: sent.requestId, name: sent.name, ok: true, result: { id: "1", title: "x" } }));
  assert.deepEqual(await request, { id: "1", title: "x" });
  s.input.write(encodeFrame({ protocol: 1, type: "event", connectionId: "c1", seq: 1, occurredAt: 1, name: "tabs.activated", payload: { tabId: 4, windowId: 1 } }));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(events[0].payload.tabId, 4); host.close();
});

test("registration writes pinned manifest atomically and rejects unverified CloakBrowser path", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-reg-")); const executable = path.join(root, "host"); writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 }); const dir = path.join(root, "hosts");
  const result = await installNativeMessagingHost({ hostPath: executable, extensionId, nativeMessagingHostDir: dir });
  assert.deepEqual(JSON.parse(readFileSync(result.path)), result.manifest); assert.equal(result.manifest.allowed_origins[0], `chrome-extension://${extensionId}/`); assert.equal(statSync(result.path).mode & 0o777, 0o600);
  await assert.rejects(() => installNativeMessagingHost({ hostPath: executable, extensionId, browser: "cloakbrowser" }), /explicit and verified/); rmSync(root, { recursive: true, force: true });
});

test("chrome API routes negotiated writes and preserves unsupported fallback", async () => {
  const calls = []; const bridge = { isConnected: true, capabilities: { commands: new Set(["bookmarks.create"]), events: new Set() }, request: async (...args) => { calls.push(args); return { id: "2", title: "x" }; } };
  const chrome = createChromeApi({}, { bridge }); assert.deepEqual(await chrome.bookmarks.create({ title: "x" }), { id: "2", title: "x" }); assert.deepEqual(calls[0], ["bookmarks.create", { details: { title: "x" }}]); await assert.rejects(() => chrome.history.deleteUrl({ url: "https://x.test/" }), /requires the Aside extension bridge/);
});

test("decoder accepts literal replacement characters but rejects malformed UTF-8", () => {
  const frame = encodeFrame({ text: "literal \\ufffd" }); assert.deepEqual(decodeFrames(frame).frames, [{ text: "literal \\ufffd" }]);
  assert.throws(() => decodeFrames(Buffer.from([1, 0, 0, 0, 0xc3])), /invalid UTF-8/);
});

test("mutations wait for the prior response and duplicate event sequences disconnect", async () => {
  const s = streams(); const host = createNativeMessagingHost({ stdin: s.input, stdout: s.output, stderr: s.error, extensionId }); s.input.write(encodeFrame(hello)); await readOne(s.output);
  const first = host.request("bookmarks.create", { details: { title: "one" } }); const sent1 = await readOne(s.output); const second = host.request("bookmarks.create", { details: { title: "two" } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(s.output.readableLength, 0);
  s.input.write(encodeFrame({ protocol: 1, type: "response", requestId: sent1.requestId, name: sent1.name, ok: true, result: { id: "1", title: "one" } })); await first; const sent2 = await readOne(s.output); assert.equal(sent2.params.details.title, "two"); s.input.write(encodeFrame({ protocol: 1, type: "response", requestId: sent2.requestId, name: sent2.name, ok: true, result: { id: "2", title: "two" } })); await second;
  const event = { protocol: 1, type: "event", connectionId: "c1", seq: 1, occurredAt: 1, name: "tabs.activated", payload: { tabId: 1, windowId: 1 } }; s.input.write(encodeFrame(event)); await new Promise(resolve => setImmediate(resolve)); s.input.write(encodeFrame({ ...event, seq: 1 })); await new Promise(resolve => setImmediate(resolve)); assert.equal(host.isConnected, false); await second.catch(() => {}); host.close();
});

test("registration rejects endpointPath, unsafe host names, and overwrites only with force", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-reg-hardening-")); const executable = path.join(root, "host"); writeFileSync(executable, "#!/bin/sh\\n", { mode: 0o755 }); const dir = path.join(root, "hosts");
  await assert.rejects(() => installNativeMessagingHost({ hostPath: executable, extensionId, nativeMessagingHostDir: dir, endpointPath: "/tmp/x" }), /endpointPath/); await assert.rejects(() => installNativeMessagingHost({ hostPath: executable, extensionId, hostName: "../evil", nativeMessagingHostDir: dir }), /hostName/);
  await installNativeMessagingHost({ hostPath: executable, extensionId, nativeMessagingHostDir: dir }); await assert.rejects(() => installNativeMessagingHost({ hostPath: executable, extensionId, nativeMessagingHostDir: dir }), /already exists/); await installNativeMessagingHost({ hostPath: executable, extensionId, nativeMessagingHostDir: dir, force: true }); rmSync(root, { recursive: true, force: true });
});
