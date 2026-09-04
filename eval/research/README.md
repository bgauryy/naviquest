# Naviquest versus fetch POC

[`POC.md`](../../POC.md) is the run contract. This directory contains the small
runtime behind it:

- `harness.mjs`: measured calls, WebSocket events, and dashboard server;
- `dashboard.html`: live progress, paired answers, judging, and results;
- `schemas.mjs`: answer and judge output validation;
- `aggregate.mjs`: blind pairs, unblinding, totals, and `out/RESULTS.md`;
- `out/tasks.json`: the shared five-question plan.

## Start

Build the injected SDK and launch Chrome:

```bash
node skills/naviquest-chrome-devtools/scripts/naviquest-build.mjs --bundle-only
node skills/naviquest-chrome-devtools/scripts/open-browser.mjs --headless \
  --port 9222 --enableFeatures WebMCPTesting --url about:blank
```

Start the general Naviquest host in one long-running terminal:

```bash
node skills/naviquest-chrome-devtools/scripts/naviquest-host.mjs \
  --port 5340 --cdp-port 9222
```

Start the POC harness in another long-running terminal:

```bash
node eval/research/harness.mjs
```

Open `http://localhost:5331`. The dashboard receives live WebSocket events and
replays the current run when opened late.

The POC pins AI mode off. This avoids model download and per-page warm-up cost;
the race measures Naviquest retrieval against fetch retrieval.

## Agent sequence

1. `POST /reset`. This removes the previous generated run while preserving
   `out/tasks.json`.
2. Start exactly two agents concurrently with the shared prompt in `POC.md`.
3. Each agent creates a new `/session` for every question, sends every research
   action through `/call`, and posts each completed answer to `/finding`.
4. Wait for both five-row JSONL files.
5. Start the judge only after `aggregate.mjs validate` succeeds.

The research endpoints are:

```text
POST /session  { arm: "naviquest" | "baseline" }
POST /call     { session, tool, args, task, phase }
POST /finding  { AgentFinding }
POST /reset
POST /judge    { verdicts, ratings, verdict }
POST /load
GET  /env
```

`baseline` is the stable wire value for the fetch agent. The dashboard displays
the human-readable label “fetch.”

## Judge and report

```bash
node eval/research/aggregate.mjs validate
# Blind judge writes out/judge-raw.json.
node eval/research/aggregate.mjs unblind
node eval/research/aggregate.mjs rate
node eval/research/aggregate.mjs report
```

Post the JSON from `rate` to `/judge`. The final report contains the rollup, all
five questions, both complete answers, judge verdicts, reasons, and estimated
retrieval-payload costs. These costs use `chars/4` on returned research payloads;
they do not represent total model usage or billing.

Only the current POC run belongs in `out/`. New runs replace old answers and
judge artifacts instead of appending historical benchmark material.
