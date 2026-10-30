export const CODEX_AUTO_RESET_CONFIG = {
  tickIntervalMs: 60000,
  autoLeadMs: 600000,
  maxDataAgeMs: 180000,
  historyMaxAgeMs: 21600000,
  historyMaxEntries: 361,
  forecastHistoryMs: 1800000,
  activeWithinMs: 900000,
  naturalResetGuardMs: 120000,
};

const C = CODEX_AUTO_RESET_CONFIG;
const QUOTA_KEYS = ["session", "weekly"];
const RESET_TYPES = ["codexRateLimits", "codex_rate_limits"];

function timestamp(value) {
  return typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
}

function knownBalance(credits) {
  return typeof credits?.balance === "number" && Number.isFinite(credits.balance) && credits.balance >= 0;
}

function validQuota(quota) {
  return quota?.total === 100 && typeof quota.used === "number" && Number.isFinite(quota.used)
    && quota.used >= 0 && quota.used <= 100 && Number.isFinite(timestamp(quota.resetAt));
}

function fresh(value, nowMs) {
  const age = nowMs - timestamp(value);
  return age >= 0 && age <= C.maxDataAgeMs;
}

export function observeCodexUsage(history, usage, nowMs = Date.now()) {
  const retained = (Array.isArray(history) ? history : []).filter((sample) => (
    Number.isFinite(sample?.at) && sample.at <= nowMs && nowMs - sample.at <= C.historyMaxAgeMs
  )).sort((a, b) => a.at - b.at);
  if (!fresh(usage?.fetchedAt, nowMs)) return retained.slice(-C.historyMaxEntries);

  const at = timestamp(usage.fetchedAt);
  const quotas = {};
  for (const key of QUOTA_KEYS) {
    const quota = usage.quotas?.[key];
    if (validQuota(quota)) quotas[key] = { used: quota.used, resetAt: quota.resetAt };
  }
  const next = { at, quotas, balance: knownBalance(usage.credits) ? usage.credits.balance : null };
  return [...retained.filter((sample) => sample.at < at), next].slice(-C.historyMaxEntries);
}

function forecastWindow(history, key, quota, nowMs) {
  const samples = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const sample = history[i];
    const window = sample.quotas?.[key];
    const newer = samples[0];
    if (nowMs - sample.at > C.forecastHistoryMs || !Number.isFinite(window?.used) || window.used < 0 || window.used > 100
      || timestamp(window.resetAt) !== timestamp(quota.resetAt)
      || (newer && (window.used > newer.quotas[key].used || newer.at - sample.at > C.maxDataAgeMs))) break;
    samples.unshift(sample);
  }
  if (samples.length < 2 || samples.at(-1).at - samples[0].at < C.tickIntervalMs) return null;

  let rate = 0;
  let burst = 0;
  let creditBurn = false;
  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1];
    const current = samples[i];
    if (nowMs - current.at > C.activeWithinMs || current.at <= previous.at) continue;
    const delta = current.quotas[key].used - previous.quotas[key].used;
    rate = Math.max(rate, delta / (current.at - previous.at));
    burst = Math.max(burst, delta);
    creditBurn ||= Number.isFinite(previous.balance) && Number.isFinite(current.balance) && current.balance < previous.balance;
  }
  if (quota.used === 100 && creditBurn) return { runwayMs: 0, workLeadMs: C.naturalResetGuardMs, nextWork: 1 };
  if (rate <= 0) return null;

  const nextWork = Math.min(100, Math.max(burst, rate * C.naturalResetGuardMs));
  return {
    runwayMs: (100 - quota.used) / rate,
    workLeadMs: Math.max(C.naturalResetGuardMs, burst / rate),
    nextWork,
  };
}

export function getCodexResetDecision({ mode, usage, bank, history = [], nowMs = Date.now() }) {
  const result = (reason, credit = null, redeem = false) => ({ redeem, reason, credit, expiresAt: credit?.expiresAt || null });
  if (mode !== "auto" && mode !== "smart") return result("Automatic reset disabled.");
  if (!fresh(usage?.fetchedAt, nowMs) || !fresh(bank?.fetchedAt, nowMs)) return result("Waiting for fresh quota, credit balance, and reset-bank data.");
  if (!knownBalance(usage.credits)) return result("Usage-credit balance unknown; automatic redemption paused.");
  if (usage.credits.unlimited === true) return result("Unlimited usage credits; no automatic reset needed.");

  const quotas = QUOTA_KEYS.map((key) => [key, usage.quotas?.[key]]).filter(([, quota]) => quota != null);
  if (!quotas.length || quotas.some(([, quota]) => !validQuota(quota) || timestamp(quota.resetAt) <= nowMs)) {
    return result("Quota windows unavailable or awaiting natural reset.");
  }
  if (typeof bank.availableCount !== "number" || !Number.isFinite(bank.availableCount) || bank.availableCount <= 0) return result("No reset-bank credits available.");
  const credits = (Array.isArray(bank.credits) ? bank.credits : []).filter((credit) => (
    typeof credit?.id === "string" && credit.id.trim() && credit.status === "available"
    && (!credit.resetType || RESET_TYPES.includes(credit.resetType)) && timestamp(credit.expiresAt) > nowMs
  )).sort((a, b) => timestamp(a.expiresAt) - timestamp(b.expiresAt));
  const credit = credits[0];
  if (!credit) return result("No available Codex reset with a known expiry and credit ID.");
  const useful = quotas.filter(([, quota]) => quota.used > 0 && timestamp(quota.resetAt) - nowMs > C.naturalResetGuardMs);
  if (!useful.length) return result("Quota full or natural reset due shortly.", credit);

  const expiresInMs = timestamp(credit.expiresAt) - nowMs;
  if (mode === "auto") {
    return expiresInMs <= C.autoLeadMs
      ? result("Redeeming near-expiry reset to restore used quota and preserve usage credits.", credit, true)
      : result("Waiting until reset-bank credit nears expiry.", credit);
  }

  const samples = observeCodexUsage(history, usage, nowMs);
  let shortestRunway = Infinity;
  for (const [key, quota] of useful) {
    const forecast = forecastWindow(samples, key, quota, nowMs);
    if (!forecast) continue;
    const resetInMs = timestamp(quota.resetAt) - nowMs;
    if (forecast.runwayMs >= resetInMs - C.naturalResetGuardMs) continue;
    shortestRunway = Math.min(shortestRunway, forecast.runwayMs);
    if (100 - quota.used <= forecast.nextWork) {
      return result(`Recent usage may exhaust ${key} quota before the next workload; preserving usage credits.`, credit, true);
    }
    if (expiresInMs <= forecast.workLeadMs) {
      return result(`Reset expires before the next expected workload; restoring ${key} quota.`, credit, true);
    }
  }
  return Number.isFinite(shortestRunway)
    ? result(`Waiting: estimated quota runway ${Math.ceil(shortestRunway / 60000)} min.`, credit)
    : result("Waiting for recent usage; natural reset may cover expected work.", credit);
}
