/**
 * Build the published artifact.
 *
 *   yarn build:lib
 *
 * WHY THIS EXISTS AT ALL
 *
 * The package used to publish raw TypeScript — `exports: { ".": "./src/index.ts" }`,
 * no `types`, no build step. Inside this workspace that works, because Vite
 * resolves the source and transpiles it. Outside it does not: webpack, Next.js,
 * Create React App and Jest all exclude `node_modules` from transpilation by
 * default, so `yarn add @naviquest/core` followed by the import in the README's
 * install block fails for most of the ecosystem. It was the most-read six lines
 * in the repository and one of the only things in it that nothing measured.
 *
 * Every published condition points at `dist/`. The workspace's Vite alias owns
 * source hot reload; publishing a `development` condition exposed raw source
 * whose build-time dependencies are intentionally bundled rather than shipped.
 *
 * `dom-accessibility-api` IS BUNDLED, not externalised, and that is a deliberate
 * trade with three parts:
 *
 *   1. It lets us drop the dependency's Babel-compiled ES5 polyfills for `Set`
 *      and `Array.from` — 2,429 minified bytes in a package targeting es2024 and
 *      verified on Chrome 151. A host cannot do this for us; the alias has to
 *      happen at the point the dependency is bundled.
 *   2. It makes `yarn build` measure the bytes a host actually receives.
 *   3. It costs a duplicate copy for a host that already depends on
 *      dom-accessibility-api directly. At 12 kB that is the cheaper side of the
 *      trade, and it is stated here rather than discovered.
 *
 * MIT requires the copyright notice to travel with the code, so it is emitted as
 * a banner that minification is told to keep.
 */
import esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { minify } from 'terser';

const HERE = import.meta.dirname;
const OUT = path.join(HERE, 'dist');

