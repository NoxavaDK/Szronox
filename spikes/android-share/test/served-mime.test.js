/**
 * Served content types over real HTTP (C02-R1).
 *
 * The diagnostic server previously derived the MIME type from the requested path,
 * so `/` — the entry point the README and browser-check navigate to — was read
 * from index.html but served as application/octet-stream, which a browser may
 * download rather than execute as a document.
 *
 * This is real HTTP against the actual server, not a handler double. It still says
 * nothing about browser or Android behaviour; those gates remain open.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(new URL("../server.js", import.meta.url)));

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Start the server, run the body, and always tear the process down. */
async function withServer(run) {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i += 1) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/index.html`)).ok; } catch { /* not listening yet */ }
      if (!ready) await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(ready, "diagnostic server did not start");
    await run((p) => fetch(`http://127.0.0.1:${port}${p}`));
  } finally {
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
  }
}

test("the root route serves index.html as HTML, not a download", async () => {
  await withServer(async (get) => {
    const rootResponse = await get("/");
    assert.equal(rootResponse.status, 200);
    assert.match(rootResponse.headers.get("content-type") ?? "", /^text\/html/);

    const explicit = await get("/index.html");
    assert.match(explicit.headers.get("content-type") ?? "", /^text\/html/);
    // Same bytes either way: only the declared type was ever wrong.
    assert.equal(await rootResponse.text(), await explicit.text());
  });
});

test("icons and module scripts keep their correct content types", async () => {
  await withServer(async (get) => {
    for (const [file, expected] of [
      ["/icon-192.png", /^image\/png/],
      ["/icon-512.png", /^image\/png/],
      ["/icon.svg", /^image\/svg\+xml/],
      ["/manifest.webmanifest", /^application\/manifest\+json/],
      ["/app.js", /javascript/],
      ["/sw.js", /javascript/],
    ]) {
      const response = await get(file);
      assert.equal(response.status, 200, `${file} should be served`);
      assert.match(response.headers.get("content-type") ?? "", expected, `${file} content type`);
    }
  });
});

test("a missing file is a 404, not an empty 200", async () => {
  await withServer(async (get) => {
    assert.equal((await get("/nie-ma-takiego-pliku.png")).status, 404);
  });
});
