/**
 * The one eval.
 *
 *   yarn eval                  # offline gates. Exits 1 on any failure.
 *   yarn eval --live           # gates, then the live six-tool probe against MDN.
 *   yarn eval --only contracts # one lane (surface|roles|contracts|invariants|crawl)
 *   yarn eval --verbose        # per-comparison detail from the roles oracle
 *
 * This replaced twenty `eval:*` scripts. The split that survived the merge is
 * the only one that was ever load-bearing: GATES are deterministic and offline,
 * so they may fail a build; the LIVE lane needs the network and a page that can
 * change under it, so AGENTS.md classifies it as a sensor and it never runs by
 * default. Folding a sensor into a gate would make a Wikipedia outage look like
 * a broken SDK, which is why `--live` is opt-in rather than the default.
 *
 * Lanes:
 *   surface     TOOL_SPECS token ceiling. The instruction surface is paid on
 *               every getTools() and ships in the bundle.
 *   roles       roles.ts vs aria-query in real Chrome. roles.ts maps HTML to
 *               implicit ARIA by hand because computedRole does not exist;
 *               AGENTS.md calls it the riskiest module in the package.
 *   contracts   The six-tool behavioural surface against a local fixture.
 *   invariants  All six tools driven on real MDN pages: budget adherence,
 *               address round-trip, cursor integrity, bounded text. (--live)
 */
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import * as esbuild from 'esbuild';
import * as aria from 'aria-query';
import { TOOL_SPECS } from '../packages/naviquest/src/tools/tool-specs.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO, 'eval/out');
const VERBOSE = process.argv.includes('--verbose');
const LIVE = process.argv.includes('--live');
const ONLY = process.argv[process.argv.indexOf('--only') + 1];
/** Point the live lane at any origin: `yarn eval --live --url https://react.dev/learn`.
 *  The invariants are page-independent, so they hold anywhere; only the frozen
 *  MDN retrieval questions are skipped, because their gold lives on MDN. */
const URL_ARG = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : undefined;
const wanted = (lane: string) => !ONLY || ONLY === lane || process.argv.indexOf('--only') < 0;

/** One tally for every lane, so the process exit code has a single source. */
let pass = 0;
let fail = 0;
const failures: string[] = [];
const check = (name: string, condition: unknown, detail?: unknown) => {
  if (condition) { pass++; console.log(`  ok   ${name}`); return; }
  fail++; failures.push(name);
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
};

const bundleSdk = (globalName: string) => esbuild.build({
  entryPoints: [path.join(REPO, 'packages/naviquest/src/index.ts')],
  bundle: true, write: false, format: 'iife', globalName,
  platform: 'browser', target: 'es2023', legalComments: 'none',
  define: { 'import.meta.url': '"about:blank"' },
}).then((built) => built.outputFiles[0].text);

// ─────────────────────────────────────────────────────────────────────────────
// LANE: surface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Measured from the real registration objects, not a regex over tools.ts: a
 * scan missed the shared ADDRESS_INPUT description and any schema assembled by
 * a helper. Re-measured 2026-09-01 at ~1,787 tokens; 2,200 leaves room for
 * routing fixes without letting the old ~3,189-token surface back in unnoticed.
 */
const SURFACE_CEILING = 2200;

function laneSurface() {
  console.log('\n=== surface: tool instruction budget ===');
  let total = 0;
  for (const definition of TOOL_SPECS) {
    const tokens = Math.ceil(JSON.stringify(definition).length / 4);
    total += tokens;
    if (VERBOSE) console.log(`  ${definition.name.padEnd(22)} ~${tokens} tok`);
  }
  check(`six tools registered (received ${TOOL_SPECS.length})`, TOOL_SPECS.length === 6, TOOL_SPECS.length);
  check(`instruction surface ~${total} tok within ${SURFACE_CEILING}`, total <= SURFACE_CEILING,
    { total, ceiling: SURFACE_CEILING, over: total - SURFACE_CEILING });
}

// ─────────────────────────────────────────────────────────────────────────────
// LANE: roles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * roles.ts differs from aria-query here ON PURPOSE. Key is `tag` or
 * `tag[type=...]`. `role` is what roles.ts returns; `reason` is why. Kept in
 * lock-step with the comments in roles.ts — if you change one, change both.
 * A divergence on this list is reported and passes; one that is NOT on it fails,
 * so the oracle catches exactly the defect no other check can see: roles.ts
 * drifting from both the spec and its own documented intent.
 */
const DIVERGENCES: Record<string, { role: string; reason: string }> = {
  'input[type=file]': { role: 'button', reason: 'opens a file picker — an agent clicks it, so button beats aria-query\'s no-role' },
  'input[type=hidden]': { role: 'generic', reason: 'nothing to address; generic keeps it out of the interactive index' },
  'input[type=password]': { role: 'textbox', reason: 'agent types into it; aria-query gives no role' },
  'input[type=date]': { role: 'textbox', reason: 'native Date role no agent vocabulary knows; textbox stays actionable' },
  'input[type=datetime-local]': { role: 'textbox', reason: 'as date' },
  'input[type=time]': { role: 'textbox', reason: 'native InputTime role; textbox stays actionable' },
  'input[type=month]': { role: 'textbox', reason: 'as date' },
  'input[type=week]': { role: 'textbox', reason: 'as date' },
  'input[type=color]': { role: 'textbox', reason: 'native ColorWell role; textbox stays actionable' },
  'input[type=email]': { role: 'textbox', reason: 'reported as textbox; combobox only with a list attribute' },
  'input[type=tel]': { role: 'textbox', reason: 'as email' },
  'input[type=url]': { role: 'textbox', reason: 'as email' },
  // aria-query maps a bare <input> (no type) via input[type=text]; roles.ts
  // defaults the same way. Not a divergence, listed for the reader.

  // SCOPE, not a bug. roles.ts's opening line: "this covers the elements that
  // actually carry meaning for an agent." An agent does not act on inline
  // formatting and does not search for "the emphasis" — text.ts already lifts
  // the text content of these into the chunk. Mapping them to `generic` keeps
  // them out of the control index by design. Locked here so a future edit that
  // accidentally promotes one is caught.
  em: { role: 'generic', reason: 'inline formatting — not actionable; text is indexed via text.ts' },
  strong: { role: 'generic', reason: 'inline formatting — not actionable' },
  mark: { role: 'generic', reason: 'inline formatting — not actionable' },
  sub: { role: 'generic', reason: 'inline formatting — not actionable' },
  sup: { role: 'generic', reason: 'inline formatting — not actionable' },
  del: { role: 'generic', reason: 'edit semantics — not actionable' },
  ins: { role: 'generic', reason: 'edit semantics — not actionable' },
  time: { role: 'generic', reason: 'inline datum — text is indexed, no action' },
  html: { role: 'generic', reason: 'document root — nothing an agent addresses' },
  address: { role: 'generic', reason: 'grouping only — no action, text indexed' },
  optgroup: { role: 'generic', reason: 'a <select> is addressed as one control; the group is not' },
  math: { role: 'generic', reason: 'MathML subtree unreadable as text; reported via opaque regions, not a role' },
  meter: { role: 'generic', reason: 'read-only gauge — takes no input; progressbar is deliberately non-actionable too' },
  blockquote: { role: 'generic', reason: 'quotation — text is indexed, no action' },
  caption: { role: 'generic', reason: 'table/figure caption — text is indexed with its table, no action' },
  code: { role: 'generic', reason: 'inline code — text is indexed, no action' },

  // KNOWN SIMPLIFICATIONS — flagged in the summary as candidate real gaps, not
  // silently blessed. roles.ts does not model these; the safe/actionable choice
  // was taken. Each is a measured follow-up, not a defect today.
  aside: { role: 'complementary', reason: 'GAP? roles.ts does not downgrade an unnamed sectioning-scoped <aside> to generic; complementary is the safe landmark choice' },
  area: { role: 'generic', reason: 'GAP? an <area href> is a navigable image-map link; roles.ts leaves it generic — rare, worth a measured check' },
  menu: { role: 'generic', reason: 'GAP? <menu> is a list per HTML-AAM; roles.ts leaves it generic — near-extinct element' },
  datalist: { role: 'generic', reason: 'GAP? <datalist> is the listbox behind input[list]; the input is what an agent uses, so generic is defensible' },
};

type RoleSpec = { key: string; tag: string; attrs: [string, string][]; wrap: string | null; expected: string };

/** Build the fixture from aria-query, skipping constraints roleOf cannot model
 *  from the element alone (explicit-role ancestors, grid/treegrid tables). */
function buildRoleFixture(): { specs: RoleSpec[]; skipped: number } {
  const specs: RoleSpec[] = [];
  let skipped = 0;
  for (const [el, roles] of aria.elementRoles.entries()) {
    const expected = [...roles][0];
    if (!expected) { skipped++; continue; }
    const tag: string = el.name;
    // Honour ATTRIBUTE-LEVEL constraints. aria-query encodes presence/absence in
    // the attribute itself: `constraints:['undefined']` means the attribute must
    // be ABSENT for this mapping, `['set']` means present, `['>1']` a numeric
    // floor. Blindly setting every listed attribute fabricated the state the
    // mapping requires to NOT hold — which turned every text input into a
    // combobox and every unnamed <section> into a region against the oracle.
    const attrs: [string, string][] = [];
    for (const a of (el.attributes ?? []) as any[]) {
      const cons: string[] = a.constraints ?? [];
      if (cons.includes('undefined')) continue;           // must be absent
      if (cons.includes('>1')) { attrs.push([a.name, '2']); continue; }
      if (cons.includes('set')) { attrs.push([a.name, 'x']); continue; } // present, non-empty
      attrs.push([a.name, a.value ?? 'x']);
    }
    // Scope constraints are OR'd across an entry. Resolve to a single wrapper,
    // preferring one roles.ts recognises as sectioning (article/main), so the
    // generic header/footer/aside mappings can actually be reached.
    const cs = new Set<string>(el.constraints ?? []);
    let wrap: string | null = null;
    let unmodellable = false;
    if (cs.has('scoped to a sectioning content element')) wrap = 'article';
    else if (cs.has('scoped to the main element')) wrap = 'main';
    else if (cs.has('scoped to the body element')) wrap = 'body';
    else if (cs.has('scoped to a sectioning root element other than body')) wrap = 'article';
    else if (cs.has('direct descendant of ol')) wrap = 'ol';
    else if (cs.has('direct descendant of ul')) wrap = 'ul';
    else if (cs.has('direct descendant of menu')) wrap = 'menu';
    else if (cs.has('ancestor table element has table role')) wrap = 'table-row';
    for (const c of cs) {
      if (c.startsWith('ancestor table element has grid')
        || c.startsWith('ancestor table element has treegrid')) unmodellable = true;
    }
    if (unmodellable) { skipped++; continue; }
    const typeAttr = attrs.find(([n]) => n === 'type')?.[1];
    const key = tag === 'input' && typeAttr ? `${tag}[type=${typeAttr}]` : tag;
    specs.push({ key, tag, attrs, wrap, expected });
  }
  return { specs, skipped };
}

async function laneRoles(browser: Browser) {
  console.log('\n=== roles: roles.ts vs aria-query in real Chrome ===');
  const built = await esbuild.build({
    stdin: { contents: `export { roleOf } from ${JSON.stringify(path.join(REPO, 'packages/naviquest/src/page/roles.ts'))};`,
             resolveDir: REPO, loader: 'ts' },
    bundle: true, write: false, format: 'iife', globalName: 'ROLES',
    platform: 'browser', target: 'es2023', legalComments: 'none',
  });
  const { specs, skipped } = buildRoleFixture();
  const page = await browser.newPage();
  let got: string[];
  try {
    await page.goto('data:text/html,<!doctype html><title>oracle</title>');
    await page.addScriptTag({ content: built.outputFiles[0].text });
    got = await page.evaluate((specs: RoleSpec[]) => {
      const roleOf = (window as any).ROLES.roleOf;
      return specs.map((s) => {
        const el = document.createElement(s.tag);
        for (const [n, v] of s.attrs) el.setAttribute(n, v);
        // A name-by-reference needs a referenced element that actually has text,
        // or roles.ts's hasAuthorName() correctly reports no name and the
        // mapping that depends on one (section -> region) never fires.
        let ref: Element | null = null;
        const lb = el.getAttribute('aria-labelledby');
        if (lb) { ref = document.createElement('span'); ref.id = lb; ref.textContent = 'label'; document.body.appendChild(ref); }
        let host: Element = el;
        if (s.wrap === 'body') { document.body.appendChild(el); }
        else if (s.wrap === 'table-row') {
          const t = document.createElement('table'); const tr = document.createElement('tr');
          tr.appendChild(el); t.appendChild(tr); document.body.appendChild(t); host = t;
        } else if (s.wrap) {
          const w = document.createElement(s.wrap); w.appendChild(el); document.body.appendChild(w); host = w;
        } else { document.body.appendChild(el); }
        const r = roleOf(el);
        host.remove(); ref?.remove();
        return r;
      });
    }, specs);
  } finally {
    await page.close();
  }

  let agree = 0; const documented: string[] = []; const drift: string[] = [];
  specs.forEach((s, i) => {
    const actual = got[i];
    if (actual === s.expected) { agree++; if (VERBOSE) console.log(`       ${s.key.padEnd(24)} ${actual}`); return; }
    const d = DIVERGENCES[s.key];
    if (d && d.role === actual) {
      documented.push(`${s.key.padEnd(24)} aria-query:${s.expected} → roles.ts:${actual}  (${d.reason})`);
      return;
    }
    drift.push(`${s.key.padEnd(24)} aria-query expects "${s.expected}", roles.ts returned "${actual}"`);
  });
  const gaps = documented.filter((d) => d.includes('GAP?'));
  console.log(`       ${agree}/${specs.length} implicit roles agree with the spec`);
  console.log(`       ${documented.length - gaps.length} documented divergence(s), ${gaps.length} flagged gap(s), ${skipped} unmodellable entry(ies) skipped`);
  if (VERBOSE) for (const d of documented) console.log(`         ${d}`);
  for (const d of drift) console.log(`       DRIFT ${d}`);
  check('roles.ts matches aria-query or a listed, reasoned divergence',
    drift.length === 0,
    drift.length ? { undocumented: drift.length, first: drift[0] } : undefined);
}

