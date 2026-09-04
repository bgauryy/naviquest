/**
 * The ranking decisions that BOTH lanes must make identically.
 *
 * There are now two places retrieval can run — inline on the main thread, and in
 * a module worker — and they must not drift. `controlDoc` already lives in
 * affordance.js for exactly this reason: the moment the harness and the product
 * build different documents, the gate measures a ranker that does not ship. The
 * same argument applies with more force here, because a worker is a copy of the
 * logic running somewhere you cannot step through.
 *
 * Everything in this module is PURE: no DOM, no index construction, no state.
 * It is imported by lane.js (main thread) and by worker.js (worker thread).
 */
import type { BM25Index, Confidence, Hit, Tokenize } from '../types.ts';
import type { RetrievalTuning } from '../config.ts';

/**
 * Which of the agent's query terms actually carry information about WHICH
 * control is meant.
 *
 * Measured against every query term, the confidence signal collapsed: 10 of 12
 * correct lookups came back "low", because "the", "my", "this" and "to" are most
 * of what a natural instruction is made of and no control name contains them.
 *
 * A term absent from the index entirely COUNTS AGAINST coverage rather than
 * being dropped — it is the strongest available evidence that the page has no
 * such control. Dropping it produced the worst outcome in the suite: "upvote
 * this question" on Stack Overflow scored 1.0 because "upvote" was absent and
 * "question" matched, and returned `link "Improve this question"` marked high.
 */
export function informativeTerms(idx: BM25Index, qTerms: string[], commonTermShare: number): string[] {
  const n = idx.n || 1;
  const ceiling = Math.max(1, n * commonTermShare);
  return qTerms.filter((t) => {
    const posting = idx.postings.get(t);
    if (!posting) return true;
    return posting.length <= ceiling;
  });
}

/**
 * Query terms weighted by how much each one narrows the corpus — the SAME idf
 * bm25.ts scores with.
 *
 * `informativeTerms` is a CONTROL-index policy and its rules are correct there:
 * a term absent from the index counts AGAINST coverage, because on a page with
 * twenty controls absence is real evidence that no such control exists (the
 * "upvote this question" case above). Reusing it to score an ANSWER inverted
 * both directions at once, measured on the demo page:
 *
 *   "of"                                        → coverage 1.00, quoted as the answer
 *   "to" / "in" / "is"                          → coverage 1.00
 *   "single occupant discount"                  → coverage 0.75, correct
 *   "how much is the single occupant discount"  → NO ANSWER AT ALL
 *
 * Two separate faults, one root. A near-stopword under the 50% ceiling scored a
 * perfect match; and "much" — a word this page never uses — was counted as
 * informative, so no sentence could ever contain it and the natural-language
 * form of a question the page answers plainly fell under the floor. Adding
 * ordinary English to a working query destroyed it. Across ten real questions on
 * live pages the answer rate was 30%.
 *
 * An answer sentence is drawn from INDEXED TEXT, so a term the corpus does not
 * contain cannot appear in any sentence. Counting it measures whether the user
 * picked the page's vocabulary, not whether the sentence answers. And terms are
 * not interchangeable: "discount" narrows 46 chunks to one, "of" narrows nothing.
 *
 * The fix is the narrow one, and it was chosen by measurement rather than taste.
 * Two variants were run in a historical experiment—ten real questions on live
 * pages whose answer keys predated this feature:
 *
 *                            answer rate   precision   MISLED
 *   baseline                    3/10         3/3        0
 *   idf-weighted coverage       3/10         2/3        0     <- rejected
 *   drop absent terms only      5/10         4/5        0     <- shipped
 *
 * idf weighting sounded better and measured worse: it bought nothing on the
 * answer rate and lost a correct answer on MDN, because on a small corpus idf is
 * noisy. Dropping absent terms alone delivers four correct answers where there
 * were three, with MISLED still at zero — the one outcome that would make this
 * feature worse than not having it.
 *
 * So this returns each reachable term's IDF — the index's own statistic. Two
 * separate consumers use it, and keeping them separate is the point:
 *
 *   COVERAGE (which sentence wins, and the `minCoverage` floor) counts terms
 *   equally and only asks whether a term is reachable at all. Weighting coverage
 *   by idf was the variant that measured worse.
 *
 *   The EVIDENCE GATE (may this be called an answer at all) sums the idf of the
 *   terms the winning sentence actually matched. See `identifyFloor`.
 */
