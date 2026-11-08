// Contract owner (package contract): omowright bundled into ONE file for Node carries no
// static `bun:*` import. Consumers do exactly that: oh-my-openagent stages the browser
// skill runtime with `bun build src/index.ts --target=node` into a single file, and
// lazycodex imports it under Node, which cannot resolve `bun:` specifiers. A static
// import anywhere in the graph is hoisted to the bundle's top level, even from a module
// only reached through a dynamic import, so the count is taken on the built artifact.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const STATIC_BUN_IMPORT =
  /(?:^|[;}\s])(?:import|export)\b[^;"'`]*?\bfrom\s*["']bun:[a-z]+["']|(?:^|[;}\s])import\s*["']bun:[a-z]+["']/gm;

test("a single-file Node bundle has no static bun: import", { skip: !process.versions.bun }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "omowright-bundle-"));
  try {
    const outfile = path.join(dir, "index.js");
    const build = spawnSync(
      process.execPath,
      ["build", entry, "--target=node", "--format=esm", `--outfile=${outfile}`],
      {
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    assert.equal(build.status, 0, `bun build failed: ${build.stderr}`);
    const bundle = readFileSync(outfile, "utf8");
    assert.deepEqual(bundle.match(STATIC_BUN_IMPORT) ?? [], []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
