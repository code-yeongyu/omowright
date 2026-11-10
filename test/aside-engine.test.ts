import { test } from "node:test";
import assert from "node:assert/strict";
import { errorMonitor } from "node:events";
import { spawn as spawnChild } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AsideReplError, connectAside, findAsideBinary } from "../src/index.ts";
import type { ConnectAsideOptions } from "../src/aside/session-types.ts";
import { field } from "./fixtures/read-field.ts";
import { replTransportFor } from "../src/aside/cli-contract.ts";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-aside-repl.ts");
const asideCommand = [process.execPath, FAKE];
const cliEnv = (fake: Readonly<Record<string, string>>) => ({ ...process.env, ...fake });

// Every engine contract below must hold on both `aside repl` contracts the CLI has shipped (#255):
// 1.26.916 evaluates each piped stdin line, 1.26.1107 runs piped stdin as one script at EOF and
// keeps its long-lived REPL session behind `aside mcp`.
const CLIS: { name: string; env: Readonly<Record<string, string>> }[] = [
  { name: "CLI 1.26.916, one eval per stdin line", env: {} },
  { name: "CLI 1.26.1107, piped stdin runs at EOF", env: { FAKE_ASIDE_CLI: "1.26.1107.24" } },
];

for (const cli of CLIS) {
  const connect = (options: ConnectAsideOptions = {}) =>
    connectAside({ asideCommand, env: cliEnv(cli.env), ...options });

  // The Aside engine's public contract over the REPL protocol: one child keeps state across
  // calls, multi-line source runs as one call, results come back as JSON values separate
  // from console output, and the session names the account.
  test(`[${cli.name}] connectAside keeps one REPL session and returns each call's value apart from its logs`, async () => {
    const aside = await connect({ account: "u1" });
    try {
      assert.equal(aside.engine, "aside");
      assert.equal(aside.account, "u1");
      assert.equal(await aside.run("globalThis.omowCount = 41;\nreturn null;"), null);
      const { value, logs } = await aside.runWithLogs(
        'console.log("from the page");\nreturn { next: globalThis.omowCount + 1 };',
      );
      assert.deepEqual(value, { next: 42 });
      assert.deepEqual(logs, ["from the page"]);
    } finally {
      await aside.close();
    }
  });

  // The REPL's [error] marker is the only failure signal; a call that throws must reject with
  // the REPL's own message, and the session must stay usable for the next call.
  test(`[${cli.name}] a failing call rejects with AsideReplError and the session keeps working`, async () => {
    const aside = await connect();
    try {
      await assert.rejects(aside.run('throw new Error("no such tab")'), (error) => {
        assert.ok(error instanceof AsideReplError);
        assert.equal(error.code, "repl_error");
        assert.match(error.message, /no such tab/);
        return true;
      });
      assert.equal(await aside.run("return 7"), 7);
      await assert.rejects(
        aside.run("return () => 1"),
        (error) => error instanceof AsideReplError && error.code === "repl_unserializable",
      );
      assert.equal(await aside.run("return 8"), 8);
    } finally {
      await aside.close();
    }
  });

  // open() makes the tab the REPL's current page, and snapshot({ find }) applies omowright's
  // search to Aside's tree, so the agent reads only the matching lines.
  test(`[${cli.name}] open and snapshot with find narrow Aside's tree to the matching lines`, async () => {
    const aside = await connect();
    try {
      await assert.rejects(aside.snapshot(), /no current page/);
      assert.deepEqual(await aside.open("https://example.com/"), {
        url: "https://example.com/",
        title: "Title of https://example.com/",
      });
      const full = await aside.snapshot();
      assert.equal(String(field(full, "tree")).split("\n").length, 4);
      assert.equal(field(full, "diff"), "");
      assert.deepEqual(await aside.snapshot({ find: "pay", context: 0 }), {
        tree: '- link "Pay later" [ref=e1]\n...\n- button "Pay now" [ref=e2]',
        find: { query: "pay", matches: 2 },
      });
      await assert.rejects(aside.snapshot({ context: 1 }), TypeError);
    } finally {
      await aside.close();
    }
  });

  // A call that outlives its budget leaves the REPL mid-evaluation, so the session must fail
  // it with a timeout and refuse later calls instead of reading a stale answer.
  test(`[${cli.name}] a call past its timeout fails and closes the session`, async () => {
    const aside = await connect({ callTimeoutMs: 300 });
    await assert.rejects(
      aside.run("await new Promise(() => {});\nreturn 1;"),
      (error) => error instanceof AsideReplError && error.code === "repl_timeout",
    );
    await assert.rejects(
      aside.run("return 1"),
      (error) => error instanceof AsideReplError && error.code === "repl_closed",
    );
    await aside.close();
  });

  // A live REPL may close its input before its process exits (#265). Observe the actual
  // pipe error without handling it: removing the transport's error listener must make this
  // test fail with unhandled EPIPE, unlike the old test that waited until the child exited.
  test(`[${cli.name}] stdin EPIPE cannot escape the transport`, { timeout: 15_000 }, async () => {
    const errors: string[] = [];
    const aside = await connect({
      callTimeoutMs: 300,
      spawn: (command, args, options) => {
        const child = spawnChild(command, args, options);
        if (args.at(-1) === "repl" || args.at(-1) === "mcp") {
          child.stdin?.on(errorMonitor, (error: NodeJS.ErrnoException) => errors.push(error.code ?? ""));
        }
        return child;
      },
    });
    try {
      assert.equal(await aside.run("closeInput(); return true;"), true);
      await assert.rejects(
        aside.run(`return ${JSON.stringify("x".repeat(1_000_000))};`),
        (error) => error instanceof AsideReplError && error.code === "repl_timeout",
      );
    } finally {
      await aside.close();
    }
    assert.ok(errors.includes("EPIPE"), `a closed input emitted EPIPE, saw ${errors.join(", ")}`);
  });
}

