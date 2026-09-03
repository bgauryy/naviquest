# Chrome Launch Reference

Load when launching Chrome with a special profile, proxy, binary, or headless/mobile need. Why: launch flags only apply to a fresh browser process — a reused CDP session silently ignores them.

## WebMCP (required for this skill)
`document.modelContext` exists only behind the feature flag, so every naviquest run needs a fresh launch with it:

```bash
node <skill-dir>/scripts/open-browser.mjs --headless --port 9222 \
  --enableFeatures WebMCPTesting --url "<url>"
```

Verified on Chrome 152. `WebMCPTesting` is the name the repo's own sensors use (`WEBMCP_CHROME_ARGS` in `eval/eval.ts`); `WebMCP` alone also exposes the domain on this build. If `open-browser.mjs` reports `"reused": true`, the flag did **not** take effect — run `--cleanup` or pick another port.

## On-device AI (only when a run wants the AI lanes)
The verifier, answerer, summarizer, translator and image describer need Chrome's built-in models. Add them to the same fresh launch:

```bash
node <skill-dir>/scripts/open-browser.mjs --headless --port 9222 --url "<url>" \
  --enableFeatures WebMCPTesting,OptimizationGuideOnDeviceModel,PromptAPIForGeminiNano,SummarizationAPIForGeminiNano,TranslationAPI,LanguageDetectionAPI
```

**Built-in AI is NOT disabled under CDP automation.** That belief is the reason runs get abandoned with "can't fix the platform", so it is measured here rather than asserted — Chrome 152, headless, over CDP, 2026-09-03:

| Reading | Measured |
|---|---|
| `--enable-features` for the AI APIs | works; `chrome://flags` on a persistent profile is not required |
| `LanguageModel.availability()` cold | `downloadable` — not `unavailable` |
| the constructors on `about:blank` | **`undefined`**. They exist only on a non-opaque origin, so navigate to the real page *before* warming |
| cold `LanguageModel` download | 54.8 s, then `available`, and a prompt round-tripped |
| `Translator` (es→en) after that | 6.4 s; `Summarizer` and `LanguageDetector` came up free on the shared base |
| an `available` model on the first tool call | still answers `unverified: NO_ON_DEVICE_READER` — the SDK starts its reader off the critical path and does not block the call that started it. Re-asking once is not enough either; that warm-up is itself a model round trip |
| the first call on a page where extractive coverage is BELOW `answer.minCoverage` | **no `answer` key at all** — not `unverified`. Measured 2026-09-03 (visible Chrome, all AI flags, `LanguageModel: available`): three back-to-back `find_on_page` calls returned results with no `answer`; after `open` → one throwaway query → **~25 s dwell**, the same queries returned `answer.verified: true`. Consequence for callers: `primeReader`/`settleOnDeviceReader` only retries when it sees `answer.unverified === 'NO_ON_DEVICE_READER'`, so an ABSENT answer does not trigger priming and the AI lanes stay cold. Warm each document explicitly: `open` → throwaway query → dwell → measured calls |
| the model across page NAVIGATIONS | the 4.2 GB model stays in the profile, but the Nano *session* is per-document, so every `open` needs the dwell above again — it is much cheaper than the 55 s cold download, not free |
| `Summarizer` / `LanguageDetector` with those flags | `available` on a real origin. `Translator` reports `downloadable` until a language pair is requested; `Rewriter` / `Writer` are **absent** on Chrome 152 with these flags (the SDK does not use them) |
| end to end | `find_on_page` on a live Wikipedia article returned `verified=true` with the answer *"training of the PaLM … in 2022 cost $8 million"*, and on a question the top passage did not answer the verifier **withheld** it. `naviquest.mjs` handles the warm-up polling |

The download only starts inside a user gesture (`packages/naviquest/src/ai/model-gate.ts` reads `navigator.userActivation.isActive`), which an agent tool call never has. `Runtime.evaluate` with `userGesture: true` supplies one — that is why `scripts/cdp-checks/model-warm.mjs` exists and why a tool call cannot warm itself.

The model lands in the **port-scoped profile** (`.naviquest/tmp/chrome/browser-state/cdp-chrome-profile-<port>/OptGuideOnDeviceModel`, 4.2 GB) and a relaunch on that profile reports `available` with no download and no gesture. So it is one cost per profile, not per run — and `--cleanup` or `rm -rf .naviquest/tmp` deletes it, buying the 55 s back on the next launch. Keep the profile between runs that want AI.

`file://` pages cannot be used: enabling the WebMCP domain grants a permission to the frame's origin, and a file origin is opaque, so Chrome 152 fails the enable with `Permission can't be granted to opaque origins`. Serve local pages over `http://127.0.0.1` (see `scripts/cdp-checks/fixtures/fixture-server.mjs`).

## Defaults
Headless inspection uses an isolated profile under `.naviquest/tmp/chrome/browser-state/` and a `1280x720` viewport (`--windowSize` overrides it) — Chrome's own headless default is a narrow size that collapses responsive sites into their mobile layout, which changes what the SDK indexes. Visible mode is for user-driven auth and keeps the OS window sizing. A real profile requires explicit user approval: CDP scripts then reach every cookie and session in it.

## Proxy
Proxy flags also require a fresh launch: `--proxyServer`, `--proxyBypassList`, `--proxyPacUrl`, or a `{ "proxy": { "server": … } }` file at `.naviquest/chrome.json` (auto-read) or `--config <path>`. Output with `"reused": true` and `"proxyRequested": true` means nothing was applied.

## Mobile
Launch window size sets outer dimensions only. For a real mobile emulation set CDP `Emulation` (viewport, DPR, touch, UA, locale, timezone) inside the script.

Next: `references/recovery.md` when a call errors or returns empty.
