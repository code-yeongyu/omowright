import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// Generated-artifact contract (#276): the extension executed by the VM tests must be
// byte-for-byte the canonical build of its source. Those tests only checked behavior.
// Build in a temporary tree so this check cannot repair the artifact it is checking.
test("committed extension matches its canonical source build", () => {
  // Windows CI keeps the checkout and OS temp directory on different drives.
  // Keep this independent build on the checkout's drive so Bun's source labels
  // are relative to the sandbox, just as they are in the canonical build.
  const dir = mkdtempSync(path.join(root, ".extension-artifact-"));
  try {
    cpSync(path.join(root, "bridge"), path.join(dir, "bridge"), { recursive: true });
    cpSync(path.join(root, "package.json"), path.join(dir, "package.json"));
    cpSync(path.join(root, ".oxfmtrc.json"), path.join(dir, ".oxfmtrc.json"));
    symlinkSync(
      path.join(root, "node_modules"),
      path.join(dir, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = spawnSync("bun", ["bridge/build-extension.ts"], {
      cwd: dir,
      env: process.env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(
      readFileSync(path.join(root, "bridge/extension/background.js"), "utf8"),
      readFileSync(path.join(dir, "bridge/extension/background.js"), "utf8"),
      "tracked extension artifact drifted; run bun run build:extension",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
