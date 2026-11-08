import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  ASIDE_INSTALL_COMMAND,
  asidePaths,
  detectAsideInstall,
  ensureAside,
  installAsideCli,
  verifyAside,
} from "../src/aside-install.js";

const PATHS = asidePaths({
  home: path.join("/tmp", "omowright-home"),
  appPath: path.join("/Applications", "Aside.app"),
  platform: "darwin",
});

const OK_OUTPUT = 'Example Domain\n\u001B[2m[ok | 2317ms]\u001B[0m';
const SIGNED_OUT_OUTPUT = 'You are not signed in.\n\u001B[31m[error | 12ms]\u001B[0m';
const ACCOUNT_SIGNED_IN = '* u0  user@example.com  signed in  profiles: Profile 0';
const ACCOUNT_SIGNED_OUT = '* u0  user@example.com  signed out  profiles: Profile 0';

function fakeRun({ repl = OK_OUTPUT, account = ACCOUNT_SIGNED_IN, installCode = 0 } = {}) {
  const calls = [];
  const runProcess = async ({ bin, args }) => {
    calls.push({ bin, args });
    if (bin === "bash") return { code: installCode, signal: null, timedOut: false, stdout: "installed", stderr: "" };
    if (args[0] === "account") return { code: 0, signal: null, timedOut: false, stdout: account, stderr: "" };
    return { code: 0, signal: null, timedOut: false, stdout: repl, stderr: "" };
  };
  return { runProcess, calls };
}

const existsFrom = (present) => (candidate) => present.has(candidate);

test("the install layout follows the platform, while detection itself does not", () => {
  const darwin = asidePaths({ home: path.join("/h"), platform: "darwin" });
  assert.equal(darwin.cliApp, path.join("/h", ".aside", "cli", "Aside CLI.app"));
  assert.equal(darwin.appPath, "/Applications/Aside.app");

  const linux = asidePaths({ home: "/h", platform: "linux" });
  assert.equal(linux.cliApp, null);
  assert.equal(linux.cliExecutable, path.join("/h", ".aside", "cli", "aside"));

  const windows = asidePaths({ home: "/h", platform: "win32" });
  assert.equal(windows.commandPath, null);
  assert.equal(windows.cliExecutable, null);
});

test("detection names the states of the installation, not of the platform", () => {
  const both = detectAsideInstall({ paths: PATHS, envPath: "", exists: existsFrom(new Set([PATHS.appPath, PATHS.cliApp])) });
  assert.equal(both.state, "app-and-cli");
  assert.equal(both.executable, PATHS.cliExecutable);
  assert.equal(both.where, "cli-bundle");

  const commandOnly = detectAsideInstall({ paths: PATHS, envPath: "", exists: existsFrom(new Set([PATHS.commandPath])) });
  assert.equal(commandOnly.state, "cli-only");
  assert.equal(commandOnly.where, "install-link");

  const appOnly = detectAsideInstall({ paths: PATHS, envPath: "", exists: existsFrom(new Set([PATHS.appPath])) });
  assert.equal(appOnly.state, "app-only");
  assert.equal(appOnly.executable, null);

  assert.equal(detectAsideInstall({ paths: PATHS, envPath: "", exists: existsFrom(new Set()) }).state, "absent");
});

test("an aside on PATH is an installation wherever the layout is unknown", () => {
  const asideOnPath = path.join("/opt", "bin", "aside");
  const found = detectAsideInstall({
    paths: asidePaths({ home: "/h", platform: "win32" }),
    envPath: path.join("/opt", "bin"),
    exists: existsFrom(new Set([asideOnPath])),
  });
  assert.equal(found.state, "cli-only");
  assert.equal(found.executable, asideOnPath);
  assert.equal(found.where, "path");
});

test("installing is opt-in and uses the vendor's own command", async () => {
  const offered = await installAsideCli({ paths: PATHS });
  assert.equal(offered.executed, false);
  assert.equal(offered.command, "curl -fsSL https://releases.aside.com/install.sh | bash");

  const { runProcess, calls } = fakeRun();
  const ran = await installAsideCli({ paths: PATHS, execute: true, runProcess });
  assert.equal(ran.executed, true);
  assert.equal(ran.ok, true);
  assert.deepEqual(calls, [{ bin: "bash", args: ["-c", ASIDE_INSTALL_COMMAND] }]);
});

