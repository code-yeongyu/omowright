import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync, globSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectPipe, createAgentTabs } from "../src/index.ts";
import { describeLayers, layersHeader, snapshotWithLayers, type LayersResult } from "../src/layers.ts";

interface FixtureServer {
  urlFor(name: string): string;
  close(): Promise<void>;
}

function requireBinary(binary: string | null | undefined): string {
  assert.ok(binary, "live test ran without a Chromium binary");
  return binary;
}

function findHeadlessShell() {
  const home = process.env.HOME;
  assert.ok(home, "HOME must be set to search the Playwright cache");
  const candidates = globSync(
    path.join(
      home,
      "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell",
    ),
  );
  if (candidates.length > 0) return candidates.toSorted().at(-1);
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chrome)) return chrome;
  return null;
}

const SHELL = process.env.SHELL_BIN ?? findHeadlessShell();
const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function startFixtureServer() {
  const server = createServer((req, res) => {
    const name = path.basename((req.url ?? "/").replace(/\?.*$/s, ""));
    if (!name.startsWith("layers-")) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    try {
      const body = readFileSync(path.join(FIXTURE_DIR, name));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise<FixtureServer>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the fixture server must listen on TCP"));
        return;
      }
      const { port } = address;
      resolve({
        urlFor: (name: string) => `http://127.0.0.1:${port}/${name}`,
        close: () => new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
    server.on("error", reject);
  });
}

// layersHeader reads only `blocking`; the fixtures are full describeLayers results.
function layersResult(result: LayersResult): LayersResult {
  return result;
}

async function launch() {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-layers-test-"));
  const connection = await connectPipe({
    browserPath: requireBinary(SHELL),
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
    storageRoot: ud,
  });
  return {
    connection,
    cleanup: async () => {
      await connection.close();
      rmSync(ud, { recursive: true, force: true });
    },
  };
}

test("layersHeader formats none and blocking lines", () => {
  assert.equal(
    layersHeader(layersResult({ blocking: null, candidates: [], viewport: { width: 1440, height: 900 } })),
    "@layers none",
  );
  assert.equal(
    layersHeader(
      layersResult({
        blocking: {
          tagName: "DIV",
          role: "dialog",
          name: "Cookie consent",
          coverage: 0.96,
          position: "fixed",
          selectorHint: "div",
          ariaModal: false,
        },
        candidates: [],
        viewport: { width: 1440, height: 900 },
      }),
    ),
    `@layers blocking=dialog "Cookie consent" coverage=96% hint=div`,
  );
  assert.equal(
    layersHeader(
      layersResult({
        blocking: {
          tagName: "DIV",
          role: "",
          name: "Saved",
          coverage: 0.08,
          position: "fixed",
          selectorHint: "#toast",
          ariaModal: false,
        },
        candidates: [],
        viewport: { width: 1440, height: 900 },
      }),
    ),
    `@layers blocking=DIV "Saved" coverage=8% hint=#toast`,
  );
});

test(
  "describeLayers and snapshotWithLayers classify live overlays",
  { skip: !SHELL && "no chromium binary found", timeout: 60000 },
  async () => {
    const fixtures = await startFixtureServer();
    const { connection, cleanup } = await launch();
    try {
      const page = (await createAgentTabs(connection).create("about:blank")).page;

      await page.goto(fixtures.urlFor("layers-dialog.html"));
      const dialogLayers = await describeLayers(page);
      assert.equal(dialogLayers.blocking?.role, "dialog");
      assert.equal(dialogLayers.blocking?.name, "Cookie consent");
      assert.ok(dialogLayers.blocking?.coverage >= 0.9, `dialog coverage ${dialogLayers.blocking?.coverage}`);
      assert.ok(layersHeader(dialogLayers).includes(`blocking=dialog "Cookie consent"`), layersHeader(dialogLayers));

      await page.goto(fixtures.urlFor("layers-plain.html"));
      const plainLayers = await describeLayers(page);
      assert.equal(plainLayers.blocking, null);
      assert.equal(layersHeader(plainLayers), "@layers none");

      const snapshot = await page.snapshot();
      const withLayers = await snapshotWithLayers(page);
      const headerLine = layersHeader(withLayers.layers);
      assert.equal(withLayers.tree.startsWith(`${headerLine}\n`), true);
      const snapshotFirstLine = snapshot.tree.split("\n")[0];
      assert.ok(snapshotFirstLine !== undefined);
      assert.ok(snapshotFirstLine.length > 0);
      assert.ok(
        withLayers.tree.split("\n").slice(1).join("\n").includes(snapshotFirstLine),
        "snapshotWithLayers tree still contains the snapshot's first line after the header",
      );

      await page.goto(fixtures.urlFor("layers-toast.html"));
      const toastLayers = await describeLayers(page);
      assert.equal(toastLayers.blocking, null, "a toast must not register as a blocking layer");
    } finally {
      await cleanup();
      await fixtures.close();
    }
  },
);
