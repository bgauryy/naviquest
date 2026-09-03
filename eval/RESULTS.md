# Naviquest eval results

Everything here was measured, not asserted. Each number names the command that
reproduces it; where a claim could not be supported, that is said instead of
smoothed over. Method and every caveat:
[research/METHODOLOGY.md](./research/METHODOLOGY.md) · how to run any of it:
[README.md](./README.md).

Run 2026-09-03 · Chrome 152.0.7977.75 · `naviquest` at commit `986abf8`.

---

## 1. The headline; every answer correct, on a quarter of the tokens

Two **real agents** answered the **same 20 questions** (10 `read` + 10 `crawl`)
across **10 distinct large sites** (Wikipedia, Node.js, MDN, Git, Kubernetes,
Python, React, Vue, TypeScript, Rust). One used naviquest's six tools; the other
used a **steelmanned** `fetch` loop; readability-extracted main content plus a
per-session cache, so re-reading a page it already held cost nothing. Quality was
scored by a **blind** LLM judge on randomized, anonymized A/B pairs with **no gold
key**.

| | naviquest | `fetch` baseline | result |
|---|--:|--:|:--|
| **Quality (blind judge)** | **20 / 20 correct** | 19.5 / 20 | **naviquest scored higher** |
| **Total tokens** | **52,822** | 214,481 | **4.1× fewer** |
| Tokens per question (median) |; |; | **2.6× fewer** (IQR 2.2×–6.3×) |
| **Largest single payload** | **1,551** | 38,198 | **24.6× smaller** |
| Wall-clock | 15,176 ms | 6,479 ms | baseline **2.3× faster** |
| Tool calls / fetches | 93 | 22 |; |

**naviquest won on quality and on cost, and lost on speed.** It answered every
one of the 20 questions correctly while the `fetch` baseline dropped half a point
(a Node.js crawl answer whose "two differences" were two halves of the same API
point), and it did that on **a quarter of the tokens**. The one axis it loses is
wall-clock: a `fetch` is a single round-trip, while naviquest pays page
navigations and more tool calls per crawl.

The **structural** result is the flat cap: naviquest's largest single tool result
was **1,551 tokens**, while the baseline had to hold an entire **38,198-token**
Wikipedia article in context. That gap is definitional and grows without limit as
pages grow; it is the number that does not depend on how the questions were
picked.

One honest note on the quality margin: half a point out of 20 is a single
judgement, which is within noise at this sample size. The claim this run
*proves* is **"no worse quality for a quarter of the tokens"**; the 20 vs 19.5 is
this run's actual scoreline, not evidence that naviquest reliably answers better.

A bookkeeping detail: the harness's live total for the naviquest arm was
**53,095** tokens against the **52,822** the agent attributed to findings. The
273-token gap is calls made without booking them to a finding. The harness figure
is ground truth for spend; the per-finding sum is what the report joins on, and
it is the conservative one.

Per-question detail: [research/out/RESULTS.md](./research/out/RESULTS.md).

---

## 1b. Cost per question; where the win comes from

Regenerate with `node eval/research/token-bars.mjs`.

