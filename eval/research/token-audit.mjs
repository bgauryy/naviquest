/**
 * Token-accounting audit — proves the race's central number is not made up.
 *   node eval/research/token-audit.mjs [url]      (needs the harness on :5331)
 *
 * The whole comparison rests on ONE claim: the tokens charged to the naviquest
 * arm are the tokens the model actually receives, counted the same way as the
 * baseline's raw text. That claim has three parts, and this script checks each
 * against live tool results rather than asserting them in a comment:
 *
 *   1. PARITY — the harness charge equals the SDK's own `_tokens` for every
 *      tool. The SDK computes `_tokens` as chars/4 of the full payload
 *      (retrieval/text.ts estimateTokens, applied in tools/budget.ts); the
 *      harness independently computes chars/4 of the full result JSON. If these
 *      ever diverge, the envelope is being stripped somewhere and naviquest is
 *      being under- or over-charged.
 *   2. NO FREE ENVELOPE — `_tokens`/`_budget`/`_etag`/`_version` are part of the
 *      payload the model sees, so they must be INSIDE the charge. Recomputing
 *      the charge with the envelope removed must come out LOWER, which is the
 *      undercharge the harness deliberately refuses to take.
 *   3. BUDGET ADHERENCE — every tool declares `_budget` and lands within it.
 *      That is what makes the per-step cost flat regardless of page size.
 *
 * Exits 1 if any check fails, so it can gate a claim before it ships.
 */
const HARNESS = process.env.HARNESS || 'http://localhost:5331';
const URL_ = process.argv[2] || 'https://en.wikipedia.org/wiki/Machine_learning';

const post = async (p, body) => {
  const r = await fetch(HARNESS + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${p} → HTTP ${r.status}`);
  return r.json();
};

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); return; }
  fail++; console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
};

const env = await fetch(`${HARNESS}/env`).then((r) => r.json()).catch(() => null);
if (!env) { console.error(`\n  Harness not reachable at ${HARNESS}. Start eval/research/harness.mjs first.\n`); process.exit(1); }
console.log(`\n=== token audit — ${new URL(URL_).host} · ${env.chromeVersion} · ai:${env.aiMode} ===\n`);

const session = (await post('/session', { arm: 'naviquest' })).id;
await post('/call', { session, tool: 'open', args: { url: URL_ } });

// locate_control first so resolve_address can be grounded in a real address.
const located = (await post('/call', { session, tool: 'locate_control', args: { description: 'link to the deep learning article' } })).result;
const address = located?.recommendedAddress || located?.candidates?.[0]?.address || null;

const probes = [
  ['describe_app', {}],
  ['find_on_page', { query: 'what is machine learning' }],
  ['locate_control', { description: 'link to the deep learning article' }],
  ['query_selector', { view: 'structure' }],
  ['agentic_content', { intent: 'list' }],
  ...(address ? [['resolve_address', { address }]] : []),
];

const rows = [];
for (const [tool, args] of probes) {
  let { result, tokens: charged } = await post('/call', { session, tool, args });
  if (!result || typeof result !== 'object') {
    // ONE retry, then report. The index BUILD is deferred (see AGENTS.md), so on
    // a very large page the first retrieval call can outrun it and time out —
    // observed once on the Transformer article, where the identical call
    // succeeded immediately after. A parity audit should not fail the build over
    // that, but it must not paper over a tool that is genuinely broken either.
    ({ result, tokens: charged } = await post('/call', { session, tool, args }));
    if (result && typeof result === 'object') console.log(`  note ${tool}: first call returned no payload; succeeded on retry (deferred index)`);
  }
  if (!result || typeof result !== 'object') { check(`${tool} returned a payload (after one retry)`, false, result); continue; }

  const sdk = result._tokens;
  const budget = result._budget;

  // 1. PARITY — same number from two independent counters.
  check(`${tool}: harness charge == SDK _tokens`, charged === sdk, { charged, sdk });

  // 2. NO FREE ENVELOPE — charging without the envelope would be cheaper, and
  //    the model receives the envelope, so the higher (honest) figure is used.
  const stripped = { ...result };
  for (const k of ['_tokens', '_budget', '_etag', '_version', '_observation', '_overBudget']) delete stripped[k];
  const strippedCharge = Math.ceil(JSON.stringify(stripped).length / 4);
  check(`${tool}: envelope is charged, not free`, strippedCharge <= charged, { charged, strippedCharge });

  // 3. BUDGET ADHERENCE — declared, and honoured.
  check(`${tool}: declares a budget and lands inside it`,
    typeof budget === 'number' && budget > 0 && sdk <= budget, { sdk, budget, overBudget: result._overBudget });

  rows.push({ tool, charged, sdk, budget, strippedCharge, frac: budget ? sdk / budget : 0 });
}

console.log('\n  tool             charged   _tokens   _budget   used   no-envelope');
for (const r of rows) {
  console.log(`  ${r.tool.padEnd(16)} ${String(r.charged).padStart(7)}   ${String(r.sdk).padStart(7)}   ${String(r.budget).padStart(7)}   ${String(Math.round(r.frac * 100) + '%').padStart(4)}   ${String(r.strippedCharge).padStart(7)}`);
}

// The single sentence the race's headline depends on.
const allParity = rows.every((r) => r.charged === r.sdk);
const peak = rows.reduce((m, r) => Math.max(m, r.sdk), 0);
console.log(`\n  ${allParity ? 'PARITY HOLDS' : 'PARITY BROKEN'} across ${rows.length} tools · largest single payload ${peak.toLocaleString('en-US')} tokens`
  + `\n  (a baseline fetch of this same page ingests the whole document — see out/RESULTS.md)`);

console.log(`\n=== ${pass}/${pass + fail} checks passed ===\n`);
process.exit(fail ? 1 : 0);
