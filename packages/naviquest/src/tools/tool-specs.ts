import type { ToolSpecName } from './tool-names.ts';

export const ORIENTATION_SECTIONS = ['reachableViews', 'outline', 'landmarks', 'currentTrail'] as const;
export const QS_FIELDS = ['tag', 'role', 'name', 'text', 'state', 'box', 'address', 'attributes', 'scope', 'frame'] as const;
export const QUERY_VIEWS = ['actions', 'structure', 'scopes', 'forms'] as const;

const ADDRESS_INPUT = {
  type: 'object',
  description: 'Copy; never edit.',
  properties: {
    frame: { type: 'string', minLength: 1 },
    landmark: { type: ['string', 'null'] },
    landmarkName: { type: ['string', 'null'] },
    headingPath: { type: 'array', items: { type: 'string' } },
    row: { type: ['string', 'null'] },
    role: { type: 'string', minLength: 1 },
    name: { type: ['string', 'null'] },
    ordinal: { type: 'integer', minimum: 0 },
    peerCount: { type: 'integer', minimum: 1 },
    anchorText: { type: 'string' },
    textOffset: { type: 'integer', minimum: 0 },
    controlOffset: { type: 'integer', minimum: 0 },
    textRevision: { type: 'integer', minimum: 0 },
    resolveWith: { type: 'string', enum: ['read_region', 'resolve_address'] },
    headingScope: { type: 'string', enum: ['subtree', 'outline'] },
  },
  required: ['landmark', 'landmarkName', 'headingPath', 'row', 'role', 'name', 'ordinal', 'peerCount'],
  // Continuation fields are open so adding one never makes an older agent
  // reject the verbatim address it was instructed to preserve.
  additionalProperties: true,
};

const PAGE_LIMIT = { type: 'integer', minimum: 1 };
const PAGE_OFFSET = { type: 'integer', minimum: 0, default: 0 };
const NUMERIC_REVISION = { type: 'integer', minimum: 0 };
const SUMMARIZE = { type: 'boolean', description: 'Slow, lossy; less text; short skips' };
/** Every tool takes it: the agent's one-line intent for THIS call. Optional, and
 *  never indexed — the page may surface it so the human sees why the agent looked. */
const REASON = { type: 'string', minLength: 1, pattern: '^[^\\r\\n]+$', description: 'One-line intent; the host may display it.' };
const NON_EMPTY_STRING_OR_LIST = {
  type: ['string', 'array'], minLength: 1, minItems: 1,
  items: { type: 'string', minLength: 1 },
};

/** Agent-facing metadata, loaded on registration or `toolDefs()` — never on
 * construction. `tool-names.ts` carries the eager half (the six names, which
 * routing needs synchronously); this is the single source for the schemas,
 * descriptions and titles that both registration and `toolDefs()` hand out. */
