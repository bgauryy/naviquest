#!/usr/bin/env node

/**
 * Long-lived, general Naviquest host.
 *
 * Owns the reusable runtime boundary: one Chrome tab per session, SDK injection
 * before navigation, WebMCP-domain tool invocation, model preflight, and
 * page-local reader settlement. Callers own questions, orchestration, metrics,
 * persistence, and evaluation policy.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createSession, closeTab, getVersion, openTab } from './cdp-client.mjs';
import { onDeviceModelState, settleOnDeviceReader } from './reader-prime.mjs';

const argv = process.argv.slice(2);
const getArg = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index !== -1 && argv[index + 1] ? argv[index + 1] : fallback;
};
const HOST_PORT = Number(getArg('--port', process.env.NQ_HOST_PORT || '5340'));
const CDP_PORT = Number(getArg('--cdp-port', process.env.CDP_PORT || '9222'));
const BUNDLE_PATH = resolve(getArg('--bundle', process.env.NQ_BUNDLE || '.naviquest/naviquest-bundle.js'));
const SIX_TOOLS = new Set(['describe_app', 'find_on_page', 'locate_control', 'query_selector', 'resolve_address', 'agentic_content']);
const sessions = new Map();

if (!Number.isInteger(HOST_PORT) || !Number.isInteger(CDP_PORT)) {
  throw new Error('--port and --cdp-port must be integers');
}

const bundle = await readFile(BUNDLE_PATH, 'utf8').catch(() => {
  throw new Error(`SDK bundle missing at ${BUNDLE_PATH}. Run scripts/naviquest-build.mjs --bundle-only first.`);
});
const browser = await getVersion(CDP_PORT).catch(() => {
  throw new Error(`Chrome is not reachable on CDP port ${CDP_PORT}. Launch it with scripts/open-browser.mjs first.`);
});

const reply = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(payload)}\n`);
};

const readBody = (req) => new Promise((resolveBody, rejectBody) => {
  let text = '';
  req.on('data', (chunk) => {
    text += chunk;
    if (text.length > 1_000_000) {
      rejectBody(new Error('request body exceeds 1 MB'));
      req.destroy();
    }
  });
  req.on('end', () => {
    try { resolveBody(text ? JSON.parse(text) : {}); }
    catch (error) { rejectBody(new Error(`invalid JSON: ${error.message}`)); }
  });
  req.on('error', rejectBody);
});

const evaluate = async (session, expression) => {
  const reading = await session.cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (reading.exceptionDetails) {
    throw new Error(reading.exceptionDetails.exception?.description || reading.exceptionDetails.text || 'Runtime.evaluate failed');
  }
  return reading.result?.value;
};

const waitForLoad = (session, timeoutMs = 45_000) => new Promise((resolveLoad) => {
  const done = () => {
    clearTimeout(timer);
    session.cdp.off('Page.loadEventFired', done);
    resolveLoad();
  };
  const timer = setTimeout(done, timeoutMs);
  session.cdp.on('Page.loadEventFired', done);
});

const installSource = (config) => `${bundle}
;(()=>{window.naviquest=WQ.createNaviquest(${JSON.stringify(config)});void(async()=>{for(let attempt=0;attempt<400;attempt++){const result=await window.naviquest.register();if(result.registered)return;await new Promise(resolve=>setTimeout(resolve,25));}})();})();`;

async function createHostSession(options) {
  const config = options?.config ?? {};
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config must be an object');
  const target = await openTab(CDP_PORT, 'about:blank');
  const cdp = await createSession(target.webSocketDebuggerUrl, target);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: installSource(config) });

  const session = {
    id: randomUUID(),
    cdp,
    targetId: target.id,
    tools: new Map(),
    webmcpEnabled: false,
    requireModel: options?.requireModel === true,
    primeReader: options?.primeReader !== false,
    primeTimeoutMs: Number(options?.primeTimeoutMs || 30_000),
    url: 'about:blank',
  };
  cdp.on('WebMCP.toolsAdded', ({ tools }) => {
    for (const tool of tools ?? []) session.tools.set(`${tool.frameId}::${tool.name}`, tool);
  });
  cdp.on('WebMCP.toolsRemoved', ({ tools }) => {
    for (const tool of tools ?? []) session.tools.delete(`${tool.frameId}::${tool.name}`);
  });
  sessions.set(session.id, session);
  return session;
}

async function openPage(session, url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('open requires an http(s) URL');
  session.tools.clear();
  const loaded = waitForLoad(session);
  await session.cdp.send('Page.navigate', { url: parsed.href });
  await loaded;

  if (!session.webmcpEnabled) {
    await session.cdp.send('WebMCP.enable');
    session.webmcpEnabled = true;
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && [...SIX_TOOLS].some((name) => ![...session.tools.values()].some((tool) => tool.name === name))) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  const names = [...new Set([...session.tools.values()].map((tool) => tool.name))];
  const missing = [...SIX_TOOLS].filter((name) => !names.includes(name));
  if (missing.length) throw new Error(`Naviquest registration incomplete on ${parsed.href}; missing ${missing.join(', ')}`);

  const modelState = session.requireModel
    ? await onDeviceModelState((expression) => evaluate(session, expression))
    : undefined;
  if (session.requireModel && modelState !== 'available') {
    throw new Error(`requireModel=true needs LanguageModel=available on ${parsed.href}; got ${modelState}. Warm this Chrome profile through model-warm.mjs.`);
  }
  session.url = parsed.href;
  // The install script runs on EVERY new document, so a page with iframes
  // (react.dev, vuejs.org — sandboxed embeds) registers the six tools once per
  // frame. Record the main frame so invokeWebMCP can address the page the caller
  // actually opened instead of refusing an ambiguous name.
  session.mainFrameId = await session.cdp.send('Page.getFrameTree')
    .then((tree) => tree?.frameTree?.frame?.id)
    .catch(() => undefined);
  return {
    opened: parsed.href,
    title: await evaluate(session, 'document.title'),
    tools: names.sort(),
    ...(modelState ? { modelState } : {}),
  };
}

async function invokeWebMCP(session, toolName, input) {
  if (!SIX_TOOLS.has(toolName)) throw new Error(`unknown Naviquest tool: ${toolName}`);
  const matches = [...session.tools.values()].filter((tool) => tool.name === toolName);
  // Iframes register the same six names (the install script runs per document),
  // so ambiguity is the NORMAL state on any page with an embed — it used to fail
  // every call on react.dev/vuejs.org. The caller opened one page: address its
  // MAIN frame and treat sub-frame registrations as noise. Only a genuinely
  // absent tool, or ambiguity with no identifiable main frame, is an error.
  const tool = matches.length === 1
    ? matches[0]
    : matches.find((candidate) => candidate.frameId === session.mainFrameId);
  if (!tool) {
    throw new Error(matches.length === 0
      ? `${toolName} is not registered on ${session.url}`
      : `${toolName} resolved to ${matches.length} frames and none is the main frame; use a frame-aware one-off CDP script`);
  }
  const responses = [];
  const onResponse = (response) => responses.push(response);
  session.cdp.on('WebMCP.toolResponded', onResponse);
  try {
    const { invocationId } = await session.cdp.send('WebMCP.invokeTool', {
      frameId: tool.frameId,
      toolName,
      input: input ?? {},
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const response = responses.find((item) => item.invocationId === invocationId);
      if (response) {
        const text = response.output?.content?.find((item) => item.type === 'text')?.text;
        let payload; let parseError;
        try { payload = typeof text === 'string' ? JSON.parse(text) : null; }
        catch (error) { payload = null; parseError = String(error?.message || error); }
        // A tool that answers with anything other than JSON — an error string, a
        // refusal, an empty result — used to arrive here as a bare `null`, which
        // told the caller nothing: `{"result":null}` with `status: Completed` and
        // no message. Measured on the Transformer article, where `find_on_page`
        // with a query the page cannot answer returned null while a matching
        // query returned a payload; the eval could not tell "no match" from
        // "tool broken". Carry the raw text and the parse error instead, so the
        // caller can see WHAT the tool said. Never be confidently silent.
        return { responded: response, text, payload, parseError };
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    await session.cdp.send('WebMCP.cancelInvocation', { invocationId }).catch(() => {});
    throw new Error(`${toolName} timed out after 30000ms`);
  } finally {
    session.cdp.off('WebMCP.toolResponded', onResponse);
  }
}

async function callTool(session, tool, input) {
  if (tool === 'open') return { result: await openPage(session, input?.url) };
  if (session.url === 'about:blank') throw new Error('open an http(s) page before calling a Naviquest tool');

  const invoke = () => invokeWebMCP(session, tool, input);
  const settled = await settleOnDeviceReader({
    current: await invoke(),
    invoke,
    evaluate: (expression) => evaluate(session, expression),
    enabled: session.primeReader,
    timeoutMs: session.primeTimeoutMs,
  });
  return {
    result: settled.payload,
    meta: {
      reader: settled.outcome,
      attempts: settled.attempts,
      status: settled.responded?.status,
      // Present ONLY when the tool did not return JSON, so a null `result` is
      // always explainable rather than silent (see invokeWebMCP).
      ...(settled.payload == null
        ? {
          rawText: typeof settled.text === 'string' ? settled.text.slice(0, 2000) : null,
          ...(settled.parseError ? { parseError: settled.parseError } : {}),
          // The whole response envelope, not just its text part. Measured
          // 2026-09-03: `find_on_page` with a query the page cannot answer
          // comes back with NO text content — `isError` and the content shape
          // are the only things that distinguish "no match" from "threw", and
          // both were being thrown away.
          isError: settled.responded?.output?.isError ?? null,
          contentTypes: (settled.responded?.output?.content ?? []).map((item) => item?.type),
        }
        : {}),
    },
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      reply(res, 200, {
        ok: true,
        transport: 'webmcp-cdp',
        browser: browser.Browser,
        cdpPort: CDP_PORT,
        sessions: sessions.size,
        tools: [...SIX_TOOLS],
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/session') {
      const session = await createHostSession(await readBody(req));
      reply(res, 200, { id: session.id });
      return;
    }
    if (req.method === 'POST' && req.url === '/call') {
      const body = await readBody(req);
      const session = sessions.get(body.session);
      if (!session) { reply(res, 404, { error: 'unknown session' }); return; }
      const started = performance.now();
      const output = await callTool(session, body.tool, body.input ?? body.args ?? {});
      reply(res, 200, { ...output, ms: Math.round(performance.now() - started) });
      return;
    }
    if (req.method === 'DELETE' && req.url?.startsWith('/session/')) {
      const id = decodeURIComponent(req.url.slice('/session/'.length));
      const session = sessions.get(id);
      if (!session) { reply(res, 404, { error: 'unknown session' }); return; }
      sessions.delete(id);
      session.cdp.close();
      await closeTab(CDP_PORT, session.targetId);
      reply(res, 200, { closed: id });
      return;
    }
    reply(res, 404, { error: 'not found' });
  } catch (error) {
    reply(res, 400, { error: String(error?.message || error).slice(0, 500) });
  }
});

async function shutdown() {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map(async (session) => {
    session.cdp.close();
    await closeTab(CDP_PORT, session.targetId);
  }));
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(HOST_PORT, '127.0.0.1', () => {
  console.log(JSON.stringify({
    status: 'NAVIQUEST_HOST_READY',
    url: `http://127.0.0.1:${HOST_PORT}`,
    browser: browser.Browser,
    cdpPort: CDP_PORT,
    bundle: BUNDLE_PATH,
  }));
});
