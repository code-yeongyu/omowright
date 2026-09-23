import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BROWSERSKILL_EXTENSION_IDS,
  detectBrowsers,
  externalExtensionEntry,
  registerExternalExtension,
  unregisterExternalExtension,
} from "../src/bsk/external-extension.js";

function scratchHome() {
  return mkdtempSync(path.join(tmpdir(), "omowright-ext-"));
}

test("BrowserSkill store ids are the published Chrome and Edge listings", () => {
  assert.equal(BROWSERSKILL_EXTENSION_IDS.chrome, "hhcmgoofomhgciiibhipgmgkgnoenaoi");
  assert.equal(BROWSERSKILL_EXTENSION_IDS.edge, "emacgiaaaiojkkpkddmmdfhmokgmnikg");
});

test("detectBrowsers finds Chromium-family user-data dirs per platform from the injected home", () => {
  const home = scratchHome();
  try {
    mkdirSync(path.join(home, "Library/Application Support/Google/Chrome/Default"), { recursive: true });
    mkdirSync(path.join(home, "Library/Application Support/Microsoft Edge/Default"), { recursive: true });
    const mac = detectBrowsers({ platform: "darwin", home, exists: existsSync });
    assert.deepEqual(mac.map((b) => b.id), ["chrome", "edge"]);
    assert.equal(mac[0].userDataDir, path.join(home, "Library/Application Support/Google/Chrome"));
    assert.equal(mac[0].store, "chrome");
    assert.equal(mac[1].store, "edge");
    assert.equal(mac[0].binary, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");

    mkdirSync(path.join(home, ".config/chromium/Default"), { recursive: true });
    const linux = detectBrowsers({ platform: "linux", home, exists: existsSync });
    assert.deepEqual(linux.map((b) => b.id), ["chromium"]);
    assert.equal(linux[0].store, "chrome");

    const win = detectBrowsers({ platform: "win32", home, exists: existsSync, env: { LOCALAPPDATA: path.join(home, "AppData/Local") } });
    assert.deepEqual(win, []);
    mkdirSync(path.join(home, "AppData/Local/Google/Chrome/User Data/Default"), { recursive: true });
    const win2 = detectBrowsers({ platform: "win32", home, exists: existsSync, env: { LOCALAPPDATA: path.join(home, "AppData/Local") } });
    assert.equal(win2[0].id, "chrome");
    assert.equal(win2[0].registryKey, "HKCU\\Software\\Google\\Chrome\\Extensions");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("externalExtensionEntry points macOS at <user-data-dir>/External Extensions with the store update url", () => {
  const entry = externalExtensionEntry({ platform: "darwin", browser: { id: "chrome", store: "chrome", userDataDir: "/ud" } });
  assert.equal(entry.kind, "file");
  assert.equal(entry.path, path.join("/ud", "External Extensions", "hhcmgoofomhgciiibhipgmgkgnoenaoi.json"));
  assert.deepEqual(JSON.parse(entry.content), { external_update_url: "https://clients2.google.com/service/update2/crx" });
  assert.equal(entry.needsRestart, true);
  assert.equal(entry.humanStep.includes("Enable"), true);

  const edge = externalExtensionEntry({ platform: "darwin", browser: { id: "edge", store: "edge", userDataDir: "/ud2" } });
  assert.equal(path.basename(edge.path), "emacgiaaaiojkkpkddmmdfhmokgmnikg.json");
  assert.deepEqual(JSON.parse(edge.content), { external_update_url: "https://edge.microsoft.com/extensionwebstorebase/v1/crx" });
});

test("externalExtensionEntry uses the HKCU registry on Windows and a system dir on Linux", () => {
  const win = externalExtensionEntry({ platform: "win32", browser: { id: "chrome", store: "chrome", registryKey: "HKCU\\Software\\Google\\Chrome\\Extensions" } });
  assert.equal(win.kind, "registry");
  assert.equal(win.key, "HKCU\\Software\\Google\\Chrome\\Extensions\\hhcmgoofomhgciiibhipgmgkgnoenaoi");
  assert.deepEqual(win.regAddArgs, ["add", win.key, "/v", "update_url", "/t", "REG_SZ", "/d", "https://clients2.google.com/service/update2/crx", "/f"]);
  assert.equal(win.needsRestart, false);

  const linux = externalExtensionEntry({ platform: "linux", browser: { id: "chrome", store: "chrome", externalDir: "/opt/google/chrome/extensions" } });
  assert.equal(linux.kind, "file");
  assert.equal(linux.path, "/opt/google/chrome/extensions/hhcmgoofomhgciiibhipgmgkgnoenaoi.json");
  assert.equal(linux.humanStep.includes("Enable"), false, "Linux installs without an enable prompt");
});

test("registerExternalExtension writes the entry once, is idempotent, and unregister removes it", async () => {
  const home = scratchHome();
  try {
    const browser = { id: "chrome", store: "chrome", userDataDir: path.join(home, "Chrome") };
    mkdirSync(browser.userDataDir, { recursive: true });
    const first = await registerExternalExtension({ platform: "darwin", browser });
    assert.equal(first.registered, true);
    assert.equal(first.alreadyPresent, false);
    const file = path.join(browser.userDataDir, "External Extensions", "hhcmgoofomhgciiibhipgmgkgnoenaoi.json");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { external_update_url: "https://clients2.google.com/service/update2/crx" });
    const second = await registerExternalExtension({ platform: "darwin", browser });
    assert.equal(second.alreadyPresent, true);
    assert.equal(second.humanStep, first.humanStep);
    const removed = await unregisterExternalExtension({ platform: "darwin", browser });
    assert.equal(removed.removed, true);
    assert.equal(existsSync(file), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("registerExternalExtension reports the store fallback when the Linux system dir is not writable", async () => {
  const home = scratchHome();
  try {
    const dir = path.join(home, "opt-ro");
    mkdirSync(dir, { recursive: true });
    const browser = { id: "chrome", store: "chrome", externalDir: dir };
    const result = await registerExternalExtension({
      platform: "linux", browser,
      writeFile: () => { const e = new Error("EACCES"); e.code = "EACCES"; throw e; },
    });
    assert.equal(result.registered, false);
    assert.equal(result.reason, "not_writable");
    assert.match(result.humanStep, /chromewebstore\.google\.com\/detail\/hhcmgoofomhgciiibhipgmgkgnoenaoi/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("registerExternalExtension on Windows runs reg add through the injected runner", async () => {
  const calls = [];
  const browser = { id: "chrome", store: "chrome", registryKey: "HKCU\\Software\\Google\\Chrome\\Extensions" };
  const result = await registerExternalExtension({
    platform: "win32", browser,
    runReg: async (args) => { calls.push(args); return { code: 0 }; },
  });
  assert.equal(result.registered, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "add");
  assert.equal(result.needsRestart, false);
});

test("registerExternalExtension refuses a browser whose extension the user removed (blocklisted) with a store link", async () => {
  const home = scratchHome();
  try {
    const userDataDir = path.join(home, "Chrome");
    mkdirSync(path.join(userDataDir, "Default"), { recursive: true });
    writeFileSync(path.join(userDataDir, "Default", "Preferences"), JSON.stringify({ extensions: { external_uninstalls: ["hhcmgoofomhgciiibhipgmgkgnoenaoi"] } }));
    const browser = { id: "chrome", store: "chrome", userDataDir };
    const result = await registerExternalExtension({ platform: "darwin", browser });
    assert.equal(result.registered, false);
    assert.equal(result.reason, "blocklisted");
    assert.match(result.humanStep, /chromewebstore\.google\.com/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
