/**
 * What a control DOES, when its name does not say so.
 *
 * Four lookups in the live gate fail under lexical ranking, dense ranking and
 * fusion alike: "go to the next page of stories" (the control is `More`), "read
 * this page in another language" (`84 languages`), "the input where I type a new
 * todo" (`What needs to be done?`), "search the bbc site". None of these are
 * vocabulary problems — no amount of string or vector similarity recovers that a
 * control *paginates*, or *is the page's primary input*. That knowledge is in the
 * markup, and it is cheap to read.
 *
 * Deliberately implemented as KEYWORD ENRICHMENT of the control's index
 * document, not as a score prior. A prior was tried and rejected — it made every
 * configuration worse (AGENTS.md, tried-and-failed: a weighted structural prior). Adding the words an author would
 * have used lets BM25 do the matching it is already good at, and it shows up in
 * the response so an agent can see why a control was offered.
 */
import type { Affordance, AffordanceHit, ProjectedNode } from '../types.ts';
import { isLanguageName } from './language.ts';
import { flatClosest, idRefTarget, queryRoots } from './dom.ts';

export type CompiledPatterns = Partial<Record<Affordance, RegExp>>;

export interface AffordanceContext {
  role: string; name: string | null; landmark: string | null;
  docLang: string; primaryInputEl: Element | null; patterns: CompiledPatterns;
  /** Pre-resolved, exclusion-safe governed targets from the projection. */
  controlled?: Element[];
}

/** Everything `controlDoc` needs — deliberately narrower than a ProjectedNode,
 *  because the harnesses build this shape by hand from labelled fixtures. */
export interface ControlDocNode {
  name: string | null; role: string; headingPath: string[];
  row: string | null; affordances?: Affordance[];
  /** Accessible name of whatever `aria-controls` points at, when it points. */
  controlsName?: string | null;
}

/**
 * Compile the host's (or the default) pattern strings once per projection.
 * Compiling per element was never the cost; carrying seven literals that no host
 * could reach was.
 */
export function compilePatterns(patterns: Partial<Record<Affordance, string>> = {}): CompiledPatterns {
  const out: CompiledPatterns = {};
  for (const [k, v] of Object.entries(patterns) as Array<[Affordance, string | RegExp]>) {
    if (!v) continue;
    // A host pattern is tested against PAGE-CONTROLLED text (aria-label, title)
    // on every control, every projection. A pathological pattern plus adversarial
    // page text is a main-thread hang, and `RegExp.escape` does not help — it
    // prevents metacharacter injection, not catastrophic backtracking. What
    // bounds the damage is bounding both sides: the pattern here, the haystack
    // in `hit()`.
    if (typeof v === 'string' && v.length > MAX_PATTERN_CHARS) continue;
    try { out[k] = v instanceof RegExp ? v : new RegExp(v, 'i'); } catch { /* a bad host pattern must not break the walk */ }
  }
  return out;
}

/** Longest host pattern accepted, and longest text any pattern is run against.
 *  Both exist to bound backtracking, not to constrain legitimate use — a control
 *  name past 200 characters is not a control name. */
const MAX_PATTERN_CHARS = 200;
const MAX_HAYSTACK_CHARS = 200;

const attr = (el: Element, k: string) => (el.getAttribute?.(k) || '').trim();
const hit = (p: CompiledPatterns, k: Affordance, s: string) =>
  !!p[k] && p[k]!.test(s.length > MAX_HAYSTACK_CHARS ? s.slice(0, MAX_HAYSTACK_CHARS) : s);

/**
 * Signals that are AUTHORED — the page said so — as opposed to inferred from a
 * label by regex. Everything not listed here is a guess, and now says so.
 *
 * The distinction is not cosmetic. `probe-signals.ts` measured which of these
 * actually occur in the wild, and the answer reordered the roadmap: `command`/
 * `commandfor` (Invoker Commands, Baseline Dec 2025) appeared ZERO times across
 * eight live sites, while `aria-controls` appeared 77 times on six of them with
 * 96% resolving through element reflection. Reading the markup beats reading the
 * label, but only for the markup authors have actually adopted.
 */
const AUTHORED_VIA = new Set([
  'rel=next', 'rel=prev', 'hreflang', 'lang', 'target=_blank', 'cross-origin',
  'type=submit', 'autofocus', 'role', 'landmark', 'aria-controls', 'command',
]);