test("a failed installer is reported with its own output, not thrown", async () => {
  const { runProcess } = fakeRun({ installCode: 1 });
  const failed = await installAsideCli({ paths: PATHS, execute: true, runProcess });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 1);
});

test("the version string is not the usability proof", async () => {
  const good = await verifyAside({ bin: "aside", runProcess: fakeRun().runProcess });
  assert.equal(good.usable, true);
  assert.equal(good.ms, 2317);

  const signedOut = await verifyAside({ bin: "aside", runProcess: fakeRun({ repl: SIGNED_OUT_OUTPUT }).runProcess });
  assert.equal(signedOut.usable, false);
  assert.equal(signedOut.needsSignIn, true);
});

test("an installed CLI that cannot drive a browser is not reported as usable", async (t) => {
  const state = await ensureAside({
    paths: PATHS,
    envPath: "",
    exists: existsFrom(new Set([PATHS.appPath, PATHS.cliApp])),
    runProcess: fakeRun({ repl: SIGNED_OUT_OUTPUT, account: ACCOUNT_SIGNED_OUT }).runProcess,
  });
  assert.equal(state.usable, false);
  assert.equal(state.state, "installed-unverified");
  assert.equal(state.account.signedIn, false);
  assert.match(state.instruction, /aside login/);
  assert.deepEqual(state.steps.map((step) => [step.step, step.ok]), [["detect", true], ["verify", false]]);
  t.diagnostic(state.steps.map((step) => `${step.step}=${step.ok}`).join(" "));
});

test("a signed-in account with a broken repl reports the repl, not a sign-in problem", async () => {
  const state = await ensureAside({
    paths: PATHS,
    envPath: "",
    exists: existsFrom(new Set([PATHS.appPath, PATHS.cliApp])),
    runProcess: fakeRun({ repl: "browser_unavailable\n[error | 4ms]" }).runProcess,
  });
  assert.equal(state.account.signedIn, true);
  assert.equal(state.instruction, "browser_unavailable");
});

test("an app without its CLI is offered the vendor install instead of a claim", async () => {
  const state = await ensureAside({
    paths: PATHS,
    envPath: "",
    exists: existsFrom(new Set([PATHS.appPath])),
    runProcess: fakeRun().runProcess,
  });
  assert.equal(state.usable, false);
  assert.equal(state.state, "app-only");
  assert.equal(state.instruction, `Install the Aside CLI: ${ASIDE_INSTALL_COMMAND}`);
  assert.equal(state.steps.at(-1).step, "install");
});

test("install: run installs with the vendor command, then verifies for real", async () => {
  const present = new Set([PATHS.appPath]);
  const { runProcess, calls } = fakeRun();
  const state = await ensureAside({
    paths: PATHS,
    install: "run",
    envPath: "",
    exists: (candidate) => present.has(candidate),
    runProcess: async (options) => {
      if (options.bin === "bash") present.add(PATHS.cliApp);
      return runProcess(options);
    },
  });
  assert.equal(state.usable, true);
  assert.equal(state.state, "ready");
  assert.equal(state.bin, PATHS.cliExecutable);
  assert.deepEqual(calls.map((call) => call.bin), ["bash", PATHS.cliExecutable]);
  assert.deepEqual(state.steps.map((step) => step.step), ["detect", "install", "verify"]);
});

test("nothing installed on macOS asks for the app and names the CLI command", async () => {
  const state = await ensureAside({ paths: PATHS, envPath: "", exists: existsFrom(new Set()), runProcess: fakeRun().runProcess });
  assert.equal(state.state, "absent");
  assert.match(state.instruction, /aside\.com.*releases\.aside\.com\/install\.sh/);
});

test("a platform without a wired installer is named as a follow-up, not guessed", async () => {
  const state = await ensureAside({ platform: "win32", envPath: "", exists: existsFrom(new Set()), runProcess: fakeRun().runProcess });
  assert.equal(state.usable, false);
  assert.equal(state.state, "absent");
  assert.match(state.instruction, /install\.ps1.*follow-up/);
  assert.equal(state.steps.find((step) => step.step === "install").detail, "no installer wired up for this platform");
});
