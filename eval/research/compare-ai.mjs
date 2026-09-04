/**
 * AI-off vs AI-on — what Chrome's on-device models actually change.
 *   node eval/research/compare-ai.mjs
 *
 * Reads two archived runs of the SAME 20 questions and reports the delta, so
 * "we tested with and without AI" is a table rather than a claim:
 *
 *   out/run-ai-off/   verify:'off', fromRegion:'off' — models never touched
 *   out/run-ai-on/    defaults, models warm and `available`
 *
 * The baseline arm is IDENTICAL in both by construction (a `fetch` loop has no
 * AI path), so it is reused rather than re-run; this script asserts that, and
 * refuses to compare if the two runs did not answer the same questions.
 *
 * Quality comes from each run's own blind-judge verdicts.json — never recomputed
 * here. Retrieval-payload cost, calls and wall-clock are the harness's measurements.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
const jsonl = (p) => readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

const arms = ['off', 'on'];
const runs = {};
for (const mode of arms) {
  const dir = path.join(OUT, `run-ai-${mode}`);
  if (!existsSync(path.join(dir, 'naviquest.jsonl'))) {
    console.error(`\n  Missing ${path.relative(process.cwd(), path.join(dir, 'naviquest.jsonl'))}.`
      + `\n  Archive each run into out/run-ai-off/ and out/run-ai-on/ first (see eval/README.md).\n`);
    process.exit(1);
  }
  runs[mode] = {
    nq: jsonl(path.join(dir, 'naviquest.jsonl')),
    bs: existsSync(path.join(dir, 'baseline.jsonl')) ? jsonl(path.join(dir, 'baseline.jsonl')) : [],
    verdicts: existsSync(path.join(dir, 'verdicts.json'))
      ? JSON.parse(readFileSync(path.join(dir, 'verdicts.json'), 'utf8')) : null,
  };
}

// Same questions, or the comparison is meaningless.
const keys = (rows) => new Set(rows.map((r) => `${r.site} :: ${r.task}`));
const kOff = keys(runs.off.nq), kOn = keys(runs.on.nq);
const same = kOff.size === kOn.size && [...kOff].every((k) => kOn.has(k));
if (!same) {
  console.error(`\n  The two runs did not answer the same questions (off ${kOff.size}, on ${kOn.size}, shared `
    + `${[...kOff].filter((k) => kOn.has(k)).length}). Refusing to compare.\n`);
  process.exit(1);
}

const sum = (rows, field) => rows.reduce((s, r) => s + (r[field] || 0), 0);
const peak = (rows, field) => rows.reduce((m, r) => Math.max(m, r[field] || 0), 0);
const quality = (verdicts, armName) => {
  if (!verdicts) return null;
  const mine = verdicts.filter((v) => v.arm === armName);
  const c = { correct: 0, partial: 0, wrong: 0, unsupported: 0 };
  for (const v of mine) c[v.quality] = (c[v.quality] || 0) + 1;
  return { ...c, score: c.correct + 0.5 * c.partial, n: mine.length };
};

const n = (x) => Math.round(x).toLocaleString('en-US');
const row = (label, off, on) => {
  // Only percentage-compare real numbers. Score rows arrive as "20/20" strings
  // and used to render a NaN%, which reads like a broken metric rather than a
  // label that simply has no meaningful delta.
  const numeric = typeof off === 'number' && typeof on === 'number';
  const d = numeric && off !== 0 ? `${on > off ? '+' : ''}${Math.round(100 * (on - off) / off)}%` : '—';
  console.log(`  ${label.padEnd(26)}${String(off).padStart(12)}${String(on).padStart(12)}${d.padStart(9)}`);
};

console.log(`\n=== naviquest arm: AI off vs AI on — same ${kOff.size} questions ===\n`);
console.log(`  ${''.padEnd(26)}${'AI off'.padStart(12)}${'AI on'.padStart(12)}${'delta'.padStart(9)}`);
row('retrieval-payload tokens', sum(runs.off.nq, 'tokens'), sum(runs.on.nq, 'tokens'));
row('tool calls', sum(runs.off.nq, 'calls'), sum(runs.on.nq, 'calls'));
row('wall-clock ms', sum(runs.off.nq, 'ms'), sum(runs.on.nq, 'ms'));
row('largest payload', peak(runs.off.nq, 'contextHeld'), peak(runs.on.nq, 'contextHeld'));

const qOff = quality(runs.off.verdicts, 'naviquest');
const qOn = quality(runs.on.verdicts, 'naviquest');
console.log('');
if (qOff && qOn) {
  row('quality score', `${qOff.score}/${qOff.n}`, `${qOn.score}/${qOn.n}`);
  row('  correct', qOff.correct, qOn.correct);
  row('  partial', qOff.partial, qOn.partial);
  row('  wrong', qOff.wrong, qOn.wrong);
  row('  unsupported', qOff.unsupported, qOn.unsupported);
} else {
  console.log('  quality: not judged in one or both runs (no verdicts.json)');
}

// The baseline must be untouched — it has no AI path. Assert rather than assume.
if (runs.off.bs.length && runs.on.bs.length) {
  const bsSame = sum(runs.off.bs, 'tokens') === sum(runs.on.bs, 'tokens')
    && runs.off.bs.length === runs.on.bs.length;
  console.log(`\n  baseline arm identical across both runs: ${bsSame ? 'yes (reused, as intended)' : 'NO — it was re-run, so its numbers differ'}`);
}

// ── TOKENS, per question. The sum hides which questions the AI path taxes and
// which it helps, and the tax is not uniform: every page opened pays a throwaway
// warm-up query, so a two-page crawl finding is charged twice.
const byKey = (rows) => new Map(rows.map((r) => [`${r.site} :: ${r.task}`, r]));
const offBy = byKey(runs.off.nq), onBy = byKey(runs.on.nq);
const deltas = [...onBy.entries()].map(([k, on]) => ({ k, on, off: offBy.get(k) }))
  .filter((d) => d.off)
  .map((d) => ({ ...d, delta: d.on.tokens - d.off.tokens }));
deltas.sort((a, b) => b.delta - a.delta);

console.log(`\n  per-question token delta (AI on − AI off), worst first:`);
for (const d of deltas) {
  const site = d.on.site.length > 21 ? d.on.site.slice(0, 20) + '…' : d.on.site;
  const tag = /^(follow|reach)/i.test(d.on.task) ? 'crawl' : 'read ';
  console.log(`    ${site.padEnd(22)}${tag}  on ${String(d.on.tokens).padStart(6)}   off ${String(d.off.tokens).padStart(6)}   ${(d.delta >= 0 ? '+' : '') + d.delta}`);
}
const worse = deltas.filter((d) => d.delta > 0).length;
const totalDelta = deltas.reduce((s, d) => s + d.delta, 0);
console.log(`\n  ${worse}/${deltas.length} questions cost MORE with AI on; net ${(totalDelta >= 0 ? '+' : '') + n(totalDelta)} tokens`
  + `\n  (each page opened pays a throwaway warm-up query before the answer lanes engage,`
  + `\n   so the AI path costs tokens as well as time — a crawl finding pays it twice.)`);

const qBase = quality(runs.on.verdicts, 'baseline') || quality(runs.off.verdicts, 'baseline');
if (qOn && qBase) {
  const bsTokens = sum(runs.on.bs.length ? runs.on.bs : runs.off.bs, 'tokens');
  const onTokens = sum(runs.on.nq, 'tokens');
  console.log(`\n  === the two claims that matter ===`);
  console.log(`  QUALITY  naviquest(AI on) ${qOn.score}/${qOn.n} · naviquest(AI off) ${qOff ? `${qOff.score}/${qOff.n}` : '—'} · fetch baseline ${qBase.score}/${qBase.n}`);
  console.log(`  TOKENS   naviquest(AI on) ${n(onTokens)} · naviquest(AI off) ${n(sum(runs.off.nq, 'tokens'))} · fetch baseline ${n(bsTokens)}`);
  console.log(`           → even with AI on, naviquest spends ${(bsTokens / Math.max(onTokens, 1)).toFixed(1)}× fewer tokens than the baseline.`);
}
console.log('');