export function affordancesOf(el: Element, ctx: AffordanceContext): AffordanceHit[] {
  const hits: AffordanceHit[] = [];
  const out = {
    push(id: Affordance, via: string) {
      hits.push({ id, via, source: AUTHORED_VIA.has(via) ? 'authored' : 'inferred' });
    },
  };
  const p = ctx.patterns ?? {};
  const role = ctx.role, name = (ctx.name || '').trim();
  const label = name || attr(el, 'aria-label') || attr(el, 'title');
  const rel = attr(el, 'rel').toLowerCase();
  const isLinkish = role === 'link' || role === 'button' || role === 'menuitem';

  if (isLinkish) {
    // BOTH authored rels are tested before EITHER name pattern: a single else-if
    // chain let `<a rel="prev">Next section</a>` match the inferred name pattern
    // first, inverting the authored-beats-inferred principle this file states.
    if (/\bnext\b/.test(rel)) out.push('pagination-next', 'rel=next');
    else if (/\bprev(ious)?\b/.test(rel)) out.push('pagination-prev', 'rel=prev');
    else if (hit(p, 'pagination-next', label)) out.push('pagination-next', 'name-pattern');
    else if (hit(p, 'pagination-prev', label)) out.push('pagination-prev', 'name-pattern');
    if (attr(el, 'hreflang')) out.push('language-switcher', 'hreflang');
    else if (attr(el, 'lang') && ctx.docLang && attr(el, 'lang') !== ctx.docLang) out.push('language-switcher', 'lang');
    // A label that IS a language name, in any language — see language.ts.
    else if (isLanguageName(label, ctx.docLang)) out.push('language-switcher', 'language-name');
    else if (hit(p, 'language-switcher', label)) out.push('language-switcher', 'name-pattern');
    if (el.tagName === 'A' && attr(el, 'target') === '_blank') out.push('external', 'target=_blank');
    else if (el.tagName === 'A' && isCrossOrigin(el)) out.push('external', 'cross-origin');
  }
  if (role === 'searchbox') out.push('search', 'role');
  else if (ctx.landmark === 'search') out.push('search', 'landmark');
  else if ((hit(p, 'search', label) && isLinkish)
    || (role === 'textbox' && searchAttrs(el).some((v) => hit(p, 'search', v)))) out.push('search', 'name-pattern');
  if (role === 'textbox' || role === 'searchbox' || role === 'combobox') {
    if (el.hasAttribute?.('autofocus')) out.push('primary-input', 'autofocus');
    else if (el === ctx.primaryInputEl) out.push('primary-input', 'sole-field');
  }
  // `el.type` is 'submit' for every bare <button> — that is the DOM default, not
  // an authored intent, and treating it as one labelled every button on every
  // page a submit. Require the ATTRIBUTE, or a name that says so.
  if (role === 'button' && attr(el, 'type').toLowerCase() === 'submit') out.push('submit', 'type=submit');
  else if (role === 'button' && hit(p, 'submit', label)) out.push('submit', 'name-pattern');
  if (isLinkish && hit(p, 'add-to-cart', label)) out.push('add-to-cart', 'name-pattern');
  if (role === 'checkbox' || role === 'switch') out.push('toggle', 'role');
  if (isLinkish && hit(p, 'destructive', label)) out.push('destructive', 'name-pattern');

  /**
   * `aria-controls` — the authored relation the SDK never read.
   *
   * Measured on live pages before being written: 77 occurrences across 6 of 8
   * sites, 74 of them (96%) resolving through `ariaControlsElements`, which is
   * the reflection property that needs no `id` and so survives generated markup.
   * A tab, an accordion header and a disclosure button were previously all just
   * "button" with a name; this is the difference between them.
   */
  if (isLinkish || role === 'tab' || role === 'combobox') {
    if ((ctx.controlled ?? controlledElements(el)).length) out.push('discloses', 'aria-controls');
  }

  /**
   * Invoker Commands and popover targets — authored intent, read directly.
   *
   * Measured prevalence today is ZERO across eight live sites (Invoker Commands
   * reached Baseline only in December 2025), so this buys nothing yet and is
   * landed as a forward bet — see docs/OPENNESS.md § 3.1. It is here rather than
   * deferred for one concrete reason: RFC § 209 lists `[popover]:popover-open`
   * among this SDK's modality primitives, and until now nothing read a popover
   * attribute at all. The doc was ahead of the code; this closes that.
   *
   * `command` carries the host's own vocabulary when prefixed `--`, which is
   * exactly the open affordance channel `patterns`/`terms` approximates — except
   * the page author declares it and it needs no configuration.
   */
  // Page-authored and unbounded, and `Affordance = string` means nothing else
  // types it: cap like host patterns, or a page injects arbitrary-length strings
  // into every control document and response.
  const command = attr(el, 'command').slice(0, MAX_PATTERN_CHARS);
  if (command) out.push(command.startsWith('--') ? command.slice(2) : command, 'command');
  if (el.hasAttribute?.('popovertarget')) {
    out.push('discloses', 'popovertarget');
  }
  return hits;
}

/**
 * What this control governs. Element reflection first — it carries references
 * that no `id` can express — then the IDREF list for pages that predate it.
 */
