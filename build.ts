/**
 * Builds the JavaScript artifacts the consumers (omo's native build) ship.
 *
 * The runtime reads src/page-bundle.js from disk next to the module, so a
 * single-file bundle alone is not a working package: the asset has to travel
 * with it. This script emits the bundle and copies every runtime asset beside
 * it, then regenerates the Chrome extension.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DIST = path.join(ROOT, "dist");

const RUNTIME_ASSETS = ["src/page-bundle.js"] as const;

mkdirSync(DIST, { recursive: true });

const built = Bun.spawnSync({
  cmd: ["bun", "build", path.join(ROOT, "src/index.ts"), "--target=node", `--outfile=${path.join(DIST, "index.js")}`],
  cwd: ROOT,
  stdout: "inherit",
  stderr: "inherit",
});
if (built.exitCode !== 0) throw new Error(`bun build failed with exit code ${built.exitCode}`);

for (const asset of RUNTIME_ASSETS) {
  copyFileSync(path.join(ROOT, asset), path.join(DIST, path.basename(asset)));
}

const extension = Bun.spawnSync({
  cmd: ["bun", path.join(ROOT, "bridge/build-extension.ts")],
  cwd: ROOT,
  stdout: "inherit",
  stderr: "inherit",
});
if (extension.exitCode !== 0) throw new Error(`build:extension failed with exit code ${extension.exitCode}`);

console.log("build: dist/index.js + runtime assets + bridge/extension/background.js");
