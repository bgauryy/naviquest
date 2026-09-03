/**
 * ONE availability policy for every Chrome built-in AI surface.
 *
 * `LanguageModel`, `Summarizer`, `Translator` and `LanguageDetector` all expose
 * the same `availability()` → `create()` handshake, and every wrapper in this
 * SDK had independently re-derived the same four-state decision from it. That is
 * the single trickiest piece of policy here — the LATCH decision — and it was
 * written four times: lm-session.ts, image-describer.ts, translator.ts (twice,
 * for the detector and the pair) and summarizer.ts. Getting it wrong in one copy
 * does not fail loudly; it permanently disables that one surface on a transient
 * fault. So the decision is derived once, here, and each wrapper keeps only what
 * is genuinely its own: which constructor, which options, which timeout.
 *
 * The policy itself is unchanged from the verifier's original lifecycle:
 *  - `available` → create;
 *  - `downloadable` → creating the model IS the multi-gigabyte download, so it
 *    happens only inside a real user gesture. That decision belongs to the
 *    person using the page, never to an agent tool call. NOT latched: "no
 *    gesture right now" is transient;
 *  - `unavailable` → the ONE stable rejection (this device / browser / options
 *    cannot run the model). Latch, so the instance stops probing a model it will
 *    never get;
 *  - anything else — `downloading`, a thrown probe, any future state — is
 *    TRANSIENT. A model mid-download becomes usable once it finishes, so do NOT
 *    latch; a later tool call re-checks.
 */

/** What an `availability()` reading means for the caller. Three actions, so a
 *  future Chrome state cannot silently become a fourth behavior. */
export type GateDecision = 'create' | 'wait' | 'latch';

export const gestureActive = (): boolean =>
  typeof navigator !== 'undefined' && navigator.userActivation?.isActive === true;

/** `gestured` is a parameter, not a call, so the decision is a pure function of
 *  its inputs and testable without a live `navigator`. */
export const decideAvailability = (status: string, gestured: boolean = gestureActive()): GateDecision => {
  if (status === 'available') return 'create';
  if (status === 'downloadable') return gestured ? 'create' : 'wait';
  if (status === 'unavailable') return 'latch';
  return 'wait';
};

export interface TemplateGate<T> {
  /** The memoized template, or `null` for every fail-open state: disabled,
   *  latched, API absent, no gesture, transient, or a failed `create()`. */
  get(): Promise<T | null>;
  /** Latch from OUTSIDE the availability probe. A session that exists but cannot
   *  satisfy its contract (no `clone()`, so no stateless call) is a stable
   *  rejection the probe cannot see. */
  latch(): void;
  /** Drop the memoized template and destroy it. Does NOT latch — a caller whose
   *  teardown is permanent latches explicitly. */
  release(): void;
}

/**
 * Memoize one lazily-created template behind the policy above.
 *
 * A single in-flight `create()` is shared, and the memo is CLEARED whenever the
 * result is null so a retryable state (no gesture, mid-download) is not cached
 * as "not right now" for the life of the instance.
 */
export function createTemplateGate<A, T>(spec: {
  enabled: () => boolean;
  ctor: () => A | null;
  availability: (api: A) => Promise<string>;
  /** Already fail-open: resolves `null` on a create failure, which is transient
   *  (cold-load timeout, model busy) and so must not latch. */
  create: (api: A) => Promise<T | null>;
  destroy?: (template: T) => void;
}): TemplateGate<T> {
  let template: T | null = null;
  let pending: Promise<T | null> | null = null;
  let latched = false;

  return {
    async get() {
      if (!spec.enabled() || latched) return null;
      const api = spec.ctor();
      // An absent constructor is stable for the life of the document.
      if (!api) { latched = true; return null; }
      if (template) return template;
      if (!pending) {
        pending = (async () => {
          // A probe that THROWS is transient, not a permanent absence — it must
          // reach `decideAvailability` as an unknown state, never as a rejection.
          const status = await spec.availability(api).catch(() => 'error');
          const decision = decideAvailability(status);
          if (decision === 'latch') { latched = true; return null; }
          if (decision === 'wait') return null;
          return spec.create(api);
        })();
      }
      try { return (template = await pending); }
      finally { if (!template) pending = null; }
    },
    latch() { latched = true; },
    release() {
      if (template && spec.destroy) {
        try { spec.destroy(template); } catch { /* a torn-down session is already gone */ }
      }
      template = null; pending = null;
    },
  };
}
