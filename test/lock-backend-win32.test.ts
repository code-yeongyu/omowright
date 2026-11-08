// Contract owner: when the Windows instance lock opens ntdll. The backend must not touch
// `bun:ffi` while it is imported, so a bundle that inlines it (a consumer's single-file
// build, read under Node) loads everywhere, and the native library opens once, on the
// first lock attempt. The tests mock `bun:ffi` itself, the real boundary, inside a child
// `bun test` run: `mock.module` only applies under the test runner and is process-wide,
// so in this process it would leak into the real Windows lock tests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const backendPath = new URL("../src/lock-backend-win32.ts", import.meta.url).pathname;

function runWithMockedFfi(dlopenBody: string, scenario: string): unknown {
  const dir = mkdtempSync(path.join(tmpdir(), "omowright-ffi-"));
  try {
    const reportPath = path.join(dir, "report.json");
    writeFileSync(
      path.join(dir, "child.test.ts"),
      `
        import { mock, test } from "bun:test";
        test("child", async () => {
          let opens = 0;
          mock.module("bun:ffi", () => ({
            ptr: () => 0,
            dlopen: () => { opens++; ${dlopenBody} },
          }));
          const report = {};
          const backend = await import(${JSON.stringify(backendPath)});
          report.opensAfterImport = opens;
          ${scenario}
          await Bun.write(${JSON.stringify(reportPath)}, JSON.stringify(report));
        });
      `,
    );
    const result = spawnSync(process.execPath, ["test", "./child.test.ts"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `child failed: ${result.stderr}`);
    const report: unknown = JSON.parse(readFileSync(reportPath, "utf8"));
    return report;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const workingNtdll = `
  return {
    symbols: {
      NtCreateFile: (handleOut) => { handleOut.writeBigUInt64LE(7n); return 0; },
      NtClose: () => 0,
      RtlNtStatusToDosError: () => 0,
    },
  };
`;

test("the Windows lock opens ntdll on the first attempt and reuses it", { skip: !process.versions.bun }, () => {
  const report = runWithMockedFfi(
    workingNtdll,
    `
      const first = await backend.tryAcquireWindows("first.flock");
      report.opensAfterFirst = opens;
      const second = await backend.tryAcquireWindows("second.flock");
      report.opensAfterSecond = opens;
      first.release();
      second.release();
    `,
  );
  assert.deepEqual(report, { opensAfterImport: 0, opensAfterFirst: 1, opensAfterSecond: 1 });
});

test(
  "a failing ntdll open surfaces at the lock attempt, not at import, and is retried",
  { skip: !process.versions.bun },
  () => {
    const report = runWithMockedFfi(
      `throw new Error("ntdll unavailable");`,
      `
        for (const attempt of ["first", "second"]) {
          try {
            await backend.tryAcquireWindows(attempt + ".flock");
            report[attempt] = "acquired";
          } catch (error) {
            report[attempt] = error.message;
          }
        }
        report.opensAfterAttempts = opens;
      `,
    );
    assert.deepEqual(report, {
      opensAfterImport: 0,
      first: "ntdll unavailable",
      second: "ntdll unavailable",
      opensAfterAttempts: 2,
    });
  },
);
