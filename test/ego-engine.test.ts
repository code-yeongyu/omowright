import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, globSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { removeTreeSync } from "./fixtures/remove-tree.ts";
import { CdpSessionCrashedError, EgoCdpClient, EgoCdpError, connectEgo } from "../src/index.ts";
import type { EgoBindings, EgoCdpBindings } from "../src/ego/bindings.ts";
import { Readable, Writable } from "node:stream";
import { field } from "./fixtures/read-field.ts";

// A type literal, so it meets EgoTaskSpace's index signature.
type FakeTaskSpace = {
  taskId: string;
  id: number;
  name: string;
};

interface FakeEgo extends EgoBindings {
  refuse: string | null;
  selected: number | null;
  spaces: FakeTaskSpace[];
  createTaskSpace(name: string): Promise<FakeTaskSpace>;
  useTaskSpace(id: number): void;
  sendCDPMessage(message: unknown): unknown;
}

// Malformed bindings and options on purpose: connectEgo's runtime checks are the boundary under test.
const untyped: { connectEgo(options: object): Promise<unknown> } = { connectEgo };

// A stand-in for Ego Lite's globalThis.ego that relays the raw CDP text to a real headless
// Chromium over --remote-debugging-pipe, so the omowright Page API runs end to end through
// the same three binding slots Ego documents (sendCDPMessage, onCDPMessage, onSendCDPMessageError).
function egoOverRealBrowser(shellBin: string | null | undefined) {
  assert.ok(shellBin, "no chrome-headless-shell found; set SHELL_BIN");
  const profile = mkdtempSync(path.join(tmpdir(), "omow-ego-"));
  const child = spawn(
    shellBin,
    ["--headless", "--no-sandbox", `--user-data-dir=${profile}`, "--remote-debugging-pipe", "about:blank"],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  let buffer = "";
  const toBrowser = child.stdio[3];
  const fromBrowser = child.stdio[4];
  assert.ok(toBrowser instanceof Writable && fromBrowser instanceof Readable, "the CDP pipe fds are streams");
  const ego: FakeEgo = {
    onCDPMessage: undefined,
    onSendCDPMessageError: undefined,
    refuse: null,
    selected: null,
    spaces: [],
    async createTaskSpace(name) {
      const space = { taskId: name, id: ego.spaces.length + 7, name };
      ego.spaces.push(space);
      return space;
    },
    useTaskSpace(id) {
      ego.selected = id;
    },
    sendCDPMessage(message) {
      if (typeof message !== "string")
        throw Object.assign(new TypeError("message must be a string"), { error_code: "EGO_INVALID_ARGUMENT" });
      if (ego.refuse || ego.selected === null) {
        const code = ego.refuse ?? "EGO_TASK_SPACE_NOT_SELECTED";
        setImmediate(() => ego.onSendCDPMessageError?.(message, code));
        return undefined;
      }
      toBrowser.write(`${message}\0`);
      return undefined;
    },
  };
  fromBrowser.setEncoding("utf8");
  fromBrowser.on("data", (chunk: string) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\0")) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      ego.onCDPMessage?.(frame);
    }
  });
  for (const stream of [toBrowser, fromBrowser]) stream.on("error", () => {});
  const stop = async () => {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
    removeTreeSync(profile);
  };
  return { ego, stop };
}

function findHeadlessShell() {
  const candidates = globSync(
    path.join(
      process.env["HOME"] ?? "",
      "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell",
    ),
  );
  if (candidates.length > 0) return candidates.toSorted().at(-1);
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return existsSync(chrome) ? chrome : null;
}

const shellBin = process.env["SHELL_BIN"] ?? findHeadlessShell();
const live = { timeout: 60_000 };

// The ego engine's public contract: connectEgo gives the full omowright Page API over Ego's
// bindings, and closing it leaves the user's browser running and the binding slots empty.
test("connectEgo drives a page through Ego's CDP bindings and leaves the browser open on close", live, async () => {
  const { ego, stop } = egoOverRealBrowser(shellBin);
  try {
    const browser = await connectEgo({ ego, taskName: "checkout" });
    assert.equal(browser.engine, "ego");
    assert.deepEqual(browser.taskSpace, { taskId: "checkout", id: 7, name: "checkout" });
    assert.equal(ego.selected, 7);
    // A second connect in the same runtime must not switch the task space under the first one.
    await assert.rejects(connectEgo({ ego, taskName: "second" }), (error) => field(error, "code") === "ego_busy");
    assert.equal(ego.selected, 7);
    assert.equal(ego.spaces.length, 1);
    const page = await browser.newTab();
    await page.setContent("<h1>Store</h1><button onclick=\"this.textContent='paid'\">Pay now</button>");
    await page.getByRole("button", { name: "Pay now" }).click();
    assert.equal(await page.locator("button").textContent(), "paid");
    await browser.close();
    assert.equal(ego.onCDPMessage, undefined);
    assert.equal(ego.onSendCDPMessageError, undefined);
    const again = new EgoCdpClient({ ego, commandTimeoutMs: 5_000 });
    assert.ok(field(await again.send("Browser.getVersion"), "product"));
    await again.close();
  } finally {
    await stop();
  }
});

