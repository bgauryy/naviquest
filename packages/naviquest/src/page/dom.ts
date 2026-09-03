/**
 * Browser tree primitives shared by projection, modality and exact inspection.
 *
 * The DOM has more than one useful tree. `parentElement` describes the light
 * tree, while visibility, inertness and rendered interaction follow the flat
 * tree through slots and shadow hosts. ID references are different again: an
 * authored `aria-labelledby="x"` is resolved in the element's own tree unless
 * the platform exposes an Element-valued reflection such as
 * `ariaLabelledByElements`. Keeping those questions separate prevents a shadow
 * component from inheriting the wrong label, or escaping an inert/excluded host.
 */

/** The parent that renders this element: slot, light parent, or shadow host. */
export function flatParentElement(el: Element): Element | null {
  if (el.assignedSlot) return el.assignedSlot;
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode?.() as Node & { host?: Element };
  return root?.host ?? null;
}

/** Flat-tree containment, used for interaction and privacy boundaries. */
export function flatContains(ancestor: Element, node: Element): boolean {
  for (let p: Element | null = node; p; p = flatParentElement(p)) {
    if (p === ancestor) return true;
  }
  return false;
}

export function flatClosest(el: Element, selector: string): Element | null {
  for (let p: Element | null = el; p; p = flatParentElement(p)) {
    try { if (p.matches(selector)) return p; } catch { return null; }
  }
  return null;
}

/**
 * Resolve an authored IDREF in its own DocumentOrShadowRoot.
 *
 * Falling back from a shadow root to `document.getElementById()` is confidently
 * wrong when the document happens to reuse the id: string IDREFs do not pierce
 * a shadow boundary. Cross-root relationships use the browser's Element-valued
 * ARIA reflection and are read by the callers before reaching this fallback.
 */
export function idRefTarget(el: Element, id: string): Element | null {
  const root = el.getRootNode?.() as (Document | ShadowRoot) & {
    getElementById?: (value: string) => Element | null;
  };
  return root?.getElementById?.(id) ?? null;
}

/** `:focus` is realm- and shadow-safe; global `document.activeElement` is not. */
export function isFocused(el: Element): boolean {
  try { return el.matches(':focus'); } catch { return false; }
}

const isShadowRoot = (node: ParentNode): node is ShadowRoot =>
  node.nodeType === 11 && 'host' in node;

/**
 * Every queryable tree reachable through open shadow roots, plus registered
 * closed roots handed in by their owning component. CSS selectors are scoped
 * to one tree by design; callers query each returned root rather than pretending
 * `document.querySelectorAll()` pierces encapsulation.
 */
export function queryRoots(start: ParentNode,
                           extra: readonly ShadowRoot[] = []): ParentNode[] {
  const out: ParentNode[] = [];
  const stack: ParentNode[] = [start, ...extra];
  const seen = new Set<ParentNode>();
  while (stack.length) {
    const root = stack.pop()!;
    if (seen.has(root)) continue;
    seen.add(root);
    out.push(root);
    if (root.nodeType === 1 && (root as Element).shadowRoot) {
      stack.push((root as Element).shadowRoot!);
    }
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot && !seen.has(el.shadowRoot)) stack.push(el.shadowRoot);
    }
  }
  return out;
}

export interface QueryScope {
  root: Document | ShadowRoot;
  /** Stable only for this traversal, like a result offset. */
  path: string;
  kind: 'document' | 'shadow';
  frameDepth: number;
  shadowDepth: number;
  frameLabel?: string;
  /** Embedding element in the parent tree; internal provenance, not an address. */
  frame?: Element;
  host?: Element;
  registered?: boolean;
}

export interface UnreachableFrame {
  path: string;
  label: string;
  reason: 'unavailable' | 'excluded';
}

export interface QueryScopesOptions {
  extra?: readonly ShadowRoot[];
  frames?: boolean;
  /** A caller can preserve its privacy boundary before entering another tree. */
  enter?: (boundary: Element) => boolean;
}

