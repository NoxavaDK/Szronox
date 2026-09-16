import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // The service worker's precache list is generated from this manifest by
    // `vite.sw.config.ts`, so the worker always names the hashed files this build really
    // emitted. Nothing hand-copies a hash.
    manifest: true,
  },
});
