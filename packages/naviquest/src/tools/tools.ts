/**
 * The six tools, and the helpers that only they use.
 *
 * `index.ts` owns the LIFECYCLE — root resolution, the retrieval lane, when to
 * rebuild, registering with WebMCP. This file owns the ANSWERS. They were one
 * 1,362-line module, which meant the things an agent can ask sat in the same
 * scope as the AbortController that tears them down.
 *
 * The split is by dependency, not by line count. Nothing here touches the
 * document, the worker, or `document.modelContext`: every tool reads a
 * projection that already exists and writes a payload. What changes per rebuild
 * arrives in one mutable `IndexState` that `reindex()` assigns into, so a tool
 * always reads the current index without a getter on every field.
 */
import { regionOf } from '../retrieval/segment.ts';
import { excludedDeep, isActionableElement } from '../page/project.ts';
import { readingOrderText } from '../page/page-text.ts';
import { etag } from '../retrieval/text.ts';
import { chain } from '../async.ts';
import { confidenceFor, coverageOf, discriminates } from '../retrieval/ranking.ts';
import { addressOf, resolve, selectorOfLastResort, samePath } from './address.ts';
import { modalState, detectModal } from '../page/modality.ts';
import { statesOf, roleOf } from '../page/roles.ts';
import { controlDoc, vocabularyOf } from '../page/affordance.ts';
import { extractAnswer } from '../retrieval/answer.ts';
import { createVerifier } from '../ai/verifier.ts';
import { createAnswerer } from '../ai/answerer.ts';
import { createLmSession } from '../ai/lm-session.ts';
import { createTranslator } from '../ai/translator.ts';
import { rrf } from '../retrieval/bm25.ts';
import { createImageDescriber } from '../ai/image-describer.ts';
import { coverageNote } from './coverage.ts';
import { ORIENTATION_SECTIONS, QS_FIELDS, QUERY_VIEWS } from './tool-specs.ts';
import { loadManifest, readDoc, rankDocs } from './agentic.ts';
import type { AgenticIntent, AgenticManifest } from './agentic.ts';
import { headingNodeIndex, outlineKey, treeTokens as computeTreeTokens } from './structure.ts';
import { makeExactFold } from '../retrieval/exact.ts';
import type { Fold } from '../retrieval/exact.ts';
import { createSemanticLedger } from './semantic-delta.ts';
import type { SemanticSnapshot } from './semantic-delta.ts';
import type { AnswerSpan } from '../retrieval/answer.ts';
import type { PageStructure } from './structure.ts';
import type { Budgeter, Shrink, ToolPayload } from './budget.ts';
import type { DeltaStore } from './delta.ts';
import { boxOf } from '../types.ts';
import { flatClosest, flatContains, idRefTarget, queryScopes } from '../page/dom.ts';
import type { Address, Chunk, Hit, ProjectedNode, Projection, QAPair, Resolution, RetrievalLane, Segmentation, States } from '../types.ts';
import type { ToolName, Tuning } from '../config.ts';
import type { Awaitable, ContentSearchResult, ControlSearchResult, Lane } from '../retrieval/lane.ts';
import { createSummaryService } from '../ai/summarizer.ts';
import { normalizeOrientation } from './orientation.ts';
import type { NaviquestOrientation } from './orientation.ts';
import type { ToolSpecName } from './tool-names.ts';

/** Everything a rebuild replaces. One object so `reindex()` assigns into it and
 *  every tool sees the new index without a getter per field. */
export interface IndexState {
  projection: Projection;
  seg: Segmentation;
  controls: ProjectedNode[];
  structure: PageStructure;
  /** Content-index row identity. Passage rows point into `seg.chunks`; section
   * rows are authored headings with no directly-owned chunk. Keeping the map
   * beside the index prevents a second ranker from guessing section relevance
   * after BM25 has already answered. */
  contentTargets: Array<
    | { kind: 'passage'; chunk: number }
    | { kind: 'section'; heading: ProjectedNode }
  >;
  version: number;
  /** Cleared on every rebuild; see `treeTokens()`. */
  treeTokenCache: number | null;
}

/** Everything fixed at construction. */
export interface ToolDeps {
  cfg: Tuning;
  lane: Lane;
  navLandmarks: Set<string>;
  st: IndexState;
  est: (v: unknown) => number;
  budget: Budgeter['budget'];
  remember: DeltaStore['remember'];
  delta: DeltaStore['delta'];
  ensureFresh: () => Awaitable<boolean>;
  /** True while the page is still re-rendering (a fresh mutation or an aria-busy
   *  region), so the agent waits rather than reading a spinner as the outcome. */
  settling: () => boolean;
  /** Whether structural mutations are rebuilt automatically. */
  autoReindex: boolean;
  /**
   * The host's exclusion selectors and redaction hook.
   *
   * Every other tool gets exclusion for free: the projection walk simply does
   * not descend into an excluded subtree, so excluded text never exists to be
   * returned. `query_selector`'s exact-CSS path has no walk — it hands an agent
   * a raw selector — so that path is the one place that must enforce the
   * contract itself. Its semantic views consume the filtered projection.
   */
  exclude: readonly string[];
  redact?: (text: string, el: Element) => string;
  /** Optional first-party overlay; read live so a mutated object updates `_etag`. */
  orientation?: NaviquestOrientation;
  /** Host hook for the agent's per-call `reason`; the page may show it to the user. */
  onIntent?: (tool: ToolSpecName, reason: string) => void;
}

/**
 * The one halving policy every budget shrinker uses. FLOOR converges fastest,
 * and `max(1, …)` keeps the last element so a length-1 list is never emptied to
 * nothing (which is what the old `ceil` spelling guarded by hand). Every site
 * that shrinks a list on an over-budget payload calls this, so the ceil/floor
 * drift the comment below records cannot silently reappear at a new call site.
 */
const halve = (len: number): number => Math.max(1, Math.floor(len / 2));

/** The over-budget TEXT shrinker, the `halve` of prose: keep `ratio` but never
 *  fall below `floor` characters, so a hard cap shrinks a payload toward fit
 *  without collapsing its text to nothing. One formula for every text field that
 *  shrinks, so the written-out-independently drift the list shrinkers had cannot
 *  reappear here (only the per-field `floor` differs, and it stays at the call
 *  site). Ratio and floors are `response` tunables: a host that pays for a
 *  budget also decides what survives exceeding it. */
const shrinkText = (text: string, floor: number, ratio: number): string =>
  text.slice(0, Math.max(floor, Math.floor(text.length * ratio)));

/** One wire shape for a semantic address miss, whether the caller wanted a
 * control or a region. DOM Elements stay inside `Resolution`; only recovery
 * addresses and the hint cross the tool boundary. */
const resolutionMiss = (r: Exclude<Resolution, { status: 'RESOLVED' }>): ToolPayload => ({
  status: r.status,
  hint: r.hint,
  ...(r.status === 'AMBIGUOUS' ? { candidates: r.candidates } : { nearest: r.nearest }),
});
const isQueryView = (value: string): value is typeof QUERY_VIEWS[number] =>
  (QUERY_VIEWS as readonly string[]).includes(value);

/**
 * Halve one list field of a budgeted payload and recompute the pagination
 * envelope (`returned`, `truncated`, `continuation`). Shared by the four tools
 * whose shrinker was byte-identical — find_on_page, locate_control, and
 * query_selector's two views — where the only prior difference was an accidental
 * ceil/floor split that made identically-oversized payloads shrink at different
 * rates. One FLOOR policy (converges fastest) is the intended unification.
 * describe_app's section shrinker (no `truncated`, different continuation) and
 * list_opaque's (guard-scoped, inline continuation) keep their own shape — they
 * are genuinely different, not folded in to avoid a rigid abstraction.
 */
function halveList(o: ToolPayload, key: 'results' | 'candidates', total: number, offset: number,
                   mkContinuation: (returned: number) => unknown): ToolPayload {
  const list = o[key] as unknown[] | undefined;
  if (list && list.length > 1) o[key] = list.slice(0, halve(list.length));
  o.returned = (o[key] as unknown[] | undefined)?.length ?? 0;
  o.truncated = Math.max(0, total - offset - o.returned);
  o.continuation = mkContinuation(o.returned);
  return o;
}

