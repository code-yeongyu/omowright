/**
 * Runs the suite under real Node with the browser binary pinned.
 *
 * The suite's membership depends on SHELL_BIN: without it, nine live tests skip and the gate
 * compares a different set of tests between runs, which makes two heads look equal when they are
 * not. This resolves the binary once (the environment first, then Playwright's cache) and refuses
 * to start when there is none, so a smaller set can never be reported as a green run.
 *
 * NODE_BIN picks the interpreter when a specific one must be exercised.
 */
import { globSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLAYWRIGHT_CACHE_PATTERNS = [
  "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell",
  "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-x64/chrome-headless-shell",
  "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell",
  ".cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell",
  ".cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell",
];

function fromPlaywrightCache(): string | null {
  const home = process.env.HOME;
  if (home === undefined) return null;
  const found: string[] = [];
  for (const pattern of PLAYWRIGHT_CACHE_PATTERNS) {
    found.push(...globSync(path.join(home, pattern)));
  }
  return found.toSorted().at(-1) ?? null;
}

function resolveBrowser(): string | null {
  const fromEnvironment = process.env.SHELL_BIN;
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) return fromEnvironment;
  return fromPlaywrightCache();
}

const browser = resolveBrowser();
if (browser === null) {
  console.error(
    "test:node needs a Chromium binary. Set SHELL_BIN (CI installs chrome-headless-shell), or install one into Playwright's cache. Refusing to run: without it nine live tests skip, and a smaller set is not the same gate.",
  );
  process.exit(1);
}

const cloakBrowser = process.env.CLOAKBROWSER_BIN ?? browser;
const testFiles = readdirSync(path.join(ROOT, "test"))
  .filter((name) => name.endsWith(".test.ts"))
  .toSorted()
  .map((name) => path.join("test", name));

console.log(`test:node: ${testFiles.length} files, SHELL_BIN=${browser}`);

const result = Bun.spawnSync({
  cmd: [process.env.NODE_BIN ?? "node", "--test", ...testFiles],
  cwd: ROOT,
  env: { ...process.env, SHELL_BIN: browser, CLOAKBROWSER_BIN: cloakBrowser },
  stdio: ["inherit", "inherit", "inherit"],
});

process.exit(result.exitCode ?? 1);
