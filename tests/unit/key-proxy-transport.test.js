import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), refresh: vi.fn() }));
vi.mock("undici", () => ({
  fetch: mocks.fetch,
  ProxyAgent: class { constructor({ uri }) { this.uri = uri; } },
  Agent: class {},
  FormData: globalThis.FormData,
}));
vi.mock("node:dns", () => ({ default: { promises: { lookup: async () => [{ address: "203.0.113.4", family: 4 }] } } }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ refreshCredentials: mocks.refresh }) }));
vi.mock("../../open-sse/services/tokenRefresh.js", () => ({ refreshWithRetry: (fn) => fn(), refreshTokenByProvider: mocks.refresh }));

import { getCredentialFetch, getCredentialProxyOptions, resetDirectDispatchersForTests } from "../../open-sse/utils/proxyFetch.js";
import { handleEmbeddingsCore } from "../../open-sse/handlers/embeddingsCore.js";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { handleFetchCore } from "../../open-sse/handlers/fetch/index.js";
import { handleSearchCore } from "../../open-sse/handlers/search/index.js";
import { handleTtsCore } from "../../open-sse/handlers/ttsCore.js";
import { handleSttCore } from "../../open-sse/handlers/sttCore.js";
import { handleVideoProxyCore } from "../../open-sse/handlers/videoCore.js";
import { handleSystemoneCore } from "../../open-sse/handlers/systemoneCore.js";

const proxy = (id) => ({ connectionProxyEnabled: true, connectionProxyUrl: `http://user:password@${id}.example:8080`, proxyPoolId: id, strictProxy: true });
const credentials = (id = "key-a") => ({ apiKey: "provider-secret", requestProxyOptions: proxy(id), providerSpecificData: { connectionProxyEnabled: true, connectionProxyUrl: "http://account.example:8080", connectionProxyPoolId: "account" } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function assertProxyCalls(count, id = "key-a") {
  expect(mocks.fetch).toHaveBeenCalledTimes(count);
  for (const [, init] of mocks.fetch.mock.calls) {
    expect(init.dispatcher.uri).toBe(proxy(id).connectionProxyUrl);
    expect(new Headers(init.headers).has("proxy-authorization")).toBe(false);
    expect(init.strictTls).toBe(true);
  }
  expect(globalThis.fetch).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDirectDispatchersForTests();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected direct fetch"); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("API key proxy transport", () => {
  it("overrides account proxy without mutating credentials and isolates simultaneous keys", async () => {
    const first = credentials();
    const snapshot = structuredClone(first);
    const second = credentials("key-b");
    mocks.fetch.mockImplementation(async () => json({ ok: true }));
    await Promise.all([getCredentialFetch(first)("https://provider.example/a"), getCredentialFetch(second)("https://provider.example/b")]);
    expect(mocks.fetch.mock.calls.map(([, init]) => init.dispatcher.uri)).toEqual([proxy("key-a").connectionProxyUrl, proxy("key-b").connectionProxyUrl]);
    expect(first).toEqual(snapshot);
    expect(getCredentialProxyOptions({ providerSpecificData: first.providerSpecificData }).proxyPoolId).toBe("account");
  });

  it("never falls back to environment proxy or direct fetch and redacts failures", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://fallback.example:8080");
    mocks.fetch.mockRejectedValue(new Error("failed http://user:password@key-a.example:8080"));
    await expect(getCredentialFetch(credentials())("https://provider.example")).rejects.toMatchObject({ keyProxyError: true, message: "[ProxyFetch] API key proxy unavailable" });
    assertProxyCalls(1);
    const missing = credentials();
    missing.requestProxyOptions.connectionProxyUrl = "";
    await expect(getCredentialFetch(missing)("https://provider.example")).rejects.toMatchObject({ keyProxyError: true });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps embedding auth retry on same key proxy", async () => {
    mocks.fetch.mockResolvedValueOnce(json({ error: "expired" }, 401)).mockResolvedValueOnce(json({ data: [{ embedding: [1] }] }));
    mocks.refresh.mockResolvedValue({ apiKey: "refreshed-secret" });
    const result = await handleEmbeddingsCore({ body: { input: "hello" }, modelInfo: { provider: "openai", model: "text-embedding-3-small" }, credentials: credentials() });
    expect(result.success).toBe(true);
    assertProxyCalls(2);
    expect(mocks.fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer refreshed-secret");
  });

  it("keeps image submission and polling on key proxy", async () => {
    vi.useFakeTimers();
    mocks.fetch.mockResolvedValueOnce(json({ polling_url: "https://poll.example/job" })).mockResolvedValueOnce(json({ status: "Ready", result: { sample: "https://image.example/result.png" } }));
    const pending = handleImageGenerationCore({ body: { prompt: "test" }, modelInfo: { provider: "black-forest-labs", model: "flux-pro" }, credentials: credentials() });
    await vi.runAllTimersAsync();
    expect((await pending).success).toBe(true);
    assertProxyCalls(2);
  });

  it.each([
    ["huggingface", "black-forest-labs/FLUX.1-Kontext-dev", { image: "https://source.example/image.png" }],
    ["huggingface", "black-forest-labs/FLUX.1-Kontext-dev", { images: ["https://source.example/image.png"] }],
    ["cloudflare-ai", "@cf/stabilityai/stable-diffusion-xl-base-1.0", { image: "https://source.example/image.png" }],
    ["cloudflare-ai", "@cf/stabilityai/stable-diffusion-xl-base-1.0", { mask: "https://source.example/mask.png" }],
  ])("rejects remote image input for bound %s keys before any download", async (provider, model, input) => {
    const creds = credentials();
    creds.providerSpecificData.accountId = "account";
    const result = await handleImageGenerationCore({
      body: { prompt: "test", ...input }, modelInfo: { provider, model }, credentials: creds,
    });
    expect(result.status).toBe(400);
    expect(result.error).toContain("send base64 images");
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("accepts inline image input and sends it through the key proxy", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
    const result = await handleImageGenerationCore({
      body: { prompt: "test", image: "data:image/png;base64,AQID" },
      modelInfo: { provider: "huggingface", model: "black-forest-labs/FLUX.1-Kontext-dev" }, credentials: credentials(),
    });
    expect(result.success).toBe(true);
    assertProxyCalls(1);
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).inputs).toBe("AQID");
  });

  it("retains SSRF redirect validation on search", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }));
    const result = await handleSearchCore({ body: { query: "test" }, provider: { id: "custom" }, providerConfig: { authType: "none", baseUrl: "https://search.example" }, credentials: credentials() });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Blocked URL");
    assertProxyCalls(1);
    expect(result.keyProxyError).not.toBe(true);
  });

  it("routes web fetch and System One through key proxy", async () => {
    mocks.fetch.mockResolvedValueOnce(json({ data: { markdown: "content" } })).mockResolvedValueOnce(json({ ok: true }));
    expect((await handleFetchCore({ url: "https://page.example", provider: "firecrawl", credentials: credentials() })).success).toBe(true);
    expect((await handleSystemoneCore({ body: { state: "s", questions: {} }, modelInfo: { provider: "ollama", model: "clef" }, credentials: credentials() })).success).toBe(true);
    assertProxyCalls(2);
  });

  it("routes speech and video HTTP requests through key proxy", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]))).mockResolvedValueOnce(json({ text: "hello" })).mockResolvedValueOnce(json({ request_id: "job", status: "pending" }));
    expect((await handleTtsCore({ provider: "openai", model: "tts-1/alloy", input: "hello", credentials: credentials() })).success).toBe(true);
    const formData = new FormData();
    formData.set("file", new Blob(["audio"], { type: "audio/wav" }), "audio.wav");
    expect((await handleSttCore({ provider: "openai", model: "whisper-1", formData, sttConfig: { format: "openai", baseUrl: "https://api.openai.com/v1/audio/transcriptions" }, credentials: credentials() })).success).toBe(true);
    expect((await handleVideoProxyCore({ provider: "xai", action: "generations", rawBody: JSON.stringify({ prompt: "test" }), credentials: credentials() })).success).toBe(true);
    assertProxyCalls(3);
  });

  it("tags transport failures without misclassifying provider rate limits", async () => {
    const args = { body: { input: "hello" }, modelInfo: { provider: "openai", model: "text-embedding-3-small" }, credentials: credentials() };
    mocks.fetch.mockRejectedValueOnce(new Error("proxy unavailable"));
    expect((await handleEmbeddingsCore(args)).keyProxyError).toBe(true);
    mocks.fetch.mockResolvedValueOnce(json({ error: { message: "rate limited" } }, 429));
    const response = await handleEmbeddingsCore(args);
    expect(response.status).toBe(429);
    expect(response.keyProxyError).not.toBe(true);
  });
});

