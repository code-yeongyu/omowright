import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AsideReplError, asideDoctor, asideOnboard, connectAside, installAsideCli } from "../src/index.ts";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-aside-repl.ts");
const asideCommand = [process.execPath, FAKE];
// Only the test's own home counts: the machine running the tests may have Aside in /Applications.
const exists = (file: string) => !file.startsWith("/Applications/") && existsSync(file);

function homeWithApp() {
  const home = mkdtempSync(path.join(tmpdir(), "omow-aside-"));
  const contents = path.join(home, "Applications", "Aside.app", "Contents");
  mkdirSync(contents, { recursive: true });
  writeFileSync(
    path.join(contents, "Info.plist"),
    '<?xml version="1.0"?>\n<plist><dict>\n<key>CFBundleIdentifier</key>\n<string>at.studio.AsideBrowser</string>\n<key>CFBundleShortVersionString</key>\n<string>1.0.1022.1</string>\n</dict></plist>\n',
  );
  return home;
}

// asideDoctor's report is the public contract an agent reads before choosing Aside: it must
// say ready only when the app, the CLI and the CLI sign-in are all there, and otherwise name
// the one step that is missing.
test("asideDoctor reports app, CLI and sign-in, and names the missing step", async () => {
  const home = homeWithApp();
  try {
    const ready = await asideDoctor({ platform: "darwin", home, exists, asideCommand });
    assert.deepEqual(ready.app, {
      installed: true,
      path: path.join(home, "Applications", "Aside.app"),
      version: "1.0.1022.1",
    });
    assert.equal(ready.cli.version, "1.26.916.1741");
    assert.deepEqual(ready.auth, { signedIn: true, account: "u0" });
    assert.equal(ready.ready, true);
    assert.equal(ready.nextStep, null);

    const signedOut = await asideDoctor({
      platform: "darwin",
      home,
      exists,
      asideCommand,
      env: { ...process.env, FAKE_ASIDE_SIGNED_OUT: "1" },
    });
    assert.equal(signedOut.ready, false);
    assert.deepEqual(signedOut.auth, { signedIn: false, account: "u0" });
    assert.ok(signedOut.nextStep?.includes(`${process.execPath} --account u0 login`));

    const otherAccount = await asideDoctor({ platform: "darwin", home, exists, asideCommand, account: "u1" });
    assert.deepEqual(otherAccount.auth, { signedIn: false, account: "u1" });
    assert.equal(otherAccount.ready, false);

    const noApp = await asideDoctor({ platform: "darwin", home: tmpdir(), exists, env: { PATH: "" } });
    assert.equal(noApp.app.installed, false);
    assert.equal(noApp.cli.installed, false);
    assert.match(String(noApp.nextStep), /install the Aside browser/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// asideOnboard installs a missing CLI with Aside's own installer, keeps the user's shell rc
// files unchanged, and re-reads the new CLI's sign-in state.
test(
  "asideOnboard installs a missing CLI and restores rc files the installer touched",
  { skip: process.platform === "win32" },
  async () => {
    const home = homeWithApp();
    try {
      writeFileSync(path.join(home, ".zshrc"), "export KEEP=1\n");
      const calls: string[] = [];
      const run = async (command: string, args: string[]) => {
        calls.push([command, ...args].join(" "));
        const bin = path.join(home, ".local", "bin");
        mkdirSync(bin, { recursive: true });
        writeFileSync(path.join(bin, "aside"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
        chmodSync(path.join(bin, "aside"), 0o755);
        writeFileSync(path.join(home, ".zshrc"), 'export KEEP=1\nexport PATH="$HOME/.local/bin:$PATH"\n');
        return { code: 0, stdout: "installed", stderr: "" };
      };
      const report = await asideOnboard({
        platform: "darwin",
        home,
        exists,
        env: { PATH: "" },
        installCli: (options) => installAsideCli({ ...options, run }),
      });
      assert.deepEqual(calls, ["bash -c curl -fsSL https://releases.aside.com/install.sh | bash"]);
      assert.equal(report.install?.installed, true);
      assert.deepEqual(report.install?.["restoredRcFiles"], [path.join(home, ".zshrc")]);
      assert.equal(readFileSync(path.join(home, ".zshrc"), "utf8"), "export KEEP=1\n");
      assert.equal(report.cli.installed, true);
      assert.equal(report.ready, true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

// Installing the CLI on a machine without the Aside app runs a remote script for nothing, so
// onboarding skips it there, and connectAside's own setup installs only when the app was found.
test("no CLI install runs when the Aside app is missing or not found", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "omow-aside-"));
  try {
    const installs: string[] = [];
    const installCli = async () => {
      installs.push("install");
      return { installed: false };
    };
    const missing = await asideOnboard({ platform: "darwin", home, exists, env: { PATH: "" }, installCli });
    assert.equal(missing.install, null);
    assert.match(String(missing.nextStep), /install the Aside browser/);
    const linux = await asideOnboard({
      platform: "linux",
      home,
      exists,
      env: { PATH: "" },
      installOnlyWithApp: true,
      installCli,
    });
    assert.equal(linux.install, null);
    assert.deepEqual(installs, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// connectAside runs the same setup first, so an agent that only calls connectAside gets the
// person's next step (here: sign the CLI in) instead of a REPL that cannot reach the browser.
test(
  "connectAside stops with the setup's next step when the CLI is signed out",
  { skip: process.platform === "win32" },
  async () => {
    const home = homeWithApp();
    try {
      const bin = path.join(home, ".local", "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(path.join(bin, "aside"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
      chmodSync(path.join(bin, "aside"), 0o755);
      await assert.rejects(connectAside({ home, env: { PATH: "", FAKE_ASIDE_SIGNED_OUT: "1" } }), (error) => {
        assert.ok(error instanceof AsideReplError);
        assert.equal(error.code, "aside_not_ready");
        assert.match(error.message, /\/aside --account u0 login`/);
        assert.equal(error.setup?.cli.installed, true);
        return true;
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);
