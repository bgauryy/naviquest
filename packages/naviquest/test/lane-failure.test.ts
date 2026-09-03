/**
 * The retrieval lane loads lazily (see `build.ts` § EAGER_GZIP_LIMIT and
 * ARCHITECTURE.md "What is eager, and what is not"). That bought 1,556 gzip
 * bytes and introduced a class of state no previous sensor could reach: the
 * window in which the lane module is in flight, and the outcome where it never
 * arrives at all.
 *
 * A page can absolutely land there — a chunk 404 after a deploy, a CSP that
 * blocks the chunk, an OOM-killed worker. The SDK's whole contract is that it
 * degrades honestly instead of guessing, so these are the paths that decide
 * whether that contract holds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lane } from '../src/retrieval/lane.ts';

const LANE = '../src/retrieval/lane.ts';

/** Minimal Lane. Retrieval quality is `yarn eval`'s job; this only has to be
 *  shaped correctly enough for `buildIndex` and the tool surface to run. */
function stubLane(overrides: Partial<Lane> = {}): Lane {
  const empty = { dense: { status: 'off' as const, detail: null }, retrieval: 'lexical' as const };
  const tokens = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return {
    kind: 'inline',
    async: false,
    build: () => ({ indexMs: 1, denseMs: 0, locale: 'en', retrieval: 'lexical', stemLanguage: 'none' }),
    searchContent: () => ({ hits: [], exact: [], retrieval: 'lexical', informative: [] }),
    searchControls: () => ({ hits: [], coverage: [], retrieval: 'lexical' }),
    fuzzy: () => ({ hits: [] }),
    tokens,
    controlTokens: tokens,
    locale: () => 'en',
    stemLanguage: () => 'none',
    dense: () => empty,
    status: () => empty,
    dispose: () => {},
    ...overrides,
  } as Lane;
}

/** Every rejection this file induces is EXPECTED. Capturing them keeps a real
 *  unhandled rejection (the thing T3 is about) distinguishable from noise. */
let unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => { unhandled.push(e); };

beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
  document.body.innerHTML = `
    <main>
      <h1>Parking permits</h1>
      <p>Residents may apply for a permit at the counter on weekdays.</p>
      <button type="button">Apply now</button>
    </main>`;
});

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  vi.resetModules();
  vi.doUnmock(LANE);
});

/** Let queued microtasks and the mocked dynamic import settle. */
const flush = async (turns = 6) => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe('the retrieval lane never arrives', () => {
  it('does not report "still loading" once the load has permanently failed', async () => {
    vi.doMock(LANE, () => ({
      createInlineLane: () => { throw new Error('chunk 404'); },
      createWorkerLane: () => { throw new Error('chunk 404'); },
    }));
    const { createNaviquest } = await import('../src/index.ts');

    const api = await createNaviquest({});
    await flush();

    const lane = api.lane();
    expect(lane.ready).toBe(false);
    // The honest failure is "it failed", not "hold on". A host that polls
    // `ready` on a detail that says "still loading" waits forever.
    expect(String(lane.dense.detail)).not.toMatch(/loading/i);
    expect(`${lane.dense.detail} ${lane.stemLanguage}`).toMatch(/fail|unavailable|error/i);
  });

  it('surfaces the failure to a tool caller rather than hanging', async () => {
    vi.doMock(LANE, () => ({
      createInlineLane: () => { throw new Error('chunk 404'); },
      createWorkerLane: () => { throw new Error('chunk 404'); },
    }));
    const { createNaviquest } = await import('../src/index.ts');

    const api = await createNaviquest({});
    await expect(api.tools.describe_app({})).rejects.toThrow(/chunk 404/);
  });

  it('does not leave the construction-time build as an unhandled rejection', async () => {
    vi.doMock(LANE, () => ({
      createInlineLane: () => { throw new Error('chunk 404'); },
      createWorkerLane: () => { throw new Error('chunk 404'); },
    }));
    const { createNaviquest } = await import('../src/index.ts');

    // Nobody awaits construction on the inline lane — that is the documented
    // contract. So the build it kicks off owns its own failure; leaking it as an
    // unhandled rejection turns a degraded index into a page-level error event.
    createNaviquest({});
    await flush();

    expect(unhandled).toEqual([]);
  });
});

describe('the retrieval lane arrives late', () => {
  it('recovers the tool surface after a failed first build', async () => {
    let attempt = 0;
    vi.doMock(LANE, () => ({
      // Fails once, then works: a chunk that 404s behind a stale CDN edge and
      // succeeds on retry. A transient failure must not be permanent.
      createInlineLane: () => {
        if (++attempt === 1) throw new Error('transient');
        return stubLane();
      },
      createWorkerLane: () => stubLane(),
    }));
    const { createNaviquest } = await import('../src/index.ts');

    const api = await createNaviquest({});
    await flush();

    // The transient failure already happened, during construction. What matters
    // is that the tool surface can come back from it — a cached rejected promise
    // never can, no matter how many times the host retries.
    let described = await api.tools.describe_app({}).catch(() => null);
    if (!described) described = await api.tools.describe_app({});
    expect(described).toBeTruthy();
    expect(api.lane().ready).toBe(true);
  });

  it('coalesces rebuilds raced during the initial load into one index build', async () => {
    const build = vi.fn(() => ({
      indexMs: 1, denseMs: 0, locale: 'en', retrieval: 'lexical' as const, stemLanguage: 'none',
    }));
    vi.doMock(LANE, () => ({
      createInlineLane: () => stubLane({ build }),
      createWorkerLane: () => stubLane({ build }),
    }));
    const { createNaviquest } = await import('../src/index.ts');

    const api = await createNaviquest({});
    // Two rebuilds inside the window where the lane module is still in flight.
    // Before coalescing covered this window, both ran: each captured its own
    // document strings, and whichever `build()` resolved last won the index —
    // leaving hit ids pointing into one projection while `st` held another.
    const both = Promise.all([api.reindex(), api.reindex()]);
    await flush();
    await both;

    // One construction build plus one coalesced rebuild.
    expect(build.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
