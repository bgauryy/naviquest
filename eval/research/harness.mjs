/**
 * Research harness — two REAL agents race on the same task, live over WebSocket.
 *   node eval/research/harness.mjs        → http://localhost:5331  (open the dashboard)
 *
 * No gold, no assumptions. Each agent gets a research question and its OWN tools:
 *   - the NAVIQUEST agent calls the six tools on ONE persistent browser tab.
 *   - the BASELINE agent uses a plain `fetch` web tool (GET a URL → page text),
 *     exactly what a regular research agent does — it reads pages and decides.
 * Every returned research payload is estimated (tokens = chars/4) and TIMED
 * (ms), then broadcast to the dashboard over a WebSocket the instant it happens
 * — the page never polls or refreshes. The driver spawns two research agents; an LLM judge
 * scores their answers blind. Crawler / efficiency / speed all fall out of the
 * per-call stats.
 *
 * Chrome, the SDK bundle, the CDP transport and the on-device models are ALL the
 * skill's job (skills/naviquest-chrome-devtools; see README.md step 1). This file
 * owns only the measurement: what to ask, what it cost, and who judged it. It
 * talks only to the skill's general localhost host; there is no CDP, injection,
 * model, or reader policy here to drift from the runtime being evaluated.
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const PORT = Number(process.env.HARNESS_PORT || 5331);
const NAVIQUEST_HOST = process.env.NAVIQUEST_HOST || 'http://127.0.0.1:5340';
const tok = (s) => Math.ceil((s || '').length / 4);
const now = () => Number(process.hrtime.bigint() / 1000000n);

// TRUE agent-visible cost, counted the SAME way for both arms so the comparison
// is fair. AUDITED (packages/naviquest: index.ts `wrap` serializes the WHOLE
// payload with JSON.stringify and no host strips the `_tokens`/`_budget`/`_etag`/
// `_version`/`_observation` envelope fields — they ship to the model verbatim, and
// the SDK's own `_tokens` is chars/4 of that same full JSON (text.ts
// estimateTokens; re-verified live 2026-09-03: harness 769 == _tokens 769, and
// again 500 == 500 on find_on_page). So charge the
// full result JSON — stripping the envelope would UNDER-charge naviquest against a
// baseline `fetch` that ingests raw text. Identical chars/4 estimator on both arms.
function agentTokens(result) {
  return tok(JSON.stringify(result));
}

/**
 * Which arm of the run this is measuring. Two states are reproducible and one
 * is not, so it is an explicit choice rather than whatever the profile happens
 * to hold:
 *   AI_MODE=off  (default) — the answer lanes never touch a model. Cost and
 *                speed are the retrieval path's own, and cannot jitter.
 *   AI_MODE=on   — measures AI-enriched quality. ONLY valid once the models
 *                report `available`; warm them with the skill's model-warm
 *                check on the same tab first. A cold model here silently fails
 *                open to lexical mid-run, which is the one unreproducible state.
 */
const AI_MODE = process.env.AI_MODE === 'on' ? 'on' : 'off';
// Tuning knobs live UNDER `tuning` — createNaviquest does resolveConfig(config.tuning),
// so a top-level `answer` is silently ignored. (This bit us: the pin only "worked"
// because AI is download-gated under automation and falls open to deterministic.)
const SDK_CONFIG = AI_MODE === 'on' ? {} : { tuning: { answer: { verify: 'off', fromRegion: 'off' } } };

async function hostRequest(pathname, init) {
  const response = await fetch(`${NAVIQUEST_HOST}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Naviquest host HTTP ${response.status}`);
  return payload;
}

let hostHealth;
try { hostHealth = await hostRequest('/health'); }
catch {
  console.error(`\n  Naviquest host is not reachable at ${NAVIQUEST_HOST}.\n  Start the general host from skills/naviquest-chrome-devtools, then retry.\n`);
  process.exit(1);
}
const chromeVersion = hostHealth.browser;
const connectedOverCDP = hostHealth.transport === 'webmcp-cdp';

