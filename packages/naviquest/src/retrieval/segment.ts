/**
 * Segmentation cascade, degrading in order:
 *   1. landmark partition
 *   2. heading boundaries with containment-derived paths  <- primary
 *   3. sectioning containment
 *   4. fixed ~200-word windows over accessible text       <- floor
 * The floor is respectable: published evaluation finds fixed-200 matches or
 * beats embedding-similarity chunking. A structureless page loses the
 * in-document gain, not correctness.
 */
import type { Chunk, ChunkStrategy, ProjectedNode, Segmentation } from '../types.ts';
import type { SegmentTuning } from '../config.ts';
import { DEFAULTS } from '../config.ts';
import { REGION_BOUNDARY } from '../page/roles.ts';
import { makeTokenizer } from './text.ts';
import { flatParentElement } from '../page/dom.ts';

// Stable identity for a container element, used only to key chunk boundaries.
// A WeakMap keeps this out of the DOM and lets the element be collected.
const containerIds = new WeakMap<Element, number>();
let nextContainerId = 1;
const containerId = (el: Element | null | undefined): number => {
  if (!el) return 0;
  let id = containerIds.get(el);
  if (!id) { id = nextContainerId++; containerIds.set(el, id); }
  return id;
};

const commonAncestor = (a: Element | null, b: Element | null): Element | null => {
  if (!a) return b;
  if (!b) return a;
  if (a === b) return a;
  const bPath = new Set<Element>();
  for (let p: Element | null = b; p; p = flatParentElement(p)) bPath.add(p);
  for (let p: Element | null = a; p; p = flatParentElement(p)) if (bPath.has(p)) return p;
  return a;
};

/**
 * The region a chunk can offer controls from, and the region read_region may
 * merge across. Starts at the chunk's own common ancestor and climbs only until
 * it finds interactive content or crosses a sectioning boundary.
 *
 * Climbing is required: a one-paragraph chunk's common ancestor is the <p>
 * itself, which contains no controls. Bounding the climb is equally required:
 * without it, two pathless sibling <div>s both resolve to <main>, and every
 * result offered every control on the page — the observed Wikipedia behaviour,
 * where all 99 chunks listed "Jump to content" as their actionable control.
 */
export function regionOf(chunk: Chunk, hasControl: (el: Element) => boolean, maxClimb = DEFAULTS.retrieval.maxRegionClimb): Element | null {
  let el = chunk.container;
  if (!el) return null;
  for (let i = 0; i < maxClimb; i++) {
    if (hasControl(el)) return el;
    if (REGION_BOUNDARY.has(el.tagName)) return el;
    const parent = flatParentElement(el);
    if (!parent) return el;
    el = parent;
  }
  return el;
}

