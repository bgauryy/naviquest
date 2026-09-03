# Next phase: Chrome Semantic Embedder integration

> **Project phase:** planned next phase after the hackathon proof of concept.
> Nothing in this document is implemented yet.

Chrome's experimental **Semantic Embedder API** generates embeddings with a
browser-managed model. Naviquest's next phase is to test that model behind the
existing BM25 and Reciprocal Rank Fusion seam, without replacing the lexical
baseline or shipping model weights.

This is an implementation contract and adoption gate. Source presence is not
enough: the browser provider ships only if a real Chrome evaluation improves
retrieval without unacceptable query latency.

Related documents: [architecture](../ARCHITECTURE.md), [evaluation evidence](./EVAL.md),
and the [development protocol](../DEV.md).

---

## 1. Status; measured, not remembered

Live check: the Chrome skill's **`scripts/cdp-checks/api-probe.mjs`**, launched
with `AIEmbeddingsAPI,AIEmbeddingsAPIForWorkers`. Chrome 152, macOS,
`https://react.dev/learn`.

| Fact | Result |
|---|---|
| `window.SemanticEmbedder`, stock Chrome | **absent**; off by default |
| Chrome flag | `chrome://flags#semantic-embedder-api` |
| Derived Chromium features | `AIEmbeddingsAPI`, `AIEmbeddingsAPIForWorkers` |
| `window.SemanticEmbedder`, flagged | **present** |
| Static surface | `availability(options)`, `create(options)` |
| Instance surface | `embed(input, { taskType, signal })`, `destroy` |
| `availability()` | **`downloadable`**; model not present |
| **Dedicated worker exposure** | **`function`**; exposed off-thread |
| Task type | A per-`embed()` option, not a `create()` option |
| Result | `embeddings[].values` as `Float32Array`; no model metadata or token statistics |
| Permissions Policy | Temporarily reuses `language-model`; Chromium has a TODO for a dedicated policy |
| Listed on `developer.chrome.com/docs/ai/built-in` | **no**, as of Chrome 152 |

