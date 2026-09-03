/**
 * Cross-language query bridge (RFC-04): translate the agent's query into the
 * page's language so a same-language BM25 pass can retrieve foreign-language
 * evidence. Only the QUERY crosses the language boundary — page text and
 * quotations stay in the original language.
 *
 * Uses Chrome's `LanguageDetector` and `Translator` (both Stable from Chrome
 * 138, both Window-only — never a worker). FAIL-OPEN by construction: absent,
 * unavailable, downloading, no gesture, slow, or a same-language query all return
 * `null`, and the caller runs the ordinary single-language retrieval unchanged.
 * The download-gate and transient-state policy are model-gate.ts's, shared with
 * every other built-in AI surface (a downloadable pack is created only inside a
 * user gesture; only a stable `unavailable` latches — and for the translator it
 * latches ONE language pair, not the API).
 *
 * Validated at the MECHANISM level by eval/cross-language.mjs (union of original
 * + translated query = 4/5 vs English-only 2/5). This adapter is off by default
 * (`retrieval.crossLanguage: 'off'`); shipping it on requires a real-Translator
 * quality + same-language non-regression measurement per RFC-04.
 */
import type { RetrievalTuning } from '../config.ts';
import { createTemplateGate, decideAvailability } from './model-gate.ts';

interface Detector { detect(text: string): Promise<Array<{ detectedLanguage: string; confidence: number }>>; destroy?: () => void; }
interface Translator { translate(text: string): Promise<string>; destroy?: () => void; }
interface DetectorCtor { availability(): Promise<string>; create(o?: { signal?: AbortSignal }): Promise<Detector>; }
interface TranslatorCtor {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(o: { sourceLanguage: string; targetLanguage: string; signal?: AbortSignal }): Promise<Translator>;
}

const detectorCtor = (): DetectorCtor | null => {
  if (typeof document === 'undefined') return null;
  const v = (globalThis as { LanguageDetector?: DetectorCtor }).LanguageDetector;
  return v && typeof v.availability === 'function' && typeof v.create === 'function' ? v : null;
};
const translatorCtor = (): TranslatorCtor | null => {
  if (typeof document === 'undefined') return null;
  const v = (globalThis as { Translator?: TranslatorCtor }).Translator;
  return v && typeof v.availability === 'function' && typeof v.create === 'function' ? v : null;
};

/** BCP-47 primary subtag, lowercased: "en-US" → "en". */
const primary = (lang: string): string => (lang || '').split('-')[0].toLowerCase();

export interface CrossLingual {
  /** The query rewritten into `pageLang`, or `null` when translation should not
   *  or cannot run (same language, absent/unavailable/downloading, no gesture,
   *  slow, error). The caller then runs ordinary single-language retrieval. */
  translateQuery(query: string, pageLang: string): Promise<string | null>;
  dispose(): void;
}

export function createTranslator(cfg: RetrievalTuning): CrossLingual {
  const enabled = cfg.crossLanguage !== 'off';
  const pairUnavailable = new Set<string>();
  const translators = new Map<string, Translator>();

  const timeout = () => AbortSignal.timeout(cfg.crossLanguageTimeoutMs);

  // The detector is one global template, so it takes the shared gate whole.
  const detectorGate = createTemplateGate({
    enabled: () => true,
    ctor: detectorCtor,
    availability: (api) => api.availability(),
    create: (api) => api.create({ signal: timeout() }).catch(() => null),
    destroy: (d) => d.destroy?.(),
  });

  /** Translators are keyed PER LANGUAGE PAIR — one gate cannot memoize them,
   *  because `en>de` being unavailable says nothing about `fr>de`. So the cache
   *  is local and only the availability DECISION is shared. */
  const getTranslator = async (source: string, target: string): Promise<Translator | null> => {
    const key = `${source}>${target}`;
    if (pairUnavailable.has(key)) return null;
    const cached = translators.get(key);
    if (cached) return cached;
    const api = translatorCtor();
    if (!api) return null;
    const status = await api.availability({ sourceLanguage: source, targetLanguage: target }).catch(() => 'error');
    const decision = decideAvailability(status);
    // Latch THIS PAIR only: a pack this device will never get is stable, but it
    // is stable for one direction, not for the Translator API.
    if (decision === 'latch') { pairUnavailable.add(key); return null; }
    if (decision === 'wait') return null;
    const t = await api.create({ sourceLanguage: source, targetLanguage: target, signal: timeout() }).catch(() => null);
    if (t) translators.set(key, t);
    return t;
  };

  return {
    async translateQuery(query, pageLang) {
      if (!enabled || !query.trim() || !pageLang) return null;
      const target = primary(pageLang);
      if (!target) return null;
      try {
        const det = await detectorGate.get();
        if (!det) return null;
        const guesses = await det.detect(query).catch(() => null);
        const source = primary(guesses?.[0]?.detectedLanguage ?? '');
        // Only translate across a language boundary; a same-language query needs
        // no bridge and a low-confidence guess on a short query is not trusted.
        if (!source || source === target || (guesses?.[0]?.confidence ?? 0) < cfg.crossLanguageMinConfidence) return null;
        const tr = await getTranslator(source, target);
        if (!tr) return null;
        const out = await tr.translate(query).catch(() => null);
        const trimmed = out?.trim();
        return trimmed && trimmed.toLowerCase() !== query.trim().toLowerCase() ? trimmed : null;
      } catch { return null; }
    },
    dispose() {
      detectorGate.release();
      for (const t of translators.values()) { try { t.destroy?.(); } catch { /* gone */ } }
      translators.clear();
    },
  };
}
