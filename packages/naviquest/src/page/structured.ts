/**
 * Explicit question -> answer pairs out of an already-parsed JSON-LD value.
 *
 * The structured counterpart to project.ts `structuredText`, which flattens a
 * schema.org block into one prose string so BM25 can rank it. That flattening
 * is lossy in the one place it costs most: `FAQPage` and `QAPage` carry the
 * author's own question sitting next to the author's own answer, and once both
 * are clauses in a joined sentence the PAIRING is gone. An agent asking "is the
 * permit refundable?" then gets a ranked passage of the whole block, when the
 * page literally contains that question with an `acceptedAnswer` that could be
 * returned verbatim.
 *
 * The caller owns `JSON.parse` and its try/catch — this module takes `unknown`
 * so the same extraction can run over a value that arrived from a fetch, a
 * cache or a test fixture rather than only over a `<script>`'s text.
 *
 * Pure by construction: no DOM, no `innerHTML`, no `document`. Retrieval
 * already runs in a module worker (see the note atop ranking.ts) and the check
 * suite runs under Node, so a global reached for here would be a
 * main-thread-only feature that fails somewhere nobody can step through.
 */

export interface QAPair {
  question: string;
  answer: string;
  /** Where in the schema this came from, for provenance in the tool response.
   *  e.g. 'FAQPage' | 'QAPage' | 'HowTo' */
  source: string;
}

/**
 * Container types that vouch for every pair found beneath them, and the label
 * reported for each. `HowToSection` collapses to `HowTo` because a section is a
 * grouping INSIDE one HowTo, not a different origin an agent could treat
 * differently — reporting it would leak the author's chunking into provenance.
 */
const CONTAINER_SOURCES: Record<string, string> = {
  FAQPage: 'FAQPage',
  QAPage: 'QAPage',
  HowTo: 'HowTo',
  HowToSection: 'HowTo',
};

/**
 * Provenance for a `Question` with no typed container above it. This is not a
 * defensive branch: `@graph` payloads routinely emit the page node and its
 * question nodes as SIBLINGS, so the commonest real FAQ graph has questions
 * that no `FAQPage` encloses. Dropping them because the wrapper is missing
 * would discard exactly the pages that markup best.
 */
const ORPHAN_SOURCE = 'Question';

/** Fallback provenance for a step found outside any typed HowTo, same reason. */
const STEP_SOURCE = 'HowTo';

/**
 * Properties whose object members are HowTo steps even when those objects carry
 * no `@type` of their own — which is most recipe and instruction markup in the
 * wild, because Google's own examples show `step` entries typed and most CMS
 * plugins copy only the shape. `itemListElement` is the `HowToSection` spelling
 * of the same list.
 */
const STEP_KEYS = new Set(['step', 'itemListElement']);

/**
 * Where a Question's text lives, most-explicit first. `name` is the schema.org
 * headline and what every FAQ generator writes; `text` is the QAPage body form,
 * where the headline is sometimes omitted entirely.
 */
const QUESTION_KEYS = ['name', 'text', 'headline'];

/** An answer node's prose, most-explicit first. */
const ANSWER_TEXT_KEYS = ['text', 'name', 'description'];

/** `acceptedAnswer` before `suggestedAnswer`: the first is the answer the
 *  author endorsed, the second is a candidate anyone may have posted. */
const ANSWER_KEYS = ['acceptedAnswer', 'suggestedAnswer'];

/** A step's question side is its name; its answer side is the instruction. */
const STEP_QUESTION_KEYS = ['name', 'headline'];
const STEP_ANSWER_KEYS = ['text', 'description'];

/**
 * Markup whose CONTENT must go too, not just its tags. A stray `<style>` in an
 * answer would otherwise contribute a wall of CSS selectors as "prose" — junk
 * in the index and unreadable in a tool response.
 */
const EMBEDDED_BLOCKS = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/**
 * Tag strip. Deliberately a regex and not a parser: this module must stay pure
 * so it can run in a worker and under Node, which rules out `innerHTML` and any
 * DOM-based sanitiser. The known cost is that prose containing a bare `<`
 * followed later by a `>` ("a < b > c") loses the span between them; that is
 * rarer in JSON-LD answers than real HTML is, and the output is only ever
 * indexed and displayed, never re-inserted into a page, so an over-eager strip
 * degrades a result while an under-eager one would ship markup to the agent.
 */
const TAGS = /<[^>]*>/g;

/**
 * The five entities the spec names, decoded in ONE pass. Sequential replaces
 * would decode `&amp;lt;` twice and turn an author's literal "&lt;" into a
 * tag-shaped fragment after the strip has already run.
 *
 * Two additions beyond the five, both because the alternative is visibly wrong
 * text in a response the agent quotes verbatim:
 *  - `&nbsp;`, which is how every WYSIWYG editor writes a space and would
 *    otherwise survive as the literal token "14&nbsp;days".
 *  - NUMERIC references, decimal and hex, which need no table at all and cover
 *    the curly quotes and dashes WordPress emits as `&#8217;`/`&#8212;`. They
 *    also subsume `&#39;`.
 * Other NAMED entities (`&pound;`, `&mdash;`) are left alone deliberately:
 * decoding them means shipping a 2,000-entry table for a gain that numeric
 * references already deliver on the pages that matter.
 */
const ENTITIES = /&(?:(amp|lt|gt|quot|nbsp)|#(\d+)|#[xX]([\da-fA-F]+));/g;
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ',
};

