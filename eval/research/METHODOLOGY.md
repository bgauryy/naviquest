# Methodology; how the research race works, and everything that was checked

This eval answers one question honestly: **when a real agent researches real
websites, what does using naviquest's tools change versus the agent using its own
`fetch` web tool?** It is built so anyone can reproduce it and audit every claim.

## The design in one paragraph

Two **real LLM agents** (spawned as subagents) get the **same** open research tasks
over 10 large pages across 10 distinct sites; a `read` (answer on the page) and a `crawl` (follow a link and
answer on the next page) each. One agent calls naviquest's six tools; the other uses
only a plain `fetch(url) → text + links` tool, the ordinary web-research loop. There
is **no gold answer** anywhere: a blind LLM judge scores each answer
`correct | partial | wrong | unsupported` without knowing which system produced it.
Everything else; tokens, **context held**, wall-clock ms, pages reached; is
measured by the harness, never asserted.

## Runtime boundary

The eval calls the general localhost host in `skills/naviquest-chrome-devtools`;
it contains no browser implementation. The host owns a real Chrome tab, raw CDP,
pre-navigation SDK injection, and tool calls through the **WebMCP CDP domain**.
This is the same public host any agent or program can use, not an eval-only path.
The baseline arm uses Node's `fetch`. Neither arm uses Playwright.

## The metrics

| metric | meaning | who measures |
|---|---|---|
| **quality** | `correct/partial/wrong/unsupported` | blind LLM judge (no gold) |
| **tokens** | total cost to complete a task = chars/4 of every tool/fetch result | harness |
| **context held** | the *largest single payload* the agent must hold at once; a whole page vs a budget-capped passage | harness (max single call) |
| **speed** | wall-clock ms | harness |
| **crawler reach** | pages reached (1 read, 2 crawl) | harness |

## This run's result (2026-09-03, AI off, Chrome 152)

| | naviquest | `fetch` baseline | result |
|---|--:|--:|:--|
| quality (blind judge) | **20/20 correct** | 19.5/20 (19 correct, 1 partial) | naviquest scored higher |
| total tokens | **52,822** | 214,481 | **4.1× fewer** |
| per question (median) |; |; | **2.6× fewer** (IQR 2.2×–6.3×) |
| largest single payload | **1,551** | 38,198 | **24.6× smaller** |
| wall-clock | 15,176 ms | 6,479 ms | baseline **2.3× faster** |
| tool calls / fetches | 93 | 22 |; |

naviquest answered all 20 correctly on a quarter of the tokens. The baseline's
half-point came off one Node.js crawl answer. **Read the quality margin as this
run's scoreline, not a reliable edge**; half a point out of 20 is a single
judgement and sits inside the noise this design can resolve; what the run
establishes is *no worse quality for a quarter of the tokens*. The
non-negotiable number is the flat cap: 1,551 tokens for the largest single tool
result against a 38,198-token page, which does not depend on how the questions
were chosen.

## Every check that was run (and why you can trust the numbers)

