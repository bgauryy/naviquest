// Bring Chrome's on-device AI models to `available` on the attached tab, before
// any tool call needs them.
//
// Why this is a separate step and not something a tool call can do for itself:
// creating a `downloadable` model IS the multi-gigabyte download, and the SDK
// only starts one while `navigator.userActivation.isActive` is true
// (packages/naviquest/src/ai/model-gate.ts). An agent tool call has no
// activation, so the SDK correctly declines and fails open to the lexical path.
// A run that wants the AI lanes has to warm them deliberately, which is this.
//
// Measured on Chrome 152, headless, over CDP (2026-09-03):
//   - the AI constructors do not exist on an opaque origin. On `about:blank`
//     every one of them is `undefined`; on an http(s) document they are present.
//     So this runs on the tab AS IT IS — navigate first, then warm, and warm the
//     SAME tab the run uses.
//   - `Runtime.evaluate` with `userGesture: true` sets
//     `navigator.userActivation.isActive`, which is what satisfies the gate.
//     This is the only reason a headless run can download the model at all.
//   - a cold `LanguageModel` download took 54.8 s and then reported
//     `available`, and a prompt round-tripped. It is NOT `unavailable` under
//     automation on this build.
//   - the model lands in the port-scoped profile (`OptGuideOnDeviceModel`, 4.2 GB)
//     and a relaunch on the same profile reports `available` with no download and
//     no gesture. So this is one cost per profile, not per run — and
//     `open-browser.mjs --cleanup` deletes it, buying the 55 s back next launch.
//
// `create()` is deliberately NOT awaited inside a single CDP call: on a cold
// profile it does not settle inside the runner's 60 s call timeout, and a
// timed-out `Runtime.evaluate` looks identical to a failed download. The
// promise is parked on the page and its progress polled instead.
//
// Requires the AI feature flags on a fresh process (references/chrome-flags.md).
//
// Env:
//   NQ_MODELS      comma-separated subset of LanguageModel,Summarizer,Translator,LanguageDetector
//                  (default LanguageModel — the one the verifier and answerer use)
//   NQ_WARM_MS     how long to wait for a download (default 300000)

const ALL = ['LanguageModel', 'Summarizer', 'Translator', 'LanguageDetector'];
const WANTED = (process.env.NQ_MODELS ?? 'LanguageModel')
  .split(',').map((name) => name.trim()).filter(Boolean);
const WARM_MS = Number.parseInt(process.env.NQ_WARM_MS ?? '300000', 10);
const POLL_MS = 5000;

// `Translator` refuses a bare `availability()` — it is a per-pair model, so it
// needs the pair it will be asked for. The other three take no options.
const OPTIONS = { Translator: { sourceLanguage: 'es', targetLanguage: 'en' } };

const unknown = WANTED.filter((name) => !ALL.includes(name));
if (unknown.length) throw new Error(`Unknown NQ_MODELS entries: ${unknown.join(',')}. Choose from ${ALL.join(',')}.`);

async function evaluate(cdp, expression, userGesture = false) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

const availability = (cdp, name) => evaluate(cdp, `(async () => {
  const ctor = globalThis[${JSON.stringify(name)}];
  if (typeof ctor === 'undefined') return 'absent';
  try { return await ctor.availability(${JSON.stringify(OPTIONS[name] ?? {})}); }
  catch (error) { return 'threw:' + error.message; }
})()`);

/** Park a `create()` on the page inside a gesture and report progress from the
 *  monitor, so a stalled download is distinguishable from a slow one. */
const startDownload = (cdp, name) => evaluate(cdp, `(() => {
  const slot = (window.__nqWarm ||= {});
  if (slot[${JSON.stringify(name)}]) return { already: true };
  const state = slot[${JSON.stringify(name)}] = { status: 'downloading', progress: 0, t0: Date.now() };
  globalThis[${JSON.stringify(name)}].create(Object.assign(${JSON.stringify(OPTIONS[name] ?? {})}, {
    monitor(m) { m.addEventListener('downloadprogress', (e) => { state.progress = e.loaded; }); },
  })).then((session) => {
    state.status = 'ready'; state.ms = Date.now() - state.t0;
    try { session.destroy?.(); } catch { /* nothing holds it; availability is what persists */ }
  }).catch((error) => {
    state.status = 'failed'; state.error = error.name + ': ' + error.message; state.ms = Date.now() - state.t0;
  });
  return { started: true, gesture: navigator.userActivation?.isActive === true };
})()`, true);

