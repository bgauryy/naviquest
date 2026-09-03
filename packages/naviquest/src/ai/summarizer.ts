/**
 * Optional Chrome built-in summarization, deliberately owned by index.ts.
 *
 * Retrieval may run in worker.ts; this module never does. `index.ts` imports it
 * lazily only after a main-window tool call explicitly passes `summarize: true`.
 * The input is therefore the same redacted, bounded text the deterministic tool
 * already produced (or the redacted page chunks for describe_app), never DOM,
 * Elements, worker state, passwords, or an unbounded HTML serialization.
 *
 * A generated summary is lossy and untrusted. On success the long source text is
 * compacted, but addresses/provenance/counts remain and `readOriginalWith`
 * gives the exact call that recovers it. Any platform, policy, model, quota, or
 * runtime failure returns the raw payload unchanged with an explicit status.
 */
import type { SummaryTuning, ToolName } from '../config.ts';
import type { ToolPayload } from '../tools/budget.ts';
import { decideAvailability } from './model-gate.ts';

/** Backstop on the token-accounting fixed point below. Not a tunable: the loop
 *  BREAKS on convergence, which decimal widths reach in two or three passes, so
 *  this only bounds a pathological non-convergence. */
const TOKEN_SETTLE_STEPS = 8;

interface BrowserSummarizer {
  summarize(input: string, options?: { signal?: AbortSignal; context?: string }): Promise<string>;
  destroy?: () => void;
}

interface BrowserSummarizerConstructor {
  availability(options?: Record<string, unknown>): Promise<string>;
  create(options?: { signal?: AbortSignal }): Promise<BrowserSummarizer>;
}

export interface SummaryService {
  apply(tool: ToolName, args: ToolPayload, payload: ToolPayload): Promise<ToolPayload>;
  dispose(): void;
}

interface SummaryServiceOptions {
  cfg: SummaryTuning;
  pageChunks: () => Array<{ headingPath: string[]; text: string }>;
  estimate: (value: unknown) => number;
}

const ctor = (): BrowserSummarizerConstructor | null => {
  // The API is Window-only in the current specification. Checking `document`
  // as well as the global prevents an extension or future worker exposure from
  // silently moving generation into the retrieval worker.
  if (typeof document === 'undefined') return null;
  const value = (globalThis as typeof globalThis & { Summarizer?: BrowserSummarizerConstructor }).Summarizer;
  return value && typeof value.availability === 'function' && typeof value.create === 'function'
    ? value : null;
};

const withoutSummary = (args: ToolPayload): ToolPayload => {
  // `reason` is an ephemeral host-observability field, not part of retrieval.
  // Replaying it would notify onIntent twice and copy the agent's rationale into
  // the result, despite the input contract saying Naviquest does not return it.
  const { summarize: _summarize, reason: _reason, ...rest } = args;
  return rest;
};

const cleanStrings = (values: unknown[]): string => [...new Set(values
  .filter((v): v is string => typeof v === 'string')
  .map((v) => v.trim()).filter(Boolean))].join('\n\n');

/** Only authored/readable text, never addresses, state, scores, or JSON syntax. */
function responseText(tool: ToolName, payload: ToolPayload): string {
  if (tool === 'find_on_page') {
    return cleanStrings([
      payload.answer?.text,
      ...(Array.isArray(payload.results) ? payload.results.map((r: ToolPayload) => r?.text) : []),
    ]);
  }
  if (tool === 'resolve_address' || tool === 'agentic_content') {
    return cleanStrings([payload.text]);
  }
  return '';
}

/** Remove only the text the summary replaces; grounding and recovery survive. */
function compact(tool: ToolName, payload: ToolPayload): ToolPayload {
  if (tool === 'find_on_page' && Array.isArray(payload.results)) {
    const answer = payload.answer && typeof payload.answer === 'object'
      ? (() => {
          const { text: _text, ...rest } = payload.answer as ToolPayload;
          return { ...rest, textSummarized: true };
        })()
      : payload.answer;
    return {
      ...payload,
      ...(answer ? { answer } : {}),
      results: payload.results.map((row: ToolPayload) => {
        const { text: _text, ...rest } = row;
        return { ...rest, textSummarized: true };
      }),
    };
  }
  if ((tool === 'resolve_address' || tool === 'agentic_content')
      && typeof payload.text === 'string') {
    const { text: _text, ...rest } = payload;
    return { ...rest, textSummarized: true };
  }
  return payload;
}

const quota = (error: unknown): { requested: number; quota: number } | null => {
  const e = error as { name?: unknown; requested?: unknown; quota?: unknown };
  return e?.name === 'QuotaExceededError'
      && typeof e.requested === 'number' && Number.isFinite(e.requested) && e.requested > 0
      && typeof e.quota === 'number' && Number.isFinite(e.quota) && e.quota > 0
    ? { requested: e.requested, quota: e.quota } : null;
};

/** Paragraph-preferred fixed windows with no overlap: summaries must not count
 * duplicated boundary text as two independent facts. */
