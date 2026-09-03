/**
 * WebMCP, typed.
 *
 * The proposal ships no TypeScript definitions, and Chrome's implementation is
 * behind `chrome://flags/#enable-webmcp-testing`, so `document.modelContext` is
 * `undefined` on every stock browser. These declarations describe the surface
 * this SDK actually touches — nothing more — and distinguish the current
 * Community Group draft from Chrome's still-legacy 151–152 testing implementation:
 *
 *   1. `executeTool` takes the tool OBJECT, not its name;
 *   2. `navigator.modelContext` is the Chrome 149 origin-trial name, deprecated
 *      in 150 and still an alias of `document.modelContext` in 151;
 *   3. Chrome 151–152 requires JSON-string input and returns a string schema.
 *      The current draft has moved past both behaviors.
 *      Current IDL is `executeTool(RegisteredTool tool, optional object
 *      inputObject = {}, optional ModelContextExecuteToolOptions options = {})`
 *      — a real object, optional, serialized for you — and `RegisteredTool`'s
 *      `inputSchema` is the result of "parse a JSON string to a JavaScript
 *      value", i.e. an object again. Chrome 151–152 still does string-in /
 *      string-out. Where the two shapes can coexist in one type they both
 *      appear below, so this file does not go stale the day Chrome catches up;
 *   4. WebMCP requires an ORIGIN-KEYED AGENT CLUSTER. Every one of the three
 *      methods rejects with `SecurityError` when the surrounding agent
 *      cluster's "is origin-keyed" is false and the scheme is not `file:` — so
 *      a page served without `Origin-Agent-Cluster: ?1` can hold a perfectly
 *      good `document.modelContext` and still fail to register anything;
 *   5. tool names are validated, not free text: non-empty, at most 128 code
 *      units, and only ASCII alphanumerics plus `_`, `-`, `.`. Anything else
 *      rejects with `InvalidStateError`.
 */

/** Hints an agent harness reads before deciding how to treat a tool's output. */
export interface ToolAnnotations {
  /** Whether every invocation is observational. `resolve_address` is false
   *  because its optional `scrollIntoView` path moves the viewport. */
  readOnlyHint?: boolean;
  /** The result contains page content, which is attacker-controlled. This is
   *  the spec's own Output Injection mitigation and is not optional for a tool
   *  that hands page text to a model. */
  untrustedContentHint?: boolean;
}

/** MCP's content envelope. Tool results are `{ content: [{ type, text }] }`. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
}

/**
 * The second argument to `execute`, and the reason it is typed at all.
 *
 * `dictionary ToolExecuteCallbackOptions { required AbortSignal signal; };` —
 * `required` in the IDL, and NOT PASSED BY CHROME 151. Measured, not assumed:
 * `execute` arrives with one argument and no `signal`. Typed here because the
 * spec says so and the day Chrome catches up should not be a discovery; do not
 * read cancellation into it today.
 * It is not decoration in the spec: the spec keeps a
 * `pending tool executions map` on the traversable navigable, and "cancel a
 * pending tool execution" signals abort on the target document's controller. A
 * long tool that ignores this keeps running after the caller has walked away.
 *
 * The cancellation is also documented as RACING the tool's natural completion:
 * if the entry is removed by resolution first, the `executeTool()` promise is
 * still rejected with the abort reason and never observes the result. So the
 * signal is the only honest way to know the answer will be thrown away.
 */
export interface ToolExecuteCallbackOptions {
  signal: AbortSignal;
}

export interface ToolDefinition {
  /** Non-empty, <= 128 code units, `[A-Za-z0-9_.-]` only — see header note 7. */
  name: string;
  /**
   * A label for display. `ModelContextTool` types this `USVString` rather than
   * `DOMString` on purpose: the title is "for display in possibly native UIs",
   * so unpaired surrogates are replaced on the way IN. `RegisteredTool` can
   * then type it `DOMString`, because that processing has already happened and
   * there is no need to repeat it on the way out.
   *
   * The spec recommends localizing it to `navigator.language`.
   */
  title?: string;
  description: string;
  /** A JSON Schema object at registration time — but a STRING when read back
   *  from Chrome 151–152. The spec parses it back to an object; see header note 3. */
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  /**
   * `callback ToolExecuteCallback = Promise<any> (object inputObject,
   * ToolExecuteCallbackOptions options);` — two parameters, the second
   * required. Handlers that only declare the first stay assignable; handlers
   * that want cancellation now have somewhere to read it from.
   */
  execute: (
    args: Record<string, unknown>,
    options: ToolExecuteCallbackOptions,
  ) => Promise<ToolResult> | ToolResult;
}

/** What `getTools()` hands back in the current draft, with Chrome 151–152's legacy
 * string schema retained in the union for compatibility probes. */
