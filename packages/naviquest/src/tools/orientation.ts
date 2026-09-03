/**
 * Optional first-party overlay — what this running app is for.
 *
 * Omit `createNaviquest({ orientation })` and describe_app has no `authored`
 * key. That is the default: six tools still orient, search, and locate from
 * the live page (embed or inject, any origin).
 *
 * Live landmarks, outline, modality, and coverage stay authoritative. This
 * module only normalises and caps copy the host passed, so `describe_app` can
 * return it as `authored` without competing with the 900-token outline shrinker.
 * Values are not indexed: find_on_page must not quote host copy as page evidence.
 *
 * Lives in its own file so tools.ts can import it (lazy answer chunk) while
 * index.ts re-exports types only — a static tools→index import would cycle.
 */
import type { OrientationTuning } from '../config.ts';

export interface OrientationTask {
  name: string;
  /**
   * CSS selector, same grammar as `exclude[]`. Agent copies it into
   * query_selector({ selector }) — never locate_control. Not an Address.
   */
  locate: string;
  how?: string;
}

export interface NaviquestOrientation {
  purpose: string;
  tasks?: OrientationTask[];
  constraints?: string[];
  /** Sync SPA "you are here" when aria-current is absent. */
  view?: () => string | null | undefined;
}

export interface AuthoredOrientation {
  source: 'createNaviquest.orientation';
  purpose: string;
  tasks?: Array<{ name: string; locate: string; how?: string }>;
  constraints?: string[];
  view?: string;
  truncated?: true;
  note?: string;
}

const clip = (value: string, max: number): { text: string; cut: boolean } => {
  const text = value.trim();
  if (text.length <= max) return { text, cut: false };
  return { text: text.slice(0, max).trimEnd(), cut: true };
};

/**
 * Same parser query_selector uses. A sliced selector is a different selector,
 * so over-cap or SyntaxError both omit the task rather than rewrite it.
 * Parse-ok is not enough: `search the site` is valid type-selector CSS.
 */
function cssSelector(value: string, maxChars: number): { selector?: string; cut: boolean; invalid: boolean } {
  const text = value.trim();
  if (!text) return { invalid: true, cut: false };
  if (text.length > maxChars) return { invalid: true, cut: true };
  try {
    document.querySelector(text);
    return { selector: text, cut: false, invalid: false };
  } catch {
    return { invalid: true, cut: false };
  }
}

/**
 * Returns undefined when the host supplied nothing usable — omit the key rather
 * than emit an empty object that looks like a declared purpose.
 *
 * `locateHits` is the query_selector match count (scopes + exclude). A selector
 * that parses but hits nothing is English-or-stale, not a locator.
 */
export function normalizeOrientation(
  input: NaviquestOrientation | undefined,
  caps: OrientationTuning,
  est: (value: unknown) => number,
  locateHits: (selector: string) => number,
): AuthoredOrientation | undefined {
  if (!input || typeof input !== 'object' || typeof input.purpose !== 'string') return undefined;
  const purposeClip = clip(input.purpose, caps.maxPurposeChars);
  if (!purposeClip.text) return undefined;

  let truncated = purposeClip.cut;
  const notes: string[] = [];
  const authored: AuthoredOrientation = {
    source: 'createNaviquest.orientation',
    purpose: purposeClip.text,
  };

  if (Array.isArray(input.tasks)) {
    const tasks: NonNullable<AuthoredOrientation['tasks']> = [];
    let droppedLocate = 0;
    let unmatched = 0;
    for (const task of input.tasks.slice(0, caps.maxTasks)) {
      if (!task || typeof task !== 'object') continue;
      if (typeof task.name !== 'string' || typeof task.locate !== 'string') continue;
      const name = clip(task.name, caps.maxLocateChars);
      const loc = cssSelector(task.locate, caps.maxLocateChars);
      if (loc.cut) truncated = true;
      if (loc.invalid || !loc.selector) { droppedLocate++; continue; }
      if (!name.text) continue;
      let hits = 0;
      try { hits = locateHits(loc.selector); } catch { hits = 0; }
      if (hits < 1) { unmatched++; continue; }
      truncated = truncated || name.cut;
      const row: { name: string; locate: string; how?: string } = { name: name.text, locate: loc.selector };
      if (typeof task.how === 'string') {
        const how = clip(task.how, caps.maxConstraintChars);
        if (how.text) { row.how = how.text; truncated = truncated || how.cut; }
      }
      tasks.push(row);
    }
    if (input.tasks.length > caps.maxTasks) truncated = true;
    if (droppedLocate) {
      notes.push(`${droppedLocate} task locate value(s) were not CSS selectors and were omitted.`);
    }
    if (unmatched) {
      notes.push(`${unmatched} task locate selector(s) matched no reachable elements and were omitted.`);
    }
    if (tasks.length) authored.tasks = tasks;
  }

  if (Array.isArray(input.constraints)) {
    const constraints: string[] = [];
    for (const item of input.constraints) {
      if (typeof item !== 'string') continue;
      const next = clip(item, caps.maxConstraintChars);
      if (!next.text) continue;
      truncated = truncated || next.cut;
      constraints.push(next.text);
    }
    if (constraints.length) authored.constraints = constraints;
  }

  if (typeof input.view === 'function') {
    try {
      const live = input.view();
      if (typeof live === 'string') {
        const view = clip(live, caps.maxViewChars);
        if (view.text) {
          authored.view = view.text;
          truncated = truncated || view.cut;
        }
      }
    } catch {
      notes.push('orientation.view() threw; live view omitted.');
    }
  }

  while (est(authored) > caps.maxTokens) {
    truncated = true;
    if (authored.tasks && authored.tasks.length > 1) {
      authored.tasks = authored.tasks.slice(0, -1);
      continue;
    }
    if (authored.tasks?.length === 1) { delete authored.tasks; continue; }
    if (authored.constraints && authored.constraints.length > 1) {
      authored.constraints = authored.constraints.slice(0, -1);
      continue;
    }
    if (authored.constraints?.length === 1) { delete authored.constraints; continue; }
    if (authored.view) { delete authored.view; continue; }
    if (authored.purpose.length > 24) {
      authored.purpose = authored.purpose.slice(0, Math.max(24, Math.floor(authored.purpose.length / 2))).trimEnd();
      continue;
    }
    break;
  }

  if (truncated) authored.truncated = true;
  if (notes.length) authored.note = notes.join(' ');
  return authored;
}
