import { readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { settleOnDeviceReader } from '../reader-prime.mjs';

// Run naviquest on the attached page and read the answer out of Chrome's own
// agent surface: install the SDK if the page does not ship it, then list or call
// the six tools over the WebMCP CDP domain — no DOM selectors, no clicks.
//
// Install and call live in ONE script on purpose. `Page.addScriptToEvaluateOnNewDocument`
// is scoped to the CDP session that added it, so a second process attaching
// later starts on a page whose injection is already gone (and the runner's
// stealth gate reloads on attach, which would wipe it anyway). Every run
// therefore re-installs, which costs one reload.
//
// Stage the bundle first: `node scripts/naviquest-build.mjs`.
//
// Requires Chrome launched with the WebMCP feature flag
// (`open-browser.mjs --enableFeatures WebMCPTesting`). Verified on Chrome 152.
//
// Env:
//   NQ_ACTION   'list' (default) | 'call'
//   NQ_TOOL     tool name, required for a single call
//   NQ_CALLS    JSON [{tool, input}, ...] — a SEQUENCE on one document, instead of NQ_TOOL/NQ_INPUT
//   NQ_INPUT    JSON string matching the tool's inputSchema (default {})
//   NQ_FRAME    frameId, only when a tool name collides across frames
//   NQ_INSTALL  path to the staged install script (default .naviquest/naviquest-install.js)
//   NQ_WAIT_MS  how long to wait for registration (default 15000)
//   NQ_PREVIEW  stdout characters of a returned payload (default 700); the artifact keeps all of it
//   NQ_PRIME    '0' to disable the extra calls a cold on-device reader needs (default on)
//   NQ_PRIME_MS how long to keep re-asking while that reader warms (default 30000)

const ACTION = process.env.NQ_ACTION ?? 'list';
const TOOL_NAME = process.env.NQ_TOOL ?? '';
const RAW_INPUT = process.env.NQ_INPUT ?? '{}';
const WANT_FRAME = process.env.NQ_FRAME ?? '';
const INSTALL_PATH = process.env.NQ_INSTALL
  ? resolve(process.env.NQ_INSTALL)
  : resolve(process.cwd(), '.naviquest', 'naviquest-install.js');
const WAIT_MS = Number.parseInt(process.env.NQ_WAIT_MS ?? '15000', 10);
const PREVIEW = Number.parseInt(process.env.NQ_PREVIEW ?? '700', 10);
const NQ_CALLS = process.env.NQ_CALLS ?? '';
const PRIME = process.env.NQ_PRIME !== '0';
const PRIME_MS = Number.parseInt(process.env.NQ_PRIME_MS ?? '30000', 10);
const PRIME_POLL_MS = 2000;
const CALL_TIMEOUT_MS = 30000;

const SIX_TOOLS = ['describe_app', 'find_on_page', 'locate_control',
                   'query_selector', 'resolve_address', 'agentic_content'];

/** What the page currently offers an agent, read in the page. `window` identity
 *  keeps a same-named tool from another frame out of the count. */
const PROBE = (waitMs) => `(async () => {
  const deadline = Date.now() + ${waitMs};
  const mc = document.modelContext;
  if (!mc || typeof mc.getTools !== 'function') return { modelContext: false, url: location.href, names: [] };
  let names = [];
  while (true) {
    const registered = await mc.getTools();
    names = registered.filter((tool) => tool.window === window && tool.name).map((tool) => tool.name);
    if (names.length >= 6 || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { modelContext: true, embedded: Boolean(window.naviquest), url: location.href, names };
})()`;

async function evaluate(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

// Unannotated or ambiguous tools default to the riskier label — a mutation gate
// only means something if "unknown" is treated as "assume it mutates".
const toolRisk = (tool) => (tool.annotations?.readOnly === true ? 'read-only' : 'mutating');

/** Every naviquest response declares what it spent. Print it: a tool that blew
 *  its budget otherwise looks identical to one that stayed inside it. */
function reportBudget(payload) {
  if (!payload || typeof payload !== 'object') return;
  const { _tokens: tokens, _budget: budget, _overBudget: over, _etag: etag } = payload;
  if (tokens === undefined && budget === undefined) return;
  console.log(`[METRIC] NAVIQUEST_BUDGET tokens=${tokens ?? 'n/a'} budget=${budget ?? 'n/a'} overBudget=${Boolean(over)}${etag ? ` etag=${etag}` : ''}`);
}

/** Returns `{ names, url }` for the settled document, installing the SDK when
 *  the page is missing any of the six tools. */
async function ensureNaviquest(cdp) {
  let state = await evaluate(cdp, PROBE(1000));
  if (!state.modelContext) {
    console.log(`[FINDING] NAVIQUEST_MODELCONTEXT_UNAVAILABLE document.modelContext is missing on ${state.url}`);
    console.log('[REASON] Chrome exposes the WebMCP surface only behind a feature flag, and flags apply to a fresh process: relaunch with open-browser.mjs --enableFeatures WebMCPTesting.');
    return null;
  }

  const complete = (names) => SIX_TOOLS.every((name) => names.includes(name));
  if (complete(state.names)) {
    console.log(`[FINDING] NAVIQUEST_PRESENT ${state.embedded ? 'page embeds the SDK' : 'six tools already registered'} on ${state.url}`);
    return { names: state.names, url: state.url };
  }

  let source;
  try {
    source = readFileSync(INSTALL_PATH, 'utf8');
  } catch (error) {
    console.log(`[FINDING] NAVIQUEST_INSTALL_MISSING ${INSTALL_PATH} — ${error.message}`);
    console.log('[REASON] Stage the bundle first: node scripts/naviquest-build.mjs (it writes .naviquest/naviquest-install.js, the one path the sandbox can read).');
    return null;
  }

  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
  console.log(`[METRIC] NAVIQUEST_INSTALL bytes=${source.length} path=${INSTALL_PATH}`);

  // An init script only runs for documents created after it is installed, so
  // the current document has to be replaced before the tools can exist.
  const loaded = new Promise((r) => {
    const handler = () => { cdp.off('Page.loadEventFired', handler); r(); };
    cdp.on('Page.loadEventFired', handler);
    setTimeout(r, Math.min(WAIT_MS, 30000));
  });
  console.log('[ACTION] reloading so the init script runs in a fresh document');
  await cdp.send('Page.reload', {});
  await loaded;

  state = await evaluate(cdp, PROBE(WAIT_MS));
  const missing = SIX_TOOLS.filter((name) => !state.names.includes(name));
  if (missing.length) {
    console.log(`[FINDING] NAVIQUEST_REGISTRATION_INCOMPLETE registered=${JSON.stringify(state.names)} missing=${JSON.stringify(missing)} url=${state.url}`);
    return null;
  }
  console.log(`[FINDING] NAVIQUEST_READY six tools installed on ${state.url}`);
  return { names: state.names, url: state.url };
}

export async function run(cdp) {
  if (!['list', 'call'].includes(ACTION)) throw new Error(`Unsupported NQ_ACTION=${ACTION}. Use list or call.`);
  if (ACTION === 'call' && !TOOL_NAME && !NQ_CALLS) throw new Error('NQ_ACTION=call needs NQ_TOOL, or NQ_CALLS for a sequence');

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const page = await ensureNaviquest(cdp);
  if (!page) return;
  console.log(`[METRIC] NAVIQUEST_TOOLS ${[...page.names].sort().join(',')}`);

  // From here on, everything goes through Chrome's own agent surface rather than
  // page JS: the same path a real WebMCP host would take.
  const tools = new Map();
  const key = (frameId, name) => `${frameId}::${name}`;
  cdp.on('WebMCP.toolsAdded', ({ tools: added }) => {
    for (const tool of added ?? []) tools.set(key(tool.frameId, tool.name), tool);
  });
  cdp.on('WebMCP.toolsRemoved', ({ tools: removed }) => {
    for (const tool of removed ?? []) tools.delete(key(tool.frameId, tool.name));
  });

  try {
    await cdp.send('WebMCP.enable');
  } catch (error) {
    console.log(`[FINDING] WEBMCP_DOMAIN_UNAVAILABLE ${error.message}`);
    // Enabling the domain grants a permission to the frame's origin, and a
    // file:// document's origin is opaque — measured on Chrome 152, not a build
    // problem. Serve the page over http instead.
    console.log('[REASON] On file:// URLs the domain cannot be enabled ("opaque origins") — serve the page over http://127.0.0.1. Otherwise relaunch Chrome with --enableFeatures WebMCPTesting.');
    return;
  }
  await new Promise((r) => setTimeout(r, 400));

  const toolList = [...tools.values()];
  const artifactPath = join(cdp.outputDir, 'naviquest-tools.json');
  // `page.url` is the document that actually registered, not the URL the runner
  // attached to: a redirect or the install reload can move it.
  writeFileSync(artifactPath, `${JSON.stringify({ url: page.url, tools: toolList }, null, 2)}\n`, { mode: 0o600 });
  cdp.upsertResourceMap?.('naviquest-tools', {
    type: 'naviquest-tools',
    targetUrl: page.url,
    toolCount: toolList.length,
    toolNames: toolList.map((t) => t.name),
    artifactPath,
  });

  if (toolList.length === 0) {
    console.log(`[FINDING] WEBMCP_NO_TOOLS the page registered ${page.names.length} tool(s) in its own realm, but the WebMCP domain reported none`);
    console.log('[REASON] Registration and the CDP view disagree — re-run; if it persists the Chrome build exposes document.modelContext without the CDP domain, and only the in-page path is usable.');
    return;
  }

  if (ACTION === 'list') {
    for (const tool of toolList) {
      console.log(`[WEBMCP_TOOL] name=${tool.name} risk=${toolRisk(tool)} frameId=${tool.frameId} description=${JSON.stringify(tool.description)}`);
      console.log(`[METRIC] WEBMCP_TOOL_SCHEMA name=${tool.name} inputSchema=${JSON.stringify(tool.inputSchema ?? {})}`);
    }
    console.log(`[ARTIFACT] NAVIQUEST_TOOLS ${artifactPath}`);
    return;
  }

  /** Resolve a registered tool by name, disambiguating across frames. */
  const resolveTool = (name) => {
    const matches = toolList.filter((t) => t.name === name);
    if (matches.length === 0) {
      console.log(`[FINDING] WEBMCP_TOOL_NOT_FOUND name=${name} available=${JSON.stringify(toolList.map((t) => t.name))}`);
      return null;
    }
    if (matches.length === 1) return matches[0];
    const disambiguated = WANT_FRAME ? matches.find((t) => t.frameId === WANT_FRAME) : null;
    if (!disambiguated) {
      console.log(`[FINDING] WEBMCP_TOOL_AMBIGUOUS name=${name} frames=${JSON.stringify(matches.map((t) => t.frameId))} — set NQ_FRAME to one of these`);
      return null;
    }
    return disambiguated;
  };

  // A SEQUENCE of calls on the document this process already attached to and
  // installed into. Each separate run of this script costs a reload, a fresh
  // index build and a cold reader — measured, three questions on one Wikipedia
  // article took 17.5 s as three runs and reloaded the page three times. They
  // are the same document's questions, so they belong in one run.
  let plan;
  try {
    plan = NQ_CALLS
      ? JSON.parse(NQ_CALLS)
      : [{ tool: TOOL_NAME, input: JSON.parse(RAW_INPUT) }];
  } catch (error) {
    console.log(`[FINDING] WEBMCP_INVALID_INPUT ${NQ_CALLS ? 'NQ_CALLS' : 'NQ_INPUT'} is not valid JSON: ${error.message}`);
    return;
  }
  if (!Array.isArray(plan) || plan.length === 0) {
    console.log('[FINDING] WEBMCP_INVALID_INPUT NQ_CALLS must be a non-empty array of {tool, input}');
    return;
  }
  const badStep = plan.findIndex((step) => !step || typeof step.tool !== 'string' || !step.tool);
  if (badStep !== -1) {
    console.log(`[FINDING] WEBMCP_INVALID_INPUT NQ_CALLS[${badStep}] needs a "tool" name`);
    return;
  }

  console.log(`[REASON] Calling ${plan.length === 1 ? `"${plan[0].tool}"` : `${plan.length} tools in sequence`} with explicit input — page code runs with page privileges, the same trust boundary as a real click.`);

  /** One `WebMCP.invokeTool` round trip, plus the tool's own JSON parsed out of
   *  Chrome's MCP content parts. */
  const invoke = async (tool, input, quiet = false) => {
    // Buffer responses from before the call goes out, so a response that arrives
    // faster than a filtered listener can be attached still counts instead of
    // producing a false Timeout.
    const buffer = new Map();
    const bufferResponse = (params) => buffer.set(params.invocationId, params);
    cdp.on('WebMCP.toolResponded', bufferResponse);

    const { invocationId } = await cdp.send('WebMCP.invokeTool', { frameId: tool.frameId, toolName: tool.name, input });
    if (!quiet) console.log(`[ACTION] called ${tool.name} invocationId=${invocationId}`);

    const responded = await new Promise((resolveResponse) => {
      const buffered = buffer.get(invocationId);
      if (buffered) {
        cdp.off('WebMCP.toolResponded', bufferResponse);
        resolveResponse(buffered);
        return;
      }
      const timer = setTimeout(() => {
        cdp.off('WebMCP.toolResponded', bufferResponse);
        cdp.off('WebMCP.toolResponded', liveHandler);
        cdp.send('WebMCP.cancelInvocation', { invocationId }).catch(() => {});
        resolveResponse({ status: 'Timeout', invocationId });
      }, CALL_TIMEOUT_MS);
      const liveHandler = (params) => {
        if (params.invocationId !== invocationId) return;
        clearTimeout(timer);
        cdp.off('WebMCP.toolResponded', bufferResponse);
        cdp.off('WebMCP.toolResponded', liveHandler);
        resolveResponse(params);
      };
      cdp.on('WebMCP.toolResponded', liveHandler);
    });

    // Chrome returns MCP content parts; the tool's own JSON is the text part.
    const text = responded.output?.content?.find((item) => item.type === 'text')?.text;
    let payload;
    if (typeof text === 'string') {
      try { payload = JSON.parse(text); } catch { payload = undefined; }
    }
    return { responded, text, payload };
  };

  const results = [];
  for (const [index, step] of plan.entries()) {
    const tool = resolveTool(step.tool);
    if (!tool) { results.push({ tool: step.tool, error: 'NOT_FOUND' }); continue; }
    const input = step.input ?? {};
    if (plan.length > 1) console.log(`[ACTION] step ${index + 1}/${plan.length}: ${step.tool} (risk=${toolRisk(tool)})`);

    let settled = await settleOnDeviceReader({
      current: await invoke(tool, input),
      invoke: () => invoke(tool, input, true),
      evaluate: (expression) => evaluate(cdp, expression),
      enabled: PRIME,
      timeoutMs: PRIME_MS,
      pollMs: PRIME_POLL_MS,
      log: console.log,
    });
    const { responded, text, payload } = settled;

    console.log(`[WEBMCP_RESULT] tool=${tool.name} status=${responded.status}`);
    // The verifier's own verdict, stated. An answer withheld as unsupported and
    // an answer nobody checked are different outcomes that otherwise look alike.
    if (payload && 'answer' in payload) {
      const stamp = payload.answer?.unverified;
      console.log(`[METRIC] NAVIQUEST_ANSWER verified=${payload.answer ? String(!stamp) : 'n/a'}${stamp ? ` unverified=${stamp}` : ''}`);
    }
    reportBudget(payload);
    const shown = typeof text === 'string' ? text : JSON.stringify(responded.output ?? null);
    console.log(`[WEBMCP_PAYLOAD] ${shown.slice(0, PREVIEW)}${shown.length > PREVIEW ? ` …(+${shown.length - PREVIEW} chars in artifact)` : ''}`);
    if (responded.status === 'Error') console.log(`[FINDING] WEBMCP_CALL_ERROR ${responded.errorText ?? 'unknown error'}`);
    if (responded.status === 'Timeout') console.log(`[FINDING] WEBMCP_CALL_TIMEOUT no toolResponded within ${CALL_TIMEOUT_MS}ms`);

    results.push({ tool: tool.name, input, status: responded.status, payload: payload ?? null, response: responded });
  }

  // One artifact per run. A sequence's steps belong together: the whole point is
  // that they share a document, and reading step 3 needs step 1's addresses.
  const resultPath = join(cdp.outputDir, 'naviquest-call.json');
  const artifact = plan.length === 1
    ? results[0].response // preserve the original single-call artifact contract
    : { url: page.url, calls: results.map(({ response: _response, ...call }) => call) };
  writeFileSync(resultPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  console.log(`[ARTIFACT] NAVIQUEST_CALL ${resultPath}`);
}
