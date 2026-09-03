# TESTING; how to run Naviquest against real websites

Browser-backed checks need **Chrome installed** (`channel: 'chrome'`) and Playwright (devDependency). Checks hitting third-party sites need **network** and are slow; they are sensors, not regression gates. Injection does not require target-site Naviquest adoption or `orientation`; six tools read live structure. `eval:contracts`, `eval:roles`, `eval:summarizer`, and `eval:surface` are deterministic and offline after Chrome and dependencies install.

```bash
yarn install
```

---

## The commands

`yarn test` (vitest + jsdom) owns two narrow jobs: **(1) induced failure and timing**; crashing a retrieval worker to land two rebuilds in one tick; **(2) WebMCP platform surface**; mocking `document.modelContext` and driving all six tools down the wire as an agent uses them: `getTools` → `executeTool` → stringified `ToolResult` → `content[0].text` → payload. No Chrome or network required; runs in under a second. **`yarn eval`** drives real Chrome against a real accessibility tree; simulated DOM is not evidence about projection or ranking. `test/webmcp-protocol.test.ts` asserts marshalling and lifecycle only. Every check was mutation-tested: breaking the input gate, pre-abort check, annotations copy, and `dispose()`'s claim release each fails a check.

Twenty `eval:*` scripts merged into [`eval/eval.ts`](../eval/eval.ts) on 2026-09-02. Gates are deterministic and offline (may fail builds); live lane needs network and a mutable page, so never runs by default.

| command | needs net | what it answers |
|---|---|---|
| `yarn eval` | **no** | all three gates below. Exits 1 on failure. |
| `yarn eval --only surface` | **no** | tool-description token budget (`TOOL_SPECS` from real registration objects) |
| `yarn eval --only roles` | **no** | `roles.ts` vs `aria-query` in real Chrome; gates on undocumented drift |
| `yarn eval --only contracts` | **no** | six-tool fixture: semantic deltas, ambiguity recovery, live navigation metadata, URL provenance, privacy, type guards, stale cursors, bounded text |
| `yarn eval --live` | yes | gates, then all six tools on real MDN pages: budget adherence, address round-trip, cursor overlap/skip, declared truncation, answerability |
| `yarn eval --only invariants` | yes | single-page live lane alone |
| `yarn eval --only compare` | yes | three arms answer same questions: `ariaSnapshot` alone, SDK+host, tools alone. Charges every arm over bytes ingested. Writes `eval/out/compare.json`. |
| `yarn eval --only crawl` | yes | cross-page navigation: `locate_control` resolves natural-language intent to link, host clicks it, SDK re-indexes new document, answer read off destination through address. Skipped under `--url`. |
| `yarn eval --verbose` |; | per-comparison detail from roles oracle |
| Chrome skill `scripts/cdp-checks/api-probe.mjs` | yes | which platform APIs exist in the attached real Chrome |

Last two keep no `package.json` script on purpose (AGENTS.md names them as protocol): ranking is *KPI first, sweep DEV, verdict HELD-OUT, never tune on pages you measure*; APIs are *probed, never recalled from memory*. Run deliberately, not as part of a batch.

### Deleted in the same merge

`eval:navigate`, `eval:inject`, `eval:selector`, `eval:tools`, `eval:accname`, `eval:summarizer`, `eval:selection`, `eval:devpost*`, `eval:benchmark`, `eval:navigation-benchmark`, `eval:mdn-agentic`, `eval:mdn-grade`, and `eval/benchmark/` MDN comparison study. Every figure this file or [EVAL.md](./EVAL.md) attributes to these sensors is now **historical**: measurement stands as record, nothing re-runs it. Rebuild sensor before quoting its number as current.

Run against any page:

```bash
node eval/eval.ts  --url https://react.dev/learn --find "useEffect cleanup"
node eval/eval.ts  --url https://vercel.com/docs --locate "search the docs"
node eval/eval.ts  --url https://www.paypal.com/us/home --headed   # watch it highlight
```

---

## How injection works (the part to copy)

Shortest runnable form:

```bash
yarn eval --live --url https://webmcp.devpost.com \
  --find "What are the judging criteria?" --reload
```

For automation code, use the shared host adapter. It builds the bundle once, installs before navigation, waits for six native tools, handles Chrome exposing `document.modelContext` after earliest init-script turn:

```ts
import { chromium } from 'playwright';
import {
  WEBMCP_CHROME_ARGS,
  buildNaviquestInstallScript,
  installNaviquestWithPlaywright,
  invokeNaviquest,
  waitForNaviquestTools,
} from './eval/eval.ts';

const browser = await chromium.launch({
  channel: 'chrome', args: WEBMCP_CHROME_ARGS,
});
const context = await browser.newContext({ bypassCSP: true });
const install = await buildNaviquestInstallScript();
await installNaviquestWithPlaywright(context, install); // before newPage/goto
const page = await context.newPage();
await page.goto('https://webmcp.devpost.com');
await waitForNaviquestTools(page);
const result = await invokeNaviquest(page, 'find_on_page', {
  query: 'What are the judging criteria?',
});
```

Chrome supports underlying lifecycle primitive directly: `Page.addScriptToEvaluateOnNewDocument`. Run `yarn eval --live --url … --cdp` to exercise that path. Puppeteer equivalent is `evaluateOnNewDocument`. `addScriptTag` and one-off `Runtime.evaluate` are not substitutes; SDK instance disappears on next hard navigation.

Adapter is evaluation/automation-host code. Site author uses public `createNaviquest()` entry in their own bundle, calls `register()` normally. Both modes expose same six tools and same `window.naviquest` page-client instance; only lifecycle ownership differs.

---

## What current real-site evidence looks like

### Competition-site dogfood, 2026-09-01

