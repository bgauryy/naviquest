/**
 * The domain model, in one place.
 *
 * These types were not added to satisfy a compiler. They exist because three of
 * this SDK's hardest-won invariants are shape invariants, and every one of them
 * was a real bug first:
 *
 *   • `visible` and `actionable` are DIFFERENT booleans (project.ts § dual
 *     visibility). Collapsing them dropped every `opacity:0` custom checkbox.
 *   • an `Address` is a DESCRIPTION, never a node reference — so it carries no
 *     `el`, and it cannot be given one by accident.
 *   • `ordinal` means nothing without `peerCount`; an ordinal into a list that
 *     has since changed is not an identity.
 *
 * A type is the cheapest place to write those down where they get checked.
 */
import type { QAPair } from './page/structured.ts';
export type { QAPair };

// ---- projection -----------------------------------------------------------

/** ARIA state, read at answer time from the live element. */
export interface States {
  expanded?: boolean | string;
  checked?: boolean | string;
  selected?: boolean | string;
  current?: boolean | string;
  invalid?: boolean | string;
  disabled?: boolean | string;
  pressed?: boolean | string;
  busy?: boolean | string;
  required?: boolean;
  readOnly?: boolean;
  /** Privacy-safe form progress: whether a value exists, never the value. */
  valuePresent?: boolean;
  focused?: boolean;
}

/** What a control DOES, when its accessible name will not say. */
/**
 * An affordance is an OPEN vocabulary, deliberately typed as `string`.
 *
 * It was a closed union of ten members, which meant a host could override the
 * pattern for an affordance we had thought of and could not add one we had not.
 * For an SDK whose thesis is that agents should query an open world, sealing the
 * vocabulary at compile time was the sharpest contradiction in the codebase —
 * and because WebMCP has no schema negotiation (`inputSchema` is a semantic hint,
 * issue #92), our vocabulary IS the interface: every closed list here becomes a
 * closed list inside every agent that consumes us.
 *
 * The core the SDK ships is written down once, in `config.ts § affordance`
 * (patterns and terms), and what a given page actually speaks is reported
 * per-page by `describe_app().vocabulary` — authoritative precisely because a
 * host may add to it. A separate `KNOWN_AFFORDANCES` constant used to restate
 * that list here; nothing imported it, and its docblock promised a schema
 * invariant nothing enforced.
 */
export type Affordance = string;

/**
 * Where an affordance came from. The distinction an agent needs and could not
 * previously make: `rel="next"` is something the AUTHOR declared, while a regex
 * matching the word "next" in a label is our guess. Both used to arrive as
 * indistinguishable strings in the same array.
 */
export type AffordanceSource = 'authored' | 'inferred';
export interface AffordanceHit { id: Affordance; via: string; source: AffordanceSource }

export interface Box { x: number; y: number; w: number; h: number }

/**
 * An element's viewport box, rounded.
 *
 * The same four `Math.round` calls and the same `?? { x: 0, y: 0, … }` guard for
 * a detached node were written out independently in three modules. Identical
 * formulae in three places is how two of them end up rounding differently.
 */
export function boxOf(el: Element | null | undefined): Box {
  const r = el?.getBoundingClientRect?.() ?? { x: 0, y: 0, width: 0, height: 0 };
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
}

export interface NonTextInfo {
  source: string;
  confidence: 'high' | 'medium' | 'low';
  chartLibrary: string | null;
}

/**
 * One node of the accessibility projection.
 *
 * `el` is a live Element and never leaves the page — it is the reason
 * `ProjectedNode` and `Address` are separate types rather than one type with
 * optional fields.
 */
export interface ProjectedNode {
  el: Element;
  /** Preferred-content provenance. It is a chunk boundary, never a filter. */
  primary: boolean;
  role: string;
  landmark: string | null;
  landmarkName: string | null;
  name: string | null;
  text: string;
  headingPath: string[];
  row: string | null;
  states: States;
  affordances?: Affordance[];
  /** `affordance id -> the signal it was read from`, e.g. `rel=next`. */
  affordanceVia?: Record<string, string>;
  /** Accessible name of whatever this control's `aria-controls` points at. */
  controlsName?: string | null;
  /** Safe one-hop authored relationships; target Elements never cross the wire. */
  relations?: Array<{ type: 'controls'; source: string; target: Element; name: string | null }>;
  interactive: boolean;
  inert: boolean;
  /** On screen — opacity counts. Governs what enters the CONTENT index. */
  visible: boolean;
  /** Clickable — opacity must NOT count. Governs what enters the CONTROL index. */
  actionable: boolean;
  isHeading: boolean;
  nonText?: NonTextInfo;
  /** Assigned once per projection; meaningless without `peerCount`. */
  ordinal?: number;
  peerCount?: number;
  /** Behind a closed <details>: real content, one click away. */
  collapsed?: boolean;
  /** Present only on the spread copies in the control list. */
  idx?: number;
  /**
   * Scope path of the same-origin child frame this node lives in
   * (e.g. `document/frame[1]`), or absent for the top document. Set only when
   * `discovery.frames` is on and the projection merged a readable frame. It
   * gives the otherwise document-local address a frame identity, so a frame
   * passage's address cannot collide with an identical one in the top document.
   */
  frame?: string;
}

