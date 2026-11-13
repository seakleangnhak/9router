import { beforeEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({ keys: {}, pools: {}, combos: [], requireApiKey: false }));
const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  handleChatCore: vi.fn(),
  getProxyPoolById: vi.fn(),
  markAccountUnavailable: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: fx.requireApiKey, comboStrategy: "fallback" }),
  getApiKeyFastMode: async () => "off",
  getModelAliases: async () => ({}),
  getComboByName: async (name) => fx.combos.find(combo => combo.name === name) || null,
  getProviderNodes: async () => [],
  getCombos: async () => fx.combos,
  getProviderConnections: async () => [],
}));
vi.mock("@/models", () => ({ getProxyPoolById: mocks.getProxyPoolById }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async (key) => fx.keys[key] || null }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => fx.combos }));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: vi.fn(),
  extractApiKey: (request) => request.headers.get("Authorization")?.slice(7),
  isValidApiKey: async (key) => fx.keys[key]?.isActive === true,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

const success = (pool = "inherited") => ({
  success: true,
  response: Response.json({ choices: [{ message: { content: pool } }] }),
});
const chat = (model, key, extra = {}) => handleChat(new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }], ...extra }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  fx.requireApiKey = false;
  fx.keys = {
    "sk-a": { id: "key-a", isActive: true, proxyPoolId: "pool-a" },
    "sk-b": { id: "key-b", isActive: true, proxyPoolId: "pool-b" },
    "sk-inherit": { id: "key-inherit", isActive: true, proxyPoolId: null },
    "sk-inactive": { id: "key-inactive", isActive: false, proxyPoolId: "pool-a" },
  };
  fx.pools = Object.fromEntries(["a", "b"].map(name => [`pool-${name}`, {
    id: `pool-${name}`, isActive: true, proxyUrl: `http://proxy-${name}.invalid:8000`,
    noProxy: "*", strictProxy: false, type: "http",
  }]));
  fx.combos = [
    { name: "Main", models: ["openai/model-a", "openai/model-b"] },
    { name: "Outer", models: ["Main"] },
  ];
  mocks.getProxyPoolById.mockImplementation(async id => fx.pools[id] || null);
  mocks.getProviderCredentials.mockImplementation(async (_provider, _excluded, _model, options) => ({
    connectionId: "account", connectionName: "fixture", requestProxyOptions: options?.requestProxyOptions,
  }));
  mocks.handleChatCore.mockImplementation(async ({ credentials }) => success(credentials.requestProxyOptions?.proxyPoolId));
  mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
});

describe("API key proxy request routing", () => {
  it("isolates two keys' pools during concurrent requests and never inherits noProxy", async () => {
    const responses = await Promise.all([chat("openai/model-b", "sk-a"), chat("openai/model-b", "sk-b")]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(await Promise.all(responses.map(async response => (await response.json()).choices[0].message.content)))
      .toEqual(["pool-a", "pool-b"]);
    const options = mocks.handleChatCore.mock.calls.map(([args]) => args.credentials.requestProxyOptions);
    expect(options.map(option => new URL(option.connectionProxyUrl).host).sort())
      .toEqual(["proxy-a.invalid:8000", "proxy-b.invalid:8000"]);
    for (const option of options) expect(option).toMatchObject({ strictProxy: true, connectionNoProxy: "" });
    expect(options[0]).not.toBe(options[1]);
  });

  it.each(["Main", "Outer"])("keeps one pool through account and nested combo fallback for %s", async (model) => {
    mocks.getProviderCredentials.mockImplementation(async (_provider, excluded, name, options) => {
      if (name === "model-a" && excluded.size === 2) return null;
      return {
        connectionId: `${name}-${excluded.size}`, connectionName: "fixture",
        requestProxyOptions: options.requestProxyOptions,
      };
    });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    mocks.handleChatCore.mockImplementation(async ({ modelInfo, credentials }) => modelInfo.model === "model-a" ? {
      success: false, status: 500, error: "fixture upstream error",
      response: Response.json({ error: { message: "fixture upstream error" } }, { status: 500 }),
    } : success(credentials.requestProxyOptions.proxyPoolId));

    const response = await chat(model, "sk-a");
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe("pool-a");
    expect(mocks.handleChatCore.mock.calls.map(([args]) => args.modelInfo.model)).toEqual(["model-a", "model-a", "model-b"]);
    const options = mocks.getProviderCredentials.mock.calls.map((args) => args[3].requestProxyOptions);
    expect(options).toHaveLength(4);
    for (const option of options) expect(option).toBe(options[0]);
    expect(mocks.getProxyPoolById).toHaveBeenCalledExactlyOnceWith("pool-a");
  });

  it.each([undefined, "unknown", "sk-inherit", "sk-inactive"])("inherits existing routing for %s in local mode", async (key) => {
    const response = await chat("openai/model-b", key, { proxyPoolId: "pool-b", proxyUrl: "http://attacker.invalid" });
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe("inherited");
    expect(mocks.getProviderCredentials.mock.calls[0][3].requestProxyOptions).toBeUndefined();
    expect(mocks.getProxyPoolById).not.toHaveBeenCalled();
  });

  it.each(["missing", "inactive", "empty"])("blocks a %s assigned pool before any credential lookup", async (state) => {
    if (state === "missing") delete fx.pools["pool-a"];
    if (state === "inactive") fx.pools["pool-a"].isActive = false;
    if (state === "empty") fx.pools["pool-a"].proxyUrl = "";
    const response = await chat("Main", "sk-a");
    expect(response.status).toBe(503);
    expect((await response.json()).error.message).toBe("API key proxy pool is unavailable");
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("leaves a shared account available after another key's proxy fails", async () => {
    mocks.handleChatCore.mockImplementation(async ({ credentials }) => credentials.requestProxyOptions.proxyPoolId === "pool-a" ? {
      success: false, status: 502, keyProxyError: true, error: "API key proxy failed",
      response: Response.json({ error: { message: "API key proxy failed" } }, { status: 502 }),
    } : success(credentials.requestProxyOptions.proxyPoolId));

    expect((await chat("openai/model-b", "sk-a")).status).toBe(502);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    const response = await chat("openai/model-b", "sk-b");
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe("pool-b");
    expect(mocks.handleChatCore.mock.calls.map(([args]) => args.connectionId)).toEqual(["account", "account"]);
  });

  it("still applies account fallback for a genuine upstream quota error", async () => {
    mocks.getProviderCredentials.mockImplementation(async (_provider, excluded, _model, options) => ({
      connectionId: `account-${excluded.size}`, connectionName: "fixture", requestProxyOptions: options.requestProxyOptions,
    }));
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    mocks.handleChatCore.mockResolvedValueOnce({
      success: false, status: 429, error: "quota exceeded",
      response: Response.json({ error: { message: "quota exceeded" } }, { status: 429 }),
    });

    expect((await chat("openai/model-b", "sk-a")).status).toBe(200);
    expect(mocks.markAccountUnavailable).toHaveBeenCalledExactlyOnceWith("account-0", 429, "quota exceeded", "openai", "model-b", undefined);
    expect(mocks.handleChatCore.mock.calls.map(([args]) => args.connectionId)).toEqual(["account-0", "account-1"]);
  });

  it("keeps authentication ahead of proxy resolution when keys are required", async () => {
    fx.requireApiKey = true;
    for (const key of [undefined, "unknown", "sk-inactive"]) {
      expect((await chat("openai/model-b", key)).status).toBe(401);
    }
    expect(mocks.getProxyPoolById).not.toHaveBeenCalled();
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });
});
