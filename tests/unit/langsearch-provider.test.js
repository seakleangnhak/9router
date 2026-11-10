import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dns from "node:dns";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { buildSearchRequest } from "../../open-sse/handlers/search/callers.js";
import { normalizeSearchResponse } from "../../open-sse/handlers/search/normalizers.js";
import { handleSearchCore } from "../../open-sse/handlers/search/index.js";
import { getProvidersByKind } from "@/shared/constants/providers.js";

const fx = vi.hoisted(() => ({ keys: {}, combos: [] }));
const credentials = vi.hoisted(() => vi.fn());
const markUnavailable = vi.hoisted(() => vi.fn());
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: true, comboStrategy: "fallback" }),
  getCombos: async () => fx.combos,
  getComboByName: async (name) => fx.combos.find((combo) => combo.name === name) || null,
  getModelAliases: async () => ({}),
  getProviderNodes: async () => [],
}));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async (key) => fx.keys[key] }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => fx.combos }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: credentials,
  markAccountUnavailable: markUnavailable,
  clearAccountError: vi.fn(),
  extractApiKey: (request) => request.headers.get("authorization")?.slice(7) || null,
  isValidApiKey: async (key) => Boolean(fx.keys[key]),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, value) => value,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), maskKey: () => "***",
}));

