/**
 * Addresses are RE-QUERYABLE DESCRIPTIONS, not pointers.
 *
 * Every shipped agent tool holds a pointer and it dies: Playwright's `ref=e5`
 * is a JS expando on the node, so React reconciliation silently kills it;
 * chrome-devtools-mcp's `uid` is positional and renumbers every snapshot.
 * A (landmark, headingPath, role, name, ordinal) tuple survives node
 * replacement because it never depended on node identity — and it degrades to
 * recoverable AMBIGUOUS rather than a dangling reference.
 *
 * Resolution is lazy, at action time. No live index of nodes is maintained.
 */
import type { Address, ProjectedNode, Projection, Resolution } from '../types.ts';
import type { AddressTuning } from '../config.ts';
import { DEFAULTS } from '../config.ts';
import { INTERACTIVE } from '../page/roles.ts';

/**
 * The address tunables, taken from the CALLER's resolved config.
 *
 * This module used to bind `const A = DEFAULTS.address` once at load time, so a
 * host that passed `tuning: { address: { … } }` got a config object reporting
 * its override and behaviour that ignored it — silently, and in contradiction of
 * the documented promise that any tunable is overridable at any depth.
 * `resolveConfig()` was merging the namespace correctly; nothing ever read the
 * result. The default keeps every existing caller working.
 */
export function addressOf(n: ProjectedNode, ordinal?: number, peerCount?: number): Address {
  return {
    // Frame provenance first, present only for a merged same-origin frame node,
    // so an address in a frame carries its own document identity.
    ...(n.frame ? { frame: n.frame } : {}),
    landmark: n.landmark ?? null,
    landmarkName: n.landmarkName ?? null,
    headingPath: n.headingPath.slice(),
    // The row's own text, when this element sits in one. Three identical
    // "Toggle Todo" checkboxes are told apart by their row and nothing else —
    // an ordinal into a list that reorders is not an identity.
    row: n.row ?? null,
    role: n.role,
    name: n.name || null,
    ordinal: ordinal ?? 0,
    // How many identical siblings existed when this address was minted. An
    // ordinal into a list that has since changed is NOT an identity — without
    // this, deleting an earlier sibling silently shifts every later ordinal
    // onto a different element.
    peerCount: peerCount ?? 1,
  };
}

/** Heading-path equality. One definition — index.js had an identical `sameHead`. */
export const samePath = (a: string[] = [], b: string[] = []): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
// An address minted before rows existed carries row:undefined; treat that as
// "don't care" so old addresses keep resolving, but never let a row-bearing
// address match a control in a DIFFERENT row.
const sameRow = (n: ProjectedNode, address: Address) => address.row == null || (n.row ?? null) === address.row;

/** Identity fields that never relax. Heading path is deliberately separate:
 * it is the sole field the fallback below may weaken. */
const sameBase = (n: ProjectedNode, address: Address): boolean => n.el.isConnected
  && n.role === address.role
  && (n.name || null) === address.name
  && (n.landmark ?? null) === address.landmark
  && (n.landmarkName ?? null) === (address.landmarkName ?? null)
  // A frame node and a top-document node with otherwise identical fields are
  // NOT the same element — the frame path is part of identity.
  && (n.frame ?? undefined) === (address.frame ?? undefined)
  && sameRow(n, address);

const mint = (list: ProjectedNode[]): Address[] => list.map((n, i) => addressOf(n, i, list.length));

