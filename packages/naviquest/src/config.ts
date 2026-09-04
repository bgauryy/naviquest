/**
 * Every tunable in one place, with the reason it has the value it has.
 *
 * These were scattered as literals across five modules: a 400-character snippet
 * cap in one, an 80-character row bound in another, a 0.5 term-share cut in a
 * third. Each one is a policy decision that a host may reasonably need to
 * change — a CJK site cannot live with `chars/4` token estimation, a dense
 * corpus may want longer chunks — and a literal buried in a hot function is not
 * a decision anyone can find, review, or override.
 *
 * Anything measured is cited. Anything arbitrary says so.
 */
import type { Affordance } from './types.ts';
import type { AgenticTuning } from './tools/agentic.ts';

/** Response ceilings, in estimated tokens. Truncation is always declared. */
import type { AdaptiveBudget } from './tools/budget.ts';
export type { AdaptiveBudget };

export interface Budgets {
  describe_app: number; find_on_page: number; locate_control: number;
  resolve_address: number; read_region: number; list_opaque_regions: number;
  agentic_content: number;
  query_selector: number;
}
export type ToolName = keyof Budgets;

export interface SegmentTuning { targetWords: number; maxWords: number }

export interface TextTuning {
  charsPerToken: number;
  maxConcatTokenLength: number;
  minConcatLength: number;
  /** Shortest token worth splitting on camel-hump / separator boundaries. */
  identifierMinLength: number;
  /** Shortest fragment kept from such a split. */
  identifierMinPart: number;
  /**
   * Match inflected forms in page CONTENT. Measured at 0% -> 82% recall@5 on
   * inflected queries across four live pages; see text.ts. `'auto'` applies a
   * stemmer when one exists for the page's language and does nothing when it
   * does not, which today means English only.
   */
  stemming: 'auto' | 'off';
}

export interface ProjectTuning {
  maxRowChars: number; headingMinFontPx: number; headingMinWeight: number;
  headingMinWeightFontPx: number; headingMaxChars: number;
  maxWrapperClimb: number;
  sliceMs: number;
  /**
   * Where the SDK looks for the primary-content partition when the host does not
   * set a strict root. Ordered most- to least-specific; the first match wins.
   *
   * `main` and `[role=main]` are the standard; `#root` / `#app` / `[data-app]`
   * are SPA mount-point conventions, which is a guess about a framework and
   * exactly the kind of list a host should be able to compose rather than fork.
   * `createNaviquest({ rootFallbacks })` still overrides it outright.
   */
  rootFallbacks: string[];
}

export interface DeltaTuning {
  history: number;
  /** Distinct tool-and-arguments keys retained. Keys embed agent-supplied
   *  strings, so without a bound an agent issuing N distinct queries retains N
   *  full payloads for the instance lifetime. Least-recently-written evicts. */
  maxTrackedKeys: number;
  /** Enable bounded semantic observations on describe_app. */
  semanticChanges: boolean;
  /** Semantic baselines retained per SDK instance. */
  semanticHistory: number;
  /** Maximum detailed changes returned before omission is declared. */
  maxSemanticChanges: number;
  /** After an action the page re-renders asynchronously; a mutation within this
   *  many ms of a describe_app call means it has NOT settled yet, so the response
   *  flags `settling` and the agent waits instead of reading a spinner as the
   *  outcome. Also true whenever any region is `aria-busy`. */
  settleQuietMs: number;
}

export interface InputTuning {
  /** Total characters of string content accepted in one tool call's arguments.
   *  Agent input is untrusted: an unbounded `selector` reaches querySelector and
   *  an unbounded `query` is echoed into continuations that no shrinker touches,
   *  so the boundary is enforced centrally rather than per field. Generous —
   *  legitimate inputs are copied addresses and short queries. */
  maxToolArgChars: number;
}

/**
 * Content the DOM text walk cannot see, because it is not text nodes.
 *
 * Each of these is authored, human-readable content that a walk over rendered
 * text misses entirely — and an agent asked "is the permit refundable?" does not
 * care that the answer lives in a `<script type="application/ld+json">` rather
 * than a `<p>`.
 */
export interface DiscoveryTuning {
  /**
   * Read `schema.org` JSON-LD. Pages routinely carry FAQ answers, product specs,
   * opening hours and event dates there and nowhere else in the document.
   * Only human-readable string values are indexed — never keys, URLs or ids —
   * because indexing `"@type": "Product"` matches every query about products.
   */
  structuredData: boolean;
  /** Keys whose values are machine identifiers, never prose. */
  structuredDataSkipKeys: string[];
  /** Characters of extracted structured data per block. A product feed is
   *  unbounded; a page's worth of answers is not. */
  maxStructuredDataChars: number;
  /**
   * Index content inside a closed `<details>`. It is real content the reader can
   * reach in one click, and an agent that cannot see it reports the page does
   * not answer a question it does answer. Results say `collapsed: true` and name
   * the disclosure control, so the agent knows to expand rather than assume.
   */
  collapsedContent: boolean;
  /**
   * Index the content of readable SAME-ORIGIN child frames into `find_on_page`,
   * with frame-qualified addresses that `resolve_address` re-enters. OFF by
   * default: measured on the open web, same-origin frames usually hold trivial
   * content while real content is cross-origin (unreachable by page JS). Turn it
   * ON for an app shell that frames its OWN content (an editor, a gallery, a
   * docs viewer) — describe_app's `unindexed-frame-documents` coverage gap is
   * the signal that this is such a page. Frame CONTROLS stay out of the control
   * index (their boxes are frame-relative), so this adds frame READING, not
   * frame clicking.
   */
  frames: boolean;
  /** Read `aria-description`, which is authored prose that no text node holds. */
  ariaDescription: boolean;
  /**
   * Keep schema.org question/answer PAIRS, not just the flattened prose.
   * `FAQPage` and `QAPage` state a question and its answer explicitly, which is
   * the only place on the web an answer is machine-identified as such — and
   * flattening it to a bag of sentences throws that away.
   */
  structuredQA: boolean;
  /** A support site's FAQPage can carry hundreds of pairs. */
  maxQAPairs: number;
  maxQAAnswerChars: number;
  /** `auto`: when the multimodal Prompt API is available, `describe_app({opaque:
   *  true, describe:true})` reads each unreadable canvas/image with the model
   *  instead of only reporting its box. Fail-open (no model → box-only). `off`
   *  disables the capability. Opt-in per call regardless — never automatic. */
  describeOpaque: 'auto' | 'off';
  /** Per-region budget for that read; a multimodal call is seconds, not ms. */
  describeTimeoutMs: number;
  /** Hard ceiling on ONE region's description. The prompt asks for a single
   *  sentence, but a model reply is untrusted output on an opaque-region list
   *  that can be dozens of entries long — the cap is what stops one verbose
   *  answer from consuming the whole `list_opaque_regions` ceiling. */
  describeMaxChars: number;
}

