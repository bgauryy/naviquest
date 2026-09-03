/**
 * Public, agent-independent contracts for Naviquest's six tools.
 *
 * WebMCP currently advertises inputs but does not negotiate a result schema.
 * Keeping these result types in the SDK gives page-side TypeScript consumers a
 * checked contract and gives contract tests named states to protect. Unknown
 * extension fields remain allowed: coverage and host vocabulary are deliberately
 * open, and adding evidence must not break an older consumer.
 */
import type { Address, Box, RetrievalLane, States } from '../types.ts';
import type { AuthoredOrientation } from './orientation.ts';
// `import type` of a VALUE symbol: erased at compile time, but lets the unions
// below derive from the agent-facing schema arrays instead of restating them —
// three hand-spelled copies of the same enum was three chances to drift.
import type { ORIENTATION_SECTIONS, QS_FIELDS, QUERY_VIEWS } from './tool-specs.ts';

export interface ToolEnvelope {
  /** Stable cross-tool decision state; tool-specific `status` fields remain for compatibility. */
  outcome: 'success' | 'degraded' | 'ambiguous' | 'not_found' | 'error';
  _etag?: string;
  _version?: number;
  _tokens?: number;
  _budget?: number;
  _overBudget?: boolean;
  _observation?: string;
  unchanged?: boolean;
  mode?: string;
  total?: number;
  /** Summarization metadata. Semantic-change counts moved to `changeSummary`
   * so `describe_app({ changesSince, summarize: true })` cannot lose them. */
  summary?: SummaryEnvelope;
  /** Per-kind semantic-change counts, describe_app changes mode only. */
  changeSummary?: Record<string, number>;
}

export interface SummaryEnvelope {
  status: string;
  text?: string;
  source?: string;
  lossy: true;
  inputChars?: number;
  outputChars?: number;
  reductionPct?: number;
  latencyMs?: number;
  readOriginalWith?: { tool: string; arguments: Record<string, unknown> };
  [extension: string]: unknown;
}

export interface ToolSuccessEnvelope extends ToolEnvelope { error?: never }

export interface ToolFailure extends ToolEnvelope {
  outcome: 'error';
  /** The machine-readable class. `INVALID_INPUT` is a malformed call and
   *  `NOT_FOUND` is a well-formed call that matched nothing — never conflated. */
  error: string;
  /**
   * REQUIRED, and it is the RECOVERY INSTRUCTION, not a diagnosis. Every failure
   * names the next move ("Restart at offset 0 with this revision"), which is why
   * this is not optional and why a raw platform error string is never enough on
   * its own. `hint` below is an additional non-obvious note, so a failure with no
   * `hint` is still fully actionable — the two fields are not one job twice.
   */
  message: string;
  hint?: string;
  next?: { tool: string; arguments: Record<string, unknown> };
}

export interface PageInput {
  limit?: number;
  offset?: number;
  revision?: number;
  /** The agent's one-line intent for THIS call; the host may show it to the user. */
  reason?: string;
}

export interface DescribeAppInput extends PageInput {
  opaque?: boolean;
  /** With `opaque:true`, read each canvas/image region with an on-device model. */
  describe?: boolean;
  section?: OrientationSection;
  since?: string;
  changesSince?: string;
  summarize?: boolean;
}

export interface OutlineRow {
  depth: number;
  text: string;
  landmark: string | null;
  headingPath: string[];
  address: Address | null;
  addressable?: false;
  readWith?: 'resolve_address';
  note?: string;
}

export type OrientationSection = typeof ORIENTATION_SECTIONS[number];
export type QuerySelectorField = typeof QS_FIELDS[number];
export type QuerySelectorView = typeof QUERY_VIEWS[number];
export interface OrientationContinuation {
  section: OrientationSection;
  limit: number;
  offset: number;
  revision: number;
}
export interface DescribeView { title: string; path: string; heading: string | null }
export interface DescribeCounts { chunks: number; controls: number }
export interface DescribeVocabulary {
  affordances: { authored: string[]; inferred: string[] };
  note: string;
  [extension: string]: unknown;
}
export interface DescribeModalState {
  modal: boolean;
  ambiguous?: true;
  candidates?: number;
  name?: string | null;
  note?: string;
}

export interface DescribeAppSuccess extends ToolSuccessEnvelope, DescribeModalState {
  view: DescribeView;
  counts: DescribeCounts;
  vocabulary: DescribeVocabulary;
  reachableViews: string[];
  outline: OutlineRow[];
  landmarks: string[];
  currentTrail: string[];
  orientationTotals: Record<OrientationSection, number>;
  continuations?: Partial<Record<OrientationSection, OrientationContinuation>>;
  nonText: Record<string, unknown>;
  structuralQuality: 'good' | 'mixed' | 'low';
  structuralEngagementPct: number;
  section?: OrientationSection;
  results?: string[] | OutlineRow[];
  coverage?: Record<string, unknown>;
  recommendation?: string;
  reindexed?: true;
  _observation?: string;
  unchanged?: boolean;
  mode?: string;
  /** Host-authored purpose. Omitted when createNaviquest had no orientation. */
  authored?: AuthoredOrientation;
}
export interface DescribeAppSectionSuccess extends ToolSuccessEnvelope {
  section: OrientationSection;
  revision: number;
  total: number;
  offset: number;
  returned: number;
  results: string[] | OutlineRow[];
  continuation?: OrientationContinuation;
}
/** Opaque and semantic-change modes are deliberately open, but they still use
 * the same universal outcome and pagination envelope as every other response. */