export function reachableTerms(idx: BM25Index, qTerms: string[]): Map<string, number> {
  const w = new Map<string, number>();
  for (const t of qTerms) {
    const posting = idx.postings.get(t);
    if (!posting?.length) continue;               // absent: no sentence can hold it
    // Document SHARE, not a weight. Two consumers need this map and neither
    // wants one: coverage needs membership only, and the discrimination gate
    // compares against a ceiling expressed in the same units config.ts already
    // uses for the control index.
    w.set(t, posting.length / Math.max(1, idx.n));
  }
  return w;
}

/** How much of what the agent asked for does this control's document contain? */
export function coverageOf(docTerms: Iterable<string>, informative: string[]): number {
  if (!informative.length) return 0;
  const doc = docTerms instanceof Set ? docTerms : new Set(docTerms);
  let hit = 0;
  for (const t of informative) if (doc.has(t)) hit++;
  return hit / informative.length;
}

/** Confidence bands over informative-term coverage. */
export const confidenceFor = (cov: number, cfg: RetrievalTuning): Confidence =>
  (cov >= cfg.confidenceHigh ? 'high' : cov >= cfg.confidenceMedium ? 'medium' : 'low');

/**
 * The control lookup, end to end, over an already-built index.
 *
 * Extracted so the inline lane and the worker run the SAME function rather than
 * two implementations that agree today.
 *
 * @returns {{ hits: [number, number][], coverage: number[], informative: string[] }}
 */
export interface RankControlsArgs {
  idx: BM25Index; docs: string[]; tokenize: Tokenize; query: string;
  limit: number; cfg: RetrievalTuning;
  search: (idx: BM25Index, terms: string[], k: number) => Hit[];
}
export interface RankedControls { hits: Hit[]; coverage: number[]; informative: string[] }

export function rankControls({ idx, docs, tokenize, query, limit, cfg, search }: RankControlsArgs): RankedControls {
  const qTerms = [...new Set(tokenize(query))];
  const hits = search(idx, qTerms, limit);
  const informative = informativeTerms(idx, qTerms, cfg.commonTermShare);
  const coverage = hits.map(([i]) => coverageOf(tokenize(docs[i] ?? ''), informative));
  return { hits, coverage, informative };
}

/**
 * Does anything the agent asked actually narrow this page down?
 *
 * The pathological case is a query made entirely of function words. Measured on
 * the demo page's 46 chunks, document share by term:
 *
 *   and 0.80 · the 0.74 · a 0.54 · of 0.48 · in 0.33 · to 0.30 · is 0.30
 *   rebate 0.20 · waste 0.15 · permit 0.07 · discount 0.02 · occupant 0.02
 *
 * The control index's 0.5 ceiling leaves `of` standing, so the query "of" matched
 * a sentence containing it, scored coverage 1.00, and came back as what the page
 * says. So did "to", "in" and "is".
 *
 * Function words sit at share >= 0.30 on this corpus and content words at <= 0.20.
 * `contentTermShare` is chosen inside that gap and it is EMPIRICAL — config.ts
 * says so rather than dressing it up.
 *
 * Two tidier alternatives were tried first and both measured worse:
 *
 *   idf-weighted coverage                   3/10 answered, 2/3 precision
 *   summed-idf gate against ln(n)           1/10 answered, 1/1 precision
 *   tightening the ceiling to 0.25          6/10 answered, 4/6, MISLED 1  <- fail
 *   THIS gate, ceiling untouched            5/10 answered, 4/5, MISLED 0
 *
 * The third is the instructive one: tightening the ceiling removed `of` from the
 * denominator, which INFLATED coverage on ordinary queries and produced a
 * misleading answer — the single outcome answer-eval calls a failure. A gate can
 * only refuse. A denominator change moves every score.
 *
 * So this asks one thing: is AT LEAST ONE reachable query term discriminating? A
 * real question always has one. A bag of prepositions never does.
 */
export const discriminates = (shares: Map<string, number>, ceiling: number): boolean => {
  for (const share of shares.values()) if (share <= ceiling) return true;
  return false;
};
