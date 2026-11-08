import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const child = Bun.spawn(
  [process.execPath, "x", "--no-install", "tsc", "--noEmit", "--pretty", "false", "-p", "tsconfig.control.json"],
  { cwd: root, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
);
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);
const output = stdout + stderr;
const diagnostics = output.split(/\r?\n/).filter((line) => line.trim().length > 0);
const expected =
  /(?:^|[/\\])typecheck-control\.ts\(1,14\): error TS2322: Type 'string' is not assignable to type 'number'\./;

if (exitCode === 0 || diagnostics.length !== 1 || !expected.test(diagnostics[0] ?? "")) {
  throw new Error(`Typecheck control did not reject exactly the deliberate assignment (exit ${exitCode}).\n${output}`);
}
console.log("Typecheck control passed: the compiler rejected the deliberate TS2322 assignment.");
