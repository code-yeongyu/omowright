import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync, mkdirSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createNativeMessagingHost, encodeFrame, decodeFrames, installNativeMessagingHost, ExtensionHelloSchema, EventSchema, ResponseSchema, createChromeApi, BridgeProtocolError } from "../src/index.js";

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

test("timed out mutation fails the connection without sending its successor", async () => {
  const s = streams(); const host = createNativeMessagingHost({ stdin: s.input, stdout: s.output, stderr: s.error, extensionId, commandTimeoutMs: 10 }); s.input.write(encodeFrame(hello)); await readOne(s.output);
  const first = host.request("bookmarks.create", { details: { title: "one" } }); await readOne(s.output); const second = host.request("bookmarks.create", { details: { title: "two" } });
  await assert.rejects(first, error => error.code === "TIMEOUT"); await assert.rejects(second, /indeterminate/); assert.equal(host.isConnected, false); assert.equal(s.output.readableLength, 0);
});

test("command queue is bounded independently of the write queue", async () => {
  const s = streams(); const host = createNativeMessagingHost({ stdin: s.input, stdout: s.output, stderr: s.error, extensionId, maxPendingWrites: 2 }); s.input.write(encodeFrame(hello)); await readOne(s.output);
  const first = host.request("bookmarks.create", { details: { title: "one" } }); const sent = await readOne(s.output); const second = host.request("bookmarks.create", { details: { title: "two" } }); await assert.rejects(host.request("bookmarks.create", { details: { title: "three" } }), /BOUNDED_TRANSPORT/);
  s.input.write(encodeFrame({ protocol: 1, type: "response", requestId: sent.requestId, name: sent.name, ok: true, result: { id: "1", title: "one" } })); await first; const sent2 = await readOne(s.output); s.input.write(encodeFrame({ protocol: 1, type: "response", requestId: sent2.requestId, name: sent2.name, ok: true, result: { id: "2", title: "two" } })); await second; host.close();
});

test("public send rejects unknown envelopes and bookmark results reject unknown fields", async () => {
  const s = streams(); const host = createNativeMessagingHost({ stdin: s.input, stdout: s.output, stderr: s.error, extensionId }); s.input.write(encodeFrame(hello)); await readOne(s.output); await assert.rejects(host.send({ type: "bogus" }), /invalid outbound message type/);
  const request = host.request("bookmarks.create", { details: { title: "x" } }); const sent = await readOne(s.output); const result = { id: "1", title: "x", dateLastUsed: 1, folderType: "bookmarks-bar", syncing: true, futureChromeField: "rejected" }; assert.throws(() => encodeFrame({ protocol: 1, type: "response", requestId: sent.requestId, name: sent.name, ok: true, result }), /invalid outbound message/); host.close(); await assert.rejects(request, /closed/);
});

test("async onEvent rejection is reported without disconnecting", async () => {
  const s = streams(); const host = createNativeMessagingHost({ stdin: s.input, stdout: s.output, stderr: s.error, extensionId, onEvent: async () => { throw new Error("async boom"); } }); s.input.write(encodeFrame(hello)); await readOne(s.output); s.input.write(encodeFrame({ protocol: 1, type: "event", connectionId: "c1", seq: 1, occurredAt: 1, name: "tabs.activated", payload: { tabId: 1, windowId: 1 } })); await new Promise(resolve => setImmediate(resolve)); assert.match(s.error.read().toString(), /async boom/); assert.equal(host.isConnected, true); host.close();
});

test("abort after a received mutation response does not disconnect the bridge", async () => {
  const s = streams(); const controller = new AbortController(); const host = createNativeMessagingHost({ stdin: s.input, stdout: s.output, stderr: s.error, extensionId }); s.input.write(encodeFrame(hello)); await readOne(s.output);
  const request = host.request("bookmarks.create", { details: { title: "done" } }, { signal: controller.signal }); const sent = await readOne(s.output);
  s.input.write(encodeFrame({ protocol: 1, type: "response", requestId: sent.requestId, name: sent.name, ok: true, result: { id: "1", title: "done" } })); assert.deepEqual(await request, { id: "1", title: "done" }); controller.abort();
  assert.deepEqual(await request, { id: "1", title: "done" }); assert.equal(host.isConnected, true); host.close();
});