1. **Token accounting is audited, not assumed; and the audit is re-runnable.**
   `node eval/research/token-audit.mjs` drives all six tools on a real page and
   checks three things per tool, exiting 1 if any fails: **parity** (the harness's
   charge equals the SDK's own `_tokens`, from two independent counters),
   **no free envelope** (recomputing the charge with
   `_tokens`/`_budget`/`_etag`/`_version` removed comes out *lower*; that
   undercharge is deliberately refused, because the model receives those fields),
   and **budget adherence** (each tool declares `_budget` and lands inside it).
   Last run: **18/18 across all six tools**, exact parity on every one
   (`describe_app` 818==818, `find_on_page` 1,096==1,096, `locate_control`
   425==425, `query_selector` 932==932, `agentic_content` 1,536==1,536,
   `resolve_address` 113==113); largest single payload 1,536 tokens on a page
   whose full text costs the baseline ~38,000. The underlying reason it holds:
   `packages/naviquest/src/index.ts` serializes the whole payload to the model and
   no host strips the envelope, while the SDK's `_tokens` is `chars/4` of that
   same full JSON (`retrieval/text.ts` `estimateTokens`, applied in
   `tools/budget.ts`).
2. **Every result is schema-validated.** `schemas.mjs` (zod) validates every
   `AgentFinding` and `JudgeVerdict`; a malformed line throws with its field path
   before it can skew a score. `aggregate.mjs validate` runs this over both files.
3. **The judge is blind.** It receives anonymized A/B answer pairs with RANDOMIZED per-task order (no arm labels; the mapping is withheld in blind-map.json)
   and scores each against the question using its own knowledge; there is no answer
   key that could bias toward either system.
4. **CSP-proof injection is verified live** on MDN and Wikipedia (strict CSP); the
   naviquest tools return real results there, proving the CDP injection path, not a
   permissive-site artifact.
5. **The crawl path is real, not scripted.** The agent discovers each link itself:
   `open → locate_control({description}) → resolve_address` (returns the link's
   `navigation.href`) `→ open(href) → find_on_page`. No target URL is hardcoded.
6. **Declared AI state.** Chrome's built-in AI is download-gated, so a run is one
   of two declared arms and never an accident of whatever the profile held.
   `AI_MODE=off` (default) pins the deterministic retrieval path
   (`answer:{verify:'off',fromRegion:'off'}`); the tools still crawl and retrieve;
   only the nondeterministic enrichment is off. `AI_MODE=on` measures enrichment,
   and requires the skill to warm the Chrome profile first. The harness then checks
   `available` on each exact page it opens and uses the skill's shared reader-settling
   policy on that document; it does not permit a cold model to fail open part-way
   through a measured arm. The mode is reported by `GET /env` and in the dashboard
   header, so it is stated, not hidden.
7. **Per-arm totals are cumulative and single-sourced** in the harness, so the
   dashboard header always equals the sum of its rows.

## Reproduce it

```bash
# 1. Chrome, flags, SDK bundle, optional model warm-up, and the general host:
#    all via skills/naviquest-chrome-devtools/SKILL.md. Not restated here.

# 2. Start the harness (serves the WebSocket dashboard at :5331)
node eval/research/harness.mjs

# 3. Reset, then run the two agents (subagents) against out/tasks.json,
#    each writing one AgentFinding per task to out/naviquest.jsonl / out/baseline.jsonl
curl -s -X POST http://localhost:5331/reset -d '{}'

# 4. Validate, judge blind, aggregate, and emit the Markdown report
node eval/research/aggregate.mjs validate       # schema check + RANDOMIZED blind A/B pairs → pairs.json + blind-map.json
#   → an LLM judge scores pairs.json (A/B only, no arm labels) into out/judge-raw.json
node eval/research/aggregate.mjs unblind         # maps judge A/B back to arms via blind-map.json → verdicts.json
node eval/research/aggregate.mjs rate            # per-arm ArmRating + per-task median/IQR (POST to /judge)
node eval/research/budget-bars.mjs               # per-tool _tokens vs _budget bars → out/BUDGET.md
node eval/research/aggregate.mjs report          # writes out/RESULTS.md (folds in the budget bars)
```

## What this version fixed (from adversarial review)

An earlier version was attacked; correctly; for an inflated headline. This version
addresses the top findings; the harness and reporting now:

- **Steelman the baseline**; `fetch` returns **readability-extracted main content**
  (prefers `<main>`/`<article>`, drops nav/header/footer/aside/forms), not a
  whole-page dump.
- **Kill the cross-task double-count**; a **per-session fetch cache** makes
  re-fetching a page the agent already read **free (0 tokens)**, so a crawl is not
  charged again for the start page it already holds (the ~⅓ inflation is gone).
- **Report distributions**; per-task **median + IQR** token ratio, not just the
  sum-ratio that the largest pages dominate.
- **Randomize + blind the judge**; A/B order is shuffled per task and the arm
  label never reaches the judge (`blind-map.json` maps back afterward).
- **Tasks that can fail**; questions now require complete/specific answers
  (enumerations, exact values), so a partial retrieval can score `partial`/`wrong`.
- **Ten distinct sites**; the task list was one site short of its claim (two
  Wikipedia and two MDN entries); `nodejs.org` and `git-scm.com` replaced the
  duplicates, so 20 findings now span 10 different domains.
- **Fixed a runtime bug the race exposed, rather than routing around it.** The
  first run's naviquest arm failed every call on `react.dev` and `vuejs.org` with
  `resolved to N frames`: the skill's install script runs on every new document,
  so a page with iframes registers the six tool names once per frame and the host
  refused the ambiguity. The host now addresses the page's **main frame** and
  treats sub-frame registrations as noise. This was a defect in the runtime under
  test; the honest fix is in the skill (`naviquest-host.mjs`), covered by a
  hermetic regression whose sub-frames carry a *decoy* answer, so reading the
  wrong frame fails loudly (`naviquest.check.mjs`, 19 assertions). An eval that
  works around a runtime bug measures the workaround, not the runtime.

## Residual caveats (still true; read honestly)

- **The judge scores against world knowledge, not the retrieved page.** It verifies
  correctness of well-known facts but cannot fully catch a page-unfaithful answer;
  true faithfulness scoring needs the retrieved slice in the judge's context.
- **On the 2026-09-03 run the quality axis did not discriminate.** All 40 answers
  (20 questions × 2 arms) scored `correct`. Spot-checking the judge's reasons
  shows it did read them; it distinguished, for example, one arm's
  "one-mutable-borrow-at-a-time" from the other's "one-mutable-or-many-immutable"
  phrasing of the same rule; so the tie is real rather than a rubber stamp. But
  a ceiling result cannot support a claim that either system answers **better**.
  It supports only the weaker, honest claim: naviquest did not answer *worse*
  while spending 4.6× fewer tokens and holding 24× less context. Discriminating
  between the arms on quality needs harder questions (ones where bounded
  retrieval can plausibly miss) or faithfulness scoring against the retrieved
  slice.
- **"Context held" is definitional.** It is the largest single tool/fetch output;   for `fetch` the whole page, for naviquest the capped payload. The non-tautological,
  provable fact is the flat cap (`BUDGET.md`): tool results stay ~1–2k tokens
  regardless of page size.
- **The headline run measured the AI path OFF** (`verify`/`fromRegion` pinned for
  reproducibility), so it shows the deterministic path did not degrade answers on
  these tasks; not that enrichment helps or hurts. The AI arm is measured
  separately (below), and enrichment is **not** out of reach under automation.

### The AI-on arm: what it costs and why it is slower

Run with a visible Chrome launched with the AI feature flags, a warmed profile,
and `AI_MODE=on` (exact commands: [eval/README.md](../README.md)). Measured
2026-09-03 on Chrome 152 with `LanguageModel`, `Summarizer` and
`LanguageDetector` all reporting `available`:

| phase | cost | paid |
|---|--:|---|
| `open` | 437 ms | per page |
| first `find_on_page`; cold, model still loading, **returns no `answer` key** | 218 ms | per page |
| dwell for the background Nano load | 25,000 ms | per page |
| **setup subtotal** | **~25,400 ms** | **once per document** |
| warm query returning a verified answer | ~2,100–3,000 ms | per query |
| the same query with AI off | 42–218 ms | per query |

**The AI arm's wall-clock penalty is model SETUP, not answer latency.** Setup is
~10× a warm answered query and is paid once per *document*, because Chrome scopes
the Gemini Nano session to the document; so it amortises over calls on the same
page and disappears entirely with AI off. The answer path itself adds ~2.4 s per
query, an order of magnitude less than the setup it is easy to mistake it for.
`node eval/research/ai-warmup-cost.mjs` reproduces this split and exits 1 if the
AI path never engaged, so a run cannot report `ai: on` while silently measuring
the deterministic path. Findings carry optional `warmupMs`/`warmupTokens` so the
report can subtract setup and state steady-state separately.

### Head to head, same 20 questions

This pairs naviquest against **itself** over the same questions, using its own
AI-off control run rather than the headline race above; pairing each
configuration against its own run is what makes the delta attributable to the
models rather than to run-to-run variation.

| naviquest arm | AI off (this pairing's control) | AI on | delta |
|---|--:|--:|--:|
| quality (blind judge) | **20/20** | 19.5/20 (19 correct, 1 partial) | −1 correct |
| total tokens | **46,891** | 56,284 | +20% |
| tool calls | 89 | 111 | +25% |
| wall-clock | **17,787 ms** | 90,187 ms | +407% |
| peak context held | 1,574 | **1,458** | −7% |

The `fetch` baseline is identical in both (it has no AI path, so it was reused
rather than re-run; `compare-ai.mjs` asserts that). **The models made every axis
worse or neutral on this workload.** 14 of 20 questions cost more with AI on
(net +9,393 tokens) because each page opened pays a throwaway warm-up query, and
a crawl question pays it twice; two questions got markedly cheaper where the AI
answer lane resolved them directly and saved retrieval round-trips.

The single `partial` was one naviquest answer on the Node.js crawl question. At
n=1 that is noise, not evidence that enrichment harms accuracy; the supportable
claim is that **AI enrichment did not improve answers here and cost materially
more**. What survives either configuration: even paying every warm-up, naviquest
spends **3.8× fewer tokens than the baseline** at the same quality.

Two behaviours that look like bugs and are not:

- A warm query can return **no answer in ~3 s** where a model-free call returns
  none in 42 ms. That is the verifier running and **withholding** a weak
  candidate; the design (`answer.verify` downgrades a sentence that echoes the
  question without answering it). Keying a health check on "an answer came back"
  would score correct withholding as a broken AI path, so `ai-warmup-cost.mjs`
  keys on the latency signal instead.
- The first call on a fresh document has **no `answer` key at all**, not
  `unverified`. That matters because `settleOnDeviceReader` only retries on
  `answer.unverified === 'NO_ON_DEVICE_READER'`; an absent answer never triggers
  priming, which is why the dwell has to be explicit in the driver.
- **Baseline can win wall-clock**; a `fetch` is one round-trip; naviquest pays page
  navigations and more tool calls per crawl.
- **n is tiny**; 20 findings / 10 domains, single run, no variance or CI. Read the
  multipliers as a POC-scale signal whose direction is robust, not calibrated facts.

### Still open to make it fully bulletproof
Score answer faithfulness *against the retrieved page* (not world knowledge), and
scale to dozens of sites with repeats for confidence intervals.

### Open defect this race surfaced (SDK side, not yet fixed)

`find_on_page` with a query the page **cannot** answer returns a WebMCP response
carrying **no text content at all**; not a payload with empty `results` and a
`hint`. Measured 2026-09-03 on the Transformer article: `query: "what is machine
learning"` → no content, while `query: "multi-head attention"` → a normal 934-token
payload. A caller therefore cannot distinguish "no match on this page" from "the
tool is broken", which is what convention 5 in [AGENTS.md](../../AGENTS.md)
exists to prevent (*"put a `hint` on every failure"*).

Half of this is now fixed and half is not:

- **Fixed (host):** the skill's host used to flatten that response to a bare
  `{"result":null}` with `status: Completed` and no explanation. It now reports
  `meta.rawText`, `meta.parseError`, `meta.isError` and `meta.contentTypes`
  whenever the payload is null, so the caller can see what the tool actually said.
- **Open (SDK):** `find_on_page` should return an empty-result payload with a
  `hint` instead of an empty response. Until it does, an agent's only signal is
  a null, and the eval's own `token-audit.mjs` needs a retry to tolerate it.
