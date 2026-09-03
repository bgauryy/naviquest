# TOOLS; six tools, two routed modes, and how an agent uses them

> **Figures here are historical.** The harness that produced them was removed from this repo; they cannot be reproduced or refuted here. See [AGENTS.md](../AGENTS.md).

Naviquest never clicks, types or submits. It tells an agent *where things are and what state they are in*; the agent acts through its own harness. The one optional page effect is `resolve_address({ scrollIntoView: true })`, which moves the viewport before returning a fresh box. Naviquest never owns trusted input. See [ARCHITECTURE.md](../ARCHITECTURE.md).

Five tools register `readOnlyHint: true`; `resolve_address` registers `false` because its opt-in scroll changes viewport state. All six set `untrustedContentHint: true`; page text is the Output Injection surface the WebMCP spec describes, and the hint is its mitigation.

All six are callable as plain JavaScript; `wf.tools.find_on_page({…})`; whether or not WebMCP exists. The demo panel drives the same functions when `document.modelContext` is absent (the default in stock Chrome).

Five tools answer about **this document**. The sixth, `agentic_content`, answers about **this origin**; the "am I on the right page?" tool, and the only one that touches the network.

Every response carries one cross-tool `outcome`: `success`, `degraded`, `ambiguous`, `not_found`, or `error`. Generic orchestration branches on that without translating each tool's status vocabulary; existing `status`, `answerStatus`, and `error` fields still carry tool-specific recovery detail.

Every input can include a non-empty one-line `reason`. If the host configures `createNaviquest({ onIntent })`, the shared wrapper sends it the tool name and reason after validation. Naviquest doesn't index or return it, and a throwing host callback doesn't break the call. The reason is untrusted agent input; render as text, never HTML.

---

## The loop

```
        ┌──────────────────────────────────────────────────┐
        │                                                  │
        ▼                                                  │
   agentic_content(list)   "Am I even on the right page?"    │
        │                   (site level; skip if you are)     │
        ▼                                                  │
   describe_app()          "Where am I? What is here?"      │
        │                                                  │
        ▼                                                  │
   find_on_page(query)     "What does this page SAY         │
        │                   about the thing I was asked?"   │
        ▼                                                  │
   locate_control(desc)    "Which control DOES it?"         │
        │                                                  │
        ▼                                                  │
   resolve_address(addr)   "Can I act on it right now?"     │
        │                                                  │
        ▼                                                  │
   [agent clicks via its own harness]                       │
        │                                                  │
        └──── describe_app({ changesSince: _observation }) ─┘
                 semantic outcome of the action
```

Two modes off that loop, plus one escape hatch:

- **`resolve_address({ address, expand: true })`**; a `find_on_page` passage was the right region but too short. Region addresses take this path automatically; `expand` forces it for a control address.
- **`describe_app({ opaque: true })`**; the answer is in a chart or image the text index cannot read. Get boxes to screenshot.
- **`query_selector({ view: "actions" | "structure" | "scopes" | "forms" })`**; queryless semantic inspection: bounded, addressable answers to "what can I do?" and "what can I see?", plus the DOM scopes exact CSS can enter. `selector` is the guarded exact-CSS escape hatch when already known.

---

## Why six, and why these six

Four core page operations form an orient → retrieve → ground → verify loop; `query_selector` exposes bounded semantic inventories or prior CSS knowledge; `agentic_content` adds site scope.

| Tool | Why the agent needs it | Why another tool cannot replace it |
|---|---|---|
| `describe_app` | Establish page identity, structure, modality, vocabulary, and declared blind spots before choosing a path. | Search ranks matching text but cannot prove which views, dialogs, landmarks, or opaque regions exist. |
| `find_on_page` | Retrieve page-authored evidence and return a region address without sending the whole document. | Control lookup answers what performs an action; it cannot establish what the page says. |
| `locate_control` | Translate an open-ended job ("update my address") into live control candidates, confidence, and refinements. | Content search finds prose near a control but cannot safely claim the control performs the job. |
| `resolve_address` | Revalidate one copied address against current state, geometry, and browser-resolved navigation immediately before action; its region path also recovers complete section text. | Ranked candidates are observations from an earlier instant. Reusing an old box or DOM identity makes rerenders and state changes look safe. |
| `query_selector` | Inspect a bounded semantic inventory, readable scopes, or exact CSS the caller already knows. | NL rankers answer relevance; they cannot provide exact inspection or document-order inventory semantics. |
| `agentic_content` | Discover, verify, and read resources across the current origin, including the live page-link fallback. | The other five index the current document. They cannot determine the answer lives on another page. |

Keeping these separate prevents one generic search tool from mixing page scope with site scope, evidence with actionability, or ranked candidates with live verification.

| Survey or inventory; many things, bounded | Expand; one thing, in full |
|---|---|
| `find_on_page`; which regions talk about X | `resolve_address` (region path); all of that region, siblings merged |
| `locate_control`; which controls might do X | `resolve_address`; can I act on *this* one, right now |
| `describe_app().nonText`; how many holes exist | `describe_app({ opaque: true })`; where they are, with boxes |
| `agentic_content` `list`/`find`; which PAGE of this site | `agentic_content` `read`; that document's text |
| `query_selector` semantic views; document-order actions/regions | *(follow `pagination.next`; no expansion semantics)* |
| `describe_app`; the whole page, structurally | *(it is the top of the tree)* |

Every surface is bounded. If a response omits a list suffix, it returns a revision-bound `pagination.next` call recovering the first omitted row. NL survey tools are ranked; semantic inventories and manifest lists preserve document/author order. Expansion consumes an address for page regions and controls; `agentic_content({ intent: "read" })` consumes a URL the same tool previously vouched for; distinct authorities.

**None of the six is redundant.** The `resolve_address` region path is not `find_on_page` with a bigger limit; it merges sibling chunks under one heading path, giving *the section* rather than the chunk that ranked. `resolve_address` is not `locate_control` again; locate ranks by description, resolve re-verifies one address against the live DOM. `describe_app` opaque mode is ~10× the cost of its counts, so it is opt-in. `agentic_content` answers about pages the agent is *not* on, which indexing the current DOM cannot reach.

**What was deliberately left out:**

- **No action tools.** Naviquest never clicks, types or submits. Inferring tool identity from ARIA was WebMCP issue #91, closed `not planned`; pages *using* ARIA also average more defects than pages with none, disqualifying it as ground truth. You declare your action tools; Naviquest only reads.
- **No `get_*` tool per field.** That is the polling pattern issue #151 describes as the problem. `since` + `_etag` replaces it.
- **No fake in-page screenshot or OCR tool.** Page JS has no permissionless API that captures browser pixels; canvas reconstruction cannot faithfully capture cross-origin images, native controls, compositing, video, closed shadow DOM, or browser chrome. Opaque mode returns a viewport box and a reason; the browser/agent vision tool captures it. WebMCP can transport a browser-owned image result, but the SDK must not pretend DOM serialization is a screenshot.

### It is not rigid, and that was fixed deliberately