// ─────────────────────────────────────────────────────────────────────────────
// LANE: contracts
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURE_HTML = `<!doctype html><html lang="en"><head><title>Contract fixture</title>
  <base href="/base/"></head><body><main>
  <a id="early-status" href="/early">Early text before any heading</a>
  <h1>Contract fixture</h1>
  <nav aria-label="Fixture navigation">
    <a id="live-link" href="guide" target="_blank" rel="help" download="guide.txt">Guide page</a>
    <a href="#search">Skip to search</a>
  </nav>
  <section><h2>Search</h2><button id="search">Search the site</button></section>
  <section><h2>Parent only</h2><h3>Child criterion</h3><p>${'Nested criterion evidence. '.repeat(700)}</p></section>
  <label>Consent <input id="consent" type="checkbox"></label>
  <label>Secret <input id="secret" type="password" value="classified"></label>
  <div role="dialog" aria-modal="true" hidden><button>Inactive modal action</button></div>
  <p id="status">Before action</p>
  <p id="mdn-prose">when creating <code>Summarizer</code> objects (<a href="#act">transient user activation</a> is required). Use <code>Summarizer.create()</code> then <code>summarize()</code>.</p>
  <section>
    <h2>Emit surface</h2>
    <div id="styled-heading" role="heading" aria-level="3">Pay <span>now</span></div>
    <p id="under-styled">Permit refund policy lives under the styled heading.</p>
    <button type="button" id="pay-phrasing">Pay <span>now</span></button>
    <p id="mdn-caption">Rate is <code>12%</code> per <a href="#y">year</a></p>
    <p id="big-prose">${'Refund clause sentence carrying budget pressure. '.repeat(200)}</p>
  </section>
  <section><h2>Unreadable map previews</h2>
    <img src="map-a.png" width="16" height="16"><img src="map-b.png" width="16" height="16"><img src="map-c.png" width="16" height="16">
  </section>
  <div data-private><button>Private action</button><p>private phrase</p></div>
  </main></body></html>`;

// Separate fixtures for the nav-chrome (#2) and weak-structure (#3) plan fixes,
// kept out of FIXTURE_HTML so its budget- and threshold-tuned checks are
// undisturbed. #2: bold menu labels inside declared chrome landmarks are
// inferred-heading bait that used to fabricate the outline; authored <h*> in
// <main> must survive. #3: a large but weakly-structured page must be declined.
const CHROME_FIXTURE = `<!doctype html><html lang="en"><title>chrome</title>
  <style>.menu{font-size:24px;font-weight:700}</style>
  <header><div class="menu">Log In Sign Up</div>
    <nav aria-label="Primary"><div class="menu">Sign Up</div><a href="/a">Products</a></nav></header>
  <main><h1>Crypto the easy way</h1>
    <p>Buy, hold and sell cryptocurrency directly with your balance, protected with encryption at rest.</p>
    <h2>Fees</h2><p>There is a spread of one point five percent in every transaction and no monthly charge.</p></main>`;
// Deliberately past declineBelowTreeTokens (2000): the point of #3 is that a
// LARGE weakly-structured page is declined where the size gate alone stays silent.
const WEAK_FIXTURE = `<!doctype html><html lang="en"><title>weak</title><body>${
  Array.from({ length: 140 }, (_, i) => `<div>Item ${i} is a full sentence of prose carrying genuinely retrievable content about a distinct product topic numbered ${i} on this page.</div>`).join('')
}</body>`;
const STRONG_FIXTURE = `<!doctype html><html lang="en"><title>strong</title><main>
  <h1>Guide</h1><h2>Installation</h2><p>Install the package and import the entry point before rendering anything.</p>
  <h2>Configuration</h2><p>Every option has a documented default and can be overridden at construction time.</p>
  <h2>Usage</h2><p>Call the primary method with a query and read the returned region, not the whole document.</p></main>`;

