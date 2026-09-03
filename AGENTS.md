# AGENTS.md

Yarn 4. `naviquest` lives in `packages/naviquest/`; a browser WebMCP SDK: six token-budgeted tools on `document.modelContext`. Agents ask the page; they do not ingest it. Two callers, one implementation: a site embeds `createNaviquest` and `register()`, or an automation host injects the same SDK (the install-script helper in `eval/eval.ts`, `docs/TESTING.md`) into **any** origin; no page markup required. `orientation` / `exclude` are optional first-party overlays. Layout: `packages/naviquest/` SDK · `packages/demo-app/` CityDesk (`/`, `/parking.html`, `/libraries.html`, `/notices.html` on `:5310`) · `eval/` sensors · `docs/` + `ARCHITECTURE.md`.

**`src/` is grouped by subsystem** (2026-09-03). At the root sit only the two entries and what nearly everything imports: `index.ts`, `worker.ts`, `config.ts`, `types.ts`, `async.ts`, `webmcp.d.ts`. The rest is `page/` (projection: `project`, `dom`, `roles`, `aria-taxonomy`, `affordance`, `nontext`, `structured`, `modality`, `page-text`, `language`, `highlight`) · `retrieval/` (`lane`, `bm25`, `lexical-index`, `exact`, `ranking`, `dense`, `text`, `segment`, `answer`) · `ai/` (`model-gate`, `prompt-api`, `lm-session`, `answerer`, `verifier`, `summarizer`, `translator`, `image-describer`) · `tools/` (`tools`, `tool-specs`, `tool-contracts`, `tool-names`, `agentic`, `orientation`, `coverage`, `address`, `structure`, `budget`, `delta`, `semantic-delta`). Folder placement is not layering enforcement; the dependency graph is a 9-level DAG with zero cycles and must stay that way; check with a metafile partition, not by eye. `index.ts` and `worker.ts` may not move: `package.json` `exports`, `vite.config.ts`, `tsconfig.json` `paths`, and `build.ts` all name those paths. MIT at `LICENSE` and `packages/naviquest/LICENSE`. `.SUBMITION/` (gitignored leftovers); do not restore into `docs/`.

## Before you write

1. **Code only through [DEV.md](./DEV.md).** Think → Plan (named slice: Place, Deps, In, Out, Interface, Test, Edges) → Code → Review. No reason → no edit.
2. **Octocode before any flow change.** Map graph (callers/callees), stream (data/control), and dependencies. Use Octocode MCP (`user-octocode`); if it is down, `npx octocode`. Do not invent architecture. A snippet is a lead, not proof.
3. `package.json` owns commands. **There is exactly one eval command: `yarn eval`, and exactly one test command: `yarn test`.** Do not run or cite deleted harness names: `check`, `oracle*`, `bench:*`, `probe:*`, `size`, `scale`, `model:fetch`, `answer:eval`, `audit:a11y`, `tokenizer:parity`, `gen:*`, and every `eval:*` name (`eval:contracts`, `eval:roles`, `eval:surface`, `eval:summarizer`, `eval:navigate`, `eval:lexical`, `eval:apis`, `eval:selector`, `eval:tools`, `eval:inject`, `eval:accname`, `eval:selection`, `eval:devpost*`, `eval:benchmark`, `eval:navigation-benchmark`, `eval:mdn-*`).

**`yarn eval` and `yarn test` are not two names for one thing, and the boundary is load-bearing** (added 2026-09-03; this file previously said "no unit-test framework"). `yarn eval` drives real Chrome and owns all behaviour: projection, ranking, budgets, addressing, tool contracts; measured against a real accessibility tree, never a simulation. `yarn test` is vitest + jsdom and owns exactly two things no sensor could reach: **induced failure and timing**, and **the WebMCP platform surface**. It can make a dynamic `import()` fail, crash a retrieval worker, and land two rebuilds in the same tick. It can also mock `document.modelContext` faithfully enough to drive the agent's real wire path offline; eval's fake implements `registerTool` only, so `execute` is reachable offline nowhere else, and `execute`'s abort branch is reachable in **no shipping browser at all** (Chrome 151 passes no signal). Deferring the retrieval lane created three such states and `yarn test` found a real defect in each (see `build.ts` § EAGER_GZIP_LIMIT). A test that could have been an eval check belongs in `yarn eval`; do not re-grow a second behaviour harness here, which is the mess the deleted names below record. The `contracts` lane = contracts, not retrieval. `page/roles.ts` is the riskiest module; run `yarn eval --only roles` after touching it or `page/aria-taxonomy.ts` (hand-maintained; no spec-staleness gate). Name computation has no oracle. Drive `:5310` for projection, addressing, tools. Doc figures are historical unless the page names a live command; measure before adding a number.

