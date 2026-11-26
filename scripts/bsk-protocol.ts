// The BrowserSkill wire contract src/bsk speaks, vendored from the CLI release BSK_CLI_VERSION pins.
// This script is the only writer of src/bsk/protocol/:
//   bun scripts/bsk-protocol.ts sync       clone Tencent/BrowserSkill at cli-v<BSK_CLI_VERSION>, copy its protocol
//                                          JSON Schemas and MIT notice, write the manifest and the generated types
//   bun scripts/bsk-protocol.ts generate   rewrite params.generated.ts from the vendored schemas
//   bun scripts/bsk-protocol.ts --check    offline: every vendored file matches the manifest and the types are current
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BSK_CLI_VERSION } from "../src/bsk/install-cli.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROTOCOL_DIR = path.join(ROOT, "src/bsk/protocol");
const SCHEMA_DIR = path.join(PROTOCOL_DIR, "schema");
const MANIFEST = path.join(PROTOCOL_DIR, "manifest.json");
const LICENSE = path.join(PROTOCOL_DIR, "LICENSE");
const GENERATED = path.join(PROTOCOL_DIR, "params.generated.ts");
const UPSTREAM = "Tencent/BrowserSkill";
const UPSTREAM_SCHEMA_PATH = "crates/bsk-protocol/schema";
const PARAMS_FILE = /^tool_(\w+)_params\.json$/;

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type JsonObject = { readonly [key: string]: Json };

interface Manifest {
  repository: string;
  tag: string;
  commit: string;
  path: string;
  license: string;
  files: Record<string, string>;
}

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const parseJson = (file: string): Json => JSON.parse(readFileSync(file, "utf8"));
const pascal = (snake: string): string => snake.replace(/(^|_)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());

function run(command: string, args: readonly string[], options: { cwd?: string; input?: string } = {}): string {
  const result = spawnSync(command, args, { cwd: options.cwd ?? ROOT, input: options.input, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.error}`);
  return result.stdout;
}

function schemaFiles(): string[] {
  return readdirSync(SCHEMA_DIR)
    .filter((name) => name.endsWith(".json"))
    .toSorted();
}

function readManifest(): Manifest {
  const raw = parseJson(MANIFEST);
  if (!isObject(raw) || !isObject(raw["files"])) throw new Error(`${MANIFEST} is not a protocol manifest`);
  const text = (key: string): string => {
    const value = raw[key];
    if (typeof value !== "string") throw new Error(`${MANIFEST}: ${key} is not a string`);
    return value;
  };
  const files: Record<string, string> = {};
  for (const [name, hash] of Object.entries(raw["files"])) {
    if (typeof hash !== "string") throw new Error(`${MANIFEST}: files.${name} is not a sha256`);
    files[name] = hash;
  }
  return {
    repository: text("repository"),
    tag: text("tag"),
    commit: text("commit"),
    path: text("path"),
    license: text("license"),
    files,
  };
}

// JSON Schema (draft-07, the subset schemars emits) to a TypeScript type expression.
function typeOf(schema: Json | undefined, indent: string): string {
  if (schema === undefined || schema === true || !isObject(schema)) return "unknown";
  const ref = schema["$ref"];
  if (typeof ref === "string") return ref.replace("#/definitions/", "");
  if ("const" in schema) return JSON.stringify(schema["const"]);
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues)) return union(enumValues.map((value) => JSON.stringify(value)));
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const variants = schema[key];
    if (Array.isArray(variants)) {
      const types = variants.map((variant) => typeOf(variant, indent));
      return key === "allOf" ? types.filter((type) => type !== "unknown").join(" & ") || "unknown" : union(types);
    }
  }
  const declared = schema["type"];
  const types = Array.isArray(declared) ? declared : [declared];
  return union(types.map((type) => primitive(schema, type, indent)));
}

function union(types: readonly string[]): string {
  return [...new Set(types)].join(" | ");
}

function primitive(schema: JsonObject, type: Json | undefined, indent: string): string {
  switch (type) {
    case "string":
    case "boolean":
    case "null":
      return type;
    case "integer":
    case "number":
      return "number";
    case "array": {
      const item = typeOf(schema["items"], indent);
      return `readonly ${item.includes(" ") ? `(${item})` : item}[]`;
    }
    case "object":
    case undefined:
      return objectType(schema, indent);
    default:
      throw new Error(`unsupported JSON Schema type ${JSON.stringify(type)}`);
  }
}

function objectType(schema: JsonObject, indent: string): string {
  const properties = schema["properties"];
  const extra = schema["additionalProperties"];
  if (!isObject(properties)) {
    if (extra === false) return "Record<string, never>";
    return `Record<string, ${isObject(extra) ? typeOf(extra, indent) : "unknown"}>`;
  }
  const required = new Set(Array.isArray(schema["required"]) ? schema["required"] : []);
  const inner = `${indent}  `;
  const lines = Object.entries(properties).map(([key, property]) => {
    const optional = required.has(key) ? "" : "?";
    const type = typeOf(property, inner);
    return `${docComment(property, inner)}${inner}readonly ${key}${optional}: ${type}${optional ? " | undefined" : ""};`;
  });
  return `{\n${lines.join("\n")}\n${indent}}`;
}

function docComment(schema: Json | undefined, indent: string): string {
  const description = isObject(schema) ? schema["description"] : undefined;
  if (typeof description !== "string") return "";
  const lines = description.replaceAll("*/", "*\\/").split("\n");
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  return `${indent}/**\n${lines.map((line) => `${indent} *${line ? ` ${line}` : ""}`).join("\n")}\n${indent} */\n`;
}

function generate(manifest: Manifest): string {
  const definitions = new Map<string, Json>();
  const methods: Array<[string, string, Json]> = [];
  for (const file of schemaFiles()) {
    const method = PARAMS_FILE.exec(file)?.[1];
    if (method === undefined) continue;
    const schema = parseJson(path.join(SCHEMA_DIR, file));
    if (!isObject(schema)) throw new Error(`${file} is not a JSON Schema object`);
    const defs = schema["definitions"];
    for (const [name, definition] of Object.entries(isObject(defs) ? defs : {})) {
      const known = definitions.get(name);
      if (known !== undefined && JSON.stringify(known) !== JSON.stringify(definition))
        throw new Error(`definition ${name} differs between schema files; ${file} needs a prefixed name`);
      definitions.set(name, definition);
    }
    methods.push([method, `Tool${pascal(method)}Params`, schema]);
  }
  const blocks = [
    `// Generated by scripts/bsk-protocol.ts from ${manifest.repository} ${manifest.tag} (${manifest.commit}),`,
    `// ${manifest.path}/tool_*_params.json. Do not edit; run \`bun scripts/bsk-protocol.ts sync\` after a pin bump.`,
    "// Upstream license: ./LICENSE (MIT).",
    "",
    ...[...definitions.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, schema]) => `${docComment(schema, "")}export type ${name} = ${typeOf(schema, "")};\n`),
    ...methods.map(([, name, schema]) => `${docComment(schema, "")}export type ${name} = ${typeOf(schema, "")};\n`),
    "/** Parameters of every `tool.<method>` request, keyed by method name. */",
    `export type BskToolParams = {\n${methods.map(([method, name]) => `  ${method}: ${name};`).join("\n")}\n};`,
    "",
  ];
  return run(process.execPath, ["fmt", "--no-script", `--stdin-filepath=${path.relative(ROOT, GENERATED)}`], {
    input: blocks.join("\n"),
  });
}

