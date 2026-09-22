/**
 * Second build: the service worker.
 *
 * Two things make this a separate build rather than another entry in `vite.config.ts`:
 *
 *   1. **Format.** A service worker registered as `type: 'classic'` must not contain `import`
 *      statements. The app build emits ES modules with code splitting; this one emits a single
 *      self-contained IIFE. Relying on an ESM build that "happens to work" as a classic script
 *      is exactly the fragility this avoids.
 *   2. **Ordering.** The worker's precache list must name the hashed files the app build
 *      actually produced. Running afterwards lets it read `dist/.vite/manifest.json` and inject
 *      the real names, so the list cannot drift from the build.
 *
 * The alternative — a Rollup plugin inside the app build that rewrites a placeholder in the
 * emitted worker during `generateBundle` — would avoid the second process, but it would also
 * mean hand-managing the worker's module format and its own dependency inlining. Two sequential
 * Vite builds reading one manifest file is the simpler deterministic arrangement, and it uses
 * no dependency the project does not already have.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const outDir = resolve(import.meta.dirname, 'dist');

/** Static files copied verbatim from `public/`. Unhashed, so they are listed by name. */
const publicShellFiles = [
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
];

interface ManifestChunk { file: string; css?: string[]; isEntry?: boolean }

/**
 * Read the app build's own record of what it emitted.
 *
 * A missing manifest means this config ran without a preceding app build; failing loudly is
 * the point — a worker built with an empty precache list would install and then serve nothing.
 */
function shellAssets(): string[] {
  const manifestPath = resolve(outDir, '.vite/manifest.json');
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    throw new Error(
      `Cannot read ${manifestPath}. Run the application build first: the service worker's ` +
        'precache list is generated from its output.',
    );
  }

  const manifest = JSON.parse(raw) as Record<string, ManifestChunk>;
  const assets = new Set<string>();
  for (const chunk of Object.values(manifest)) {
    // Entry chunks and their stylesheets are the shell. Nothing else is precached: lazily
    // fetched chunks, if any are ever added, should reach the network on demand.
    if (chunk.isEntry !== true) continue;
    assets.add(`/${chunk.file}`);
    for (const css of chunk.css ?? []) assets.add(`/${css}`);
  }
  if (assets.size === 0) throw new Error(`No entry chunks found in ${manifestPath}.`);

  for (const file of publicShellFiles) assets.add(file);
  return [...assets].sort();
}

const assets = shellAssets();
// Derived from the asset list, so a release whose bundle changed gets a new cache name and a
// release whose bundle did not is byte-identical. No clock, no build counter, no manual bump.
const version = createHash('sha256').update(assets.join('\n')).digest('hex').slice(0, 16);

export default defineConfig({
  publicDir: false,
  define: {
    __SHELL_ASSETS__: JSON.stringify(assets),
    __SHELL_VERSION__: JSON.stringify(version),
  },
  build: {
    outDir,
    // The application build's output must survive this one.
    emptyOutDir: false,
    manifest: false,
    target: 'es2020',
    rollupOptions: {
      input: resolve(import.meta.dirname, 'src/sw.ts'),
      output: {
        // Served from the origin root, so its scope covers the whole app.
        format: 'iife',
        entryFileNames: 'sw.js',
        inlineDynamicImports: true,
      },
    },
  },
});