const progress = (cdp, name) => evaluate(cdp, `(window.__nqWarm?.[${JSON.stringify(name)}] ?? null)`);

async function warm(cdp, name) {
  const before = await availability(cdp, name);

  if (before === 'available') {
    console.log(`[FINDING] NAVIQUEST_MODEL_WARM ${name} already available — no download, this profile has it`);
    return true;
  }
  if (before === 'absent') {
    const url = await evaluate(cdp, 'location.href');
    console.log(`[FINDING] NAVIQUEST_MODEL_ABSENT ${name} is not defined on ${url}`);
    console.log('[REASON] The built-in AI constructors are missing on an opaque origin (measured: absent on about:blank, present on http(s)) and behind a feature flag. Navigate the tab to the real page first, and relaunch Chrome with the AI flags in references/chrome-flags.md.');
    return false;
  }
  if (before === 'unavailable') {
    console.log(`[FINDING] NAVIQUEST_MODEL_UNAVAILABLE ${name} reports unavailable`);
    console.log('[REASON] This is the SDK\'s one stable rejection — the device, build or options cannot run the model. Do not retry; run the lexical path and say AI was off.');
    return false;
  }
  if (typeof before === 'string' && before.startsWith('threw:')) {
    console.log(`[FINDING] NAVIQUEST_MODEL_PROBE_FAILED ${name} availability() ${before}`);
    return false;
  }

  const started = await startDownload(cdp, name);
  if (started?.started && started.gesture !== true) {
    // Without activation Chrome may accept the call and never settle, which
    // would otherwise be reported as a slow download rather than a wrong call.
    console.log(`[FINDING] NAVIQUEST_MODEL_NO_GESTURE ${name} create() ran without user activation`);
    console.log('[REASON] The download gate reads navigator.userActivation.isActive; this script passes Runtime.evaluate userGesture:true. Getting false here means the CDP call lost the gesture — re-run through cdp-runner.mjs.');
  }
  console.log(`[ACTION] ${name} is ${before} — downloading (up to ${WARM_MS}ms; a cold LanguageModel measured 54.8s)`);

  const deadline = Date.now() + WARM_MS;
  let last = -1;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const state = await progress(cdp, name);
    if (!state) break;
    if (state.status === 'ready') {
      const after = await availability(cdp, name);
      console.log(`[METRIC] NAVIQUEST_MODEL_WARM name=${name} ms=${state.ms} availability=${after}`);
      console.log(`[FINDING] NAVIQUEST_MODEL_WARM ${name} downloaded and is ${after}`);
      return after === 'available';
    }
    if (state.status === 'failed') {
      console.log(`[FINDING] NAVIQUEST_MODEL_DOWNLOAD_FAILED ${name} ${state.error} after ${state.ms}ms`);
      return false;
    }
    if (state.progress !== last) {
      last = state.progress;
      console.log(`[METRIC] NAVIQUEST_MODEL_PROGRESS name=${name} loaded=${(state.progress * 100).toFixed(1)}%`);
    }
  }

  const state = await progress(cdp, name);
  console.log(`[FINDING] NAVIQUEST_MODEL_WARM_TIMEOUT ${name} still ${state?.status ?? 'unknown'} at ${(100 * (state?.progress ?? 0)).toFixed(1)}% after ${WARM_MS}ms`);
  console.log('[REASON] The download is Chrome\'s, not the page\'s — it survives this script. Either raise NQ_WARM_MS and re-run (progress resumes), or run the lexical path and declare AI off.');
  return false;
}

export async function run(cdp) {
  await cdp.send('Runtime.enable');

  const warmed = [];
  const cold = [];
  for (const name of WANTED) ((await warm(cdp, name)) ? warmed : cold).push(name);

  console.log(`[METRIC] NAVIQUEST_MODELS warm=${warmed.join(',') || 'none'} cold=${cold.join(',') || 'none'}`);
  // Warming is an enabler, not an assertion: the SDK fails open to lexical, so a
  // cold model degrades the run instead of invalidating it. Say which it was.
  if (cold.length) console.log('[FINDING] NAVIQUEST_MODELS_PARTIAL some models stayed cold — AI-enriched answers will fail open to the lexical path');
}