// Page output can contain the prompt text, and the pipe can split right after it; the call
// must still end at its own [ok] marker, and the next call must read its own answer.
test("output that contains the prompt text and arrives split keeps calls in step", async () => {
  const aside = await connectAside({ asideCommand });
  try {
    const { value, logs } = await aside.runWithLogs('await splitWrite("tricky repl > ", "tail\\n");\nreturn 5;');
    assert.equal(value, 5);
    assert.deepEqual(logs, ["tricky repl > tail"]);
    assert.equal(await aside.run("return 6"), 6);
    const fake = await aside.runWithLogs('await splitWrite("[ok | 3ms]\\nrepl > ", "after\\n");\nreturn 9;');
    assert.equal(fake.value, 9);
    assert.equal(await aside.run("return 10"), 10);
    const fakeError = await aside.runWithLogs('await splitWrite("[error | 3ms]\\nrepl > ", "after\\n");\nreturn 11;');
    assert.equal(fakeError.value, 11);
    assert.equal(await aside.run("return 12"), 12);
  } finally {
    await aside.close();
  }
});

// A CLI that keeps no session omowright can drive must fail fast with a typed error naming its
// version, never an empty 15 s start timeout (#255).
test("a CLI with no usable REPL protocol fails with a typed error naming its version", async () => {
  await assert.rejects(
    connectAside({ asideCommand, env: cliEnv({ FAKE_ASIDE_CLI: "1.26.1107.24", FAKE_ASIDE_MCP_TOOLS: "none" }) }),
    (error) => {
      assert.ok(error instanceof AsideReplError);
      assert.equal(error.code, "repl_unsupported_cli");
      assert.match(error.message, /1\.26\.1107\.24/);
      return true;
    },
  );
  await assert.rejects(
    connectAside({ asideCommand, env: cliEnv({ FAKE_ASIDE_SILENT: "1" }), startTimeoutMs: 500 }),
    (error) => {
      assert.ok(error instanceof AsideReplError);
      assert.equal(error.code, "repl_start_timeout");
      assert.match(error.message, /1\.26\.916\.1741/);
      return true;
    },
  );
});

// JSON-RPC protocol contract: `aside mcp` may send requests of its own, and its id space is its own,
// so a server `ping` can carry the id of the pending call. Only a response settles a call; a ping
// gets an empty result and any other server request gets method-not-found.
test("aside mcp server requests are answered and never settle the pending call", async () => {
  const aside = await connectAside({
    asideCommand,
    env: cliEnv({ FAKE_ASIDE_CLI: "1.26.1107.24", FAKE_ASIDE_MCP_SERVER_REQUESTS: "1" }),
  });
  try {
    assert.equal(await aside.run("return 3"), 3);
    assert.equal(await aside.run("return 4"), 4);
  } finally {
    await aside.close();
  }
});