export interface DescribeAppModeSuccess extends ToolSuccessEnvelope {
  results?: Array<Record<string, unknown>>;
  changes?: Array<Record<string, unknown>>;
  total?: number;
  returned?: number;
  truncated?: number;
  continuation?: Record<string, unknown>;
  _observation?: string;
  unchanged?: boolean;
  mode?: string;
}
export type DescribeAppResult = DescribeAppSuccess | DescribeAppSectionSuccess | DescribeAppModeSuccess | ToolFailure;

export interface FindOnPageInput extends PageInput {
  query: string;
  /** Open goal vocabulary. `read` is the default; `navigate` asks for a live-action recovery. */
  goal?: string;
  since?: string;
  summarize?: boolean;
}

export interface ContentAnswer {
  /** Omitted only when `summarize: true` replaced it; use summary.readOriginalWith. */
  text?: string;
  textSummarized?: true;
  source: string;
  coverage?: number;
  address: Address | null;
  addressable?: boolean;
  spanElement?: number;
}

export interface ContentPassage {
  kind: 'answer' | 'section' | 'passage';
  /** Omitted only when `summarize: true` replaced it; use summary.readOriginalWith. */
  text?: string;
  textSummarized?: true;
  match: 'exact' | 'ranked';
  score: number;
  queryCoverage: number;
  confidence?: 'high' | 'medium' | 'low';
  headingPath?: string[];
  address: Address;
  actionable?: Array<{ role: string; name: string | null; address: Address; [extension: string]: unknown }>;
  [extension: string]: unknown;
}

export interface FindOnPageSuccess extends ToolSuccessEnvelope {
  results: ContentPassage[];
  answer?: ContentAnswer;
  answerStatus: 'supported' | 'unsupported' | 'no-match';
  status: 'supported' | 'ambiguous' | 'not_found' | 'degraded';
  recommendedAddress: Address | null;
  confidence: 'high' | 'medium' | 'low';
  confidenceBasis: string;
  nextCalls?: Array<{ tool: string; arguments: Record<string, unknown>; reason: string }>;
  evidenceOnly: boolean;
  queryCoverage: number;
  coverageBasis: string;
  hint?: string;
  next?: { tool: string; arguments: Record<string, unknown>; reason?: string };
  retrieval: RetrievalLane;
  matched: number;
  returned: number;
  truncated: number;
}
export type FindOnPageResult = FindOnPageSuccess | ToolFailure;

export interface LocateControlInput extends PageInput {
  description: string;
  role?: string | string[];
  affordance?: string | string[];
  landmark?: string;
}

export interface ControlCandidate {
  role: string;
  name: string | null;
  state: States & { inert: boolean };
  address: Address;
  score: number;
  queryCoverage: number;
  confidence: 'high' | 'medium' | 'low';
  headingPath: string[];
  row?: string;
  primary?: boolean;
  warning?: string;
  affordances?: string[];
  affordanceSource?: Record<string, string>;
  [extension: string]: unknown;
}

export interface LocateControlSuccess extends ToolSuccessEnvelope {
  status: 'supported' | 'ambiguous';
  recommendedAddress: Address | null;
  confidence: 'high' | 'medium' | 'low';
  nextCalls?: Array<{ tool: string; arguments: Record<string, unknown>; reason: string }>;
  candidates: ControlCandidate[];
  retrieval: RetrievalLane;
  ambiguous: boolean;
  recommended: 0 | null;
  confidenceBasis: string;
  refineBy?: { roles?: string[]; affordances?: string[]; landmarks?: string[]; names?: string[] };
  hint?: string;
  matched: number;
  returned: number;
  truncated: number;
  note?: string;
  nearest?: Array<{ role: string; name: string | null; confidence: 'low'; address: Address;
    headingPath: string[]; row?: string; similarity: number; score?: number; warning?: string }>;
}
export interface LocateControlNoMatch extends ToolSuccessEnvelope {
  status: 'not_found';
  recommendedAddress: null;
  confidence: 'low';
  confidenceBasis: string;
  nextCalls: Array<{ tool: string; arguments: Record<string, unknown>; reason: string }>;
  candidates: [];
  nearest?: Array<{ role: string; name: string | null; confidence: 'low'; address: Address;
    headingPath: string[]; row?: string; similarity: number; score?: number; warning?: string }>;
  retrieval: RetrievalLane;
  note: string;
  removedByFilter?: number;
  ambiguous?: false;
}
export type LocateControlResult = LocateControlSuccess | LocateControlNoMatch | ToolFailure;

