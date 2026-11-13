import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: vi.fn() }));
vi.mock("@/models", () => ({ getProxyPoolById: vi.fn() }));

const { getApiKeyByKey } = await import("@/lib/db/repos/apiKeysRepo.js");
const { getProxyPoolById } = await import("@/models");
const { getKeyProxyContext } = await import("@/sse/services/keyProxy.js");

function request(headers = {}, query = "") {
  return new Request(`http://localhost/v1/chat/completions${query}`, { headers });
}

beforeEach(() => {
  vi.resetAllMocks();
  getApiKeyByKey.mockResolvedValue({ isActive: true, proxyPoolId: "pool-a" });
  getProxyPoolById.mockResolvedValue({
    id: "pool-a", isActive: true, proxyUrl: "http://user:pass@proxy.example:8080", noProxy: "*", strictProxy: false,
  });
});

describe("API key proxy routing context", () => {
  it("inherits for no key, unknown/inactive keys, and existing unassigned keys", async () => {
    expect(await getKeyProxyContext(request())).toEqual({});
    for (const key of [null, { isActive: false, proxyPoolId: "pool-a" }, { isActive: true }, { isActive: true, proxyPoolId: null }]) {
      getApiKeyByKey.mockResolvedValueOnce(key);
      expect(await getKeyProxyContext(request({ Authorization: "Bearer test-key" }))).toEqual({});
    }
    expect(getProxyPoolById).not.toHaveBeenCalled();
  });

  it.each([
    [{ Authorization: "Bearer test-key" }, ""],
    [{ "x-api-key": "test-key" }, ""],
    [{ "x-goog-api-key": "test-key" }, ""],
    [{}, "?key=test-key"],
  ])("uses all authenticated key locations", async (headers, query) => {
    const { requestProxyOptions } = await getKeyProxyContext(request(headers, query));
    expect(getApiKeyByKey).toHaveBeenCalledWith("test-key");
    expect(requestProxyOptions).toEqual({
      keyProxy: true, proxyPoolId: "pool-a", connectionProxyEnabled: true,
      connectionProxyUrl: "http://user:pass@proxy.example:8080/",
      connectionNoProxy: "", vercelRelayUrl: "", strictProxy: true,
    });
  });

  it("uses one snapshot for combo/account retries, without mutating pool settings", async () => {
    const req = request({ Authorization: "Bearer test-key" });
    const [a, b] = await Promise.all([getKeyProxyContext(req), getKeyProxyContext(req)]);
    expect(a).toBe(b);
    expect(getProxyPoolById).toHaveBeenCalledTimes(1);
    expect((await getProxyPoolById.mock.results[0].value).noProxy).toBe("*");
    expect((await getProxyPoolById.mock.results[0].value).strictProxy).toBe(false);
  });

  it.each(["vercel", "cloudflare", "deno", "netlify"])("routes saved %s relays with strict isolation", async (type) => {
    getProxyPoolById.mockResolvedValue({ id: "pool-a", type, isActive: true, proxyUrl: "https://relay.example/proxy" });
    const { requestProxyOptions } = await getKeyProxyContext(request({ "x-api-key": "test-key" }));
    expect(requestProxyOptions.vercelRelayUrl).toBe("https://relay.example/proxy");
    expect(requestProxyOptions.connectionProxyEnabled).toBe(false);
    expect(requestProxyOptions.strictProxy).toBe(true);
  });

  it.each([
    null,
    { isActive: false, proxyUrl: "http://proxy.example:8080" },
    { isActive: true, proxyUrl: "" },
    { isActive: true, proxyUrl: "http://[invalid" },
    { isActive: true, proxyUrl: "file:///secret" },
  ])("blocks unavailable or invalid saved pools without exposing credentials", async (pool) => {
    getProxyPoolById.mockResolvedValue(pool);
    const ctx = await getKeyProxyContext(request({ "x-api-key": "test-key" }));
    expect(ctx.requestProxyOptions).toBeUndefined();
    expect(ctx.error.status).toBe(503);
    expect(await ctx.error.text()).not.toMatch(/user:pass|test-key|proxy\.example/);
  });

  it("accepts existing host:port pools", async () => {
    getProxyPoolById.mockResolvedValue({ id: "pool-a", isActive: true, proxyUrl: "127.0.0.1:7890" });
    const { requestProxyOptions } = await getKeyProxyContext(request({ "x-api-key": "test-key" }));
    expect(requestProxyOptions.connectionProxyUrl).toBe("http://127.0.0.1:7890/");
  });
});
