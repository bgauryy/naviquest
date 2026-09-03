# EVAL; measured on twelve large live websites, 2026-08-31

Most numbers below are **historical**. The 2026-09-02 eval merge collapsed twenty
`eval:*` scripts into one `yarn eval` and deleted the live-site sensors that
produced these tables (`navigate`, `selector`, `tools`, `accname`, `summarizer`,
the Devpost dogfood, the ten-site navigation benchmark, the MDN comparison study).
The measurements stand as a dated record; nothing re-runs them. Rebuild a sensor
before quoting its figure as current. Each caveat below is stated once.

Still re-runnable:

```bash
yarn eval                                   # offline gates: surface, roles, contracts
yarn eval --live                            # six tools on real MDN pages
yarn eval --live --url https://…            # the same invariants on any origin
yarn eval --only crawl                      # cross-page navigation on real sites
yarn eval --only compare                    # three arms, one estimator
# after launching an HTTP(S) tab with the Chrome skill:
node skills/naviquest-chrome-devtools/scripts/cdp-sandbox.mjs skills/naviquest-chrome-devtools/scripts/cdp-checks/api-probe.mjs --port 9222
                                             # which platform APIs the attached Chrome has
```

## Proposed Devpost two-agent race (unmeasured)

This candidate compares one Naviquest agent with one plain-`fetch` agent on the
same five questions. It is a test plan, not a result. Both agents receive only
the shared home URL and one neutral question. The complete competition protocol
is in [`POC.md`](../POC.md).

A browser inspection on 2026-09-04 covered the overview, resources, rules,
project gallery, updates, discussions, schedule, and participants. Challenge
managers had not published the project gallery, participants required login,
and discussions were mutable, so none is an answer source for this task set. Do
not log in, join the hackathon, open **My projects**, or submit a form.

| ID | Question |
|---|---|
| D1 | What does a valid WebMCP Challenge submission have to include? List all deliverables and the specific requirements for the project description, demo video, and source-code repository. |
| D2 | Can a project begun before August 25, 2026 qualify? Explain which work counts, how judges assess it, and what evidence the entrant must provide. |
| D3 | Give the final extended submission deadline in PT and in EDT. Explain why it changed and identify the three project artifacts that must remain unchanged after submissions close. |
| D4 | How do the two judging stages work? Name all four equally weighted criteria in the second stage and explain the tie-breaking order. |
| D5 | How can judges test a submitted application in each supported browser environment? Include the minimum Chrome version and required flag, whether judges must open the live application, and where an entrant must provide private login credentials. |

The run is invalid if one arm receives a destination URL, expected answer, or
page excerpt that the other arm does not. Capture the rendered page revisions or
archive the evidence used by the blind judge. The updates page can supersede the
rules page. Gallery and participant surfaces can change after judging.

## Three arms, one estimator (2026-09-02, re-runnable)

`yarn eval --only compare` answers four questions three ways and charges every arm
with the same function (`chars/4`) over the bytes it actually ingested. The deleted
collector graded each arm against its own corpus and reported Naviquest 0/6 against
Playwright 5/6; both were artifacts of that choice, and one shared estimator over
one shared unit is the correction.

| Arm | Tokens | Answered |
|---|---|---|
| `ariaSnapshot` only | 77,932 | 4/4 |
| SDK retrieves and names, host clicks | **5,481** | 3/4 |
| Tools alone, no host actuation |; | 2/2 single-page, 0/2 cross-page |

**14.2× fewer tokens** (re-measured 2026-09-02 with the two structural ranking
priors active; source `eval/out/compare.json`). The middle arm answers 3 of 4: the
miss is the `asyncio.gather` cross-page hop, a destination-page answer-extraction
limit, not a navigation failure and not a ranking regression; `chromePenalty`/`imageAltPenalty` off vs on both return `unsupported` on that page,
and the pre-prior baseline missed it too. The ratio rose from 11.6× as answered
pages got cheaper (MDN 2,382→1,946, Wikipedia 1,046→753 tokens). The third arm is
the honest limit: nothing in the SDK clicks, so it cannot cross a page, and the
lane asserts that failure so a future actuation capability shows up as a broken
check. Two hop questions are guarded by a precondition that their gold phrase is
absent from the start page; `concurrently` and `response` were the first picks and
both leaked, which would have scored an arm that never navigated.

## Where the tools LOSE: commercial marketing pages (2026-09-02)

The three-arm result above is measured on reference pages. Driving the same tools
over `paypal.com/us/home`, `developer.paypal.com` and `stripe.com/atlas` inverts it
; **12,930 tokens over 12 questions against 12,295 for three `ariaSnapshot` dumps,
and roughly 5/12 answered**. Three causes, all measured:

1. **`opacity: 0` scroll-reveal content is not indexed.** PayPal's own "Your
   payments are encrypted…" sentence is in `innerText` and in the accessibility
   tree from first paint, and `find_on_page('encrypted')` returned `not_found`.
   The deleted opacity-gap sensor swept ten commercial sites for the size of this gap;
   the held-out set puts PayPal at **20.9% of readable prose** (its index goes
   32 → 76 chunks once scrolled). Indexing that text is rejected; it costs 4,846
   chars of genuinely hidden UI to gain 1,478 on DEV, and no index-time property
   separates the two. Now declared in `coverage.revealPending` instead of dropped
   in silence.
2. **Navigation chrome outranks content.** On Stripe Atlas (10% structural
   engagement) "how much does Stripe Atlas cost" returns the mega-menu from the
   `navigation` landmark, and "do I need to be a US resident" spent 2,532 tokens
   returning it. Open.
3. **Nav elements become root headings.** Every PayPal passage carries
   `headingPath: ["Log In Sign Up", "Sign Up", …]`, so real headings arrive at
   depth 3 and the reported document structure is fiction. Open.

The predictor is not page size but `structuralEngagementPct`; 10–22% on these
pages against well-formed reference HTML. `describe_app`'s "read the tree instead"
recommendation is gated only on `declineBelowTreeTokens`, so it stays silent on
exactly the pages where the tools lose. Open.

The older three-arm KPI contract and failure taxonomy lived in `docs/BENCHMARK.md`;
the task-labeled 10-site × 3-question navigation audit (Naviquest vs Playwright vs
web search) lived in `eval/NAVIGATION-BENCHMARK.md` and
`eval/NAVIGATION-BENCHMARK-RESULTS.md`. All deleted in the same merge; public
capability audits, not regression gates or evidence for tuning on these pages.

**No hand-written labels.** No expected answers, per-site settle times, page
markers, or app seeding. Every probe is derived from the page at runtime, so
nothing here can be tuned by picking friendlier sites; bot walls are detected from
generic signals only. A blocked page is named and excluded; a page where the loop
costs more than the baseline is printed as a **loss**. Two baselines, because one
flatters us: an accessibility snapshot (`role "name"` pairs) is a poor baseline for
a *content* question; `document.body.innerText` is what a DOM-dump harness actually
sends and is the honest one.

---

## 1. Token cost of one orient → search → locate loop

**Median 15.2% of an accessibility snapshot, 59.4% of `innerText`** across 12 sites.
Illustrative rows (`loop` tokens, % of aria / % of innerText):

| site | raw HTML | aria | innerText | **loop** | % aria | % innerText |
|---|--:|--:|--:|--:|--:|--:|
| cnn | **1,502,408** | 14,363 | 1,866 | 1,741 | 12.1% | 93.3% |
| wikipedia | 305,636 | 83,613 | 21,713 | 2,242 | **2.7%** | **10.3%** |
| youtube | 283,951 | 756 | 118 | 349 | 46.2% | **295.8%** |

Honest reading, narrower than "uses fewer tokens":

- **Large win on big, text-heavy pages.** Wikipedia 10.3% of `innerText`, Stack
  Overflow 7.8%. CNN's raw HTML is **1.5 million tokens**; twelve times a 128k
  window, so a DOM dump does not *fit*; and three tool calls answer for 1,741, or
  **0.12% of the raw HTML**.
- **Break-even on small pages and a loss on two:** gov.uk 184%, YouTube 296%. Both
  correctly flagged; `describe_app().recommendation` fires on gov.uk, YouTube and
  figma-docs, telling the agent to stop calling.
- **Against `innerText` the median is 59.4%, not 15%.** Quote 15.2% only against an
  accessibility snapshot, and say which baseline you mean.

## 2. Does it help the agent *find* things?

Heading round-trip **38/45**, control found by its own accessible name **34/38**,
control addresses resolved **32/32**, region addresses readable **35/35**,
invariants **96/96**, pages 12/12 with 0 blocked and 0 errors. Addressing is the
strongest result: **67/67 addresses across twelve large sites resolved through the
tool each one declares**, zero `NOT_FOUND` on an unchanged page.

## 3. The `since` delta loop; the clearest win

| site | full orient | with `since` | saved |
|---|--:|--:|--:|
| wikipedia | 802 | 12 | 98.5% |
| stackoverflow | 538 | 13 | 97.6% |
| **median** | | | **97.6%** |

