import { computeAccessibleName } from 'dom-accessibility-api';
import { roleOf, headingLevel, statesOf, LANDMARKS, INTERACTIVE, SCOPE_BOUNDARY } from './roles.ts';
import { NAME_FROM_CONTENT_ROLES, ROW_ROLES } from './aria-taxonomy.ts';
import { detectModal, isInertUnder } from './modality.ts';
import { isNonText, describeNonText, isUnlabelledControl, compileNonText } from './nontext.ts';
import { extractQA, clean } from './structured.ts';
import type { QAPair } from './structured.ts';
import { DEFAULTS } from '../config.ts';
import { affordancesOf, findPrimaryInput, compilePatterns, controlledElements } from './affordance.ts';
import { flatContains, flatParentElement, idRefTarget, isQueryableShadowRoot, queryRoots, queryScopes } from './dom.ts';
import { boxOf } from '../types.ts';
import { readingOrderText } from './page-text.ts';
import type { Coverage, OpaqueRegion, ProjectedNode, Projection } from '../types.ts';
import type { AffordanceTuning, DiscoveryTuning, NonTextTuning, ProjectTuning } from '../config.ts';

const NAME_FROM_CONTENT = new Set(NAME_FROM_CONTENT_ROLES);

/**
 * Elements that hold no rendered content, ever.
 *
 * This is a PERFORMANCE shortcut, not a semantic rule, and it is the only one of
 * the three lists here that survived. The UA stylesheet already sets
 * `display:none` on every one of them, so `checkVisibility()` would reject them
 * anyway — but that costs a style resolution per node, and skipping by tag name
 * costs a set lookup. `TEMPLATE` is the one that genuinely needs naming: its
 * content lives in a separate DocumentFragment that is not `display:none`, it is
 * simply not in the document at all.
 */
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link']);

/**
 * HTML phrasing tags. A <p> of only these still reads as one sentence; indexing
 * each <code>/<span> as its own node punched holes in MDN legal prose
 * (2026-09-02 Summarizer API: "creating objects ( is required)" instead of
 * "creating Summarizer objects (transient user activation is required)").
 *
 * Private to the projection: only the walk needs to know which elements fold.
 * Everything downstream consumes the folded text.
 */
const PHRASING_TAGS = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'BR', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN',
  'EM', 'I', 'INS', 'KBD', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG',
  'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR',
]);

/** Direct text of this element only — descendants are visited on their own. */
function ownText(el: Element): string {
  const parts: string[] = [];
  for (const n of el.childNodes) {
    // Assigned text renders at its <slot>, where the walk emits it with the
    // shadow heading/landmark context. Reading it here too duplicates terms and
    // places the first copy under the host's unrelated light-DOM path.
    if (n.nodeType === 3 && !(n as Text).assignedSlot) {
      const t = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (t) parts.push(t);
    }
  }
  return parts.join(' ');
}

function hasNonPhrasingChild(el: Element): boolean {
  for (const child of el.children) if (!PHRASING_TAGS.has(child.tagName)) return true;
  return false;
}

/** Sentence text when the element is phrasing-only; otherwise direct text only —
 *  a block child means its own <p>s are visited separately and would duplicate. */
function contentText(el: Element): string {
  return hasNonPhrasingChild(el) ? ownText(el) : readingOrderText(el);
}

/** `text` is the caller's already-computed content fold — recomputing it here
 *  double-walked every candidate on the hot path. */
function looksLikeHeading(el: Element, cfg: ProjectTuning, text: string): boolean {
  // Phrasing children are the heading (`Pay <span>now</span>`). Block children
  // are a section, not a title — same fold as contentText.
  if (hasNonPhrasingChild(el)) return false;
  const t = text;
  if (!t || t.length > cfg.headingMaxChars) return false;
  const cs = getComputedStyle(el);
  const size = parseFloat(cs.fontSize) || 16;
  const weight = parseInt(cs.fontWeight, 10) || 400;
  return size >= cfg.headingMinFontPx
    || (weight >= cfg.headingMinWeight && size >= cfg.headingMinWeightFontPx);
}

export interface ProjectOptions {
  exclude?: string[];
  redact?: (text: string, el: Element) => string;
  project?: Partial<ProjectTuning>;
  affordance?: Partial<AffordanceTuning>;
  nonText?: Partial<NonTextTuning>;
  /** Roles treated as a row. Defaults to the taxonomy-derived `ROW_ROLES`. */
  rowRoles?: string[];
  /** Landmark roles that are page chrome, not document content (nav/banner/
   *  contentinfo). We never INFER a heading inside one — a bold menu label is
   *  not a document heading, and treating it as one fabricated an outline
   *  ("Log In Sign Up › Sign Up › …") that prefixed every real passage. */
  navLandmarks?: string[];
  discovery?: Partial<DiscoveryTuning>;
  /** Roots a component author handed in — the closed-shadow-DOM opt-in. */
  extraRoots?: Array<Element | ShadowRoot>;
  /** Preferred content partition. It affects provenance, never reachability. */
  primaryRoot?: Element;
  /** Page-level metadata is only part of automatic whole-page projection. */
  includeDocumentMetadata?: boolean;
}

/** The synchronous driver never consults the clock: one task, by contract. */
const NEVER = () => false;

/**
 * Work units this cheap have to be batched, or reading the clock costs more than
 * the work between two reads. Assigning one ordinal is a field write; building
 * one peer key is a string concat and a Map lookup — the same order of magnitude
 * as `performance.now()` itself, unlike a walk frame, which is dominated by
 * style resolution, layout boxes and the accessible-name algorithm and can
 * afford a check apiece. Reasoned, not measured: the number only has to be large
 * enough that the clock is noise and small enough that one batch cannot overrun
 * an 8 ms slice, and 512 field writes is nowhere near either edge.
 */
const SLICE_BATCH = 512;

/**
 * Caps on a name RECOVERED rather than authored — deliberately constants and not
 * `tuning` keys.
 *
 * `NAME_FROM_CONTENT_CHARS` bounds a name we build from an element's own text
 * when the accname library declines to name a role that takes its name from
 * content; `GOVERNED_HEADING_CHARS` bounds a heading borrowed as the label for
 * the region a control governs, and is shorter because it is a title standing in
 * for a name rather than the element's own.
 *
 * Both are name HYGIENE, not host policy: a control's name is a label, and the
 * cap only exists so a wrapper that turned out to hold a paragraph is truncated
 * instead of indexed as a name. Exposing them as tunables measured at 0.2 kB of
 * the eager gzip budget for a knob no host has reason to turn, and this codebase
 * treats an unread override as worse than a named literal.
 */
const NAME_FROM_CONTENT_CHARS = 200;
const GOVERNED_HEADING_CHARS = 120;

/**
 * `scheduler.yield()` resumes at the FRONT of the task queue, so a projection
 * that gives the main thread back keeps its own turn and cannot be starved by
 * whatever the host queued while it was away. Chrome 129+ and Firefox since
 * Aug 2025 — NO SAFARI, and there the `setTimeout(0)` fallback is correct, just
 * coarser: it goes to the BACK of the queue and is clamped (~1 ms, 4 ms once
 * nested five deep), so the same page takes more wall-clock to project. Coarser,
 * never wrong — both hand the thread back, which is the only thing the 50 ms
 * long-task guardrail asks for.
 */