export interface RegisteredTool extends Omit<ToolDefinition, 'inputSchema' | 'execute' | 'title'> {
  /** `DOMString` here, `USVString` on the way in — see `ToolDefinition.title`.
   *  Chrome defaults an absent title to the empty string rather than omitting
   *  the member; webmachinelearning/webmcp#224 is open about changing that, so
   *  treat both `''` and `undefined` as "no title". */
  title?: string;
  inputSchema: Record<string, unknown> | string;
  /**
   * The `Window` of the document that registered the tool — REQUIRED in the
   * IDL, and the other half of how an agent tells frames apart. `getTools()`
   * walks the traversable navigable's INCLUSIVE DESCENDANT NAVIGABLES, i.e. the
   * whole frame tree, not just this document, so two frames each running this
   * SDK return two tools called `find_on_page` distinguished only by `window`,
   * `origin`, and whatever `title` the host set.
   */
  window: Window;
  /**
   * The registering document's serialized origin. REQUIRED, and load-bearing
   * rather than informational: `executeTool()` parses this string first and
   * rejects with `NotSupportedError` if it is a failure or an opaque origin.
   * For same-origin tools it equals the caller's own `origin`; it only tells
   * you something new when the tool came from another origin's frame.
   */
  origin: string;
}

/** Options for `registerTool`. */
export interface ModelContextRegisterToolOptions {
  /**
   * Origins in this document's tree that may see the tool. Absent means an
   * EMPTY LIST, and "tool is exposed to an origin" returns true only for a
   * same-origin caller or one listed here — so the default is same-origin only,
   * and cross-origin exposure is opt-in per tool. Each entry is URL-parsed and
   * must be potentially trustworthy, or the call rejects with `SecurityError`.
   */
  exposedTo?: string[];
  /** Aborting this unregisters the tool. Passing an already-aborted signal
   *  rejects with the signal's abort reason. This is how `dispose()` works. */
  signal?: AbortSignal;
}

/** Options for `getTools`. */
export interface ModelContextGetToolOptions {
  /**
   * Which origins in the frame tree to query. Same-origin documents are always
   * included; this only widens the walk. An empty or absent list therefore
   * means same-origin only. Entries are URL-parsed and must be potentially
   * trustworthy, or the call rejects with `SecurityError`.
   */
  fromOrigins?: string[];
}

/** Options for `executeTool`. */
export interface ModelContextExecuteToolOptions {
  /** Cancels the execution: aborts the signal the tool's `execute` was handed. */
  signal?: AbortSignal;
}

/**
 * Every method here is gated on the policy-controlled feature `tools`, whose
 * default allowlist is `'self'`. A cross-origin iframe therefore has to be
 * given `allow="tools"` or all three methods reject with `NotAllowedError` —
 * and `getTools()` silently SKIPS any frame in the tree that lacks it, so a
 * missing `allow` shows up as a tool that never appears rather than an error.
 */
export interface ModelContext extends EventTarget {
  /**
   * Resolves with nothing. Registering a name that is ALREADY IN THE TOOL MAP
   * rejects with `InvalidStateError` — the platform dedupes for you, so the
   * SDK's WeakSet claim is about not registering twice in the first place, not
   * about the surface tolerating it.
   */
  registerTool(tool: ToolDefinition, options?: ModelContextRegisterToolOptions): Promise<void>;
  /**
   * Optional on this interface deliberately: the surface has already moved once
   * (`navigator` -> `document.modelContext`), and code that probes the platform
   * must not assume the member it probes with exists.
   *
   * Results are sorted by `name`, ascending, code-unit order.
   */
  getTools?(options?: ModelContextGetToolOptions): Promise<RegisteredTool[]>;
  /**
   * Takes the tool OBJECT. Current IDL takes a plain `object` and makes it optional,
   * serializing it internally; the union spans both so neither shape is a type
   * error when probing Chrome 151–152. Resolves to the stringified result.
   */
  executeTool?(
    tool: RegisteredTool,
    input?: string | Record<string, unknown>,
    options?: ModelContextExecuteToolOptions,
  ): Promise<string>;
  /**
   * Fired when the registered tool set changes. The event is `toolchange` and
   * the handler is `ontoolchange` — NOT `change`, which is what these
   * declarations said until it was checked against the event-handler table.
   *
   * An agent harness that caches `getTools()` has no other way to learn the set
   * moved, which is exactly what happens when a host tears Naviquest down on
   * unmount. It fires at every document in the frame tree the tool is exposed
   * to, from a parallel algorithm on the `webmcp task source`: parents are
   * notified before children, but the ordering against your own unrelated tasks
   * is explicitly not something you may rely on.
   */
  ontoolchange?: ((this: ModelContext, ev: Event) => unknown) | null;
}

declare global {
  interface Document { modelContext?: ModelContext }
  /** Deprecated in Chrome 150; still an alias of `document.modelContext` in 151. */
  interface Navigator { modelContext?: ModelContext }
}
