import { PROVIDER_ID_TO_ALIAS, PROVIDER_MODELS } from "open-sse/config/providerModels.js";
import { normalizeServiceTier, normalizeReportedServiceTier } from "open-sse/config/serviceTiers.js";

const registry = () => globalThis[Symbol.for("9router.requestTraces")];

export function readRequestTraces(id) {
  const available = !!registry();
  const enabled = available && process.env.NINEROUTER_REQUEST_TRACES === "true";
  return { available, enabled, traces: enabled ? registry().list(id) : [] };
}

export function currentRequestTrace() {
  return registry()?.current();
}

export function recordTraceTier(context, field, tier) {
  if (context && !context.trace.terminalReason) {
    context.trace[field] = tier == null ? null : normalizeServiceTier(tier) ?? "other";
  }
}

export function startTraceAttempt(context, provider, model) {
  if (!context || context.trace.terminalReason) return;
  const { trace, elapsedMs } = context;
  if (trace.attempts.length >= 32) {
    trace.droppedAttempts++;
    return;
  }
  const knownProvider = Object.hasOwn(PROVIDER_ID_TO_ALIAS, provider);
  const models = knownProvider ? PROVIDER_MODELS[PROVIDER_ID_TO_ALIAS[provider]] : null;
  const attempt = {
    provider: knownProvider ? provider : "custom",
    model: models?.some((entry) => entry.id === model) ? model : null,
    startedMs: elapsedMs(), status: null, outcome: "selecting_account", firstTokenMs: null, actualTier: null,
  };
  trace.attempts.push(attempt);
  return {
    bindResponse(response) {
      if (response) context.responses.set(response, attempt);
    },
    update(outcome, status) {
      if (trace.terminalReason) return;
      attempt.outcome = outcome;
      if (Number.isInteger(status) && status >= 100 && status <= 599) attempt.status = status;
    },
    onToken() {
      if (trace.terminalReason) return;
      attempt.firstTokenMs ??= elapsedMs();
      trace.firstTokenMs ??= attempt.firstTokenMs;
    },
    onUpstreamStart() {
      if (!trace.terminalReason) attempt.upstreamStartedMs ??= elapsedMs();
    },
    onUpstreamStatus(status) {
      if (!trace.terminalReason && Number.isInteger(status) && status >= 100 && status <= 599) attempt.upstreamStatus = status;
    },
    onForwardedTier(tier) {
      if (!trace.terminalReason) attempt.forwardedTier = tier === undefined ? null : normalizeServiceTier(tier) ?? "other";
    },
    onTier(tier) {
      tier = normalizeReportedServiceTier(tier);
      if (trace.terminalReason || !tier) return;
      attempt.actualTier = tier;
      if (context.returnedAttempt === attempt) trace.actualTier = tier;
    },
    onError(reason) {
      if (!trace.terminalReason) attempt.streamError ??= reason;
    },
  };
}
