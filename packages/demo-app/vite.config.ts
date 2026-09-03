import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

/**
 * CityDesk imports Naviquest by package name so this build exercises the SDK's
 * published exports. The package script builds that workspace dependency first.
 */
export default defineConfig({
  root,
  publicDir: 'public',
  server: { port: 5310, fs: { allow: ['../..'] } },
  preview: { port: 5311 },
  worker: { format: 'es' },
  build: {
    // Vercel owns packages/demo-app as its Root Directory and publishes `out`.
    outDir: 'out',
    emptyOutDir: true,
    target: 'es2023',
    rollupOptions: {
      input: {
        main: page('index.html'),
        parking: page('parking.html'),
        libraries: page('libraries.html'),
        notices: page('notices.html'),
        workspace: page('workspace.html'),
      },
    },
  },
});