describe("API key relay boundaries", () => {
  const relayCredentials = () => ({
    ...credentials(),
    requestProxyOptions: { proxyPoolId: "relay-a", vercelRelayUrl: "https://relay.example/proxy", strictProxy: true },
  });

  it.each([307, 308])("rejects relay %s redirects before replaying inference directly", async (status) => {
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status, headers: { location: "https://provider.example/direct" } }));
    await expect(getCredentialFetch(relayCredentials())("https://provider.example/v1/chat", {
      method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "private prompt" }] }),
    })).rejects.toMatchObject({ keyProxyError: true });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0][0]).toBe("https://relay.example/proxy");
    expect(mocks.fetch.mock.calls[0][1].redirect).toBe("manual");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([502, 503])("tags relay %s as key-local failure instead of locking shared accounts", async (status) => {
    mocks.fetch.mockResolvedValueOnce(json({ error: { message: "relay unavailable" } }, status));
    const result = await handleEmbeddingsCore({
      body: { input: "hello" }, modelInfo: { provider: "openai", model: "text-embedding-3-small" }, credentials: relayCredentials(),
    });
    expect(result.keyProxyError).toBe(true);
    expect(result.status).toBe(502);
    expect(result.error).not.toContain("relay.example");
  });

  it("retains genuine quota response handling through relays", async () => {
    mocks.fetch.mockResolvedValueOnce(json({ error: { message: "quota exceeded" } }, 429));
    const result = await handleEmbeddingsCore({
      body: { input: "hello" }, modelInfo: { provider: "openai", model: "text-embedding-3-small" }, credentials: relayCredentials(),
    });
    expect(result.status).toBe(429);
    expect(result.keyProxyError).not.toBe(true);
  });
});
