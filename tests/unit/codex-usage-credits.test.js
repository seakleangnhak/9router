import { beforeEach, describe, expect, it, vi } from "vitest";

const { proxyAwareFetch } = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

import { getCodexAccountId, getCodexUsage } from "../../open-sse/services/usage/codex.js";

describe("Codex usage credits", () => {
  beforeEach(() => vi.clearAllMocks());

  function respond(credits, primaryWindow = { used_percent: 25, reset_at: 2000000000 }) {
    proxyAwareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        plan_type: "pro",
        credits,
        rate_limit: {
          primary_window: primaryWindow,
          secondary_window: { used_percent: 40, reset_at: 2000500000 },
        },
        rate_limit_reset_credits: { available_count: 2 },
      }),
    });
  }

  it("tracks usage balance separately from quota and reset-bank credits", async () => {
    respond({ balance: "55969", has_credits: true, unlimited: false });
    const before = Date.now();

    const result = await getCodexUsage("token", { strictProxy: false }, { workspaceId: "acct_123" });

    expect(result.credits).toEqual({ balance: 55969, hasCredits: true, unlimited: false });
    expect(result.resetCredits).toEqual({ availableCount: 2 });
    expect(result.quotas.session.used).toBe(25);
    expect(result.quotas.weekly.used).toBe(40);
    expect(Date.parse(result.fetchedAt)).toBeGreaterThanOrEqual(before);
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("/wham/usage"),
      expect.objectContaining({
        headers: expect.objectContaining({ "ChatGPT-Account-ID": "acct_123" }),
        signal: expect.any(AbortSignal),
      }),
      { strictProxy: false },
    );
  });

  it.each([
    [{ workspaceId: "workspace", chatgptAccountId: "chatgpt", accountId: "generic" }, "workspace"],
    [{ workspaceId: " ", chatgptAccountId: "chatgpt", accountId: "generic" }, "chatgpt"],
    [{ chatgptAccountId: "chatgpt", accountId: "generic" }, "chatgpt"],
    [{ workspaceId: 123, chatgptAccountId: {}, accountId: "generic" }, "generic"],
    [{ workspaceId: " ", chatgptAccountId: false, accountId: [] }, null],
  ])("scopes usage checks to executor account precedence for %j", async (data, expected) => {
    respond({ balance: 10, has_credits: true, unlimited: false });
    expect(getCodexAccountId(data)).toBe(expected);
    await getCodexUsage("token", null, data);
    expect(proxyAwareFetch.mock.calls[0][1].headers["ChatGPT-Account-ID"]).toBe(expected ?? undefined);
  });

  it.each([undefined, null, "", " \t ", "not-a-balance", "55,969", -1, "-1", Infinity, NaN, true, false, {}, []])(
    "preserves unknown or invalid balance %j instead of making it zero",
    async (balance) => {
      respond({ balance, has_credits: true, unlimited: false });
      expect((await getCodexUsage("token")).credits).toEqual({ balance: null, hasCredits: true, unlimited: false });
    },
  );

  it.each([0, "0", "0.00", 0.5, "12.75"])("preserves valid balance %j", async (balance) => {
    respond({ balance, has_credits: Number(balance) > 0, unlimited: false });
    expect((await getCodexUsage("token")).credits.balance).toBe(Number(balance));
  });

  it("preserves absent credit data as unknown", async () => {
    respond(undefined);
    expect((await getCodexUsage("token")).credits).toEqual({ balance: null, hasCredits: null, unlimited: false });
  });

  it("preserves unlimited credit status without inventing a balance", async () => {
    respond({ has_credits: true, unlimited: true });
    expect((await getCodexUsage("token")).credits).toEqual({ balance: null, hasCredits: true, unlimited: true });
  });

  it("does not trust string booleans", async () => {
    respond({ balance: "100", has_credits: "true", unlimited: "true" });
    expect((await getCodexUsage("token")).credits).toEqual({ balance: 100, hasCredits: null, unlimited: false });
  });

  it.each([undefined, null, "", " \t ", "invalid", -1, 101, Infinity, NaN, true, false, {}, []])(
    "preserves invalid quota usage %j as unknown instead of inventing remaining capacity",
    async (used) => {
      respond({ balance: 10, has_credits: true, unlimited: false }, { used_percent: used, reset_at: 2000000000 });
      expect((await getCodexUsage("token")).quotas.session).toMatchObject({ used: null, remaining: null });
    },
  );

  it.each([0, "0", 50, "50", 100, "100"])("preserves valid quota usage %j", async (used) => {
    respond({ balance: 10, has_credits: true, unlimited: false }, { used_percent: used, reset_at: 2000000000 });
    expect((await getCodexUsage("token")).quotas.session).toMatchObject({ used: Number(used), remaining: 100 - Number(used) });
  });

  it("does not mark a failed upstream read as a fresh credit snapshot", async () => {
    proxyAwareFetch.mockResolvedValue({ ok: false, status: 401 });
    const result = await getCodexUsage("token");
    expect(result.message).toContain("401");
    expect(result.credits).toBeUndefined();
    expect(result.fetchedAt).toBeUndefined();
  });
});
