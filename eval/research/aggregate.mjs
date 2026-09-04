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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentFinding, JudgeVerdicts, ArmRating, must } from './schemas.mjs';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
const readJsonl = (f) => readFileSync(path.join(OUT, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

const nq = readJsonl('naviquest.jsonl').map((r, i) => must(AgentFinding, r, `naviquest[${i}]`));
const bs = readJsonl('baseline.jsonl').map((r, i) => must(AgentFinding, r, `baseline[${i}]`));
console.error(`validated: naviquest ${nq.length} findings, baseline ${bs.length} findings — all pass AgentFinding schema`);

const key = (f) => `${f.site} :: ${f.task}`;
const bsByKey = new Map(bs.map((f) => [key(f), f]));

const mode = process.argv[2] || 'validate';

if (mode === 'validate') {
  // Blind pairs for the judge with RANDOMIZED A/B order per task, so position can
  // never leak the arm. The mapping goes to blind-map.json (never to the judge);
  // `unblind` mode maps verdicts back afterwards.
  const pairs = []; const blindMap = [];
  for (const n of nq) {
    const b = bsByKey.get(key(n));
    const flip = Math.random() < 0.5;
    pairs.push({ site: n.site, task: n.task,
      answerA: flip ? (b?.answer ?? '') : n.answer,
      answerB: flip ? n.answer : (b?.answer ?? '') });
    blindMap.push({ site: n.site, task: n.task, A: flip ? 'baseline' : 'naviquest', B: flip ? 'naviquest' : 'baseline' });
  }
  writeFileSync(path.join(OUT, 'pairs.json'), JSON.stringify({ pairs }, null, 2));      // NO arm labels
  writeFileSync(path.join(OUT, 'blind-map.json'), JSON.stringify(blindMap, null, 2));
  console.error(`wrote ${pairs.length} blinded pairs (randomized A/B) + blind-map.json`);
} else if (mode === 'unblind') {
  // Map the judge's A/B verdicts back to arms via blind-map.json.
  const raw = JSON.parse(readFileSync(path.join(OUT, 'judge-raw.json'), 'utf8'));
  const map = JSON.parse(readFileSync(path.join(OUT, 'blind-map.json'), 'utf8'));
  const v = [];
  raw.forEach((r, i) => {
    const m = map[i];
    v.push({ site: m.site, task: m.task, arm: m.A, quality: r.qualityA, reason: r.reasonA });
    v.push({ site: m.site, task: m.task, arm: m.B, quality: r.qualityB, reason: r.reasonB });
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
    const row = (r) => `| **${r.arm}** | ${r.qualityScore}/${r.tasks} (${r.counts.correct}✅ ${r.counts.partial}🟡 ${r.counts.wrong}❌ ${r.counts.unsupported}⚪) | ${n(r.totalTokens)} | ${n(r.peakContextHeld)} | ${n(r.totalMs)} | ${r.pagesReached} |`;
    const taskRows = nq.map((f) => {
      const b = bsByKey.get(key(f));
      return `| ${f.site} | ${short(f.task, 60)} | ${qEmoji[qOf('naviquest', f)] || '?'} | ${qEmoji[qOf('baseline', f)] || '?'} | ${n(f.tokens)} | ${n(b?.tokens || 0)} | ${n(f.contextHeld)} | ${n(b?.contextHeld || 0)} |`;
    }).join('\n');
    const md = `# Research race — results

*Two real agents, same ${R.naviquest.tasks} questions. Quality scored blind by an LLM judge (no gold key); tokens, context held, speed and crawler reach are measured by the harness. Small n, single run — a POC-scale signal, not a benchmark.*

Environment: ${env.chromeVersion || 'Chrome over raw CDP'} · built-in AI ${env.aiMode === 'off' ? 'off (deterministic retrieval path)' : env.aiMode || 'state not recorded'} · token cost = chars/4 of the full tool result (matches the SDK's own \`_tokens\`).

The baseline here is **steelmanned**: readability-extracted main content (not a whole-page dump), plus discovered links. Both arms start a fresh isolated session for every question.

## Headline

- **Tokens per task (the honest figure):** median **${verdict.tokens_x_per_task_median}× fewer**, IQR ${verdict.tokens_x_per_task_iqr[0]}×–${verdict.tokens_x_per_task_iqr[1]}× (sum-ratio ${verdict.tokens_x_sum}×, leveraged by the largest pages). ${n(R.naviquest.totalTokens)} vs ${n(R.baseline.totalTokens)} total.
- **Flat payload (the provable core):** naviquest's largest single tool result was **${n(R.naviquest.peakContextHeld)} tokens** regardless of page size, vs **${n(R.baseline.peakContextHeld)}** for a whole page (${verdict.context_held_x}× — definitional: capped tool vs full page).
- **Quality:** naviquest ${verdict.quality_naviquest} · baseline ${verdict.quality_baseline} (blind, randomized A/B).
- **Speed:** ${verdict.speed_faster_arm} **${verdict.speed_x_display}× faster** wall-clock (${n(R.naviquest.totalMs)} vs ${n(R.baseline.totalMs)} ms).${R.naviquest.warmupMs ? `
- **Where naviquest's time went:** ${n(R.naviquest.warmupMs)} ms of that is one-off on-device-model **setup** (Chrome scopes the Gemini Nano session to the document, so every page opened pays a ~25 s warm-up before the answer lanes engage). Excluding setup, the arm spent **${n(R.naviquest.msExcludingWarmup)} ms** answering — so the wall-clock gap is model start-up, not answer latency. Measure the split yourself with \`node eval/research/ai-warmup-cost.mjs\`.` : ''}

## Per-arm

| arm | quality (judge) | total tokens | peak context held | total ms | pages |
|---|---|--:|--:|--:|--:|
${row(R.naviquest)}
${row(R.baseline)}

## Per-task (✅ correct · 🟡 partial · ❌ wrong · ⚪ unsupported)

| site | task | nq | base | nq tok | base tok | nq ctx | base ctx |
|---|---|:--:|:--:|--:|--:|--:|--:|
${taskRows}

${existsSync(path.join(OUT, 'BUDGET.md')) ? '\n' + readFileSync(path.join(OUT, 'BUDGET.md'), 'utf8') + '\n' : ''}${existsSync(path.join(OUT, 'COMPARISON.md')) ? '\n' + readFileSync(path.join(OUT, 'COMPARISON.md'), 'utf8') + '\n' : ''}## How to reproduce

See [METHODOLOGY.md](../METHODOLOGY.md) for the exact steps and every check that was run. In short: launch Chrome via the skill, \`node eval/research/harness.mjs\`, spawn the two agents against \`out/tasks.json\`, judge blind, then \`node eval/research/aggregate.mjs report\` (and \`node eval/research/budget-bars.mjs\` for the per-tool budget bars).
`;
    writeFileSync(path.join(OUT, 'RESULTS.md'), md);
    console.error('wrote out/RESULTS.md');
    console.log(JSON.stringify({ verdict }, null, 2));
  }
}
