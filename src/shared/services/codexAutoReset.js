import "open-sse/index.js";
import { createHash, randomUUID } from "node:crypto";
import { getProviderConnectionById } from "@/lib/db/index.js";
import {
  getCodexAutoReset, listEnabledCodexAutoResets, updateCodexAutoReset,
  claimCodexResetAccount, updateCodexResetAccount, releaseCodexResetAccount,
} from "@/lib/db/repos/codexResetRepo.js";
import { getCodexAccountId, getCodexUsage, getCodexRateLimitResetCredits, consumeCodexRateLimitResetCredit } from "open-sse/services/usage/codex.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { CODEX_AUTO_RESET_CONFIG as C, observeCodexUsage, getCodexResetDecision } from "./codexAutoResetPolicy.js";

const LEASE_MS = 5 * 60000;
const RETRY_MS = 5 * 60000;
const runtime = (global.__codexAutoReset ??= { interval: null, running: false });

export function codexResetAccountKey(connection) {
  const id = getCodexAccountId(connection.providerSpecificData);
  return id ? createHash("sha256").update(id).digest("hex") : null;
}

export function codexAutoResetStatus(state) {
  return {
    mode: state.mode || "off",
    reason: state.reason || "Automatic reset disabled.",
    lastCheckedAt: state.lastCheckedAt || null,
    lastResetAt: state.lastResetAt || null,
    expiresAt: state.expiresAt || null,
  };
}

function defaultDeps() {
  return {
    getProviderConnectionById, getCodexAutoReset, listEnabledCodexAutoResets, updateCodexAutoReset,
    claimCodexResetAccount, updateCodexResetAccount, releaseCodexResetAccount,
    getCodexUsage, getCodexRateLimitResetCredits, consumeCodexRateLimitResetCredit,
    resolveConnectionProxyConfig, refreshAndUpdateCredentials,
  };
}

async function readUsage(connection, proxy, deps) {
  const usage = await deps.getCodexUsage(connection.accessToken, proxy, connection.providerSpecificData);
  const bank = await deps.getCodexRateLimitResetCredits(connection.accessToken, proxy, connection.providerSpecificData);
  return { usage, bank };
}

function quotaSnapshot(usage) {
  return Object.fromEntries(["session", "weekly"].filter((key) => usage?.quotas?.[key]).map((key) => [key, {
    used: usage.quotas[key].used,
    resetAt: usage.quotas[key].resetAt,
  }]));
}

function resetObserved(previous, usage) {
  return Object.entries(previous || {}).some(([key, quota]) => {
    const next = usage?.quotas?.[key];
    return next && Number.isFinite(next.used) && next.used < quota.used;
  });
}

function freshRetryData(usage, bank, nowMs) {
  const age = (value) => nowMs - Date.parse(value);
  const quotas = Object.values(quotaSnapshot(usage));
  return [usage?.fetchedAt, bank?.fetchedAt].every((at) => age(at) >= 0 && age(at) <= C.maxDataAgeMs)
    && typeof usage?.credits?.balance === "number" && Number.isFinite(usage.credits.balance) && usage.credits.balance >= 0
    && usage.credits.unlimited !== true && quotas.length > 0
    && quotas.every((quota) => typeof quota.used === "number" && Number.isFinite(quota.used)
      && quota.used >= 0 && quota.used <= 100 && Date.parse(quota.resetAt) > nowMs)
    && Number.isFinite(bank.availableCount) && Array.isArray(bank.credits);
}

