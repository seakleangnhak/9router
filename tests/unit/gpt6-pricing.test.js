import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getPricingForModel, calculateCostFromTokens, formatCost } from "../../open-sse/providers/pricing.js";

const cases = [
  ["gpt-6-astra(medium)", 10, 1, 12.5, 50],
  ["gpt-6-luna", 0.1, 0.01, 0.125, 0.5],
  ["gpt-6-sol(medium)", 2, 0.2, 2.5, 10],
  ["gpt-6.1-sol", 2, 0.1, 2.5, 10],
  ["gpt-6.1-sol(high)", 2, 0.1, 2.5, 10],
];
const originalDataDir = process.env.DATA_DIR;
let tempDir, db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-gpt6-pricing-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("GPT-6 pricing", () => {
  it.each(cases)("calculates and persists %s cost with cache reads/writes", async (model, input, cached, creation, output) => {
    const pricing = { input, cached, cache_creation: creation, output, reasoning: output };
    const tokens = { prompt_tokens: 10000, cached_tokens: 6000, cache_creation_input_tokens: 1000, completion_tokens: 2000 };
    const expected = (3000 * input + 6000 * cached + 1000 * creation + 2000 * output) / 1_000_000;
    expect(getPricingForModel("codex", model)).toEqual(pricing);
    expect(getPricingForModel("codex", `cx/${model}`)).toEqual(pricing);
    expect(calculateCostFromTokens(tokens, pricing)).toBeCloseTo(expected, 12);

    await db.saveRequestUsage({ provider: "codex", model, connectionId: "fixture", tokens, endpoint: "/v1/responses" });
    const history = await db.getUsageHistory({ provider: "codex", model });
    expect(history.find(row => row.model === model).cost).toBeCloseTo(expected, 12);
    const stats = await db.getUsageStats("24h");
    expect(stats.byModel[`${model} (codex)`].cost).toBeCloseTo(expected, 12);
  });

  it("preserves provider overrides and free namespace rates with thinking suffixes", () => {
    expect(getPricingForModel("github", "gpt-5.3-codex(high)"))
      .toEqual(getPricingForModel("github", "gpt-5.3-codex"));
    expect(getPricingForModel("cline", "cline-free/deepseek-v4.1-flash(high)").input).toBe(0);
    expect(getPricingForModel("codex", "unknown-model(high)")).toBeNull();
  });

  it("honors custom base-model rates and explicit suffix-specific overrides", async () => {
    const base = { input: 3, cached: 0.3, cache_creation: 3.75, output: 15 };
    const high = { ...base, input: 4 };
    await db.updatePricing({ codex: { "gpt-6.1-sol": base, "gpt-6.1-sol(high)": high } });
    expect(await db.getPricingForModel("codex", "gpt-6.1-sol(medium)")).toEqual(base);
    expect(await db.getPricingForModel("codex", "gpt-6.1-sol(high)")).toEqual(high);
    await db.resetPricing("codex");
  });

  it.each([
    [0, "$0.00"], [undefined, "$0.00"], [0.000001, "<$0.0001"],
    [0.0001, "$0.0001"], [0.003025, "$0.0030"], [0.01, "$0.01"], [1.25, "$1.25"],
  ])("shows cost %s as %s", (cost, expected) => {
    expect(formatCost(cost)).toBe(expected);
  });
});
