import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// The workflow's installation boundary must reject CDN error bodies before extraction,
// retry boundedly, and say lint did not run (#277). Execute the configured step with only
// the download replaced; real size/hash checks reject independent corrupt payloads.
// There was no install-failure coverage, and this needs no production-only test seam.
for (const size of [107, 1_100_000]) {
  test(`actionlint install diagnoses a corrupt ${size}-byte download`, { skip: process.platform !== "linux" }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "actionlint-install-"));
    try {
      mkdirSync(path.join(dir, "bin"));
      symlinkSync(
        path.join(root, "scripts"),
        path.join(dir, "scripts"),
        process.platform === "win32" ? "junction" : "dir",
      );
      writeFileSync(path.join(dir, "payload"), Buffer.alloc(size, 120));
      writeFileSync(
        path.join(dir, "bin", "curl"),
        `#!/bin/bash
printf 'attempt\\n' >> "$ATTEMPTS"
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ] || [ "$1" = "-o" ]; then out="$2"; shift; fi
  shift
done
if [ -n "$out" ]; then cp "$PAYLOAD" "$out"; else cat "$PAYLOAD"; fi
`,
        { mode: 0o755 },
      );
      const workflow = readFileSync(path.join(root, ".github/workflows/lint-workflows.yml"), "utf8");
      const install = workflow.split("      - name: Install actionlint")[1]?.split("\n      - name:")[0] ?? "";
      const configured = /^\s+run: (.+)$/m.exec(install)?.[1];
      assert.ok(configured, "workflow configures an installation command");
      const result = spawnSync("bash", ["-c", configured], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env["PATH"]}`,
          PAYLOAD: path.join(dir, "payload"),
          ATTEMPTS: path.join(dir, "attempts"),
          GITHUB_STEP_SUMMARY: path.join(dir, "summary"),
        },
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, size === 107 ? /download was 107 bytes/ : /checksum mismatch/);
      assert.equal(readFileSync(path.join(dir, "attempts"), "utf8").trim().split("\n").length, 3);
      assert.match(readFileSync(path.join(dir, "summary"), "utf8"), /lint did not run/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
