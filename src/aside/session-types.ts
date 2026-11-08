// Types for the Aside engine's REPL session. Types only: nothing here exists at runtime.
import type { SpawnOptions } from "node:child_process";
import type { AsideCommand } from "./cli-binary.ts";
import type { AsideOnboardReport } from "./onboard.ts";

export interface AsideReadable {
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
}

export interface AsideWritable {
  write(data: string): unknown;
  end(data?: string): unknown;
  /** Present on a real child stream; a write that races the child's exit raises EPIPE here. */
  on?(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
}

// What a spawn hands back: a stream is null when its stdio slot was not a pipe.
export interface AsideSpawnedProcess {
  readonly stdin: AsideWritable | null;
  readonly stdout: AsideReadable | null;
  readonly stderr?: AsideReadable | null;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "spawn", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

// The part of a spawned `aside repl` / `aside mcp` child the session uses: stdin and stdout are pipes.
export interface AsideChildProcess extends AsideSpawnedProcess {
  readonly stdin: AsideWritable;
  readonly stdout: AsideReadable;
}

export type AsideSpawn = (command: string, args: string[], options: SpawnOptions) => AsideSpawnedProcess;

export type AsideReplProtocol = "line" | "mcp";

// What a transport learned while starting: the line protocol's banner names the account and
// session directory, `aside mcp` its server version.
export interface AsideTransportInfo {
  account?: string;
  sessionDir?: string;
  version?: string;
}

export interface AsideReplErrorOptions {
  output?: string[];
  setup?: AsideOnboardReport;
}

export interface AsideSessionOptions {
  callTimeoutMs?: number;
  protocol?: AsideReplProtocol;
  account?: string | null;
}

export interface AsideSnapshotOptions {
  find?: string | RegExp;
  context?: number;
  interactive?: boolean;
  showHidden?: boolean;
  selector?: string;
  ref?: string;
}

export interface ConnectAsideOptions {
  account?: string;
  host?: string;
  asideCommand?: AsideCommand;
  autoSetup?: boolean;
  env?: NodeJS.ProcessEnv;
  home?: string;
  startTimeoutMs?: number;
  callTimeoutMs?: number;
  spawn?: AsideSpawn;
}

export interface Waiter {
  isDone: (pending: string, lines: string[]) => boolean;
  resolve: (lines: string[]) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}