/** Above this `String.fromCodePoint` throws RangeError, so `&#999999999;` in
 *  one block would take down the whole projection. Lone surrogates do not
 *  throw, but they produce an unpaired code unit that survives into the index
 *  and breaks string comparison later, so they are dropped on the same branch.
 *  A space is the safe reading of a character that cannot be represented. */
const MAX_CODE_POINT = 0x10ffff;

function decodeEntity(
  _match: string, named: string | undefined, dec: string | undefined, hex: string | undefined,
): string {
  if (named !== undefined) return NAMED_ENTITIES[named];
  const code = dec !== undefined ? parseInt(dec, 10) : parseInt(hex ?? '', 16);
  if (!Number.isFinite(code) || code < 0 || code > MAX_CODE_POINT) return ' ';
  if (code >= 0xd800 && code <= 0xdfff) return ' ';
  return String.fromCodePoint(code);
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `@type` is a string or an array of strings; both spellings are everywhere. */
function typesOf(node: Record<string, unknown>): string[] {
  const t = node['@type'];
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return [];
}

/**
 * Plain text out of a value that is usually HTML. Entities are decoded AFTER
 * the strip, never before, or `&lt;p&gt;` — how an author escapes a tag they
 * want the reader to see — becomes a real tag and is then deleted.
 */
export function clean(raw: string): string {
  return raw
    .replace(EMBEDDED_BLOCKS, ' ')
    // A space, not '': `<p>Yes.</p><p>Within 14 days.</p>` glued to
    // "Yes.Within 14 days." is one junk token in the index and an unreadable
    // sentence in the response.
    .replace(TAGS, ' ')
    .replace(ENTITIES, decodeEntity)
    .replace(/\s+/g, ' ')
    .trim();
}

/** First of `keys` that holds usable prose on this node, already cleaned. */
function firstString(node: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = node[k];
    if (typeof v === 'string') {
      const t = clean(v);
      if (t) return t;
    }
  }
  return '';
}

/**
 * The answer attached to a Question node. The answer property may be a string,
 * an object, or an ARRAY of candidate answers — StackExchange-style QAPage
 * markup emits every posted answer under `suggestedAnswer`. Only the first
 * usable one is taken: an agent asked a question wants an answer, not a thread.
 */
function answerOf(node: Record<string, unknown>): string {
  for (const key of ANSWER_KEYS) {
    const raw = node[key];
    for (const candidate of Array.isArray(raw) ? raw : [raw]) {
      if (typeof candidate === 'string') {
        const t = clean(candidate);
        if (t) return t;
      } else if (isObj(candidate)) {
        const t = firstString(candidate, ANSWER_TEXT_KEYS);
        if (t) return t;
      }
    }
  }
  return '';
}

/** What the current subtree is, and whether its members are HowTo steps. */
interface Context { source: string; step: boolean }

/**
 * Question/answer pairs from one parsed JSON-LD value.
 */
export function extractQA(data: unknown, opts: { maxPairs: number; maxAnswerChars: number }): QAPair[] {
  const out: QAPair[] = [];
  if (opts.maxPairs <= 0) return out;

  // JSON-LD is a GRAPH. Serialisers materialise the same node under two parents
  // when it is referenced by `@id`, and a node that references an ancestor
  // recurses until the stack gives out. Identity, not value: two distinct
  // objects with identical content are two real occurrences, and the question
  // dedup below is what decides whether both are kept.
  const seen = new Set<object>();

  // The same FAQ block is commonly emitted twice on one page — once by the CMS
  // and once by an SEO plugin — so the pairs must be deduplicated by what the
  // agent would read, case-insensitively, not by object identity.
  const questionsSeen = new Set<string>();

  const add = (question: string, answer: string, source: string): void => {
    if (!question || !answer) return;         // half a pair answers nothing
    const key = question.toLowerCase();
    if (questionsSeen.has(key)) return;
    const trimmed = answer.slice(0, opts.maxAnswerChars).trim();
    if (!trimmed) return;
    questionsSeen.add(key);
    out.push({ question, answer: trimmed, source });
  };

  const visit = (v: unknown, ctx: Context): void => {
    if (out.length >= opts.maxPairs) return;
    if (Array.isArray(v)) {
      // Top-level arrays of nodes are legal JSON-LD and common: one <script>
      // holding a page node, an organisation node and an FAQ node side by side.
      for (const x of v) visit(x, ctx);
      return;
    }
    if (!isObj(v) || seen.has(v)) return;
    seen.add(v);

    const types = typesOf(v);
    let source = ctx.source;
    for (const t of types) {
      const s = CONTAINER_SOURCES[t];
      if (s) source = s;
    }

    if (types.includes('Question')) {
      add(firstString(v, QUESTION_KEYS), answerOf(v), source || ORPHAN_SOURCE);
    } else if (types.includes('HowToStep') || ctx.step) {
      // A step is a question in disguise: "How do I renew it?" is answered by
      // the step named "Renew online" whose text is the instruction.
      add(firstString(v, STEP_QUESTION_KEYS), firstString(v, STEP_ANSWER_KEYS), source || STEP_SOURCE);
    }

    // Every property is descended, not just `mainEntity`. Questions turn up
    // under `@graph`, under `about`, under `hasPart` and nested inside other
    // questions' answers, and a walk keyed on one property name would see the
    // textbook example and miss the page.
    for (const [k, x] of Object.entries(v)) {
      visit(x, { source, step: source === STEP_SOURCE && STEP_KEYS.has(k) });
    }
  };

  visit(data, { source: '', step: false });
  return out.slice(0, opts.maxPairs);
}
