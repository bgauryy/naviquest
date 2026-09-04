import { excludedDeep, isActionableElement, project, projectAsync } from './page/project.ts';
import { segment } from './retrieval/segment.ts';
import { estimateTokens, makeTokenizer, scriptDensity } from './retrieval/text.ts';
import { chain } from './async.ts';
import { resolve, samePath } from './tools/address.ts';
import { createHighlighter, highlightSupported } from './page/highlight.ts';
import { DEFAULTS, resolveConfig } from './config.ts';
import { controlDoc } from './page/affordance.ts';
import { createBudgeter } from './tools/budget.ts';
import { createDeltaStore } from './tools/delta.ts';
import { buildStructure, headingNodeIndex, outlineKey, treeTokens } from './tools/structure.ts';
import { detectModal } from './page/modality.ts';
import { TOOL_NAMES } from './tools/tool-names.ts';
import { flatContains, isQueryableShadowRoot, queryRoots, queryScopes } from './page/dom.ts';
import type { IndexState, Tools } from './tools/tools.ts';
import type { PageStructure } from './tools/structure.ts';
import type { ToolPayload } from './tools/budget.ts';
import type { Address, DenseState, IndexStats, Projection, Resolution, RetrievalLane, Segmentation } from './types.ts';
import type { PartialTuning, Tuning } from './config.ts';
import type { NaviquestOrientation } from './tools/orientation.ts';
import type { Awaitable } from './async.ts';
import type { DenseResult, Lane, LaneStatus } from './retrieval/lane.ts';
import type { ModelContext, ToolDefinition, ToolResult } from './webmcp.d.ts';
import type { NaviquestTools } from './tools/tool-contracts.ts';
import type { ToolSpec } from './tools/tool-specs.ts';
import type { ToolSpecName } from './tools/tool-names.ts';

// Token budgets, chunk sizes, confidence bands and every other tunable live in
// config.js with the reason for each value. Truncation is always DECLARED — a
// silently trimmed response reads to a model as "that's everything", which is
// the easiest way to make an agent confidently wrong.

/**
 * How a worker is delivered, by default.
 *
 * `new URL('./worker.ts', import.meta.url)` is the standard-ESM spelling that
 * every modern bundler understands natively and that also works unbundled. It is
 * deliberately NOT a bundler-specific import (`?worker&inline`): this file is the
 * SDK core and must not require Vite.
 */
export function defaultWorkerFactory() {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
}

/**
 * Everything a host may pass. Empty `createNaviquest()` is the default: six
 * tools navigate from live structure (embed or inject, any page). `root` /
 * `exclude` / `orientation` are optional first-party overlays.
 */
export interface NaviquestConfig {
  /** Strict selector/element boundary. Omit it to index the reachable page. */
  root?: string | Element;
  /** Override the automatic primary-content cascade. Never limits reachability. */
  rootFallbacks?: string[];
  /** Optional. Never walked, never indexed, never returned — applied DURING the walk. */
  exclude?: string[];
  /** Last-chance redaction hook, called with the element the text came from. */
  redact?: (text: string, el: Element) => string;
  /** Overrides for any tunable in config.ts, at any depth. */
  tuning?: PartialTuning;
  /** Explicit values stay pinned; otherwise follows `<html lang>` on rebuild. */
  locale?: string;
  /** Run retrieval in a module worker. Tool calls are promises in either lane. */
  worker?: boolean;
  /** How that worker is constructed. Defaults to a standard-ESM module worker. */
  workerFactory?: () => Worker;
  /** `true` warms the dense lane only when `document.modelContext` exists;
   *  `'eager'` warms immediately, which is a development setting. REQUIRES
   *  `worker: true` — the inline lane never embeds (that long task is the one
   *  the worker exists to move off-thread), so without a worker this option is
   *  inert and every response stays `retrieval: "lexical"`. */
  dense?: boolean | 'eager';
  /** Where the dense weights live. Defaults to `./model/`. */
  denseBase?: string;
  /** Set false to index once and only on explicit `reindex()`. */
  autoReindex?: boolean;
  /** Called after every rebuild with the fresh stats. */
  onIndex?: (stats: IndexStats) => void;
  /** Called with the agent's `reason` (one-line intent) on each tool call that
   *  supplies one, so the page can show the user WHY the agent acted. The SDK
   *  never displays it. Treat it as untrusted text; never insert it as HTML. */
  onIntent?: (tool: ToolSpecName, reason: string) => void;
  /**
   * Optional first-party overlay for describe_app(). Omit it (the default) and
   * there is no `authored` key — inject navigates any page from live structure.
   * Never overrides landmarks or outline. `tasks[].locate` is a CSS selector,
   * same grammar as `exclude`. Not indexed for find_on_page.
   */
  orientation?: NaviquestOrientation;
}

/** Outcome of `register()` — success, already-ours, or a platform-taken name. */
export interface RegisterResult {
  registered: boolean;
  via: string | null;
  /** The complete active surface. Present only when `registered` is true. */
  tools?: string[];
  /** Names that caused an atomic registration attempt to roll back. */
  failed?: string[];
  reason?: string;
}

/**
 * The object `createNaviquest()` resolves to. Public tools are always promises;
 * construction itself is sync on the inline lane and a promise on the worker.
 */
export interface NaviquestApi {
  reindex(): Promise<IndexStats>;
  config(): Tuning;
  stats(): IndexStats;
  tools: NaviquestTools;
  registerRegion(rootOrElement: Element | ShadowRoot | null | undefined): boolean;
  unregisterRegion(rootOrElement: Element | ShadowRoot): boolean;
  /** Agent-facing metadata: titles, descriptions, JSON Schemas. A promise
   *  because the schemas load with the answer engine rather than on
   *  construction — see tool-names.ts for what that buys. */
  toolDefs(): Promise<ToolDefinition[]>;
  resolve(a: Address): Resolution;
  highlightAnswer(answer: { address?: Address; spanElement?: number }): boolean;
  highlightAddress(address: Address): boolean;
  clearHighlight(): void;
  highlightSupported: () => boolean;
  register(): Promise<RegisterResult>;
  lane(): {
    kind: 'inline' | 'worker';
    async: boolean;
    /** False while the retrieval module is still loading. `stemLanguage` reads
     *  `'pending'` and the dense state is a placeholder until it turns true. */
    ready: boolean;
    stemLanguage: string;
    dense: DenseState;
    retrieval: RetrievalLane;
  };
  warmDense(base?: string): Awaitable<DenseResult | LaneStatus>;
  dispose(): void;
}

/**
 * Where the SDK looks for the primary-content partition when the host does not
 * set a strict root. Ordered most- to least-specific; the first match wins.
 *
 * Derived, not declared: the list lives in `config.ts` with the other composable
 * selector lists (`tuning.project.rootFallbacks` accepts `(base) => [...]`),
 * because a framework mount-point guess is exactly what a host extends. This
 * export stays so the shipped cascade remains readable from one name.
 */
export const DEFAULT_ROOTS: readonly string[] = DEFAULTS.project.rootFallbacks;

/**
 * Which `modelContext` already has Naviquest's tools on it.
 *
 * A third-party SDK gets loaded twice more often than anyone plans for: two
 * bundles, a widget plus the page shell, a route change that re-runs the entry.
 * `registerTool` does not deduplicate, so the second call put SIX MORE tools on
 * the surface with identical names — and an agent choosing between two
 * `find_on_page` entries is strictly worse off than one that never saw them.
 *
 * A WeakSet keyed by the context object, so it cannot keep one alive and it
 * resets naturally per document.
 */
const claimed = new WeakSet<object>();

const firstMatch = (selectors: string[]): Element | null => {
  for (const sel of selectors) {
    try { const el = document.querySelector(sel); if (el) return el; } catch { /* ignore a bad host selector */ }
  }
  return null;
};

/**
 * Has the user asked for reduced data usage? Limited availability (Chromium
 * only), so absence means "no preference expressed", never "no".
 */
export function dataSaverOn(): boolean {
  try {
    return !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
  } catch { return false; }
}

