/**
 * CSS Custom Highlight API — shows a retrieved region WITHOUT mutating the host
 * DOM. Nothing else on the platform can do this.
 *
 * StaticRange, not Range: the Highlight spec prefers it when the author
 * observes DOM changes themselves, because live Ranges are fixed up by the
 * engine on EVERY mutation — thousands of them on a React page is a
 * self-inflicted performance problem.
 *
 * PER INSTANCE, not per module. `CSS.highlights` is a document-global registry
 * keyed by name, so two SDK instances sharing one name clobber each other's
 * ranges — and a host that installs Naviquest in an embedded widget as well as
 * the page shell has two. The first instance keeps the documented
 * `::highlight(naviquest-hit)` selector so existing stylesheets are unaffected;
 * later ones are suffixed.
 */
const BASE = 'naviquest-hit';
let instances = 0;

let supported = false;
// All three are needed and all three are checked. `Highlight` was assumed to
// ship wherever `CSS.highlights` does — true in every engine today, but a
// feature test that assumes is just a comment.
try {
  supported = typeof CSS !== 'undefined' && !!CSS.highlights
    && typeof StaticRange === 'function' && typeof Highlight === 'function';
} catch { /* older engine */ }

export interface Highlighter {
  /** The `::highlight()` name this instance writes to. */
  readonly name: string;
  highlight(elements: Array<Element | null | undefined>): boolean;
  clear(): void;
}

export const highlightSupported = (): boolean => supported;

export function createHighlighter(): Highlighter {
  const name = instances++ === 0 ? BASE : `${BASE}-${instances}`;
  return {
    name,
    highlight(elements) {
      if (!supported) return false;
      const hl = new Highlight();
      for (const el of elements) {
        if (!el) continue;
        for (const n of el.childNodes) {
          const value = n.nodeValue;
          if (n.nodeType === 3 && value?.trim()) {
            try {
              hl.add(new StaticRange({
                startContainer: n, startOffset: 0, endContainer: n, endOffset: value.length,
              }));
            } catch { /* a range the engine rejects is one region not shown, not a failure */ }
          }
        }
      }
      CSS.highlights.set(name, hl);
      return true;
    },
    clear() { if (supported) CSS.highlights.delete(name); },
  };
}
