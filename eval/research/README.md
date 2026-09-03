# Research race — naviquest vs a real fetch agent, live over WebSocket

Two **real agents** research the same tasks; a blind LLM judge scores quality. No
gold key, no assumptions: each agent produces its own answer, and efficiency
(tokens), speed (ms) and crawler reach (pages) are **measured**, not asserted.

- **naviquest agent** — the six tools (`describe_app`, `find_on_page`, and
  `locate_control`→`resolve_address` to follow links, `agentic_content`) on ONE
  persistent browser tab kept warm across tasks. It talks only to the general
  localhost host from `skills/naviquest-chrome-devtools`; that host owns Chrome,
  raw CDP, pre-navigation injection, WebMCP-domain invocation, and model state.
- **baseline agent** — a regular web-research loop: a plain `fetch(url)` tool that
  returns the page's text + links. It reads and crawls on its own.

Both run as **parallel subagents** driving the harness over `POST /call`. The full
methodology and every check that was run are in **[METHODOLOGY.md](METHODOLOGY.md)**;
a generated results table lands in **[out/RESULTS.md](out/RESULTS.md)**.

## Token accounting (audited — the number is true)

Every call is charged `chars/4` of the **full** result JSON, identically for both
arms. The naviquest envelope's `_tokens`/`_budget`/`_etag`/`_version` fields are
NOT stripped by any host (`packages/naviquest/src/index.ts:867` serializes the
whole payload to the model), so charging the full JSON matches the SDK's own
`_tokens` exactly — re-audited across all six tools by `node
eval/research/token-audit.mjs` (18/18: `describe_app` 818==818, `find_on_page`
1,096==1,096, `locate_control` 425==425, `query_selector` 932==932,
`agentic_content` 1,536==1,536, `resolve_address` 113==113) — and never
under-charges naviquest against a
`fetch` that ingests raw text.

## 1. Bring up Chrome and the SDK (the skill owns this)

**This directory measures; the skill runs. `harness.mjs` is not a second host** —
it has zero CDP, zero injection, zero Chrome logic; it only POSTs to the skill's
host and charges/times/judges what comes back. Chrome, its flags, the SDK bundle,
the CDP/WebMCP transport, session lifetime and on-device models are **not this
directory's business** — they belong to
[`skills/naviquest-chrome-devtools`](../../skills/naviquest-chrome-devtools), which
is general infrastructure for any caller. Follow its `SKILL.md`: stage the bundle,
launch Chrome, optionally warm the models, then start `naviquest-host.mjs`.
The exact flags and the measured model-warm behaviour live in the skill's
`references/chrome-flags.md`; they are deliberately not repeated here, so there is
one place to correct when Chrome changes.

The harness refuses to invent a fallback: if the port is down it says so and exits,
rather than quietly measuring a different browser.

```bash
node eval/research/harness.mjs                           # AI off (default)
AI_MODE=on node eval/research/harness.mjs                # AI on — host profile must already be warm
# NAVIQUEST_HOST=http://127.0.0.1:5440 points at a non-default skill host
# HARNESS_PORT=5444 changes the dashboard/API port when 5331 is occupied
```

`AI_MODE=off` keeps the models out of the answer path entirely
(`{answer:{verify:'off',fromRegion:'off'}}`), which is what makes the cost and
speed numbers reproducible. `AI_MODE=on` measures AI-enriched quality instead. The
model download belongs to the Chrome profile, so warm that profile first; the
harness then validates `available` on the exact page it opened before allowing a
measured tool call. It also uses the skill's shared reader-settling policy on that
same document, so the first measured result is verified (or explicitly
withheld/marked unverified). Warm-up retries count toward wall-clock but are not
agent-visible token payloads.
The dashboard header and `GET /env` report which mode a run was in.

## 2. Start the harness (serves the WebSocket dashboard)

```bash
node eval/research/harness.mjs        # http://localhost:5331
```

Open `http://localhost:5331`. The dashboard connects over a **WebSocket**; it never
polls or refreshes, and the server replays the whole run on connect, so a tab
opened late is identical to one open from the start. `POST /reset` zeroes a run.

What it shows, top to bottom:

- **now checking** — each agent's current question, site, and `read`/`crawl`
  badge, its progress (`n of 20 findings`), and a plain-language narration of the
  newest call. This is the shot that makes the race legible on video: the two
  lanes hold the *same* question while the token counters diverge.
- **same-question check** — an on-screen assertion that both arms answered the
  same keys, verbatim from `tasks.json`. Green only when the sets match.
