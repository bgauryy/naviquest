# Technology

How Naviquest turns a live browser document into six bounded WebMCP tools. See
[TOOLS.md](./TOOLS.md) for the wire contract and [ARCHITECTURE.md](../ARCHITECTURE.md)
for stage-by-stage invariants.

## System boundary

Naviquest runs inside the host page: it reads browser-exposed document semantics,
builds three local indexes, and registers six tools through
`document.modelContext`. No page content leaves for a server. Five tools declare
`readOnlyHint: true`; `resolve_address` declares `false` because its live-link
result is the navigation seam, so the metadata must not overpromise.

```text
document and reachable roots
  → accessibility-oriented projection
  → headed regions and control documents
  → inline or worker retrieval
  → optional main-window summary
  → bounded tool response with a re-resolvable address
  → browser companion performs trusted input, navigation, or screenshots
```

**This boundary is the product, not a temporary limitation.** From page
JavaScript, Naviquest can't be a faithful screenshot API, trusted input
dispatcher, browser-computed AX reader, or cross-origin frame inspector; Playwright or Chrome DevTools supplies those; Naviquest supplies the compact
target, evidence, state, box, and declared coverage gap. Chrome documents
`document.modelContext.registerTool` as the WebMCP imperative registration
surface; WebMCP is tab-bound and origin-scoped, not a replacement for server-side
MCP. See the [WebMCP overview](https://developer.chrome.com/docs/ai/webmcp) and
[imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api).

## Why each technology is here

| Technology | Why Naviquest uses it | Boundary or rejected substitute |
|---|---|---|
| WebMCP imperative registration | Publishes typed, bounded page tools on the document; the SDK object reuses the same implementation. | Server-side MCP can't observe live tab state; a second page API creates two behavior paths. |
| Accessibility-oriented DOM projection | Turns structure, names, roles, relationships, and live state into the vocabulary an agent reasons with. | Raw DOM and CSS selectors expose implementation detail without proving semantic purpose or actionability. |
| `dom-accessibility-api` | Computes accessible names where page JavaScript has no browser-computed name API. | Native-only fallback left reachable controls unnamed, so Naviquest bundles the shim. |
| `Intl.Segmenter`, Unicode normalization, `Intl.DisplayNames` | Tokenizes words and sentences across CJK, Thai, RTL, and identifier-heavy text; derives language affordances without an English list. | Whitespace splitting reports false coverage on scripts without spaces. |
| Heading-aware segmentation | Keeps evidence attached to its authored section and gives retrieval a durable region to address and expand. | Fixed windows discard hierarchy, so they stay only the fallback. |
| Exact evidence plus Okapi BM25 | Deterministic literal recovery plus a zero-download lexical ranker that answers immediately. | Dense-only retrieval ranked below BM25 at rank 1 and can't prove literal source spans. |
| Int8 Model2Vec plus Reciprocal Rank Fusion | Adds an optional paraphrase lane while preserving BM25 results and availability. | Fusion avoids making model download, cache state, or embedding weakness a prerequisite for an answer. |
| ESM module worker | Moves index construction and ranking off the page thread; projection and live resolution stay beside the DOM. | Workers can't touch DOM nodes; moving projection there needs lossy serialization. |
| Cache API and Web Locks | Reuse unchanged dense weights and stop multiple SDK instances racing the same download. | Missing support degrades to a normal fetch; lexical never waits. |
| `scheduler.yield()` with timer fallback | Splits long projection work so large pages don't monopolize the main thread. | `requestIdleCallback` is Window-only, absent from the worker scheduling chain. |
| Mutation, slot, toggle, frame, URL, viewport, semantic observation signals | Detects different classes of page change and reports bounded deltas or explicit degradation. | No single event observes property-only state, URL-less view changes, shadow assignment, and frame navigation. |
| CSS Custom Highlight API | Marks retrieved evidence without wrappers or host DOM changes. | DOM mutation for highlighting invalidates addresses, triggers observers, and disturbs the host app. |
| Chrome Prompt API (`LanguageModel`, incl. multimodal image input) | Powers three opt-in, fail-open on-device readers: the answer **verifier** (does this extractive sentence answer the question?), the **answer-from-region** reader, and the **multimodal opaque-region describer**; `describe_app({ opaque: true, describe: true })` reads a `<canvas>` chart or unlabeled `<img>` (`ai/image-describer.ts`). | Lexical selection can't tell "answers the question" from "on-topic but wrong", and text can't read a canvas. Download-gated and Window-only, so every use fails open to the deterministic path. |
| Chrome Summarizer API | Optionally reduces long grounded responses after retrieval while preserving addresses and exact source recovery. | Generated text is lossy, stays on the page `Window`, skips short input, and never replaces deterministic evidence by default. |
| Dynamic `import()`, esbuild, Terser | Registers small schemas eagerly, loads the answer engine on first use, emits publishable JS and declarations, enforces the bundle budget. | Shipping raw TypeScript or eager-loading the full engine pushes compatibility and startup cost to every host page. |
| Strict TypeScript | Keeps the public SDK, six schemas, worker messages, and demo consumers aligned before publishing. | Runtime tool input still needs guards because WebMCP schemas are semantic hints, not validators. |

## Tool implementation map

| Tool | Internal path | Browser data used | Main output |
|---|---|---|---|
| `describe_app` | `structure.ts`, `coverage.ts`, `modality.ts`, `semantic-delta.ts` | document title and URL, landmarks, headings, `aria-current`, modal/inert state, root and frame coverage | orientation, paged inventories, `_etag`, `_observation`, or opaque boxes |
| `find_on_page` | `segment.ts`, `exact.ts`, `bm25.ts`, `answer.ts` | visible projected text, heading containment, locale-sensitive word and sentence boundaries | ranked regions, sourced answer sentence, nearby controls, addresses |
| `locate_control` | `project.ts`, `roles.ts`, `affordance.ts`, `ranking.ts` | accessible name, role, form/list context, state, ARIA relationships, native link/form attributes | ranked live controls, confidence, affordances, ambiguity refinements |
| `resolve_address` | `address.ts`, live state and geometry helpers in `tools.ts` | current DOM identity, state properties, `getBoundingClientRect()`, visual viewport, browser-resolved anchor URL | fail-closed resolution, box, state, native-link `navigation`, or full region text |
| `query_selector` | `exact.ts`, `dom.ts`, projection and scope inventories | known CSS, readable same-origin frame documents, open and registered shadow roots | bounded semantic inventory or guarded exact evidence with scope provenance |
| `agentic_content` | `agentic.ts`, URL and fetch APIs | same-origin `llms.txt` resources or current live page links | site-resource list/search/read with explicit `urlSemantics` |

The six names are routing decisions. Region reading stays a path of
`resolve_address`, and opaque inspection stays a mode of `describe_app`, so an
agent needn't choose between two tools for the same address or summary.

## Projection and accessibility semantics

The projector uses an explicit work stack, not `TreeWalker`, because the walk
must cross open shadow roots and slot assignments; a component owner hands
Naviquest a closed root through `registerRegion()`, since the platform offers page
JavaScript no way to discover one. Naviquest combines native element attributes
and properties; ARIA relationship reflection (`ariaLabelledByElements`,
`ariaControlsElements`) when Chrome exposes it; the bundled `dom-accessibility-api`
accessible-name implementation; `Element.checkVisibility()` and computed style for
authored visibility; and live form state at answer time, since property writes
don't always produce DOM mutations. Chrome 152 still exposes no page-JavaScript
`computedRole` or `computedName`, so the hand-written role layer and
accessible-name implementation remain; the browser-computed accessibility tree
stays a browser-companion capability.

## International text

[`Intl.Segmenter`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter)
provides locale-sensitive word and sentence boundaries; why Japanese, Chinese,
Thai, and other space-free scripts stay searchable; the same tokenizer runs for
indexing and queries. `Intl.DisplayNames` builds language-name affordance evidence
from ISO codes instead of an English word list. Unicode normalization and
locale-aware casing keep exact evidence and BM25 documents aligned.

## Retrieval lanes

All public tools return promises, regardless of lane.

| Lane | Execution | Network and memory policy |
|---|---|---|
| Inline lexical | BM25 and exact evidence run on the main thread | default; no model download |
| Module worker | projection stays on the main thread; index construction and ranking run in `worker.ts` | only strings, numbers, IDs, and scores cross `postMessage()` |
| Dense fusion | worker loads an int8 Model2Vec table and fuses cosine results with BM25 using Reciprocal Rank Fusion | optional; lexical answers never wait for the model |

The SDK constructs one standard ESM module worker with
`new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`.
[Web Workers](https://developer.mozilla.org/docs/Web/API/Web_Workers_API/Using_web_workers)
can't access the DOM, enforcing the division: projection and address resolution
stay on the page thread; pure retrieval can leave it. The dense worker uses
`fetch()`, the Cache API, and Web Locks; cache storage avoids re-downloading
unchanged weights, a per-URL lock stops two SDK instances racing the same
download, and `navigator.connection.saveData` disables warming under reduced-data
requests. Missing cache or lock support degrades to an ordinary fetch; lexical
never waits.

## Scheduling, freshness, and observations

Long projection walks yield through `scheduler.yield()` when available and fall
back to a timer. A generation guard rejects a sliced projection if an
address-relevant mutation occurred while it was being built.

Freshness combines several browser signals because no single API covers the
composed page: [`MutationObserver`](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver)
for child/text/attribute changes in every reachable root; `slotchange` for
reassignment inside components; `toggle` for popover and disclosure state;
capture-phase frame `load` for browsing-context navigation; and URL, tree shape,
viewport resize, and font-loading checks for changes that don't arrive as useful
mutation records.

`_etag` plus `since` compares delivered payloads; `_observation` plus
`changesSince` compares compact semantic snapshots at tool-call time; catching
current focus and property-only state, but reporting an interval rather than
claiming which action caused a change. Histories and returned suffixes are
bounded and declare omissions. Observation cursors are namespaced per SDK
instance, so one can't confidently compare another's snapshot; malformed history
or change-limit tuning restores the shipped bounds instead of disabling eviction.
Controls and regions get per-element identities in the observation ledger, with
semantic-address fallback for equivalent framework replacement, so an early text
edit is a `region-content` change even when it also changes the region's next
address.

## Addresses and highlighting

An `Address` is a semantic description; landmark, heading path, role, accessible
name, row context, ordinal, peer count; not a stored DOM pointer. Resolution
re-runs a strict ladder against the current page and returns `AMBIGUOUS` or
`NOT_FOUND` instead of picking a plausible wrong node. Native link metadata comes
from the resolved live `HTMLAnchorElement` or `HTMLAreaElement`, so `<base>`,
property changes, fragments, targets, and browser URL resolution stay
authoritative. The [CSS Custom Highlight API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API)
marks answer ranges through `Highlight`, `StaticRange`, `CSS.highlights`, and the
public `::highlight(naviquest-hit)` pseudo-element, without wrapping or mutating
host content.

## Loading and bundle policy

Only the six tool names load eagerly. Titles, descriptions, and input schemas
load through `import('./tools/tool-specs.ts')` when `register()` or `toolDefs()`
needs them; the answer engine loads once through `import('./tools/tools.ts')` on
first call. Its lazy graph includes `summarizer.ts` but does no model work without
`summarize: true`. The optional worker and dense weights stay separate.

`packages/naviquest/build.ts` uses esbuild and Terser, walks the complete static
import closure, and currently fails above 28.5 kB eager gzip. It reports lazy and
worker chunks separately so code splitting can't hide their cost. The 2026-09-03
build measured 28.46 kB gzip eager and 4.39 kB for the optional worker; the lazy
chunks are reported individually because their loading conditions differ.

The gate moved from 29,000 to 29,500 that day to pay for the phrasing fold in
`project.ts`, then to 30.2 kB across three further same-day batches; ~200 bytes
above the ceiling. Lowering it to 29,200 was paid for by making the agent-facing
tool metadata lazy: the six names stay eager in `tool-names.ts`, while titles,
descriptions, and JSON Schemas load with the answer engine, so `register()` and
`toolDefs()` pay for them and construction doesn't. 1,362 gzip bytes reclaimed;
`build.ts` records why, and the 30 kB ceiling did not move.

## APIs deliberately not used

| API or technology | Decision |
|---|---|
| WASM | BM25 is small JavaScript; Wasm adds a boundary without removing DOM work |
| `SharedArrayBuffer` and Wasm threads | cross-origin isolation can break a host page's third-party resources |
| Navigation API | useful auxiliary signal, but misses first load and URL-less view changes |
| `PerformanceObserver` layout shifts | geometry settling belongs to the browser companion, not semantic truth |
| Sanitizer API | Naviquest has no unsanitized HTML sink; `agentic_content` declines HTML reads |
| computed accessibility fields | `computedRole` and `computedName` were absent in the tested Chrome 152 page-JavaScript surface |

## Implemented optional main-window summarization

Chrome's [Summarizer API](https://developer.chrome.com/docs/ai/summarizer-api)
is an implemented optional response stage, not a retrieval or grounding
dependency. Pass `summarize: true` to a content-bearing tool. The lazy `tools.ts`
graph owns `summarizer.ts`; after the grounded response returns, the summary
service sends only redacted authored text to one cached browser session; never
DOM, elements, addresses, state, scores, form values, or worker data; and starts
a model download only during active user activation.

On success, the response labels generated text as lossy and preserves grounding
plus an exact source-recovery call. On absence, policy denial, missing model,
download state, language rejection, quota overflow, timeout, or runtime failure,
the deterministic fields stay unchanged and `summary.status` declares the
degradation. A preflight token estimate skips input below the configurable
`summary.minInputTokens` floor before checking availability; a postflight guard
returns the source if the grounded summary envelope isn't smaller than the
deterministic payload. Ready results expose measured model latency and estimated
payload tokens saved.

Quota overflow triggers one bounded summary-of-summaries pass. Tunable limits in
`config.ts` control timeout, quota safety ratio, chunk ceiling, and output size.
Sequential on purpose: one cached model session avoids competing for the same
on-device model and makes the number of model calls explicit. The stage stays on
the page `Window` even when BM25 runs in `worker.ts`: Chromium's current IDL puts
worker exposure behind the separate `AISummarizationAPIForWorkers` feature
(disabled by default), while the Writing Assistance API draft exposes the standard
interface on `Window`. Runtime feature detection and `availability()` decide the
fallback; headless execution gets no Naviquest-specific exception.

## Browser-companion responsibilities

Page JavaScript can't provide privileged pixels, trusted mouse or keyboard input,
browser-computed accessibility, cross-origin frame DOM, navigation completion,
downloads, waits, or screenshots. Naviquest returns semantic targets, live state,
boxes, navigation provenance, and declared coverage gaps. Playwright, Chrome
DevTools, or another browser companion performs and verifies the action.
