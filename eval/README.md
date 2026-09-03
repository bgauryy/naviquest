# eval/; the sensors

Everything behavioural is measured here, against real Chrome; never simulated.
There is exactly **one eval command** (`yarn eval`, per [AGENTS.md](../AGENTS.md));
induced failure/timing and the WebMCP platform surface live in `yarn test`
(vitest + jsdom), not here. Numbers and verdicts: [docs/EVAL.md](../docs/EVAL.md).

## Gates; offline, deterministic, may fail a build

```bash
yarn eval                    # all offline lanes; exits 1 on any failure
yarn eval --only roles       # one lane: surface | roles | contracts | frames | rank
yarn eval --verbose          # per-comparison detail (roles oracle)
```

`eval/eval.ts` launches its own Playwright Chromium and bundles the SDK itself; no server, no skill, no setup. Offline lanes:

| Lane | What it gates |
|---|---|
| `surface` | `TOOL_SPECS` instruction-token ceiling (paid on every `getTools()`) |
| `roles` | `page/roles.ts` vs aria-query in real Chrome; **run after touching `roles.ts` or `aria-taxonomy.ts`** |
| `contracts` | The six-tool behavioural surface against a local fixture |
| `frames` | Same-origin iframe discovery (`discovery.frames`) |
| `rank` | Structural ranking priors (chrome demotion), before/after on one config change |

## Live sensors; network, opt-in, never a gate

```bash
yarn eval --live                                  # gates + invariants + crawl + compare
yarn eval --live --only invariants                # one live lane
yarn eval --live --url https://react.dev/learn    # invariants on any origin (skips crawl/compare; their gold lives on MDN)
```

Live lanes drive real pages (MDN by default), so they can fail on an outage; that is why they never run by default. Artifacts land in `eval/out/`
(`invariants.json`, `compare.json`). Run `--live` before shipping SDK changes:
it is the only sensor that drives `locate_control` and `query_selector` against
a real page.

## Research race; `eval/research/` (the two-agent comparison; needs the skill)

This is where **two real agents are compared**: a naviquest agent (the six tools
on one warm tab) vs a baseline agent (a plain `fetch(url)` research loop); **20
findings each (10 read + 10 crawl) across 10 distinct large sites**
(`out/tasks.json`), blind LLM judge, live WebSocket dashboard.

**The boundary; eval measures, the skill runs.** `harness.mjs` is not a second
host: it contains zero CDP, zero injection, zero Chrome logic. It only POSTs to
the skill's host and measures what comes back. Anything about *running* naviquest
(Chrome flags, bundling, sessions, WebMCP invocation, reader settling, models)
belongs to the skill; anything about *measuring* it (tasks, charging, timing,
judging, dashboard) belongs here. If you find yourself adding runtime code to
`eval/research/`, it goes in the skill instead; and vice versa.

**Last run (2026-09-03, AI off, Chrome 152); the headline result.**

| | naviquest | `fetch` baseline | result |
|---|--:|--:|:--|
| quality (blind judge) | **20 / 20 correct** | 19.5 / 20 | naviquest scored higher |
| total tokens | **52,822** | 214,481 | **4.1× fewer** |
| per question (median) |; |; | **2.6× fewer** (IQR 2.2×–6.3×) |
| largest single payload | **1,551** | 38,198 | **24.6× smaller** |
| wall-clock | 15,176 ms | 6,479 ms | baseline **2.3× faster** |

naviquest answered every question correctly on a quarter of the tokens. Full
table: [RESULTS.md](RESULTS.md) · per-question:
[research/out/RESULTS.md](research/out/RESULTS.md).

**Separately**, naviquest was measured against *itself* with the on-device models
on and off over the same questions; a different pairing with its own AI-off run
(46,891 tokens, 20/20) as its control, so the delta is attributable to the models
rather than to run-to-run variation. AI-on cost **56,284** tokens and
**90,187 ms** for **19.5/20**: +20% tokens and 5× the wall-clock for no quality
gain, which is why `AI_MODE=off` is the default. See
[RESULTS.md §7](RESULTS.md) · `node eval/research/compare-ai.mjs`.

**What is measured, and how:**

| Metric | How |
|---|---|
| `tokens` (efficiency) | `chars/4` of the **full** tool-result JSON, identical estimator both arms. Equals the SDK's own `_tokens` exactly; audited across all six tools by `node eval/research/token-audit.mjs` (18/18: parity, envelope charged not free, every tool inside its budget) |
| `contextHeld` | largest single result the agent had to hold; capped passage vs whole page |
| `ms` (speed) | wall-clock per call, measured by the harness |
| `pagesReached` (crawler reach) | distinct URLs opened/fetched |
| quality | blind LLM judge on randomized anonymous A/B pairs; no gold key |

