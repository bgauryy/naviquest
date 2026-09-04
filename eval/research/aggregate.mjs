/**
 * Validate both arms' findings and produce the comparison.
 *   node eval/research/aggregate.mjs validate   → check schema, print blind judge pairs
 *   node eval/research/aggregate.mjs rate        → with out/verdicts.json, print ArmRating
 *
 * No gold, no assumptions: this file never decides quality. It validates shapes,
 * rolls up the MEASURED costs, and (in rate mode) folds in the LLM judge's blind
 * verdicts. Quality comes only from out/verdicts.json.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentFinding, BlindJudgeVerdicts, JudgeVerdicts, ArmRating, must } from './schemas.mjs';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
const readJsonl = (f) => readFileSync(path.join(OUT, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

const nq = readJsonl('naviquest.jsonl').map((r, i) => must(AgentFinding, r, `naviquest[${i}]`));
const bs = readJsonl('baseline.jsonl').map((r, i) => must(AgentFinding, r, `baseline[${i}]`));
console.error(`validated: naviquest ${nq.length} findings, baseline ${bs.length} findings — all pass AgentFinding schema`);

const key = (f) => `${f.site} :: ${f.task}`;
const bsByKey = new Map(bs.map((f) => [key(f), f]));
const nqKeys = new Set(nq.map(key));
const bsKeys = new Set(bs.map(key));
if (nqKeys.size !== nq.length || bsKeys.size !== bs.length) throw new Error('duplicate task key in an arm');
const onlyNq = [...nqKeys].filter((k) => !bsKeys.has(k));
const onlyBs = [...bsKeys].filter((k) => !nqKeys.has(k));
if (onlyNq.length || onlyBs.length) {
  throw new Error(`arms did not answer identical tasks: only naviquest=${onlyNq.length}, only baseline=${onlyBs.length}`);
}
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const mode = process.argv[2] || 'validate';

if (mode === 'validate') {
  // Blind pairs for the judge with RANDOMIZED A/B order per task, so position can
  // never leak the arm. The mapping goes to blind-map.json (never to the judge);
  // `unblind` mode maps verdicts back afterwards.
  const pairs = []; const blindMap = [];
  for (const [index, n] of nq.entries()) {
    const b = bsByKey.get(key(n));
    const flip = Math.random() < 0.5;
    const pairId = `pair-${String(index + 1).padStart(3, '0')}`;
    const answerA = flip ? b.answer : n.answer;
    const answerB = flip ? n.answer : b.answer;
    const pairDigest = digest({ pairId, site: n.site, task: n.task, answerA, answerB });
    pairs.push({ pairId, pairDigest, site: n.site, task: n.task, answerA, answerB });
    blindMap.push({ pairId, pairDigest, site: n.site, task: n.task,
      A: flip ? 'baseline' : 'naviquest', B: flip ? 'naviquest' : 'baseline' });
  }
  writeFileSync(path.join(OUT, 'pairs.json'), JSON.stringify({ pairs }, null, 2));      // NO arm labels
  writeFileSync(path.join(OUT, 'blind-map.json'), JSON.stringify(blindMap, null, 2));
  console.error(`wrote ${pairs.length} blinded pairs (randomized A/B) + blind-map.json`);
} else if (mode === 'unblind') {
  // Map the judge's A/B verdicts back to arms via blind-map.json.
  const raw = must(BlindJudgeVerdicts, JSON.parse(readFileSync(path.join(OUT, 'judge-raw.json'), 'utf8')), 'judge-raw');
  const map = JSON.parse(readFileSync(path.join(OUT, 'blind-map.json'), 'utf8'));
  const pairs = JSON.parse(readFileSync(path.join(OUT, 'pairs.json'), 'utf8')).pairs;
  const mapById = new Map(map.map((m) => [m.pairId, m]));
  const pairById = new Map(pairs.map((p) => [p.pairId, p]));
  if (mapById.size !== map.length || raw.length !== map.length) throw new Error('judge output must contain exactly one verdict per blinded pair');
  const seen = new Set();
  const v = [];
  raw.forEach((r) => {
    const m = mapById.get(r.pairId);
    if (!m || seen.has(r.pairId)) throw new Error(`unknown or duplicate judge pair: ${r.pairId}`);
    if (r.pairDigest !== m.pairDigest) throw new Error(`stale judge packet for ${r.pairId}: digest mismatch`);
    const pair = pairById.get(r.pairId);
    if (!pair || !pair.answerA.includes(r.anchorA) || !pair.answerB.includes(r.anchorB)) {
      throw new Error(`judge answer anchor does not match ${r.pairId}`);
    }
    seen.add(r.pairId);
    v.push({ pairId: r.pairId, pairDigest: r.pairDigest, site: m.site, task: m.task, arm: m.A, quality: r.qualityA, reason: r.reasonA, answerAnchor: r.anchorA });
    v.push({ pairId: r.pairId, pairDigest: r.pairDigest, site: m.site, task: m.task, arm: m.B, quality: r.qualityB, reason: r.reasonB, answerAnchor: r.anchorB });
  });
  must(JudgeVerdicts, v, 'unblind');
  writeFileSync(path.join(OUT, 'verdicts.json'), JSON.stringify(v, null, 1));
  console.error(`unblinded ${v.length} verdicts → verdicts.json`);
} else if (mode === 'rate' || mode === 'report') {
  const verdicts = must(JudgeVerdicts, JSON.parse(readFileSync(path.join(OUT, 'verdicts.json'), 'utf8')), 'verdicts');
  const qOf = (arm, f) => verdicts.find((v) => v.arm === arm && v.site === f.site && v.task === f.task)?.quality;
  const rate = (arm, list) => {
    const q = list.map((f) => qOf(arm, f)).filter(Boolean);
    const counts = { correct: 0, partial: 0, wrong: 0, unsupported: 0 };
    for (const x of q) counts[x]++;
    const base = must(ArmRating, {
      arm,
      qualityScore: counts.correct + 0.5 * counts.partial,
      usefulTasks: counts.correct + counts.partial,
      totalTokens: list.reduce((s, f) => s + f.tokens, 0),
      medianTokens: median(list.map((f) => f.tokens)),
      totalCalls: list.reduce((s, f) => s + f.calls, 0),
      totalMs: list.reduce((s, f) => s + f.ms, 0),
      pagesReached: list.reduce((s, f) => s + f.pagesReached, 0),
      peakContextHeld: list.reduce((m, f) => Math.max(m, f.contextHeld), 0),
      tasks: list.length,
    }, `rating.${arm}`);
    // AI-on runs carry a per-document model warm-up inside `totalMs`/`totalTokens`.
    // Reporting only the inclusive total makes the AI arm look uniformly slow when
    // the cost is one-off SETUP per page (~25 s) rather than answer latency
    // (~2.6 s/query) — see eval/research/ai-warmup-cost.mjs. Surface the split so
    // the report can say which it was. Zero on AI-off runs.
    const warmupMs = list.reduce((s, f) => s + (f.warmupMs || 0), 0);
    const warmupTokens = list.reduce((s, f) => s + (f.warmupTokens || 0), 0);
    return { ...base, counts, warmupMs, warmupTokens,
      msExcludingWarmup: base.totalMs - warmupMs,
      tokensExcludingWarmup: base.totalTokens - warmupTokens };   // counts drive the dashboard's quality panel
  };
  const R = { naviquest: rate('naviquest', nq), baseline: rate('baseline', bs) };
  const ratio = (a, b) => (b ? +(a / b).toFixed(1) : Infinity);
  // Reciprocals must come from the RAW values, never from an already-rounded
  // ratio: 6,479/15,176 = 0.4269 rounds to 0.4, and 1/0.4 reports the baseline
  // as 2.5x faster when it is actually 2.3x. Rounding twice inflated a headline
  // number by 7%, so the inverse is computed once, here, from the measurements.
  const inverse = (a, b) => (a ? +(b / a).toFixed(1) : Infinity);
  // Per-task ratio DISTRIBUTIONS — the honest picture, since the sum-ratio is
  // dominated by the largest pages. Median + IQR say what a typical task sees.
  const quant = (arr, p) => { const s = [...arr].sort((a, b) => a - b); const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
  const perTask = nq.map((n) => { const b = bsByKey.get(key(n)); return b && n.tokens ? b.tokens / n.tokens : null; }).filter((x) => x != null);
  const tokDist = { median: +quant(perTask, 0.5).toFixed(1), iqr: [+quant(perTask, 0.25).toFixed(1), +quant(perTask, 0.75).toFixed(1)], min: +Math.min(...perTask).toFixed(1), max: +Math.max(...perTask).toFixed(1) };
  const qualityValue = { correct: 1, partial: 0.5, wrong: 0, unsupported: 0 };
  const wins = { naviquest: 0, baseline: 0, ties: 0 };
  for (const n of nq) {
    const a = qualityValue[qOf('naviquest', n)], b = qualityValue[qOf('baseline', n)];
    if (a > b) wins.naviquest++; else if (b > a) wins.baseline++; else wins.ties++;
  }
  const verdict = {
    tokens_x_sum: ratio(R.baseline.totalTokens, R.naviquest.totalTokens),
    tokens_x_per_task_median: tokDist.median,
    tokens_x_per_task_iqr: tokDist.iqr,
    context_held_x: ratio(R.baseline.peakContextHeld, R.naviquest.peakContextHeld),
    speed_x: ratio(R.baseline.totalMs, R.naviquest.totalMs),
    // How many times faster the SLOWER-scoring arm's opponent is, from raw ms.
    speed_x_display: R.naviquest.totalMs <= R.baseline.totalMs
      ? ratio(R.baseline.totalMs, R.naviquest.totalMs)
      : inverse(R.baseline.totalMs, R.naviquest.totalMs),
    speed_faster_arm: R.naviquest.totalMs <= R.baseline.totalMs ? 'naviquest' : 'baseline',
    quality_naviquest: `${R.naviquest.qualityScore}/${R.naviquest.tasks} (${R.naviquest.usefulTasks} useful)`,
    quality_baseline: `${R.baseline.qualityScore}/${R.baseline.tasks} (${R.baseline.usefulTasks} useful)`,
    quality_wins: wins,
  };

  if (mode === 'rate') {
    // Exactly the shape the dashboard's /judge endpoint expects, so the output
    // can be piped straight into it. `verdicts` is included because the
    // dashboard renders a per-QUESTION rating next to each arm's answer, not
    // just the two roll-up bars — without it those badges stay blank.
    console.log(JSON.stringify({ verdicts, ratings: { naviquest: R.naviquest, baseline: R.baseline }, verdict }, null, 2));
  } else {
    // Write a shareable Markdown report to out/RESULTS.md.
    const env = existsSync(path.join(OUT, 'env.json')) ? JSON.parse(readFileSync(path.join(OUT, 'env.json'), 'utf8')) : {};
    const n = (x) => x.toLocaleString('en-US');
    const short = (s, k = 90) => (s.length > k ? s.slice(0, k - 1) + '…' : s).replace(/\|/g, '\\|');
    const qEmoji = { correct: '✅', partial: '🟡', wrong: '❌', unsupported: '⚪' };
    const row = (r) => `| **${r.arm}** | ${r.qualityScore}/${r.tasks} (${r.counts.correct}✅ ${r.counts.partial}🟡 ${r.counts.wrong}❌ ${r.counts.unsupported}⚪) | ${n(r.totalTokens)} | ${n(r.medianTokens)} | ${n(r.totalCalls)} | ${n(r.peakContextHeld)} | ${n(r.totalMs)} | ${r.pagesReached} |`;
    const taskRows = nq.map((f) => {
      const b = bsByKey.get(key(f));
      return `| ${f.site} | ${short(f.task, 60)} | ${qEmoji[qOf('naviquest', f)] || '?'} | ${qEmoji[qOf('baseline', f)] || '?'} | ${n(f.tokens)} | ${n(b?.tokens || 0)} | ${n(f.contextHeld)} | ${n(b?.contextHeld || 0)} |`;
    }).join('\n');
    const detail = nq.map((f, index) => {
      const b = bsByKey.get(key(f));
      const nqV = verdicts.find((v) => v.arm === 'naviquest' && v.site === f.site && v.task === f.task);
      const bsV = verdicts.find((v) => v.arm === 'baseline' && v.site === f.site && v.task === f.task);
      return `### ${index + 1}. ${f.task}\n\n**Naviquest — ${nqV.quality}.** ${nqV.reason}\n\n${f.answer}\n\n*${n(f.tokens)} retrieval-payload tokens · ${f.calls} calls · ${n(f.ms)} ms · ${f.pagesReached} pages · ${n(f.contextHeld)} largest-payload tokens*\n\n**Fetch — ${bsV.quality}.** ${bsV.reason}\n\n${b.answer}\n\n*${n(b.tokens)} retrieval-payload tokens · ${b.calls} calls · ${n(b.ms)} ms · ${b.pagesReached} pages · ${n(b.contextHeld)} largest-payload tokens*`;
    }).join('\n\n');
    const md = `# Research race — results

*Two real agents, same ${R.naviquest.tasks} questions. Quality scored blind by an LLM judge (no gold key); returned research payloads, speed, and crawler reach are measured by the harness. Small n, single run — a POC-scale signal, not a benchmark.*

Environment: ${env.chromeVersion || 'Chrome over raw CDP'} · built-in AI ${env.aiMode === 'off' ? 'off (deterministic retrieval path)' : env.aiMode || 'state not recorded'} · retrieval-payload token estimate = chars/4 of the full tool result (matches the SDK's own \`_tokens\`). This does not measure model prompt, reasoning, cached-context, or answer-generation tokens and is not total model usage or billing.

The baseline here is **steelmanned**: readability-extracted main content (not a whole-page dump), plus discovered links. Both arms start a fresh isolated session for every question.

## Headline

- **Retrieval-payload tokens per task:** median **${verdict.tokens_x_per_task_median}× fewer**, IQR ${verdict.tokens_x_per_task_iqr[0]}×–${verdict.tokens_x_per_task_iqr[1]}× (sum-ratio ${verdict.tokens_x_sum}×, influenced by the largest pages). ${n(R.naviquest.totalTokens)} vs ${n(R.baseline.totalTokens)} total.
- **Median retrieval-payload cost:** ${n(R.naviquest.medianTokens)} for naviquest vs ${n(R.baseline.medianTokens)} for fetch.
- **Largest returned payload:** naviquest's largest single tool result was **${n(R.naviquest.peakContextHeld)} estimated tokens** regardless of page size, vs **${n(R.baseline.peakContextHeld)}** for a whole page (${verdict.context_held_x}× — definitional: capped tool vs full page).
- **Quality:** naviquest ${verdict.quality_naviquest} · baseline ${verdict.quality_baseline} (blind, randomized A/B).
- **Question outcomes:** naviquest won ${verdict.quality_wins.naviquest}, fetch won ${verdict.quality_wins.baseline}, and ${verdict.quality_wins.ties} tied.
- **Speed:** ${verdict.speed_faster_arm} **${verdict.speed_x_display}× faster** wall-clock (${n(R.naviquest.totalMs)} vs ${n(R.baseline.totalMs)} ms).${R.naviquest.warmupMs ? `
- **Where naviquest's time went:** ${n(R.naviquest.warmupMs)} ms of that is one-off on-device-model **setup** (Chrome scopes the Gemini Nano session to the document, so every page opened pays a ~25 s warm-up before the answer lanes engage). Excluding setup, the arm spent **${n(R.naviquest.msExcludingWarmup)} ms** answering — so the wall-clock gap is model start-up, not answer latency. Measure the split yourself with \`node eval/research/ai-warmup-cost.mjs\`.` : ''}

## Per-arm

| arm | quality (judge) | payload tokens | median payload tokens | calls | largest payload | total ms | pages |
|---|---|--:|--:|--:|--:|--:|--:|
${row(R.naviquest)}
${row(R.baseline)}

## Per-task (✅ correct · 🟡 partial · ❌ wrong · ⚪ unsupported)

| site | task | nq | base | nq payload tok | base payload tok | nq largest | base largest |
|---|---|:--:|:--:|--:|--:|--:|--:|
${taskRows}

## Answers and judge assessments

${detail}

## How to reproduce

Follow [POC.md](../../../POC.md): start the host and harness, run exactly two research agents against \`out/tasks.json\`, judge the randomized pairs, then run \`unblind\`, \`rate\`, and \`report\`.
`;
    writeFileSync(path.join(OUT, 'RESULTS.md'), md);
    console.error('wrote out/RESULTS.md');
    console.log(JSON.stringify({ verdict }, null, 2));
  }
}