export function resolveModelContext(): { mc: ModelContext | null; via: string | null } {
  if (typeof document !== 'undefined' && document.modelContext) return { mc: document.modelContext, via: 'document.modelContext' };
  if (typeof navigator !== 'undefined' && navigator.modelContext) return { mc: navigator.modelContext, via: 'navigator.modelContext (deprecated in Chrome 150)' };
  return { mc: null, via: null };
}

export function createNaviquest(config: NaviquestConfig = {}): Awaitable<NaviquestApi> {
  const hasExplicitRoot = config.root !== undefined;
  // A stable detached root is the truthful representation of an authored
  // selector that currently matches nothing. Falling back to <html> here leaks
  // the whole page; retaining the old element after removal serves stale data.
  const missingExplicitRoot = document.createElement('div');
  // `root` is strict only when the host authored it. The automatic cascade used
  // to become the projection root, turning "prefer main content" into "pretend
  // the header and footer do not exist". The 2026-09-01 three-arm benchmark
  // grounded 39/104 page-wide tasks versus Playwright's 99/104; root omission
  // was the dominant failure. Omitted root means whole reachable body, while
  // the same cascade remains a primary-content partition for later ranking.
  const resolveRoot = (): Element | null => {
    if (typeof config.root === 'string') {
      try { return document.querySelector(config.root); } catch { return null; }
    }
    if (config.root) return config.root;
    return document.body ?? document.documentElement;
  };
  const resolvePrimaryRoot = (root: Element | null): Element | null => {
    if (hasExplicitRoot) return root;
    // Config-level override first (a host naming its own partition), then the
    // tunable, which is the same list a `tuning` composer extends.
    const candidate = firstMatch(config.rootFallbacks ?? cfg.project.rootFallbacks);
    return candidate && root && flatContains(root, candidate) ? candidate : root;
  };
  // A classic bundle can run synchronously in <head>, before <body> or an
  // explicit selector exists. Use documentElement only as an empty bootstrap
  // root, then re-resolve at DOMContentLoaded/tool time; never dereference null.
  // BEFORE any root resolution: the primary-content cascade reads
  // `cfg.project.rootFallbacks`, so resolving a root first put `cfg` in its
  // temporal dead zone. Nothing here depends on a root.
  const cfg = resolveConfig(config.tuning);
  const exclude = config.exclude ?? [];
  const autoReindex = config.autoReindex !== false;
  const worker = !!config.worker;
  let rootEl = resolveRoot()
    ?? (hasExplicitRoot ? missingExplicitRoot : document.documentElement ?? missingExplicitRoot);
  let primaryRootEl = resolvePrimaryRoot(rootEl) ?? rootEl;
  const est = (v: unknown) => estimateTokens(v, cfg.text.charsPerToken);
  // What reading this whole page would have cost — the baseline every adaptive
  // ceiling is a share of. This is the SAME derivation `describe_app` uses to
  // decline (`retrieval.declineBelowTreeTokens`), and it has to be: budget.ts
  // promises the recommendation speaks "on exactly the pages where this cap
  // binds hardest". Summing indexed chunk text broke that promise, because
  // controls carry a role and a name but no chunk text — measured on
  // docs.python.org/3/library/asyncio.html (78 controls) at 1,165 chunk tokens
  // against a tree over 2,000, which squeezed describe_app to a 466 ceiling it
  // cannot meet at 491 while the recommendation stayed silent. Reading the whole
  // page means dumping the tree, so the tree is the honest baseline. Still
  // floored by `min(fixed, …)`: this can only relax a cap toward the static
  // table, never above it. Shares tools.ts's per-index cache.
  const pageTokens = () => st.projection
    ? (st.treeTokenCache ??= treeTokens(st.projection.nodes, cfg.text.charsPerToken))
    : 0;
  const { budget } = createBudgeter(cfg.budgets, est, pageTokens, cfg.adaptiveBudget);
  const controller = new AbortController();
  // Own registry key, so two instances on one page cannot clobber each other.
  const highlighter = createHighlighter();

  // The locale is resolved HERE, on the main thread, and passed down. A worker
  // has no `document`, so a tokenizer constructed there would silently fall back
  // to 'en' — and word boundaries are locale-dependent, so index-time and
  // query-time term statistics would stop matching on any non-English page.
  const resolveLocale = () => config.locale
    ?? ((typeof document !== 'undefined' && document.documentElement?.getAttribute('lang')) || '').trim();
  let locale = resolveLocale();
  // Frozen once for segmentation. Retrieval builds its own tokenizer from the
  // same locale/config on the other side of the possible worker boundary.
  let segmentWords = makeTokenizer(locale, cfg.text).wordCount;

  /**
   * Retrieval runs inline unless the host asks for a worker. This is an internal
   * scheduling choice: public tool wrappers always return promises.
   *
   * The lane LOADS lazily, alongside the answer engine, because nothing can
   * query an index until a tool exists to ask. Importing it eagerly pulled bm25,
   * lexical-index, ranking and exact into the closure every page pays for —
   * 2,472 gzip bytes, measured, for code no page reaches without an agent.
   *
   * Both facts a caller needs BEFORE the lane arrives come from config, not from
   * the instance: whether the lane is asynchronous, and which one it is. That is
   * what lets projection, freshness and the sync page-side surface keep working
   * unchanged while the module is still in flight.
   */
  const laneAsync = worker;
  const laneKind: Lane['kind'] = worker ? 'worker' : 'inline';
  let lane: Lane | null = null;
  let lanePromise: Promise<Lane> | null = null;
  /** Why the lane is absent, when it is absent for good. Read by `lane()`, which
   *  otherwise could only report "still loading" — forever, to a host polling a
   *  chunk that 404s. */
  let laneError: unknown = null;
  const laneReady = (): Awaitable<Lane> => lane ?? (lanePromise ??= import('./retrieval/lane.ts')
    .then((m) => (lane = worker
      ? m.createWorkerLane(config.workerFactory ?? defaultWorkerFactory)
      : m.createInlineLane()))
    .catch((e) => {
      // Cache the FAILURE nowhere. A rejected promise held in `lanePromise`
      // would be returned to every later caller, so one chunk fetch that failed
      // behind a stale CDN edge would disable retrieval for the life of the
      // page even though a retry would have worked. Clearing it makes the next
      // caller retry; `laneError` keeps the reason so the failure is still
      // reportable rather than merely repeated.
      lanePromise = null;
      laneError = e;
      throw e;
    }));

  /**
   * Everything a rebuild replaces, in ONE object.
   *
   * The tools live in tools.ts now and must see the current index without a
   * getter per field, so `reindex()` assigns into this rather than reassigning
   * six separate closure variables that only this module could reach.
   */
  const st: IndexState = {
    projection: null as unknown as Projection,
    seg: null as unknown as Segmentation,
    /** The actionable subset of the projection — spread COPIES, so `ordinal`
     *  and `peerCount` must already be on the node (project.ts computes them). */
    controls: [],
    structure: null as unknown as PageStructure,
    contentTargets: [],
    version: 0,
    treeTokenCache: null,
  };
  let controlDocs: string[] = [];

  /** Freshness bookkeeping. `dirty` is set by the observer; `lastHref` catches
   *  SPA navigation that mutates nothing we observe; `lastCount` catches a
   *  wholesale replacement the attribute filter would miss. */
  let dirty = false;
  /** When the last observed mutation fired (performance.now). A describe_app call
   *  within `settleQuietMs` of it means the page is still re-rendering — see the
   *  `settling` provider below. Survives the reindex that clears `dirty`. */
  let lastMutationAt = -Infinity;
  let lastHref: string | null = null;
  let lastShape = '';
  let lastStats: IndexStats = {} as IndexStats;
  let observer: MutationObserver | null = null;
  let bootedEarly = false;
  /** Roots a component author handed in — the closed-shadow-DOM opt-in. */
  const registeredRegions = new Set<Element | ShadowRoot>();
  /**
   * An active top-layer modal is the temporary interaction root of the page.
   * Portals commonly render it beside an explicitly configured app root. The
   * configured root remains strict while no modal is open; while one is active,
   * indexing only the now-inert app would dead-end the agent and rank unrelated
   * controls. This platform-derived exception is non-primary and disappears on
   * close. Host exclusions still win.
   */
  let transientInteractionRoot: Element | null = null;
  const resolveTransientInteractionRoot = (): Element | null => {
    const registeredShadows = [...registeredRegions].filter(isQueryableShadowRoot);
    const modal = detectModal(registeredShadows).element;
    return modal && !flatContains(rootEl, modal)
      && !excludedDeep(modal, exclude) ? modal : null;
  };
  /** The roots indexed beyond `rootEl`: registered regions plus the transient
   *  modal root. One derivation — this list was spelled inline at four sites. */
  const overlayRoots = (): Array<Element | ShadowRoot> => [...registeredRegions,
    ...(transientInteractionRoot ? [transientInteractionRoot] : [])];
  /** Shape across every reachable query tree. Unlike a light-DOM element count,
   * this notices attachShadow(), whose creation emits no MutationObserver record. */
  const treeShape = () => {
    const roots = new Set<ParentNode>();
    const registeredShadow = [...registeredRegions].filter(isQueryableShadowRoot);
    for (const r of queryRoots(rootEl, registeredShadow)) roots.add(r);
    const externalElements = overlayRoots()
      .filter((r): r is Element => !isQueryableShadowRoot(r) && !flatContains(rootEl, r))
      .filter((r, _i, all) => !all.some((outer) => outer !== r && flatContains(outer, r)));
    for (const r of externalElements) {
      for (const q of queryRoots(r)) roots.add(q);
    }
    for (const r of st.projection?.frameRoots ?? []) {
      for (const q of queryRoots(r)) roots.add(q);
    }
    let elements = 0;
    for (const r of roots) elements += r.querySelectorAll('*').length;
    return `${roots.size}:${elements}`;
  };

  /**
   * `subtree: true` does NOT cross a shadow boundary, and neither does the
   * `getElementsByTagName('*')` count used as the backstop — so a mutation
   * entirely inside an open shadow root set no dirty flag, changed no element
   * count, and left the index stale with no freshness signal at all. The SDK is
   * otherwise shadow-aware throughout, which made this the one place the
   * projection could silently disagree with the page.
   *
   * Every open root the projection walked is observed too, tracked in a WeakSet
   * so a rebuild does not re-attach to roots already covered.
   */
  const OBSERVE: MutationObserverInit = {
    // Observe every attribute. Role/type/href/rel/aria-controls and even a host
    // exclusion selector's custom data attribute can all change what the agent
    // sees or can do. A whitelist made those changes permanently stale while
    // returning a confident revision. State-only mutations are still excluded
    // from the tear counter below, so busy pages do not lose sliced projection.
    subtree: true, childList: true, characterData: true, attributes: true,
  };
  /** Live value of the nav-landmark judgement; see config.ts § navLandmarks. */
  const navLandmarks = new Set(cfg.retrieval.navLandmarks);

  let observedRoots = new WeakSet<Node>();
  const observedEvents = new WeakSet<EventTarget>();
  const markTearDirty = () => { dirty = true; lastMutationAt = performance.now(); mutationSeq++; tearSeq++; };
  const markFrameLoad = (event: Event) => {
    const target = event.target as Element | null;
    if (target?.localName === 'iframe' || target?.localName === 'frame') markTearDirty();
  };
  const observeRoots = (roots: Array<Element | ShadowRoot>) => {
    if (!observer) return;
    for (const r of roots) {
      if (observedRoots.has(r)) continue;
      observedRoots.add(r);
      try { observer.observe(r, OBSERVE); } catch { /* a detached root is not a failure */ }
      // Slot assignment and popover top-layer state are platform state, not DOM
      // mutations. Their standard events are the only reliable freshness source.
      if (!observedEvents.has(r)) {
        observedEvents.add(r);
        r.addEventListener('slotchange', markTearDirty, { capture: true, signal: controller.signal });
        r.addEventListener('toggle', markTearDirty, { capture: true, signal: controller.signal });
        // A browsing context can navigate itself without mutating `src` in the
        // parent. `load` is the platform signal that contentDocument may have
        // changed from readable to cross-origin/sandboxed (or back). It does not
        // bubble, so listen in capture on each reachable shadow/registered root.
        r.addEventListener('load', markFrameLoad, { capture: true, signal: controller.signal });
      }
    }
  };
  /** `<html lang>` drives the tokenizer locale; watch it wherever it is not the
   *  index root already. Shared by first attach and every rebind. */
  const observeLang = () => {
    if (observer && document.documentElement !== rootEl) {
      try { observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] }); } catch {}
    }
  };
  const rebindObservation = () => {
    if (!observer) return;
    observer.disconnect();
    observedRoots = new WeakSet<Node>();
    try { observer.observe(rootEl, OBSERVE); } catch { observer = null; return; }
    observeLang();
    observeRoots([...(st.projection?.shadowRoots ?? []),
      ...(st.projection?.frameRoots ?? []), ...overlayRoots()]);
  };

  /**
   * Attributes whose change can INVALIDATE AN ADDRESS, as opposed to merely
   * making the index stale.
   *
   * An address is `{ landmark, headingPath, role, name, ordinal, peerCount }` —
   * it describes the element rather than pointing at it. What breaks one is a
   * node appearing, leaving or moving, or the accessible NAME changing under it.
   *
   * What deliberately is NOT here: `style`, `class`, and the state attributes
   * `aria-expanded`/`aria-checked`/`aria-selected`/`aria-current`. State is read
   * live at tool time (`liveState`), never baked into the address, so a checkbox
   * toggling mid-projection changes nothing an address depends on. Including
   * them would have made every page with a CSS animation fail the tear check on
   * every pass and fall back to the unsliced walk — which is to say, it would
   * have quietly deleted the feature on exactly the busy pages it exists for.
   */
  const TEAR_ATTRS = new Set(['aria-label', 'aria-labelledby', 'aria-hidden', 'hidden', 'inert',
    'placeholder', 'title', 'value', 'role', 'type', 'href', 'rel', 'aria-controls',
    'aria-description', 'aria-level', 'id', 'for']);
  /** Bumped only by tear-relevant records. `dirty` still tracks every mutation,
   *  because staleness and tearing are different questions. */
  let tearSeq = 0;
  /** Every freshness-relevant change, including ones that cannot tear projection. */
  let mutationSeq = 0;
  if (autoReindex && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver((records) => {
      dirty = true;
      lastMutationAt = performance.now();
      mutationSeq++;
      // First match is enough: the guard needs a CHANGED signal, not a census,
      // and this runs on every mutation batch the page produces.
      for (const r of records) {
        if (r.type === 'childList'
          || (r.type === 'attributes' && r.attributeName
            && (TEAR_ATTRS.has(r.attributeName) || exclude.length))) { tearSeq++; break; }
      }
    });
    try { observer.observe(rootEl!, OBSERVE); } catch { observer = null; }
    observeLang();
  }
  // A modal/popover outside the indexed root can still make that root inert.
  document.addEventListener('toggle', markTearDirty,
    { capture: true, signal: controller.signal });
  document.addEventListener('load', markFrameLoad,
    { capture: true, signal: controller.signal });
  // Resize changes boxes and visibility, not addresses: stale, never torn — and
  // routing it through the tear counter forced a drag-resize into the unsliced
  // rebuild path on every following tool call.
  window.addEventListener('resize', () => { dirty = true; lastMutationAt = performance.now(); mutationSeq++; },
    { passive: true, signal: controller.signal });
  document.fonts?.addEventListener?.('loadingdone', markTearDirty,
    { signal: controller.signal });

  /**
   * Delta observations — ETag semantics for page state.
   *
   * Measured: between two agent steps, 100% of a re-issued describe_app payload
   * was byte-identical on five live sites, and find_on_page returned identical
   * results too. An agent that re-observes every reasoning step pays full price
   * for zero information. This is the gap WebMCP issue #151 describes, and the
   * fix is the one the web already uses for the same problem.
   *
   * A tool returns `_etag`. The agent passes it back as `since`. If nothing
   * changed it gets ~8 tokens instead of ~900; if something did, it gets only
   * the fields that moved.
   */
  const store = createDeltaStore(cfg.delta.history, () => st.version, cfg.delta.maxTrackedKeys);
  const remember = store.remember;
  const delta = store.delta;

  /**
   * The six answers. They live in tools.ts and receive the mutable `st` plus the
   * services they need — this module keeps the lifecycle and nothing else.
   */
  const toolDeps = {
    cfg, navLandmarks, st, est,
    budget, remember, delta,
    ensureFresh: () => ensureFresh(),
    // Has the page stopped reacting? True while a mutation is still fresh (an
    // async re-render in flight) or any region declares itself aria-busy — so the
    // agent waits instead of reading a spinner as the outcome of its action.
    // Read AFTER ensureFresh reindexes, so a same-call reindex-mutation counts.
    settling: (): boolean =>
      (performance.now() - lastMutationAt) < cfg.delta.settleQuietMs
      || !!document.querySelector('[aria-busy="true"]'),
    autoReindex,
    // query_selector's exact-CSS path is the only path that can reach an element
    // the projection walk deliberately skipped, so it needs the exclusion
    // contract explicitly. Its semantic views stay inside the projection.
    exclude, redact: config.redact,
    orientation: config.orientation,
    onIntent: config.onIntent,
  };
  // Tool metadata must exist at registration time; the answer engine does not.
  // All wrappers remain promises even after the first import, so timing never
  // changes the public return shape.
  //
  // The answer engine and the retrieval lane are wanted at the same instant and
  // neither depends on the other, so they load in parallel rather than in
  // series. `createTools` takes a concrete Lane — by the time it runs, there is
  // one, which is why nothing inside tools.ts had to learn about this seam.
  //
  // `firstBuild` is the ordering guarantee, not a convenience. Construction no
  // longer blocks on the index, so without it a tool could reach a lane whose
  // `build()` had not run and search an empty index — and it would do so only
  // sometimes, depending on which module finished fetching first. Gating tool
  // CREATION on the first build makes "a tool exists" and "the index is built"
  // the same event, which is the invariant every tool body already assumes.
  let loadedTools: Promise<Tools> | undefined;
  /**
   * Has an index been built at least once? This is the gate, rather than a
   * handle on the construction-time build, because a handle can only be awaited
   * — and awaiting a build that FAILED yields the same failure no matter how
   * many times a caller asks. `indexReady()` can instead rebuild, which is what
   * turns a transient failure back into a working tool surface.
   */
  let indexBuilt = false;
  const indexReady = (): Awaitable<unknown> => (indexBuilt ? true : reindex());
  const loadTools = () => loadedTools ??= Promise
    .all([import('./tools/tools.ts'), laneReady(), indexReady()])
    .then(([{ createTools }, l]) => createTools({ ...toolDeps, lane: l }))
    .catch((e) => {
      // Un-cache, for the same reason `laneReady` does: `??=` on a rejected
      // promise makes one failed chunk fetch or one crashed worker a permanent
      // death sentence for all six tools. The error still reaches THIS caller;
      // it just does not bind every future one.
      loadedTools = undefined;
      throw e;
    });

  /** @returns true when the index was rebuilt for this call — or, in worker
   *  mode, a promise for it. Every tool routes through `chain()` so one
   *  implementation of each tool serves both lanes. */
  function ensureFresh() {
    if (!autoReindex) return false;
    // Inferred locale belongs to the current SPA view, not to SDK construction.
    // Sites switch `<html lang>` without replacing the body; freezing the old
    // tokenizer made Turkish dotted/dotless-I queries disagree with authored
    // text even after an otherwise successful reindex. An explicit config
    // locale remains pinned by resolveLocale().
    const currentLocale = resolveLocale();
    if (currentLocale !== locale) {
      locale = currentLocale;
      segmentWords = makeTokenizer(locale, cfg.text).wordCount;
      markTearDirty();
    }
    const currentTransientRoot = resolveTransientInteractionRoot();
    if (currentTransientRoot !== transientInteractionRoot) {
      transientInteractionRoot = currentTransientRoot;
      markTearDirty();
      rebindObservation();
    }
    // Selector/fallback roots are identities only until an SPA replaces them.
    // Re-resolve at the observation boundary; removal happens at the parent and
    // is invisible to an observer attached to the detached old subtree.
    if (typeof config.root !== 'object') {
      const resolved = resolveRoot();
      const current = resolved
        ?? (hasExplicitRoot ? missingExplicitRoot : document.documentElement ?? missingExplicitRoot);
      const currentPrimary = resolvePrimaryRoot(current);
      if (current !== rootEl || currentPrimary !== primaryRootEl) {
        rootEl = current;
        primaryRootEl = currentPrimary ?? current;
        markTearDirty();
        rebindObservation();
      }
    }
    const href = typeof location !== 'undefined' ? location.href : '';
    const shape = treeShape();
    if (!dirty && href === lastHref && shape === lastShape) return false;
    return chain(reindex(), () => true);
  }

  /** How many torn passes to discard before giving up and taking the long task.
   *  Two, because a page mutating through three consecutive sliced passes is not
   *  going to stop for a fourth, and a stale index is worse than a long task. */
  const MAX_TORN_RETRIES = 2;

  /**
   * Project, sliced where that is safe and in one task where it is not.
   *
   * Slicing hands the main thread back mid-walk, so the DOM can move underneath
   * a pass and the result can describe a page that never existed at any instant.
   * A torn projection does not throw — it mints addresses that resolve to the
   * wrong element or to nothing. Historical live-site measurements reached 100%
   * address re-resolution across 18 sites; rebuild the sensor before changing
   * this guard.
   *
   * Two preconditions, both of them necessary:
   *
   *   - the WORKER lane, because only it benefits from moving the downstream
   *     retrieval build off the main thread;
   *   - an OBSERVER, because without one there is no tear signal at all, and
   *     slicing blind is the one combination that could ship a torn index.
   *
   * Neither holds -> the original synchronous walk, unchanged.
   */
  function projectNow(): Awaitable<Projection> {
    // Initial construction does not pass through ensureFresh(). Resolve the
    // platform interaction root here as well so an SDK installed while a modal
    // is already open starts from the usable surface.
    transientInteractionRoot = resolveTransientInteractionRoot();
    const opts = { exclude, redact: config.redact,
      project: cfg.project, affordance: cfg.affordance, nonText: cfg.nonText,
      discovery: cfg.discovery, navLandmarks: cfg.retrieval.navLandmarks,
      extraRoots: overlayRoots(),
      primaryRoot: primaryRootEl,
      includeDocumentMetadata: !hasExplicitRoot };
    if (!laneAsync || !observer) return project(rootEl!, opts);
    return (async () => {
      for (let attempt = 0; attempt <= MAX_TORN_RETRIES; attempt++) {
        const before = tearSeq;
        const p = await projectAsync(rootEl!, opts);
        if (tearSeq === before) return p;
      }
      // Last resort, and deliberately the thing we were trying to avoid: one
      // uninterrupted pass cannot be torn, because nothing else runs during it.
      return project(rootEl!, opts);
    })();
  }

  /**
   * OPT-IN (`discovery.frames`): fold the content of readable SAME-ORIGIN child
   * frames into the projection, so `find_on_page` reaches an app shell that
   * frames its own content. Each frame is projected SEPARATELY (its addresses are
   * document-local) and every node is tagged with the frame's scope path, so a
   * frame passage's address carries a frame identity and cannot collide with the
   * top document. Frame CONTROLS are left for the control index to drop (their
   * boxes are frame-relative) — this adds frame READING, not frame clicking.
   * Bounded: a capped number of frames, and a runaway frame is skipped whole.
   */
  function mergeFrames(p: Projection): Projection {
    if (!cfg.discovery.frames || !rootEl) return p;
    const opts = { exclude, redact: config.redact, project: cfg.project,
      affordance: cfg.affordance, nonText: cfg.nonText,
      discovery: { ...cfg.discovery, frames: false },   // depth 1: no nested-frame recursion
      navLandmarks: cfg.retrieval.navLandmarks, includeDocumentMetadata: false };
    let n = 0;
    for (const s of queryScopes(document, { extra: p.shadowRoots, frames: true,
      enter: (b) => !excludedDeep(b, exclude) }).scopes) {
      if (n >= 6) break;   // frame cap
      if (s.kind !== 'document' || s.root === document || !s.frame || !flatContains(rootEl, s.frame)) continue;
      const el = (s.root as Document).documentElement;
      let fp: Projection;
      try { fp = project(el!, { ...opts, primaryRoot: el! }); } catch { continue; }
      if (fp.nodes.length > 3000) continue;   // a runaway frame does not blow the index
      for (const nd of fp.nodes) nd.frame = s.path;
      for (const opaque of fp.opaque) opaque.frame = s.path;
      p.nodes.push(...fp.nodes);
      p.qa.push(...fp.qa);
      p.opaque.push(...fp.opaque);
      p.opaqueWithoutGeometry += fp.opaqueWithoutGeometry;
      p.opaqueTotal += fp.opaqueTotal;
      if (fp.shadowRoots?.length) p.shadowRoots.push(...fp.shadowRoots);
      p.frameRoots.push(el!);
      for (const key of Object.keys(fp.coverage) as Array<keyof typeof fp.coverage>) {
        if (key !== 'elementsInspectedPct') p.coverage[key] += fp.coverage[key];
      }
      n++;
    }
    // Derive the remaining gap from complete document projections: each merged
    // document removes one parent gap, while its own nested-frame gaps remain.
    p.coverage.unindexedFrameDocuments = Math.max(0, p.coverage.unindexedFrameDocuments - n);
    p.coverage.elementsInspectedPct = Math.min(100, Math.round(
      (p.coverage.rootElements / Math.max(1, p.coverage.documentElements)) * 100));
    p.opaque.sort((a, b) => (b.box.w * b.box.h) - (a.box.w * a.box.h));
    return p;
  }

  let pendingReindex: Promise<IndexStats> | null = null;
  function reindex(): Awaitable<IndexStats> {
    // Coalesce, but never serve a knowingly stale snapshot: a mutation that
    // arrived AFTER an in-flight rebuild started sets `dirty` again, and the
    // caller that saw it must get a rebuild that includes it, not the older one.
    if (pendingReindex) {
      return pendingReindex.then((stats) => (dirty ? reindex() : stats));
    }
    const t0 = performance.now();
    const generation = mutationSeq;
    // Split at the projection boundary so everything downstream stays exactly as
    // it was — same body, same indentation, one `chain` at the seam.
    const run = chain(projectNow(), (projection) => buildIndex(mergeFrames(projection), t0, generation));
    // Coalesce on whether THIS run is asynchronous, not on which lane we are on.
    // The inline lane used to be synchronous always, so `laneAsync` was a fair
    // proxy; it is not one any more. The inline lane is asynchronous for exactly
    // one window — while the retrieval module is in flight — and two rebuilds
    // landing inside that window each captured their own document strings, so
    // whichever `build()` resolved last won the index while `st` held the other
    // projection. Hit ids then pointed into chunks that were no longer there.
    if (typeof (run as Promise<IndexStats>)?.then !== 'function') return run;
    const pending = Promise.resolve(run).finally(() => {
      if (pendingReindex === pending) pendingReindex = null;
    });
    pendingReindex = pending;
    return pending;
  }

  function buildIndex(projection: Projection, t0: number, generation: number) {
    st.projection = projection;
    // Attach before the asynchronous index build starts. A mutation during that
    // await must advance mutationSeq so this generation cannot clear `dirty`.
    observeRoots([...st.projection.shadowRoots, ...st.projection.frameRoots, ...overlayRoots()]);
    // Wall clock, so under slicing this INCLUDES the time spent yielded. That is
    // the honest number for "how long until the index was fresh"; the number the
    // 50 ms guardrail cares about is the longest single task, which docs/EVAL.md
    // § 7 records as projection-bound.
    const projectMs = performance.now() - t0;

    // Projection and segmentation stay on the main thread because they need the
    // DOM. Only the two INDEXES cross into the worker, and only as plain strings.
    // Chunk size and retrieval must use the same locale-sensitive boundaries;
    // a default English counter recreates the CJK/Thai defect under a new name.
    st.seg = segment(st.projection.nodes, cfg.segment, segmentWords);
    // Heading path is prefixed before indexing — the cheap deterministic
    // analogue of contextual retrieval. `headingWeight` repeats it (BM25F-lite):
    // see config.ts § lexical for the measured failure a weight of 1 produces.
    const hw = Math.max(1, Math.round(cfg.lexical.headingWeight ?? 1));
    st.structure = buildStructure(st.projection, navLandmarks);
    const passageTargets: IndexState['contentTargets'] = st.seg.chunks.map((_, chunk) => ({ kind: 'passage', chunk }));
    // Every authored heading is a target distinct from the passage it contains:
    // "find this section" asks for the heading while "what does it say" asks
    // for evidence below it. Devpost's "Judging Criteria" has no direct chunk;
    // Wikipedia's featured-article heading does, yet its child links still beat
    // it until the heading itself entered the SAME BM25 corpus. A post-search
    // heading heuristic would be a second ranker and could disagree with the
    // shipped lane.
    // One O(nodes) map instead of a find() per outline entry — the join itself
    // lives in structure.ts, shared with the tools' outline section.
    const headingByKey = headingNodeIndex(st.projection);
    const sectionTargets: IndexState['contentTargets'] = st.structure.outline.flatMap((entry) => {
      const heading = headingByKey.get(outlineKey(entry.landmark, entry.headingPath));
      return heading ? [{ kind: 'section' as const, heading }] : [];
    });
    st.contentTargets = [...passageTargets, ...sectionTargets];
    const contentDocs = st.contentTargets.map((target) => {
      if (target.kind === 'section') {
        const head = target.heading.headingPath.join(' ');
        return `${target.heading.landmark ?? ''} ${Array(hw).fill(head).join(' ')}`;
      }
      const c = st.seg.chunks[target.chunk];
      const head = c.headingPath.join(' ');
      return `${c.landmark ?? ''} ${Array(hw).fill(head).join(' ')} ${c.text}`;
    });

    // Keep the latent interactive corpus, not only the controls whose CSS made
    // them actionable during projection. CSSOM/adoptedStyleSheets changes emit
    // no MutationObserver record: dropping a hidden control here makes a later
    // hidden→visible transition undiscoverable, while keeping it lets the tools
    // filter actionability live. Search indices still align by this stable idx.
    st.controls = st.projection.nodes
      // Frame controls are excluded: their bounding box is relative to the frame's
      // own viewport, and the host acts in top-document coordinates. Frame content
      // is READ (find_on_page / read_region), not clicked — see mergeFrames.
      .filter((n) => n.interactive && !n.frame)
      .map((n, i) => ({ ...n, idx: i }));
    // The row text goes into the control's document, so a row control can be
    // found by what its row SAYS rather than by what the control is called.
    // Built by affordance.js § controlDoc, which the evaluation harnesses import
    // too — the ranker under test is the ranker that ships. Appending a row whose
    // text IS the control's name would double that name's term frequency and hand
    // BM25 an unearned boost, so controlDoc drops it; the affordance terms are the
    // words an author would have used if the markup had had to say it out loud.
    controlDocs = st.controls.map((c) => controlDoc(c, cfg.affordance.terms));

    // `chars/4` is an English approximation. Detect the page's script once per
    // index and adjust, unless the host pinned a value.
    if (config.tuning?.text?.charsPerToken === undefined) {
      const sample = st.seg.chunks.slice(0, cfg.retrieval.scriptSampleChunks).map((c) => c.text).join(' ');
      const density = scriptDensity(sample, cfg.retrieval.scriptSampleChars);
      cfg.text.charsPerToken = +(4 - density * 2.5).toFixed(2);
    }

    // Everything above is synchronous and stays that way: the projection, the
    // segmentation the sync highlight surface reads, the structure, and the
    // document strings. Only the INDEX build crosses the lazy lane boundary, so
    // `st.seg` is never null for a caller that constructed the SDK and went
    // straight to `highlightAddress()`.
    //
    // Inline: once the lane module has landed this resolves immediately, exactly
    // as it always has. Worker: it returns a promise for the same stats. The
    // first build additionally waits on the lane chunk — warmed at construction
    // below, so in practice it has arrived before an agent asks anything.
    return chain(laneReady(), (l) => chain(l.build({
      contentDocs,
      // Exact evidence must scan authored text, not the heading repetitions
      // added above for ranking. Otherwise a query matching only a heading would
      // be reported at an offset that does not exist in the returned passage.
      rawContentDocs: st.contentTargets.map((target) => target.kind === 'section'
        ? target.heading.headingPath.at(-1) ?? target.heading.text
        : st.seg.chunks[target.chunk].text),
      controlDocs, locale, textCfg: cfg.text, lexical: cfg.lexical,
    }), (built) => {
      const stats = {
        ...st.seg.stats,
        charsPerToken: cfg.text.charsPerToken,
        controls: st.controls.filter((n) => isActionableElement(n.el)).length,
        nodes: st.projection.nodes.length,
        coverage: st.projection.coverage,
        locale: built.locale,
        retrieval: built.retrieval,
        stemLanguage: built.stemLanguage,
        lane: laneKind,
        projectMs: +projectMs.toFixed(1),
        indexMs: built.indexMs,
        ...(bootedEarly ? { bootedEarly: true } : {}),
        ...(built.denseMs ? { denseMs: built.denseMs } : {}),
      };
      // The index exists from here, whatever happens to the bookkeeping below.
      // `indexReady()` reads this to decide "await nothing" versus "rebuild",
      // and a rebuild that already produced stats must not be repeated.
      indexBuilt = true;
      // A worker rebuild can still be in flight when dispose() aborts the tools.
      // Publishing its result now — bumping the version, caching stats, and above
      // all firing onIndex — would report a fresh index on an instance whose tools
      // are already unregistered: a callback the host cannot correlate to a live
      // SDK, and state that lies about teardown. Resolve the promise with a
      // coherent value, but land no side effect.
      if (disposed) return stats;
      dirty = mutationSeq !== generation;
      st.treeTokenCache = null;
      st.version++;
      lastHref = typeof location !== 'undefined' ? location.href : '';
      lastShape = treeShape();
      lastStats = stats;
      config.onIndex?.(stats);
      return stats;
    }));
  }

  /**
   * Every public tool returns a promise. Besides stabilizing the contract
   * across worker and freshness states, this keeps the answer engine out of
   * the eager core until the first tool call.
   */
  const settle = <T>(v: Awaitable<T>): Promise<T> => Promise.resolve(v);

  /**
   * One top-level input gate for every consumer and every tool.
   *
   * JSON Schema is only a semantic hint in WebMCP, and destructuring `null`
   * throws before any tool's field guards run. The old `args ?? {}` wrapper was
   * worse for optional-input tools: it silently converted an explicitly invalid
   * `null` call into a successful `describe_app({})`. Centralising the object
   * boundary keeps six tools and both adapters from drifting. `undefined` alone
   * means "no arguments" and still becomes the empty object.
   */
  const invoke = (name: ToolSpecName, args: unknown): Promise<ToolPayload> => {
    const valid = args === undefined
      || (typeof args === 'object' && args !== null && !Array.isArray(args));
    if (!valid) return Promise.resolve({ outcome: 'error', error: 'INVALID_INPUT', message: 'tool input must be an object' });
    // The untrusted-string SIZE cap lives in the lazy tool wrapper (tools.ts
    // § withSummary), which runs before any tool body — kept out of the eager
    // core, which only needs the object-shape gate above.
    const input = (args ?? {}) as ToolPayload;
    return loadTools()
      .then((tools) => (tools[name] as (a: any) => Awaitable<ToolPayload>)(input));
  };

  // Dispatched by name, so each entry's argument shape is only knowable at the
  // call site. The individual tool functions above keep their precise signatures;
  // this map is the dynamic surface WebMCP and the demo panel both go through.
  // Names come from tool-names.ts, not the schemas: routing is synchronous and
  // must not pull 4.9 kB of agent-facing metadata into construction.
  const toolMap = Object.fromEntries(
    TOOL_NAMES.map((name) => [name, (args?: ToolPayload) => invoke(name, args)]),
  ) as unknown as NaviquestTools;

  /**
   * Registration-time metadata, built once from the lazily loaded schemas.
   *
   * `register()` is already async and `toolDefs()` returns a promise, so both
   * consumers can await the import — which is the whole reason the schemas are
   * not eager. Memoised, so a host that calls `register()` on every route
   * change rebuilds neither the import nor these closures.
   */
  let loadedDefs: Promise<ToolDefinition[]> | undefined;
  const loadToolDefs = () => loadedDefs ??= import('./tools/tool-specs.ts')
    .then(({ TOOL_SPECS }) => TOOL_SPECS.map(toolDefinition));

  const toolDefinition = (t: ToolSpec) => ({
    name: t.name,
    // `USVString title` on ModelContextTool — see tools.ts § specs for why the
    // spec carries a display name separate from the callable one.
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    // Declared here, once, so `toolDefs` and the WebMCP registration cannot
    // disagree about them — and so a test can assert them (acceptance A9).
    annotations: { readOnlyHint: (t as { readOnlyHint?: boolean }).readOnlyHint !== false, untrustedContentHint: true },
    /**
     * The second argument is not optional in the spec — and Chrome 151 does not
     * pass it. Both halves of that matter.
     *
     * `ToolExecuteCallbackOptions` declares `required AbortSignal signal`, and
     * the spec keeps a `pending tool executions map` with a documented
     * cancellation/resolution race precisely because agents abandon turns.
     * MEASURED against Chrome 151: `execute` is invoked with one argument and
     * no signal. So this branch is
     * correct against the spec and INERT in the browser that ships today.
     *
     * It is here anyway because the alternative is discovering the gap the day
     * Chrome closes it, and because the cost is one optional parameter. What it
     * must not do is let anyone read cancellation into a release that has none —
     * hence this note rather than a claim in the README.
     *
     * What this honours is the RESPONSE, not the WORK. Retrieval that has
     * already been posted into the worker still runs to completion there — the
     * lane has no cancellation seam and inventing one for a pure-CPU task that
     * finishes in single-digit milliseconds would cost more than it saves. What
     * changes is that the promise the agent is waiting on settles at once
     * instead of at our convenience, which is what abort means at this boundary.
     * A lane-level cancel belongs with lane.ts if a tool ever does I/O.
     */
    execute: async (args: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      const signal = options?.signal;
      // Cheapest possible case, and the commonest: the turn was already
      // abandoned before this tool was ever reached.
      signal?.throwIfAborted?.();
      const work = Promise.resolve(invoke(t.name, args)).then(wrap);
      if (!signal) return work;
      // `once` removes the listener when abort fires; when WORK wins instead, the
      // listener is released with the per-call signal, which the agent drops at
      // turn end. No long-lived accumulation to unwind.
      return Promise.race([work, new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })]);
    },
  });

  const wrap = (obj: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

  /**
   * Warm the dense lane.
   *
   * Historical network measurement: served gzipped, the table
   * costs 0.04 s unthrottled, 6.19 s on fast 4G, 13.90 s on regular 4G and
   * 34.59 s on slow 4G. An agent will not wait fourteen seconds for a search, so
   * "lazy on first query" is not a shippable policy on its own. Three rules fall
   * out of that, and all three are implemented rather than described:
   *
   *   1. A query NEVER blocks on the model. Every retrieval response carries
   *      `retrieval: "lexical" | "hybrid"`, reported by the lane, so an agent can
   *      tell "no match" from "the model has not arrived".
   *   2. Warm when an agent is PLAUSIBLY PRESENT, not when it asks.
   *      `document.modelContext` existing is that signal — it means a
   *      WebMCP-capable agent is in the page. An ordinary visitor keeps zero
   *      bytes on first paint, which is the whole point of the lexical floor.
   *   3. The worker fetches, so the bytes never touch the main heap.
   *
   * `dense: true` is that gated policy and is what a site should ship. It has one
   * consequence worth stating rather than discovering: in stock Chrome
   * `document.modelContext` does not exist, so the gated policy correctly never
   * fires and the lane is invisible to anyone developing without the WebMCP flag.
   * `dense: 'eager'` warms immediately for exactly that case. It is a development
   * setting, and it is named for what it does rather than hidden behind `true`.
   */
  function warmDense(base?: string) {
    /**
     * `saveData` is the user saying "do not spend my bytes", and we were
     * spending 4 MB of them anyway.
     *
     * The dense lane is a RANKING improvement, never a correctness one — every
     * response already declares `retrieval: "lexical"` and the SDK is designed
     * to answer without the weights. So Data Saver is the one signal that should
     * veto the download outright, and honouring it costs one branch.
     *
     * An explicit `warmDense(base)` from a host still wins: passing a base is an
     * intentional act, not the automatic warm-on-agent-arrival policy.
     */
    if (base === undefined && dataSaverOn()) {
      return chain(laneReady(), (l) => l.status());
    }
    const url = base ?? config.denseBase ?? './model/';
    const abs = typeof location !== 'undefined' ? new URL(url, location.href).href : url;
    return chain(laneReady(), (l) => l.dense(abs));
  }

  let registered = false;
  let disposed = false;
  let registrationController: AbortController | null = null;
  let registrationInFlight: Promise<RegisterResult> | null = null;

  function register(): Promise<RegisterResult> {
    // Two hosts can defensively call register() in the same turn. Sharing the
    // attempt prevents them racing six names against each other and mistaking
    // their own duplicate for another SDK instance.
    return registrationInFlight ??= registerOnce().finally(() => { registrationInFlight = null; });
  }

  async function registerOnce(): Promise<RegisterResult> {
    // The AbortController is aborted permanently on dispose, so a re-register
    // would have every tool rejected with a bare AbortError. Say what happened.
    if (disposed) return { registered: false, via: null, reason: 'disposed; create a new Naviquest instance' };
    const { mc, via } = resolveModelContext();
    if (!mc) return { registered: false, via: null, reason: 'WebMCP modelContext is unavailable' };
    // Calling register() twice on one instance is a no-op, not six duplicate
    // tools. Returning the same shape means a host that calls it defensively on
    // every route change needs no special case.
    if (registered) {
      return { registered: true, via, tools: [...TOOL_NAMES] };
    }
    /**
     * The fast path, and the one with a message worth reading — but NOT the
     * guarantee. `claimed` is module state, so it only sees instances that share
     * this module. Two separately bundled copies of the SDK on one page each hold
     * their own WeakSet, and both would try.
     *
     * The platform is the actual guarantee: registering a name already in the
     * tool map rejects with `InvalidStateError`, so duplicates are impossible
     * rather than merely discouraged. The catch below is what covers the case
     * this set cannot see.
     */
    if (claimed.has(mc)) {
      return { registered: false, via,
               reason: 'this modelContext already has Naviquest tools; dispose their owning instance first' };
    }
    const results: string[] = [];
    // The schemas arrive here rather than at construction. Awaited before the
    // first registerTool call. A load failure leaves no platform state behind
    // and remains retryable.
    let defs: ToolDefinition[];
    try { defs = await loadToolDefs(); }
    catch (error) {
      return { registered: false, via,
        reason: `tool definitions failed to load: ${(error as Error)?.message || error}` };
    }
    if (disposed) return { registered: false, via: null, reason: 'disposed while loading tool definitions' };
    const attempt = new AbortController();
    registrationController = attempt;
    for (const t of defs) {
      try {
        await mc.registerTool({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          // Retrieved page content is exactly the Output Injection surface the
          // WebMCP spec describes. untrustedContentHint is its own mitigation
          // and is not optional for a tool that hands page text to a model.
          annotations: t.annotations,
          execute: t.execute,
        }, { signal: attempt.signal });
        results.push(t.name);
      } catch (e) {
        const taken = (e as Error)?.name === 'InvalidStateError';
        // Six tools are one navigation contract. Abort unregisters every name
        // this attempt already installed, so the page never advertises a mixed
        // surface and the same instance can retry after a transient failure.
        attempt.abort();
        registrationController = null;
        return { registered: false, via, failed: [t.name],
          reason: taken
            ? `${t.name} already exists; registration rolled back`
            : `${t.name} failed; registration rolled back and can be retried` };
      }
    }
    if (disposed) {
      attempt.abort();
      registrationController = null;
      return { registered: false, via: null, reason: 'disposed during registration' };
    }
    // Rule 2 above: a registered tool surface is the evidence that an agent is
    // plausibly here. Deliberately not awaited — registration must not wait on
    // megabytes, and the lexical lane is already answering.
    if (config.dense && laneKind === 'worker') Promise.resolve(warmDense()).catch(() => {});
    registered = true;
    claimed.add(mc);
    return { registered: true, via, tools: results };
  }

  const api: NaviquestApi = {
    reindex: () => settle(reindex()),
    /** The resolved tunables, so a host can inspect what it is running.
     *  structuredClone rather than a JSON round trip, which silently drops
     *  `undefined` values and turns anything non-JSON into a different shape. */
    config: () => structuredClone(cfg),
    stats: () => ({ ...lastStats }),
    tools: toolMap,
    /**
     * Opt-in for content this SDK cannot reach on its own.
     *
     * A closed shadow root is unreachable from page JavaScript — Apple's Mac
     * configurator hides `Add to Bag` and every memory radio behind 28 of them,
     * which makes those tasks impossible rather than merely missed. The
     * component that created the root has the reference, so it can call in:
     *
     *   connectedCallback() { window.naviquest?.registerRegion(this.shadowRoot); }
     *
     * Also accepts a plain element for content rendered outside `root`.
     */
    registerRegion(rootOrElement: Element | ShadowRoot | null | undefined): boolean {
      if (!rootOrElement || registeredRegions.has(rootOrElement)) return false;
      registeredRegions.add(rootOrElement);
      observeRoots([rootOrElement]);
      markTearDirty();
      // Fire-and-forget by contract (the boolean answers "was it accepted"),
      // but a worker-lane rebuild failure must not surface as an unhandled
      // rejection; `dirty` stays set, so the next tool call rebuilds anyway.
      Promise.resolve(reindex()).catch(() => {});
      return true;
    },
    unregisterRegion(rootOrElement: Element | ShadowRoot): boolean {
      const had = registeredRegions.delete(rootOrElement);
      if (had) {
        markTearDirty();
        rebindObservation();
        Promise.resolve(reindex()).catch(() => {});
      }
      return had;
    },
    toolDefs: loadToolDefs,
    // The tool surface always re-projects before answering; the sync page-side
    // surface can only afford that on the inline lane, where ensureFresh
    // completes synchronously. Worker-lane callers hold a possibly-stale
    // projection until the next tool call — resolve() reports NOT_FOUND on a
    // removed element either way, so staleness degrades, never lies.
    resolve: (a: Address) => {
      if (!laneAsync) void ensureFresh();
      return resolve(a, st.projection, cfg.address);
    },
    /**
     * Highlight the sentence that answered, not the section it sits in.
     *
     * `find_on_page` reports which of the chunk's elements the answer span fell
     * in; highlighting only that one is the difference between showing a reader
     * where to look and showing them a whole section and asking them to find it.
     * Falls back to the full region when the answer has no element — a
     * schema.org answer has no passage to point at.
     */
    highlightAnswer(answer: { address?: Address; spanElement?: number }) {
      if (!answer?.address) return false;
      if (typeof answer.spanElement !== 'number') return api.highlightAddress(answer.address);
      // Heading paths are not unique per chunk (highlightAddress below collects
      // ALL of them); taking the first chunk resolved the span index against the
      // wrong chunk in a multi-chunk section. Index into the combined span list,
      // matching the order the chunks themselves carry.
      const spans = st.seg.chunks
        .filter((c) => samePath(c.headingPath, answer.address!.headingPath))
        .flatMap((c) => c.spans);
      const el = spans[answer.spanElement]?.el;
      return el ? highlighter.highlight([el]) : api.highlightAddress(answer.address);
    },
    highlightAddress(address: Address) {
      const els = st.seg.chunks
        .filter((c) => samePath(c.headingPath, address.headingPath))
        .flatMap((c) => c.els);
      const r = resolve(address, st.projection, cfg.address);
      if (r.status === 'RESOLVED') els.push(r.element);
      return highlighter.highlight(els);
    },
    clearHighlight: () => highlighter.clear(),
    highlightSupported,
    register,
    /** Which lane retrieval is running on, and what the dense half is doing. */
    /**
     * `ready: false` is the honest answer while the retrieval module is in
     * flight. `kind` and `async` are config facts and are true immediately;
     * `stemLanguage` and the dense state are not knowable until the lane
     * exists, and guessing 'none' for a page that will stem in German is
     * exactly the confident wrong answer this SDK does not give.
     *
     * "Still loading" and "never arriving" are also different answers, and
     * reporting the first for the second is the same lie in slower motion: a
     * host polling `ready` on a chunk that 404s would wait for a load that has
     * already failed. `laneError` separates them.
     */
    lane: () => {
      if (lane) {
        return { kind: lane.kind, async: lane.async, ready: true as const,
          stemLanguage: lane.stemLanguage(), ...lane.status() };
      }
      const why = laneError instanceof Error ? laneError.message : String(laneError);
      return { kind: laneKind, async: laneAsync, ready: false as const,
        stemLanguage: laneError ? 'unavailable' : 'pending',
        dense: laneError
          ? { status: 'unavailable' as const, detail: `retrieval lane failed: ${why}` }
          : { status: 'off' as const, detail: 'retrieval lane still loading' },
        retrieval: 'lexical' as const };
    },
    warmDense,
    dispose() {
      // The registration controller unregisters the six tools as one surface;
      // the lifecycle controller independently stops observers and listeners.
      const { mc } = resolveModelContext();
      if (mc && registered) claimed.delete(mc);
      registered = false;
      disposed = true;
      registrationController?.abort(); registrationController = null;
      // Only a lane that exists can be disposed. If the module is still in
      // flight, dispose the instance it produces rather than dropping a live
      // worker on the floor — `disposed` already suppresses everything else.
      controller.abort(); observer?.disconnect(); highlighter.clear();
      if (lane) lane.dispose();
      else lanePromise?.then((l) => l.dispose()).catch(() => {});
      loadedTools?.then((tools) => tools.disposeSummary()).catch(() => {});
    },
  };

  // Construction stays synchronous THROUGH THE PROJECTION, which is the half
  // that has to be: the DOM is a moving target and the snapshot must be taken
  // now. The index build behind it is deferred only by the cost of fetching the
  // retrieval module, and that fetch starts on this line rather than on the
  // first tool call — warmed, not lazy. An agent that arrives one round trip
  // later than the page finds a built index and waits for nothing.
  // `bootedEarly` is decided BEFORE the first build so the stats describing the
  // incomplete document are the ones that carry the flag.
  const earlyBoot = typeof document !== 'undefined' && document.readyState === 'loading';
  if (earlyBoot) bootedEarly = true;
  const reindexed = reindex();
  // On the inline lane nobody awaits construction — that is the documented
  // contract — so this build has no caller to hand a failure to. Left bare it
  // becomes an unhandled rejection: a page-level `unhandledrejection` event and
  // a console error attributed to the host, for a condition the SDK is designed
  // to survive. It is observed rather than swallowed: `lane()` reports the
  // reason, and the next tool call retries and rejects with the real error.
  void Promise.resolve(reindexed).catch(() => {});

  /**
   * A third-party SDK does not get to choose when it is loaded.
   *
   * Installed from `<head>` without `defer`, or by a tag manager, the root
   * cascade matches nothing and the first projection indexes an empty document —
   * and because MutationObserver only reports what changes AFTER it attaches,
   * a page that finishes parsing normally would never trigger the rebuild that
   * fixes it. The index would simply be empty for the life of the page.
   *
   * So: index whatever exists now (construction stays synchronous), and rebuild
   * once the parser is done. `stats().bootedEarly` reports that it happened
   * rather than leaving a host to wonder why the first numbers looked wrong.
   */
  if (earlyBoot) {
    document.addEventListener('DOMContentLoaded', () => { ensureFresh(); },
      { once: true, signal: controller.signal });
  }

  // `dense: 'eager'` — warm now, without waiting for an agent to show up. Not
  // awaited: the lexical lane is already answering and must not be held up.
  if (config.dense === 'eager' && laneKind === 'worker') {
    chain(reindexed, () => Promise.resolve(warmDense()).catch(() => {}));
  }

  /**
   * The inline lane still constructs synchronously, and that is a contract, not
   * an optimization: a host writes `const nq = createNaviquest()` and reaches
   * for `nq.tools` on the next line without awaiting, because on the inline lane
   * there was never anything to await. Returning a promise here because the
   * RETRIEVAL MODULE is in flight would hand every one of those callers a
   * thenable where they expect an API object.
   *
   * It stays safe because the deferral boundary sits after the synchronous half:
   * by this line `st.projection`, `st.seg`, `st.structure` and `st.controls` are
   * already populated, so `resolve()`, `highlightAddress()` and the whole
   * page-side surface answer immediately. Only SEARCH needs the lane, and no
   * search can happen before `loadTools()` — which waits on the first build.
   *
   * The worker lane returned a promise for a built index before and still does.
   */
  return laneAsync ? chain(reindexed, () => api) : api;
}