export const TOOL_SPECS = [
  {
    name: 'describe_app', title: 'Orient on page',
    description: 'Use when the page is unfamiliar or its current scope is uncertain. Returns a compact map of sections, views, vocabulary, and coverage. Next: choose a content search, a control lookup, or cross-page discovery from the gap; do not page headings solely to enumerate them. After an action, use `_observation` as `changesSince`.',
    inputSchema: { type: 'object', properties: {
      opaque: { type: 'boolean', description: 'Boxes of elements the text index cannot read (canvas, unlabeled images), not the orientation.' },
      describe: { type: 'boolean', description: 'With `opaque:true`, read each canvas/image region with an on-device model (`description`). Slow — use a small `limit`. Fail-open where no model exists.' },
      section: { type: 'string', enum: [...ORIENTATION_SECTIONS] },
      limit: { ...PAGE_LIMIT, default: 10 }, offset: PAGE_OFFSET, revision: NUMERIC_REVISION,
      since: { type: 'string', description: 'Prior `_etag`.' },
      changesSince: { type: 'string', description: 'Prior `_observation` after an action. Emits `announce` (live-region text the page stated) and `errorText` (a field\'s own validation message) so you read the outcome, not just that state changed.' },
      summarize: SUMMARIZE,
      reason: REASON,
    } },
  },
  {
    name: 'find_on_page', title: 'Search page',
    description: 'Use for a fact, explanation, or passage on this page; not for a control or exhaustive inventory. Returns ranked evidence and an optional answer. Expand an excerpt only when it leaves a material gap. For a job use locate_control; for another page use agentic_content.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', minLength: 1, description: 'Content, not a control.' },
      goal: { type: 'string', minLength: 1, description: '`read` default; `navigate` requests an action.' },
      limit: { ...PAGE_LIMIT, default: 5 }, offset: PAGE_OFFSET, revision: NUMERIC_REVISION,
      since: { type: 'string', description: 'Prior `_etag`.' },
      summarize: SUMMARIZE,
      reason: REASON,
    }, required: ['query'] },
  },
  {
    name: 'locate_control', title: 'Find a control',
    description: 'Use for a specific user job, not a label guess or a page-wide inventory. Returns ranked live controls/links and refinements when intent is ambiguous. Resolve the chosen address immediately before the host acts. Page only while the job remains unresolved.',
    inputSchema: { type: 'object', properties: {
      description: { type: 'string', minLength: 1, description: 'Control job, not guessed label.' },
      limit: { ...PAGE_LIMIT, default: 4 }, offset: PAGE_OFFSET, revision: NUMERIC_REVISION,
      role: { ...NON_EMPTY_STRING_OR_LIST, description: 'ARIA-role filter.' },
      affordance: { ...NON_EMPTY_STRING_OR_LIST, description: 'Open-vocabulary job filter.' },
      landmark: { type: 'string', minLength: 1 },
      reason: REASON,
    }, required: ['description'] },
  },
  {
    name: 'resolve_address', title: 'Resolve address', readOnlyHint: false,
    description: 'Use with an address already returned by another tool: ground a control before an action, or expand a region when its excerpt is insufficient. Returns fresh state, navigation, box, and readable region evidence. Never reuse a box; follow a next page only if omitted text or controls affect the decision.',
    inputSchema: { type: 'object', properties: {
      address: ADDRESS_INPUT,
      scrollIntoView: { type: 'boolean', description: 'Move before measuring.' },
      expand: { type: 'boolean', description: 'Read more of a region: paginate its full text (`textOffset`) and include its controls.' },
      summarize: SUMMARIZE,
      reason: REASON,
    }, required: ['address'] },
  },
  {
    name: 'query_selector', title: 'List or inspect by semantics/CSS',
    description: 'Use for known CSS or an inventory the user explicitly needs; not as a default orientation step. `actions` and `forms` can be large, so one job should use locate_control. Returns bounded matching rows. Request only fields needed; page only when omitted rows could change the answer.',
    inputSchema: { type: 'object', properties: {
      view: { type: 'string', enum: [...QUERY_VIEWS] },
      selector: { type: 'string', minLength: 1, description: 'Known CSS.' },
      limit: { ...PAGE_LIMIT, default: 10 }, offset: PAGE_OFFSET,
      revision: { type: ['integer', 'string'], minimum: 0, minLength: 1, description: 'Copy from a cursor.' },
      role: NON_EMPTY_STRING_OR_LIST, affordance: NON_EMPTY_STRING_OR_LIST,
      landmark: { type: 'string', minLength: 1 },
      name: { type: 'string', minLength: 1, description: 'Copied exact accessible name; actions only.' },
      heading: { type: 'string', minLength: 1, description: 'Copied exact heading; structure only.' },
      frames: { type: 'boolean', description: 'Follow readable frames; default true.' },
      fields: { type: ['array', 'null'], uniqueItems: true, description: 'Return only evidence needed for the next decision: usually name and address; add state, text, or box only when they matter.', items: { type: 'string', enum: [...QS_FIELDS] } },
      reason: REASON,
    }, oneOf: [
      { required: ['view'], not: { required: ['selector'] } },
      { required: ['selector'], not: { required: ['view'] } },
    ] },
  },
  {
    name: 'agentic_content', title: 'Agent resources',
    description: 'Use for same-origin resources or a cross-page graph; not for facts already on this page. `list`/`find` returns bounded live links and resource handles. Navigate only destinations relevant to the user’s goal, retain source/destination/purpose, and report unvisited or truncated scope.',
    inputSchema: { type: 'object', properties: {
      intent: { type: 'string', enum: ['list', 'read', 'find'] },
      query: { type: 'string' },
      url: { type: 'string' },
      goal: { type: 'string', minLength: 1, description: '`navigate` verifies a live HTML URL when available.' },
      limit: { ...PAGE_LIMIT, default: 20 }, offset: PAGE_OFFSET,
      revision: { type: 'string', minLength: 1, description: 'Copy from a cursor.' },
      summarize: SUMMARIZE,
      reason: REASON,
    }, allOf: [
      { if: { properties: { intent: { const: 'find' } }, required: ['intent'] }, then: { required: ['query'], properties: { query: { minLength: 1 } } } },
      { if: { properties: { intent: { const: 'read' } }, required: ['intent'] }, then: { required: ['url'], properties: { url: { minLength: 1 } } } },
    ] },
  },
] as const;

/** One spec entry. Type-only, so the eager entry can describe a definition it
 *  builds without importing the schemas that define it. */
export type ToolSpec = typeof TOOL_SPECS[number];

type Assert<T extends true> = T;
/**
 * The names are declared eagerly in `tool-names.ts` and the schemas here, so
 * the two files could drift: a spec could invent a seventh name, or a name
 * could lose its schema and register as `undefined`. `Assert<false>` fails its
 * own constraint, so tsc rejects either direction at this declaration. Types
 * erase, so the guard costs no bytes in the lazy chunk.
 */
export type ToolNamesCoverSpecs = Assert<[
  Exclude<ToolSpecName, typeof TOOL_SPECS[number]['name']>,
  Exclude<typeof TOOL_SPECS[number]['name'], ToolSpecName>,
] extends [never, never] ? true : false>;
