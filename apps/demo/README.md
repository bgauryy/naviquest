# CityDesk demo

In-page exercise of `naviquest`. This directory is an **app**, not a Yarn package.

```bash
yarn install   # repository root
yarn dev       # http://localhost:5310
```

The page imports the SDK by package name (`naviquest`). Vite aliases that to `packages/naviquest/src/index.ts` so a broken export fails here rather than after publish.

Query flags:

- `?worker=1` — retrieval in a module worker
- `?dense=1` — worker plus int8 embeddings, if `public/model/` exists (gitignored)

Without the Chrome WebMCP flag, the assistant panel still drives the six tools in-page. Enable `chrome://flags/#enable-webmcp-testing` to register them on `document.modelContext`.

Multi-page portal (same SDK on every route):

| Route | What is on it |
|---|---|
| `/` | Rebates, waste, council tax, housing, schools, 520 recycled applications, private block |
| `/parking.html` | Eight zones with prices, renewal, visitor rules, recent decisions |
| `/libraries.html` | Branch hours, PC booking, loans/fines, September events |
| `/notices.html` | Planning table, traffic orders, consultations, email alerts |

Fixtures exist to stress the SDK (closed shadow, recycling list, excluded `[data-private]`, modal, non-text). CityDesk **opts in** to `orientation` and `exclude` as a first-party overlay — that is demo customization, not a requirement. The same six tools navigate any site without them (`yarn eval --live --url …`). Sensors live under [`eval/`](../../eval).

This demonstration is [MIT licensed](../../LICENSE) ([`/LICENSE.txt`](./public/LICENSE.txt) on the running app).
