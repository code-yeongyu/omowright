declare module "ws" {
  import type { IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";

  type WebSocketReadyState = 0 | 1 | 2 | 3;

  interface WebSocketMessageEvent {
    data: string | Buffer | ArrayBuffer;
    type: string;
  }

  interface WebSocketCloseEvent {
    code: number;
    reason: string;
    wasClean: boolean;
    type: string;
  }

  interface WebSocketClientOptions {
    headers?: Record<string, string>;
  }

  class WebSocket {
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;
    readonly readyState: WebSocketReadyState;
    constructor(address: string | URL, options?: WebSocketClientOptions);
    send(data: string | Buffer | ArrayBuffer | ArrayBufferView): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: "open" | "error", listener: () => void, options?: { once?: boolean }): void;
    addEventListener(
      type: "message",
      listener: (event: WebSocketMessageEvent) => void,
      options?: { once?: boolean },
    ): void;
    addEventListener(type: "close", listener: (event: WebSocketCloseEvent) => void, options?: { once?: boolean }): void;
    on(event: "open" | "close", listener: () => void): this;
    on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): this;
  }

  class WebSocketServer {
    constructor(options: { noServer: true });
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (client: WebSocket, request: IncomingMessage) => void,
    ): void;
    close(callback?: (error?: Error) => void): void;
  }

  export { WebSocket, WebSocketServer };
  export type { WebSocketCloseEvent, WebSocketMessageEvent };
  export default WebSocket;
}
