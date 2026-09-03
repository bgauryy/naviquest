/**
 * The one page-text derivation, in its own module because four modules need it
 * and three of them are imported BY `project.ts` (importing back would cycle).
 *
 * A second TreeWalker is how `query_selector` came to glue `permitClosed` while
 * `find_on_page` spaced the same sentence. There is one join; everything that
 * emits what the user can read calls it.
 *
 * `textContent` stays rejected: it ignores the exclusion contract and glues
 * adjacent text nodes into tokens that were never on the page.
 */

/** Hoisted: this runs once per phrasing element on the walk, and rebuilding the
 *  set inside the call allocated one per element on a 6k-element page. */
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA']);

/** Text nodes in tree order, spaced. Same join as row labels — never glue tokens. */
export function readingOrderText(el: Element, skipEl?: (e: Element) => boolean): string {
  const skip = SKIP;
  const parts: string[] = [];
  const tw = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node as Text;
      if (text.assignedSlot) return NodeFilter.FILTER_REJECT;
      for (let p = text.parentElement; p; p = p.parentElement) {
        if (skip.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (skipEl && p !== el && skipEl(p)) return NodeFilter.FILTER_REJECT;
        if (p === el) break;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const t = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
    if (t) parts.push(t);
  }
  return parts.join(' ');
}
