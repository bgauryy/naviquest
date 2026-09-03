import { deepActiveElement, flatContains, flatParentElement, idRefTarget, queryRoots } from './dom.ts';
import { readingOrderText } from './page-text.ts';

/**
 * The only reliable read of modality. `element.inert` does NOT reflect
 * inherited inertness, so we walk ancestors; and CloseWatcher is the wrong tool
 * entirely (it creates close behaviour, it doesn't detect someone else's modal).
 *
 * PERF: detectModal() must be called ONCE per projection pass and the result
 * threaded through. Calling document.querySelector(':modal') per element made
 * projection O(n²) — measured at 165 ms for 6k elements before this was hoisted.
 */
/** A dialog with no accessible name is usually titled by the first heading it
 *  contains. Kept as a constant so the fallback is visible rather than inline. */
const HEADING_SELECTOR = 'h1, h2, h3, [role=heading]';

const labelledName = (el: Element | null | undefined): string | null => {
  if (!el) return null;
  const t = readingOrderText(el);
  return t || null;
};

/**
 * `:modal` is NOT a synonym for "a modal dialog is open", and both directions
 * of that assumption were wrong here.
 *
 * It also matches the FULLSCREEN element (the spec lists `:fullscreen` opened
 * via `requestFullscreen()` alongside `showModal()`). Verified in Chromium: a
 * fullscreen `<video>` matched `:modal`, so every control on the page was
 * reported `inert` and `modalState()` announced that the rest of the page could
 * not be activated. Fullscreen hides the page; it does not make it inert, and a
 * user watching a video has not removed the page's controls from existence.
 *
 * The old fallback failed the other way: `dialog[open]` matches a dialog opened
 * with `.show()` or the `open` attribute, which is explicitly NON-modal — it
 * does not enter the top layer and does not make anything inert. Also verified:
 * `.show()` produced a DIALOG match and the same false inertness. The fallback
 * now accepts only author-declared modality, which cannot lie by accident.
 */
export interface ModalDetection {
  element: Element | null;
  candidates: number;
  ambiguous: boolean;
}

export function detectModal(extraRoots: readonly ShadowRoot[] = []): ModalDetection {
  const candidates: Element[] = [];
  // Selectors are scoped to one tree. Query every reachable open shadow root
  // and every closed root registered by its owner; otherwise a real modal web
  // component leaves outside controls incorrectly actionable.
  const roots = queryRoots(document, extraRoots);
  for (const root of roots) {
    try {
      for (const el of root.querySelectorAll(':modal')) {
        if (el === document.fullscreenElement) continue;
        candidates.push(el);
      }
    } catch { /* engine without :modal — fall through */ }
  }
  if (!candidates.length) {
    for (const root of roots) {
      for (const el of root.querySelectorAll<Element>('[role="dialog"][aria-modal="true"]')) {
        // `aria-modal` declares semantics; unlike `dialog.showModal()`, it does
        // not prove the dialog is active. Vercel and GitHub keep inactive dialog
        // templates in the DOM. Treating those as open marked every otherwise
        // trial-clickable control inert. Hidden/aria-hidden author-declared
        // dialogs are not modality candidates.
        if (el.closest('[aria-hidden="true"]')) continue;
        try {
          if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
          // getClientRects, not offsetParent: modals are almost always
          // position:fixed, for which offsetParent is null (MDN) — the old
          // fallback rejected exactly the elements this loop screens FOR.
        } catch {
          if (!el.getClientRects().length) continue;
        }
        candidates.push(el);
      }
    }
  }
  if (candidates.length <= 1) {
    return { element: candidates[0] ?? null, candidates: candidates.length, ambiguous: false };
  }
  // Selector results are tree ordered, not top-layer ordered. Modal focusing
  // steps put focus in the topmost dialog, even when dialogs were opened in the
  // opposite order from their DOM positions, so use browser-maintained focus
  // instead of a DOM-order guess.
  const focused = deepActiveElement();
  const focusedModal = focused && candidates.find((c) => flatContains(c, focused));
  return focusedModal
    ? { element: focusedModal, candidates: candidates.length, ambiguous: false }
    : { element: null, candidates: candidates.length, ambiguous: true };
}

export function isInertUnder(el: Element, modal: Element | null): boolean {
  for (let p: Element | null = el; p; p = flatParentElement(p)) if (p.hasAttribute?.('inert')) return true;
  if (!modal) return false;
  return !flatContains(modal, el);
}

export function modalState(input: Element | ModalDetection | null): Record<string, unknown> {
  const detection: ModalDetection = input && 'element' in input
    ? input as ModalDetection
    : { element: input as Element | null, candidates: input ? 1 : 0, ambiguous: false };
  if (detection.ambiguous) return {
    modal: true,
    ambiguous: true,
    candidates: detection.candidates,
    note: 'Several modal dialogs are open and focus does not identify the topmost one. Control inertness is withheld rather than guessed; inspect the dialogs or use vision.',
  };
  const modal = detection.element;
  if (!modal) return { modal: false };
  return {
    modal: true,
    name: modal.getAttribute('aria-label')
      || labelledName(idRefTarget(modal, modal.getAttribute('aria-labelledby') || ''))
      || labelledName(modal.querySelector(HEADING_SELECTOR)) || null,
    note: 'The rest of the page is inert. Controls outside this dialog cannot be activated.',
  };
}