```
wikipedia.org read          ▇▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁  2,210 vs 37,950 tok  (17.2× fewer)  ← biggest win
typescriptlang.org read     ▇▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁    707 vs 11,682 tok  (16.5× fewer)
wikipedia.org crawl         ▇▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁  2,809 vs 38,198 tok  (13.6× fewer)
developer.mozilla.org read  ▇▇▁▁▁▁▁▁▁▁▁▁▁▁▁▁  1,845 vs 15,994 tok  (8.7× fewer)
docs.python.org crawl       ▇▇▁▁▁▁▁▁▁▁▁▁▁▁▁▁  1,954 vs 13,894 tok  (7.1× fewer)
doc.rust-lang.org read      ▇▇▇▁▁▁▁▁▁▁▁▁▁▁▁▁  1,131 vs  6,865 tok  (6.1× fewer)
kubernetes.io read          ▇▇▇▇▁▁▁▁▁▁▁▁▁▁▁▁  1,412 vs  5,951 tok  (4.2× fewer)
kubernetes.io crawl         ▇▇▇▇▁▁▁▁▁▁▁▁▁▁▁▁  3,389 vs 12,875 tok  (3.8× fewer)
developer.mozilla.org crawl ▇▇▇▇▇▁▁▁▁▁▁▁▁▁▁▁  4,540 vs 14,130 tok  (3.1× fewer)
typescriptlang.org crawl    ▇▇▇▇▇▇▁▁▁▁▁▁▁▁▁▁  4,110 vs 11,534 tok  (2.8× fewer)
docs.python.org read        ▇▇▇▇▇▇▇▁▁▁▁▁▁▁▁▁  1,724 vs  4,172 tok  (2.4× fewer)
react.dev read              ▇▇▇▇▇▇▇▁▁▁▁▁▁▁▁▁  2,145 vs  5,057 tok  (2.4× fewer)
vuejs.org crawl             ▇▇▇▇▇▇▇▁▁▁▁▁▁▁▁▁  3,230 vs  7,396 tok  (2.3× fewer)
git-scm.com read            ▇▇▇▇▇▇▇▁▁▁▁▁▁▁▁▁  2,871 vs  6,435 tok  (2.2× fewer)
vuejs.org read              ▇▇▇▇▇▇▇▁▁▁▁▁▁▁▁▁  2,174 vs  4,811 tok  (2.2× fewer)
git-scm.com crawl           ▇▇▇▇▇▇▇▇▁▁▁▁▁▁▁▁  2,830 vs  5,850 tok  (2.1× fewer)
doc.rust-lang.org crawl     ▇▇▇▇▇▇▇▇▇▁▁▁▁▁▁▁  1,892 vs  3,291 tok  (1.7× fewer)
react.dev crawl             ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▁▁  5,796 vs  6,864 tok  (1.2× fewer)
nodejs.org read             ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▶  2,727 vs    923 tok  (3.0× MORE)
nodejs.org crawl            ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▶  3,326 vs    609 tok  (5.5× MORE)  ← baseline wins here
─────────────────────────────────────────────────────────────────────────────────
TOTAL                       ▇▇▇▇▁▁▁▁▁▁▁▁▁▁▁▁  52,822 vs 214,481 tok  (4.1× fewer)
```

Each bar is naviquest's cost as a **fraction of what the `fetch` agent spent on the identical question**; so a *short* bar is a large win. (Opposite reading from the per‑tool budget bars above, where a long bar means "close to the cap".) Both arms are charged with the same estimator, audited by `token-audit.mjs`.

**The advantage tracks page size.** Biggest win: a Wikipedia read at **17.2×**; a large article the baseline must ingest whole. And the baseline **wins two questions outright**, both on `nodejs.org`, whose pages are small enough (609–923 tokens) that a single whole‑page fetch beats naviquest's multi‑call loop. That is the honest shape of the trade: below roughly 3k tokens of page, just fetching it is cheaper. naviquest's cost stays bounded by its per‑tool budgets either way, so the gap widens without limit as pages grow.

---

## 2. Token accounting; audited, not assumed

The whole comparison rests on the token number being real, so it is checked
against live tool results rather than trusted.

```bash
node eval/research/token-audit.mjs        # 18/18, exits 1 if parity breaks
```

| tool | harness charge | SDK `_tokens` | `_budget` | used |
|---|--:|--:|--:|--:|
| `describe_app` | 818 | 818 | 900 | 91% |
| `find_on_page` | 1,096 | 1,096 | 1,200 | 91% |
| `locate_control` | 425 | 425 | 600 | 71% |
| `query_selector` | 932 | 932 | 1,200 | 78% |
| `agentic_content` | 1,536 | 1,536 | 2,000 | 77% |
| `resolve_address` | 113 | 113 | 500 | 23% |

Three properties hold for **every** tool:

1. **Parity**; the harness's independent `chars/4` count equals the SDK's own
   `_tokens` exactly. Two counters, same answer.
