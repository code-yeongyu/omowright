import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readProperty } from "../src/read-property.ts";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const coreSource = await readFile(new URL("../src/core.ts", import.meta.url), "utf8");
const publicApi: Record<string, unknown> = await import("omowright");

test("package exposes the OmOWright identity", () => {
  assert.equal(packageJson.name, "omowright");
  assert.match(packageJson.description, /^OmOWright /);
});

test("public page and input classes use OmO names", () => {
  for (const name of ["OmOPage", "OmOMouse", "OmOKeyboard"]) {
    const exported: unknown = publicApi[name];
    assert.equal(readProperty(exported, "name"), name, `wrong runtime class name: ${name}`);
  }
});

test("runtime artifacts use the OmOWright namespace", () => {
  assert.match(coreSource, /"omowright-artifacts"/);
});
