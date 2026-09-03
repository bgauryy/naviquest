/**
 * Settle Naviquest's page-local on-device reader after a first tool response.
 *
 * Chrome's model can be available while the SDK's cloned reader is still cold:
 * lm-session intentionally starts that warm-up off the critical path and returns
 * `NO_ON_DEVICE_READER`. Keep this policy here so the CLI runner and long-lived
 * callers do not each invent a retry loop.
 *
 * `invoke` must call the SAME tool with the SAME input on the SAME document.
 * Its return shape is deliberately transport-neutral: `{ responded?, text?,
 * payload }`, so WebMCP.invokeTool and direct SDK callers share the policy.
 */
export const onDeviceModelState = (evaluate) => evaluate(`(async () => {
  if (typeof LanguageModel === 'undefined') return 'absent';
  try { return await LanguageModel.availability(); } catch { return 'absent'; }
})()`);

export async function settleOnDeviceReader({
  current,
  invoke,
  evaluate,
  enabled = true,
  timeoutMs = 30_000,
  pollMs = 2_000,
  log = () => {},
}) {
  let value = current;
  if (!enabled || value.payload?.answer?.unverified !== 'NO_ON_DEVICE_READER') {
    return { ...value, outcome: 'not-needed', attempts: 0 };
  }

  const modelState = await onDeviceModelState(evaluate);

  if (modelState !== 'available') {
    log(`[FINDING] NAVIQUEST_ANSWER_UNVERIFIED no on-device reader on this page (LanguageModel: ${modelState})`);
    log(modelState === 'downloadable'
      ? '[REASON] The model exists but is not downloaded in this profile, and a tool call cannot download it (no user gesture). Run model-warm.mjs on THIS tab once, then call again. The answer below stands on the lexical path; it is merely unchecked.'
      : '[REASON] No model on this page: either an opaque origin or the AI channels are off for this launch — see references/chrome-flags.md. The answer below stands on the lexical path; it is merely unchecked.');
    return { ...value, outcome: 'unverified', modelState, attempts: 0 };
  }

  log(`[ACTION] the answer came back with a COLD on-device reader — re-asking the same document while the SDK's reader warms (up to ${timeoutMs}ms)`);
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let delay = pollMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now()))));
    attempts++;
    value = await invoke();
    if (value.payload?.answer?.unverified !== 'NO_ON_DEVICE_READER') {
      const outcome = value.payload?.answer ? 'verified' : 'withheld-as-unsupported';
      log(`[METRIC] NAVIQUEST_VERIFIER_PRIMED attempts=${attempts} after=${outcome}`);
      return { ...value, outcome, modelState, attempts };
    }
    // A retry is a complete tool call, not a cheap status probe. Exponential
    // backoff bounds both page work and logs while still catching a fast warm-up.
    delay = Math.min(delay * 2, 8_000);
  }

  log(`[FINDING] NAVIQUEST_VERIFIER_COLD the reader never came up within ${timeoutMs}ms (${attempts} attempts)`);
  log('[REASON] The model reported `available` but its reader never answered, so the budget is likely too tight for this device: raise NQ_PRIME_MS. The answer below is unverified; report it as unverified.');
  return { ...value, outcome: 'timeout', modelState, attempts };
}