export interface AffordanceTuning {
  /** Strings so a host can override them from JSON; compiled once per projection. */
  patterns: Partial<Record<Affordance, string>>;
  /** The words injected into a control's index document when an affordance matches. */
  terms: Partial<Record<Affordance, string>>;
}

export interface LexicalTuning {
  /** Okapi BM25 term-frequency saturation. 1.2-2.0 is the published range. */
  k1: number;
  /** Length normalisation. 0.75 is canonical; 0 disables it entirely, which a
   *  corpus of uniformly short control names may genuinely want. */
  b: number;
  /** Reciprocal Rank Fusion constant. 60 is the RRF paper's value and the
   *  historical baseline recorded in docs/EVAL.md. Rebuild the ranking sensor
   *  before retuning it. */
  rrfK: number;
  /**
   * BM25F-lite: how many times a chunk's heading path is included in its
   * indexed document. 1 is plain prefixing — and it measurably loses: with the
   * heading present once, TF saturation lets body-text-rich sibling sections
   * outrank the section whose OWN heading matches the query ("Light reactions"
   * ranks "Light-dependent reactions" over "Light-independent reactions" and
   * drops the target from the top 5 entirely). Repetition is the classic
   * poor-man's field weighting: k1 saturates it, so it biases ties toward the
   * right section without letting a bare heading beat genuinely relevant prose.
   */
  headingWeight: number;
}

export interface AddressTuning {
  /** How many candidates an AMBIGUOUS resolution offers: enough to choose from,
   *  few enough that the agent does not give up and re-read the page. */
  ambiguousCandidates: number;
  /** How many nearest matches a NOT_FOUND resolution offers. */
  notFoundNearest: number;
  /** Depth of the last-resort CSS selector. Longer is more brittle, not less. */
  selectorMaxDepth: number;
}

export interface NonTextTuning {
  /**
   * Words that are not a description even when an author wrote them into `alt`.
   * WebAIM Million 2026: 10.8% of images WITH alt text carry questionable or
   * repetitive alt, and indexing that unfiltered is measurably worse than
   * indexing no images at all.
   *
   * These ship in English because the corpus they were derived from was English.
   * That is a limitation, not a design: a German `alt="bild"` and a Spanish
   * `alt="imagen"` are exactly as useless and this list will not catch either,
   * so a host must be able to extend it without forking the file.
   */
  placeholderWords: string[];
  /**
   * How a charting library is recognised: `name -> CSS selector`. Half the
   * ecosystem already emits rich text — Highcharts' export table, Vega's
   * per-mark aria-labels — and that text is a better description than any this
   * SDK could generate. Five libraries ship; a site using a sixth, or its own
   * in-house chart component, can name it here instead of being an opaque
   * region forever.
   */
  chartLibraries: Record<string, string>;
  /**
   * `library name -> CSS selector` for a library that renders its series as a
   * REAL HTML table next to the chart. That table is the best description a
   * chart can have — it is the data — so it is read instead of guessed at.
   *
   * Keyed by library rather than branched on in code: Highcharts' export-data
   * table was a hardcoded `if (lib === 'highcharts')`, which meant a host whose
   * library does the same thing could name the library in `chartLibraries` and
   * still not get its table read. A library absent from this map simply has no
   * data table, which is the common case.
   */
  chartDataTables: Record<string, string>;
  /** Where a chart's harvested text stops: fragments collected, characters
   *  kept, data-table rows read. Uncapped, one dashboard becomes the index. */
  maxChartFragments: number;
  maxChartChars: number;
  maxChartTableRows: number;
  /** How much of a rejected candidate to echo in an opaque-region record:
   *  enough to recognise, not enough to be mistaken for a description. */
  rejectedTextChars: number;
}

/**
 * Returning the SENTENCE that answers, not just the passage that contains it.
 *
 * `find_on_page` handed back a ~400-character chunk and left the agent to read
 * it. That is a retrieval result, not an answer, and it is the difference
 * between an SDK that helps an agent search and one that helps it respond.
 */
