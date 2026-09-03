/**
 * Intl.Segmenter is the only zero-download, Unicode-correct tokenizer, and the
 * only thing that works at all for CJK/Thai (`"吾輩は猫である"`.split(' ') gives
 * one useless element). `isWordLike` is exactly the BM25 term filter.
 *
 * The locale is frozen once and reused at BOTH index and query time: word
 * boundaries are locale-dependent, so a mismatch makes term statistics
 * silently stop matching. Construct once — never per chunk.
 */
// The default reads the document's language, which means the module could not be
// imported at all outside a browser — the evaluation harnesses run in Node.
const docLocale = () => (typeof document !== 'undefined'
  ? (document.documentElement?.getAttribute('lang') || '').trim() : '') || 'en';

// The ONLY import in this module, and it is safe in Node: every one of
// config.ts's own imports is `import type`, so it has zero runtime dependencies
// and touches no DOM. Worth the edge — the alternative was a second copy of two
// length thresholds, which is the rot this file's own § morphology notes warn
// about.
import { DEFAULTS } from '../config.ts';
import type { TextTuning } from '../config.ts';

export interface Tokenizer {
  locale: string;
  tokens: (str: string) => string[];
  /** Count authored Unicode words without identifier-expansion terms. */
  wordCount: (str: string) => number;
  fold: (s: string) => string;
}

/** Diacritic-stripping casefold (NFKD + strip combining marks + lowercase). One
 *  definition, shared by the tokenizer here and language.ts's name matching — a
 *  second hand-written copy is one that silently stops matching this one.
 *  Locale-aware folding (Turkish dotless-İ) is exact.ts's separate concern. */
export const foldDiacritics = (s: string): string =>
  s.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase();

export function makeTokenizer(locale: string = docLocale(),
                              opts: Partial<TextTuning> = {}): Tokenizer {
  const idMinLen = opts.identifierMinLength ?? DEFAULTS.text.identifierMinLength;
  const idMinPart = opts.identifierMinPart ?? DEFAULTS.text.identifierMinPart;
  let seg: Intl.Segmenter;
  // The reported locale must be the one actually SEGMENTING, and the request can
  // differ from it in TWO ways — only one of which announces itself.
  //
  // A tag the engine rejects THROWS, and the fallback below is loud. A
  // DEPRECATED tag does not throw: the constructor canonicalises it in silence.
  // `new Intl.Segmenter('iw')` segments HEBREW and resolves to 'he'; 'in' -> 'id',
  // 'ji' -> 'yi', 'iw-IL' -> 'he-IL'. Echoing the request back therefore lied on
  // exactly the pages where it mattered — aliexpress.com serves `lang="iw"`, so
  // `stats.locale` named a locale that was not the one segmenting, which is the
  // index/query mismatch the field is surfaced on every response to expose.
  //
  // `resolvedOptions()` is the only thing that knows which of the two happened,
  // so it is the single source for the answer rather than the catch branch
  // guessing 'en' and the success branch guessing the request.
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
    // Baseline only since April 2024, and both branches below throw the same
    // TypeError where the constructor is absent — the one hard crash in an SDK
    // that otherwise degrades. The shim splits on letter/number runs: no
    // CJK/Thai boundaries, but a degraded index beats a thrown SDK.
    const shim = {
      segment: (s: string) => [...s.matchAll(/[\p{L}\p{N}]+/gu)]
        .map((m) => ({ segment: m[0], isWordLike: true })),
      resolvedOptions: () => ({ locale: locale || 'en' }),
    };
    seg = shim as unknown as Intl.Segmenter;
  } else {
    try { seg = new Intl.Segmenter(locale, { granularity: 'word' }); }
    catch { seg = new Intl.Segmenter('en', { granularity: 'word' }); }
  }
  locale = seg.resolvedOptions().locale;
  const fold = foldDiacritics;
  return {
    locale,
    tokens(str: string) {
      const out: string[] = [];
      for (const s of seg.segment(str)) {
        if (!s.isWordLike) continue;
        out.push(fold(s.segment));
        // BEFORE folding — case is the signal, and `fold` destroys it.
        for (const part of identifierParts(s.segment, idMinLen, idMinPart)) out.push(fold(part));
      }
      return out;
    },
    wordCount(str: string) {
      let count = 0;
      for (const s of seg.segment(str)) if (s.isWordLike) count++;
      return count;
    },
    fold,
  };
}