const NQ_TOOLS = new Set(['describe_app', 'find_on_page', 'locate_control', 'query_selector', 'resolve_address', 'agentic_content']);
const sessions = new Map();   // id -> per-question measured state
let nextId = 1;

// Cumulative per-ARM totals — the single source of truth the dashboard displays.
// Per-session counters were the bug: several sessions of one arm each reported
// their own small total, so the header showed the newest session, not the arm.
const armTotal = () => ({ tokens: 0, calls: 0, ms: 0, pages: new Set(), done: new Set(), now: null, liveCalls: 0 });
const arm = { naviquest: armTotal(), baseline: armTotal() };
const armView = (a) => ({ tokens: a.tokens, calls: a.calls, ms: a.ms, pages: a.pages.size, done: a.done.size, now: a.now });
const sessionView = (s) => ({
  tokens: s.tokens,
  calls: s.calls,
  ms: s.ms,
  pagesReached: s.pages.size,
  contextHeld: s.contextHeld,
  toolTrace: [...s.toolTrace],
});

/**
 * The PLAN — what both arms are asked, read once at boot from out/tasks.json.
 * The dashboard needs it to show progress as "7 of 20" rather than an unbounded
 * ticker, and to prove on screen that both agents got the SAME questions: the
 * plan is the single list, and each arm's `done` set is keyed against it.
 */
let plan = { sites: [], findings: 0, tasks: [], taskPlanHash: null };
try {
  const raw = JSON.parse(await readFile(path.join(OUT, 'tasks.json'), 'utf8'));
  // A POC can define one independent research question per row (`task`) while
  // the broader benchmark pairs read/crawl questions. Normalize both shapes at
  // the dashboard boundary so the measured call and grading paths stay shared.
  const tasks = raw.flatMap((t) => t.task
    ? [{ site: t.site, phase: t.phase === 'crawl' ? 'crawl' : 'read', task: t.task }]
    : [
      { site: t.site, phase: 'read', task: t.read },
      { site: t.site, phase: 'crawl', task: t.crawl },
    ]);
  plan = {
    sites: [...new Set(raw.map((t) => t.site))],
    findings: tasks.length,
    tasks,
    taskPlanHash: createHash('sha256').update(JSON.stringify(tasks)).digest('hex'),
  };
} catch { console.error('[harness] out/tasks.json unreadable — progress will be unbounded'); }

const envView = () => ({ connectedOverCDP, chromeVersion, aiMode: AI_MODE, naviquestHost: NAVIQUEST_HOST, plan });
const CURRENT_RUN_ARTIFACTS = [
  'naviquest.jsonl', 'baseline.jsonl', 'pairs.json', 'blind-map.json',
  'judge-raw.json', 'verdicts.json', 'RESULTS.md', 'env.json',
];
async function resetRunArtifacts() {
  await Promise.all(CURRENT_RUN_ARTIFACTS.map((file) => rm(path.join(OUT, file), { force: true })));
  await writeFile(path.join(OUT, 'env.json'), `${JSON.stringify(envView(), null, 2)}\n`);
}

const wss = new WebSocketServer({ noServer: true });
const clients = new Set();
const bcast = (o) => { const m = JSON.stringify(o); for (const c of clients) if (c.readyState === 1) c.send(m); };

// Server-side run state, so a dashboard tab opened at ANY time replays the whole
// eval from the beginning instead of only seeing live events after it connected.
const run = { events: [], verdicts: null, ratings: null, verdict: null };
const record = (o) => { run.events.push(o); if (run.events.length > 1000) run.events.shift(); bcast(o); };
const host = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; } };

