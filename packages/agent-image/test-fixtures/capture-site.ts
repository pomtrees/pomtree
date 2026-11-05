// Offline fixture site for the Docker-gated capture-worker WACZ test (sandbox-docker capture-worker-wacz.test.ts). Two fake virtual hosts on
// one listener: origin-a.test redirects (302) to origin-b.test, whose page carries a placeholder that a script replaces after load.
// Node builtins only: it runs inside the egress sidecar image next to capture-proxy-seam.ts.
import { createServer, type Server } from "node:http";

export const SITE_PORT = 8080;
export const START_PATH = "/start";
export const PAGE_PATH = "/page";
const SCRIPT_PATH = "/app.js";
export const HOST_A = "origin-a.test";
export const HOST_B = "origin-b.test";
// Present only in the served HTML; the script replaces it. A capture that never ran the script holds this and not RENDERED_PHRASE.
export const PLACEHOLDER_PHRASE = "Placeholder paragraph served before any script ran.";
// Present only in the script's source as two fragments and in the DOM once it ran, so the raw HTML and the script bytes never contain it whole.
export const RENDERED_PHRASE = "Rendered by script after load: the archival heron stands in still water.";

const sentence = (n: number) =>
  `Paragraph ${n} of the fixture article explains how an archive keeps what a page showed, with enough words to read as body text rather than navigation.`;
const PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fixture article</title></head>
<body><main><article><h1>Fixture article</h1>
<div id="body"><p>${PLACEHOLDER_PHRASE}</p></div>
${[1, 2, 3, 4].map((n) => `<p>${sentence(n)}</p>`).join("\n")}
</article></main>
<script src="${SCRIPT_PATH}"></script></body></html>
`;
const APP_JS = `window.addEventListener("load", () => {
  const first = "Rendered by script after load:";
  const second = " the archival heron stands in still water.";
  document.getElementById("body").innerHTML = "<p>" + first + second + "</p>";
});
`;

export function startCaptureSite(port = SITE_PORT, host = "127.0.0.1"): Promise<Server> {
  const server = createServer((req, res) => {
    const vhost = (req.headers.host ?? "").split(":")[0];
    const path = (req.url ?? "").split("?")[0];
    if (vhost === HOST_A && path === START_PATH) {
      res.writeHead(302, { location: `http://${HOST_B}:${port}${PAGE_PATH}`, "content-type": "text/plain" });
      res.end("moved\n");
    } else if (vhost === HOST_B && path === PAGE_PATH) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE_HTML);
    } else if (vhost === HOST_B && path === SCRIPT_PATH) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(APP_JS);
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found\n");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