// ---- public surface --------------------------------------------------------
//
// PUBLIC SURFACE. Everything a consumer needs, re-exported from the package
// entry so nobody has to reach into a file path. The demo imports only from
// here, which means a broken export fails the demo build rather than surfacing
// after publish.
export { vocabularyOf } from './page/affordance.ts';
export type { AgenticIntent, AgenticDoc, AgenticManifest, AgenticTuning } from './tools/agentic.ts';
export { estimateTokens, makeTokenizer, makeStemmer } from './retrieval/text.ts';
export type { ToolPayload, Shrink } from './tools/budget.ts';
export type { PageStructure } from './tools/structure.ts';
export { DEFAULTS, resolveConfig } from './config.ts';
export { highlightSupported } from './page/highlight.ts';
export type {
  Address, Chunk, Coverage, IndexStats, OpaqueRegion, ProjectedNode, Projection,
  QAPair, Resolution, RetrievalLane, States,
} from './types.ts';
export type { Tuning, PartialTuning, ToolName, OrientationTuning } from './config.ts';
export type { NaviquestOrientation, OrientationTask, AuthoredOrientation } from './tools/orientation.ts';
export type { AnswerSpan } from './retrieval/answer.ts';
export type { ModelContext, ToolDefinition, ToolResult } from './webmcp.d.ts';
export type {
  AgenticContentInput, AgenticContentResult, AgenticContentSuccess,
  AgenticDocument, AgenticLink, AgenticMatch,
  ContentAnswer, ContentPassage, ControlCandidate,
  DescribeAppInput, DescribeAppModeSuccess, DescribeAppResult,
  DescribeAppSectionSuccess, DescribeAppSuccess, DescribeModalState,
  FindOnPageInput, FindOnPageResult, FindOnPageSuccess,
  OrientationSection, PageInput,
  LocateControlInput, LocateControlNoMatch, LocateControlResult, LocateControlSuccess,
  OutlineRow, QuerySelectorExactSuccess, QuerySelectorField, QuerySelectorInput,
  QuerySelectorResult, QuerySelectorSuccess, QuerySelectorViewSuccess,
  ResolveAddressInput, ResolveAddressMiss, ResolveAddressResult, ResolveAddressSuccess, ResolveRegionSuccess,
  PaginationEnvelope, SummaryEnvelope, ToolEnvelope, ToolFailure, ToolSuccessEnvelope, NaviquestTools,
} from './tools/tool-contracts.ts';