Feature names were **derived, not guessed**: a temporary user-data directory seeded with
`browser.enabled_labs_experiments: ['semantic-embedder-api@1']` was launched and
the switches Chrome produced were read off `chrome://version`. Guessing
(`SemanticEmbedderAPI`, `AISemanticEmbedder`, four others) gave an absent global.
Chromium contract: [`semantic_embedder.idl`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/ai/semantic_embedder.idl)
and [`semantic_embedder.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/ai/semantic_embedder.cc).
The separate [explainer](https://github.com/explainers-by-googlers/semantic-embedder-api)
states that the proposal has not been approved to ship.

### The load-bearing result

**Worker exposure**, gated by `AIEmbeddingsAPIForWorkers`, is the load-bearing
result. The Chrome 152 probe confirms `typeof SemanticEmbedder === 'function'`
in a dedicated worker. This lets `worker.ts` keep owning corpus embedding, so
the provider does not move the embed pass onto the main thread.

Chromium main also defines worker gates for Prompt, Summarizer, Translator, and
Language Detector. Those gates were not exposed in the tested Chrome 152 build,
so Naviquest must continue probing the runtime instead of assuming source-main
behavior.

---

## 2. Why this API and not the shipped table

| Cost today | Where it is measured | What the API does to it |
|---|---|---|
| 3.90 MB `potion-base-8M` download | Historical `index.ts` `warmDense` measurements | Browser-managed model, amortized by Chrome instead of shipped per site. The model assets are absent from the current checkout. |
| Cache API + Web Locks single-flight, `saveData` veto, and `decodeTable` | `worker.ts` `loadDense` | Retained for the table provider, but bypassed by the browser provider. |
| No query/document asymmetry | `dense.ts` § 3: "the input where I type a new todo" scores `Toggle Todo` 0.574, `What needs to be done?` 0.083 | `taskType: 'retrieval-query'` / `'retrieval-document'` is precisely that asymmetry; a static table can't express it. |
| Static-embedding ceiling | `dense.ts` § 1: fused hit@1 71%; dense alone 57–62% vs BM25 67% | A browser-managed model is a candidate improvement, but its quality remains unmeasured. |

---

## 3. Where it plugs in

A **provider behind the existing dense seam**, not a new lane. Everything
downstream is provider-agnostic:

```
createNaviquest({ worker: true, dense: true, denseProvider: 'browser' })
  → lane.dense(provider)  lane.ts
  → load provider         worker.ts
  → embed documents       embed({ taskType: 'retrieval-document' })
  → embed query           embed({ taskType: 'retrieval-query', signal })
  → fuse(lex, den)        existing rrf()
  → retrieval: 'hybrid'   existing response contract
```

Kept verbatim: **`topK()`** takes a `Float32Array` query against an int8 corpus; the shape `embed()` returns. **int8 quantization**; `dense.ts` § 2 measures cosine
against f32 at mean 0.999969 / worst 0.999924 over 544 real chunks, so storing the
raw `Float32Array` doubles memory for nothing. **RRF fusion, dense never
alone**; `dense.ts` § 3: Reciprocal Rank Fusion scores each document by
Σ 1/(k + rank) across the BM25 and dense rankings (k = 60) and re-sorts by the sum,
so neither list's top rank dominates; a stronger model is a reason to re-measure
the floor, not drop it.

One refactor splits browser inference from storage: an asynchronous batch embed
produces vectors, then a synchronous `quantizeCorpus(vectors)` builds the same
contiguous `Int8Array(n * dims)` consumed by `topK()`.

---

## 4. What genuinely changes

### One session, two task types

Chromium applies `taskType` on each `embed()` call. Naviquest therefore creates
one session and uses:

- `retrieval-document` for indexed passages and controls
- `retrieval-query` for incoming searches

Keeping both vector classes in one session is important because Chromium does
not expose an embedding-space identifier. Destroying or replacing the session
must discard all vectors derived from it.

### Query inference enters the critical path

Static Model2Vec query embedding is synchronous arithmetic. Browser embedding is
an asynchronous model call on every search. Each call uses an `AbortSignal`
timeout. A timeout, invalid result, or destroyed session returns the already
available lexical ranking and reports `retrieval: 'lexical'`.

### Rebuilds become asynchronous

The current worker can rebuild static vectors synchronously. Browser corpus
embedding can finish after a newer page projection arrives. Every build needs a
generation identity; only the newest generation can install vectors. While a
changed corpus is being embedded, its old dense matrix is cleared so the worker
cannot combine a new lexical index with stale vectors.

### Persistence is not safe yet

The explainer proposes `metadata.embeddingSpace`, but Chromium's IDL does not
expose it. Persisting vectors across sessions can combine different
model spaces after a browser update. This phase keeps vectors in memory and
scoped to one live session.

### Model download remains explicit

Creating a downloadable model can trigger a large browser-managed download.
Agent tool calls must not make that choice. The Chrome skill's `model-warm.mjs`
owns intentional download and activation; the SDK only uses a model that Chrome
reports as available.

### Configuration remains opt-in

One additive option selects the provider:

```ts
denseProvider: 'auto' | 'browser' | 'table' | 'off'
```

`dense: false` remains the default. Existing `dense: true` callers retain the
table provider unless they explicitly request `browser` or `auto`.
`warmDense(base)` continues to force the table path for compatibility.

---

## 5. Blockers

### RRF calibration

`tools.ts` records that `ambiguityRatio` was measured on BM25 scores and reads
near-always-ambiguous against RRF's ~1/61 scale (escape hatch: *"harmless while no
dense table ships in this repo"*). Making dense present removes the hatch:
`recommendedAddress` becomes null even when ranking improves. The implementation
must measure a hybrid-specific separation rule on a DEV split, freeze it, and
verify it on held-out queries. Confidence remains based on informative lexical
coverage, not cosine similarity.

### Experimental platform surface

Semantic Embedder is flag-gated and absent from Chrome's public built-in AI
list. Chromium reuses the `language-model` Permissions Policy and has
a TODO for a dedicated policy. The injection path can therefore be unavailable
on an otherwise supported browser and must degrade explicitly.

### Model execution is not proven

Chromium's browser test skips when the embedder model is unavailable. The
installed Chrome build must complete a real batch embedding before any SDK
integration begins.

---

## 6. Slices, in order

### Slice 0: prove the installed platform

- Launch a fresh isolated Chrome profile with
  `AIEmbeddingsAPI,AIEmbeddingsAPIForWorkers`.
- Keep `api-probe.mjs` download-free.
- Extend `model-warm.mjs` to intentionally warm `SemanticEmbedder`.
- Create one session, run query and document task types, validate batch
  cardinality, finite equal-sized vectors, abort, and cleanup.
- Stop if the constructor, model, worker exposure, or real embedding fails.

### Slice 1: add provider-independent vector storage

- Extract normalization and int8 quantization in `retrieval/dense.ts`.
- Accept browser-produced `Float32Array` vectors.
- Reject empty, non-finite, ragged, or dimension-mismatched vectors.
- Keep `topK()` and RRF unchanged.

### Slice 2: implement the worker provider

- Add `ai/semantic-embedder.ts` with narrow local types matching Chromium IDL.
- Create one session and use per-call retrieval task types.
- Add abortable query and corpus embedding.
- Keep vectors session-local and destroy them with the session.
- Guard every asynchronous corpus install with a build generation.
- Return lexical results while the browser provider is absent, loading, stale,
  timed out, or invalid.

### Slice 3: expose explicit configuration

- Add `denseProvider` without changing the default.
- Preserve `dense`, `denseBase`, and `warmDense(base)` behavior.
- Add `?dense=browser` to the demo while preserving `?dense=1` for the table
  provider.

### Slice 4: measure before adoption

Add an explicit `embedding` lane to the existing eval command:

```bash
yarn eval --only embedding
```

The lane runs only when explicitly selected, so ordinary gates never trigger a
model download. It compares BM25 and browser-hybrid ranking on frozen DEV and
held-out paraphrase sets and reports:

- Hit@1 and hit@3
- Literal-query regressions
- Corpus embedding time
- Query latency distribution
- Timeout and lexical-fallback count
- Vector dimensions and batch cardinality
- Address round-trip and hybrid ambiguity behavior

Tune any hybrid rank-separation rule on DEV only, then run held-out once.

### Slice 5: ship or stop

Ship the browser provider only when:

- Held-out hit@1 improves, or hit@3 improves without reducing hit@1.
- Literal hit@1 and address round-trip do not regress.
- Query embedding stays within the measured tool budget or falls back without
  hanging.
- Every absent, cold, malformed, timed-out, stale, and disposed state remains
  explicit.

If the gate fails, keep the platform measurement and do not land speculative
runtime integration.

---

## 7. Other Chromium AI opportunities

Chromium source exposes more AI surfaces than Naviquest can justify adopting.

### High-value follow-up

The Summarizer API exposes `measureInputUsage()` and `inputQuota`. Naviquest
discovers oversized input by attempting a summary and catching a
quota failure. After the embedding phase, probe quota measurement and use it to
avoid a failed model call before chunking.

### Measure before moving

Chromium main exposes Prompt, Summarizer, Translator, and Language Detector to
workers behind separate feature gates. The tested Chrome 152 runtime did not.
Extend the capability probe first. Move translation or summarization into the
worker only if the installed runtime supports it and measurement shows a
main-thread benefit.

Prompt accepts audio inputs as well as images. Audio description can improve
coverage of opaque media, but it needs a separate privacy, grounding, and token
evaluation.

### Already used correctly

Naviquest already uses Prompt API response constraints, cancellation signals,
and clone-per-turn isolation. Add `measureContextUsage()` only if a real
sensor finds context overflow; unconditional preflight adds latency to
already bounded prompts.

### Not a fit for core retrieval

- Writer and Rewriter generate text that is not page evidence.
- Proofreader can alter a query's meaning.
- Prompt tool use duplicates the external agent's router and introduces
  recursive tool calls.

These APIs do not improve the grounded retrieval contract enough to justify
their latency and failure modes.

## 8. Rejected

| Alternative | Why not |
|---|---|
| Replace the lexical lane with the browser embedder | `dense.ts` § 3. A better model is a reason to re-measure fusion, not remove the zero-download floor. |
| Store the raw `Float32Array` | `dense.ts` measures int8 cosine fidelity at 0.999969 mean. Raw floats double corpus memory without a measured ranking gain. |
| Call `create()` in `api-probe.mjs` | With availability `downloadable`, creating is a download; a capability probe must not spend a user's bytes. The model-warm check owns intentional downloads. |
| Persist browser vectors now | Chromium IDL exposes no embedding-space identifier. A model update can make cached vectors incompatible with new queries. |
| Delete the table provider once the browser one works | The API is flag-gated and Chrome-only. The table remains the cross-browser dense path. |
| Guess the Chromium feature names | Six spellings tried, all wrong, all indistinguishable from "not implemented". Derive from `chrome://version`. |

---

## 9. Verification

- `yarn typecheck`
- `yarn test` for induced timeout, malformed vectors, stale completion,
  concurrent creation, and disposal
- `yarn eval --only embedding` for the real browser API and retrieval KPI
- `yarn eval` for deterministic browser behavior
- `yarn build` for declarations, worker output, and eager gzip
- `yarn eval --live` after the embedding gate passes

## 10. Reversal conditions

Re-run the Chrome skill's `api-probe.mjs` with both embedding feature flags
before implementation. Stop if the API is withdrawn, renamed, loses worker
exposure, or cannot execute on the installed model. Revisit persistence only
after Chromium exposes a stable embedding-space identifier.
