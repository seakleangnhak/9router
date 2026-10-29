import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { upstreamFetch } = vi.hoisted(() => ({ upstreamFetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: upstreamFetch }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest() {}, logRawRequest() {}, logOpenAIRequest() {},
    logTargetRequest() {}, logProviderResponse() {}, logConvertedResponse() {},
    appendProviderChunk() {}, appendOpenAIChunk() {}, appendConvertedChunk() {}, logError() {},
  }),
}));
vi.mock("@/lib/localDb", () => ({ getApiKeys: async () => [{ key: "router-fixture", isActive: true }] }));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: async () => "cli-fixture" }));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { pingModelByKind } = await import("../../src/app/api/models/test/ping.js");
const { PROVIDER_MODELS } = await import("../../open-sse/config/providerModels.js");

const completion = {
  id: "chatcmpl-fixture", object: "chat.completion", model: "gpt-5.5", created: 1700000000,
  choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function chat(body, headers = {}) {
  return handleChatCore({
    body,
    modelInfo: { provider: "openai", model: "gpt-5.5" },
    credentials: { apiKey: "sk-openai-fixture", providerSpecificData: {} },
    connectionId: "openai-fixture",
    clientRawRequest: { endpoint: "/v1/chat/completions", body: structuredClone(body), headers },
  });
}

function expectUpstreamRequest() {
  expect(upstreamFetch).toHaveBeenCalledOnce();
  const [url, init] = upstreamFetch.mock.calls[0];
  expect(url).toBe("https://api.openai.com/v1/chat/completions");
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-openai-fixture");
  const body = JSON.parse(init.body);
  expect(body).toMatchObject({ model: "gpt-5.5", stream: true, max_completion_tokens: 1024 });
  expect(body).not.toHaveProperty("max_tokens");
}

describe("OpenAI API provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn(async (url) => { throw new Error(`Unexpected fetch: ${url}`); }));
    // Match the official endpoint: stream defaults to false. This makes the
    // old forceStream/body mismatch reproduce the dashboard's exact failure.
    upstreamFetch.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (!body.stream) return Response.json(completion);
      const chunk = {
        ...completion,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("passes the dashboard GPT-5.5 model test through the real handler and executor", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      expect(url).toBe("http://127.0.0.1:20128/api/v1/chat/completions");
      const result = await chat(JSON.parse(init.body), Object.fromEntries(new Headers(init.headers)));
      return result.response;
    }));

    const result = await pingModelByKind("openai/gpt-5.5", "llm", "http://127.0.0.1:20128");
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, error: null, status: 200 });
    expectUpstreamRequest();
  });

  it.each([
    ["explicit stream:false", false, {}],
    ["omitted stream", undefined, {}],
    ["omitted stream with JSON Accept", undefined, { accept: "application/json" }],
  ])("returns valid JSON for %s", async (_label, stream, headers) => {
    const body = { model: "openai/gpt-5.5", messages: [{ role: "user", content: "hi" }], max_tokens: 1024 };
    if (stream !== undefined) body.stream = stream;
    const result = await chat(body, headers);

    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toContain("application/json");
    expect(await result.response.json()).toMatchObject({
      object: "chat.completion", choices: [{ message: { role: "assistant", content: "Hi" } }],
    });
    expectUpstreamRequest();
  });

  it("keeps streaming clients on SSE", async () => {
    const result = await chat({
      model: "openai/gpt-5.5", messages: [{ role: "user", content: "hi" }], max_tokens: 1024, stream: true,
    }, { accept: "text/event-stream" });

    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toContain("text/event-stream");
    const raw = await result.response.text();
    expect(raw).toContain('"content":"Hi"');
    expect(raw).toContain("data: [DONE]");
    expectUpstreamRequest();
  });

  it.each(["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"])("lists %s on the API-key provider", (model) => {
    expect(PROVIDER_MODELS.openai.some(({ id }) => id === model)).toBe(true);
  });
});