export interface ResolveAddressInput {
  address: Address;
  scrollIntoView?: boolean;
  expand?: boolean;
  summarize?: boolean;
  /** The agent's one-line intent for THIS call; the host may show it to the user. */
  reason?: string;
}

export interface ResolveAddressSuccess extends ToolSuccessEnvelope {
  status: 'RESOLVED';
  role: string;
  name: string | null;
  row?: string;
  state: States & { inert: boolean };
  actionable: boolean;
  relaxed?: true;
  note?: string;
  relations?: ControlRelation[];
  box: Box;
  inViewport: boolean;
  selectorOfLastResort: string | null;
  selectorWarning: string;
  warning?: string;
  // target/rel/download are present only when the anchor carries them (liveNavigationOf).
  navigation?: { href: string; sameOrigin: boolean; target?: string; rel?: string; download?: string };
}

export interface ControlRelation {
  type: 'controls';
  source: string;
  target: { name: string | null; address: Address | null; addressable: boolean };
}

export interface ResolveAddressMiss extends ToolSuccessEnvelope {
  status: 'AMBIGUOUS' | 'NOT_FOUND';
  hint: string;
  candidates?: Address[];
  nearest?: Address[];
}
export interface ResolveRegionSuccess extends ToolSuccessEnvelope {
  status: 'RESOLVED';
  kind: 'region';
  headingPath: string[];
  landmark: string | null;
  /** Omitted only when `summarize: true` replaced it; use summary.readOriginalWith. */
  text?: string;
  textSummarized?: true;
  textOffset: number;
  totalTextChars: number;
  controlOffset: number;
  totalControls: number;
  returnedControls: number;
  merged: number;
  controls: Array<{ role: string; name: string | null; state: States; address: Address }>;
  collapsed?: true;
  revealedBy?: Address | null;
  note?: string;
  truncated?: boolean;
  continuation?: Address;
  remainingTextChars?: number;
  remainingControls?: number;
}
export type ResolveAddressResult = ResolveAddressSuccess | ResolveRegionSuccess | ResolveAddressMiss | ToolFailure;

export interface QuerySelectorInput {
  limit?: number;
  offset?: number;
  revision?: number | string;
  view?: QuerySelectorView;
  selector?: string;
  role?: string | string[];
  affordance?: string | string[];
  landmark?: string;
  /** Exact normalized match; copy a name returned by Naviquest. */
  name?: string;
  /** Exact normalized match; copy a heading returned by Naviquest. */
  heading?: string;
  frames?: boolean;
  fields?: QuerySelectorField[] | null;
  /** The agent's one-line intent for THIS call; the host may show it to the user. */
  reason?: string;
}

export interface QuerySelectorSuccess extends ToolSuccessEnvelope {
  view?: QuerySelectorView;
  selector?: string;
  matched?: number;
  returned: number;
  truncated: number;
  results: Array<Record<string, unknown> & { address?: Address | null }>;
}
export type QuerySelectorResult = QuerySelectorSuccess | ToolFailure;

export interface AgenticContentInput {
  intent?: 'list' | 'read' | 'find';
  query?: string;
  url?: string;
  /** Open goal vocabulary. `navigate` asks the tool to verify a live HTML sibling. */
  goal?: string;
  limit?: number;
  offset?: number;
  revision?: string;
  summarize?: boolean;
  /** The agent's one-line intent for THIS call; the host may show it to the user. */
  reason?: string;
}

export interface AgenticContentSuccess extends ToolSuccessEnvelope {
  status?: string;
  urlSemantics?: 'manifest-resource' | 'live-page-link';
  matches?: AgenticMatch[];
  docs?: AgenticDocument[];
  links?: AgenticLink[];
  total?: number;
  linksTotal?: number;
  returned?: number;
  truncated?: number;
  linksTruncated?: number;
  continuation?: AgenticContentInput;
  text?: string;
}
export interface AgenticDocument {
  title: string;
  url: string;
  section: string | null;
  note: string | null;
}
export interface AgenticLink {
  title: string;
  url: string;
  landmark: string | null;
  address: Address;
}
export interface AgenticMatch {
  kind: 'resource' | 'live-page';
  action: 'read' | 'navigate';
  title: string;
  url: string;
  resourceUrl?: string;
  liveUrl?: string;
  liveUrlVerified?: true;
  address?: Address;
  confidence?: 'high' | 'medium' | 'low';
  section?: string | null;
  note?: string | null;
  [extension: string]: unknown;
}
export type AgenticContentResult = AgenticContentSuccess | ToolFailure;

export interface NaviquestTools {
  describe_app(input?: DescribeAppInput): Promise<DescribeAppResult>;
  find_on_page(input: FindOnPageInput): Promise<FindOnPageResult>;
  locate_control(input: LocateControlInput): Promise<LocateControlResult>;
  resolve_address(input: ResolveAddressInput): Promise<ResolveAddressResult>;
  query_selector(input: QuerySelectorInput): Promise<QuerySelectorResult>;
  agentic_content(input?: AgenticContentInput): Promise<AgenticContentResult>;
}
