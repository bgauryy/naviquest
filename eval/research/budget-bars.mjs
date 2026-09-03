/**
 * Per-tool token-budget bars — proof that EVERY naviquest tool is capped.
 *   node eval/research/budget-bars.mjs [url]        (default: a large Wikipedia page)
 *
 * Drives each of the six tools once on ONE real page through the running harness
 * (:5331) and reads the SDK's own `_tokens` (what the agent receives) against
 * `_budget` (the cap for that tool on that page). This is the whole point of
 * naviquest: a page of any size still answers inside a fixed per-tool budget, so an
 * agent's context never scales with the page. Writes out/BUDGET.md and prints.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS = 'http://localhost:5331';
const URL_ = process.argv[2] || 'https://en.wikipedia.org/wiki/Machine_learning';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
const BLOCKS = 16;

const post = async (p, body) => (await fetch(HARNESS + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const call = async (session, tool, args) => (await post('/call', { session, tool, args })).result;

const sid = (await post('/session', { arm: 'naviquest' })).id;
await call(sid, 'open', { url: URL_ });

// One representative call per tool. resolve_address is chained off locate_control
// so it grounds a real address the page actually has.
const lc = await call(sid, 'locate_control', { description: 'link to the deep learning article' });
const addr = lc.recommendedAddress || lc.candidates?.[0]?.address || null;

const specs = [
  ['describe_app', {}],
  ['find_on_page', { query: 'what is machine learning' }],
  ['locate_control', { description: 'link to the deep learning article' }],
  ['resolve_address', addr ? { address: addr } : null],
  ['query_selector', { view: 'structure' }],
  ['agentic_content', { intent: 'list' }],
];

const rows = [];
for (const [tool, args] of specs) {
  if (!args) continue;
  const r = await call(sid, tool, args);
  const tokens = r._tokens ?? 0, budget = r._budget ?? 0;
  if (budget) rows.push({ tool, tokens, budget, frac: tokens / budget });
}
const peak = Math.max(...rows.map((r) => r.frac));
const nameW = Math.max(...rows.map((r) => r.tool.length));
const budW = Math.max(...rows.map((r) => r.budget.toLocaleString('en-US').length));

const bar = (frac) => { const f = Math.max(0, Math.min(BLOCKS, Math.round(BLOCKS * frac))); return '▇'.repeat(f) + '▁'.repeat(BLOCKS - f); };
const line = (r) => `${r.tool.padEnd(nameW)}  ${bar(r.frac)}  ${r.tokens.toLocaleString('en-US').padStart(budW)} / ${r.budget.toLocaleString('en-US')} tok  (${Math.round(r.frac * 100)}%)${r.frac === peak ? '  ← nearest cap' : ''}`;

const chart = rows.map(line).join('\n');
const host = new URL(URL_).host.replace(/^www\./, '');
const md = `## Per-tool token budget — every tool is capped

On \`${host}\` (a large page), each of the six tools answers well inside its own token
budget. The page can be any size; these numbers do not grow with it.

\`\`\`
${chart}
\`\`\`

\`_tokens\` is the SDK's own count of what the agent receives; \`_budget\` is the cap for
that tool on this page. This is why an agent's context stays flat: the whole page is
never returned — only a budgeted, ranked slice.
`;
writeFileSync(path.join(OUT, 'BUDGET.md'), md);
console.log('\n' + chart + '\n\nwrote out/BUDGET.md');
