import { describe, expect, it } from "vitest";
import { aggregateRoutingHealth } from "../../src/lib/routingHealth.js";

const attempt = (provider, outcome, fields = {}) => ({ provider, outcome, startedMs: 10, ...fields });
const trace = (terminalReason, attempts, droppedAttempts = 0) => ({ terminalReason, attempts, droppedAttempts });

describe("routing health", () => {
  it("uses observed upstream statuses and upstream start for latency", () => {
    const result = aggregateRoutingHealth([
      trace("response_finished", [
        attempt("a", "account_fallback", { upstreamStatus: 429 }),
        attempt("a", "response_accepted", { upstreamStatus: 200, upstreamStartedMs: 100, firstTokenMs: 200 }),
        attempt("b", "response_accepted", { upstreamStatus: 200, upstreamStartedMs: 70, firstTokenMs: 110 }),
      ]),
      trace("stream_error", [attempt("a", "response_accepted", { upstreamStatus: 200, upstreamStartedMs: 200, firstTokenMs: 500, streamError: "upstream_stream_error" })]),
      trace("http_error", [attempt("b", "failed"), attempt("b", "no_eligible_account")], 2),
    ]);
    expect(result).toEqual({ traceCount: 3, truncatedTraces: 1, clientDisconnects: 0, interruptedUploads: 0, providers: [
      { provider: "a", attempts: 3, fallbacks: 1, upstreamSamples: 3, upstreamErrors: 2, latencySamples: 2, medianFirstTokenMs: 200 },
      { provider: "b", attempts: 2, fallbacks: 0, upstreamSamples: 1, upstreamErrors: 0, latencySamples: 1, medianFirstTokenMs: 40 },
    ] });
  });

  it("counts disconnects per trace and excludes disconnected, interrupted and unfinished traces", () => {
    const result = aggregateRoutingHealth([
      trace("client_disconnected", [attempt("a", "account_fallback", { upstreamStatus: 429 }), attempt("b", "response_accepted", { upstreamStatus: 200 })]),
      trace("client_disconnected", []),
      trace("upload_interrupted", []),
      trace(null, [attempt("a", "response_accepted", { upstreamStatus: 200, upstreamStartedMs: 10, firstTokenMs: 20 })]),
      trace("http_error", [attempt("a", "upstream_pending"), attempt("b", "selecting_account")]),
    ]);
    expect(result.clientDisconnects).toBe(2);
    expect(result.interruptedUploads).toBe(1);
    expect(result.providers).toEqual([
      { provider: "a", attempts: 0, fallbacks: 0, upstreamSamples: 0, upstreamErrors: 0, latencySamples: 0, medianFirstTokenMs: null },
      { provider: "b", attempts: 0, fallbacks: 0, upstreamSamples: 0, upstreamErrors: 0, latencySamples: 0, medianFirstTokenMs: null },
    ]);
  });

  it("does not infer upstream errors or combo and Fusion fallbacks", () => {
    const { providers } = aggregateRoutingHealth([trace("response_finished", [
      attempt("a", "failed", { streamError: "stream_connection_lost", firstTokenMs: 20 }),
      attempt("b", "response_accepted", { upstreamStatus: 200, upstreamStartedMs: 30, firstTokenMs: 20 }),
      attempt("c", "response_accepted", { upstreamStatus: 503 }),
    ])]);
    expect(providers.map(({ fallbacks }) => fallbacks)).toEqual([0, 0, 0]);
    expect(providers.map(({ upstreamSamples, upstreamErrors }) => [upstreamSamples, upstreamErrors])).toEqual([[0, 0], [1, 0], [1, 1]]);
    expect(providers.map(({ latencySamples }) => latencySamples)).toEqual([0, 0, 0]);
    expect(aggregateRoutingHealth([])).toEqual({ traceCount: 0, truncatedTraces: 0, clientDisconnects: 0, interruptedUploads: 0, providers: [] });
  });
});
