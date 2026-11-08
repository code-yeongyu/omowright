import { createServer } from "node:http";

const HTML = `<!DOCTYPE html>
<html>
  <head><title>trace fixture</title></head>
  <body style="margin:0;font-family:monospace">
    <h1>trace fixture</h1>
    <p>this page loads json on load and fetches more json when the button is clicked</p>
    <button id="go" style="height:40px;width:160px">fetch click</button>
    <div id="out" style="height:200px">bottom marker with enough text to pass the readiness probe</div>
    <script>
      window.__data = fetch('/api/data').then(function (response) { return response.json(); });
      var resolveClick;
      window.__clicked = new Promise(function (resolve) { resolveClick = resolve; });
      document.getElementById('go').addEventListener('click', function () {
        fetch('/api/click')
          .then(function (response) { return response.json(); })
          .then(function (payload) {
            document.getElementById('out').textContent = 'clicked ' + payload.clicked;
            resolveClick(payload);
          });
      });
    </script>
  </body>
</html>`;

export async function startTraceServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(HTML);
      return;
    }
    if (url.pathname === "/api/data") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ items: [{ id: 1 }, { id: 2 }], source: "load" }));
      return;
    }
    if (url.pathname === "/api/click") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ clicked: true }));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    async close() {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
