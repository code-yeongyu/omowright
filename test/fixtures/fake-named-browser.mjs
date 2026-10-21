import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const target = {
  description: "",
  id: "fake-page",
  title: "Fake named browser",
  type: "page",
  url: "about:blank",
};

const server = createServer((req, res) => {
  const port = server.address().port;
  if (req.url === "/json/version") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        Browser: "FakeNamedBrowser/1.0",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl:
          `ws://127.0.0.1:${port}/devtools/browser/fake`,
      }),
    );
    return;
  }
  if (req.url === "/json/list") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([target]));
    return;
  }
  res.writeHead(404).end();
});

const sockets = new Set();
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

const webSockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  webSockets.handleUpgrade(req, socket, head, (webSocket) => {
    webSockets.emit("connection", webSocket, req);
  });
});
webSockets.on("connection", (webSocket) => {
  webSocket.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const result = message.method === "Browser.getVersion"
      ? { product: "FakeNamedBrowser/1.0", protocolVersion: "1.3" }
      : {};
    webSocket.send(JSON.stringify({ id: message.id, result }));
  });
});

function shutdown() {
  for (const webSocket of webSockets.clients) webSocket.terminate();
  for (const socket of sockets) socket.destroy();
  webSockets.close();
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  process.stderr.write(
    `DevTools listening on ws://127.0.0.1:${port}/devtools/browser/fake\n`,
  );
});
