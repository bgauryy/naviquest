/**
 * The retrieval worker.
 *
 * WHY THIS EXISTS, measured (the dated worker result in docs/EVAL.md, Chrome
 * 151, 3,000 real page
 * chunks):
 *
 *   chunks  where         index ms   longest main-thread task   max frame gap
 *    1,500  main thread       61.1                     61 ms          62.1 ms
 *    1,500  worker            74.6                      0 ms           9.4 ms
 *    3,000  main thread      118.2                    118 ms         118.6 ms
 *    3,000  worker           123.7                      0 ms           9.3 ms
 *
 * Indexing breaks the 50 ms guardrail from 1,500 chunks upward and drops exactly
 * as many frames as it takes milliseconds. In the worker the main thread never
 * sees a long task and holds 60 fps, for about 4% more wall-clock.
 *
 * WHAT DOES NOT LIVE HERE, and cannot:
 *   • the projection — it needs the DOM (that is RFC § 5, and it is why the
 *     dominant cost on a Stack Overflow question, 57.6 ms, is untouched by this
 *     file; the remaining lever is sliced projection — see docs/EVAL.md § 7)
 *   • axe-core — it does not merely fail to find a DOM in a worker, it fails to
 *     LOAD: `TypeError: Cannot read properties of undefined (reading 'document')`
 *   • element references — only strings at build and ids/scores/literal offsets
 *     at query cross this boundary, ever.
 */
import type { DenseCorpus, DenseState, DenseTable, Hit, RetrievalLane } from './types.ts';
import type { RetrievalTuning } from './config.ts';
import type { ContentSearchResult, ControlSearchResult, DenseResult, LaneBuildArgs, LaneBuildResult } from './retrieval/lane.ts';

type BuildMsg = LaneBuildArgs & { id: number };
type QueryMsg = { id: number; query: string; k: number; cfg: RetrievalTuning };
type ControlQueryMsg = QueryMsg & { cfg: RetrievalTuning };
type DenseMsg = { id: number; base: string };

/** Termination ceiling for the dense-table fetch. A constant, not a message
 *  field: the optional `timeoutMs` this replaced was never set by any sender, so
 *  it read as a knob while only ever being this number. */
const DENSE_FETCH_TIMEOUT_MS = 180_000;

/**
 * The worker's own global, typed WITHOUT pulling in the `WebWorker` lib.
 * Including both `DOM` and `WebWorker` in one program makes every shared
 * declaration (`self`, `fetch`, `MessageEvent`) ambiguous, and every module this
 * file imports is shared with the main thread.
 */
interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage: ((e: MessageEvent) => void) | null;
}
const ctx = globalThis as unknown as WorkerScope;
import { search as bm25Search, fuzzyRank, rrf } from './retrieval/bm25.ts';
import { coverageOf, informativeTerms, rankControls, reachableTerms } from './retrieval/ranking.ts';
import { embed, buildCorpus, topK, decodeTable } from './retrieval/dense.ts';
import { searchExact } from './retrieval/exact.ts';
import { createLexicalStore } from './retrieval/lexical-index.ts';

// The build step and the index state it owns are shared with the inline lane —
// see lexical-index.ts for why a second copy is not allowed to exist.
const { s, build: buildLexical } = createLexicalStore();

// The dense lane. `table` is the model; `contentVecs`/`controlVecs` are the
// corpora. All four are null until a table is successfully loaded, and every
// response reports which lane answered so an agent can tell "no match" from
// "the model has not arrived".
let table: DenseTable | null = null;
let contentVecs: DenseCorpus | null = null;
let controlVecs: DenseCorpus | null = null;
let denseState: DenseState = { status: 'off', detail: null };

const lane = (): RetrievalLane => (table && (contentVecs || controlVecs) ? 'hybrid' : 'lexical');

function build(msg: BuildMsg): LaneBuildResult {
  const r = buildLexical(msg);

  // Re-embedding the corpus is part of a rebuild, not a separate event: an index
  // whose dense half describes the PREVIOUS DOM is the internally-inconsistent
  // response this SDK already fixed once for the lexical half.
  let denseMs = 0;
  if (table) {
    const t1 = performance.now();
    if (r.contentChanged) contentVecs = buildCorpus(s.contentDocs, table);
    if (r.controlsChanged) controlVecs = buildCorpus(s.controlDocs, table);
    denseMs = performance.now() - t1;
  }
  return { indexMs: r.indexMs, denseMs: +denseMs.toFixed(1),
           locale: r.locale, retrieval: lane(), stemLanguage: r.stemLanguage };
}

