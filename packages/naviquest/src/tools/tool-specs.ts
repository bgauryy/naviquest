import type { ToolSpecName } from './tool-names.ts';

export const ORIENTATION_SECTIONS = ['reachableViews', 'outline', 'landmarks', 'currentTrail'] as const;
export const QS_FIELDS = ['tag', 'role', 'name', 'text', 'state', 'box', 'address', 'selector', 'parent', 'attributes', 'scope', 'frame'] as const;
export const QUERY_VIEWS = ['actions', 'structure', 'scopes', 'forms'] as const;

const ADDRESS_INPUT = {
  type: 'object',
  description: 'Copy unchanged from a Naviquest result.',
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
const SUMMARIZE = { type: 'boolean', description: 'Optional lossy summary; slower; short text may stay unchanged.' };
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
    description: 'Orient to an unfamiliar page or changed state. Returns identity, structure, views, vocabulary, modality, and coverage gaps. Use `_observation` with `changesSince` when an interaction outcome matters.',
    inputSchema: { type: 'object', properties: {
      opaque: { type: 'boolean', description: 'Boxes of elements the text index cannot read (canvas, unlabeled images), not the orientation.' },
      describe: { type: 'boolean', description: 'With `opaque:true`, read each canvas/image region with an on-device model (`description`). Slow — use a small `limit`. Fail-open where no model exists.' },
      section: { type: 'string', enum: [...ORIENTATION_SECTIONS], description: 'Return one paged orientation section.' },
      limit: { ...PAGE_LIMIT, default: 10 }, offset: PAGE_OFFSET, revision: NUMERIC_REVISION,
      since: { type: 'string', description: 'Prior `_etag`.' },
      changesSince: { type: 'string', description: 'Prior `_observation` after an action. Emits `announce` (live-region text the page stated) and `errorText` (a field\'s own validation message) so you read the outcome, not just that state changed.' },
      summarize: SUMMARIZE,
      reason: REASON,
    } },
  },
  {
    name: 'find_on_page', title: 'Search page',
    description: 'Retrieve page-authored evidence for a question, topic, or passage. Returns ranked excerpts and addresses. Use `locate_control` for actions and `agentic_content` for other pages or resources.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', minLength: 1, description: 'Natural-language question, topic, or passage.' },
      goal: { type: 'string', minLength: 1, default: 'read', description: 'Open task context; `navigate` adds action-oriented recovery.' },
      limit: { ...PAGE_LIMIT, default: 5 }, offset: PAGE_OFFSET, revision: NUMERIC_REVISION,
      since: { type: 'string', description: 'Prior `_etag`.' },
      summarize: SUMMARIZE,
      reason: REASON,
    }, required: ['query'] },
  },
  {
    name: 'locate_control', title: 'Find a control',
    description: 'Match an open-ended user intent to current controls or links. Returns ranked candidates, confidence, refinements, and addresses; optional filters narrow the search.',
    inputSchema: { type: 'object', properties: {
      description: { type: 'string', minLength: 1, description: 'What the user wants to accomplish.' },
      limit: { ...PAGE_LIMIT, default: 4 }, offset: PAGE_OFFSET, revision: NUMERIC_REVISION,
      role: { ...NON_EMPTY_STRING_OR_LIST, description: 'ARIA-role filter.' },
      affordance: { ...NON_EMPTY_STRING_OR_LIST, description: 'Open-vocabulary job filter.' },
      landmark: { type: 'string', minLength: 1 },
      reason: REASON,
    }, required: ['description'] },
  },
  {
    name: 'resolve_address', title: 'Resolve address', readOnlyHint: false,
    description: 'Revalidate an address from any Naviquest tool. Controls return live state and geometry; regions can return wider text and nearby controls with `expand:true`.',
    inputSchema: { type: 'object', properties: {
      address: ADDRESS_INPUT,
      scrollIntoView: { type: 'boolean', description: 'Scroll before measuring viewport-relative geometry.' },
      expand: { type: 'boolean', description: 'Read more of a region: paginate its full text (`textOffset`) and include its controls.' },
      summarize: SUMMARIZE,
      reason: REASON,
    }, required: ['address'] },
  },
  {
    name: 'query_selector', title: 'List or inspect by semantics/CSS',
    description: 'Inspect known CSS or browse an explicit semantic inventory. Results cross readable frames and shadow roots; exact rows can be refetched with different fields.',
    inputSchema: { type: 'object', properties: {
      view: { type: 'string', enum: [...QUERY_VIEWS], description: 'Document-order semantic inventory.' },
      selector: { type: 'string', minLength: 1, description: 'CSS evaluated across readable query scopes.' },
      limit: { ...PAGE_LIMIT, default: 10 }, offset: PAGE_OFFSET,
      revision: { type: ['integer', 'string'], minimum: 0, minLength: 1, description: 'Copy from a continuation or exact-search result.' },
      role: NON_EMPTY_STRING_OR_LIST, affordance: NON_EMPTY_STRING_OR_LIST,
      landmark: { type: 'string', minLength: 1 },
      name: { type: 'string', minLength: 1, description: 'Copied exact accessible name; actions only.' },
      heading: { type: 'string', minLength: 1, description: 'Copied exact heading; structure only.' },
      frames: { type: 'boolean', default: true, description: 'Follow readable frames.' },
      fields: { type: ['array', 'null'], uniqueItems: true, description: 'Fields useful for this inspection; text, state, box, and context are opt-in.', items: { type: 'string', enum: [...QS_FIELDS] } },
      reason: REASON,
    }, oneOf: [
      { required: ['view'], not: { required: ['selector'] } },
      { required: ['selector'], not: { required: ['view'] } },
    ] },
  },
  {
    name: 'agentic_content', title: 'Agent resources',
    description: 'Discover same-origin pages and published resources beyond the current document. `list` browses, `find` ranks, and `read` opens a returned resource.',
    inputSchema: { type: 'object', properties: {
      intent: { type: 'string', enum: ['list', 'read', 'find'], default: 'list', description: '`list` browses, `find` ranks by query, and `read` opens a returned URL.' },
      query: { type: 'string', description: 'Natural-language terms for `find`.' },
      url: { type: 'string', description: 'Exact resource URL returned by `list` or `find`.' },
      goal: { type: 'string', minLength: 1, default: 'read', description: 'Open task context; `navigate` asks `find` to verify live HTML when possible.' },
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
