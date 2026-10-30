/**
 * Codex (OpenAI) usage handler
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { FETCH_CONNECT_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { U, parseResetTime, toFiniteNumber } from "./shared.js";

// Codex (OpenAI) API config
const CODEX_CONFIG = {
  usageUrl: U("codex").url,
  resetCreditsUrl: U("codex").resetCreditsUrl,
  resetCreditsConsumeUrl: U("codex").resetCreditsConsumeUrl,
};

function toIsoDate(value) {
  if (!value) return null;
  const date = value instanceof Date
    ? value
    : new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value);
  const time = date.getTime();
  return Number.isFinite(time) ? date.toISOString() : null;
}

function errorMessage(value, fallback) {
  if (!value) return fallback;
  if (typeof value === "string") return value;
  if (typeof value.message === "string") return value.message;
  return JSON.stringify(value);
}

export function getCodexAccountId(providerSpecificData) {
  return [providerSpecificData?.workspaceId, providerSpecificData?.chatgptAccountId, providerSpecificData?.accountId]
    .find((value) => typeof value === "string" && value.trim())?.trim() || null;
}

function codexHeaders(accessToken, providerSpecificData) {
  const headers = {
    "Authorization": `Bearer ${accessToken}`,
    "Accept": "application/json",
    "OpenAI-Beta": "codex-1",
    "originator": "codex_cli_rs",
  };
  const accountId = getCodexAccountId(providerSpecificData);
  if (accountId) headers["ChatGPT-Account-ID"] = accountId;
  return headers;
}

function formatUsageCredits(credits) {
  const balance = toFiniteNumber(credits?.balance, null);
  return {
    balance: balance !== null && balance >= 0 ? balance : null,
    hasCredits: typeof credits?.has_credits === "boolean" ? credits.has_credits : null,
    unlimited: credits?.unlimited === true,
  };
}

function getCodexRateLimitBody(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  return snapshot.rate_limit && typeof snapshot.rate_limit === "object"
    ? snapshot.rate_limit
    : snapshot;
}

function formatCodexWindow(window) {
  const percent = toFiniteNumber(window?.used_percent ?? window?.percent_used, null);
  const used = percent !== null && percent >= 0 && percent <= 100 ? percent : null;
  return {
    used,
    total: 100,
    remaining: used === null ? null : 100 - used,
    resetAt: parseResetTime(window?.reset_at ?? window?.resets_at ?? window?.resetAt ?? null),
    unlimited: false,
  };
}

function appendCodexQuotaWindows(quotas, prefix, snapshot) {
  const rateLimit = getCodexRateLimitBody(snapshot);
  if (!rateLimit) return false;

  const primary = rateLimit.primary_window || rateLimit.primary || snapshot.primary_window || snapshot.primary;
  const secondary = rateLimit.secondary_window || rateLimit.secondary || snapshot.secondary_window || snapshot.secondary;
  let added = false;

  if (primary) {
    quotas[prefix ? `${prefix}_session` : "session"] = formatCodexWindow(primary);
    added = true;
  }
  if (secondary) {
    quotas[prefix ? `${prefix}_weekly` : "weekly"] = formatCodexWindow(secondary);
    added = true;
  }

  return added;
}

function getCodexReviewRateLimit(data) {
  if (data.code_review_rate_limit || data.review_rate_limit) {
    return data.code_review_rate_limit || data.review_rate_limit;
  }

  const byLimitId = data.rate_limits_by_limit_id;
  if (byLimitId && typeof byLimitId === "object" && !Array.isArray(byLimitId)) {
    return byLimitId.code_review || byLimitId.codex_review || byLimitId.review || null;
  }

  const additional = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : [];
  return additional.find((entry) => {
    const id = String(entry?.limit_name || entry?.metered_feature || entry?.id || "").toLowerCase();
    return id === "code_review" || id === "codex_review" || id === "review" || id.includes("review");
  }) || null;
}

function getCodexSparkRateLimit(data) {
  if (data.spark_rate_limit || data.gpt_5_3_codex_spark_rate_limit) {
    return data.spark_rate_limit || data.gpt_5_3_codex_spark_rate_limit;
  }

  const byLimitId = data.rate_limits_by_limit_id;
  if (byLimitId && typeof byLimitId === "object" && !Array.isArray(byLimitId)) {
    return byLimitId["gpt-5.3-codex-spark"] || byLimitId.gpt_5_3_codex_spark || byLimitId.spark || null;
  }

  const additional = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : [];
  return additional.find((entry) => {
    const id = String(entry?.limit_name || entry?.metered_feature || entry?.id || "").toLowerCase();
    return id.includes("spark") || id.includes("5.3-codex-spark");
  }) || null;
}

export async function getCodexUsage(accessToken, proxyOptions = null, providerSpecificData = null) {
  try {
    const response = await proxyAwareFetch(CODEX_CONFIG.usageUrl, {
      method: "GET",
      cache: "no-store",
      headers: codexHeaders(accessToken, providerSpecificData),
      signal: AbortSignal.timeout(FETCH_CONNECT_TIMEOUT_MS),
    }, proxyOptions);

    if (!response.ok) {
      return { message: `Codex connected. Usage API temporarily unavailable (${response.status}).` };
    }

    const data = await response.json();
    const normalRateLimit = data.rate_limit || data.rate_limits || data.rate_limits_by_limit_id?.codex || {};
    const reviewRateLimit = getCodexReviewRateLimit(data);
    const sparkRateLimit = getCodexSparkRateLimit(data);
    const availableResetCredits = Math.max(0, toFiniteNumber(data.rate_limit_reset_credits?.available_count, 0));
    const quotas = {};

    appendCodexQuotaWindows(quotas, "", normalRateLimit);
    appendCodexQuotaWindows(quotas, "review", reviewRateLimit);
    appendCodexQuotaWindows(quotas, "spark", sparkRateLimit);

    return {
      plan: data.plan_type || data.summary?.plan || "unknown",
      limitReached: getCodexRateLimitBody(normalRateLimit)?.limit_reached || false,
      reviewLimitReached: getCodexRateLimitBody(reviewRateLimit)?.limit_reached || false,
      sparkLimitReached: getCodexRateLimitBody(sparkRateLimit)?.limit_reached || false,
      credits: formatUsageCredits(data.credits),
      fetchedAt: new Date().toISOString(),
      resetCredits: { availableCount: availableResetCredits },
      quotas,
    };
  } catch (error) {
    throw new Error(`Failed to fetch Codex usage: ${error.message}`);
  }
}

export async function getCodexRateLimitResetCredits(accessToken, proxyOptions = null, providerSpecificData = null) {
  if (!accessToken) {
    throw new Error("No Codex access token available. Please re-authorize the connection.");
  }

  const response = await proxyAwareFetch(CODEX_CONFIG.resetCreditsUrl, {
    method: "GET",
    cache: "no-store",
    headers: codexHeaders(accessToken, providerSpecificData),
    signal: AbortSignal.timeout(FETCH_CONNECT_TIMEOUT_MS),
  }, proxyOptions);

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message = errorMessage(data?.message || data?.error || data?.detail, `Codex reset credits API unavailable (${response.status}).`);
    throw new Error(message);
  }

  const credits = Array.isArray(data?.credits) ? data.credits : [];
  const availableCount = toFiniteNumber(data?.available_count ?? data?.availableCount, null);
  return {
    fetchedAt: new Date().toISOString(),
    availableCount: Number.isInteger(availableCount) && availableCount >= 0 ? availableCount : null,
    credits: credits.map((credit) => ({
      id: typeof credit?.id === "string" && credit.id.trim() ? credit.id : null,
      resetType: typeof (credit?.reset_type ?? credit?.resetType) === "string"
        ? credit.reset_type ?? credit.resetType
        : null,
      status: String(credit?.status || "unknown"),
      grantedAt: toIsoDate(credit?.granted_at ?? credit?.grantedAt),
      expiresAt: toIsoDate(credit?.expires_at ?? credit?.expiresAt),
    })),
  };
}

// Consume one Codex rate-limit reset credit (irreversible, spends 1 credit)
export async function consumeCodexRateLimitResetCredit(accessToken, redeemRequestId, proxyOptions = null, creditId = null, providerSpecificData = null) {
  if (!accessToken) {
    throw new Error("No Codex access token available. Please re-authorize the connection.");
  }
  if (typeof redeemRequestId !== "string" || !redeemRequestId.trim()) {
    throw new Error("A redeem request id is required to consume a Codex reset credit.");
  }
  if (creditId !== null && (typeof creditId !== "string" || !creditId.trim())) {
    throw new Error("A non-empty Codex reset credit id is required.");
  }

  let response;
  let data = null;
  try {
    response = await proxyAwareFetch(CODEX_CONFIG.resetCreditsConsumeUrl, {
      method: "POST",
      headers: {
        ...codexHeaders(accessToken, providerSpecificData),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ redeem_request_id: redeemRequestId, ...(creditId !== null ? { credit_id: creditId } : {}) }),
      signal: AbortSignal.timeout(FETCH_CONNECT_TIMEOUT_MS),
    }, proxyOptions);

    const text = await response.text();
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`Failed to consume Codex reset credit: ${error.message}`);
  }

  const code = data?.code || null;
  const windowsReset = toFiniteNumber(data?.windows_reset, 0);
  const success = response.ok && (code === "reset" || code === "already_redeemed" || (!code && windowsReset > 0));

  return {
    ok: success,
    noCredit: response.ok && code === "no_credit",
    status: response.status,
    code,
    windowsReset,
    message: data?.message || null,
    raw: data,
  };
}
