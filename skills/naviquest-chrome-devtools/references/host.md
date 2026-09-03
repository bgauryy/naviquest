# Long-Lived Host

Load when several calls, several agents, or another program need Naviquest without
reloading the page per request. Why: the host keeps one Chrome tab, index, and
reader per session while hiding CDP/WebMCP plumbing behind localhost HTTP.

## Start

```bash
node scripts/naviquest-build.mjs --bundle-only
node scripts/open-browser.mjs --headless --port 9222 \
  --enableFeatures WebMCPTesting --url about:blank
node scripts/naviquest-host.mjs --port 5340 --cdp-port 9222
```

For on-device AI, launch with the flags and warm-up in `chrome-flags.md` first.
The host binds `127.0.0.1` only and refuses `requireModel:true` unless the model
is `available` on the exact opened page.

## Call

```bash
S=$(curl -s -X POST http://127.0.0.1:5340/session \
  -H 'content-type: application/json' \
  -d '{"requireModel":false}' |
  node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).id')

curl -s -X POST http://127.0.0.1:5340/call \
  -H 'content-type: application/json' \
  -d "{\"session\":\"$S\",\"tool\":\"open\",\"input\":{\"url\":\"https://example.com\"}}"

curl -s -X POST http://127.0.0.1:5340/call \
  -H 'content-type: application/json' \
  -d "{\"session\":\"$S\",\"tool\":\"find_on_page\",\"input\":{\"query\":\"what is this domain for\"}}"

curl -s -X DELETE "http://127.0.0.1:5340/session/$S"
```

`POST /session` accepts `config`, `requireModel`, `primeReader`, and
`primeTimeoutMs`. `POST /call` accepts `open` or any of the six Naviquest tools.
`GET /health` reports Chrome, transport, tools, and active session count.

The caller owns questions, branching, metrics, storage, and evaluation. The host
owns tabs, injection, WebMCP invocation, model checks, reader settlement, and
cleanup. Dependent flows call step 1, inspect its result, then choose step 2.

Next: load `recovery.md` only when the host returns an error; otherwise the step ends.
