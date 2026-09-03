/**
 * The one sentence in a retrieved passage that actually answers the question.
 *
 * `find_on_page` returns a ~400-character passage, which is the right unit for a
 * human skimming a page and the wrong one for an agent that has to QUOTE
 * something back. Given a passage, an agent either replays all 400 characters —
 * paying for four sentences of context nobody asked for — or picks a sentence
 * itself, which is a second, unaccountable extraction step happening outside
 * this SDK where no gate can see it. Naming the sentence here makes that choice
 * reviewable, and gives the caller offsets it can hand to the highlighter.
 *
 * Everything here is PURE: no DOM, no index, no state. It runs on a chunk's text
 * and the same tokenizer the index was built with, so it can run in the worker.
 *
 * The tokenizer is INJECTED rather than constructed, for the reason text.ts
 * gives: word boundaries are locale-dependent, and a module that quietly builds
 * its own tokenizer will silently stop matching the terms the index holds. The
 * same argument applies to `queryTerms`, which must be terms as the index
 * spells them — post-folding, post-stemming — not raw words from the agent.
 *
 * Pass the INFORMATIVE terms, the ones ranking.ts already filters for. Coverage
 * collapses the same way the control-lookup confidence signal did when it was
 * measured over every query term: "how much does a permit cost per year" is
 * mostly function words, no sentence contains them, and the sentence that
 * genuinely answers scores 0.56 and falls under a 0.6 floor.
 */
import type { Tokenize } from '../types.ts';

export interface AnswerSpan {
  /** The sentence itself, trimmed. */
  text: string;
  /** Character offsets into the ORIGINAL chunk text, so a caller can map back
   *  to a DOM range for highlighting. */
  start: number;
  end: number;
  /**
   * 0..1 — the share of the query's REACHABLE terms this sentence contains:
   * matched terms over the query terms the corpus holds, counted EQUALLY.
   * The idf-weighted variant was measured worse and rejected (see ranking.ts §
   * reachableTerms — this docblock used to describe that rejected algorithm);
   * idf still gates evidence, it just does not weight the ratio.
   */
  coverage: number;
}

export interface AnswerOptions {
  /** Locale for sentence segmentation. MUST be the same locale the index was
   *  built with. */
  locale: string;
  /** Below this coverage, return null rather than a weak guess. */
  minCoverage: number;
  /** Sentences shorter than this are fragments (list bullets, "Yes.") and are
   *  merged with the following sentence rather than returned alone. */
  minSentenceChars: number;
  /** Never return more than this many characters. */
  maxAnswerChars: number;
}

/** Half-open bounds of one sentence within the chunk text, never a copy of it:
 *  the offsets are the load-bearing output and slicing early loses them. */
interface Bounds { start: number; end: number }

const WS = /\s/;

/**
 * Sentence boundaries are not "split on periods". `Intl.Segmenter` is the only
 * zero-download implementation that knows "Dr. Chen" and "approx. 3.5 kg" are
 * not three sentences, and the only thing that works at all for scripts with no
 * space delimiter — the same reason text.ts uses it for words.
 *
 * Constructed ONCE per call. Building a segmenter per sentence is the classic
 * way to make `Intl` look slow; it is the construction that costs, not the
 * segmentation.
 */
function segmentSentences(text: string, locale: string): Bounds[] {
  try {
    const seg = new Intl.Segmenter(locale, { granularity: 'sentence' });
    const out: Bounds[] = [];
    for (const s of seg.segment(text)) out.push({ start: s.index, end: s.index + s.segment.length });
    return out;
  } catch {
    // Defensive, exactly as text.ts is: a locale the engine rejects must degrade
    // to a worse answer, never to a thrown tool call. This split is wrong about
    // abbreviations, and that is the trade being made knowingly.
    return splitOnTerminators(text);
  }
}

/** The fallback. Offsets are tracked rather than derived from `String.split`,
 *  because a caller that cannot trust `start`/`end` cannot highlight anything —
 *  degraded segmentation is survivable, degraded offsets are not. */
function splitOnTerminators(text: string): Bounds[] {
  const re = /(?<=[.!?])\s+/g;
  const out: Bounds[] = [];
  let start = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ start, end: m.index + m[0].length });
    start = re.lastIndex;
  }
  if (start < text.length) out.push({ start, end: text.length });
  return out;
}

/** Pull the bounds in off surrounding whitespace so the highlighted range is the
 *  sentence and not the blank line above it. Keeps
 *  `chunkText.slice(start, end).trim() === text` true either way. */
function tighten(text: string, bounds: Bounds): Bounds {
  let { start, end } = bounds;
  while (start < end && WS.test(text[start])) start++;
  while (end > start && WS.test(text[end - 1])) end--;
  return { start, end };
}

