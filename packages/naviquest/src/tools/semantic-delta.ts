/** Bounded semantic observations, separate from response-byte ETags. */
import type { ToolPayload } from './budget.ts';

export interface SemanticControlFact {
  id: number;
  address: ToolPayload;
  role: string;
  name: string | null;
  state: ToolPayload;
  actionable: boolean;
  /** The page's OWN validation message for this control while it is invalid
   *  (`aria-errormessage` text, else the native constraint message). Absent when
   *  valid. This is what closes the read-after-acting loop: after a failed
   *  submit the agent learns "Postcode must be a valid UK format", not just
   *  `invalid:true`. Never a field VALUE — only the page's stated error. */
  errorText?: string;
}

export interface SemanticRegionFact {
  id: number;
  address: ToolPayload;
  hash: string;
  chars: number;
  /** True when this region is a live region (`role=alert|status`,
   *  `aria-live=polite|assertive`). Its appearance or text change is the page
   *  ANNOUNCING an outcome, so the diff carries the text, not just a char delta. */
  live?: boolean;
  /** Bounded announced text, present only when `live`. */
  liveText?: string;
}

export interface SemanticSnapshot {
  projectionRevision: number;
  view: ToolPayload;
  modal: ToolPayload;
  controls: SemanticControlFact[];
  regions: SemanticRegionFact[];
  coverage: ToolPayload;
}

export interface SemanticLedger {
  observe(snapshot: SemanticSnapshot): string;
  changes(since: string, snapshot: SemanticSnapshot): ToolPayload;
}

const json = (v: unknown) => JSON.stringify(v);
const fieldsChanged = (before: ToolPayload, after: ToolPayload) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => json(before[key]) !== json(after[key]));
const regionKey = (address: ToolPayload) => {
  const { anchorText: _text, textOffset: _offset, controlOffset: _control, textRevision: _revision, ...identity } = address;
  return json(identity);
};

let nextLedgerId = 1;