// Ego refuses sends before they reach CDP (the task is under user control, or no task space is
// selected) and only says so through onSendCDPMessageError; the command must fail with that
// code instead of waiting for its timeout.
test("a send Ego refuses rejects at once with Ego's error code", live, async () => {
  const { ego, stop } = egoOverRealBrowser(shellBin);
  try {
    const client = new EgoCdpClient({ ego, commandTimeoutMs: 20_000 });
    await client.ensureConnected();
    await assert.rejects(
      client.send("Browser.getVersion"),
      (error) => error instanceof EgoCdpError && error.code === "EGO_TASK_SPACE_NOT_SELECTED",
    );
    ego.useTaskSpace(3);
    const product = field(await client.send("Browser.getVersion"), "product");
    assert.equal(typeof product === "string" && product.length > 0, true);
    ego.refuse = "EGO_TASK_SPACE_USER_IN_CONTROL";
    await assert.rejects(
      client.send("Browser.getVersion"),
      (error) =>
        error instanceof EgoCdpError &&
        error.code === "EGO_TASK_SPACE_USER_IN_CONTROL" &&
        /Browser\.getVersion/.test(error.message),
    );
    // A refusal whose message carries no id fails every pending command, not just one.
    ego.refuse = null;
    const sendCDPMessage = ego.sendCDPMessage;
    ego.sendCDPMessage = () =>
      setImmediate(() => ego.onSendCDPMessageError?.("task space closed", "EGO_TASK_SPACE_NOT_FOUND"));
    const both = [client.send("Browser.getVersion"), client.send("Target.getTargets")];
    for (const pending of both)
      await assert.rejects(pending, (error) => field(error, "code") === "EGO_TASK_SPACE_NOT_FOUND");
    ego.sendCDPMessage = sendCDPMessage;
    await client.close();
  } finally {
    await stop();
  }
});

// One Ego runtime has one pair of callback slots: a second client must not silently take them
// over, closing one client must not clear another's, and a renderer crash fails that session's
// pending commands at once (PipeCdpClient parity) instead of waiting for the timeout.
test("Ego's callback slots belong to one client at a time, and a crash fails pending commands", async () => {
  const sent: Array<{ id?: unknown }> = [];
  let onSent = () => {};
  const ego: EgoCdpBindings = {
    sendCDPMessage: (message) => {
      sent.push(JSON.parse(message));
      onSent();
    },
  };
  const first = new EgoCdpClient({ ego, commandTimeoutMs: 20_000 });
  const firstConnect = first.ensureConnected();
  assert.ok(ego.onCDPMessage, "the first client claims the message slot");
  ego.onCDPMessage(JSON.stringify({ id: sent[0]?.id, result: {} }));
  await firstConnect;
  const second = new EgoCdpClient({ ego });
  await assert.rejects(second.ensureConnected(), (error) => field(error, "code") === "ego_busy");
  const reached = new Promise<void>((resolve) => {
    onSent = resolve;
  });
  const pending = first.send("Runtime.evaluate", { expression: "1" }, "S1");
  await reached;
  assert.ok(ego.onCDPMessage, "the first client still owns the message slot");
  ego.onCDPMessage(JSON.stringify({ method: "Inspector.targetCrashed", sessionId: "S1", params: {} }));
  await assert.rejects(pending, CdpSessionCrashedError);
  await first.close();
  assert.equal(ego.onCDPMessage, undefined);
});

test("connectEgo names the missing bindings and a task space Ego could not create", async () => {
  assert.throws(
    () => new EgoCdpClient({ ego: undefined }),
    (error) => error instanceof EgoCdpError && error.code === "ego_unavailable",
  );
  const ego = {
    sendCDPMessage() {},
    useTaskSpace() {},
    createTaskSpace: async () => ({ error: "No active browser", error_code: "EGO_BROWSER_UNAVAILABLE" }),
  };
  await assert.rejects(
    untyped.connectEgo({ ego }),
    (error) => error instanceof EgoCdpError && error.code === "EGO_BROWSER_UNAVAILABLE",
  );
  await assert.rejects(untyped.connectEgo({ ego, taskSpace: "checkout" }), TypeError);
  await assert.rejects(
    untyped.connectEgo({ ego: { sendCDPMessage() {} } }),
    (error) => field(error, "code") === "ego_task_space_unsupported",
  );
});