/**
 * Fusion, exactly as measured (RFC § 5, VALIDATION § 8.2/8.6): Reciprocal Rank
 * Fusion at k = 60, and dense NEVER on its own. Alone it ranks below BM25 at
 * rank 1; fused it is worth +5 pp hit@1 and +9 pp hit@3.
 */
function fuse(lexHits: Hit[], denseHits: Hit[] | null, k: number): Hit[] {
  if (!denseHits) return lexHits;
  return rrf([lexHits, denseHits], s.lexical.rrfK, k);
}

function searchContent(msg: QueryMsg): ContentSearchResult {
  const terms = [...new Set(s.contentTokens(msg.query))];
  const weights: Array<[string, number]> = [...reachableTerms(s.contentIdx!, terms)];
  const lex = bm25Search(s.contentIdx!, terms, msg.k, s.lexical);
  const den = table && contentVecs ? topK(embed(msg.query, table), contentVecs, msg.k) : null;
  return {
    hits: fuse(lex, den, msg.k),
    exact: searchExact(s.exactDocs, msg.query, s.exactFold, msg.k),
    retrieval: lane(),
    informative: informativeTerms(s.contentIdx!, terms, msg.cfg.commonTermShare),
    weights,
  };
}

function searchControls(msg: ControlQueryMsg): ControlSearchResult {
  // Ranking, coverage and confidence all come from ranking.js so the worker and
  // the inline lane cannot disagree about them.
  const { hits, coverage, informative } = rankControls({
    idx: s.controlIdx!, docs: s.controlDocs, tokenize: s.ctlTokens,
    query: msg.query, limit: msg.k, cfg: msg.cfg,
    search: (i, terms, n) => bm25Search(i, terms, n, s.lexical),
  });
  if (!(table && controlVecs)) return { hits, coverage, retrieval: 'lexical' };
  const den = topK(embed(msg.query, table!), controlVecs!, msg.k);
  const fused = fuse(hits, den, msg.k);
  // Coverage is a property of the CONTROL, not of its rank, so it is recomputed
  // for whatever the FUSION returned — but from the informative terms the
  // lexical pass already derived, using the same `coverageOf` the inline lane
  // calls. The first version of this ran rankControls a second time purely to
  // recover `informative`, and reimplemented the intersection inline, which is
  // two copies of the arithmetic ranking.js exists to keep single.
  return {
    hits: fused,
    coverage: fused.map(([i]) => coverageOf(s.ctlTokens(s.controlDocs[i] ?? ''), informative)),
    retrieval: 'hybrid',
  };
}

/** The weights cache, or null wherever the Cache API is unavailable. */
async function openCache(): Promise<Cache | null> {
  try {
    if (typeof caches === 'undefined') return null;
    return await caches.open('naviquest-model-v1');
  } catch { return null; }
}

/**
 * Fetch and install the embedding table.
 *
 * The WORKER fetches, not the main thread: 6.6 MB of weights never touch the
 * main heap and the download cannot contend with paint. Failure is not an error
 * condition — it leaves the lane lexical, which every response already declares.
 */
