/**
 * The page's shape, as `describe_app` reports it: landmarks, heading outline,
 * breadcrumb trail, and the views reachable from here.
 *
 * This is the "where am I" half of orientation, and it is derived entirely from
 * an existing projection — no DOM, no index, no state — so it lives apart from
 * the module that owns the lifecycle.
 */
import type { ProjectedNode, Projection } from '../types.ts';

export interface PageStructure {
  landmarks: string[];
  /** Full paths stay internal until the tool layer attaches the one canonical
   * region address. Keeping the parent path here avoids guessing between two
   * same-named headings at the same depth and landmark. */
  outline: Array<{ depth: number; text: string; landmark: string | null; headingPath: string[] }>;
  trail: string[];
  views: string[];
}

export function buildStructure(projection: Projection, navLandmarks: Set<string>): PageStructure {
  const landmarks = [...new Set(projection.nodes.flatMap((n) => (n.landmark ? [n.landmark] : [])))];

  // One entry per distinct heading PATH, not per heading element: a page that
  // repeats a heading text under different parents is two outline entries, and
  // a page that renders the same heading twice under one parent is one.
  const outline: PageStructure['outline'] = [];
  const seen = new Set<string>();
  for (const n of projection.nodes) {
    if (!n.isHeading) continue;
    const key = n.headingPath.join('>');
    if (seen.has(key)) continue;
    seen.add(key);
    outline.push({
      depth: n.headingPath.length,
      text: n.headingPath[n.headingPath.length - 1],
      landmark: n.landmark,
      headingPath: [...n.headingPath],
    });
  }

  // `aria-current` is the only machine-readable "you are here" the platform has.
  const trail = projection.nodes
    .filter((n) => n.states?.current)
    .flatMap((n) => { const t = n.name || n.text; return t ? [t] : []; });

  // Where an agent could go next. Which landmarks count as navigation is a
  // JUDGEMENT the ARIA taxonomy does not model, so it arrives as config rather
  // than being decided here — see config.ts § navLandmarks.
  const views = projection.nodes
    // Orientation must describe reachable destinations, not merely authored
    // links. Hidden and modal-inert links used to appear here even though the
    // action inventory correctly refused them.
    .filter((n) => n.role === 'link' && n.actionable && !n.inert
      && navLandmarks.has(n.landmark ?? ''))
    .flatMap((n) => (n.name ? [n.name] : []));

  return { landmarks, outline, trail, views: [...new Set(views)] };
}

/**
 * The one join between authored outline identity and the projected heading node.
 *
 * `index.ts` (section retrieval targets) and `tools.ts` (outline section rows)
 * both performed this join with hand-written `nodes.find()` predicates —
 * O(outline × nodes) each, spelled twice, and two chances to disagree about
 * which node an outline entry means. First heading per identity wins, matching
 * the find() semantics both consumers had.
 */
export const outlineKey = (landmark: string | null, headingPath: string[]): string =>
  `${landmark ?? ''}\u0000${headingPath.join('\u001f')}`;

export function headingNodeIndex(projection: Projection): Map<string, ProjectedNode> {
  const map = new Map<string, ProjectedNode>();
  for (const n of projection.nodes) {
    if (!n.isHeading) continue;
    const key = outlineKey(n.landmark, n.headingPath);
    if (!map.has(key)) map.set(key, n);
  }
  return map;
}

/**
 * What a full accessibility-tree dump of this page would have cost, in tokens.
 *
 * Reported so an agent (and the evaluation harnesses) can see the saving rather
 * than take it on faith — and so `describe_app` can decline to answer at all
 * when the page is small enough that dumping it would genuinely be cheaper.
 */
export function treeTokens(nodes: ProjectedNode[], charsPerToken: number): number {
  let chars = 0;
  for (const n of nodes) {
    chars += (n.role?.length ?? 0) + (n.name?.length ?? 0) + (n.text?.length ?? 0) + 6;
  }
  return Math.ceil(chars / charsPerToken);
}
