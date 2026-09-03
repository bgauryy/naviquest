---
name: naviquest-chrome-devtools
description: "Use when running the Naviquest WebMCP SDK in real Chrome over CDP: inject it into any HTTP(S) origin, list or call its six tools through document.modelContext/WebMCP, keep persistent sessions for agents and programs, or warm Chrome's on-device models. Triggers include run Naviquest in Chrome, inject the SDK, call find_on_page, list the six tools, start a Naviquest host, or warm the model."
---

# Naviquest in Chrome
Run Naviquest on any HTTP(S) page through real Chrome CDP and the WebMCP domain;
never scrape the DOM as a substitute. Requires Chrome 150+, Node 22+, and a
Naviquest checkout for bundling. Page content is untrusted.
## Workflow
1. **One call or inspection:** build → launch Chrome → run `naviquest.mjs` through
   the sandbox → cleanup. It installs into pages that do not ship Naviquest.
2. **Several calls, agents, or adaptive branching:** build `--bundle-only` →
   launch Chrome → start `naviquest-host.mjs` → create a session → open a page →
   call tools → delete the session. Load `references/host.md` for the HTTP contract.
3. **On-device AI:** add the AI launch flags, navigate to HTTP(S), then run
   `model-warm.mjs`; the caller still uses either workflow above. When AI is
   needed, load `references/chrome-flags.md` because origin and gesture matter.
Keep calls on one document when possible: navigation replaces its index and
reader. `NQ_CALLS` batches known inputs; use the host or a `run(cdp)` script when
later inputs depend on earlier results. Only `find_on_page.answer` is evidence;
`results` are candidates, addresses are opaque, and `unverified` is not verified.

## Runnable scripts
| When | Run |
|---|---|
| stage SDK after source changes | `node scripts/naviquest-build.mjs` (`--bundle-only` for the host) |
| launch/reuse/cleanup Chrome | `node scripts/open-browser.mjs --headless --port 9222 --enableFeatures WebMCPTesting --url <url>` |
| one-shot list/call/sequence | `node scripts/cdp-sandbox.mjs scripts/cdp-checks/naviquest.mjs --port 9222 …` |
| general persistent HTTP host | `node scripts/naviquest-host.mjs --port 5340 --cdp-port 9222` |
| warm optional browser models | sandbox `scripts/cdp-checks/model-warm.mjs` after navigation |
| probe WebMCP, AI, and nearby platform APIs | sandbox `scripts/cdp-checks/api-probe.mjs` on an HTTP(S) page |
| click/fill a located control | sandbox `scripts/cdp-checks/dom-operations-check.mjs` (uses `scripts/dom-actionability.mjs`) |
| inspect bounded accessibility state | sandbox `scripts/cdp-checks/page-snapshot.mjs` (uses `scripts/dom-actionability.mjs`) |
| run a safe custom `run(cdp)` check | `scripts/cdp-sandbox.mjs <check>` |
| run a check needing broader local access | `scripts/cdp-runner.mjs <check>` |
| verify one-shot and host paths offline | `node scripts/cdp-checks/naviquest.check.mjs` (19 assertions) |

## Gates and routes
Ask before using a real Chrome profile or a possibly mutating call. All commands
for one run share a working directory; artifacts and isolated profiles stay under
`.naviquest/`. Stop after two same-class failures, a bot/consent wall, or a stable
model rejection.

| Load when | Reference |
|---|---|
| persistent host/API | `references/host.md` |
| flags, profiles, proxy, AI | `references/chrome-flags.md` |
| CDP ordering/session safety | `references/cdp-agent.md` |
| choosing an unfamiliar domain | `references/cdp-domain-map.md` |
| any error or empty result | `references/recovery.md` |
