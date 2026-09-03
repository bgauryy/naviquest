# EVIDENCE; why web agents actually fail

> **Figures here are historical.** The harness that produced them was removed from this repository. See [AGENTS.md](../AGENTS.md).

Evidence and limits; and rules governing citation. Written after contradicting an earlier framing; see § 5.

Design decisions are in [ARCHITECTURE.md](../ARCHITECTURE.md) and [TECHNOLOGY.md](./TECHNOLOGY.md).

---

## 1. The correction: observation size is a FIT problem, not an accuracy problem

We had claimed smaller observations make agents more accurate. **The literature does not support that.**

**Citable evidence:**

| Claim | Number | Source |
|---|---|---|
| Raw DOM snapshots exceeding 128k context | **42%** | D2Snap, arXiv 2508.04412 |
| Mean context utilisation after reduction | 16.5% | same |
| Latency gain from reduction, WorkArena-L1 | **2.2× faster, retaining 84%** of success | arXiv 2605.29397 |
| Latency gain, WebLINX | **3.1× faster, retaining 89%** | same |
| DOM elements per page, pre-cleaning | 1,135 average | Mind2Web, arXiv 2306.06070 |
| Turns per task | 43 average | WebLINX |

**What is NOT citable:**

- **D2Snap's +5.8pt is not an improvement:** "95% CI −13.6 to +26.0%pt; McNemar, p = 0.47." Claims non-inferiority only; citing it as a gain misrepresents the source.
- **No reduction method exceeded full-HTML baseline** across 11 methods × 32 configs. Authors' caution: "retaining more HTML elements naturally increases coverage and success."
- **"Lost in the middle" untested on DOMs:** Strong on multi-doc QA (GPT-3.5: middle 53.8% vs closed-book 56.1%) but text retrieval ≠ web observation. **Must be labelled extrapolation.**

**The one strong reduction argument that is ours:** naive pruning imposes a hard ceiling. Mind2Web's ranker achieves **Recall@50 of 85.3–88.9%**, so **the correct element is absent 11–15% of the time.** Truncation and heuristic pruning delete the target silently. Semantically-aware retrieval answers this directly.

**Defensible framing:** raw DOMs overflow 42% of the time, reduction buys 2.2–3.1× latency, good reduction preserves 84–89% of accuracy, and naive pruning loses the target 11–15% of the time. Argues for **semantically-aware** reduction, not smaller observations.

---

## 2. The real target: the execution gap

Given **human-authored high-level plans**, executors reach only **38.5% plan completion and 36.4% final success.**; arXiv 2603.14248

**Hand the agent a perfect plan and it still fails ~64% of the time.** From 104 Mind2Web-Live instances:

- **34% of actions produce no DOM change**
- **10.4% of failures** repeat the same action > 3 times
- **32% of `goto` actions** lead to non-existent links
- **>16%** of actions occur outside the required domain

Corroborated independently:

- **OSWorld:** of 550 failed examples, **>75% exhibit mouse click inaccuracies** despite accurate planning. "Strong planning but weak execution."
- **SeeAct:** oracle grounding raises step success **+20–32pp** across splits; whole-task 37.8% → **51.1%**. *"Grounding is a major bottleneck."* **54% of correct-plan-wrong-grounding cases invented a bounding box** and 46% mislinked the box.

**This is where Naviquest operates:** `locate_control` returns an addressable, named, state-annotated control, refusing to guess when ambiguous.

---

## 3. Brittleness is semantic, not cosmetic

| Perturbation | Effect |
|---|---|
| **Relational** instructions vs direct-name | GTA-1 92.8→65.8 (−27.1pp), Qwen2.5-VL 86.9→45.0 (−41.9pp), UI-TARS-1.5 91.0→35.0 (−56.0pp) |
| Cosmetic changes (restyling, text-shrink) | **not statistically significant** |
| Implicit control remapping (meaning changes) | 54.3% → **26.2%** |
| DOM obfuscation | 54.3% → 49.8% |
| Pop-ups introduced | 54.3% → 43.0% |
| Network/server faults | WebVoyager **42.0% → 2.0%** (−95%) |