export function controlledElements(el: Element): Element[] {
  const reflected = (el as Element & { ariaControlsElements?: Element[] }).ariaControlsElements;
  if (reflected?.length) return reflected;
  // An invoker names its target directly, which is strictly better than any
  // IDREF: `commandForElement`/`popoverTargetElement` are resolved by the
  // platform and survive markup with generated ids.
  const invoked = (el as Element & { commandForElement?: Element | null; popoverTargetElement?: Element | null });
  const target = invoked.commandForElement ?? invoked.popoverTargetElement;
  if (target) return [target];
  const ids = (el.getAttribute?.('aria-controls') || '').trim();
  if (!ids) return [];
  return ids.split(/\s+/)
    .map((id): Element | null => idRefTarget(el, id))
    .filter((e): e is Element => !!e);
}

/**
 * Attributes that identify a search field, tested SEPARATELY rather than
 * concatenated.
 *
 * They used to be joined with a space — `name + ' ' + placeholder` — which made
 * the haystack `"q "` for an input named `q` with no placeholder, and the `^q$`
 * rule that exists precisely to catch the web's conventional search parameter
 * could never match. Hacker News, whose search input is `<input name="q">` with
 * no label and no placeholder, was unfindable by "where do I type a search
 * query" for that reason alone.
 */
function searchAttrs(el: Element): string[] {
  return ['name', 'id', 'placeholder', 'aria-placeholder', 'title']
    .map((a) => attr(el, a)).filter(Boolean);
}

function isCrossOrigin(el: Element): boolean {
  try { return new URL(el.getAttribute('href') ?? '', location.href).origin !== location.origin; }
  catch { return false; }
}

/**
 * The page's primary input, if it has an obvious one: an autofocused field, or
 * the only text field in a form, or the first text field inside `main`.
 * Computed once per projection — this is a page-level question, not a per-node one.
 */
export function findPrimaryInput(root: Element, extraRoots: readonly ShadowRoot[] = []): Element | null {
  try {
    const fields = queryRoots(root, extraRoots)
      .flatMap((tree) => [...tree.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea')])
      .filter((el) => el.checkVisibility?.({ visibilityProperty: true }) ?? true);
    if (!fields.length) return null;
    const focused = fields.find((el) => el.hasAttribute('autofocus'));
    if (focused) return focused;
    const inMain = fields.filter((el) => flatClosest(el, 'main, [role=main]'));
    if (inMain.length) return inMain[0];
    const byForm = new Map<Element, Element[]>();
    for (const el of fields) {
      const f = (el as HTMLInputElement).form || el.closest('form') || root;
      byForm.set(f, (byForm.get(f) || []).concat(el));
    }
    for (const [, list] of byForm) if (list.length === 1) return list[0];
    return fields[0];
  } catch { return null; }
}

/**
 * The control's index document — ONE definition.
 *
 * The SDK built this string in index.js and every evaluation harness rebuilt it
 * by hand, which is a drift waiting to happen: the moment the two disagree, the
 * gate measures a ranker the product does not ship.
 */
export function controlDoc(node: ControlDocNode, terms: Partial<Record<Affordance, string>> = {}): string {
  const name = (node.name ?? '').trim();
  const row = node.row ?? '';
  // `''.includes(x)` is false but `x.includes('')` is TRUE, so an unnamed control
  // must not lose its row — that is the control with nothing else to be found by.
  const dupes = name && row && (name.includes(row) || row.includes(name));
  const aff = (node.affordances ?? []).map((a) => terms[a] ?? '').join(' ');
  // The name of the region this control governs. "Show advanced options" is
  // findable by "advanced options" only because aria-controls said so.
  const governs = (node.controlsName || '').trim();
  const governsDupe = governs && name && (name.includes(governs) || governs.includes(name));
  return `${name} ${node.role} ${node.headingPath.join(' ')} ${dupes ? '' : row} ${aff} ${governsDupe ? '' : governs}`
    .replace(/\s+/g, ' ').trim();
}


/**
 * Which affordance terms are actually in play on THIS page, and where each came
 * from. Reported by `describe_app` so the vocabulary is discoverable rather than
 * something an agent has to know in advance. See `docs/OPENNESS.md § 4`.
 */
export function vocabularyOf(nodes: ProjectedNode[]): Record<string, unknown> {
  const authored: string[] = [];
  const inferred: string[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    for (const id of n.affordances ?? []) {
      const via = n.affordanceVia?.[id] ?? 'name-pattern';
      const key = id + '|' + via;
      if (seen.has(key)) continue;
      seen.add(key);
      (via === 'name-pattern' || via === 'sole-field' ? inferred : authored).push(id);
    }
  }
  return {
    affordances: {
      authored: [...new Set(authored)].sort(),
      inferred: [...new Set(inferred)].sort(),
    },
    note: 'Affordances are an open vocabulary; a host may define its own. '
      + '`authored` was declared by the page (rel, hreflang, aria-controls, type); '
      + '`inferred` was matched from a control name and may be wrong. '
      + 'Each control reports its own source under `affordanceSource`.',
  };
}
