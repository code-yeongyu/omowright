import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, globSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PipeCdpClient, connectPipe } from "../src/pipe.ts";
import { connect } from "../src/index.ts";
import { BrowserConnection } from "../src/connection.ts";
import type { ConnectOptions } from "../src/connection.ts";
import { resolveDialogAction } from "../src/dialog-policy.ts";
import type { Dialog, DialogInfo } from "../src/dialog-policy.ts";
import type { CdpResult, CdpSend, CdpSendOptions } from "../src/cdp-protocol.ts";
import { createAgentTabs } from "../src/agent-tabs.ts";
import { readProperty } from "../src/read-property.ts";
import { removeTreeSync } from "./fixtures/remove-tree.ts";

// A fake that records each command and answers {}; the overload is the generic CdpSend contract.
function recordingSend(sent: SentCommand[]): CdpSend {
  function send<M extends string>(
    method: M,
    params?: object,
    sessionId?: string,
    opts?: CdpSendOptions,
  ): Promise<CdpResult<M>>;
  async function send(method: string, params?: object, sessionId?: string): Promise<unknown> {
    sent.push({ method, params, sessionId });
    return {};
  }
  return send;
}

interface SentCommand {
  method: string;
  params: unknown;
  sessionId: string | undefined;
}
// The dialog handle a CDP listener receives as meta.dialog, and the Playwright Dialog page.on("dialog") delivers.
interface DialogHandle {
  accept(promptText?: string): Promise<unknown>;
  dismiss(): Promise<unknown>;
}
interface DialogEventMeta {
  sessionId?: string;
  dialog?: DialogHandle;
}

function findHeadlessShell() {
  const home = process.env.HOME;
  assert.ok(home !== undefined, "HOME is unset");
  const candidates = globSync(
    path.join(
      home,
      "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell",
    ),
  );
  if (candidates.length > 0) return candidates.toSorted().at(-1);
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chrome)) return chrome;
  return undefined;
}

const SHELL = process.env.SHELL_BIN ?? findHeadlessShell();

function captureClient(options = {}) {
  const client = new PipeCdpClient({ browserPath: process.execPath, ...options });
  const sent: SentCommand[] = [];
  client.send = recordingSend(sent);
  return { client, sent };
}

function dialogOpening(params = {}, sessionId = "sess-1") {
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

async function handledParams(client: PipeCdpClient, sent: SentCommand[], msg = dialogOpening()) {
  sent.length = 0;
  await client._handleTransportMessage(msg);
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

  const decline = () => false;
  client.setDialogPolicy(decline);
  assert.equal(client.dialogPolicy, decline);
  assert.deepEqual(await handledParams(client, sent), { accept: false });
});

// Contract (#147): a CDP listener gets the opened dialog as meta.dialog, and the policy answers only when no listener
// did, so the browser gets exactly one Page.handleJavaScriptDialog per dialog.
test("a listener's answer replaces the policy's, and the policy answers when no listener does", async () => {
  const rows: Array<{ label: string; listener: (dialog: DialogHandle) => unknown; sent: unknown[] }> = [
    {
      label: "accept with text",
      listener: (dialog) => dialog.accept("typed"),
      sent: [{ accept: true, promptText: "typed" }],
    },
    { label: "dismiss", listener: (dialog) => dialog.dismiss(), sent: [{ accept: false }] },
    {
      label: "async accept",
      listener: async (dialog) => {
        await Promise.resolve();
        await dialog.accept();
      },
      sent: [{ accept: true }],
    },
    { label: "look only", listener: () => {}, sent: [{ accept: true, promptText: "policy" }] },
  ];
  for (const row of rows) {
    const { client, sent } = captureClient({ dialogPolicy: { accept: true, promptText: "policy" } });
    let opened: DialogHandle | undefined;
    client.on("Page.javascriptDialogOpening", (_params: unknown, meta: DialogEventMeta) => {
      opened = meta.dialog;
      assert.ok(opened, "the dialog event meta carries no dialog");
      return row.listener(opened);
    });
    await client._handleTransportMessage(dialogOpening({ type: "prompt", message: "q" }));
    assert.deepEqual(
      sent.map((s) => s.params),
      row.sent,
      row.label,
    );
    assert.ok(
      sent.every((s) => s.method === "Page.handleJavaScriptDialog" && s.sessionId === "sess-1"),
      row.label,
    );
    assert.ok(opened, row.label);
    await assert.rejects(opened.dismiss(), /already handled/, row.label);
    assert.equal(sent.length, 1, row.label);
  }
});

