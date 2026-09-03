/**
 * The ONE lexical build, shared by both retrieval lanes.
 *
 * `lane.ts` (inline) and `worker.ts` each held a line-for-line copy of this
 * step. The ranking half was extracted to `ranking.ts` for exactly the reason
 * that file states — "the moment the harness and the product build different
 * documents, the gate measures a ranker that does not ship" — but the BUILD
 * half, where tokenizer, stemmer, and change-signature drift would silently
 * desynchronize term statistics between lanes, was not. The copies had already
 * begun to reorder (one built the tokenizer before the change check, one
 * after), which is harmless and is exactly how drift starts.
 *
 * DOM-free by construction: this module runs identically on the main thread
 * and inside the module worker.
 */
import { makeTokenizer, expandTokens, makeStemmer, withStems } from './text.ts';
import { buildIndex } from './bm25.ts';
import { buildExactDocuments, makeExactFold } from './exact.ts';
import type { ExactDocument, Fold } from './exact.ts';
import type { BM25Index, Tokenize } from '../types.ts';
import { DEFAULTS } from '../config.ts';
import type { LexicalTuning, TextTuning } from '../config.ts';

/** Exact equality, shared by both lanes. Hash-only reuse risks a collision that
 * leaves retrieval confidently stale; reference equality alone misses every
 * rebuild because projection creates fresh arrays. */
export function sameDocuments(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((doc, i) => doc === b[i]);
}

export interface LexicalBuildInput {
  contentDocs: string[]; rawContentDocs: string[]; controlDocs: string[];
  locale: string; textCfg?: Partial<TextTuning>; lexical: LexicalTuning;
}

export interface LexicalBuildOutcome {
  indexMs: number; locale: string; stemLanguage: string;
  /** Which halves were rebuilt — the worker lane re-embeds exactly these. */
  contentChanged: boolean; controlsChanged: boolean;
}

/** The mutable index state a lane reads at query time. One object, reassigned
 *  in place by `build()`, so a lane holds `s` once — the same shape tools.ts
 *  uses for `IndexState`. */
export interface LexicalState {
  tok: ReturnType<typeof makeTokenizer> | null;
  contentTokens: Tokenize;
  ctlTokens: Tokenize;
  contentIdx: BM25Index | null;
  controlIdx: BM25Index | null;
  contentDocs: string[];
  rawContentDocs: string[];
  controlDocs: string[];
  exactDocs: ExactDocument[];
  exactFold: Fold;
  lexical: LexicalTuning;
  stemLanguage: string;
}

export function createLexicalStore(): { s: LexicalState; build(args: LexicalBuildInput): LexicalBuildOutcome } {
  const s: LexicalState = {
    tok: null,
    contentTokens: () => [],
    ctlTokens: () => [],
    contentIdx: null,
    controlIdx: null,
    contentDocs: [],
    rawContentDocs: [],
    controlDocs: [],
    exactDocs: [],
    exactFold: (text) => text,
    // DEFAULTS.lexical, not a third copy of its values. This is dead until
    // `build()` assigns the host's tuning, but a hand-written duplicate of a
    // config default is a thing that silently stops matching it.
    lexical: { ...DEFAULTS.lexical },
    stemLanguage: 'none',
  };
  let buildSignature = '';

  return {
    s,
    build(args) {
      const t0 = performance.now();
      const textCfg = args.textCfg ?? {};
      const signature = JSON.stringify([args.locale, textCfg, args.lexical]);
      const tokenizerChanged = signature !== buildSignature;
      // Captured, not re-read. `text.ts` is explicit that the locale must be
      // frozen once and reused at BOTH index and query time — a closure that
      // reads the mutable binding would tokenize a query with whatever
      // tokenizer the LAST rebuild installed, which on a page that changes
      // `<html lang>` is a silent mismatch in term statistics.
      const tk = makeTokenizer(args.locale, textCfg);
      // Content stems, controls do not — see text.ts § morphology. Both sides of
      // the content index use the SAME function, because a stemmed corpus and an
      // unstemmed query match nothing at all.
      const stem = (textCfg.stemming ?? 'auto') === 'off'
        ? makeStemmer('none') : makeStemmer(tk.locale);
      const contentChanged = tokenizerChanged
        || !sameDocuments(s.contentDocs, args.contentDocs)
        || !sameDocuments(s.rawContentDocs, args.rawContentDocs);
      const controlsChanged = tokenizerChanged || !sameDocuments(s.controlDocs, args.controlDocs);
      s.tok = tk;
      s.exactFold = makeExactFold(tk.locale);
      s.stemLanguage = stem.language;
      s.lexical = args.lexical;
      s.contentTokens = (t) => withStems(tk.tokens(t), stem);
      s.ctlTokens = (t) => expandTokens(tk.tokens(t), textCfg);
      if (contentChanged) {
        s.contentIdx = buildIndex(args.contentDocs, s.contentTokens);
        s.exactDocs = buildExactDocuments(args.rawContentDocs, s.exactFold);
      }
      if (controlsChanged) s.controlIdx = buildIndex(args.controlDocs, s.ctlTokens);
      s.contentDocs = args.contentDocs;
      s.rawContentDocs = args.rawContentDocs;
      s.controlDocs = args.controlDocs;
      buildSignature = signature;
      return { indexMs: +(performance.now() - t0).toFixed(1), locale: tk.locale,
               stemLanguage: stem.language, contentChanged, controlsChanged };
    },
  };
}
