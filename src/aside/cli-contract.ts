// Which REPL contract an Aside CLI speaks, read from the CLI's own `aside repl --help`, never
// from its version number. Up to 1.26.916 a piped `aside repl` printed a banner and a prompt and
// evaluated each stdin line. From 1.26.1107 a piped `aside repl` reads stdin to EOF and runs it
// as one script, and its help says so ("Without code, piped stdin runs as one script."); its
// long-lived REPL session lives behind `aside mcp` (the `repl` tool) instead.
// Known limit: this keys on the help's wording. A CLI that keeps the one-script behavior but
// rewords the phrase falls back to the line protocol, whose start then fails with
// repl_start_timeout naming the CLI version, never a silent wrong session.
import type { AsideReplProtocol, AsideSpawn, AsideSpawnedProcess } from "./session-types.ts";

const SCRIPT_AT_EOF = /piped stdin runs as one script/i;
// `aside mcp --help` lists its tools one per line; a `repl` entry means the mcp transport works.
const LISTS_REPL_TOOL = /^\s*repl\b/m;

export interface AsideCliProbeOptions {
  spawn: AsideSpawn;
  command: readonly [string, ...string[]];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

interface CliCapture {
  out: string | null;
  timedOut: boolean;
}

function captureCli({
  spawn,
  command,
  args,
  env,
  timeoutMs,
}: AsideCliProbeOptions & { args: string[] }): Promise<CliCapture> {
  return new Promise((resolve) => {
    const [bin, ...lead] = command;
    let child: AsideSpawnedProcess;
    try {
      child = spawn(bin, [...lead, ...args], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch {
      resolve({ out: null, timedOut: false });
      return;
    }
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ out: null, timedOut: true });
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      out += chunk;
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ out: null, timedOut: false });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ out: code === 0 ? out : null, timedOut: false });
    });
  });
}

// "mcp" when piped `aside repl` runs stdin as one script; "line" otherwise, including when the
// help fails, which keeps the protocol every earlier CLI spoke. Each help probe gets the caller's
// short fixed timeoutMs, not the REPL start budget. When `aside repl --help` times out, the
// default is "mcp" if `aside mcp --help` lists a repl tool, else "line".
export async function replTransportFor(options: AsideCliProbeOptions): Promise<AsideReplProtocol> {
  const help = await captureCli({ ...options, args: ["repl", "--help"] });
  if (help.out !== null) return SCRIPT_AT_EOF.test(help.out) ? "mcp" : "line";
  if (!help.timedOut) return "line";
  const mcpHelp = await captureCli({ ...options, args: ["mcp", "--help"] });
  return mcpHelp.out !== null && LISTS_REPL_TOOL.test(mcpHelp.out) ? "mcp" : "line";
}

export async function asideCliVersion(options: AsideCliProbeOptions): Promise<string | null> {
  const { out } = await captureCli({ ...options, args: ["--version"] });
  return out?.trim() || null;
}
