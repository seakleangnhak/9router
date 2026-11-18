// Attempts record account fallback decisions, not combo transitions or Fusion branches.
export function aggregateRoutingHealth(traces) {
  const providers = new Map();
  let truncatedTraces = 0;
  let clientDisconnects = 0;
  let interruptedUploads = 0;
  for (const trace of traces) {
    if (trace.droppedAttempts > 0) truncatedTraces++;
    if (trace.terminalReason === "client_disconnected") clientDisconnects++;
    if (trace.terminalReason === "upload_interrupted") interruptedUploads++;
    const disconnected = trace.terminalReason === "client_disconnected" || trace.terminalReason === "upload_interrupted";
    for (const attempt of trace.attempts) {
      if (!attempt.provider) continue;
      if (!providers.has(attempt.provider)) providers.set(attempt.provider, { provider: attempt.provider, attempts: 0, fallbacks: 0, upstreamSamples: 0, upstreamErrors: 0, latencies: [] });
      const row = providers.get(attempt.provider);
      if (disconnected || !trace.terminalReason) continue;
      // In-progress and unclassified attempts do not imply a fallback decision.
      if (["response_accepted", "failed", "account_fallback"].includes(attempt.outcome)) {
        row.attempts++;
        if (attempt.outcome === "account_fallback") row.fallbacks++;
      }
      if (Number.isInteger(attempt.upstreamStatus) && attempt.upstreamStatus >= 100 && attempt.upstreamStatus <= 599) {
        row.upstreamSamples++;
        if (attempt.upstreamStatus >= 400 || attempt.streamError) row.upstreamErrors++;
      }
      if (Number.isFinite(attempt.firstTokenMs) && Number.isFinite(attempt.upstreamStartedMs) && attempt.firstTokenMs >= attempt.upstreamStartedMs) {
        row.latencies.push(attempt.firstTokenMs - attempt.upstreamStartedMs);
      }
    }
  }
  return {
    traceCount: traces.length,
    truncatedTraces,
    clientDisconnects,
    interruptedUploads,
    providers: [...providers.values()].sort((a, b) => a.provider.localeCompare(b.provider)).map(({ latencies, ...row }) => {
      latencies.sort((a, b) => a - b);
      const middle = Math.floor(latencies.length / 2);
      return { ...row, latencySamples: latencies.length, medianFirstTokenMs: !latencies.length ? null : latencies.length % 2 ? latencies[middle] : (latencies[middle - 1] + latencies[middle]) / 2 };
    }),
  };
}
