/**
 * On-device comprehension check for an extractive answer.
 *
 * `find_on_page` picks the answer sentence by lexical term-overlap, which
 * reliably prefers a sentence that ECHOES the question ("use the fetch method"
 * for "what does the fetch method return") over the one that ANSWERS it
 * ("returns a Promise"). No lexical rule separates the two — that judgment is
 * reading comprehension. When the browser exposes the Prompt API (Gemini Nano),
 * one yes/no call gates assertion: a rejected answer becomes `unsupported`, the
 * recovery hint fires, and the agent reads the full region instead of quoting a
 * confident wrong sentence.
 *
 * FAIL-OPEN by construction: the shared session yields `null` when no reader is
 * available (absent, unavailable, cold, slow), and the caller then asserts
 * exactly as it does today. The SDK never gets WORSE for turning this on.
 *
 * The Prompt API session lifecycle — lazy load, download gate, off-critical-path
 * warm-up, stateless clone-per-call — lives in lm-session.ts, shared with the
 * answer-from-region reader so one page loads Gemini Nano once, not twice. This
 * file is now only the verdict's prompt and its parse.
 */
import type { AnswerTuning } from '../config.ts';
import type { LmSession } from './lm-session.ts';

export interface Verifier {
  /** true = answers the question · false = does not · null = could not verify
   *  (disabled/absent/unavailable/cold/error) → the caller asserts as it would
   *  without a verifier. */
  verify(question: string, answer: string): Promise<boolean | null>;
}

const VERDICT_SCHEMA = {
  type: 'object', properties: { answers: { type: 'boolean' } }, required: ['answers'],
};

export function createVerifier(cfg: AnswerTuning, session: LmSession): Verifier {
  const enabled = cfg.verify !== 'off';
  return {
    async verify(question, answer) {
      if (!enabled || !answer.trim()) return null;
      const raw = await session.run(
        `Question: ${question}\nCandidate answer: "${answer}"\n`
        + 'Does the candidate answer THIS question directly — stating the fact asked for, '
        + 'not merely mentioning the topic? Reply {"answers": true} or {"answers": false}.',
        VERDICT_SCHEMA, cfg.verifyTimeoutMs);
      if (raw === null) return null;
      try {
        const parsed = JSON.parse(raw) as { answers?: unknown };
        return typeof parsed.answers === 'boolean' ? parsed.answers : null;
      } catch { return null; }
    },
  };
}
