/**
 * One retrieval API, two places it can run.
 *
 * The inline lane is what the SDK has always done: build the index and answer
 * queries on the main thread, synchronously. The worker lane does the same work
 * off-thread and answers with promises.
 *
 * `worker: true` is OPT-IN and the inline lane remains the default. Public tool
 * wrappers always return promises (index.ts `invoke`); what differs here is the
 * thread the index is built on, not the host-facing return shape. Both lanes run
 * the same ranking code (ranking.ts, bm25.ts, dense.ts), so what differs is the
 * thread, not the answer.
 *
 * The boundary rule: only serializable retrieval facts cross it —
 * document strings at build, then ids, scores, and literal offsets at query.
 * No elements, vectors, addresses, or DOM.
 */
import { makeTokenizer, expandTokens } from './text.ts';
import { search as bm25Search, fuzzyRank } from './bm25.ts';
import { rankControls, informativeTerms, reachableTerms } from './ranking.ts';
import type { DenseState, Hit, RetrievalLane, Tokenize } from '../types.ts';
import type { LexicalTuning, RetrievalTuning, TextTuning } from '../config.ts';
import { searchExact } from './exact.ts';
import type { ExactMatch } from './exact.ts';
import { createLexicalStore } from './lexical-index.ts';

import type { Awaitable } from '../async.ts';
/** Re-exported so the lane contract still reads as one type from one place. */
export type { Awaitable };

export interface LaneBuildArgs {
  contentDocs: string[]; rawContentDocs: string[]; controlDocs: string[]; locale: string;
  textCfg: TextTuning; lexical: LexicalTuning;
}
export interface LaneBuildResult {
  indexMs: number; denseMs: number; locale: string; retrieval: RetrievalLane;
  /** Which morphology lane the content index was built with. */
  stemLanguage: string;
}
export interface ContentSearchResult {
  /**
   * `[term, idf]` for the query terms the index actually holds. An array rather
   * than a Map: Maps DO structured-clone across postMessage (the previous
   * comment here claimed otherwise), but tool payloads are JSON on the wire and
   * an entries array serializes without a conversion at every consumer.
   */
  weights?: Array<[string, number]>;
  hits: Hit[];
  /** Literal evidence is parallel to `hits`, never a rank override. */
  exact: ExactMatch[];
  retrieval: RetrievalLane;
  /** The query terms that carry information about WHICH passage is meant.
   *  Answer selection scores against these, never against every token: measured,
   *  a genuinely answering sentence scores 0.75 against every query term and
   *  1.00 against the informative ones, and the floor sits between. */
  informative: string[];
}
export interface ControlSearchResult { hits: Hit[]; coverage: number[]; retrieval: RetrievalLane }
export interface DenseResult { dense: DenseState; retrieval: RetrievalLane }
export interface LaneStatus { dense: DenseState; retrieval: RetrievalLane }

/**
 * The contract both lanes satisfy. Ranking is imported from one module so the
 * two cannot drift in values any more than they can in shape.
 */
export interface Lane {
  kind: 'inline' | 'worker';
  async: boolean;
  build(args: LaneBuildArgs): Awaitable<LaneBuildResult>;
  searchContent(query: string, k: number, cfg: RetrievalTuning): Awaitable<ContentSearchResult>;
  searchControls(query: string, k: number, cfg: RetrievalTuning): Awaitable<ControlSearchResult>;
  fuzzy(query: string, k: number, floor: number): Awaitable<{ hits: Hit[] }>;
  tokens: Tokenize;
  controlTokens: Tokenize;
  locale(): string | null;
  /** Which morphology lane is active: a language code, or 'none'. */
  stemLanguage(): string;
  dense(base?: string): Awaitable<DenseResult>;
  status(): LaneStatus;
  dispose(): void;
}

const DENSE_OFF: DenseState = { status: 'off', detail: 'no dense table requested' };

/** The main-thread lane. Every method returns a value, never a promise.
 *  The build step and index state live in lexical-index.ts, shared with the
 *  worker lane, so the two cannot drift in term statistics. */
export function createInlineLane(): Lane {
  const { s, build } = createLexicalStore();

  return {
    kind: 'inline',
    async: false,
    build(args) {
      const r = build(args);
      return { indexMs: r.indexMs, denseMs: 0, locale: r.locale,
               retrieval: 'lexical', stemLanguage: r.stemLanguage };
    },
    searchContent(query, k, cfg) {
      const terms = [...new Set(s.contentTokens(query))];
      return {
        hits: bm25Search(s.contentIdx!, terms, k, s.lexical),
        exact: searchExact(s.exactDocs, query, s.exactFold, k),
        retrieval: 'lexical',
        informative: informativeTerms(s.contentIdx!, terms, cfg.commonTermShare),
        // Serialisable, because the worker lane has to send the same thing.
        weights: [...reachableTerms(s.contentIdx!, terms)],
      };
    },
    searchControls(query, k, cfg) {
      const { hits, coverage } = rankControls({
        idx: s.controlIdx!, docs: s.controlDocs, tokenize: s.ctlTokens,
        query, limit: k, cfg,
        search: (i, terms, n) => bm25Search(i, terms, n, s.lexical),
      });
      return { hits, coverage, retrieval: 'lexical' };
    },
    fuzzy(query, k, floor) {
      return { hits: fuzzyRank(s.controlDocs, query, k, floor, s.tok!.fold) };
    },
    tokens: (t) => s.tok!.tokens(t),
    controlTokens: (t) => s.ctlTokens(t),
    locale: () => s.tok?.locale ?? null,
    stemLanguage: () => s.stemLanguage,
    // The dense lane needs a worker: embedding a corpus is exactly the long task
    // this whole file exists to move off the main thread, so offering it inline
    // would be offering the bug.
    dense() { return { dense: { status: 'unavailable', detail: 'dense requires worker: true' }, retrieval: 'lexical' }; },
    status() { return { dense: DENSE_OFF, retrieval: 'lexical' }; },
    dispose() {},
  };
}

