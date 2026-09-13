import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
const types = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".json":"application/json", ".webmanifest":"application/manifest+json", ".svg":"image/svg+xml" };
createServer(async (req, res) => {
  const path = normalize(new URL(req.url, "http://localhost").pathname).replace(/^\.\.(\/|\\)/, "");
  try { const body = await readFile(join(process.cwd(), path === "/" ? "index.html" : path)); res.writeHead(200,{"content-type":types[extname(path)]||"application/octet-stream","cache-control":"no-store"}); res.end(body); }
  catch { res.writeHead(404); res.end("Not found"); }
}).listen(4173, "127.0.0.1", () => console.log("Diagnostyka: http://127.0.0.1:4173"));
