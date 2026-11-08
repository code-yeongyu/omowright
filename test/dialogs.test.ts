import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, globSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PipeCdpClient, connectPipe } from "../src/pipe.ts";
import { BrowserConnection } from "../src/connection.ts";
import { resolveDialogAction } from "../src/dialog-policy.ts";
import type { DialogInfo } from "../src/dialog-policy.ts";
import { createAgentTabs } from "../src/agent-tabs.ts";
import type { CdpResult, CdpSendOptions } from "../src/cdp-protocol.ts";

function findHeadlessShell() {
  const candidates = globSync(
    path.join(
      process.env.HOME ?? "",
      "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell",
    ),
  );
  if (candidates.length > 0) return candidates.toSorted().at(-1);
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chrome)) return chrome;
  return null;
}

const SHELL = process.env.SHELL_BIN ?? findHeadlessShell();

// Live tests are skipped without a binary; inside them the path is required.
function requireBinary(binary: string | null | undefined): string {
  assert.ok(binary, "live test ran without a Chromium binary");
  return binary;
}

type SentCommand = { method: string; params?: unknown; sessionId?: unknown };
type DialogMessage = ReturnType<typeof dialogOpening>;

// A recording fake transport: every command resolves with an empty CDP result.
// The overload is the generic CdpSend contract; the implementation is what the fake really returns.
function recordingSend(sent: SentCommand[]) {
  function send<M extends string>(
    method: M,
    params?: object,
    sessionId?: string,
    options?: CdpSendOptions,
  ): Promise<CdpResult<M>>;
  async function send(method: string, params?: object, sessionId?: string): Promise<unknown> {
    sent.push({ method, params, sessionId });
    return {};
  }
  return send;
}

function captureClient(options: Partial<ConstructorParameters<typeof PipeCdpClient>[0]> = {}) {
  const client = new PipeCdpClient({ browserPath: process.execPath, ...options });
  const sent: SentCommand[] = [];
  client.send = recordingSend(sent);
  return { client, sent };
}

function dialogOpening(params: Record<string, unknown> = {}, sessionId = "sess-1") {
  return {
    method: "Page.javascriptDialogOpening",
    sessionId,
    params: {
      type: "alert",
      message: "hi",
      defaultPrompt: "",
      url: "https://example.test/",
      ...params,
    },
  };
}

function declineEveryDialog() {
  return false;
}

async function handledParams(client: PipeCdpClient, sent: SentCommand[], msg: DialogMessage = dialogOpening()) {
  sent.length = 0;
  // The transport entry point is the unit under test; it has no public alias.
  await client["_handleTransportMessage"](msg);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.method, "Page.handleJavaScriptDialog");
  assert.equal(sent[0]?.sessionId, msg.sessionId);
  return sent[0]?.params;
}

test("resolveDialogAction maps policies and falls back when the function throws or rejects", async () => {
  assert.deepEqual(await resolveDialogAction({ accept: false }), { accept: false });
  assert.deepEqual(await resolveDialogAction({ accept: true, promptText: "hello" }), {
    accept: true,
    promptText: "hello",
  });

  const seen: unknown[] = [];
  const policy = (dialog: DialogInfo) => {
    seen.push(dialog);
    if (dialog.type === "confirm") return false;
    return { accept: true, promptText: "typed" };
  };
  assert.deepEqual(await resolveDialogAction(policy, { type: "confirm", message: "x", url: "https://a.test/" }), {
    accept: false,
  });
  assert.deepEqual(
    await resolveDialogAction(policy, {
      type: "prompt",
      message: "q",
      defaultPrompt: "dflt",
      url: "https://example.test/",
    }),
    { accept: true, promptText: "typed" },
  );
  assert.deepEqual(seen, [
    { type: "confirm", message: "x", defaultPrompt: "", url: "https://a.test/" },
    { type: "prompt", message: "q", defaultPrompt: "dflt", url: "https://example.test/" },
  ]);

  assert.deepEqual(
    await resolveDialogAction(() => {
      throw new Error("policy boom");
    }),
    { accept: true },
  );
  assert.deepEqual(
    await resolveDialogAction(async () => {
      throw new Error("policy reject");
    }),
    { accept: true },
  );
});

test("PipeCdpClient default dialogPolicy auto-accepts", async () => {
  const { client, sent } = captureClient();
  assert.deepEqual(client.dialogPolicy, { accept: true });
  assert.deepEqual(await handledParams(client, sent), { accept: true });
});

test("object dialogPolicy can dismiss and supply promptText", async () => {
  const { client, sent } = captureClient({ dialogPolicy: { accept: false } });
  assert.deepEqual(client.dialogPolicy, { accept: false });
  assert.deepEqual(await handledParams(client, sent), { accept: false });

  client.setDialogPolicy({ accept: true, promptText: "hello" });
  assert.deepEqual(client.dialogPolicy, { accept: true, promptText: "hello" });
  assert.deepEqual(await handledParams(client, sent, dialogOpening({ type: "prompt", message: "q" })), {
    accept: true,
    promptText: "hello",
  });

  const decline = declineEveryDialog;
  client.setDialogPolicy(decline);
  assert.equal(client.dialogPolicy, decline);
  assert.deepEqual(await handledParams(client, sent), { accept: false });
});

test("BrowserConnection.setDialogPolicy delegates or rejects by transport", () => {
  const { client } = captureClient();
  const connection = new BrowserConnection(client);
  connection.setDialogPolicy({ accept: false, promptText: "nope" });
  assert.deepEqual(client.dialogPolicy, { accept: false, promptText: "nope" });

  // A transport without the optional setDialogPolicy on purpose: its absence is the boundary under test.
  const unsupported = new BrowserConnection({
    ensureConnected: async () => {},
    send: recordingSend([]),
    on: () => () => {},
    close: async () => {},
    discoverTargets: async () => [],
  });
  assert.throws(() => unsupported.setDialogPolicy({ accept: false }), {
    message: "dialog policy is not supported by this transport",
  });
});

test(
  "live dialogPolicy dismisses confirm, fills prompt, and still emits dialog",
  {
    skip: !SHELL && "no chromium binary found",
    timeout: 60_000,
  },
  async () => {
    const ud = mkdtempSync(path.join(tmpdir(), "omowright-dialogs-"));
    const connection = await connectPipe({
      browserPath: requireBinary(SHELL),
      browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
      storageRoot: ud,
      dialogPolicy: { accept: false },
    });
    try {
      const page = (await createAgentTabs(connection).create("about:blank")).page;

      const confirmDialog = page.waitForEvent("dialog", { timeout: 5000 });
      const confirmed = page.evaluate(() => confirm("x"));
      assert.equal((await confirmDialog).type, "confirm");
      assert.equal((await confirmDialog).message, "x");
      assert.equal(await confirmed, false);

      connection.setDialogPolicy({ accept: true, promptText: "hello" });

      const promptDialog = page.waitForEvent("dialog", { timeout: 5000 });
      const prompted = page.evaluate(() => prompt("q"));
      assert.equal((await promptDialog).type, "prompt");
      assert.equal(await prompted, "hello");
    } finally {
      await connection.close();
      rmSync(ud, { recursive: true, force: true });
    }
  },
);
