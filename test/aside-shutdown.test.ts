import { test } from "node:test";
import assert from "node:assert/strict";
import { errorMonitor } from "node:events";
import { spawn as spawnChild } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AsideReplError, connectAside } from "../src/index.ts";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-aside-repl.ts");
const asideCommand = [process.execPath, FAKE];
const cliEnv = (fake: Readonly<Record<string, string>>) => ({ ...process.env, ...fake });

for (const protocol of ["line", "mcp"]) {
  // A live REPL may close its input before its process exits (#265). Observe the actual
  // pipe error without handling it: removing the transport's error listener must make this
  // test fail with unhandled EPIPE, unlike the old test that waited until the child exited.
  test(`[${protocol}] stdin EPIPE cannot escape the transport`, { timeout: 15_000 }, async () => {
    const errors: string[] = [];
    const aside = await connectAside({
      asideCommand,
      env: cliEnv(protocol === "mcp" ? { FAKE_ASIDE_CLI: "1.26.1107.24" } : {}),
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
        ...(mode === "failed line connect" ? { startTimeoutMs: 500 } : {}),
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
