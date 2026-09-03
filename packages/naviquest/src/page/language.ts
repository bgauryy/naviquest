/**
 * Is this control a language switcher? Answered with `Intl`, not with English.
 *
 * The shipped pattern was
 *   `\b\d+\s+languages?\b|^languages?$|^language\b|\btranslate\b|\bidioma\b|\bsprache\b`
 * — three English words plus one Spanish and one German afterthought. It cannot
 * match `Langue`, `言語`, `Русский`, `Ελληνικά`, or a switcher that simply lists
 * `Deutsch`, which is how most multilingual sites actually label one. A retrieval
 * SDK that supports CJK segmentation but detects affordances only in English is
 * inconsistent with itself.
 *
 * `Intl.DisplayNames` (Baseline since 2021) maps a language code to its name in
 * ANY locale, so two passes over the ISO 639-1 set give both:
 *
 *   - the EXONYM, the name in the page's own language  ("German", "allemand")
 *   - the ENDONYM, the name in its own language        ("Deutsch")
 *
 * The endonym pass is the one that matters: a language menu is nearly always
 * written in the languages it offers, not in the language of the current page.
 *
 * The code list is ISO 639-1 — a closed set because the standard is closed, not
 * because someone enumerated the languages they could think of. Built lazily on
 * first use and cached, so a page with no language switcher pays nothing.
 */
import { foldDiacritics } from '../retrieval/text.ts';

/** ISO 639-1. Two letters each, so this costs ~600 bytes before compression. */
const ISO_639_1 =
  'aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy '
  + 'da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu '
  + 'hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb '
  + 'lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om '
  + 'or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw '
  + 'ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu';

let cache: { locale: string; names: Set<string> } | null = null;

/** Casefold for comparison — the tokenizer's own fold plus a trim, so a
 *  language label and an indexed token fold identically. */
const fold = (s: string) => foldDiacritics(s).trim();

/**
 * Every language name this page might plausibly show, in the page's language
 * and in each language's own. Returns an empty set where `Intl.DisplayNames`
 * is unavailable, which degrades to "no match" rather than to an error.
 */
function languageNames(docLocale: string): Set<string> {
  if (cache?.locale === docLocale) return cache.names;
  const names = new Set<string>();
  try {
    const codes = ISO_639_1.split(' ');
    const inPage = new Intl.DisplayNames([docLocale || 'en'], { type: 'language', fallback: 'none' });
    for (const code of codes) {
      const exonym = inPage.of(code);
      if (exonym && exonym !== code) names.add(fold(exonym));
      try {
        // The endonym: the language's name in itself. `Deutsch`, `日本語`.
        const endonym = new Intl.DisplayNames([code], { type: 'language', fallback: 'none' }).of(code);
        if (endonym && endonym !== code) names.add(fold(endonym));
      } catch { /* a code this runtime has no data for is simply skipped */ }
    }
  } catch { /* no Intl.DisplayNames — the pattern fallback still applies */ }
  cache = { locale: docLocale, names };
  return names;
}

/**
 * Does this label name a language? Whole-label match only.
 *
 * Deliberately NOT a substring test: "English" appears inside "English muffin
 * recipes" and inside half the article titles on an English-language wiki, and
 * a substring rule would tag every one of them a language switcher. A switcher's
 * label IS the language name.
 */
export function isLanguageName(label: string, docLocale: string): boolean {
  const f = fold(label);
  if (!f || f.length > 40) return false;
  return languageNames(docLocale).has(f);
}

