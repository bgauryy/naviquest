// Minimal implicit-role mapping. A production build uses `aria-query`;
// this covers the elements that actually carry meaning for an agent.
//
// `dd`/`dt` are here because the axe-core oracle found them missing on its first
// live run: 24 definition-list entries on the Wikipedia article projected as
// `generic` where axe asserts `definition`. Description lists are how reference
// pages mark up term-and-explanation content, which is precisely the content an
// agent searches for — so a wrong role there costs retrieval, not tidiness.
// See `yarn eval --only roles` / docs/EVAL.md § 7b.
const BY_TAG: Record<string, (el: Element) => string> = {
  a: (el) => (el.hasAttribute('href') ? 'link' : 'generic'),
  article: () => 'article', aside: () => 'complementary', button: () => 'button',
  dd: () => 'definition', dt: () => 'term',
  dialog: () => 'dialog', details: () => 'group', fieldset: () => 'group',
  figure: () => 'figure', footer: (el) => (inSectioning(el) ? 'generic' : 'contentinfo'),
  form: () => 'form', h1: () => 'heading', h2: () => 'heading', h3: () => 'heading',
  h4: () => 'heading', h5: () => 'heading', h6: () => 'heading',
  header: (el) => (inSectioning(el) ? 'generic' : 'banner'),
  hr: () => 'separator', img: (el) => (el.getAttribute('alt') === '' ? 'presentation' : 'img'),
  li: () => 'listitem', main: () => 'main', nav: () => 'navigation',
  ol: () => 'list', ul: () => 'list', option: () => 'option', output: () => 'status',
  p: () => 'paragraph', progress: () => 'progressbar',
  section: (el) => (hasAuthorName(el) ? 'region' : 'generic'),
  select: (el) => ((el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? 'listbox' : 'combobox'),
  summary: () => 'button', table: () => 'table',
  tbody: () => 'rowgroup', thead: () => 'rowgroup', tfoot: () => 'rowgroup',
  td: () => 'cell', textarea: () => 'textbox', th: (el) => thRole(el),
  tr: () => 'row', search: () => 'search', dfn: () => 'term',
};
/**
 * Verified against Chrome's own accessibility tree via CDP `getFullAXTree`
 * rather than transcribed from html-aria, because the two disagree and it is
 * the tree an agent's other tools will see.
 *
 * Three of these are deliberate divergences from html-aria's
 * "no corresponding role", and each is a decision about ACTIONABILITY:
 *
 *   file    html-aria: none. Chrome: `button`. It opens a picker — button.
 *   hidden  html-aria: none. Chrome: IGNORED. Nothing to address; `generic`
 *           keeps it out of INTERACTIVE, which is the whole point.
 *   password / date / time / month / week / color
 *           html-aria: none. Chrome: `textbox`, or a native non-ARIA role
 *           (`Date`, `DateTime`, `ColorWell`, `InputTime`) that no agent
 *           vocabulary knows. An agent types into all of them, so they are
 *           reported as `textbox` — the closest role that stays actionable.
 */
const INPUT_ROLE: Record<string, string> = {
  button: 'button', submit: 'button', reset: 'button', image: 'button',
  file: 'button', hidden: 'generic',
  checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
  search: 'searchbox', email: 'textbox', tel: 'textbox', text: 'textbox',
  url: 'textbox', password: 'textbox', date: 'textbox', 'datetime-local': 'textbox',
  time: 'textbox', month: 'textbox', week: 'textbox', color: 'textbox',
};
/** A `list` attribute turns five of the text types into a combobox — verified
 *  in Chrome's AX tree, and the one input nuance html-aria and Chrome agree on. */
const LIST_COMBOBOX = new Set(['text', 'search', 'tel', 'url', 'email']);
/**
 * Three sets that were three separate `SECTIONING` constants in three modules,
 * each subtly different and all sharing one name — the shape a real bug grows in.
 * They answer three different questions, so they are named for the questions.
 */
import type { States } from '../types.ts';
import { LANDMARK_ROLES, WIDGET_ROLES, VALID_ROLES } from './aria-taxonomy.ts';
import { idRefTarget, isFocused } from './dom.ts';
/**
 * What takes <header>/<footer> out of being a landmark.
 *
 * `MAIN` belongs here and was missing: Chrome reports a `<footer>` inside
 * `<main>` as `sectionfooter`, NOT `contentinfo`, so every article footer on
 * every page was being promoted to a page-level landmark. The role list is the
 * other half of the same rule — an element with `role="main"` scopes a footer
 * exactly as a `<main>` element does.
 *
 * (ARIA 1.3 names these `sectionheader`/`sectionfooter`, which is what Chrome
 * emits. We report `generic`, which is what html-aria documents and what the
 * rest of this file's vocabulary expects.)
 */
const HTML_SECTIONING = new Set(['ARTICLE', 'ASIDE', 'MAIN', 'NAV', 'SECTION']);
const SECTIONING_ROLES = new Set(['article', 'complementary', 'main', 'navigation', 'region']);
/** Where a heading's scope stops when climbing out of wrapper elements. */
export const SCOPE_BOUNDARY = new Set(['SECTION', 'ARTICLE', 'ASIDE', 'NAV', 'MAIN', 'BODY', 'DIALOG', 'FORM']);
/** Where a chunk's region stops when looking for the controls that belong to it.
 *  Includes list rows, because a row IS a region for this purpose. */
export const REGION_BOUNDARY = new Set([...SCOPE_BOUNDARY, 'LI', 'TR']);

/**
 * `<th>` is not always a column header, and calling it one was wrong on every
 * row-headed table — found by the axe-core oracle on the Wikipedia article,
 * where axe asserts `rowheader` and the projection said `columnheader`.
 *
 * HTML-AAM resolves this from `scope`, and where `scope` is absent, from
 * position. The positional case is the common one in real markup: a `<th>` that
 * leads a row whose other cells are `<td>` is heading that ROW.
 */
function thRole(el: Element): string {
  const scope = (el.getAttribute('scope') || '').toLowerCase();
  if (scope === 'row' || scope === 'rowgroup') return 'rowheader';
  if (scope === 'col' || scope === 'colgroup') return 'columnheader';
  const row = el.parentElement;
  if (row?.tagName === 'TR' && row.firstElementChild === el && row.querySelector('td')) return 'rowheader';
  return 'columnheader';
}

function inSectioning(el: Element): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (HTML_SECTIONING.has(p.tagName)) return true;
    if (SECTIONING_ROLES.has(explicitRole(p) ?? '')) return true;
  }
  return false;
}