2. **The envelope is charged, not free**; recomputing the cost with
   `_tokens`/`_budget`/`_etag`/`_version` stripped comes out *lower*. That
   undercharge is deliberately refused, because the model does receive those
   fields. Charging the full JSON is what makes the comparison against a `fetch`
   that ingests raw text fair.
3. **Budget adherence**; each tool declares a cap and lands inside it.

Both arms are charged with the identical estimator.

---

## 3. Offline gates

```bash
yarn eval     # 90/90 checks, ~3 s, real Chromium
yarn test     # 33/33, vitest + jsdom
```

| lane | what it gates |
|---|---|
| `surface` | `TOOL_SPECS` instruction-token ceiling |
| `roles` | `page/roles.ts` vs aria-query in real Chrome |
| `contracts` | the six-tool behavioural surface |
| `frames` | same-origin iframe discovery |
| `rank` | structural ranking priors, before/after on one config change |

The `rank` lane is a genuine before/after: with the chrome-demotion prior off,
navigation and footer blocks out-rank the answering prose (4 inversions); with it
on, 0. The image-alt prior takes image-above-content inversions 4 → 3 and flips
the top result from a picture description to the answer.

---

## 4. What the eval found in the runtime

An eval that never fails the thing it measures is decoration. This one found two
real defects in the Chrome skill, both fixed:

**Iframe pages broke every tool call.** The SDK install script runs on every new
document, so any page with an embed registered the six tool names once per frame,
and the host refused the ambiguity with `resolved to N frames`. react.dev and
vuejs.org failed *completely* in the first run. The host now addresses the page's
**main frame** and treats sub-frame registrations as noise.

| | before | after |
|---|--:|--:|
| react.dev tool calls | 29 | **14** |
| vuejs.org tool calls | 14 | **11** |
| naviquest total calls (20 findings) | 114 | **89** (−22%) |

Tokens only fell 6% because failed calls cost 0 tokens; the waste was in calls
and latency, not payload. Locked in by a hermetic regression whose sub-frames
carry a **decoy answer**, so reading the wrong frame fails loudly rather than
passing quietly (`naviquest.check.mjs`, now 19 assertions).

**Null tool results were unexplainable.** A response that was not JSON became a
bare `{"result":null}` with `status: Completed` and no message; indistinguishable
from a broken tool. The host now reports `rawText`, `parseError`, `isError` and
`contentTypes` whenever the payload is null.

---

## 5. Open defect this eval surfaced (SDK side, not fixed)

`find_on_page` with a query the page **cannot** answer returns a WebMCP response
carrying **no text content at all**; not an empty-results payload with a `hint`.
Measured on the Transformer article: `"what is machine learning"` → no content,
while `"multi-head attention"` → a normal 934-token payload.

A caller therefore cannot distinguish "no match on this page" from "the tool is
broken", which is exactly what convention 5 in [AGENTS.md](../AGENTS.md) exists to
prevent (*"put a `hint` on every failure"*). The host-side half is fixed (above);
the SDK half is open.

---

## 6. On-device AI; status

Ran in a **visible** Chrome with all AI feature flags. `LanguageModel`,
`Summarizer` and `LanguageDetector` all report **`available`** on a real origin;
`Translator` is `downloadable` until a language pair is requested; `Rewriter` and
`Writer` are absent on Chrome 152 (the SDK does not use them). `open` reports
`modelState: available`, and the verifier genuinely engages; returning
`verified: true` answers, and correctly **withholding** weak candidates instead of
asserting them.

```bash
node eval/research/ai-warmup-cost.mjs     # exits 1 if the AI path never engaged
```

### The AI arm is slower because of SETUP, not answering

| phase | cost | paid |
|---|--:|---|
| `open` | 437 ms | per page |
| first `find_on_page`; cold, model loading, **returns no `answer` key** | 218 ms | per page |
| dwell for the background Gemini Nano load | 25,000 ms | per page |
| **setup subtotal** | **~25,400 ms** | **once per document** |
| warm query returning a verified answer | ~2,600 ms | per query |
| the same query with AI off | 42–218 ms | per query |

