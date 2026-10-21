// Learns how fast each model processes a prompt (tokens per ms until its first streamed token) so the UI can show a rough
// "about 40s" while a long prompt is being read. Local servers such as LM Studio report no progress during this phase.
// Token counts are the loop's own estimates on both sides, so the rate calibrates itself even if the estimate is biased.
const MIN_TOKENS = 200, MIN_MS = 100, SMOOTHING = 0.3;
const rates = new Map(); // model -> tokens per ms (exponential moving average)

export const prefill = {
  record(model, tokens, ms) {
    if (tokens < MIN_TOKENS || ms < MIN_MS) return; // too small to measure; a cached prompt would also inflate the rate
    const r = tokens / ms, prev = rates.get(model);
    rates.set(model, prev ? prev + SMOOTHING * (r - prev) : r);
  },
  // Expected prefill time in ms, or null before this model has been measured (the UI then shows an indeterminate bar).
  eta(model, tokens) {
    const r = rates.get(model);
    return r && tokens >= MIN_TOKENS ? Math.round(tokens / r) : null;
  },
  reset() { rates.clear(); },
};
