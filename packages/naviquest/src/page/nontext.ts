/**
 * Non-text content: images, icons, SVG, canvas, charts, media.
 *
 * The counter-intuitive finding this module is built on: the win is NOT
 * generating descriptions. It is (a) consuming author text we would otherwise
 * discard, and (b) QUALITY-FILTERING it. WebAIM Million 2026 found 10.8% of
 * images that have alt text have "questionable or repetitive" alt — alt="image",
 * a filename, or text identical to adjacent content. Indexing that unfiltered
 * makes retrieval measurably worse than indexing no images at all, because a
 * query for "chart" matches fifty alt="image" attributes.
 *
 * Where nothing usable exists we emit an OPAQUE REGION record rather than
 * silently omitting the element. That converts an invisible hole into an
 * addressable one: a vision-capable agent can screenshot exactly that box, and
 * the SDK never guesses.
 */
import { boxOf } from '../types.ts';
import { idRefTarget } from './dom.ts';
import { readingOrderText } from './page-text.ts';
import type { Confidence, OpaqueRegion, ProjectedNode } from '../types.ts';
import type { NonTextTuning } from '../config.ts';

/**
 * Non-text policy is HOST-OVERRIDABLE, for the same reason affordance patterns
 * are: the shipped lists are English and cover five charting libraries, and both
 * of those are facts about the corpus they were derived from rather than about
 * the web. A site can extend either without forking this file.
 *
 * It is THREADED, not module state. The first version installed it into module
 * scope once per projection pass, which is correct only because `project()` is
 * synchronous and two passes can therefore never interleave. That invariant is
 * not written down anywhere and ROADMAP 4.2 — yielding across landmark subtrees
 * with `scheduler.yield()` — deletes it. Two SDK instances on one page with
 * different policy would then silently read each other's.
 */
export interface NonTextPolicy {
  cfg: NonTextTuning;
  placeholders: Set<string>;
  chartSelector: string;
}

/** Compile the host's policy once per projection, then pass it down. */
export function compileNonText(cfg: NonTextTuning): NonTextPolicy {
  return {
    cfg,
    placeholders: new Set(cfg.placeholderWords.map((w) => w.toLowerCase())),
    chartSelector: Object.values(cfg.chartLibraries).join(', '),
  };
}

type QualityVerdict = { ok: false; reason: string } | { ok: true; norm: string };
/** Either author text worth indexing, an author-declared decoration, or a hole. */
type NonTextVerdict =
  | { kind: 'DECORATIVE' }
  | { kind: 'TEXT'; text: string; source: string; confidence: Confidence; chartLibrary?: string | null }
  | (Omit<OpaqueRegion, 'landmark' | 'landmarkName' | 'headingPath' | 'nearestHeading'>);

const NONTEXT_TAGS = new Set(['img', 'svg', 'canvas', 'object', 'embed', 'video', 'audio', 'iframe']);
const NONTEXT_ROLES = new Set(['img', 'image', 'graphics-document', 'graphics-symbol', 'graphics-object']);

const FILE_EXT = /\.(jpe?g|png|gif|webp|svgz?|avif|bmp|ico|tiff?)\s*$/i;

/** Author-declared decorative — ~30% of all images. Emit nothing, flag nothing. */
function isDecorative(el: Element): boolean {
  if (el.localName === 'img' && el.getAttribute('alt') === '') return true;
  const role = el.getAttribute('role');
  if (role === 'presentation' || role === 'none') return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  return false;
}

export function isNonText(el: Element): boolean {
  if (NONTEXT_TAGS.has(el.localName.toLowerCase())) return true;
  const role = el.getAttribute('role');
  return !!role && NONTEXT_ROLES.has(role);
}

/**
 * WebAIM's own definition of junk alt, plus axe's image-redundant-alt logic.
 * Rejects are kept as low-confidence metadata rather than discarded.
 */
/**
 * The checks both quality gates share: empty, a filename, a placeholder word.
 * They were three identical lines in two functions, which is how the two drift.
 * @returns {{ ok: false, reason: string } | { ok: true, norm: string }}
 */