async function newSession(armName) {
  const id = 's' + (nextId++);
  const sess = {
    id, arm: armName, calls: 0, tokens: 0, ms: 0,
    pages: new Set(), contextHeld: 0, toolTrace: [], site: '',
  };
  if (armName === 'naviquest') {
    const created = await hostRequest('/session', {
      method: 'POST',
      body: JSON.stringify({
        config: SDK_CONFIG,
        requireModel: AI_MODE === 'on',
        primeReader: AI_MODE === 'on',
      }),
    });
    sess.hostSession = created.id;
  }
  sessions.set(id, sess);
  record({ ev: 'session', id, arm: armName });
  return id;
}

async function closeNaviquestSessions() {
  const remote = [...sessions.values()].filter((session) => session.hostSession);
  await Promise.allSettled(remote.map((session) => hostRequest(`/session/${encodeURIComponent(session.hostSession)}`, {
    method: 'DELETE',
  })));
  sessions.clear();
}

async function runCall(sess, tool, args, meta) {
  const t0 = now();
  let result, note = '';
  // Agents declare which finding a call belongs to (`task` + `phase`). It is
  // optional so a bare tool call still measures, but when supplied the dashboard
  // can show WHAT each agent is working on right now — the thing a viewer needs
  // to see to believe both arms answered the same question.
  if (meta?.task) {
    sess.task = String(meta.task); sess.phase = meta.phase === 'crawl' ? 'crawl' : 'read';
    arm[sess.arm].now = { site: sess.site || host(args?.url) || '', task: sess.task, phase: sess.phase };
  }
  if (sess.arm === 'baseline') {
    // A STEELMANNED regular agent's web tool: readability-extracted main content
    // (not the whole raw page), plus links, with a per-session fetch cache. A cache
    // hit avoids network work, but its returned payload is still charged because
    // the agent receives those bytes again.
    if (tool !== 'fetch') throw new Error('baseline has only the `fetch` tool');
    const url = args.url;
    (sess.fetchCache ||= new Map());
    const cached = sess.fetchCache.get(url);
    if (cached) {
      const result = { ...cached, cached: true };
      const t = agentTokens(result);
      sess.pages.add(url); sess.site = host(url);
      const ms0 = now() - t0;
      sess.calls++; sess.tokens += t; sess.ms += ms0;
      sess.contextHeld = Math.max(sess.contextHeld, t); sess.toolTrace.push(tool);
      const A0 = arm[sess.arm];
      A0.calls++; A0.tokens += t; A0.ms += ms0; A0.liveCalls++; for (const p of sess.pages) A0.pages.add(p);
      record({ ev: 'call', id: sess.id, arm: sess.arm, site: sess.site, tool, tokens: t, ms: ms0, contextHeld: t,
        task: sess.task || null, phase: sess.phase || null,
        note: `fetch ${host(url)} (cache hit; returned payload charged)`, totals: armView(A0) });
      return { result, tokens: t, ms: ms0, totals: sessionView(sess) };
    }
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (research-agent)' }, signal: AbortSignal.timeout(20000) });
    const html = await res.text();
    // Readability-lite: prefer the main/article region and drop boilerplate
    // containers (nav, header, footer, aside, forms) the way trafilatura/Jina do,
    // so the baseline is a competent extractor, not a whole-page dump.
    const main = (html.match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/i)
      || html.match(/<[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/[^>]+>/i));
    const bodyHtml = (main ? main[1] : html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ');
    const text = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
    // Links come from the FULL html so crawl targets in nav are still discoverable.
    const links = []; const seen = new Set();
    for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      let href; try { href = new URL(m[1], url).href; } catch { continue; }
      if (!/^https?:/.test(href) || seen.has(href)) continue;
      const label = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!label) continue; seen.add(href); links.push({ href, label });
      if (links.length >= 150) break;
    }
    sess.pages.add(url); sess.site = host(url);
    result = { url, text: text.slice(0, 200000), links };
    sess.fetchCache.set(url, result);
    note = `fetch ${host(url)}${new URL(url).pathname} — ${text.length} chars (readability), ${links.length} links`;
  } else {
    // The eval knows only the skill host's public contract. Chrome, CDP,
    // injection, WebMCP invocation, model checks, and reader settlement stay in
    // the standalone skill.
    if (tool !== 'open' && !NQ_TOOLS.has(tool)) throw new Error(`unknown naviquest tool: ${tool}`);
    const called = await hostRequest('/call', {
      method: 'POST',
      body: JSON.stringify({ session: sess.hostSession, tool, input: args || {} }),
    });
    result = called.result;
    if (tool === 'open') {
      sess.pages.add(args.url);
      sess.site = host(args.url);
      note = `open ${host(args.url)}${new URL(args.url).pathname}`;
    } else {
      note = `${tool}(${JSON.stringify(args).slice(0, 40)})${called.meta?.reader && called.meta.reader !== 'not-needed' ? ` [reader:${called.meta.reader}]` : ''}`;
    }
  }
  const ms = now() - t0, t = agentTokens(result);
  sess.calls++; sess.tokens += t; sess.ms += ms;
  sess.contextHeld = Math.max(sess.contextHeld, t); sess.toolTrace.push(tool);
  const A = arm[sess.arm];
  A.calls++; A.tokens += t; A.ms += ms; A.liveCalls++; for (const p of sess.pages) A.pages.add(p);
  if (sess.task) A.now = { site: sess.site, task: sess.task, phase: sess.phase };
  record({ ev: 'call', id: sess.id, arm: sess.arm, site: sess.site, tool, tokens: t, ms, contextHeld: t, note,
    task: sess.task || null, phase: sess.phase || null,
    totals: armView(A) });   // per-ARM cumulative, not per-session
  return { result, tokens: t, ms, totals: sessionView(sess) };
}