export interface AnswerTuning {
  /** Off returns passages only, exactly as before. */
  enabled: boolean;
  /** Share of the query's distinct terms a sentence must contain to be offered
   *  as the answer. Below this we return nothing: a weak guess is worse than no
   *  guess, because the agent will quote it verbatim. */
  minCoverage: number;
  /** A sentence shorter than this is a fragment — a list bullet, or "Yes." —
   *  and is merged with the one after it rather than returned alone. */
  minSentenceChars: number;
  /** Hard cap on the returned span. */
  maxAnswerChars: number;
  /** How close a query must be to a schema.org question before its answer is
   *  returned verbatim. High on purpose: quoting the wrong answer as if the page
   *  stated it is the worst failure this feature can have. */
  qaMinCoverage: number;
  /** `auto`: when the browser exposes the Prompt API, one yes/no call gates
   *  whether an extractive answer is ASSERTED — a sentence that echoes the
   *  question without answering it is downgraded to `unsupported` so the recovery
   *  hint fires. Fail-open: absent/unavailable → assert as if `off`. `off`
   *  disables it. It never makes assertion WORSE, only adds a reader. */
  verify: 'auto' | 'off';
  /** Ceiling on one STEADY-STATE verdict.
   *
   *  Unlike the Summarizer, this call sits on `find_on_page`'s critical path:
   *  every query with an answer candidate awaits it before the tool returns. So
   *  the bound is tight, and on timeout the reader yields `null` and the answer
   *  asserts exactly as it would with no reader at all.
   *
   *  MEASURED on the nano profile (`node eval/verify-measure.mjs` prints the
   *  per-verdict wall time): a warm yes/no verdict under a `responseConstraint`
   *  costs 302 ms and 267 ms; `clone()` itself is 0 ms. 3 s is ~10x headroom
   *  over that, and deliberately does NOT cover the cold path below. */
  verifyTimeoutMs: number;
  /** Ceiling on the ONE-OFF model warm-up, which runs off the critical path.
   *
   *  MEASURED: the FIRST `prompt()` against a fresh session costs 18,751 ms —
   *  Gemini Nano loading, not verdict latency. Charging that to a tool call is
   *  not an option, and bounding it at `verifyTimeoutMs` is worse than useless:
   *  every call aborts at 3 s, the abort cancels the load, the model never warms,
   *  and the reader fails open forever while reporting `available`. That
   *  starvation loop is what this second knob exists to prevent. The warm-up is
   *  therefore fired in the background and the verdict that triggered it is
   *  fail-open; this bound only guarantees a wedged warm-up terminates. */
  verifyWarmupTimeoutMs: number;
  /** `auto`: when the extractive path finds nothing assertable and the Prompt
   *  API is present, read the top retrieved regions' full text with the
   *  on-device model and answer from them — bridging the semantic/vocabulary
   *  gap BM25 cannot (curated synonym expansion and a key→value lane were both
   *  measured and rejected on this cluster). The reply is quote-verified against
   *  the regions, so it only ever quotes the page. Fail-open: absent/unavailable
   *  → nothing changes. `off` disables it. Shares one Gemini Nano session with
   *  the verifier. Built-in AI is off under automation, so this moves real
   *  Chrome-with-AI quality, not the offline/Playwright bench. */
  fromRegion: 'auto' | 'off';
  /** Ceiling on one STEADY-STATE region read. Looser than `verifyTimeoutMs`: a
   *  short-phrase generation is more tokens than a yes/no verdict. On timeout
   *  the reader yields null and `find_on_page` returns its passage result (or
   *  nothing) exactly as it would with no reader. */
  fromRegionTimeoutMs: number;
  /** Characters of joined top-region text handed to the model. Bounds prompt
   *  cost regardless of how large the retrieved chunks are. */
  fromRegionMaxChars: number;
  /** How many top-ranked regions to concatenate as the model's evidence. */
  fromRegionCount: number;
}

/**
 * Chrome's built-in Summarizer is a presentation lane over an already-grounded
 * tool result. These limits bound optional model work; they never change what
 * enters the deterministic index or what the unsummarized tool call returns.
 */
export interface SummaryTuning {
  /** Below this authored-text size, model latency cannot buy enough context
   *  reduction to justify generation and the deterministic payload is kept. */
  minInputTokens: number;
  /** One create/summarize operation may not hold an agent call forever. */
  timeoutMs: number;
  /** Leave headroom after a QuotaExceededError reports the model's exact ratio. */
  quotaSafetyRatio: number;
  /** A page requiring more model calls than this fails open to the raw payload. */
  maxChunks: number;
  /** Generated text is still untrusted and must remain response-sized. */
  maxOutputChars: number;
  /** Floor on a re-chunk computed from a QuotaExceededError ratio. A model that
   *  reports a tiny quota would otherwise produce hundreds of near-empty chunks,
   *  each paying a model call; the floor turns that into `maxChunks` fail-open. */
  minChunkChars: number;
}

export interface RetrievalTuning {
  snippetChars: number; selectorTextChars: number; maxRegionClimb: number; ambiguityRatio: number;
  commonTermShare: number; contentTermShare: number;
  confidenceHigh: number; confidenceMedium: number;
  fuzzyFloor: number; fuzzyCount: number; declineBelowTreeTokens: number;
  /**
   * Score multiplier (0..1) for a content passage that lives in a chrome
   * landmark — one of `navLandmarks` (nav / banner / contentinfo). BM25 rewards
   * term density, and a mega-menu or a footer is a dense pile of short
   * high-value nouns with no connecting prose: lexically ideal, semantically
   * chrome. This demotes it by a signal the PAGE declared (the landmark role),
   * not a guess, so a real answer buried under nav/footnote noise can surface.
   * 1 disables it. Applies to `find_on_page` content ranking only — a nav
   * CONTROL is a legitimate `locate_control` target and is never penalised.
   */
  chromePenalty: number;
  /**
   * Score multiplier (0..1) applied in proportion to how much of a passage is
   * recovered NON-TEXT (image alt text, chart descriptions). Alt text is a
   * description of a picture, not a claim the page makes, so ranking it beside
   * prose lets an agent quote decoration as fact. Scaled by the chunk's
   * non-text word fraction, so an all-image passage takes the full penalty and
   * a prose passage with one inline image is barely touched. 1 disables it.
   */
  imageAltPenalty: number;
  /**
   * Score multiplier (0..1) applied to passages under a citation / back-matter
   * heading (References, Bibliography, See also, External links, …). These
   * repeat the article's topic vocabulary densely, so they out-rank the one
   * sentence that answers even though they only CITE it. A declared signal (the
   * authored section heading), soft like the others — the citation stays
   * findable, just not ahead of prose. 1 disables it.
   */
  citationPenalty: number;
  /**
   * Section headings that mark citation / back-matter, matched locale-folded
   * against a passage's heading path to trigger `citationPenalty`. English by
   * default; a non-English host EXTENDS it (`(base) => [...base, 'références',
   * 'weblinks']`) rather than forking — the same ArrayOverride the other word
   * lists use, so the demotion does not silently no-op off English.
   */
  citationHeadings: string[];
  /**
   * Cross-language query bridge (RFC-04). `'auto'`: when the query's detected
   * language differs from the page's, translate the query with Chrome's
   * Translator and fuse a second same-language BM25 pass (RRF) so foreign-
   * language evidence is retrievable. Only the QUERY crosses the boundary;
   * quotations stay in the page's language. `'off'` (default) disables it.
   * Fail-open and Window-only. OFF by default pending a real-Translator quality
   * and same-language non-regression measurement.
   */
  crossLanguage: 'off' | 'auto';
  /** Deadline for one detect/translate call; fail-open on timeout. */
  crossLanguageTimeoutMs: number;
  /** Minimum language-detection confidence before trusting a cross-language
   *  translation (a short query gives a weak guess that is not worth acting on). */
  crossLanguageMinConfidence: number;
  /** How many controls a passage offers, ranked by relevance to the query. */
  actionablePerResult: number;
  /** Characters of a pathless region's own text used to identify it, since it
   *  has no heading to be named by. */
  anchorTextChars: number;
  /**
   * Landmarks whose controls take you SOMEWHERE rather than doing something.
   *
   * The one classification here the ARIA taxonomy cannot supply: "is this
   * navigation" is a judgement about intent, not a fact about role inheritance,
   * so unlike LANDMARKS and INTERACTIVE it stays authored — but authored HERE,
   * where a host can change it, rather than frozen in a module constant. A site
   * whose `complementary` sidebar is its primary nav needs exactly that.
   */
  navLandmarks: string[];
  /** Chunks sampled to detect the page's script for the token estimate. */
  scriptSampleChunks: number;
  /** Characters of that sample actually examined. */
  scriptSampleChars: number;
  /**
   * Bands describe_app reports as good/mixed/low structural engagement. These
   * are a JUDGEMENT about someone else's markup, which is exactly the kind of
   * policy that should not be a ternary buried in a response builder.
   */
  structuralGoodPct: number;
  structuralMixedPct: number;
  /**
   * Below this structural-engagement %, describe_app advises reading the page
   * directly REGARDLESS of size. Size was the wrong predictor: measured, the
   * tools underperformed on large, weakly-structured commercial pages (Stripe
   * 10%, PayPal dev 22%) that `declineBelowTreeTokens` never flagged because
   * they are not small. This changes advice only, never retrieval, so it cannot
   * make an answer worse — only warn before the agent pays to lose.
   */
  declineBelowStructuralPct: number;
  qsAttributes: string[];
  /** Exact/scope pagination snapshots retained per SDK instance. */
  selectorCursorEntries: number;
}