function yieldToScheduler(): Promise<void> {
  const s = (globalThis as unknown as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  return s?.yield?.() ?? new Promise<void>((r) => { setTimeout(r, 0); });
}

/**
 * A unit of walk work. `el === null` is the EXIT SENTINEL — the post-order half
 * of a frame, pushed BEFORE the element's children so it pops only after the
 * last of its descendants.
 *
 * The recursion this replaced had exactly one piece of post-order work,
 * `rowStack.pop()`, and it is not optional. Row context is how a control is
 * found by what its ROW says — "toggle renew passport" against three checkboxes
 * all named "Toggle Todo" — so a stack conversion that pops at the wrong depth
 * does not crash, it silently labels every later control with a row it is not
 * in, and the addresses minted there point at the wrong control.
 */
type Frame = {
  el: Element | null;
  landmark: string | null;
  landmarkName: string | null;
  /** Text assigned directly to a slot has no Element of its own. */
  slottedText?: string;
  /** Light-tree owner used for visibility/highlighting of an assigned Text. */
  textOwner?: Element;
};
/** Carries no data, so one instance serves every row exit on every pass. */
const ROW_EXIT: Frame = { el: null, landmark: null, landmarkName: null };

/**
 * The projection, in ONE synchronous task.
 *
 * Synchrony is load-bearing: the inline lane's first index is built before
 * `createNaviquest` returns. `projectAsync` is this same pass under a different
 * driver, never a replacement for it. Shadow-aware and slot-aware:
 * TreeWalker/querySelectorAll stop at shadow boundaries, and slotted light-DOM
 * children must be visited at the slot position exactly once, or every slotted
 * string is double-counted and BM25 term frequencies are poisoned. See
 * `startProjection` for why the walk is a stack rather than recursion.
 */
export function project(root: Element, opts: ProjectOptions = {}): Projection {
  const pass = startProjection(root, opts);
  pass.pump(NEVER);
  return pass.finish();
}

/**
 * The same projection, sliced across tasks.
 *
 * Projection is the last thing on the indexing path that cannot move off the
 * main thread: it reads computed style, layout boxes and the accessible-name
 * algorithm, none of which exist in a worker. docs/EVAL.md § 7 still records a
 * 50 ms guardrail breach on the two largest pages WITH the retrieval worker
 * enabled, because the breach is projection-bound. So the remaining lever is not
 * *where* the work runs but how long it runs at a stretch.
 *
 * The clock is read once per work unit rather than once per batch of them,
 * because a walk frame's own cost — `getComputedStyle`, `checkVisibility`,
 * `computeAccessibleName` — is orders of magnitude above a clock read, and a
 * slice can never be tighter than the slowest single element anyway.
 *
 * The CALLER owns the tear. Handing the main thread back means the DOM may
 * change between slices, and a torn projection mints addresses that do not
 * resolve; the mutation guard that discards and retries lives at the call site,
 * because only the call site can decide to fall back to `project()`.
 */
export async function projectAsync(root: Element, opts: ProjectOptions = {}): Promise<Projection> {
  const pass = startProjection(root, opts);
  let deadline = performance.now() + pass.sliceMs;
  while (!pass.pump(() => performance.now() >= deadline)) {
    await yieldToScheduler();
    deadline = performance.now() + pass.sliceMs;
  }
  return pass.finish();
}

/**
 * Is this element excluded, by itself?
 *
 * EXPORTED, and it was a closure until `query_selector` needed it. That tool
 * hands an agent a raw CSS selector, which means it can reach any element on the
 * page — including the ones a host paid this SDK to never return. The walk gets
 * exclusion for free by simply not descending; a selector match has no walk, so
 * it has to be filtered explicitly, against THIS function rather than a second
 * copy of these three rules.
 *
 * The rules are: the host's own opt-out attribute, `aria-hidden="true"`, and any
 * selector the host passed as `exclude`. Selectors are validated before a
 * projection starts; a later parse failure must still fail closed rather than
 * exposing the subtree the host meant to withhold.
 */
export function excludedSelf(el: Element, exclude: readonly string[]): boolean {
  if (el.hasAttribute?.('data-naviquest-ignore')) return true;
  if (el.getAttribute?.('aria-hidden') === 'true') return true;
  for (const sel of exclude) if (el.matches(sel)) return true;
  return false;
}

/**
 * …and is it excluded by any ANCESTOR?
 *
 * This is the one that matters for a selector tool. `exclude: ['[data-private]']`
 * means the whole subtree, and an agent selecting `input` would otherwise walk
 * straight into a private block that the index itself never contained — the SDK
 * agreeing to a privacy contract in one tool and breaking it in another.
 */
export function excludedDeep(el: Element, exclude: readonly string[]): boolean {
  for (let p: Element | null = el; p; p = flatParentElement(p)) if (excludedSelf(p, exclude)) return true;
  return false;
}

/**
 * Can this interactive element be acted on in the page's current CSS state?
 *
 * Shared by projection and answer-time validation. CSSOM mutations such as
 * `adoptedStyleSheets` emit no MutationObserver record, so a projection-time
 * boolean alone can become confidently stale. Opacity deliberately does not
 * count: transparent native inputs under styled labels are a standard control
 * pattern. `content-visibility:auto` is likewise a scroll optimization, not
 * authored hiding; checkVisibility's default forces the necessary layout.
 */
export function isActionableElement(el: Element): boolean {
  try {
    if (!el.checkVisibility({ visibilityProperty: true })) return false;
    // Same fallback rationale as visible(): offsetParent is null for
    // position:fixed controls, which include most dialog and toolbar actions.
  } catch { return el.getClientRects().length > 0; }
  const r = el.getBoundingClientRect?.();
  return !r || r.width > 0 || r.height > 0;
}

/**
 * One pass, two drivers.
 *
 * Everything below is shared: there is no second implementation of the walk to
 * drift out of agreement with the first. All a driver chooses is when `pump`
 * returns — never (synchronous) or on a slice boundary (asynchronous) — and on a
 * static DOM the two must produce byte-identical projections.
 */
function startProjection(root: Element, opts: ProjectOptions) {
  const cfg = { ...DEFAULTS.project, ...(opts.project ?? {}) };
  // Accessible names depend on mutable attributes, referenced text and style.
  // A module-level WeakMap survived reindex and returned the old name forever;
  // cache only inside the immutable snapshot one projection is constructing.
  const accNameCache = new WeakMap<Element, string>();
  const exclude = opts.exclude ?? [];
  // `exclude` is a privacy boundary, not a best-effort filter. Validate the
  // complete list before touching page content so one typo cannot fail open.
  for (const sel of exclude) {
    if (typeof sel !== 'string') throw new TypeError('exclude selectors must be strings');
    try { root.matches(sel); }
    catch { throw new TypeError(`invalid exclude selector: ${JSON.stringify(sel)}`); }
  }
  const ownerDocument = root.ownerDocument;
  // Roots a component author handed in explicitly. Page JS cannot pierce a
  // closed shadow root — but the component that created it can call in, which
  // turns a hard ceiling into one line of adoption. See index.js registerRegion.
  const extraRoots = (opts.extraRoots ?? []).filter(Boolean);
  // The automatic content root used to be the projection root, which made a
  // ranking preference into a hard exclusion boundary. Keep the distinction in
  // every node so retrieval can prefer primary content without hiding global
  // navigation, consent/account controls, footers, or registered regions.
  const primaryRoot = opts.primaryRoot ?? root;
  const isPrimary = (el: Element): boolean => flatContains(primaryRoot, el);
  const registeredHosts = new WeakSet<Element>();
  for (const r of extraRoots) if (isQueryableShadowRoot(r)) registeredHosts.add(r.host);
  // The elements PHASE_ROOTS will look up in `hostContext` — shadow hosts and
  // plain registered elements alike — known at pass start, so the walk saves
  // context only where it can ever be read.
  const contextBoundaries = new Set<Element>(
    extraRoots.map((r) => (isQueryableShadowRoot(r) ? r.host : r as Element)));
  const redact = opts.redact ?? ((t) => t);
  const nodes: ProjectedNode[] = [];
  const shadowRoots: ShadowRoot[] = [];
  const shadowRootSeen = new WeakSet<ShadowRoot>();
  const rememberShadowRoot = (r: ShadowRoot) => {
    if (!shadowRootSeen.has(r)) { shadowRootSeen.add(r); shadowRoots.push(r); }
  };
  for (const r of extraRoots) if (isQueryableShadowRoot(r)) rememberShadowRoot(r);
  const modality = detectModal(shadowRoots); // once per pass — see modality.js PERF note
  const modal = modality.element;
  const coverage: Coverage = { elementsInspectedPct: 100, documentElements: 0, rootElements: 0, framesOutsideRoot: 0, unindexedFrameDocuments: 0, virtualizedCollections: 0, offDomRowsDeclared: 0, offDomItemsDeclared: 0, unknownSizeCollections: 0, excluded: 0, customElements: 0, unknownRoots: 0, inferredHeadings: 0,
                     opaqueComponents: 0, opaqueInteractive: 0,
                     nonText: 0, nonTextDecorative: 0, nonTextRecovered: 0, nonTextOpaque: 0, unlabelledControls: 0,
                     revealPending: 0, revealPendingChars: 0,
                     malformedStructuredData: 0, nameComputeFailures: 0, invalidExcludeSelectors: 0 };
  /** Parked elements already charged to `revealPendingChars`; see the walk. */
  const countedParked = new WeakSet<Element>();
  const opaque: OpaqueRegion[] = [];
  const qa: QAPair[] = [];
  const primaryInputEl = findPrimaryInput(primaryRoot,
    shadowRoots.filter((r) => flatContains(primaryRoot, r.host)));
  const patterns = compilePatterns(opts.affordance?.patterns ?? {});
  const nonTextPolicy = compileNonText({ ...DEFAULTS.nonText, ...(opts.nonText ?? {}) });
  // Roles whose element IS a row for addressing: taxonomy-derived (subclasses of
  // `listitem`/`row` plus the declared extension in aria-taxonomy.ts), because
  // "is this a repeated addressable container" is a retrieval question ARIA does
  // not model. Host-overridable via `rowRoles`.
  const rowRoles = new Set(opts.rowRoles ?? ROW_ROLES);
  // Chrome landmarks: no INFERRED heading is minted inside these. Authored
  // <h*>/role=heading still count — the author declared those; we only refuse to
  // guess a heading out of bold nav text. Empty set = the default whole-page
  // behaviour, so a caller that passes nothing is unchanged.
  const navChrome = new Set(opts.navLandmarks ?? []);
  const discovery: DiscoveryTuning = { ...DEFAULTS.discovery, ...(opts.discovery ?? {}) };
  const docLang = (ownerDocument.documentElement?.getAttribute('lang') || '').trim();
  const nonTextHandled = new Set<Element>();
  const visitedElements = new WeakSet<Element>();
  /**
   * ARIA has an unusually strong virtualisation signal: `aria-rowcount` exists
   * specifically to declare the full table/grid size when only a window of rows
   * is in the DOM (`-1` means the total is unknown). Unlike class names,
   * scroll-height guesses, or framework internals, this is authored platform
   * semantics. Retain the containers during the walk and compare their declared
   * total with their actually reachable rows at finish; the missing data cannot
   * be indexed, but it must not look like complete search coverage.
   */
  const declaredRowCollections: Array<{ el: Element; total: number }> = [];
  const declaredSetGroups: Array<{ parent: Element; role: string; level: string; total: number; items: Element[] }> = [];
  const setGroupsByParent = new WeakMap<Element, Map<string, typeof declaredSetGroups[number]>>();
  const headingStack: Array<{ scope: Node; level: number; text: string; root: Node }> = [];
  // Registered roots are walked after the document for resumability. Carry the
  // context at their host explicitly; otherwise they inherit whichever heading
  // happened to be last in an unrelated footer or shadow tree.
  let headingPrefix: string[] = [];
  const hostContext = new WeakMap<Element, {
    headingPath: string[]; landmark: string | null; landmarkName: string | null;
  }>();

  /**
   * accname and aria-describedby resolve IDREFs across the WHOLE document, so a
   * label pointing into an excluded subtree would pull that text into the index
   * — defeating the exclusion guarantee through the side door.
   */
  // `aria-labelledby` ONLY: it is the one IDREF attribute accname draws the NAME
  // from. `aria-describedby`/`aria-details` feed descriptions, and blanking the
  // name because a description target was excluded made the control unnameable —
  // "worse than a wrong role because nothing can retrieve it". Description
  // consumers (describeNonText) apply their own per-target exclusion filter.
  const refsExcluded = (el: Element): boolean => {
    for (const id of (el.getAttribute?.('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
      const t = idRefTarget(el, id);
      if (t && isExcludedDeep(t)) return true;
    }
    return false;
  };
  const isExcludedDeep = (el: Element): boolean => excludedDeep(el, exclude);

  function name(el: Element): string {
    if (accNameCache.has(el)) return accNameCache.get(el)!;
    let n = '';
    if (refsExcluded(el)) { accNameCache.set(el, ''); return ''; }
    // A throwing name computation leaves the element indexed UNNAMED, which is
    // precisely what a name-based lookup will fail to find — so it is counted,
    // not swallowed.
    try { n = computeAccessibleName(el) || ''; } catch { n = ''; coverage.nameComputeFailures++; }
    const labelledBy = (el as Element & { ariaLabelledByElements?: Element[] }).ariaLabelledByElements;
    if (!n && labelledBy?.length) {
      n = labelledBy
        .filter((e) => !isExcludedDeep(e))
        .map((e) => readingOrderText(e)).join(' ').trim();
    }
    // dom-accessibility-api stops at the ARIA spec's step 2. The PLATFORM does
    // not: Chrome and Playwright both surface `textbox "What needs to be done?"`
    // for a placeholder-only input. Without these fallbacks TodoMVC's primary
    // control indexed as name:"" and no description could ever reach it.
    if (!n) n = fallbackName(el);
    /**
     * Resolving an invalid role is only half the repair.
     *
     * `dom-accessibility-api` reads the raw `role` attribute itself and cannot
     * be handed our resolved role, so `<button role="buton">Lodge claim</button>`
     * came back with role `button` (fixed) and name `""` (not fixed) — leaving a
     * real control indexed under no name at all, which is worse than a wrong
     * role because nothing can retrieve it. Verified: `locate_control` returned
     * zero candidates for that button and one for the identical button without
     * the typo.
     *
     * So when the library declines to name an element whose RESOLVED role takes
     * its name from content, we finish the job ourselves.
     */
    if (!n && NAME_FROM_CONTENT.has(roleOf(el))) {
      n = contentText(el).slice(0, NAME_FROM_CONTENT_CHARS);
    }
    n = n ? redact(n, el) : n;
    accNameCache.set(el, n);
    return n;
  }

  /**
   * A name for the region a control governs, for the control's index document.
   * Its own accessible name if it has one, else the first heading inside it —
   * a disclosure panel is very often titled by the heading it contains rather
   * than by an aria-label on the wrapper.
   */
  const governedName = (els: Element[]): string | null => {
    for (const e of els) {
      const n = name(e);
      if (n) return n;
      const h = e.querySelector?.('h1, h2, h3, h4, h5, h6, [role=heading]');
      const ht = h ? contentText(h) : '';
      if (ht) return redact(ht.slice(0, GOVERNED_HEADING_CHARS), h ?? e);
    }
    return null;
  };

  const isExcluded = (el: Element): boolean => excludedSelf(el, exclude);

  // TWO different questions, previously answered by one check.
  //
  // `visible` — is this text on screen? Strict, opacity included: text at
  // opacity 0 is text the user cannot read, and indexing it returns passages
  // the agent cannot see.
  const visible = (el: Element): boolean => {
    try {
      // `content-visibility:auto` is a rendering optimization, not authored
      // hiding. Its off-screen descendants remain part of find-in-page, focus
      // navigation, and the accessibility tree. Passing
      // `contentVisibilityAuto:true` here made Chromium's temporary display
      // lock look like `display:none`: a long page could omit every deferred
      // section until the user manually scrolled near it, so retrieval
      // confidently answered from the wrong corpus. The deterministic
      // content-auto sensor that reproduced this with both prose and a control
      // was deleted in the 2026-09-02 eval merge; the finding stands, the
      // reproduction must be rebuilt. Keep the default `false`; checkVisibility still
      // rejects `content-visibility:hidden` and elements with no box.
      return el.checkVisibility({
        opacityProperty: true, visibilityProperty: true,
      });
      // getClientRects, not offsetParent: offsetParent is null for
      // position:fixed elements (MDN), so the old fallback rejected exactly the
      // overlays and dialogs a visibility check most needs to accept.
    } catch { return el.getClientRects().length > 0; }
  };

  /**
   * Is this text merely PARKED at `opacity: 0`, rather than hidden?
   *
   * Scroll-reveal animations — Framer Motion, GSAP ScrollTrigger, AOS — rest
   * real content at opacity 0 in normal flow and raise it when it scrolls into
   * view. That text has a box, has `visibility: visible`, and sits in both
   * `innerText` and the accessibility tree, so Playwright's snapshot carries it
   * while this index does not.
   *
   * It still stays OUT of the index. The deleted opacity-gap sensor swept ten
   * commercial sites: indexing it buys 1,478 chars of real content at a cost of
   * 4,846 chars of genuinely hidden UI — dropdown panels, inactive carousel
   * slides — and NO index-time property separates the two. An opacity
   * transition is declared by 96.8% of the reveal text and 97.8% of the hidden
   * text; 98.8% and 97.3% respectively sit in normal flow. Only scrolling tells
   * them apart, and an index cannot scroll.
   *
   * So it is counted and DECLARED rather than silently dropped. Measured on
   * paypal.com/us/home: the page's own "Your payments are encrypted…" sentence
   * was missing from the index while `coverage` reported 100% inspected, and
   * `find_on_page('encrypted')` returned not_found for text the agent could see
   * in the tree. Convention 5 — an agent that is told can scroll or read the
   * page directly; an agent that is not told is misinformed.
   */
  const revealPending = (el: Element): boolean => {
    try {
      // Only reached for elements `visible()` already rejected, so this second
      // call is paid on hidden elements alone.
      if (!el.checkVisibility({ opacityProperty: false, visibilityProperty: true })) return false;
    } catch { return false; }
    const r = el.getBoundingClientRect?.();
    return !!r && r.width > 0 && r.height > 0;
  };

  // The scope of a heading is the container holding it and its sibling content.
  // Using the nearest SECTIONING ancestor was too broad: a heading inside a
  // plain <div> claimed all of <main>, so its path leaked onto later content.
  function scopeOf(el: Element): Node {
    // …but a heading is very often not a direct child of the container it
    // titles. `<div class="mw-heading"><h2>…</h2><span>[edit]</span></div>`
    // followed by sibling <p>s is Wikipedia's shape, and MediaWiki, BBC and
    // most CMS themes share it. Treating that wrapper as the scope meant the
    // following prose was never contained by it, so pruneTo() popped the
    // heading immediately: 100% of sampled chunks on Wikipedia, Hacker News and
    // BBC had an EMPTY heading path — the one thing this design claims over
    // Playwright's (role, name) key.
    //
    // A wrapper is an element that holds the heading and nothing else of
    // substance: no block-level siblings, no own text.
    let n = el;
    for (let i = 0; i < cfg.maxWrapperClimb; i++) {
      const p = n.parentElement;
      if (!p || p === root || SCOPE_BOUNDARY.has(p.tagName)) break;
      if (!isHeadingWrapper(p, n)) break;
      n = p;
    }
    // A heading can be a direct child of a ShadowRoot. Falling back to the
    // outer indexed root crosses trees and makes the heading disappear as soon
    // as the next shadow child is visited; its own root is the real scope.
    return n.parentElement ?? n.getRootNode();
  }

  /**
   * Heading nesting from document order + DOM containment. Level numbers are
   * used only for RELATIVE ordering inside one shared scope, never as absolute
   * depth — 41.8% of real pages skip levels, so h1→h3 must yield a 2-deep path.
   */
  function pushHeading(el: Element, text: string, level: number): void {
    const scope = scopeOf(el);
    const elRoot = el.getRootNode();
    while (headingStack.length) {
      const top = headingStack[headingStack.length - 1];
      if (top.root !== elRoot) break;               // outer tree — keep as ancestor path
      if (!top.scope.contains(el)) { headingStack.pop(); continue; }
      if (top.scope === scope && top.level >= level) { headingStack.pop(); continue; }
      break;
    }
    headingStack.push({ scope, level, text, root: el.getRootNode() });
  }
  /**
   * Prune the stack to entries whose scope actually contains this element.
   * Without this, content that appears before any heading in a new container
   * inherits a stale path from unrelated earlier sections — which pollutes both
   * the retrieval context and every address minted there.
   */
  function pruneTo(el: Element): void {
    // Containment must be evaluated WITHIN THE SAME TREE. Node.contains() does
    // not pierce shadow boundaries, so a light-DOM scope never "contains" a
    // shadow node — which previously popped the entire stack on entering any
    // open shadow root, then leaked the shadow heading out to later siblings.
    const elRoot = el.getRootNode();
    while (headingStack.length) {
      const top = headingStack[headingStack.length - 1];
      if (top.root === elRoot && top.scope.contains(el)) break;
      if (top.root !== elRoot) break;   // different tree: leave the outer path intact
      headingStack.pop();
    }
  }
  const headingPath = () => [...headingPrefix, ...headingStack.map((h) => h.text)];

  // Row context. A list row's own text is the only thing that distinguishes its
  // controls from the identical controls in every other row, and the heading
  // path does not descend that far. Without it "toggle renew passport" — the
  // single most common real agent instruction on a list UI — has no answer,
  // because the checkbox is named "Toggle Todo" three times over.
  const rowStack: Element[] = [];
  const rowTextCache = new WeakMap<Element, string | null>();
  function rowTextOf(el: Element): string | null {
    if (rowTextCache.has(el)) return rowTextCache.get(el) ?? null;
    let t: string | null = null;
    // Never mint row text out of a subtree we promised not to index.
    const dirty = el.querySelector?.('[data-naviquest-ignore],[aria-hidden="true"]')
      || exclude.some((sel) => { try { return !!el.querySelector(sel); } catch { return false; } });
    if (!dirty) {
      const full = readingOrderText(el);
      // A row is only useful as identity if it is row-sized. Hacker News wraps
      // its whole header in one <td>, so truncating to 80 chars gave every
      // header control the row "Hacker Newsnew | pas" — noise in the index and
      // a misleading label in the response. Too long to be identity → no row.
      t = full && full.length <= cfg.maxRowChars ? redact(full, el) : null;
    }
    rowTextCache.set(el, t);
    return t;
  }

  /** One reader for a parsed JSON-LD block, whether the walk found it or the
   *  head sweep did. */
  const jsonLdSeen = new Set<Element>();
  function readStructured(el: Element, data: unknown, landmark: string | null,
                          landmarkName: string | null, path: string[]): void {
    jsonLdSeen.add(el);
    if (discovery.structuredQA && qa.length < discovery.maxQAPairs) {
      const extracted = extractQA(data, {
        maxPairs: discovery.maxQAPairs - qa.length,
        maxAnswerChars: discovery.maxQAAnswerChars,
      });
      // JSON-LD scripts are not walked as visible text, so the structured Q&A
      // lane must apply the same host redactor explicitly. Without this, a
      // secret removed from projected chunks could still be returned verbatim
      // by find_on_page's answer path—and then become Summarizer input.
      qa.push(...extracted.map((pair) => ({
        ...pair,
        question: redact(pair.question, el),
        answer: redact(pair.answer, el),
      })).filter((pair) => pair.question && pair.answer));
    }
    const text = structuredText(data, discovery);
    if (!text) return;
    nodes.push({
      el, primary: isPrimary(el), role: 'definition', landmark, landmarkName, name: null,
      text: redact(text, el), headingPath: path,
      row: null, states: {}, interactive: false, inert: false,
      visible: true, actionable: false, isHeading: false,
    });
  }

  /**
   * The work stack. Seeded with the root; `extraRoots` feeds it again later, and
   * `pump` always drains it before asking for another post-walk unit — which is
   * what keeps a registered root walked to completion before the next one starts.
   */
  const stack: Frame[] = [{ el: root, landmark: null, landmarkName: null }];

  /** One frame: an element visited, or a row scope closed. */
  function step(frame: Frame): void {
    if (frame.el === null) { rowStack.pop(); return; }
    const el = frame.el;
    // Reassigned below for a landmark element and inherited by its children,
    // exactly as the recursive parameters were.
    let landmark = frame.landmark;
    let landmarkName = frame.landmarkName;
    if (frame.slottedText != null) {
      const text = frame.slottedText.replace(/\s+/g, ' ').trim();
      if (text) {
        const owner = frame.textOwner ?? el;
        nodes.push({
          el: owner, primary: isPrimary(owner), role: 'generic', landmark, landmarkName, name: null,
          text: redact(text, el), headingPath: headingPath(), row: null,
          states: {}, interactive: false, inert: false,
          visible: visible(owner), actionable: false, isHeading: false,
        });
      }
      return;
    }
    // An open root that a component also registered, or an overlapping plain
    // Element region, must not project the same subtree twice. Identity is local
    // to this pass and therefore cannot become stale across reindex.
    if (visitedElements.has(el)) return;
    visitedElements.add(el);
    if (SKIP_TAGS.has(el.localName.toLowerCase())) {
      // …with one exception. A JSON-LD block is a <script>, so the tag skip is
      // exactly what has always hidden it. It is read here, in document order,
      // so it lands under the heading path of the section that contains it.
      if (discovery.structuredData && el.localName === 'script'
        && (el.getAttribute('type') || '').toLowerCase() === 'application/ld+json'
        && !isExcludedDeep(el)) {
        // Parsed ONCE, here, and handed to both consumers. `structuredText`
        // used to parse internally and swallow the error, which meant a second
        // reader of the same block would have to parse it again.
        let data: unknown;
        // Unparseable JSON-LD means the page DECLARES facts this index does not
        // hold. Counted so `coverage` can say so.
        try { data = JSON.parse(el.textContent || ''); }
        catch { coverage.malformedStructuredData++; return; }
        pruneTo(el);
        readStructured(el, data, landmark, landmarkName, headingPath());
      }
      return;
    }

    // Before the slot branch, not after it: the slot branch returns without ever
    // reaching a later check, so `<slot aria-hidden="true">` (or a host-excluded
    // slot) projected all of its assigned content — an exclusion the walk
    // promised and then skipped past.
    if (isExcluded(el)) { coverage.excluded++; return; }

    // A <slot> renders its assigned nodes. Handle it here, not only as a child
    // of the element being walked: `<style>…</style><slot></slot>` as the direct
    // children of a shadow root is the commonest web-component shape there is,
    // and walking the slot as an ordinary element visited its FALLBACK content
    // while the host's real light children were skipped via assignedSlot —
    // dropping 100% of the component's content, silently.
    if (el.localName === 'slot') {
      const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true })
        .filter((n) => n.nodeType === 1 || (n.nodeType === 3 && !!(n.nodeValue || '').trim()));
      if (assigned.length) {
        // Reversed: a stack pops last-in-first-out, and assigned order IS the
        // rendered order the index has to reproduce.
        for (let i = assigned.length - 1; i >= 0; i--) {
          const n = assigned[i];
          stack.push(n.nodeType === 1
            ? { el: n as Element, landmark, landmarkName }
            : { el, landmark, landmarkName, slottedText: n.nodeValue || '',
                textOwner: n.parentElement ?? undefined });
        }
        return;
      }
      // Reached only for a slot with neither assigned nodes NOR fallback:
      // `assignedNodes({flatten: true})` already returns the fallback content
      // when nothing is assigned (MDN), so the branch above handles both.
    }

    const isCustom = el.tagName.includes('-');
    if (isCustom) {
      coverage.customElements++;
      // `el.shadowRoot` is null for a CLOSED root and for no root at all, and
      // page JavaScript cannot tell those apart. Only the certain half is
      // reported: a custom host exposing no open root and not registered.
      if (!el.shadowRoot && !registeredHosts.has(el)) coverage.unknownRoots++;
    }

    pruneTo(el);
    const role = roleOf(el);
    if (role === 'table' || role === 'grid' || role === 'treegrid') {
      const rawRowCount = el.getAttribute('aria-rowcount')?.trim();
      if (rawRowCount && /^-?\d+$/.test(rawRowCount)) {
        const total = Number(rawRowCount);
        if (total === -1 || total > 0) declaredRowCollections.push({ el, total });
      }
    }
    const rawSetSize = el.getAttribute('aria-setsize')?.trim();
    if (rawSetSize && /^-?\d+$/.test(rawSetSize)) {
      const total = Number(rawSetSize);
      const parent = flatParentElement(el);
      if (parent && (total === -1 || total > 0)) {
        // `aria-setsize` is item-level. Group siblings by their rendered parent,
        // resolved role, and tree level; otherwise nested tree items would be
        // compared with the wrong set. This is authored platform semantics—not
        // a class-name, framework, or scroll-geometry guess.
        const level = el.getAttribute('aria-level') ?? '';
        const key = `${role}\u0000${level}`;
        let byKey = setGroupsByParent.get(parent);
        if (!byKey) { byKey = new Map(); setGroupsByParent.set(parent, byKey); }
        let group = byKey.get(key);
        if (!group) {
          group = { parent, role, level, total, items: [] };
          byKey.set(key, group);
          declaredSetGroups.push(group);
        }
        group.items.push(el);
        if (group.total !== -1) group.total = total === -1 ? -1 : Math.max(group.total, total);
      }
    }
    // A landmark ROLE is not an identity: a page with eight <section>s has eight
    // landmarks all called "region". Without the accessible name, matching on
    // landmark bounds nothing, and an address can relax across section
    // boundaries onto an identically-named control elsewhere.
    if (LANDMARKS.has(role)) { landmark = role; landmarkName = name(el) || null; }
    // Saved ONLY for elements that can become a registered-root boundary this
    // pass — it is read exclusively in PHASE_ROOTS. Unconditional set was one
    // object allocation and a WeakMap write per element on the hot path.
    if (contextBoundaries.has(el)) {
      hostContext.set(el, { headingPath: headingPath(), landmark, landmarkName });
    }

    const own = ownText(el);
    // Inlined rather than `contentText(el)`: on an element with block children
    // the two are the same string, and calling both walked every such element
    // twice on the hot path. The fold takes the exclusion predicate: without it,
    // text inside an excluded PHRASING descendant (`<p>… <span data-private>`)
    // was folded into its parent's indexed text — the walk never descends into
    // the span, but the TreeWalker did.
    const content = hasNonPhrasingChild(el) ? own : readingOrderText(el, isExcluded);

    /**
     * The ElementInternals blind spot, counted rather than merely regretted.
     *
     * A component that does the RIGHT thing — semantics via `attachInternals()`
     * instead of ARIA attributes — is invisible from outside. Verified in
     * Chromium: with `internals.role = 'switch'` and `internals.ariaLabel` set,
     * `el.role` is null, no attribute is mirrored, and `computeAccessibleName`
     * returns nothing. There is no computed-role API to fall back on.
     *
     * Measured across live sites: 217 such
     * elements on 3 of 8 sites — 180 of YouTube's 224 components, and 17 of 17
     * on nytimes.com. That is most of the interactive furniture on a
     * component-heavy page, and until now nothing said so.
     *
     * `:state()` probing was tried as a recovery and rejected on evidence:
     * `el.matches(':state(checked)')` genuinely reads custom state from outside,
     * but probing eleven common names across 302 live components matched zero.
     * So this is a DECLARATION, not a repair — the same contract as closed
     * shadow roots, which an agent already knows how to reason about.
     */
    if (isCustom && role === 'generic' && !own && !name(el)) {
      // A host with an open root full of ordinary controls is a wrapper, not an
      // opaque control. Only the HOST's own focusability is evidence that
      // ElementInternals may carry inaccessible semantics; descendant buttons
      // are already walked and must not make their wrapper "probably a control".
      const ti = el.getAttribute('tabindex');
      if (ti !== null && Number(ti) >= 0) {
        coverage.opaqueComponents++;
        coverage.opaqueInteractive++;
      }
    }

    // Content inside a closed <details> is one click from the reader, so an
    // agent that cannot see it reports the page does not answer a question the
    // page does answer. Indexed, and flagged, so the answer can say "expand this
    // first" instead of guessing.
    const collapsedBy = discovery.collapsedContent
      ? el.closest('details:not([open])') as HTMLElement | null : null;
    const isVisible = visible(el) || !!collapsedBy;
    if (!isVisible) {
      // Count the topmost CONTENT-BEARING parked element per chain, once.
      //
      // Counting every parked element reported paypal.com as 107 passages and
      // ~2,854 chars, because a reveal wrapper and each parked descendant all
      // qualify while the wrapper's reading-order text already contains theirs.
      // Suppressing on "parent is parked" then reported zero: the outermost
      // parked node is usually a bare wrapper whose OWN text is empty, so the
      // only elements carrying text are precisely the ones it suppressed.
      // Walking to the nearest already-counted parked ancestor is what actually
      // deduplicates the TEXT. Parked is `!visible && revealPending` — the
      // second half alone is true of visible elements too.
      if (content && revealPending(el)) {
        let anc = flatParentElement(el);
        let covered = false;
        while (anc && !visible(anc) && revealPending(anc)) {
          if (countedParked.has(anc)) { covered = true; break; }
          anc = flatParentElement(anc);
        }
        if (!covered) {
          countedParked.add(el);
          coverage.revealPending++;
          coverage.revealPendingChars += content.length;
        }
      }
    }
    // A hidden heading must not rewrite the path of later visible content. The
    // previous order pushed it before visibility was known, so an off-screen
    // marketing heading silently became retrieval context and address identity.
    // Closed <details> is the intentional exception: its content is indexed as
    // collapsed and carries the discloser needed to make it actionable.
    if (isVisible && role === 'heading' && content) {
      pushHeading(el, redact(content, el), headingLevel(el));
    } else if (isVisible && content && !navChrome.has(landmark ?? '')
      && looksLikeHeading(el, cfg, content) && !/^H[1-6]$/.test(el.tagName)) {
      coverage.inferredHeadings++;
      pushHeading(el, redact(content, el), 3);
    }
    const isRow = rowRoles.has(role);
    if (isRow) rowStack.push(el);
    const row = rowStack.length ? rowTextOf(rowStack[rowStack.length - 1]) : null;

    // Non-text content: recover author text, or record an addressable hole.
    if (isNonText(el)) {
      coverage.nonText++;
      const d = describeNonText(el, name(el), nonTextPolicy, (t) => !isExcludedDeep(t));
      if (d.kind === 'DECORATIVE') { coverage.nonTextDecorative++; }
      else if (d.kind === 'TEXT') {
        coverage.nonTextRecovered++;
        nodes.push({
          el, primary: isPrimary(el), role, landmark, landmarkName, name: null, text: redact(d.text, el),
          headingPath: headingPath(), row, states: {}, interactive: false, inert: false,
          visible: isVisible, actionable: false, isHeading: false,
          nonText: { source: d.source, confidence: d.confidence, chartLibrary: d.chartLibrary ?? null },
        });
        // The recovered text may BE this element's own text (a <canvas>'s
        // fallback content, an <svg>'s <title>). Pushing it again below would
        // double its term frequency and skew BM25.
        nonTextHandled.add(el);
      } else {
        coverage.nonTextOpaque++;
        // The host redactor applies to every string that leaves, the same as the
        // TEXT branch above. `src` and rejected candidate text are page-authored
        // strings (a URL can carry a token; rejected alt text can carry PII).
        const hp = headingPath();
        opaque.push({
          ...d,
          ...(d.src ? { src: redact(d.src, el) } : {}),
          ...(d.filenameHint ? { filenameHint: redact(d.filenameHint, el) } : {}),
          rejectedCandidates: d.rejectedCandidates.map((c) => ({ ...c, text: redact(c.text, el) })),
          landmark, landmarkName, headingPath: hp, nearestHeading: hp.at(-1) ?? null,
        });
      }
    }

    const interactive = INTERACTIVE.has(role);
    const foldPhrasing = !interactive && role !== 'heading' && PHRASING_TAGS.has(el.tagName)
      && !!el.parentElement && !hasNonPhrasingChild(el.parentElement);
    if (!foldPhrasing && (interactive || content) && !nonTextHandled.has(el)) {
      // Affordances now arrive with provenance. The wire shape stays a flat
      // array of ids — that is what agents and the check suite consume — and the
      // signal each one was read from travels beside it, so an agent can weigh
      // `rel="next"` above a regex that matched the word "next".
      // IDREF relationships cross subtree boundaries. Resolve them, but apply
      // the same deep exclusion contract as the projection before reading a
      // governed name; otherwise aria-controls can exfiltrate a private panel's
      // heading through an otherwise public button.
      const governed = interactive
        ? controlledElements(el).filter((target) => !isExcludedDeep(target))
        : [];
      const hits = interactive
        ? affordancesOf(el, { role, name: name(el), landmark, docLang, primaryInputEl, patterns,
            controlled: governed })
        : [];
      nodes.push({
        el, primary: isPrimary(el), role, landmark, landmarkName,
        name: interactive ? name(el) : null,
        text: redact(content, el),
        headingPath: headingPath(),
        row,
        states: interactive ? statesOf(el) : {},
        affordances: hits.map((h) => h.id),
        ...(hits.length ? { affordanceVia: Object.fromEntries(hits.map((h) => [h.id, h.via])) } : {}),
        ...(governed.length ? { controlsName: governedName(governed) } : {}),
        ...(governed.length ? { relations: governed.map((target) => ({
          type: 'controls' as const,
          source: el.hasAttribute('popovertarget') ? 'popovertarget'
            : el.hasAttribute('commandfor') ? 'commandfor' : 'aria-controls',
          target,
          name: governedName([target]),
        })) } : {}),
        interactive,
        // With several open dialogs and no focused descendant, the platform
        // exposes no top-layer ordering API. Mark controls conservatively inert
        // and let describe_app report ambiguity rather than choosing by DOM order.
        inert: interactive ? (modality.ambiguous || isInertUnder(el, modal)) : false,
        visible: isVisible,
        actionable: interactive ? isActionableElement(el) : false,
        // Visible headings only: the walk already refuses to push a hidden
        // heading onto the path (above), but the flag leaked through, so
        // buildStructure minted outline entries labelled with the PARENT's text.
        isHeading: role === 'heading' && isVisible,
      });
      const last = nodes[nodes.length - 1];
      if (collapsedBy) last.collapsed = true;
      // `aria-description` is authored prose that lives in no text node. The
      // IDREF form (`aria-describedby`) is already consumed for non-text
      // content; this is the string form, and nothing was reading it.
      if (discovery.ariaDescription) {
        const desc = el.getAttribute('aria-description')?.trim();
        if (desc) {
          last.text = last.text ? `${last.text} ${redact(desc, el)}` : redact(desc, el);
        }
      }
      // An unreadable control is only a HOLE if the agent could otherwise have
      // used it. Counting controls in collapsed menus and closed dialogs put
      // Wikipedia's figure at 231 against axe-core's 32 real link-name
      // violations, and told the agent to screenshot 241 regions.
      if (last.actionable && isUnlabelledControl(last, nonTextPolicy)) {
        coverage.unlabelledControls++;
        const hp = headingPath();
        opaque.push({
          el, kind: 'OPAQUE', tag: el.tagName.toLowerCase(), role, src: null, filenameHint: null,
          chartLibrary: null, landmark, landmarkName, headingPath: hp,
          nearestHeading: hp.at(-1) ?? null,
          box: boxOf(el),
          // Same wire field, same cap as nontext.ts's rejected chart candidates:
          // `rejectedCandidates[].text` had two producers and only one of them
          // read the tunable, so a host lowering it moved half the responses.
          rejectedCandidates: last.name || last.text
            ? [{ text: (last.name || last.text).slice(0, nonTextPolicy.cfg.rejectedTextChars),
                 reason: 'NAME_NOT_USABLE' }] : [],
          reason: 'UNLABELLED_CONTROL',
        });
      }
    }

    // SUCCESSORS, pushed in the REVERSE of the order they must be visited,
    // because a stack pops last-in-first-out and node order is not cosmetic:
    // `ordinal`/`peerCount` are assigned by position below, and every address
    // minted from this pass carries them.
    //
    // Sentinel first, so the row closes only after the last descendant inside
    // it. Then the light children, then the shadow children — the recursion
    // descended into the shadow root BEFORE the host's own children, and a
    // shadow-DOM heading arriving after its light siblings would change the
    // heading path of everything that follows.
    if (isRow) stack.push(ROW_EXIT);
    const kids = el.children;
    for (let i = kids.length - 1; i >= 0; i--) {
      const c = kids[i];
      // Rendered at its slot position instead — visiting here would duplicate it.
      if (c.assignedSlot) continue;
      stack.push({ el: c, landmark, landmarkName });
    }
    if (el.shadowRoot) {
      rememberShadowRoot(el.shadowRoot);
      const shadowKids = el.shadowRoot.children;
      for (let i = shadowKids.length - 1; i >= 0; i--) {
        stack.push({ el: shadowKids[i], landmark, landmarkName });
      }
    }
  }

  // Ordinals are computed ONCE, in the phase machine below, and stored on the
  // node. Computing them later from a filter over projection.nodes was both
  // O(n) per call and — for
  // `controls`, which holds spread COPIES — silently broken: indexOf() on a
  // copy returns -1, so every address locate_control produced carried ordinal 0
  // and three identical buttons all resolved to the first one.
  const peerKey = (n: ProjectedNode) => `${n.role}\u0000${n.name ?? ''}\u0000${n.landmark ?? ''}\u0000${n.landmarkName ?? ''}\u0000${n.headingPath.join('\u0001')}\u0000${n.row ?? ''}`;

  /**
   * The post-walk work, as resumable units.
   *
   * Each of these passes is O(n) over the whole page and each will breach the
   * 50 ms guardrail on its own at scale, so none of them may run as one
   * indivisible block: a walk sliced to 8 ms followed by a single 60 ms ordinal
   * pass has fixed nothing. A phase number and one cursor are the entire resume
   * state, deliberately — the less state a slice boundary carries, the fewer
   * ways it can be crossed wrongly.
   */
  const PHASE_WALK = 0, PHASE_JSONLD = 1, PHASE_ROOTS = 2, PHASE_GROUP = 3, PHASE_ORDINALS = 4;
  let phase = PHASE_WALK;
  let cursor = 0;
  let ldScripts: Element[] = [];
  const peers = new Map<string, ProjectedNode[]>();
  let peerGroups = peers.values();

  /** One unit of post-walk work. False once the whole pass is finished. */
  function unit(): boolean {
    switch (phase) {
      case PHASE_WALK:
        /**
         * Structured data lives in `<head>`; the walk starts at `<main>`.
         *
         * MEASURED on the pages this was meant to help: CNN carries 1 JSON-LD
         * block, the New York Times 2, AliExpress 1 — and **every one of them in
         * `<head>`**, which a walk rooted at the content never reaches. The
         * feature passed its fixture only because the fixture put the script in
         * the body, which is not where the web puts it.
         */
        ldScripts = discovery.structuredData && opts.includeDocumentMetadata
          ? [...ownerDocument.querySelectorAll('script[type="application/ld+json"]')] : [];
        phase = PHASE_JSONLD; cursor = 0;
        return true;
      case PHASE_JSONLD: {
        // One block per unit. Parsing a product feed's JSON is the expensive
        // half here and it does not divide below a single block.
        if (cursor < ldScripts.length) {
          const el = ldScripts[cursor++];
          if (jsonLdSeen.has(el) || isExcludedDeep(el)) return true;
          let data: unknown;
          try { data = JSON.parse(el.textContent || ''); }
          catch { coverage.malformedStructuredData++; return true; }
          // Page-level facts, so they take an empty heading path rather than
          // inheriting whichever section happened to be open when the sweep ran.
          readStructured(el, data, null, null, []);
          return true;
        }
        phase = PHASE_ROOTS; cursor = 0;
        return true;
      }
      case PHASE_ROOTS:
        // One registered root per unit — and because `pump` drains the walk
        // stack before asking for another unit, each is walked to completion
        // before the next is counted, exactly as the nested loop did.
        if (cursor < extraRoots.length) {
          const r = extraRoots[cursor++];
          const boundary = isQueryableShadowRoot(r) ? r.host : r;
          if (excludedDeep(boundary, exclude)) {
            coverage.excluded++;
            return true;
          }
          const context = hostContext.get(boundary);
          headingStack.length = 0;
          headingPrefix = context?.headingPath ?? [];
          if (!isQueryableShadowRoot(r)) {
            stack.push({ el: r, landmark: context?.landmark ?? null,
              landmarkName: context?.landmarkName ?? null });
            return true;
          }
          const rootKids = r.children ?? [];
          for (let i = rootKids.length - 1; i >= 0; i--) {
            stack.push({ el: rootKids[i], landmark: context?.landmark ?? null,
              landmarkName: context?.landmarkName ?? null });
          }
          return true;
        }
        phase = PHASE_GROUP; cursor = 0;
        return true;
      case PHASE_GROUP: {
        // Grouping built incrementally rather than by `Map.groupBy` over a
        // filtered copy: same keys, same first-seen key order, same order within
        // a group — and resumable at any node, which `Map.groupBy` is not.
        const end = Math.min(cursor + SLICE_BATCH, nodes.length);
        for (; cursor < end; cursor++) {
          const n = nodes[cursor];
          if (!n.interactive && !n.text) continue;
          const k = peerKey(n);
          const g = peers.get(k);
          if (g) g.push(n); else peers.set(k, [n]);
        }
        if (cursor >= nodes.length) { phase = PHASE_ORDINALS; peerGroups = peers.values(); }
        return true;
      }
      case PHASE_ORDINALS:
        for (let b = 0; b < SLICE_BATCH; b++) {
          const next = peerGroups.next();
          if (next.done) return false;
          const group = next.value;
          for (let i = 0; i < group.length; i++) { group[i].ordinal = i; group[i].peerCount = group.length; }
        }
        return true;
    }
    return false;   // unreachable: every phase either advances or ends the pass
  }

  /**
   * Runs work units until the slice is spent or nothing is left. Returns true
   * when the pass is complete — the one thing the two drivers disagree about.
   *
   * The walk stack is drained before any post-walk unit, which is what lets
   * `PHASE_ROOTS` push frames back onto it and have them walked in place.
   */
  function pump(sliceOver: () => boolean): boolean {
    for (;;) {
      if (stack.length) step(stack.pop()!);
      else if (!unit()) return true;
      if (sliceOver()) return false;
    }
  }

  function finish(): Projection {
    const collectionElements = new Set(declaredRowCollections.map((c) => c.el));
    for (const collection of declaredRowCollections) {
      // Count only rows owned by this collection, not rows belonging to a nested
      // grid/table with its own declared total. Querying `[role=row]` alone would
      // miss native `<tr>`; roleOf is the one shared HTML+ARIA authority.
      const renderedRows = [...collection.el.querySelectorAll('tr,[role]')]
        .filter((candidate) => {
          // This count answers only whether the row exists in the DOM. Host
          // exclusion is a separate access policy; treating excluded-but-
          // present rows as off-DOM would create a false virtualization claim.
          if (roleOf(candidate) !== 'row') return false;
          for (let p = flatParentElement(candidate); p && p !== collection.el; p = flatParentElement(p)) {
            if (collectionElements.has(p)) return false;
          }
          return true;
        }).length;
      if (collection.total === -1) {
        coverage.virtualizedCollections++;
        coverage.unknownSizeCollections++;
      } else if (collection.total > renderedRows) {
        coverage.virtualizedCollections++;
        coverage.offDomRowsDeclared += collection.total - renderedRows;
      }
    }
    for (const group of declaredSetGroups) {
      // This is a DOM-presence count, not an indexing-policy count. An item the
      // host deliberately excludes is still rendered; subtracting it from the
      // declared total would turn privacy policy into a false virtualization
      // warning. Re-query the flat parent at finish so excluded light children
      // and direct open-shadow children both count without making them
      // retrievable. `aria-setsize` belongs on every member of a partial set,
      // so it is also the narrowest selector that cannot pull unrelated peers
      // into the group.
      const present = new Set<Element>();
      for (const tree of queryRoots(group.parent)) {
        for (const candidate of tree.querySelectorAll('[aria-setsize]')) {
          if (flatParentElement(candidate) !== group.parent) continue;
          if (roleOf(candidate) !== group.role) continue;
          if ((candidate.getAttribute('aria-level') ?? '') !== group.level) continue;
          present.add(candidate);
        }
      }
      const renderedItems = present.size;
      if (group.total === -1) {
        coverage.virtualizedCollections++;
        coverage.unknownSizeCollections++;
      } else if (group.total > renderedItems) {
        coverage.virtualizedCollections++;
        coverage.offDomItemsDeclared += group.total - renderedItems;
      }
    }
    // `closedRoots`/`unreachableRoots`/`componentsInspectedPct` are gone: page
    // JavaScript cannot detect a closed root it was not handed, so the first was
    // permanently 0 and the derived pair were constants (0, 100) presented to
    // agents as measurements. `unknownRoots` above is the honest signal.
    coverage.rootElements = root.querySelectorAll('*').length + 1;
    // Coverage describes the rendered page surface. Counting <html>, <head>,
    // <title>, metadata, preload links, and scripts in the denominator made a
    // complete <body> projection report less than 100%, which falsely told the
    // agent to broaden after it had already inspected every rendered light-DOM
    // element. JSON-LD in <head> has its own explicit sweep and counter.
    const documentSurface = ownerDocument.body ?? ownerDocument.documentElement;
    coverage.documentElements = documentSurface
      ? documentSurface.querySelectorAll('*').length + 1
      : coverage.rootElements;
    coverage.elementsInspectedPct = Math.min(100,
      Math.round((coverage.rootElements / Math.max(1, coverage.documentElements)) * 100));
    // flatContains, like every other containment check in finish(): an iframe
    // inside an open shadow root under `root` is NOT outside it.
    coverage.framesOutsideRoot = [...ownerDocument.querySelectorAll('iframe')]
      .filter((f) => !flatContains(root, f)).length;
    // Frame documents are separate browsing contexts. Exact inspection can
    // enumerate readable ones, but parent addresses carry no frame identity, so
    // silently folding their descendants into this projection would mint
    // unresolvable addresses. Count the boundary instead of claiming the page
    // is semantically complete.
    const belongsToIndexedContext = (boundary: Element): boolean => {
      if (flatContains(root, boundary)) return true;
      let owner = boundary.ownerDocument;
      while (owner && owner !== ownerDocument) {
        let frame: Element | null = null;
        try { frame = owner.defaultView?.frameElement ?? null; } catch { return false; }
        if (!frame) return false;
        if (flatContains(root, frame)) return true;
        owner = frame.ownerDocument;
      }
      return false;
    };
    coverage.unindexedFrameDocuments = queryScopes(ownerDocument, {
      extra: shadowRoots, frames: true,
      enter: (boundary) => belongsToIndexedContext(boundary) && !excludedDeep(boundary, exclude),
    }).scopes.filter((s) => s.kind === 'document' && s.root !== ownerDocument
      && !!s.frame && flatContains(root, s.frame)).length;
    // A zero-area box is not a vision fallback. Five of 13 opaque AliExpress
    // results had no width or height in the 2026-09-01 live sensor, so the tool
    // invited an agent to take screenshots that cannot exist. Keep those holes
    // in the coverage total, but do not present them as capturable targets; the
    // separate count preserves the distinction between "unreadable" and
    // "unreadable, and page JavaScript cannot even locate it visually".
    const locatedOpaque = opaque.filter((o) => o.box.w > 0 && o.box.h > 0);
    // Rank by viewport prominence, but retain the complete population. The tool
    // used to cap this array at 25 before pagination ever saw it, making
    // `opaqueTotal` truthful but the omitted boxes impossible to recover. The
    // wire now pages this population, so an in-memory cap would only recreate
    // silent truncation one layer earlier.
    return { nodes, qa, coverage, shadowRoots, frameRoots: [],
             // Pagination population/order is fixed by the projection. The
             // answer path refreshes coordinates but never re-filters or
             // re-sorts on geometry-only changes, which would let an unchanged
             // semantic revision silently skip or duplicate a continuation.
             opaque: locatedOpaque.toSorted((a, b) => (b.box.w * b.box.h) - (a.box.w * a.box.h)),
             opaqueWithoutGeometry: opaque.length - locatedOpaque.length,
             opaqueTotal: opaque.length };
  }

  return { sliceMs: cfg.sliceMs, pump, finish };
}

/**
 * Human-readable strings out of a schema.org JSON-LD block.
 *
 * Pages routinely carry FAQ answers, opening hours, product specifications and
 * event dates in `<script type="application/ld+json">` and NOWHERE ELSE in the
 * document. A walk over rendered text cannot see any of it, and an agent asked
 * "is the permit refundable?" does not care which node the answer lives in.
 *
 * Only prose values are taken. Keys, `@`-keywords, URLs and identifiers are
 * skipped, because indexing `"@type": "Product"` matches every query about
 * products and indexing a URL matches nothing anyone would type.
 */
function structuredText(data: unknown, cfg: DiscoveryTuning): string {
  const skip = new Set(cfg.structuredDataSkipKeys);
  const out: string[] = [];
  const seen = new Set<unknown>();
  // Running total, not `out.join()` per visited string — the join made the cap
  // check quadratic in the number of strings in a large product feed.
  let outChars = 0;
  const visit = (v: unknown, key: string) => {
    if (outChars > cfg.maxStructuredDataChars) return;
    if (typeof v === 'string') {
      // JSON-LD string values are routinely HTML — schema.org's own FAQPage
      // examples put `<p>` inside `acceptedAnswer.text`. Indexing the markup put
      // literal "<p>" in the content index and, worse, surfaced it inside an
      // answer span. Cleaned with the SAME function the Q&A extractor uses, so
      // the two cannot disagree about what a JSON-LD string means.
      const t = clean(v);
      // A value that is a URL, a bare number or a date is metadata, not prose.
      if (!t || skip.has(key) || /^(https?:|\/|#|mailto:|tel:)/i.test(t)) return;
      if (/^[\d\s:+\-TZ.]+$/.test(t)) return;
      out.push(t);
      outChars += t.length + 1;
      return;
    }
    if (typeof v !== 'object' || v === null || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const x of v) visit(x, key); return; }
    for (const [k, x] of Object.entries(v)) { if (!skip.has(k)) visit(x, k); }
  };
  visit(data, '');
  return [...new Set(out)].join('. ').slice(0, cfg.maxStructuredDataChars);
}

/**
 * Is this element rendered inline?
 *
 * Asked of the PLATFORM, not of a tag list. The list this replaced —
 * `SPAN, A, BUTTON, SUP, SUB, …` — was a snapshot of which HTML elements
 * default to inline, and every one of those defaults is a CSS declaration away
 * from being wrong. `<div style="display:inline">` is inline and the list said
 * otherwise; `<span style="display:block">` is a block and the list said the
 * opposite. `display` is the actual question, the browser has already computed
 * it, and it costs one style read on a path bounded by `maxWrapperClimb`.
 *
 * `contents` counts as inline: the box is not generated at all, so it cannot be
 * the block-level sibling that disqualifies a heading wrapper.
 */
function isInline(el: Element): boolean {
  try {
    const d = getComputedStyle(el).display;
    return d.startsWith('inline') || d === 'contents';
  } catch { return false; }
}

/**
 * Is `parent` merely a box drawn around `heading`? True when it contributes no
 * own text and no block-level content of its own — the [edit] link and screen
 * -reader spans that CMSs put next to a heading do not disqualify it.
 */
function isHeadingWrapper(parent: Element, heading: Element): boolean {
  for (const c of parent.children) {
    if (c === heading) continue;
    if (!isInline(c)) return false;
  }
  for (const t of parent.childNodes) {
    if (t.nodeType === 3 && (t.nodeValue || '').trim()) return false;
  }
  return true;
}

/**
 * Accessible-name fallbacks that dom-accessibility-api does not implement but
 * the platform does. Ordered by how much the author meant them as a label.
 *
 * Strictly a LAST resort. Caught by the historical axe-core oracle recorded in
 * docs/EVAL.md: an element with text content that computes to an
 * empty name is not unnamed, it is HIDDEN — dom-accessibility-api correctly
 * returns '' for it, and so does axe. Applying `title` there invented names for
 * 150+ collapsed sidebar links on Wikipedia and dropped name agreement with axe
 * to 19%. `title` may only speak when nothing else does.
 */
function fallbackName(el: Element): string {
  if ((el.textContent || '').trim()) return '';
  const attr = (k: string) => (el.getAttribute?.(k) || '').trim();
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    const type = ((el as HTMLInputElement).type || '').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'reset') {
      const v = ((el as HTMLInputElement).value || '').trim();
      if (v) return v;
    }
    const ph = attr('placeholder') || attr('aria-placeholder');
    if (ph) return ph;
  }
  return attr('title') || attr('aria-roledescription') || '';
}