12–13 tokens against 237–833, on every one of twelve sites. This is the mechanism
[WebMCP issue #151](https://github.com/webmachinelearning/webmcp/issues/151) says
the platform lacks, and it is the least equivocal number here.

## 4. The accessibility effect; measured, and it found a broken signal

The share of `landmark`+`window` chunks *is* the share of content that got no
heading path; the differentiator over Playwright's `(role, accessible name)`.
Empty-heading-path share ranged **97% (stackoverflow, low 3% structuralQuality, 3/5
round-trip) → 1% (nytimes, good 99%, 1/1)** across the 12 sites. **Real accessibility
structure is what makes this SDK work, and it is measurably absent on a lot of the
web.** The three worst pages for empty heading paths (97%, 78%, 77%) are three of the
four worst for round-trip; Wikipedia at 70% is the counter-example, so this is a
tendency, not a law.

**The defect this found:** `structuralEngagementPct` counted `landmark` as structural
engagement, so **`describe_app().structuralQuality` reported `good` on all twelve
pages**; 99% on the Stack Overflow page where 97% of chunks have no heading path. A
signal that never varies is not a signal, and `locate_control`'s advice to prefer
whole-region reads when `structuralQuality: "low"` could never fire. Fixed to `(heading
+ containment) / total`; the signal now spans **low 3% → good 100%** and tracks
retrieval difficulty.

## 5. Is BM25 right for content? Where it fails

The deleted lexical-gap sensor took a heading the page reports, deleted **the single
longest content word** (the crudest paraphrase, inventing no vocabulary), and
re-asked. Literal heading hit rank-1 17/24 (71%), minus-one-word 13/24 (54%): a
**−17 pp** drop at rank 1, **−8 pp** on found-at-all; a **floor** on the paraphrase
gap, not a ceiling (only a deletion, no synonym). **Superseded by Part 6 (2026-08-31):**
a BM25F-lite heading-weighting loop cut the drop from 17 pp to **3 pp** (rank-1 71% →
90% literal, 54% → 86% reduced, all 29 probes); the remaining gap is genuine
vocabulary. Clean illustration: *"Light-independent reactions"* minus `independent` is
**lost entirely**, because *"Light-dependent reactions"* also exists and the deleted
word was the only thing separating them.

**Verdict: BM25 is the right *floor*, not the right *ceiling*.** Zero download, zero
bytes on first paint, answers before any model could load; but it scores term
overlap, so it works best exactly when the agent already knows the page's wording,
when retrieval was least needed. The optional int8 dense lane fused by RRF is the
documented answer (+5 pp hit@1 when measurable), off by default. BM25 is genuinely
good at control lookup (34/38 found by their own name) and `b=0.75` length
normalisation.

## 6. Frames; a structural gap, quantified (now an opt-in)

By default, naviquest's semantic projection treats an `<iframe>` as an **opaque
region**: content inside is not indexed, but the boundary is *declared* in
`describe_app` coverage (`unindexedFrameDocuments`) rather than silently dropped.
Exact CSS (`query_selector`) can always inspect every recursively reachable
same-origin frame document and its open shadow roots.

**`discovery.frames` (opt-in, off by default) closes the gap for same-origin
frames**: `find_on_page` then reaches their content, with a frame-qualified
`Address` (`frame: "document/frame[N]"`) that `resolve_address` re-enters and whose
region read will not cross the frame boundary. It is off by default because the measurement
below shows same-origin frames usually hold trivial content on the open web (the
real content is cross-origin, which page JS can never reach); it is worth turning
on for an app shell that frames its **own** editor, gallery, or docs viewer; the
`unindexedFrameDocuments` coverage gap is the signal that a page is one of those.
Frame *controls* stay out of the control index (their boxes are frame-relative),
so this adds frame reading, not clicking. Gated by `laneFrames` in `eval/eval.ts`.

| site | iframes |
|---|--:|
| nytimes | 21 |
| cnn | 18 |
| aliexpress | 6 |
| react.dev | 5 |
| bbc | 4 |
| figma-docs | 3 |
| github, youtube | 2 |

**8 of 12 large sites carry iframes.** Most are ads and analytics, which is
content an agent should not want; but that is an assumption this measurement
does not verify, and on an application shell (an embedded editor, a payment
field, a help widget) the unreachable frame is the part the agent needs.

Same-origin frames are reachable in principle: two frames each running the SDK
hand one agent two `find_on_page` tools, distinguishable by `title`, `window` and
`origin` but not addressable across the boundary. Cross-origin frames are
unreachable by design. This is the largest open gap for "ready for web apps".

## 7. Performance, and one guardrail breach

Projection **breaches the documented 50 ms long-task guardrail on the two largest
pages**; stackoverflow **70.5 ms** (11,447 elements), wikipedia **62.1 ms**; and it
is the half that cannot move to a worker (it reads computed style, layout boxes,
accessible names). `projectAsync` time-slicing exists for exactly this but is
worker-lane only; the inline lane (the default a host gets) still projects in one task.

## 7b. roles.ts oracle; the one deterministic, network-free sensor (2026-08-31)

Everything above needs the network, so none of it is a regression gate. `roles.ts`; the riskiest module, mapping elements to implicit ARIA roles by hand because
`computedRole` still does not exist; had no check after the harness deletion. `yarn
eval --only roles` rebuilds one: deterministic, offline, subject-independent,
cross-checking the shipped `roleOf` against **`aria-query`** (a second encoding of
HTML-AAM) by building every element it describes in **real Chrome**. Result: **91/111
implicit roles agreeing with the spec**, 16 documented divergences, 4 flagged
candidate gaps, 1 skipped, **0 undocumented drift**.

The 16 divergences are `roles.ts` deliberately mapping non-actionable elements (`em`,
`strong`, `code`, `blockquote`, `time`, `meter`, …) to `generic`; its "minimal,
actionable-only" scope; their text is still indexed via `text.ts`. Each is listed
with a reason, so the gate turns **red** if any silently changes (verified not
vacuous: `button -> generic` exits 1 with `DRIFT button`). **Four flagged candidate
gaps**, locked to current behaviour, worth a measured follow-up (not fixed blind; projection changes have no live regression gate): `area[href]` (image-map link,
`generic` not `link`), an unnamed sectioning-scoped `<aside>` (kept `complementary`),
`<menu>` (`generic` not `list`), `<datalist>` (`generic` not `listbox`). Only `area`
is likely to touch real retrieval. It does **not** cover name computation, state, or
the contextual cases it skips; a role-mapping oracle, not a full AX oracle; but it
is the first thing in the repo that can fail on a bad edit without a network.

## 7c. "Use a native API instead of the shim"; measured, and rejected (2026-08-31)

The one bundled dependency, `dom-accessibility-api`, costs **~2.9 kB gzip**. There is
no browser API to replace it: `computedName`, `computedRole` and
`getComputedAccessibleNode` are all **absent in Chrome 151**, so the only alternative
is hand-rolling accname, tested against the library as oracle. Since accname decides
retrieval (a control is found by its name), the bar is near-total agreement with zero
blanks the shim filled: **overall 92.6% of 704 named elements**, with 10 the shim
named and native left blank.

**Rejected, with the specific failures:**
- **Whitespace.** accname inserts a space at element boundaries; `textContent` does
  not; `"Next : Who has to pay"` vs `"Next:Who has to pay"`. Exact-name matching
  breaks on this alone.
- **Name-from-content nuance.** `"JavaScript"` vs `"JavaScriptJS"`, and badge text
  (`"… Experimental"`, `"… Deprecated"`) the shim includes and native drops; 50
  disagreements on MDN.
- **Blanks = unreachable controls.** 10 elements the platform names and native left
  empty; each is a control an agent could not find.
- **Over-naming.** Native named 322 MDN elements the shim correctly leaves unnamed
  (every `<a>` via name-from-content); index pollution.

**Verdict: the 2.9 kB stays.** It buys correctness no native API provides, and
accname is exactly the subtle algorithm hand-rolling turns into a bug farm. The
sensor is kept so the calculus can be re-run if `computedName` ships.

## 8. Where the measurement itself is weak

- **Zero-sample classes.** bbc produced no control probes or control addresses;
  github none either. Named explicitly, because `0/0` beside `8/8 invariants` reads
  as a pass. Cause: control names derive from `find_on_page`'s `actionable` lists,
  which can be empty; itself a finding about region→control linkage.
- **`n` is small.** 45 heading probes, 38 control probes, 24 lexical probes across
  4–12 pages. Directional, not statistically powered.
- **One site failed to load under instrumentation.** Stack Overflow threw `Execution
  context was destroyed` in the lexical probe (a client-side navigation mid-run) and
  is absent from § 5's totals.
- **The dense lane is not exercised.** All inline-lane, lexical-only numbers, and the
  weights can no longer be regenerated in this repository.

---

# Part 2; platform APIs, probed rather than asserted (2026-08-31)

```bash
node skills/naviquest-chrome-devtools/scripts/open-browser.mjs --headless \
  --port 9222 --enableFeatures WebMCPTesting --url https://example.com
node skills/naviquest-chrome-devtools/scripts/cdp-sandbox.mjs \
  skills/naviquest-chrome-devtools/scripts/cdp-checks/api-probe.mjs \
  --port 9222 --target-url example.com
                              # proposals + SDK dependencies, in real Chrome
```

Six APIs were proposed as "worth leveraging" **from memory rather than a probe**; the exact failure this repo has a rule against. Probed on Chrome 151:

| # | Proposal | Present? | Verdict |
|---|---|---|---|
| 1 | `computedRole` / `computedName` | **no** | Neither exists on the page-JS surface; `getComputedAccessibleNode` also absent, so `roles.ts` stays hand-written |
| 2 | `navigator.userActivation` | **yes** | **Claim was wrong.** Reports `{isActive, hasBeenActive}` for the *current context*; whether **you** have activation; cannot tell you a control *requires* a gesture. Not implementable as written |
| 3 | `IntersectionObserver` | **yes** | Baseline. Still needs its own gate; it changes *what* is indexed |
| 4 | `CSS.highlightsFromPoint` | **no** | Absent. `CSS.highlights`, `Highlight`, `StaticRange` (all already relied on) present |
| 5 | `document.fragmentDirective` | **yes, 0 own keys** | Feature detection only, no generation API |
| 6 | `Sanitizer` + `Element.setHTML` | **yes** | **Better than implied**; both present, plus `setHTMLUnsafe`. Most actionable of the six |

Already-relied-on APIs re-confirmed present: `checkVisibility`, `Intl.Segmenter`,
`Intl.Locale`, `scheduler.yield`, `navigator.locks`, `caches`,
`ariaLabelledByElements`, `ariaControlsElements`. `document.modelContext` absent
without the Chrome flag. **Net: of six proposals, two are unavailable, one is not
implementable as described, and one is more available than claimed**; probing
changed the answer on four of six.

**Frame reachability:** **36 iframes: 18 reachable, 18 permanently opaque; reachable
ones hold 12–43 elements each.** The frames carrying real content (ads, embeds,
payment fields) are cross-origin by construction, so readable-frame inspection is
genuinely useful for an app that frames its own UI and close to useless on a news
site. `query_selector` reports `framesUnreachable` rather than implying it searched
everything.

## Six-tool lossless pagination, exact evidence, composed scopes; 93/93 (2026-09-01)

The same tool gained two projection-backed views (`actions`, `structure`) plus the
composed DOM `scopes` view. The frozen sensor went 16/25 → 37/37 → 76/76 → **93/93**,
covering pagination cursors, privacy exclusions, malformed input (59 calls all
`INVALID_INPUT`), cursor staleness/eviction, and lifecycle/shadow/frame cases; on live
React and NYTimes, sampled action addresses resolved **6/6** and structure addresses
read **6/6** with no second-page duplicates. The only thing making a raw-selector tool
shippable is that its exact-CSS path refuses the same regions the projection refuses.
Attacked against the demo's `[data-private]` block:

| attack | result |
|---|---|
| `[data-private]` directly | 0 returned, **2 withheld and declared** |
| `[data-private] *` | 5 withheld, no leak |
| `*` with `limit: 400` (wildcard sweep) | 296 matched, 7 withheld, **no leak** |
| `body [data-private] p` | 4 withheld, no leak |

Malformed/conflicting selectors → `INVALID_INPUT`; no-match a real zero; inside budget
at 376/988 tokens; the 12-site navigation sensor's **156/156** combined invariants
held.

**Coalescing (2026-09-01):** grouping lexical chunks that expand to the same exact
region cut React 52 → 43 unique regions (−13.8% result tokens), Wikipedia 39 → 29
(−26.2%), CNN 46 → 42 (−16.0%); rank 1 unchanged. **WASM BM25 rejected** on the
measured bottleneck: live index time is 3.4 ms (React) / 6.8 ms (CNN) while projection
is 12.8 / 23.0 ms; WASM would not move projection, `Intl.Segmenter`, or serialization.
Reconsider only above 10,000 chunks or worker retrieval p95 above 50 ms.

**Historical eighth-tool cost:** 7 → 8 tools pushed the instruction surface ~2,869 →
**~3,175 tok** (against a 3,200 ceiling) and the core gzip bundle 34.8 → **37.4 kB**; a K7 breach of 25%. That ceiling exists because these strings are paid twice: on every
`getTools()` and in the shipped bundle. An intermediate 2026-09-01 sensor measured the
six definitions at **~2,132 tokens**; the final current surface is **1,507/2,200**
(Part 4 § 5). The eight-tool and 2,132-token figures are dated design history.

---

# Part 3; historical pre-merge rating (2026-08-31)

Preserves the eight-tool measurement that motivated the merges. Not the current
surface: `read_region` is now a routed path of `resolve_address`,
`list_opaque_regions` is `describe_app({ opaque: true })`, and `query_selector` now
has semantic views in addition to exact CSS.

```bash
# Historical eight-tool names (2026-08-31), run by sensors that no longer exist.
# Current surface is six tools:
# read_region → resolve_address; list_opaque_regions → describe_app({ opaque: true }).
#   eval:navigate · eval:selector · eval:tools
```

Graded on **what an agent can do with the answer**, not whether the call returned.

| # | Tool | Value | Evidence | Grade |
|---|---|---|---|---|
| 1 | `resolve_address` | Critical; nothing else is actionable without it | **32/32** resolved, **0 NOT_FOUND** on an unchanged page | **A** |
| 2 | `describe_app` | Critical; the only orientation | orient 237–833 tok; **`since` saves 97.6% median**; `recommendation` fires on 3 losing pages | **A** |
| 3 | `locate_control` | High; grounding is the bottleneck | **34/38** by their own name; zero high-confidence misses; affordances +15 pp | **A−** |
| 4 | `read_region` | High; fragment → section | **35/35** region addresses readable | **A−** |
| 5 | `find_on_page` | Medium-high, vocabulary-bound | round-trip **38/45**; deleting ONE word costs **−17 pp** at rank 1 | **B** |
| 6 | `list_opaque_regions` | Medium; only pays off with vision | **51/53 (96%)** boxes, 96% carry a `reason`, silent on 2/8 pages | **B+** |
| 7 | `agentic_content` | Medium; the only tool to *leave* the page | **2/8** origins publish a manifest; fallback links **40/40** resolve; `find` 2/2 | **B−** |
| 8 | `query_selector` | Low for navigation | 16/16 checks; 4/4 privacy attacks refused; frames +12/+22 elements | **B** |

**The top four are the product** (addressing is the cleanest result, 67/67; `since`
the highest-value mechanism, 97.6% median; `find_on_page` weakest because BM25 scores
term overlap). **The bottom two are honest but conditional:** `list_opaque_regions`
has value exactly zero for an agent without vision; `agentic_content`'s manifest path
is mostly unused because **the web does not publish manifests** (2 of 8 origins),
making the 40/40 link fallback the real product.

**Two defects this rating found, both in descriptions I wrote:** (1)
`list_opaque_regions` told agents to gate on `nonText.opaque`, but GitHub reports
`opaque: 0` with **`unlabelledControls: 12`**; twelve icon-only controls an agent
would never look for; fixed to name both fields. (2) `agentic_content` returns
`matches` for `find`, not `docs`, undocumented; a probe read `f.docs`, got
`undefined`, and briefly recorded a working ranker as broken. Both were the
*undocumented response contract* failure class.

---

# Part 4; surface audit: redundancy, optimization, and the live ecosystem (2026-08-31)

## 1. The instruction surface was over its own ceiling; found and fixed

The two Part 3 fixes pushed the surface to **~3,266 tokens against the 3,200
ceiling**, ungated (the check died with the harness). Removing ~370 tok of duplicated
instruction text (restatement, not guidance) brought it to ~2,896 tok, later **~1,787
tokens** on the exact runtime definitions after the 2026-09-01 compression, with
routing, uncertainty, truncation and failure actions retained.

## 2. Redundancy: can any tool be removed?; No

`find_on_page`/`read_region` (survey vs expand; merging pays full section text per
hit); `locate_control`/`resolve_address` (rank vs verify; verification must be
free-standing, state and box only guaranteed at act time); `describe_app`/
`list_opaque_regions` (count is ~free, boxes ~10× cost, so the expensive call stays
opt-in); `query_selector` (only path outside the indexed root, plus bounded semantic
inventories); `agentic_content` (the only network-touching, site-level tool).
**Closest to removable: `list_opaque_regions`**; zero value without vision. It stays
because `describe_app` reports opaque counts and a coverage claim with no
follow-through is worse than none. The redundancy that *was* real: ~370 tokens of
duplicated instruction text (§ 1), not duplicated tools.

## 3. Live comparison: the only other WebMCP deployments we can find

Probed with `--enable-features=WebMCPTesting`. Both still ship, correctly gated on
the platform API existing (in stock Chrome they expose nothing).

| | mcp.io / cloudflare | **Naviquest** |
|---|---|---|
| tools | 2 each (site search) | **6** (page + site) |
| `untrustedContentHint` | **false on both** | **true, all 6** |
| description size | 10–59 tok | ~360 tok avg |
| addressable element / `since` / budgets | no | every result / −97.6% / all responses |

Two findings: (1) **Both shippers omit `untrustedContentHint` on tools that hand
fetched page text to a model**; the spec's own Output-Injection mitigation, absent
from the spec's own website. (2) **The honest trade the other way:** their descriptions
are one-liners; ours average ~350 per definition because `inputSchema` is an
unvalidated hint, so our descriptions carry a routing and response contract theirs
don't; a real design choice, not a scoreboard. Neither returns an addressable element;
"both shipped search; neither shipped grounding" reproduces live.

## 4. Modern APIs; probed, not adopted without a consumer

`URLPattern` (yes; churn, not value); `Element.ariaNotify` (yes, new; notifies
screen readers, no agent-facing read surface); `Element.moveBefore` (yes; host-app
concern); `Observable` (yes; doesn't fix MutationObserver's blindness to property
writes); `Sanitizer` (yes; no unsanitized-HTML sink to adopt it into); `Summarizer`
(global present on a non-opaque `Window`; `downloadable` on a cold isolated Chrome 152
profile, then `available` after the shared model download, 2026-09-03; still undefined
in a dedicated worker; adopted as an optional schema-controlled response stage, runs
only for `summarize: true`, starts downloads only under active user activation,
retains grounding/source recovery, declares `lossy`, falls back to deterministic
text). These are capability evidence only; adoption still needs a Naviquest consumer,
and page JavaScript cannot replace trusted pixels, input, browser-computed AX, waits,
screenshots, or cross-origin frame control.

Verdict: **no automatic or worker-side generation**; Summarizer runs only behind an
explicit input flag after retrieval. Also justified: `query_selector`'s `attributes`
allowlist moved from a hardcoded tool-body judgement to `retrieval.qsAttributes`.

**4a. Summarizer orchestration (2026-09-01).** The deleted summarizer sensor (a fake
fixed-quota model, reproducible state, does not grade prose) verified: ordinary calls
make no model call; non-boolean `summarize` → `INVALID_INPUT`; output is explicitly
lossy; excluded/redacted text never reaches the model; a short response skips the
model; a long-region payload shrinks 1,344 → 378 estimated tokens (72%). Fixture model
calls are a cost disclosure, not a latency claim; the summarizer's own quality and
latency remain unmeasured. Use the flag for long responses, not as a blanket default.

## 5. Re-verified after all changes (2026-09-01 current pass)

The deterministic `yarn eval` sensor passes 32/32 (written red at 2/11). The deleted
ten-site navigation sensor ran 2026-09-01: Naviquest 60/60 at 26,424 payload tokens
versus the Playwright exact-target grounding ceiling's 57/60 at 68,733. The executor
receives no grader labels; these public cases cannot justify a ranking change.

A **targeted current-contract audit on five real sites** (MDN, React, English
Wikipedia, GOV.UK, NHS; no demo page) confirmed live native link-URL reads with
same-origin provenance, `live-page-link`/`manifest-resource` fallback discovery,
`refineBy.roles` ambiguity recovery, and property-only search-value detection without
returning the sentinel. **Current gaps it found:**
- MDN `locate_control("search MDN")` returned unrelated links with high confidence
  even while declaring ambiguity; violates the intended confidence invariant, needs
  fresh held-out calibration before any ranking change.
- Wikipedia ranked navigation children under the correct Featured Article heading
  above the requested prose. **Blind section ranking remains the largest measured
  quality loss.**
- Heading-less region churn: an early text edit could appear as region add/remove.
  Regions now get the per-element identity used for controls; a red contract proves
  the edit stays `region-content`.
- A fallback `live-page-link` is not readable as a manifest document; passing it to
  `read` now returns `NAVIGATE_INSTEAD` / `LIVE_PAGE_LINK` with its address (an
  arbitrary same-origin URL still returns `NOT_IN_MANIFEST`).

All payloads stayed within emitted budgets; all six malformed-input probes returned
`INVALID_INPUT`. A dated public capability audit, not a private release gate. The
current default sensor is 22 pages (the original 12 plus 10 more).

Transcript (2026-09-01, live pages change; not deterministic gates): roles 0
undocumented drift · surface 1,507/2,200 · selector 118/118 · contracts 32/32 ·
lexical HELD-OUT 18/19 literal, 17/19 reduced rank-1 · navigation invariants 286/286 ·
heading round-trip 59/71 · controls by their own sampled name 88/93 · 71/71 control
addresses resolved · 56/56 region addresses read. When the page supplies the
vocabulary, sampled addresses round-trip almost perfectly; two successful tasks remain
below rank one, reported separately from completed-trajectory quality.

**Bundle size history.** The eager static closure crept from 28.89 kB (2026-09-01) to
a 30.2 kB gate; ~200 bytes above the 30 kB product ceiling; then two reclaims
(moving agent-facing tool metadata out of the eager closure, then deferring the
retrieval lane) brought it to **27.76 kB** at a 27.9 kB gate (2026-09-03). The first
tool call loads a memoized ~21 kB answer-engine chunk; `worker: true` adds ~4 kB.

A response-shrinker fix was found and verified: NHS first returned 369 tokens against
a 350 cap; ranked lists now halve instead of dropping one row per step (repeated run
13/13 invariants, full rerun 286/286). **The loop still costs more than `innerText` on
CNN (108.7%), GOV.UK (204.8%), YouTube (663.2%), Figma docs (117.3%), NHS search
(145.2%), ECharts (203.9%), and Vercel Docs (100.4%); those losses remain explicit
rather than averaged away.**

## Where the eager weight actually was (2026-09-03)

Both this doc and `AGENTS.md` recorded that the next reclaim should split the
2,777-line `tools.ts` god file. **That was wrong for a year of edits:** `tools.ts` is
already behind a dynamic import; splitting it reclaims **zero** eager bytes. An
esbuild metafile partition found the largest removable item was an *edge*: `index.ts`
imported a four-line `then()` helper from `lane.ts`, dragging `lane`, `bm25`,
`lexical-index`, `ranking` and `exact` into the closure every page pays for. Moving it
to a leaf `async.ts` reclaimed **1,556 gzip bytes** (eager 29,317 → 27,761), gate
*down* 29.4 → 27.9 kB, verified by `yarn eval` (80/80) and `yarn eval --live` (91/91).
**Lesson: an import graph is not a cost model**; a leaf helper in a heavy module costs
the whole module; partition the metafile.

## What the reclaim broke, and how it was found (2026-09-03)

Making the lane lazy created three states no sensor could reach (module in flight,
never arriving, two rebuilds mid-load). `yarn typecheck`/`eval`/`eval --live` were all
green; none can induce a failed `import()`. `yarn test` (vitest + jsdom), added for
exactly this, found five real defects written failing first: `??=` caching a rejection
(a failed chunk fetch disabling retrieval for the page's life, and a failed first build
**permanently killing all six tools; worse than pre-reclaim**); `lane()` reporting
`'still loading'` for a permanent failure (host polling `ready` waits forever); an
un-awaited construction-time rejection blamed on the host; and coalescing keyed on the
wrong lane, so two rebuilds in the async window pointed hit ids into gone chunks. Each
was fixed to un-cache on failure, separate "loading" from "failed", and coalesce on
whether *this run* is a promise.

Then the harness refused to load at all; **a module that exports `then` is a
thenable.** `await import(m)` calls `namespace.then(resolve, reject)`; the helper
still named `then` received `resolve`, saw no `.then`, and called `reject(resolve)`; every dynamic import rejected. Static importers never see it (the binding is inlined),
so the bundle shipped green; had the lane been deferred without moving `then` out,
**the entire retrieval lane would have rejected on every page**, uncaught by any gate.
Renamed `then` → `chain`; `test/module-shape.test.ts` asserts no dynamically-imported
module exports `then`. Cost: 96 gzip eager bytes; net against the pre-reclaim 29.32 kB
is still 1,460 bytes.

---

# Part 5; the merge: 8 tools → 6 (2026-08-31)

Directed consolidation on Part 4's redundancy analysis:

| former tool | now | why the merge wins |
|---|---|---|
| `read_region` | `resolve_address` region path (routed by the address's `resolveWith`; `expand: true` forces it) | the split made the AGENT route between two tools over structurally identical addresses; the failure D40 measured (3/3 mis-routed on ja.wikipedia). Routing is the tool's job now |
| `list_opaque_regions` | `describe_app({ opaque: true, limit })` | its only relationship to describe_app was "the boxes behind the counts at ~10× cost"; a parameter expresses that without a second `getTools()` entry |

Both modes keep their own independently-tunable budget ceilings. 8 → **6 tools**:
surface ~2,898 → **~2,690 tok**, gzip 37.1 → **36.8 kB**, wrong-tool routing failure
mode **gone**. Re-verified: selector 16/16 · wikipedia 5/5 headings, 5/5 controls,
6/6 + 3/3 addresses, 8/8 invariants · opaque mode 50/52 usable boxes on 8 sites ·
typecheck clean. Three stale agent-facing routes to the dead names were rewritten.

---

# Part 6; improvement loop: the paraphrase gap, attacked (2026-08-31)

The first disciplined keep/discard loop since the harness was rebuilt. Frozen
protocol: error-analyze → KPI contract → baseline → smallest change → held-out
verdict.

## KPI contract (written before touching the subject)

```text
Goal        an agent's content query finds the right region when its wording
            only partially matches the page
Primary     minus-one-word rank-1 %, HELD-OUT pages (mdn, gov.uk, rfc-editor,
            python-docs; the last two never used in any ranking work here)
Baseline    measured, fixed budget          Target  >= +10 pp
Guardrails  G1 literal rank-1 on held-out does not drop · G2 navigate
            invariants hold · G3 heading round-trip not worse · G4 typecheck,
            build, surface budget green
Tuning      DEV pages only (wikipedia, react.dev), <= 3 iterations
```

**Hypothesis.** Heading terms enter the indexed doc **once** (`index.ts` prefixing),
so TF saturation lets body-rich sibling sections outrank the section whose own
heading matches. Remedy: **BM25F-lite field weighting**; repeat the heading path in
the doc, k1 saturates the repetition, ties bias toward the right section. Shipped as
`lexical.headingWeight`.

## The sweep (DEV) and held-out verdict

| headingWeight | literal rank-1 | minus-one-word rank-1 |
|--:|--:|--:|
| 1 (baseline) | 56% | 38% |
| **3 (chosen)** | **88%** | **81%** |
| 5 | 94% | 81% |

w=3 over w=5: same primary, smaller intervention. Held-out: literal rank-1 92% → 92%
(G1 ✓), minus-one-word **85% → 92%**.

**ACCEPT, with a framing error disclosed rather than retrofitted.** The +10 pp target
was calibrated against an assumed ~54% baseline; the held-out pages started at 85%,
where +10 pp is nearly the ceiling (+15 pp max). The lobby rule (primary moves on
held-out AND guardrails hold) is met: +7 pp held-out, +43 pp DEV, **+27 pp combined
across all 29 probes (59% → 86%)**, zero literal regressions, guardrails green.
Default set to `headingWeight: 3`.

**Lessons:** (1) Calibrate the threshold against the held-out baseline, not an
assumed one; a +10 pp bar on an 85% baseline is a ceiling test. (2) The paraphrase
gap was one-third mechanism, not all vocabulary; a field-weighting bug accounted for
27 pp of the 41 pp combined gap; re-measure the dense lane against THIS baseline
before shipping it. (3) Suite contamination is now logged in the harness; wikipedia
and react.dev are burned for future ranking experiments.
