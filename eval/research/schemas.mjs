/**
 * Zod schemas for the research race. No gold, no assumptions: an arm's answer is
 * whatever its agent actually produced, and QUALITY is decided only by a blind LLM
 * judge — never by a pre-baked phrase. Retrieval-payload tokens, speed (ms), and
 * crawler reach (pages) are measured by the harness, not asserted here.
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
  tokens: z.number().int().nonnegative(),   // estimated tokens in returned research payloads
  calls: z.number().int().nonnegative(),    // tool calls / fetches made
  ms: z.number().int().nonnegative(),       // speed
  pagesReached: z.number().int().nonnegative(),  // crawler reach
  // Largest single tool/fetch result returned during this question. This is a
  // payload bound, not total model context usage.
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
  pairId: z.string(),
  pairDigest: z.string().regex(/^[a-f0-9]{64}$/),
  site: z.string(),
  task: z.string(),
  arm: Arm,
  quality: z.enum(['correct', 'partial', 'wrong', 'unsupported']),
  reason: z.string().min(1),
  answerAnchor: z.string().min(1),
});
export const JudgeVerdicts = z.array(JudgeVerdict);

/** Blind judge output. The digest binds a verdict to the exact A/B packet. */
export const BlindJudgeVerdict = z.object({
  pairId: z.string(),
  pairDigest: z.string().regex(/^[a-f0-9]{64}$/),
  qualityA: z.enum(['correct', 'partial', 'wrong', 'unsupported']),
  reasonA: z.string().min(1),
  anchorA: z.string().min(1),
  qualityB: z.enum(['correct', 'partial', 'wrong', 'unsupported']),
  reasonB: z.string().min(1),
  anchorB: z.string().min(1),
});
export const BlindJudgeVerdicts = z.array(BlindJudgeVerdict);

/** Per-arm roll-up: quality is the judge's, the rest is measured. */
export const ArmRating = z.object({
  arm: Arm,
  qualityScore: z.number(),          // correct=1, partial=0.5
  usefulTasks: z.number().int(),     // correct + partial
  totalTokens: z.number().int().nonnegative(),
  medianTokens: z.number().nonnegative(),
  totalCalls: z.number().int().nonnegative(),
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