export interface OpaqueRegion {
  /** Live page-side identity; never serialized. Geometry is measured on demand. */
  el: Element;
  /** Same-origin frame scope when this region came from a merged frame document. */
  frame?: string;
  kind: 'OPAQUE';
  tag: string;
  role: string;
  src: string | null;
  filenameHint: string | null;
  chartLibrary: string | null;
  landmark: string | null;
  landmarkName: string | null;
  headingPath: string[];
  nearestHeading: string | null;
  box: Box;
  rejectedCandidates: Array<{ text: string; reason: string }>;
  reason: string;
}

export interface Coverage {
  excluded: number; customElements: number;
  /** Custom hosts with no exposed root: may have no root or an unregistered closed root. */
  unknownRoots: number;
  inferredHeadings: number;
  /**
   * Components whose semantics are unreachable from page JavaScript because
   * they live in `ElementInternals` — no role, no accessible name, no own text.
   * See the note beside the counter in project.ts. `opaqueInteractive` is the
   * subset that is focusable, and therefore almost certainly a control.
   */
  opaqueComponents: number; opaqueInteractive: number;
  nonText: number; nonTextDecorative: number; nonTextRecovered: number;
  nonTextOpaque: number; unlabelledControls: number;
  /**
   * Readable text parked at `opacity: 0` with a real box — a scroll-reveal
   * animation that has not fired yet. NOT indexed (project.ts § revealPending
   * has the measurement), but reported, because it is in the accessibility tree
   * and an agent comparing against a snapshot would otherwise see this index
   * silently lose it.
   */
  revealPending: number; revealPendingChars: number;
  /**
   * Things the projection tried to read and could not, which used to be
   * swallowed by a bare `catch`. Each is a HOLE in the index that an agent
   * comparing against the rendered page would otherwise have to infer:
   *
   * `malformedStructuredData` — a `<script type=application/ld+json>` whose JSON
   * does not parse, so its facts are absent even though the page declares them.
   * `nameComputeFailures` — elements where the accessible-name computation threw
   * and the element was indexed unnamed, which is what a name-based lookup misses.
   * `invalidExcludeSelectors` is retained for wire compatibility but remains
   * zero: invalid host exclusions now abort projection before any content is read.
   */
  malformedStructuredData: number;
  nameComputeFailures: number;
  invalidExcludeSelectors: number;
  // `closedRoots`/`unreachableRoots`/`componentsInspectedPct` were removed:
  // page JavaScript cannot detect a closed shadow root it was not handed, so the
  // first was permanently 0 and the other two were derived constants (0 and 100)
  // reported to agents as measurements. `unknownRoots` carries the honest state.
  elementsInspectedPct: number;
  documentElements: number; rootElements: number; framesOutsideRoot: number;
  /** Frame documents inside the root that semantic projection cannot enter. */
  unindexedFrameDocuments: number;
  /** Collections whose authored ARIA total proves the DOM is only a window. */
  virtualizedCollections: number;
  /** Known rows absent from those DOM windows; excludes unknown (`-1`) totals. */
  offDomRowsDeclared: number;
  /** Known non-row set items absent from ARIA-declared rendered windows. */
  offDomItemsDeclared: number;
  /** Partial collections that explicitly declare an unknown full size. */
  unknownSizeCollections: number;
}

export interface Projection {
  nodes: ProjectedNode[];
  /** schema.org question/answer pairs found in JSON-LD on this page. */
  qa: QAPair[];
  coverage: Coverage;
  shadowRoots: ShadowRoot[];
  /** Document elements of successfully merged same-origin frames. */
  frameRoots: Element[];
  opaque: OpaqueRegion[];
  /** Semantic holes that had no non-zero box and therefore cannot be cropped. */
  opaqueWithoutGeometry: number;
  opaqueTotal: number;
}

// ---- segmentation ---------------------------------------------------------

export type ChunkStrategy = 'heading' | 'landmark' | 'containment' | 'window';

export interface Chunk {
  id: number;
  /** Inherited from projected nodes; chunks never cross this boundary. */
  primary: boolean;
  /** Behind a closed disclosure: real content the reader can reach in one click. */
  collapsed?: boolean;
  landmark: string | null;
  headingPath: string[];
  strategy: ChunkStrategy;
  text: string;
  words: number;
  /** Of `words`, how many came from non-text nodes (image alt text, chart
   *  descriptions). A description of a picture is not a claim the page makes, so
   *  a chunk that is mostly recovered non-text is demoted in content ranking by
   *  this fraction — the declared per-node `nonText` signal, carried to the
   *  chunk it lands in. A fraction, not a boolean, because an image folds into a
   *  sibling-prose chunk and must not drag that prose down with it. */
  nonTextWords: number;
  els: Element[];
  /** Where each element's text landed in the joined `text`, so a character
   *  offset can be mapped back to the element it came from. */
  spans: Array<{ el: Element; start: number; end: number }>;
  container: Element | null;
  /** Scope path of the same-origin frame this chunk's content came from
   *  (`discovery.frames`), or absent for the top document. Carried onto the
   *  region address so a frame passage resolves back into its own document. */
  frame?: string;
}

