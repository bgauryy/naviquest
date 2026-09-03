import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * The demo application. It imports the SDK by its PACKAGE NAME, not by a
 * relative path into a sibling folder — so the demo exercises exactly the entry
 * point a real install gets, and a broken export shows up here rather than
 * after publish.
 */
export default defineConfig({
  root: 'apps/demo',
  resolve: {
    /* Array form with anchored patterns, not the object form. An object alias
       is a PREFIX match, so a bare `naviquest` key would also rewrite
       `naviquest/worker` into `.../src/index.ts/worker`. Anchoring each entry
       keeps the subpath export resolvable and the package name unambiguous. */
    alias: [
      { find: /^naviquest$/, replacement: fileURLToPath(new URL('./packages/naviquest/src/index.ts', import.meta.url)) },
      { find: /^naviquest\/worker$/, replacement: fileURLToPath(new URL('./packages/naviquest/src/worker.ts', import.meta.url)) },
    ],
  },
  server: { port: 5310, fs: { allow: ['../..'] } },
  preview: { port: 5311 },
  worker: { format: 'es' },
  build: {
    outDir: '../../dist/demo',
    emptyOutDir: true,
    target: 'es2023',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./apps/demo/index.html', import.meta.url)),
        parking: fileURLToPath(new URL('./apps/demo/parking.html', import.meta.url)),
        libraries: fileURLToPath(new URL('./apps/demo/libraries.html', import.meta.url)),
        notices: fileURLToPath(new URL('./apps/demo/notices.html', import.meta.url)),
      },
    },
  },
});