export function segment(nodes: ProjectedNode[], opts: Partial<SegmentTuning> = {},
                        countWords = makeTokenizer().wordCount): Segmentation {
  const TARGET_WORDS = opts.targetWords ?? DEFAULTS.segment.targetWords;
  const MAX_WORDS = opts.maxWords ?? DEFAULTS.segment.maxWords;
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;

  const flush = () => {
    if (cur && cur.words > 0) { chunks.push(cur); }
    cur = null;
  };

  /** Close the open chunk and start a new one. Returns it, rather than only
   *  assigning the closure variable, so callers never have to assume it ran. */
  const open = (n: Pick<ProjectedNode, 'primary' | 'landmark' | 'headingPath' | 'frame'>, strategy: ChunkStrategy): Chunk => {
    flush();
    return (cur = {
      id: chunks.length,
      primary: n.primary,
      landmark: n.landmark,
      headingPath: n.headingPath.slice(),
      strategy,
      text: '',
      words: 0,
      nonTextWords: 0,
      els: [],
      spans: [],
      container: null,
      collapsed: false,
      ...(n.frame ? { frame: n.frame } : {}),
    });
  };

  let lastKey: string | null = null;
  for (const n of nodes) {
    if (!n.text) continue;
    // Interactive nodes ARE indexed as content. Excluding them cost 40-93% of
    // the retrievable words on real pages: link text is content, and on
    // link-dense pages (Hacker News story titles, gov.uk body links, Wikipedia
    // article links) it is most of the content. Whether it survived used to
    // depend on markup nesting — <a>text</a> was lost, <a><span>text</span></a>
    // was kept — which is an accident, not a policy.
    //
    // Their accessible NAME still lives only in the control index; this is the
    // element's own text node, counted exactly once, in document order.
    if (n.visible === false) { continue; }
    const pathless = n.headingPath.length === 0;
    // With no heading to bound them, sibling containers must not merge: two
    // pathless <div>s would otherwise become one chunk whose text spans both.
    // A header and main can legitimately share no landmark and no heading. The
    // primary provenance is therefore a segmentation boundary, not a ranking weight: a
    // bounded passage must never merge global shell text into primary content.
    // Frame is part of the key: a frame node and a top-document node with the
    // same landmark and heading path live in different documents and must never
    // merge into one chunk (that would mint an address spanning two documents).
    const key = `${n.frame ?? ''}|${n.primary}|${n.landmark}|${n.headingPath.join('>')}|${pathless ? containerId(flatParentElement(n.el)) : ''}`;

    if (n.isHeading) { open(n, 'heading'); lastKey = key; continue; }
    if (key !== lastKey) {
      open(n, n.headingPath.length ? 'containment' : n.landmark ? 'landmark' : 'window');
      lastKey = key;
    }
    let chunk = cur ?? open(n, 'window');
    lastKey = key;

    // Whitespace is not a word boundary in CJK and is optional in Thai. The
    // old split counted a whole Japanese section as one word and silently
    // disabled the only size bound that keeps a result cheap. Identifier
    // expansion is deliberately excluded: it is retrieval, not document size.
    const w = countWords(n.text);
    if (chunk.words + w > MAX_WORDS && chunk.words >= TARGET_WORDS) {
      chunk = open({ ...n, headingPath: chunk.headingPath }, 'window');
      lastKey = key;
    }
    // Where this element's text landed in the joined chunk text. Without it an
    // answer span is a pair of numbers with nothing to point at: highlighting
    // the sentence requires knowing which ELEMENT it came from, and the chunk
    // text is a join of many.
    const start = chunk.text ? chunk.text.length + 1 : 0;
    chunk.text += (chunk.text ? ' ' : '') + n.text;
    chunk.spans.push({ el: n.el, start, end: chunk.text.length });
    chunk.words += w;
    // Recovered non-text (image alt, chart data) counts toward the chunk's
    // demotion fraction; prose in the same chunk does not.
    if (n.nonText) chunk.nonTextWords += w;
    chunk.els.push(n.el);
    if (n.collapsed) chunk.collapsed = true;
    chunk.container = commonAncestor(chunk.container, n.el);
  }
  flush();

  // K9 — structural engagement rate. Counted from the chunks that SURVIVED, not
  // from open() calls: an opened-then-empty chunk is discarded by flush(), and
  // counting those produced >100% engagement.
  // Reported, never targeted — optimising it would mean forcing structure onto
  // pages that lack it.
  const surviving: Record<ChunkStrategy, number> = { heading: 0, landmark: 0, containment: 0, window: 0 };
  for (const c of chunks) surviving[c.strategy]++;
  /**
   * Structural engagement = the share of chunks that carry a HEADING PATH.
   *
   * This counted `landmark` as structural, and `landmark` is precisely the
   * DEGRADED case: segment() opens a chunk as `containment` when the node has a
   * heading path and as `landmark` when it does not but sits inside a landmark.
   * So the old numerator added the failure mode to the success mode.
   *
   * Measured across twelve large live sites, the consequence was that
   * `describe_app().structuralQuality` reported **`good` on all twelve** — 99% on
   * a Stack Overflow question page where 97% of chunks have no heading path at
   * all, and `good 100%` on a YouTube home page with a zero-entry outline and one
   * chunk. A signal that never varies is not a signal, and `locate_control`'s own
   * documentation tells an agent that `structuralQuality: "low"` means it should
   * prefer whole-region reads over narrow queries — advice that could never fire.
   *
   * The heading path is the whole differentiator over Playwright's
   * `(role, accessible name)`; it is what tells twelve "Add to cart" buttons
   * apart. Chunks without one are addressable only by role, name and landmark,
   * so they are exactly what this number needs to expose rather than absorb.
   */
  const structural = surviving.heading + surviving.containment;
  const totalC = chunks.length || 1;
  return {
    chunks,
    stats: {
      chunks: chunks.length,
      strategyCounts: surviving,
      structuralEngagementPct: Math.round((structural / totalC) * 100),
    },
  };
}