/** The first token of an explicit `role`, or null. */
const explicitRole = (el: Element): string | null =>
  (el.getAttribute?.('role') || '').trim().split(/\s+/)[0] || null;

/**
 * Does this element carry an AUTHOR-supplied accessible name?
 *
 * `<section>` maps to `region` only when named, and `region` takes its name
 * from the author alone (`aria-label`/`aria-labelledby`/`title`) — never from
 * its contents. So attribute inspection is the entire algorithm here, not an
 * approximation of one, and this file stays free of the accname dependency.
 */
function hasAuthorName(el: Element): boolean {
  if ((el.getAttribute?.('aria-label') || '').trim()) return true;
  if ((el.getAttribute?.('title') || '').trim()) return true;
  // Element reflection first: it carries references that no `id` can express.
  const reflected = (el as Element & { ariaLabelledByElements?: Element[] }).ariaLabelledByElements;
  if (reflected?.length) return reflected.some((e) => (e.textContent || '').trim());
  const ref = (el.getAttribute?.('aria-labelledby') || '').trim();
  if (!ref) return false;
  return ref.split(/\s+/).some((id) => {
    const t = idRefTarget(el, id);
    return !!(t?.textContent || '').trim();
  });
}

/**
 * Derived from the ARIA superclass chain, not typed by hand — see
 * `aria-taxonomy.ts`. The hand list had 8 entries and silently dropped
 * every DPUB landmark (`doc-chapter`, `doc-bibliography`, …), which is exactly
 * the vocabulary reference and documentation pages use.
 */
export const LANDMARKS = new Set(LANDMARK_ROLES);


/**
 * "An agent can act on this ELEMENT" — a narrower question than "is this a
 * widget", and the gap between the two is where the naive derivation fails.
 *
 * The superclass chain gives 34 widget roles. Nineteen of those are additions
 * the hand list of 15 was missing and should have had (`menuitemcheckbox`,
 * `menuitemradio`, `scrollbar`, the DPUB link roles). But `gridcell`,
 * `columnheader`, `rowheader` and `row` also inherit `widget` — so a raw swap
 * would enter EVERY CELL OF EVERY TABLE into the control index, and
 * `progressbar` would offer an agent a read-only meter to click.
 *
 * So the set is derived and then narrowed, and the narrowing is a RETRIEVAL
 * decision rather than a taxonomy fact, which is why it is spelled out here
 * instead of hidden in the generator:
 *
 *   - table structure (`gridcell`, `row`, `columnheader`, `rowheader`) is
 *     addressed as a row, not as a control — see ROW_ROLES;
 *   - composite containers (`grid`, `menu`, `menubar`, `tablist`, `tree`,
 *     `treegrid`, `radiogroup`) are the thing that HOLDS controls; an agent
 *     acts on their descendants;
 *   - `progressbar` takes no user input.
 *
 * `listbox` and `combobox` stay: both are single controls a user opens.
 */
const NOT_INDIVIDUALLY_ACTIONABLE = new Set([
  'gridcell', 'row', 'columnheader', 'rowheader',
  'grid', 'menu', 'menubar', 'tablist', 'tree', 'treegrid', 'radiogroup',
  'progressbar',
]);
export const INTERACTIVE = new Set(WIDGET_ROLES.filter((r) => !NOT_INDIVIDUALLY_ACTIONABLE.has(r)));

const VALID = new Set(VALID_ROLES);

