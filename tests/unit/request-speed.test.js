import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { formatTokensPerSecond, getTokensPerSecond } from "../../src/shared/utils/requestSpeed.js";
import { buildOnStreamComplete } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { handleNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const saves = vi.hoisted(() => ({ usage: vi.fn(async () => {}), detail: vi.fn(async () => {}) }));
vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: saves.usage,
  saveRequestDetail: saves.detail,
  appendRequestLog: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

describe("request TPS", () => {
  it.each([{ completion_tokens: 100 }, { output_tokens: 100 }])("reads output counts %j", (tokens) => {
    expect(getTokensPerSecond(tokens, 2000)).toBe(50);
  });

  it.each([undefined, null, 0, -1, NaN, Infinity, "2000"])("rejects duration %s", (duration) => {
    expect(getTokensPerSecond({ completion_tokens: 100 }, duration)).toBeNull();
  });

  it.each([undefined, null, 0, -1, NaN, Infinity, "100"])("rejects output count %s", (output) => {
    expect(getTokensPerSecond({ completion_tokens: output }, 2000)).toBeNull();
    expect(getTokensPerSecond({ output_tokens: output }, 2000)).toBeNull();
  });

  it("does not invent missing output counts or an overflowing speed", () => {
    expect(getTokensPerSecond(null, 2000)).toBeNull();
    expect(getTokensPerSecond({}, 2000)).toBeNull();
    expect(getTokensPerSecond({ completion_tokens: Number.MAX_VALUE }, 1)).toBeNull();
    expect(getTokensPerSecond({ completion_tokens: 0, output_tokens: 100 }, 2000)).toBeNull();
  });

  it("formats measured and unavailable speeds", () => {
    expect(formatTokensPerSecond(50)).toBe("50.0");
    expect(formatTokensPerSecond(0)).toBe("0.0");
    for (const value of [null, undefined, -1, NaN, Infinity]) {
      expect(formatTokensPerSecond(value)).toBe("—");
    }
  });
});

describe("request timing propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(4000);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["stream", "json", "chat-sse", "responses-sse"])("shares duration between usage and Details for %s", async (kind) => {
    const tokens = { prompt_tokens: 10, completion_tokens: 100 };
    const ctx = {
      provider: "openai", model: "test-model", connectionId: "test-connection",
      body: { model: "test-model", messages: [] }, stream: false, requestStartTime: 2000,
      sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.OPENAI,
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      trackDone: vi.fn(), appendLog: vi.fn(),
      reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() },
    };
    const message = { id: "chatcmpl-test", choices: [{ message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }], usage: tokens };
    const sse = (data) => `${data.type ? `event: ${data.type}\n` : ""}data: ${JSON.stringify(data)}\n\n`;

    if (kind === "stream") {
      const { onStreamComplete } = buildOnStreamComplete({ ...ctx, stream: true });
      onStreamComplete({ content: "Hi" }, tokens, 3500);
    } else if (kind === "json") {
      expect((await handleNonStreamingResponse({ ...ctx, providerResponse: Response.json(message) })).success).toBe(true);
    } else {
      const raw = kind === "chat-sse"
        ? sse({ ...message, choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n"
        : sse({ type: "response.completed", response: { id: "resp-test", status: "completed", usage: { input_tokens: 10, output_tokens: 100, total_tokens: 110 } } });
      const providerResponse = new Response(raw, { headers: { "content-type": "text/event-stream" } });
      const responseCtx = kind === "responses-sse" ? { provider: "codex", targetFormat: FORMATS.OPENAI_RESPONSES } : {};
      expect((await handleForcedSSEToJson({ ...ctx, ...responseCtx, providerResponse })).success).toBe(true);
    }

    expect(saves.usage).toHaveBeenCalledTimes(1);
    expect(saves.detail).toHaveBeenCalledTimes(1);
    const usage = saves.usage.mock.calls[0][0];
    const detail = saves.detail.mock.calls[0][0];
    expect(usage.latency).toBe(detail.latency);
    expect(usage.latency).toEqual({ ttft: kind === "stream" ? 1500 : 2000, total: 2000 });
    expect(getTokensPerSecond(usage.tokens, usage.latency.total)).toBe(50);
  });

  it("records total duration for System One decision usage", async () => {
    const modules = ["../../src/sse/services/auth.js", "@/lib/localDb", "../../src/sse/services/model.js", "../../src/sse/services/tokenRefresh.js", "../../open-sse/handlers/systemoneCore.js"];
    vi.doMock(modules[0], () => ({
      getProviderCredentials: async () => ({ connectionId: "test-connection", connectionName: "Test" }),
      clearAccountError: async () => {}, markAccountUnavailable: vi.fn(), extractApiKey: () => null, isValidApiKey: () => true,
    }));
    vi.doMock(modules[1], () => ({ getSettings: async () => ({ requireApiKey: false }) }));
    vi.doMock(modules[2], () => ({ getModelInfo: async () => ({ provider: "v1m", model: "rev-latest" }) }));
    vi.doMock(modules[3], () => ({ checkAndRefreshToken: async (_provider, credentials) => credentials }));
    vi.doMock(modules[4], () => ({ handleSystemoneCore: async () => {
      Date.now.mockReturnValue(4000);
      return { success: true, response: Response.json({}), usage: { prompt_tokens: 10, completion_tokens: 100 } };
    } }));
    try {
      const { handleSystemone } = await import("../../src/sse/handlers/systemone.js");
      Date.now.mockReturnValue(2000);
      await handleSystemone(new Request("http://localhost/v1/systemone", {
        method: "POST", body: JSON.stringify({ model: "v1m/rev-latest", state: {}, questions: {} }),
      }));
      expect(saves.usage).toHaveBeenCalledTimes(1);
      const usage = saves.usage.mock.calls[0][0];
      expect(usage.latency).toEqual({ total: 2000 });
      expect(getTokensPerSecond(usage.tokens, usage.latency.total)).toBe(50);
    } finally {
      for (const modulePath of modules) vi.doUnmock(modulePath);
    }
  });
});

