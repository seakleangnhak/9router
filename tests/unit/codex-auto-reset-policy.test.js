import { describe, expect, it } from "vitest";
import {
  CODEX_AUTO_RESET_CONFIG as C,
  getCodexResetDecision,
  observeCodexUsage,
} from "../../src/shared/services/codexAutoResetPolicy.js";

const now = Date.parse("2026-10-30T05:00:00.000Z");
const iso = (offset) => new Date(now + offset).toISOString();
const minute = 60000;
const hour = 60 * minute;

function usage(used = 80, resetIn = 3 * hour) {
  return {
    fetchedAt: iso(0),
    credits: { balance: 0, hasCredits: false, unlimited: false },
    quotas: {
      session: { used, total: 100, remaining: 100 - used, resetAt: iso(resetIn) },
      weekly: { used: 20, total: 100, remaining: 80, resetAt: iso(3 * 24 * hour) },
    },
  };
}

function bank(expiresIn = 5 * minute) {
  return {
    fetchedAt: iso(0),
    availableCount: 1,
    credits: [{ id: "reset_1", status: "available", resetType: "codexRateLimits", expiresAt: iso(expiresIn) }],
  };
}

function history(currentUsage, previousUsed, { previousBalance = currentUsage.credits.balance, minutesAgo = 1 } = {}) {
  return [{
    at: now - minutesAgo * minute,
    balance: previousBalance,
    quotas: {
      session: { used: previousUsed, resetAt: currentUsage.quotas.session.resetAt },
      weekly: { used: currentUsage.quotas.weekly.used, resetAt: currentUsage.quotas.weekly.resetAt },
    },
  }];
}

function decide(overrides = {}) {
  return getCodexResetDecision({ mode: "auto", usage: usage(), bank: bank(), nowMs: now, ...overrides });
}