const { handleSearch } = await import("../../src/sse/handlers/search.js");
const provider = REGISTRY.find((entry) => entry.id === "langsearch");
const url = "https://example.com/release";
const params = { query: "release notes", searchType: "web", maxResults: 5, token: "langsearch-fixture" };
const payload = {
  code: 200,
  data: { webPages: { value: [{ name: "Release", url, snippet: "Latest release", datePublished: "2026-11-10" }] } },
  usage: { input_tokens: 3, output_tokens: 12 },
};
const response = (value = payload, status = 200, headers = {}) => Response.json(value, { status, headers });
const build = (patch = {}) => buildSearchRequest({ id: "langsearch", ...provider.searchConfig }, { ...params, ...patch });
const core = (body = {}) => handleSearchCore({
  body: { query: params.query, ...body }, provider, providerConfig: provider.searchConfig,
  credentials: { apiKey: params.token },
});
const request = (model = "langsearch", key = "sk-open") => new Request("http://localhost/v1/search", {
  method: "POST", headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
  body: JSON.stringify({ model, query: params.query, max_results: 5 }),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  vi.stubGlobal("fetch", vi.fn(async () => response()));
  fx.combos = [{ name: "search-combo", kind: "webSearch", models: ["langsearch", "brave-search"] }];
  fx.keys = {
    "sk-open": { access: { restricted: false } },
    "sk-combo": { id: "combo", access: { restricted: true, allow: ["search-combo"] } },
    "sk-denied": { id: "denied", access: { restricted: true, allow: ["brave-search"] } },
  };
  credentials.mockReset().mockImplementation(async (id) => ({ connectionId: `${id}-connection`, apiKey: params.token }));
  markUnavailable.mockReset().mockResolvedValue({ shouldFallback: false });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("LangSearch provider", () => {
  it("appears only in Web Search with API-key auth and no invented monthly quota", () => {
    expect(provider).toMatchObject({ category: "apikey", serviceKinds: ["webSearch"], searchConfig: {
      baseUrl: "https://api.langsearch.com/v1/web-search", authHeader: "bearer", searchTypes: ["web"], maxMaxResults: 50,
    } });
    expect(provider.searchConfig.freeMonthlyQuota).toBeUndefined();
    expect(getProvidersByKind("webSearch").some((entry) => entry.id === "langsearch")).toBe(true);
    expect(getProvidersByKind("webFetch").some((entry) => entry.id === "langsearch")).toBe(false);
    expect(getProvidersByKind("llm").some((entry) => entry.id === "langsearch")).toBe(false);
  });

  it("uses snippets by default and keeps credentials on the fixed endpoint", () => {
    for (const baseUrl of ["https://example.org/collect", "http://169.254.169.254/latest/meta-data"]) {
      const built = build({ providerOptions: { baseUrl }, providerSpecificData: { baseUrl } });
      expect(built.url).toBe(provider.searchConfig.baseUrl);
      expect(built.url).not.toContain(params.token);
      expect(built.init.method).toBe("POST");
      expect(built.init.headers.Authorization).toBe(`Bearer ${params.token}`);
      const body = JSON.parse(built.init.body);
      expect(body).toMatchObject({ query: params.query, count: 5 });
      expect(body.contents?.text ?? false).toBe(false);
    }
  });

  it.each([
    ["any", "noLimit"], ["day", "oneDay"], ["week", "oneWeek"], ["month", "oneMonth"], ["year", "oneYear"],
  ])("maps %s time range to %s", (timeRange, freshness) => {
    expect(JSON.parse(build({ timeRange }).init.body).freshness).toBe(freshness);
  });

  it("maps date ranges, domain filters, and bounded full text", () => {
    const body = JSON.parse(build({
      timeRange: "day", providerOptions: { freshness: "2026-11-01..2026-11-10" },
      domainFilter: ["example.com", "-reddit.com"],
      contentOptions: { full_page: true, max_characters: 3000 },
    }).init.body);
    expect(body).toMatchObject({ freshness: "2026-11-01..2026-11-10", includeDomains: ["example.com"],
      excludeDomains: ["reddit.com"], contents: { text: { maxCharacters: 3000 } } });
    expect(JSON.parse(build({ contentOptions: { full_page: true } }).init.body).contents.text).toBe(true);
  });

  it.each([
    { maxResults: 0 }, { maxResults: -1 }, { maxResults: 1.5 }, { maxResults: "5" }, { maxResults: 51 },
    { searchType: "news" }, { offset: 1 }, { domainFilter: [null] },
    { contentOptions: { full_page: true, max_characters: 0 } },
    { contentOptions: { full_page: true, max_characters: 2147483648 } },
    { providerOptions: { freshness: "2026-02-30" } },
    { providerOptions: { freshness: "2026-11-10..2026-11-01" } },
  ])("rejects unsupported or invalid request parameters: %j", (patch) => {
    expect(() => build(patch)).toThrow();
  });

  it.each([0, -1, 1.5, "5"])("rejects invalid result counts before provider access: %j", async (max_results) => {
    expect(await core({ max_results })).toMatchObject({ success: false, status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("normalizes source snippets, text, dates, and result order", () => {
    const normalized = normalizeSearchResponse("langsearch", { ...payload, data: { webPages: { value: [
      payload.data.webPages.value[0], { name: "Guide", url: `${url}/guide`, text: "Full source text" },
    ] } } }, params.query, "web");
    expect(normalized.results[0]).toMatchObject({ title: "Release", url, snippet: "Latest release", published_at: "2026-11-10",
      position: 1, content: null, citation: { provider: "langsearch", rank: 1 } });
    expect(normalized.results[1]).toMatchObject({ title: "Guide", position: 2, published_at: null,
      content: { format: "text", text: "Full source text", length: 16 } });
  });

  it("returns valid empty results while rejecting a malformed upstream envelope", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ code: 200, data: { webPages: { value: [] } } }));
    const empty = await core();
    expect(empty.success).toBe(true);
    expect((await empty.response.json()).results).toEqual([]);
    vi.mocked(fetch).mockResolvedValueOnce(response({ code: 200, data: {} }));
    expect(await core()).toMatchObject({ success: false, status: 502 });
  });

  it.each([[3, 12], [0, 0]])("reports valid upstream token counters %i/%i without inventing an allowance", async (input_tokens, output_tokens) => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ ...payload, usage: { input_tokens, output_tokens } }));
    const result = await core();
    expect(result.success).toBe(true);
    expect((await result.response.json()).usage).toMatchObject({ queries_used: 1, input_tokens, output_tokens });
    const sent = vi.mocked(fetch).mock.calls[0];
    expect(sent[0]).toBe(provider.searchConfig.baseUrl);
    expect(JSON.parse(sent[1].body)).toMatchObject({ query: params.query, count: 5 });
  });

  it.each([
    [{ input_tokens: -1, output_tokens: Number.MAX_SAFE_INTEGER + 1 }, undefined, undefined],
    [{ input_tokens: 0, output_tokens: -1 }, 0, undefined],
    [{ input_tokens: "3", output_tokens: 12 }, undefined, 12],
  ])("omits invalid token counters while retaining valid fields: %j", async (upstream, input, output) => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ ...payload, usage: upstream }));
    const usage = (await (await core()).response.json()).usage;
    expect(usage.input_tokens).toBe(input);
    expect(usage.output_tokens).toBe(output);
  });

  it.each([401, 429])("preserves HTTP %i failures and quota retry guidance", async (status) => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ code: String(status), message: "Account limit", log_id: "request-fixture" }, status,
      status === 429 ? { "Retry-After": "60" } : {}));
    const result = await core();
    expect(result).toMatchObject({ success: false, status });
    expect(result.response.status).toBe(status);
    expect((await result.response.json()).error.message).toContain("Account limit");
    if (status === 429) expect(result.response.headers.get("retry-after")).toBe("60");
  });

  it("converts an HTTP-date Retry-After into the precise reset time", async () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    const reset = now + 7200000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.mocked(fetch).mockResolvedValueOnce(response({ message: "Daily tokens exhausted" }, 429,
      { "Retry-After": new Date(reset).toUTCString() }));
    const result = await core();
    expect(result).toMatchObject({ success: false, status: 429, resetsAtMs: reset });
    expect(result.response.headers.get("retry-after")).toBe("7200");
    expect((await result.response.json()).retryAfter).toBe(new Date(reset).toISOString());
  });

  it("passes a quota reset beyond 30 minutes to the account cooldown", async () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.mocked(fetch).mockResolvedValueOnce(response({ message: "Daily tokens exhausted" }, 429, { "Retry-After": "7200" }));
    const result = await handleSearch(request());
    expect(result.status).toBe(429);
    expect(result.headers.get("retry-after")).toBe("7200");
    expect(markUnavailable).toHaveBeenCalledWith("langsearch-connection", 429,
      expect.stringContaining("Daily tokens exhausted"), "langsearch", "websearch:langsearch", now + 7200000);
  });

  it("refuses a redirect before forwarding the Bearer key to another host", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, {
      status: 302, headers: { Location: "https://example.org/collect" },
    }));
    expect(await core()).toMatchObject({ success: false, status: 502 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(provider.searchConfig.baseUrl);
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ redirect: "manual",
      headers: { Authorization: `Bearer ${params.token}` } });
  });

  it("retains quota retry guidance when account and combo fallbacks are exhausted", async () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    const reset = new Date(now + 7200000).toISOString();
    vi.spyOn(Date, "now").mockReturnValue(now);
    fx.combos[0].models = ["langsearch"];
    markUnavailable.mockResolvedValueOnce({ shouldFallback: true });
    credentials
      .mockResolvedValueOnce({ connectionId: "langsearch-connection", apiKey: params.token })
      .mockResolvedValueOnce({ allRateLimited: true, retryAfter: reset, retryAfterHuman: "2h" });
    vi.mocked(fetch).mockResolvedValueOnce(response({ message: "Daily tokens exhausted" }, 429, { "Retry-After": "7200" }));
    const result = await handleSearch(request("search-combo", "sk-combo"));
    expect(result.status).toBe(429);
    expect(result.headers.get("retry-after")).toBe("7200");
    expect((await result.json()).error.message).toContain("Daily tokens exhausted");
    expect(credentials).toHaveBeenCalledTimes(2);
    expect(credentials.mock.calls[1][1]).toContain("langsearch-connection");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("checks router key access before touching LangSearch credentials", async () => {
    expect((await handleSearch(request("langsearch", "sk-denied"))).status).toBe(403);
    expect((await handleSearch(request("langsearch", null))).status).toBe(401);
    expect(credentials).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows a restricted combo to fall back after LangSearch quota exhaustion", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ code: "429", message: "Daily tokens exhausted" }, 429, { "Retry-After": "60" }))
      .mockResolvedValueOnce(response({ web: { results: [{ title: "Fallback", url, description: "Release notes" }] } }));
    const result = await handleSearch(request("search-combo", "sk-combo"));
    expect(result.status).toBe(200);
    expect((await result.json()).provider).toBe("brave-search");
    expect(credentials.mock.calls.map(([id]) => id)).toEqual(["langsearch", "brave-search"]);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.clearAllMocks();
    expect((await handleSearch(request("langsearch", "sk-combo"))).status).toBe(403);
    expect(credentials).not.toHaveBeenCalled();
  });
});
