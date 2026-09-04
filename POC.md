# Run the Naviquest versus fetch POC

Run two research agents on the same five questions, then ask a third agent to
judge their answers blind. The live dashboard at `http://localhost:5331` must
show progress, answer quality, and retrieval-payload token use throughout the
run.

The comparison has one intentional difference:

- **Naviquest agent:** uses Naviquest's six WebMCP tools in real Chrome.
- **Fetch agent:** uses extracted page text and links from `fetch(url)`.

Both agents use the same model, reasoning effort, starting URL, questions,
question order, and answer goal. Each agent handles all five questions in one
model context, with a fresh measured session for each question.

## Primary result: estimated retrieval-payload tokens

Retrieval-payload efficiency is the primary measured result. Quality is the
guardrail: a cheaper incomplete answer does not win.

Every run must show these token numbers:

1. **Every call:** estimated tokens in the full research result returned to the
   agent.
2. **Every question:** Naviquest payload tokens, fetch payload tokens, and which
   arm used fewer.
3. **Each arm:** total payload tokens and median payload tokens per question.
4. **Final comparison:** median per-question ratio with IQR, plus the total-token
   ratio as a secondary summary.
5. **Largest payload:** the largest single result returned to each arm.

The harness applies the same estimator to both arms:

```text
tokens = ceil(JSON.stringify(fullToolResult).length / 4)
```

For each question, `tokens` is the sum returned by its `/call` requests, and
`contextHeld` is the largest single-call token value. A cached fetch avoids a
network request but still incurs payload tokens because the agent receives its
content again. Agents must copy these measurements from the harness; they must not
estimate or adjust them.

This metric estimates retrieval payloads visible to the agent. It does not
measure model prompt, reasoning, cached-context, or answer-generation tokens. Do
not present it as total model usage or billing.

The aggregator calculates `fetch tokens / Naviquest tokens` for each matched
question. A value above 1 means Naviquest used that many times fewer payload
tokens; a value below 1 means fetch used `1 / value` times fewer. The final headline uses
the median of these per-question ratios and reports the IQR. This prevents one
large page from dominating the comparison. The total-token ratio remains visible
but is not the primary result.

## Start the run

From the repository root, run these setup commands:

```bash
node skills/naviquest-chrome-devtools/scripts/naviquest-build.mjs --bundle-only
node skills/naviquest-chrome-devtools/scripts/open-browser.mjs --headless \
  --port 9222 --enableFeatures WebMCPTesting --url about:blank
```

Start the host in one long-running terminal:

```bash
node skills/naviquest-chrome-devtools/scripts/naviquest-host.mjs \
  --port 5340 --cdp-port 9222
```

Start the POC harness in another long-running terminal:

```bash
node eval/research/harness.mjs
```

Keep the host and harness running. Open `http://localhost:5331`, then reset the
run:

```bash
curl -sS -X POST http://localhost:5331/reset
```

`/reset` removes the previous run's generated findings, blind-judge artifacts,
and report, then records the current environment. It preserves `tasks.json`.

The harness pins built-in AI off so the POC compares deterministic Naviquest
retrieval with fetch retrieval. The five shared tasks are in
[`eval/research/out/tasks.json`](./eval/research/out/tasks.json).

## Orchestrator sequence

1. Confirm `GET http://localhost:5331/env` reports Chrome over CDP, AI off, and
   five tasks.
2. Start exactly two research agents concurrently: one Naviquest and one fetch.
3. Give both agents the shared prompt below, followed by only their arm-specific
   capability block.
4. Watch the dashboard until both arms show `5 of 5`.
5. Confirm `naviquest.jsonl` and `baseline.jsonl` each contain five schema-valid
   rows with identical `(site, task)` keys.
6. Run `node eval/research/aggregate.mjs validate` to create randomized A/B pairs.
7. Start one fresh-context judge with only `out/pairs.json` and the judge prompt.
   Do not expose the arm files or `blind-map.json` to the judge.
8. Unblind, post the ratings to the dashboard, and generate the report.
9. Verify that the dashboard and report show all token comparisons and all ten
   answer verdicts.

Do not create one agent per question. Do not start judging before both research
agents finish.

## Shared research-agent prompt

Give this prompt to both research agents:

> Read `eval/research/out/tasks.json` and answer all five questions in order.
> Start from the URL supplied with each task and use public page evidence only.
> Keep one model context for the full assignment, but create a fresh harness
> session for each question. Follow only links discovered through your allowed
> capability. Send every research action through `/call`, including the task and
> phase, so the dashboard receives live progress and measures its retrieval
> payload. The reset has removed the previous run files. Write the first
> `AgentFinding` to
> a new arm-owned JSONL file, then append one row per completed question and POST
> that same finding to `/finding`. After the final `/call` for a question, copy
> its returned `totals` into the finding: `tokens`, `calls`, `ms`,
> `pagesReached`, `contextHeld`, and `toolTrace`. Do not recalculate or edit those
> values. Continue until all five rows pass the schema. Return a compact
> completion summary with total and median retrieval-payload tokens, calls, time,
> pages, and largest payload.

Append exactly one of these capability blocks.

### Naviquest capability

> Use `arm: "naviquest"`. For each question, create `/session` with that arm.
> Use `open` plus only the six registered Naviquest tools. Navigate only to
> addresses recovered from Naviquest results. Do not use HTTP fetch, search
> engines, browser DOM tools, or prior knowledge as evidence. Write exactly five
> rows to `eval/research/out/naviquest.jsonl`.

### Fetch capability

> Use `arm: "baseline"`; the dashboard labels this arm “fetch.” Create a new
> `/session` for each question. Use only the harness `fetch` tool.
> Navigate only to links returned by fetched pages. Do not use Naviquest, search
> engines, browser DOM tools, or prior knowledge as evidence. Write exactly five
> rows to `eval/research/out/baseline.jsonl`.

## Required progress and finding data

All relative endpoints below use `http://localhost:5331` as their base. Start
each question with:

```text
POST /session { arm: "naviquest" | "baseline" }
```

Use the returned session ID for every call made for that question.

Send every research action through:

```text
POST /call { session, tool, args, task, phase }
```

The response supplies the current call's `result`, `tokens`, and `ms`, plus
authoritative per-question totals:

```text
totals { tokens, calls, ms, pagesReached, contextHeld, toolTrace }
```

`pagesReached` counts unique URLs opened or fetched in that question's session.
`toolTrace` lists every tool in call order, including cached fetches.
`contextHeld` is the largest noncached result payload. After completing a
question, copy `totals` into the schema-valid row and send it through:

```text
POST /finding {
  arm, site, task, answer,
  tokens, calls, ms, pagesReached, contextHeld, toolTrace,
  phase
}
```

The dashboard must update retrieval-payload token totals after every call. Once
both answers for a question exist, it must show both token counts and the exact
relative ratio, regardless of which arm used fewer tokens. It must never assume
Naviquest wins.

## Blind judge prompt

After `aggregate.mjs validate` succeeds, give a fresh judge only
`eval/research/out/pairs.json` and this prompt:

> For each randomized pair, verify the answers against official public WebMCP
> Challenge evidence. Assess answer A and answer B independently for correctness,
> completeness, specificity, and support. Return `correct`, `partial`, `wrong`,
> or `unsupported` with one concrete reason for each answer. Copy a short exact
> phrase from each answer into `anchorA` or `anchorB`. Preserve each supplied
> `pairId` and `pairDigest`. Do not infer which system produced an answer. Write
> exactly five schema-valid objects to `eval/research/out/judge-raw.json`.

If the judge cannot access the evidence or validate a pair, it must report the
failure instead of inventing a score.

## Publish the result

Run:

```bash
node eval/research/aggregate.mjs unblind
judge_payload=$(node eval/research/aggregate.mjs rate)
curl -sS -X POST http://localhost:5331/judge \
  -H 'content-type: application/json' --data-binary "$judge_payload"
node eval/research/aggregate.mjs report
```

The completed dashboard and
[`eval/research/out/RESULTS.md`](./eval/research/out/RESULTS.md) must show:

- all five matched questions and both complete answers;
- the judge's verdict and reason for each answer;
- retrieval-payload tokens for each arm on every question;
- the payload-token winner and ratio for every question;
- total and median retrieval-payload tokens per arm;
- median per-question token ratio, IQR, and total-token ratio; and
- calls, largest payload, pages reached, and wall-clock time.

The run passes when both arms have five findings, the judge has ten valid answer
verdicts, every payload-token total comes from `/call`, and the dashboard reaches
the results stage with complete answers.

## Last verified run

The last completed five-question run returned an estimated **19,594
retrieval-payload tokens with Naviquest** and **28,333 with fetch**. Naviquest used **1.5×
fewer payload tokens per question at the median** (IQR 1.1×–1.8×) and **1.4×
fewer in total**. These numbers record one example; they are neither an expected
result nor an acceptance threshold. Each new run must publish its own measured
comparison.
