/**
 * Answer from the retrieved regions, in the page's own words.
 *
 * The lexical lane fails a distinct, measured cluster of questions: the page
 * ANSWERS them, but in words the query never used — "who CREATED javascript" is
 * answered by "…DESIGNED by Brendan Eich"; "what method TRANSFORMS each element"
 * by `map`. BM25 cannot bridge that vocabulary gap, so the answering passage
 * never ranks and the extractive answer path returns nothing. Curated synonym
 * expansion and a structured key→value lane were both measured and rejected on
 * this cluster (eval/synonym-ceiling-probe.mjs, eval/fact-ceiling-probe.mjs):
 * the gap is semantic, not lexical, so the fix is comprehension.
 *
 * So when the extractive path finds nothing assertable, hand the on-device model
 * the FULL text of the top-ranked regions — the ones retrieval already surfaced,
 * so no new search terms are invented — and ask it to answer from that text or
 * say NONE. Its reply is then QUOTE-VERIFIED: the phrase must actually appear in
 * the regions, or it is dropped. A model that paraphrases or invents is treated
 * as no answer, so this can only quote the page, never speak for it.
 *
 * FAIL-OPEN, like the verifier it shares a session with: disabled, no reader,
 * cold, slow, NONE, or a phrase that fails the quote check all return `null`,
 * and `find_on_page` returns exactly what it would with no reader — a passage
 * result or nothing. It only ever ADDS an answer the lexical path missed.
 */
import type { AnswerTuning } from '../config.ts';
import type { LmSession } from './lm-session.ts';

export interface RegionAnswer {
  /** The quote-verified phrase. */
  text: string;
  /** EVERY `regions` index whose text contains the phrase, so the caller can
   *  attribute the answer to the best-matching region rather than the first that
   *  merely happens to contain it. Never empty (a phrase in no region is dropped). */
  regions: number[];
}

export interface Answerer {
  /** Read `regions` (top passages, already retrieved) and answer `question` from
   *  them, or null. The answer is guaranteed to appear verbatim in `regions`. */
  answer(question: string, regions: string[]): Promise<RegionAnswer | null>;
}

const ANSWER_SCHEMA = {
  type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'],
};

/** Loose fold for the quote check: case and whitespace only. The model quotes
 *  from text we gave it, so punctuation and casing are the realistic drift; a
 *  heavier Unicode fold would buy nothing on the same source string. */
const fold = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function createAnswerer(cfg: AnswerTuning, session: LmSession): Answerer {
  const enabled = cfg.fromRegion !== 'off';
  return {
    async answer(question, regions) {
      if (!enabled || !question.trim() || !regions.length) return null;
      // Join with a blank line and cap: the model reads the top regions as one
      // passage, and the cap bounds prompt cost regardless of how large the
      // retrieved chunks are. The join marker is stripped for the quote check.
      const joined = regions.join('\n\n').slice(0, cfg.fromRegionMaxChars);
      const raw = await session.run(
        `Text:\n"""\n${joined}\n"""\n\nQuestion: ${question}\n`
        + 'Answer the question in a short phrase, using ONLY wording that appears in the '
        + 'text above. If the text does not contain the answer, reply {"answer": "NONE"}.',
        ANSWER_SCHEMA, cfg.fromRegionTimeoutMs);
      if (raw === null) return null;
      let phrase = '';
      try {
        const parsed = JSON.parse(raw) as { answer?: unknown };
        phrase = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
      } catch { return null; }
      if (!phrase || phrase.toUpperCase() === 'NONE') return null;
      // QUOTE-VERIFY against every region so the answer both proves itself and
      // names EACH region it appears in (the caller attributes it to the best
      // one). A phrase the model composed but the page does not contain matches
      // nowhere and is dropped.
      const needle = fold(phrase);
      const found: number[] = [];
      for (let i = 0; i < regions.length; i++) if (fold(regions[i]).includes(needle)) found.push(i);
      if (!found.length) return null;
      return { text: phrase, regions: found };
    },
  };
}