describe("request TPS persistence", () => {
  const globalKeys = ["_dbAdapter", "_pendingRequests", "_lastErrorProvider", "_statsEmitter", "_pendingTimers", "_recentRing", "_connectionMapCache", "_statsEmitTimers"];
  const signals = ["beforeExit", "SIGINT", "SIGTERM"];
  let previousGlobals, previousListeners, tempDir, adapter, usage;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-tps-"));
    vi.stubEnv("DATA_DIR", tempDir);
    previousGlobals = new Map(globalKeys.map((key) => [key, global[key]]));
    previousListeners = new Map(signals.map((signal) => [signal, process.listeners(signal)]));
    for (const key of globalKeys) delete global[key];
    vi.resetModules();
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    adapter = await getAdapter();
    usage = await import("../../src/lib/db/repos/usageRepo.js");
    await usage.getActiveRequests();
  });

  afterAll(() => {
    for (const timer of Object.values(global._pendingTimers || {})) clearTimeout(timer);
    for (const timer of Object.values(global._statsEmitTimers || {})) clearTimeout(timer);
    adapter?.close();
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) {
        if (!previousListeners.get(signal).includes(listener)) process.removeListener(signal, listener);
      }
    }
    for (const [key, value] of previousGlobals) {
      if (value === undefined) delete global[key]; else global[key] = value;
    }
    vi.unstubAllEnvs();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("retains timing and TPS through live updates and a recent-request reload", async () => {
    const latency = { ttft: 1500, total: 2000 };
    await usage.saveRequestUsage({ provider: "openai", model: "timed", tokens: { prompt_tokens: 10, completion_tokens: 100 }, latency });
    const row = adapter.get("SELECT meta FROM usageHistory WHERE model = ?", ["timed"]);
    expect(JSON.parse(row.meta)).toEqual({ latency });
    expect((await usage.getUsageHistory({ model: "timed" }))[0].latency).toEqual(latency);
    expect((await usage.getActiveRequests()).recentRequests.find((r) => r.model === "timed").tokensPerSecond).toBe(50);
    expect((await usage.getUsageStats()).recentRequests.find((r) => r.model === "timed").tokensPerSecond).toBe(50);

    global._recentRing.items = [];
    global._recentRing.initialized = false;
    expect((await usage.getActiveRequests()).recentRequests.find((r) => r.model === "timed").tokensPerSecond).toBe(50);
  });

  it("leaves legacy requests without timing unavailable", async () => {
    await usage.saveRequestUsage({ provider: "openai", model: "legacy", tokens: { prompt_tokens: 10, completion_tokens: 100 } });
    expect((await usage.getActiveRequests()).recentRequests.find((r) => r.model === "legacy").tokensPerSecond).toBeNull();
    expect((await usage.getUsageStats()).recentRequests.find((r) => r.model === "legacy").tokensPerSecond).toBeNull();
  });
});