/** Caps for the optional `createNaviquest({ orientation })` overlay. Arbitrary; do not raise describe_app's 900 budget to fit copy. */
export interface OrientationTuning {
  maxTokens: number;
  maxTasks: number;
  maxPurposeChars: number;
  maxConstraintChars: number;
  /** Per-task CSS selector cap. Same grammar as `exclude[]`; never slice. */
  maxLocateChars: number;
  maxViewChars: number;
}

/**
 * How an OVER-BUDGET payload is shrunk toward its ceiling, and the caps applied
 * to a response's text on the way out.
 *
 * These governed the shape of every truncated response while sitting as literals
 * in tools.ts, which made the one policy the budget shrinkers share invisible to
 * the host that pays for it. `budgets` is tunable; the behavior when a budget is
 * exceeded now is too.
 */
export interface ResponseTuning {
  /**
   * The `halve` of prose: what fraction of a too-long text field survives one
   * shrink step. Below 1 so shrinking terminates; 0.6 converges in a few steps
   * without collapsing a passage to a fragment in one.
   */
  textKeepRatio: number;
  /** Floor for a region's text, so shrinking a `resolve_address` region toward
   *  fit cannot reduce it below a readable amount. */
  regionTextFloorChars: number;
  /** The same floor for FETCHED site text, which is a whole document and can
   *  afford — and needs — a larger one than a page region. */
  fetchedTextFloorChars: number;
  /** Diff shrink attempts before the whole `changed` bag is dropped by name. */
  maxDiffSteps: number;
  /** A live-region outcome is a bounded OBSERVATION ("Saved", "3 errors"), not a
   *  passage. Anything longer is a region to read, not an outcome to report. */
  outcomeChars: number;
}

export interface Tuning {
  budgets: Budgets; adaptiveBudget: AdaptiveBudget; segment: SegmentTuning; text: TextTuning;
  project: ProjectTuning; delta: DeltaTuning; lexical: LexicalTuning;
  discovery: DiscoveryTuning; input: InputTuning;
  address: AddressTuning; nonText: NonTextTuning;
  affordance: AffordanceTuning; retrieval: RetrievalTuning; answer: AnswerTuning;
  summary: SummaryTuning; agentic: AgenticTuning;
  orientation: OrientationTuning; response: ResponseTuning;
}

/**
 * An array tunable may be REPLACED with a new array, or EXTENDED with a function
 * that receives the shipped default and returns the list to use.
 *
 * Replacement alone was a rigidity this file argues against in its own header.
 * `resolveConfig`'s deep merge treats an array as a leaf — correct, because a
 * host that wants to NARROW a list must be able to — so the only way to add one
 * German word to `nonText.placeholderWords` was to restate all 27 English ones,
 * and the next SDK release then silently dropped whatever was added upstream.
 * That is precisely the fork-the-file outcome the comment on that list says a
 * non-English host must not be pushed into.
 *
 * So: pass an array to replace, pass a function to compose.
 *
 *   tuning: { nonText: { placeholderWords: (base) => [...base, 'bild', 'imagen'] } }
 *   tuning: { agentic:  { paths: ['/llms.txt'] } }            // still replaces
 *
 * The function form is the type-safe one — no `'key+'` string convention to
 * misspell, and the base is handed in rather than imported, so a host cannot
 * accidentally compose against a stale copy of the default.
 */
export type ArrayOverride<T> = T | ((base: T) => T);

/** What a host may override — any subset, at any depth. */
export type PartialTuning = {
  [K in keyof Tuning]?: {
    [P in keyof Tuning[K]]?: Tuning[K][P] extends readonly unknown[]
      ? ArrayOverride<Tuning[K][P]>
      : Tuning[K][P];
  };
};