// JSON.parse must be wrapped: a malformed body (curl escaping the complex answer
// text) used to throw inside this `end` callback — outside the handler's try/catch —
// and crash the whole process mid-eval. Reject instead; the handler returns a 500.
const body = (req) => new Promise((resolve, reject) => {
  let b = ''; req.on('data', (c) => b += c);
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});
// A single bad request or host hiccup must never take the harness down mid-run.
process.on('uncaughtException', (e) => console.error('[harness] uncaught (ignored):', e?.message || e));
process.on('unhandledRejection', (e) => console.error('[harness] unhandledRejection (ignored):', e?.message || e));
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/' ) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(await readFile(path.join(HERE, 'dashboard.html'), 'utf8')); return; }
    if (req.url === '/session' && req.method === 'POST') {
      const { arm } = await body(req);
      if (arm !== 'naviquest' && arm !== 'baseline') { res.writeHead(400); res.end(JSON.stringify({ error: 'arm must be naviquest|baseline' })); return; }
      const id = await newSession(arm); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id, arm })); return;
    }
    if (req.url === '/call' && req.method === 'POST') {
      const { session, tool, args, task, phase } = await body(req); const sess = sessions.get(session);
      if (!sess) { res.writeHead(404); res.end(JSON.stringify({ error: 'no such session' })); return; }
      const out = await runCall(sess, tool, args || {}, { task, phase });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); return;
    }
    // An arm declares a finding FINISHED. Purely for the live view: progress
    // ("11 of 20"), and the per-task answer both arms produced, so a viewer can
    // read the two answers to the same question side by side while it runs. The
    // authoritative record is still out/*.jsonl, validated by aggregate.mjs.
    if (req.url === '/finding' && req.method === 'POST') {
      const f = await body(req);
      const A = arm[f.arm];
      if (!A) { res.writeHead(400); res.end(JSON.stringify({ error: 'arm must be naviquest|baseline' })); return; }
      A.done.add(`${f.site} :: ${f.task}`);
      A.now = null;
      // An arm can arrive here two ways. Normally its calls already went through
      // /call and the totals are live — adding the finding again would double
      // count. But an arm REUSED from an earlier run (the baseline has no AI
      // path, so an AI run replays it rather than re-running it) has made no
      // live calls, and without this it renders as 20 findings costing zero
      // tokens. Fold the finding's own measurements in only in that case.
      if (A.liveCalls === 0) {
        A.tokens += Number(f.tokens) || 0;
        A.calls += Number(f.calls) || 0;
        A.ms += Number(f.ms) || 0;
        for (let i = 0; i < (Number(f.pagesReached) || 0); i++) A.pages.add(`${f.site}#${A.pages.size}`);
      }
      record({ ev: 'finding', arm: f.arm, site: f.site, task: f.task, phase: f.phase || null,
        answer: String(f.answer || ''), tokens: f.tokens || 0, calls: f.calls || 0,
        ms: f.ms || 0, contextHeld: f.contextHeld || 0, toolTrace: f.toolTrace || [],
        totals: armView(A) });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return;
    }
    if (req.url === '/reset' && req.method === 'POST') {
      await closeNaviquestSessions();
      await resetRunArtifacts();
      arm.naviquest = armTotal(); arm.baseline = armTotal();
      run.events = []; run.verdicts = null; run.ratings = null; run.verdict = null;
      bcast({ ev: 'reset' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, cleared: CURRENT_RUN_ARTIFACTS, env: envView() }));
      return;
    }
    // The driver posts the blind LLM-judge results here; the dashboard renders
    // quality next to cost — both are the point, neither alone is.
    if (req.url === '/judge' && req.method === 'POST') { const b = await body(req); run.verdicts = b.verdicts || null; run.ratings = b.ratings || null; run.verdict = b.verdict || null; record({ ev: 'judge', verdicts: run.verdicts, ratings: run.ratings, verdict: run.verdict }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
    // Load a COMPLETED run's real findings into the dashboard (task-granular rows
    // with the true measured cost), so a tab shows the whole eval without a live
    // re-run. Rows are the real per-task totals from out/*.jsonl — not synthetic.
    if (req.url === '/load' && req.method === 'POST') {
      arm.naviquest = armTotal(); arm.baseline = armTotal(); run.events = [];
      for (const a of ['naviquest', 'baseline']) {
        const f = path.join(OUT, `${a}.jsonl`);
        let text; try { text = await readFile(f, 'utf8'); } catch { continue; }
        const rows = text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const A = arm[a];
        for (const r of rows) {
          A.calls += r.calls; A.tokens += r.tokens; A.ms += r.ms;
          for (let i = 0; i < r.pagesReached; i++) A.pages.add(`${r.site}#${A.pages.size}`);
          A.done.add(`${r.site} :: ${r.task}`);
          record({ ev: 'call', id: a, arm: a, site: r.site, tool: (r.toolTrace || []).join('→') || 'task',
            tokens: r.tokens, ms: r.ms, contextHeld: r.contextHeld, note: r.task, task: r.task,
            answer: String(r.answer || ''), totals: armView(A) });
          record({ ev: 'finding', arm: a, site: r.site, task: r.task, phase: r.phase || 'read',
            answer: String(r.answer || ''), tokens: r.tokens, calls: r.calls,
            ms: r.ms, contextHeld: r.contextHeld, toolTrace: r.toolTrace || [], totals: armView(A) });
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return;
    }
    if (req.url === '/env' ) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(envView())); return; }
    res.writeHead(404); res.end('not found');
  } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message).slice(0, 200) })); }
});
server.on('upgrade', (req, sock, head) => { wss.handleUpgrade(req, sock, head, (ws) => {
  clients.add(ws); ws.on('close', () => clients.delete(ws));
  // Replay the whole run so a tab opened late is identical to one open all along.
  ws.send(JSON.stringify({ ev: 'snapshot', connectedOverCDP, chromeVersion, aiMode: AI_MODE, plan, events: run.events, verdicts: run.verdicts, ratings: run.ratings, verdict: run.verdict }));
}); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  await closeNaviquestSessions();
  server.close(() => process.exit(0));
});
server.listen(PORT, () => console.log(`\n  research harness → http://localhost:${PORT}  (skill host → ${chromeVersion}, ai: ${AI_MODE})\n  agent tools: POST /session {arm} · POST /call {session,tool,args}\n`));