export function resolve(address: Address | null | undefined, projection: Projection,
                        A: AddressTuning = DEFAULTS.address): Resolution {
  // Callers include agents. An agent that passes nothing, or a half-built
  // address it assembled itself, must get the same structured answer as one
  // that passes a stale address — never a TypeError.
  if (!address || typeof address !== 'object') {
    return {
      status: 'NOT_FOUND',
      nearest: [],
      hint: 'No address supplied. Pass the `address` object returned by find_on_page or locate_control.',
    };
  }
  if (!Array.isArray(address.headingPath)) address = { ...address, headingPath: [] };

  const exact = projection.nodes.filter(
    (n) => sameBase(n, address) && samePath(n.headingPath, address.headingPath),
  );

  // The fast path still checks the ordinal: with one peer the only valid ordinal
  // is 0, and an agent-assembled `{ordinal: 5, peerCount: 1}` must fall through
  // to the range check below rather than resolve to element 0.
  if (exact.length === 1 && (address.peerCount ?? 1) <= 1 && (address.ordinal ?? 0) === 0) {
    return { status: 'RESOLVED', element: exact[0].el, node: exact[0] };
  }
  if (exact.length >= 1) {
    // The ordinal only means anything if the peer set is unchanged. If siblings
    // were added or removed, ordinal N now points at a different element, so we
    // report ambiguity rather than acting on the wrong one.
    if (exact.length !== (address.peerCount ?? exact.length)) {
      return {
        status: 'AMBIGUOUS',
        candidates: mint(exact).slice(0, A.ambiguousCandidates),
        hint: `The set of matching elements changed since this address was created `
          + `(${address.peerCount} then, ${exact.length} now), so the ordinal is no longer reliable. `
          + `Re-run the search or pick a candidate.`,
      };
    }
    const pick = exact[address.ordinal];
    if (pick) return { status: 'RESOLVED', element: pick.el, node: pick };
    return {
      status: 'AMBIGUOUS',
      candidates: mint(exact).slice(0, A.ambiguousCandidates),
      hint: `${exact.length} elements match; ordinal ${address.ordinal} is out of range.`,
    };
  }

  // Nothing matched exactly. Relaxation MUST NOT cross a landmark boundary:
  // resolving a "Submit" in a deleted section onto a different section's
  // "Submit" is precisely the confidently-wrong outcome this design exists to
  // prevent. We relax the heading path only, and only within the same landmark.
  const sameLandmark = projection.nodes.filter(
    (n) => sameBase(n, address),
  );
  if (sameLandmark.length === 1) {
    const n = sameLandmark[0];
    // Even inside one landmark, require the heading path to share a prefix —
    // otherwise this is a different part of the page wearing the same label.
    if (sharesPrefix(n.headingPath, address.headingPath)) {
      return { status: 'RESOLVED', element: n.el, node: n, relaxed: true,
               note: 'Heading path changed; matched within the same landmark and heading prefix.' };
    }
  }
  if (sameLandmark.length >= 1) {
    return {
      status: 'AMBIGUOUS',
      candidates: mint(sameLandmark).slice(0, A.ambiguousCandidates),
      hint: 'The original heading path is gone. Candidates share the role, name and landmark — pick one.',
    };
  }

  const nearest = projection.nodes
    .filter((n) => n.el.isConnected && n.role === address.role && n.name)
    .slice(0, A.notFoundNearest);
  /**
   * A REGION address is not a broken control address, and the hint must not
   * imply that it is.
   *
   * `find_on_page` mints a region address from the chunk's first element, which
   * is usually a paragraph, a table cell or a `generic` wrapper. `project.ts`
   * computes an accessible name only for interactive nodes, so those are
   * unnameable by construction and `resolve_address` cannot find them — that is
   * the documented F10 gap, not a defect. Such an address is for the REGION
   * path, which matches on `headingPath` and `anchorText` and does resolve it —
   * and since the read_region merge, `resolve_address` routes it there
   * automatically, so an agent reaches THIS hint only when the region itself no
   * longer matches anything (the section was removed or rewritten), or when page
   * JavaScript calls `resolve()` directly with a region address.
   *
   * The old hint said "No generic named null remains in the region landmark",
   * which tells an agent the thing DISAPPEARED. It never existed as a findable
   * element, and the agent's next move is a different tool rather than a
   * re-search. Found on a Japanese Wikipedia article, where a table-heavy page
   * mints three such addresses out of three — the English label-free set happens
   * to start most chunks with a named link and hid it.
   */
  // The address says which tool it is for, so this no longer has to guess from
  // the role. The guess was a role heuristic (`name == null && !INTERACTIVE`),
  // and an Arabic Wikipedia article broke it immediately: that page's region
  // address starts with a named link, so the heuristic said "control" and the
  // hint reverted to telling the agent a link had disappeared. The mint site
  // knows the answer; it just was not saying it.
  const unnameable = address.resolveWith === 'read_region'
    || (address.resolveWith == null && address.name == null && !INTERACTIVE.has(address.role));
  return {
    status: 'NOT_FOUND',
    nearest: mint(nearest),
    hint: unnameable
      ? `This is a REGION address (a ${address.role} carries no accessible name), and its section no `
        + 'longer matches any content on the page — it was likely removed or rewritten. Re-run '
        + 'find_on_page for fresh region addresses; to act on something, take an address from a '
        + "region's `controls` or from locate_control."
      : `No ${address.role} named ${JSON.stringify(address.name)} remains`
        + (address.landmark ? ` in the ${address.landmark} landmark.` : '.'),
  };
}

/** Do the two paths share at least their first segment (or are both empty)? */
function sharesPrefix(a: string[], b: string[]): boolean {
  if (!a.length && !b.length) return true;
  if (!a.length || !b.length) return false;
  return a[0] === b[0];
}

/**
 * A CSS selector for an element, as a LAST RESORT.
 *
 * Addresses are descriptions precisely because selectors rot, so this exists for
 * one reason: the agent's click tool lives outside the page and cannot hold a DOM
 * reference. It is generated fresh at resolve time, never stored, never used for
 * matching, and always labelled so nobody mistakes it for an identity.
 */
export function selectorOfLastResort(el: Element | null,
                                     maxDepth = DEFAULTS.address.selectorMaxDepth): string | null {
  if (!el || el.nodeType !== 1) return null;
  // Standard CSS has no selector combinator that pierces a shadow boundary.
  // Returning a bare `button` for a shadow control selected an unrelated
  // light-DOM button in a real Chromium reproduction — worse than returning no
  // selector. The address and viewport box remain valid, and page code can use
  // `resolve(address)` to receive the live Element.
  if (el.getRootNode() !== el.ownerDocument) return null;
  // The same hazard across a frame boundary: this selector is generated against
  // the element's OWN document, and an agent runs selectors at top level. A bare
  // `button` for an iframe control would select an unrelated top-document one.
  if (typeof document !== 'undefined' && el.ownerDocument !== document) return null;
  const parts: string[] = [];
  let node: Element | null = el;
  for (let i = 0; i < maxDepth && node && node.nodeType === 1; i++) {
    if (node.id && node.ownerDocument?.querySelectorAll?.(`#${CSS.escape(node.id)}`).length === 1) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      return parts.join(' > ');
    }
    const tag = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (!parent) { parts.unshift(tag); break; }
    const sameTag = [...parent.children].filter((c) => c.tagName === node!.tagName);
    parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})` : tag);
    node = parent;
  }
  return parts.join(' > ');
}
