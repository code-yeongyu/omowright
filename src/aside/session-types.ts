// Types for the Aside engine's REPL session. Types only: nothing here exists at runtime.
import type { SpawnOptionsWithStdioTuple, StdioPipe } from "node:child_process";
import type { AsideCommand } from "./cli-binary.ts";
import type { AsideOnboardReport } from "./onboard.ts";

export interface AsideReadable {
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
}

// The part of a spawned `aside repl` child the session uses.
export interface AsideChildProcess {
  readonly stdin: {
    write(data: string): unknown;
    end(data: string): unknown;
    /** Present on a real child stream; a write that races the child's exit raises EPIPE here. */
    on?(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
  };
  readonly stdout: AsideReadable;
  readonly stderr?: AsideReadable | null;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "spawn", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  kill(): unknown;
}

export type AsideSpawn = (
  command: string,
  args: string[],
  options: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe>,
) => AsideChildProcess;

export interface AsideReplErrorOptions {
  output?: string[];
  setup?: AsideOnboardReport;
}

export interface AsideSessionOptions {
  callTimeoutMs?: number;
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