/**
 * Enumerate every DOM query scope page JavaScript can actually enter.
 *
 * Neither selectors nor tree walkers cross a DocumentOrShadowRoot boundary.
 * Keeping the boundary walk here gives exact inspection one authority for all
 * four combinations that matter: shadow-in-frame, frame-in-shadow, nested
 * frames, and registered closed roots. The walk tests `contentDocument`
 * directly because URL/origin comparisons are not an access check: `srcdoc`
 * and initial `about:blank` inherit origin, while sandboxing can make a
 * same-looking URL opaque.
 *
 * Scope paths are traversal addresses, not CSS selectors and not durable page
 * addresses. They deliberately use local ordinals so arbitrary author strings
 * cannot turn provenance into an unbounded payload; the author label is kept
 * separately for agent orientation.
 */
export function queryScopes(start: Document,
                            options: QueryScopesOptions = {}): {
  scopes: QueryScope[];
  unreachableFrames: UnreachableFrame[];
} {
  const scopes: QueryScope[] = [];
  const unreachableFrames: UnreachableFrame[] = [];
  const seen = new Set<Document | ShadowRoot>();
  const extras = new Set(options.extra ?? []);
  const extrasByHost = new Map<Element, ShadowRoot[]>();
  for (const root of extras) {
    const roots = extrasByHost.get(root.host) ?? [];
    roots.push(root);
    extrasByHost.set(root.host, roots);
  }

  const frameLabel = (el: Element, ordinal: number): string =>
    el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('id')
      || `${el.localName}[${ordinal}]`;

  const visit = (root: Document | ShadowRoot, path: string, frameDepth: number,
                 shadowDepth: number, meta: Partial<QueryScope> = {}) => {
    if (seen.has(root)) return;
    seen.add(root);
    scopes.push({ root, path, kind: root.nodeType === 9 ? 'document' : 'shadow',
                  frameDepth, shadowDepth, ...meta });

    let shadowOrdinal = 0;
    let frameOrdinal = 0;
    for (const el of root.querySelectorAll('*')) {
      const shadowCandidates = [
        ...(el.shadowRoot ? [el.shadowRoot] : []),
        ...(extrasByHost.get(el) ?? []),
      ];
      for (const shadow of shadowCandidates) {
        const ordinal = shadowOrdinal++;
        if (options.enter && !options.enter(el)) continue;
        visit(shadow, `${path}/shadow[${ordinal}]`, frameDepth, shadowDepth + 1,
              // Projection.shadowRoots contains both discovered open roots and
              // host-granted closed roots. `mode` is the browser fact that
              // distinguishes them; membership in `extra` alone does not.
              { host: el, registered: shadow.mode === 'closed' && extras.has(shadow),
                frameLabel: meta.frameLabel });
      }

      if (!options.frames || (el.localName !== 'iframe' && el.localName !== 'frame')) continue;
      const ordinal = frameOrdinal++;
      const framePath = `${path}/frame[${ordinal}]`;
      const label = frameLabel(el, ordinal);
      if (options.enter && !options.enter(el)) {
        unreachableFrames.push({ path: framePath, label, reason: 'excluded' });
        continue;
      }
      try {
        const doc = (el as HTMLIFrameElement).contentDocument;
        if (doc?.documentElement) {
          visit(doc, framePath, frameDepth + 1, shadowDepth,
                { frameLabel: label, frame: meta.frame ?? el });
        } else {
          unreachableFrames.push({ path: framePath, label, reason: 'unavailable' });
        }
      } catch {
        unreachableFrames.push({ path: framePath, label, reason: 'unavailable' });
      }
    }
  };

  visit(start, 'document', 0, 0);

  // A component may register a closed root before its host is connected. Keep
  // it queryable rather than silently dropping a capability the host granted.
  let detachedOrdinal = 0;
  for (const root of extras) {
    if (!seen.has(root)) {
      visit(root, `registered[${detachedOrdinal++}]`, 0, 1,
            { host: root.host, registered: root.mode === 'closed' });
    }
  }
  return { scopes, unreachableFrames };
}

/** Focus descends through open shadow roots; Document.activeElement alone stops at the host. */
export function deepActiveElement(root: Document | ShadowRoot = document): Element | null {
  let active = root.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

export function isQueryableShadowRoot(node: ParentNode): node is ShadowRoot {
  return isShadowRoot(node);
}