async function checkConnection(connectionId, deps) {
  let connection = await deps.getProviderConnectionById(connectionId);
  if (!connection || connection.provider !== "codex" || connection.isActive === false
    || !["oauth", "access_token"].includes(connection.authType)) return;
  const accountKey = codexResetAccountKey(connection);
  const report = async (patch) => deps.updateCodexAutoReset(connectionId, { ...patch, lastCheckedAt: new Date().toISOString() });
  if (!accountKey) {
    await report({ reason: "Account ID unavailable; automatic redemption paused." });
    return;
  }
  const owner = randomUUID();
  let account;
  try { account = await deps.claimCodexResetAccount(accountKey, owner, Date.now(), LEASE_MS); }
  catch {
    await report({ reason: "Durable account lock unavailable; automatic redemption paused." });
    return;
  }
  if (!account) return;
  const saveAccount = async (patch) => {
    account = await deps.updateCodexResetAccount(accountKey, owner, patch);
  };
  try {
    let config = await deps.getCodexAutoReset(connectionId);
    if (config.mode !== "auto" && config.mode !== "smart") return;
    if (config.accountKey !== accountKey) {
      await report({ mode: "off", reason: "Account changed; enable automatic reset again for this account." });
      return;
    }
    const proxyConfig = await deps.resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxy = { ...proxyConfig, strictProxy: false };
    if (connection.authType === "oauth") ({ connection } = await deps.refreshAndUpdateCredentials(connection, false, proxy));
    if (codexResetAccountKey(connection) !== accountKey) {
      await report({ reason: "Account changed; waiting for the next check." });
      return;
    }
    const { usage, bank } = await readUsage(connection, proxy, deps);
    const nowMs = Date.now();
    const history = observeCodexUsage(account.history, usage, nowMs);
    await saveAccount({ history });
    if (account.awaitingReset) {
      if (!Object.keys(account.awaitingReset).length) {
        await saveAccount({ awaitingReset: quotaSnapshot(usage) });
      }
      if (!resetObserved(account.awaitingReset, usage)) {
        await report({ reason: "Waiting for upstream to confirm restored quota before another reset." });
        return;
      }
      await saveAccount({ awaitingReset: null, history: observeCodexUsage([], usage, nowMs) });
    }
    if (account.lastAttemptAt && nowMs - Date.parse(account.lastAttemptAt) < RETRY_MS) {
      await report({ reason: "Waiting after the previous redemption attempt." });
      return;
    }
    const decision = getCodexResetDecision({ mode: config.mode, usage, bank, history: account.history, nowMs });
    await report({ reason: decision.reason, expiresAt: decision.expiresAt, lastResetAt: account.lastResetAt || null });

    // An uncertain POST always retains its original ID and selected credit, including after restart.
    const pending = account.pending;
    if (!decision.redeem && !pending) return;
    if (pending && config.mode === "smart" && (usage.credits?.balance > 0 || usage.credits?.hasCredits === true)) return;
    if (pending && (!freshRetryData(usage, bank, nowMs) || pending.mode !== config.mode)) {
      await report({ reason: "Previous redemption unconfirmed; waiting for fresh data and its original reset mode. Manual requests must be retried manually." });
      return;
    }
    config = await deps.getCodexAutoReset(connectionId);
    const latest = await deps.getProviderConnectionById(connectionId);
    if (!latest || latest.isActive === false || codexResetAccountKey(latest) !== accountKey
      || config.accountKey !== accountKey
      || (config.mode !== "auto" && config.mode !== "smart")) return;
    if (!pending) {
      const currentDecision = getCodexResetDecision({ mode: config.mode, usage, bank, history: account.history, nowMs: Date.now() });
      if (!currentDecision.redeem) return;
    }
    if (pending && pending.mode !== config.mode) return;
    if (pending) {
      const selected = bank.credits.find((credit) => credit.id === pending.creditId);
      const originalCredit = selected || pending.credit;
      const safeReplay = (selected && ["redeemed", "expired"].includes(selected.status))
        || (!selected && bank.availableCount === 0);
      const retryDecision = getCodexResetDecision({
        mode: config.mode, usage, bank: { ...bank, credits: originalCredit ? [originalCredit] : [] },
        history: account.history, nowMs: Date.now(),
      });
      if (!safeReplay && !retryDecision.redeem) {
        await report({ reason: "Previous redemption unconfirmed; waiting until retry is useful or manual reconciliation." });
        return;
      }
    }
    const attempt = pending || {
      redeemRequestId: randomUUID(), creditId: decision.credit.id, mode: config.mode,
      credit: {
        id: decision.credit.id, status: decision.credit.status,
        resetType: decision.credit.resetType, expiresAt: decision.credit.expiresAt,
      },
      preResetQuotas: quotaSnapshot(usage),
    };
    await saveAccount({ pending: attempt, lastAttemptAt: new Date().toISOString() });
    const result = await deps.consumeCodexRateLimitResetCredit(
      connection.accessToken, attempt.redeemRequestId, proxy, attempt.creditId, connection.providerSpecificData,
    );
    if (!result.ok) {
      // Definitive no-op responses are safe to finish. Network/unknown responses retain pending.
      if (result.noCredit || ["nothing_to_reset", "credit_expired", "credit_not_available"].includes(result.code)) {
        await saveAccount({ pending: null });
      }
      await report({ reason: result.noCredit ? "No reset credits available." : "Redemption not confirmed; retry will reuse the same request ID." });
      return;
    }
    const lastResetAt = new Date().toISOString();
    await saveAccount({ pending: null, history: [], awaitingReset: attempt.preResetQuotas || quotaSnapshot(usage), lastResetAt });
    await report({ lastResetAt, reason: "Reset redeemed; verifying restored quota." });
    const verified = await readUsage(connection, proxy, deps);
    if (resetObserved(account.awaitingReset, verified.usage)) {
      await saveAccount({ awaitingReset: null, history: observeCodexUsage([], verified.usage, Date.now()) });
      await report({ reason: "Reset redeemed and quota refreshed." });
    }
  } catch {
    // Provider errors can include credentials or account details; keep dashboard and logs generic.
    await report({ reason: "Upstream check failed; automatic redemption paused. Any pending request ID is preserved." });
  } finally {
    await deps.releaseCodexResetAccount(accountKey, owner);
  }
}

