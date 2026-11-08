// In-process stand-in for the BrowserSkill daemon's CLI-facing IPC: a Unix
// socket server speaking one JSON Lines frame per request, mirroring
// `crates/bsk-cli/src/daemon/ipc.rs` (RequestFrame {id, method, params} ->
// ResponseFrame {id, result} | {id, error}). Tests script replies per method
// and read back every request the daemon saw.
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultSocketPath } from "../../src/bsk/ipc-client.ts";

export interface BskRequestFrame {
  id: unknown;
  method: string;
  params?: unknown;
}

export type BskReply = { result: unknown } | { error: unknown } | string | undefined;
export type BskHandler = (frame: BskRequestFrame) => BskReply;

export interface FakeBskDaemonOptions {
  handlers?: Record<string, BskHandler>;
  delayMs?: number;
  sockPathFor?: (home: string) => string;
  splitReplyAt?: string;
}

export interface FakeBskDaemon {
  home: string;
  sockPath: string;
  requests: BskRequestFrame[];
  close(): Promise<void>;
}

export async function startFakeBskDaemon({
  handlers = {},
  delayMs = 0,
  sockPathFor = defaultSocketPath,
  splitReplyAt,
}: FakeBskDaemonOptions = {}): Promise<FakeBskDaemon> {
  const home = mkdtempSync(path.join(tmpdir(), "fake-bsk-home-"));
  mkdirSync(path.join(home, "run"));
  // Listen where the real daemon would for this home: run/daemon.sock, or the derived pipe on Windows.
  // `sockPathFor` moves it elsewhere, so only daemon.json can lead a client to it.
  const sockPath = sockPathFor(home);
  const requests: BskRequestFrame[] = [];
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.length === 0) continue;
        handle(socket, line);
      }
    });
  });

  function handle(socket: Socket, line: string) {
    let frame: BskRequestFrame;
    try {
      frame = JSON.parse(line);
    } catch {
      socket.write("not json\n");
      return;
    }
    requests.push(frame);
    const handler = handlers[frame.method] ?? defaultHandler;
    const reply = handler(frame);
    if (reply === undefined) return; // scripted silence: the client must time out
    const send = () => {
      const body = typeof reply === "string" ? reply : JSON.stringify({ id: frame.id, ...reply });
      if (socket.destroyed) return;
      if (splitReplyAt === undefined) {
        socket.write(body + "\n");
        return;
      }
      // Two separate writes, the cut placed inside one multi-byte UTF-8 character.
      const bytes = Buffer.from(body + "\n", "utf8");
      const cut = bytes.indexOf(Buffer.from(splitReplyAt, "utf8")) + 1;
      // The pause keeps the kernel from merging the halves into one read; the fixed client
      // decodes either way, so it only decides whether the old decoder is exercised.
      socket.write(bytes.subarray(0, cut), () =>
        setTimeout(() => {
          if (!socket.destroyed) socket.write(bytes.subarray(cut));
        }, 50),
      );
    };
    if (delayMs > 0) setTimeout(send, delayMs);
    else send();
  }

  function defaultHandler(frame: BskRequestFrame): BskReply {
    if (frame.method === "system.ping") return { result: { pong: true } };
    if (frame.method === "cancel") return { result: { cancelled: true } };
    return { error: { code: "unknown_method", message: `unknown method ${frame.method}` } };
  }

  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(sockPath, resolve));
  writeFileSync(
    path.join(home, "daemon.json"),
    JSON.stringify({
      pid: process.pid,
      sock_path: sockPath,
      ws_port: 52800,
      version: "0.3.0-fake",
      started_at_epoch_secs: Math.floor(Date.now() / 1000),
    }),
  );

  return {
    home,
    sockPath,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      rmSync(home, { recursive: true, force: true });
    },
  };
}