/**
 * `registerTool` -> `register`, `tool`. The whole token is always kept as well.
 *
 * Found by measurement, not by taste. On `github.com/webmachinelearning/webmcp`
 * the question "how do I register a tool on the page" was the ONE recall miss in
 * the WebMCP ecosystem set: both baselines contained the answer and we returned
 * nothing. The page says `document.modelContext.registerTool`, `Intl.Segmenter`
 * emits `registerTool` as one word-like segment, `fold` lowercases it to
 * `registertool`, and no amount of BM25 connects that to the query term
 * `register`.
 *
 * That is not a niche gap. Six of the eight sites in that set are developer
 * documentation — the page category an agent is most likely to be sent to read —
 * and an API name is the single most likely thing to be asked about on one.
 *
 * Applied INSIDE the tokenizer so index and query get identical treatment.
 * Doing it as a post-pass over one side is how a corpus and its queries stop
 * matching, which is the failure this file's header already warns about for
 * locale.
 *
 * Deliberately narrow: it fires only on a token carrying an explicit word
 * boundary — a lower-to-upper transition, or a separator — so ordinary prose is
 * untouched. `Photosynthesis` does not split; `iPhone` does, harmlessly, and
 * `iphone` is still indexed alongside. Parts under three characters are dropped
 * so `toString` cannot contribute a bare `to`, which is exactly the kind of
 * near-stopword ranking.ts § discriminates exists to refuse.
 */
const IDENTIFIER = /[a-z0-9][A-Z]|[A-Z][A-Z][a-z]|[_.-]/;

/** Split on separators and on camel-hump boundaries, without a sentinel: the
 *  lookbehind/lookahead pair cuts between the characters rather than consuming
 *  them, so no information is lost and nothing has to be stitched back. */
const BOUNDARY = /[_.-]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;

function identifierParts(raw: string, minLength = DEFAULTS.text.identifierMinLength,
                                minPart = DEFAULTS.text.identifierMinPart): string[] {
  if (raw.length < minLength || !IDENTIFIER.test(raw)) return [];
  const parts = raw.split(BOUNDARY).filter((p) => p.length >= minPart);
  // One part means the split found nothing the whole token did not already say.
  return parts.length > 1 ? parts : [];
}

/**
 * Morphology: match "carbohydrates" to "carbohydrate".
 *
 * MEASURED, 2026-08-30, four live pages, 160 probes. A probe queries a term that
 * appears in exactly ONE chunk, using an inflected form the page never contains:
 *
 *   plain BM25     recall@5    0/160    (0%)
 *   + stemming     recall@5  157/160   (98%)
 *
 * Zero. An agent asking "how are carbohydrates stored" against a page that says
 * "storing carbohydrate" retrieved NOTHING, on every page tested. 8.9% of the
 * distinct vocabulary on the Wikipedia article is a suffix-variant of another
 * term already in the index, and BM25 treated every pair as unrelated words.
 *
 * CONTENT ONLY, and that is an evidence boundary rather than an oversight. The
 * same experiment over the 30-lookup labelled control gate moved hit@1 by 0 pp
 * (+3 pp hit@3, one win and one loss): control names are short, and morphology
 * has almost nothing to bite on. Applying it there would be a change the
 * evidence does not support.
 *
 * The stem is ADDED, never substituted, so an exact match still carries its own
 * term frequency and cannot be outranked by a fuzzier one.
 *
 * ENGLISH ONLY, and the SDK says so rather than pretending. These are Porter-ish
 * suffix rules; they are wrong for German compounds, meaningless for the
 * agglutinative languages, and irrelevant to CJK — which this SDK explicitly
 * indexes. Snowball covers 26 languages properly and is thousands of lines per
 * language of pure, DOM-free computation, which is exactly what the retrieval
 * worker is for. This remains an explicitly unsupported-language gap.
 */
const EN_RULES: Array<[RegExp, string]> = [
  [/(.{3,})ational$/, '$1ate'], [/(.{3,})ization$/, '$1ize'], [/(.{3,})fulness$/, '$1ful'],
  [/(.{3,})ousness$/, '$1ous'], [/(.{3,})iveness$/, '$1ive'], [/(.{3,})ities$/, '$1ity'],
  [/(.{3,})ements?$/, '$1'], [/(.{3,})ness$/, '$1'], [/(.{3,})tions?$/, '$1te'],
  [/(.{3,})sions?$/, '$1se'], [/(.{3,})(?:ingly|edly)$/, '$1'], [/(.{3,})ing$/, '$1'],
  [/(.{3,})ed$/, '$1'], [/(.{3,})ies$/, '$1y'], [/(.{3,})es$/, '$1'], [/(.{3,})s$/, '$1'],
  [/(.{3,})ly$/, '$1'], [/(.{3,})(?:able|ible)$/, '$1'],
];