export function createTools(d: ToolDeps) {
  const { cfg, lane, navLandmarks, st, est, budget, remember, delta, ensureFresh, settling, autoReindex, exclude, redact, orientation, onIntent } = d;
  // This module is already the lazy main-window answer engine. Keeping the
  // optional response stage here avoids a second loader in the eager lifecycle
  // while retrieval itself can still cross lane.ts into worker.ts.
  const summary = createSummaryService({ cfg: cfg.summary, estimate: est, pageChunks: () => st.seg.chunks });
  const liveControls = () => st.controls.filter((n) => isActionableElement(n.el));
  /** Exact semantic filters compare copied authored labels, never relevance.
   * The fold is exact.ts's — one implementation of the Turkish-dotless-I
   * reasoning, not two — plus whitespace collapse, memoized per locale. */
  let keyFold: { locale: string; fold: Fold } | null = null;
  const semanticKey = (value: string) => {
    const locale = lane.locale() ?? 'en';
    if (keyFold?.locale !== locale) keyFold = { locale, fold: makeExactFold(locale) };
    return keyFold.fold(value).replace(/\s+/g, ' ').trim();
  };
  const semanticLedger = createSemanticLedger(cfg.delta.semanticHistory, cfg.delta.maxSemanticChanges);
  // One Gemini Nano session for the whole instance, shared by both readers so
  // the page loads the model once. Fail-open when the Prompt API is absent.
  const lmSession = createLmSession({
    enabled: cfg.answer.verify !== 'off' || cfg.answer.fromRegion !== 'off',
    warmupTimeoutMs: cfg.answer.verifyWarmupTimeoutMs,
  });
  // Gates whether an extractive answer is asserted; reads the top regions when
  // the extractive path finds nothing. Both fail-open when the Prompt API is absent.
  const answerVerifier = createVerifier(cfg.answer, lmSession);
  const answerer = createAnswerer(cfg.answer, lmSession);
  // Cross-language query bridge (RFC-04). Off by default; fail-open and
  // Window-only (Translator/LanguageDetector are not exposed in workers).
  const translator = createTranslator(cfg.retrieval);
  // Reads unreadable canvas/image regions on demand; fail-open when absent.
  const opaqueDescriber = createImageDescriber(cfg.discovery);
  const elementIds = new WeakMap<Element, number>();
  let nextElementId = 1;

  /** WebMCP schemas are hints, not validators. Keep the wire open while refusing
   * coercions that would otherwise turn malformed calls into confident output. */
  const positiveInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
  const nonNegativeInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
  const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
  const stringFilter = (v: unknown): v is string | string[] => nonEmptyString(v)
    || (Array.isArray(v) && v.length > 0 && v.every(nonEmptyString));

  /**
   * Budget, tag, diff, remember — in that order, once, for every tool that
   * supports `since`.
   *
   * The order is the whole point and it used to be wrong in both callers. They
   * tagged and remembered the payload they INTENDED to send, then shrank it to
   * fit the budget and sent something smaller. So on MDN `describe_app` shrank
   * 1,490 tokens to 900 by halving `reachableViews`, declared `depthTruncated`
   * once, and then answered every subsequent `since` call with `unchanged: true`
   * — telling an agent holding 130 of 264 views that it had all of them. That is
   * budget.ts rule 1 ("a silently trimmed list reads to a model as 'that is
   * everything'") defeated one layer up by the cache in front of it.
   *
   * An etag names the bytes the agent RECEIVED. Anything else is a cache key for
   * a response that was never sent.
   *
   * The diff is budgeted too. It used to return straight out with no shrinker
   * and no `_overBudget`, so a call that changed `reachableViews` handed back the
   * full 1,234-token list under a 900 budget — the delta path costing more than
   * the full response it exists to replace, while printing `_budget: 900` beside
   * `_tokens: 1300` and not setting the flag that says so.
   */
  function deliver(name: ToolName, key: string, since: string | undefined,
                   out: ToolPayload, shrink: Shrink): ToolPayload {
    // 1. Shrink FIRST. Everything downstream describes what this returns.
    const sent = budget(name, out, shrink);

    // 2. Tag the delivered content. Envelope fields are excluded for the same
    //    reason delta skips them: `_tokens` is metadata about the answer, and a
    //    payload whose etag changed only because its own size field changed
    //    would never register as unchanged.
    const tag = etag(contentOf(sent));

    // 3. Diff against what the agent says it holds — which is now genuinely what
    //    we last sent it.
    const diff = delta(key, since, sent, tag);
    remember(key, tag, sent);

    if (diff) {
      // A diff is a response and pays the same ceiling. `changed` is a bag of
      // whole fields, so the only honest shrink is to drop the largest one and
      // name it: a half-sent field would be indistinguishable from a small one.
      const sentDiff = budget(name, diff, (o, step) => {
        const changed = (o.changed ?? {}) as Record<string, unknown>;
        const keys = Object.keys(changed).sort((a, b) => est(changed[b]) - est(changed[a]));
        if (!keys.length) return o;
        const drop = keys[0];
        const { [drop]: _removed, ...rest } = changed;
        o.changed = step > cfg.response.maxDiffSteps ? {} : rest;
        o.omitted = [...(o.omitted ?? []), drop];
        o.note = `${o.omitted.length} changed field(s) did not fit this tool's budget and were omitted by name. `
          + 'Re-request without `since` to receive them.';
        return o;
      });
      // A shrunk diff is the ordering bug above through a second door: its
      // `_etag` (set by delta) names the FULL payload, so handing it back as
      // `since` would answer `unchanged` for fields the agent never received.
      // A partial diff earns no etag; the agent's next since-free call re-syncs.
      if ((sentDiff.omitted as string[] | undefined)?.length) delete sentDiff._etag;
      return sentDiff;
    }

    sent._etag = tag;
    sent._version = st.version;
    return sent;
  }

  /**
   * A budget mode is not necessarily a callable WebMCP name. Region expansion
   * and opaque discovery deliberately keep separate ceilings because their
   * payload shapes cost differently, while agents still resume them through
   * resolve_address and describe_app. Adapt the cursor only after the shared
   * budgeter has created it: putting this knowledge in budget.ts would couple
   * its generic envelope to this six-tool dispatch and pull it into the eager
   * SDK closure.
   */
  function budgetMode(mode: ToolName, publicTool: ToolSpecName,
                      resume: (args: unknown) => ToolPayload,
                      out: ToolPayload, shrink: Shrink): ToolPayload {
    const sent = budget(mode, out, shrink);
    const next = sent.pagination?.next;
    if (Array.isArray(next)) {
      for (const call of next) {
        call.tool = publicTool;
        call.arguments = resume(call.arguments);
      }
    }
    return sent;
  }

  /**
   * `element -> projected node`, built once per index instead of scanned per hit.
   *
   * `find_on_page` did `projection.nodes.find(n => n.el === first)` inside its
   * per-result map: a linear pass over every projected node, five times per
   * answer, on pages with thousands of nodes. Keyed on `st.version` so a rebuild
   * invalidates it without anyone having to remember to.
   */
  let nodeIndex: { version: number; map: Map<Element, ProjectedNode> } | null = null;
  function nodeForElement(el: Element | undefined): ProjectedNode | undefined {
    if (!el) return undefined;
    if (nodeIndex?.version !== st.version) {
      const map = new Map<Element, ProjectedNode>();
      for (const n of st.projection.nodes) if (n.el) map.set(n.el, n);
      nodeIndex = { version: st.version, map };
    }
    return nodeIndex.map.get(el);
  }

  /**
   * Mint the one region-address shape used by retrieval, structure inspection,
   * and continuation. Keeping this derivation in one place is not cosmetic: a
   * previous duplicate ranker produced a flattering result that had to be
   * retracted, and two address builders would create the same kind of drift.
   *
   * A chunk commonly starts with an unnamed paragraph. That is still the real
   * projected role/name pair and must not be rewritten as a generic region:
   * doing so measured 29/41 address round-trips against 41/41 for the real node.
   * Heading-less chunks add their own text anchor because `headingPath: []`
   * otherwise aliases every pathless region. `resolveWith` makes routing the
   * resolver's responsibility; agents previously sent all three region results
   * from a Japanese Wikipedia page down the control path and received NOT_FOUND.
   */
  function regionAddress(c: Chunk): Address {
    const node = nodeForElement(c.els[0]);
    return {
      // A frame region resolves back into its own document; without this a frame
      // passage and a same-heading top-document passage would be indistinguishable.
      ...(c.frame ? { frame: c.frame } : {}),
      role: node?.role ?? 'region',
      name: node?.name ?? null,
      landmark: c.landmark,
      landmarkName: node?.landmarkName ?? null,
      headingPath: c.headingPath,
      row: null,
      ordinal: 0,
      peerCount: 1,
      // Heading paths are not unique across shell and primary content. Keep a
      // bounded text anchor on every region so the read path can select the
      // region first, then expand sibling chunks without crossing provenance.
      anchorText: c.text.slice(0, cfg.retrieval.anchorTextChars),
      resolveWith: 'read_region',
    };
  }

  /** One address derivation for both outline rows and searchable sections. */
  function outlineAddress(heading: ProjectedNode): Address {
    return { ...addressOf(heading, heading.ordinal ?? 0, heading.peerCount ?? 1),
      resolveWith: 'read_region', headingScope: 'outline' };
  }

  /** Sparse, authored one-hop graph edges for an action. A target is addressed
   * as the region the retrieval model already knows how to read; when no text
   * chunk represents it, the null is explicit rather than a guessed selector. */
  function relationsOf(n: ProjectedNode): ToolPayload[] {
    return (n.relations ?? []).map((relation) => {
      const chunk = st.seg.chunks.find((c) => c.els.some((el) =>
        relation.target === el || relation.target.contains?.(el)));
      return {
        type: relation.type, source: relation.source,
        target: { name: relation.name, address: chunk ? regionAddress(chunk) : null,
          addressable: !!chunk },
      };
    });
  }

  /** The answer, without the envelope. What an etag should be over. */
  function contentOf(o: ToolPayload): Record<string, unknown> {
    const content: Record<string, unknown> = {};
    for (const k of Object.keys(o)) if (!k.startsWith('_')) content[k] = o[k];
    return content;
  }

  type OrientationSection = typeof ORIENTATION_SECTIONS[number];

  function describe_app({ since, changesSince, opaque, describe, section, limit = 10, offset = 0, revision }: {
    since?: string; changesSince?: string; opaque?: boolean; describe?: boolean; section?: string; limit?: number; offset?: number; revision?: number;
  } = {}) {
    // MODAL, like agentic_content's intents: `opaque: true` returns the boxes of
    // everything the text index could not read, instead of the orientation. This
    // was a separate tool (`list_opaque_regions`) whose whole relationship to
    // describe_app was "the count is free, the boxes are ~10x" — a cost split a
    // parameter expresses just as well as a second entry in getTools(), without
    // an agent having to learn two names for one subject.
    if (opaque != null && typeof opaque !== 'boolean') {
      return { error: 'INVALID_INPUT', message: 'opaque must be a boolean' };
    }
    if (describe != null && typeof describe !== 'boolean') {
      return { error: 'INVALID_INPUT', message: 'describe must be a boolean' };
    }
    if (describe && !opaque) {
      return { error: 'INVALID_INPUT', message: 'describe applies only to opaque mode: describe_app({ opaque: true, describe: true })' };
    }
    if (!positiveInt(limit) || !nonNegativeInt(offset)) {
      return { error: 'INVALID_INPUT', message: 'limit must be a positive integer' };
    }
    if (since != null && typeof since !== 'string') {
      return { error: 'INVALID_INPUT', message: 'since must be an etag string returned by this tool' };
    }
    if (changesSince != null && typeof changesSince !== 'string') {
      return { error: 'INVALID_INPUT', message: 'changesSince must be the `_observation` string returned by describe_app' };
    }
    if (revision != null && !nonNegativeInt(revision)) {
      return { error: 'INVALID_INPUT', message: 'revision must be the integer copied from a continuation' };
    }
    if (section != null && !(ORIENTATION_SECTIONS as readonly string[]).includes(section)) {
      return { error: 'INVALID_INPUT', message: `section must be one of ${ORIENTATION_SECTIONS.join(', ')}` };
    }
    if ((opaque || section) && since != null) {
      return { error: 'INVALID_INPUT', message: 'since applies only to the initial orientation response' };
    }
    if (changesSince != null && (since != null || opaque || section || offset > 0 || revision != null)) {
      return { error: 'INVALID_INPUT', message: 'changesSince is a separate describe mode and cannot be combined with since, opaque, section, offset, or revision' };
    }
    if (opaque && section) return { error: 'INVALID_INPUT', message: 'opaque and section are mutually exclusive modes' };
    if (offset > 0 && revision == null) {
      return { error: 'INVALID_INPUT', message: 'offset above 0 requires the revision copied from the continuation' };
    }
    const withFreshCursor = <T>(body: () => T) => chain(ensureFresh(), () => revision != null && revision !== st.version
      ? { error: 'STALE_CURSOR', revision: st.version,
          message: 'The page changed after that response. Restart at offset 0.' }
      : body());
    if (opaque) return withFreshCursor(() => listOpaqueBody(limit, offset, describe === true));
    if (section) return withFreshCursor(() => orientationSectionBody(section as OrientationSection, limit, offset));
    if (offset || revision != null) return { error: 'INVALID_INPUT', message: 'offset and revision require opaque or section mode' };
    if (changesSince != null) {
      if (!cfg.delta.semanticChanges) return { error: 'DISABLED', message: 'Semantic observations are disabled by this host. Call describe_app() for a fresh orientation.' };
      return chain(ensureFresh(), () => semanticChangesBody(changesSince));
    }
    return chain(ensureFresh(), (refreshed) => describeAppBody(since, refreshed, limit));
  }
  function orientationSource(section: OrientationSection): any[] {
    if (section === 'reachableViews') return st.structure.views;
    if (section === 'outline') {
      const headingByKey = headingNodeIndex(st.projection);
      return st.structure.outline.map((entry) => {
      const heading = headingByKey.get(outlineKey(entry.landmark, entry.headingPath));
      // Structure owns authored heading identity; segmentation owns readable
      // regions. Join them here, where regionAddress is already the single
      // address derivation. Constructing an address in structure.ts would create
      // a second derivation and eventually make outline and search disagree.
      // An outline heading is itself a durable semantic element even when all
      // of its content lives under flat sibling subheadings. Address the heading
      // and let the region reader derive the HTML outline boundary at resolve
      // time; using only descendant headingPath prefixes missed Devpost's h2/h3
      // sibling layout and reported "Judging Criteria" as unaddressable.
      const address = heading ? outlineAddress(heading) : null;
      return {
        depth: entry.depth, text: entry.text, landmark: entry.landmark,
        headingPath: entry.headingPath,
        ...(address ? { address, readWith: 'resolve_address' } : {
          address: null, addressable: false,
          note: 'This heading has no readable indexed region beneath it.',
        }),
      };
      });
    }
    if (section === 'landmarks') return st.structure.landmarks;
    return st.structure.trail;
  }
  function orientationSectionBody(section: OrientationSection, limit: number, offset: number) {
    const source = orientationSource(section);
    const results = source.slice(offset, offset + limit);
    const out: ToolPayload = { section, revision: st.version, total: source.length, offset,
      returned: results.length, results,
      ...(offset + results.length < source.length ? {
        continuation: { section, limit, offset: offset + results.length, revision: st.version },
      } : {}) };
    return budget('describe_app', out, (o) => {
      if ((o.results?.length ?? 0) > 1) o.results = o.results.slice(0, halve(o.results.length));
      o.returned = o.results?.length ?? 0;
      o.continuation = (o.offset ?? 0) + o.returned < (o.total ?? 0)
        ? { section, limit, offset: (o.offset ?? 0) + o.returned, revision: st.version } : undefined;
      return o;
    });
  }
  /**
   * Same scopes, frames, and exclude as query_selector. Authored locate is a
   * host selector only if it hits something the agent could copy into that tool.
   */
  function authoredLocateHits(selector: string): number {
    const scan = queryScopes(document, {
      extra: st.projection.shadowRoots,
      frames: true,
      enter: (boundary) => !excludedDeep(boundary, exclude),
    });
    let n = 0;
    for (const scope of scan.scopes) {
      let found: Element[];
      try { found = [...scope.root.querySelectorAll(selector)]; }
      catch { return 0; }
      for (const el of found) if (!excludedDeep(el, exclude)) n++;
    }
    return n;
  }

  function describeAppBody(since: string | undefined, refreshed: boolean, limit: number) {
    const m = modalState(detectModal(st.projection.shadowRoots));
    const allLists = Object.fromEntries(ORIENTATION_SECTIONS.map((section) => [section, orientationSource(section)]));
    const initialLists = Object.fromEntries(ORIENTATION_SECTIONS.map((section) => [section, allLists[section].slice(0, limit)]));
    const continuations: ToolPayload = {};
    for (const section of ORIENTATION_SECTIONS) if (initialLists[section].length < allLists[section].length) {
      continuations[section] = { section, limit, offset: initialLists[section].length, revision: st.version };
    }
    const authored = normalizeOrientation(orientation, cfg.orientation, est, authoredLocateHits);
    const out: ToolPayload = {
      view: {
        title: document.title,
        path: location.pathname + location.hash,
        // Read the heading from the PROJECTION, not the DOM. querySelector('h1')
        // bypasses the walk entirely, so an <h1> inside a [data-private] block
        // landed straight in this field despite being excluded everywhere else.
        heading: st.projection.nodes.find((n) => n.isHeading && n.primary)?.text
          ?? st.projection.nodes.find((n) => n.isHeading)?.text ?? null,
      },
      ...(authored ? { authored } : {}),
      ...initialLists,
      orientationTotals: Object.fromEntries(ORIENTATION_SECTIONS.map((section) => [section, allLists[section].length])),
      ...(Object.keys(continuations).length ? { continuations } : {}),
      ...(settling() ? { settling: true, settlingNote: 'The page is still re-rendering (a fresh mutation or an aria-busy region). This is not the settled state — wait, then call describe_app again.' } : {}),
      counts: { chunks: st.seg.chunks.length, controls: liveControls().length },
      nonText: {
        total: st.projection.coverage.nonText,
        decorative: st.projection.coverage.nonTextDecorative,
        textRecovered: st.projection.coverage.nonTextRecovered,
        opaque: st.projection.coverage.nonTextOpaque,
        unlabelledControls: st.projection.coverage.unlabelledControls,
        note: st.projection.opaqueTotal
          ? `${st.projection.opaqueTotal} element(s) carry meaning this text index cannot read. Call describe_app({ opaque: true }) for capturable boxes.`
          : 'All non-text content had usable author-written descriptions.',
      },
      structuralQuality: st.seg.stats.structuralEngagementPct >= cfg.retrieval.structuralGoodPct ? 'good'
        : st.seg.stats.structuralEngagementPct >= cfg.retrieval.structuralMixedPct ? 'mixed' : 'low',
      structuralEngagementPct: st.seg.stats.structuralEngagementPct,
      // The projection cannot be authoritative: closed shadow roots are
      // unreachable, ElementInternals semantics are unreadable from outside,
      // and there is no computed-role API. So we report what we could see.
      coverage: {
        elementsInspectedPct: st.projection.coverage.elementsInspectedPct,
        customElements: st.projection.coverage.customElements,
        unknownShadowHosts: st.projection.coverage.unknownRoots,
        opaqueComponents: st.projection.coverage.opaqueComponents,
        indexedRootElements: st.projection.coverage.rootElements,
        documentElements: st.projection.coverage.documentElements,
        framesOutsideRoot: st.projection.coverage.framesOutsideRoot,
        unindexedFrameDocuments: st.projection.coverage.unindexedFrameDocuments,
        virtualizedCollections: st.projection.coverage.virtualizedCollections,
        offDomRowsDeclared: st.projection.coverage.offDomRowsDeclared,
        offDomItemsDeclared: st.projection.coverage.offDomItemsDeclared,
        unknownSizeCollections: st.projection.coverage.unknownSizeCollections,
        // Exposed as a number as well as prose: an agent deciding whether to
        // scroll and re-query should branch on a count, not parse `note`.
        revealPending: st.projection.coverage.revealPending,
        note: coverageNote(st.projection.coverage),
      },
      /**
       * The vocabulary this page is speaking, declared rather than assumed.
       *
       * WebMCP has no schema negotiation — `inputSchema` is a semantic hint
       * (issue #92) — so an agent cannot discover what values our tools might
       * return. It could only hardcode our enum, which made every closed list in
       * this SDK a closed list inside every agent that consumed it.
       *
       * Declaring it here means a host can add an affordance without an SDK
       * release, and an unknown value becomes information rather than a parse
       * failure. `authored` counts affordances the PAGE declared; `inferred`
       * counts the ones we guessed from a label, which is the distinction that
       * lets an agent weigh them differently.
       */
      vocabulary: vocabularyOf(st.projection.nodes),
      ...m,
      ...(refreshed ? { reindexed: true } : {}),
      // An SDK that knows when NOT to help is worth more than one that always
      // claims a win. Two independent reasons to decline, checked in order of
      // certainty. This changes ADVICE, never retrieval, so it cannot make any
      // answer worse — only warn before the agent pays full price to lose.
      ...((() => {
        // 1. Small page: the whole accessibility tree is cheaper than three tool
        //    calls — measured at 103% on Excalidraw.
        if (treeTokens() < cfg.retrieval.declineBelowTreeTokens
          && st.projection.coverage.elementsInspectedPct === 100) {
          return { recommendation: `This page is small: its full accessibility tree is roughly ${treeTokens()} tokens. `
            + 'Requesting it directly will cost less than querying it through these tools.' };
        }
        // 2. Weakly structured, ANY size. Size was the wrong predictor: the tools
        //    lost on large commercial pages (Stripe 10%, PayPal dev 22%) whose
        //    prose is buried in nav chrome and dense footnotes, and the size gate
        //    stayed silent on exactly those. Structural engagement is the signal
        //    that separates them, and it is already measured.
        if (st.seg.stats.structuralEngagementPct < cfg.retrieval.declineBelowStructuralPct) {
          return { recommendation: `This page is weakly structured (${st.seg.stats.structuralEngagementPct}% of content sits under a heading or landmark). `
            + 'Passage retrieval is less reliable here — recommended passages are weak evidence. '
            + 'Prefer reading the page or its accessibility tree directly, and verify any answer against the source.' };
        }
        return {};
      })()),
    };
    // Budget pressure may reduce an initial page, never erase it. Every removed
    // suffix receives its own revision-bound cursor because four independent
    // inventories cannot honestly share one numeric offset.
    const sent = deliver('describe_app', 'describe_app', since, out, (o) => {
      const lists = ['reachableViews', 'outline', 'landmarks', 'currentTrail']
        .filter((k) => Array.isArray(o[k]) && o[k].length > 1)
        .sort((a, b) => est(o[b]) - est(o[a]));
      if (lists.length) {
        const k = lists[0];
        o[k] = o[k].slice(0, halve(o[k].length));
        o.continuations = { ...(o.continuations ?? {}),
          [k]: { section: k, limit, offset: o[k].length, revision: st.version } };
        return o;
      }
      // A single semantic record is indivisible. Declare an overage instead of
      // deleting a coverage warning or returning half a record.
      return o;
    });
    if (cfg.delta.semanticChanges) sent._observation = semanticLedger.observe(semanticSnapshot());
    return sent;
  }

  function semanticChangesBody(changesSince: string): ToolPayload {
    const result = semanticLedger.changes(changesSince, semanticSnapshot());
    if (result.error) return result;
    // The most important place for settle: the diff after an action can be just
    // the spinner. Flag it so the agent re-observes rather than concluding.
    if (settling()) { result.settling = true; result.settlingNote = 'Still re-rendering — this delta may be a loading state, not your action’s outcome. Wait and call describe_app({ changesSince }) again.'; }
    return budget('describe_app', result, (o) => {
      if ((o.changes?.length ?? 0) > 1) o.changes = o.changes.slice(0, halve(o.changes.length));
      else if ((o.changes?.length ?? 0) === 1) o.changes = [];
      o.returned = o.changes?.length ?? 0;
      o.truncated = Math.max(0, (o.total ?? 0) - o.returned);
      if (o.truncated) {
        const byKind = { ...o.changeSummary };
        for (const change of o.changes ?? []) byKind[change.kind]--;
        for (const kind of Object.keys(byKind)) if (!byKind[kind]) delete byKind[kind];
        o.omitted = { count: o.truncated, byKind };
      }
      return o;
    });
  }

  function find_on_page({ query, goal = 'read', limit = 5, offset = 0, revision, since }: {
    query?: string; goal?: string; limit?: number; offset?: number; revision?: number; since?: string;
  } = {}) {
    if (!nonEmptyString(query)) {
      return { error: 'INVALID_INPUT', message: 'query must be a non-empty string' };
    }
    if (!positiveInt(limit) || !nonNegativeInt(offset)) {
      return { error: 'INVALID_INPUT', message: 'limit must be a positive integer and offset must be a non-negative integer' };
    }
    if (!nonEmptyString(goal)) return { error: 'INVALID_INPUT', message: 'goal must be a non-empty string when supplied' };
    if (revision != null && !nonNegativeInt(revision)) {
      return { error: 'INVALID_INPUT', message: 'revision must be the integer copied from a continuation' };
    }
    if (offset > 0 && revision == null) {
      return { error: 'INVALID_INPUT', message: 'offset above 0 requires the revision copied from the continuation' };
    }
    if (since != null && typeof since !== 'string') {
      return { error: 'INVALID_INPUT', message: 'since must be an etag string returned by this tool' };
    }
    return chain(ensureFresh(), () => {
      if (revision != null && revision !== st.version) return { error: 'STALE_CURSOR', revision: st.version,
        message: 'The page changed after that result page. Restart at offset 0.' };
      // Query expansion via the on-device LLM was tried and REVERTED: it fixed
      // acronym cases ("stand for" → the expansion) but appended synonym terms
      // that pushed the right chunk out of the candidate set, netting off 3/7 →
      // auto 2/7 on the vocabulary misses (eval/expand-measure.mjs). BM25 recall
      // on true vocabulary mismatch needs the semantic embedder, not more terms.
      const want = Math.max(1, st.contentTargets.length);
      const primary = lane.searchContent(query, want, cfg.retrieval);
      // Default path: single-language retrieval, unchanged.
      if (cfg.retrieval.crossLanguage === 'off') {
        return chain(primary, (found) => findOnPageBody(query, goal, limit, offset, since, found));
      }
      // Cross-language (RFC-04): if the query is in another language, translate it
      // to the page's language and FUSE a second same-language pass. Recall comes
      // from both queries (RRF); the page-language `informative`/`weights` drive
      // extraction so quotations stay in the page's language; the original query's
      // exact overlay is kept. Fail-open: no translation → the single pass runs.
      const pageLang = lane.locale() ?? (typeof document !== 'undefined' ? document.documentElement.lang : '') ?? '';
      return chain(translator.translateQuery(query, pageLang), (translated) => {
        if (!translated) return chain(primary, (found) => findOnPageBody(query, goal, limit, offset, since, found));
        return chain(primary, (found) => chain(lane.searchContent(translated, want, cfg.retrieval), (found2) => {
          const fused: ContentSearchResult = { ...found2, exact: found.exact,
            hits: rrf([found.hits, found2.hits], cfg.lexical.rrfK, want) };
          return findOnPageBody(query, goal, limit, offset, since, fused);
        }));
      });
    });
  }
  async function findOnPageBody(query: string, goal: string, limit: number, offset: number,
                          since: string | undefined, found: ContentSearchResult) {
    // Exact evidence annotates existing ranked hits and recovers only chunks the
    // tokenizer could not represent. It never REORDERS by exactness: a quoted
    // phrase can occur in prose ABOUT the target, and exact-first ranking would
    // turn a better snippet into a worse ranker. (The structural prior below is a
    // separate axis — a hit that is both exact and, say, in a footer is still
    // demoted as chrome; exactness does not exempt a passage from that signal.)
    const exactById = new Map(found.exact.map((match) => [match.id, match]));
    const rankedIds = new Set(found.hits.map(([id]) => id));
    // Structural content prior on the ranked hits BEFORE pagination, so a demoted
    // passage leaves the top rather than only the returned page. Two declared,
    // index-time signals compose multiplicatively into the score: a chrome
    // landmark (nav/banner/contentinfo — a dense noun pile, not prose), and the
    // fraction of the passage that is recovered NON-TEXT (image alt / chart text
    // — a description of a picture, not a claim the page makes). Baked into the
    // score so rank order, `score`, and the ambiguity ratio stay consistent;
    // exact overlays keep their 0 and stay last, unchanged.
    // Locale-folded once per search, so the citation demotion fires on
    // `Références`/`Weblinks`, not only English — and a host can extend the list.
      const citationKeys = new Set(cfg.retrieval.citationHeadings.map(semanticKey));
    const contentPrior = (id: number): number => {
      const t = st.contentTargets[id];
      const chunk = t?.kind === 'passage' ? st.seg.chunks[t.chunk] : undefined;
      const landmark = t?.kind === 'section' ? t.heading.landmark : chunk?.landmark ?? null;
      let prior = navLandmarks.has(landmark ?? '') ? cfg.retrieval.chromePenalty : 1;
      if (chunk && chunk.words > 0 && chunk.nonTextWords > 0) {
        const fraction = Math.min(1, chunk.nonTextWords / chunk.words);
        prior *= 1 - fraction * (1 - cfg.retrieval.imageAltPenalty);
      }
      // A citation / back-matter section (References, See also, …) repeats the
      // topic's vocabulary and out-ranks the sentence that answers. Declared by
      // the authored heading anywhere on the path (the whole subtree is
      // back-matter), so a subsection under References is demoted too.
      const path = t?.kind === 'section' ? t.heading.headingPath : chunk?.headingPath;
      if (path?.some((h) => citationKeys.has(semanticKey(h)))) prior *= cfg.retrieval.citationPenalty;
      return prior;
    };
    const priored = found.hits
      .map(([id, score]) => [id, score * contentPrior(id)] as [number, number])
      .sort((a, b) => b[1] - a[1]);
    const hits = [...priored,
      ...found.exact.filter(({ id }) => !rankedIds.has(id)).map(({ id }) => [id, 0] as [number, number])];
    // Coalesce before pagination. Otherwise a page containing repeated chunks
    // can return fewer than `limit`, and advancing by the raw-hit count either
    // skips a region or repeats one on the next call.
    const seenRegions = new Set<string>();
    const allRegionHits = hits.filter(([id]) => {
      const target = st.contentTargets[id];
      if (target?.kind === 'section') {
        const key = `section\u0000${target.heading.landmark ?? ''}\u0000${target.heading.headingPath.join('\u0000')}`;
        if (seenRegions.has(key)) return false;
        seenRegions.add(key);
        return true;
      }
      const c = target?.kind === 'passage' ? st.seg.chunks[target.chunk] : undefined;
      if (!c || !c.headingPath.length) return true;
      const landmarkName = nodeForElement(c.els[0])?.landmarkName ?? '';
      const key = `${c.primary}\u0000${c.landmark ?? ''}\u0000${landmarkName}\u0000${c.headingPath.join('\u0000')}`;
      if (seenRegions.has(key)) return false;
      seenRegions.add(key);
      return true;
    });
    const regionHits = allRegionHits.slice(offset, offset + limit);
    // Hoisted. It was rebuilt inside the per-result map, so a five-result answer
    // tokenised the same query five times.
    const qSet = new Set(lane.tokens(query));
    const results = regionHits.map(([id, score]) => {
      const target = st.contentTargets[id];
      const exact = exactById.get(id);
      if (target?.kind === 'section') {
        const heading = target.heading;
        const queryCoverage = coverageOf(lane.tokens(heading.headingPath.join(' ')), found.informative);
        return {
          // Keep the internal result union destructurable below. Section rows
          // have no source chunk; the field is removed before the wire payload.
          _chunk: undefined,
          _target: id,
          kind: 'section',
          text: heading.headingPath.at(-1) ?? heading.text,
          match: exact ? 'exact' : 'ranked',
          score: +score.toFixed(3),
          queryCoverage: +queryCoverage.toFixed(2),
          confidence: confidenceFor(queryCoverage, cfg.retrieval),
          headingPath: heading.headingPath,
          address: outlineAddress(heading),
          actionable: [],
        };
      }
      const c = target?.kind === 'passage' ? st.seg.chunks[target.chunk] : undefined;
      if (!c) throw new Error(`content target ${id} is not aligned with the content index`);
      // Ranked by relevance to the query, not document order. Measured: on
      // Wikipedia every hit offered "", "wavelengths", "light" — the article's
      // own links in the order they appear — while gov.uk offered the control the
      // agent actually wanted. Document order is not an answer to a question.
      //
      // But relevance has to be REPORTED or it is not a ranking the agent can
      // use, and zero-overlap controls have to be dropped when better ones
      // exist. Without both, a region whose controls all score 0 — query "refund
      // policy", controls "Submit"/"Cancel" — sorts stably back into document
      // order and hands the agent the exact behaviour this comment rejects,
      // with nothing on the payload to reveal it.
      const scored = controlsInRegion(c).map((n) => {
        const hay = lane.tokens(controlDoc({ ...n, row: null, headingPath: [] }, cfg.affordance.terms));
        let hit = 0;
        for (const t of hay) if (qSet.has(t)) hit++;
        return { n, rel: hit / Math.max(1, qSet.size) };
      }).sort((a, b) => b.rel - a.rel);
      const anyRelevant = scored.some((x) => x.rel > 0);
      const inner = scored
        .filter((x) => !anyRelevant || x.rel > 0)
        .slice(0, cfg.retrieval.actionablePerResult);
      // A fixed prefix hid the literal occurrence whenever it landed late in a
      // long chunk. Centre the same configured window on the evidence; keep the
      // full-text address for context beyond it. If the query itself exceeds the
      // window, starting at the occurrence is the least misleading bounded view.
      // Ranked-hit centring by query-term position was tried and reverted: on a
      // page where the answer word is common (fetch's "returns"), idf picks a
      // head term and no lexical signal marks the answer — the honest recovery
      // is `readFullTextWith`, which the agent follows to read the whole region.
      const excerptChars = cfg.retrieval.snippetChars;
      const excerptStart = exact && c.text.length > excerptChars
        ? Math.max(0, Math.min(
          exact.end - exact.start > excerptChars ? exact.start
            : exact.start - Math.floor((excerptChars - (exact.end - exact.start)) / 2),
          c.text.length - excerptChars,
        )) : 0;
      const excerptEnd = Math.min(c.text.length, excerptStart + excerptChars);
      const isExcerpt = c.text.length > excerptChars;
      const excerpt = `${excerptStart ? '…' : ''}${c.text.slice(excerptStart, excerptEnd)}${excerptEnd < c.text.length ? '…' : ''}`;
      return {
        kind: 'passage',
        // Internal. Stripped before the payload leaves, and the reason
        // `bestAnswer` no longer re-finds its own chunk by prose prefix.
        _chunk: target.chunk,
        _target: id,
        text: excerpt,
        textChars: c.text.length,
        match: exact ? 'exact' : 'ranked',
        ...(isExcerpt ? {
          textIsExcerpt: true,
          excerptStart,
          readFullTextWith: 'resolve_address',
        } : {}),
        score: +score.toFixed(3),
        queryCoverage: +coverageOf(lane.tokens(`${c.headingPath.join(' ')} ${c.text}`), found.informative).toFixed(2),
        chunkStrategy: c.strategy,
        primary: c.primary,
        // A passage behind a closed <details> is real content and is retrievable,
        // but an agent that reports it as visible is wrong twice over: the human
        // cannot see it, and acting on anything inside it fails until the
        // disclosure is opened. So say so, and name the control that opens it —
        // the agent should not have to work out which of the offered controls
        // that is.
        ...(c.collapsed ? { collapsed: true, revealedBy: discloserFor(c) } : {}),
        address: regionAddress(c),
        actionable: inner.map(({ n, rel }) => ({
          role: n.role, name: n.name,
          // The score the ordering was made on. An agent that cannot see it
          // cannot tell a 0.8 match from a 0.0 one sitting next to it.
          relevance: +rel.toFixed(2),
          // Navigation leaves the passage; an action operates on it. An agent
          // that cannot tell them apart wanders.
          kind: navLandmarks.has(n.landmark ?? '') || (n.affordances ?? []).some((a) => a.startsWith('pagination') || a === 'external')
            ? 'nav' : 'action',
          ...(n.affordances?.length ? { affordances: n.affordances } : {}),
          ...(n.affordanceVia ? { affordanceSource: n.affordanceVia } : {}),
          address: addr(n),
        })),
        ...(scored.length > inner.length ? {
          actionableAvailable: scored.length,
          readAllControlsWith: 'resolve_address',
        } : {}),
      };
    });
    // ONE answer, not one per result.
    //
    // `find_on_page` returned passages and left the agent to read them. That is
    // a retrieval result, not an answer, and the difference is whether the SDK
    // helps an agent search or helps it respond. A single, clearly-sourced,
    // addressable answer also costs ~100 tokens against the 1,200 budget, where
    // a span on every result would fight it.
    const answer = cfg.answer.enabled ? await bestAnswer(query, found, results, allRegionHits) : null;
    // `_chunk` was for us. It never crosses the wire — the envelope convention is
    // that a leading underscore is OUR metadata, and shipping an internal array
    // index would invite an agent to use it as an address.
    const wire = results.map(({ _chunk, _target, ...rest }) => rest);
    // Rank-1 auto-inline of a single chunk was tried and REVERTED: it raised
    // naive single-call recovery 60→68 but dropped the capable-agent ceiling
    // 77→72, because a chunk is only PART of a region and resolve_address reads
    // the whole thing — so the inline handed the agent LESS than the affordance
    // would, while spending budget. The excerpt + `readFullTextWith` a capable
    // agent follows is the stronger design; a full-region inline is future work.
    const coalesced = hits.length - allRegionHits.length;
    const continuation = (sent: number) => offset + sent < allRegionHits.length
      ? { query, goal, limit, offset: offset + sent, revision: st.version } : undefined;
    // A retrieval score answers "which passage is most related?", not "does this
    // passage answer the question?". The Devpost dogfood trace had non-empty
    // results, no supported answer, and an instruction to read rank 1 as though
    // those states were equivalent. Declare the distinction on every response.
    const queryCoverage = Number(results[0]?.queryCoverage ?? 0);
    const answerStatus = answer ? 'supported' : hits.length ? 'unsupported' : 'no-match';
    const top = wire[0];
    const runnerUp = wire[1];
    // CALIBRATION DEBT: `ambiguityRatio` was measured on BM25 scores. In hybrid
    // mode the lane returns RRF scores (~1/61 scale, adjacent ranks 1-3% apart),
    // so this gate reads nearly always ambiguous and `recommendedAddress` nearly
    // always null. Harmless while no dense table ships in this repo; the
    // threshold MUST be re-measured against fused scores before weights land.
    const selectionAmbiguous = !!top && !!runnerUp && top.score > 0
      && (runnerUp.score / top.score) > cfg.retrieval.ambiguityRatio;
    // An exact authored heading is stronger identity evidence than a nearby
    // descendant passage with similar BM25 score. Treating that pair as a tie
    // made a first-class parent section discoverable but never recommendable.
    const recommendedAddress = top?.kind === 'section' && top.confidence === 'high'
      && (top.match === 'exact' || !selectionAmbiguous) ? top.address : null;
    const status = answer || recommendedAddress ? 'supported'
      : hits.length ? 'ambiguous' : 'not_found';
    // Signal-driven next move, highest-recovery first. The commonest miss is a
    // real answer sitting just past a top-passage EXCERPT: resolve_address reads
    // the whole region, and the diagnosis showed it recovers most "unsupported"
    // cases in one hop. Only then fall back to navigation or the outline.
    const topRec = top as { textIsExcerpt?: boolean; address?: unknown } | undefined;
    const topAddress = topRec?.textIsExcerpt && topRec.address != null ? topRec.address : undefined;
    const nextCalls = !answer && hits.length ? [
      ...(topAddress ? [{ tool: 'resolve_address', arguments: { address: topAddress },
        reason: 'The top passage is an excerpt; read its full region before concluding the fact is absent — the answer is often just past the window.' }] : []),
      ...(goal === 'navigate' ? [{ tool: 'locate_control', arguments: { description: query },
        reason: 'Navigation needs a live action; content ranking alone does not prove one.' }] : []),
      { tool: 'describe_app', arguments: { section: 'outline' },
        reason: 'Inspect authored section targets when passages do not support an answer.' },
    ] : [];
    // A weak lexical match means the page uses different words (or does not cover
    // this at all) — a distinct next move from "excerpted, read more". Below the
    // answer-support coverage bar is the natural "too weak to answer" boundary.
    const weakCoverage = Number(queryCoverage) < cfg.answer.minCoverage;
    const out: ToolPayload = { results: wire, matched: allRegionHits.length, returned: results.length,
      offset, revision: st.version,
      ...(coalesced ? { coalesced, matchedChunks: hits.length } : {}),
      // Coalesced rows are not omissions: every one expands to a region already
      // returned. `truncated` names only lower-ranked hits the limit omitted.
      truncated: Math.max(0, allRegionHits.length - offset - results.length),
      ...(continuation(results.length) ? { continuation: continuation(results.length) } : {}),
      ...(answer ? { answer } : {}),
      answerStatus,
      status,
      recommendedAddress,
      confidence: answer?.verified ? 'high' : recommendedAddress ? top.confidence : 'low',
      // Both `high` sources are model-checked, but by DIFFERENT checks — say which,
      // so the agent does not read one guarantee as the other. Passage: a yes/no
      // comprehension verdict on an extracted sentence. Region-model: the model
      // read the top passages and produced the answer, quote-verified present on
      // the page — comprehension, not a yes/no, and grounded rather than extracted.
      confidenceBasis: answer?.verified
        ? (answer.source === 'region-model'
            ? 'an on-device model read the page\'s top passages and answered; the answer is quote-verified present on the page'
            : 'an on-device model confirmed this sentence answers the question — the trustworthy signal, unlike coverage')
        : 'informative query-term coverage plus rank separation; not correctness probability',
      ...(nextCalls.length ? { nextCalls } : {}),
      evidenceOnly: !answer && hits.length > 0,
      queryCoverage: +queryCoverage.toFixed(2),
      coverageBasis: 'informative query terms present in the top passage and its heading path; not correctness probability',
      ...(answer ? {} : {
        // The hint names the SPECIFIC next move for THIS response's signals, so
        // an agent recovers without guessing — the difference between a 60%
        // one-shot reader and a 77% agent that follows the affordance.
        hint: !hits.length
          ? 'No passage matched. Try describe_app({section:"outline"}) for the page’s sections, rephrase in the page’s own words, or agentic_content to reach other pages.'
          : topAddress
            ? 'No answer cleared the support gate and the top passage is an EXCERPT. resolve_address its address to read the full region before concluding the fact is absent — it is often just past the window.'
            : weakCoverage
              ? `Weak lexical match (coverage ${Number(queryCoverage).toFixed(2)}): the page uses different words, or does not cover this. Rephrase in its vocabulary (describe_app shows headings), or try agentic_content for other pages.`
              : 'No sentence cleared the support gate. Treat passages as evidence: resolve_address the top results to read them in full, or inspect the outline.',
        ...(nextCalls.length ? { next: nextCalls[0] } : {}),
      }),
      // `locate_control` has had a no-match path since the beginning — a fuzzy
      // `nearest` list and a written explanation of the difference between "no
      // such control exists" and "your wording missed". This tool returned a bare
      // empty array, which leaves an agent unable to tell an unindexed page from a
      // missed query and gives it no next move. The asymmetry was an oversight,
      // not a decision.
      ...(hits.length ? {} : {
        note: st.seg.chunks.length
          ? `No passage matched. ${st.seg.chunks.length} chunk(s) are indexed on this page under the headings describe_app lists — rephrase, `
            + 'or call describe_app to see what this view actually covers.'
          : 'Nothing is indexed on this page. Either the root selector matched no content or every candidate was excluded.',
        indexedChunks: st.seg.chunks.length,
      }),
      // Which lane answered. Without it an agent cannot tell "no match" from
      // "the semantic model has not finished arriving". Reported by the lane
      // rather than hard-coded, so it cannot claim hybrid before the table lands.
      retrieval: found.retrieval };
    const key = `find_on_page:${goal}:${query}:${limit}:${offset}`;
    // A single ranked region, its address, and its sourced answer are one
    // indivisible evidence record. If that cannot fit, `_overBudget` is more
    // truthful than silently weakening it.
    return deliver('find_on_page', key, since, out,
      (o) => halveList(o, 'results', allRegionHits.length, offset, continuation));
  }

  function locate_control({ description, limit = 4, offset = 0, revision, role, affordance, landmark }: {
    description?: string; limit?: number; offset?: number; revision?: number;
    role?: string | string[]; affordance?: string | string[]; landmark?: string;
  } = {}) {
    // WebMCP's `inputSchema` is "purely a semantic hint" (issue #92) and NOTHING
    // validates a call, so the declared type is a suggestion and the tool is the
    // only guard. `find_on_page` already checked `typeof`; this checked only
    // falsiness, and the two must not disagree about what a bad call is.
    //
    // The failure it allowed was the quiet kind. `Intl.Segmenter#segment`
    // COERCES, so a non-string description did not throw — `{}` tokenized as
    // "[object Object]" and `123` as "123", and the tool returned plausibly
    // ranked garbage with a confidence attached. A readable error beats a
    // confident wrong answer, which is the rule this whole surface is built on.
    if (!nonEmptyString(description)) {
      return { error: 'INVALID_INPUT', message: 'description must be a non-empty string describing what the control should do' };
    }
    if (!positiveInt(limit) || !nonNegativeInt(offset)) {
      return { error: 'INVALID_INPUT', message: 'limit must be a positive integer and offset must be a non-negative integer' };
    }
    if (revision != null && !nonNegativeInt(revision)) {
      return { error: 'INVALID_INPUT', message: 'revision must be the integer copied from a continuation' };
    }
    if (offset > 0 && revision == null) {
      return { error: 'INVALID_INPUT', message: 'offset above 0 requires the revision copied from the continuation' };
    }
    if (role != null && !stringFilter(role)) {
      return { error: 'INVALID_INPUT', message: 'role must be a non-empty string or non-empty array of strings' };
    }
    if (affordance != null && !stringFilter(affordance)) {
      return { error: 'INVALID_INPUT', message: 'affordance must be a non-empty string or non-empty array of strings' };
    }
    if (landmark != null && !nonEmptyString(landmark)) {
      return { error: 'INVALID_INPUT', message: 'landmark must be a non-empty string' };
    }
    // How much of what the agent ASKED FOR does this control actually contain?
    // Rank position says nothing on its own: on the Apple configurator "choose
    // 16GB of unified memory" returned a lone `link "Terms of Use"` matching
    // one term out of six, with no signal that it was a guess. A returned
    // control that is confidently wrong fails a trajectory exactly like an
    // invented CSS selector does.
    //
    // The ranking, the informative-term filter and the coverage arithmetic all
    // live in ranking.js now, because there are two lanes that must not drift
    // apart on any of them. See ranking.js for why coverage counts a term NO
    // control contains AGAINST the match rather than dropping it.
    // FILTERS, not a ranking change.
    //
    // A structural prior was tried and rejected — weighting by landmark and role
    // made every configuration worse (VALIDATION § 8.3), so ranking is left
    // alone. What the agent can do instead is say what it already knows: "the
    // one that paginates", "a textbox, not a link", "in the navigation". That
    // cannot regress the ranker because it only removes candidates the agent has
    // already ruled out, and it is measured the same way everything else is.
    //
    // Over-fetch before filtering, or a filter that matches the 5th-ranked
    // control returns nothing while the control sits right there.
    const filtered = (role || affordance || landmark) ? controlFilter({ role, affordance, landmark }) : null;
    return chain(ensureFresh(), () => {
      if (revision != null && revision !== st.version) return { error: 'STALE_CURSOR', revision: st.version,
        message: 'The page changed after that candidate page. Restart at offset 0.' };
      // Sized AFTER the refresh: `st.controls` can grow when a re-render adds
      // controls, and capping the search at the STALE pre-refresh count would
      // leave the new controls unranked — false ambiguity, short pagination, or
      // the wrong candidate for a control that is right there.
      const want = Math.max(1, st.controls.length);
      return chain(lane.searchControls(description, want, cfg.retrieval),
      (found) => {
        // POST-filter. Gating the recovery path on the PRE-filter count meant a
        // filter that removed every candidate fell through to the ranked body
        // with an empty hit list, and `[].every()` being vacuously true then
        // attached a note describing candidates that did not exist. An empty
        // list plus a false description of it is worse than the bare empty list
        // this SDK already calls the worst possible answer for an agent.
        // Actionability is live CSS state. The retrieval corpus intentionally
        // retains latent interactive elements so CSSOM-only hidden→visible
        // transitions remain discoverable; filter every result at answer time
        // so the reverse transition never returns a stale clickable candidate.
        const kept = applyFilter(found, (c) => isActionableElement(c.el)
          && (!filtered || filtered(c)));
        // Controls that MATCH the intent but are not actionable right now (CSS-
        // hidden, inside a closed disclosure, disabled). Surfacing the count lets
        // an agent tell "no such control" from "reveal it first, then re-query"
        // instead of the tool silently deciding they do not exist.
        const latent = found.hits.filter(([i]) => st.controls[i] && !isActionableElement(st.controls[i].el)).length;
        if (kept.hits.length) return locateControlBody(description, limit, offset, kept,
          { role, affordance, landmark }, latent);
        // Which of the two things went wrong is the useful part. A filter that
        // ate live candidates is a different problem from a page with no such
        // control, and only the first is fixed by dropping the filter.
        const removedByFilter = filtered
          ? found.hits.filter(([i]) => !!st.controls[i] && isActionableElement(st.controls[i].el)).length - kept.hits.length
          : 0;
        return chain(lane.fuzzy(description, cfg.retrieval.fuzzyCount, cfg.retrieval.fuzzyFloor),
                    (f) => locateNoMatchBody(description,
                                             f.hits.filter(([i]) => !!st.controls[i] && isActionableElement(st.controls[i].el)), found.retrieval,
                                             removedByFilter, { role, affordance, landmark }));
      });
    });
  }

  /** A predicate over the control list, built from the agent's stated constraints. */
  function controlFilter(f: { role?: string | string[]; affordance?: string | string[]; landmark?: string }) {
    const roles = f.role ? new Set([f.role].flat()) : null;
    const affs = f.affordance ? new Set([f.affordance].flat()) : null;
    return (c: ProjectedNode) =>
      (!roles || roles.has(c.role))
      && (!affs || (c.affordances ?? []).some((a) => affs.has(a)))
      && (!f.landmark || c.landmark === f.landmark);
  }

  /** Keep rank order, drop what the agent ruled out, keep coverage aligned. */
  function applyFilter(found: ControlSearchResult, keep: (c: ProjectedNode) => boolean): ControlSearchResult {
    const hits: Hit[] = [];
    const coverage: number[] = [];
    found.hits.forEach(([i, score], rank) => {
      const c = st.controls[i];
      if (c && keep(c)) { hits.push([i, score]); coverage.push(found.coverage[rank] ?? 0); }
    });
    return { ...found, hits, coverage };
  }

  function locateControlBody(description: string, limit: number, offset: number,
                             found: ControlSearchResult,
                             filters: { role?: string | string[]; affordance?: string | string[]; landmark?: string },
                             latent = 0) {
    const hits = found.hits;
    const candidates = hits.slice(offset, offset + limit).map(([i, score], pageRank) => {
      const rank = offset + pageRank;
      const c = st.controls[i];
      const cov = found.coverage[rank] ?? 0;
      return {
        role: c.role, name: c.name,
        primary: c.primary,
        ...(c.row ? { row: c.row } : {}),
        ...(c.affordances?.length ? { affordances: c.affordances } : {}),
        // Provenance travels with the affordance so an agent can tell an
        // authored signal (`rel=next`) from our own guess (`name-pattern`).
        ...(c.affordanceVia ? { affordanceSource: c.affordanceVia } : {}),
        ...(c.controlsName ? { controls: c.controlsName } : {}),
        ...(c.relations?.length ? { relations: relationsOf(c) } : {}),
        state: { ...liveState(c), inert: c.inert },
        headingPath: c.headingPath,
        address: addr(c),
        score: +score.toFixed(3),
        queryCoverage: +cov.toFixed(2),
        confidence: confidenceFor(cov, cfg.retrieval),
        ...(c.inert ? { warning: 'This control is inert — a modal dialog is open. It cannot be activated.' } : {}),
      };
    });
    return locateRanked(description, limit, offset, candidates, hits, found, filters, latent);
  }

  /**
   * Nothing matched lexically. An empty list with no explanation leaves an agent
   * unable to tell "no such control exists" from "your wording missed", and with
   * no next move; the closest names, marked as a fuzzy guess, are a recovery path.
   */
  function locateNoMatchBody(description: string, near: Hit[], retrieval: RetrievalLane,
                             removedByFilter = 0,
                             constraints: { role?: unknown; affordance?: unknown; landmark?: unknown } = {}) {
    const applied = Object.entries(constraints)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
    return budget('locate_control', {
      status: 'not_found', recommendedAddress: null, confidence: 'low',
      confidenceBasis: 'No lexical control match; nearest names are recovery evidence only.',
      retrieval,
      candidates: [],
      ...(removedByFilter ? { removedByFilter, filters: applied } : {}),
      nearest: near.map(([i, dice]) => {
        const c = st.controls[i];
        return { role: c.role, name: c.name, ...(c.row ? { row: c.row } : {}),
                 headingPath: c.headingPath, address: addr(c),
                 similarity: +dice.toFixed(2), confidence: 'low' };
      }),
      note: removedByFilter
        ? `${removedByFilter} control(s) matched "${description}" but every one was removed by your filters (${applied.join(', ')}). `
          + 'Re-run without them, or check describe_app.vocabulary for the affordances this page actually declares.'
        : near.length
          ? 'No control matched your description lexically. These are the closest names on the page by character similarity — verify before acting.'
          : `No control on this page resembles that description. ${liveControls().length} control(s) are currently actionable; call describe_app to see what this view contains.`,
      nextCalls: [{ tool: 'describe_app', arguments: {},
        reason: 'Orient on the current view and its declared control vocabulary.' }],
    }, asIs);
  }

  function locateRanked(description: string, limit: number, offset: number,
                        candidates: ToolPayload[], hits: Hit[], found: ControlSearchResult,
                        filters: { role?: string | string[]; affordance?: string | string[]; landmark?: string },
                        latent = 0) {
    const makeContinuation = (sent: number) => offset + sent < hits.length ? {
      description, limit, offset: offset + sent, revision: st.version,
      ...(filters.role != null ? { role: filters.role } : {}),
      ...(filters.affordance != null ? { affordance: filters.affordance } : {}),
      ...(filters.landmark != null ? { landmark: filters.landmark } : {}),
    } : undefined;
    const scoreAmbiguous = offset === 0 && candidates.length > 1 && candidates[0].score > 0
      && (candidates[1].score / candidates[0].score) > cfg.retrieval.ambiguityRatio;
    // BM25 rank and query-term coverage are different evidence. The Devpost
    // trace placed the exact authored control below a generic higher-scoring
    // link while the lower row had stronger coverage. Calling that unambiguous
    // made the ranker look authoritative when its own evidence disagreed.
    const lowerStronger = offset === 0 && candidates.slice(1)
      .some((candidate) => (candidate.queryCoverage ?? 0) > (candidates[0]?.queryCoverage ?? 0));
    const exactNameRank = offset === 0
      ? candidates.findIndex((candidate) => typeof candidate.name === 'string'
        && semanticKey(candidate.name) === semanticKey(description))
      : -1;
    const exactNameConflict = exactNameRank > 0;
    const ambiguous = scoreAmbiguous || lowerStronger || exactNameConflict;
    const distinct = (values: unknown[]) => [...new Set(values.filter((v): v is string => typeof v === 'string' && !!v))];
    const roles = distinct(candidates.map((c) => c.role));
    const affordances = distinct(candidates.flatMap((c) => Array.isArray(c.affordances) ? c.affordances : []));
    const landmarks = distinct(candidates.map((c) => c.address?.landmark));
    const refineBy = {
      ...(roles.length > 1 ? { roles } : {}),
      ...(affordances.length > 1 ? { affordances } : {}),
      ...(landmarks.length > 1 ? { landmarks } : {}),
      ...(ambiguous && candidates.length > 1
        ? { names: distinct(candidates.map((c) => c.name)) } : {}),
    };
    const recommended = !ambiguous && candidates[0]?.confidence === 'high' ? 0 : null;
    const recommendedAddress = recommended === 0 ? candidates[0].address : null;
    const nextCalls = recommendedAddress ? [] : candidates[0]?.name ? [{
      tool: 'query_selector', arguments: { view: 'actions', name: candidates[0].name, limit: 4 },
      reason: 'Verify the copied identity only; this does not prove task fit.',
    }] : [];
    const out: ToolPayload = {
      status: recommendedAddress ? 'supported' : 'ambiguous',
      recommendedAddress,
      confidence: recommendedAddress ? candidates[0].confidence : 'low',
      retrieval: found.retrieval,
      candidates, matched: hits.length, returned: candidates.length, offset, revision: st.version,
      ...(latent ? { latent, latentNote: `${latent} more control(s) match but are not actionable now (hidden, disabled, or behind a closed disclosure). Reveal them — open the section or scroll — then locate_control again.` } : {}),
      confidenceBasis: 'informative query-term coverage; not correctness probability',
      recommended,
      ...(nextCalls.length ? { nextCalls } : {}),
      // `candidates.length &&` is load-bearing: `[].every()` is true, so an empty
      // list used to ship with a note asserting its candidates were weak.
      ...(candidates.length && candidates.every((c) => c.confidence === 'low')
        ? { note: 'Every candidate matched only a small part of your description. Treat these as weak guesses; consider find_on_page or describe_app first.' }
        : {}),
      // Ratio, not absolute difference: BM25 scores are unnormalised and scale
      // with idf and query length, so a fixed 0.15 gap flagged unrelated
      // controls on large corpora and missed genuine ties on small ones.
      ambiguous,
      ...(ambiguous && Object.keys(refineBy).length ? { refineBy } : {}),
      ...(recommended == null && candidates.length ? {
        hint: 'No candidate is safe to recommend from ranking alone. Refine by a returned discriminator or exact-inspect a copied candidate name.',
      } : {}),
      truncated: Math.max(0, hits.length - offset - candidates.length),
      ...(makeContinuation(candidates.length) ? { continuation: makeContinuation(candidates.length) } : {}),
    };
    return budget('locate_control', out,
      (o) => halveList(o, 'candidates', hits.length, offset, makeContinuation));
  }

  /**
   * One exact inspection surface, two authorities.
   *
   * `selector` preserves the developer/first-party escape hatch against the live
   * document. `view` exposes the projection the agent otherwise has no way to
   * browse: `actions` answers "what can I do?" and `structure` answers "what can
   * I see?". These are exact, document-order inventories, not a third ranker —
   * natural-language content and control intent still belong to find_on_page and
   * locate_control respectively.
   *
   * It is deliberately the LAST resort in the tool description, because a
   * selector is the thing this whole SDK exists to stop agents inventing: it
   * breaks on re-render, it carries no semantics, and an agent that guesses one
   * gets silence rather than an error. Handing it back as a tool is only
   * defensible because the results still carry ADDRESSES — so the agent can
   * select once and then act through the durable layer.
   *
   * Three properties make it safe enough to ship:
   *
   * 1. **It cannot bypass the privacy contract.** Matches inside an `exclude`
   *    subtree, inside `[data-naviquest-ignore]`, or inside `aria-hidden="true"`
   *    are dropped by `excludedDeep` — the SAME function the walk uses — and the
   *    count of what was dropped is reported rather than hidden. Text runs
   *    through the host's `redact` hook exactly as indexed text does. Without
   *    this, a host that paid the SDK to never return `[data-private]` would find
   *    one tool honouring that and another walking straight in.
   * 2. **A bad selector is an answer, not a throw.** `querySelectorAll` raises
   *    `SyntaxError` on malformed input, and nothing validates a tool call.
   * 3. **It is bounded and declares truncation**, like every other response.
   *
   * Exact inspection follows readable iframes by default; `frames: false` is a
   * cost opt-out. A non-null `contentDocument` is the access test — URL strings
   * cannot distinguish inherited-origin `srcdoc` from an opaque sandbox. A
   * missing document can mean cross-origin, sandboxed, or not loaded. Measured
   * on five large sites: of 36 iframes, 18 were same-origin
   * and reachable but held only 12-43 elements each, because the frames that
   * carry real content (ads, embeds, payment fields) are cross-origin by
   * construction. So this is genuinely useful for an app shell that frames its
   * own editor, and close to useless on a news site. The response says which
   * frames it could not enter rather than implying it searched everything.
   */
  function query_selector({ selector, view, limit = 10, offset = 0, revision,
                            frames, fields, role, affordance, landmark, name, heading }: {
    selector?: string; view?: string; limit?: number; offset?: number; revision?: number | string;
    frames?: boolean; fields?: string[]; role?: string | string[];
    affordance?: string | string[]; landmark?: string; name?: string; heading?: string;
  } = {}) {
    if (selector != null && (typeof selector !== 'string' || !selector.trim())) {
      return { error: 'INVALID_INPUT', message: 'selector must be a non-empty CSS selector string' };
    }
    if (view != null && (typeof view !== 'string' || !view.trim())) {
      return { error: 'INVALID_INPUT', message: 'view must be a non-empty string' };
    }
    if (frames != null && typeof frames !== 'boolean') {
      return { error: 'INVALID_INPUT', message: 'frames must be a boolean' };
    }
    if (fields != null && (!Array.isArray(fields) || !fields.every((f) => typeof f === 'string'))) {
      return { error: 'INVALID_INPUT', message: 'fields must be an array of strings or null' };
    }
    const hasSelector = selector != null;
    const hasView = view != null;
    if (hasSelector === hasView) {
      return { error: 'INVALID_INPUT', message: `pass exactly one of \`selector\` (known CSS) or \`view\` (${QUERY_VIEWS.join(', ')})` };
    }
    if (!positiveInt(limit) || !nonNegativeInt(offset)) {
      return { error: 'INVALID_INPUT', message: 'limit must be a positive integer and offset must be a non-negative integer' };
    }
    if (hasView) {
      if (!isQueryView(view)) {
        return { error: 'INVALID_INPUT', message: `view must be one of: ${QUERY_VIEWS.join(', ')}` };
      }
      if (fields || (view !== 'scopes' && frames != null)) {
        return { error: 'INVALID_INPUT', message: 'fields apply only to exact selector mode; frames applies to exact selector or scopes mode' };
      }
      if (view === 'forms') {
        if (role || affordance || landmark || name || heading) {
          return { error: 'INVALID_INPUT', message: 'the forms view takes no filters; it groups every form on the page' };
        }
        return chain(ensureFresh(), () => formsBody(limit, offset, revision));
      }
      if (view === 'scopes') {
        if (role || affordance || landmark || name || heading) {
          return { error: 'INVALID_INPUT', message: 'semantic filters do not filter query scopes' };
        }
        return chain(ensureFresh(), () => queryScopesBody(limit, offset, revision, frames ?? true));
      }
      if (view === 'structure' && (role || affordance || name)) {
        return { error: 'INVALID_INPUT', message: 'role, affordance and name filter actions; structure accepts landmark and heading' };
      }
      if (view === 'actions' && heading) {
        return { error: 'INVALID_INPUT', message: 'heading filters structure; actions accept role, affordance, landmark and name' };
      }
      return chain(ensureFresh(), () => querySemanticBody(view, limit, offset, revision, role, affordance, landmark, name, heading));
    }
    if (role || affordance || landmark || name || heading) {
      return { error: 'INVALID_INPUT', message: 'semantic filters apply only to semantic view mode' };
    }
    return chain(ensureFresh(), () => querySelectorBody(selector!, limit, offset, revision, frames ?? true, fields));
  }

  /** Which fields to emit per match. Default is the actionable set WITHOUT
   *  text; exact CSS can reach elements with arbitrarily large descendants,
   *  and slicing that text would leave no lossless recovery path. A caller
   *  that explicitly asks for `text` gets the complete redacted value and may
   *  receive `_overBudget` if even one indivisible row exceeds the ceiling. */
  const selectorElementIds = new WeakMap<Element, number>();
  const selectorScopeIds = new WeakMap<object, number>();
  let nextSelectorElementId = 1;
  let nextSelectorScopeId = 1;
  let nextSelectorCursorId = 1;
  const selectorCursors = new Map<string, { key: string; population: readonly string[] }>();

  const scopeIdentity = (root: object): number => {
    let id = selectorScopeIds.get(root);
    if (id == null) {
      id = nextSelectorScopeId++;
      selectorScopeIds.set(root, id);
    }
    return id;
  };

  const elementIdentity = (el: Element): number => {
    let id = selectorElementIds.get(el);
    if (id == null) {
      id = nextSelectorElementId++;
      selectorElementIds.set(el, id);
    }
    return id;
  };

  const newSelectorCursor = (key: string, population: readonly string[]): string => {
    const token = `q${(nextSelectorCursorId++).toString(36)}`;
    selectorCursors.set(token, { key, population: [...population] });
    while (selectorCursors.size > cfg.retrieval.selectorCursorEntries) {
      selectorCursors.delete(selectorCursors.keys().next().value!);
    }
    return token;
  };

  /**
   * Bind a numeric offset to the exact ordered population it follows.
   *
   * `etag()` is intentionally a compact 32-bit change hint; its own contract
   * tolerates a collision because the consequence is one missed refetch. A CSS
   * pagination collision can silently skip or repeat controls, so this path
   * retains a bounded exact identity sequence and compares every entry.
   */
  function selectorCursor(revision: string | undefined, offset: number, key: string,
                          population: readonly string[]): { revision: string } | ToolPayload {
    if (revision == null) {
      if (offset > 0) {
        return { error: 'INVALID_INPUT',
                 message: 'offset above 0 requires the revision copied from the previous page continuation' };
      }
      return { revision: newSelectorCursor(key, population) };
    }
    const saved = selectorCursors.get(revision);
    if (!saved) {
      return { error: 'CURSOR_EXPIRED',
               message: 'That exact-inspection cursor is no longer retained. Restart at offset 0 without revision.' };
    }
    const same = saved.key === key && saved.population.length === population.length
      && saved.population.every((value, i) => value === population[i]);
    if (!same) {
      return { error: 'STALE_CURSOR', revision: newSelectorCursor(key, population),
               message: 'The inspected population changed after that page. Restart at offset 0 with this replacement revision.' };
    }
    // Refresh insertion order so an actively copied continuation is not evicted
    // behind abandoned one-off queries.
    selectorCursors.delete(revision);
    selectorCursors.set(revision, saved);
    return { revision };
  }

  /**
   * `Element.textContent` includes excluded descendants. Returning it for an
   * allowed ancestor launders private text through `body`, `main`, or a wildcard
   * selector even though selecting the private child itself is refused. Walk
   * the authored subtree and prune with the projection's exclusion authority.
   * Same spaced text-node join as the content index — concatenating raw
   * nodeValues glued `permitClosed` (row-text evidence).
   */
  function selectorText(el: Element): string {
    return readingOrderText(el, (node) => node !== el && excludedDeep(node, exclude));
  }

  /**
   * Tell the agent which DOM trees exact inspection can actually enter.
   *
   * This is intentionally a mode of query_selector, not another tool name:
   * scopes answer "where can this exact query run?", while actions and
   * structure answer the two semantic navigation questions. Inaccessible frame
   * rows participate in the same pagination as accessible roots, so a page with
   * hundreds of embeds cannot silently lose the tail of its coverage report.
   */
  function queryScopesBody(limit: number, offset: number,
                           revision: number | string | undefined, frames: boolean) {
    if (revision != null && (typeof revision !== 'string' || !revision)) {
      return { error: 'INVALID_INPUT', message: 'scopes revision must be the string copied from a scopes continuation' };
    }
    const scan = queryScopes(document, {
      extra: st.projection.shadowRoots,
      frames,
      enter: (boundary) => !excludedDeep(boundary, exclude),
    });
    const population = [
      ...scan.scopes.map((scope) => ({
        status: 'searchable', path: scope.path, kind: scope.kind,
        frameDepth: scope.frameDepth, shadowDepth: scope.shadowDepth,
        ...(scope.frameLabel ? { frame: scope.frameLabel } : {}),
        ...(scope.host ? { host: scope.host.localName,
          ...(scope.host.id ? { hostId: scope.host.id } : {}) } : {}),
        ...(scope.registered ? { registered: true } : {}),
        _identity: `${scopeIdentity(scope.root as object)}:${scope.path}`,
      })),
      ...scan.unreachableFrames.map((frame) => ({
        status: frame.reason === 'excluded' ? 'excluded' : 'unreachable',
        path: frame.path, kind: 'frame', frame: frame.label,
        reason: frame.reason === 'excluded'
          ? 'The frame element is inside a host-excluded region.'
          : 'The parent page cannot read this frame document (cross-origin, sandboxed, or not loaded).',
        _identity: `${frame.path}:${frame.label}:${frame.reason}`,
      })),
    ];
    const cursor = selectorCursor(revision as string | undefined, offset,
      `scopes:${frames}`, population.map((row) => row._identity));
    if ('error' in cursor) return cursor;
    const scopeRevision = cursor.revision;
    const rows = population.slice(offset, offset + limit).map(({ _identity: _ignored, ...row }) => row);
    const continuation = (returned: number) => offset + returned < population.length
      ? { view: 'scopes', limit, offset: offset + returned, revision: scopeRevision, frames }
      : undefined;
    const out: ToolPayload = {
      view: 'scopes', revision: scopeRevision, frames, total: population.length,
      searchable: scan.scopes.length,
      unreachable: scan.unreachableFrames.filter((f) => f.reason === 'unavailable').length,
      excludedByHost: scan.unreachableFrames.filter((f) => f.reason === 'excluded').length,
      offset, returned: rows.length, results: rows,
      truncated: Math.max(0, population.length - offset - rows.length),
      ...(continuation(rows.length) ? { continuation: continuation(rows.length) } : {}),
      note: 'Each searchable path is a DocumentOrShadowRoot searched by exact CSS. Paths are traversal-local; copy continuations, not paths, across calls.',
    };
    return budget('query_selector', out,
      (o) => halveList(o, 'results', population.length, offset, continuation));
  }

  /**
   * Browse the already-built semantic model without serialising it wholesale.
   * Pagination carries the projection revision because numeric offsets are only
   * meaningful while the population is unchanged. Returning STALE_CURSOR is
   * safer than silently shifting the window after a re-render.
   */
  function querySemanticBody(view: 'actions' | 'structure', limit: number, offset: number,
                             revision: number | string | undefined, role?: string | string[],
                             affordance?: string | string[], landmark?: string,
                             name?: string, heading?: string) {
    if (offset > 0 && revision == null) {
      return { error: 'INVALID_INPUT', message: 'offset above 0 requires the revision copied from the continuation' };
    }
    if (revision != null && !nonNegativeInt(revision)) {
      return { error: 'INVALID_INPUT', message: 'revision must be the integer returned by a semantic view' };
    }
    if (revision != null && revision !== st.version) {
      return { error: 'STALE_CURSOR', revision: st.version,
               message: 'The page projection changed after that page of results. Restart at offset 0 with this revision.' };
    }
    if (role != null && !stringFilter(role)) {
      return { error: 'INVALID_INPUT', message: 'role must be a non-empty string or non-empty array of strings' };
    }
    if (affordance != null && !stringFilter(affordance)) {
      return { error: 'INVALID_INPUT', message: 'affordance must be a non-empty string or non-empty array of strings' };
    }
    if (landmark != null && !nonEmptyString(landmark)) {
      return { error: 'INVALID_INPUT', message: 'landmark must be a non-empty string' };
    }
    if (name != null && !nonEmptyString(name)) {
      return { error: 'INVALID_INPUT', message: 'name must be a copied non-empty accessible name' };
    }
    if (heading != null && !nonEmptyString(heading)) {
      return { error: 'INVALID_INPUT', message: 'heading must be copied non-empty heading text' };
    }

    const roles = role ? new Set([role].flat()) : null;
    const affordances = affordance ? new Set([affordance].flat()) : null;
    // This is a deterministic fallback, not a relevance lane. Locale-aware
    // case/diacritic folding plus whitespace normalization accepts copied text
    // across scripts while still refusing substring guesses.
    const wantedName = name == null ? null : semanticKey(name);
    const wantedHeading = heading == null ? null : semanticKey(heading);
    // `structure` is an address graph, not a chunk dump. Several segmentation
    // chunks can resolve to the same heading region; paging those duplicates
    // spent tokens and made `matched` larger than the number of distinct things
    // an agent could actually inspect. Coalesce by the public identity before
    // filtering and slicing, just as find_on_page does before its cursor.
    const structurePopulation: Chunk[] = [];
    const structureAddresses = new Set<string>();
    for (const c of st.seg.chunks) {
      const key = `${c.primary}:${JSON.stringify(regionAddress(c))}`;
      if (structureAddresses.has(key)) continue;
      structureAddresses.add(key);
      structurePopulation.push(c);
    }
    const source = view === 'actions'
      ? st.controls.filter((n) => isActionableElement(n.el)
          && (!roles || roles.has(n.role))
          && (!affordances || (n.affordances ?? []).some((a) => affordances.has(a)))
          && (!landmark || n.landmark === landmark)
          && (!wantedName || semanticKey(n.name ?? '') === wantedName))
      : structurePopulation.filter((c) => (!landmark || c.landmark === landmark)
          && (!wantedHeading || semanticKey(c.headingPath.at(-1) ?? '') === wantedHeading));
    const selected = source.slice(offset, offset + limit);
    const results = view === 'actions'
      ? (selected as ProjectedNode[]).map((n) => ({
          role: n.role, name: n.name,
          primary: n.primary,
          ...(n.row ? { row: n.row } : {}),
          landmark: n.landmark, headingPath: n.headingPath,
          ...(n.affordances?.length ? { affordances: n.affordances } : {}),
          ...(n.affordanceVia ? { affordanceSource: n.affordanceVia } : {}),
          ...(n.controlsName ? { controls: n.controlsName } : {}),
          ...(n.relations?.length ? { relations: relationsOf(n) } : {}),
          state: { ...liveState(n), inert: n.inert }, address: addr(n),
        }))
      : (selected as Chunk[]).map((c) => ({
          label: c.headingPath.at(-1) ?? c.text.slice(0, cfg.retrieval.anchorTextChars),
          primary: c.primary,
          landmark: c.landmark, headingPath: c.headingPath,
          chunkStrategy: c.strategy, textChars: c.text.length,
          ...(c.collapsed ? { collapsed: true, revealedBy: discloserFor(c) } : {}),
          address: regionAddress(c),
        }));
    const coverage = {
      elementsInspectedPct: st.projection.coverage.elementsInspectedPct,
      unknownShadowHosts: st.projection.coverage.unknownRoots,
      opaqueComponents: st.projection.coverage.opaqueComponents,
    };
    const out: ToolPayload = {
      view, scope: 'projection', revision: st.version,
      total: view === 'actions' ? liveControls().length : structurePopulation.length,
      matched: source.length, offset, returned: results.length, results, coverage,
      truncated: Math.max(0, source.length - offset - results.length),
      ...(offset + results.length < source.length
        ? { continuation: { view, limit, offset: offset + results.length, revision: st.version,
            ...(role != null ? { role } : {}), ...(affordance != null ? { affordance } : {}),
            ...(landmark != null ? { landmark } : {}), ...(name != null ? { name } : {}),
            ...(heading != null ? { heading } : {}) } }
        : {}),
      note: view === 'actions'
        ? 'Document-order actionable controls. Use locate_control to rank by a job; resolve an address immediately before acting.'
        : 'Document-order visible content regions. Use find_on_page to rank by a question; resolve an address to read the full section.',
    };
    return budget('query_selector', out, (o) => {
      o.results = (o.results ?? []).slice(0, halve(o.results?.length ?? 1));
      o.returned = o.results.length;
      o.truncated = Math.max(0, (o.matched ?? 0) - (o.offset ?? 0) - o.returned);
      o.continuation = o.truncated
        ? { view, limit, offset: (o.offset ?? 0) + o.returned, revision: st.version,
            ...(role != null ? { role } : {}), ...(affordance != null ? { affordance } : {}),
            ...(landmark != null ? { landmark } : {}), ...(name != null ? { name } : {}),
            ...(heading != null ? { heading } : {}) }
        : undefined;
      return o;
    });
  }

  /**
   * Each form on the page as ONE unit: the tally (required/filled/invalid) plus
   * the submit control. An agent filling a form pays N locate_control calls today
   * and still cannot tell whether it is complete; this answers "how much is left"
   * in one call. The facts already exist per-node in `statesOf` — this is a rollup,
   * not new indexing.
   */
  function formsBody(limit: number, offset: number, revision: number | string | undefined) {
    if (offset > 0 && revision == null) {
      return { error: 'INVALID_INPUT', message: 'offset above 0 requires the revision copied from the continuation' };
    }
    if (revision != null && !nonNegativeInt(revision)) {
      return { error: 'INVALID_INPUT', message: 'revision must be the integer returned by the forms view' };
    }
    if (revision != null && revision !== st.version) {
      return { error: 'STALE_CURSOR', revision: st.version,
               message: 'The page projection changed after that page of forms. Restart at offset 0 with this revision.' };
    }
    const byForm = new Map<Element, ProjectedNode[]>();
    for (const n of st.controls) {
      if (!isActionableElement(n.el)) continue;
      const form = (n.el as HTMLInputElement).form || flatClosest(n.el, 'form');
      if (!form) continue;
      let list = byForm.get(form);
      if (!list) { list = []; byForm.set(form, list); }
      list.push(n);
    }
    const all = [...byForm.entries()].map(([formEl, controls]) => {
      let required = 0, requiredFilled = 0, filled = 0, invalid = 0;
      let submit: ToolPayload | undefined;
      const fields = controls.map((n) => {
        const state = { ...liveState(n), inert: n.inert };
        if (state.required) required++;
        if (state.valuePresent) filled++;
        if (state.required && state.valuePresent) requiredFilled++;
        if (state.invalid) invalid++;
        // Declared submit signal — type=submit (a <button> in a form defaults to
        // it) or an authored submit affordance — never a name regex, which would
        // be the rigid English-only pattern the rigidity audit removed.
        if (!submit && ((n.el as HTMLInputElement | HTMLButtonElement).type === 'submit'
            || (n.affordances ?? []).includes('submit'))) {
          submit = { role: n.role, name: n.name, address: addr(n) };
        }
        return { role: n.role, name: n.name, state, address: addr(n) };
      });
      const label = formEl.getAttribute('aria-label')?.trim() || undefined;
      return {
        ...(label ? { name: label } : {}),
        fields: controls.length, required, requiredFilled, filled, invalid,
        complete: required > 0 && requiredFilled === required && invalid === 0,
        ...(submit ? { submit } : {}),
        controls: fields,
      };
    });
    const selected = all.slice(offset, offset + limit);
    const out: ToolPayload = {
      view: 'forms', scope: 'projection', revision: st.version,
      total: all.length, matched: all.length, offset, returned: selected.length, results: selected,
      truncated: Math.max(0, all.length - offset - selected.length),
      ...(offset + selected.length < all.length
        ? { continuation: { view: 'forms', limit, offset: offset + selected.length, revision: st.version } } : {}),
      note: 'Each form as a unit: the required/filled/invalid tally plus the submit control. Fill a field by its address; resolve_address immediately before acting.',
    };
    return budget('query_selector', out, (o) => {
      o.results = (o.results as ToolPayload[] ?? []).slice(0, halve((o.results as unknown[])?.length ?? 1));
      o.returned = (o.results as unknown[]).length;
      o.truncated = Math.max(0, (o.matched as number ?? 0) - (o.offset as number ?? 0) - o.returned);
      o.continuation = o.truncated
        ? { view: 'forms', limit, offset: (o.offset as number ?? 0) + o.returned, revision: st.version } : undefined;
      return o;
    });
  }

  function querySelectorBody(selector: string, limit: number, offset: number,
                             revision: number | string | undefined, frames: boolean, fields?: string[]) {
    if (revision != null && (typeof revision !== 'string' || !revision)) {
      return { error: 'INVALID_INPUT', message: 'CSS revision must be the string copied from a selector continuation' };
    }
    if (Array.isArray(fields) && fields.some((f) => !(QS_FIELDS as readonly string[]).includes(f))) {
      return { error: 'INVALID_INPUT', message: `fields must be a subset of ${QS_FIELDS.join(', ')}` };
    }
    const want = new Set(
      Array.isArray(fields) && fields.length
        ? fields
        : ['tag', 'role', 'name', 'state', 'address', 'scope'],
    );

    const scan = queryScopes(document, {
      extra: st.projection.shadowRoots,
      frames,
      // Frame descendants cannot climb through their embedding element with
      // flatParentElement. Refuse the boundary here or an excluded iframe host
      // would become a privacy bypass even though every inner match passed the
      // ordinary ancestor check in its own document.
      enter: (boundary) => !excludedDeep(boundary, exclude),
    });
    let excluded = 0;
    const matches: Array<{ el: Element; scope: (typeof scan.scopes)[number] }> = [];
    for (const scope of scan.scopes) {
      let found: Element[];
      try { found = [...scope.root.querySelectorAll(selector)]; } catch (e) {
        return { error: 'INVALID_INPUT',
                 message: `selector did not parse: ${(e as Error)?.message ?? 'SyntaxError'}` };
      }
      for (const el of found) {
        // The privacy contract, enforced with the walk's own function.
        if (excludedDeep(el, exclude)) { excluded++; continue; }
        // Collect the complete eligible population before applying the page
        // window. Stopping when `rows.length === limit` made `matched` depend
        // on traversal progress and left no offset from which an agent could
        // recover later document, shadow-root, or frame matches.
        matches.push({ el, scope });
      }
    }

    // The projection revision cannot protect exact CSS pagination: this mode
    // deliberately reaches outside the indexed root and into iframe documents,
    // neither of which is necessarily observed by the projection lifecycle.
    // Retain and exactly compare the ordered element/root identities so a short
    // hash collision cannot advance an agent past rows it never received.
    const cursor = selectorCursor(revision as string | undefined, offset,
      `selector:${selector}:frames:${frames}:fields:${JSON.stringify(fields ?? null)}`,
      matches.map(({ el, scope }) => `${scopeIdentity(scope.root)}:${elementIdentity(el)}:${scope.path}`));
    if ('error' in cursor) return cursor;
    const populationRevision = cursor.revision;

    const page = matches.slice(offset, offset + limit);
    const rows = page.map(({ el, scope }) => {
      const node = nodeForElement(el);
      const row: ToolPayload = {};
      if (want.has('tag')) row.tag = el.tagName.toLowerCase();
      if (want.has('scope')) row.scope = scope.path;
      if (want.has('frame') && scope.frameLabel) row.frame = scope.frameLabel;
      if (want.has('role')) row.role = node?.role ?? roleOf(el);
      if (want.has('name')) row.name = node?.name ?? null;
      if (want.has('text')) {
        const raw = selectorText(el);
        const full = redact ? redact(raw, el) : raw;
        // Bounded with the SAME vocabulary find_on_page uses for a clipped
        // passage, so an agent learns one truncation contract, not three.
        // Clipped after redaction: the cap must describe what is returned.
        if (full.length > cfg.retrieval.selectorTextChars) {
          row.text = `${full.slice(0, cfg.retrieval.selectorTextChars)}…`;
          row.textChars = full.length;
          row.textIsExcerpt = true;
          if (node) row.readFullTextWith = 'resolve_address';
          else row.textNote = 'Truncated, and outside the indexed root — there is no address to read the rest with. Narrow the selector.';
        } else {
          row.text = full;
        }
      }
      if (want.has('state')) row.state = node ? liveState(node) : statesOf(el);
      if (want.has('box')) {
        row.box = boxOf(el);
        // A child document's DOMRect is relative to that document's viewport,
        // not to the top-level screenshot. Parent-offset arithmetic is wrong
        // under nested frames, borders, transforms, and zoom; preserve the
        // coordinate space so the privileged browser companion can scope its
        // crop/action to the returned frame provenance.
        row.boxSpace = scope.frameDepth > 0 ? 'scope-viewport' : 'top-level-viewport';
      }
      if (want.has('attributes')) {
        // Which attributes carry semantics is a judgement, so it lives in
        // config (`retrieval.qsAttributes`) — a trailing `-` is a prefix.
        const at: Record<string, string> = {};
        for (const a of el.attributes) {
          if (cfg.retrieval.qsAttributes.some((q) => q.endsWith('-') ? a.name.startsWith(q) : a.name === q)) at[a.name] = a.value;
        }
        row.attributes = at;
      }
      if (want.has('address')) {
        // An address only exists for an element the projection actually saw.
        // A match outside the indexed root, or one the walk skipped, is real
        // but not addressable — and saying so is the point: an agent handed a
        // silent `null` cannot tell "no address" from "address forgotten".
        row.address = node ? addr(node) : null;
        if (!node) {
          row.addressNote = 'Outside the indexed root or skipped by the projection — not addressable. Act via a selector at your own risk, or re-query inside the root.';
          // The note told the agent to use a selector and gave it none. Its own
          // query may have matched forty elements, so "a selector" was not
          // enough to act on THIS one. Same field name resolve_address uses, so
          // there is one vocabulary for a generated selector, and the same
          // caveat: generated fresh, never stored, never an identity.
          row.selectorOfLastResort = selectorOfLastResort(el, cfg.address.selectorMaxDepth);
        }
      }
      return row;
    });

    const continuation = (returned: number) => offset + returned < matches.length
      ? { selector, limit, offset: offset + returned, revision: populationRevision, frames,
          ...(fields != null ? { fields } : {}) }
      : undefined;

    const out: ToolPayload = {
      selector, revision: populationRevision, matched: matches.length, offset,
      returned: rows.length, results: rows,
      scopesSearched: scan.scopes.length,
      treesSearched: scan.scopes.length,
      documentsSearched: scan.scopes.filter((scope) => scope.kind === 'document').length,
      shadowTreesSearched: scan.scopes.filter((scope) => scope.kind === 'shadow').length,
      registeredRootsSearched: scan.scopes.filter((scope) => scope.registered).length,
      truncated: Math.max(0, matches.length - offset - rows.length),
      ...(continuation(rows.length) ? { continuation: continuation(rows.length) } : {}),
      // Never silent: a host's exclusion removing matches is information the
      // agent needs, or it will read `matched: 0` as "no such element".
      ...(excluded ? { excludedByHost: excluded,
                       note: `${excluded} match(es) were inside a region this site excludes from agent access and are not returned.` } : {}),
      ...(frames ? {
        framesSearched: scan.scopes.filter((scope) => scope.kind === 'document' && scope.frameDepth > 0).length,
        framesUnreachable: scan.unreachableFrames.filter((f) => f.reason === 'unavailable')
          .map(({ path, label }) => ({ path, label })),
        framesExcludedByHost: scan.unreachableFrames.filter((f) => f.reason === 'excluded').length,
        framesNote: 'Unreachable frame documents may be cross-origin, sandboxed, or not loaded. Their descendants were not searched; use view:"scopes" for the paged scope graph.',
      } : {}),
    };
    // Rows are the unit of pagination, so budget pressure can remove only a
    // suffix of whole rows. Deleting `text` used to create a continuation that
    // advanced past data the agent had never received.
    return budget('query_selector', out,
      (o) => halveList(o, 'results', matches.length, offset, continuation));
  }

  async function listOpaqueBody(limit: number, offset: number, describe = false) {
    // Converts an invisible hole into an addressable one. We never guess what
    // an unlabelled graphic depicts; we say where it is so a vision-capable
    // agent can look, and why we could not read it.
    // Geometry is viewport state, not semantic index state. A scroll changes
    // every screenshot coordinate without a MutationObserver record, and
    // reindexing on scroll would turn high-volume input into full projection
    // churn. Retain the live Element internally and measure boxes here instead.
    // Preserve the projection-time population and order for lossless numeric
    // pagination; refresh only each row's coordinates. A geometry-only change
    // has no semantic revision, so filtering/sorting here would make a copied
    // continuation skip or duplicate rows.
    const source = st.projection.opaque.map((o) => ({ ...o, box: boxOf(o.el) }));
    const unlocated = st.projection.opaqueWithoutGeometry;
    const page = source.slice(offset, offset + limit);
    // Opt-in read of each unreadable graphic. SEQUENTIAL so N model clones never
    // co-reside; bounded by the page slice, so the agent owns the cost via limit
    // (a multimodal call is seconds — small limits are the point). Fail-open.
    const descriptions: Array<string | null> = [];
    if (describe) for (const o of page) descriptions.push(await opaqueDescriber.describe(o.el, o.nearestHeading ?? undefined));
    const regions = page.map((o, i) => ({
      tag: o.tag, role: o.role, reason: o.reason,
      ...(o.frame ? { frame: o.frame } : {}),
      chartLibrary: o.chartLibrary,
      headingPath: o.headingPath, nearestHeading: o.nearestHeading,
      box: o.box,
      filenameHint: o.filenameHint,
      rejected: o.rejectedCandidates,
      ...(describe && descriptions[i] ? { description: descriptions[i] } : {}),
    }));
    const out: ToolPayload = {
      regions,
      total: source.length,
      offset, returned: regions.length, revision: st.version,
      truncated: Math.max(0, source.length - offset - regions.length),
      ...(offset + regions.length < source.length ? {
        continuation: { opaque: true, limit, offset: offset + regions.length, revision: st.version },
      } : {}),
      ...(unlocated ? {
        unlocated,
        geometryNote: `${unlocated} additional unreadable element(s) currently have no non-zero box, so page JavaScript cannot provide a screenshot target for them.`,
      } : {}),
      note: describe
        ? 'These carry meaning the text index cannot read; `description` is an on-device model read of the pixels (absent where no model was available). filenameHint is a low-confidence URL guess, never author-written text.'
        : 'These carry meaning the text index cannot read. Add `describe: true` to read canvas/image regions with an on-device model (slow — use a small limit). filenameHint is a low-confidence URL guess, never author-written text.',
    };
    return budgetMode('list_opaque_regions', 'describe_app', (args) => args as ToolPayload, out, (o) => {
      // Dropping one row per step cannot fit a 25-row response inside the
      // budgeter's 12-step safety bound: Wikipedia stopped at 13 rows and 831
      // tokens against a 700-token ceiling. Halving converges while retaining
      // the prominence order; `truncated` is recomputed from the located total.
      if ((o.regions?.length ?? 0) > 1) {
        o.regions = o.regions.slice(0, halve(o.regions.length));
        o.returned = o.regions.length;
        o.truncated = Math.max(0, source.length - offset - o.regions.length);
        o.continuation = { opaque: true, limit, offset: offset + o.regions.length, revision: st.version };
      }
      // Rejected alternatives explain why a box stayed opaque. They are part of
      // the record, not expendable decoration; a single large record may exceed
      // the ceiling but is never silently weakened.
      return o;
    });
  }

  /**
   * The act seam.
   *
   * This SDK is read-only by design, so the agent clicks through its own
   * harness — which means an address has to be usable by a tool this SDK does
   * not own. `resolve()` hands a live Element to page JavaScript; an MCP client
   * cannot hold one. This returns what an outside tool can actually use: a box
   * to click, the element's current state, and a selector explicitly marked as
   * a last resort rather than an identity.
   */
  function resolve_address({ address, scrollIntoView = false, expand = false }: {
    address?: Address; scrollIntoView?: boolean; expand?: boolean;
  } = {}) {
    // NOT_FOUND and INVALID_INPUT are different instructions. `resolve()` guards
    // the non-object case itself and answers NOT_FOUND, which is right for a
    // stale address and wrong for a malformed one: it tells the agent the
    // element is gone when the truth is that it passed a string. An agent acts
    // on that difference — re-search versus fix the call.
    if (!address || typeof address !== 'object' || Array.isArray(address)) {
      return { error: 'INVALID_INPUT', message: 'address must be the address object a previous tool returned, copied back verbatim' };
    }
    const nullableString = (v: unknown) => v === null || typeof v === 'string';
    if (!nonEmptyString(address.role) || !nullableString(address.name)
      || (address.frame != null && !nonEmptyString(address.frame))
      || !nullableString(address.landmark) || !nullableString(address.landmarkName)
      || !nullableString(address.row)
      || !Array.isArray(address.headingPath) || !address.headingPath.every((x) => typeof x === 'string')
      || !nonNegativeInt(address.ordinal) || !positiveInt(address.peerCount)
      || (address.resolveWith != null && address.resolveWith !== 'read_region' && address.resolveWith !== 'resolve_address')
      || (address.headingScope != null && address.headingScope !== 'subtree' && address.headingScope !== 'outline')) {
      return { error: 'INVALID_INPUT', message: 'address is malformed; copy the complete address object returned by a tool without editing it' };
    }
    if (typeof scrollIntoView !== 'boolean' || typeof expand !== 'boolean') {
      return { error: 'INVALID_INPUT', message: 'scrollIntoView and expand must be booleans' };
    }
    // ONE tool for "act on this address", dispatched by the address itself.
    // `read_region` was a separate tool, and the split created the exact failure
    // D40 documents: two structurally identical address objects needing
    // different tools, with the agent left to route between them. The address
    // already carries `resolveWith`, so the routing is the tool's job now.
    // `expand: true` forces the region read for any heading-path address — the
    // old read_region capability, preserved for expanding around a control.
    if (address.resolveWith === 'read_region' || expand) {
      return chain(ensureFresh(), () => readRegionBody(address));
    }
    return chain(ensureFresh(), () => resolveAddressBody(address, scrollIntoView));
  }
  function resolveAddressBody(address: Address, scrollIntoView: boolean) {
    const r = resolve(address, st.projection, cfg.address);
    if (r.status !== 'RESOLVED') {
      return budget('resolve_address', resolutionMiss(r), asIs);
    }
    const el = r.element;
    if (scrollIntoView) { try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch {} }
    const rect = el.getBoundingClientRect?.() ?? { x: 0, y: 0, width: 0, height: 0 };
    const node = r.node;
    const fallbackSelector = selectorOfLastResort(el, cfg.address.selectorMaxDepth);
    // CSSOM View deliberately keeps the layout viewport (`innerWidth/Height`)
    // separate from the pinch-zoom visual viewport. DOMRects use layout
    // coordinates, so compare them with the visual viewport's offset bounds.
    // The old zero-origin layout check reported a target below the zoomed view
    // as visible, inviting a coordinate action at pixels the user could not
    // see. `visualViewport` is optional; the fallback preserves older engines.
    const visual = globalThis.visualViewport;
    const viewportLeft = visual?.offsetLeft ?? 0;
    const viewportTop = visual?.offsetTop ?? 0;
    const viewportRight = viewportLeft + (visual?.width ?? innerWidth);
    const viewportBottom = viewportTop + (visual?.height ?? innerHeight);
    const actionableNow = isActionableElement(el);
    const navigation = liveNavigationOf(el);
    const out: ToolPayload = {
      status: 'RESOLVED',
      ...(r.relaxed ? { relaxed: true, note: r.note } : {}),
      role: node.role,
      name: node.name,
      ...(node.row ? { row: node.row } : {}),
      state: { ...liveState(node), inert: node.inert },
      actionable: actionableNow && !node.inert,
      ...(node.relations?.length ? { relations: relationsOf(node) } : {}),
      ...(navigation ? { navigation } : {}),
      box: boxOf(el),
      inViewport: rect.width > 0 && rect.height > 0
        && rect.top < viewportBottom && rect.bottom > viewportTop
        && rect.left < viewportRight && rect.right > viewportLeft,
      selectorOfLastResort: fallbackSelector,
      selectorWarning: fallbackSelector
        ? 'Generated now, never stored. Prefer the address; this selector breaks on re-render.'
        : 'This element is inside a shadow tree. Standard CSS cannot address it from document; use the address, box, or the page-side resolve(address) Element.',
      ...(node.inert ? { warning: 'A modal dialog is open — this control is inert and cannot be activated.' } : {}),
      ...(!actionableNow ? { warning: 'This element still resolves, but its current CSS/layout makes it non-actionable. Search again after the view changes; do not click its box.' } : {}),
    };
    return budget('resolve_address', out, asIs);
  }

  function readRegionBody(address: Address) {
    const textOffset = address.textOffset ?? 0;
    const controlOffset = address.controlOffset ?? 0;
    if (!nonNegativeInt(textOffset) || !nonNegativeInt(controlOffset)) {
      return { error: 'INVALID_INPUT', message: 'address textOffset/controlOffset must be non-negative integers returned in a continuation' };
    }
    if (address.textRevision != null && address.textRevision !== st.version) {
      return { error: 'STALE_CURSOR', revision: st.version,
               message: 'The page changed after this region page was returned. Resolve the original address again from the beginning.' };
    }
    const anchor = typeof address.anchorText === 'string' ? address.anchorText.trim() : null;
    const projectionOrder = new Map(st.projection.nodes.map((node, index) => [node.el, index]));
    const headingLevel = (node: ProjectedNode): number => {
      const authored = Number(node.el.getAttribute('aria-level'));
      if (Number.isInteger(authored) && authored > 0) return authored;
      const native = /^h([1-6])$/u.exec(node.el.localName)?.[1];
      return native ? Number(native) : Math.max(1, node.headingPath.length);
    };
    let sameRegion: Chunk[];
    if (address.headingScope === 'outline') {
      const resolvedHeading = resolve(address, st.projection, cfg.address);
      const heading = resolvedHeading.status === 'RESOLVED' ? resolvedHeading.node : null;
      const start = heading ? projectionOrder.get(heading.el) : undefined;
      if (heading && start != null) {
        const level = headingLevel(heading);
        const next = st.projection.nodes.find((_node, index) => index > start
          && _node.isHeading && headingLevel(_node) <= level);
        const end = next ? projectionOrder.get(next.el) ?? st.projection.nodes.length : st.projection.nodes.length;
        sameRegion = st.seg.chunks.filter((chunk) => {
          if ((chunk.frame ?? undefined) !== (address.frame ?? undefined)) return false;
          const positions = chunk.els.map((el) => projectionOrder.get(el)).filter((value): value is number => value != null);
          return positions.some((position) => position >= start && position < end);
        });
      } else sameRegion = [];
    } else {
      sameRegion = st.seg.chunks.filter(
        // A frame region never expands into a same-heading top-document chunk:
        // read_region must not cross the frame boundary it was addressed within.
        (c) => (c.frame ?? undefined) === (address.frame ?? undefined)
          && (address.headingScope === 'subtree'
          ? c.headingPath.length >= address.headingPath.length
            && address.headingPath.every((part, index) => c.headingPath[index] === part)
          : samePath(c.headingPath, address.headingPath ?? []))
          && (address.landmark == null || c.landmark === address.landmark)
      );
    }
    // The anchor identifies one logical region; it must not filter every sibling
    // chunk or expansion would return only the first passage. Once identified,
    // provenance prevents equal heading paths in shell and primary content from
    // being merged into one confidently wrong answer.
    const anchored = address.headingScope === 'outline' ? [] : anchor ? sameRegion.filter((c) =>
      c.text.startsWith(anchor.slice(0, cfg.retrieval.anchorTextChars)) || c.text.includes(anchor)) : [];
    const selectedPrimary = anchored[0]?.primary;
    const matching = address.headingScope !== 'outline' && anchor && !anchored.length ? []
      : sameRegion.filter((c) => selectedPrimary == null || c.primary === selectedPrimary);
    if (!matching.length) {
      // Same miss shape as the control path (resolveAddressBody): a region that
      // no longer matches is NOT_FOUND / AMBIGUOUS with a recovery hint, not a
      // generic `error` — the `error` field forced `outcome:'error'` in
      // withOutcome, so equal misses reported two different outcomes.
      const r = resolve(address, st.projection, cfg.address);
      if (r.status !== 'RESOLVED') return budget('resolve_address', resolutionMiss(r), asIs);
      // The address resolved to an element, but no indexed chunk carries its
      // region text (a heading whose body never entered the passage index).
      // NOT_FOUND with a region-specific recovery, not a generic error.
      return budget('resolve_address', { status: 'NOT_FOUND',
        hint: 'The address resolved to an element but no readable region is indexed under it; re-run find_on_page for a current region address.' }, asIs);
    }
    const fullText = matching.map((c) => c.text).join('\n\n');
    const text = fullText.slice(textOffset);
    const outlineControls = address.headingScope === 'outline'
      ? [...new Map(matching.flatMap(controlsInRegion).map((node) => [node.el, node])).values()]
      : null;
    const allControls = (outlineControls ?? (matching.length === 1 ? controlsInRegion(matching[0])
      : st.controls.filter((n) => isActionableElement(n.el)
          && samePath(n.headingPath, address.headingPath ?? [])
          && (selectedPrimary == null || n.primary === selectedPrimary))))
      .map((n) => ({ role: n.role, name: n.name, state: liveState(n), address: addr(n) }));
    const controlsIn = allControls.slice(controlOffset);
    const collapsed = matching.filter((c) => c.collapsed);
    const out: ToolPayload = { status: 'RESOLVED', kind: 'region',
      headingPath: address.headingPath, landmark: address.landmark,
      text, textOffset, totalTextChars: fullText.length,
      controls: controlsIn, controlOffset, totalControls: allControls.length,
      returnedControls: controlsIn.length, merged: matching.length,
      ...(collapsed.length ? {
        collapsed: true,
        revealedBy: discloserFor(collapsed[0]),
        note: 'Part of this region is behind a closed disclosure. The text is included, but nothing inside it can be activated until that control is opened.',
      } : {}) };
    return budgetMode('read_region', 'resolve_address', (address) => ({ address }), out, (o) => {
      const controlsCost = est(o.controls ?? []);
      const textCost = est(o.text ?? '');
      if ((o.controls?.length ?? 0) > 1 && controlsCost >= textCost) {
        o.controls = o.controls.slice(0, halve(o.controls.length));
      } else if ((o.text?.length ?? 0) > cfg.response.regionTextFloorChars) {
        o.text = shrinkText(o.text, cfg.response.regionTextFloorChars, cfg.response.textKeepRatio);
      } else if ((o.controls?.length ?? 0) > 1) {
        o.controls = o.controls.slice(0, halve(o.controls.length));
      }
      o.returnedControls = o.controls?.length ?? 0;
      const nextText = textOffset + (o.text?.length ?? 0);
      const nextControl = controlOffset + o.returnedControls;
      const moreText = nextText < fullText.length;
      const moreControls = nextControl < allControls.length;
      o.truncated = moreText || moreControls;
      o.continuation = moreText || moreControls
        ? { ...address, textOffset: nextText, controlOffset: nextControl, textRevision: st.version }
        : undefined;
      o.remainingTextChars = Math.max(0, fullText.length - nextText);
      o.remainingControls = Math.max(0, allControls.length - nextControl);
      return o;
    });
  }

  /**
   * State, read at ANSWER time rather than at index time.
   *
   * `el.checked = true` and a typed `value` are PROPERTIES. They change no
   * attribute, add no node, and leave the element count identical — so a
   * MutationObserver, and therefore the freshness check built on it, is
   * structurally blind to them. That is exactly the state an agent most needs:
   * what the human just did to the form. Found by driving the demo's own
   * assistant — tick a document checkbox and it still reported it outstanding.
   *
   * Re-reading costs one attribute walk per RETURNED candidate, which is
   * nothing, and it is the difference between an assistant that can see a
   * ticked box and one that argues with the resident about it.
   */
  const liveState = (n: ProjectedNode): States => (n.el && n.interactive ? statesOf(n.el) : n.states ?? {});

  // Ordinal and peerCount are precomputed on the projection node during
  // reindex(), so this works for spread copies too and costs nothing per call.
  const addr = (n: ProjectedNode): Address => addressOf(n, n.ordinal ?? 0, n.peerCount ?? 1);

  /** Compact, redacted semantic facts. History contains no DOM nodes or values. */
  // A region an agent should read as the page ANNOUNCING an outcome.
  const LIVE_REGION_SEL = '[role~="alert"],[role~="status"],[aria-live="polite"],[aria-live="assertive"]';
  // Outcome text is a bounded observation, not a passage — keep it short. The
  // ellipsis replaces the last kept character, so the result never exceeds the cap.
  const clipOutcome = (s: string) => {
    s = s.trim();
    const cap = cfg.response.outcomeChars;
    return s.length > cap ? `${s.slice(0, cap - 1)}…` : s;
  };
  /**
   * The page's OWN validation message for an invalid control. `aria-errormessage`
   * is resolved under the SAME exclusion authority as `aria-describedby` so it
   * cannot launder text out of an excluded subtree; the native constraint
   * message is the fallback. Never a field value — only the stated error.
   */
  const errorTextOf = (el: Element): string | undefined => {
    let msg = '';
    for (const id of (el.getAttribute('aria-errormessage') || '').split(/\s+/).filter(Boolean)) {
      const t = idRefTarget(el, id);
      if (t && !excludedDeep(t, exclude)) {
        const text = readingOrderText(t, (node) => node !== t && excludedDeep(node, exclude)).trim();
        if (text) msg = msg ? `${msg} ${text}` : text;
      }
    }
    if (!msg) {
      const input = el as HTMLInputElement;
      if (input.willValidate && input.validity && !input.validity.valid && input.validationMessage) msg = input.validationMessage;
    }
    return msg ? clipOutcome(msg) : undefined;
  };

  function semanticSnapshot(): SemanticSnapshot {
    const idOf = (el: Element) => {
      let id = elementIds.get(el);
      if (id == null) { id = nextElementId++; elementIds.set(el, id); }
      return id;
    };
    const controls = st.controls.map((n) => {
      const state = { ...liveState(n), inert: n.inert };
      // aria-errormessage is only meaningful while aria-invalid is set (ARIA 1.2).
      const errorText = state.invalid && n.el ? errorTextOf(n.el) : undefined;
      return {
        id: idOf(n.el), address: addr(n), role: n.role, name: n.name,
        state,
        actionable: isActionableElement(n.el) && !n.inert,
        ...(errorText ? { errorText } : {}),
      };
    });
    // Keyed on the chunk's FIRST ELEMENT, not its container. A region that
    // exceeds `segment.maxWords` splits into several chunks that share one
    // common ancestor and one address (regionKey drops anchorText), so a
    // container-keyed fact made every chunk after the first indistinguishable
    // from its predecessor: the ledger matched one and reported the other
    // `region-removed` on every single observation, for a region that was
    // still on the page. First elements are distinct per chunk by construction.
    const regions = st.seg.chunks.map((c) => {
      const start = c.container ?? c.els[0] ?? null;
      const live = start ? flatClosest(start, LIVE_REGION_SEL) : null;
      return {
        id: idOf(c.els[0] ?? c.container!),
        address: regionAddress(c), hash: etag(c.text), chars: c.text.length,
        ...(live ? { live: true, liveText: clipOutcome(c.text) } : {}),
      };
    });
    const coverageGaps = [
      ...(st.projection.coverage.unindexedFrameDocuments ? ['unindexed-frame-documents'] : []),
      ...(st.projection.coverage.unknownRoots ? ['closed-shadow-roots'] : []),
    ];
    return {
      projectionRevision: st.version,
      view: { title: document.title, path: location.pathname + location.hash,
        heading: st.projection.nodes.find((n) => n.isHeading && n.primary)?.text
          ?? st.projection.nodes.find((n) => n.isHeading)?.text ?? null },
      modal: modalState(detectModal(st.projection.shadowRoots)),
      controls, regions,
      coverage: { indexedControls: st.controls.length, sampledControls: controls.length,
        completeForIndexedSurface: autoReindex,
        gaps: [...coverageGaps, ...(!autoReindex ? ['manual-reindex-required'] : [])] },
    };
  }

  /**
   * What sending the whole accessibility projection would cost, approximately.
   * Computed once per index — it was walking every node twice in one expression,
   * on every describe_app call.
   */
  /** Cached per index — the projection does not change between rebuilds. */
  function treeTokens() {
    return st.treeTokenCache ??= computeTreeTokens(st.projection.nodes, cfg.text.charsPerToken);
  }

  /**
   * The controls an agent can actually act on having read THIS passage.
   *
   * Matching on the heading path alone was fine until the path was empty, and
   * on real pages it very often is: samePath([], []) matches every pathless
   * control on the page, so on Wikipedia all 99 chunks offered the same three
   * global nav links ("Jump to content", …) as their actionable controls.
   * Containment inside the chunk's own region is what "inside this passage"
   * actually means.
   */
  /**
   * The answer to this query, preferring one the page states EXPLICITLY.
   *
   * schema.org `FAQPage`/`QAPage` is the only place on the web where an answer
   * is machine-identified as the answer to a stated question, so when the query
   * matches one of those questions closely enough it is quoted verbatim. The
   * threshold is deliberately high: quoting the wrong answer as though the page
   * said it is the worst failure this feature can have, and it is worse than
   * returning a passage and letting the agent read.
   *
   * Otherwise the best sentence in the best-ranked passage, scored against the
   * INFORMATIVE query terms — see lane.ts for why not every token.
   */
  async function bestAnswer(query: string, found: ContentSearchResult, results: ToolPayload[], ranked: Hit[]): Promise<ToolPayload | null> {
    // NO fallback to the raw token stream. `informativeTerms` drops terms so
    // common they say nothing about which passage is meant; when it drops all of
    // them the query was entirely function words, which is precisely the case
    // answer.ts's header warns about — and falling back to every term put the
    // stopwords straight back in, so a sentence containing "the" and "of" could
    // clear `minCoverage` and be quoted as the page's answer. The one query shape
    // the filter exists for was the one that bypassed it. No informative terms
    // means no defensible answer span.
    const informative = found.informative;
    if (!informative.length) return null;

    if (st.projection.qa.length) {
      const qTerms = new Set(informative);
      let best: { pair: QAPair; coverage: number } | null = null;
      for (const pair of st.projection.qa) {
        const words = new Set(lane.tokens(pair.question));
        let hit = 0;
        for (const t of qTerms) if (words.has(t)) hit++;
        const coverage = qTerms.size ? hit / qTerms.size : 0;
        if (!best || coverage > best.coverage) best = { pair, coverage };
      }
      if (best && best.coverage >= cfg.answer.qaMinCoverage) {
        return {
          text: best.pair.answer,
          source: `schema.org/${best.pair.source}`,
          question: best.pair.question,
          coverage: +best.coverage.toFixed(2),
          // Structured data lives in a <script type="application/ld+json"> with
          // no rendered element, so there is nothing to address. Saying that is
          // not the same as omitting the field: the passage branch DOES return an
          // address, and an agent reading two shapes for one `answer` object
          // cannot tell "unaddressable by construction" from "we forgot".
          address: null,
          addressable: false,
          note: 'Quoted from this page\'s structured data, which has no rendered element to address or highlight.',
        };
      }
    }

    // A query of pure function words cannot have an answer, however well some
    // sentence "covers" it. Refusing HERE rather than in the denominator leaves
    // every ordinary query's score untouched — ranking.ts § discriminates.
    const shares = found.weights ? new Map(found.weights) : null;
    if (shares && !discriminates(shares, cfg.retrieval.contentTermShare)) return null;

    // The extractive path needs a PASSAGE chunk at rank 1. When rank 1 is an
    // authored section heading (no chunk) there is no span to extract — but the
    // region reader below scans the WHOLE ranked list for passages and can still
    // answer, so a non-passage top must fall through to it, never return null here
    // (that early return silently killed the region reader for heading-topped
    // queries). The chunk id travelled with the hit; §extractAnswer needs the text.
    const top = results[0];
    if (top && typeof top._chunk === 'number') {
      const chunk = st.seg.chunks[top._chunk as number];
      if (chunk) {
        const span: AnswerSpan | null = extractAnswer(chunk.text, informative, lane.tokens, {
          locale: lane.locale() ?? 'en',
          minCoverage: cfg.answer.minCoverage,
          minSentenceChars: cfg.answer.minSentenceChars,
          maxAnswerChars: cfg.answer.maxAnswerChars,
        }, shares);
        if (span) {
          // The extractive span is a lexical guess. Where a reader exists, gate its
          // ASSERTION: a sentence that echoes the question without answering it is
          // rejected, becomes `unsupported`, the recovery hint fires. Fail-open —
          // no reader (the usual case, every offline test) → assert as before.
          const verdict = await answerVerifier.verify(query, span.text);
          if (verdict !== false) return {
            text: span.text,
            source: 'passage',
            coverage: +span.coverage.toFixed(2),
            ...(verdict === true ? { verified: true } : {}),
            // `null` is NOT a pass — no reader ran. Asserting the answer with a
            // bare absent `verified` let an unchecked sentence look the same as
            // an unverifiable one, which is the "never be confidently wrong"
            // rule: an agent must be able to tell a check that failed to run
            // from a check that returned. `confidence` already reads `low` here;
            // this names WHY, so the agent can choose to read the region.
            ...(verdict === null ? { unverified: 'NO_ON_DEVICE_READER' } : {}),
            address: top.address,
            // Which element the sentence came from, so a caller can highlight the
            // paragraph that answers rather than the whole section.
            ...(elementIndexFor(chunk, span) >= 0 ? { spanElement: elementIndexFor(chunk, span) } : {}),
          };
          // verdict === false: the sentence echoes the question without answering
          // it. Fall through to the region reader for the real, differently-worded answer.
        }
      }
    }
    // No assertable extractive answer (no passage at rank 1, none extracted, or
    // the verifier rejected it). Where the on-device reader exists, hand it the
    // top regions and let it answer in the page's own words. Fail-open → null,
    // and the caller returns a passage-less result exactly as it does today.
    return regionAnswer(query, found.informative, ranked);
  }

  /**
   * Answer from the top retrieved regions with the on-device model, quote-verified.
   *
   * Evidence is the FULL text of the top `fromRegionCount` PASSAGE regions of the
   * whole ranked list — NOT the paginated `results` the agent sees. The reader is
   * an internal answer mechanism, so its recall must not be capped by the response
   * `limit`: the answering region for a vocabulary-gap question routinely ranks
   * below the top few, and reading only what fit on the first page is what left it
   * recall-bound. No new query terms are invented, so it cannot wander off-topic
   * the way expansion did; `answerer` guarantees the phrase appears verbatim in a
   * region, so it is quotable as the page's own words and carries that region's
   * address. Fail-open: no reader / cold / NONE / unquotable → null.
   */
  async function regionAnswer(query: string, informative: string[], ranked: Hit[]): Promise<ToolPayload | null> {
    const regions: string[] = [];
    const addrs: Array<Address | null> = [];
    for (const [id] of ranked) {
      if (regions.length >= cfg.answer.fromRegionCount) break;
      const target = st.contentTargets[id];
      if (target?.kind !== 'passage') continue;   // sections have no body text to read
      const c = st.seg.chunks[target.chunk];
      if (c) { regions.push(c.text); addrs.push(regionAddress(c)); }
    }
    if (!regions.length) return null;
    const hit = await answerer.answer(query, regions);
    if (!hit) return null;
    // Provenance: the phrase can appear verbatim in more than one region — an
    // intro blurb AND the passage that answers. `answerer` returns every region
    // that contains it; address the one that best MATCHES the query, so the agent
    // is pointed at the answer's real home, not the first textual coincidence.
    let best = hit.regions[0], bestCov = -1;
    for (const i of hit.regions) {
      const cov = coverageOf(lane.tokens(regions[i]), informative);
      if (cov > bestCov) { bestCov = cov; best = i; }
    }
    return {
      text: hit.text,
      source: 'region-model',
      // The model READ the question and answered from the page, and the phrase is
      // quote-verified present. Confidence keys on `verified`; the source-specific
      // confidenceBasis (find_on_page) states this was a read, not a yes/no verdict.
      verified: true,
      address: addrs[best] ?? null,
      addressable: !!addrs[best],
      note: 'Read from the top passages by the on-device model and quote-verified against them — '
          + 'the page states this in different words than the query used.',
    };
  }

  /** Which of a chunk's elements a character offset falls in, or -1. */
  function elementIndexFor(chunk: Chunk, span: AnswerSpan): number {
    return chunk.spans.findIndex((sp) => span.start >= sp.start && span.start < sp.end);
  }

  /**
   * Site-level content, in one call.
   *
   * THE ONE ASYNC TOOL. The other five read a projection that already exists, so
   * inline they return values; this one touches the network, so it returns a
   * promise in both lanes. That asymmetry is stated rather than smoothed over —
   * a tool that sometimes returns a promise is worse than one that always does.
   *
   * Cached per instance, negative results included: an agent in a reasoning loop
   * must not generate one round trip per step for a file that is still absent.
   */
  /** Error payloads here are a handful of tokens; nothing to shrink. */
  const asIs = (o: ToolPayload) => o;
  let manifestCache: Promise<AgenticManifest> | null = null;
  const manifest = () => (manifestCache ??= loadManifest(cfg.agentic, location.href));
  // Bounded by agentic.maxBytes per entry and by the URLs this manifest already
  // vouched for. A continuation must not refetch a changing document and splice
  // two versions together, so the first read is reused for this SDK instance.
  const documentCache = new Map<string, ReturnType<typeof readDoc>>();
  const documentText = (url: string) => {
    let pending = documentCache.get(url);
    if (!pending) { pending = readDoc(url, cfg.agentic); documentCache.set(url, pending); }
    return pending;
  };

  function agentic_content(args: { intent?: AgenticIntent; query?: string; url?: string; goal?: string; limit?: number;
                                    offset?: number; revision?: string } = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return Promise.resolve({ error: 'INVALID_INPUT', message: 'input must be an object' });
    }
    const { intent = 'list', query, url, goal = 'read', limit = 20, offset = 0, revision } = args;
    if (!cfg.agentic.enabled) {
      return Promise.resolve({ error: 'DISABLED', message: 'Agent content discovery is turned off by this host.' });
    }
    if (intent !== 'list' && intent !== 'read' && intent !== 'find') {
      return Promise.resolve({ error: 'INVALID_INPUT', message: `intent must be "list", "read" or "find" — received ${JSON.stringify(intent)}.` });
    }
    if (!positiveInt(limit)) {
      return Promise.resolve({ error: 'INVALID_INPUT', message: 'limit must be a positive integer' });
    }
    if (query != null && typeof query !== 'string') {
      return Promise.resolve({ error: 'INVALID_INPUT', message: 'query must be a string' });
    }
    if (url != null && typeof url !== 'string') {
      return Promise.resolve({ error: 'INVALID_INPUT', message: 'url must be a string' });
    }
    if (!nonEmptyString(goal)) return Promise.resolve({ error: 'INVALID_INPUT', message: 'goal must be a non-empty string when supplied' });
    if (!nonNegativeInt(offset) || (revision != null && typeof revision !== 'string')) {
      return Promise.resolve({ error: 'INVALID_INPUT', message: 'offset must be a non-negative integer and revision must be a string' });
    }
    if (offset > 0 && revision == null) {
      return Promise.resolve({ error: 'INVALID_INPUT', message: 'revision is required when offset is non-zero; copy both from the continuation' });
    }
    // Refresh before reading the live link frontier: the no-manifest fallback
    // (outboundLinks) reads st.controls, so an SPA that added links since the
    // last index would otherwise be crawled from a stale frontier and miss them.
    return chain(ensureFresh(), () => manifest().then((m) => agenticBody(m, intent, query, url, goal, limit, offset, revision)));
  }

  function agenticBody(m: AgenticManifest, intent: AgenticIntent, query: string | undefined,
                       url: string | undefined, goal: string, limit: number, offset: number, revision?: string) {
    // Common preamble on every intent: which source answered, and what the site
    // says it is. An agent that cannot tell an authored manifest from our
    // fallback cannot weigh what it is reading.
    const head = { source: m.source, origin: m.origin,
                   urlSemantics: m.source === 'none' ? 'live-page-link' : 'manifest-resource',
                   ...(m.title ? { site: m.title } : {}),
                   ...(m.summary ? { summary: m.summary } : {}),
                   // Declared truncation, applied to the guard itself. The WebMCP
                   // spec site's manifest is 117 entries of which 116 are on
                   // github.com; without this an agent sees one document and
                   // concludes the site publishes almost nothing.
                   ...(m.crossOrigin.dropped ? {
                     crossOriginOmitted: {
                       count: m.crossOrigin.dropped,
                       hosts: m.crossOrigin.hosts,
                       note: `${m.crossOrigin.dropped} manifest entr${m.crossOrigin.dropped === 1 ? 'y' : 'ies'} point at another origin and are not returned — this tool only hands back same-origin URLs. They exist; fetch them with your own browsing tool if the answer is not here.`,
                     },
                   } : {}) };

    if (intent === 'read') {
      if (!url) return budget('agentic_content', { ...head, error: 'INVALID_INPUT', message: 'url is required for intent "read".' }, asIs);
      // Only a URL this origin's own manifest vouched for. An agent-supplied URL
      // fetched with the user's session is a request-forgery primitive, and
      // "same-origin" alone does not cover an internal admin path the manifest
      // never listed.
      const known = m.docs.find((d) => d.url === url);
      if (!known) {
        // A no-manifest `find` result is deliberately a live DOM destination,
        // not a document resource. Returning NOT_IN_MANIFEST for that exact URL
        // was safe but operationally wrong: the tool had just handed the caller
        // the link, then described the expected next call as an error. Recognise
        // only URLs still present in the current bounded same-origin population;
        // arbitrary same-origin paths remain forbidden below.
        const live = m.source === 'none' ? outboundLinks().links.find((link) => link.url === url) : undefined;
        if (live) {
          return budget('agentic_content', { ...head, url, title: live.title,
            status: 'NAVIGATE_INSTEAD', reason: 'LIVE_PAGE_LINK', address: live.address,
            message: 'This URL is a live page link, not a manifest resource. Resolve its address and navigate with the browser, then use describe_app or find_on_page on that page.' }, asIs);
        }
        return budget('agentic_content', { ...head, error: 'NOT_IN_MANIFEST',
          message: 'This tool only reads documents it returned. Call intent "list" and page that complete population; a partial URL sample is intentionally not attached to this error.' }, asIs);
      }
      return documentText(url).then((r) => ('error' in r
        // `r.error` is a platform diagnosis, not a recovery move, and `message`
        // is contractually the latter — so name the move and keep the cause.
        ? budget('agentic_content', { ...head, error: 'FETCH_FAILED', url,
            message: `This document could not be fetched (${r.error}). It stays in the manifest, so retry once; if it fails again, read a different document from intent "list" or navigate to this URL instead.`,
            cause: r.error }, asIs)
        : 'tooLarge' in r
        ? budget('agentic_content', { ...head, url, title: known.title, status: 'NAVIGATE_INSTEAD',
            reason: 'SOURCE_TOO_LARGE', sourceCapBytes: cfg.agentic.maxBytes,
            message: 'The source exceeds this tool\'s byte ceiling. Its fetched prefix is intentionally not returned because the omitted suffix has no lossless continuation. Navigate to the url and use the page tools instead.' }, asIs)
        : 'navigate' in r
        ? budget('agentic_content', { ...head, url, title: known.title, status: 'NAVIGATE_INSTEAD',
            message: 'That entry is an HTML page, not a text document. Returning its markup would cost more than the page is worth. Navigate to the url and call describe_app and find_on_page there — they answer the same question against the live DOM for a fraction of the tokens.' }, asIs)
        : (() => {
          const contentRevision = etag(r.text);
          if (revision != null && revision !== contentRevision) {
            return { ...head, error: 'STALE_CURSOR', revision: contentRevision,
              message: 'The cached document does not match that continuation. Restart at offset 0.' };
          }
          if (offset > r.text.length) {
            return { ...head, error: 'INVALID_INPUT', message: 'offset is past the end of this document' };
          }
          const page = r.text.slice(offset, offset + cfg.agentic.maxReadChars);
          const makeContinuation = (sent: number) => offset + sent < r.text.length
            ? { intent: 'read', url, offset: offset + sent, revision: contentRevision }
            : undefined;
          return budget('agentic_content', { ...head, url, title: known.title, text: page,
              offset, cachedTextChars: r.text.length,
              ...(makeContinuation(page.length) ? { truncated: true, continuation: makeContinuation(page.length),
                remainingTextChars: r.text.length - offset - page.length } : {}) },
            (o) => {
              o.text = shrinkText(o.text as string, cfg.response.fetchedTextFloorChars,
                                  cfg.response.textKeepRatio);
              o.truncated = true;
              o.continuation = makeContinuation((o.text as string).length);
              o.remainingTextChars = Math.max(0, r.text.length - offset - (o.text as string).length);
              return o;
            });
        })()));
    }

    if (intent === 'find') {
      if (!nonEmptyString(query)) return budget('agentic_content', { ...head, error: 'INVALID_INPUT', message: 'query is required for intent "find".' }, asIs);
      // Absence of llms.txt degrades consistently: `list` and `find` operate on
      // the same safe, current-page, same-origin links instead of one exposing a
      // fallback population the other claims does not exist.
      const fallback = m.source === 'none' ? outboundLinks() : null;
      const fallbackDocs = fallback?.links.map((l) => ({
        title: String(l.title ?? ''), url: String(l.url ?? ''), section: null,
        note: typeof l.landmark === 'string' ? l.landmark : null,
      })) ?? [];
      const population = m.source === 'none' ? fallbackDocs : m.docs;
      // Rank the complete population BEFORE slicing. Applying `limit` inside
      // the ranker made offset 20 irrecoverable: those candidates had already
      // been discarded, and budget shrinking silently discarded still more.
      const ranked = rankDocs(population, query, lane.tokens);
      const fallbackByUrl = new Map((fallback?.links ?? []).map((l) => [l.url, l]));
      const authoredLinks = m.source === 'none' ? [] : outboundLinks().links;
      const pathKey = (value: string) => {
        try { return new URL(value, location.href).pathname.replace(/\.md$/u, '').replace(/\/$/u, ''); }
        catch { return ''; }
      };
      const allMatches = ranked.map((d) => {
        const live = m.source === 'none' ? fallbackByUrl.get(d.url) : authoredLinks.find((link) =>
          semanticKey(link.title) === semanticKey(d.title) || pathKey(link.url) === pathKey(d.url));
        return { title: d.title, url: d.url, section: d.section, note: d.note,
          ...(m.source === 'none'
            ? { kind: 'live-page', action: 'navigate', liveUrl: d.url }
            : { kind: 'resource', action: 'read', resourceUrl: d.url,
                ...(live ? { liveUrl: live.url } : {}) }),
          ...(live?.address ? { address: live.address } : {}),
          confidence: confidenceFor(d.coverage, cfg.retrieval) };
      });
      const resultRevision = etag({ intent: 'find', query, goal, matches: allMatches });
      if (revision != null && revision !== resultRevision) {
        return budget('agentic_content', { ...head, error: 'STALE_CURSOR', revision: resultRevision,
          message: 'The ranked document population changed. Restart at offset 0.' }, asIs);
      }
      if (offset > allMatches.length) {
        return budget('agentic_content', { ...head, error: 'INVALID_INPUT',
          message: 'offset is past the end of the ranked document population' }, asIs);
      }
      const matches = allMatches.slice(offset, offset + limit);
      const makeContinuation = (sent: number) => offset + sent < allMatches.length
        ? { intent: 'find', query, goal, limit, offset: offset + sent, revision: resultRevision }
        : undefined;
      const send = (sentMatches: ToolPayload[]) => budget('agentic_content', {
        ...head,
        matches: sentMatches,
        searched: population.length,
        matched: allMatches.length,
        offset,
        returned: matches.length,
        revision: resultRevision,
        truncated: Math.max(0, allMatches.length - offset - matches.length),
        ...(makeContinuation(matches.length) ? { continuation: makeContinuation(matches.length) } : {}),
        ...(allMatches.length ? {} : { note: population.length
          ? m.source === 'none'
            ? 'No safe same-origin link title matched. Try intent "list" to inspect them, or find_on_page for this page.'
            : 'No manifest entry matched. The manifest lists titles, not full text — try intent "list" and pick by section, or find_on_page for this page.'
          : 'This site publishes no agent manifest and exposes no safe same-origin page links. Use find_on_page for the current page.' }),
      }, (o) => {
        // Budget omission is pagination, too. Recompute the cursor from the
        // entries actually sent so the next call starts at the first entry the
        // shrinker removed instead of skipping it forever.
        if (o.matches.length > 1) o.matches = o.matches.slice(0, halve(o.matches.length));
        o.returned = o.matches.length;
        o.truncated = Math.max(0, allMatches.length - offset - o.returned);
        const continuation = makeContinuation(o.returned);
        if (continuation) o.continuation = continuation;
        else delete o.continuation;
        return o;
      });
      if (m.source === 'none' || goal !== 'navigate') return send(matches);
      // A manifest resource is not a browser destination. Some sites publish a
      // Markdown content-negotiation sibling (`/useState.md`) for the live HTML
      // page (`/useState`). Derive only that narrow candidate, then verify it by
      // same-origin HEAD before advertising `liveUrl`; an unverified string
      // would recreate the invented-selector failure at the URL layer.
      return Promise.all(matches.map(async (match) => {
        let candidate: URL;
        try { candidate = new URL(String(match.url), location.href); }
        catch { return match; }
        if (candidate.origin !== location.origin || !candidate.pathname.endsWith('.md')) return match;
        candidate.pathname = candidate.pathname.slice(0, -3);
        try {
          const response = await fetch(candidate, { method: 'HEAD', credentials: 'same-origin',
            signal: AbortSignal.timeout(cfg.agentic.timeoutMs), redirect: 'follow' });
          const final = new URL(response.url || candidate.href);
          if (!response.ok || final.origin !== location.origin
            || !/^text\/html\b/iu.test(response.headers.get('content-type') ?? '')) return match;
          return { ...match, action: 'navigate', liveUrl: final.href, liveUrlVerified: true };
        } catch { return match; }
      })).then(send);
    }

    // intent === 'list'
    const allDocs = m.docs.map((d) => ({ title: d.title, url: d.url, section: d.section, note: d.note }));
    // The former fallback gathered only `limit` links, so a second page did not
    // exist even though `linksTotal` said it did. Build the full safe population
    // first, bind a revision to it, and only then take the requested page.
    const fallback = m.source === 'none' ? outboundLinks() : null;
    const allItems = fallback?.links ?? allDocs;
    const resultRevision = etag({ intent: 'list', source: m.source, items: allItems });
    if (revision != null && revision !== resultRevision) {
      return budget('agentic_content', { ...head, error: 'STALE_CURSOR', revision: resultRevision,
        message: 'The document population changed. Restart at offset 0.' }, asIs);
    }
    if (offset > allItems.length) {
      return budget('agentic_content', { ...head, error: 'INVALID_INPUT',
        message: 'offset is past the end of the document population' }, asIs);
    }
    const page = allItems.slice(offset, offset + limit);
    const makeContinuation = (sent: number) => offset + sent < allItems.length
      ? { intent: 'list', limit, offset: offset + sent, revision: resultRevision }
      : undefined;
    return budget('agentic_content', {
      ...head,
      docs: m.source === 'none' ? [] : page,
      total: m.docs.length,
      truncated: m.source === 'none' ? 0 : Math.max(0, m.docs.length - offset - page.length),
      offset,
      returned: page.length,
      revision: resultRevision,
      ...(makeContinuation(page.length) ? { continuation: makeContinuation(page.length) } : {}),
      ...(m.source === 'none' ? {
        // Absence is an answer, not an error — and it is the common case. The
        // page's own outbound links are the honest fallback. Their URLs are
        // live DOM destinations, unlike manifest resource URLs; urlSemantics
        // keeps that authority difference explicit.
        links: page,
        linksTotal: fallback!.total,
        linksTruncated: Math.max(0, fallback!.total - offset - page.length),
        note: 'This site publishes no llms.txt. These are the same-origin destinations linked from the current page, with addresses you can resolve and act on.',
        tried: m.tried,
      } : {}),
    }, (o) => {
      // The no-manifest path contains `links`, not `docs`. The generic docs-only
      // shrinker made no progress there, so CNN returned 2,036 tokens against an
      // adaptive ceiling and GOV.UK spent 199% of the page it was meant to save
      // (2026-09-01, eval:tools). Shrink the list that actually exists and name
      // its omitted count independently from manifest-document truncation.
      if ((o.docs?.length ?? 0) > 1) {
        o.docs = o.docs.slice(0, halve(o.docs.length));
      } else if ((o.links?.length ?? 0) > 1) {
        o.links = o.links.slice(0, halve(o.links.length));
      }
      const sent = m.source === 'none' ? o.links.length : o.docs.length;
      o.returned = sent;
      if (m.source === 'none') o.linksTruncated = Math.max(0, fallback!.total - offset - sent);
      else o.truncated = Math.max(0, m.docs.length - offset - sent);
      const continuation = makeContinuation(sent);
      if (continuation) o.continuation = continuation;
      else delete o.continuation;
      return o;
    });
  }

  /**
   * Same-origin destinations linked from this page, read at ANSWER time.
   *
   * `href` is deliberately not on the projected node: it is not part of an
   * element's identity, it changes without changing the accessibility tree, and
   * storing it would mean a stale URL survives a re-render that the address
   * layer would otherwise have caught. Reading it here costs one attribute
   * lookup per returned link and is always current.
   */
  function outboundLinks(): { links: ToolPayload[]; total: number } {
    const seen = new Set<string>();
    const out: ToolPayload[] = [];
    for (const n of st.controls) {
      if (!isActionableElement(n.el) || n.role !== 'link' || !n.name) continue;
      const nav = liveNavigationOf(n.el);
      if (!nav?.sameOrigin
          || (nav.href.includes('#') && nav.href.split('#')[0] === n.el.ownerDocument.location?.href.split('#')[0])
          || seen.has(nav.href)) continue;
      seen.add(nav.href);
      out.push({ title: n.name, url: nav.href, landmark: n.landmark, address: addr(n) });
    }
    return { links: out, total: seen.size };
  }

  /** Current browser-resolved destination for native links. It is deliberately
   * answer-time data: href/base/target can change without changing identity. */
  function liveNavigationOf(el: Element): ToolPayload | null {
    const tag = el.localName.toLowerCase();
    if (tag !== 'a' && tag !== 'area' || !el.hasAttribute('href')) return null;
    const href = (el as HTMLAnchorElement | HTMLAreaElement).href;
    if (!href) return null;
    let sameOrigin = false;
    try { sameOrigin = new URL(href).origin === el.ownerDocument.location?.origin; } catch { /* keep false */ }
    const target = el.getAttribute('target') || undefined;
    const rel = el.getAttribute('rel') || undefined;
    const download = el.getAttribute('download');
    return { href, sameOrigin, ...(target ? { target } : {}), ...(rel ? { rel } : {}),
      ...(download != null ? { download } : {}) };
  }

  /**
   * The control that opens the disclosure a passage is hidden behind.
   *
   * Resolved at ANSWER time from the chunk's own container rather than stored on
   * the node, for the same reason addresses are descriptions: the <summary> may
   * have been re-rendered since the projection, and an address re-resolves while
   * a stored reference rots.
   */
  function discloserFor(c: Chunk): Address | null {
    const details = c.els[0] ? flatClosest(c.els[0], 'details:not([open])') : null;
    if (!details) return null;
    const summary = details.querySelector(':scope > summary');
    const node = st.controls.find((n) => n.el === summary && isActionableElement(n.el));
    return node ? addr(node) : null;
  }

  function controlsInRegion(c: Chunk): ProjectedNode[] {
    const region = regionOf(c, (el) => st.controls.some((n) => isActionableElement(n.el)
                              && el !== n.el && flatContains(el, n.el)),
                            cfg.retrieval.maxRegionClimb);
    if (!region) return [];
    return st.controls.filter(
      (n) => isActionableElement(n.el) && flatContains(region, n.el)
        && (!c.headingPath.length || samePath(n.headingPath, c.headingPath)),
    );
  }

  /** One universal decision field prevents a generic host from learning six
   * status dialects. Existing status/error fields stay unchanged because they
   * carry tool-specific recovery detail and are already public wire contracts.
   * This lives in the lazy answer engine so the additive contract costs no eager
   * bytes; index.ts covers the only failure that returns before this boundary. */
  const withOutcome = (payload: ToolPayload): ToolPayload => {
    const out = { ...payload,
      outcome: payload.error ? 'error'
        : payload.status === 'AMBIGUOUS' || payload.status === 'ambiguous' ? 'ambiguous'
        : payload.status === 'NOT_FOUND' || payload.status === 'not_found' ? 'not_found'
        : payload.status === 'degraded' ? 'degraded' : 'success' };
    // Last writer recounts: `outcome`, and `_etag`/`_version` attached after
    // budgeting, were systematically absent from `_tokens` — a small but
    // constant accounting lie in the subsystem whose thesis is token honesty.
    if (typeof out._tokens === 'number') out._tokens = est(out);
    return out;
  };
  const withSummary = (name: ToolSpecName, run: (args: any) => Awaitable<ToolPayload>) =>
    (args: any = {}) => {
      if (!args || typeof args !== 'object' || Array.isArray(args))
        return Promise.resolve(withOutcome({ error: 'INVALID_INPUT', message: 'tool input must be an object' }));
      // Untrusted agent strings are unbounded by the schema (a hint, not a
      // validator): an oversized `selector` reaches querySelector, an oversized
      // `query` is echoed into continuations and delta keys no shrinker touches.
      // One coarse serialized-length cap for all six tools; serializing is
      // bounded work, it is the DOWNSTREAM use of the string that this stops.
      let serialized: string | undefined;
      try { serialized = JSON.stringify(args); }
      catch { return Promise.resolve(withOutcome({ error: 'INVALID_INPUT', message: 'tool input must be JSON-serializable' })); }
      if (serialized === undefined)
        return Promise.resolve(withOutcome({ error: 'INVALID_INPUT', message: 'tool input must be JSON-serializable' }));
      if (serialized.length > cfg.input.maxToolArgChars)
        return Promise.resolve(withOutcome({ error: 'INVALID_INPUT', message: `tool input exceeds ${cfg.input.maxToolArgChars} characters` }));
      if ('summarize' in args && typeof args.summarize !== 'boolean')
        return Promise.resolve(withOutcome({ error: 'INVALID_INPUT', message: 'summarize must be a boolean' }));
      if ('reason' in args && (!nonEmptyString(args.reason) || /[\r\n]/u.test(args.reason)))
        return Promise.resolve(withOutcome({ error: 'INVALID_INPUT', message: 'reason must be a non-empty, single-line string' }));
      // Surface the agent's stated intent to the host (opt-in; the page decides
      // whether to show it). After the size guard so `reason` is already bounded;
      // a throwing host callback must never break the tool call.
      if (typeof args.reason === 'string' && args.reason.trim())
        try { onIntent?.(name, args.reason.trim()); } catch { /* host hook is not allowed to break the tool */ }
      return chain(run(args), (payload) => chain(summary.apply(name, args, payload), withOutcome));
    };
  return {
    describe_app: withSummary('describe_app', describe_app),
    find_on_page: withSummary('find_on_page', find_on_page),
    locate_control: withSummary('locate_control', locate_control),
    query_selector: withSummary('query_selector', query_selector),
    resolve_address: withSummary('resolve_address', resolve_address),
    agentic_content: withSummary('agentic_content', agentic_content),
    disposeSummary: () => { summary.dispose(); lmSession.dispose(); opaqueDescriber.dispose(); translator.dispose(); },
  };
}

export type Tools = ReturnType<typeof createTools>;
