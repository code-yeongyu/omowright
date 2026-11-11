// The server-side ws surface the test fixtures drive; src/ws.d.ts declares only what src uses.
declare module "ws" {
  import type { IncomingMessage } from "node:http";

  interface WebSocket {
    send(data: string | Buffer, callback: (error?: Error) => void): void;
    terminate(): void;
  }

  interface WebSocketServer {
    readonly clients: Set<WebSocket>;
    emit(event: "connection", client: WebSocket, request?: IncomingMessage): boolean;
    on(event: "connection", listener: (client: WebSocket, request: IncomingMessage) => void): this;
  }
}
