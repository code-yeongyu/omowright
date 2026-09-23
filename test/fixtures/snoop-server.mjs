import { createServer } from "node:http";

const PAGE_SIZE = 5;
const MAX_PAGE = 4;

const HTML = `<!DOCTYPE html>
<html>
  <head><title>snoop fixture</title></head>
  <body style="margin:0;font-family:monospace">
    <button id="ping" style="height:40px;width:120px">ping</button>
    <div id="items"></div>
    <div id="tail" style="height:200px">bottom marker with enough text to pass the readiness probe</div>
    <script>
      window.__loaded = [];
      window.__clicked = null;
      let nextPage = 0;
      let loading = false;
      async function loadMore() {
        if (loading || nextPage >= ${MAX_PAGE}) return;
        loading = true;
        nextPage += 1;
        try {
          const response = await fetch('/api/items?page=' + nextPage);
          const items = await response.json();
          const list = document.getElementById('items');
          for (const item of items) {
            const row = document.createElement('div');
            row.className = 'item';
            row.style.height = '240px';
            row.textContent = 'item ' + item.id;
            list.appendChild(row);
            window.__loaded.push(item.id);
          }
        } finally {
          loading = false;
        }
      }
      window.addEventListener('scroll', () => {
        const remaining = document.scrollingElement.scrollHeight - window.scrollY - window.innerHeight;
        if (remaining < window.innerHeight) loadMore();
      });
      document.getElementById('ping').addEventListener('click', async () => {
        const response = await fetch('/api/click');
        window.__clicked = await response.json();
      });
      loadMore();
    </script>
  </body>
</html>`;

function itemsForPage(page) {
  return Array.from({ length: PAGE_SIZE }, (_unused, index) => ({ id: (page - 1) * PAGE_SIZE + index + 1 }));
}

export async function startSnoopServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(HTML);
      return;
    }
    if (url.pathname === "/api/items") {
      const page = Math.min(MAX_PAGE, Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(itemsForPage(page)));
      return;
    }
    if (url.pathname === "/api/click") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    itemsPerPage: PAGE_SIZE,
    maxPage: MAX_PAGE,
    async close() {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
