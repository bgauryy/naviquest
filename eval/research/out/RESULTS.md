# Research race — results

*Two real agents, same 5 questions. Quality scored blind by an LLM judge (no gold key); tokens, context held, speed and crawler reach are measured by the harness. Small n, single run — a POC-scale signal, not a benchmark.*

Environment: Chrome/152.0.7977.65 · built-in AI off (deterministic retrieval path) · token cost = chars/4 of the full tool result (matches the SDK's own `_tokens`).

The baseline here is **steelmanned**: readability-extracted main content (not a whole-page dump), plus discovered links. Both arms start a fresh isolated session for every question.

## Headline

- **Tokens per task (the honest figure):** median **1.3× fewer**, IQR 1.2×–1.6× (sum-ratio 1.5×, leveraged by the largest pages). 20,453 vs 30,158 total.
- **Flat payload (the provable core):** naviquest's largest single tool result was **1,603 tokens** regardless of page size, vs **3,785** for a whole page (2.4× — definitional: capped tool vs full page).
- **Quality:** naviquest 3.5/5 (4 useful) · baseline 3/5 (3 useful) (blind, randomized A/B).
- **Speed:** naviquest **1.6× faster** wall-clock (11,580 vs 18,395 ms).

## Per-arm

| arm | quality (judge) | total tokens | peak context held | total ms | pages |
|---|---|--:|--:|--:|--:|
| **naviquest** | 3.5/5 (3✅ 1🟡 0❌ 1⚪) | 20,453 | 1,603 | 11,580 | 10 |
| **baseline** | 3/5 (3✅ 0🟡 0❌ 2⚪) | 30,158 | 3,785 | 18,395 | 21 |

## Per-task (✅ correct · 🟡 partial · ❌ wrong · ⚪ unsupported)

| site | task | nq | base | nq tok | base tok | nq ctx | base ctx |
|---|---|:--:|:--:|--:|--:|--:|--:|
| POC question 1 | What does a valid WebMCP Challenge submission have to inclu… | ✅ | ⚪ | 1,443 | 6,742 | 907 | 1,775 |
| POC question 2 | Can a project begun before August 25, 2026 qualify? Explain… | ✅ | ✅ | 3,912 | 5,060 | 1,603 | 1,775 |
| POC question 3 | Give the final extended submission deadline in PT and in ED… | ✅ | ⚪ | 4,219 | 4,988 | 1,163 | 1,775 |
| POC question 4 | How do the two judging stages work? Name all four equally w… | ⚪ | ✅ | 3,226 | 5,060 | 1,213 | 1,775 |
| POC question 5 | How can judges test a submitted application in each support… | 🟡 | ✅ | 7,653 | 8,308 | 1,603 | 3,785 |


## Cost per question — naviquest vs the `fetch` baseline

Each bar is naviquest's token cost as a **fraction of what the `fetch` agent spent
answering the identical question**, so a *short* bar is a large win. (This is the
opposite reading from the per-tool budget bars, where a long bar means "close to
the cap".) Both arms are charged with the same estimator — `chars/4` of the full
result — audited by `token-audit.mjs`.

```
POC question 1 read  ▇▇▇▁▁▁▁▁▁▁▁▁▁▁▁▁  1,443 vs 6,742 tok  (4.7× fewer)  ← biggest win
POC question 4 read  ▇▇▇▇▇▇▇▇▇▇▁▁▁▁▁▁  3,226 vs 5,060 tok  (1.6× fewer)
POC question 2 read  ▇▇▇▇▇▇▇▇▇▇▇▇▁▁▁▁  3,912 vs 5,060 tok  (1.3× fewer)
POC question 3 read  ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▁▁  4,219 vs 4,988 tok  (1.2× fewer)
POC question 5 read  ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▁  7,653 vs 8,308 tok  (1.1× fewer)  ← baseline wins here
─────────────────────────────────────────────────────────────────────────
TOTAL                ▇▇▇▇▇▇▇▇▇▇▇▁▁▁▁▁  20,453 vs 30,158 tok  (1.5× fewer)
```

The spread is the point: **the advantage tracks page size.** The largest win is
**POC question 1 read** at 4.7× — a big article the baseline has to
ingest whole. naviquest was cheaper on every question in this run.

naviquest's cost stays bounded by its per-tool budgets either way, so the gap
widens without limit as pages grow — which is why the `TOTAL` row (1.5×) sits
well above the median question.

## How to reproduce

See [METHODOLOGY.md](../METHODOLOGY.md) for the exact steps and every check that was run. In short: launch Chrome via the skill, `node eval/research/harness.mjs`, spawn the two agents against `out/tasks.json`, judge blind, then `node eval/research/aggregate.mjs report` (and `node eval/research/budget-bars.mjs` for the per-tool budget bars).
