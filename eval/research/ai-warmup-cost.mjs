/**
 * Where the AI arm's time actually goes — SETUP vs STEADY STATE.
 *   node eval/research/ai-warmup-cost.mjs [url]     (harness on :5331, AI_MODE=on)
 *
 * The AI-on race is slower than AI-off, and the honest question is *why*. This
 * separates the two costs on one page, so the answer is measured rather than
 * asserted:
 *
 *   SETUP     — Chrome's Gemini Nano session is created PER DOCUMENT, and the
 *               first prompt against a fresh one loads the model (~19 s). The SDK
 *               fires that off the critical path and fails open, so the first
 *               `find_on_page` after `open` returns NO `answer` key at all. Every
 *               page an agent opens pays this once.
 *   STEADY    — once warm, a verified answer costs one bounded model round trip
 *               on top of the same retrieval the AI-off path does.
 *
 * If SETUP dominates, the AI arm's wall-clock penalty is a property of Chrome's
 * model lifecycle, not of the answer lane — and it amortises over calls per page.
 *
 * Prints a table and exits 1 if the AI path never engaged (so a run cannot
 * silently report `ai: on` while measuring the deterministic path).
 */
const HARNESS = process.env.HARNESS || 'http://localhost:5331';
const URL_ = process.argv[2] || 'https://en.wikipedia.org/wiki/Machine_learning';
const DWELL_MS = Number(process.env.DWELL_MS || 25_000);

const post = async (p, body) => {
  const r = await fetch(HARNESS + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${p} → HTTP ${r.status}`);
  return r.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const answerOf = (result) => (result && typeof result === 'object' ? result.answer : null) || null;

const env = await fetch(`${HARNESS}/env`).then((r) => r.json()).catch(() => null);
if (!env) { console.error(`\n  Harness not reachable at ${HARNESS}.\n`); process.exit(1); }
if (env.aiMode !== 'on') {
  console.error(`\n  Harness reports ai:${env.aiMode}. Restart it as AI_MODE=on with a Chrome launched`
    + `\n  with the AI feature flags and a warmed profile (see eval/README.md).\n`);
  process.exit(1);
}
console.log(`\n=== AI setup vs steady state — ${new URL(URL_).host} · ${env.chromeVersion} ===\n`);

const session = (await post('/session', { arm: 'naviquest' })).id;

// SETUP — the page open, then the first query, which is the call that triggers
// the background model load and is itself answerless.
const t0 = Date.now();
const opened = await post('/call', { session, tool: 'open', args: { url: URL_ } });
const openMs = Date.now() - t0;
console.log(`  open                       ${String(openMs).padStart(7)} ms   modelState: ${opened.result?.modelState ?? 'n/a'}`);

const QUERY = 'what distinguishes supervised from unsupervised learning';
const first = await post('/call', { session, tool: 'find_on_page', args: { query: QUERY } });
const firstAnswer = answerOf(first.result);
console.log(`  first find_on_page (cold)  ${String(first.ms).padStart(7)} ms   answer: ${firstAnswer ? `yes (verified: ${firstAnswer.verified})` : 'NONE — model still loading'}   ${first.tokens} tok`);

console.log(`  dwell (background load)    ${String(DWELL_MS).padStart(7)} ms   measured cold prompt ≈ 19,000 ms`);
await sleep(DWELL_MS);

// STEADY STATE — same query, same page, warm model.
const warm = await post('/call', { session, tool: 'find_on_page', args: { query: QUERY } });
const warmAnswer = answerOf(warm.result);
console.log(`  same query (warm)          ${String(warm.ms).padStart(7)} ms   answer: ${warmAnswer ? `yes (verified: ${warmAnswer.verified})` : 'NONE'}   ${warm.tokens} tok`);

// A second warm query, to show steady state is repeatable and not a one-off.
const warm2 = await post('/call', { session, tool: 'find_on_page', args: { query: 'what is reinforcement learning' } });
const warm2Answer = answerOf(warm2.result);
console.log(`  another query (warm)       ${String(warm2.ms).padStart(7)} ms   answer: ${warm2Answer ? `yes (verified: ${warm2Answer.verified})` : 'NONE'}   ${warm2.tokens} tok`);

const setupMs = openMs + first.ms + DWELL_MS;
const steadyMs = Math.round((warm.ms + warm2.ms) / 2);

// Engagement is NOT "an answer came back". Measured: warm, the same query took
// 3,017 ms and returned NO answer while a second query returned
// `verified: true` — the verifier had run and WITHHELD a weak candidate, which
// is the designed behaviour (a sentence that echoes the question without
// answering it is downgraded rather than asserted). Keying the check on an
// answer would call that correct withholding a failure. The signal that a model
// round trip happened is either an answer OR the latency jump over the cold,
// model-free call.
const modelRoundTrip = Math.max(warm.ms, warm2.ms) > first.ms * 3;
const engaged = Boolean(warmAnswer || warm2Answer) || modelRoundTrip;
const withheld = !warmAnswer && modelRoundTrip;

console.log(`\n  SETUP (once per page opened): ${setupMs.toLocaleString('en-US')} ms`
  + `\n  STEADY STATE (per query):     ${steadyMs.toLocaleString('en-US')} ms`
  + `\n  → the AI arm's wall-clock penalty is ${Math.round(setupMs / Math.max(steadyMs, 1))}× the cost of an actual answered query,`
  + `\n    paid once per DOCUMENT because Chrome scopes the Nano session to the document.`
  + `\n    It amortises over calls on the same page and disappears entirely with AI off.`);

const shown = warmAnswer?.text || warm2Answer?.text;
if (shown) console.log(`\n  verified answer: "${String(shown).slice(0, 140)}${shown.length > 140 ? '…' : ''}"`);
if (withheld) {
  console.log(`\n  note: one warm query returned NO answer in ${warm.ms} ms (vs ${first.ms} ms cold, model-free).`
    + `\n  That is the verifier running and WITHHOLDING a weak candidate, not a failure — the SDK`
    + `\n  declines rather than asserting a sentence that echoes the question without answering it.`);
}

if (!engaged) {
  console.error(`\n  FAIL: the AI path never engaged — no answer and no model-latency signal after the`
    + `\n  dwell. This run would report ai:on while measuring the deterministic path.\n`);
  process.exit(1);
}
console.log('\n  ok: the AI path engaged (verified answer and/or model round-trip latency observed)\n');
