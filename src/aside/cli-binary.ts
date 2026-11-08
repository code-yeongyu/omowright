// Locates the Aside CLI: ASIDE_BIN, then ~/.local/bin, then (Windows) %LOCALAPPDATA%\Aside\CLI\current, then PATH.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// The Aside CLI and any arguments before `repl`; the binary is absent when none was found.
export type AsideCommand = readonly [bin?: string | null, ...lead: string[]];

export interface FindAsideBinaryOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (file: string) => boolean;
}

export function findAsideBinary({
  env = process.env,
  home = homedir(),
  exists = existsSync,
}: FindAsideBinaryOptions = {}): string | null {
  if (env.ASIDE_BIN) return env.ASIDE_BIN;
  const candidates = [path.join(home, ".local", "bin", process.platform === "win32" ? "aside.exe" : "aside")];
  // Aside's Windows installer (install.ps1) puts the CLI here, off PATH with -SkipPathUpdate.
  if (process.platform === "win32" && env.LOCALAPPDATA)
    candidates.push(path.join(env.LOCALAPPDATA, "Aside", "CLI", "current", "aside.exe"));
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, process.platform === "win32" ? "aside.exe" : "aside"));
  }
  return candidates.find((candidate) => exists(candidate)) ?? null;
}
