import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PipeCdpClient } from "../src/pipe.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-pipe-browser.mjs", import.meta.url));
const harness = fileURLToPath(new URL("./fixtures/pipe-leak-harness.mjs", import.meta.url));

const ALLOCATOR_LINE =
  "Trying to load the allocator multiple times. This is *not* supported.";

test("pipe transport does not leak browser stdout/stderr to the parent tty", async () => {
  const child = spawn(process.execPath, [harness], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => { stderr += c; });
  const code = await new Promise((resolve) => child.on("close", resolve));

  assert.equal(code, 0, `harness failed:\n${stderr}`);
  assert.match(stdout, /HARNESS_OK FakeChrome\/1\.0/);
  assert.ok(!stderr.includes(ALLOCATOR_LINE), `browser stderr leaked to parent:\n${stderr}`);
  assert.ok(!stdout.includes("fake-browser stdout noise"), `browser stdout leaked to parent:\n${stdout}`);
});

test("readiness failure surfaces the drained browser stdio tail", async () => {
  const client = new PipeCdpClient({
    browserPath: process.execPath,
    browserArgs: [fixture],
    spawnOptions: { env: { ...process.env, FAKE_BROWSER_MODE: "mute-cdp" } },
    readinessTimeoutMs: 1500,
  });
  try {
    await assert.rejects(client.ensureConnected(), (err) => {
      assert.match(err.message, /did not become ready over the CDP pipe/);
      assert.match(err.message, /BOOM diagnostics 123/);
      return true;
    });
  } finally {
    await client.close();
  }
});