export function roleOf(el: Element): string {
  /**
   * `role` is a SPACE-SEPARATED FALLBACK LIST, and the first *valid* token wins
   * — not the first token. Taking the first unconditionally meant a typo
   * (`role="buton"`) produced a role no downstream set contains, so a real
   * button became invisible to `locate_control` while the browser still exposed
   * it as a button. Now an unrecognised token falls through to the next, and a
   * list of nothing but junk falls through to the implicit role, which is what
   * the browser does.
   *
   * Measured as real but rare before being written: 2 invalid tokens in 386
   * role attributes across eight live sites, both `role="text"` on youtube.com.
   * It is cheap because the taxonomy is already here.
   */
  const explicit = el.getAttribute('role');
  if (explicit) {
    for (const token of explicit.trim().split(/\s+/)) {
      if (!VALID.has(token)) continue;
      // ARIA's presentational-role conflict resolution ignores `none` and
      // `presentation` on focusable/native controls and on elements carrying a
      // global ARIA state/property. Chrome therefore exposes
      // `<button role="presentation">` as a button. Accepting the literal role
      // here erased a real action while claiming it was decorative.
      if ((token === 'none' || token === 'presentation') && presentationalConflict(el)) continue;
      return token;
    }
  }
  return implicitRole(el);
}

function presentationalConflict(el: Element): boolean {
  const implicit = implicitRole(el);
  if (INTERACTIVE.has(implicit) || el.hasAttribute('tabindex') || el.hasAttribute('contenteditable')) return true;
  for (const a of el.attributes) if (GLOBAL_ARIA.has(a.name)) return true;
  return false;
}

/** ARIA global states/properties. Role-specific attributes such as aria-level
 * do not trigger presentational-role conflict resolution. */
const GLOBAL_ARIA = new Set([
  'aria-atomic', 'aria-busy', 'aria-controls', 'aria-current', 'aria-describedby',
  'aria-description', 'aria-details', 'aria-disabled', 'aria-dropeffect',
  'aria-errormessage', 'aria-flowto', 'aria-grabbed', 'aria-haspopup', 'aria-hidden',
  'aria-invalid', 'aria-keyshortcuts', 'aria-label', 'aria-labelledby', 'aria-live',
  'aria-owns', 'aria-relevant', 'aria-roledescription',
]);

/** The host-language role with authored `role` deliberately ignored. */
function implicitRole(el: Element): string {
  if (el.localName === 'input') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    if (el.hasAttribute('list') && LIST_COMBOBOX.has(type)) return 'combobox';
    return INPUT_ROLE[type] ?? 'textbox';
  }
  const f = BY_TAG[el.localName.toLowerCase()];
  return f ? f(el) : 'generic';
}

export function headingLevel(el: Element): number {
  const m = /^H([1-6])$/.exec(el.tagName);
  if (m) return +m[1];
  const aria = el.getAttribute('aria-level');
  /**
   * ARIA puts NO ceiling on `aria-level` — a deeply nested tree or an outline
   * widget legitimately uses 7, 12, 30. Clamping to 6 collapsed every one of
   * those onto the same depth, silently merging sibling sections into one
   * heading path. Only the floor is real (`aria-level` is >= 1).
   */
  const n = Math.floor(Number(aria));
  return aria && Number.isFinite(n) && n >= 1 ? n : 2;
}

const STATE_ATTRS = ['expanded', 'checked', 'selected', 'current', 'invalid', 'disabled', 'pressed', 'busy'] as const;
export function statesOf(el: Element): States {
  const s: States = {};
  for (const k of STATE_ATTRS) {
    const v = el.getAttribute(`aria-${k}`);
    if (v !== null) s[k] = v === 'true' ? true : v === 'false' ? false : v;
  }
  const input = el as HTMLInputElement;
  if (input.disabled === true) s.disabled = true;
  if (el.tagName === 'INPUT' && (input.type === 'checkbox' || input.type === 'radio')) s.checked = input.checked;
  if (el.getAttribute('aria-required') === 'true') s.required = true;
  if (el.getAttribute('aria-readonly') === 'true') s.readOnly = true;
  if (isFocused(el)) s.focused = true;
  // Tag/property checks work for same-origin frame elements too. `instanceof`
  // against this window's constructors returns false for elements created in a
  // different realm, which made `query_selector({ frames:true })` drop native
  // required/invalid/value-presence state while still returning a confident row.
  const tag = el.localName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    if (input.required) s.required = true;
    if (input.readOnly) s.readOnly = true;
    // Boolean presence gives an agent the state needed to continue a form while
    // never exposing passwords or user-entered text through a read-only sensor.
    const type = input.type.toLowerCase();
    if (tag === 'textarea') s.valuePresent = input.value.length > 0;
    else if (type === 'checkbox' || type === 'radio') s.valuePresent = input.checked;
    else if (type === 'file') s.valuePresent = (input.files?.length ?? 0) > 0;
    else if (!['button', 'submit', 'reset', 'image'].includes(type)) {
      s.valuePresent = input.value.length > 0;
    }
    if (input.willValidate && !input.validity.valid) s.invalid = true;
  } else if (tag === 'select') {
    const select = el as HTMLSelectElement;
    if (select.required) s.required = true;
    s.valuePresent = select.selectedIndex >= 0 && select.value.length > 0;
    if (select.willValidate && !select.validity.valid) s.invalid = true;
  }
  return s;
}
