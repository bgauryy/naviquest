/**
 * ONE on-device LanguageModel (Gemini Nano), shared by every text reader.
 *
 * Two readers now sit on the Prompt API — the answer VERIFIER (does this
 * extractive sentence answer the question?) and the answer-from-REGION reader
 * (read the top passages and answer in the page's own words). Each used to own
 * its own template session, which meant two `create()` calls, two multi-second
 * warm-ups, and two Gemini Nano contexts resident for one page. This owns a
 * single session both draw from: the first reader to need it pays the one
 * warm-up, and the second finds it already warm.
 *
 * The lifecycle is the verifier's, moved here verbatim and unchanged:
 *  - lazy: a page an agent never queries loads nothing;
 *  - download-gated: creating a `downloadable` model IS the multi-GB download,
 *    so it happens only inside a user gesture — never latched, because "no
 *    gesture right now" is transient. That decision now lives in model-gate.ts,
 *    shared with every other built-in AI surface instead of copied per wrapper;
 *  - warm-off-critical-path: the first `prompt()` against a fresh session pays a
 *    measured ~18 s model load, so the first call that would need a reader
 *    starts the load in the background and returns fail-open, and every later
 *    call finds a warm model inside its tight per-call bound;
 *  - FAIL-OPEN throughout: absent, unavailable, no gesture, cold, slow, or
 *    torn-down all return `null`, and every caller asserts exactly as it would
 *    with no reader at all.
 *
 * Stateless per call: `run()` prompts a THROWAWAY clone and destroys it, so no
 * call is conditioned on a previous one and context cannot grow to
 * `QuotaExceededError`. A session that cannot be cloned is refused, not reused.
 * Window-only, like the Summarizer wrapper; never moved into the worker.
 */

import type { BrowserLanguageModel } from './prompt-api.ts';
import { languageModelCtor } from './prompt-api.ts';
import { createTemplateGate } from './model-gate.ts';

export type { BrowserLanguageModel } from './prompt-api.ts';

export interface LmSession {
  /**
   * One stateless prompt on a throwaway clone of the warm template.
   *
   * Returns the raw model string, or `null` when no reader is available:
   * absent / unavailable / no gesture / not-yet-warm (the cold path starts the
   * background warm-up and returns null so the caller proceeds as if no reader
   * existed) / timeout / error. The caller parses the string it gets back.
   */
  run(prompt: string, schema: object, timeoutMs: number): Promise<string | null>;
  dispose(): void;
}

const WARM_PROMPT = 'Reply {"ok": true}.';
const WARM_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };

export function createLmSession(cfg: { enabled: boolean; warmupTimeoutMs: number }): LmSession {
  /** The TEMPLATE session. Never prompted — every call runs on a clone. */
  const gate = createTemplateGate({
    enabled: () => cfg.enabled,
    ctor: languageModelCtor,
    availability: (api) => api.availability(),
    create: (api) => api.create({ signal: AbortSignal.timeout(cfg.warmupTimeoutMs) }).catch(() => null),
    destroy: (t) => t.destroy?.(),
  });

  /** One prompt on a throwaway clone. The clone is destroyed either way —
   *  leaking one per call is the unbounded context growth the template
   *  indirection exists to prevent, moved into the heap. */
  const ask = async (base: BrowserLanguageModel, prompt: string, schema: object,
                     signal: AbortSignal): Promise<string | null> => {
    let turn: BrowserLanguageModel | null = null;
    try {
      turn = await base.clone!({ signal });
      return await turn.prompt(prompt, { responseConstraint: schema, signal });
    } finally { try { turn?.destroy?.(); } catch { /* already torn down */ } }
  };

  let warmed = false;
  let warming: Promise<void> | null = null;
  const warm = (base: BrowserLanguageModel): void => {
    if (warming) return;
    warming = ask(base, WARM_PROMPT, WARM_SCHEMA, AbortSignal.timeout(cfg.warmupTimeoutMs))
      .then(() => { warmed = true; })
      // A failed warm-up is not a latch: the model may simply have been busy.
      .catch(() => { warming = null; });
  };

  return {
    async run(prompt, schema, timeoutMs) {
      if (!cfg.enabled) return null;
      try {
        const base = await gate.get();
        if (!base) return null;
        // A session that cannot clone cannot produce a stateless result. The
        // availability probe cannot see this, so latch from outside it.
        if (typeof base.clone !== 'function') { gate.latch(); return null; }
        // Cold: start the load, do not wait for it, let the caller assert as if
        // no reader. Warm: run inside the caller's tight per-call bound.
        if (!warmed) { warm(base); return null; }
        return await ask(base, prompt, schema, AbortSignal.timeout(timeoutMs));
      } catch { return null; }
    },
    dispose() {
      gate.release();
      // An in-flight warm-up outlives dispose() and would otherwise mark a
      // destroyed template warm; the latch below is what refuses after teardown.
      warmed = false; warming = null;
      gate.latch();
    },
  };
}