test("BrowserConnection.setDialogPolicy delegates or rejects by transport", () => {
  const { client } = captureClient();
  const connection = new BrowserConnection(client);
  connection.setDialogPolicy({ accept: false, promptText: "nope" });
  assert.deepEqual(client.dialogPolicy, { accept: false, promptText: "nope" });

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
    let connection;
    try {
      connection = await connectPipe({
        browserPath: SHELL,
        browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
        storageRoot: ud,
        dialogPolicy: { accept: false },
      });
      const page = (await createAgentTabs(connection).create("about:blank")).page;

      const confirmDialog = page.waitForEvent("dialog", { timeout: 5000 });
      const confirmed = page.evaluate(() => confirm("x"));
      assert.equal((await confirmDialog).type(), "confirm");
      assert.equal((await confirmDialog).message(), "x");
      assert.equal(await confirmed, false);

      connection.setDialogPolicy({ accept: true, promptText: "hello" });

      const promptDialog = page.waitForEvent("dialog", { timeout: 5000 });
      const prompted = page.evaluate(() => prompt("q"));
      assert.equal((await promptDialog).type(), "prompt");
      assert.equal(await prompted, "hello");
    } finally {
      await connection?.close();
      removeTreeSync(ud);
    }
  },
);

// Public API: connect() over WebSocket takes the same dialog policy as connectPipe(), so a QA script on an attached
// endpoint (the OmO desktop thread browser) can take the cancel path of a confirm() and answer a prompt() (#56).
test(
  "live connect() honours dialogPolicy over WebSocket",
  {
    skip: !SHELL && "no chromium binary found",
    timeout: 60_000,
  },
  async () => {
    assert.ok(SHELL);
    const ud = mkdtempSync(path.join(tmpdir(), "omowright-dialogs-ws-"));
    const browser = spawn(
      SHELL,
      ["--headless", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${ud}`, "about:blank"],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let connection;
    try {
      const wsUrl = await new Promise<string>((resolve, reject) => {
        let buffered = "";
        browser.stderr.on("data", (chunk: string) => {
          buffered += chunk;
          const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffered);
          if (match) resolve(match[1] ?? "");
        });
        browser.once("exit", (code: number | null) => reject(new Error(`chromium exited early (${code})`)));
      });
      connection = await connect(wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/.*$/, ""), {
        storageRoot: ud,
        dialogPolicy: { accept: false },
        // An unset client field must not erase the top-level policy.
        client: { dialogPolicy: undefined },
      });
      const page = (await createAgentTabs(connection).create("about:blank")).page;

      const confirmDialog = page.waitForEvent("dialog", { timeout: 5000 });
      const confirmed = page.evaluate(() => confirm("x"));
      assert.equal((await confirmDialog).type(), "confirm");
      assert.equal(await confirmed, false, "the policy dismissed the confirm");

      connection.setDialogPolicy({ accept: true, promptText: "hello" });
      assert.deepEqual(readProperty(connection.cdp, "dialogPolicy"), { accept: true, promptText: "hello" });
      const prompted = page.evaluate(() => prompt("q"));
      assert.equal(await prompted, "hello", "the policy answered the prompt");
    } finally {
      await connection?.close().catch(() => {});
      const exited = browser.exitCode === null ? once(browser, "exit") : Promise.resolve();
      browser.kill();
      await exited;
      removeTreeSync(ud);
    }
  },
);

// Public API contract (#147): page.on("dialog") hands listeners Playwright's Dialog (type(), message(), defaultValue(),
// accept(promptText?), dismiss()). A listener that answers replaces the policy; with no listener, or one that only
// looks, the policy answers as before. Both transports; connect(url) goes through a shared connection (#72/#76).
async function openTransport(kind: string, ud: string, dialogPolicy?: ConnectOptions["dialogPolicy"]) {
  assert.ok(SHELL);
  if (kind === "pipe") {
    const connection = await connectPipe({
      browserPath: SHELL,
      browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
      storageRoot: ud,
      dialogPolicy,
    });
    return { connection, stop: async () => {} };
  }
  const browser = spawn(
    SHELL,
    ["--headless", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${ud}`, "about:blank"],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const stop = async () => {
    const exited = browser.exitCode === null ? once(browser, "exit") : Promise.resolve();
    browser.kill();
    await exited;
  };
  try {
    const wsUrl = await new Promise<string>((resolve, reject) => {
      let buffered = "";
      browser.stderr.on("data", (chunk: string) => {
        buffered += chunk;
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffered);
        if (match) resolve(match[1] ?? "");
      });
      browser.once("exit", (code: number | null) => reject(new Error(`chromium exited early (${code})`)));
    });
    const connection = await connect(wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/.*$/, ""), {
      storageRoot: ud,
      dialogPolicy,
    });
    return { connection, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

const listenerRows: Array<{
  label: string;
  script: string;
  answer: (dialog: Dialog) => unknown;
  seen: string[];
  result: unknown;
}> = [
  {
    label: "alert accepted",
    script: "alert('hello')",
    answer: (d) => d.accept(),
    seen: ["alert", "hello", ""],
    result: undefined,
  },
  {
    label: "confirm accepted",
    script: "confirm('proceed?')",
    answer: (d) => d.accept(),
    seen: ["confirm", "proceed?", ""],
    result: true,
  },
  {
    label: "confirm dismissed",
    script: "confirm('proceed?')",
    answer: (d) => d.dismiss(),
    seen: ["confirm", "proceed?", ""],
    result: false,
  },
  {
    label: "prompt accepted with text",
    script: "prompt('name?', 'dflt')",
    answer: (d) => d.accept("typed"),
    seen: ["prompt", "name?", "dflt"],
    result: "typed",
  },
  {
    label: "prompt seen but not answered",
    script: "prompt('name?', 'dflt')",
    answer: () => undefined,
    seen: ["prompt", "name?", "dflt"],
    result: "policy",
  },
];

for (const kind of ["pipe", "ws"]) {
  test(
    `live ${kind}: page close promptly rejects pending evaluations with a page closed error`,
    {
      skip: !SHELL && "no chromium binary found",
      timeout: 45_000,
    },
    async () => {
      const ud = mkdtempSync(path.join(tmpdir(), `omowright-close-${kind}-`));
      let transport: Awaited<ReturnType<typeof openTransport>> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let off: (() => void) | undefined;
      try {
        transport = await openTransport(kind, ud);
        const { connection } = transport;
        const page = await connection.newTab();
        const other = await connection.newTab();
        const sessionId = await page.resolveSessionId();
        await connection.cdp.send("Runtime.enable", undefined, sessionId);
        const started = new Set();
        const ready = Promise.withResolvers<void>();
        off = connection.cdp.on("Runtime.consoleAPICalled", (params: unknown, meta: DialogEventMeta) => {
          if (meta.sessionId !== sessionId) return;
          const args = readProperty(params, "args");
          const first: unknown = Array.isArray(args) ? args[0] : undefined;
          const marker = first === undefined || first === null ? undefined : readProperty(first, "value");
          if (marker === "close-pending-user" || marker === "close-pending-cdp") started.add(marker);
          if (started.size === 2) ready.resolve();
        });
        const evaluated = page
          .evaluate(() => {
            console.debug("close-pending-user");
            return new Promise(() => {});
          })
          .then(
            () => assert.fail("evaluate resolved"),
            (error) => error,
          );
        const raw = connection.cdp
          .send(
            "Runtime.evaluate",
            {
              expression: 'console.debug("close-pending-cdp"); new Promise(() => {})',
              awaitPromise: true,
            },
            sessionId,
          )
          .then(
            () => assert.fail("CDP evaluate resolved"),
            (error: unknown) => error,
          );
        await ready.promise;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error("page close exceeded 1500 ms")), 1500);
        });
        const results = await Promise.race([Promise.all([page.close(), evaluated, raw]), deadline]);
        for (const error of results.slice(1)) {
          assert.equal(readProperty(error, "name"), "CdpSessionDetachedError");
          assert.ok(error instanceof Error);
          assert.match(error.message, /page closed/i);
          assert.equal(readProperty(error, "sessionId"), sessionId);
        }
        assert.equal(await other.evaluate(() => 6 * 7), 42, "another page remains usable");
      } finally {
        clearTimeout(timer);
        off?.();
        await transport?.connection.close().catch(() => {});
        await transport?.stop();
        removeTreeSync(ud);
      }
    },
  );
}

