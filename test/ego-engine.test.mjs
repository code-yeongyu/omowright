import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, globSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CdpSessionCrashedError, EgoCdpClient, EgoCdpError, connectEgo } from "../src/index.js";

// A stand-in for Ego Lite's globalThis.ego that relays the raw CDP text to a real headless
// Chromium over --remote-debugging-pipe, so the omowright Page API runs end to end through
// the same three binding slots Ego documents (sendCDPMessage, onCDPMessage, onSendCDPMessageError).
function egoOverRealBrowser(shellBin) {
  assert.ok(shellBin, "no chrome-headless-shell found; set SHELL_BIN");
  const profile = mkdtempSync(path.join(tmpdir(), "omow-ego-"));
  const child = spawn(shellBin, ["--headless", "--no-sandbox", `--user-data-dir=${profile}`, "--remote-debugging-pipe", "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  let buffer = "";
  const ego = {
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
    useTaskSpace(id) { ego.selected = id; },
    sendCDPMessage(message) {
      if (typeof message !== "string") throw Object.assign(new TypeError("message must be a string"), { error_code: "EGO_INVALID_ARGUMENT" });
      if (ego.refuse || ego.selected === null) {
        const code = ego.refuse ?? "EGO_TASK_SPACE_NOT_SELECTED";
        setImmediate(() => ego.onSendCDPMessageError?.(message, code));
        return undefined;
      }
      child.stdio[3].write(`${message}\0`);
      return undefined;
    },
  };
  child.stdio[4].setEncoding("utf8");
  child.stdio[4].on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\0")) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      ego.onCDPMessage?.(frame);
    }
  });
  for (const stream of [child.stdio[3], child.stdio[4]]) stream.on("error", () => {});
  const stop = async () => {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
    rmSync(profile, { recursive: true, force: true });
  };
  return { ego, stop };
}

function findHeadlessShell() {
  const candidates = globSync(path.join(process.env.HOME ?? "", "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell"));
  if (candidates.length > 0) return candidates.sort().at(-1);
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return existsSync(chrome) ? chrome : null;
}

const shellBin = process.env.SHELL_BIN ?? findHeadlessShell();
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
    const page = await browser.newTab();
    await page.setContent('<h1>Store</h1><button onclick="this.textContent=\'paid\'">Pay now</button>');
    await page.getByRole("button", { name: "Pay now" }).click();
    assert.equal(await page.locator("button").textContent(), "paid");
    await browser.close();
    assert.equal(ego.onCDPMessage, undefined);
    assert.equal(ego.onSendCDPMessageError, undefined);
    const again = new EgoCdpClient({ ego, commandTimeoutMs: 5_000 });
    assert.ok((await again.send("Browser.getVersion")).product);
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
    await assert.rejects(client.send("Browser.getVersion"), (error) => error instanceof EgoCdpError && error.code === "EGO_TASK_SPACE_NOT_SELECTED");
    ego.useTaskSpace(3);
    assert.equal((await client.send("Browser.getVersion")).product.length > 0, true);
    ego.refuse = "EGO_TASK_SPACE_USER_CONTROLLED";
    await assert.rejects(client.send("Browser.getVersion"), (error) => error instanceof EgoCdpError && error.code === "EGO_TASK_SPACE_USER_CONTROLLED" && /Browser\.getVersion/.test(error.message));
    // A refusal whose message carries no id fails every pending command, not just one.
    ego.refuse = null;
    const sendCDPMessage = ego.sendCDPMessage;
    ego.sendCDPMessage = () => setImmediate(() => ego.onSendCDPMessageError?.("task space closed", "EGO_TASK_SPACE_NOT_FOUND"));
    const both = [client.send("Browser.getVersion"), client.send("Target.getTargets")];
    for (const pending of both) await assert.rejects(pending, (error) => error.code === "EGO_TASK_SPACE_NOT_FOUND");
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
  const sent = [];
  let onSent = () => {};
  const ego = { sendCDPMessage: (message) => { sent.push(JSON.parse(message)); onSent(); } };
  const first = new EgoCdpClient({ ego, commandTimeoutMs: 20_000 });
  const firstConnect = first.ensureConnected();
  ego.onCDPMessage(JSON.stringify({ id: sent[0].id, result: {} }));
  await firstConnect;
  const second = new EgoCdpClient({ ego });
  await assert.rejects(second.ensureConnected(), (error) => error.code === "ego_busy");
  const reached = new Promise((resolve) => { onSent = resolve; });
  const pending = first.send("Runtime.evaluate", { expression: "1" }, "S1");
  await reached;
  ego.onCDPMessage(JSON.stringify({ method: "Inspector.targetCrashed", sessionId: "S1", params: {} }));
  await assert.rejects(pending, CdpSessionCrashedError);
  await first.close();
  assert.equal(ego.onCDPMessage, undefined);
});

test("connectEgo names the missing bindings and a task space Ego could not create", async () => {
  assert.throws(() => new EgoCdpClient({ ego: undefined }), (error) => error instanceof EgoCdpError && error.code === "ego_unavailable");
  const ego = { sendCDPMessage() {}, useTaskSpace() {}, createTaskSpace: async () => ({ error: "No active browser", error_code: "EGO_BROWSER_UNAVAILABLE" }) };
  await assert.rejects(connectEgo({ ego }), (error) => error instanceof EgoCdpError && error.code === "EGO_BROWSER_UNAVAILABLE");
  await assert.rejects(connectEgo({ ego, taskSpace: "checkout" }), TypeError);
  await assert.rejects(connectEgo({ ego: { sendCDPMessage() {} } }), (error) => error.code === "ego_task_space_unsupported");
});