export const DEFAULTS: Tuning = {
  /** Response ceilings, in estimated tokens. Truncation is always declared. */
  budgets: {
    describe_app: 900,
    find_on_page: 1200,
    locate_control: 600,
    // Its own ceiling. It used to borrow locate_control's, which made one tool's
    // limit a side effect of another's.
    resolve_address: 500,
    // Not tools any more — the MODES their tools dispatch to. `read_region` is
    // resolve_address's region-expansion path (a section of text needs a far
    // bigger ceiling than a box-and-state reply); `list_opaque_regions` is
    // describe_app's `opaque: true` mode. The keys keep their old names so the
    // ceilings stay independently tunable per mode.
    read_region: 2000,
    list_opaque_regions: 700,
    // A site manifest is a list of titles, so `list` is cheap; `read` returns a
    // whole document and is the one call here that can be large. Sized for read,
    // because a budget that only fits the cheap intent makes the useful one
    // arrive pre-truncated.
    agentic_content: 2000,
    // A selector can match 200 elements. The ceiling is what stops an agent
    // writing `div` and paying for the page it was trying not to download.
    query_selector: 1200,
  },

  /**
   * Scale every ceiling above to the page actually being described.
   *
   * See budget.ts § AdaptiveBudget for the measurement. `share` at 0.4 means a
   * single tool response may cost at most 40% of what reading the whole page
   * would have — three of them then land near one full read in the worst case
   * and well under it whenever the page is larger than the fixed table.
   *
   * `floor` at 350 is where a response can still carry an answer, an address and
   * a declared truncation. Below that the honest answer is not a smaller payload
   * but `describe_app`'s existing `recommendation` that this page is too small
   * to be worth querying at all.
   */
  adaptiveBudget: {
    enabled: true, share: 0.4, floor: 350,
    // The former fixed 12-step guard was reached on NHS search while the
    // shrinker was still making useful progress. Lists now halve, and 24 leaves
    // room to trim nested action/text fields before honestly declaring overage.
    maxShrinkSteps: 24,
  },

  segment: {
    /** Target and hard cap for a chunk, in words. 200 is the published
     *  fixed-window baseline (Vectara, NAACL 2025); 90 keeps a typical
     *  heading-scoped section in one piece. */
    targetWords: 90,
    maxWords: 200,
  },

  text: {
    /** Estimated tokens per character. 4 is the usual English approximation and
     *  is roughly 2x wrong for CJK, which this SDK explicitly supports — so it
     *  is a per-host setting, not a constant. */
    charsPerToken: 4,
    /** Adjacent-token concatenation ("log in" -> "login") applies only to short
     *  tokens; longer ones produce noise, not affordance spellings. */
    maxConcatTokenLength: 6,
    minConcatLength: 4,
    /**
     * Identifier splitting — `registerTool` -> `register`, `tool`.
     *
     * These two were the last length literals in the retrieval hot path, and
     * they sat in `text.ts` while the two thresholds for the NEIGHBOURING
     * concatenation feature (above) were already here. Same module, same kind of
     * judgement, opposite treatment.
     *
     * Both are calibrated on Latin-script identifiers: 6 characters before a
     * token is worth splitting at all, 3 before a fragment is worth keeping. A
     * host indexing a language whose words are 1-3 characters, or one whose code
     * identifiers are not camelCase, has no reason to inherit either number.
     */
    identifierMinLength: 6,
    identifierMinPart: 3,
    stemming: 'auto',
  },

  project: {
    /** A row's text is identity only while it stays row-sized. Hacker News wraps
     *  its entire header in one <td>; a truncated prefix of that is noise. */
    maxRowChars: 80,
    /** A <div> is treated as a heading at this computed size/weight. 30.6% of
     *  pages style headings this way rather than marking them up. */
    headingMinFontPx: 19,
    headingMinWeight: 600,
    headingMinWeightFontPx: 16,
    /** Longest single-line text still eligible to be an inferred heading. */
    headingMaxChars: 90,
    /** How far to climb looking for a heading's real scope through wrapper
     *  elements (`<div class="mw-heading"><h2>`). */
    maxWrapperClimb: 3,
    rootFallbacks: ['main', '[role=main]', '#main', '#root', '#app', '[data-app]'],
    /** Milliseconds of projection work before the main thread is handed back.
     *  Read ONLY by `projectAsync`, which only the worker lane takes; the
     *  default inline lane still projects in one synchronous task, because its
     *  tools are synchronous (§ W1). 8 ms fits inside a 16.7 ms frame, so a
     *  slice cannot itself be the long task the 50 ms guardrail is watching for
     *  — and nothing below the cost of the slowest single element buys anything,
     *  since a slice always overruns by the frame it was in the middle of. */
    sliceMs: 8,
  },

  /** Delta observations (ETag semantics for page state). */
  delta: {
    /** How many prior payloads to remember per tool, so `since` can be answered
     *  with a field-level diff instead of a full re-send. */
    history: 4,
    /** 64 distinct keys × `history` payloads bounds retention at a size an
     *  agent's genuine re-queries fit in comfortably; past it the oldest key is
     *  the one least likely to receive a `since`. Arbitrary, not measured. */
    maxTrackedKeys: 64,
    semanticChanges: true,
    semanticHistory: 4,
    maxSemanticChanges: 32,
    // 250 ms: long enough to still be "settling" through a normal SPA re-render
    // burst, short enough that a genuinely idle page reads as settled at once.
    settleQuietMs: 250,
  },

  input: {
    /** 16 KB: an order of magnitude above the largest legitimate call observed
     *  (a copied address plus a long query is well under 2 KB), and small enough
     *  that a prompt-injected megabyte string cannot become a selector parse,
     *  a delta-history key, or an echoed continuation. Arbitrary, not measured. */
    maxToolArgChars: 16_384,
  },

  /**
   * What a control DOES, when its name will not say. Patterns are STRINGS so a
   * host can override them from JSON, and they are case-insensitive.
   *
   * These ship in English because the corpus they were derived from was English.
   * That is a limitation, not a design: this SDK indexes CJK, Thai and RTL text
   * and then decides affordances with these, so a non-English host has to be able
   * to extend them without forking the file. `terms` are the words injected into
   * the control's index document when an affordance matches — short and specific,
   * because long lists make every control match everything.
   */
  affordance: {
    patterns: {
      'pagination-next': '^(more|next|older|newer|next page|show more|load more|see more|continue|»|›|→|>>)$',
      'pagination-prev': '^(prev|previous|back|newer|earlier|«|‹|←|<<)$',
      'language-switcher': '\\b\\d+\\s+languages?\\b|^languages?$|^language\\b|\\btranslate\\b|\\bidioma\\b|\\bsprache\\b',
      search: '\\bsearch\\b|\\bfind\\b|^q$',
      submit: '\\b(submit|send|save|confirm|checkout|pay|apply|place order|sign up|register)\\b',
      'add-to-cart': '\\badd to (bag|cart|basket)\\b|\\bbuy now\\b',
      destructive: '\\b(delete|remove|clear|discard|unsubscribe|deactivate)\\b',
    },
    terms: {
      'pagination-next': 'next page pagination forward more',
      'pagination-prev': 'previous page pagination back',
      'language-switcher': 'language translate locale',
      'primary-input': 'input field type enter primary',
      search: 'search find query',
      submit: 'submit send confirm',
      'add-to-cart': 'add cart bag basket buy',
      toggle: 'toggle tick mark switch',
      destructive: 'delete remove clear',
      external: 'external new window',
      // `discloses` was emitted by affordance.ts (via aria-controls and
      // popovertarget) and part of the shipped vocabulary, but had no entry here —
      // so it was FILTERABLE and not RETRIEVABLE. `locate_control({ affordance:
      // 'discloses' })` worked; "the control that opens the details" could not
      // reach it, because no term in the query appeared in the control's index
      // document. That is the exact failure the affordance layer exists to fix,
      // in the one affordance nobody gave words to.
      discloses: 'expand open reveal show disclose collapse details',
    },
  },

  /**
   * Site-level agent content. See agentic.ts for why this is one tool rather
   * than three, and why every path is same-origin.
   */
  agentic: {
    enabled: true,
    /** `llms.txt` first: it is the index. `llms-full.txt` is the same content
     *  inlined and is enormous, so it is a fallback rather than a preference. */
    paths: ['/llms.txt', '/llms-full.txt'],
    /** 512 kB. Larger than any real index, smaller than a book. */
    maxBytes: 512 * 1024,
    timeoutMs: 4000,
    maxReadChars: 20000,
  },

  /**
   * Optional first-party describe_app overlay. Applied BEFORE budget('describe_app')
   * so a novel cannot eat the outline. 180 tokens is arbitrary; measure CityDesk
   * before raising it, and never raise budgets.describe_app to compensate.
   */
  orientation: {
    maxTokens: 180,
    maxTasks: 6,
    maxPurposeChars: 280,
    maxConstraintChars: 160,
    maxLocateChars: 80,
    maxViewChars: 80,
  },

  response: {
    textKeepRatio: 0.6,
    regionTextFloorChars: 200,
    fetchedTextFloorChars: 400,
    // Eight, because the shrinker halves the bag each step: eight halvings take
    // any realistic `changed` set to one entry, and a page still over budget
    // after that is mutating faster than a diff can describe it.
    maxDiffSteps: 8,
    outcomeChars: 300,
  },

  discovery: {
    structuredData: true,
    // `@`-prefixed JSON-LD keywords, plus the keys that hold identifiers rather
    // than prose. `name` and `description` and `text` are exactly what we want.
    structuredDataSkipKeys: ['@context', '@id', '@type', 'url', 'sameAs', 'image',
                             'logo', 'contentUrl', 'thumbnailUrl', 'identifier'],
    maxStructuredDataChars: 2000,
    collapsedContent: true,
    frames: false,
    ariaDescription: true,
    structuredQA: true,
    maxQAPairs: 50,
    maxQAAnswerChars: 600,
    describeOpaque: 'auto',
    // 30 s: the FIRST multimodal call pays a one-time ~22 s model load (measured,
    // eval/describe-measure.mjs); warm calls are ~1–2 s. Opt-in and documented
    // slow, so a budget that clears the cold load beats a fail-open that returns
    // box-only exactly when the agent asked to read the pixels.
    describeTimeoutMs: 30000,
    describeMaxChars: 300,
  },

  answer: {
    enabled: true,
    minCoverage: 0.5,
    minSentenceChars: 25,
    maxAnswerChars: 400,
    qaMinCoverage: 0.75,
    verify: 'auto',
    verifyTimeoutMs: 3_000,
    // 60 s against a measured 18.75 s cold load: generous on purpose, because
    // this bound is a termination guarantee and not a latency budget. Nothing
    // waits on it.
    verifyWarmupTimeoutMs: 60_000,
    fromRegion: 'auto',
    // Looser than the 3 s verdict: a short-phrase generation from several
    // regions is more tokens. Only fires when the extractive path found nothing,
    // i.e. a hard query the SDK otherwise answers `unsupported` — so a bounded
    // one-off wait to actually answer it is the better trade.
    fromRegionTimeoutMs: 10_000,
    // 8 regions / 7 000 chars MEASURED (eval/region-measure.mjs, nano profile):
    // reading the top 8 of the FULL ranked list — not the paginated first page —
    // took the semantic-wall cluster 2→5, where the first-page-only top 4 got
    // 2→3. The answering region for a vocabulary-gap question routinely ranks
    // below the fold, so recall here is what pays.
    fromRegionMaxChars: 7_000,
    fromRegionCount: 8,
  },

  summary: {
    // The summary envelope keeps grounding and a raw-recovery call, so tiny
    // inputs cannot become meaningfully cheaper. The deterministic sensor's
    // 61-character response paid one model call and still grew; 64 estimated
    // tokens is a conservative floor, not a claim about Chrome model latency.
    minInputTokens: 64,
    // On-device generation is slower than retrieval, but a browser tool that
    // occupies a turn for minutes is unusable. The timeout bounds each model
    // call, not a model download, which remains browser/user controlled.
    timeoutMs: 30_000,
    // A quota ratio is exact for the rejected request but tokenisation overhead
    // is implementation-defined. Twenty percent headroom avoids retrying at the
    // same boundary without making chunks needlessly small.
    quotaSafetyRatio: 0.8,
    // Summary-of-summaries is linear in this number. Twelve covers long articles
    // while placing a hard ceiling on main-window model work.
    maxChunks: 12,
    // Chrome's short default should be far smaller; this is a defensive ceiling
    // against an implementation or model returning an unexpectedly long result.
    maxOutputChars: 1200,
    minChunkChars: 256,
  },

  lexical: { k1: 1.5, b: 0.75, rrfK: 60, headingWeight: 3 },

  address: { ambiguousCandidates: 6, notFoundNearest: 5, selectorMaxDepth: 6 },

  nonText: {
    placeholderWords: [
      'image', 'images', 'img', 'graphic', 'graphics', 'photo', 'photograph', 'picture', 'pic',
      'blank', 'spacer', 'untitled', 'alt', 'thumbnail', 'thumb', 'banner', 'icon', 'logo',
      'placeholder', 'decoration', 'decorative', 'null', 'none', 'undefined', 'empty',
    ],
    chartLibraries: {
      highcharts: '.highcharts-container, [class*="highcharts"]',
      recharts: '.recharts-wrapper',
      vega: '[class*="vega"]',
      echarts: '[_echarts_instance_]',
      plotly: '.js-plotly-plot',
    },
    chartDataTables: {
      // Highcharts' export-data module is the one shipped library that renders
      // its series as an adjacent HTML table.
      highcharts: 'table.highcharts-data-table, table[class*="data-table"]',
    },
    maxChartFragments: 60,
    maxChartChars: 1200,
    maxChartTableRows: 40,
    rejectedTextChars: 60,
  },

  retrieval: {
    navLandmarks: ['navigation', 'banner', 'contentinfo'],
    /** Characters of chunk text returned per hit before the budget shrinker
     *  gets involved. */
    snippetChars: 400,
    /**
     * Characters of `query_selector` per-row text.
     *
     * Rows are that tool's only pagination unit and its shrinker floors at one
     * row, so an uncapped row could never be shrunk: `fields:['text']` on a
     * large element returned the whole thing and merely flagged `_overBudget`.
     * Measured on the contract fixture at 9,799 chars / 2,611 tokens against a
     * 1,200-token ceiling — the exact "paying for the page it was trying not to
     * download" the query_selector budget comment exists to prevent.
     *
     * 1,200 chars is ~300 tokens: large enough to read a real section in one
     * call, small enough that several rows still fit under the ceiling and the
     * row shrinker can always converge. Reading past it is `resolve_address`,
     * which owns paginated full text (`textOffset`) and a bigger ceiling.
     */
    selectorTextChars: 1200,
    /** How far to climb from a chunk's own container looking for the controls
     *  that belong to it. Bounded, or two pathless sibling <div>s both resolve
     *  to <main> and every result offers every control on the page. */
    maxRegionClimb: 3,
    /** locate_control declares ambiguity on a RATIO, not a difference: BM25
     *  scores are unnormalised and scale with idf and query length. */
    ambiguityRatio: 0.85,
    /**
     * Which attributes query_selector's `attributes` field returns. A trailing
     * `-` matches as a prefix. This is a JUDGEMENT about which attributes carry
     * agent-relevant semantics, not a spec fact — a host whose framework hangs
     * state off `data-state` or `data-testid` has every right to add it, and it
     * shipped as a hardcoded if-chain in the tool body until this line.
     */
    qsAttributes: ['aria-', 'id', 'type', 'role', 'name', 'href'],
    /**
     * Exact CSS can inspect unobserved documents, so its cursor must retain the
     * ordered identity population rather than trust a collision-prone short
     * hash. Bound the retained live-node snapshots: they exist only to protect
     * active pagination trajectories, not as another DOM index.
     */
    selectorCursorEntries: 64,
    /** A query term present in more than this share of CONTROL documents carries
     *  no information about which control is meant. Controls are a handful of
     *  short strings, so the ceiling is loose on purpose. */
    commonTermShare: 0.5,
    /**
     * The same judgement for CONTENT chunks, which are a different corpus with
     * different statistics — the argument bm25.ts makes about `k1`/`b`, applied
     * to the one place it had not been.
     *
     * Sharing 0.5 with the control index was a measured defect. On the demo
     * page's 46 chunks:
     *
     *   and 0.80 · the 0.74 · a 0.54 · of 0.48 · in 0.33 · to 0.30 · is 0.30
     *   rebate 0.20 · waste 0.15 · permit 0.07 · discount 0.02
     *
     * A 0.5 ceiling removes `and`, `the` and `a` and keeps `of` — so the query
     * "of" matched a sentence containing it, scored coverage 1.00, and was
     * quoted back as what the page says. So did "to", "in" and "is".
     *
     * Function words sit at share >= 0.30 here and content words at <= 0.20, and
     * the value below is chosen inside that gap. It is EMPIRICAL and says so: a
     * parameter-free alternative was tried first — gate the answer on summed idf
     * against `ln(n)`, the self-information needed to identify one chunk in n —
     * and it historically measured 1/10 against 5/10, because a correct
     * short sentence often matches only one content term. Elegance lost to the
     * recorded sweep. Rebuild that sensor before changing this threshold.
     */
    contentTermShare: 0.25,
    /** Confidence bands over informative-term coverage. Measured against 35
     *  labelled lookups this signal separates correct from wrong by 0.18; the
     *  dense cosine separates them by 0.35, so these bands are the lexical-only
     *  fallback and should be replaced when the dense lane lands. */
    confidenceHigh: 0.6,
    confidenceMedium: 0.34,
    /** Character-trigram Dice floor for the no-match fallback. Arbitrary: low
     *  enough to surface something, high enough not to surface everything. */
    fuzzyFloor: 0.12,
    /** How many closest names to offer when nothing matched lexically. */
    fuzzyCount: 3,
    /** Below this, the whole accessibility tree is cheaper than querying it, and
     *  describe_app says so instead of pretending to be the frugal option. */
    declineBelowTreeTokens: 2000,
    // 0.35: enough to sink a dense chrome block beneath a single answering
    // sentence, verified by the `--only rank` lane's chrome-vs-content fixture.
    // Not 0 — chrome may hold the only copy of a fact, so it stays findable.
    chromePenalty: 0.35,
    // 0.4 at full non-text fraction: sinks an alt-text-only passage beneath the
    // prose that answers, verified by the `--only rank` image-alt fixture.
    imageAltPenalty: 0.4,
    // 0.5: sinks a References/See-also pile below the prose that answers, while
    // keeping the citation findable. Verified by the `--only rank` citation
    // fixture; it was accepted on live-page inversions (Linux mascot / Python
    // designer) measured by a gold-substring harness that has since been
    // deleted, so the end-to-end half of that evidence is historical.
    citationPenalty: 0.5,
    citationHeadings: ['references', 'reference', 'bibliography', 'citations', 'citation', 'notes',
      'footnotes', 'sources', 'external links', 'further reading', 'see also', 'works cited'],
    // OFF by default: the mechanism is validated (eval/cross-language.mjs) but
    // shipping it on needs a real-Translator quality + non-regression measurement.
    crossLanguage: 'off',
    crossLanguageTimeoutMs: 4_000,
    crossLanguageMinConfidence: 0.5,
    actionablePerResult: 3,
    anchorTextChars: 48,
    scriptSampleChunks: 40,
    scriptSampleChars: 4000,
    /** 60/25 are judgement calls about markup quality, not measurements. They
     *  live here so they can be argued with. */
    structuralGoodPct: 60,
    structuralMixedPct: 25,
    /** Same boundary as `structuralMixedPct` today — below "mixed" IS "low" — but
     *  a separate knob because the decline threshold is a different judgement
     *  from the display band and should move independently. */
    declineBelowStructuralPct: 25,
  },
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Deep-merge a host's partial overrides over DEFAULTS. Never mutates either —
 *  and never ALIASES either: every nested object and array in the result is a
 *  fresh copy. A shallow `{...base}` shared the un-overridden subtrees with the
 *  module-level DEFAULTS, so an instance that wrote a detected value (the
 *  script-density `charsPerToken` adjustment) silently rewrote the exported
 *  default for every later instance and every module-level fallback. */
export function resolveConfig(overrides: PartialTuning = {}): Tuning {
  // structuredClone, not a hand-rolled deep copy: DEFAULTS is pure data (no
  // functions), and this is the same primitive index.ts already uses.
  const clone = <T>(v: T): T => (v == null || typeof v !== 'object' ? v : structuredClone(v));
  const merge = (base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> => {
    const out = clone(base) as Record<string, unknown>;
    for (const [k, v] of Object.entries(over ?? {})) {
      const b = base[k];
      // An ArrayOverride: hand the shipped default in and take what comes back.
      // Guarded so a thrown or malformed composer degrades to the default rather
      // than to a broken config — a host's typo must not disable the tokenizer.
      if (typeof v === 'function') {
        try {
          const next = (v as (x: unknown) => unknown)(Array.isArray(b) ? [...(b as unknown[])] : b);
          if (next !== undefined) out[k] = clone(next);
        } catch { /* keep the default */ }
        continue;
      }
      if (isObj(v) && isObj(b)) out[k] = merge(b, v);
      // Cloned for the same isolation as the defaults: a host that mutates the
      // object it passed in must not be mutating a live config.
      else if (v !== undefined) out[k] = clone(v);
    }
    return out;
  };
  const resolved = merge(DEFAULTS as unknown as Record<string, unknown>,
                         overrides as Record<string, unknown>) as unknown as Tuning;
  /**
   * Tool schemas do not validate host-side tuning, so a malformed VALUE (right
   * type, poison magnitude) is restored to the shipped default here rather than
   * becoming NaN/Infinity arithmetic three modules away. Concretely:
   * `charsPerToken: 0` makes every token estimate Infinity and every budget
   * unsatisfiable; a NaN penalty poisons the ranking sort comparator; a NaN
   * timeout THROWS inside `AbortSignal.timeout` on a fail-open AI path and looks
   * like an absent model rather than a bad override; a `textKeepRatio` at or
   * above 1 makes the text shrinker a no-op so an over-budget payload never
   * converges; and a NaN character cap turns `slice(0, NaN)` into silent data
   * loss. Each of these guards was written out by hand, nineteen times, in three
   * spellings of the same check — one table is both smaller in the eager bundle
   * and the only place the policy can drift.
   *
   * Three kinds, because the legal range genuinely differs:
   *  - `counts` are positive safe integers (a zero cap is a disabled cap);
   *  - `sizes` are non-negative safe integers (zero is meaningful: no delay,
   *    no tracked changes);
   *  - `ratios` are finite non-negative numbers, with an optional exclusive
   *    lower bound and upper bound for the values that are shares or fractions.
   */
  const int = Number.isSafeInteger, fin = Number.isFinite;
  const fix = (group: object, defaults: object, keys: string, ok: (v: number) => boolean): void => {
    const g = group as Record<string, number>, d = defaults as Record<string, number>;
    // Space-separated so each rule is one string literal rather than an array of
    // them: this whole function is eager on every `createNaviquest`.
    for (const k of keys.split(' ')) if (typeof g[k] !== 'number' || !ok(g[k])) g[k] = d[k];
  };
  const pos = (v: number): boolean => int(v) && v > 0;
  fix(resolved.delta, DEFAULTS.delta, 'semanticHistory maxTrackedKeys', pos);
  fix(resolved.input, DEFAULTS.input, 'maxToolArgChars', pos);
  fix(resolved.response, DEFAULTS.response,
      'regionTextFloorChars fetchedTextFloorChars maxDiffSteps outcomeChars', pos);
  fix(resolved.summary, DEFAULTS.summary, 'minChunkChars', pos);
  fix(resolved.discovery, DEFAULTS.discovery, 'describeTimeoutMs describeMaxChars', pos);
  fix(resolved.answer, DEFAULTS.answer,
      'verifyTimeoutMs verifyWarmupTimeoutMs fromRegionTimeoutMs fromRegionMaxChars', pos);
  fix(resolved.retrieval, DEFAULTS.retrieval, 'crossLanguageTimeoutMs', pos);
  fix(resolved.delta, DEFAULTS.delta, 'settleQuietMs maxSemanticChanges', (v) => int(v) && v >= 0);
  // 0 excludes chrome entirely and >1 would boost it; both are legal choices.
  fix(resolved.retrieval, DEFAULTS.retrieval, 'chromePenalty imageAltPenalty citationPenalty',
      (v) => fin(v) && v >= 0);
  fix(resolved.adaptiveBudget, DEFAULTS.adaptiveBudget, 'floor', (v) => fin(v) && v >= 0);
  // Shares: strictly above 0, at most 1.
  const share = (v: number): boolean => fin(v) && v > 0 && v <= 1;
  fix(resolved.adaptiveBudget, DEFAULTS.adaptiveBudget, 'share', share);
  fix(resolved.retrieval, DEFAULTS.retrieval, 'crossLanguageMinConfidence', share);
  // Strictly below 1, or the text shrinker never converges.
  fix(resolved.response, DEFAULTS.response, 'textKeepRatio', (v) => fin(v) && v > 0 && v < 1);
  fix(resolved.text, DEFAULTS.text, 'charsPerToken', (v) => fin(v) && v > 0);
  return resolved;
}
