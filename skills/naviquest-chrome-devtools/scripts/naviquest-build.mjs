#!/usr/bin/env node

/**
 * Build the naviquest install script and stage it for the sandbox.
 *
 *   node scripts/naviquest-build.mjs [--repo <path>] [--out <file>]
 *
 * Why a separate step instead of bundling inside the CDP check: the sandbox
 * (`cdp-sandbox.mjs`) blocks child processes and scopes fs reads to the
 * `.naviquest` tree, and esbuild both spawns a binary and reads the whole SDK
 * source tree. So bundling happens here, unsandboxed, and the check reads one
 * staged file — the same staging pattern the sandbox already uses for
 * `dom-actionability.mjs`.
 *
 * The install script mirrors `eval/eval.ts`'s `buildNaviquestInstallScript`:
 * one IIFE exposing `WQ`, then a registration loop. It is installed as a
 * document init script, so it reruns for every document in the tab.
 *
 * `--bundle-only` writes the IIFE WITHOUT that registration loop, for a caller
 * that constructs the SDK itself with its own config (a sweep pinning the answer
 * lanes, say). It exists so such a caller does not stand up a second esbuild
 * invocation: the bundle options below are load-bearing (the `import.meta.url`
 * define in particular), and a second copy of them drifts silently.
 */

import esbuild from 'esbuild';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { outputBase } from './artifacts.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const getArg = (flag, def) => { const i = argv.indexOf(flag); return i !== -1 && argv[i + 1] ? argv[i + 1] : def; };
const BUNDLE_ONLY = argv.includes('--bundle-only');

const ok = (payload) => console.log(JSON.stringify(payload));
const err = (message, hint) => { console.log(JSON.stringify({ status: 'ERROR', message, hint })); process.exit(1); };

/** The SDK entry, found by walking up from the skill folder. A skill installed
 *  outside the monorepo has no SDK to bundle, so say that instead of guessing. */
function findSdkEntry(startDir) {
  let dir = resolve(startDir);
  for (let hop = 0; hop < 8; hop++) {
    const entry = join(dir, 'packages', 'naviquest', 'src', 'index.ts');
    if (existsSync(entry)) return entry;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const REPO = getArg('--repo', '');
const entry = REPO
  ? join(resolve(REPO), 'packages', 'naviquest', 'src', 'index.ts')
  : findSdkEntry(__dir);

if (!entry || !existsSync(entry)) {
  err(
    `naviquest SDK source not found${REPO ? ` under --repo ${REPO}` : ' above the skill folder'}`,
    'Run this from a checkout of the naviquest monorepo, or pass --repo <path-to-monorepo>.',
  );
}

const OUT = resolve(getArg('--out', join(outputBase(), BUNDLE_ONLY ? 'naviquest-bundle.js' : 'naviquest-install.js')));
mkdirSync(dirname(OUT), { recursive: true, mode: 0o700 });

let bundle;
try {
  const built = await esbuild.build({
    entryPoints: [entry],
    bundle: true, write: false, format: 'iife', globalName: 'WQ',
    platform: 'browser', target: 'es2023', legalComments: 'none',
    // The worker is loaded from `import.meta.url`, which an IIFE has no notion
    // of. The SDK degrades to the main thread and declares it, so a stub keeps
    // the bundle valid rather than throwing at construction.
    define: { 'import.meta.url': '"about:blank"' },
    // An init script can run in a scope where the IIFE's own global assignment
    // does not land on `globalThis`, and a caller that constructs the SDK itself
    // reaches it by name. Pin it.
    footer: BUNDLE_ONLY ? { js: 'try{globalThis.WQ=WQ;}catch(e){}' } : undefined,
  });
  bundle = built.outputFiles[0].text;
} catch (buildError) {
  err(`esbuild failed: ${buildError.message}`, 'Run `yarn install` in the monorepo — esbuild is a workspace devDependency.');
}

// A navigation replaces the realm and the native tool map, so registration
// retries: Chrome can expose `document.modelContext` after the first init-script
// turn (measured 2026-09-01, eval/eval.ts).
const INSTALL = BUNDLE_ONLY ? bundle : `${bundle}
;(()=>{window.naviquest=WQ.createNaviquest({});void(async()=>{for(let attempt=0;attempt<400;attempt++){const result=await window.naviquest.register();if(result.registered)return;await new Promise(resolve=>setTimeout(resolve,25));}})();})();`;

writeFileSync(OUT, INSTALL, { mode: 0o600 });
ok({
  status: BUNDLE_ONLY ? 'BUNDLE_READY' : 'INSTALL_SCRIPT_READY',
  path: OUT,
  bytes: INSTALL.length,
  sdkEntry: entry,
  registers: !BUNDLE_ONLY,
});
