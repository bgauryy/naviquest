#!/usr/bin/env node
// Grader for the skill: does naviquest actually run in Chrome?
//
//   node scripts/cdp-checks/naviquest.check.mjs [--port 9245]
//
// Deterministic and offline: serves the plain fixture over http from a separate
// process, launches an isolated headless Chrome with the WebMCP flag, installs
// the SDK into a page that ships none, then asserts exact prefixed stdout lines
// from `naviquest.mjs`. Exit 0 = green, 1 = red.

import { spawn, spawnSync } from 'child_process';
import { createInterface } from 'readline';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(__dir, '../..');
const OPEN_BROWSER = join(SKILL_DIR, 'scripts', 'open-browser.mjs');
const SANDBOX = join(SKILL_DIR, 'scripts', 'cdp-sandbox.mjs');
const BUILD = join(SKILL_DIR, 'scripts', 'naviquest-build.mjs');
const HOST = join(SKILL_DIR, 'scripts', 'naviquest-host.mjs');
const NAVIQUEST = join(__dir, 'naviquest.mjs');
const FIXTURE_SERVER = join(__dir, 'fixtures', 'fixture-server.mjs');

const argv = process.argv.slice(2);
const getArg = (flag, def) => { const i = argv.indexOf(flag); return i !== -1 && argv[i + 1] ? argv[i + 1] : def; };
const PORT = getArg('--port', '9245');
const HOST_PORT = String(Number(PORT) + 1000);

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: Boolean(cond) });
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${cond ? '' : detail ? ` — ${detail}` : ''}`);
}

function run(cmd, args, env = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', cwd: SKILL_DIR, env: { ...process.env, ...env } });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status };
}

const cleanupBrowser = () => run(process.execPath, [OPEN_BROWSER, '--port', PORT, '--cleanup']);

const fixtureProcess = spawn(process.execPath, [FIXTURE_SERVER], { stdio: ['ignore', 'pipe', 'inherit'] });
const fixtureUrl = await new Promise((resolveUrl, rejectUrl) => {
  const timer = setTimeout(() => rejectUrl(new Error('fixture server did not print an origin within 10s')), 10000);
  createInterface({ input: fixtureProcess.stdout }).once('line', (line) => { clearTimeout(timer); resolveUrl(line.trim()); });
});
console.log(`[CHECK] port ${PORT}, fixture ${fixtureUrl}`);

const naviquest = (env) => run(process.execPath, [SANDBOX, NAVIQUEST, '--port', PORT, '--target-url', '127.0.0.1', '--keep-tab'], env);
let hostProcess;

try {
  const build = run(process.execPath, [BUILD]);
  let buildInfo = {};
  try { buildInfo = JSON.parse(build.stdout.trim().split('\n').pop()); } catch {}
  check('install script builds from SDK source', buildInfo.status === 'INSTALL_SCRIPT_READY' && buildInfo.bytes > 10000, build.stdout || build.stderr);

  cleanupBrowser();
  const launch = run(process.execPath, [
    OPEN_BROWSER, '--headless', '--port', PORT, '--enableFeatures', 'WebMCPTesting', '--url', fixtureUrl,
  ]);
  let launchInfo = {};
  try { launchInfo = JSON.parse(launch.stdout.trim().split('\n').pop()); } catch {}
  // BROWSER_READY alone isn't enough: open-browser reports it for a silently
  // reused Chrome too, where --enableFeatures never took effect. A port occupied
  // by something else has to fail here rather than misattribute later failures.
  const launched = launchInfo.status === 'BROWSER_READY'
    && launchInfo.reused === false
    && launchInfo.enableFeaturesConfigured === 'WebMCPTesting';
  check('fresh Chrome launches with the WebMCP flag', launched, JSON.stringify(launchInfo));

  if (launched && buildInfo.status === 'INSTALL_SCRIPT_READY') {
    const list = naviquest({ NQ_ACTION: 'list' });
    const listed = ['describe_app', 'find_on_page', 'locate_control', 'query_selector', 'resolve_address', 'agentic_content']
      .filter((name) => new RegExp(`\\[WEBMCP_TOOL\\][^\\n]*name=${name}\\b`).test(list.stdout));
    check('list exits 0', list.status === 0, `exit=${list.status} ${list.stderr.slice(-300)}`);
    check('SDK installs into a page that ships none', /\[FINDING\] NAVIQUEST_READY/.test(list.stdout), list.stdout.slice(0, 800));
    check('all six tools reach Chrome\'s agent surface', listed.length === 6, `found ${listed.join(',') || 'none'}`);

    const find = naviquest({ NQ_ACTION: 'call', NQ_TOOL: 'find_on_page', NQ_PREVIEW: '4000', NQ_INPUT: '{"query":"when does the library close"}' });
    check('find_on_page completes', /\[WEBMCP_RESULT\][^\n]*status=Completed/.test(find.stdout), find.stdout.slice(0, 800));
    check('find_on_page answers from page text', /6 p\.m\. on weekdays/.test(find.stdout), find.stdout.slice(0, 1500));
    check('response declares its token budget', /\[METRIC\] NAVIQUEST_BUDGET tokens=\d+/.test(find.stdout), find.stdout.slice(0, 800));

    const locate = naviquest({ NQ_ACTION: 'call', NQ_TOOL: 'locate_control', NQ_PREVIEW: '4000', NQ_INPUT: '{"description":"renew my parking permit"}' });
    check('locate_control finds the fixture button', /Renew a parking permit/.test(locate.stdout), locate.stdout.slice(0, 1500));

    const sequence = naviquest({
      NQ_ACTION: 'call',
      NQ_PREVIEW: '4000',
      NQ_CALLS: '[{"tool":"find_on_page","input":{"query":"when does the library close"}},{"tool":"locate_control","input":{"description":"renew my parking permit"}}]',
    });
    const reloads = (sequence.stdout.match(/\[ACTION\] reloading/g) ?? []).length;
    check('NQ_CALLS runs multiple tools on one document', /step 1\/2: find_on_page/.test(sequence.stdout)
      && /step 2\/2: locate_control/.test(sequence.stdout)
      && /6 p\.m\. on weekdays/.test(sequence.stdout)
      && /Renew a parking permit/.test(sequence.stdout), sequence.stdout.slice(0, 1800));
    check('NQ_CALLS pays one install reload', reloads === 1, `reloads=${reloads}`);

    // Wrong input must come back as INVALID_INPUT, not as a crash or as
    // NOT_FOUND: an agent that cannot tell them apart retries forever.
    const bad = naviquest({ NQ_ACTION: 'call', NQ_TOOL: 'find_on_page', NQ_PREVIEW: '600', NQ_INPUT: '{"query":""}' });
    check('empty query is rejected as invalid input', /INVALID_INPUT|WEBMCP_CALL_ERROR/.test(bad.stdout), bad.stdout.slice(0, 800));

    const hostBuild = run(process.execPath, [BUILD, '--bundle-only']);
    check('host bundle builds from the same SDK source', /"status":"BUNDLE_READY"/.test(hostBuild.stdout), hostBuild.stdout || hostBuild.stderr);
    hostProcess = spawn(process.execPath, [HOST, '--port', HOST_PORT, '--cdp-port', PORT], {
      cwd: SKILL_DIR,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const hostReady = await new Promise((resolveReady) => {
      const timer = setTimeout(() => resolveReady(false), 10000);
      createInterface({ input: hostProcess.stdout }).once('line', (line) => {
        clearTimeout(timer);
        resolveReady(/NAVIQUEST_HOST_READY/.test(line));
      });
    });
    check('general host starts on the existing CDP browser', hostReady);
    if (hostReady) {
      const post = async (path, body, method = 'POST') => {
        const response = await fetch(`http://127.0.0.1:${HOST_PORT}${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return response.json();
      };
      const hosted = await post('/session', { requireModel: false });
      const opened = await post('/call', { session: hosted.id, tool: 'open', input: { url: fixtureUrl } });
      const answered = await post('/call', {
        session: hosted.id,
        tool: 'find_on_page',
        input: { query: 'when does the library close' },
      });
      check('general host opens a page with all six WebMCP tools', opened.result?.tools?.length === 6, JSON.stringify(opened));
      check('general host returns a Naviquest answer', /6 p\.m\. on weekdays/.test(answered.result?.answer?.text ?? ''), JSON.stringify(answered).slice(0, 1000));

      // REGRESSION (2026-09-03): the install script runs per document, so a page
      // with iframes registers the six NAMES once per frame. The host used to
      // require exactly one match and threw "resolved to N frames" on every
      // call — every tool broke on any page with an embed (measured on
      // react.dev and vuejs.org in eval/research). Assert both that the call
      // succeeds AND that it answers from the MAIN frame: the sub-frames carry a
      // decoy 11 p.m. closing time, so reading the wrong frame fails loudly.
      const framedUrl = new URL('framed-page.html', fixtureUrl).href;
      const framedOpen = await post('/call', { session: hosted.id, tool: 'open', input: { url: framedUrl } });
      const framedAnswer = await post('/call', {
        session: hosted.id,
        tool: 'find_on_page',
        input: { query: 'when does the library close' },
      });
      const framedText = JSON.stringify(framedAnswer);
      check('a page with iframes still registers the six tools', framedOpen.result?.tools?.length === 6, JSON.stringify(framedOpen).slice(0, 600));
      check('a tool call on a framed page does not fail as ambiguous', !/resolved to \d+ frames/.test(framedText), framedText.slice(0, 400));
      check('a framed page answers from the MAIN frame, not an embed',
        /6 p\.m\. on weekdays/.test(framedText) && !/11 p\.m\./.test(framedText), framedText.slice(0, 600));

      await post(`/session/${hosted.id}`, undefined, 'DELETE');
    }
  }
} finally {
  hostProcess?.kill();
  cleanupBrowser();
  fixtureProcess.kill();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n[CHECK] ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
