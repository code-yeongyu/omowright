import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultNativeMessagingHostDir } from "../src/bridge-transport.js";

// Chrome's documented per-user native messaging host locations.
const EXPECTED = {
  darwin: {
    chrome: ["Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"],
    chromium: ["Library", "Application Support", "Chromium", "NativeMessagingHosts"],
  },
  linux: {
    chrome: [".config", "google-chrome", "NativeMessagingHosts"],
    chromium: [".config", "chromium", "NativeMessagingHosts"],
  },
};

for (const [platform, browsers] of Object.entries(EXPECTED)) {
  for (const [browser, segments] of Object.entries(browsers)) {
    test(`default native messaging host dir: ${browser} on ${platform}`, () => {
      assert.equal(defaultNativeMessagingHostDir(browser, platform), path.join(homedir(), ...segments));
    });
  }
}

test("default native messaging host dir refuses unknown browsers and platforms", () => {
  assert.throws(() => defaultNativeMessagingHostDir("cloakbrowser", "linux"), /custom browser requires nativeMessagingHostDir/);
  assert.throws(() => defaultNativeMessagingHostDir("chrome", "win32"), /nativeMessagingHostDir/);
});