## Commands

| Task | Command |
|---|---|
| Install / demo / preview | `yarn install` · `yarn dev` (`:5310`) · `yarn preview` (`:5311`) |
| Build / types | `yarn build` · `yarn typecheck` |
| Gates (offline, deterministic) | `yarn test`; vitest + jsdom; induced failure and timing (module namespaces, lane-load failure, rebuild coalescing) plus the WebMCP platform surface (wire round trip for all six tools, input gate, annotations, abort, instance handoff). Exits 1 on any failure. `yarn eval`; lanes `surface`, `roles`, `contracts`. Exits 1 on any failure. |
| Live sensors (network, not gates) | `yarn eval --live`; adds `invariants` (all six tools on one real MDN page: budget adherence, address round-trip, cursor integrity, bounded text, retrieval) `crawl` (locate a link from a natural-language intent, let the host click it, re-index the new document, answer from the destination), and `compare` (the same questions answered by `ariaSnapshot` alone, by SDK+host, and by the tools alone; one estimator charges every arm). |
| One lane / detail | `yarn eval --only roles` · `--only contracts` · `--only surface` · `--only invariants` · `--only crawl` · `--only compare` · `--verbose` |
| Platform API protocol | Chrome skill `scripts/cdp-checks/api-probe.mjs` |
| Two-agent research race (agent-visible cost vs a `fetch` loop, live dashboard) | `node eval/research/harness.mjs`; needs the Chrome skill's host first. Steps: [eval/README.md](./eval/README.md) |

## Refs

| Need | Path |
|---|---|
| Coding protocol (required) | [DEV.md](./DEV.md) |
| Mechanism | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Tools | [docs/TOOLS.md](./docs/TOOLS.md) |
| Sensors / numbers | [docs/EVAL.md](./docs/EVAL.md) · [docs/TESTING.md](./docs/TESTING.md) |
| Evidence / rejected ideas | [docs/EVIDENCE.md](./docs/EVIDENCE.md) |
| Platform APIs | [docs/TECHNOLOGY.md](./docs/TECHNOLOGY.md) |
| Historical ranking evidence | [docs/EVAL.md](./docs/EVAL.md) |
| Semantic Embedder API plan (unimplemented) | [docs/SEMANTIC-EMBEDDER.md](./docs/SEMANTIC-EMBEDDER.md) |
| API probe | `skills/naviquest-chrome-devtools/scripts/cdp-checks/api-probe.mjs` |
| How to run every eval, incl. the two-agent race | [eval/README.md](./eval/README.md) |
| Running naviquest in real Chrome (the runtime the race measures) | `skills/naviquest-chrome-devtools/SKILL.md` |

## Do not reverse

- **Six tools.** `read_region` → `resolve_address` region path (`resolveWith`, `expand: true`). `list_opaque_regions` → `describe_app({ opaque: true })`. Split only if modal dispatch loses to a second name.
- **One index, two consumers:** `document.modelContext` and the returned SDK object. No second page-side path.
- **Ranking:** KPI first, sweep DEV, verdict HELD-OUT. The historical sensor was deleted; rebuild one before changing the ranker. Never tune on the pages you measure.
- **Platform APIs:** probe with the Chrome skill (`scripts/cdp-checks/api-probe.mjs`), never memory. Verdicts: [docs/EVAL.md](./docs/EVAL.md), [docs/TECHNOLOGY.md](./docs/TECHNOLOGY.md).

## Conventions

