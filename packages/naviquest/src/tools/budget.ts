/**
 * Token budgets, and shrinking a response until it fits one.
 *
 * Every tool declares a ceiling in `config.ts § budgets`, because a tool that
 * quietly returns 4,000 tokens has spent the agent's context on this page
 * whether or not the answer needed it. Two rules hold everywhere here:
 *
 *   1. **Truncation is always DECLARED.** A silently trimmed list reads to a
 *      model as "that is everything", which is the cheapest way to make an
 *      agent confidently wrong.
 *   2. **Failure to fit is also declared.** If shrinking cannot reach the cap we
 *      set `_overBudget` and hand back the smallest payload we managed, rather
 *      than pretending or throwing.
 *
 * Extracted from index.ts, where it sat between the tool bodies and the WebMCP
 * registration. It depends on nothing but a size estimator and the budget table,
 * so it does not belong in the module that owns the DOM.
 */
import type { Budgets, ToolName } from '../config.ts';

/**
 * A budget shrinker. It MUST make progress on every call — an idempotent step
 * (a fixed `slice(0, 12)`, say) spins the guard out and returns an over-budget
 * payload rather than a smaller one.
 */
export type Shrink = (o: ToolPayload, step: number) => ToolPayload;

/**
 * A tool response. The leading-underscore fields are the ENVELOPE every tool
 * carries — token count, budget, and (where the tool supports `since`) the etag
 * and version. They are underscored because they are metadata about the answer
 * rather than part of it, and the delta diff skips them for the same reason.
 */
export type ToolPayload = Record<string, any> & {
  _etag?: string; _version?: number; _tokens?: number;
  _budget?: number; _overBudget?: boolean;
};

export interface Budgeter {
  budget(toolName: ToolName, out: ToolPayload, shrink: Shrink): ToolPayload;
}

/**
 * The ceiling for one tool on THIS page.
 *
 * A fixed table spends the same 900 tokens orienting on a 768-token page as on a
 * 7,240-token one. Measured across the eight-site WebMCP ecosystem set, that
 * gave the orient -> search -> locate loop a floor of roughly 1,900 tokens and
 * put it at a median **146% of `document.body.innerText`** — the honest baseline
 * for a content question. It won outright on exactly one site: the only page in
 * the set with more than 2,000 tokens of prose.
 *
 * That floor is our own budget table, not a property of the problem. A response
 * cannot be worth more than the page it describes, so the ceiling is capped at a
 * share of what reading the whole page would have cost.
 *
 * `floor` is not negotiable downward: below it a response stops being able to
 * carry an address and a note, and a tool that returns a truncated stub is worse
 * than one that admits the page is too small to be worth querying — which is
 * what `describe_app`'s `recommendation` already says, and says on exactly the
 * pages where this cap binds hardest.
 */
export interface AdaptiveBudget {
  enabled: boolean;
  /** Ceiling as a share of the page's own token cost. */
  share: number;
  /** Never shrink a tool below this, whatever the page size. */
  floor: number;
  /** Safety ceiling for a tool-specific shrinker. This is not the response
   * ceiling: logarithmic list/text shrinking should finish much sooner. */
  maxShrinkSteps: number;
}

export function createBudgeter(
  budgets: Budgets,
  est: (v: unknown) => number,
  /** What reading this whole page would cost. Omitted in tests and by callers
   *  with no index yet, in which case the static table applies unchanged. */
  pageTokens: (() => number) | undefined,
  adaptive: AdaptiveBudget,
): Budgeter {
  const normalizeEnvelope = (o: ToolPayload): ToolPayload => {
    if (Array.isArray(o.results) && typeof o.returned === 'number') {
      o.returned = o.results.length;
      if (typeof o.matched === 'number' && typeof o.truncated === 'number') {
        // `matched` already counts coalesced rows as one: it is the post-coalesce
        // total. Subtracting `coalesced` here again under-declared `truncated`
        // by exactly that many hits — rule 1 broken in the function enforcing it.
        o.truncated = Math.max(0, o.matched - (o.offset ?? 0) - o.returned);
      }
    }
    return o;
  };
  const capFor = (tool: ToolName): number => {
    const fixed = budgets[tool];
    if (!adaptive.enabled || !pageTokens) return fixed;
    const page = pageTokens();
    if (!page) return fixed;
    return Math.min(fixed, Math.max(adaptive.floor, Math.round(page * adaptive.share)));
  };
  return {
    /**
     * Shrink until the response fits.
     *
     * Every step is attempted. Bailing out on the first step that happens to
     * change nothing was the bug: a page with a short outline and a 264-item nav
     * made steps 1 and 2 no-ops, so the loop exited before step 3 — the one that
     * would have trimmed the field holding 83% of the payload. We keep the
     * SMALLEST payload seen, not the last one, because a shrinker is free to
     * make a step that does not help.
     */
    budget(toolName, out, shrink) {
      const cap = capFor(toolName);
      let cur = normalizeEnvelope(out); let step = 0; let best = cur; let bestSize = est(cur);
      while (bestSize > cap && step < adaptive.maxShrinkSteps) {
        const next = normalizeEnvelope(shrink({ ...cur }, ++step));
        const size = est(next);
        if (size < bestSize) { best = next; bestSize = size; }
        cur = next;
      }
      cur = normalizeEnvelope(best);
      cur._tokens = est(cur);
      cur._budget = cap;
      if (cur._tokens > cap) cur._overBudget = true;   // declared, never silent
      return cur;
    },
  };
}
