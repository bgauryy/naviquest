/**
 * Zod schemas for the research race. No gold, no assumptions: an arm's answer is
 * whatever its agent actually produced, and QUALITY is decided only by a blind LLM
 * judge — never by a pre-baked phrase. Efficiency (tokens), speed (ms) and crawler
 * reach (pages) are measured by the harness, not asserted here.
 *
 * Every turn's structured output is validated against these before it is written
 * or judged, so a malformed result fails loudly rather than skewing a score.
 */
import { z } from 'zod';

export const Arm = z.enum(['naviquest', 'baseline']);

/** What one agent produced for one research task, with its measured cost. */
export const AgentFinding = z.object({
  site: z.string(),
  task: z.string(),          // the open research question — no expected answer attached
  arm: Arm,
  answer: z.string(),        // the agent's own answer, in its own words
  tokens: z.number().int().nonnegative(),   // efficiency — total tokens spent on this task
  calls: z.number().int().nonnegative(),    // tool calls / fetches made
  ms: z.number().int().nonnegative(),       // speed
  pagesReached: z.number().int().nonnegative(),  // crawler reach
  // context held — the LARGEST single tool/fetch result the agent had to hold in
  // context at once to answer. This is where bounded retrieval wins decisively: a
  // fetch agent must hold the whole page; naviquest holds a budget-capped passage.
  contextHeld: z.number().int().nonnegative(),
  toolTrace: z.array(z.string()),           // ordered tool names the agent invoked
  // AI-on runs only. Chrome's Gemini Nano session is per-document and its first
  // prompt costs ~19 s, so an AI arm must warm every page it opens before the
  // answer lanes engage. That is SETUP, not answer latency — recording it
  // separately is what lets the report say "the AI arm is slower because of
  // per-page model setup" and show the steady-state figure underneath, instead
  // of a single inflated number. `ms`/`tokens` stay INCLUSIVE totals; these are
  // the subtrahend. Absent on AI-off runs (and on rows written before the split
  // existed), which read as zero.
  warmupMs: z.number().int().nonnegative().optional(),
  warmupTokens: z.number().int().nonnegative().optional(),
});
export const AgentFindings = z.array(AgentFinding);

/** A blind LLM judge's verdict on one (task, arm) answer. Judges MUST return this. */
export const JudgeVerdict = z.object({
  site: z.string(),
  task: z.string(),
  arm: Arm,
  quality: z.enum(['correct', 'partial', 'wrong', 'unsupported']),
  reason: z.string(),
});
export const JudgeVerdicts = z.array(JudgeVerdict);

/** Per-arm roll-up: quality is the judge's, the rest is measured. */
export const ArmRating = z.object({
  arm: Arm,
  qualityScore: z.number(),          // correct=1, partial=0.5
  usefulTasks: z.number().int(),     // correct + partial
  totalTokens: z.number().int().nonnegative(),
  totalMs: z.number().int().nonnegative(),
  pagesReached: z.number().int().nonnegative(),
  peakContextHeld: z.number().int().nonnegative(),   // worst single-payload the arm ever had to hold
  tasks: z.number().int().nonnegative(),
});

/** Safe-parse helper: returns the value or throws with the zod issue path. */
export function must(schema, value, where) {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(`schema violation at ${where}: ${r.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`);
  return r.data;
}
