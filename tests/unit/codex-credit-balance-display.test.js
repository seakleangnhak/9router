import { describe, expect, it } from "vitest";
import { formatCodexCreditBalance } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("Codex usage-credit display", () => {
  it("shows exact balance separately from reset-credit counts", () => {
    expect(formatCodexCreditBalance({ balance: 55969, hasCredits: true, unlimited: false }, "en-US")).toBe("55,969");
    expect(formatCodexCreditBalance({ balance: 0 }, "en-US")).toBe("0");
    expect(formatCodexCreditBalance({ balance: 123.45 }, "en-US")).toBe("123.45");
    expect(formatCodexCreditBalance({ balance: 0.000001 }, "en-US")).toBe("0.000001");
  });

  it("distinguishes unknown, hidden, unavailable, and unlimited credit balances", () => {
    expect(formatCodexCreditBalance(null)).toBe("Unknown");
    expect(formatCodexCreditBalance({ balance: null })).toBe("Unknown");
    expect(formatCodexCreditBalance({ balance: "" })).toBe("Unknown");
    expect(formatCodexCreditBalance({ balance: NaN })).toBe("Unknown");
    expect(formatCodexCreditBalance({ balance: -1 })).toBe("Unknown");
    expect(formatCodexCreditBalance({ balance: null, hasCredits: true })).toBe("Available (balance unavailable)");
    expect(formatCodexCreditBalance({ balance: null, hasCredits: false })).toBe("None available");
    expect(formatCodexCreditBalance({ unlimited: true })).toBe("Unlimited");
  });
});