test("bookmark result schema is recursive and explicitly strict", () => {
  const response = { protocol: 1, type: "response", requestId: "abcdef0123456789", name: "bookmarks.create", ok: true, result: { id: "1", parentId: "0", index: 0, title: "folder", dateAdded: 1, dateGroupModified: 2, dateLastUsed: 3, folderType: "bookmarks-bar", syncing: false, unmodifiable: "managed", children: [{ id: "2", title: "link", url: "https://example.test/" }] } };
  assert.equal(ResponseSchema.safeParse(response).success, true); assert.equal(ResponseSchema.safeParse({ ...response, result: { ...response.result, futureChromeField: true } }).success, false); assert.equal(ResponseSchema.safeParse({ ...response, result: { ...response.result, children: [{ ...response.result.children[0], futureChromeField: true }] } }).success, false);
});

test("registration rejects writable or symlinked directory components", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-reg-components-")); const executable = path.join(root, "host"); writeFileSync(executable, "#!/bin/sh\\n", { mode: 0o755 }); const parent = path.join(root, "parent"); const dir = path.join(parent, "hosts"); mkdirSync(parent); chmodSync(parent, 0o777);
  await assert.rejects(() => installNativeMessagingHost({ hostPath: executable, extensionId, nativeMessagingHostDir: dir }), /security rejected/); chmodSync(parent, 0o700); const linked = path.join(root, "linked"); symlinkSync(parent, linked);
  await assert.rejects(() => installNativeMessagingHost({ hostPath: executable, extensionId, nativeMessagingHostDir: path.join(linked, "hosts") }), /security rejected/); rmSync(root, { recursive: true, force: true });
});

test("settled mutations remove abort listeners and timers", async () => {
  const s = streams(); const controller = new AbortController(); const originalAdd = controller.signal.addEventListener.bind(controller.signal); const originalRemove = controller.signal.removeEventListener.bind(controller.signal); let added = 0; let removed = 0;
  controller.signal.addEventListener = (...args) => { added += 1; return originalAdd(...args); }; controller.signal.removeEventListener = (...args) => { removed += 1; return originalRemove(...args); };
  const host = createNativeMessagingHost({ stdin: s.input, stdout: s.output, stderr: s.error, extensionId, commandTimeoutMs: 60_000 }); s.input.write(encodeFrame(hello)); await readOne(s.output);
  const request = host.request("bookmarks.create", { details: { title: "done" } }, { signal: controller.signal }); const sent = await readOne(s.output);
  assert.equal(added, 1); s.input.write(encodeFrame({ protocol: 1, type: "response", requestId: sent.requestId, name: sent.name, ok: true, result: { id: "1", title: "done" } })); await request;
  assert.equal(removed, 1); controller.abort(); assert.equal(host.isConnected, true); host.close();
});

test("extension protocol errors use a dedicated response name and reconnect indefinitely", () => {
  const source = readFileSync(new URL("../bridge/extension/background.js", import.meta.url), "utf8");
  assert.match(source, /PROTOCOL_ERROR_NAME = [\"']protocolError[\"']/); assert.doesNotMatch(source, /COMMANDS\.includes\(name\) \? name : COMMANDS\[0\]/); assert.match(source, /retries = 0/); assert.doesNotMatch(source, /retries >= 6\) return/); assert.match(source, /retries >= 6/);
});

test("protocolError responses are schema-valid and cannot collide with commands", () => {
  const response = { protocol: 1, type: "response", requestId: "abcdef0123456789", name: "protocolError", ok: false, error: { code: "UNKNOWN_COMMAND", message: "invalid command" } };
  assert.equal(ResponseSchema.safeParse(response).success, true); assert.equal(ResponseSchema.safeParse({ ...response, ok: true, error: undefined, result: {} }).success, false); assert.equal(["bookmarks.create", "bookmarks.move", "bookmarks.remove", "history.deleteUrl", "history.deleteRange", "tabGroups.update", "debugger.attach", "debugger.detach"].includes(response.name), false);
});

test("registration rejects symlinked executables and parent components", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-reg-links-")); const real = path.join(root, "real"); mkdirSync(real); const executable = path.join(real, "host"); writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 }); const linkedHost = path.join(root, "linked-host"); symlinkSync(executable, linkedHost); await assert.rejects(() => installNativeMessagingHost({ hostPath: linkedHost, extensionId, nativeMessagingHostDir: path.join(root, "hosts") }), /owned executable/);
  const linkedParent = path.join(root, "linked-parent"); symlinkSync(real, linkedParent); await assert.rejects(() => installNativeMessagingHost({ hostPath: executable, extensionId, nativeMessagingHostDir: path.join(linkedParent, "hosts") }), /security rejected/); rmSync(root, { recursive: true, force: true });
});
