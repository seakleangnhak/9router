import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/db/index.js", () => ({ getProviderConnectionById: vi.fn() }));
vi.mock("@/lib/db/repos/codexResetRepo.js", () => ({
  getCodexAutoReset: vi.fn(), listEnabledCodexAutoResets: vi.fn(), updateCodexAutoReset: vi.fn(),
  claimCodexResetAccount: vi.fn(), updateCodexResetAccount: vi.fn(), releaseCodexResetAccount: vi.fn(),
}));
vi.mock("open-sse/services/usage/codex.js", () => ({
  getCodexAccountId: (data) => data?.workspaceId || data?.chatgptAccountId || data?.accountId || null,
  getCodexUsage: vi.fn(), getCodexRateLimitResetCredits: vi.fn(), consumeCodexRateLimitResetCredit: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn() }));
vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({ refreshAndUpdateCredentials: vi.fn() }));

import {
  runCodexAutoResetTick, withManualCodexResetLock, codexResetAccountKey,
} from "../../src/shared/services/codexAutoReset.js";

const minute = 60000;
const start = Date.parse("2026-10-30T05:00:00.000Z");

function currentUsage(used = 80, balance = 55969) {
  return {
    fetchedAt: new Date().toISOString(),
    credits: { balance, hasCredits: balance > 0, unlimited: false },
    quotas: {
      session: { used, total: 100, remaining: 100 - used, resetAt: new Date(start + 3 * 60 * minute).toISOString() },
      weekly: { used: 20, total: 100, remaining: 80, resetAt: new Date(start + 3 * 24 * 60 * minute).toISOString() },
    },
  };
}