async function loadDense(msg: DenseMsg): Promise<DenseResult> {
  try {
    denseState = { status: 'loading', detail: msg.base };
    // A ~4 MB fetch with no deadline can leave the lane reporting "loading"
    // forever on a stalled connection, and the honesty contract depends on the
    // status being true. `slow 3G` measured 138 s for this table, so the ceiling
    // is generous rather than tight — it exists to guarantee termination, not to
    // enforce a latency budget.
    const signal = AbortSignal.timeout(DENSE_FETCH_TIMEOUT_MS);

    /**
     * The Cache API turns a measured 6.2 s first-query cost into a once-ever
     * cost.
     *
     * The dated dense-lane result in docs/EVAL.md measures 6.2 s on fast 4G, 13.9 s on
     * regular 4G and 34.6 s on slow 4G — and the SDK paid that on EVERY page
     * load, because HTTP caching of a 4 MB opaque binary is at the mercy of the
     * host's headers and we control neither. A named cache is ours.
     *
     * Versioned by URL, so a host that ships new weights at a new path gets them
     * rather than a stale hit. Every step is optional: no `caches` (insecure
     * context, some worker environments), a full quota, or a storage error all
     * fall through to the plain fetch, which is the behaviour we had.
     */
    const store = await openCache();
    const cached = async (url: string): Promise<Response | undefined> =>
      store ? await store.match(url).catch(() => undefined) : undefined;
    const download = async (url: string): Promise<Response> => {
      const res = await fetch(url, { signal });
      // Only cache a real success; caching a 404 would pin the failure.
      if (store && res.ok) await store.put(url, res.clone()).catch(() => {});
      return res;
    };

    /**
     * ONE download per origin, not one per tab.
     *
     * The cache above turns the second PAGE LOAD free and does nothing for the
     * second TAB: two tabs opening cold both reach `match()` before either
     * `put()` has resolved, so both miss and both pull the full 3.90 MB table.
     * VALIDATION § 8.7 prices that duplicate at 6.19 s on fast 4G, 13.90 s on
     * regular 4G and 34.59 s on slow 4G — spent twice, on the single most
     * expensive resource this SDK fetches.
     *
     * The lock is keyed per URL, and the first thing INSIDE it is a second
     * `match()`. That re-check is the entire mechanism: it is what lets the
     * waiting tab find the winner's entry and return having sent no bytes.
     * Without it the lock would merely serialise two downloads, which is
     * strictly worse than the herd it replaced — the second tab would wait out
     * the first 13.90 s and then spend its own.
     *
     * Degrades exactly as `openCache()` does, and for the same reason: this is a
     * RANKING improvement and never a correctness one. No `navigator.locks`
     * (older engine, some worker environments) or a lock request that never gets
     * us into the callback falls through to the unlocked fetch, which is the
     * behaviour we had. With no cache there is nothing for the re-check to find,
     * so the lock is skipped rather than taken for nothing. Web Locks has been
     * Baseline Widely Available since March 2022 and is exposed to workers,
     * which is why this can run from here at all.
     */
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    const fetchCached = async (p: string): Promise<Response> => {
      const url = new URL(p, msg.base).href;
      const hit = await cached(url);
      if (hit) return hit;
      if (!store || !locks) return download(url);
      // Set inside the callback, so the `catch` can tell "the lock never let us
      // run" (retry unlocked) from "our own fetch threw" (report it). Retrying
      // the latter would download the table twice on the one path this exists to
      // stop, and `loadDense`'s catch already turns it into `unavailable`.
      let entered = false;
      try {
        // Annotated because `LockManager.request` is typed `Promise<any>`, and
        // an implicit `any` here would let a wrong return type through silently.
        // The same `signal` that bounds every fetch bounds the WAIT: a winner
        // suspended holding the lock would otherwise park this tab on a promise
        // that never settles, reporting "loading" forever — the exact outcome
        // the timeout exists to prevent. Abort-while-waiting rejects with
        // `entered` still false, which the catch already routes to the
        // unlocked download.
        const res: Response = await locks.request('naviquest-dense:' + url, { signal }, async () => {
          entered = true;
          return (await cached(url)) ?? (await download(url));
        });
        return res;
      } catch (e) {
        if (entered) throw e;
        return download(url);
      }
    };

    const j = async (p: string) => (await fetchCached(p)).json();
    const meta = await j('meta.json');
    const vocabList = await j('vocab.json');
    const res = await fetchCached('table.bin');
    if (!res.ok) throw new Error(`table.bin HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const t0 = performance.now();
    table = decodeTable(meta, vocabList, buf);
    if (s.contentDocs.length) contentVecs = buildCorpus(s.contentDocs, table);
    if (s.controlDocs.length) controlVecs = buildCorpus(s.controlDocs, table);
    const ms = +(performance.now() - t0).toFixed(1);
    denseState = { status: 'ready', detail: `${meta.model} ${meta.n}x${meta.dims} int8`,
                   bytes: buf.byteLength, embedMs: ms };
  } catch (e) {
    // Stated, never silent. A lane that failed to arrive and a lane that was
    // never asked for are different situations for an agent.
    table = null; contentVecs = null; controlVecs = null;
    denseState = { status: 'unavailable', detail: String((e as Error)?.message || e) };
  }
  return { dense: denseState, retrieval: lane() };
}

ctx.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  const reply = (payload: object) => ctx.postMessage({ id: msg.id, ok: true, ...payload });
  try {
    switch (msg.type) {
      case 'build': return reply(build(msg));
      case 'searchContent': return reply(searchContent(msg));
      case 'searchControls': return reply(searchControls(msg));
      case 'fuzzy': return reply({ hits: fuzzyRank(s.controlDocs, msg.query, msg.k, msg.floor) });
      case 'dense': return reply(await loadDense(msg));
      case 'status': return reply({ dense: denseState, retrieval: lane() });
      default: return ctx.postMessage({ id: msg.id, ok: false, error: `unknown message ${msg.type}` });
    }
  } catch (err) {
    ctx.postMessage({ id: msg.id, ok: false, error: String((err as Error)?.message || err) });
  }
};