An earlier version sealed its vocabulary at compile time; an `Affordance` union of exactly ten strings no host could extend. Since WebMCP has no schema negotiation (`inputSchema` is a semantic hint, issue #92), an agent could only hardcode our enum. Three live fixes:

1. **`Affordance` is an open type** (`types.ts`), not a union.
2. **Hosts extend it without forking**; `tuning.affordance.patterns` and `tuning.affordance.terms` add an affordance and the words that retrieve it. Any tunable in `config.ts` is overridable at any depth.
3. **`describe_app().vocabulary` declares what *this page* speaks**, split into `authored` (page said so) vs `inferred` (guessed from a label). An unknown affordance becomes information, not a parse failure.

The same principle runs through the response shapes: `retrieval` names the lane that answered, `affordanceSource` names where a label came from, `confidence` names how much of the query matched, `coverage` names what could not be seen. **An agent is never asked to trust a value whose provenance it cannot read.**

---

## 1. `describe_app({ since?, changesSince?, section?, opaque?, describe?, limit?, offset?, revision?, summarize? })`

**Call this first.** Bounded by page *structure*, not *length*, so it stays cheap at any size.

| Field | What it tells the agent |
|---|---|
| `view` | `{ title, path, heading }`; heading read from the projection, not `querySelector('h1')`, so an excluded block cannot leak in |
| `landmarks`, `outline` | The structural map. Each readable outline row carries a region `address` and `readWith: "resolve_address"`; an unaddressable heading says so. Nesting comes from document order and DOM containment, **never** heading level numbers; 41.8% of pages skip levels |
| `currentTrail` | The `aria-current` trail: where the page thinks you are |
| `reachableViews` | Where you can go from here |
| `counts` | `{ chunks, controls }`; the size of the index behind the other tools |
| `nonText` | How many images/charts carry meaning, how many recoverable, how many opaque |
| `coverage` | Selected-root share of document elements, frames outside that root, open/unknown/registered component roots, evidence-backed opaque hosts; **what could not be seen**, reported not hidden |
| `structuralQuality` | `good` / `mixed` / `low`; how much real structure retrieval had to work with |
| `vocabulary` | The affordance terms *this page* speaks, split `authored` vs `inferred` |
| `authored` | **Optional first-party overlay.** Present only when the embedder passed `createNaviquest({ orientation })`. Omit that option (the default, including inject-into-any-site) and this key is absent; the agent still orients from `view`/outline/`locate_control`. Provenance-tagged; does not replace live structure. `tasks[].locate` is a CSS selector (same grammar as `exclude[]`); copy into `query_selector({ selector })`, never `locate_control`. Included in `_etag`/`since`, not in `changesSince` |
| modal state | Whether a dialog is open, and therefore whether everything behind it is inert |
| `recommendation` | Present **only** when the page is small enough that the whole a11y tree is cheaper than these tools |
| `orientationTotals`, `pagination.next` | Complete sizes and one next call per independently paged orientation list |
| `_observation` | Cursor for a later bounded semantic comparison |

On a canvas app the entire a11y tree is a few hundred tokens and three tool calls cost more than sending it; measured at 103% on Excalidraw. Rather than lose that comparison, `describe_app` says so and tells the agent to ask for the tree instead.

### The `since` parameter; why this tool is cheap in a loop

Pass back the `_etag` from your previous call:

```js
const a = await describe_app();                    // ~900 tokens
const b = await describe_app({ since: a._etag });   // ~8 tokens if nothing moved
```

Across five live sites, between two agent steps **100% of a re-issued `describe_app` payload was byte-identical.** An agent that re-observes every step pays full price for zero information; over a five-step loop, `since` removes **78.8%** of re-observation cost. This answers [WebMCP issue #151](https://github.com/webmachinelearning/webmcp/issues/151) with ETag semantics.

### The `changesSince` parameter; what changed semantically

Copy `_observation` from an ordinary response, then pass it back:

```js
const before = await describe_app();
// The browser companion performs an action.
const after = await describe_app({ changesSince: before._observation });
```

Reports bounded changes to views, dialogs, control identity, state, actionability, focus, regions, and coverage. It samples the current projection, so it detects property-only state changes with no DOM mutation. The interval does not prove causation. An expired cursor returns `STALE_OBSERVATION` with a fresh cursor and a recovery hint.

Semantic snapshots hold compact identities, states, bounded addresses, and hashes; not form values, DOM nodes, or excluded private text. Configure bounded history and response cap via `tuning.delta.semanticHistory` and `tuning.delta.maxSemanticChanges`. Don't combine `changesSince` with pagination, opaque mode, a section request, or ETag `since`.

---

## 2. `find_on_page({ query, goal?, limit?, offset?, revision?, since?, summarize? })`

Ranked content regions, each carrying the controls that belong to it.

```jsonc
{
  "answer": {                     // omitted unless a sentence clears the floor
    "text": "A single occupant discount of 25 percent applies…",
    "source": "passage",          // or "schema.org/FAQPage", quoted verbatim
    "address": { /* re-queryable */ },
    "spanElement": 1
  },
  "results": [{
    "kind": "passage",          // or "section" for an outline heading
    "text": "…",
    "match": "exact",           // exact authored occurrence; otherwise "ranked"
    "excerptStart": 812,
    "score": 4.2,
    "queryCoverage": 1,
    "chunkStrategy": "heading",   // or "containment" / fixed-window fallback
    "address": { "landmark": "main", "headingPath": ["Council tax", "Discounts"],
                 "role": "region", "ordinal": 0 },
    "actionable": [{ "role": "button", "name": "Apply for a discount",
                     "kind": "action",        // vs "nav"; nav leaves the passage
                     "affordances": ["submit"],
                     "affordanceSource": { "submit": "type=submit" },
                     "address": { /* … */ } }]
  }],
  "matched": 7,
  "offset": 0,
  "truncated": 0,
  "status": "SUPPORTED",
  "answerStatus": "supported",    // unsupported => passages are evidence only
  "evidenceOnly": false,
  "queryCoverage": 1,
  "recommendedAddress": { /* address of the supported result */ },
  "confidence": "high",
  "confidenceBasis": "query coverage and answer support; not correctness probability",
  "nextCalls": [],                // typed recovery calls; legacy `next` also remains
  "retrieval": "lexical",         // or "hybrid" once the dense lane warms
  "_etag": "1kx9f2", "_version": 3,
  "_tokens": 466, "_budget": 1200
}
```

- **`kind` prevents section blindness.** Outline headings participate in the same lexical corpus as passages; a `section` result is addressable and resolvable directly, not a post-ranking guess. Parent headings stay discoverable even when matching words aren't repeated in child prose.
- **Decision fields are machine-routable.** `status`, `recommendedAddress`, `confidenceBasis`, and `nextCalls` let a client continue from evidence without reading prose or grader labels. `goal: "navigate"` adds a `locate_control` next call. `goal` is an open string so the SDK doesn't freeze every agent's vocabulary.
- **`answerStatus` fails closed.** `supported` = `answer` cleared the gate. `unsupported` = related passages found but none supports an answer (evidence only; `hint` + `next` route to the addressable outline). `no-match` = no passage found. Never treat an absent `answer` as permission to report rank 1.
- **`answer.verified` and `answer.unverified` are not opposites.** `verified: true` means an on-device model was asked whether the sentence answers the question and said yes. `unverified: "NO_ON_DEVICE_READER"` means the check never ran (no Prompt API, model not downloaded, no user gesture, cold session); so the answer is lexical extraction only. Both absent is not a third state: exactly one appears whenever `answer.source` is `passage`. A rejected sentence never reaches the caller, so there is no `verified: false`. `confidence` already reads `low` in the unverified case.
- **`answer` is one answer, not one per result.** A single clearly-sourced, addressable answer costs ~100 tokens; a span per result would fight the budget. When nothing clears the floor the field is absent and the preceding status explains why. `queryCoverage` reports informative-term occurrence in the top passage and heading path; not a correctness probability.
- **`actionable.kind` separates `nav` from `action`.** Navigation leaves the passage; an action operates on it. An agent that can't tell them apart wanders.
- **`retrieval` says which lane answered**; distinguishing "no match" from "embedding table not finished downloading". Reported by the lane, so it can't claim `hybrid` before the table lands.
- **`match` says why this excerpt is shown.** `exact` = case/diacritic-folded literal occurs in the authored chunk, so a long excerpt is centred on it. `ranked` = BM25/hybrid retrieved without a literal occurrence. Exact never promotes a ranked hit; a punctuation-only literal BM25 can't represent is appended after all ranked hits with score zero, recovering identifiers while preserving relevance order.
- **Repeated chunks from one headed region are coalesced exactly.** Resolving any chunk under one heading reads the same merged region, so `find_on_page` keeps the highest-ranked row and reports `coalesced` instead of paying repeatedly. Pathless chunks are never grouped by fuzzy text. Live probes 2026-09-01: est. result-token reductions of 13.8% (React), 16.0% (CNN), 26.2% (Wikipedia); MDN a no-op. Rank 1 and answer extraction unchanged.

Call the returned `pagination.next` entry to read lower-ranked regions; its arguments contain the query, limit, offset, and projection revision. A page change returns `STALE_CURSOR` rather than shifting the offset onto a different region. `since` works too, keyed on the exact query page.

---

## 3. `locate_control({ description, limit?, offset?, revision?, role?, affordance?, landmark? })`

Ask in words; get a real, addressable, currently-enabled control; or an explicit ambiguity. Never an invented `#submit-btn`.

```js
locate_control({ description: 'the button that submits the return request' })
```

```jsonc
{
  "candidates": [{
    "role": "button", "name": "Start a return",
    "row": "Order #4471; wireless keyboard",   // present inside a list/table row
    "affordances": ["submit"],
    "affordanceSource": { "submit": "type=submit" },  // the SIGNAL per affordance:
                                               // markup-declared (rel=next, type=submit,
                                               // aria-controls, hreflang, command) vs
                                               // guessed (name-pattern, sole-field)
    "state": { "disabled": false, "inert": false },
    "headingPath": ["Shipping & Returns", "Returns"],
    "address": { /* re-queryable */ },
    "score": 4.81,
    "queryCoverage": 1,
    "confidence": "high"
  }],
  "ambiguous": false,
  "recommended": 0,
  "confidenceBasis": "informative query-term coverage; not correctness probability",
  "offset": 0,
  "truncated": 0,
  "retrieval": "lexical"
}
```

`recommended: 0` appears only when rank evidence agrees and the first candidate has high term coverage; otherwise `null` with a recovery hint. Ambiguity includes close BM25 scores, a lower candidate with stronger term coverage, or a lower exact-name match; rank 1 alone is never authority.

When ambiguous, `refineBy` lists only discriminators present in that candidate set: roles, affordances, landmarks, or copied candidate names. Feed one back through the filter. This is recovery guidance, not a ranking boost, and is omitted when unambiguous.

### Narrowing: filters remove, they never reorder

```js
locate_control({ description: 'go to the next page', affordance: 'pagination-next' })
locate_control({ description: 'where I type',        role: 'textbox' })
locate_control({ description: 'the account menu',    landmark: 'navigation' })
```

`affordance` is the useful one: it names **the job, not the wording**. No similarity measure recovers that a control named `More` paginates, or that `What needs to be done?` is a page's primary input; that's in the markup, and cheap to read.

Available affordances: `pagination-next`, `pagination-prev`, `search`, `submit`, `language-switcher`, `primary-input`, `add-to-cart`, `toggle`, `destructive`, `external`. The set a *given page* speaks is reported by `describe_app().vocabulary`, so a host can add one without an SDK release.

A weighted structural prior (boosting `main` over `banner`, picker roles for "choose/select") was tried and **made every configuration worse** (VALIDATION § 8.3). Ranking is left alone; filters only remove candidates already ruled out.

Call the returned `pagination.next` entry for lower-ranked candidates. Pagination ranks the complete filtered population before slicing, preserves every filter, and fails with `STALE_CURSOR` if the projection changes.

### When nothing matches

An empty list with no explanation can't distinguish "no such control" from "your wording missed". So:

```jsonc
{
  "candidates": [],
  "nearest": [{ "role": "link", "name": "Log in", "similarity": 0.62,
                "confidence": "low", "address": { /* … */ } }],
  "note": "No control matched your description lexically. These are the closest
           names on the page by character similarity; verify before acting."
}
```

### The guardrail that matters more than the hit rate

`confidence` answers *how much of what you asked for this control actually contains*; not rank position. On the Apple configurator, "choose 16GB of unified memory" once returned a lone `link "Terms of Use"` matching one term in six, with nothing to flag the guess. **A confidently-wrong control fails a trajectory exactly like an invented selector.** Measured: **zero high-confidence misses** across both evaluation sets. The tradeoff is conservative confidence; many correct answers come back `low`. Safe in the direction that matters.

---

## 4. `resolve_address({ address, scrollIntoView?, summarize? })`

**The act seam.** `wf.resolve(address)` hands a live `Element` to page JS, but an MCP client cannot hold one. This returns what an outside click tool can use.

```jsonc
{
  "status": "RESOLVED",
  "role": "button", "name": "Start a return",
  "state": { "disabled": false, "inert": false },
  "box": { "x": 412, "y": 980, "w": 148, "h": 44 },
  "inViewport": false,
  "selectorOfLastResort": "main > section:nth-of-type(3) > button",
  "selectorWarning": "Generated now, never stored. Prefer the address;
                      this selector breaks on re-render."
}
```

For a resolved native `a` or `area`, `navigation` contains the browser-resolved current `href`, `sameOrigin`, `target`, `rel`, and `download`. This is derived from the live element at answer time, not the indexed identity, so an `href` change is visible without rebuilding the index. The field describes navigation; the browser companion performs it.

Non-resolving addresses degrade informatively, never silently:

| `status` | Means | Carries |
|---|---|---|
| `RESOLVED` | One element, unambiguously | the box, live state, viewport flag |
| `AMBIGUOUS` | The address now matches several | `candidates`; pick one and re-address |
| `NOT_FOUND` | Nothing matches | `nearest`; the closest addresses on the page |

It **never returns the wrong element**; the whole design. Playwright's `ref=e5` is a JS expando React reconciliation silently kills, and `chrome-devtools-mcp`'s `uid` renumbers on every snapshot; both resolve to the *wrong* node, the worst failure for an agent about to click.

`relaxed: true` appears when the address matched only after relaxing the ordinal; it comes with a `note`, and the relaxation rule refuses to cross a landmark boundary. If a modal is open, an inert control says so rather than letting the agent click into the void.

---

## 5. The region path; `resolve_address({ address, expand?, summarize? })`

*Formerly `read_region`; merged 2026-08-31. A region address (`resolveWith: "read_region"`) takes this path automatically; `expand: true` forces it for any heading-path address.*

A `find_on_page` passage was the right region but got trimmed. Expand it.

```jsonc
{
  "headingPath": ["Council tax", "Discounts"],
  "landmark": "main",
  "text": "…the full section, sibling chunks auto-merged…",
  "controls": [{ "role": "link", "name": "Apply", "state": {}, "address": {} }],
  "merged": 3
}
```

Sibling chunks under the same heading path are merged automatically, so you get *the section* rather than the chunk that ranked. Two flags:

- **`collapsed` + `revealedBy`**; part of the region is inside a closed `<details>` or collapsed disclosure. The text is included, but nothing inside can be activated until that control opens; `revealedBy` names it.
- **`truncated` + `pagination.next`**; text or controls hit the budget. The next call advances both `textOffset` and `controlOffset`, so repeated calls reconstruct the complete region without repeating either stream.

---

## 6. Opaque mode; `describe_app({ opaque: true, describe?, limit?, offset?, revision? })`

*Formerly `list_opaque_regions`; merged 2026-08-31. Same payload, same separate ceiling, one fewer name in `getTools()`.*

What is on this page that the **text index could not read**; and where to look.

```jsonc
{
  "regions": [{
    "tag": "canvas", "role": "img",
    "reason": "NO_ACCESSIBLE_NAME",
    "chartLibrary": "chart.js",
    "headingPath": ["Energy use"], "nearestHeading": "Energy use",
    "box": { "x": 88, "y": 1240, "w": 640, "h": 320 },
    "filenameHint": "annual-consumption",
    "rejected": [{ "text": "chart", "reason": "TOO_GENERIC" }]
  }],
  "total": 43,
  "truncated": 33,
  "pagination": { "complete": false, "next": [{ "tool": "describe_app", "arguments": { "opaque": true, "limit": 10, "offset": 10, "revision": 7 } }] },
  "note": "These carry meaning the text index cannot read. filenameHint is a
           low-confidence guess, never author-written text."
}
```

**By default it never guesses what a graphic depicts.** It says *where it is* so a vision-capable agent can screenshot exactly that box, and *why* the text layer couldn't read it. `rejected` shows the name candidates considered and thrown out.

**Opt in to read the pixels on-device:** `describe_app({ opaque: true, describe: true })` reads each opaque region with Chrome's **multimodal Prompt API** (`ai/image-describer.ts`) and returns a short description of the chart/image. It is **fail-open** (no model → box-only), Window-only, download-gated on a user gesture, and opt-in per call. The projection retains every locatable opaque region; the tool pages the viewport-prominence ordering instead of capping it.

Lesson: it once reported **499 opaque regions on Wikipedia** because image-alt quality rules (`NUMERIC_ONLY`) were applied to *control names*, declaring citation links `[1]`, `[2]` unreadable. Control names now have their own quality rules; only an actionable control counts as a hole. Wikipedia now reports 43. Cross-checked against axe-core's `link-name`/`button-name`: **precision 1.00, recall 1.00**.

---

## 7. `query_selector({ view? | selector?, … })`

One exact-inspection surface with two authorities. Pass exactly one:

- `view: "actions"`; **what can I do?** from the privacy-filtered actionable-control projection. Rows carry role, name, context, live state, affordances, governed-region context, address. The bounded action side of the ARIA graph.
- `view: "structure"`; **what can I see?** from the segmented visible content model. Rows carry heading path, landmark, chunk strategy, size, region address. The bounded content side of the same graph.
- `view: "scopes"`; **where can exact inspection run?** Pages every readable `Document` and open/registered `ShadowRoot`, plus explicit rows for iframe documents the parent can't enter. Scope paths are traversal provenance, not durable addresses.
- `view: "forms"`; each form as one fill unit: field counts, required, filled, invalid counts, plus its submit control.
- `selector`; bounded, tree-scoped `querySelectorAll` for CSS already known by a first-party integration or debugging agent. It searches the document and each reachable/registered shadow root separately, recursively following readable frames (including frames inside shadow roots and nested frames) by default. `frames: false` is the explicit cost opt-out. A last resort; a guessed selector carries no semantics and breaks on re-render. If a first-party host opted into `orientation`, `describe_app().authored.tasks[].locate` is known CSS; copy it here. Injected sessions have no `authored` key and still use `locate_control`.

Semantic views are document-order inventories, not relevance ranking. Use `locate_control` to rank controls by a job and `find_on_page` to rank content by a question. `role`, `affordance`, `landmark`, exact `name`, and exact `heading` are removal-only filters. Pass `name`/`heading` only by copying authored text from a previous result; they are deterministic recovery, not guessed labels.

```js
query_selector({ view: 'actions', role: ['button', 'textbox'], limit: 10 })
query_selector({ view: 'actions', name: 'Join hackathon' })
query_selector({ view: 'structure', landmark: 'main', limit: 10 })
query_selector({ view: 'structure', heading: 'Judging Criteria' })
query_selector({ view: 'scopes', limit: 10 })
query_selector({ view: 'forms', limit: 10 })
```

Semantic views return `matched`, `returned`, `truncated`, projection `coverage`, and a copyable `pagination.next`. Structure coalesces chunks that resolve to the same region, so every row has a distinct re-readable address. Next-call arguments include the projection `revision`; after a re-render the tool returns `STALE_CURSOR` rather than shifting an offset onto different elements. They preserve page size and every filter.

Exact mode reports `documentsSearched`, `shadowTreesSearched`, registered-root coverage, and a `scope` path on every default result. Standard CSS has no shadow-piercing combinator, so a resolved shadow control returns no document selector; its address, box, and page-side `resolve(address)` remain valid. Boxes from the top document declare `boxSpace: "top-level-viewport"`; boxes inside a readable frame declare `boxSpace: "scope-viewport"` (the owning frame document's viewport, not a guessed top-page translation). Use a frame-scoped browser companion for pixel actions; do not sum nested frame offsets from this payload. Exact-mode next calls retain a bounded snapshot of the complete ordered scope/element identities (the selector can reach outside the observed projection and into frames). Every identity is compared exactly: a changed population returns `STALE_CURSOR`, an evicted abandoned cursor returns `CURSOR_EXPIRED`. Both fail closed.

Live action state is re-read at answer time. Beyond ARIA state it reports native `required`, `readOnly`, focus, validity, and `valuePresent`. The last is deliberately boolean: it lets an agent continue a form without exposing a password or resident-entered value through a read-only sensor.

### Exact CSS mode

```js
query_selector({ selector: 'form input[required]', limit: 5 })
query_selector({ selector: '#claim-address', fields: ['address', 'box'] })
query_selector({ selector: 'input' }) // readable nested frames are included
query_selector({ selector: 'input', frames: false }) // current document/shadows only
```

```jsonc
{
  "selector": "form input[type=\"checkbox\"]",
  "matched": 3, "returned": 3,
  "results": [{
    "tag": "input", "role": "checkbox", "name": "Proof of ownership",
    "state": { "checked": false, "disabled": false }, "scope": "document",
    "address": { /* re-queryable; act through this, not the selector */ }
  }]
}
```

`fields` defaults to `tag, role, name, state, address, scope`. **`text` is opt-in**, each row's text capped at **1200 characters** (`retrieval.selectorTextChars`). Rows are this tool's only pagination unit and its shrinker floors at one row, so an uncapped row could not be shrunk: a large element returned the whole thing and merely flagged `_overBudget`; measured at 9,799 chars / 2,611 tokens against the 1,200-token ceiling. A clipped row declares itself and names the tool that owns paginated full text:

```jsonc
{ "text": "Refund clause sentence…", "textChars": 9799, "textIsExcerpt": true,
  "readFullTextWith": "resolve_address" }
```

When a match is real but **not addressable** (outside the indexed root, or skipped by the projection), the row carries `selectorOfLastResort` alongside its `addressNote`. Its own query may have matched forty elements, so the row supplies one selector isolating *this* match. Same caveat as `resolve_address`: generated fresh, never stored, never an identity.

### It cannot bypass the host's exclusion; the whole safety argument

Other tools get exclusion free: the projection walk doesn't descend into an excluded subtree, so excluded text never exists to return. This tool has no walk, so it filters explicitly; through `excludedDeep`, **the same function the walk uses**, not a second copy.

Matches inside an `exclude` selector, `[data-naviquest-ignore]`, or `aria-hidden="true"` are dropped, **and the count is declared**:

```jsonc
{ "matched": 0, "excludedByHost": 2,
  "note": "2 match(es) were inside a region this site excludes from agent access and are not returned." }
```

`matched: 0` alone reads as *"no such element"* when the truth is *"it exists and this site withholds it"*. Verified adversarially: a direct selector for the excluded block, its descendants, a nested path, and a 400-element `*` wildcard sweep all refuse; the wildcard reports 293 matched with 7 withheld rather than laundering the text out.

### `fields`; pay only for what you will read

Any subset of `tag`, `role`, `name`, `text`, `state`, `box`, `address`, `attributes`, `scope`, `frame`. Default `tag, role, name, state, address, scope` omits text because an exact selector can match an element with arbitrarily large descendants. If you request `text`, the tool returns the complete redacted value and can set `_overBudget` for one indivisible row; it never clips that field. Ask for `["address"]` alone when you only need something to act on. An all-invalid `fields` is rejected, not silently ignored.

### `frames`; recursively readable by default, and the response says so

Exact CSS and `view: "scopes"` follow readable frame documents by default, including nested frames and frames inside shadow roots. `frames: false` opts out. Cross-origin, opaque-sandbox, and not-yet-loaded frame documents are listed in `framesUnreachable` rather than silently skipped.

Measured across five large sites, 36 iframes: **18 same-origin reachable, 18 cross-origin permanently opaque**; and the reachable ones held only 12–43 elements each, because the frames carrying real content (ads, embeds, payment fields) are cross-origin by construction. On react.dev this adds 12 elements to a 2,275-element page; on nytimes.com, 16 to 3,539. So it genuinely helps an **application that frames its own UI** and is near-useless on a news site. Not a workaround for cross-origin content, and doesn't pretend to be.

### Other behaviours

- A selector that doesn't parse returns `{ error: "INVALID_INPUT" }` with the parser's own message. `querySelectorAll` throws `SyntaxError`, and nothing validates a tool call.
- `matched` is the true total even when `limit` cuts the page. Call `pagination.next` to recover the remainder.
- `address: null` with `addressNote` means the element is real but outside the indexed root; not addressable, and saying so beats a silent `null`.
- Text runs through the host's `redact` hook exactly as indexed text does.

---

## 8. `agentic_content({ intent, query?, url?, goal?, limit?, offset?, revision?, summarize? })`

The other five answer about the page you're on. This one answers what comes first: **which page should I be on?**

Some sites publish `llms.txt`; one markdown file at the origin root listing pages that matter to an agent, each with a one-line description. Good idea, bad ergonomic: it's prose, so an agent must guess whether it exists, fetch it, parse markdown, resolve relative links, and handle its absence.

**Missing is the normal case.** `llms.txt` has no W3C/IETF/schema.org status and no governance. Adoption across a 300,000-domain sample is ~10%, and only one of the top 50 AI-cited domains has one. Across 500M+ AI-crawler events over 90 days, direct `/llms.txt` requests numbered in the low hundreds against overwhelming ordinary HTML crawling. Google says it does not support the convention. An SE Ranking model of AI-citation frequency got *more* accurate when `llms.txt` presence was removed as a feature. So the manifest path is the bonus, the fallback is the default, and the tool never implies a site is agent-unfriendly for lacking a file most sites don't have. Reading one when it exists costs one request and replaces a crawl; worth supporting, but a design that only worked *with* it wouldn't work on the real web.

**Historical deleted-harness measurement, 2026-08-31** (former `eval:agentic`/`eval:webmcp`; no current command reproduces it):

| site | manifest | entries | cost vs crawling the page yourself |
|---|---|---|---|
| Wikipedia | none |; | **4.3%**; fallback links instead of 31,666 tokens of DOM |
| Cloudflare docs | `llms.txt` | 106 | 45.6% |
| Vercel | `llms.txt` | 17 | 65.7% |
| Anthropic docs | `llms.txt` | 576 | 70.3% |
| Perplexity docs | `llms.txt` | 201 | **155.9%; a loss** |

Perplexity is the honest counter-case: a *large* manifest on a page with *few* links costs more to list than the page costs to crawl. There, `find` is the right intent and `list` is not; which is why they are separate intents. That table also caught two real defects invisible on pages we control: `docs.anthropic.com` serves a valid 688-entry manifest as `content-type: text/html`, which an earlier content-type guard rejected; and the cross-origin accounting below.

One call, three intents. Each failure names the next move instead of pretending every URL is readable through this tool. Every `list`/`find` response carries one response-level `urlSemantics` for its returned URLs. A manifest entry is `manifest-resource` (identifies the published resource, might be Markdown, not the live HTML route). A fallback DOM link is `live-page-link` and includes a resolvable address. Calling `read` with a `live-page-link` URL produces `NAVIGATE_INSTEAD`, reason `LIVE_PAGE_LINK`, and the address. With `goal: "navigate"`, Naviquest can verify a same-origin `.md` sibling as an HTML response and return it typed `kind: "live-page"`, `action: "navigate"`, `liveUrl`. Without that check it stays typed `kind: "resource"`, `action: "read"`, `resourceUrl`; clients never open a resource URL as a live page.

### `intent: "list"`; what this site publishes

```jsonc
{
  "source": "llms.txt",                    // or "llms-full.txt" / "none"
  "origin": "https://example.gov.uk",
  "urlSemantics": "manifest-resource",
  "site": "Meadowvale Council; services",
  "summary": "Bins, council tax, parking and planning for the Meadowvale area…",
  "docs": [
    { "title": "Council tax", "url": "https://example.gov.uk/council-tax",
      "section": "Services", "note": "Bands, discounts, who is exempt, and how to pay." }
  ],
  "total": 4, "truncated": 0,
  "_tokens": 211, "_budget": 2000
}
```

`section` is the manifest's own `##` grouping, so the site's structure survives into the answer.

### `intent: "find"`; which entry, in plain words

```js
agentic_content({ intent: 'find', query: 'how do I pay council tax' })
```

**It returns `matches`, not `docs`.** `list` returns `docs`; `find` returns `matches`; `read` returns `text`. (Undocumented before a probe read `f.docs`, found it `undefined`, and briefly recorded a working ranker as broken; the same defect this page prevents elsewhere.) Ranked by Unicode-token coverage over title + note + section, reported as the **same `confidence` scale `locate_control` uses**. Deliberately *not* the BM25 index (built over this page's chunks, whereas a manifest is a few dozen short titles); exact overlap is the right size of instrument and needs no index build, but shares the frozen `Intl.Segmenter` vocabulary so a one-character CJK query like `猫` doesn't disappear. When no manifest exists, `find` ranks the same safe same-origin fallback links `list` exposes.

### `intent: "read"`; one document's text

```js
agentic_content({ intent: 'read', url: 'https://example.gov.uk/tax.md' })
```

**An HTML entry is declined, not returned:**

```jsonc
{ "status": "NAVIGATE_INSTEAD",
  "url": "https://example.gov.uk/council-tax",
  "message": "That entry is an HTML page, not a text document. Returning its
              markup would cost more than the page is worth. Navigate to the url
              and call describe_app and find_on_page there; they answer the same
              question against the live DOM for a fraction of the tokens." }
```

Handing back a page's markup is precisely the cost Naviquest exists to remove; once on that page, `find_on_page` answers the same question better and cheaper. `read` is for the text documents a manifest points at; `.md`, `.txt`, JSON; and says so for anything else.

Long text is fetched once into a per-instance cache bounded by `maxBytes`, then paged with `{ offset, revision }`. Call the returned `pagination.next` entry unchanged. The revision is an exact content etag, so pages from two document versions cannot be spliced. If the source exceeds `maxBytes`, the tool returns `NAVIGATE_INSTEAD` with `reason: "SOURCE_TOO_LARGE"`; it does not expose a permanently partial prefix.

`list` and `find` use the same pagination contract. `list` pages the complete manifest or fallback-link population; `find` ranks the complete population before slicing. Both hash the population into `revision`, and budget pressure advances the next-call cursor by rows actually sent.

### When the site publishes nothing

Absence is an answer, not an error, and it is the common case:

```jsonc
{
  "source": "none",
  "docs": [], "total": 0,
  "links": [{ "title": "Council tax", "url": "https://example.gov.uk/council-tax",
              "landmark": "navigation", "address": { /* resolvable */ } }],
  "note": "This site publishes no llms.txt. These are the same-origin destinations
           linked from the current page, with addresses you can resolve and act on.",
  "tried": [{ "path": "/llms.txt", "status": "HTML, not a manifest" }]
}
```

**`tried` shows the probe results**, so a host whose manifest isn't picked up can debug without reading our source; "HTML, not a manifest" is the common cause, because an SPA serves its shell with a 200 for any unknown path rather than a 404.

**`links` is the one place this SDK surfaces an `href`.** `describe_app().reachableViews` names destinations but not enough to go to one. `href` is deliberately not stored on a projected node; it isn't part of an element's identity, it changes without changing the a11y tree, and storing it would let a stale URL survive a re-render the address layer would catch. So it's read at answer time and comes with an address, so the agent can navigate the URL or resolve and click the link.

### When the manifest points somewhere else

```jsonc
{
  "source": "llms.txt",
  "docs": [ /* 1 entry */ ],
  "crossOriginOmitted": {
    "count": 116,
    "hosts": ["docs.github.com"],
    "note": "116 manifest entries point at another origin and are not returned;              this tool only hands back same-origin URLs. They exist; fetch them
             with your own browsing tool if the answer is not here."
  }
}
```

Real case: `github.com/llms.txt` is **117 entries, 116 on `docs.github.com`.** The same-origin guard is right to drop them, but the first version returned *one document with no indication 116 were removed*; a silent truncation, which reads to a model as "that's everything". The deleted `eval:webmcp` run found it against real origins. Current same-origin and provenance contracts live in `eval/eval.ts` and `the deleted selector sensor`.

### Two guarantees in the current browser contracts

**Same-origin, in every path.** A tool that fetches an agent-supplied URL is a request-forgery primitive pointed at whatever the user's cookies can reach. Every manifest entry is resolved against `location.origin` and dropped if it lands elsewhere; `read` additionally refuses any URL not already in the manifest this origin published; so a same-origin `/admin/keys` an agent invents is refused just as a cross-origin URL is. Requests go out with `credentials: 'omit'`.

**Bounded in time and size.** 4 s timeout, 512 kB cap on a fetched body, 20,000 characters per `read` page before a revision-bound next call. A hung request must not hang the agent's turn; a byte-capped source is named separately.

### Uniform asynchronous calls

All six page-side tools return promises. Schemas register immediately; the answer engine loads once on the first call. `agentic_content` is the only tool that performs network I/O. The manifest is fetched once per instance and cached, **including the negative result**; an agent in a loop must not generate one round trip per step for a file that's still not there.

---

## Addresses: the thing that makes all of it actionable

Retrieval is useless if an agent can't act on what it read. Every result carries an **address**, and an address is a *description*, not a pointer:

```jsonc
{ "frame": "document/frame[1]", // ONLY when discovery.frames indexed a same-origin
                                // child frame; resolve_address re-enters that frame
  "landmark": "main",
  "headingPath": ["Shipping & Returns", "Returns"],
  "role": "button", "name": "Start a return",
  "ordinal": 0,
  "peerCount": 3,           // identical siblings when this was minted
  "anchorText": "…",        // only when there is no heading path to identify the region
  "resolveWith": "read_region",  // present on REGION addresses only
  "headingScope": "outline", // outline rows read through their descendant subsections
  "textOffset": 1200,       // only in truncated-region next-call arguments
  "textRevision": 7         // stale next calls fail instead of shifting
}
```

### `resolveWith`; which tool an address is for

Two structurally identical addresses come back from `find_on_page` that need **different tools**:

| Address | Where it comes from | Resolve it with |
|---|---|---|
| **region** | a result's own `address` | `resolve_address` routes it to the region path automatically; matched by heading path |
| **control** | `actionable[].address`, and every `locate_control` candidate | `resolve_address`; identifies one element |

`resolveWith: "read_region"` marks the first. Absent means the second, so every address minted before this field behaves exactly as before.

An address copied from `describe_app({ section: "outline" })` also carries `headingScope: "outline"`. Its region begins at that heading and ends immediately before the next heading of the same or higher level, following real document outlines even when subsection headings are flat DOM siblings. Copy the marker with the rest of the address; omitting it falls back to the ordinary DOM-subtree region path.

A region address is minted from the chunk's first element (usually a paragraph, table cell, or `generic` wrapper), and an accessible name is computed only for interactive nodes; so those are **unnameable by construction** and `resolve_address` can't find them. A documented limit, not a defect: read the section via the region path, then act on an address from its `controls`. Found on unlabelled pages; a Japanese Wikipedia article minted three unresolvable region addresses out of three (the English sample hid it because its chunks mostly start with a named link), and the failure *lied*: the hint said `No generic named null remains`, reading as "the passage disappeared" rather than "wrong route". `resolve_address` now routes region addresses itself.

Playwright already proved the core; its element identity key *is* `(role, accessible name)`. Naviquest adds the **heading path** (what `(role, name)` lacks when "Add to cart" appears under twelve product headings) and a **row** for list/table contexts (what makes list-heavy apps addressable at all). Measured: every minted address re-resolved after reindex across live sites, including after full subtree replacement.

---

## Flows

### One asynchronous call shape

Retrieval runs inline on the main thread by default, but every tool call is a promise; the answer engine loads on first use.

```ts
const wf = createNaviquest({ root: '#app' });
const hits = await wf.tools.find_on_page({ query: 'refund policy' });
```

Pass `worker: true` and indexing/ranking move into a module worker without changing the call shape:

```ts
const wf = createNaviquest({ root: '#app', worker: true });
const hits = await wf.tools.find_on_page({ query: 'refund policy' });
```

**What crosses the worker boundary:** only plain strings and numbers. Projection and segmentation stay on the main thread (they need the DOM); the two indexes cross as arrays of strings, results come back as `(id, score)` pairs. Nothing leaves the browser. Exact, unchanged content and control corpora are reused independently on a rebuild; a state/presentation mutation can require a fresh projection without changing either retrieval document set, and re-embedding the same strings would spend worker time for no semantic change. Equality is checked string-for-string, never by a collision-prone hash.

### The dense lane

Off by default. Lexical BM25 answers immediately; the int8 `potion-base-8M` table (3.9 MB at 128 dims) is a **ranking** improvement, never a correctness one. Three implemented rules:

1. **A query never blocks on the model.** Every response carries `retrieval: "lexical" | "hybrid"`.
2. **Warm when an agent is plausibly present**, not when it asks; `document.modelContext` existing is that signal. Ordinary visitors keep zero bytes on first paint.
3. **The worker fetches**, so the bytes never touch the main heap.

Measured over a real network: 0.04 s unthrottled, 6.19 s fast 4G, 34.59 s slow 4G; "lazy on first query" is not a shippable policy alone, which is why the policy above exists. `dense: true` is what a site should ship. `dense: 'eager'` warms immediately and exists because `document.modelContext` doesn't exist in stock Chrome; without it the gated policy would silently do nothing for anyone developing without the flag.

### Implemented Chrome Summarizer; optional schema flag, main window

Set `summarize: true` on `describe_app`, `find_on_page`, `resolve_address`, or `agentic_content`. Optional, defaults to `false`; selects the built-in summary policy without adding model-format choices to the wire schema. The first call lazily loads the `tools.ts` graph (includes `summarizer.ts`). The deterministic tool runs first; only then does the summary service feature-detect Chrome's built-in `Summarizer` on the page `Window` and process the redacted text retrieval returned.

```js
const result = await wf.tools.resolve_address({
  address,
  expand: true,
  summarize: true,
});

if (result.summary?.status === 'ready') {
  render(result.summary.text);
} else {
  render(result.text); // unchanged grounded fallback
}
```

`summary.lossy` is always `true`. Treat `summary.text` as navigation help, not page evidence. A successful response retains addresses, scores, state, provenance, counts, and `summary.readOriginalWith` (the tool name and arguments for recovering the exact deterministic payload). Successful search and region summaries remove the long text they replace and mark those records `textSummarized: true`. A page summary is additive because `describe_app()` is an orientation response, not a page dump.

Unavailable, skipped, and failed paths retain the original response before adding the `summary` status envelope. Status can report `unavailable`, `downloadable`, `downloading`, `no-input`, `skipped-short`, `input-too-large`, `not-smaller`, or `failed`. Before checking model availability, `skipped-short` retains response text below `tuning.summary.minInputTokens` (64 est. tokens default), so a short response pays no model latency. `not-smaller` means a longer response passed preflight and a summary was generated, but raw evidence was retained because the complete summarized envelope cost at least as much. Naviquest starts a downloadable model only while `navigator.userActivation` is active; the browser can still reject creation for policy, hardware, storage, language, or runtime reasons.

Long input uses a bounded summary-of-summaries pass. A quota error supplies the requested and available sizes; Naviquest splits at paragraph/word boundaries, uses 80% of the reported quota, allows at most 12 chunks, summarizes them sequentially, then summarizes the combined partials. Defaults: 30 s timeout, 64-token input floor, 1,200 output characters, no recursive tree. Override via `tuning.summary`.

A ready result reports both sides of the exchange. `latencyMs` covers session creation and model calls after availability succeeds. `sourcePayloadTokens` and `resultTokens` use Naviquest's response estimator; `tokensSaved` is their difference, `tokensSavedPerSecond` divides it by that call's measured model latency. These measure transport context, not summary correctness.

This stage never runs in the retrieval worker. Current Chromium source contains a separate disabled-by-default worker feature, and the current spec exposes `Summarizer` on `Window`; Naviquest keeps the stricter boundary even if a browser later exposes the API in workers. Headless mode has no special branch. The summarizer sensor (deleted in the eval merge) provides deterministic orchestration/efficiency coverage without a downloaded model: on 2026-09-01, its 12 checks and fixed long-region fixture measured 1,344 est. payload tokens before summarization and 378 after (72% reduction); the delayed fake model took 34.5 ms and reported 966 est. tokens saved, and a 61-char response made zero model calls. The delay tests accounting, not real Chrome performance. Run the Chrome skill's `scripts/cdp-checks/api-probe.mjs` to inspect the attached profile's real availability.

### Why retrieval is not WASM today

Live 2026-09-01: indexing 3.5 ms (React), 9.1 ms (CNN), while DOM projection cost 18.0 and 24.1 ms; the 3,000-chunk BM25 query sensor is ~1.5 ms. WASM would not move projection, `Intl.Segmenter`, string cloning, or serialization. Reconsider only above 10,000 representative chunks, worker retrieval p95 over 50 ms, or a trace showing dense dot products dominate. Proper BM25F and translated-query fusion remain held-out prototypes, not production defaults.

### Freshness

A `MutationObserver` watches the automatic body or explicit root, every reachable shadow root, and every registered external region. It observes every attribute because role, link relations, ARIA IDREFs, and host exclusion selectors can all change meaning or privacy without changing element count.

Mutation observation isn't the whole lifecycle. `attachShadow()`, slot assignment, and popover top-layer changes can occur without a mutation beneath the selected root. Naviquest compares the reachable-tree shape, listens for `slotchange`, `toggle`, and iframe `load`, responds to visual-viewport, resize, font, and inferred `<html lang>` changes, and re-resolves selector-based roots after SPA replacement. The active modal becomes a temporary semantic root when a portal rendered it outside an explicit app root. Worker builds carry a mutation generation, so an older async result can't clear a newer dirty state.

CSSOM writes need not produce DOM mutations, so action candidates are retained as a latent corpus and revalidated with current computed visibility and geometry before every response. Opaque-region ordering and pagination stay revision-stable while their screenshot boxes are recomputed live. ARIA `rowcount` and `setsize` expose virtualized rows/items not in the DOM; coverage names those missing populations instead of letting search imply a rendered window is the whole collection.

`coverage` also declares three failures the projection used to swallow: `malformedStructuredData` counts JSON-LD blocks that don't parse (the page asserts facts this index doesn't hold); `nameComputeFailures` counts elements whose accessible-name computation threw and which are indexed unnamed and unreachable by name lookup; `invalidExcludeSelectors` counts host `exclude[]` entries that aren't valid CSS. The last is the inverse and is addressed to the host, not the agent; an unparseable selector matched nothing, so content the host meant to withhold **is** indexed.

`describe_app().coverage` compares an explicit root with the rendered parent document, reports frames outside it, and counts readable frame documents inside the root that exact inspection can enter but semantic search cannot index. A custom host with no exposed root is `unknownShadowHosts`, not a claimed closed root: page JS can't distinguish "no shadow root" from "unregistered closed root". Multiple open modals with no focused descendant are explicit too: orientation reports `ambiguous: true`, and controls are conservatively inert instead of being assigned to a guessed top-layer dialog.

**One thing the observer is structurally blind to:** `el.checked = true` and a typed `value` are *properties*; they change no attribute, add no node, leave the element count identical. That's exactly the state an agent most needs. So live state is re-read **at answer time** for every returned candidate, not at index time. Found by driving the demo's own assistant: tick a document checkbox and it still reported it outstanding.

### Budgets, and declared truncation

Every response carries `_tokens` and `_budget`. When a page exceeds its budget, the tool removes only a suffix of complete rows or text and returns a cursor for the first omitted item. A single indivisible record can set `_overBudget`; the tool does not weaken that record to manufacture a smaller answer. This is not politeness; a silently trimmed response reads to a model as *"that's everything"*, the easiest way to make an agent confidently wrong.

---

## When *not* to use these tools

Below roughly a 2,000-token page, this SDK is a net loss and says so. `describe_app` returns a `recommendation` telling the agent to request the accessibility tree directly.

Measured: Excalidraw's entire a11y tree is 407 tokens against 420 for three tool calls; 103%. YouTube's is 755 tokens for 2,291 elements, because it is custom elements all the way down. App shells and canvases defeat both representations equally. Where it wins, it wins big: CNN's raw HTML is **1.5 million tokens** (twelve times a 128k context), its a11y snapshot is 14,348, and three tool calls answer for **1,365**.

---

## Measured on pages nobody prepared

The 2026-09-01 targeted audit injected the current SDK into MDN, React, English Wikipedia, GOV.UK, and NHS. No demo fixture contributed. Rank 1 was captured before grading; expected labels were not passed into Naviquest selection.

| Tool or mode | Live result |
|---|---|
| `describe_app` | MDN, React, Wikipedia stayed within budget and declared structure/coverage; GOV.UK/NHS established semantic baselines |
| `find_on_page` | relevant on React Quick Start, weak for Wikipedia featured-article prose and one MDN out-of-page question |
| `locate_control` | exact Wikipedia searchbox; safe recoverable React ambiguity; one MDN phrasing returned unrelated high-confidence links |
| `resolve_address` | native MDN/React/Wikipedia links returned live absolute navigation metadata; non-links omitted it |
| `query_selector` | accurate bounded action/scope inventories; no relevance claim, no challenging live iframe in this sample |
| `agentic_content` | fallback links declared `live-page-link`; React Markdown declared `manifest-resource` without an invented HTML alias |
| `changesSince` | GOV.UK/NHS detected property-only state and focus, returned no entered value, declared exact truncation under a cap |

The label-free navigate sensor (deleted in the eval merge) derives probes from each page at runtime and can run against any URL:

- take a heading the page reports → search for it → the region under it must come back;
- take a control's own accessible name → look it up → that control must rank first;
- resolve every address any tool mints;
- plus invariants true of any page; responses inside budget or declaring truncation, coverage reported, and a token *verified absent* returning a declared no-match rather than a fabricated answer.

**Historical sensor result, retained as dated design evidence:** six pages in no other harness (`rfc-editor.org`, `w3.org/WAI`, `python.org`, `usa.gov`, `caniuse.com`, `blog.mozilla.org`):

| | |
|---|---|
| invariants held | **48/48** |
| addresses resolved | **41/41** |
| control found by its own name | **29/30** |
| heading round-trip | 21/24 |
| loop cost, median % of an aria snapshot | **42.8%** |

**42.8%, against 13.7% on the curated set.** Both honest; they measure different things. Curated sites are large and document-shaped, where a fixed orientation cost is a small share. An arbitrary page is smaller and more application-shaped, so the same cost is a larger share. Use 13.7% for document pages, 42.8% for "some page, unseen".

That deleted sensor also found a region address inheriting the role of the link that started its chunk while forcing `name: null`, making 4 of 5 addresses on `caniuse.com` unresolvable. Nine labelled sites never hit it, because prose-led pages take the fallback branch.

---

## Reference

| | |
|---|---|
| Tool implementations | [`packages/naviquest/src/tools/tools.ts`](../packages/naviquest/src/tools/tools.ts) |
| Lifecycle, registration, lanes | [`packages/naviquest/src/index.ts`](../packages/naviquest/src/index.ts) |
| Addressing and resolution | [`packages/naviquest/src/tools/address.ts`](../packages/naviquest/src/tools/address.ts) |
| How the pieces fit, and why | [ARCHITECTURE.md](../ARCHITECTURE.md) and [TECHNOLOGY.md](./TECHNOLOGY.md) |
| Current measurements and limits | [EVAL.md](./EVAL.md) and [TESTING.md](./TESTING.md) |
| Browser APIs and implementation map | [TECHNOLOGY.md](./TECHNOLOGY.md) |

---

## The contract every tool shares

Three things hold across all six, each existing because its absence produced a real defect. Stated once here rather than repeated in six tool descriptions, which are paid for on every `getTools()`; see [ARCHITECTURE § 23](../ARCHITECTURE.md).

### The envelope

Underscored, because it is metadata *about* the answer, not part of it; and the delta diff skips these keys for the same reason.

| Field | Meaning |
|---|---|
| `_tokens` / `_budget` | what this response cost, and its ceiling on this page |
| `_overBudget: true` | shrinking could **not** reach the ceiling. The smallest payload achievable, **not** the whole answer |
| `_etag` | pass back as `since`. Names the bytes you actually received |
| `_version` | increases on every reindex, so you can tell *unchanged* from *different index* |

### Every omission is recoverable

`truncated` reports how much remains and `pagination.next` starts at the first omitted row or character. Orientation may return several next calls because its outline, landmarks, trail, and reachable views have independent offsets. Search excerpts declare their source length and carry a region address for the complete read. Call the returned next entry unchanged; revision mismatches return `STALE_CURSOR` rather than combining pages from different DOM or document versions.

### Errors are values, never throws

Every tool returns `{ error, message }` rather than rejecting; a thrown call gives an agent nothing to act on.

| `error` | Means | Do |
|---|---|---|
| `INVALID_INPUT` | the argument was the wrong type or missing | fix the call; **not** "the thing is absent" |
| `AMBIGUOUS` | *(region path)* the address now matches several regions | pick from `candidates` |
| `NOT_FOUND` | *(region path)* the address matches nothing | re-search; `nearest` lists the closest |
| `DISABLED` | *(`agentic_content`)* the host turned site discovery off | do not retry |
| `NOT_IN_MANIFEST` | *(`agentic_content`)* that URL is neither a manifest resource nor a currently exposed live page link | read only `manifest-resource` URLs; a returned `live-page-link` produces `NAVIGATE_INSTEAD` with its address |
| `FETCH_FAILED` | *(`agentic_content`)* network or timeout | do not loop; the result is cached, negatives included |

`INVALID_INPUT` vs `NOT_FOUND` is deliberate. Passing a string where an address belongs used to return `NOT_FOUND`, telling the agent the element vanished when the truth was a wrong type; two different next moves.

### Nothing validates your call

WebMCP's `inputSchema` is, in the spec's words, *"purely a semantic hint"* ([issue #92](https://github.com/webmachinelearning/webmcp/issues/92)), and no layer validates arguments against it. So every tool type-guards its own input. That guard is load-bearing: `Intl.Segmenter` **coerces**, so a non-string `description` never threw; `{}` tokenized as `"[object Object]"` and `locate_control` returned plausibly ranked garbage with a confidence attached. A readable error beats a confident wrong answer.