export interface SegmentStats {
  chunks: number;
  strategyCounts: Record<ChunkStrategy, number>;
  structuralEngagementPct: number;
}

export interface Segmentation { chunks: Chunk[]; stats: SegmentStats }

// ---- addressing -----------------------------------------------------------

/**
 * A re-queryable DESCRIPTION of an element. Deliberately carries no reference:
 * every shipped agent tool holds a pointer and it dies.
 */
export interface Address {
  /**
   * Same-origin child-frame scope path (e.g. `document/frame[1]`), or absent for
   * the top document. Present only when `discovery.frames` indexed a readable
   * frame; `resolve_address` re-enters that frame's document before resolving,
   * and an address without it never matches a frame node (and vice versa).
   */
  frame?: string;
  landmark: string | null;
  landmarkName: string | null;
  headingPath: string[];
  row: string | null;
  role: string;
  name: string | null;
  ordinal: number;
  /** How many identical siblings existed when this address was minted. */
  peerCount: number;
  /** Only minted for regions with no heading to name them. */
  anchorText?: string;
  /**
   * Present only in `read_region` next-call arguments. Character offset into the
   * resolved region text; copied back verbatim so pagination advances instead
   * of returning the same truncated prefix forever.
   */
  textOffset?: number;
  /** Number of region controls already returned alongside earlier text pages. */
  controlOffset?: number;
  /** Projection revision paired with `textOffset`; stale next calls fail. */
  textRevision?: number;
  /**
   * Which tool this address is FOR.
   *
   * `find_on_page` mints a REGION address per result (the passage) and CONTROL
   * addresses inside `actionable`. The two are structurally identical objects
   * that require different tools — a region address is matched by heading path
   * and resolves through `read_region`, while a control address identifies one
   * element and resolves through `resolve_address` — and until this field existed
   * nothing on the wire said which was which. An agent could only try one and
   * read a failure.
   *
   * Named for the TOOL rather than a category, because that is the thing an
   * agent has to decide. `kind` was the obvious name and is already taken on a
   * neighbouring object with a different meaning — `actionable[].kind` is
   * `'nav' | 'action'` — and two fields called `kind` meaning different things
   * on adjacent objects in one payload is a trap.
   *
   * Absent means `resolve_address`, so every address minted before this field
   * behaves exactly as it did.
   */
  resolveWith?: 'read_region' | 'resolve_address';
  /** Outline-only region scope. Resolving reads chunks at this heading and all
   * descendant heading paths; ordinary search addresses remain exact regions. */
  headingScope?: 'subtree' | 'outline';
}

/** The three outcomes of resolving an address. Declared once and referenced by
 *  `Resolution` below, which used to re-spell all three literals inline. */
export type ResolveStatus = 'RESOLVED' | 'AMBIGUOUS' | 'NOT_FOUND';

export type Resolution =
  | { status: Extract<ResolveStatus, 'RESOLVED'>; element: Element; node: ProjectedNode; relaxed?: boolean; note?: string }
  | { status: Extract<ResolveStatus, 'AMBIGUOUS'>; candidates: Address[]; hint: string }
  | { status: Extract<ResolveStatus, 'NOT_FOUND'>; nearest: Address[]; hint: string };

// ---- retrieval ------------------------------------------------------------

export type Tokenize = (s: string) => string[];

/** `[docId, score]`, sorted by score descending. */
export type Hit = [number, number];

export interface BM25Index {
  postings: Map<string, Array<[number, number]>>;
  lens: number[];
  avg: number;
  n: number;
}

/** Which lane answered. An agent cannot tell "no match" from "the model has not
 *  arrived" without this, so it is on every retrieval response. */
export type RetrievalLane = 'lexical' | 'hybrid';

export type Confidence = 'high' | 'medium' | 'low';

export interface DenseTable {
  vocab: Map<string, number>;
  rows: Int8Array;
  scales: Float32Array;
  dims: number;
  n: number;
}

export interface DenseCorpus {
  mat: Int8Array;
  scales: Float32Array;
  dims: number;
  n: number;
}

export interface DenseState {
  status: 'off' | 'loading' | 'ready' | 'unavailable';
  detail: string | null;
  bytes?: number;
  embedMs?: number;
}

export interface IndexStats {
  chunks: number;
  strategyCounts: Record<ChunkStrategy, number>;
  structuralEngagementPct: number;
  charsPerToken: number;
  controls: number;
  nodes: number;
  coverage: Coverage;
  locale: string;
  retrieval: RetrievalLane;
  /** Which morphology lane matched inflected forms: a language code, or 'none'.
   *  Reported because poor recall on a language with no stemmer has a cause an
   *  agent would otherwise have to guess at. */
  stemLanguage: string;
  lane: 'inline' | 'worker';
  projectMs: number;
  indexMs: number;
  denseMs?: number;
  /** The SDK was constructed while the document was still parsing, so the first
   *  index described an incomplete page and was rebuilt on DOMContentLoaded. */
  bootedEarly?: boolean;
}