/**
 * Porter's step 5a, and it is not optional here.
 *
 * Without it the two sides do not CONVERGE: "certificates" strips `es` to
 * "certificat" while "certificate" keeps its final `e`, so the query and the
 * document land on different stems and match no better than before. Stripping a
 * trailing `e` from the stem is what makes them meet.
 */
const dropFinalE = (w: string) => (w.length > 4 && w.endsWith('e') ? w.slice(0, -1) : w);

export type Stemmer = ((word: string) => string) & { language: string };

const identity = Object.assign((w: string) => w, { language: 'none' });

/**
 * A stemmer for this locale, or the identity function when there is not one.
 * `language: 'none'` is reported on every retrieval response, so an agent
 * getting poor recall on a Finnish page can tell that morphology is the reason.
 */
export function makeStemmer(locale: string): Stemmer {
  // `Intl.Locale` rather than `split(/[-_]/)[0]`, for the same reason
  // makeTokenizer resolves rather than echoes: the naive split cannot
  // canonicalise, so 'iw' selected a stemmer for a language code that has not
  // named Hebrew since 1989. Harmless while 'en' is the only stemmer; a
  // wrong-language stemmer if more language-specific stemmers land, and
  // that is a silent recall loss rather than an error.
  //
  // The catch is load-bearing, not decorative: `new Intl.Locale` THROWS on tags
  // the split happily minced — 'en_US', 'x-klingon', and the literal 'none' this
  // SDK passes to switch morphology off (lane.ts, worker.ts). An untranslatable
  // tag has no stemmer, which is what `identity` already means.
  let lang: string | undefined;
  try { lang = new Intl.Locale(locale || 'und').language; } catch { return identity; }
  if (lang !== 'en') return identity;
  return Object.assign((word: string): string => {
    if (word.length < 5) return word;
    for (const [re, rep] of EN_RULES) if (re.test(word)) return dropFinalE(word.replace(re, rep));
    return dropFinalE(word);
  }, { language: 'en' });
}

/** Add each token's stem alongside it. Never substitutes: an exact match keeps
 *  its own term frequency and cannot be outranked by a fuzzier one. */
export function withStems(tokens: string[], stem: Stemmer): string[] {
  if (stem.language === 'none') return tokens;
  const out = tokens.slice();
  for (const t of tokens) { const st = stem(t); if (st !== t) out.push(st); }
  return out;
}

/** `chars/token` is a per-host setting, not a constant: 4 is the usual English
 *  approximation and roughly 2x wrong for CJK, which this SDK supports. */
export const estimateTokens = (s: unknown, charsPerToken = 4): number =>
  Math.ceil((typeof s === 'string' ? s : JSON.stringify(s)).length / charsPerToken);

/**
 * Adjacent-token concatenation, applied to CONTROL names and control queries
 * only.
 *
 * "log in to my account" tokenises to [log, in, to, my, account] and never
 * matches a link whose text is "login" — on Hacker News that query returned
 * three story titles instead, because they happened to contain "account". The
 * reverse fails too: a "Log in" button against a "login" query. English writes
 * the same affordance open, closed and hyphenated ("sign up"/"signup",
 * "check out"/"checkout", "log in"/"login"), so both sides get both forms.
 *
 * Deliberately not applied to page content: it would inflate the term space of
 * every chunk for a class of ambiguity that only arises in short control names.
 */
export function expandTokens(tokens: string[], opts: { maxConcatTokenLength?: number; minConcatLength?: number } = {}): string[] {
  const maxLen = opts.maxConcatTokenLength ?? DEFAULTS.text.maxConcatTokenLength;
  const minJoined = opts.minConcatLength ?? DEFAULTS.text.minConcatLength;
  const out = tokens.slice();
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i], b = tokens[i + 1];
    if (a.length <= maxLen && b.length <= maxLen) {
      const joined = a + b;
      if (joined.length >= minJoined) out.push(joined);
    }
  }
  return out;
}

/**
 * FNV-1a over the JSON form. Used for ETag-style change detection, never for
 * security: an agent re-sends the token it was given, and a collision costs one
 * unnecessary full response.
 */
export function etag(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/**
 * Share of CJK/Thai codepoints in a sample. `chars/4` is an English
 * approximation and roughly 2x wrong for scripts where one character is closer
 * to one token, so the budget has to know which page it is on.
 */
export function scriptDensity(sample: string, maxChars = 4000): number {
  const s = String(sample || '').slice(0, maxChars);
  if (!s.length) return 0;
  let dense = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x0e00 && c <= 0x0e7f)) dense++;
  }
  return dense / [...s].length;
}
