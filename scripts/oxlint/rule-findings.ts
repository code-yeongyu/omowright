import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.join(import.meta.dirname, "../..");

export type Finding = { readonly code: string; readonly message: string };

type Diagnostic = { readonly code?: string; readonly message?: string; readonly filename: string };

// Lints every fixture through the shipped ratchet configuration (so losing its jsPlugins entry
// fails too) in ONE oxlint run, and returns each fixture's findings in input order. Fixtures are
// written to the OS temp root, outside the repository, so no repo-side scan can meet them.
export function lintFixtures(sources: readonly string[]): Finding[][] {
  const dir = mkdtempSync(path.join(tmpdir(), "omowright-testing-rules-"));
  try {
    const files = sources.map((source, index) => {
      const file = path.join(dir, `case-${index}.test.ts`);
      writeFileSync(file, source);
      return file;
    });
    const result = spawnSync(
      path.join(root, "node_modules/.bin/oxlint"),
      ["-c", "scripts/lint-ratchet.oxlintrc.json", "-f", "json", ...files],
      { cwd: root, encoding: "utf8" },
    );
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`oxlint failed (${String(result.status)}): ${result.stderr}`);
    }
    const parsed: { readonly diagnostics: readonly Diagnostic[] } = JSON.parse(result.stdout);
    const byFile = files.map((): Finding[] => []);
    for (const { code, message, filename } of parsed.diagnostics) {
      const index = Number(/^case-(\d+)\.test\.ts$/.exec(path.basename(filename))?.[1]);
      const found = byFile[index];
      if (found === undefined) throw new Error(`unexpected diagnostic file ${filename}`);
      found.push({ code: code ?? "parse-error", message: message ?? "" });
    }
    return byFile;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