export function createSemanticLedger(historyLength: number, maxChanges: number): SemanticLedger {
  // resolveConfig() restores shipped defaults for malformed host overrides.
  // Keep this boundary safe too: a negative history previously made the
  // eviction loop infinite, while NaN/Infinity silently disabled its bound.
  const retained = Number.isSafeInteger(historyLength) && historyLength > 0 ? historyLength : 1;
  const changeLimit = Number.isSafeInteger(maxChanges) && maxChanges >= 0 ? maxChanges : 0;
  const ledgerId = nextLedgerId++;
  let sequence = 0;
  const history = new Map<string, SemanticSnapshot>();
  const order: string[] = [];

  const remember = (snapshot: SemanticSnapshot) => {
    const cursor = `o:${ledgerId}:${++sequence}`;
    history.set(cursor, snapshot);
    order.push(cursor);
    while (order.length > retained) history.delete(order.shift()!);
    return cursor;
  };

  return {
    observe: remember,
    changes(since, snapshot) {
      const prior = history.get(since);
      const through = remember(snapshot);
      if (!prior) return {
        error: 'STALE_OBSERVATION',
        message: 'That semantic observation is not retained. Establish a new baseline with describe_app().',
        _observation: through,
      };

      const all: ToolPayload[] = [];
      const add = (change: ToolPayload) => all.push(change);

      const viewFields = fieldsChanged(prior.view, snapshot.view);
      if (viewFields.length) add({ kind: 'view', subject: 'document', fields: viewFields,
        before: prior.view, after: snapshot.view });
      if (json(prior.modal) !== json(snapshot.modal)) add({ kind: 'modal', subject: 'document',
        fields: fieldsChanged(prior.modal, snapshot.modal), before: prior.modal, after: snapshot.modal });

      const oldById = new Map(prior.controls.map((fact) => [fact.id, fact]));
      const oldByAddress = new Map(prior.controls.map((fact) => [json(fact.address), fact]));
      const matchedOld = new Set<SemanticControlFact>();
      for (const current of snapshot.controls) {
        const old = oldById.get(current.id) ?? oldByAddress.get(json(current.address));
        if (!old) {
          add({ kind: 'control-added', subject: 'control', address: current.address,
            after: { role: current.role, name: current.name, state: current.state, actionable: current.actionable,
              ...(current.errorText ? { errorText: current.errorText } : {}) } });
          continue;
        }
        matchedOld.add(old);
        if (json(old.address) !== json(current.address) || old.role !== current.role || old.name !== current.name) {
          add({ kind: 'control-identity', subject: 'control', address: current.address,
            fields: ['address', ...(old.role !== current.role ? ['role'] : []), ...(old.name !== current.name ? ['name'] : [])],
            before: { address: old.address, role: old.role, name: old.name },
            after: { address: current.address, role: current.role, name: current.name } });
        }
        const beforeFocused = old.state.focused === true;
        const afterFocused = current.state.focused === true;
        const beforeState = { ...old.state }; delete beforeState.focused;
        const afterState = { ...current.state }; delete afterState.focused;
        const stateFields = fieldsChanged(beforeState, afterState);
        // errorText rides the same change the agent already reads for `invalid`,
        // so a validation failure surfaces the message in one event, not two.
        const errorChanged = (old.errorText ?? '') !== (current.errorText ?? '');
        if (stateFields.length || errorChanged) add({ kind: 'control-state', subject: 'control', address: current.address,
          fields: [...stateFields, ...(errorChanged ? ['errorText'] : [])],
          before: { ...beforeState, ...(errorChanged ? { errorText: old.errorText ?? null } : {}) },
          after: { ...afterState, ...(errorChanged ? { errorText: current.errorText ?? null } : {}) } });
        if (beforeFocused !== afterFocused) add({ kind: 'focus', subject: 'control', address: current.address,
          fields: ['focused'], before: { focused: beforeFocused }, after: { focused: afterFocused } });
        if (old.actionable !== current.actionable) add({ kind: 'control-actionability', subject: 'control',
          address: current.address, fields: ['actionable'], before: { actionable: old.actionable },
          after: { actionable: current.actionable } });
      }
      for (const old of prior.controls) if (!matchedOld.has(old)) {
        add({ kind: 'control-removed', subject: 'control', address: old.address,
          before: { role: old.role, name: old.name, state: old.state, actionable: old.actionable } });
      }

      const oldRegionsById = new Map(prior.regions.map((fact) => [fact.id, fact]));
      const oldRegionsByAddress = new Map(prior.regions.map((fact) => [regionKey(fact.address), fact]));
      const matchedOldRegions = new Set<SemanticRegionFact>();
      for (const current of snapshot.regions) {
        // The address fallback is CONSUMING. Two chunks of one split region
        // share an address, so a rebuild that re-keys elements would otherwise
        // alias both onto the same prior fact and drop one from the diff.
        const byAddress = oldRegionsByAddress.get(regionKey(current.address));
        const old = oldRegionsById.get(current.id) ?? byAddress;
        if (old && old === byAddress) oldRegionsByAddress.delete(regionKey(current.address));
        if (!old) {
          // A live region appearing IS the page announcing an outcome — carry
          // the words, not a char count the agent then has to go re-read.
          if (current.live) add({ kind: 'announce', subject: 'region', address: current.address,
            after: { text: current.liveText ?? '', chars: current.chars } });
          else add({ kind: 'region-added', subject: 'region', address: current.address,
            after: { chars: current.chars } });
        } else {
          matchedOldRegions.add(old);
          if (old.hash !== current.hash) {
            if (current.live) add({ kind: 'announce', subject: 'region', address: current.address,
              fields: ['text'], before: { text: old.liveText ?? '' }, after: { text: current.liveText ?? '', chars: current.chars } });
            else add({ kind: 'region-content', subject: 'region', address: current.address,
              fields: ['text'], before: { chars: old.chars }, after: { chars: current.chars } });
          }
        }
      }
      for (const old of prior.regions) if (!matchedOldRegions.has(old)) {
        add({ kind: 'region-removed', subject: 'region', address: old.address, before: { chars: old.chars } });
      }
      if (json(prior.coverage) !== json(snapshot.coverage)) add({ kind: 'coverage', subject: 'document',
        fields: fieldsChanged(prior.coverage, snapshot.coverage), before: prior.coverage, after: snapshot.coverage });

      // `changeSummary`, not `summary`: the summarizer stage writes `summary` on
      // every payload it touches, and `describe_app({ changesSince, summarize })`
      // silently lost this histogram to that collision.
      const changeSummary: Record<string, number> = {};
      for (const change of all) changeSummary[change.kind] = (changeSummary[change.kind] ?? 0) + 1;
      const changes = all.slice(0, changeLimit);
      const omittedByKind: Record<string, number> = {};
      for (const change of all.slice(changeLimit)) {
        omittedByKind[change.kind] = (omittedByKind[change.kind] ?? 0) + 1;
      }
      const truncated = all.length - changes.length;
      return {
        mode: 'changes', since, through, _observation: through,
        projectionRevision: { before: prior.projectionRevision, after: snapshot.projectionRevision },
        attribution: 'interval, not causation', unchanged: all.length === 0,
        total: all.length, returned: changes.length, truncated,
        changeSummary, changes, ...(truncated ? { omitted: { count: truncated, byKind: omittedByKind } } : {}),
        coverage: snapshot.coverage,
      };
    },
  };
}
