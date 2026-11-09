import { beforeEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({ settings: {}, combos: [], keys: {} }));
const mocks = vi.hoisted(() => ({ core: vi.fn(), credentials: vi.fn() }));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => fx.settings,
  getComboByName: async (name) => fx.combos.find((combo) => combo.name === name) || null,
  getModelAliases: async () => ({}),
  getProviderNodes: async () => [],
}));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => fx.combos }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async (key) => fx.keys[key] }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn(async () => {}) }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.credentials,
  markAccountUnavailable: async () => ({ shouldFallback: false }),
  clearAccountError: vi.fn(),
  extractApiKey: (request) => request.headers.get("authorization")?.slice(7) || null,
  isValidApiKey: async (key) => Boolean(fx.keys[key]),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/imageGenerationCore.js", () => ({ handleImageGenerationCore: mocks.core }));
vi.mock("open-sse/handlers/imageProviders/index.js", () => ({ getImageAdapter: () => null }));
vi.mock("@/sse/utils/logger.js", () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }));

const { handleImageGeneration } = await import("../../src/sse/handlers/imageGeneration.js");
const { resetComboRotation } = await import("../../open-sse/services/combo.js");

const members = ["openai/dall-e-3", "gemini/imagen-4.0-generate-001"];
const image = { created: 1, data: [{ b64_json: "aW1hZ2U=" }] };
const body = { model: "image-combo", prompt: "A red cube", n: 2, size: "1024x1024", quality: "high", output_format: "webp", response_format: "b64_json" };
const request = (data = body, key = "sk-open", suffix = "", headers = {}) => new Request(`http://localhost/v1/images/generations${suffix}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers },
  body: JSON.stringify(data),
});
const failure = () => ({
  success: false, status: 429, error: "Image quota exhausted",
  response: Response.json({ error: { message: "Image quota exhausted" } }, { status: 429 }),
});

beforeEach(() => {
  vi.clearAllMocks();
  resetComboRotation("image-combo");
  fx.settings = { requireApiKey: true, comboStrategy: "fallback" };
  fx.combos = [{ id: "image-id", name: "image-combo", kind: "image", models: [...members] }];
  fx.keys = {
    "sk-open": { access: { restricted: false } },
    "sk-combo": { id: "combo-key", name: "combo", access: { restricted: true, allow: ["image-combo"] } },
    "sk-model": { id: "model-key", name: "model", access: { restricted: true, allow: [members[0]] } },
  };
  mocks.credentials.mockImplementation(async (provider) => ({ connectionId: `${provider}-connection`, apiKey: "provider-fixture" }));
  mocks.core.mockImplementation(async () => ({ success: true, response: Response.json(image) }));
});

describe("image combo routing", () => {
  it("falls back across providers with original image parameters when the key permits the combo", async () => {
    mocks.core.mockResolvedValueOnce(failure());
    const response = await handleImageGeneration(request(body, "sk-combo"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(image);
    expect(mocks.core.mock.calls.map(([options]) => options.modelInfo)).toEqual([
      { provider: "openai", model: "dall-e-3" },
      { provider: "gemini", model: "imagen-4.0-generate-001" },
    ]);
    for (const [options] of mocks.core.mock.calls) expect(options.body).toEqual(body);
  });

  it("rotates successful members across round-robin requests", async () => {
    fx.settings.comboStrategies = { "image-combo": { fallbackStrategy: "round-robin" } };
    await handleImageGeneration(request());
    await handleImageGeneration(request());

    expect(mocks.core.mock.calls.map(([options]) => options.modelInfo.provider)).toEqual(["openai", "gemini"]);
  });

  it("returns binary image bytes and headers unchanged", async () => {
    const binary = new Response(new Uint8Array([0, 1, 128, 255]), { headers: { "Content-Type": "image/webp" } });
    mocks.core.mockResolvedValueOnce({ success: true, response: binary });
    const response = await handleImageGeneration(request(body, "sk-open", "?response_format=binary"));

    expect(response).toBe(binary);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 1, 128, 255]));
    expect(mocks.core.mock.calls[0][0].binaryOutput).toBe(true);
    expect(mocks.core).toHaveBeenCalledOnce();
  });

  it.each([
    `event: done\ndata: ${JSON.stringify(image)}\n\n`,
    `event: progress\ndata: {"status":"generating"}\n\nevent: partial_image\ndata: {"b64_json":"aW1hZ2U=","index":0}\n\nevent: done\ndata: ${JSON.stringify(image)}\n\n`,
  ])("returns the first image SSE stream unchanged without generating another image", async (events) => {
    fx.combos[0].models = ["codex/gpt-image-2.6-flare", members[0]];
    const stream = new Response(events, { headers: { "Content-Type": "text/event-stream" } });
    mocks.core.mockResolvedValueOnce({ success: true, response: stream });
    const response = await handleImageGeneration(request(body, "sk-open", "", { Accept: "text/event-stream" }));

    expect(response).toBe(stream);
    expect(await response.text()).toBe(events);
    expect(mocks.core.mock.calls[0][0].streamToClient).toBe(true);
    expect(mocks.core).toHaveBeenCalledOnce();
  });

  it("returns a failure when every image model has exhausted quota", async () => {
    mocks.core.mockImplementation(async () => failure());
    const response = await handleImageGeneration(request());

    expect(response.status).toBe(429);
    expect((await response.json()).error.message).toContain("Image quota exhausted");
    expect(mocks.core).toHaveBeenCalledTimes(2);
  });

  it("rejects an unlisted combo before credentials even when its member is allowed", async () => {
    const response = await handleImageGeneration(request(body, "sk-model"));

    expect(response.status).toBe(403);
    expect(mocks.credentials).not.toHaveBeenCalled();
    expect(mocks.core).not.toHaveBeenCalled();
  });

  it("keeps direct image model requests unchanged", async () => {
    const direct = { ...body, model: members[0] };
    const success = Response.json(image);
    mocks.core.mockResolvedValueOnce({ success: true, response: success });

    expect(await handleImageGeneration(request(direct))).toBe(success);
    expect(mocks.core.mock.calls[0][0]).toMatchObject({ body: direct, modelInfo: { provider: "openai", model: "dall-e-3" } });
    expect(mocks.core).toHaveBeenCalledOnce();
  });

  it("requires an API key before resolving provider credentials", async () => {
    const response = await handleImageGeneration(request(body, null));

    expect(response.status).toBe(401);
    expect(mocks.credentials).not.toHaveBeenCalled();
    expect(mocks.core).not.toHaveBeenCalled();
  });
});
