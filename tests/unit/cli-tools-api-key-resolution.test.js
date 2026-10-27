/**
 * Tests for #4399 — CLI Tools Apply writes placeholder "sk_9router" key.
 *
 * When requireApiKey=true, the written "sk_9router" caused 401 on every
 * CLI tool request. The fix: replace the literal fallback with
 * resolveCliApiKey(), which reads the first active key from the DB
 * (or returns "" if none exist — never the placeholder).
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { POST } from "../../src/app/api/cli-tools/pi-settings/route.js";

const { getApiKeys } = vi.hoisted(() => ({ getApiKeys: vi.fn() }));
vi.mock("@/lib/db", () => ({ getApiKeys }));

// Test the resolveCliApiKey logic in isolation.
// The actual module reads from SQLite; we replicate the decision logic here.

function resolveCliApiKeyLogic(callerKey, activeKeys = []) {
  if (callerKey && callerKey.trim() && callerKey.trim() !== "sk_9router") {
    return callerKey.trim();
  }
  const active = activeKeys.find((k) => k.isActive);
  return active?.key || "";
}

describe("resolveCliApiKey logic (#4399)", () => {
  it("returns the caller key when non-empty and not the placeholder", () => {
    expect(resolveCliApiKeyLogic("sk-real-key-123", [])).toBe("sk-real-key-123");
  });

  it("falls back to first active DB key when caller key is empty", () => {
    const keys = [{ key: "sk-db-key", isActive: true }];
    expect(resolveCliApiKeyLogic("", keys)).toBe("sk-db-key");
  });

  it("falls back to first active DB key when caller key is null", () => {
    const keys = [{ key: "sk-db-key", isActive: true }];
    expect(resolveCliApiKeyLogic(null, keys)).toBe("sk-db-key");
  });

  it("falls back to first active DB key when caller key is undefined", () => {
    const keys = [{ key: "sk-db-key", isActive: true }];
    expect(resolveCliApiKeyLogic(undefined, keys)).toBe("sk-db-key");
  });

  it("falls back to first active DB key when caller is the placeholder itself", () => {
    const keys = [{ key: "sk-db-key", isActive: true }];
    expect(resolveCliApiKeyLogic("sk_9router", keys)).toBe("sk-db-key");
  });

  it("skips inactive keys and picks the first active one", () => {
    const keys = [
      { key: "sk-inactive", isActive: false },
      { key: "sk-active", isActive: true },
    ];
    expect(resolveCliApiKeyLogic("", keys)).toBe("sk-active");
  });

  it("returns empty string when no active DB key exists and caller is empty", () => {
    const keys = [{ key: "sk-inactive", isActive: false }];
    expect(resolveCliApiKeyLogic("", keys)).toBe("");
  });

  it("returns empty string when DB is empty and caller is empty", () => {
    expect(resolveCliApiKeyLogic("", [])).toBe("");
  });

  it("trims whitespace from caller key", () => {
    expect(resolveCliApiKeyLogic("  sk-real  ", [])).toBe("sk-real");
  });

  it("never returns sk_9router", () => {
    expect(resolveCliApiKeyLogic("sk_9router", [])).not.toBe("sk_9router");
    expect(resolveCliApiKeyLogic("", [])).not.toBe("sk_9router");
  });
});

describe("resolveApiKey.js source checks (#4399)", () => {
  const src = fs.readFileSync(
    new URL("../../src/app/api/cli-tools/resolveApiKey.js", import.meta.url),
    "utf-8"
  );

  it("resolveApiKey.js exports resolveCliApiKey", () => {
    expect(src).toContain("resolveCliApiKey");
  });

  it("resolveApiKey.js imports getApiKeys from DB", () => {
    expect(src).toContain("getApiKeys");
  });

  it("resolveApiKey.js does not return sk_9router as a fallback value", () => {
    // The helper may reference "sk_9router" to guard against it, but must
    // never use it as a return / fallback value (e.g. `return "sk_9router"`).
    expect(src).not.toMatch(/return\s+"sk_9router"/);
    expect(src).not.toMatch(/\|\|\s*"sk_9router"/);
  });
});

describe("Pi apply settings", () => {
  let home;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "9router-pi-settings-"));
    vi.spyOn(os, "homedir").mockReturnValue(home);
    getApiKeys.mockReset();
    getApiKeys.mockResolvedValue([
      { key: "sk-inactive", isActive: false },
      { key: "sk-active", isActive: true },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const apply = (body) => POST(new Request("http://localhost/api/cli-tools/pi-settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));

  it("creates a config using the first active API key", async () => {
    const response = await apply({ baseUrl: "http://localhost:20128", apiKey: "", model: "cx/gpt-6.1-sol" });
    expect(response.status).toBe(200);
    const configPath = path.join(home, ".pi", "agent", "models.json");
    expect(await response.json()).toMatchObject({ success: true, configPath });
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
      providers: {
        "9router": {
          baseUrl: "http://localhost:20128/v1",
          apiKey: "sk-active",
          api: "openai-completions",
          models: [{ id: "cx/gpt-6.1-sol", name: "cx/gpt-6.1-sol", contextWindow: 200000, maxTokens: 64000 }],
        },
      },
    });
  });

  it("preserves existing credentials and provider settings when applying models", async () => {
    const configPath = path.join(home, ".pi", "models.json");
    const provider = { baseUrl: "http://old/v1", apiKey: "sk-existing", api: "openai-responses", headers: { "X-Custom": "keep" } };
    const otherProvider = { baseUrl: "https://other.example/v1", apiKey: "sk-other" };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ providers: { "9router": provider, other: otherProvider }, keep: true }));

    const response = await apply({ baseUrl: "http://localhost:20128/v1", apiKey: "", models: ["cx/gpt-6.1-sol"] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, configPath });
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
      providers: {
        "9router": {
          ...provider,
          baseUrl: "http://localhost:20128/v1",
          models: [{ id: "cx/gpt-6.1-sol", name: "cx/gpt-6.1-sol", contextWindow: 200000, maxTokens: 64000 }],
        },
        other: otherProvider,
      },
      keep: true,
    });
    expect(getApiKeys).not.toHaveBeenCalled();
  });

  it("preserves custom model names and caps unless new caps are selected", async () => {
    const configPath = path.join(home, ".pi", "agent", "models.json");
    const modelId = "cx/gpt-6.1-sol";
    const model = { id: modelId, name: "Work model", contextWindow: 1000000, maxTokens: 128000 };
    const provider = { baseUrl: "http://localhost:20128/v1", apiKey: "sk-existing", api: "openai-responses", models: [model] };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ providers: { "9router": provider } }));

    const body = { baseUrl: provider.baseUrl, apiKey: "", models: [{ id: modelId, name: modelId }] };
    expect((await apply(body)).status).toBe(200);
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).providers["9router"]).toEqual(provider);

    const caps = { contextWindow: 262144, maxTokens: 65536 };
    expect((await apply({ ...body, models: [{ ...body.models[0], ...caps }] })).status).toBe(200);
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).providers["9router"]).toEqual({
      ...provider,
      models: [{ ...model, ...caps }],
    });
    expect(getApiKeys).not.toHaveBeenCalled();
  });

  it("replaces the stored key when the caller selects a key", async () => {
    const configPath = path.join(home, ".pi", "agent", "models.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ providers: { "9router": { apiKey: "sk-existing" } } }));

    const response = await apply({ baseUrl: "http://localhost:20128", apiKey: "sk-selected", model: "cx/gpt-6.1-sol" });
    expect(response.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).providers["9router"].apiKey).toBe("sk-selected");
    expect(getApiKeys).not.toHaveBeenCalled();
  });
});
