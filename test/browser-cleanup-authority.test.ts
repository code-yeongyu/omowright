import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

test(
  "failed browser launches do not select another run's process for cleanup",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "omowright-cleanup-authority-"));
    const record = join(dir, "signals");
    try {
      await writeFile(record, "");
      const args = [
        "--import",
        fileURLToPath(new URL("./fixtures/record-cleanup-authority.mjs", import.meta.url)),
        "--test",
        "--test-reporter=tap",
        "--test-name-pattern=a pidfile that cannot be written|connectPipe quits the browser it spawned",
        fileURLToPath(new URL("./browser-pidfile.test.ts", import.meta.url)),
        fileURLToPath(new URL("./pipe.test.ts", import.meta.url)),
      ];
      // Use Node for the preload: syncBuiltinESMExports also replaces the named
      // ESM execFileSync import in the historical fixtures before they execute.
      const env: NodeJS.ProcessEnv = { ...process.env, OMOWRIGHT_SIGNAL_RECORD: record };
      delete env.NODE_TEST_CONTEXT;
      const { stdout } = await promisify(execFile)("node", args, {
        env,
        timeout: 45_000,
      });
      assert.match(stdout, /# pass 2\b/);
      assert.doesNotMatch(await readFile(record, "utf8"), /^independent$/m);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
