import type { BM25Index, Hit, Tokenize } from '../types.ts';

// Okapi BM25. ~40 lines, no dependency, and the zero-download floor that makes
// the SDK useful before any model is fetched.
//
// k1 and b are PARAMETERS, not constants. 1.5/0.75 are the canonical values and
// the historical baseline recorded in docs/EVAL.md used — but length
// normalisation in particular is a corpus decision, and this SDK indexes two
// very different corpora with the same code: page prose, where b=0.75 is right,
// and control names, which are uniformly short and where it does almost nothing.
import { DEFAULTS } from '../config.ts';
const { k1: K1, b: B, rrfK: RRF_K } = DEFAULTS.lexical;

export function buildIndex(docs: string[], tokenize: Tokenize): BM25Index {
  const postings = new Map<string, Array<[number, number]>>();
  const lens: number[] = [];
  docs.forEach((text: string, i: number) => {
    const terms = tokenize(text);
    lens[i] = terms.length || 1;
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, f] of tf) {
      if (!postings.has(t)) postings.set(t, []);
      postings.get(t)!.push([i, f]);
    }
  });
  const avg = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
  return { postings, lens, avg, n: docs.length };
}

export function search(idx: BM25Index, queryTerms: string[], k = 10,
                       { k1 = K1, b = B }: { k1?: number; b?: number } = {}): Hit[] {
  const scores = new Map<number, number>();
  for (const t of queryTerms) {
    const list = idx.postings.get(t);
    if (!list) continue;
    const idf = Math.log(1 + (idx.n - list.length + 0.5) / (list.length + 0.5));
    for (const [i, f] of list) {
      const denom = f + k1 * (1 - b + b * (idx.lens[i] / idx.avg));
      scores.set(i, (scores.get(i) || 0) + idf * ((f * (k1 + 1)) / denom));
    }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
}

// Reciprocal Rank Fusion, k=60 — and it IS wired in: `worker.ts` fuses the
// lexical and dense hit lists through this function on the dense lane. The
// comment here said "not wired into the SDK — there is no dense lane to fuse
// with yet", which stopped being true when dense.ts shipped, and also pointed at
// an injection seam that no longer exists.
//
// Measured with real potion weights it was worth +5 pp hit@1 and +9 pp hit@3
// over lexical alone, and dense WITHOUT fusion is worse than lexical at rank 1 —
// a static embedding has no compositionality, so it earns its place only here.
// Those figures came from a harness that has since been removed and cannot be
// re-measured in this repository.
export function rrf(lists: Hit[][], k = RRF_K, limit = 10): Hit[] {
  const s = new Map<number, number>();
  for (const list of lists) list.forEach(([id]: Hit, rank: number) => s.set(id, (s.get(id) || 0) + 1 / (k + rank + 1)));
  return [...s.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

/**
 * Character-trigram similarity, used ONLY when the lexical index returns
 * nothing at all. An empty `candidates` array with no explanation is the worst
 * possible answer for an agent: it cannot tell "this page has no such control"
 * from "your wording missed", and it has no next move. This gives it the
 * closest names on the page, explicitly marked as a fuzzy guess.
 *
 * Not fused into normal ranking on purpose — trigram noise reorders good
 * lexical results, and the ranking that BM25 produces when it produces anything
 * at all is the one this SDK is accountable for.
 */
const trigrams = (s: string): Set<string> => {
  const t = ` ${(s || '').toLowerCase().replace(/\s+/g, ' ')} `;
  const out = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
};

// No parameter defaults: `floor`'s shipped value lives in config.ts (`fuzzyFloor`)
// and a second copy here was one that could silently stop matching it.
export function fuzzyRank(docs: string[], query: string, k: number, floor: number): Hit[] {
  const q = trigrams(query);
  if (!q.size) return [];
  const scored: Hit[] = [];
  for (let i = 0; i < docs.length; i++) {
    const d = trigrams(docs[i]);
    if (!d.size) continue;
    let shared = 0;
    for (const g of q) if (d.has(g)) shared++;
    const dice = (2 * shared) / (q.size + d.size);
    if (dice >= floor) scored.push([i, dice]);
  }
  return scored.sort((a, b) => b[1] - a[1]).slice(0, k);
}
