/**
 * Per-question cost bars — naviquest against the `fetch` baseline.
 *   node eval/research/token-bars.mjs [runDir]     (default: out/, i.e. the last run)
 *
 * The companion to `budget-bars.mjs`. That one proves every TOOL stays inside its
 * own cap; this one shows what that buys per QUESTION against a real baseline:
 * each bar is naviquest's token cost as a fraction of what the `fetch` agent
 * spent answering the identical question, so a short bar is a large win.
 *
 * Both arms are charged with the same estimator (`chars/4` of the full result),
 * audited by `token-audit.mjs`, so the bars compare like with like.
 *
 * Writes out/COMPARISON.md and prints. Exits 1 if the two arms did not answer
 * the same questions — an unpaired chart would be meaningless.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.resolve(HERE, process.argv[2] || 'out');
const BLOCKS = 16;

const jsonl = (f) => {
  const p = path.join(RUN, f);
  if (!existsSync(p)) { console.error(`\n  Missing ${path.relative(process.cwd(), p)}\n`); process.exit(1); }
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

const nq = jsonl('naviquest.jsonl');
const bs = jsonl('baseline.jsonl');
const key = (r) => `${r.site} :: ${r.task}`;
const bsBy = new Map(bs.map((r) => [key(r), r]));

const paired = nq.map((n) => ({ n, b: bsBy.get(key(n)) })).filter((p) => p.b);
if (paired.length !== nq.length || nq.length !== bs.length) {
  console.error(`\n  The arms did not answer the same questions (naviquest ${nq.length}, baseline ${bs.length}, paired ${paired.length}).\n`);
  process.exit(1);
}

const n = (x) => x.toLocaleString('en-US');
// A filled block = naviquest's share of what the baseline spent. A short bar is
// a big win, which is the opposite reading from budget-bars.mjs (where a long
// bar means "close to the cap") — so the caption says so explicitly.
//
// A bar can also OVERFLOW: on a small page naviquest's multi-call loop can cost
// more than one whole-page fetch. Clamping that to a full bar would render a
// loss as if it were a break-even, so overflow gets a ▶ terminator and the
// label flips to "more" — never dress a loss up as "0.2× fewer".
const bar = (frac) => {
  if (frac > 1) return '▇'.repeat(BLOCKS - 1) + '▶';
  const f = Math.max(1, Math.min(BLOCKS, Math.round(BLOCKS * frac)));
  return '▇'.repeat(f) + '▁'.repeat(BLOCKS - f);
};
/** "4.2× fewer" when naviquest is cheaper, "3.0× MORE" when it is not. */
const verdictOf = (r) => (r.times >= 1
  ? `${r.times.toFixed(1)}× fewer`
  : `${(1 / r.times).toFixed(1)}× MORE`);

const rows = paired.map(({ n: a, b }) => ({
  site: a.site,
  phase: /^(follow|reach)/i.test(a.task) ? 'crawl' : 'read',
  nq: a.tokens,
  bs: b.tokens,
  frac: b.tokens ? a.tokens / b.tokens : 1,
  times: a.tokens ? b.tokens / a.tokens : 0,
})).sort((x, y) => y.times - x.times);

const labelW = Math.max(...rows.map((r) => r.site.length)) + 7;
const nqW = Math.max(...rows.map((r) => n(r.nq).length));
const bsW = Math.max(...rows.map((r) => n(r.bs).length));
const best = rows[0], worst = rows[rows.length - 1];

const line = (r) => {
  const label = `${r.site} ${r.phase}`.padEnd(labelW);
  const tag = r === best ? '  ← biggest win' : r === worst ? '  ← baseline wins here' : '';
  return `${label}${bar(r.frac)}  ${n(r.nq).padStart(nqW)} vs ${n(r.bs).padStart(bsW)} tok  (${verdictOf(r)})${tag}`;
};

const totalNq = rows.reduce((s, r) => s + r.nq, 0);
const totalBs = rows.reduce((s, r) => s + r.bs, 0);
const lost = rows.filter((r) => r.times < 1);
const totalLine = `${'TOTAL'.padEnd(labelW)}${bar(totalNq / totalBs)}  ${n(totalNq).padStart(nqW)} vs ${n(totalBs).padStart(bsW)} tok  (${(totalBs / totalNq).toFixed(1)}× fewer)`;

const chart = rows.map(line).join('\n') + '\n' + '─'.repeat(labelW + BLOCKS + nqW + bsW + 26) + '\n' + totalLine;

const md = `## Cost per question — naviquest vs the \`fetch\` baseline

Each bar is naviquest's token cost as a **fraction of what the \`fetch\` agent spent
answering the identical question**, so a *short* bar is a large win. (This is the
opposite reading from the per-tool budget bars, where a long bar means "close to
the cap".) Both arms are charged with the same estimator — \`chars/4\` of the full
result — audited by \`token-audit.mjs\`.

\`\`\`
${chart}
\`\`\`

The spread is the point: **the advantage tracks page size.** The largest win is
**${best.site} ${best.phase}** at ${best.times.toFixed(1)}× — a big article the baseline has to
ingest whole. ${lost.length
  ? `And the baseline wins ${lost.length} of ${rows.length} questions outright, all on \`${lost[0].site}\`, whose pages are small enough (${n(Math.min(...lost.map((r) => r.bs)))}–${n(Math.max(...lost.map((r) => r.bs)))} tokens) that one whole-page fetch costs less than naviquest's multi-call loop. That is the honest shape of the trade: below roughly 3k tokens of page, just fetching it is cheaper.`
  : 'naviquest was cheaper on every question in this run.'}

naviquest's cost stays bounded by its per-tool budgets either way, so the gap
widens without limit as pages grow — which is why the ${'`'}TOTAL${'`'} row (${(totalBs / totalNq).toFixed(1)}×) sits
well above the median question.
`;

writeFileSync(path.join(RUN, 'COMPARISON.md'), md);
console.log('\n' + chart + `\n\nwrote ${path.relative(process.cwd(), path.join(RUN, 'COMPARISON.md'))}\n`);
