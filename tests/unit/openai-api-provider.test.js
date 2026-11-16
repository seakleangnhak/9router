import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { upstreamFetch } = vi.hoisted(() => ({ upstreamFetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => ({
  ...(await importOriginal()), proxyAwareFetch: upstreamFetch }));
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

const responsesCompletion = {
  id: "resp-fixture", object: "response", model: "gpt-6.1-sol", created_at: 1700000000, status: "completed",
  output: [
    { id: "msg-fixture", type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "Checking weather", annotations: [] }] },
    { id: "fc-fixture", type: "function_call", call_id: "call-fixture", name: "lookup",
      arguments: '{"city":"Phnom Penh"}', status: "completed" },
  ],
  usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
};
const functionTool = {
  type: "function", name: "lookup", description: "Look up weather", strict: true,
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
};
const responsesEvents = [
  { type: "response.created", response: { ...responsesCompletion, output: [], status: "in_progress" } },
  { type: "response.output_item.added", output_index: 1,
    item: { ...responsesCompletion.output[1], arguments: "", status: "in_progress" } },
  { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc-fixture", delta: '{"city":"Phnom Penh"}' },
  ...responsesCompletion.output.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
  { type: "response.completed", response: responsesCompletion },
];
const responsesSSE = responsesEvents.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

function chat(body, headers = {}) {
  return handleChatCore({
    body,
    modelInfo: { provider: "openai", model: body.model.replace(/^openai\//, "") },
    credentials: { apiKey: "sk-openai-fixture", providerSpecificData: {} },
    connectionId: "openai-fixture",
    clientRawRequest: { endpoint: body.input ? "/v1/responses" : "/v1/chat/completions", body: structuredClone(body), headers },
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

  it.each([false, true])("routes GPT-6.1 Sol Responses tools and reasoning losslessly (stream=%s)", async (stream) => {
    upstreamFetch.mockResolvedValueOnce(new Response(responsesSSE, { headers: { "content-type": "text/event-stream" } }));
    const body = {
      model: "openai/gpt-6.1-sol", stream,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Weather in Phnom Penh?" }] }],
      tools: [functionTool], reasoning: { effort: "low", summary: "auto" }, text: { format: { type: "text" }, verbosity: "low" },
    };
    const requested = structuredClone(body);
    const result = await chat(body);

    expect(upstreamFetch).toHaveBeenCalledOnce();
    const [url, init] = upstreamFetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-openai-fixture");
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ model: "gpt-6.1-sol", stream: true,
      input: requested.input, tools: requested.tools, reasoning: requested.reasoning, text: requested.text });
    expect(sent).not.toHaveProperty("messages");
    expect(sent).not.toHaveProperty("reasoning_effort");
    expect(result.success).toBe(true);
    if (stream) {
      expect(result.response.headers.get("content-type")).toContain("text/event-stream");
      const raw = await result.response.text();
      const events = raw.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
      expect(events).toContainEqual(responsesEvents[2]);
      expect(events.find((event) => event.type === "response.completed")?.response).toMatchObject(responsesCompletion);
    } else {
      expect(result.response.headers.get("content-type")).toContain("application/json");
      expect(await result.response.json()).toMatchObject({ object: "response", status: "completed",
        output: responsesCompletion.output, usage: responsesCompletion.usage });
    }
  });

  it("routes GPT-6.1 Sol Chat function tools through Responses and returns Chat JSON", async () => {
    upstreamFetch.mockResolvedValueOnce(new Response(responsesSSE, { headers: { "content-type": "text/event-stream" } }));
    const { type, ...fn } = functionTool;
    const result = await chat({ model: "openai/gpt-6.1-sol", stream: false, reasoning_effort: "low",
      messages: [{ role: "user", content: "Weather in Phnom Penh?" }], tools: [{ type, function: fn }] });

    expect(upstreamFetch).toHaveBeenCalledOnce();
    const [url, init] = upstreamFetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ model: "gpt-6.1-sol", stream: true, tools: [functionTool], reasoning: { effort: "low" },
      input: [{ role: "user", content: [{ type: "input_text", text: "Weather in Phnom Penh?" }] }] });
    expect(sent).not.toHaveProperty("messages");
    expect(sent).not.toHaveProperty("reasoning_effort");
    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toContain("application/json");
    expect(await result.response.json()).toMatchObject({ object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "Checking weather",
        tool_calls: [{ id: "call-fixture", type: "function", function: { name: "lookup", arguments: '{"city":"Phnom Penh"}' } }] },
      finish_reason: "tool_calls" }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
  });

  it.each(["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"])("lists %s on the API-key provider", (model) => {
    expect(PROVIDER_MODELS.openai.some(({ id }) => id === model)).toBe(true);
  });
});