// The 30 kB contract covers the complete eager static-import closure. Lazy and
// worker chunks are separate costs, printed below rather than hidden.
// Landing exactly at 29,995 bytes made any five-byte change a release failure;
// the parser-only root re-export was removed after the 2026-09-01 size loop,
// so the build enforces reclaimed headroom instead of merely reporting it.
//
// 29,000 -> 29,500 on 2026-09-02. The phrasing fold in project.ts (a <p> of only
// phrasing tags is ONE passage) costs ~335 gzip bytes and the 29,000 gate had 37
// left. It was paid for deliberately: without it `find_on_page` returned MDN's
// "creating objects ( is required)" — inline <code>/<a> punched out of the
// sentence — which is the defect the whole retrieval surface exists to avoid.
// Compaction was attempted first and gzip absorbed all of it (<10 bytes across a
// compact tag list, re-privatised exports, and two allocation fixes), so the
// cost is the fold itself, not its spelling.
//
// 29,500 -> 29,850 on 2026-09-02 (second raise, same day). Paid for the review
// fixes: resolveConfig deep-clone (an instance's detected charsPerToken was
// mutating the exported DEFAULTS through a shared nested object), the central
// tool-input size gate (agent strings reached querySelector and delta-history
// keys unbounded), exclusion honored by the phrasing fold and by <slot>, opaque
// non-text metadata through the host redactor, and the treeTokens page-cost
// derivation. Compaction reclaimed ~250 bytes first (the dead KNOWN_AFFORDANCES
// constant, the duplicated lang-observer and overlay-root spreads, a dead alias).
//
// 29,850 -> 30,100 on 2026-09-02 (third raise, same day). This one CROSSES the
// 30 kB product line by ~100 bytes, stated plainly rather than hidden. It pays
// for the second review+MDN batch: the dead-coverage-field removal (closedRoots
// / componentsInspectedPct / unreachableRoots / elements / openRoots /
// slottedVisited / registeredRoots / ariaDescriptions — all write-only or
// derived constants reported to agents as measurements), the frame-boundary
// selector guard, the changeSummary/summary field-collision fix, the
// aria-labelledby-only name exclusion, the position:fixed getClientRects
// fallback, the Intl.Segmenter/locks-signal/summarizer-activation MDN fixes, and
// the outline-join dedupe. Two facts justify the cross: the moved-lazy input
// gate and five removed counters already reclaimed everything gzip would give
// back (further micro-cutting returns <10 bytes/edit), and a concurrent feature
// (revealPending) landed eager weight in the same window. The reclaim of record
// is the tools.ts god-file split (2.3k lines, lazy) — when that lands, this
// comes back under 30 kB. Until then 30 kB is still the number to defend, and
// crossing it was a measured product decision, not a place to land a feature.
//
// 30,100 -> 30,200 on 2026-09-02 (fourth raise, same day). Pays ~83 gzip bytes
// for the second structural ranking signal: `imageAltPenalty` demotes a passage
// by the fraction of it that is recovered non-text (image alt / chart text — a
// description of a picture, not a page claim), a sibling of the shipped
// `chromePenalty`. Both are declared index-time signals gated by `--only rank`
// (measured: image alt flips from the top result to below the answer). The
// same-batch dead-code removal (hiddenSkipped, two write-only counters,
// findModal, the 4-way shrinker + fold dedup) reclaimed what it could, but the
// two new config tunables + the per-chunk nonText fraction net positive.
// Comments are Terser-stripped, so this is genuine feature code; the tools.ts
// split is still the recorded path back under 30 kB.
//
// 30,200 -> 29,200 on 2026-09-02 (first LOWERING, and the reclaim the four
// raises above kept promising). Not the recorded tools.ts split — a cheaper one
// found by asking which eager bytes no caller needs at construction time.
// `tool-specs.ts` (the six titles, descriptions and JSON Schemas: 4,888
// minified bytes) was eager only because `index.ts` imported it statically, and
// only ONE consumer needed it that early: `toolDefs`, a sync array property with
// zero consumers in the demo, eval/, or any doc. Routing needs the six NAMES,
// not the schemas, so the names moved to `tool-names.ts` (~120 bytes eager) and
// the schemas moved behind the same dynamic import as the answer engine —
// `register()` was already async, and `toolDefs` became `toolDefs()`. Measured:
// 30,182 -> 28,820 eager gzip, 1,362 bytes back, so the 30 kB product line holds
// again. The lazy side pays ~2.05 kB at registration, printed below.
//
// 29,200 leaves ~380 bytes of headroom deliberately. The 29,995 gate taught
// this file that a zero-slack limit turns every five-byte edit into a release
// failure; a limit set AT the current size would do it again. The tools.ts god-
// file split (2.3k lines) remains unspent, so there is a second reclaim in hand
// if a feature needs one.
//
// 29,200 -> 29,400 on 2026-09-03. NOT a reclaim being spent: the 28,820 figure
// above had drifted to 29,080 through un-measured edits, so the "~380 bytes of
// headroom" was really 120 by the time this raise was needed. Two changes bought
// the 237 bytes:
//  - three previously SWALLOWED index failures are now counted and declared in
//    `coverage` (unparseable JSON-LD, a throwing accessible-name computation,
//    and an `exclude[]` selector that is not valid CSS — the last means content
//    the host meant to withhold is indexed, which cannot stay silent);
//  - the response-shrink policy (keep-ratio, per-field floors, diff steps,
//    outcome cap) moved out of tools.ts literals into `tuning.response`.
// Every compressible byte was taken first: the nineteen hand-written
// `resolveConfig` guards became one table (-0.4 kB), and two name-hygiene caps
// stayed literals in project.ts rather than becoming knobs no host would turn.
// Note the structural tension this exposed — DEFAULTS is eager, so EVERY new
// tunable costs eager gzip; "move judgement into config.ts" and "keep the eager
// bundle small" pull against each other.
//
// 29,400 -> 27,900 on 2026-09-03, a RECLAIM, and the note above about spending
// the tools.ts split was wrong. tools.ts is already lazy; splitting it would
// have reclaimed nothing. A metafile partition of the eager closure found the
// real weight: `index.ts` imported `then()` from `lane.ts`, and that one
// four-line helper dragged the whole retrieval subtree — lane, bm25,
// lexical-index, ranking, exact — into the closure every page pays for, to
// serve code no page reaches without an agent.
//
// `then()` moved to the `async.ts` leaf, `lane.async`/`lane.kind` became config
// facts (`!!config.worker`), and the lane now loads beside the answer engine.
// Measured: eager source 70,162 -> 64,213 minified bytes, 26 -> 22 eager
// modules, 1,556 gzip bytes reclaimed. The projection still runs synchronously
// at construction — that half genuinely must, and index.ts says why — so only
// the index BUILD crosses the new boundary.
//
// 27,900 -> 28,000 on 2026-09-03, spending 96 of the reclaimed bytes on the
// failure paths that reclaim created. Deferring the lane added three states no
// previous sensor could reach, and `yarn test` (jsdom, induced failure) found
// all three: a rejected `lanePromise` cached by `??=` disabled retrieval for the
// life of the page when a retry would have worked; the same pattern on
// `loadedTools` made one failed chunk fetch permanently kill all six tools; and
// `lane()` reported "still loading" forever for a load that had already failed.
// The bytes are `laneError`, two `catch` clauses that un-cache, and `indexReady`
// replacing a one-shot handle on the first build. Correctness in the degraded
// path is worth 96 bytes; the alternative was a 45-byte headroom this file
// already argues against. 2 kB still separates this from the 30 kB product line.
//
// 28,000 -> 28,500 on 2026-09-03, spending 142 bytes on `discovery.frames`:
// opt-in same-origin child-frame CONTENT indexing (index.ts `mergeFrames`,
// frame-qualified Address). Dogfooding on an app shell that framed its own
// content (a project gallery in a same-origin iframe) showed find_on_page
// returning only the parent chrome while the real content sat one frame down,
// declared-but-unindexed in coverage. The feature is OFF by default (the open-web
// payoff is small; the value is app shells that frame their own editor/gallery/
// docs), so most pages pay only the ~142 bytes of a disabled branch. 1.5 kB still
// separates this from the 30 kB product line.
const EAGER_GZIP_LIMIT = 28_500;
let eagerGzip = 0;
let eagerMetafile: esbuild.Metafile | undefined;

