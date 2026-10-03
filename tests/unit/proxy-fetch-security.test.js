import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({
  fetch: vi.fn(),
  Agent: vi.fn(function (options) { this.options = options; }),
  ProxyAgent: vi.fn(function (options) { this.options = options; }),
  resolve4: vi.fn((hostname, callback) => callback(null, ["203.0.113.1"])),
  Socket: vi.fn(function () { throw new Error("Direct socket forbidden in test"); }),
}));

vi.mock("undici", () => ({ Agent: network.Agent, ProxyAgent: network.ProxyAgent }));
vi.mock("dns", () => ({
  Resolver: class {
    setServers() {}
    resolve4(...args) { return network.resolve4(...args); }
  },
}));
vi.mock("net", () => ({ Socket: network.Socket }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  network.fetch.mockReset();
  vi.stubGlobal("fetch", network.fetch);
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "STRICT_SSL"]) {
    vi.stubEnv(name, undefined);
  }
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("proxy fetch preserves TLS verification", () => {
  it.each(["SELF_SIGNED_CERT_IN_CHAIN", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"])("rejects %s by default", async (code) => {
    const error = new TypeError("fetch failed", { cause: { code } });
    network.fetch.mockRejectedValueOnce(error).mockResolvedValueOnce(new Response("unsafe"));
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    await expect(proxyAwareFetch("https://api.example.com/v1/chat", { headers: { Authorization: "Bearer test-key" } })).rejects.toBe(error);
    expect(network.fetch).toHaveBeenCalledTimes(1);
    expect(network.Agent).not.toHaveBeenCalled();
  });

  it.each(["true", "1", "unexpected"])("keeps verification with STRICT_SSL=%s", async (value) => {
    vi.stubEnv("STRICT_SSL", value);
    const error = new TypeError("fetch failed", { cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } });
    network.fetch.mockRejectedValueOnce(error).mockResolvedValueOnce(new Response("unsafe"));
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    await expect(proxyAwareFetch("https://api.example.com/v1/chat")).rejects.toBe(error);
    expect(network.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["false", "0"])("allows explicit opt-in with STRICT_SSL=%s", async (value) => {
    vi.stubEnv("STRICT_SSL", value);
    const response = new Response("ok");
    network.fetch.mockRejectedValueOnce(new TypeError("fetch failed", { cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } })).mockResolvedValueOnce(response);
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    await expect(proxyAwareFetch("https://api.example.com/v1/chat")).resolves.toBe(response);
    expect(network.fetch).toHaveBeenCalledTimes(2);
    expect(network.Agent).toHaveBeenCalledWith({ connect: { rejectUnauthorized: false } });
  });

  it("keeps an insecure opt-in retry on the configured strict proxy", async () => {
    vi.stubEnv("STRICT_SSL", "false");
    const response = new Response("ok");
    network.fetch.mockRejectedValueOnce(new TypeError("fetch failed", { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } })).mockResolvedValueOnce(response);
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const proxyUrl = "http://proxy.example.com:8080";

    await expect(proxyAwareFetch("https://api.example.com/v1/chat", {}, { enabled: true, url: proxyUrl, strictProxy: true })).resolves.toBe(response);
    expect(network.ProxyAgent).toHaveBeenLastCalledWith({ uri: proxyUrl, requestTls: { rejectUnauthorized: false } });
    expect(network.Agent).not.toHaveBeenCalled();
  });
});

describe("strict proxy blocks DNS bypass without a resolved proxy", () => {
  it.each(["cloudcode-pa.googleapis.com", "api.individual.githubcopilot.com", "api2.cursor.sh"])("refuses direct access to %s before DNS or sockets", async (hostname) => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    await expect(proxyAwareFetch(`https://${hostname}/v1/chat`, {}, { proxyPoolId: "inactive-pool", strictProxy: true })).rejects.toThrow(/Proxy required but none resolved/);
    expect(network.resolve4).not.toHaveBeenCalled();
    expect(network.Socket).not.toHaveBeenCalled();
    expect(network.fetch).not.toHaveBeenCalled();
  });
});
