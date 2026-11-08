// Registers the Web Store extension through Chrome's "external extensions"
// mechanism (the only non-enterprise path that survives Chrome 25's ban on
// silent installs): a per-user JSON file on macOS/Chromium-Linux, an HKCU
// registry value on Windows, a root-owned directory for Google Chrome on
// Linux. Windows and macOS still show one "Enable extension?" prompt.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { windowsSystemTool } from "../owner-only.ts";
import { readProperty } from "../read-property.ts";
import { BROWSERSKILL_EXTENSION_IDS, STORE_PAGE_URLS, STORE_UPDATE_URLS, pathFor } from "./browsers.ts";
import type { StoreId } from "./browsers.ts";
import { optionalProperty } from "./reply-fields.ts";

export {
  BROWSERSKILL_EXTENSION_IDS,
  STORE_PAGE_URLS,
  STORE_UPDATE_URLS,
  catalogBrowsers,
  detectBrowsers,
} from "./browsers.ts";

// The fields of a catalog row (or a hand-built one) that registration reads.
export interface ExtensionBrowser {
  id: string;
  label?: string;
  store: StoreId;
  userDataDir?: string;
  externalDir?: string | null;
  userExternalDir?: boolean;
  registryKey?: string | null;
  externalExtensions?: boolean;
}

export interface StoreEntry {
  kind: "store";
  needsRestart: false;
  storeUrl: string;
  humanStep: string;
}

export interface RegistryEntry {
  kind: "registry";
  key: string;
  needsRestart: false;
  storeUrl: string;
  regAddArgs: string[];
  regDeleteArgs: string[];
  humanStep: string;
}

export interface FileEntry {
  kind: "file";
  path: string;
  content: string;
  needsRestart: true;
  storeUrl: string;
  humanStep: string;
}

export type ExtensionEntry = StoreEntry | RegistryEntry | FileEntry;

export type ExtensionRegistration = ExtensionEntry & {
  registered: boolean;
  alreadyPresent: boolean;
  reason?: "store_only" | "blocklisted" | "reg_failed" | "not_writable";
  detail?: string | undefined;
};

export type ExtensionRemoval = ExtensionEntry & { removed: boolean; detail?: string | undefined };

type ReadFile = (file: string, encoding: "utf8") => string;
type WriteFile = (file: string, content: string) => void;
type RunReg = (args: string[]) => Promise<{ code: number | null; stderr?: string }>;

// path.join rejected a missing directory here before the types made it explicit.
function requireDir(dir: string | null | undefined, what: string): string {
  if (typeof dir !== "string") throw new TypeError(`${what} is not set for this browser`);
  return dir;
}

const ENABLE_STEP = (browser: string) =>
  `Quit ${browser} completely and open it again; a dialog offers to enable "BrowserSkill" — click Enable.`;
const BADGE_STEP = (browser: string) =>
  `In ${browser}, open the menu (the badge on the toolbar) and enable "BrowserSkill" when prompted; no restart is needed.`;

const storeStep = (browser: ExtensionBrowser, label: string) =>
  `Open ${STORE_PAGE_URLS[browser.store]} in ${label} and click the "Add" button.`;

export function externalExtensionEntry({
  platform = process.platform,
  browser,
}: {
  platform?: string;
  browser: ExtensionBrowser;
}): ExtensionEntry {
  const id = BROWSERSKILL_EXTENSION_IDS[browser.store];
  const updateUrl = STORE_UPDATE_URLS[browser.store];
  const label = browser.label ?? browser.id.charAt(0).toUpperCase() + browser.id.slice(1);
  if (browser.externalExtensions === false) {
    return {
      kind: "store",
      needsRestart: false,
      storeUrl: STORE_PAGE_URLS[browser.store],
      humanStep: storeStep(browser, label),
    };
  }
  if (platform === "win32") {
    const key = `${browser.registryKey}\\${id}`;
    return {
      kind: "registry",
      key,
      needsRestart: false,
      storeUrl: STORE_PAGE_URLS[browser.store],
      regAddArgs: ["add", key, "/v", "update_url", "/t", "REG_SZ", "/d", updateUrl, "/f"],
      regDeleteArgs: ["delete", key, "/f"],
      humanStep: BADGE_STEP(label),
    };
  }
  const content = JSON.stringify({ external_update_url: updateUrl }, null, 2) + "\n";
  if (platform === "linux" && !browser.userExternalDir) {
    return {
      kind: "file",
      path: pathFor(platform).join(requireDir(browser.externalDir, "externalDir"), `${id}.json`),
      content,
      needsRestart: true,
      storeUrl: STORE_PAGE_URLS[browser.store],
      humanStep: `Quit ${label} completely and open it again; the extension installs without a prompt.`,
    };
  }
  return {
    kind: "file",
    path: pathFor(platform).join(requireDir(browser.userDataDir, "userDataDir"), "External Extensions", `${id}.json`),
    content,
    needsRestart: true,
    storeUrl: STORE_PAGE_URLS[browser.store],
    humanStep:
      platform === "linux"
        ? `Quit ${label} completely and open it again; the extension installs without a prompt.`
        : ENABLE_STEP(label),
  };
}