function splitText(input: string, chars: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < input.length) {
    let end = Math.min(input.length, start + chars);
    if (end < input.length) {
      const paragraph = input.lastIndexOf('\n\n', end);
      const word = input.lastIndexOf(' ', end);
      const candidate = paragraph > start + chars / 2 ? paragraph : word;
      if (candidate > start) end = candidate;
    }
    out.push(input.slice(start, end).trim());
    start = end;
    while (start < input.length && /\s/.test(input[start])) start++;
  }
  return out.filter(Boolean);
}

export function createSummaryService({ cfg, pageChunks, estimate }: SummaryServiceOptions): SummaryService {
  let session: BrowserSummarizer | null = null;
  let sessionPromise: Promise<BrowserSummarizer> | null = null;
  let disposed = false;

  const returnedTokens = (value: ToolPayload): number => {
    // `_tokens` describes the response around it; counting the accounting field
    // itself would make every recomputation inflate its own result.
    const { _tokens: _reported, ...body } = value;
    return estimate(body);
  };

  const createSession = async (api: BrowserSummarizerConstructor): Promise<BrowserSummarizer> => {
    if (session) return session;
    if (sessionPromise) return sessionPromise;
    const signal = AbortSignal.timeout(cfg.timeoutMs);
    // A session that resolves AFTER dispose() would otherwise live undestroyed
    // forever — dispose() can only destroy what has already arrived.
    sessionPromise = api.create({ signal }).then((created) => {
      if (disposed) { try { created.destroy?.(); } catch { /* optional cleanup */ } return created; }
      return (session = created);
    });
    try { return await sessionPromise; }
    finally { sessionPromise = null; }
  };

  const one = async (model: BrowserSummarizer, input: string): Promise<string> =>
    model.summarize(input, { signal: AbortSignal.timeout(cfg.timeoutMs) });

  const run = async (model: BrowserSummarizer, input: string): Promise<{
    text: string; passes: number; chunks: number; modelCalls: number;
  }> => {
    try {
      return { text: await one(model, input), passes: 1, chunks: 1, modelCalls: 1 };
    } catch (error) {
      const q = quota(error);
      if (!q) throw error;
      const chars = Math.max(cfg.minChunkChars,
                             Math.floor(input.length * (q.quota / q.requested) * cfg.quotaSafetyRatio));
      const chunks = splitText(input, chars);
      if (chunks.length < 2 || chunks.length > cfg.maxChunks) {
        const tooLarge = new Error(`input requires ${chunks.length} summary chunks; ceiling is ${cfg.maxChunks}`);
        tooLarge.name = 'SummaryInputTooLarge';
        throw tooLarge;
      }
      const partials: string[] = [];
      for (const chunk of chunks) partials.push(await one(model, chunk));
      const combined = partials.join('\n');
      try {
        return { text: await one(model, combined), passes: 2, chunks: chunks.length, modelCalls: chunks.length + 2 };
      } catch (finalError) {
        // The partial summaries are already bounded model outputs. If their
        // combination alone exceeds the final quota, returning them explicitly
        // as partial beats discarding successful work or starting an unbounded
        // recursive summarization tree.
        if (!quota(finalError)) throw finalError;
        return { text: combined, passes: 1, chunks: chunks.length, modelCalls: chunks.length + 2 };
      }
    }
  };

  const annotate = (tool: ToolName, payload: ToolPayload, args: ToolPayload, status: string,
                    extra: ToolPayload = {}): ToolPayload => {
    // Recompute accounting from the returned shape. Carrying the source
    // `_tokens` or `_overBudget` into a compacted result would make a successful
    // summary claim the cost and overflow state of text it no longer contains.
    const { _tokens: _sourceTokens, _overBudget: _sourceOverBudget, ...body } = payload;
    const next: ToolPayload = { ...body, summary: {
      status, lossy: true,
      note: status === 'ready'
        ? 'Generated text is a navigation aid, not page evidence. Re-read the original before quoting or acting.'
        : 'The deterministic original payload is unchanged.',
      readOriginalWith: { tool, arguments: withoutSummary(args) },
      ...extra,
    } };
    next._tokens = estimate(next);
    if (typeof next._budget === 'number' && next._tokens > next._budget) next._overBudget = true;
    return next;
  };

  return {
    async apply(tool, args, payload) {
      if (args.summarize !== true || disposed || payload.error) return payload;
      const input = tool === 'describe_app'
        ? pageChunks().map((chunk) => `${chunk.headingPath.join(' > ')}\n${chunk.text}`.trim()).join('\n\n')
        : responseText(tool, payload);
      if (!input) return annotate(tool, payload, args, 'no-input');
      const inputTokens = estimate(input);
      // describe_app summarizes page text that is absent from its raw response;
      // for response tools, a small source cannot repay model latency or the
      // grounding/recovery envelope. This preflight is intentionally followed
      // by the exact postflight payload comparison below: the floor avoids an
      // obvious loss, while the comparison catches unusual model output.
      if (tool !== 'describe_app' && inputTokens < cfg.minInputTokens) {
        return annotate(tool, payload, args, 'skipped-short', {
          inputTokens, minInputTokens: cfg.minInputTokens, modelCalls: 0, latencyMs: 0,
          detail: 'Raw evidence retained because the response is too short to justify model latency.',
        });
      }
      const api = ctor();
      if (!api) return annotate(tool, payload, args, 'unavailable', { detail: 'Summarizer is not exposed in this window.' });

      let availability: string;
      try { availability = await api.availability(); }
      catch (error) {
        return annotate(tool, payload, args, 'failed', { detail: String((error as Error)?.message || error) });
      }
      // Shared policy (model-gate.ts): creating a downloadable model is allowed
      // only while Chrome reports a real user activation, because an agent tool
      // call must not silently choose a multi-gigabyte download for the person
      // using the page. This surface keeps the raw STATUS rather than a gate's
      // null, because unlike the other readers it reports degradation on the
      // wire — and it deliberately does not latch, so it re-probes every call.
      if (decideAvailability(availability) !== 'create') {
        return annotate(tool, payload, args, availability, {
          detail: availability === 'downloadable'
            ? 'Model download needs an active user gesture; retry from a host UI action.'
            : `Chrome reported Summarizer availability as ${availability}.`,
        });
      }

      const started = performance.now();
      try {
        const model = await createSession(api);
        const generated = await run(model, input);
        const capped = generated.text.trim().slice(0, cfg.maxOutputChars);
        if (!capped) return annotate(tool, payload, args, 'failed', { detail: 'Summarizer returned empty text.' });
        const compacted = compact(tool, payload);
        const sourcePayloadTokens = typeof payload._tokens === 'number'
          ? payload._tokens : estimate(payload);
        const ready = annotate(tool, compacted, args, 'ready', {
          text: capped,
          source: tool === 'describe_app' ? 'page' : 'response',
          inputTokens,
          inputChars: input.length,
          outputChars: capped.length,
          reductionPct: Math.max(0, Math.round((1 - capped.length / input.length) * 100)),
          latencyMs: +(performance.now() - started).toFixed(1),
          passes: generated.passes,
          chunks: generated.chunks,
          modelCalls: generated.modelCalls,
          ...(generated.text.trim().length > cfg.maxOutputChars ? { truncated: true } : {}),
        });
        // Report the actual returned-envelope impact, not only the generated
        // prose ratio. Iterate because the metrics themselves cost a few tokens;
        // the values settle once their decimal widths stop changing — and the
        // loop now TESTS that convergence instead of asserting it in prose. The
        // bound is a backstop: decimal widths converge in two or three passes.
        for (let i = 0; i < TOKEN_SETTLE_STEPS; i++) {
          const settled = returnedTokens(ready);
          ready.summary.sourcePayloadTokens = sourcePayloadTokens;
          ready.summary.resultTokens = settled;
          ready.summary.tokensSaved = sourcePayloadTokens - settled;
          ready.summary.tokensSavedPerSecond = ready.summary.latencyMs > 0
            ? +((sourcePayloadTokens - settled) / (ready.summary.latencyMs / 1000)).toFixed(1)
            : null;
          if (ready._tokens === settled) break;
          ready._tokens = settled;
        }
        ready._tokens = returnedTokens(ready);
        // Payload efficiency is the feature's contract, not merely shorter
        // generated prose. On small responses the grounding envelope can cost
        // more than the text it replaces; returning that measured 15% worse in
        // the deterministic sensor. Keep the original evidence and name why.
        // describe_app is the exception: its summary contains bounded page text
        // that the orientation payload never carried, so raw and summarized are
        // different capabilities rather than two encodings of one response.
        if (tool !== 'describe_app' && ready._tokens >= sourcePayloadTokens) {
          const unchanged = { ...payload, summary: {
            status: 'not-smaller', lossy: true,
            note: 'Raw evidence retained because the complete summary envelope was not smaller.',
            latencyMs: ready.summary.latencyMs,
            modelCalls: ready.summary.modelCalls,
            sourcePayloadTokens,
            attemptedResultTokens: ready._tokens,
            attemptedTokensSaved: sourcePayloadTokens - ready._tokens,
          } };
          unchanged._tokens = returnedTokens(unchanged);
          return unchanged;
        }
        return ready;
      } catch (error) {
        // Per spec (MDN Summarizer.create) `create()` requires transient
        // activation unconditionally; Chrome enforces it only for the download
        // path, which is what the availability branch above models. On a
        // spec-conformant engine the `available` path throws NotAllowedError —
        // report it as the same needs-a-gesture state, not a generic failure.
        const name = (error as Error)?.name;
        return annotate(tool, payload, args,
          name === 'SummaryInputTooLarge' ? 'input-too-large'
            : name === 'NotAllowedError' ? 'downloadable' : 'failed',
          { detail: name === 'NotAllowedError'
            ? 'Summarizer.create() needs an active user gesture in this engine; retry from a host UI action.'
            : String((error as Error)?.message || error) });
      }
    },
    dispose() {
      disposed = true;
      try { session?.destroy?.(); } catch { /* optional platform cleanup */ }
      session = null;
    },
  };
}