function commonQuality(text: string | null | undefined, p: NonTextPolicy): QualityVerdict {
  const t = (text || '').trim();
  if (!t) return { ok: false, reason: 'EMPTY' };
  if (FILE_EXT.test(t)) return { ok: false, reason: 'FILENAME' };
  const norm = t.toLowerCase().replace(/[_\-\s]+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim();
  if (p.placeholders.has(norm)) return { ok: false, reason: 'PLACEHOLDER' };
  return { ok: true, norm };
}

function qualityCheck(text: string | null | undefined, el: Element, p: NonTextPolicy): QualityVerdict {
  const t = (text || '').trim();
  const base = commonQuality(t, p);
  if (!base.ok) return base;
  const norm = base.norm;
  if (/^\d+$/.test(norm)) return { ok: false, reason: 'NUMERIC_ONLY' };
  if (norm.length < 2) return { ok: false, reason: 'TOO_SHORT' };

  // Redundant with the link that WRAPS it (an <img> inside an <a>), or with a
  // sibling image's alt. Must start from the parent: closest() on a <button>
  // returns the button itself, which made every control fail its own name.
  const link = el.parentElement?.closest?.('a,button');
  if (link && link !== el) {
    const linkText = (link.textContent || '').replace(/\s+/g, ' ').trim();
    if (linkText && linkText.toLowerCase() === t.toLowerCase()) {
      return { ok: false, reason: 'REDUNDANT_WITH_LINK_TEXT' };
    }
  }
  const prev = el.previousElementSibling;
  if (prev?.localName === 'img' && (prev.getAttribute('alt') || '').trim().toLowerCase() === t.toLowerCase()) {
    return { ok: false, reason: 'REDUNDANT_WITH_ADJACENT_IMAGE' };
  }
  return { ok: true, norm };
}

/** Chart library fingerprints. Half the ecosystem already emits rich text. */
function chartFingerprint(el: Element, p: NonTextPolicy): string | null {
  // Driven by `nonText.chartLibraries`, so a site with an in-house chart
  // component can name it and get its text harvested, instead of being an
  // opaque region forever. The hand-written if-ladder this replaced could only
  // ever know about the five libraries someone had thought of.
  for (const [name, selector] of Object.entries(p.cfg.chartLibraries)) {
    try { if (el.closest(selector)) return name; } catch { /* a bad host selector must not break the walk */ }
  }
  return null;
}

/**
 * Harvest text a chart already exposes. Highcharts' exporting.showTable and
 * Vega's per-mark aria-labels are a better description than any caption we
 * could generate — and we would otherwise throw them away.
 */
function harvestChart(el: Element, p: NonTextPolicy): { library: string | null; text: string } | null {
  const lib = chartFingerprint(el, p);
  if (!lib) return null;
  // Same guard as chartFingerprint: `chartSelector` is the comma-join of every
  // host selector, and one malformed entry must not throw out of the walk.
  let chartRoot: Element | null = null;
  try { chartRoot = p.chartSelector ? el.closest(p.chartSelector) : null; } catch { /* bad host selector */ }
  const root = chartRoot ?? el.parentElement;
  if (!root) return null;
  const bits: string[] = [];

  // A library that renders its series as a real adjacent HTML table declares the
  // selector in `chartDataTables`; the lookup replaced a hardcoded Highcharts
  // branch. Scope this tightly: searching the whole parent section made a Vega
  // chart harvest a neighbouring Highcharts table and report it as its own data.
  const dataTableSel = p.cfg.chartDataTables?.[lib];
  if (dataTableSel) {
    let table: Element | null = null;
    // One malformed host selector must not throw out of the walk — same guard
    // the `chartSelector` join above takes.
    try { table = root.querySelector(dataTableSel); } catch { /* bad host selector */ }
    for (let sib = root.nextElementSibling; !table && sib; sib = sib.nextElementSibling) {
      if (sib.localName === 'table') { table = sib; break; }
      if (sib.matches?.('h1,h2,h3,h4,h5,h6,section')) break;   // stop at the next block
    }
    if (table) bits.push(tableToText(table, p));
  }

  // Vega / Recharts / ECharts put the description in ARIA on the container or marks.
  // The cap bounds the TOTAL: a bare `break` only ended the inner selector's
  // loop, so the outer one collected up to three times the configured limit.
  aria: for (const sel of ['[aria-label]', '[role="graphics-symbol"][aria-label]', '[aria-roledescription]']) {
    for (const n of root.querySelectorAll(sel)) {
      const v = n.getAttribute('aria-label') || n.getAttribute('aria-roledescription');
      if (v && v.length > 2) bits.push(v);
      if (bits.length > p.cfg.maxChartFragments) break aria;
    }
  }
  const svgText = [...root.querySelectorAll('svg text')].map((t) => t.textContent?.trim() ?? '').filter(Boolean);
  if (svgText.length) bits.push(svgText.join(' · '));

  const text = [...new Set(bits)].join(' ').replace(/\s+/g, ' ').trim();
  return text ? { library: lib, text: text.slice(0, p.cfg.maxChartChars) } : { library: lib, text: '' };
}

function tableToText(table: Element, p: NonTextPolicy): string {
  return [...(table as HTMLTableElement).rows].slice(0, p.cfg.maxChartTableRows)
    .map((r) => [...r.cells].map((c) => c.textContent?.trim() ?? '').join(': '))
    .join('; ');
}

/**
 * Resolve non-text content to either usable text or an opaque-region record.
 * `accName` is injected so this module never re-implements accname.
 */
export function describeNonText(el: Element, accName: string, p: NonTextPolicy,
                                safe: (t: Element) => boolean = () => true): NonTextVerdict {
  if (isDecorative(el)) return { kind: 'DECORATIVE' };

  const candidates: Array<{ text: string; source: string; confidence: Confidence; rejected?: string }> = [];
  const push = (text: string | null | undefined, source: string, confidence: Confidence) => {
    if (text?.trim()) candidates.push({ text: text.trim(), source, confidence });
  };

  // Author-written, in descending trustworthiness.
  push(accName, 'accessible-name', 'high');
  if (el.localName === 'svg') {
    // SVG <title>/<desc>/<text> keep `textContent`: <text><tspan>12</tspan>
    // <tspan>%</tspan></text> means "12%", so the spaced join would corrupt it.
    push(el.querySelector(':scope > title')?.textContent, 'svg-title', 'high');
    push(el.querySelector(':scope > desc')?.textContent, 'svg-desc', 'high');
    const txt = [...el.querySelectorAll('text')].map((t) => t.textContent?.trim() ?? '').filter(Boolean).join(' ');
    push(txt, 'svg-text-nodes', 'medium');   // never index <path> data — semantic noise
  }
  // Captions, described-by targets and <canvas> fallbacks are author PROSE and
  // routinely carry <code>/<a>. They take the same reading-order join as
  // passages, so a caption cannot come back as "Rate is per" (own text) or
  // "Rate is12%peryear" (textContent).
  const fig = el.closest('figure');
  const cap = fig?.querySelector('figcaption');
  if (cap && safe(cap)) push(readingOrderText(cap), 'figcaption', 'high');
  for (const attr of ['aria-describedby', 'aria-details']) {
    const ids = (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean);
    for (const id of ids) {
      const t = idRefTarget(el, id);
      if (t && safe(t)) push(readingOrderText(t), attr, 'high');
    }
  }
  // <canvas> fallback content is NORMATIVE in the HTML spec, not folklore.
  if (el.localName === 'canvas') push(readingOrderText(el), 'canvas-fallback', 'high');
  if (el.localName === 'iframe') push(el.getAttribute('title'), 'iframe-title', 'medium');

  const chart = harvestChart(el, p);
  if (chart?.text) {
    // A chart's per-mark labels and data table carry the actual values, so they
    // outrank the container's accessible name ("Contamination rate by district"
    // tells an agent the topic; the marks tell it the numbers). Combine, with
    // the harvest leading.
    const nameFirst = accName && !chart.text.includes(accName) ? `${accName}. ` : '';
    candidates.unshift({ text: (nameFirst + chart.text).trim(), source: `chart:${chart.library}`, confidence: 'high' });
  }

  for (const c of candidates) {
    const q = qualityCheck(c.text, el, p);
    if (q.ok) return { kind: 'TEXT', ...c, ...(chart ? { chartLibrary: chart.library } : {}) };
    c.rejected = q.reason;
  }

  // Nothing usable. Report the hole instead of hiding it.
  const src = el.getAttribute?.('src') || el.getAttribute?.('data') || null;
  return {
    el,
    kind: 'OPAQUE',
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role') || '',
    src,
    filenameHint: src ? filenameStem(src) : null,     // low confidence, never presented as author text
    chartLibrary: chart?.library ?? null,
    box: boxOf(el),
    rejectedCandidates: candidates.flatMap((c) => (c.rejected ? [{ text: c.text.slice(0, p.cfg.rejectedTextChars), reason: c.rejected }] : [])),
    reason: candidates.length ? 'ALL_CANDIDATES_REJECTED' : 'NO_TEXT_AVAILABLE',
  };
}

function filenameStem(src: string | null): string | null {
  try {
    const last = new URL(src ?? '', location.href).pathname.split('/').pop() || '';
    return last.replace(FILE_EXT, '').replace(/[-_]+/g, ' ').replace(/\d{3,}/g, '').trim() || null;
  } catch { return null; }
}

/**
 * A control with no usable name is the same class of hole as an unlabelled
 * image. Note this is not just `!name`: an icon-only button whose accessible
 * name is "★" or "image" HAS a name, but a meaningless one. axe separates gap
 * detectors from quality detectors, and this needs both.
 */
export function isUnlabelledControl(node: ProjectedNode, p: NonTextPolicy): boolean {
  if (!node.interactive) return false;
  return !qualityCheckControl(node.name || node.text || '', p).ok;
}

/**
 * Quality rules for a CONTROL name, which are not the rules for image alt text.
 * Running the alt-text rules over control names declared MDN's browser-compat
 * buttons ("14", "39", "10.1") and Wikipedia's citation links ("[1]") unreadable
 * — 144 and 499 "opaque regions" respectively, each one an invitation to
 * screenshot a control whose name was perfectly good.
 *
 * A number IS a name on a control: page 2, version 14, quantity 3, seat 12A.
 * What is genuinely unusable is a name with no letters and no digits at all —
 * "★", "»", "×" — or a placeholder/filename, which mean the same thing here as
 * they do on an image.
 */
function qualityCheckControl(text: string | null | undefined, p: NonTextPolicy): QualityVerdict {
  const base = commonQuality(text, p);
  if (!base.ok) return base;
  // A number IS a name on a control (page 2, version 14, seat 12A). What is
  // unusable is a name with no letters and no digits at all: "★", "»", "×".
  if (!base.norm) return { ok: false, reason: 'SYMBOL_ONLY' };
  return { ok: true, norm: base.norm };
}