export async function withManualCodexResetLock(connection, redeem, deps = defaultDeps(), proxy = null) {
  const accountKey = codexResetAccountKey(connection)
    || createHash("sha256").update(`connection:${connection.id}`).digest("hex");
  const owner = randomUUID();
  const account = await deps.claimCodexResetAccount(accountKey, owner, Date.now(), LEASE_MS, false);
  if (!account) return { status: 409, code: "reset_in_progress", ok: false, message: "A reset is already being checked for this account." };
  try {
    let before = {};
    try {
      before = quotaSnapshot(await deps.getCodexUsage(connection.accessToken, proxy, connection.providerSpecificData));
    } catch { /* A manual reset remains available when quota lookup fails; automation waits for confirmation. */ }
    const latest = await deps.getProviderConnectionById(connection.id);
    if (!latest || codexResetAccountKey(latest) !== codexResetAccountKey(connection)) {
      return { status: 409, code: "connection_changed", ok: false, message: "Connection changed; refresh before retrying reset." };
    }
    const pending = account.pending || { redeemRequestId: randomUUID(), creditId: null, preResetQuotas: before };
    await deps.updateCodexResetAccount(accountKey, owner, { pending, lastAttemptAt: new Date().toISOString() });
    const result = await redeem(pending.redeemRequestId, pending.creditId);
    if (result.ok) {
      await deps.updateCodexResetAccount(accountKey, owner, {
        pending: null, history: [], lastResetAt: new Date().toISOString(), awaitingReset: pending.preResetQuotas || before,
        lastAttemptAt: new Date().toISOString(),
      });
    } else if (result.noCredit || ["nothing_to_reset", "credit_expired", "credit_not_available"].includes(result.code)) {
      await deps.updateCodexResetAccount(accountKey, owner, { pending: null });
    }
    return { ...result, redeemRequestId: pending.redeemRequestId };
  } finally {
    await deps.releaseCodexResetAccount(accountKey, owner);
  }
}

export async function runCodexAutoResetTick(deps = defaultDeps(), state = runtime) {
  if (state.running) return;
  state.running = true;
  try {
    for (const config of await deps.listEnabledCodexAutoResets()) {
      try { await checkConnection(config.connectionId, deps); }
      catch { console.warn("[CodexAutoReset] Check deferred; no new redemption started."); }
    }
  } finally {
    state.running = false;
  }
}

export async function configureCodexAutoReset() {
  const enabled = (await listEnabledCodexAutoResets()).length > 0;
  if (!enabled && runtime.interval) {
    clearInterval(runtime.interval);
    runtime.interval = null;
  } else if (enabled && !runtime.interval) {
    runtime.interval = setInterval(() => runCodexAutoResetTick().catch(() => {}), C.tickIntervalMs);
    runtime.interval.unref?.();
  }
  if (enabled) runCodexAutoResetTick().catch(() => {});
}