describe("Codex automatic redemption service", () => {
  let connection;
  let config;
  let account;
  let deps;
  let state;
  let events;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    events = [];
    state = { running: false };
    account = {};
    config = { mode: "auto" };
    connection = {
      id: "connection_1", provider: "codex", authType: "access_token", isActive: true,
      accessToken: "fixture-token", providerSpecificData: { chatgptAccountId: "account_1" },
    };
    config.accountKey = codexResetAccountKey(connection);
    deps = {
      getProviderConnectionById: vi.fn(async () => connection),
      getCodexAutoReset: vi.fn(async () => ({ ...config })),
      listEnabledCodexAutoResets: vi.fn(async () => [{ connectionId: connection.id, mode: config.mode }]),
      updateCodexAutoReset: vi.fn(async (_id, patch) => (config = { ...config, ...patch })),
      claimCodexResetAccount: vi.fn(async (_key, owner) => {
        if (account.leaseOwner) return null;
        account = { ...account, leaseOwner: owner };
        return { ...account };
      }),
      updateCodexResetAccount: vi.fn(async (_key, owner, patch) => {
        expect(account.leaseOwner).toBe(owner);
        if (patch.pending) events.push({ type: "persist", id: patch.pending.redeemRequestId });
        account = { ...account, ...patch };
        return { ...account };
      }),
      releaseCodexResetAccount: vi.fn(async (_key, owner) => {
        if (account.leaseOwner === owner) delete account.leaseOwner;
      }),
      getCodexUsage: vi.fn(async () => currentUsage()),
      getCodexRateLimitResetCredits: vi.fn(async () => ({
        fetchedAt: new Date().toISOString(), availableCount: 2,
        credits: [
          { id: "reset_later", resetType: "codexRateLimits", status: "available", expiresAt: new Date(start + 60 * minute).toISOString() },
          { id: "reset_first", resetType: "codexRateLimits", status: "available", expiresAt: new Date(start + 9 * minute).toISOString() },
        ],
      })),
      consumeCodexRateLimitResetCredit: vi.fn(async (_token, id) => {
        events.push({ type: "post", id });
        return { ok: true, code: "reset", windowsReset: 2 };
      }),
      resolveConnectionProxyConfig: vi.fn(async () => ({})),
      refreshAndUpdateCredentials: vi.fn(async (conn) => ({ connection: conn })),
    };
  });

  afterEach(() => vi.useRealTimers());

  it("does not redeem for Off, inactive, missing, or non-Codex connections", async () => {
    config.mode = "off";
    await runCodexAutoResetTick(deps, state);
    config.mode = "auto";
    connection.isActive = false;
    await runCodexAutoResetTick(deps, state);
    connection.isActive = true;
    connection.provider = "openai";
    await runCodexAutoResetTick(deps, state);
    deps.getProviderConnectionById.mockResolvedValue(null);
    await runCodexAutoResetTick(deps, state);
    expect(deps.consumeCodexRateLimitResetCredit).not.toHaveBeenCalled();
    expect(deps.getCodexUsage).not.toHaveBeenCalled();
  });

  it("pauses automatic spending without a trustworthy account identity", async () => {
    connection.providerSpecificData = {};
    await runCodexAutoResetTick(deps, state);
    expect(deps.claimCodexResetAccount).not.toHaveBeenCalled();
    expect(deps.consumeCodexRateLimitResetCredit).not.toHaveBeenCalled();
    expect(config.reason).toMatch(/Account ID unavailable/);
  });

  it("does not transfer automatic-spending permission to a replacement account", async () => {
    connection.providerSpecificData = { chatgptAccountId: "replacement-account" };
    await runCodexAutoResetTick(deps, state);
    expect(config.mode).toBe("off");
    expect(deps.consumeCodexRateLimitResetCredit).not.toHaveBeenCalled();
    expect(deps.getCodexUsage).not.toHaveBeenCalled();
  });

  it("persists one ID before selectively spending earliest-expiring credit despite positive usage balance", async () => {
    await runCodexAutoResetTick(deps, state);

    expect(events.map((event) => event.type)).toEqual(["persist", "post"]);
    expect(events[0].id).toBe(events[1].id);
    expect(deps.consumeCodexRateLimitResetCredit).toHaveBeenCalledWith(
      "fixture-token", events[0].id, expect.any(Object), "reset_first", connection.providerSpecificData,
    );
    expect(account.pending).toBeNull();
    expect(account.awaitingReset).toMatchObject({ session: { used: 80 }, weekly: { used: 20 } });
    expect(account.lastResetAt).toBe(new Date(start).toISOString());
    expect(deps.releaseCodexResetAccount).toHaveBeenCalled();
  });

  it("Smart waits for usage credits to reach zero before redeeming exhausted quota", async () => {
    config.mode = "smart";
    const exhausted = currentUsage(100, 55968.1592845);
    account.history = [{ at: start - minute, balance: 56000, quotas: exhausted.quotas }];
    deps.getCodexUsage.mockResolvedValue(exhausted);

    await runCodexAutoResetTick(deps, state);
    expect(deps.consumeCodexRateLimitResetCredit).not.toHaveBeenCalled();
    expect(config.reason).toMatch(/Usage credits remain/);

    deps.getCodexUsage.mockImplementation(async () => currentUsage(100, 0));
    await runCodexAutoResetTick(deps, state);
    expect(deps.consumeCodexRateLimitResetCredit).toHaveBeenCalledOnce();
    expect(deps.consumeCodexRateLimitResetCredit.mock.calls[0][3]).toBe("reset_first");
  });

  it.each([
    ["available", 55968.1592845], ["redeemed", 55968.1592845], ["expired", 55968.1592845], ["missing", 55968.1592845], ["redeemed", 0],
  ])("Smart retains pending request without replay while credits remain or conflict: %s, %s", async (status, balance) => {
    config.mode = "smart";
    account.pending = {
      redeemRequestId: "uncertain-smart-request", creditId: "reset_first", mode: "smart",
      credit: { id: "reset_first", status: "available", resetType: "codexRateLimits", expiresAt: new Date(start + 9 * minute).toISOString() },
      preResetQuotas: currentUsage(100, 0).quotas,
    };
    const pending = { ...account.pending };
    const exhausted = currentUsage(100, balance);
    exhausted.credits.hasCredits = true;
    account.history = [{ at: start - minute, balance: 56000, quotas: exhausted.quotas }];
    deps.getCodexUsage.mockResolvedValue(exhausted);
    const currentBank = await deps.getCodexRateLimitResetCredits();
    currentBank.credits.find((credit) => credit.id === "reset_first").status = status;
    if (status === "missing") Object.assign(currentBank, { availableCount: 0, credits: [] });
    deps.getCodexRateLimitResetCredits.mockResolvedValue(currentBank);

    await runCodexAutoResetTick(deps, { running: false });
    expect(deps.consumeCodexRateLimitResetCredit).not.toHaveBeenCalled();
    expect(account.pending).toEqual(pending);
    expect(config.reason).toMatch(/Usage credits remain/);
  });

  it("requires an actual usage drop before clearing restored-quota confirmation", async () => {
    await runCodexAutoResetTick(deps, state);
    vi.setSystemTime(start + 6 * minute);
    deps.getCodexUsage.mockImplementation(async () => {
      const unchanged = currentUsage();
      unchanged.quotas.session.resetAt = new Date(start + 4 * 60 * minute).toISOString();
      return unchanged;
    });
    await runCodexAutoResetTick(deps, state);
    expect(deps.consumeCodexRateLimitResetCredit).toHaveBeenCalledTimes(1);
    expect(account.awaitingReset).toBeTruthy();

    deps.getCodexUsage.mockImplementation(async () => currentUsage(0));
    const emptyBank = { fetchedAt: new Date().toISOString(), availableCount: 0, credits: [] };
    deps.getCodexRateLimitResetCredits.mockResolvedValue(emptyBank);
    await runCodexAutoResetTick(deps, state);
    expect(account.awaitingReset).toBeNull();
    expect(deps.consumeCodexRateLimitResetCredit).toHaveBeenCalledTimes(1);
  });

  it.each(["full", "unknown", "stale"])("does not POST for %s quota/credit data", async (kind) => {
    deps.getCodexUsage.mockImplementation(async () => {
      const current = currentUsage(kind === "full" ? 0 : 80);
      if (kind === "full") current.quotas.weekly.used = 0;
      if (kind === "unknown") current.credits.balance = null;
      if (kind === "stale") current.fetchedAt = new Date(start - 4 * minute).toISOString();
      return current;
    });
    await runCodexAutoResetTick(deps, state);
    expect(deps.consumeCodexRateLimitResetCredit).not.toHaveBeenCalled();
  });

  it("preserves uncertain redemption ID and selected credit across retry and process-state restart", async () => {
    deps.consumeCodexRateLimitResetCredit.mockRejectedValueOnce(new Error("fixture timeout"));
    await runCodexAutoResetTick(deps, state);
    const pending = { ...account.pending };
    expect(pending).toMatchObject({ redeemRequestId: expect.any(String), creditId: "reset_first" });

    vi.setSystemTime(start + 6 * minute);
    await runCodexAutoResetTick(deps, { running: false });
    expect(deps.consumeCodexRateLimitResetCredit).toHaveBeenCalledTimes(2);
    expect(deps.consumeCodexRateLimitResetCredit.mock.calls[1][1]).toBe(pending.redeemRequestId);
    expect(deps.consumeCodexRateLimitResetCredit.mock.calls[1][3]).toBe(pending.creditId);
    expect(account.pending).toBeNull();
  });

  it("recovers a lost successful response when the selected credit disappears from an empty bank", async () => {
    let redeemed = false;
    const availableBank = deps.getCodexRateLimitResetCredits.getMockImplementation();
    deps.getCodexUsage.mockImplementation(async () => currentUsage(redeemed ? 0 : 80));
    deps.getCodexRateLimitResetCredits.mockImplementation(async () => redeemed
      ? { fetchedAt: new Date().toISOString(), availableCount: 0, credits: [] }
      : availableBank());
    deps.consumeCodexRateLimitResetCredit
      .mockImplementationOnce(async () => { redeemed = true; throw new Error("fixture lost response"); })
      .mockResolvedValue({ ok: true, code: "already_redeemed", windowsReset: 0 });

    await runCodexAutoResetTick(deps, state);
    const pending = { ...account.pending };
    expect(pending).toMatchObject({
      creditId: "reset_first", mode: "auto",
      credit: { id: "reset_first", status: "available", expiresAt: new Date(start + 9 * minute).toISOString() },
      preResetQuotas: { session: { used: 80 } },
    });

    vi.setSystemTime(start + 6 * minute);
    await runCodexAutoResetTick(deps, { running: false });

    expect(deps.consumeCodexRateLimitResetCredit).toHaveBeenCalledTimes(2);
    expect(deps.consumeCodexRateLimitResetCredit.mock.calls[1][1]).toBe(pending.redeemRequestId);
    expect(deps.consumeCodexRateLimitResetCredit.mock.calls[1][3]).toBe(pending.creditId);
    expect(account.pending).toBeNull();
    expect(account.awaitingReset).toBeNull();
    expect(config.reason).toMatch(/quota refreshed/);
  });

  it("does not retry an uncertain POST while balance or quota data is unknown", async () => {
    deps.consumeCodexRateLimitResetCredit.mockRejectedValueOnce(new Error("fixture timeout"));
    await runCodexAutoResetTick(deps, state);
    const pendingId = account.pending.redeemRequestId;
    vi.setSystemTime(start + 6 * minute);
    deps.getCodexUsage.mockImplementation(async () => ({ ...currentUsage(), credits: { balance: null } }));
    await runCodexAutoResetTick(deps, { running: false });
    expect(deps.consumeCodexRateLimitResetCredit).toHaveBeenCalledTimes(1);
    expect(account.pending.redeemRequestId).toBe(pendingId);
  });

  it("does not replay a pending redemption under a different automatic mode", async () => {
    deps.consumeCodexRateLimitResetCredit.mockRejectedValueOnce(new Error("fixture timeout"));
    await runCodexAutoResetTick(deps, state);
    const pendingId = account.pending.redeemRequestId;
    config.mode = "smart";
    vi.setSystemTime(start + 6 * minute);
    await runCodexAutoResetTick(deps, { running: false });
    expect(deps.consumeCodexRateLimitResetCredit).toHaveBeenCalledTimes(1);
    expect(account.pending.redeemRequestId).toBe(pendingId);
  });

  it("rechecks Off after asynchronous upstream reads", async () => {
    deps.getCodexUsage.mockImplementation(async () => {
      config.mode = "off";
      return currentUsage();
    });
    await runCodexAutoResetTick(deps, state);
    expect(deps.consumeCodexRateLimitResetCredit).not.toHaveBeenCalled();
  });

  it("does not spend if connection switches account during upstream reads", async () => {
    deps.getCodexUsage.mockImplementation(async () => {
      connection = { ...connection, providerSpecificData: { chatgptAccountId: "account_2" } };
      return currentUsage();
    });
    await runCodexAutoResetTick(deps, state);
    expect(deps.consumeCodexRateLimitResetCredit).not.toHaveBeenCalled();
  });

  it("shares confirmation state across two connections for the same account", async () => {
    deps.listEnabledCodexAutoResets.mockResolvedValue([
      { connectionId: "connection_1", mode: "auto" }, { connectionId: "connection_2", mode: "auto" },
    ]);
    deps.getProviderConnectionById.mockImplementation(async (id) => ({ ...connection, id }));
    await runCodexAutoResetTick(deps, state);
    expect(deps.consumeCodexRateLimitResetCredit).toHaveBeenCalledTimes(1);
    expect(account.awaitingReset).toBeTruthy();
  });

  it("does not run overlapping scheduler ticks", async () => {
    let release;
    let entered;
    const entry = new Promise((resolve) => { entered = resolve; });
    const blocked = new Promise((resolve) => { release = resolve; });
    deps.getCodexUsage.mockImplementationOnce(async () => {
      entered();
      await blocked;
      return currentUsage();
    });
    const first = runCodexAutoResetTick(deps, state);
    await entry;
    await runCodexAutoResetTick(deps, state);
    expect(deps.claimCodexResetAccount).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(deps.consumeCodexRateLimitResetCredit).toHaveBeenCalledTimes(1);
    expect(state.running).toBe(false);
  });

  it("uses shared account lock and pending ID for manual redemption", async () => {
    account.pending = { redeemRequestId: "previous-attempt", creditId: "reset_first" };
    const redeem = vi.fn(async () => ({ ok: true, code: "already_redeemed" }));
    const result = await withManualCodexResetLock(connection, redeem, deps);
    expect(deps.claimCodexResetAccount).toHaveBeenCalledWith(
      codexResetAccountKey(connection), expect.any(String), start, expect.any(Number), false,
    );
    expect(redeem).toHaveBeenCalledWith("previous-attempt", "reset_first");
    expect(result).toMatchObject({ ok: true, redeemRequestId: "previous-attempt" });
    expect(account.pending).toBeNull();
    expect(deps.releaseCodexResetAccount).toHaveBeenCalled();
  });

  it("does not follow a manual reset with automatic spending against unchanged quota", async () => {
    await withManualCodexResetLock(connection, vi.fn(async () => ({ ok: true, code: "reset" })), deps);
    vi.setSystemTime(start + 6 * minute);
    await runCodexAutoResetTick(deps, state);
    expect(deps.consumeCodexRateLimitResetCredit).not.toHaveBeenCalled();
  });

  it("uses the original quota snapshot when manually retrying a lost successful response", async () => {
    let restored = false;
    deps.getCodexUsage.mockImplementation(async () => currentUsage(restored ? 0 : 80));
    const redeem = vi.fn()
      .mockImplementationOnce(async () => { restored = true; throw new Error("fixture lost response"); })
      .mockResolvedValue({ ok: true, code: "already_redeemed" });

    await expect(withManualCodexResetLock(connection, redeem, deps)).rejects.toThrow("fixture lost response");
    const pending = { ...account.pending };
    expect(pending.preResetQuotas.session.used).toBe(80);
    await withManualCodexResetLock(connection, redeem, deps);
    expect(redeem.mock.calls[1][0]).toBe(pending.redeemRequestId);
    expect(account.awaitingReset.session.used).toBe(80);

    vi.setSystemTime(start + 6 * minute);
    deps.getCodexRateLimitResetCredits.mockImplementation(async () => ({
      fetchedAt: new Date().toISOString(), availableCount: 0, credits: [],
    }));
    await runCodexAutoResetTick(deps, state);
    expect(account.awaitingReset).toBeNull();
    expect(deps.consumeCodexRateLimitResetCredit).not.toHaveBeenCalled();
  });

  it("rejects manual reset during another account reset check", async () => {
    account.leaseOwner = "other-process";
    const redeem = vi.fn();
    const result = await withManualCodexResetLock(connection, redeem, deps);
    expect(result).toMatchObject({ ok: false, status: 409, code: "reset_in_progress" });
    expect(redeem).not.toHaveBeenCalled();
  });

  it("does not redeem manually after the connection changes account during quota lookup", async () => {
    deps.getCodexUsage.mockImplementationOnce(async () => {
      connection = { ...connection, providerSpecificData: { chatgptAccountId: "different-account" } };
      return currentUsage();
    });
    const original = connection;
    const redeem = vi.fn();
    const result = await withManualCodexResetLock(original, redeem, deps);
    expect(result).toMatchObject({ ok: false, status: 409, code: "connection_changed" });
    expect(redeem).not.toHaveBeenCalled();
    expect(deps.releaseCodexResetAccount).toHaveBeenCalledOnce();
  });
});
