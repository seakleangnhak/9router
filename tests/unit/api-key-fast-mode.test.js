import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { chatCore } = vi.hoisted(() => ({ chatCore: vi.fn() }));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: chatCore }));
vi.mock("../../src/sse/services/auth.js", async (importOriginal) => ({
  ...await importOriginal(),
  getProviderCredentials: async () => ({ connectionId: "fixture", accessToken: "fixture" }),
  clearAccountError: async () => {},
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials,
  updateProviderCredentials: async () => {},
}));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: async () => "fixture" }));

const originalDataDir = process.env.DATA_DIR;
let tempDir, db, handleChat, createKey, updateKey, allowed, denied;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-fast-permission-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  ({ handleChat } = await import("../../src/sse/handlers/chat.js"));
  ({ POST: createKey } = await import("../../src/app/api/keys/route.js"));
  ({ PUT: updateKey } = await import("../../src/app/api/keys/[id]/route.js"));
  allowed = await db.createApiKey("allowed", "fixture", true);
  denied = await db.createApiKey("denied", "fixture");
  await db.createCombo({ name: "fast-combo", models: ["cx/gpt-6.1-sol"] });
  await db.setModelAlias("fast-alias", "cx/gpt-6.1-sol");
});

afterAll(() => {
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(async () => {
  vi.clearAllMocks();
  chatCore.mockResolvedValue({ success: true, response: new Response("OK") });
  await db.updateSettings({ requireApiKey: true });
});

function request(body, key, endpoint = "/v1/responses") {
  return new Request(`http://localhost${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
}

describe("API key Fast mode policy", () => {
  it("defaults off and preserves permission through update/export/import", async () => {
    expect(denied.allowFastMode).toBe(false);
    expect(await db.canUseFastMode(denied.key)).toBe(false);
    await db.updateApiKey(denied.id, { allowFastMode: true });
    expect(await db.canUseFastMode(denied.key)).toBe(true);
    const snapshot = await db.exportDb();
    await db.updateApiKey(denied.id, { allowFastMode: false });
    await db.importDb(snapshot);
    expect(await db.canUseFastMode(denied.key)).toBe(true);
    await db.updateApiKey(denied.id, { allowFastMode: false });
    expect((await db.getApiKeyById(denied.id)).allowFastMode).toBe(false);
  });

  it("creates and updates permissions through the management API", async () => {
    const created = await createKey(request({ name: "API-created", allowFastMode: true }));
    expect(created.status).toBe(201);
    const key = await created.json();
    expect(key.allowFastMode).toBe(true);
    expect(await db.canUseFastMode(key.key)).toBe(true);
    const updated = await updateKey(request({ allowFastMode: false }), { params: Promise.resolve({ id: key.id }) });
    expect(updated.status).toBe(200);
    expect((await updated.json()).key.allowFastMode).toBe(false);
    expect(await db.canUseFastMode(key.key)).toBe(false);
  });

  it.each(["true", 1, null])("rejects non-boolean permission %s without changing the key", async (value) => {
    expect((await createKey(request({ name: "invalid", allowFastMode: value }))).status).toBe(400);
    expect((await updateKey(request({ allowFastMode: value }), { params: Promise.resolve({ id: denied.id }) })).status).toBe(400);
    expect(await db.canUseFastMode(denied.key)).toBe(false);
  });

  it.each([
    ["/v1/responses", "priority", "cx/gpt-6.1-sol"],
    ["/v1/chat/completions", "fast", "cx/gpt-6.1-sol"],
    ["/v1/responses", "fast", "fast-combo"],
    ["/v1/responses", "priority", "fast-alias"],
  ])("forces normal tier for OFF key on %s tier %s model %s", async (endpoint, tier, model) => {
    const response = await handleChat(request({ model, input: "hello", service_tier: tier }, denied.key, endpoint));
    expect(response.status).toBe(200);
    expect(chatCore.mock.calls[0][0].body.service_tier).toBe("default");
  });

  it.each(["priority", "fast"])("forwards tier %s and reasoning for an approved key", async (tier) => {
    const response = await handleChat(request({
      model: "cx/gpt-6.1-sol", input: "hello", service_tier: tier, reasoning: { effort: "high" },
    }, allowed.key));
    expect(response.status).toBe(200);
    expect(chatCore.mock.calls[0][0].body).toMatchObject({ service_tier: tier, reasoning: { effort: "high" } });
  });

  it.each([undefined, "default"])("allows Standard tier %s for an unapproved key", async (tier) => {
    const response = await handleChat(request({ model: "cx/gpt-6.1-sol", input: "hello", service_tier: tier }, denied.key));
    expect(response.status).toBe(200);
    expect(chatCore).toHaveBeenCalledOnce();
  });

  it.each([undefined, "unknown", "inactive"])("forces normal tier for %s key in local mode", async (keyKind) => {
    await db.updateSettings({ requireApiKey: false });
    let key = keyKind;
    if (keyKind === "inactive") {
      const inactive = await db.createApiKey("inactive", "fixture", true);
      await db.updateApiKey(inactive.id, { isActive: false });
      key = inactive.key;
    }
    const response = await handleChat(request({ model: "cx/gpt-6.1-sol", input: "hello", service_tier: "priority" }, key));
    expect(response.status).toBe(200);
    expect(chatCore.mock.calls[0][0].body.service_tier).toBe("default");
  });

  it.each(["off", "on", "force"])("persists %s through API updates and export/import", async (fastMode) => {
    const created = await createKey(request({ name: `Mode ${fastMode}`, fastMode }));
    expect(created.status).toBe(201);
    const key = await created.json();
    expect(key.fastMode).toBe(fastMode);
    const updated = await updateKey(request({ fastMode }), { params: Promise.resolve({ id: key.id }) });
    expect(updated.status).toBe(200);
    expect((await updated.json()).key.fastMode).toBe(fastMode);
    const snapshot = await db.exportDb();
    await updateKey(request({ fastMode: "off" }), { params: Promise.resolve({ id: key.id }) });
    await db.importDb(snapshot);
    expect(await db.getApiKeyFastMode(key.key)).toBe(fastMode);
    await db.updateApiKey(key.id, { isActive: false });
    expect(await db.getApiKeyFastMode(key.key)).toBe("off");
    expect((await db.getApiKeyById(key.id)).fastMode).toBe(fastMode);
  });

  it.each(["invalid", "FORCE", true, 2, null, {}, []])("rejects invalid mode %j without changing the key", async (fastMode) => {
    expect((await createKey(request({ name: "invalid", fastMode }))).status).toBe(400);
    expect((await updateKey(request({ fastMode }), { params: Promise.resolve({ id: denied.id }) })).status).toBe(400);
    expect(await db.getApiKeyFastMode(denied.key)).toBe("off");
  });

  it.each(["off", "on", "force"].flatMap(mode =>
    [undefined, "default", "priority", "fast"].flatMap(tier =>
      ["/v1/responses", "/v1/chat/completions"].map(endpoint => [mode, tier, endpoint])
    )
  ))("applies %s to client tier %s on %s, preserving reasoning", async (fastMode, tier, endpoint) => {
    const key = await db.createApiKey("policy", "fixture", false, fastMode);
    const response = await handleChat(request({
      model: "cx/gpt-6.1-sol", input: "hello", service_tier: tier, reasoning: { effort: "high" },
    }, key.key, endpoint));
    expect(response.status).toBe(200);
    expect(chatCore.mock.calls[0][0].body.service_tier).toBe(fastMode === "off" ? "default" : fastMode === "force" ? "priority" : tier);
    expect(chatCore.mock.calls[0][0].body.reasoning).toEqual({ effort: "high" });
  });

  it.each(["fast-alias", "fast-combo"])("forces priority for normal requests to %s", async (model) => {
    const key = await db.createApiKey("forced", "fixture", false, "force");
    expect((await handleChat(request({ model, input: "hello", service_tier: "default" }, key.key))).status).toBe(200);
    expect(chatCore.mock.calls[0][0].body.service_tier).toBe("priority");
  });

  it.each([undefined, "unknown", "inactive"])("keeps authentication enforced for %s key", async (kind) => {
    let key = kind;
    if (kind === "inactive") {
      const inactive = await db.createApiKey("inactive", "fixture", false, "force");
      await db.updateApiKey(inactive.id, { isActive: false });
      key = inactive.key;
    }
    expect((await handleChat(request({ model: "cx/gpt-6.1-sol", input: "hello" }, key))).status).toBe(401);
    expect(chatCore).not.toHaveBeenCalled();
  });

  it("takes revocation into account on the next request", async () => {
    const body = { model: "cx/gpt-6.1-sol", input: "hello", service_tier: "priority" };
    await db.updateApiKey(denied.id, { allowFastMode: true });
    expect((await handleChat(request(body, denied.key))).status).toBe(200);
    await db.updateApiKey(denied.id, { allowFastMode: false });
    chatCore.mockClear();
    expect((await handleChat(request(body, denied.key))).status).toBe(200);
    expect(chatCore.mock.calls[0][0].body.service_tier).toBe("default");
  });
});


describe("Combo reasoning ceiling with API key policies", () => {
  it("saves, exports, imports, and clears a ceiling through the management API", async () => {
    const { POST } = await import("../../src/app/api/combos/route.js");
    const { PUT } = await import("../../src/app/api/combos/[id]/route.js");
    const response = await POST(request({ name: "limited", models: ["cx/gpt-6.1-sol"], maxReasoningEffort: "high" }));
    expect(response.status).toBe(201);
    const combo = await response.json();
    expect(combo.maxReasoningEffort).toBe("high");
    const snapshot = await db.exportDb();
    await db.updateCombo(combo.id, { maxReasoningEffort: "low" });
    await db.importDb(snapshot);
    expect((await db.getComboById(combo.id)).maxReasoningEffort).toBe("high");
    for (const invalidLimit of ["invalid", "", 0, false]) {
      const invalid = { ...snapshot, combos: [{ ...combo, maxReasoningEffort: invalidLimit }] };
      await expect(db.importDb(invalid)).rejects.toThrow();
      expect((await db.getComboById(combo.id)).maxReasoningEffort).toBe("high");
    }
    const cleared = await PUT(request({ maxReasoningEffort: null }), { params: Promise.resolve({ id: combo.id }) });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).maxReasoningEffort).toBeNull();
  });

  it.each(["invalid", "HIGH", "", 5, true, {}])("rejects invalid ceiling %j", async (maxReasoningEffort) => {
    const { POST } = await import("../../src/app/api/combos/route.js");
    const { PUT } = await import("../../src/app/api/combos/[id]/route.js");
    const combo = await db.createCombo({ name: `invalid-limit-${typeof maxReasoningEffort}-${String(maxReasoningEffort)}`, models: [] });
    expect((await POST(request({ name: "invalid-limit", maxReasoningEffort }))).status).toBe(400);
    expect((await PUT(request({ maxReasoningEffort }), { params: Promise.resolve({ id: combo.id }) })).status).toBe(400);
    expect((await db.getComboById(combo.id)).maxReasoningEffort).toBeNull();
  });

  it.each(["fallback", "round-robin", "fusion"])("carries ceiling to every %s panel and judge request", async (strategy) => {
    const name = `limit-${strategy}`;
    await db.createCombo({ name, models: ["cx/gpt-6.1-sol", "cx/gpt-6-sol"], maxReasoningEffort: "high" });
    await db.updateSettings({ comboStrategies: { [name]: { fallbackStrategy: strategy } } });
    chatCore.mockImplementation(async () => ({ success: true, response: Response.json({ choices: [{ message: { content: "Answer" } }] }) }));
    expect((await handleChat(request({ model: name, input: "hello", reasoning: { effort: "ultra" } }, allowed.key))).status).toBe(200);
    expect(chatCore).toHaveBeenCalled();
    for (const [options] of chatCore.mock.calls) expect(options.maxReasoningEffort).toBe("high");
    if (strategy === "fusion") expect(chatCore.mock.calls.length).toBe(3);
  });

  it.each([["high", "medium", "medium"], ["low", "high", "low"], ["high", null, "high"]])("keeps stricter nested ceiling %s / %s", async (outerLimit, innerLimit, expected) => {
    const inner = await db.createCombo({ name: `inner-${outerLimit}-${innerLimit}`, models: ["cx/gpt-6.1-sol"], maxReasoningEffort: innerLimit });
    const outer = await db.createCombo({ name: `outer-${outerLimit}-${innerLimit}`, models: [inner.name], maxReasoningEffort: outerLimit });
    expect((await handleChat(request({ model: outer.name, input: "hello" }, allowed.key))).status).toBe(200);
    expect(chatCore.mock.calls[0][0].maxReasoningEffort).toBe(expected);
  });

  it("preserves old combos without a ceiling and direct model requests", async () => {
    const combo = await db.createCombo({ name: "no-limit", models: ["cx/gpt-6.1-sol"] });
    expect(combo.maxReasoningEffort).toBeNull();
    for (const model of [combo.name, "cx/gpt-6.1-sol"]) {
      await handleChat(request({ model, input: "hello", reasoning: { effort: "ultra" } }, allowed.key));
      expect(chatCore.mock.calls.at(-1)[0].maxReasoningEffort).toBeNull();
    }
  });
});