/**
 * The worker lane. Every method returns a promise.
 *
 * @param spawn a zero-arg factory returning a Worker. Injected rather than
 *   constructed here so the bundler decides how the worker is delivered: the
 *   normal build emits a chunk, and the injectable IIFE the live-site harness
 *   pushes into third-party pages inlines it as a blob, because there is no
 *   second file to fetch on someone else's origin.
 */
export function createWorkerLane(spawn: () => Worker): Lane {
  const worker = spawn();
  // One AbortController owns every listener this lane attaches, so teardown is
  // `ac.abort()` rather than a remove-each-listener list that drifts out of sync
  // with the add-each-listener list above it.
  const ac = new AbortController();
  let seq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void }>();
  // A main-thread tokenizer as well as the worker's. It is used for work that
  // never touches an index — ranking a passage's own controls by query overlap —
  // and a round trip to ask the worker to split a string would cost more than
  // constructing a second Intl.Segmenter.
  let tok: ReturnType<typeof makeTokenizer> | null = null;
  let ctlTokens: Tokenize = () => [];
  let textCfg: Partial<TextTuning> = {};
  let denseState: DenseState = DENSE_OFF;
  let retrieval: RetrievalLane = 'lexical';
  let stemLang = 'none';

  worker.addEventListener('message', (e) => {
    const { id, ok, error, ...rest } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(rest); else p.reject(new Error(error));
  }, { signal: ac.signal });

  // A worker that dies must not leave every tool call hanging forever. An agent
  // waiting on a promise that never settles is worse than one told the truth.
  // `crashed` is permanent: rejecting only the calls pending at crash time and
  // then posting later calls into the dead worker re-created the forever-hang
  // for every call AFTER the first batch.
  let crashed: Error | null = null;
  worker.addEventListener('error', (e) => {
    crashed = new Error('retrieval worker failed', { cause: e.message ?? e });
    for (const [, p] of pending) p.reject(crashed);
    pending.clear();
  }, { signal: ac.signal });
  // A reply that cannot be deserialized leaves its `pending` entry unsettled —
  // the same hang through a different door. The event carries no id, so every
  // in-flight call is rejected; the worker itself is still alive.
  worker.addEventListener('messageerror', () => {
    const err = new Error('retrieval worker reply could not be deserialized');
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  }, { signal: ac.signal });

  const call = (type: string, payload: Record<string, unknown> = {}) => {
    if (crashed) return Promise.reject(crashed);
    // Promise.withResolvers, rather than capturing resolve/reject out of a
    // `new Promise` executor into an outer `let`. Same shape, no closure to get
    // wrong, and the postMessage cannot accidentally run before the handlers
    // are registered.
    const { promise, resolve, reject } = Promise.withResolvers<any>();
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, ...payload });
    return promise;
  };

  return {
    kind: 'worker',
    async: true,
    async build({ contentDocs, rawContentDocs, controlDocs: cd, locale, textCfg: tc, lexical }) {
      textCfg = tc ?? {};
      const tk = makeTokenizer(locale, textCfg ?? {});   // captured — see the inline lane
      tok = tk;
      ctlTokens = (t) => expandTokens(tk.tokens(t), textCfg);
      const r = await call('build', { contentDocs, rawContentDocs, controlDocs: cd, locale, textCfg, lexical });
      stemLang = r.stemLanguage ?? 'none';
      retrieval = r.retrieval;
      return r;
    },
    async searchContent(query, k, cfg) {
      const r = await call('searchContent', { query, k, cfg });
      retrieval = r.retrieval;
      return r;
    },
    async searchControls(query, k, cfg) {
      const r = await call('searchControls', { query, k, cfg });
      retrieval = r.retrieval;
      return r;
    },
    fuzzy(query, k, floor) { return call('fuzzy', { query, k, floor }); },
    tokens: (s) => tok!.tokens(s),
    controlTokens: (s) => ctlTokens(s),
    locale: () => tok?.locale ?? null,
    stemLanguage: () => stemLang,
    async dense(base?: string) {
      const r = await call('dense', { base });
      denseState = r.dense;
      retrieval = r.retrieval;
      return r;
    },
    status: () => ({ dense: denseState, retrieval }),
    dispose() {
      ac.abort(); worker.terminate();
      // Reject, never merely clear: a cleared pending entry is the forever-hang
      // the crashed/messageerror handlers exist to prevent, through a third door.
      const err = new Error('retrieval lane disposed');
      for (const [, p] of pending) p.reject(err);
      pending.clear();
      crashed = err;
    },
  };
}