/** MIT attribution for the one bundled dependency. `legalComments: 'none'`
 *  strips comments from the dependency's own source, so the notice is
 *  re-attached here rather than left to survive minification by luck. */
const BANNER = `/*! @naviquest/core — MIT
 * Bundles dom-accessibility-api (MIT) © 2020 Sebastian Silbermann
 * https://github.com/eps1lon/dom-accessibility-api
 */`;

/** `SetLike` implements add/clear/delete/has/size — that is `Set`. `ArrayFrom`
 *  is `Array.from`. Both exist natively everywhere this SDK runs. */
const dropPolyfills: esbuild.Plugin = {
  name: 'drop-es5-polyfills',
  setup(build) {
    build.onResolve({ filter: /polyfills\/(SetLike|array\.from)\.mjs$/ }, (a) => ({
      path: a.path, namespace: 'native-shim',
    }));
    build.onLoad({ filter: /.*/, namespace: 'native-shim' }, (a) => ({
      contents: /SetLike/.test(a.path) ? 'export default Set;' : 'export default Array.from;',
      loader: 'js',
    }));
  },
};

fs.rmSync(OUT, { recursive: true, force: true });

for (const [entry, file] of [['src/index.ts', 'index.js'], ['src/worker.ts', 'worker.js']] as const) {
  const result = await esbuild.build({
    entryPoints: [path.join(HERE, entry)],
    ...(entry === 'src/index.ts'
      ? { outdir: OUT, entryNames: 'index', chunkNames: 'chunks/[name]-[hash]', splitting: true }
      : { outfile: path.join(OUT, file) }),
    bundle: true, minify: true, format: 'esm', target: 'es2024',
    legalComments: 'none', banner: { js: BANNER }, sourcemap: true,
    plugins: [dropPolyfills], metafile: entry === 'src/index.ts',
  });
  if (result.metafile) {
    eagerMetafile = result.metafile;
  }
}

// Source points at worker.ts so Vite/webpack discover and compile the worker as
// its own graph during development. The published graph contains worker.js;
// leaving the source suffix in dist makes a direct package import request a file
// that does not exist. The equal-length replacement preserves source-map
// columns, and the exact-one assertion turns future bundler output drift into a
// build failure instead of another published 404.
const builtIndex = path.join(OUT, 'index.js');
const builtIndexSource = fs.readFileSync(builtIndex, 'utf8');
const workerSourceRef = './worker.ts';
const workerDistRef = './worker.js';
const workerRefCount = builtIndexSource.split(workerSourceRef).length - 1;
if (workerRefCount !== 1) throw new Error(`expected one ${workerSourceRef} reference, found ${workerRefCount}`);
fs.writeFileSync(builtIndex, builtIndexSource.replace(workerSourceRef, workerDistRef));