Cosmetic barely matters; **semantic change is devastating.** Stable, explicitly named affordances; accessibility semantics as addressing substrate; target this exactly.

Two corollary results:
- **Agents click malicious pop-ups 86.6–98.2%.** Reporting `modal: true` and flagging inert controls is a direct mitigation.
- **54.9% of feasible WebArena tasks judged impossible** by the agent. `describe_app()` attacks this directly.

---

## 4. Ranked failure modes

Ordered by evidence strength × impact. **Modes 1–3 are entangled:** grounding error → repeated action → step-budget exhaustion. Treat as one cluster.

| # | Failure mode | Evidence | Magnitude |
|---|---|---|---|
| 1 | **Element grounding** | very strong, causally isolated | >75% of OSWorld failures; oracle +20–32pp |
| 2 | **State misperception** | strong | 34% no change; pop-ups 54.3→43.0%; malicious 86.6–98.2% |
| 3 | **Long-horizon collapse** ⚠ overlaps 1–2 | strong | 44.4% WebVoyager; step 52% → task 5.2% |
| 4 | **Low-level execution gap** | strong, clean | 38.5% / 36.4% given human plans |
| 5 | **Premature termination** | strong | 54.9% of feasible tasks judged impossible |
| 6 | **Hallucination** | strong | 21.8% WebVoyager; 54% invent bounding box |
| 7 | **Environment brittleness** | strong, scoped | WebVoyager −95% under network faults |
| 8 | **Semantic/relational brittleness** | strong, narrow | −27 to −56pp; remapping 54.3→26.2% |
| 9 | **Observation size** | moderate, indirect | 42% exceed 128k; reduction retains 84–89% |
| 10 | **Observation-pruning ceiling** | moderate | Recall@50 85.3–88.9% → target absent 11–15% |
| 11 | Exploration deficit | moderate, unquantified | 28–41% wrong-branch |
| 12 | Non-text content | weak, partly negative | vision ≈2.3× overall; OCR mildly hurts |
| 13 | Icon-only / unlabelled controls | weak; prevalence only | ~30.6% of pages; no measured failure rate |
| 14 | Stale element refs | weak for agents | 54.3→49.8% |

**Caveats:** Only WebVoyager publishes a complete distribution; everything else is a point measurement. Absolute rates incomparable across benchmarks. Most predate frontier models; 2026 studies use small models, so rates may overstate today's.

---

## 5. What we had to retract or must not cite

| Claim | Status |
|---|---|
| "Smaller observations make agents more accurate" | **Retracted.** D2Snap p = 0.47 |
| "Large context actively degrading web agents" | **Extrapolation only; position bias unmeasured on DOMs** |
| "WebArena: 50% reasoning / 30% ambiguity / 10% info loss" | **Misattributed; absent from both texts; originates in evaluator-model analysis** |
| "Context rot degrades accuracy 30%+" | **No primary source** |
| "Task success 78% → 42% with degraded accessibility tree" | **Fabricated** |
| Icon-only buttons cause agent failure | **Prevalence verified, effect size never measured** |
| Chart/canvas-specific agent failure rates | **Do not exist in any benchmark** |
| Set-of-mark prompting effective for web agents | **Contested:** SeeAct says not effective; VisualWebArena +1.3pt |
| WebAIM empty-button percentage | Sources conflict on year (27.7% vs 30.6%); confirm before quoting |

Peer-review status unconfirmed for 2026 arXiv preprints; read from arXiv, not published proceedings.

---

## 6. Guardrails on the writeup

Acceptance criteria for publication:

- The "78% → 42%" statistic is **unsourced** and must not appear.
- D2Snap's p = 0.47 means **never claim reducing observation size improves accuracy.** Cite context *fit* and the pruning ceiling, not accuracy.
- **Never present "lost in the middle" as a web-observation finding.** It is multi-doc QA; label extrapolation to DOMs.
- **WebArena publishes no quantified failure taxonomy.** The "50% / 30% / 10%" figure is misattributed and must not appear.
- Vectara's NAACL 2025 result tested embedding-similarity chunking, not structural chunking.
- Anthropic's 35% contextual-retrieval gain is LLM-generated per chunk; our structural prefix captures some, not all.
- Issue #91: Community Group issue closed `not planned` with `backlog` label; not a formal W3C rejection.
- Any number not measured ourselves is cited with source and regime. Gutenberg ≠ web pages.
- Icon-only-button failure rates are prevalence-only. Do not assert a causal agent-failure rate.
- For current claims, run the named sensor in [EVAL.md](./EVAL.md), record date and browser, distinguish deterministic checks from live-site observations.

---

## 7. Two unmeasured gaps worth owning

1. **Icon-only and unlabelled controls:** ~30.6% of home pages have buttons with no accessible name; **nobody has measured the agent-failure cost.** Our `locate_control` accuracy on labelled vs unlabelled is a publishable measurement. Nameless-actionable-control set matches axe's `link-name` findings (32/32, precision and recall 1.00).
2. **Position bias over accessibility trees:** Nobody has run Lost-in-the-Middle on a DOM or accessibility-tree observation. Our harness could settle whether the extrapolation in § 1 is real.

---

## 8. Failure modes of the retrieval layer itself; measured 2026-08-28

§ 4 ranks how agents fail. This section records how a retrieval layer built to help them fails; first-party numbers on 13 live sites, the only figures in this document not from a paper.

| Retrieval failure mode | Before fix | After |
|---|---|---|
| **Content inside a link/button invisible to search** | link-only recall **0.07** (gov.uk), **0.20** (HN), median **0.27–0.40** | median **1.00** |
| **Control styled with `opacity:0` not indexed** | TodoMVC: **0 of 4** core actions addressable | 4 of 4 |
| **Structure claimed but not recovered** | **100%** chunks with empty path on sampled sites | 21% / 100% (HN) / 50% |
| **Confidently wrong control lookup** | Apple configurator: false bounding box with no uncertainty signal | 0 high-confidence misses; hit@1 36% → 55% (dev), 65% → 71% (held-out) |
| **Internally inconsistent observation** | react.dev: `describe_app` reported new view, `find_on_page` served old | freshness checked on every tool call |
| **Expensive cost report** | `list_opaque_regions` reported 499 regions on one Wikipedia article | 43 |

**The generalisable lesson:** every failure passed 76/76 checks on a demo page. A demo cannot be evidence for a tool whose purpose is other people's pages; clean headings and labelled controls keep broken paths green. Held-out live sites are the only honest gate.

## Sources

D2Snap arXiv 2508.04412 · Observation Reduction arXiv 2605.29397 · Lost in the Middle arXiv 2307.03172 (TACL 2023) · Mind2Web arXiv 2306.06070 · WebLINX · Hierarchical Planning arXiv 2603.14248 · OSWorld arXiv 2404.07972 (NeurIPS 2024) · SeeAct arXiv 2401.01614 (ICML 2024) · GUI-Perturbed arXiv 2604.14262 · StressWeb arXiv 2604.16385 · WAREX arXiv 2510.03285 · WebArena arXiv 2307.13854 · WebVoyager arXiv 2401.13919 · VisualWebArena arXiv 2401.13649 · WorkArena++ arXiv 2407.05291 · WebStep arXiv 2606.15673 · premature termination arXiv 2606.20724 · hidden-operation blindness arXiv 2606.14106 · Trustworthy GUI Agents survey arXiv 2503.23434 · WebAIM Million (webaim.org/projects/million/)
