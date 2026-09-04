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
