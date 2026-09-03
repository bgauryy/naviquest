/**
 * The WebMCP boundary — the path an agent actually takes.
 *
 * `yarn eval` owns tool BEHAVIOUR and drives it in real Chrome. It cannot drive
 * this. Two reasons, both structural rather than incidental:
 *
 *   1. The offline gate's fake `modelContext` implements `registerTool` only
 *      (eval.ts § "Registration is one six-tool transaction"), so nothing
 *      offline ever calls `execute`. The full wire path — `getTools` ->
 *      `executeTool` -> stringified `ToolResult` -> `content[0].text` -> the
 *      payload — is exercised only under `--live`, which needs Chrome's WebMCP
 *      flag and a network.
 *   2. Cancellation is unreachable in ANY shipping browser. `execute`'s signal
 *      handling is written against the spec's `required AbortSignal signal`,
 *      and index.ts records the measurement against Chrome 151: `execute` is
 *      invoked with one argument and no signal. A mock is the only thing that
 *      can reach that branch before the day Chrome closes the gap.
 *
 * So this file mocks the PLATFORM, never the SDK. Nothing here asserts ranking,
 * naming or projection quality — those belong to `yarn eval` and would be a lie
 * measured against jsdom. What it asserts is marshalling: that every tool's
 * payload survives the double JSON encoding, that the input gate rejects what
 * it claims to, that registration and `toolDefs()` cannot drift, and that abort
 * means abort.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolDefinition } from '../src/webmcp.d.ts';

/**
 * A spec-faithful `ModelContext`, built from `webmcp.d.ts` rather than from
 * what the SDK happens to call: duplicate names reject with `InvalidStateError`,
 * `getTools` sorts by name in code-unit order, `executeTool` takes the tool
 * OBJECT plus a JSON string and resolves to the STRINGIFIED result. Loosening
 * any of those would let a bug through that the platform would catch.
 */