describe("Codex automatic reset policy", () => {
  it("defaults absent or invalid modes to disabled", () => {
    for (const mode of [undefined, "off", "enabled", true]) {
      expect(decide({ mode })).toMatchObject({ redeem: false, reason: "Automatic reset disabled." });
    }
  });

  it("Auto redeems only near expiry and preserves a positive usage-credit balance", () => {
    const current = usage();
    current.credits = { balance: 55969, hasCredits: true, unlimited: false };
    expect(decide({ usage: current })).toMatchObject({ redeem: true, credit: { id: "reset_1" } });
    expect(decide({ usage: current, bank: bank(C.autoLeadMs + 1) }).redeem).toBe(false);
  });

  it.each([null, undefined, "55969", NaN, Infinity, -1])("pauses when usage-credit balance is unknown or invalid: %s", (balance) => {
    const current = usage();
    current.credits.balance = balance;
    for (const mode of ["auto", "smart"]) {
      expect(decide({ mode, usage: current })).toMatchObject({ redeem: false, reason: expect.stringContaining("balance unknown") });
    }
  });

  it("accepts a known zero balance without conflating it with missing data", () => {
    const current = usage();
    current.credits = { balance: 0, hasCredits: false, unlimited: false };
    expect(decide({ usage: current }).redeem).toBe(true);
  });

  it("does not spend resets to replace unlimited usage credits", () => {
    const current = usage();
    current.credits.unlimited = true;
    expect(decide({ usage: current }).redeem).toBe(false);
  });

  it("requires fresh timestamps from both quota/credit and reset-bank reads", () => {
    expect(decide({ usage: { ...usage(), fetchedAt: iso(-C.maxDataAgeMs - 1) } }).redeem).toBe(false);
    expect(decide({ bank: { ...bank(), fetchedAt: iso(-C.maxDataAgeMs - 1) } }).redeem).toBe(false);
    expect(decide({ bank: { ...bank(), fetchedAt: null } }).redeem).toBe(false);
    expect(decide({ usage: { ...usage(), fetchedAt: iso(minute) } }).redeem).toBe(false);
  });

  it("skips full quotas, unknown windows, and imminent natural resets", () => {
    const full = usage(0);
    full.quotas.weekly.used = 0;
    expect(decide({ usage: full }).redeem).toBe(false);
    expect(decide({ usage: { ...usage(), quotas: {} } }).redeem).toBe(false);
    const soon = usage(80, minute);
    soon.quotas.weekly.used = 0;
    expect(decide({ usage: soon }).redeem).toBe(false);
    const invalid = usage();
    invalid.quotas.weekly.used = "80";
    expect(decide({ usage: invalid }).redeem).toBe(false);
  });

  it("requires an available, unexpired eligible credit with opaque ID and known expiry", () => {
    for (const patch of [
      { status: "redeemed" }, { id: null }, { id: " " }, { expiresAt: null },
      { expiresAt: "invalid" }, { expiresAt: iso(-1) }, { resetType: "differentFeature" },
    ]) {
      const currentBank = bank();
      Object.assign(currentBank.credits[0], patch);
      expect(decide({ bank: currentBank }).redeem).toBe(false);
    }
    expect(decide({ bank: { ...bank(), availableCount: 0 } }).redeem).toBe(false);
    expect(decide({ bank: { ...bank(), availableCount: "1" } }).redeem).toBe(false);
  });

  it("selects earliest eligible expiry without mutating bank rows", () => {
    const currentBank = bank();
    currentBank.availableCount = 3;
    currentBank.credits.push(
      { ...currentBank.credits[0], id: "later", expiresAt: iso(hour) },
      { ...currentBank.credits[0], id: "first", expiresAt: iso(minute) },
    );
    expect(decide({ bank: currentBank }).credit.id).toBe("first");
    expect(currentBank.credits.map((credit) => credit.id)).toEqual(["reset_1", "later", "first"]);
  });

  it("Smart requires observed work even when quota is exhausted and credit is expiring", () => {
    expect(decide({ mode: "smart", usage: usage(100) }).redeem).toBe(false);
    const current = usage(100);
    expect(decide({ mode: "smart", usage: current, history: history(current, 100) }).redeem).toBe(false);
  });

  it.each([
    [55968.1592845, true], [0.000001, true], [55968.1592845, false], [55968.1592845, null], [0, true],
  ])("Smart retains resets while credits remain or their availability conflicts: %s, %s", (balance, hasCredits) => {
    const current = usage(100);
    current.credits = { balance, hasCredits, unlimited: false };
    expect(decide({ mode: "smart", usage: current, bank: bank(minute), history: history(current, 100, { previousBalance: 56000 }) })).toMatchObject({
      redeem: false, reason: expect.stringContaining("Usage credits remain"),
    });
  });

  it.each([[95, 85, 4 * 24 * hour], [40, 39, minute]])("Smart keeps usage credits ahead of workload and expiry triggers: %s", (used, previousUsed, expiresIn) => {
    const current = usage(used);
    current.credits = { balance: 55968.1592845, hasCredits: true, unlimited: false };
    expect(decide({ mode: "smart", usage: current, bank: bank(expiresIn), history: history(current, previousUsed) }).redeem).toBe(false);
  });

  it("Smart reacts sooner to a heavy workload than a light workload at identical quota usage", () => {
    const current = usage(95);
    const args = { mode: "smart", usage: current, bank: bank(4 * 24 * hour) };
    expect(decide({ ...args, history: history(current, 85) }).redeem).toBe(true);
    expect(decide({ ...args, history: history(current, 94) }).redeem).toBe(false);
  });

  it("Smart waits when remaining quota covers expected work before natural reset", () => {
    const current = usage(95, 4 * minute);
    expect(decide({ mode: "smart", usage: current, history: history(current, 94) }).redeem).toBe(false);
  });

  it("Smart can save an expiring reset before quota is nearly exhausted", () => {
    const current = usage(40);
    expect(decide({ mode: "smart", usage: current, bank: bank(minute), history: history(current, 39) }).redeem).toBe(true);
    expect(decide({ mode: "smart", usage: current, bank: bank(20 * minute), history: history(current, 39) }).redeem).toBe(false);
  });

  it("Smart learns weekly depletion independently from the 5-hour window", () => {
    const current = usage(10, minute);
    current.quotas.weekly.used = 99;
    const samples = history(current, 10);
    samples[0].quotas.weekly.used = 90;
    expect(decide({ mode: "smart", usage: current, bank: bank(48 * hour), history: samples })).toMatchObject({
      redeem: true, reason: expect.stringContaining("weekly"),
    });
  });

  it("Smart uses depleted credits as activity only when quota is already exhausted", () => {
    const exhausted = usage(100);
    expect(decide({ mode: "smart", usage: exhausted, history: history(exhausted, 100, { previousBalance: 56000 }) }).redeem).toBe(true);
    const partial = usage(80);
    expect(decide({ mode: "smart", usage: partial, history: history(partial, 80, { previousBalance: 56000 }) }).redeem).toBe(false);
  });

  it("Smart discards rates across reset discontinuities and stale activity", () => {
    const current = usage(95);
    const changedWindow = history(current, 85);
    changedWindow[0].quotas.session.resetAt = iso(-hour);
    expect(decide({ mode: "smart", usage: current, history: changedWindow }).redeem).toBe(false);
    expect(decide({ mode: "smart", usage: current, history: history(current, 99) }).redeem).toBe(false);
    expect(decide({ mode: "smart", usage: current, history: history(current, 85, { minutesAgo: 20 }) }).redeem).toBe(false);
  });

  it("Smart does not infer a burst from observations taken less than one scheduler tick apart", () => {
    const current = usage(99);
    const samples = history(current, 70);
    samples[0].at = now - 100;
    expect(decide({ mode: "smart", usage: current, history: samples }).redeem).toBe(false);
  });
});

describe("Codex usage observations", () => {
  it("records both quota windows and a zero balance without mutating history", () => {
    const current = usage(50);
    current.credits.balance = 0;
    const previous = history(current, 40);
    const observed = observeCodexUsage(previous, current, now);
    expect(observed).toHaveLength(2);
    expect(observed[1]).toMatchObject({ at: now, balance: 0, quotas: { session: { used: 50 }, weekly: { used: 20 } } });
    expect(previous).toHaveLength(1);
  });

  it("replaces duplicate timestamps and bounds retained history", () => {
    const current = usage();
    const rows = Array.from({ length: C.historyMaxEntries + 20 }, (_, i) => ({
      at: now - (C.historyMaxEntries + 19 - i) * 1000, balance: 10, quotas: {},
    }));
    rows.push({ at: now + 1, quotas: {} }, { at: now - C.historyMaxAgeMs - 1, quotas: {} });
    const observed = observeCodexUsage(rows, current, now);
    expect(observed).toHaveLength(C.historyMaxEntries);
    expect(observed.at(-1)).toMatchObject({ at: now, balance: 0 });
    expect(observed.filter((sample) => sample.at === now)).toHaveLength(1);
  });

  it("does not turn stale data into a fresh observation or missing balance into zero", () => {
    const current = usage();
    current.credits.balance = null;
    expect(observeCodexUsage([], current, now)[0].balance).toBeNull();
    current.fetchedAt = iso(-C.maxDataAgeMs - 1);
    expect(observeCodexUsage([], current, now)).toEqual([]);
  });
});
