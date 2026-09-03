/**
 * The `LanguageModel` (Prompt API) surface, declared once.
 *
 * Two wrappers sit on this API — the text readers in lm-session.ts and the
 * multimodal opaque-region describer in image-describer.ts — and each had its
 * own structurally identical copy of these interfaces and of the feature probe.
 * Two declarations of one platform shape is two places for the platform to drift
 * away from us, so it is declared here and imported.
 *
 * `input` is `unknown` because the same `prompt()` takes a plain string for the
 * text readers and a multimodal content array for the describer; `create`
 * options are open for the same reason (`expectedInputs` is image-only).
 */

export interface BrowserLanguageModel {
  prompt(input: unknown, options?: { responseConstraint?: object; signal?: AbortSignal }): Promise<string>;
  /** A fresh session with the template's configuration and NONE of its history.
   *  Required in practice, not optional — a session we cannot clone cannot
   *  produce a stateless result, so it is refused rather than reused. */
  clone?: (options?: { signal?: AbortSignal }) => Promise<BrowserLanguageModel>;
  destroy?: () => void;
}

export interface BrowserLanguageModelConstructor {
  availability(options?: Record<string, unknown>): Promise<string>;
  create(options?: Record<string, unknown>): Promise<BrowserLanguageModel>;
}

/** Window-only: the Prompt API is not exposed to workers, and the `document`
 *  check is what keeps this module importable from one. */
export const languageModelCtor = (): BrowserLanguageModelConstructor | null => {
  if (typeof document === 'undefined') return null;
  const value = (globalThis as typeof globalThis & { LanguageModel?: BrowserLanguageModelConstructor }).LanguageModel;
  return value && typeof value.availability === 'function' && typeof value.create === 'function'
    ? value : null;
};
