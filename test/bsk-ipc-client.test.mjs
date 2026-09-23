import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startFakeBskDaemon } from "./fixtures/fake-bsk-daemon.mjs";
import { BskIpcClient, BskRpcError, readDaemonInfo, resolveBskHome } from "../src/bsk/ipc-client.js";

test("resolveBskHome prefers BSK_HOME and falls back to ~/.bsk", () => {
  assert.equal(resolveBskHome({ BSK_HOME: "/x/y", HOME: "/h" }), "/x/y");
  assert.equal(resolveBskHome({ BSK_HOME: "", HOME: "/h" }), path.join("/h", ".bsk"));
});

test("readDaemonInfo parses daemon.json and rejects a missing one", async () => {
  const daemon = await startFakeBskDaemon();
  try {
    const info = readDaemonInfo(daemon.home);
    assert.equal(info.sock_path, daemon.sockPath);
    assert.equal(info.version, "0.3.0-fake");
    assert.equal(info.ws_port, 52800);
  } finally { await daemon.close(); }
  const empty = mkdtempSync(path.join(tmpdir(), "bsk-empty-"));
  try {
    assert.equal(readDaemonInfo(empty), null);
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test("call round-trips a request frame and returns result", async () => {
  const daemon = await startFakeBskDaemon();
  try {
    const client = new BskIpcClient({ home: daemon.home, autoStart: false });
    const result = await client.call("system.ping", {});
    assert.deepEqual(result, { pong: true });
    assert.equal(daemon.requests.length, 1);
    const [frame] = daemon.requests;
    assert.equal(frame.method, "system.ping");
    assert.equal(typeof frame.id, "string");
    assert.ok(frame.id.length >= 8);
    assert.deepEqual(frame.params, {});
  } finally { await daemon.close(); }
});

test("call with a prefix produces ids the daemon can correlate and omits absent params", async () => {
  const daemon = await startFakeBskDaemon({ handlers: { "session.list": () => ({ result: { sessions: [] } }) } });
  try {
    const client = new BskIpcClient({ home: daemon.home, autoStart: false });
    await client.call("session.list", undefined, { idPrefix: "list" });
    assert.match(daemon.requests[0].id, /^list-[0-9a-f]{12}$/);
    assert.equal("params" in daemon.requests[0], false);
  } finally { await daemon.close(); }
});

test("error frames become BskRpcError with the daemon code and data", async () => {
  const daemon = await startFakeBskDaemon({
    handlers: { "tool.click": () => ({ error: { code: "not_found", message: "ref e9 unknown", data: { reason: "ref_not_found" } } }) },
  });
  try {
    const client = new BskIpcClient({ home: daemon.home, autoStart: false });
    await assert.rejects(client.call("tool.click", { session_id: "abcd", ref: "e9" }), (err) => {
      assert.ok(err instanceof BskRpcError);
      assert.equal(err.code, "not_found");
      assert.equal(err.message, "ref e9 unknown");
      assert.deepEqual(err.data, { reason: "ref_not_found" });
      return true;
    });
  } finally { await daemon.close(); }
});

test("an undecodable request is answered under id \"0\" and still surfaces the daemon's error", async () => {
  const daemon = await startFakeBskDaemon({
    handlers: { "no.such": () => JSON.stringify({ id: "0", error: { code: "protocol_error", message: "invalid frame: unknown variant `no.such`" } }) },
  });
  try {
    const client = new BskIpcClient({ home: daemon.home, autoStart: false });
    await assert.rejects(client.call("no.such", {}), (err) => {
      assert.equal(err.code, "protocol_error");
      assert.match(err.message, /unknown variant `no.such`/);
      return true;
    });
  } finally { await daemon.close(); }
});

test("a malformed reply line is a protocol_error, not a hang", async () => {
  const daemon = await startFakeBskDaemon({ handlers: { "system.status": () => "this is not json" } });
  try {
    const client = new BskIpcClient({ home: daemon.home, autoStart: false });
    await assert.rejects(client.call("system.status", {}), (err) => {
      assert.ok(err instanceof BskRpcError);
      assert.equal(err.code, "protocol_error");
      return true;
    });
  } finally { await daemon.close(); }
});

test("a silent daemon trips the per-call timeout with code timeout", async () => {
  const daemon = await startFakeBskDaemon({ handlers: { "tool.navigate": () => undefined } });
  try {
    const client = new BskIpcClient({ home: daemon.home, autoStart: false, timeoutMs: 150 });
    const started = Date.now();
    await assert.rejects(client.call("tool.navigate", { session_id: "abcd", url: "https://example.com" }), (err) => {
      assert.ok(err instanceof BskRpcError);
      assert.equal(err.code, "timeout");
      return true;
    });
    assert.ok(Date.now() - started < 2000, "timeout must not wait for the daemon");
  } finally { await daemon.close(); }
});

test("cancel sends a cancel frame on its own connection while the call is in flight", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const daemon = await startFakeBskDaemon({
    handlers: {
      "tool.navigate": () => undefined, // never answers on its own
      cancel: (frame) => { release(frame); return { result: { cancelled: true } }; },
    },
  });
  try {
    const client = new BskIpcClient({ home: daemon.home, autoStart: false, timeoutMs: 5000 });
    const handle = client.callWithHandle("tool.navigate", { session_id: "abcd", url: "https://slow.example" }, { idPrefix: "navigate" });
    const cancelled = await client.cancel(handle.rpcId);
    const cancelFrame = await gate;
    assert.deepEqual(cancelled, { cancelled: true });
    assert.equal(cancelFrame.method, "cancel");
    assert.deepEqual(cancelFrame.params, { rpc_id: handle.rpcId });
    assert.match(cancelFrame.id, /^cancel-[0-9a-f]{12}$/);
    assert.equal(daemon.requests.length, 2, "two connections, two frames");
    handle.abort();
    await assert.rejects(handle.promise, (err) => err instanceof BskRpcError && err.code === "cancelled");
  } finally { await daemon.close(); }
});

test("abort before the socket is even resolved settles the handle as cancelled without touching the daemon", async () => {
  const daemon = await startFakeBskDaemon();
  try {
    let releaseStart;
    const client = new BskIpcClient({
      home: daemon.home, autoStart: true,
      startDaemon: () => new Promise((resolve) => { releaseStart = resolve; }),
      sockPath: undefined,
    });
    const { rmSync } = await import("node:fs");
    rmSync(path.join(daemon.home, "daemon.json"));
    const handle = client.callWithHandle("system.ping", {});
    handle.abort();
    releaseStart();
    await assert.rejects(handle.promise, (err) => err instanceof BskRpcError && err.code === "cancelled");
    assert.equal(daemon.requests.length, 0);
  } finally { await daemon.close(); }
});

test("with auto-start disabled and no daemon.json the client fails fast and explains why", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bsk-none-"));
  try {
    const client = new BskIpcClient({ home, autoStart: false });
    const started = Date.now();
    await assert.rejects(client.call("system.ping", {}), (err) => {
      assert.ok(err instanceof BskRpcError);
      assert.equal(err.code, "no_daemon");
      assert.match(err.message, /daemon\.json/);
      assert.match(err.message, /BSK_AUTO_START|bsk daemon start/);
      return true;
    });
    assert.ok(Date.now() - started < 1000);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("with auto-start enabled the client runs the starter once and retries discovery", async () => {
  const daemon = await startFakeBskDaemon();
  const home = mkdtempSync(path.join(tmpdir(), "bsk-late-"));
  const { copyFileSync, mkdirSync } = await import("node:fs");
  let starts = 0;
  try {
    const client = new BskIpcClient({
      home,
      autoStart: true,
      startDaemon: async () => {
        starts += 1;
        mkdirSync(path.join(home, "run"), { recursive: true });
        copyFileSync(path.join(daemon.home, "daemon.json"), path.join(home, "daemon.json"));
      },
    });
    const result = await client.call("system.ping", {});
    assert.deepEqual(result, { pong: true });
    assert.equal(starts, 1);
    await client.call("system.ping", {});
    assert.equal(starts, 1, "a discovered daemon is reused without restarting");
  } finally { await daemon.close(); rmSync(home, { recursive: true, force: true }); }
});
