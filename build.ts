/**
 * Builds what npm publishes: `package.json` `exports` and `bin` point at `dist/`.
 *
 * Declarations are emitted by `typescript-5`, not by the pinned `typescript` 7:
 * TypeScript 7 refuses the anonymous class `createOmOPageClass` returns (one TS4094
 * per private field) and writes no `dist/index.d.ts`. TypeScript 7 stays the gate.
 *
 * `bun build.ts --only=js,assets,bin` runs a subset; the default runs every step.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DIST = path.join(ROOT, "dist");
const STAGE = path.join(ROOT, ".build");
const DECLARATION_COMPILER = path.join(ROOT, "node_modules", "typescript-5", "lib", "tsc.js");
const JS_ENTRY = path.join(ROOT, "src/index.ts");
const RUNTIME_ASSETS = ["src/page-bundle.js"] as const;
const BIN_ENTRY = "bin/omowright-cloak.ts";
const BIN_LIBRARY_IMPORT = 'from "../src/index.ts"';
const BIN_LIBRARY_SPECIFIER = 'from "../index.js"';
const STEPS = ["js", "assets", "types", "bin", "extension"] as const;
type Step = (typeof STEPS)[number];

const RELATIVE_TS_SPECIFIER = /(["'])(\.\.?\/[^"']*)\.ts\1/g;

function run(cmd: string[], what: string): void {
  const result = Bun.spawnSync({ cmd, cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${what} failed with exit code ${result.exitCode}`);
}

function buildTypes(): void {
  if (!existsSync(DECLARATION_COMPILER)) {
    throw new Error(`missing ${path.relative(ROOT, DECLARATION_COMPILER)}; run \`bun install\``);
  }
  run(["bun", DECLARATION_COMPILER, "-p", "tsconfig.build.json", "--outDir", STAGE], "declaration emit");
  const entry = path.join(STAGE, "index.d.ts");
  if (!existsSync(entry)) throw new Error(`declaration emit wrote no ${path.relative(ROOT, entry)}`);
  const rewritten = rewriteDeclarationSpecifiers(STAGE);
  assertNoBareTsSpecifiers(STAGE);
  const ambient = copyAmbientDeclarations();
  console.log(
    `types: dist/index.d.ts + tree (${rewritten} files, specifiers rewritten to .js, ${ambient.length} ambient)`,
  );
}

/**
 * Copies the ambient module declarations the sources rely on (`src/ws.d.ts` declares the
 * `ws` surface, and `dist/core.d.ts` imports it) and references them from the entry, because
 * an ambient declaration applies only once its file is in the program.
 */
function copyAmbientDeclarations(): string[] {
  const copied: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, "src"), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".d.ts")) continue;
    copyFileSync(path.join(ROOT, "src", entry.name), path.join(STAGE, entry.name));
    copied.push(`./${entry.name}`);
  }
  if (copied.length === 0) return copied;
  const entryFile = path.join(STAGE, "index.d.ts");
  const references = copied.map((name) => `/// <reference path="${name}" />`).join("\n");
  writeFileSync(entryFile, `${references}\n${readFileSync(entryFile, "utf8")}`);
  return copied;
}

/** A published `.d.ts` must name the emitted module, or consumers hit TS5097 on `./x.ts`. */
function rewriteDeclarationSpecifiers(dir: string): number {
  let rewritten = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      rewritten += rewriteDeclarationSpecifiers(full);
      continue;
    }
    if (!entry.name.endsWith(".d.ts")) continue;
    const source = readFileSync(full, "utf8");
    const next = source.replace(RELATIVE_TS_SPECIFIER, "$1$2.js$1");
    if (next === source) continue;
    writeFileSync(full, next);
    rewritten += 1;
  }
  return rewritten;
}

function assertNoBareTsSpecifiers(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      assertNoBareTsSpecifiers(full);
      continue;
    }
    if (!entry.name.endsWith(".d.ts")) continue;
    const leftover = readFileSync(full, "utf8").match(RELATIVE_TS_SPECIFIER);
    if (leftover) throw new Error(`${path.relative(ROOT, full)} still imports ${leftover[0]}`);
  }
}

/**
 * Transpiled, not bundled: the library import is rewritten to the packed entry so the
 * package carries one copy of it. A bundle would also inline `injected.ts`, whose
 * `page-bundle.js` read resolves against the bundle's own directory.
 */
function buildBin(): void {
  const source = readFileSync(path.join(ROOT, BIN_ENTRY), "utf8");
  if (!source.includes(BIN_LIBRARY_IMPORT)) {
    throw new Error(`${BIN_ENTRY} no longer imports the library with ${BIN_LIBRARY_IMPORT}`);
  }
  const body = source.replace(BIN_LIBRARY_IMPORT, BIN_LIBRARY_SPECIFIER).replace(/^#![^\n]*\n/, "");
  const compiled = new Bun.Transpiler({ loader: "ts", target: "node" }).transformSync(body);
  const outFile = path.join(STAGE, "bin", "omowright-cloak.js");
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, `#!/usr/bin/env node\n${compiled}`);
  chmodSync(outFile, 0o755);
  console.log("bin: dist/bin/omowright-cloak.js");
}

/**
 * Split, so the Windows lock backend stays in a chunk that loads only on Windows under
 * Bun, the branch that asks for it. The backend imports `bun:ffi` dynamically on first
 * use, so a single-file bundle (what consumers build) loads under Node as well;
 * `test/bundle-runtime-imports.test.ts` pins that.
 */
function buildJs(): void {
  run(["bun", "build", JS_ENTRY, "--target=node", "--splitting", `--outdir=${STAGE}`], "bun build");
  console.log("js: dist/index.js + lazy chunks");
}

function buildAssets(): void {
  for (const asset of RUNTIME_ASSETS) {
    const outFile = path.join(STAGE, path.basename(asset));
    copyFileSync(path.join(ROOT, asset), outFile);
    console.log(`asset: dist/${path.basename(asset)}`);
  }
}

function buildExtension(): void {
  run(["bun", path.join(ROOT, "bridge/build-extension.ts")], "build:extension");
  console.log("extension: bridge/extension/background.js");
}

function parseSteps(argv: string[]): Step[] {
  const only = argv.find((arg) => arg.startsWith("--only="));
  if (only === undefined) return [...STEPS];
  const requested = only.slice("--only=".length).split(",");
  const unknown = requested.filter((name) => !STEPS.includes(name as Step));
  if (unknown.length > 0) throw new Error(`unknown build step(s): ${unknown.join(", ")}`);
  return requested as Step[];
}

const steps = parseSteps(process.argv.slice(2));
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

try {
  for (const step of steps) {
    if (step === "js") buildJs();
    else if (step === "assets") buildAssets();
    else if (step === "types") buildTypes();
    else if (step === "bin") buildBin();
    else buildExtension();
  }
} catch (error) {
  // Nothing publishable survives a failed build: a stale dist/ would pack an older tree.
  rmSync(DIST, { recursive: true, force: true });
  throw error;
}

rmSync(DIST, { recursive: true, force: true });
renameSync(STAGE, DIST);
console.log(`build: complete (${steps.join(", ")})`);