Setup costs ~**10× a warm answered query** and is paid once per *document*,
because Chrome scopes the Nano session to the document. It amortises over calls
on the same page and disappears entirely with AI off. The answer path itself adds
~2.4 s per query; real, but an order of magnitude below the start-up cost it is
easy to mistake it for.

### The AI path costs tokens too

Turning the models on is **not** free in context. Every page opened pays a
throwaway warm-up query before the answer lanes engage, and a crawl finding pays
it twice.

---

## 7. AI on vs AI off; head to head

This is a **separate paired measurement** of naviquest against itself; its own
AI-off run versus its AI-on run over the identical 20 questions. Its AI-off
column is that pairing's own baseline (46,891 tokens, 20/20), not the headline
run in §1; pairing each configuration against its own run is what makes the delta
attributable to the models rather than to run-to-run variation. The `fetch`
baseline has no AI path, so it was reused unchanged (the script asserts that).
Reproduce with `node eval/research/compare-ai.mjs`.

| naviquest arm | AI off | AI on | delta |
|---|--:|--:|--:|
| **quality (blind judge)** | **20/20** | **19.5/20** (19 correct, 1 partial) | −1 correct |
| total tokens | **46,891** | 56,284 | **+20%** |
| tool calls | 89 | 111 | +25% |
| wall-clock | 17,787 ms | 90,187 ms | +407% |
| peak context held | 1,574 | **1,458** | −7% |

**On this task set, enabling the on-device models made every axis worse or
neutral.** It cost 20% more tokens, 25% more calls, 5× the wall-clock, and scored
half a point lower. That is the honest result, and it is why `AI_MODE=off` is the
default: the deterministic retrieval path is not a fallback here, it is the
better configuration for this workload.

Read the quality delta carefully. The single `partial` was one naviquest answer
on the Node.js crawl question ("*its two points are both halves of the single API
difference; misses environment control and modules*"). At n=1 that is noise, not
a demonstration that AI enrichment hurts accuracy; the defensible claim is
**"AI enrichment did not improve answers here, and cost materially more."**

The token cost is uneven and structural; **14 of 20 questions cost more with AI
on, net +9,393 tokens**:

| question | AI on | AI off | delta |
|---|--:|--:|--:|
| developer.mozilla.org · crawl | 4,776 | 1,757 | **+3,019** |
| wikipedia.org · crawl | 5,291 | 3,245 | +2,046 |
| vuejs.org · crawl | 3,858 | 2,317 | +1,541 |
| … | | | |
| nodejs.org · crawl | 2,061 | 3,026 | −965 |
| typescriptlang.org · crawl | 2,280 | 7,344 | **−5,064** |

Crawl questions are taxed hardest because they open two pages and therefore pay
the warm-up twice. The two large *savings* are the flip side: where the AI answer
lane resolves a question directly, it avoids the extra retrieval round-trips the
lexical path needed.

### The claim that survives all of it

| arm (and which run) | quality | total tokens |
|---|--:|--:|
| naviquest, AI **off**; this pairing's control | **20/20** | **46,891** |
| naviquest, AI **on**; this pairing | 19.5/20 | 56,284 |
| `fetch` baseline; as judged in this pairing | 20/20 | 214,481 |

(The baseline scored 20/20 when judged alongside the AI-on arm and 19.5/20 when
judged alongside the headline run in §1. Same answers both times; the judge is
re-run per pairing, and a half-point moving between arms across judgings is
exactly the noise floor this design can resolve. Neither number is the "real"
one; both are that pairing's scoreline.)

**Even with AI on and paying every warm-up, naviquest spends 3.8× fewer tokens
than the baseline at the same answer quality.** The context advantage comes from
bounded retrieval, not from the models.

## Reproducing any of this

Every number above names its command. The two-agent race needs the Chrome skill's
host running first; see [README.md](./README.md) for the copy-pasteable
sequence, including the visible-Chrome + warm-model variant for AI-on runs. The
live dashboard at `http://localhost:5331` shows both agents' current question,
progress, per-call cost, and the blind judge's per-question ratings as the race
runs.