The steps, in order; **copy-paste runnable**:

```bash
# ── 1. Runtime: Chrome + SDK + host. Owned by the SKILL, not this directory.
node skills/naviquest-chrome-devtools/scripts/naviquest-build.mjs --bundle-only
node skills/naviquest-chrome-devtools/scripts/open-browser.mjs \
     --headless --port 9222 --enableFeatures WebMCPTesting
node skills/naviquest-chrome-devtools/scripts/naviquest-host.mjs \
     --port 5340 --cdp-port 9222 &          # leave running
curl -s http://127.0.0.1:5340/health         # expect transport: webmcp-cdp + 6 tools
#   Chrome already running on that port? add --cleanup first, or the feature flag
#   cannot be applied and WebMCP will be missing.

# ── 2. Harness + dashboard (the measurement side)
node eval/research/harness.mjs &             # http://localhost:5331
open http://localhost:5331                   # WATCH IT HERE; live, per-call, no polling
#   It refuses to start if the skill's host is down, rather than measuring a
#   different browser. Port taken? HARNESS_PORT=5444.

# ── 3. Run the TWO AGENTS in parallel on the SAME questions
curl -s -X POST http://localhost:5331/reset -d '{}'
#   Then spawn two subagents (see "Driving the two agents" below). Each drives
#   POST /call, POSTs each finished finding to /finding (this is what makes the
#   dashboard show progress and both answers), and appends one AgentFinding per
#   finding to out/naviquest.jsonl / out/baseline.jsonl.

# ── 4. Judge blind, then aggregate
node eval/research/aggregate.mjs validate    # schema check + randomized blind A/B → pairs.json
#   → spawn a THIRD subagent as blind judge: it reads out/pairs.json (answers
#     labelled A/B only, arms hidden) and writes out/judge-raw.json as
#     [{qualityA,reasonA,qualityB,reasonB}, …] in the same order.
node eval/research/aggregate.mjs unblind     # A/B back to arms via blind-map.json → verdicts.json
node eval/research/aggregate.mjs rate        # per-arm ArmRating + per-task median/IQR
#   → POST that JSON to /judge so the dashboard shows quality beside cost:
curl -s -X POST http://localhost:5331/judge -H 'content-type: application/json' \
     -d "$(node eval/research/aggregate.mjs rate)"

# ── 5. Report
node eval/research/budget-bars.mjs           # per-tool _tokens vs _budget → out/BUDGET.md
node eval/research/aggregate.mjs report      # → out/RESULTS.md (folds in the bars)

# ── Charts
node eval/research/budget-bars.mjs           # per-TOOL: each tool vs its own cap → out/BUDGET.md
node eval/research/token-bars.mjs            # per-QUESTION: naviquest vs the baseline → out/COMPARISON.md

# ── Audit the number the whole race rests on (exits 1 if it does not hold):
node eval/research/token-audit.mjs           # parity, envelope, budget; all six tools

# ── Replay a finished run into the dashboard without re-running the agents:
curl -s -X POST http://localhost:5331/load -d '{}'
```

### Running it with the on-device AI ON (and why the default is off)

`AI_MODE=off` (default) keeps the models out of the answer path
(`{answer:{verify:'off',fromRegion:'off'}}`), which is what makes cost and speed
reproducible. `AI_MODE=on` measures the AI-enriched path instead, and it needs a
**different browser launch** plus a **warm-up dwell**; both measured, neither
optional:

```bash
# Visible (non-headless) Chrome with every AI feature the SDK can use:
node skills/naviquest-chrome-devtools/scripts/open-browser.mjs --cleanup --port 9222
node skills/naviquest-chrome-devtools/scripts/open-browser.mjs --port 9222 \
  --url "https://en.wikipedia.org/wiki/Machine_learning" \
  --enableFeatures WebMCPTesting,OptimizationGuideOnDeviceModel,PromptAPIForGeminiNano,SummarizationAPIForGeminiNano,TranslationAPI,LanguageDetectionAPI

# Warm the model INSIDE a user gesture (a tool call never has one). ~55 s cold,
# then cached in the port-scoped profile; one cost per profile, not per run.
node skills/naviquest-chrome-devtools/scripts/cdp-sandbox.mjs \
     skills/naviquest-chrome-devtools/scripts/cdp-checks/model-warm.mjs --port 9222

node skills/naviquest-chrome-devtools/scripts/naviquest-host.mjs --port 5340 --cdp-port 9222 &
AI_MODE=on node eval/research/harness.mjs &   # /env and the dashboard header report the mode
```