async function laneContracts(browser: Browser) {
  console.log('\n=== contracts: deterministic six-tool surface ===');
  const BUNDLE = await bundleSdk('WQ');
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/llms.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('# Fixture\n## References\n- [Guide resource](/guide.md): Agent-readable source\n');
    } else if (url === '/guide.md') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('# Guide resource\nAgent content.');
    } else if (url === '/chrome' || url === '/weak' || url === '/strong') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(url === '/chrome' ? CHROME_FIXTURE : url === '/weak' ? WEAK_FIXTURE : STRONG_FIXTURE);
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(FIXTURE_HTML);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const page = await browser.newPage();
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: BUNDLE });
    const result = await page.evaluate(async () => {
      const WQ: any = (window as any).WQ;
      const wq: any = WQ.createNaviquest({ exclude: ['[data-private]'],
        tuning: { adaptiveBudget: { enabled: false }, budgets: { describe_app: 900 } } });

      const located = await wq.tools.locate_control({ description: 'search', limit: 4 });
      const searchButton = located.candidates?.find((x: any) => x.role === 'button');
      const linkFound = await wq.tools.locate_control({ description: 'guide page', role: 'link', limit: 1 });
      const liveLink = document.querySelector('#live-link') as HTMLAnchorElement;
      const firstResolved = await wq.tools.resolve_address({ address: linkFound.candidates[0].address });
      liveLink.setAttribute('href', '../changed?x=1#now');
      const secondResolved = await wq.tools.resolve_address({ address: linkFound.candidates[0].address });

      const docs = await wq.tools.agentic_content({ intent: 'find', query: 'guide resource', limit: 2 });
      const docsNavigate = await wq.tools.agentic_content({ intent: 'find', query: 'guide resource', goal: 'navigate', limit: 2 });
      const fallbackWq: any = WQ.createNaviquest({ tuning: { agentic: { paths: ['/missing.txt'] } } });
      const fallback = await fallbackWq.tools.agentic_content({ intent: 'find', query: 'guide page', limit: 2 });
      const fallbackRead = await fallbackWq.tools.agentic_content({
        intent: 'read', url: fallback.matches?.[0]?.url,
      });
      const unknownRead = await fallbackWq.tools.agentic_content({ intent: 'read', url: `${location.origin}/admin` });
      const baseline = await wq.tools.describe_app();
      const consent = document.querySelector('#consent') as HTMLInputElement;
      consent.checked = true; // deliberately no event
      document.querySelector('#status')!.textContent = 'After action';
      (document.querySelector('#search') as HTMLButtonElement).focus();
      const changes = await wq.tools.describe_app({ changesSince: baseline._observation });
      const unchanged = await wq.tools.describe_app({ changesSince: changes._observation });
      const malformed = await wq.tools.describe_app({ changesSince: 4 });
      const mixed = await wq.tools.describe_app({ changesSince: baseline._observation, opaque: true });

      (document.querySelector('#search') as HTMLButtonElement).blur();
      const rerenderBase = await wq.tools.describe_app();
      document.querySelector('#search')!.replaceWith(document.querySelector('#search')!.cloneNode(true));
      const rerender = await wq.tools.describe_app({ changesSince: rerenderBase._observation });

      const capped: any = WQ.createNaviquest({ tuning: { delta: { semanticHistory: 1, maxSemanticChanges: 2 },
        adaptiveBudget: { enabled: false }, budgets: { describe_app: 900 } } });
      const capBase = await capped.tools.describe_app();
      for (let i = 0; i < 5; i++) {
        const button = document.createElement('button'); button.textContent = `Added ${i}`; document.querySelector('main')!.appendChild(button);
      }
      const cappedChanges = await capped.tools.describe_app({ changesSince: capBase._observation });
      const expired = await capped.tools.describe_app({ changesSince: capBase._observation });

      const manual: any = WQ.createNaviquest({ autoReindex: false });
      const manualBase = await manual.tools.describe_app();
      const late = document.createElement('button'); late.textContent = 'Manual late control'; document.querySelector('main')!.appendChild(late);
      const manualChanges = await manual.tools.describe_app({ changesSince: manualBase._observation });

      const firstInstance: any = WQ.createNaviquest({});
      const secondInstance: any = WQ.createNaviquest({});
      const firstInstanceBase = await firstInstance.tools.describe_app();
      await secondInstance.tools.describe_app();
      document.title = 'Second instance changed';
      const crossInstance = await secondInstance.tools.describe_app({ changesSince: firstInstanceBase._observation });

      const malformedTuning: any = WQ.createNaviquest({ tuning: { delta: {
        semanticHistory: Number.POSITIVE_INFINITY, maxSemanticChanges: Number.NaN,
      } } });
      const malformedBases = [];
      for (let i = 0; i < 6; i++) malformedBases.push(await malformedTuning.tools.describe_app());
      (document.querySelector('#consent') as HTMLInputElement).checked = false;
      const malformedCap = await malformedTuning.tools.describe_app({
        changesSince: malformedBases[malformedBases.length - 1]._observation,
      });
      const malformedExpiry = await malformedTuning.tools.describe_app({
        changesSince: malformedBases[0]._observation,
      });

      const regionBase = await wq.tools.describe_app();
      document.querySelector('#early-status')!.textContent = 'Changed early text before any heading';
      const regionChange = await wq.tools.describe_app({ changesSince: regionBase._observation });

      // Outcome channel: after an action the page reports success/failure two
      // ways — a live-region toast and field-level validation. Both must reach
      // the agent as TEXT, not a char delta and a bare `invalid:true`.
      const outcomeHost = document.createElement('div');
      outcomeHost.innerHTML =
        '<form><label>Postcode <input id="oc-field" type="text"></label>'
        + '<p id="oc-err" hidden>Postcode must be a valid UK format</p></form>'
        + '<div id="oc-live" role="alert"></div>';
      document.body.appendChild(outcomeHost);
      const outcomeWq: any = WQ.createNaviquest({ tuning: { adaptiveBudget: { enabled: false }, budgets: { describe_app: 1200 } } });
      const outcomeBase = await outcomeWq.tools.describe_app();
      const ocField = document.querySelector('#oc-field') as HTMLInputElement;
      ocField.setAttribute('aria-invalid', 'true');
      ocField.setAttribute('aria-errormessage', 'oc-err');
      document.querySelector('#oc-err')!.removeAttribute('hidden');
      document.querySelector('#oc-live')!.textContent = 'Could not save: 1 error';
      const outcomeChange = await outcomeWq.tools.describe_app({ changesSince: outcomeBase._observation });

      // Settle signal: an aria-busy region means the page is still re-rendering,
      // so describe_app flags `settling`; a quiet page (busy cleared, mutation
      // window elapsed) does not. This is what stops an agent reading a spinner
      // as the outcome of its action.
      const busyHost = document.createElement('div');
      busyHost.setAttribute('role', 'status'); busyHost.setAttribute('aria-busy', 'true');
      busyHost.textContent = 'Saving…';
      document.body.appendChild(busyHost);
      const settleBusy = await wq.tools.describe_app();
      busyHost.setAttribute('aria-busy', 'false');
      await new Promise((r) => setTimeout(r, 320)); // outlast settleQuietMs (250)
      const settleQuiet = await wq.tools.describe_app();

      // Form-as-a-unit: query_selector({view:'forms'}) rolls a form up to its
      // required/filled/invalid tally + submit control, so an agent knows what
      // is left to fill without N locate_control calls.
      const formHost = document.createElement('div');
      formHost.innerHTML = '<form id="signup-fixture" aria-label="Signup Fixture">'
        + '<label>User <input required></label>'
        + '<label>Email <input required value="taken@x.com"></label>'
        + '<label>Zip <input aria-invalid="true" value="bad"></label>'
        + '<label>Consent <input type="checkbox"></label>'
        + '<input type="submit" value="Create account">'
        + '<div role="textbox" aria-label="Custom note" aria-required="true" aria-readonly="true" tabindex="0"></div>'
        + '</form><label>External <input form="signup-fixture" required value="linked"></label>';
      document.body.appendChild(formHost);
      const formsView = await wq.tools.query_selector({ view: 'forms' });
      const formsPage = await wq.tools.query_selector({ view: 'forms', limit: 1 });
      const insertedForm = document.createElement('form');
      insertedForm.setAttribute('aria-label', 'Inserted before continuation');
      insertedForm.innerHTML = '<input>';
      document.body.prepend(insertedForm);
      await Promise.resolve();
      const formsStale = await wq.tools.query_selector(formsPage.pagination.next[0].arguments);

      let invalidExclude = '';
      try { WQ.createNaviquest({ exclude: ['['] }); }
      catch (error) { invalidExclude = String((error as Error)?.message ?? error); }

      // New recovery contracts are deliberately deterministic. Disabling answer
      // extraction creates the exact dangerous state from the Devpost trace —
      // ranked evidence exists, but the SDK cannot support an answer — without
      // tuning a fixture sentence to the answer engine's current thresholds.
      const evidenceOnlyWq: any = WQ.createNaviquest({ tuning: { answer: { enabled: false } } });
      const evidenceOnly = await evidenceOnlyWq.tools.find_on_page({ query: 'contract fixture', limit: 2 });
      const parentSearch = await evidenceOnlyWq.tools.find_on_page({ query: 'Parent only', limit: 3 });
      const phrasingSearch = await wq.tools.find_on_page({ query: 'transient user activation', limit: 5 });
      const methodSearch = await wq.tools.find_on_page({ query: 'Summarizer.create', limit: 5 });
      const phrasingExact = await wq.tools.query_selector({ selector: '#mdn-prose', fields: ['text'], limit: 2 });
      const payButton = await wq.tools.locate_control({ description: 'pay now', limit: 5 });
      const styledSearch = await wq.tools.find_on_page({ query: 'Permit refund policy', limit: 5 });
      const captionExact = await wq.tools.query_selector({ selector: '#mdn-caption', fields: ['text'], limit: 2 });
      const bigSelectorText = await wq.tools.query_selector({ selector: '#big-prose', fields: ['text', 'address'], limit: 2 });
      const unindexedMatch = await wq.tools.query_selector({ selector: 'title', fields: ['tag', 'address'], limit: 2 });
      const outline = await wq.tools.describe_app({ section: 'outline', limit: 20 });
      const parentOutline = outline.results?.find((x: any) => x.text === 'Parent only');
      const parentRead = parentOutline?.address
        ? await wq.tools.resolve_address({ address: parentOutline.address, expand: true }) : null;
      const parentNext = parentRead?.pagination?.next?.[0];
      const parentResumed = parentNext
        ? await wq.tools.resolve_address(parentNext.arguments)
        : null;
      const exactAction = await wq.tools.query_selector({ view: 'actions', name: 'Guide page', limit: 20 });
      const exactHeading = await wq.tools.query_selector({ view: 'structure', heading: 'Search', limit: 20 });

      // Freshness regressions: these populations grow AFTER construction. A
      // tool that sizes or reads them before ensureFresh() silently omits the
      // new control/link even though the shared index was rebuilt in that call.
      const lateButton = document.createElement('button');
      lateButton.textContent = 'Launch dynamic report';
      document.querySelector('main')!.appendChild(lateButton);
      const lateLink = document.createElement('a');
      lateLink.href = '/dynamic-report'; lateLink.textContent = 'Dynamic report handbook';
      document.querySelector('main')!.appendChild(lateLink);
      await Promise.resolve(); // deliver MutationObserver records
      const freshControl = await wq.tools.locate_control({ description: 'launch dynamic report', limit: 4 });
      const freshFallback = await fallbackWq.tools.agentic_content({
        intent: 'find', query: 'dynamic report handbook', limit: 4,
      });

      // A removed region is a normal stale-address miss, not a malformed tool
      // call. It must use the same outcome/status/hint shape as a control miss.
      const disposable = document.createElement('section');
      disposable.innerHTML = '<h2>Disposable region</h2><p>Ephemeral region evidence.</p>';
      document.querySelector('main')!.appendChild(disposable);
      await Promise.resolve();
      const disposableHit = await wq.tools.find_on_page({ query: 'ephemeral region evidence', limit: 2 });
      const disposableAddress = disposableHit.results?.[0]?.address;
      disposable.remove();
      await Promise.resolve();
      const staleRegion = disposableAddress
        ? await wq.tools.resolve_address({ address: disposableAddress, expand: true }) : null;

      // `reason` is one shared input contract. Valid intent reaches the host;
      // wrong types and multi-line values fail before any tool body runs.
      const intents: Array<{ tool: string; reason: string }> = [];
      const intentWq: any = WQ.createNaviquest({ onIntent: (tool: string, reason: string) => intents.push({ tool, reason }) });
      await intentWq.tools.describe_app({ reason: 'orient before reading' });
      const badReasonType = await intentWq.tools.describe_app({ reason: 4 });
      const badReasonLines = await intentWq.tools.find_on_page({ query: 'fees', reason: 'read\nsecret' });
      const badJson = await intentWq.tools.describe_app({ toJSON: () => undefined });
      const summaryWq: any = WQ.createNaviquest({});
      const summarizedReason = await summaryWq.tools.find_on_page({
        query: 'fees', summarize: true, reason: 'summarize fees',
      });

      // Registration is one six-tool transaction. A failed name rolls back the
      // names from that attempt; a retry may succeed; concurrent retries share
      // one in-flight attempt; dispose unregisters the successful surface.
      const registeredNames = new Set<string>();
      let rejectedName: string | null = 'locate_control';
      let registrationCalls = 0;
      const fakeModelContext = {
        async registerTool(def: { name: string }, options?: { signal?: AbortSignal }) {
          registrationCalls++;
          await Promise.resolve();
          if (rejectedName === def.name) throw new DOMException('fixture rejection', 'NotAllowedError');
          if (registeredNames.has(def.name)) throw new DOMException('duplicate', 'InvalidStateError');
          registeredNames.add(def.name);
          options?.signal?.addEventListener('abort', () => registeredNames.delete(def.name), { once: true });
        },
      };
      Object.defineProperty(document, 'modelContext', { configurable: true, value: fakeModelContext });
      const registrationWq: any = WQ.createNaviquest({});
      const failedRegistration = await registrationWq.register();
      const namesAfterFailure = [...registeredNames];
      rejectedName = null; registrationCalls = 0;
      const [retryA, retryB] = await Promise.all([registrationWq.register(), registrationWq.register()]);
      const retryCalls = registrationCalls;
      const namesAfterRetry = [...registeredNames];
      registrationWq.dispose();
      const namesAfterDispose = [...registeredNames];
      delete (document as any).modelContext;

      const liveOrientation = {
        purpose: 'Fixture desk for contract checks.',
        tasks: [{ name: 'Search', locate: '#search' }],
        constraints: ['Do not submit secrets.'],
        view: () => 'contracts',
      };
      const oriented: any = WQ.createNaviquest({
        exclude: ['[data-private]'],
        orientation: liveOrientation,
        tuning: { adaptiveBudget: { enabled: false }, budgets: { describe_app: 900 } },
      });
      const authoredPage = await oriented.tools.describe_app();
      const authoredWarm = await oriented.tools.describe_app({ since: authoredPage._etag });
      const authoredStable = await oriented.tools.describe_app({ since: authoredWarm._etag });
      liveOrientation.purpose = 'Changed fixture purpose.';
      const authoredMoved = await oriented.tools.describe_app({ since: authoredStable._etag });
      const authoredOpaque = await oriented.tools.describe_app({ opaque: true, limit: 5 });
      const opaquePage = await oriented.tools.describe_app({ opaque: true, limit: 1 });
      const opaqueNext = opaquePage.pagination?.next?.[0];
      const opaqueResumed = opaqueNext
        ? await oriented.tools.describe_app(opaqueNext.arguments)
        : null;
      const authoredSection = await oriented.tools.describe_app({ section: 'outline', limit: 5 });
      const authoredExact = await oriented.tools.query_selector({
        selector: authoredPage.authored.tasks[0].locate, limit: 2,
      });
      const authoredLong = await WQ.createNaviquest({
        orientation: { purpose: 'x'.repeat(400) },
        tuning: { adaptiveBudget: { enabled: false } },
      }).tools.describe_app();
      const authoredThrow = await WQ.createNaviquest({
        orientation: { purpose: 'Throwing view.', view: () => { throw new Error('view failed'); } },
        tuning: { adaptiveBudget: { enabled: false } },
      }).tools.describe_app();
      const authoredBad = await WQ.createNaviquest({
        orientation: {
          purpose: 'Mixed locators.',
          tasks: [
            { name: 'Prose', locate: 'search the site' },
            { name: 'Broken', locate: '###' },
            { name: 'Search', locate: '#search' },
          ],
        },
        tuning: { adaptiveBudget: { enabled: false } },
      }).tools.describe_app();
      const authoredExcluded = await WQ.createNaviquest({
        exclude: ['[data-private]'],
        orientation: {
          purpose: 'Excluded locator.',
          tasks: [{ name: 'Private', locate: '[data-private] button' }],
        },
        tuning: { adaptiveBudget: { enabled: false } },
      }).tools.describe_app();

      return { located, searchButton, firstResolved, secondResolved, docs, docsNavigate, fallback, fallbackRead, unknownRead,
        baseline, changes, unchanged,
        malformed, mixed, rerender, cappedChanges, expired, manualChanges, crossInstance,
        malformedCap, malformedExpiry, regionChange, outcomeChange, settleBusy, settleQuiet, formsView, formsStale, invalidExclude, evidenceOnly, parentSearch, phrasingSearch, methodSearch, phrasingExact, payButton, styledSearch, captionExact, bigSelectorText, unindexedMatch, outline, parentOutline, parentRead, parentNext, parentResumed,
        exactAction, exactHeading, freshControl, freshFallback, staleRegion,
        intents, badReasonType, badReasonLines, badJson, summarizedReason,
        failedRegistration, namesAfterFailure, retryA, retryB, retryCalls, namesAfterRetry, namesAfterDispose,
        authoredPage, authoredStable, authoredMoved, authoredOpaque, opaquePage, opaqueNext, opaqueResumed,
        authoredSection, authoredExact, authoredLong, authoredThrow, authoredBad, authoredExcluded };
    });

    check('every tool response exposes one generic orchestration outcome',
      result.baseline.outcome === 'success'
        && result.located.outcome === 'ambiguous'
        && result.firstResolved.outcome === 'success'
        && result.malformed.outcome === 'error',
      { describe: result.baseline.outcome, locate: result.located.outcome,
        resolve: result.firstResolved.outcome, invalid: result.malformed.outcome });
    check('ambiguous control exposes structured refinements',
      result.located.ambiguous === true
        && result.located.refineBy?.roles?.includes('link')
        && result.located.refineBy?.roles?.includes('button'), result.located);
    check('role refinement reaches the intended search button', !!result.searchButton);
    check('a hidden author-declared dialog does not make the page modal',
      result.baseline.modal === false && result.searchButton?.state?.inert === false,
      { modal: result.baseline.modal, search: result.searchButton });
    check('resolved link exposes browser-resolved navigation metadata',
      result.firstResolved.navigation?.href === `${origin}/base/guide`
        && result.firstResolved.navigation?.sameOrigin === true
        && result.firstResolved.navigation?.target === '_blank'
        && result.firstResolved.navigation?.rel === 'help'
        && result.firstResolved.navigation?.download === 'guide.txt', result.firstResolved);
    check('resolve_address reads href live instead of storing it in the index',
      result.secondResolved.navigation?.href === `${origin}/changed?x=1#now`, result.secondResolved);
    check('manifest results declare resource URL semantics',
      result.docs.urlSemantics === 'manifest-resource'
        && result.docs.matches?.[0]?.url === `${origin}/guide.md`, result.docs);
    check('fallback results declare live page-link semantics',
      result.fallback.urlSemantics === 'live-page-link' && !!result.fallback.matches?.[0]?.address, result.fallback);
    check('reading a returned live page-link directs browser navigation',
      result.fallbackRead.status === 'NAVIGATE_INSTEAD'
        && result.fallbackRead.reason === 'LIVE_PAGE_LINK'
        && result.fallbackRead.url === result.fallback.matches?.[0]?.url,
      result.fallbackRead);
    check('reading an arbitrary unlisted URL remains forbidden',
      result.unknownRead.error === 'NOT_IN_MANIFEST', result.unknownRead);
    check('orientation establishes an independent observation cursor',
      typeof result.baseline._observation === 'string', result.baseline);
    check('semantic observation catches eventless state, content, and focus changes',
      result.changes.mode === 'changes'
        && result.changes.changes?.some((x: any) => x.kind === 'control-state' && x.fields?.includes('checked'))
        && result.changes.changes?.some((x: any) => x.kind === 'focus')
        && result.changes.changes?.some((x: any) => x.kind === 'region-content'), result.changes);
    check('semantic observations never serialize password values',
      !JSON.stringify(result.changes).includes('classified'), result.changes);
    check('a second observation without changes is compact and explicit',
      result.unchanged.unchanged === true && result.unchanged.returned === 0, result.unchanged);
    check('changesSince is type guarded', result.malformed.error === 'INVALID_INPUT', result.malformed);
    check('changesSince cannot mix with another describe mode', result.mixed.error === 'INVALID_INPUT', result.mixed);
    check('semantically identical framework replacement creates no churn', result.rerender.unchanged === true, result.rerender);
    check('semantic change detail is capped with exact omission accounting',
      result.cappedChanges.total >= 5 && result.cappedChanges.returned === 2
        && result.cappedChanges.truncated === result.cappedChanges.total - 2
        && Object.values(result.cappedChanges.omitted?.byKind ?? {}).reduce((a: number, b: any) => a + b, 0)
          === result.cappedChanges.truncated, result.cappedChanges);
    check('expired semantic observations fail explicitly', result.expired.error === 'STALE_OBSERVATION', result.expired);
    check('manual indexing declares structural observation degradation',
      result.manualChanges.coverage?.completeForIndexedSurface === false
        && result.manualChanges.coverage?.gaps?.includes('manual-reindex-required'), result.manualChanges);
    check('semantic cursors are scoped to one SDK instance',
      result.crossInstance.error === 'STALE_OBSERVATION', result.crossInstance);
    check('malformed semantic limits degrade to bounded defaults',
      result.malformedCap.returned >= 1
        && result.malformedExpiry.error === 'STALE_OBSERVATION',
      { cap: result.malformedCap, expiry: result.malformedExpiry });
    check('heading-less text edits remain region-content changes',
      result.regionChange.changes?.some((x: any) => x.kind === 'region-content')
        && !result.regionChange.changes?.some((x: any) => x.kind === 'region-added' || x.kind === 'region-removed'),
      result.regionChange);
    check('a live-region announcement surfaces its text, not just a char delta',
      result.outcomeChange.changes?.some((x: any) => x.kind === 'announce'
        && String(x.after?.text || '').includes('Could not save')),
      result.outcomeChange);
    check('an aria-busy region marks the page as still settling',
      result.settleBusy.settling === true, result.settleBusy);
    check('a quiet page is not flagged settling',
      result.settleQuiet.settling !== true, result.settleQuiet);
    check('the forms view rolls a form up to its tally and submit control', (() => {
      const f = result.formsView.results?.find((x: any) => x.name === 'Signup Fixture');
      const checkbox = f?.controls?.find((x: any) => x.name === 'Consent');
      const submit = f?.controls?.find((x: any) => String(x.name).includes('Create account'));
      const custom = f?.controls?.find((x: any) => x.name === 'Custom note');
      const external = f?.controls?.find((x: any) => x.name === 'External');
      return !!f && f.fields === 7 && f.required === 4 && f.requiredFilled === 2
        && f.filled === 3 && f.invalid >= 1 && f.complete === false
        && checkbox?.state?.checked === false && checkbox?.state?.valuePresent === false
        && submit?.state?.valuePresent === undefined
        && custom?.state?.required === true && custom?.state?.readOnly === true
        && !!external && !!f.submit && String(f.submit.name).includes('Create account');
    })(), result.formsView);
    check('forms continuations reject a changed projection',
      result.formsStale.error === 'STALE_CURSOR', result.formsStale);
    check('invalid host exclusion selectors abort before indexing',
      /invalid exclude selector/.test(result.invalidExclude), result.invalidExclude);
    check("an invalid control surfaces the page's own validation message",
      result.outcomeChange.changes?.some((x: any) => x.fields?.includes('errorText')
        && String(x.after?.errorText || '').includes('valid UK format')),
      result.outcomeChange);
    check('ranked passages without a supported answer fail closed with a copyable recovery',
      result.evidenceOnly.results?.length > 0
        && result.evidenceOnly.answer === undefined
        && result.evidenceOnly.answerStatus === 'unsupported'
        && result.evidenceOnly.evidenceOnly === true
        && result.evidenceOnly.next?.tool === 'describe_app'
        && result.evidenceOnly.next?.arguments?.section === 'outline', result.evidenceOnly);
    check('a parent-only heading is a first-class searchable section target',
      result.parentSearch.results?.[0]?.kind === 'section'
        && result.parentSearch.results[0].headingPath?.at(-1) === 'Parent only'
        && result.parentSearch.results[0].address?.headingScope === 'outline'
        && result.parentSearch.recommendedAddress?.headingScope === 'outline', result.parentSearch);
    check('outline rows carry a directly readable region address',
      result.outline.results?.some((x: any) => x.text === 'Search'
        && x.address?.resolveWith === 'read_region'
        && x.readWith === 'resolve_address'), result.outline);
    check('a parent-only outline heading reads its descendant subsection',
      result.parentOutline?.address?.headingScope === 'outline'
        && result.parentRead?.kind === 'region'
        && result.parentRead?.status === 'RESOLVED'
        && result.parentRead?.headingPath?.at(-1) === 'Parent only'
        && String(result.parentRead?.text).includes('Nested criterion evidence'),
      { outline: result.parentOutline, read: result.parentRead });
    check('a paged region keeps its mode budget and resumes through resolve_address',
      result.parentRead?._budget === 2_000
        && result.parentNext?.tool === 'resolve_address'
        && result.parentResumed?.status === 'RESOLVED'
        && result.parentResumed?.textOffset > 0,
      { first: result.parentRead, next: result.parentNext, resumed: result.parentResumed });
    check('exact semantic action-name filtering returns only the copied name',
      result.exactAction.matched === 1
        && result.exactAction.results?.length === 1
        && result.exactAction.results[0].name === 'Guide page', result.exactAction);
    check('exact semantic heading filtering returns only the copied heading',
      result.exactHeading.matched >= 1
        && result.exactHeading.results?.every((x: any) => x.headingPath?.at(-1) === 'Search'), result.exactHeading);
    check('locate_control ranks controls added after its previous index',
      result.freshControl.candidates?.some((x: any) => x.name === 'Launch dynamic report'), result.freshControl);
    check('agentic_content fallback reads links added after its previous index',
      result.freshFallback.matches?.some((x: any) => x.title === 'Dynamic report handbook'), result.freshFallback);
    check('a stale region address uses the normal resolution-miss outcome',
      (result.staleRegion?.outcome === 'not_found' || result.staleRegion?.outcome === 'ambiguous')
        && (result.staleRegion?.status === 'NOT_FOUND' || result.staleRegion?.status === 'AMBIGUOUS')
        && typeof result.staleRegion?.hint === 'string'
        && result.staleRegion?.error === undefined, result.staleRegion);
    check('reason reaches the host through one shared hook',
      result.intents?.length === 1
        && result.intents[0].tool === 'describe_app'
        && result.intents[0].reason === 'orient before reading', result.intents);
    check('reason rejects wrong types and multiple lines',
      result.badReasonType?.error === 'INVALID_INPUT'
        && result.badReasonLines?.error === 'INVALID_INPUT',
      { type: result.badReasonType, lines: result.badReasonLines });
    check('shared input validation returns an error for a non-serializable object',
      result.badJson?.error === 'INVALID_INPUT' && result.badJson?.outcome === 'error', result.badJson);
    check('summary recovery does not return or replay the agent reason',
      !!result.summarizedReason?.summary?.readOriginalWith
        && !('reason' in result.summarizedReason.summary.readOriginalWith.arguments),
      result.summarizedReason?.summary);
    check('registration failure rolls back the whole six-tool attempt',
      result.failedRegistration?.registered === false
        && result.failedRegistration?.failed?.includes('locate_control')
        && result.failedRegistration?.tools === undefined
        && result.namesAfterFailure?.length === 0,
      { registration: result.failedRegistration, names: result.namesAfterFailure });
    check('registration retry is atomic and concurrent calls share one attempt',
      result.retryA?.registered === true && result.retryB?.registered === true
        && result.retryCalls === 6
        && result.namesAfterRetry?.length === 6,
      { a: result.retryA, b: result.retryB, calls: result.retryCalls, names: result.namesAfterRetry });
    check('dispose unregisters every successfully registered tool',
      result.namesAfterDispose?.length === 0, result.namesAfterDispose);
    check('agent resources expose typed read semantics',
      result.docs.matches?.[0]?.kind === 'resource'
        && result.docs.matches[0].action === 'read'
        && result.docs.matches[0].resourceUrl === `${origin}/guide.md`, result.docs);
    check('navigate intent verifies a same-origin HTML sibling before recommending it',
      result.docsNavigate.matches?.[0]?.action === 'navigate'
        && result.docsNavigate.matches[0].liveUrlVerified === true
        && result.docsNavigate.matches[0].liveUrl === `${origin}/guide`, result.docsNavigate);
    check('live fallback links expose typed navigation semantics',
      result.fallback.matches?.[0]?.kind === 'live-page'
        && result.fallback.matches[0].action === 'navigate'
        && result.fallback.matches[0].liveUrl === result.fallback.matches[0].url, result.fallback);
    check('describe_app omits authored when the host passed no orientation',
      !('authored' in result.baseline), result.baseline);
    check('describe_app returns host orientation with provenance',
      result.authoredPage.authored?.source === 'createNaviquest.orientation'
        && result.authoredPage.authored?.purpose === 'Fixture desk for contract checks.'
        && result.authoredPage.authored?.tasks?.[0]?.locate === '#search'
        && result.authoredPage.authored?.view === 'contracts'
        && Array.isArray(result.authoredPage.outline), result.authoredPage);
    check('authored locate is a CSS selector query_selector can copy',
      result.authoredExact.matched === 1
        && result.authoredExact.results?.[0]?.name === 'Search the site'
        && !!result.authoredExact.results?.[0]?.address, result.authoredExact);
    check('non-selector locate values are omitted with a note',
      result.authoredBad.authored?.tasks?.length === 1
        && result.authoredBad.authored?.tasks?.[0]?.locate === '#search'
        && String(result.authoredBad.authored?.note).includes('omitted'), result.authoredBad);
    check('exclude selectors withhold authored locate matches',
      !result.authoredExcluded.authored?.tasks
        && String(result.authoredExcluded.authored?.note).includes('omitted'), result.authoredExcluded);
    check('unchanged since still holds when authored copy is stable',
      result.authoredStable.unchanged === true, result.authoredStable);
    check('purpose edits without a DOM mutation invalidate since',
      result.authoredMoved.unchanged !== true
        && (result.authoredMoved.changed?.authored?.purpose === 'Changed fixture purpose.'
          || result.authoredMoved.authored?.purpose === 'Changed fixture purpose.'), result.authoredMoved);
    check('overlong purpose is truncated and declared',
      result.authoredLong.authored?.truncated === true
        && result.authoredLong.authored?.purpose?.length <= 280, result.authoredLong);
    check('orientation.view throw omits view and keeps the tool successful',
      !result.authoredThrow.error
        && result.authoredThrow.authored?.purpose === 'Throwing view.'
        && result.authoredThrow.authored?.view === undefined
        && String(result.authoredThrow.authored?.note).includes('threw'), result.authoredThrow);
    check('opaque and section modes omit authored',
      !('authored' in result.authoredOpaque) && !('authored' in result.authoredSection),
      { opaque: result.authoredOpaque, section: result.authoredSection });
    check('opaque pagination resumes through registered describe_app',
      result.opaquePage.total > 1
        && result.opaqueNext?.tool === 'describe_app'
        && result.opaqueResumed?.offset === 1
        && !result.opaqueResumed?.error,
      { first: result.opaquePage, next: result.opaqueNext, resumed: result.opaqueResumed });
    const phrasingBlob = [
      result.phrasingSearch?.answer?.text,
      ...(result.phrasingSearch?.results ?? []).map((row: { text?: string }) => row.text),
    ].join('\n');
    const methodBlob = [
      result.methodSearch?.answer?.text,
      ...(result.methodSearch?.results ?? []).map((row: { text?: string }) => row.text),
    ].join('\n');
    check('inline code and links stay inside the sentence find_on_page returns',
      phrasingBlob.includes('transient user activation is required'), phrasingBlob.slice(0, 400));
    check('inline method names in one paragraph are one passage',
      methodBlob.includes('Summarizer.create()') && methodBlob.includes('summarize()'), methodBlob.slice(0, 400));
    check('query_selector text uses the same spaced sentence as find_on_page',
      String(result.phrasingExact?.results?.[0]?.text ?? '').includes('transient user activation is required'),
      result.phrasingExact?.results?.[0]?.text);
    const payName = result.payButton?.candidates?.find((x: { name?: string }) => x.name === 'Pay now')
      ?? result.payButton?.candidates?.[0];
    check('interactive name folds phrasing children',
      payName?.name === 'Pay now' || payName?.text === 'Pay now', payName);
    const styledHit = (result.styledSearch?.results ?? []).find((row: { headingPath?: string[]; address?: { headingPath?: string[] } }) =>
      (row.headingPath ?? row.address?.headingPath ?? []).includes('Pay now'));
    check('heading with phrasing children is the section title',
      !!styledHit,
      { headingPath: styledHit?.headingPath ?? styledHit?.address?.headingPath });
    check('query_selector caption folds inline code and links',
      String(result.captionExact?.results?.[0]?.text ?? '').includes('Rate is 12% per year'),
      result.captionExact?.results?.[0]?.text);
    const bigRow = result.bigSelectorText?.results?.[0];
    check('selector text is bounded and declares its own truncation',
      typeof bigRow?.text === 'string'
        && bigRow.text.length < 9000
        && bigRow.textIsExcerpt === true
        && bigRow.textChars > bigRow.text.length
        && !!bigRow.readFullTextWith
        && result.bigSelectorText._overBudget !== true,
      { chars: bigRow?.text?.length, textChars: bigRow?.textChars,
        excerpt: bigRow?.textIsExcerpt, readFullTextWith: bigRow?.readFullTextWith,
        tokens: result.bigSelectorText?._tokens, budget: result.bigSelectorText?._budget,
        over: result.bigSelectorText?._overBudget });
    const unindexed = result.unindexedMatch?.results?.[0];
    check('an unaddressable match carries the selector its note tells the agent to use',
      unindexed?.address === null && !!unindexed?.addressNote
        && typeof unindexed?.selectorOfLastResort === 'string'
        && unindexed.selectorOfLastResort.length > 0, unindexed);

    // #2 nav chrome must not fabricate the heading outline; #3 describe_app
    // declines on weak structure regardless of size. Driven on dedicated
    // fixtures so FIXTURE_HTML's tuned checks above are untouched.
    const chromePage = await browser.newPage();
    try {
      await chromePage.goto(`${origin}/chrome`, { waitUntil: 'domcontentloaded' });
      await chromePage.addScriptTag({ content: BUNDLE });
      const chrome = await chromePage.evaluate(async () => {
        const wq: any = await (window as any).WQ.createNaviquest({});
        const outline = await wq.tools.describe_app({ section: 'outline', limit: 50 });
        const fees = await wq.tools.find_on_page({ query: 'transaction fee spread percentage' });
        const paths = JSON.stringify((outline.results ?? []).map((o: any) => o.headingPath))
          + JSON.stringify((fees.results ?? []).map((r: any) => r.address?.headingPath));
        return { paths };
      });
      check('inferred nav-chrome headings do not enter the outline or passage paths',
        !chrome.paths.includes('Log In Sign Up') && !chrome.paths.includes('Sign Up'), chrome.paths);
      check('authored headings inside/after chrome still populate the outline',
        chrome.paths.includes('Crypto the easy way') && chrome.paths.includes('Fees'), chrome.paths);

      await chromePage.goto(`${origin}/weak`, { waitUntil: 'domcontentloaded' });
      await chromePage.addScriptTag({ content: BUNDLE });
      const weak = await chromePage.evaluate(async () => {
        const wq: any = await (window as any).WQ.createNaviquest({});
        const app = await wq.tools.describe_app();
        return { rec: app.recommendation ?? '', quality: app.structuralQuality };
      });
      check('a large but weakly-structured page is declined, not just small ones',
        weak.quality === 'low' && /weakly structured/i.test(weak.rec), weak);

      await chromePage.goto(`${origin}/strong`, { waitUntil: 'domcontentloaded' });
      await chromePage.addScriptTag({ content: BUNDLE });
      const strong = await chromePage.evaluate(async () => {
        const wq: any = await (window as any).WQ.createNaviquest({});
        return { rec: (await wq.tools.describe_app()).recommendation ?? '' };
      });
      check('a well-structured page is not flagged weakly structured',
        !/weakly structured/i.test(strong.rec), strong.rec);
    } finally {
      await chromePage.close();
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LANE: invariants (--live)
// ─────────────────────────────────────────────────────────────────────────────

export const WEBMCP_CHROME_ARGS = ['--enable-features=WebMCPTesting'];
const MDN = 'https://developer.mozilla.org';
const SIX_TOOLS = ['describe_app', 'find_on_page', 'locate_control',
                   'query_selector', 'resolve_address', 'agentic_content'] as const;

/**
 * The frozen retrieval questions and the phrases that prove a real answer.
 * Gold must be reachable THROUGH the tools; memory does not count.
 */
const QUESTIONS = [
  { id: 'Q1', page: 'summarizer', needles: ['Summarizer.create()', 'summarize()'],
    prompt: 'The browser can shorten a long article with its own on-device model (no cloud). From this site: what object do I construct, and which two calls create it then produce a summary of a string?' },
  { id: 'Q2', page: 'summarizer', needles: ['Summarizer.availability()'],
    prompt: 'How does this site tell me to test whether that on-device model will honor my options before I construct the object?' },
  { id: 'Q3', page: 'summarizer', needles: ['"tldr" or key points'],
    prompt: 'What example summary shapes does this site list (short blurb vs structured takeaways)? Quote the docs.' },
  { id: 'Q4', page: 'summarizer', needles: ['transient user activation is required'],
    prompt: 'Construction can fail even on HTTPS if the user never touched the page. What extra requirement does this site document?' },
  { id: 'Q5', page: 'prompt', needles: ['LanguageModel', 'prompt()'],
    prompt: 'I also need a general on-device prompt — not a summary. Which interface is the session, and which instance method returns the complete reply?' },
  { id: 'Q6', page: 'prompt', needles: ['currently opposed by two browser vendor'],
    prompt: 'Should I ship that general prompt capability to Firefox and Safari users? Quote any warning this site gives, and name any vendors it cites.' },
] as const;

const normalize = (value: unknown): string =>
  String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US');

/**
 * A tool response as searchable prose.
 *
 * `JSON.stringify` escapes the quotes inside a payload, so a gold phrase that
 * contains one — MDN's `"tldr" or key points` — could never match its own text
 * and the probe reported `not-retrievable` for content the SDK had returned.
 * Unescape before matching, or the sensor invents product defects.
 */
const readable = (payload: unknown): string =>
  JSON.stringify(payload ?? '').replace(/\\"/g, '"').replace(/\\n/g, ' ');

/** Build one init script. Install it before navigation; do not addScriptTag. */
export async function buildNaviquestInstallScript(): Promise<string> {
  const bundle = await bundleSdk('WQ');
  // A navigation replaces the realm and native tool map. The browser's init
  // hook reruns this whole script for every document. Chrome can expose
  // modelContext after the earliest init-script turn (Devpost, 2026-09-01), so
  // registration retries for ten seconds.
  return `${bundle}\n;(()=>{window.naviquest=WQ.createNaviquest({});void(async()=>{for(let attempt=0;attempt<400;attempt++){const result=await window.naviquest.register();if(result.registered)return;await new Promise(resolve=>setTimeout(resolve,25));}})();})();`;
}

export async function waitForNaviquestTools(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const mc: any = (document as any).modelContext;
    if (!mc?.getTools || !mc?.executeTool) throw new Error('document.modelContext execution API is unavailable');
    for (let attempt = 0; attempt < 400; attempt++) {
      const registered = await mc.getTools();
      const local = registered.filter((tool: any) => tool.window === window && tool.name);
      if (local.length >= 6) return local.map((tool: any) => tool.name);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Naviquest tools were not registered');
  });
}

/** Execute only through Chrome's registered WebMCP surface. */
export async function invokeNaviquest<T = any>(page: Page, name: string, args: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(async ({ name, args }) => {
    const mc: any = (document as any).modelContext;
    const registered = await mc.getTools();
    const tool = registered.find((candidate: any) => candidate.window === window && candidate.name === name);
    if (!tool) throw new Error(`${name} was not registered on document.modelContext`);
    // Chrome 152 still implements the legacy JSON-string argument boundary.
    const wire = JSON.parse(await mc.executeTool(tool, JSON.stringify(args)));
    const text = wire.content?.find((item: any) => item.type === 'text')?.text;
    if (typeof text !== 'string') throw new Error(`${name} returned no text content`);
    return JSON.parse(text);
  }, { name, args });
}

// discovery.frames: same-origin child-frame CONTENT indexing. The shell and the
// framed document share the SAME heading, so this also proves collision safety:
// a frame passage's address must not resolve to (or read) the top-document one.
async function laneFrames(browser: Browser) {
  console.log('\n=== frames: same-origin child-frame content indexing (discovery.frames) ===');
  const BUNDLE = await bundleSdk('WQ');
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if ((req.url ?? '/') === '/frame-inner') {
      res.end('<!doctype html><title>inner</title><main><h1>Workspace</h1>'
        + '<p>The purple platypus ledger reconciles quarterly and is due on the fifteenth.</p>'
        + '<script type="application/ld+json">{broken</script>'
        + '<canvas width="40" height="30"></canvas>'
        + '<x-frame-widget tabindex="0" style="display:block;width:40px;height:30px"></x-frame-widget></main>');
    } else {
      res.end('<!doctype html><title>shell</title><main><h1>Workspace</h1>'
        + '<p>Welcome to the shell overview page.</p>'
        + '<iframe title="workspace" src="/frame-inner" style="width:600px;height:200px"></iframe></main>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('frame fixture server did not bind');
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${addr.port}`, { waitUntil: 'load' });
    await page.waitForTimeout(300);   // let the same-origin child frame load
    await page.addScriptTag({ content: BUNDLE });
    const r = await page.evaluate(async () => {
      const WQ: any = (window as any).WQ;
      const q = 'purple platypus ledger';
      const off = await WQ.createNaviquest({ tuning: { answer: { verify: 'off', fromRegion: 'off' } } });
      const fOff = await off.tools.find_on_page({ query: q });
      const on = await WQ.createNaviquest({ tuning: { answer: { verify: 'off', fromRegion: 'off' }, discovery: { frames: true } } });
      const da = await on.tools.describe_app({});
      const fOn = await on.tools.find_on_page({ query: q });
      const top = (fOn.results ?? []).find((x: any) => /platypus/i.test(x.text ?? ''));
      let region = '';
      if (top?.address) {
        const rr = await on.tools.resolve_address({ address: top.address, read: true });
        region = rr.region?.text ?? rr.text ?? '';
      }
      const opaque = await on.tools.describe_app({ opaque: true, limit: 10 });
      const frame = document.querySelector('iframe') as HTMLIFrameElement;
      frame.contentDocument!.querySelector('p')!.textContent =
        'The orange capybara register closes monthly on the twentieth.';
      await new Promise((resolve) => setTimeout(resolve, 0));
      const afterNew = await on.tools.find_on_page({ query: 'orange capybara register' });
      const afterOld = await on.tools.find_on_page({ query: q });
      return {
        offFound: (fOff.results ?? []).some((x: any) => /platypus/i.test(x.text ?? '')),
        onFound: !!top,
        addressFrame: top?.address?.frame ?? null,
        unindexed: da.coverage?.unindexedFrameDocuments,
        frameOpaqueComponents: da.coverage?.opaqueComponents,
        frameNonTextOpaque: da.nonText?.opaque,
        malformedFrameDataReported: /JSON-LD block/.test(da.coverage?.note ?? ''),
        opaqueTotal: opaque.total,
        opaqueFrame: opaque.regions?.some((x: any) => typeof x.frame === 'string'),
        roundTrip: /platypus/i.test(region),
        staysInFrame: !/overview page/i.test(region),
        mutationFresh: (afterNew.results ?? []).some((x: any) => /orange capybara/i.test(x.text ?? '')),
        staleTextGone: !(afterOld.results ?? []).some((x: any) => /purple platypus/i.test(x.text ?? '')),
      };
    });
    check('frames off: framed content is NOT indexed', r.offFound === false, r);
    check('frames on: framed content IS found', r.onFound === true, r);
    check('frames on: no unindexed-frame coverage gap remains', r.unindexed === 0, r);
    check('frames on: the result address carries a frame path', typeof r.addressFrame === 'string' && r.addressFrame.startsWith('document/frame'), r);
    check('frames on: the frame address round-trips (read the frame text)', r.roundTrip === true, r);
    check('frames on: read_region does not cross into the same-heading shell', r.staysInFrame === true, r);
    check('frames on: in-frame mutations rebuild the semantic index',
      r.mutationFresh === true && r.staleTextGone === true, r);
    check('frames on: frame coverage and opaque regions are merged',
      r.frameOpaqueComponents > 0 && r.frameNonTextOpaque > 0
        && r.malformedFrameDataReported === true && r.opaqueTotal > 0 && r.opaqueFrame === true, r);
    await page.close();
  } finally { server.close(); }
}

async function laneInvariants(context: BrowserContext) {
  console.log('\n=== invariants: six tools on live MDN ===');
  const page = await context.newPage();
  const toolsSeen = new Set<string>();
  const calls: Array<{ page: string; tool: string; label: string; tokens?: number; budget?: number }> = [];
  const violations: Array<{ invariant: string; page: string; detail: unknown }> = [];
  const flag = (invariant: string, pg: string, detail: unknown) => violations.push({ invariant, page: pg, detail });

  /**
   * Every response, one place. Budget adherence is checked here rather than at
   * each call site so no future call can opt out of it by forgetting.
   */
  const call = async (pageLabel: string, tool: string, args: Record<string, unknown>, label = tool): Promise<any> => {
    const result = await invokeNaviquest(page, tool, args);
    toolsSeen.add(tool);
    calls.push({ page: pageLabel, tool, label, tokens: result?._tokens, budget: result?._budget });
    // `_overBudget` is honest — the SDK declares it rather than lying — but a
    // declared overrun is still an agent paying for a page it tried not to
    // download. On a real page it must never happen.
    if (result?._overBudget === true) {
      flag('budget', pageLabel, { tool, label, tokens: result._tokens, budget: result._budget });
    }
    return result;
  };

  const addressesOf = (payload: any): unknown[] => {
    const found: unknown[] = [];
    if (payload?.answer?.address) found.push(payload.answer.address);
    for (const row of payload?.results ?? []) if (row?.address) found.push(row.address);
    for (const row of payload?.candidates ?? []) if (row?.address) found.push(row.address);
    if (payload?.recommendedAddress) found.push(payload.recommendedAddress);
    return found;
  };
  const rowKey = (row: any): string =>
    JSON.stringify([row?.tag ?? null, row?.role ?? null, row?.name ?? null, row?.address ?? null]);
  /**
   * A row whose returned text is shorter than the text it claims to have must
   * say so. Silent clipping is the failure mode convention 5 exists to prevent:
   * an agent cannot tell a short section from a truncated one.
   */
  const declaresTruncation = (row: any): boolean => {
    if (typeof row?.textChars !== 'number') return true;
    if (row.textChars <= String(row.text ?? '').length) return true;
    return row.textIsExcerpt === true;
  };

  const open = async (url: string) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(1_500);
    await waitForNaviquestTools(page);
  };

  const retrievalRows: Array<{ id: string; found: boolean; via: string }> = [];

  try {
    // The hub is the stress page: ~190k chars of link list, the shape most
    // likely to blow a ceiling. The two article pages are where the gold lives.
    const targets: Array<{ label: string; url: string; corpus: string | null }> = URL_ARG
      ? [{ label: new URL(URL_ARG).hostname, url: URL_ARG, corpus: null }]
      : [
        { label: 'hub', url: `${MDN}/en-US/docs/Web/API`, corpus: null },
        { label: 'summarizer', url: `${MDN}/en-US/docs/Web/API/Summarizer_API`, corpus: 'summarizer' },
        { label: 'prompt', url: `${MDN}/en-US/docs/Web/API/Prompt_API`, corpus: 'prompt' },
      ];

    for (const target of targets) {
      await open(target.url);
      const label = target.label;
      await call(label, 'describe_app', {});
      await call(label, 'agentic_content', { intent: 'list', limit: 10 });

      // The three semantic views, each budget-checked.
      for (const view of ['actions', 'structure', 'scopes'] as const) {
        await call(label, 'query_selector', { view, limit: 10 }, `query_selector:${view}`);
      }

      // Exact CSS asking for text on the biggest element on the page. This is
      // the shape that returned an uncapped page dump before 2026-09-02.
      for (const selector of ['main', 'body', 'article']) {
        const res = await call(label, 'query_selector',
          { selector, fields: ['text', 'address'], limit: 2 }, `query_selector:${selector}+text`);
        for (const row of res?.results ?? []) {
          if (!declaresTruncation(row)) {
            flag('declared-truncation', label, { selector, chars: String(row.text ?? '').length, textChars: row.textChars });
          }
          // Independently of the budget flag: a single row must never carry a
          // whole large element, because rows are this tool's only pagination
          // unit and its shrinker floors at one row.
          if (String(row?.text ?? '').length > 4_000) {
            flag('selector-text-bound', label, { selector, chars: String(row.text).length });
          }
        }
      }

      // Pagination integrity on a selector that matches a lot.
      const p1 = await call(label, 'query_selector', { selector: 'a', limit: 5, offset: 0 }, 'query_selector:page1');
      if (p1?.pagination?.next?.[0]) {
        const p2 = await call(label, 'query_selector', p1.pagination.next[0].arguments, 'query_selector:page2');
        const first = new Set((p1.results ?? []).map(rowKey));
        const overlap = (p2?.results ?? []).filter((row: unknown) => first.has(rowKey(row)));
        // A continuation that re-serves a row wastes budget; one that jumps past
        // a row loses it forever, because offset is the only way back.
        if (overlap.length) flag('continuation-overlap', label, { overlap: overlap.length });
        if (typeof p2?.offset === 'number' && p2.offset !== (p1.results ?? []).length) {
          flag('continuation-skip', label, { returned: (p1.results ?? []).length, nextOffset: p2.offset });
        }
      }

      // locate_control: the only tool that answers "which control performs this
      // job". MDN always has a site search.
      const located = await call(label, 'locate_control',
        { description: 'search this site', role: 'searchbox' }, 'locate_control:search');

      // A page-independent search, so find_on_page and resolve_address are
      // exercised on EVERY page rather than only inside the MDN-only frozen
      // questions below. Under --url that block never runs, and the probe
      // reported 4/6 tool coverage on react.dev until this existed. The page's
      // own title is the one query guaranteed to mean something here.
      const title = await page.title();
      const found = await call(label, 'find_on_page', { query: title || 'page', limit: 5 }, 'find_on_page:title');

      // An address is the SDK's identity contract; one that cannot be resolved
      // on the page that produced it, milliseconds later, is a broken promise —
      // whichever tool minted it.
      for (const [from, payload] of [['locate_control', located], ['find_on_page', found]] as const) {
        for (const address of addressesOf(payload).slice(0, 2)) {
          const back = await call(label, 'resolve_address', { address }, `resolve_address:${from}`);
          if (back?.error === 'NOT_FOUND' || back?.status === 'NOT_FOUND') {
            flag('address-roundtrip', label, { from, status: back?.status ?? back?.error });
          }
        }
      }
      await call(label, 'describe_app', { opaque: true }, 'describe_app:opaque');

      // Can the frozen questions be answered THROUGH the tools, on the page
      // that holds the answer? This drives the real agent flow — rank, then
      // read the region behind the top hits.
      if (!target.corpus) continue;
      for (const question of QUESTIONS.filter((q) => q.page === target.corpus)) {
        const found = await call(label, 'find_on_page', { query: question.prompt, limit: 5 }, `find_on_page:${question.id}`);
        let resultPage = found;
        let corpusText = '';
        let via = 'find_on_page';
        const expanded: any[] = [];
        const hit = () => question.needles.every((n) => normalize(corpusText).includes(normalize(n)));
        // Tool budgets can reduce a nominal five-result page to one result and
        // return a continuation. Exercise the agent flow, not a one-shot call:
        // inspect each compact page and its addresses, bounded to three pages.
        for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
          corpusText += readable(resultPage);
          if (hit()) break;
          for (const address of addressesOf(resultPage).slice(0, 3)) {
            const region = await call(label, 'resolve_address', { address, expand: true }, `resolve_address:${question.id}`);
            expanded.push(region);
            corpusText += readable(region);
            via = 'resolve_address(expand)';
            if (hit()) break;
          }
          if (hit() || !resultPage?.pagination?.next?.[0]) break;
          resultPage = await call(label, 'find_on_page', resultPage.pagination.next[0].arguments,
            `find_on_page:${question.id}:continuation`);
          via = 'find_on_page(continuation)';
        }
        if (VERBOSE && !hit()) {
          console.log(`       ${question.id} miss detail ${JSON.stringify({
            answer: found.answer?.text, matched: found.matched, returned: found.returned,
            results: (found.results ?? []).map((row: any) => ({
              text: row.text, headingPath: row.address?.headingPath, score: row.score,
            })),
            expanded: expanded.map((region) => ({
              status: region.status, headingPath: region.headingPath,
              text: String(region.text ?? '').slice(0, 2_000),
            })),
          })}`);
        }
        retrievalRows.push({ id: question.id, found: hit(), via: hit() ? via : 'MISS' });
      }
    }

    const missing = SIX_TOOLS.filter((tool) => !toolsSeen.has(tool));
    if (missing.length) flag('tool-coverage', 'all', { missing });
  } catch (error) {
    flag('probe-error', 'all', error instanceof Error ? error.message : String(error));
  }

  const worst = calls
    .filter((c) => typeof c.tokens === 'number' && typeof c.budget === 'number')
    .sort((a, b) => (b.tokens! / b.budget!) - (a.tokens! / a.budget!))
    .slice(0, 6)
    .map((c) => ({ page: c.page, label: c.label, tokens: c.tokens, budget: c.budget,
                   pctOfBudget: Math.round((c.tokens! / c.budget!) * 100) }));

  console.log(`       ${toolsSeen.size}/6 tools exercised across ${calls.length} calls`);
  console.log(`       retrieval ${retrievalRows.filter((r) => r.found).length}/${retrievalRows.length}  ${retrievalRows.map((r) => `${r.id}:${r.via}`).join('  ')}`);
  for (const row of worst) console.log(`       ${String(row.pctOfBudget).padStart(4)}%  ${row.page}/${row.label}  ${row.tokens}/${row.budget}`);

  check('all six tools drive a real page', toolsSeen.size === 6, [...toolsSeen]);
  // Skipped under --url: the frozen gold lives on MDN, and asserting it against
  // an arbitrary origin would fail for the page's content, not the SDK.
  if (!URL_ARG) {
    check('every frozen question is answerable through the tools',
      retrievalRows.length > 0 && retrievalRows.every((r) => r.found),
      retrievalRows.filter((r) => !r.found));
  }
  check('no budget, address, cursor, or truncation invariant broken',
    violations.length === 0, violations.slice(0, 4));

  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, 'invariants.json'), JSON.stringify(
    { probedAt: new Date().toISOString(), origin: MDN, toolsExercised: [...toolsSeen].sort(),
      retrieval: retrievalRows, worstBudgetPressure: worst, violations, calls }, null, 2));
  console.log(`       wrote ${path.join(OUT, 'invariants.json')}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// LANE: crawl
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hops where the answer is NOT on the start page.
 *
 * `invariants` proves six tools behave on one document. It cannot see what an
 * agent actually does, which is arrive somewhere, work out where to go next, go
 * there, and read the answer off the destination. Each clause is its own
 * failure: an intent that ranks the wrong link, a control the SDK described but
 * a host cannot bind to, an index that does not rebuild on the new document, an
 * address that does not survive the navigation.
 *
 * `gold` is deliberately a weak word the destination cannot avoid and the start
 * page does not lead with. Tuned tighter it would measure Wikipedia's prose
 * rather than the SDK.
 */
const CRAWLS = [
  { start: 'https://docs.python.org/3/library/asyncio.html',
    intent: 'go to the coroutines and tasks page',
    question: 'run awaitables concurrently', gold: 'concurrently' },
  { start: 'https://en.wikipedia.org/wiki/Web_scraping',
    intent: 'open the web crawler article',
    question: 'what does a web crawler do', gold: 'crawler' },
  { start: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
    intent: 'open the Response interface reference',
    question: 'response body headers status', gold: 'response' },
];

async function laneCrawl(context: BrowserContext) {
  console.log('\n=== crawl: navigate between real pages, answer from the destination ===');
  const page = await context.newPage();

  for (const t of CRAWLS) {
    const site = t.start.replace('https://', '').split('/')[0];
    const problems: string[] = [];
    try {
      await page.goto(t.start, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      await waitForNaviquestTools(page);
      await invokeNaviquest(page, 'describe_app', {});

      // Nothing in the SDK clicks. It names the control and the host actuates
      // it, so the only part of navigation the SDK owns is producing a role and
      // a name a host can bind to — which is exactly what this asserts.
      const lc: any = await invokeNaviquest(page, 'locate_control', { description: t.intent });
      const target = lc.recommendedAddress ?? lc.candidates?.[0]?.address;
      if (!target?.name || !target?.role) {
        check(`${site}: intent resolves to an addressable control`, false, lc.error ?? lc.status);
        continue;
      }
      const from = page.url();
      const byRole = (exact: boolean) =>
        page.getByRole(target.role, { name: target.name, exact }).first().click({ timeout: 8000 });
      await byRole(true).catch(() => byRole(false));
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(1500);
      if (page.url() === from) problems.push('the located control did not navigate');

      // A new document is a new index, and no host told the SDK to rebuild.
      await waitForNaviquestTools(page);
      const after: any = await invokeNaviquest(page, 'describe_app', {});
      if (!after.counts?.chunks) problems.push('destination indexed zero chunks');

      const found: any = await invokeNaviquest(page, 'find_on_page', { query: t.question, limit: 3 });
      const hit = found.results?.[0];
      if (!hit) problems.push(`nothing found for "${t.question}" on the destination`);
      else if (!hit.address) problems.push('top destination hit carries no address');
      else {
        const read: any = await invokeNaviquest(page, 'resolve_address', { address: hit.address, expand: true });
        if (read.error) problems.push(`address did not round-trip after navigating: ${read.error}`);
        // Unescaped, because a gold word can sit against a quote in the payload.
        else if (!JSON.stringify(read).replace(/\\"/g, '"').toLowerCase().includes(t.gold)) {
          problems.push(`expanded passage never says "${t.gold}"`);
        }
      }
      check(`${site}: "${t.intent}" → ${page.url().replace('https://', '').slice(0, 44)}`,
        problems.length === 0, problems.length ? problems : undefined);
    } catch (e) {
      check(`${site}: "${t.intent}"`, false, (e as Error).message.split('\n')[0]);
    }
  }
  await page.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// LANE: compare
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the SDK is worth, measured against the thing it replaces.
 *
 * Three arms answer the SAME questions on the SAME pages, and every arm is
 * charged by ONE estimator over the bytes it actually had to ingest — not by
 * each arm's own accounting. The old deleted collector graded each arm against
 * its own corpus and reported naviquest 0/6 against playwright 5/6; both numbers
 * were measurement artifacts of that choice. Charging every arm with the same
 * function over the same unit is the correction.
 *
 *   playwright            `ariaSnapshot()` — what an automation agent reads today.
 *   playwright+naviquest   the SDK retrieves and NAMES controls; Playwright clicks.
 *   naviquest-only         the six tools with no host actuation at all.
 *
 * `naviquest-only` is expected to fail every cross-page task. That is the honest
 * result, not a bug: nothing in the SDK clicks, and a lane that hid it would be
 * claiming a capability the package does not ship.
 */
const COMPARE = [
  { url: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
    question: 'what does the fetch method return', gold: 'promise', hop: null },
  { url: 'https://en.wikipedia.org/wiki/Web_scraping',
    question: 'techniques used for web scraping', gold: 'scraping', hop: null },
  // A hop's gold must be absent from its START page, or an arm that never
  // navigated scores on a word it was handed for free — the lane asserts this
  // below rather than trusting the choice. `concurrently` and `response` were
  // the first picks and both failed that test.
  { url: 'https://docs.python.org/3/library/asyncio.html',
    question: 'run awaitables concurrently',
    gold: ['running tasks concurrently', 'schedule coroutines concurrently'],
    hop: 'go to the coroutines and tasks page' },
  { url: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
    question: 'response body headers status', gold: 'response.body',
    hop: 'open the Response interface reference' },
];

/** One estimator, every arm. Matches the SDK's own chars-per-token default. */
const toks = (s: string) => Math.ceil(s.length / 4);
const says = (s: string, gold: string) => s.replace(/\\"/g, '"').toLowerCase().includes(gold);
const saysAny = (s: string, gold: string | readonly string[]) =>
  (Array.isArray(gold) ? gold : [gold]).some((phrase) => says(s, phrase));

async function laneCompare(context: BrowserContext) {
  console.log('\n=== compare: playwright vs playwright+naviquest vs naviquest-only ===');
  const page = await context.newPage();
  const rows: Array<Record<string, unknown>> = [];
  const leaked: string[] = [];

  for (const t of COMPARE) {
    const arms: Record<string, { tokens: number; answered: boolean; calls: number }> = {};

    // ARM 1 — Playwright alone. To cross a page it must find the link inside the
    // snapshot it already paid for, so the hop costs a second full snapshot.
    await page.goto(t.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    if (t.hop && saysAny(await page.locator('body').innerText(), t.gold)) {
      leaked.push(Array.isArray(t.gold) ? t.gold.join(' | ') : t.gold);
    }
    let pwTokens = 0; let pwCalls = 0; let pwText = '';
    {
      const snap = await page.locator('body').ariaSnapshot();
      pwTokens += toks(snap); pwCalls++; pwText = snap;
      if (t.hop) {
        // Generous to this arm: pick the snapshot link with the most words in
        // common with the intent, which is what a model would do with the dump.
        const want = new Set(t.hop.toLowerCase().split(/\W+/).filter(Boolean));
        const best = [...snap.matchAll(/- link "([^"]+)"/g)]
          .map((m) => m[1])
          .map((name) => ({ name, hits: name.toLowerCase().split(/\W+/).filter((w) => want.has(w)).length }))
          .sort((a, b) => b.hits - a.hits)[0];
        if (best?.hits) {
          await page.getByRole('link', { name: best.name, exact: true }).first()
            .click({ timeout: 8000 }).catch(() => {});
          await page.waitForLoadState('domcontentloaded');
          await page.waitForTimeout(1200);
          const snap2 = await page.locator('body').ariaSnapshot();
          pwTokens += toks(snap2); pwCalls++; pwText = snap2;
        }
      }
    }
    arms.playwright = { tokens: pwTokens, answered: saysAny(pwText, t.gold), calls: pwCalls };

    // ARM 2 — the SDK retrieves and names; Playwright actuates.
    await page.goto(t.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await waitForNaviquestTools(page);
    let wqTokens = 0; let wqCalls = 0; let wqText = '';
    const pay = (v: unknown) => { const s = JSON.stringify(v); wqTokens += toks(s); wqCalls++; return s; };
    {
      if (t.hop) {
        const lc: any = await invokeNaviquest(page, 'locate_control', { description: t.hop });
        pay(lc);
        const target = lc.recommendedAddress ?? lc.candidates?.[0]?.address;
        if (target?.name && target?.role) {
          await page.getByRole(target.role, { name: target.name, exact: true }).first()
            .click({ timeout: 8000 }).catch(() => {});
          await page.waitForLoadState('domcontentloaded');
          await page.waitForTimeout(1200);
          await waitForNaviquestTools(page);
        }
      }
      const f: any = await invokeNaviquest(page, 'find_on_page', { query: t.question, limit: 3 });
      wqText = pay(f);
      if (f.results?.[0]?.address && !saysAny(wqText, t.gold)) {
        const r: any = await invokeNaviquest(page, 'resolve_address', { address: f.results[0].address, expand: true });
        wqText += pay(r);
      }
    }
    arms['playwright+naviquest'] = { tokens: wqTokens, answered: saysAny(wqText, t.gold), calls: wqCalls };

    // ARM 3 — tools only. Same start page, no click.
    await page.goto(t.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await waitForNaviquestTools(page);
    let soloTokens = 0; let soloCalls = 0; let soloText = '';
    {
      const f: any = await invokeNaviquest(page, 'find_on_page', { query: t.question, limit: 3 });
      const s = JSON.stringify(f); soloTokens += toks(s); soloCalls++; soloText = s;
      if (f.results?.[0]?.address && !saysAny(soloText, t.gold)) {
        const r: any = await invokeNaviquest(page, 'resolve_address', { address: f.results[0].address, expand: true });
        const s2 = JSON.stringify(r); soloTokens += toks(s2); soloCalls++; soloText += s2;
      }
    }
    arms['naviquest-only'] = { tokens: soloTokens, answered: saysAny(soloText, t.gold), calls: soloCalls };

    const label = `${t.url.replace('https://', '').split('/')[0]}${t.hop ? ' +hop' : ''}: ${t.question}`;
    console.log(`\n  ${label}`);
    for (const [name, a] of Object.entries(arms)) {
      console.log(`    ${a.answered ? 'answered' : 'MISSED  '}  ${String(a.tokens).padStart(6)} tok  ${a.calls} call(s)  ${name}`);
    }
    rows.push({ ...t, arms });
  }

  // The claim the package makes is cheapness at equal correctness, so grade both
  // halves. A cheap arm that misses is not a win, and neither is a correct one
  // that costs a full page dump.
  const single = rows.filter((r) => !r.hop);
  const hops = rows.filter((r) => r.hop);
  const sum = (rs: typeof rows, arm: string, k: 'tokens' | 'answered') =>
    rs.reduce((a, r: any) => a + Number(r.arms[arm][k]), 0);

  check('every hop asks for something its start page does not already say',
    leaked.length === 0, leaked);
  check('the SDK answers every question Playwright answers',
    rows.every((r: any) => !r.arms.playwright.answered || r.arms['playwright+naviquest'].answered),
    rows.filter((r: any) => r.arms.playwright.answered && !r.arms['playwright+naviquest'].answered).map((r: any) => r.question));

  const wqTok = sum(rows, 'playwright+naviquest', 'tokens');
  const pwTok = sum(rows, 'playwright', 'tokens');
  console.log(`\n  totals: playwright ${pwTok} tok · playwright+naviquest ${wqTok} tok`
    + ` · ${(pwTok / Math.max(wqTok, 1)).toFixed(1)}× cheaper`
    + ` · answered ${sum(rows, 'playwright', 'answered')}/${rows.length} vs ${sum(rows, 'playwright+naviquest', 'answered')}/${rows.length}`);
  check('the SDK costs less than reading the accessibility tree', wqTok < pwTok, { wqTok, pwTok });

  check('tools alone answer a single-page question',
    single.every((r: any) => r.arms['naviquest-only'].answered),
    single.filter((r: any) => !r.arms['naviquest-only'].answered).map((r: any) => r.question));
  // Stated as an expectation so a future actuation capability shows up here as a
  // failing check rather than passing silently and leaving this text stale.
  check('tools alone cannot cross a page, and the lane says so',
    hops.every((r: any) => !r.arms['naviquest-only'].answered),
    hops.filter((r: any) => r.arms['naviquest-only'].answered).map((r: any) => r.question));

  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, 'compare.json'),
    JSON.stringify({ measuredAt: new Date().toISOString(), estimator: 'chars/4', rows }, null, 2));
  console.log(`       wrote ${path.join(OUT, 'compare.json')}`);
  await page.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// LANE: rank — structural content prior (chrome demotion), measured
// ─────────────────────────────────────────────────────────────────────────────
//
// Real end-to-end measurement, no model and no fake. The failure this lane
// reproduces is #1: BM25 rewards term density, so a nav/footer block dense with
// query nouns out-ranks the single sentence that answers the query. The fix is a
// declared, index-time signal — the chrome landmark role — used to scale the
// score (config `retrieval.chromePenalty`). The lane serves ONE fixture, then
// measures the SAME code twice: `chromePenalty: 1` (off) vs the default (on).
// Off must reproduce the failure (chrome ranks #1); on must fix it (the answer
// ranks #1) — a genuine before/after on the metric, one config change apart.

// A mega-menu and a footer that REPEAT the exact query phrases (short, dense,
// no connecting prose — lexically ideal, semantically chrome), plus content
// sections that genuinely answer. The repetition is what makes BM25 rank the
// chrome above the answering prose, which is the real #1 failure.
const RANK_FIXTURE = `<!doctype html><html lang="en"><title>rank</title>
  <nav aria-label="Primary"><p>Refunds Refund Policy Refunds Refund Policy Returns Refund Policy Refunds</p>
    <p>Shipping Delivery Shipping Tracking Shipping Delivery Shipping Delivery</p></nav>
  <main>
    <h1>Help center</h1>
    <section><h2>Refunds</h2><p>Our refund policy gives you a full refund to the original payment method within thirty days of the return arriving.</p></section>
    <section><h2>Shipping</h2><p>Standard shipping delivers your order within five business days and every delivery includes a tracking link.</p></section>
  </main>
  <footer><p>Refund Policy Shipping Delivery Returns Refund Policy Shipping Delivery Refund Policy</p></footer>`;

// query → substring identifying the gold section that actually answers it.
const RANK_QUERIES: Array<{ query: string; gold: string }> = [
  { query: 'what is the refund policy', gold: 'Refunds' },
  { query: 'shipping and delivery times', gold: 'Shipping' },
];

// #6: a dense <img alt> (a description of a picture, short and noun-packed —
// lexically ideal) in its own section, competing with the prose that answers.
// The alt text is not a claim the page makes, so it must not out-rank the prose.
const IMG_FIXTURE = `<!doctype html><html lang="en"><title>img</title><main>
  <h1>Headphones</h1>
  <section><h2>Photo</h2><img alt="wireless bluetooth noise cancelling headphones wireless bluetooth noise cancelling battery long"></section>
  <section><h2>Details</h2><p>These wireless bluetooth headphones deliver active noise cancelling and give long battery life on a single charge before you need to plug in.</p></section>
</main>`;
const IMG_QUERY = 'wireless bluetooth noise cancelling headphones battery';

// A citation / back-matter section (heading "References") that REPEATS the query
// vocabulary densely — lexically ideal, but it only cites the fact the prose
// states once. Without the prior BM25 ranks the citation pile above the
// answering sentence; the citation heading is a declared signal that demotes it.
const CITE_FIXTURE = `<!doctype html><html lang="en"><title>cite</title><main>
  <h1>Linux</h1>
  <section><h2>Overview</h2><p>The mascot of Linux is a penguin named Tux, created by Larry Ewing in 1996.</p></section>
  <section><h2>References</h2><p>Linux mascot Tux Linux mascot Tux Linux mascot penguin Linux mascot Tux Linux mascot penguin Linux mascot Tux Linux mascot penguin</p></section>
</main>`;
const CITE_QUERY = 'what is the linux mascot';

async function laneRank(browser: Browser) {
  console.log('\n=== rank: structural chrome-demotion prior (measured before/after) ===');
  const BUNDLE = await bundleSdk('WQ');
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    const u = req.url || '/';
    res.end(u.startsWith('/img') ? IMG_FIXTURE : u.startsWith('/cite') ? CITE_FIXTURE : RANK_FIXTURE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('rank fixture server did not bind');
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const page = await browser.newPage();
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: BUNDLE });

    const out = await page.evaluate(async (queries) => {
      const WQ: any = (window as any).WQ;
      const CHROME = new Set(['navigation', 'banner', 'contentinfo']);
      const label = (x: any) => (x.address?.headingPath ?? x.headingPath ?? []).at(-1) ?? null;
      const isChrome = (x: any) => CHROME.has(x.address?.landmark ?? '');
      const rowsOf = (r: any) => (r.results ?? [])
        .map((x: any) => ({ label: label(x), chrome: isChrome(x), score: x.score ?? 0 }));
      // How many chrome passages are ranked ABOVE a RELEVANT content passage
      // (score > 0) — the exact defect: a nav menu or footer sitting above the
      // prose that actually answers. Irrelevant content ranking below a
      // term-matching chrome block is correct and is not counted.
      const inversions = (rows: Array<{ chrome: boolean; score: number }>) => {
        let inv = 0;
        for (let i = 0; i < rows.length; i++)
          if (rows[i].chrome) for (let j = i + 1; j < rows.length; j++) if (!rows[j].chrome && rows[j].score > 0) inv++;
        return inv;
      };

      // Same code, one config change apart. `off` disables the prior; `on` is the
      // shipped default. No model, no fake — real retrieval both times. Budget is
      // lifted so the FULL ranked order is visible; in production the shrinker
      // returns only the top result, which is why ranking it right matters.
      const wide = { adaptiveBudget: { enabled: false }, budgets: { find_on_page: 100000 } };
      const off: any = await WQ.createNaviquest({ tuning: { ...wide, retrieval: { chromePenalty: 1 } } });
      const on: any = await WQ.createNaviquest({ tuning: wide });

      const rows = [] as any[];
      let offInv = 0, onInv = 0;
      for (const { query } of queries) {
        const ro = rowsOf(await off.tools.find_on_page({ query, limit: 8 }));
        const rn = rowsOf(await on.tools.find_on_page({ query, limit: 8 }));
        offInv += inversions(ro);
        onInv += inversions(rn);
        rows.push({ query, off: ro, on: rn });
      }
      return { total: queries.length, offInv, onInv, rows };
    }, RANK_QUERIES);

    const fmt = (rs: Array<{ label: string; chrome: boolean }>) =>
      rs.map((r) => `${r.chrome ? '▚' : '·'}${r.label}`).join(', ');
    for (const r of out.rows) {
      console.log(`  off [${fmt(r.off)}]`);
      console.log(`  on  [${fmt(r.on)}]`);
    }
    console.log(`  chrome-above-content inversions: without prior ${out.offInv} → with prior ${out.onInv}  (▚ = chrome)`);

    // The failure must actually reproduce, or the fix proves nothing.
    check('without the prior, chrome passages rank above answering content (failure reproduced)',
      out.offInv > 0, out.rows);
    // The prior must eliminate every chrome-above-content inversion.
    check('with the prior, every content passage ranks above every chrome passage',
      out.onInv === 0, out.rows);
    // Strict improvement, never a regression.
    check('the prior strictly reduces chrome-above-content inversions',
      out.onInv < out.offInv, { off: out.offInv, on: out.onInv });

    // #6 image-alt demotion, same before/after method on a separate fixture.
    await page.goto(`${origin}/img`, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: BUNDLE });
    const img = await page.evaluate(async (query) => {
      const WQ: any = (window as any).WQ;
      const label = (x: any) => (x.address?.headingPath ?? x.headingPath ?? []).at(-1) ?? null;
      // The image passage is the section headed "Photo"; content is anything else
      // with a real score. Count image passages ranked above answering content.
      const order = (r: any) => (r.results ?? []).map((x: any) => ({ img: label(x) === 'Photo', score: x.score ?? 0, label: label(x) }));
      const inv = (rs: any[]) => { let n = 0; for (let i = 0; i < rs.length; i++) if (rs[i].img) for (let j = i + 1; j < rs.length; j++) if (!rs[j].img && rs[j].score > 0) n++; return n; };
      const wide = { adaptiveBudget: { enabled: false }, budgets: { find_on_page: 100000 } };
      const off: any = await WQ.createNaviquest({ tuning: { ...wide, retrieval: { imageAltPenalty: 1 } } });
      const on: any = await WQ.createNaviquest({ tuning: wide });
      const ro = order(await off.tools.find_on_page({ query, limit: 8 }));
      const rn = order(await on.tools.find_on_page({ query, limit: 8 }));
      return { off: ro, on: rn, offInv: inv(ro), onInv: inv(rn) };
    }, IMG_QUERY);
    const ifmt = (rs: Array<{ label: string; img: boolean }>) => rs.map((r) => `${r.img ? '🖼' : '·'}${r.label}`).join(', ');
    console.log(`  off [${ifmt(img.off)}]`);
    console.log(`  on  [${ifmt(img.on)}]`);
    console.log(`  image-above-content inversions: without prior ${img.offInv} → with prior ${img.onInv}  (🖼 = image alt)`);
    // The user-facing stakes: the budget shrinker returns only the top result,
    // so the guarantee is that the picture description no longer out-ranks the
    // answer. (A dense alt still out-scores trivially-relevant fragments, which
    // no sane penalty sinks it below — that is not the defect and is not gated.)
    check('without the prior, image alt text is the top result over answering content (failure reproduced)',
      img.off[0]?.img === true, img.off);
    check('with the prior, the answering content is the top result, not the image',
      img.on[0]?.img === false, img.on);
    check('the image-alt prior strictly reduces image-above-content inversions',
      img.onInv < img.offInv, { off: img.offInv, on: img.onInv });

    // Citation demotion, same before/after method on a References fixture.
    await page.goto(`${origin}/cite`, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: BUNDLE });
    const cite = await page.evaluate(async (query) => {
      const WQ: any = (window as any).WQ;
      const label = (x: any) => (x.address?.headingPath ?? x.headingPath ?? []).at(-1) ?? null;
      // The citation passage is headed "References"; content is anything else
      // with a real score. Count citation passages ranked above answering content.
      const order = (r: any) => (r.results ?? []).map((x: any) => ({ cite: label(x) === 'References', score: x.score ?? 0, label: label(x) }));
      const inv = (rs: any[]) => { let n = 0; for (let i = 0; i < rs.length; i++) if (rs[i].cite) for (let j = i + 1; j < rs.length; j++) if (!rs[j].cite && rs[j].score > 0) n++; return n; };
      const wide = { adaptiveBudget: { enabled: false }, budgets: { find_on_page: 100000 } };
      const off: any = await WQ.createNaviquest({ tuning: { ...wide, retrieval: { citationPenalty: 1 } } });
      const on: any = await WQ.createNaviquest({ tuning: wide });
      const ro = order(await off.tools.find_on_page({ query, limit: 8 }));
      const rn = order(await on.tools.find_on_page({ query, limit: 8 }));
      return { off: ro, on: rn, offInv: inv(ro), onInv: inv(rn) };
    }, CITE_QUERY);
    const cfmt = (rs: Array<{ label: string; cite: boolean; score: number }>) => rs.map((r) => `${r.cite ? '❡' : '·'}${r.label}:${r.score.toFixed(2)}`).join(', ');
    console.log(`  off [${cfmt(cite.off)}]`);
    console.log(`  on  [${cfmt(cite.on)}]`);
    // A micro-fixture cannot reproduce Wikipedia's page-scale inversion (idf and
    // heading-weight favour the short answer here), so this gate proves the
    // MECHANISM deterministically: the declared signal attenuates the citation
    // passage by exactly `citationPenalty` and leaves answering content
    // untouched. The end-to-end evidence (Linux mascot 5→6) came from a
    // gold-substring harness that has since been deleted — re-measure with
    // eval/agent before citing it again.
    const refOff = cite.off.find((r: any) => r.cite)?.score ?? 0;
    const refOn = cite.on.find((r: any) => r.cite)?.score ?? 0;
    const contentOff = cite.off.find((r: any) => !r.cite)?.score ?? 0;
    const contentOn = cite.on.find((r: any) => !r.cite)?.score ?? 0;
    console.log(`  citation score ${refOff.toFixed(3)} → ${refOn.toFixed(3)} (×${(refOn / refOff).toFixed(2)}); content ${contentOff.toFixed(3)} → ${contentOn.toFixed(3)}`);
    check('the citation prior attenuates a References passage by the penalty factor',
      refOff > 0 && Math.abs(refOn - refOff * 0.5) < 0.01, { refOff, refOn });
    check('the citation prior leaves answering content untouched',
      contentOff > 0 && Math.abs(contentOn - contentOff) < 0.01, { contentOff, contentOn });

    await page.close();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Only run when this file IS the command. The three host-adapter exports above
 * are the documented way an automation host injects the SDK into an origin it
 * does not own (README, docs/TESTING.md), so importing them must not launch a
 * browser and run the suite as a side effect.
 */
const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntry) {
  const started = Date.now();
  console.log(`naviquest eval — ${LIVE ? 'gates + live sensors' : 'gates only (add --live for network sensors)'}`);

  const browser = await chromium.launch({ channel: 'chrome', args: WEBMCP_CHROME_ARGS });
  try {
    if (wanted('surface')) laneSurface();
    if (wanted('roles')) await laneRoles(browser);
    if (wanted('contracts')) await laneContracts(browser);
    if (wanted('frames')) await laneFrames(browser);
    if (wanted('rank')) await laneRank(browser);

    if (LIVE || ONLY === 'invariants' || ONLY === 'crawl' || ONLY === 'compare') {
      const install = await buildNaviquestInstallScript();
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 }, locale: 'en-US', bypassCSP: true,
      });
      await context.addInitScript({ content: install });
      try {
        if (wanted('invariants')) await laneInvariants(context);
        // Skipped under --url: the crawl's start pages are its fixtures, so
        // pointing it at another origin would measure nothing.
        if (wanted('crawl') && !URL_ARG) await laneCrawl(context);
        if (wanted('compare') && !URL_ARG) await laneCompare(context);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\n=== ${pass}/${pass + fail} checks passed in ${((Date.now() - started) / 1000).toFixed(1)}s ===`);
  if (fail) {
    for (const name of failures) console.log(`  failed: ${name}`);
    process.exit(1);
  }
  process.exit(0);
}