// close() must not leave an `aside mcp` running, even one that ignores SIGTERM after a call timed out.
test("close() after a call timeout ends an aside mcp that ignores SIGTERM", { timeout: 15_000 }, async () => {
  const children: ChildProcess[] = [];
  const aside = await connectAside({
    asideCommand,
    env: cliEnv({ FAKE_ASIDE_CLI: "1.26.1107.24", FAKE_ASIDE_STUBBORN: "1" }),
    callTimeoutMs: 300,
    spawn: (command, args, options) => {
      const child = spawnChild(command, args, options);
      if (args.at(-1) === "mcp") children.push(child);
      return child;
    },
  });
  const [child] = children;
  assert.ok(child, "connectAside spawned an aside mcp child");
  try {
    await assert.rejects(
      aside.run("await new Promise(() => {});\nreturn 1;"),
      (error) => error instanceof AsideReplError && error.code === "repl_timeout",
    );
    await aside.close();
    const { pid } = child;
    assert.ok(pid !== undefined);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

// The public close/connect boundaries must reap even a CLI that ignores SIGTERM (#264).
// Existing coverage only exercises MCP call timeout; these cases cover line close and failed
// startup using the same real child fixture and existing spawn option, without a production seam.
for (const mode of ["line close", "line timeout", "failed line connect", "failed mcp connect"]) {
  test(`bounded shutdown: ${mode}`, { timeout: 15_000 }, async () => {
    let child: ChildProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const env = cliEnv({
      FAKE_ASIDE_STUBBORN: "1",
      ...(mode === "failed mcp connect" ? { FAKE_ASIDE_CLI: "1.26.1107.24", FAKE_ASIDE_MCP_TOOLS: "none" } : {}),
      ...(mode === "failed line connect" ? { FAKE_ASIDE_SILENT: "1" } : {}),
    });
    try {
      const connection = connectAside({
        asideCommand,
        env,
        callTimeoutMs: 300,
        startTimeoutMs: 500,
        spawn: (command, args, options) => {
          const spawned = spawnChild(command, args, options);
          if (args.length === 2 && ["repl", "mcp"].includes(args[1] ?? "")) child = spawned;
          return spawned;
        },
      });
      if (mode.startsWith("failed")) {
        await assert.rejects(connection, (error) => error instanceof AsideReplError);
      } else {
        const session = await connection;
        if (mode === "line timeout") {
          await assert.rejects(
            session.run("await new Promise(() => {});"),
            (error) => error instanceof AsideReplError && error.code === "repl_timeout",
          );
          await assert.rejects(
            session.run("return 1"),
            (error) => error instanceof AsideReplError && error.code === "repl_closed",
          );
        }
        await Promise.race([
          session.close(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("close exceeded shutdown budget")), 10_000);
          }),
        ]);
      }
      assert.ok(child, "the session child was captured");
      assert.ok(child.exitCode !== null || child.signalCode !== null, "session child was reaped before returning");
    } finally {
      clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
}

// The `aside repl --help` probe has its own short budget, so a CLI whose help never answers costs a
// few seconds, not the whole start budget twice. On a probe timeout the transport is `aside mcp` when
// `aside mcp --help` lists a repl tool, else the line protocol.
test(
  "a hung help probe falls back within its own budget, to mcp only when aside mcp lists a repl tool",
  { timeout: 15_000 },
  async () => {
    const started = Date.now();
    const connections = await Promise.allSettled([
      connectAside({
        asideCommand,
        env: cliEnv({ FAKE_ASIDE_CLI: "1.26.1107.24", FAKE_ASIDE_HELP_HANG: "1" }),
        startTimeoutMs: 30_000,
      }),
      connectAside({ asideCommand, env: cliEnv({ FAKE_ASIDE_HELP_HANG: "1" }), startTimeoutMs: 30_000 }),
    ]);
    const sessions = connections.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    try {
      for (const result of connections) if (result.status === "rejected") throw result.reason;
      const [mcp, line] = sessions;
      assert.ok(mcp && line);
      assert.ok(Date.now() - started < 12_000);
      assert.equal(await mcp.run("globalThis.omowKept = 5;\nreturn 1;"), 1);
      assert.equal(await mcp.run("return globalThis.omowKept"), 5);
      assert.equal(await line.run("return 6"), 6);
      assert.equal(line.sessionDir, "~/.aside/u/0/sessions/fake");
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
    }
  },
);

// The CLI help contract lists a tool name followed by whitespace, not a word boundary:
// repl-foo must never opt a CLI into the MCP transport. Existing coverage only listed repl.
test("MCP help fallback requires the exact repl tool name", async () => {
  const protocols = await Promise.all(
    ["repl", "repl-foo"].map((tool) =>
      replTransportFor({
        spawn: spawnChild,
        command: [process.execPath, FAKE],
        env: cliEnv({ FAKE_ASIDE_CLI: "1.26.1107.24", FAKE_ASIDE_HELP_HANG: "1", FAKE_ASIDE_MCP_HELP_TOOL: tool }),
        timeoutMs: 500,
      }),
    ),
  );
  assert.deepEqual(protocols, ["mcp", "line"]);
});

test("connectAside names the missing CLI instead of failing to spawn", async () => {
  await assert.rejects(
    connectAside({ autoSetup: false, env: { PATH: "" }, home: "/nonexistent" }),
    (error) => error instanceof AsideReplError && error.code === "aside_not_found",
  );
});

// Platform contract: Aside's Windows installer puts the CLI under %LOCALAPPDATA%\Aside\CLI\current,
// which is not on PATH after `install.ps1 -SkipPathUpdate` (#255).
test("findAsideBinary finds the Windows installer's CLI off PATH", { skip: process.platform !== "win32" }, () => {
  const expected = path.join("C:\\Users\\someone\\AppData\\Local", "Aside", "CLI", "current", "aside.exe");
  assert.equal(
    findAsideBinary({
      env: { PATH: "", LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local" },
      home: "C:\\nonexistent",
      exists: (candidate) => candidate === expected,
    }),
    expected,
  );
});