/**
 * Where to cut when the answer exceeds its character budget.
 *
 * A hard cut at the budget produces "the permit is non-refundab", which an agent
 * will quote verbatim, so back off to the last whitespace inside the window.
 * A single token longer than the whole budget has no boundary to find; the hard
 * cut is then the only option and is preferable to returning nothing.
 */
function endOnWordBoundary(text: string, start: number, end: number): number {
  if (end >= text.length || WS.test(text[end])) return end;
  for (let i = end - 1; i > start; i--) if (WS.test(text[i])) return i;
  return end;
}

/**
 * The sentence in `chunkText` that best answers `queryTerms`, or null.
 */
export function extractAnswer(
  chunkText: string,
  queryTerms: string[],
  tokenize: Tokenize,
  opts: AnswerOptions,
  /**
   * `term -> idf` for the query terms the corpus actually holds, from
   * `ranking.ts § reachableTerms`. Used two different ways on purpose:
   * membership decides COVERAGE (a term the corpus lacks cannot appear in any
   * sentence, so counting it measured whether the asker used the page's
   * vocabulary rather than whether the sentence answers); the values decide the
   * EVIDENCE GATE. Absent means no index was available — coverage then falls
   * back to equal weights over every term and the gate does not run.
   */
  weights?: Map<string, number> | null,
): AnswerSpan | null {
  if (!chunkText || !chunkText.trim()) return null;

  // Deduplicated because coverage is a share of DISTINCT terms: a caller that
  // passes the raw token stream of "cost of the parking permit cost" would
  // otherwise weight "cost" twice and inflate the denominator against itself.
  const wanted = new Set(queryTerms.filter((t) => !!t));
  if (!wanted.size) return null;

  // The denominator is what a sentence COULD contain. A term the corpus does not
  // hold is unreachable by construction and belongs in neither half of the
  // fraction — counting it only measures whether the asker used the page's
  // vocabulary.
  const reachable = (t: string) => (weights ? weights.has(t) : true);
  const total = [...wanted].filter(reachable).length;
  if (total <= 0) return null;

  const sentences = segmentSentences(chunkText, opts.locale);

  let bestIdx = -1;
  let bestCoverage = 0;
  for (let i = 0; i < sentences.length; i++) {
    const { start, end } = sentences[i];
    const raw = chunkText.slice(start, end);
    if (!raw.trim()) continue;
    const have = new Set(tokenize(raw));
    let hit = 0;
    for (const t of wanted) if (reachable(t) && have.has(t)) hit++;
    const coverage = hit / total;
    // Strictly greater, so an exact tie keeps the EARLIER sentence. In prose the
    // claim is stated first and then qualified, so the later of two equally
    // covered sentences is usually the qualification and reads as a non-answer
    // when quoted alone.
    if (coverage > bestCoverage) { bestCoverage = coverage; bestIdx = i; }
  }

  // A zero-coverage sentence is never an answer, whatever `minCoverage` is set
  // to — the loop's strict comparison already refuses to select one, so a host
  // that sets the floor to 0 gets "no answer" rather than the first sentence of
  // every passage. Below the floor, null: a weak guess is worse than nothing
  // here, because the agent will quote it as though the page said it.
  if (bestIdx < 0 || bestCoverage < opts.minCoverage) return null;


  let { start, end } = sentences[bestIdx];

  // "Yes." is a correct answer and a useless one. Fragments — list bullets,
  // one-word confirmations, table cells that segment as their own sentence —
  // carry the match but not the fact, so absorb what follows until the span is
  // substantial. Bounded by `maxAnswerChars` rather than by a fixed number of
  // sentences, so a run of short bullets cannot walk the whole chunk.
  for (let i = bestIdx + 1; i < sentences.length; i++) {
    if (chunkText.slice(start, end).trim().length >= opts.minSentenceChars) break;
    if (sentences[i].end - start > opts.maxAnswerChars) break;
    end = sentences[i].end;
  }

  if (end - start > opts.maxAnswerChars) {
    end = endOnWordBoundary(chunkText, start, start + opts.maxAnswerChars);
  }

  ({ start, end } = tighten(chunkText, { start, end }));
  const text = chunkText.slice(start, end).trim();
  // Only reachable when the budget is smaller than the first token; an empty
  // span would still satisfy the offset invariant and mean nothing to a reader.
  if (!text) return null;

  // The coverage reported is the SELECTED sentence's, not the extended span's.
  // It is the number the `minCoverage` gate was applied to, and a caller that
  // sees a different one cannot reproduce the decision that was made for it.
  return { text, start, end, coverage: bestCoverage };
}