for (const kind of ["pipe", "ws"]) {
  test(
    `live ${kind}: a dialog listener answers through the Dialog object, and the policy answers the rest`,
    {
      skip: !SHELL && "no chromium binary found",
      timeout: 60_000,
    },
    async () => {
      const ud = mkdtempSync(path.join(tmpdir(), `omowright-dialog-object-${kind}-`));
      let transport: Awaited<ReturnType<typeof openTransport>> | undefined;
      try {
        transport = await openTransport(kind, ud, { accept: true, promptText: "policy" });
        const { connection } = transport;
        const page = (await createAgentTabs(connection).create("about:blank")).page;
        for (const row of listenerRows) {
          const seen: unknown[][] = [];
          const answers: unknown[] = [];
          const off = page.on("dialog", (dialog: Dialog) => {
            seen.push([dialog.type(), dialog.message(), dialog.defaultValue()]);
            const answered = row.answer(dialog);
            if (answered) answers.push(answered);
            return answered;
          });
          try {
            assert.equal(await page.evaluate(row.script), row.result, row.label);
            await Promise.all(answers);
            assert.deepEqual(seen, [row.seen], row.label);
          } finally {
            off();
          }
        }
        assert.equal(await page.evaluate("confirm('no listener')"), true, "the policy accepts with no listener");
        assert.equal(
          await page.evaluate("prompt('no listener', 'dflt')"),
          "policy",
          "the policy fills the prompt with no listener",
        );
      } finally {
        await transport?.connection.close().catch(() => {});
        await transport?.stop();
        removeTreeSync(ud);
      }
    },
  );
}
