import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  connectCloakProfile,
  findCloakBrowserPath,
} from "../src/index.js";

test("CloakBrowser reuses site state and fingerprint across reloads", async () => {
  const profileDir = mkdtempSync(path.join(tmpdir(), "omowright-cloak-e2e-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>profile smoke</title><main>ready</main>");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;

  try {
    const first = await connectCloakProfile({
      browserPath: findCloakBrowserPath(),
      profileDir,
      fingerprintSeed: 31415,
    });
    const firstPage = await first.newTab(url);
    const firstState = await firstPage.evaluate(`(() => {
      localStorage.setItem("omowright-profile-smoke", "persisted");
      return { webdriver: navigator.webdriver, value: localStorage.getItem("omowright-profile-smoke") };
    })()`);
    await first.close();

    const second = await connectCloakProfile({
      browserPath: findCloakBrowserPath(),
      profileDir,
    });
    const secondPage = await second.newTab(url);
    const secondState = await secondPage.evaluate(`(() => ({
      webdriver: navigator.webdriver,
      value: localStorage.getItem("omowright-profile-smoke"),
    }))()`);
    await second.close();

    const metadata = JSON.parse(
      readFileSync(path.join(profileDir, ".omowright-cloak.json"), "utf8"),
    );
    assert.deepEqual(firstState, { webdriver: false, value: "persisted" });
    assert.deepEqual(secondState, { webdriver: false, value: "persisted" });
    assert.equal(metadata.fingerprintSeed, 31415);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(profileDir, { recursive: true, force: true });
  }
});