// esbuild optimizes quickly; Terser's repeated compression pass is the final
// size pass. Preserve maps: a smaller artifact with source locations pointing
// at the pre-Terser code is not a valid release build.
const jsFiles = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const target = path.join(dir, entry.name);
  return entry.isDirectory() ? jsFiles(target) : entry.name.endsWith('.js') ? [target] : [];
});
for (const file of jsFiles(OUT)) {
  const mapFile = `${file}.map`;
  const result = await minify(fs.readFileSync(file, 'utf8'), {
    module: true, compress: { passes: 3 }, mangle: true,
    sourceMap: fs.existsSync(mapFile) ? {
      content: fs.readFileSync(mapFile, 'utf8'), filename: path.basename(file), url: path.basename(mapFile),
    } : undefined,
  });
  if (!result.code) throw new Error(`Terser emitted no code for ${file}`);
  fs.writeFileSync(file, result.code);
  if (result.map) fs.writeFileSync(mapFile, result.map);
}

// Types come from tsc, because a hand-written .d.ts is a second declaration of
// the surface that can disagree with the first.
execFileSync('npx', ['tsc', '-p', path.join(HERE, 'tsconfig.build.json')], { stdio: 'inherit' });

// tsc emitDeclarationOnly does not copy ambient input `.d.ts` files, and it
// leaves `.ts` specifiers in the emitted declarations. Both would 404 for a
// consumer resolving `types` from dist/. The JS graph already rewrites the
// worker specifier below; this is the same contract for types.
fs.copyFileSync(path.join(HERE, 'src/webmcp.d.ts'), path.join(OUT, 'webmcp.d.ts'));
for (const file of fs.readdirSync(OUT).filter((name) => name.endsWith('.d.ts'))) {
  const target = path.join(OUT, file);
  const source = fs.readFileSync(target, 'utf8');
  const rewritten = source.replace(/from (['"])(\.[^'"]+)\.ts\1/g, (match, quote, spec) => (
    spec.endsWith('.d') ? match : `from ${quote}${spec}.js${quote}`
  ));
  if (rewritten !== source) fs.writeFileSync(target, rewritten);
}
const missingDeclarations = fs.readdirSync(OUT).filter((name) => name.endsWith('.d.ts')).flatMap((file) => {
  const source = fs.readFileSync(path.join(OUT, file), 'utf8');
  return [...source.matchAll(/from ['"](\.[^'"]+)['"]/g)].flatMap((match) => {
    const resolved = path.resolve(OUT, match[1]);
    const exists = [resolved, resolved.replace(/\.js$/, '.d.ts')].some((candidate) => fs.existsSync(candidate));
    return exists ? [] : [`${file} -> ${match[1]}`];
  });
});
if (missingDeclarations.length) {
  throw new Error(`declaration import(s) do not exist: ${missingDeclarations.join(', ')}`);
}

/**
 * An export is a promise to every package resolver, even when the README never
 * mentions it. A leftover `./internals` export once survived a deleted entry
 * file, so builds passed while `import('@naviquest/core/internals')` failed only
 * for a consumer. Validate every local leaf after JS and declarations exist: source,
 * types, development, and default conditions all have to resolve in the exact
 * package tree that would be published.
 */
const packageJsonPath = path.join(HERE, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
  exports?: Record<string, unknown>;
};
const exportTargets = (value: unknown): string[] => {
  if (typeof value === 'string') return value.startsWith('./') ? [value] : [];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(exportTargets);
};
const missingExports = exportTargets(packageJson.exports)
  .filter((target) => !fs.existsSync(path.resolve(HERE, target)));
if (missingExports.length) {
  throw new Error(`package export target(s) do not exist: ${missingExports.join(', ')}`);
}

// Resolve the archive as a real consumer, outside the workspace aliases and
// dependency hoisting that made the raw-source development export look valid.
const consumerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'naviquest-consumer-'));
try {
  const archive = path.join(consumerRoot, 'naviquest.tgz');
  execFileSync('yarn', ['pack', '--out', archive], { cwd: HERE, stdio: 'pipe' });
  const consumer = path.join(consumerRoot, 'consumer');
  const installed = path.join(consumer, 'node_modules', '@naviquest', 'core');
  fs.mkdirSync(installed, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', installed]);
  fs.writeFileSync(path.join(consumer, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(consumer, 'smoke.mjs'),
    "import { createNaviquest } from '@naviquest/core';\n"
    + "if (typeof createNaviquest !== 'function') throw new Error('missing createNaviquest export');\n");
  execFileSync(process.execPath, ['--conditions=development', 'smoke.mjs'],
    { cwd: consumer, stdio: 'pipe' });
  console.log('packed import development condition: PASS');
} finally {
  fs.rmSync(consumerRoot, { recursive: true, force: true });
}

for (const [entry, file] of [['index.js', 'index.js'], ['worker.js', 'worker.js']] as const) {
  const bytes = fs.readFileSync(path.join(OUT, file));
  const gzip = gzipSync(bytes, { level: 9 }).length;
  console.log(`${entry.padEnd(12)} ${(bytes.length / 1024).toFixed(1)} kB  ${(gzip / 1000).toFixed(2)} kB gzip`);
}

// Count every static import fetched with index.js. Dynamic-import chunks are
// first-use cost, not eager cost, and are printed separately rather than erased.
const staticFiles = new Set<string>();
const visitStatic = (file: string) => {
  if (staticFiles.has(file)) return;
  staticFiles.add(file);
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/\b(?:from|import)["'](\.[^"']+)["']/g)) {
    visitStatic(path.resolve(path.dirname(file), match[1]));
  }
};
visitStatic(path.join(OUT, 'index.js'));
eagerGzip = [...staticFiles].reduce((sum, file) => sum + gzipSync(fs.readFileSync(file), { level: 9 }).length, 0);
const eagerInputs = new Map<string, number>();
if (eagerMetafile) for (const [outputName, output] of Object.entries(eagerMetafile.outputs)) {
  if (!staticFiles.has(path.resolve(outputName))) continue;
  for (const [name, input] of Object.entries(output.inputs)) eagerInputs.set(name, (eagerInputs.get(name) ?? 0) + input.bytesInOutput);
}
const largestInputs = [...eagerInputs].sort((a, b) => b[1] - a[1]).slice(0, 6);
console.log(`eager static  ${[...staticFiles].map((f) => path.relative(OUT, f)).join(' + ')} = ${(eagerGzip / 1000).toFixed(2)} kB gzip`);
for (const file of jsFiles(path.join(OUT, 'chunks')).filter((f) => !staticFiles.has(f))) {
  console.log(`lazy chunk    ${path.relative(OUT, file)} ${(gzipSync(fs.readFileSync(file), { level: 9 }).length / 1000).toFixed(2)} kB gzip`);
}
console.log(`largest eager inputs: ${largestInputs.map(([name, bytes]) => `${path.relative(HERE, name)} ${(bytes / 1000).toFixed(1)}k`).join(', ')}`);
console.log(`eager target ${EAGER_GZIP_LIMIT / 1000} kB: ${eagerGzip <= EAGER_GZIP_LIMIT ? 'PASS' : `RED (${((eagerGzip - EAGER_GZIP_LIMIT) / 1000).toFixed(2)} kB over)`}`);
console.log(`eager headroom ${EAGER_GZIP_LIMIT - eagerGzip} gzip bytes`);
if (eagerGzip > EAGER_GZIP_LIMIT) {
  throw new Error(`eager bundle regression: ${eagerGzip} > ${EAGER_GZIP_LIMIT} gzip bytes`);
}
// Recursive since `src/` grouped into subsystem folders — a shallow read counted
// the six root declarations and silently under-reported the other forty.
const countDeclarations = (dir: string): number => fs.readdirSync(dir, { withFileTypes: true })
  .reduce((n, e) => n + (e.isDirectory() ? countDeclarations(path.join(dir, e.name))
    : Number(e.name.endsWith('.d.ts'))), 0);
console.log(`types        ${countDeclarations(OUT)} declaration file(s)`);
