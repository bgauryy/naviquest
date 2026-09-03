# CityDesk demo

In-page exercise of `naviquest`, a browser-research SDK that a website embeds
for WebMCP or an automation host injects into an unmodified origin. This
directory is a private app workspace.

```bash
yarn install                    # repository root
yarn dev                        # http://localhost:5310
yarn workspace demo-app build   # out/ at the repository root
```

The page imports the SDK by package name (`naviquest`). The build first builds that workspace dependency, then Vite resolves its published `exports` map. The generated app therefore contains the same `dist/` SDK implementation that an installed consumer receives.

## Deploy to Vercel

Import the repository from GitHub with these settings:

- **Framework Preset:** Vite
- **Root Directory:** `./` (the repository root)

The repository-level [`vercel.json`](../../vercel.json) runs `yarn build` and publishes repository-root `out`. Keeping the repository root lets Vercel build the `naviquest` workspace dependency without an outside-root exception. The generated deployment includes all five HTML routes, files from `public/`, assets, the Naviquest SDK, and its worker.

Query flags:

- `?worker=1`; retrieval in a module worker
- `?dense=1`; worker plus int8 embeddings, if `public/model/` exists (gitignored)

CityDesk is a WebMCP **provider**, not an in-page agent: it calls only
`createNaviquest()` and `register()`. The browser agent invokes the six tools and
receives their `_tokens` / `_budget` metadata; the demo page never calls a tool
itself. Enable `chrome://flags/#enable-webmcp-testing` to register them on
`document.modelContext` during local development.

Multi-page portal (same SDK on every route):

| Route | What is on it |
|---|---|
| `/` | Dashboard, agent instructions, rebates, waste, council tax, housing, schools, 520 recycled applications, private block |
| `/parking.html` | Eight zones with prices, renewal, visitor rules, recent decisions |
| `/libraries.html` | Branch hours, PC booking, loans/fines, September events |
| `/notices.html` | Planning table, traffic orders, consultations, email alerts |
| `/workspace.html` | Fake resident SPA workspace: tasks, applications, household details, and activity |

Fixtures exist to stress the SDK (closed shadow, recycling list, excluded `[data-private]`, modal, non-text). CityDesk **opts in** to `orientation` and `exclude` as a first-party overlay. That metadata makes CityDesk routes and tasks less ambiguous, but it is not a requirement: the same six tools retrieve generic DOM and ARIA evidence on any site (`yarn eval --live --url …`). Naviquest discovers and grounds destinations; the browser host performs navigation and other browser actions.

The demo is not a universal token benchmark. Bounded retrieval can reduce agent context on large, structured pages, while small pages and broad multi-page tasks can favor direct fetch or require more tool calls. Sensors live under [`eval/`](../../eval).

This demonstration is [MIT licensed](../../LICENSE) ([`/LICENSE.txt`](./public/LICENSE.txt) on the running app).