1. Comments explain *why* and cite the measurement. Removing one is a regression.
2. Judgement (thresholds, caps, weights, lists, vendor selectors) lives in `config.ts`, overridable with `createNaviquest({ tuning })`. Spec facts stay in code. Unread overrides are worse than literals.
3. Array tunables accept a composer: `(base) => [...base, 'x']`.
4. Wire vocabulary is open. `Affordance` is `string`; `describe_app().vocabulary` declares the page.
5. Never be confidently wrong: declare degradation, name truncation, return `nearest` / `AMBIGUOUS`, put a `hint` on every failure.
6. No English-only tokenization; `Intl.Segmenter` in `retrieval/text.ts`, not `split(/\s+/)`.
7. One derivation, imported. Never duplicate a ranker or projector.
8. Tool `description` stays only if it changes agent behavior. Numbers belong in [docs/TOOLS.md](./docs/TOOLS.md) (`tools/tools.ts` is paid on `getTools()` and in the bundle).
9. Type-guard every tool input. `INVALID_INPUT` ≠ `NOT_FOUND`.
10. Host need not have done anything. Closed shadow roots: report the gap in `coverage`.

## Public API (breaking)

`createNaviquest` · `window.naviquest` (only documented global) · `::highlight(naviquest-hit)` · `data-naviquest-ignore` · six tool names / schemas / `Address`. No `window.__*` seams.

## Do not redo (without new evidence)

| Idea | Outcome |
|---|---|
| Weighted structural prior | Every config worse |
| Dense embeddings replacing lexical | Below BM25 at rank 1; fusion only |
| Invoker Commands as affordances | 0 elements / 8 sites |
| `CloseWatcher` for modality | Creates close behavior; does not detect it |
| `requestIdleCallback` in workers | `Window`-only |
| `Float16Array` for embeddings | Doubles memory (already int8) |
| WASM threads / `SharedArrayBuffer` | `COEP: require-corp` breaks host subresources |
| Navigation API as freshness source of truth | Misses first load and URL-less views |
| Inferring action tools from ARIA | WebMCP #91, `not planned` |
| Tightening answer coverage denominator | Misleading scores |
| Native-only accname (drop shim) | Keep shim. Its sensor was deleted in the 2026-09-02 eval merge; re-measure before revisiting |
| Indexing `opacity:0` content (scroll-reveal) | Historical DEV sweep of ten commercial sites: buys 1,478 chars of real content, costs 4,846 chars of hidden UI. No index-time discriminator; an opacity transition is declared by 96.8% of reveal vs 97.8% of hidden text. Declared in `coverage.revealPending` instead. |

Open (historical until re-measured): the eager gzip gate is **28.0 kB** in `build.ts` at a measured **27.86 kB** (ratcheted DOWN from 29.4 on 2026-09-03 by deferring the retrieval lane; the sync-or-promise helper moved to the `async.ts` leaf so `index.ts` stops importing `retrieval/lane.ts`, and was RENAMED `then` → `chain` because a module exporting `then` makes its own namespace thenable and `await import()` of it rejects with a native function, and `lane`/`bm25`/`lexical-index`/`ranking`/`exact` now load beside the answer engine: 26→22 eager modules, 1,556 gzip bytes reclaimed. Projection still runs synchronously at construction; only the index BUILD is deferred, and `loadTools()` gates on it. **The old note that "the `tools.ts` split is still unspent" was wrong; `tools/tools.ts` is already lazy and splitting it reclaims zero eager bytes**; measure the eager closure with a metafile partition before believing any claim about where the weight is. Structural tension that remains: `DEFAULTS` is eager, so every new tunable costs eager gzip) · confidence reads `low` on correct answers (calibration debt) · two structural ranking priors now ship, both declared index-time signals gated by `yarn eval --only rank`: `retrieval.chromePenalty` (demotes passages in nav/banner/contentinfo landmarks; 3→0 chrome-above-content inversions on the live LLM Wikipedia article) and `retrieval.imageAltPenalty` (demotes a passage by its recovered-non-text word fraction; image alt / chart text; flips the top result from the picture description to the answer); legal footnotes NOT in a chrome landmark still rank as prose · `opacity:0` reveal-pending content declared (`coverage.revealPending`) but not indexed · dense lane cannot rebuild (`packages/demo-app/public/model/` still loads) · `locate_control` weaker on large commercial pages · query intent vs vocabulary · iframes opaque to parent index. Detail: [docs/EVAL.md](./docs/EVAL.md).

## Ship

`yarn typecheck` · `yarn test` · `yarn eval` · `yarn build` (SDK `dist/` + demo `dist/demo/`) · `yarn eval --live` before shipping SDK changes (only sensor that drives `locate_control` and `query_selector` against a real page) · `yarn dev` and drive the demo for projection, segmentation, addressing, tools · `description` / `inputSchema` change → convention 8 · dropped capability → say so; do not leave a doc claiming it.
