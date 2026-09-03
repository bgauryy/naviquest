/**
 * What the projection could NOT see, said plainly.
 *
 * The honesty contract in one function. An agent that believes it saw the whole
 * page and did not is worse off than one told the view is partial, because only
 * the second knows to fall back to a screenshot.
 */
import type { Coverage } from '../types.ts';

export function coverageNote(c: Coverage): string {
  const parts: string[] = [];
  if (c.unknownRoots) {
    parts.push(`${c.unknownRoots} custom-element host(s) expose no open shadow root. Their light DOM was inspected; page JavaScript cannot distinguish “no shadow root” from an unregistered closed root, so component completeness is unknown rather than scored as missing.`);
  }
  if (c.elementsInspectedPct < 100) {
    parts.push(`The selected index root covers ${c.elementsInspectedPct}% of document elements (${c.rootElements}/${c.documentElements}); ${c.framesOutsideRoot} iframe(s) sit outside it. Results describe the selected root, not the whole document.`);
  }
  if (c.unindexedFrameDocuments) {
    parts.push(`${c.unindexedFrameDocuments} readable frame document(s) inside the selected root are available to exact scope inspection but absent from the semantic index; use query_selector({ view: "scopes" }) or a frame-local SDK.`);
  }
  if (c.virtualizedCollections) {
    const known = c.offDomRowsDeclared
      ? `${c.offDomRowsDeclared} declared row(s) are currently outside the DOM and absent from search.` : '';
    const knownItems = c.offDomItemsDeclared
      ? `${c.offDomItemsDeclared} declared set item(s) are currently outside the DOM and absent from search.` : '';
    const unknown = c.unknownSizeCollections
      ? `${c.unknownSizeCollections} collection(s) declare that more rows exist but not how many.` : '';
    parts.push(`${c.virtualizedCollections} ARIA-declared partial collection(s) are only a rendered window. ${known} ${knownItems} ${unknown} Scroll or use the collection's controls to load another window before concluding an item is absent.`.replace(/\s+/g, ' ').trim());
  }
  if (c.opaqueComponents) {
    parts.push(`${c.opaqueComponents} component(s) carry no role, name or text readable from outside; their semantics are likely set through ElementInternals, which no page API can read${c.opaqueInteractive ? `, and ${c.opaqueInteractive} of those are focusable and so probably controls` : ''}. Treat the control list as incomplete here and fall back to a screenshot if an expected control is missing.`);
  }
  if (c.revealPending) {
    // Deliberately not asserting these are ALL scroll-reveal: the held-out
    // sweep found 794 chars that stayed hidden after a full scroll, and no
    // index-time property separates the two (project.ts § revealPending).
    parts.push(`${c.revealPending} readable passage(s) (~${c.revealPendingChars} chars) are in the accessibility tree but hidden by opacity alone — usually a scroll-reveal animation that has not fired, sometimes a genuinely closed panel — so they are absent from this index. Scroll them into view and query again, or read the page directly, before concluding the page does not say something.`);
  }
  if (c.malformedStructuredData) {
    parts.push(`${c.malformedStructuredData} JSON-LD block(s) on this page do not parse, so the facts they declare are absent from the index even though the page asserts them. Read the region directly before concluding a declared fact is missing.`);
  }
  if (c.nameComputeFailures) {
    parts.push(`${c.nameComputeFailures} element(s) threw during accessible-name computation and are indexed UNNAMED. A name-based lookup cannot reach them; locate them by role or by surrounding text instead.`);
  }
  return parts.length ? parts.join(' ') : 'All components inspected.';
}