Deleted Devpost sensor ran native Devpost criteria crawl, then three-task Naviquest-versus-Playwright recovery comparison. Detailed measurements, source URLs, and evidence lived in `eval/DEVPOST-CRAWL.md` and `eval/DEVPOST-DOGFOOD.md` (deleted 2026-09-02). Crawl prompt is public; one deadline question was adjusted after 13/14 run; dated product demonstration, not held-out ranking evidence. Browser host owns navigation; Naviquest owns semantic discovery, reading, and grounding inside each document.

### Current ten-site navigation benchmark, 2026-09-01

Deleted ten-site sensor self-tested the frozen 30-case matrix, then injected current SDK into MDN, React, GOV.UK, NHS, English Wikipedia, Next.js, Vercel, GitHub, W3C APG, and TypeScript. Audit makes no submission, purchase, login, or persistent site change. The 2026-09-01 capture completed all 30 Naviquest trajectories:

| Arm | Quality | Fully grounded/actionable | Rank 1 | Payload tokens |
|---|---:|---:|---:|---:|
| Naviquest returned-signal recovery | **60/60** | **30/30** | 28/30 | **26,424** |
| Playwright exact-target grounding ceiling | 57/60 | 28/30 | **30/30** | 68,733 |

Two Naviquest tasks below rank 1 completed through copied SDK-returned names or addresses. Public, contaminated recovery evidence; not held-out ranking result or recursive-crawling evaluation.

| Contract | Real-site evidence |
|---|---|
| Live navigation | MDN CSS, React Quick Start, Wikipedia Featured Articles addresses resolved to current browser-computed absolute URLs with `sameOrigin` provenance |
| URL semantics | MDN/Wikipedia fallback links returned `live-page-link` + addresses; React `useState.md` returned `manifest-resource` without pretending it was the live HTML page |
| Ambiguity recovery | React docs search exposed textbox/button role refinements; retrying `role: "button"` reached `Search ⌘ K` |
| Semantic state | property-only search-value presence detected on GOV.UK/NHS without serializing entered sentinel value |
| Focus | NHS reported focused search control and simultaneous reactive value reset as separate semantic facts |
| Bounded changes | both GOV.UK and NHS reported 42 changes, returned 3, declared exactly 39 omissions under forced cap |
| Unchanged | immediate follow-up observations cost 84 tokens on GOV.UK and 83 on NHS |
| Independent browser view | Chrome DevTools exposed 60 actionable MDN accessibility references from 695 AX nodes and independently confirmed both `Skip to search` and search buttons |

Separate targeted audit found ranking/classification gaps: MDN returned unrelated high-confidence controls for one search-intent phrasing; Wikipedia promoted child navigation above featured-article prose. Exposed heading-less region churn; deterministic contract proves same edit remains `region-content` change after stable per-element region identity. Treat public ranking failures as diagnosis evidence, not tuning data.

### Historical four-site navigation capture, 2026-08-31

Deleted navigate sensor's `--url` mode produced this dated capture. `%aria` / `%text` is cost of one orient→search→locate loop against accessibility snapshot vs. `document.body.innerText` (honest DOM-dump baseline). Lower is better; addresses/heading are success counts.

| site | elements | rawHTML tok | loop tok | %aria | %text | heading | ctrl-by-name | addrs | `since` saved |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| modelcontextprotocol.io | 688 | 73,430 | 806 | 44.9% | **104.9%** | 1/1 | 1/1 | 2/2 | 96.5% |
| react.dev/learn | 2,411 | 70,908 | 1,905 | 30.0% | 57.6% | 4/5 | 4/5 | 9/9 | 97.0% |
| vercel.com/docs | 1,723 | 198,536 | 1,259 | 17.1% | 95.1% | 2/2 | 5/5 | 7/7 | 97.3% |
| www.paypal.com | 3,623 | 124,252 | 1,033 | 23.3% | 46.5% | 0/1 | 3/3 | 4/4 | 95.9% |

**How to read it honestly:**

- **Re-observation win is universal: `since` saved 95.9–97.3%.** Second orient costs 12–13 tokens instead of 320–440.
- **Addressing held everywhere: 22/22** control+region addresses resolved through the tool. Agent reading address can act on it.
- **Cost win tracks page size and text density.** Vercel docs: loop is 17% of accessibility snapshot; raw HTML is ~199 k tokens (doesn't fit context window) while three tool calls answer in ~1,260.
- **modelcontextprotocol.io is a LOSS against `innerText` (104.9%).** SDK reports it (`describe_app().recommendation` fired: "this page is small, ~843 tokens, request the tree directly"). Knowing when not to help is the point.
- **paypal breached one budget** (`find_on_page` 411/350 tokens) and missed its single heading probe (0/1); real finding on marketing page with little heading structure.

Example payload contents (`yarn eval --live --url`):

- **Vercel, `locate_control("search the documentation")`** → rank 1 `button "Search Docs"` with affordance `search` and re-resolvable address; `confidence: "low", ambiguous: true` (wording only partly overlaps). Grounds and flags its own uncertainty.
- **React `/learn`, `find_on_page("how do I run code when a component mounts")`** → low scores (~6.5), `answer: null`. Page is intro, doesn't cover `useEffect`; SDK returns near-misses marked as weak. Documented "query intent, not vocabulary" gap, visible live.
- **modelcontextprotocol.io, `find_on_page("what is the model context protocol")`** → right heading round-trips (`"What is the Model Context Protocol (MCP)?"`), but top *text* is `"Copy page"` button under that heading; heading-weighted BM25F promoting heading match over prose. Real ranking quirk on button-dense doc shells.

Reproduce any line:

```bash
node eval/eval.ts  --url https://vercel.com/docs --locate "search the documentation"
```

Numbers move as these sites change; they are a live sensor, not a fixture.
