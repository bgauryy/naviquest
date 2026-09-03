/**
 * Describe an OPAQUE region with the multimodal Prompt API.
 *
 * The projection already declares WHERE the unreadable elements are — a canvas
 * chart, an unlabeled `<img>`, a custom-rendered widget — via
 * `describe_app({ opaque: true })`, and deliberately stops there rather than
 * GUESS what a graphic depicts. The multimodal model does not guess: it reads
 * the pixels. So this fills the hole with an actual description, but only when
 * the agent opts in (`describe: true`) — the "where it is" default is unchanged.
 *
 * FAIL-OPEN, like verifier.ts and summarizer.ts: no multimodal model, not opted
 * in, an un-imageable element, a timeout, or a malformed reply → `null`, and the
 * region keeps its box-only record. Window-only (the Prompt API is not exposed
 * to workers) and download-gated (creating a downloadable model is the person's
 * decision, gated on `navigator.userActivation`, never an agent tool call's).
 *
 * Stateless per call: each description runs on a CLONE of a never-prompted
 * template, so region N's description is not conditioned on regions 1..N-1 and
 * the session cannot grow to QuotaExceededError — the same reasoning verifier.ts
 * records for its yes/no verdicts.
 */

import type { BrowserLanguageModel } from './prompt-api.ts';
import { languageModelCtor } from './prompt-api.ts';
import { createTemplateGate } from './model-gate.ts';
import type { DiscoveryTuning } from '../config.ts';

/** Only elements the Prompt API accepts as image input directly. A custom
 *  widget or an SVG has no such handle here; it keeps its box for a
 *  screenshot-capable host, which is what the opaque list is for. */
const imageable = (el: Element): el is HTMLImageElement | HTMLCanvasElement =>
  (typeof HTMLImageElement !== 'undefined' && el instanceof HTMLImageElement)
  || (typeof HTMLCanvasElement !== 'undefined' && el instanceof HTMLCanvasElement);

export interface ImageDescriber {
  /** A one-sentence description of what the element shows, or null (fail-open). */
  describe(el: Element, hint?: string): Promise<string | null>;
  dispose(): void;
}

/** The multimodal declaration is what makes this a DIFFERENT template from the
 *  text readers' — it must be identical on the availability probe and on
 *  `create`, or Chrome answers for a model we are not about to build. */
const MULTIMODAL = { expectedInputs: [{ type: 'text' }, { type: 'image' }] };

export function createImageDescriber(cfg: DiscoveryTuning): ImageDescriber {
  const timeoutMs = cfg.describeTimeoutMs;
  // Availability policy (download gate, latch-on-`unavailable`, transient
  // otherwise) is model-gate.ts's, shared with every other built-in AI surface.
  const gate = createTemplateGate({
    enabled: () => cfg.describeOpaque !== 'off',
    ctor: languageModelCtor,
    availability: (api) => api.availability(MULTIMODAL),
    create: (api) => api.create({ ...MULTIMODAL, signal: AbortSignal.timeout(timeoutMs) }).catch(() => null),
    destroy: (t) => t.destroy?.(),
  });

  return {
    async describe(el, hint) {
      if (!imageable(el)) return null;
      let turn: BrowserLanguageModel | null = null;
      try {
        const base = await gate.get();
        if (!base) return null;
        // A session that cannot clone cannot describe region N independently of
        // regions 1..N-1; the probe cannot see that, so latch from outside it.
        if (typeof base.clone !== 'function') { gate.latch(); return null; }
        const signal = AbortSignal.timeout(timeoutMs);
        turn = await base.clone({ signal });
        const raw = await turn.prompt([{ role: 'user', content: [
          { type: 'text', value: `Describe what this shows in ONE sentence${hint ? ` (context: ${hint})` : ''}. If it is a chart, name what it plots and the notable values. No preamble.` },
          { type: 'image', value: el },
        ] }], { signal });
        const text = String(raw).replace(/\s+/g, ' ').trim();
        return text ? text.slice(0, cfg.describeMaxChars) : null;
      } catch { return null; }
      // A clone holds model context; leaking one per region is unbounded heap growth.
      finally { try { turn?.destroy?.(); } catch { /* already torn down */ } }
    },
    // Not latched: unlike the text readers, this instance is not torn down for
    // the life of the document, so a later call may legitimately rebuild.
    dispose() { gate.release(); },
  };
}
