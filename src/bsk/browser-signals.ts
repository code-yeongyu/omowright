import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { windowsSystemTool } from "../owner-only.ts";
import { readProperty } from "../read-property.ts";
import { pathFor } from "./browsers.ts";
import { optionalProperty } from "./reply-fields.ts";

const PROBE_TIMEOUT_MS = 3_000;

export type RunCommand = (command: string, args: string[]) => Promise<string | null>;
export type StatFn = (file: string) => { mtimeMs: number };

export interface BrowserSignals {
  defaultBrowser: string | null;
  running: string[] | null;
  lastUsed: Record<string, number | null>;
}

function runDefault(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        resolve(error ? null : String(stdout));
      },
    );
  });
}

export function parseMacDefaultBrowser(plistJson: string): string | null {
  let handlers: unknown;
  try {
    handlers = optionalProperty(JSON.parse(plistJson), "LSHandlers");
  } catch {
    return null;
  }
  if (!Array.isArray(handlers)) return null;
  const list: unknown[] = handlers;
  const pick = (scheme: string): unknown => {
    const handler = list.find(
      (h) =>
        optionalProperty(h, "LSHandlerURLScheme") === scheme && typeof readProperty(h, "LSHandlerRoleAll") === "string",
    );
    return handler === undefined ? undefined : readProperty(handler, "LSHandlerRoleAll");
  };
  const role = pick("https") ?? pick("http");
  return typeof role === "string" ? role.toLowerCase() : "com.apple.safari";
}

export function parseWindowsProgId(regOutput: string | null | undefined): string | null {
  const match = /ProgId\s+REG_SZ\s+(\S+)/i.exec(regOutput ?? "");
  return match?.[1]?.toLowerCase() ?? null;
}

export function parseProcessNames(platform: string, output: string | null | undefined): string[] {
  const names = new Set<string>();
  for (const raw of String(output ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (platform === "win32") {
      const image = /^"([^"]+)"/.exec(line)?.[1];
      if (image) names.add(image.toLowerCase());
    } else if (platform === "darwin") {
      if (/\.app\/Contents\/MacOS\/[^/]+$/.test(line)) names.add(line);
    } else {
      names.add(path.posix.basename(line));
    }
  }
  return [...names];
}

interface ProbeInput {
  platform: string;
  home: string;
  run: RunCommand;
}

async function probeDefault({ platform, home, run }: ProbeInput): Promise<string | null> {
  if (platform === "darwin") {
    const plist = path.posix.join(
      home,
      "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist",
    );
    const json = await run("plutil", ["-convert", "json", "-o", "-", plist]);
    return json === null ? null : parseMacDefaultBrowser(json);
  }
  if (platform === "linux") {
    const out = await run("xdg-settings", ["get", "default-web-browser"]);
    return out?.trim() ? out.trim().toLowerCase() : null;
  }
  if (platform === "win32") {
    const key = "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice";
    return parseWindowsProgId(await run(windowsSystemTool("reg.exe"), ["query", key, "/v", "ProgId"]));
  }
  return null;
}

async function probeRunning({ platform, run }: Omit<ProbeInput, "home">): Promise<string[] | null> {
  const out =
    platform === "win32"
      ? await run(windowsSystemTool("tasklist.exe"), ["/fo", "csv", "/nh"])
      : await run("ps", platform === "darwin" ? ["-axo", "comm="] : ["-eo", "comm="]);
  return out === null ? null : parseProcessNames(platform, out);
}

function lastUsedAt(browser: { userDataDir: string }, stat: StatFn, { join }: typeof path.posix): number | null {
  let latest: number | null = null;
  for (const rel of [["Local State"], ["Default", "History"], ["Default", "Preferences"]]) {
    try {
      const mtime = stat(join(browser.userDataDir, ...rel)).mtimeMs;
      if (latest === null || mtime > latest) latest = mtime;
    } catch {}
  }
  return latest;
}

export interface ProbeBrowserSignalsOptions {
  platform?: string;
  home?: string;
  browsers?: Array<{ id: string; userDataDir: string }>;
  run?: RunCommand;
  stat?: StatFn;
}

// Reads the machine-wide facts that say which browser the user actually uses. Every probe degrades to
// null (unknown) instead of throwing, so a locked-down machine yields "ask the user", never a guess.
export async function probeBrowserSignals({
  platform = process.platform,
  home = homedir(),
  browsers = [],
  run = runDefault,
  stat = statSync,
}: ProbeBrowserSignalsOptions = {}): Promise<BrowserSignals> {
  const [defaultBrowser, running] = await Promise.all([
    probeDefault({ platform, home, run }),
    probeRunning({ platform, run }),
  ]);
  const lastUsed = Object.fromEntries(browsers.map((b) => [b.id, lastUsedAt(b, stat, pathFor(platform))]));
  return { defaultBrowser, running, lastUsed };
}
