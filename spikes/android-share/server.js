import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
const types = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".json":"application/json", ".webmanifest":"application/manifest+json", ".svg":"image/svg+xml", ".png":"image/png" };
createServer(async (req, res) => {
  const requested = normalize(new URL(req.url, "http://localhost").pathname).replace(/^\.\.(\/|\\)/, "");
  // C02-R1: the served file decides the MIME type. Deriving it from the incoming
  // path returned application/octet-stream for "/", which a browser may download
  // instead of executing as a document -- and "/" is the entry point the README
  // and browser-check navigate to.
  const served = requested === "/" || requested.endsWith("/") ? join(requested, "index.html") : requested;
  try { const body = await readFile(join(process.cwd(), served)); res.writeHead(200,{"content-type":types[extname(served)]||"application/octet-stream","cache-control":"no-store"}); res.end(body); }
  catch { res.writeHead(404); res.end("Not found"); }
}).listen(Number(process.env.PORT ?? 4173), "127.0.0.1", function () {
  // PORT is honoured so a test can bind a free port instead of racing 4173.
  console.log(`Diagnostyka: http://127.0.0.1:${this.address().port}`);
});