export function isBlocklisted(
  browser: { userDataDir?: string },
  id: string,
  { readFile = readFileSync }: { readFile?: ReadFile } = {},
): boolean {
  if (!browser.userDataDir) return false;
  for (const profile of ["Default", "Profile 1", "Profile 2", "Profile 3"]) {
    const file = path.join(browser.userDataDir, profile, "Preferences");
    let prefs: unknown;
    try {
      prefs = JSON.parse(readFile(file, "utf8"));
    } catch {
      continue;
    }
    const uninstalls = optionalProperty(optionalProperty(prefs, "extensions"), "external_uninstalls");
    if (Array.isArray(uninstalls) && uninstalls.includes(id)) return true;
  }
  return false;
}

function runRegDefault(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(windowsSystemTool("reg.exe"), args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => {
      stderr += c;
    });
    child.on("error", (error) => resolve({ code: -1, stderr: error.message }));
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

export interface RegisterExternalExtensionOptions {
  platform?: string;
  browser: ExtensionBrowser;
  writeFile?: WriteFile;
  readFile?: ReadFile;
  runReg?: RunReg;
}

export async function registerExternalExtension({
  platform = process.platform,
  browser,
  writeFile = writeFileSync,
  readFile = readFileSync,
  runReg = runRegDefault,
}: RegisterExternalExtensionOptions): Promise<ExtensionRegistration> {
  const entry = externalExtensionEntry({ platform, browser });
  const id = BROWSERSKILL_EXTENSION_IDS[browser.store];
  const label = browser.label ?? browser.id;
  const storeHint = `Open ${entry.storeUrl} in ${label} and click the "Add" button.`;
  if (entry.kind === "store") return { ...entry, registered: false, alreadyPresent: false, reason: "store_only" };
  if (isBlocklisted(browser, id, { readFile })) {
    return {
      ...entry,
      registered: false,
      alreadyPresent: false,
      reason: "blocklisted",
      humanStep: `The extension was removed from ${label} before, so external registration is ignored. ${storeHint}`,
    };
  }
  if (entry.kind === "registry") {
    const result = await runReg(entry.regAddArgs);
    if (result.code !== 0)
      return {
        ...entry,
        registered: false,
        alreadyPresent: false,
        reason: "reg_failed",
        detail: result.stderr,
        humanStep: storeHint,
      };
    return { ...entry, registered: true, alreadyPresent: false };
  }
  let alreadyPresent = false;
  try {
    alreadyPresent = readFile(entry.path, "utf8") === entry.content;
  } catch {}
  if (alreadyPresent) return { ...entry, registered: true, alreadyPresent: true };
  try {
    mkdirSync(path.dirname(entry.path), { recursive: true });
    writeFile(entry.path, entry.content);
  } catch (error) {
    const code = readProperty(error, "code");
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      return {
        ...entry,
        registered: false,
        alreadyPresent: false,
        reason: "not_writable",
        humanStep: `${entry.path} is not writable without administrator rights. ${storeHint}`,
      };
    }
    throw error;
  }
  return { ...entry, registered: true, alreadyPresent: false };
}

export async function unregisterExternalExtension({
  platform = process.platform,
  browser,
  runReg = runRegDefault,
}: {
  platform?: string;
  browser: ExtensionBrowser;
  runReg?: RunReg;
}): Promise<ExtensionRemoval> {
  const entry = externalExtensionEntry({ platform, browser });
  if (entry.kind === "store") return { ...entry, removed: false };
  if (entry.kind === "registry") {
    const result = await runReg(entry.regDeleteArgs);
    return { ...entry, removed: result.code === 0, detail: result.stderr };
  }
  const present = existsSync(entry.path);
  if (present) rmSync(entry.path, { force: true });
  return { ...entry, removed: present };
}
