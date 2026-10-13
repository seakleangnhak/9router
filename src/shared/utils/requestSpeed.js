// ponytail: end-to-end output TPS; add first-output timing if generation-only speed is needed.
export function getTokensPerSecond(tokens, durationMs) {
  const output = tokens?.completion_tokens ?? tokens?.output_tokens;
  if (!Number.isFinite(output) || output <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  const speed = output * 1000 / durationMs;
  return Number.isFinite(speed) ? speed : null;
}

export function formatTokensPerSecond(value) {
  return Number.isFinite(value) && value >= 0 ? value.toFixed(1) : "—";
}
