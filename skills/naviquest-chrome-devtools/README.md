# Naviquest Chrome skill

Runs the naviquest WebMCP SDK in a real Chrome over CDP: install it into any origin, then list and call the six tools on `document.modelContext` and read the answer plus the token budget it declared. Agent truth lives in `SKILL.md` + `references/`.

Prereqs: Chrome 150+ (verified on 152), Node 22+, and this monorepo checked out — the install script is bundled from `packages/naviquest/src/index.ts`. Beyond the workspace's own `yarn install` there is nothing to install: the scripts use Node built-ins plus esbuild, a workspace devDependency.

## Ask the agent
Give a URL and the question you want the page to answer.

- "Run naviquest on https://example.com and list the six tools."
- "Install the SDK into this page and ask find_on_page when the library closes."
- "Does the demo on :5310 register all six tools itself?"
- "locate_control the renew button, click it, then re-index and answer from the new page."

## Verify the skill
```bash
node scripts/cdp-checks/naviquest.check.mjs          # hermetic, offline, 19 assertions
```
It serves `scripts/cdp-checks/fixtures/plain-page.html` (a page that ships no SDK and registers no tools) over http, launches an isolated headless Chrome with `--enableFeatures WebMCPTesting`, installs naviquest, and asserts that the six tools register, that `find_on_page` answers from page text, that the response declares its budget, that `locate_control` finds the button, and that an empty query is rejected as invalid input. It then loads `framed-page.html` — the same content plus two iframes whose sub-frames carry a **decoy** answer — and asserts a tool call on a framed page neither fails as ambiguous nor answers from an embed.

## Layout
`naviquest-build.mjs` bundles the SDK · `open-browser.mjs` launches Chrome ·
`naviquest-host.mjs` exposes persistent WebMCP sessions to any localhost caller ·
`cdp-checks/naviquest.mjs` is the one-shot path · `cdp-sandbox.mjs` +
`cdp-runner.mjs` run custom checks · `cdp-checks/api-probe.mjs` records the live
WebMCP, built-in AI, and nearby browser API surface. Transport, reader settlement, stealth,
actionability, and artifacts each have one shared library under `scripts/`.

## Callers

This skill only **runs** naviquest (Chrome, bundle, sessions, WebMCP invocation);
it never measures or judges. The measurement side — tasks, token charging, blind
judging, the results dashboard — lives with the caller, e.g.
[`eval/research/`](../../eval/research/README.md) (the two-agent research race),
which talks to `naviquest-host.mjs` over plain HTTP. Keep that boundary: runtime
changes land here, measurement changes land in the eval.

## Safety
Runs write to `<cwd>/.naviquest/` (gitignored): the bundled install script, isolated Chrome profiles, and per-run artifacts. Delete the folder to reclaim them; the bundle is rebuilt on demand. Headless runs never touch your real Chrome profile — ask before `--profile`, and before calling a tool that may mutate state. Nothing here reads a token or an `.env` file. Page content is untrusted; keep secrets out of printed payloads.