- **bottom line** — tokens / peak context / blind-judge quality / wall-clock.
- per-arm totals, cost·context·speed bars, the blind-judge quality panel.
- **same question, both answers** — both arms' answers side by side with each
  one's judge rating, so a viewer can read the quality claim rather than trust it.
- **every step, as it happened** — one row per tool call, grouped by site.

Agents feed those views through two optional fields and one endpoint:

| Wire | Effect |
|---|---|
| `POST /call {…, task, phase}` | drives the "now checking" lanes and labels each call |
| `POST /finding {arm,site,task,phase,answer,tokens,calls,ms,contextHeld,toolTrace}` | drives progress, the same-question check, and the side-by-side answers |

`/finding` is a live-view mirror only — the authoritative record stays
`out/*.jsonl`, validated by `aggregate.mjs`.

## 3. Run the two agents in parallel

The driver `POST /reset`, then spawns two subagents that drive `POST /call`. Each
writes one `AgentFinding` per task to `out/naviquest.jsonl` / `out/baseline.jsonl`,
validated against `schemas.mjs`.

## 4. Judge blind, then aggregate

`node aggregate.mjs validate` checks both files against the zod schema and prints
anonymized A/B pairs. A blind LLM-judge subagent scores each answer
(`correct|partial|wrong|unsupported`) with no gold phrase; the driver writes
`out/verdicts.json`, runs `node aggregate.mjs rate` for the per-arm `ArmRating`,
and `POST /judge` pushes quality to the dashboard beside cost. To review a finished
run without re-running the agents, `POST /load` ingests the real `out/*.jsonl`.

## What the race actually shows

**Measured 2026-09-03 (AI off, Chrome 152):**

| | naviquest | `fetch` baseline | result |
|---|--:|--:|:--|
| quality (blind judge) | **20/20 correct** | 19.5/20 | naviquest scored higher |
| total tokens | **52,822** | 214,481 | **4.1× fewer** |
| per question (median) | — | — | **2.6× fewer** (IQR 2.2×–6.3×) |
| largest single payload | **1,551** | 38,198 | **24.6× smaller** |
| wall-clock | 15,176 ms | 6,479 ms | baseline **2.3× faster** |

naviquest answered every question correctly and spent a quarter of the tokens to
do it. The baseline's half-point came off a Node.js crawl answer whose "two
differences" were two halves of the same API point. Treat the quality margin as
this run's scoreline rather than a reliable edge — half a point out of 20 is one
judgement, within noise at this sample size; the claim the run establishes is
**no worse quality for a quarter of the tokens**.

With the on-device models ON, the same questions cost naviquest **56,284** tokens
and **90,187 ms** for **19.5/20** — +20% tokens and 5× the wall-clock against its
own AI-off pairing, for no quality gain. That is why `AI_MODE=off` is the default
rather than a fallback. `node eval/research/compare-ai.mjs` prints the head-to-head.

Quality is often a **tie** when both agents are competent and the answer is on the
page — the honest differences are:

- **tokens:** naviquest is multiples cheaper (it retrieves a bounded passage; the
  baseline ingests the whole page each fetch), and the gap widens with page size.
- **context held:** the largest single payload an agent must keep resident — a whole
  fetched page vs a budget-capped passage. This is where bounded retrieval wins
  decisively and the gap grows without limit as pages grow.
- **speed:** the baseline can win wall-clock — a `fetch` is one round-trip, while
  naviquest pays page navigations and more tool calls per crawl.

`describe_app` bounds even a 6,000-control page to ~900 tokens, so naviquest's
per-step cost stays flat where the baseline's ingest grows — the comparison holds
up to a page whose text does not fit a context window.

## Per-tool budget bars

`node eval/research/budget-bars.mjs [url]` drives all six tools once on one large
page and renders each tool's real `_tokens` against its `_budget` cap (→
`out/BUDGET.md`, also folded into `RESULTS.md`) — the proof that *every* tool is
capped, not just the read:

```
describe_app     ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▁▁    769 / 900 tok  (85%)
find_on_page     ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▁  1,096 / 1,200 tok  (91%)  ← nearest cap
locate_control   ▇▇▇▇▇▇▇▇▇▇▇▁▁▁▁▁    425 / 600 tok  (71%)
resolve_address  ▇▇▇▇▁▁▁▁▁▁▁▁▁▁▁▁    113 / 500 tok  (23%)
query_selector   ▇▇▇▇▇▇▇▇▇▇▇▇▁▁▁▁    932 / 1,200 tok  (78%)
agentic_content  ▇▇▇▇▇▇▇▇▇▇▇▇▁▁▁▁  1,536 / 2,000 tok  (77%)
```
