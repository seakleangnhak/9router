import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("undici", () => ({
  fetch: mocks.fetch,
  ProxyAgent: class { constructor({ uri }) { this.uri = uri; } },
  Agent: class {},
  FormData: globalThis.FormData,
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
  }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import { resetDirectDispatchersForTests } from "../../open-sse/utils/proxyFetch.js";

const keyProxy = {
  proxyPoolId: "key-pool", connectionProxyEnabled: true,
  connectionProxyUrl: "http://proxy-user:proxy-password@key-proxy.example:8080", connectionNoProxy: "", strictProxy: true,
};
const accountProxy = {
  connectionProxyPoolId: "account-pool", connectionProxyEnabled: true,
  connectionProxyUrl: "http://account-proxy.example:8080", connectionNoProxy: "*", workspaceId: "codex-account",
};
const specs = [
  {
    provider: "openai", model: "gpt-4o", format: "openai", endpoint: "/v1/chat/completions",
    url: "https://api.openai.com/v1/chat/completions", token: "openai-api-secret",
    body: { stream: true, messages: [{ role: "user", content: "native proxy test" }], temperature: 0.2 },
  },
  {
    provider: "codex", model: "gpt-6.1-sol", format: "openai-responses", endpoint: "/v1/responses",
    url: "https://chatgpt.com/backend-api/codex/responses", token: "codex-oauth-secret",
    body: {
      stream: true, instructions: "Preserve native request", store: false,
      input: [{ role: "user", content: [{ type: "input_text", text: "native proxy test" }] }],
      reasoning: { effort: "high" },
    },
  },
];

function run(spec) {
  const body = { model: spec.model, ...structuredClone(spec.body) };
  const credentials = {
    connectionId: "account", [spec.provider === "codex" ? "accessToken" : "apiKey"]: spec.token,
    providerSpecificData: structuredClone(accountProxy), requestProxyOptions: structuredClone(keyProxy),
  };
  return {
    credentials,
    result: handleChatCore({
      body, modelInfo: { provider: spec.provider, model: spec.model }, credentials,
      connectionId: "account", sourceFormatOverride: spec.format, userAgent: "codex-cli/0.144.1",
      clientRawRequest: { endpoint: spec.endpoint, body, headers: { accept: "application/json", "user-agent": "codex-cli/0.144.1" } },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), errorLine: vi.fn() },
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDirectDispatchersForTests();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected direct fetch"); }));
});
afterEach(() => vi.unstubAllGlobals());

describe.each(specs)("$provider chat uses API key proxy", (spec) => {
  it("preserves native request and provider auth while overriding account proxy", async () => {
    mocks.fetch.mockImplementation(async () => spec.provider === "codex"
      ? new Response(`event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: { id: "resp-proxy", object: "response", status: "completed", model: spec.model,
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "through-key-proxy", annotations: [] }] }],
            usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } },
        })}\n\n`, { headers: { "content-type": "text/event-stream" } })
      : new Response(`data: ${JSON.stringify({ id: "chatcmpl-proxy", object: "chat.completion.chunk", model: spec.model,
          choices: [{ index: 0, delta: { role: "assistant", content: "through-key-proxy" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }));

    const { credentials, result } = run(spec);
    const response = await result;
    expect(response.success).toBe(true);
    expect(await response.response.text()).toContain("through-key-proxy");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0];
    expect(url).toBe(spec.url);
    expect(init.method).toBe("POST");
    expect(init.dispatcher.uri).toBe(keyProxy.connectionProxyUrl);
    expect(init.strictTls).toBe(true);
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${spec.token}`);
    expect(headers.has("Proxy-Authorization")).toBe(false);
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe(spec.model);
    if (spec.provider === "codex") {
      expect(sent).toMatchObject({ reasoning: spec.body.reasoning, store: false, stream: true });
      expect(sent.input).toEqual(expect.arrayContaining(spec.body.input));
      const instructions = [sent.instructions, ...sent.input.filter(item => item.role === "developer")
        .flatMap(item => (item.content || []).map(part => part.text))];
      expect(instructions).toContain(spec.body.instructions);
      expect(headers.get("ChatGPT-Account-ID")).toBe("codex-account");
    } else {
      expect(sent).toMatchObject({ messages: spec.body.messages, temperature: 0.2, stream: true });
    }
    expect(credentials.providerSpecificData).toEqual(accountProxy);
    expect(credentials.requestProxyOptions).toEqual(keyProxy);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns tagged proxy failure without retrying account or direct transport", async () => {
    mocks.fetch.mockRejectedValue(new Error(`connect failed: ${keyProxy.connectionProxyUrl}`));
    const response = await run(spec).result;
    expect(response).toMatchObject({ success: false, status: 502, keyProxyError: true });
    expect(await response.response.text()).not.toContain("proxy-password");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