function sync(): void {
  const tag = `cli-v${BSK_CLI_VERSION}`;
  const checkout = mkdtempSync(path.join(tmpdir(), "bsk-protocol-"));
  try {
    run("git", ["clone", "--quiet", "--depth=1", `--branch=${tag}`, `https://github.com/${UPSTREAM}.git`, checkout]);
    const commit = run("git", ["rev-parse", "HEAD"], { cwd: checkout }).trim();
    rmSync(SCHEMA_DIR, { recursive: true, force: true });
    mkdirSync(SCHEMA_DIR, { recursive: true });
    const source = path.join(checkout, UPSTREAM_SCHEMA_PATH);
    for (const name of readdirSync(source).filter((file) => file.endsWith(".json")))
      copyFileSync(path.join(source, name), path.join(SCHEMA_DIR, name));
    copyFileSync(path.join(checkout, "LICENSE"), LICENSE);
    const manifest: Manifest = {
      repository: UPSTREAM,
      tag,
      commit,
      path: UPSTREAM_SCHEMA_PATH,
      license: sha256(LICENSE),
      files: Object.fromEntries(schemaFiles().map((name) => [name, sha256(path.join(SCHEMA_DIR, name))])),
    };
    writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(GENERATED, generate(manifest));
    console.log(`bsk-protocol: vendored ${schemaFiles().length} schemas from ${UPSTREAM} ${tag} (${commit})`);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
}

function check(): string[] {
  const manifest = readManifest();
  const problems: string[] = [];
  if (manifest.tag !== `cli-v${BSK_CLI_VERSION}`)
    problems.push(
      `manifest tag ${manifest.tag} is not cli-v${BSK_CLI_VERSION}; run \`bun scripts/bsk-protocol.ts sync\``,
    );
  if (sha256(LICENSE) !== manifest.license) problems.push("LICENSE differs from the manifest");
  const onDisk = schemaFiles();
  for (const name of onDisk) {
    const expected = manifest.files[name];
    if (expected === undefined) problems.push(`schema/${name} is not in the manifest`);
    else if (sha256(path.join(SCHEMA_DIR, name)) !== expected)
      problems.push(`schema/${name} differs from the manifest`);
  }
  for (const name of Object.keys(manifest.files))
    if (!onDisk.includes(name)) problems.push(`schema/${name} is in the manifest but missing`);
  if (readFileSync(GENERATED, "utf8") !== generate(manifest))
    problems.push("params.generated.ts is stale; run `bun scripts/bsk-protocol.ts generate`");
  return problems;
}

const mode = process.argv[2];
switch (mode) {
  case "sync":
    sync();
    break;
  case "generate":
    writeFileSync(GENERATED, generate(readManifest()));
    break;
  case "--check": {
    const problems = check();
    for (const problem of problems) console.error(`bsk-protocol: ${problem}`);
    if (problems.length > 0) process.exit(1);
    console.log(
      `bsk-protocol: ${schemaFiles().length} vendored schemas match ${readManifest().tag}; types are current`,
    );
    break;
  }
  default:
    console.error("usage: bun scripts/bsk-protocol.ts sync | generate | --check");
    process.exit(2);
}
