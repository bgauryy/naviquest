#!/usr/bin/env node

import { resolve, join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { outputBase } from './artifacts.mjs';
import { applyMandatoryStealth, stealthEnabled, isAboutOrDataUrl } from './mandatory-stealth.mjs';
import * as cdpClient from './cdp-client.mjs';

const OUTPUT_BASE = outputBase();
const argv      = process.argv.slice(2);
const scriptArg = argv.find(a => !a.startsWith('--') && (a.endsWith('.mjs') || a.endsWith('.js')));
const getArg    = (flag, def) => { const i = argv.indexOf(flag); return i !== -1 && argv[i + 1] ? argv[i + 1] : def; };
const hasFlag   = (flag) => argv.includes(flag);

const PORT        = getArg('--port', '9222');
const NEW_TAB     = getArg('--new-tab', '');
const TARGET_ID   = getArg('--target', '');
const TARGET_URL  = getArg('--target-url', '');
const TARGET_TYPE = getArg('--target-type', '');
const TIMEOUT     = parseInt(getArg('--timeout', '60000'), 10);
const KEEP_TAB    = hasFlag('--keep-tab');
const LIST_TARGETS = hasFlag('--list-targets');
const VERBOSE     = process.env.CDP_VERBOSE === '1';
if (hasFlag('--no-stealth')) process.env.CDP_NO_STEALTH = '1';

if (hasFlag('--help') || hasFlag('-h')) {
  console.error('[CDP_RUNNER] Usage: node cdp-runner.mjs <script.mjs> [--port 9222] [--new-tab <url>] [--target <id>] [--target-url <pattern>] [--target-type <type>] [--list-targets] [--keep-tab] [--no-stealth]');
  process.exit(0);
}

if (!scriptArg && !LIST_TARGETS) {
  console.error('[CDP_RUNNER] Usage: node cdp-runner.mjs <script.mjs> [--port 9222] [--new-tab <url>] [--target <id>] [--target-url <pattern>] [--target-type <type>] [--list-targets] [--keep-tab] [--no-stealth]');
  process.exit(1);
}

function readJson(filePath, fallback = null) {
  try { return JSON.parse(readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

// The protocol plumbing lives in cdp-client.mjs so a long-lived caller can hold
// the same session type; these bind it to this run's port and timeout.
try { cdpClient.requireWebSocket(); }
catch (e) { console.error(`[CDP_RUNNER] ${e.message}`); process.exit(1); }

const getVersion      = ()   => cdpClient.getVersion(PORT);
const getTargets      = ()   => cdpClient.getTargets(PORT);
const openTab         = (url) => cdpClient.openTab(PORT, url);
const activateTarget  = (id) => cdpClient.activateTarget(PORT, id);
const closeTab        = (id) => cdpClient.closeTab(PORT, id);

const createSession = (wsUrl, targetInfo) => cdpClient.createSession(wsUrl, targetInfo, {
  timeout: TIMEOUT,
  onHandlerError: (e) => console.error('[CDP_RUNNER] Handler error:', e.message),
});

let _cleanup = null;
function registerCleanup(fn) { _cleanup = fn; }

async function shutdown(signal) {
  console.error(`[CDP_RUNNER] ${signal} received - cleaning up...`);
  if (_cleanup) {
    try { await _cleanup(); } catch {}
  }
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function main() {
  let version;
  try {
    version = await getVersion();
  } catch {
    console.error(`[CDP_RUNNER] Chrome not responding on port ${PORT}. Run open-browser.mjs first.`);
    process.exit(1);
  }
  if (VERBOSE) console.error(`[CDP_RUNNER] Chrome: ${version.Browser}`);
  const sessionMetaDir = process.env.CDP_SESSION_META_DIR ?? (() => {
    const dir = join(OUTPUT_BASE, 'tmp', 'chrome', 'session-meta', `port-${PORT}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  })();
  mkdirSync(sessionMetaDir, { recursive: true, mode: 0o700 });
  const sessionMetaFile = join(sessionMetaDir, 'session-metadata.json');
  const targetSnapshotFile = join(sessionMetaDir, 'targets-latest.json');

  if (LIST_TARGETS) {
    const nowIso = new Date().toISOString();
    const targets = await getTargets();
    writeJson(targetSnapshotFile, {
      capturedAt: nowIso,
      port: PORT,
      targets: targets.map(t => ({
        id: t.id ?? null,
        type: t.type ?? null,
        url: t.url ?? null,
        title: t.title ?? null,
      })),
    });
    const existingMeta = readJson(sessionMetaFile, {}) ?? {};
    writeJson(sessionMetaFile, {
      ...existingMeta,
      port: PORT,
      browser: version.Browser,
      lastListedTargetsAt: nowIso,
      updatedAt: nowIso,
    });
    console.log(JSON.stringify(targets.map(t => ({
      id: t.id, type: t.type, url: t.url, title: t.title,
    })), null, 2));
    process.exit(0);
  }

  let targetWsUrl, targetInfo, openedTabId;
  let pendingNavigate = null;

  if (NEW_TAB) {
    const tabUrl = NEW_TAB;
    const openUrl = stealthEnabled() && !isAboutOrDataUrl(tabUrl) ? 'about:blank' : tabUrl;
    if (openUrl !== tabUrl) pendingNavigate = tabUrl;
    const tab  = await openTab(openUrl);
    openedTabId = tab.id;
    targetWsUrl = tab.webSocketDebuggerUrl;
    targetInfo  = { id: tab.id, url: tab.url, title: tab.title, type: tab.type };
    console.error(`[CDP_RUNNER] Opened new tab (${tab.id}) -> ${openUrl}${pendingNavigate ? ` (pending ${pendingNavigate})` : ''}`);
    await new Promise(r => setTimeout(r, 800));

  } else if (TARGET_ID) {
    const targets = await getTargets();
    const t = targets.find(x => x.id === TARGET_ID);
    if (!t) { console.error(`[CDP_RUNNER] Target ${TARGET_ID} not found`); process.exit(1); }
    targetWsUrl = t.webSocketDebuggerUrl;
    targetInfo  = t;
    await activateTarget(TARGET_ID).catch(() => {});

  } else if (TARGET_URL) {
    const targets = await getTargets();
    const pool    = TARGET_TYPE ? targets.filter(t => t.type === TARGET_TYPE) : targets;
    const t       = pool.find(x => x.url && x.url.includes(TARGET_URL));
    if (!t) {
      const available = targets.map(x => `  [${x.type}] ${x.url}`).join('\n');
      console.error(`[CDP_RUNNER] No target URL matching "${TARGET_URL}". Available targets:\n${available}`);
      process.exit(1);
    }
    targetWsUrl = t.webSocketDebuggerUrl;
    targetInfo  = t;
    console.error(`[CDP_RUNNER] Matched target [${t.type}]: ${t.url}`);

  } else if (TARGET_TYPE) {
    const targets = await getTargets();
    const t       = targets.find(x => x.type === TARGET_TYPE);
    if (!t) {
      const available = [...new Set(targets.map(x => x.type))].join(', ');
      console.error(`[CDP_RUNNER] No target of type "${TARGET_TYPE}". Available types: ${available}`);
      process.exit(1);
    }
    targetWsUrl = t.webSocketDebuggerUrl;
    targetInfo  = t;
    console.error(`[CDP_RUNNER] Matched target [${t.type}]: ${t.url}`);

  } else {
    const targets = await getTargets();
    const pages   = targets.filter(t => t.type === 'page');
    if (pages.length === 0) {
      console.error('[CDP_RUNNER] No page targets. Open a tab in Chrome first, or use --new-tab <url>');
      process.exit(1);
    }
    const t = pages[0];
    targetWsUrl = t.webSocketDebuggerUrl;
    targetInfo  = t;
    console.error(`[CDP_RUNNER] Using tab: ${t.url}`);
  }

  if (!targetWsUrl) {
    console.error('[CDP_RUNNER] Could not get WebSocket URL for target');
    process.exit(1);
  }

  const cdp = await createSession(targetWsUrl, targetInfo);

  const outputDir = process.env.CDP_OUTPUT_DIR ?? (() => {
    const ts  = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const dir = join(OUTPUT_BASE, 'tmp', 'chrome', ts);
    mkdirSync(dir, { recursive: true });
    return dir;
  })();
  const runLogFile = join(sessionMetaDir, 'run-history.json');
  const existingMeta = readJson(sessionMetaFile, {}) ?? {};
  const nowIso = new Date().toISOString();
  const baseMeta = {
    ...existingMeta,
    port: PORT,
    browser: version.Browser,
    lastConnectedAt: nowIso,
    outputDir,
    lastScript: scriptArg,
    currentTarget: {
      id: targetInfo.id ?? null,
      type: targetInfo.type ?? null,
      url: targetInfo.url ?? null,
      title: targetInfo.title ?? null,
      via: NEW_TAB ? 'new-tab' : TARGET_ID ? 'target' : TARGET_URL ? 'target-url' : TARGET_TYPE ? 'target-type' : 'first-page',
    },
    lastSelection: {
      newTab: NEW_TAB || null,
      targetId: TARGET_ID || null,
      targetUrl: TARGET_URL || null,
      targetType: TARGET_TYPE || null,
      keepTab: KEEP_TAB,
    },
    updatedAt: nowIso,
  };
  writeJson(sessionMetaFile, baseMeta);

  const currentTargets = await getTargets().catch(() => []);
  writeJson(targetSnapshotFile, {
    capturedAt: nowIso,
    port: PORT,
    targets: currentTargets.map(t => ({
      id: t.id ?? null,
      type: t.type ?? null,
      url: t.url ?? null,
      title: t.title ?? null,
      attached: t.id === targetInfo.id,
    })),
  });

  const runHistory = readJson(runLogFile, { runs: [] }) ?? { runs: [] };
  if (!Array.isArray(runHistory.runs)) runHistory.runs = [];
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  runHistory.runs.push({
    id: runId,
    startedAt: nowIso,
    script: scriptArg,
    outputDir,
    target: baseMeta.currentTarget,
    status: 'running',
  });
  if (runHistory.runs.length > 100) runHistory.runs = runHistory.runs.slice(-100);
  writeJson(runLogFile, runHistory);
  const finalizeRun = (status, extra = {}) => {
    const current = readJson(runLogFile, { runs: [] }) ?? { runs: [] };
    if (!Array.isArray(current.runs)) current.runs = [];
    const idx = current.runs.findIndex(r => r.id === runId);
    if (idx !== -1) {
      current.runs[idx] = {
        ...current.runs[idx],
        status,
        finishedAt: new Date().toISOString(),
        ...extra,
      };
      writeJson(runLogFile, current);
    }
  };

  cdp.outputDir = outputDir;
  cdp.sessionMetaDir = sessionMetaDir;
  cdp.sessionMetaFile = sessionMetaFile;
  cdp.targetSnapshotFile = targetSnapshotFile;
  cdp.resourcesFile = join(sessionMetaDir, 'resource-map.json');
  cdp.reasoningFile = join(sessionMetaDir, 'reasoning-log.json');
  cdp.addReasoningStep = (step) => {
    const payload = readJson(cdp.reasoningFile, { steps: [] }) ?? { steps: [] };
    if (!Array.isArray(payload.steps)) payload.steps = [];
    payload.steps.push({
      at: new Date().toISOString(),
      ...step,
    });
    if (payload.steps.length > 300) payload.steps = payload.steps.slice(-300);
    writeJson(cdp.reasoningFile, payload);
    return payload.steps.length;
  };
  cdp.upsertResourceMap = (resourceKey, details) => {
    const payload = readJson(cdp.resourcesFile, { updatedAt: null, resources: {} }) ?? { updatedAt: null, resources: {} };
    if (!payload.resources || typeof payload.resources !== 'object') payload.resources = {};
    payload.resources[resourceKey] = {
      ...(payload.resources[resourceKey] ?? {}),
      ...details,
      updatedAt: new Date().toISOString(),
    };
    payload.updatedAt = new Date().toISOString();
    writeJson(cdp.resourcesFile, payload);
    return payload.resources[resourceKey];
  };
  cdp.readSessionMetadata = () => readJson(cdp.sessionMetaFile, {});
  cdp.writeSessionMetadata = (patch) => {
    const current = readJson(cdp.sessionMetaFile, {}) ?? {};
    const next = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    writeJson(cdp.sessionMetaFile, next);
    return next;
  };
  if (VERBOSE) {
    console.error(`[CDP_RUNNER] Output dir: ${outputDir}`);
    console.error(`[CDP_RUNNER] Session meta dir: ${sessionMetaDir}`);
    console.error(`[CDP_RUNNER] Connected - running ${scriptArg}`);
  }

  // Scripts use CDP over local Chrome only. Blocking arbitrary outbound
  // fetch/WebSocket keeps a check script from quietly becoming a network
  // client: everything a page says must arrive through the browser, which is
  // the only surface the skill claims to measure.
  const _origFetch = globalThis.fetch;
  const _OrigWS    = globalThis.WebSocket;
  function isLocalhost(url) {
    try {
      const h = new URL(String(url)).hostname;
      return h === 'localhost' || h === '127.0.0.1' || h === '::1';
    } catch { return false; }
  }
  globalThis.fetch = function restrictedFetch(input, init) {
    const url = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : input?.url ?? '';
    if (!isLocalhost(url)) {
      throw new Error(`[SANDBOX] fetch blocked: only localhost allowed (attempted: ${url})`);
    }
    return _origFetch(input, init);
  };
  globalThis.WebSocket = class RestrictedWebSocket extends _OrigWS {
    constructor(url, ...args) {
      if (!isLocalhost(url)) {
        throw new Error(`[SANDBOX] WebSocket blocked: only localhost allowed (attempted: ${url})`);
      }
      super(url, ...args);
    }
  };

  registerCleanup(async () => {
    cdp.close();
    if (openedTabId && !KEEP_TAB) {
      const closed = await closeTab(openedTabId);
      console.error(`[CDP_RUNNER] Tab ${openedTabId} ${closed ? 'closed' : 'already gone'}`);
    }
  });

  const scriptPath = resolve(process.cwd(), scriptArg);
  if (!existsSync(scriptPath)) {
    console.error(`[CDP_RUNNER] Script not found: ${scriptPath}`);
    cdp.writeSessionMetadata({ lastRunStatus: 'error', lastError: `Script not found: ${scriptPath}` });
    finalizeRun('error', { error: `Script not found: ${scriptPath}` });
    await _cleanup?.();
    process.exit(1);
  }

  let mod;
  try {
    mod = await import(pathToFileURL(scriptPath).href);
  } catch (e) {
    console.error(`[CDP_RUNNER] Failed to load script: ${e.message}`);
    cdp.writeSessionMetadata({ lastRunStatus: 'error', lastError: e.message });
    finalizeRun('error', { error: e.message });
    await _cleanup?.();
    process.exit(1);
  }

  if (typeof mod.run !== 'function') {
    console.error('[CDP_RUNNER] Script must export: export async function run(cdp) { ... }');
    cdp.writeSessionMetadata({
      lastRunStatus: 'error',
      lastError: 'Script must export: export async function run(cdp) { ... }',
    });
    finalizeRun('error', { error: 'missing run(cdp) export' });
    await _cleanup?.();
    process.exit(1);
  }

  try {
    if (stealthEnabled()) {
      await applyMandatoryStealth(cdp, { navigateUrl: pendingNavigate ?? undefined });
      if (pendingNavigate) {
        console.error(`[CDP_RUNNER] Stealth gate: navigating to ${pendingNavigate}`);
        await cdp.send('Page.navigate', { url: pendingNavigate });
        await new Promise((r) => setTimeout(r, 2500));
        if (targetInfo) targetInfo = { ...targetInfo, url: pendingNavigate };
      } else if (/^https?:/i.test(targetInfo?.url ?? '') && process.env.CDP_STEALTH_NO_RELOAD !== '1') {
        // applyMandatoryStealth already reloaded; skip second reload for http(s) attach
      }
    }
  } catch (stealthErr) {
    console.error(`[CDP_RUNNER] ${stealthErr.message}`);
    cdp.writeSessionMetadata({ lastRunStatus: 'error', lastError: stealthErr.message });
    finalizeRun('error', { error: stealthErr.message });
    await _cleanup?.();
    process.exit(1);
  }

  let exitCode = 0;
  try {
    await mod.run(cdp);
    cdp.writeSessionMetadata({ lastRunStatus: 'success' });
    finalizeRun('success');
    if (VERBOSE) console.error('[CDP_RUNNER] Script completed successfully');
  } catch (e) {
    const isCdpError = /CDP error \[|CDP timeout/.test(e.message);
    if (isCdpError) {
      const methodMatch = e.message.match(/for:\s*(\S+)/) ?? e.message.match(/'([A-Z][a-zA-Z]+\.[a-zA-Z]+)'/);
      const method = methodMatch ? methodMatch[1] : 'unknown';
      console.log(`[CDP_RETRY_NEEDED] method=${method} error="${e.message}"`);
      console.log(`[CDP_RETRY_NEEDED] Fix: ensure the domain for "${method}" is enabled before calling it, check parameter names, and re-run.`);
      cdp.writeSessionMetadata({
        lastRunStatus: 'retry-needed',
        lastError: e.message,
        lastErrorMethod: method,
      });
      finalizeRun('retry-needed', { error: e.message, errorMethod: method });
      exitCode = 2;
    } else {
      console.error(`[CDP_RUNNER] Script error: ${e.message}`);
      if (e.stack) console.error(e.stack);
      cdp.writeSessionMetadata({
        lastRunStatus: 'error',
        lastError: e.message,
      });
      finalizeRun('error', { error: e.message });
      exitCode = 1;
    }
  } finally {
    await _cleanup?.();
    _cleanup = null;
  }

  process.exit(exitCode);
}

main().catch(async e => {
  console.error('[CDP_RUNNER_FATAL]', e.message);
  if (_cleanup) { try { await _cleanup(); } catch {} }
  process.exit(1);
});