function fakeModelContext() {
  const tools = new Map<string, ToolDefinition>();
  return {
    calls: [] as string[],
    async registerTool(def: ToolDefinition, options?: { signal?: AbortSignal }) {
      this.calls.push(def.name);
      if (tools.has(def.name)) throw new DOMException('duplicate', 'InvalidStateError');
      tools.set(def.name, def);
      options?.signal?.addEventListener('abort', () => tools.delete(def.name), { once: true });
    },
    async getTools() {
      return [...tools.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    async executeTool(tool: { name: string }, input?: string | Record<string, unknown>,
                      options?: { signal?: AbortSignal }) {
      const def = tools.get(tool.name);
      if (!def) throw new DOMException('no such tool', 'NotFoundError');
      const args = typeof input === 'string' ? JSON.parse(input) : input;
      return JSON.stringify(await def.execute(args, options as never));
    },
    def: (name: string) => tools.get(name),
    size: () => tools.size,
  };
}

type Fake = ReturnType<typeof fakeModelContext>;

/**
 * The agent's path, step for step — deliberately the same sequence as
 * `invokeNaviquest` in eval.ts so the offline and live harnesses cannot drift
 * in how they address the surface.
 */
async function callTool(mc: Fake, name: string, args: unknown = {}, signal?: AbortSignal) {
  const registered = await mc.getTools();
  const tool = registered.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} was not registered`);
  const wire = JSON.parse(await mc.executeTool(tool, JSON.stringify(args), { signal }));
  const text = wire.content?.find((item: { type: string }) => item.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error(`${name} returned no text content`);
  return { wire, payload: JSON.parse(text) };
}

let mc: Fake;

beforeEach(() => {
  document.body.innerHTML = `
    <main>
      <h1>Parking permits</h1>
      <p>Residents may apply for a resident permit at the counter on weekdays.</p>
      <form><label for="q">Search permits</label><input id="q" name="q"></form>
      <button type="button">Apply now</button>
    </main>`;
  mc = fakeModelContext();
  Object.defineProperty(document, 'modelContext', { configurable: true, value: mc });
});

afterEach(() => { delete (document as { modelContext?: unknown }).modelContext; });

/** Minimal arguments that must produce a real answer, not a validation error.
 *  `resolve_address` is absent: its one required field is an address, which has
 *  to come from a previous tool call rather than a literal. */
const MINIMAL: Record<string, Record<string, unknown>> = {
  describe_app: {},
  find_on_page: { query: 'permit' },
  locate_control: { description: 'apply now' },
  query_selector: { selector: 'button' },
  agentic_content: {},
};

describe('registration publishes the surface it advertises', () => {
  it('registers all six names and nothing else', async () => {
    const { createNaviquest } = await import('../src/index.ts');
    const api = await createNaviquest({});

    const result = await api.register();

    expect(result.registered).toBe(true);
    expect((await mc.getTools()).map((t) => t.name)).toEqual([
      'agentic_content', 'describe_app', 'find_on_page',
      'locate_control', 'query_selector', 'resolve_address',
    ]);
  });

  /**
   * index.ts § toolDefinition claims annotations are "declared here, once, so
   * `toolDefs` and the WebMCP registration cannot disagree". They are in fact
   * copied field by field into `registerTool`, so the claim is an invariant
   * someone has to hold, not one the compiler holds. This is that someone.
   */
  it('registers exactly what toolDefs() advertises', async () => {
    const { createNaviquest } = await import('../src/index.ts');
    const api = await createNaviquest({});
    await api.register();

    for (const def of await api.toolDefs()) {
      const registered = mc.def(def.name)!;
      expect(registered).toBeTruthy();
      expect(registered.title).toBe(def.title);
      expect(registered.description).toBe(def.description);
      expect(registered.inputSchema).toEqual(def.inputSchema);
      expect(registered.annotations).toEqual(def.annotations);
    }
  });

  /** `untrustedContentHint` is the declared mitigation for handing page text to
   *  a model; `readOnlyHint` is per-tool, and `resolve_address` is the one tool
   *  that can act on the page. Neither may drift silently. */
  it('declares untrustedContentHint everywhere and readOnlyHint per tool', async () => {
    const { createNaviquest } = await import('../src/index.ts');
    const api = await createNaviquest({});

    const defs = await api.toolDefs();
    for (const def of defs) expect(def.annotations?.untrustedContentHint).toBe(true);
    const writable = defs.filter((d) => d.annotations?.readOnlyHint === false).map((d) => d.name);
    expect(writable).toEqual(['resolve_address']);
  });
});

describe('every tool survives the wire', () => {
  /**
   * The payload is JSON-encoded into `content[0].text` and that ToolResult is
   * itself stringified by the platform. Anything non-serialisable in a payload
   * — a leaked `Element`, a `Map`, a cycle — either throws inside `execute` or
   * silently arrives as `{}`. Only the round trip can tell.
  */
  it.each(Object.keys(MINIMAL))('%s returns a parseable payload', async (name) => {
    const { createNaviquest } = await import('../src/index.ts');
    const api = await createNaviquest({});
    await api.register();

    const { wire, payload } = await callTool(mc, name, MINIMAL[name]);

    expect(wire.content[0].type).toBe('text');
    expect(payload).toBeTypeOf('object');
    expect(payload.error).toBeUndefined();
  });

  it('gives every truncated inventory a copyable, uniform next call', async () => {
    document.body.innerHTML = `<main><h1>Services</h1><button>Apply</button><button>Cancel</button><button>Save</button></main>`;
    const { createNaviquest } = await import('../src/index.ts');
    const api = await createNaviquest({});
    await api.register();

    const first = await callTool(mc, 'query_selector', { selector: 'button', limit: 1 });
    const next = first.payload.pagination?.next;
    expect(first.payload.truncated).toBeGreaterThan(0);
    expect(first.payload.pagination?.complete).toBe(false);
    expect(next).toHaveLength(1);
    expect(first.payload.continuation).toBeUndefined();
    expect(next[0]).toMatchObject({ tool: 'query_selector', arguments: { selector: 'button', offset: 1 } });

    const second = await callTool(mc, next[0].tool, next[0].arguments);
    expect(second.payload.offset).toBe(1);
    expect(second.payload.error).toBeUndefined();
  });

  /** The address round trip is the one cross-tool contract: an address minted
   *  by one tool has to be resolvable by another, THROUGH the wire encoding. */
  it('resolve_address accepts an address minted over the wire', async () => {
    const { createNaviquest } = await import('../src/index.ts');
    const api = await createNaviquest({});
    await api.register();

    const listed = await callTool(mc, 'query_selector', { selector: 'button' });
    const address = listed.payload.nodes?.[0]?.address ?? listed.payload.results?.[0]?.address;
    expect(address, 'query_selector minted no address to resolve').toBeTruthy();

    const { payload } = await callTool(mc, 'resolve_address', { address });

    expect(payload.error).toBeUndefined();
  });

  it('declares and validates frame address identity over the wire', async () => {
    const { createNaviquest } = await import('../src/index.ts');
    const api = await createNaviquest({});
    await api.register();

    const resolveDef = (await api.toolDefs()).find((def) => def.name === 'resolve_address');
    const schema = resolveDef?.inputSchema as {
      properties?: { address?: { properties?: Record<string, unknown> } };
    };
    expect(schema.properties?.address?.properties?.frame).toEqual({
      type: 'string', minLength: 1,
    });

    const listed = await callTool(mc, 'query_selector', { selector: 'button' });
    const address = listed.payload.nodes?.[0]?.address ?? listed.payload.results?.[0]?.address;
    const { payload } = await callTool(mc, 'resolve_address', {
      address: { ...address, frame: { path: 'document/frame[1]' } },
    });

    expect(payload.error).toBe('INVALID_INPUT');
  });
});

describe('the input gate holds at the platform edge', () => {
  /**
   * A regression lock on a fixed defect. The old `args ?? {}` wrapper turned an
   * explicitly invalid `null` into a successful `describe_app({})` — the worst
   * possible outcome, because the agent is told its malformed call worked.
   */
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', '{"query":"permit"}'],
    ['a number', 42],
  ])('rejects %s rather than treating it as empty input', async (_label, args) => {
    const { createNaviquest } = await import('../src/index.ts');
    const api = await createNaviquest({});
    await api.register();

    const { payload } = await callTool(mc, 'describe_app', args);

    expect(payload.outcome).toBe('error');
    expect(payload.error).toBe('INVALID_INPUT');
  });

  it('treats absent input as empty input', async () => {
    const { createNaviquest } = await import('../src/index.ts');
    const api = await createNaviquest({});
    await api.register();

    const { payload } = await callTool(mc, 'describe_app', undefined);

    expect(payload.error).toBeUndefined();
  });
});

/**
 * One page, one `modelContext`, several SDK instances over its life — an SPA
 * that disposes on route change and constructs again, or two bundled copies of
 * the SDK. eval.ts drives one instance through failure, retry and dispose; the
 * handoff BETWEEN instances is only visible with more than one.
 */
describe('instances hand the modelContext over cleanly', () => {
  it('refuses a second instance instead of racing it for the six names', async () => {
    const { createNaviquest } = await import('../src/index.ts');
    const first = await createNaviquest({});
    await first.register();

    const second = await createNaviquest({});
    const result = await second.register();

    expect(result.registered).toBe(false);
    // The platform would reject the duplicate anyway; what this buys is a
    // reason naming the conflict rather than six InvalidStateErrors.
    expect(result.reason).toMatch(/already has Naviquest tools/);
    expect(mc.size()).toBe(6);
  });

  /**
   * `claimed` is a module-level WeakSet and `dispose()` is the only thing that
   * releases it. Drop that one `delete` and every later instance on the page is
   * refused forever — a route change would silently end WebMCP support, with
   * the surface unregistered and nothing able to re-register it.
   */
  it('lets a fresh instance take over after the previous one disposes', async () => {
    const { createNaviquest } = await import('../src/index.ts');
    const first = await createNaviquest({});
    await first.register();
    first.dispose();
    expect(mc.size()).toBe(0);

    const second = await createNaviquest({});
    const result = await second.register();

    expect(result.registered).toBe(true);
    expect(mc.size()).toBe(6);
    const { payload } = await callTool(mc, 'find_on_page', { query: 'permit' });
    expect(payload.error).toBeUndefined();
  });

  it('says so rather than registering a dead surface after dispose', async () => {
    const { createNaviquest } = await import('../src/index.ts');
    const api = await createNaviquest({});
    api.dispose();

    const result = await api.register();

    expect(result.registered).toBe(false);
    expect(result.reason).toMatch(/disposed/);
  });
});

/**
 * Chrome 151 passes no signal, so none of this is reachable in a browser today.
 * It is written against the spec's `required AbortSignal signal` and the
 * documented pending-tool-executions race, and these are the only checks that
 * will notice the day Chrome starts passing one.
 */
describe('abort is honoured at the response boundary', () => {
  it('rejects a turn that was abandoned before the tool was reached', async () => {
    const { createNaviquest } = await import('../src/index.ts');
    const api = await createNaviquest({});
    await api.register();

    const controller = new AbortController();
    controller.abort(new DOMException('turn abandoned', 'AbortError'));

    await expect(callTool(mc, 'describe_app', {}, controller.signal)).rejects.toThrow(/abandoned/);
  });

  it('settles with the abort reason when the turn ends mid-flight', async () => {
    const { createNaviquest } = await import('../src/index.ts');
    const api = await createNaviquest({});
    await api.register();

    const controller = new AbortController();
    const inFlight = callTool(mc, 'find_on_page', { query: 'permit' }, controller.signal);
    controller.abort(new DOMException('turn ended', 'AbortError'));

    await expect(inFlight).rejects.toThrow(/turn ended/);
  });

  /** Abort wins the race; the work it outran still settles. If that settlement
   *  escaped, an abandoned turn would surface as a page-level error event. */
  it('does not leak the outrun work as an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { createNaviquest } = await import('../src/index.ts');
      const api = await createNaviquest({});
      await api.register();

      const controller = new AbortController();
      const inFlight = callTool(mc, 'find_on_page', { query: 'permit' }, controller.signal);
      controller.abort(new DOMException('turn ended', 'AbortError'));
      await inFlight.catch(() => {});
      for (let i = 0; i < 8; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
