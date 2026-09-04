/**
 * Literal evidence beside lexical retrieval.
 *
 * BM25 answers "which passage is about this?"; substring search answers "where
 * did these exact authored characters occur?". Neither is a substitute for the
 * other. In particular, punctuation-only fragments have no word-like terms for
 * `Intl.Segmenter` to index, while an exact-first ranker would promote incidental
 * quotations above passages that actually answer the query. The caller therefore
 * keeps BM25 order and uses this lane only to centre evidence and append chunks
 * BM25 could not represent. docs/EVAL.md records the same split: BM25 ranks,
 * literal offsets centre the evidence.
 *
 * This module is DOM-free and shared by the inline lane and the worker. That is
 * load-bearing: scheduling may differ between lanes; answers must not.
 */

import { foldDiacritics } from './text.ts';

export interface ExactDocument {
  /** Original chunk text, needed to translate folded offsets without a giant
   * per-character map. */
  raw: string;
  /** NFKD/diacritic/case folded once at build time, not once per query. */
  folded: string;
}

export interface ExactMatch {
  id: number;
  /** Half-open UTF-16 offsets into the ORIGINAL chunk text. */
  start: number;
  end: number;
}

export type Fold = (text: string) => string;

/** Locale-aware Unicode folding for literal evidence. `toLowerCase()` gets
 * Turkish dotted/dotless I wrong; ASCII-only lowering is even worse. Lowercase
 * before NFKD/diacritic removal so capital dotted İ becomes `i`, while dotless
 * I remains `ı`. The locale has already been resolved by `Intl.Segmenter`, so
 * both lanes receive the same valid tag. */
export function makeExactFold(locale: string): Fold {
  return (text) => foldDiacritics(text, locale);
}

export function buildExactDocuments(docs: readonly string[], fold: Fold): ExactDocument[] {
  return docs.map((raw) => ({ raw, folded: fold(raw) }));
}

/** Translate an offset in the folded string back into the original string.
 *
 * Keeping a Uint32 offset for every folded code unit costs roughly four extra
 * bytes per character—the wrong trade for a browser SDK already retaining raw
 * and indexed text. Only matched documents pay this linear translation. NFKD is
 * decompositional, so summing each original code point's folded length preserves
 * boundaries even when one character expands (`ﬁ` -> `fi`) or disappears (a
 * combining mark). */
function originalRange(raw: string, foldedStart: number, foldedEnd: number,
                       fold: Fold): { start: number; end: number } {
  let foldedOffset = 0;
  let start = 0;
  let end = raw.length;
  let foundStart = false;
  for (let i = 0; i < raw.length;) {
    const point = String.fromCodePoint(raw.codePointAt(i)!);
    const nextOriginal = i + point.length;
    const nextFolded = foldedOffset + fold(point).length;
    if (!foundStart && nextFolded > foldedStart) {
      start = i;
      foundStart = true;
    }
    if (foundStart && nextFolded >= foldedEnd) {
      end = nextOriginal;
      break;
    }
    i = nextOriginal;
    foldedOffset = nextFolded;
  }
  return { start, end };
}

/** First literal occurrence per document. Multiple occurrences in one chunk do
 * not create more results: the public unit is an addressable passage, and
 * duplicating it would waste tokens and corrupt pagination counts. */
export function searchExact(docs: readonly ExactDocument[], query: string,
                            fold: Fold, limit: number): ExactMatch[] {
  const needle = fold(query.trim());
  if (!needle) return [];
  const out: ExactMatch[] = [];
  for (let id = 0; id < docs.length && out.length < limit; id++) {
    const doc = docs[id];
    const at = doc.folded.indexOf(needle);
    if (at < 0) continue;
    out.push({ id, ...originalRange(doc.raw, at, at + needle.length, fold) });
  }
  return out;
}
