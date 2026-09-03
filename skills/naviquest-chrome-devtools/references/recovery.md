# Recovery Reference

Load when a CDP call errors, returns empty, or the same failure class hits twice. Why: match the symptom to a known fix instead of retrying blind. After **two** same-class failures, stop and summarize the evidence.

## Naviquest-specific
| Situation | Fix |
|-----------|-----|
| `NAVIQUEST_MODELCONTEXT_UNAVAILABLE` | Chrome has no `document.modelContext`. Flags apply per process: `open-browser.mjs --cleanup`, then relaunch with `--enableFeatures WebMCPTesting`. A launch JSON showing `"reused": true` never got the flag. |
| `WEBMCP_DOMAIN_UNAVAILABLE … opaque origins` | The page is a `file://` URL. Serve it over `http://127.0.0.1` (`scripts/cdp-checks/fixtures/fixture-server.mjs`); enabling the domain grants a permission the origin cannot receive. |
| `NAVIQUEST_INSTALL_MISSING` | Run `scripts/naviquest-build.mjs` first. It writes into `<cwd>/.naviquest/`, the only tree the sandbox can read, so run both from the same working directory. |
| `NAVIQUEST_REGISTRATION_INCOMPLETE` | The document was replaced again after installation (a redirect, a consent hop, or the site's own SPA route). Re-run against the settled URL with `NQ_WAIT_MS` raised, and check the artifact for which names did arrive. |
| Tools registered a moment ago are gone (`WEBMCP_NO_TOOLS`) | Injection lives in the CDP session that added it, and the runner's stealth gate reloads on attach. Never split install and call across two runs; `naviquest.mjs` does both. |
| Fixture requests hang and the tab shows an error page | Something is serving the fixture from a process that is blocked in `spawnSync`. Serve it from its own process, as `naviquest.check.mjs` does. |
| A tool answers with `results` but no `answer` | Not a defect: only `answer` is evidence. Re-ask with a query in the page's own vocabulary (`describe_app().vocabulary`), or read the region behind the address with `resolve_address`. |
| `INVALID_INPUT` | The input failed the tool's own type guard; a different outcome from `NOT_FOUND`. Fix the JSON in `NQ_INPUT` against the `inputSchema` printed by `NQ_ACTION=list`; do not retry unchanged. |
| `NAVIQUEST_MODEL_ABSENT` | The AI constructors are missing. Either the tab is on an opaque origin (`about:blank`); navigate to the real page, *then* warm; or the launch lacked the AI flags, which need a fresh process (`references/chrome-flags.md`). |
| `NAVIQUEST_MODEL_UNAVAILABLE` | The one stable model rejection: this device/build/options cannot run it. Do not re-warm. Run the lexical path and declare AI off. |
| `NAVIQUEST_MODEL_WARM_TIMEOUT` | The download is Chrome's and survives the script, so progress resumes. Raise `NQ_WARM_MS` and re-run once; if progress never moves, treat it as cold and say so. |
| `NAVIQUEST_ANSWER_UNVERIFIED` | Nobody checked the answer; it still stands on the lexical path. The printed `[REASON]` names the state: `downloadable` → run `model-warm.mjs` on THIS tab once, then call again; `absent` → opaque origin, or the AI channels are off for this launch (`references/chrome-flags.md`). |
| `NAVIQUEST_VERIFIER_COLD` | The model reported `available` but its reader never answered inside the budget; raise `NQ_PRIME_MS`. Report the answer as unverified. |
| Tempted to conclude "Chrome disables built-in AI under CDP/automation" | **Measured false** on Chrome 152 (`references/chrome-flags.md`): the model downloads over CDP and `find_on_page` returns `verified=true`. The three real gates are a non-opaque origin, a user gesture for the download, and the SDK's own reader warm-up; all handled by `model-warm.mjs` and `naviquest.mjs`. Do not close a run on this. |
| `find_on_page` returned no `answer` at all | If a verifier ran, this is it working: it withheld a passage that did not answer the question. Follow the payload's `hint`; `resolve_address` the top result and read the region. |
| An address stops resolving after a click | Addresses are invalidated by mutation by design. Re-run `find_on_page` / `locate_control` on the new document instead of reusing the old address or its box. |

## Chrome and CDP
| Situation | Fix |
|-----------|-----|
| `Chrome not found` | Install Chrome or pass `--chromePath`. |
| `Chrome not running on port` | Run `open-browser.mjs --headless` first. |
| Chrome already open without CDP | Handled: `open-browser.mjs` launches an isolated CDP session. |
| `WebSocket unavailable` | Node 22+ required (native WebSocket, no install). |
| `bad option: --allow-net` | `--allow-net` is Node 25+ only; the sandbox gates on the major version. Update `cdp-sandbox.mjs` if you still see it. |
| `ERR_ACCESS_DENIED` in the sandbox | The script wrote outside `cdp.outputDir`, read a blocked path, or tried a child process / Worker. Write via `join(cdp.outputDir, name)`, talk to the page only through `cdp.send()`, and rerun with `--verbose` to see the allowed paths. |
| `Script not found` | Use `.naviquest/tmp/cdp-<task>.mjs`; never hardcode `/tmp/`. |
| `CDP timeout for <method>` | The domain is not enabled; add its `enable` call first. |
| `[CDP_RETRY_NEEDED]` (exit 2) | Read the two printed lines: they name the method and the fix. Retry once. |
| `No page targets` | Use `--new-tab about:blank`, then navigate inside `run()`. |
| Events never fire with `--new-tab <url>` | The tab loaded before listeners attached. Open `about:blank`, attach, then `Page.navigate`. |
| Need an iframe or worker | `--list-targets`, then `--target-url <pattern>` or `--target-type service_worker`. Iframes are opaque to the parent index by design; attach to the frame. |
| `<tool> resolved to N frames` from the host | FIXED 2026-09-03; the host now calls the MAIN frame and ignores sub-frame registrations (the install script runs per document, so any page with an embed registers the six names more than once; this used to break every call on react.dev / vuejs.org). If you still see it, the main frame did not register: re-`open` the page, then check `Page.getFrameTree`. Regression covered by `naviquest.check.mjs` (`framed-page.html` carries a decoy answer in its sub-frames). |
| `Page.navigate` times out on every URL | Stale session: `open-browser.mjs --cleanup`, then relaunch. |
| Unsure whether cleanup kills the tracked browser | `--cleanup --dry-run` reports whether the PID matches both the port and the isolated profile, without killing anything. |
| JavaScript dialog blocks all commands | Add a guard before navigating: `cdp.on('Page.javascriptDialogOpening', () => cdp.send('Page.handleJavaScriptDialog', { accept: true }))`. |
| `Runtime.evaluate` hangs after `Debugger.enable` | `await cdp.send('Debugger.setSkipAllPauses', { skip: true })` immediately after. |
| A fill is ignored by the app's own state | Frameworks override the instance `value` setter; assign through the prototype setter instead (`dom-operations-check.mjs`'s fill already does). |
| Consent or GDPR wall instead of content | Foreign-language title, very few requests, no API calls. Accept it once in the page, wait, re-navigate, then re-run the install; the SDK indexes whatever document it lands in. |
| Bot wall or CDN challenge | Stealth is already applied and self-tested on attach. If it still blocks, switch to a visible browser and let the user clear it in the same CDP session. |
| URL with `?` or `&` fails in zsh | Quote it: `--url "http://…"`. |