Measured 2026-09-03 on Chrome 152 with those flags: `LanguageModel`,
`Summarizer` and `LanguageDetector` all report **`available`** on a real origin;
`Translator` is `downloadable` until a language pair is asked for; `Rewriter` and
`Writer` are absent (unused). `open` then reports `modelState: available`.

**The warm-up dwell is mandatory per page.** Gemini Nano's session is
per-document and the first `prompt()` against a fresh one costs ~19 s, which the
SDK fires in the background and fails open on. So the first `find_on_page` on a
freshly opened page comes back with **no `answer` key at all**; three
back-to-back calls returned none, and after `open` → one throwaway query → ~25 s
dwell the same queries returned `answer.verified: true`. Any AI-on driver must
warm each document (`open` → throwaway query → dwell → measured calls) and charge
that warm-up to the finding, or it will silently measure the deterministic path
while reporting `ai: on`.

**The AI arm is slower because of SETUP, not because answering is slow**; and
that is measured, not asserted:

```bash
node eval/research/ai-warmup-cost.mjs      # needs AI_MODE=on; exits 1 if AI never engaged
```

Measured 2026-09-03 (Chrome 152, visible, `LanguageModel: available`):

| phase | cost | paid |
|---|--:|---|
| `open` | 437 ms | per page |
| first `find_on_page` (cold, model still loading, **no answer**) | 218 ms | per page |
| dwell for the background Nano load | 25,000 ms | per page |
| **setup total** | **~25,400 ms** | **once per document** |
| warm query, verified answer | ~2,100–3,000 ms | per query |
| **steady state** | **~2,600 ms** | **per query** |
| same query with AI off (no model round trip) | 42–218 ms | per query |

So setup is **~10× a warm answered query**, it is paid **once per document**
because Chrome scopes the Nano session to the document, it amortises over calls
on the same page, and it vanishes entirely with AI off. The answer path itself
adds roughly 2.4 s per query over the deterministic path; real, but an order of
magnitude smaller than the setup it is easy to mistake it for.

One behaviour to read correctly: a warm query can return **no answer in ~3 s**
while a model-free call returns none in 42 ms. That is the verifier running and
**withholding** a weak candidate, which is the design (`answer.verify` downgrades
a sentence that echoes the question without answering it); not a failure.
`ai-warmup-cost.mjs` keys its pass/fail on the latency signal for exactly this
reason, so correct withholding is never scored as a broken AI path.

### Driving the two agents

Both arms must be given the **identical** question list from `out/tasks.json`
(10 sites × {read, crawl} = 20 findings), and each finding's `task` field must be
the question **verbatim**; it is the pairing key the judge and the report join
on. The dashboard shows a live `same-question check` that turns green only when
both arms have answered the same keys.

| Arm | Tool it is allowed | Session |
|---|---|---|
| `naviquest` | the six tools via `POST /call {session,tool,args,task,phase}`; `open` navigates | one warm tab for the whole run |
| `baseline` | only `fetch` via `POST /call {session,tool:"fetch",args:{url},task,phase}` | one session; re-fetching a page it already read is cached and charged 0 |

Passing `task` + `phase` on each call is what drives the "now checking" lanes;
`POST /finding` after each finding drives progress and the side-by-side answers.

### What the dashboard shows

Top to bottom: **now checking** (each agent's current question, site, read/crawl
badge, progress `n of 20`, and a plain-language narration of the newest call) ·
the **same-question check** · **bottom line** tiles (tokens, context, quality,
speed) · per-arm totals · cost/context/speed bars · **blind-judge quality** ·
**same question, both answers** with each arm's rating · every step as it
happened. A tab opened late replays the whole run.

The harness refuses to start if the skill's host port is down; it will not
quietly measure a different browser. Details and every audit that was run:
[research/README.md](research/README.md) ·
[research/METHODOLOGY.md](research/METHODOLOGY.md). Finished-run artifacts live
in `research/out/` (`RESULTS.md`, `verdicts.json`, the two `*.jsonl` finding
files); `POST /load` replays them on the dashboard without re-running agents.

Note: `yarn eval --live --only compare` is a **different** comparison; one
estimator pricing `ariaSnapshot` vs SDK+host vs tools-alone on the same
questions, inside `eval.ts`. The two-agent race is only in `eval/research/`.

## Rules that keep the numbers honest

- Gates fail builds; sensors inform. Never fold a live lane into a gate.
- Never tune on the pages you measure (KPI first, sweep DEV, verdict HELD-OUT).
- Doc figures are historical unless the page names a live command; re-measure
  before adding a number.
