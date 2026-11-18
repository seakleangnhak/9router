import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BaseExecutor } from "../../open-sse/executors/base.js";
import { handleComboChat, handleFusionChat } from "../../open-sse/services/combo.js";
import { appendRequestLog } from "@/lib/usageDb.js";

const { upstreamFetch, credentials, cooldown } = vi.hoisted(() => ({
  upstreamFetch: vi.fn(), credentials: vi.fn(), cooldown: vi.fn(),
}));
vi.mock("../../open-sse/utils/proxyFetch.js", async (original) => ({
  ...await original(), proxyAwareFetch: upstreamFetch,
}));
vi.mock("../../src/sse/services/auth.js", async (original) => ({
  ...await original(), getProviderCredentials: credentials, markAccountUnavailable: cooldown,
  clearAccountError: async () => {},
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, value) => value, updateProviderCredentials: async () => {},
}));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: async () => "fixture" }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest() {}, logRawRequest() {}, logOpenAIRequest() {}, logTargetRequest() {},
    logProviderResponse() {}, logConvertedResponse() {}, appendProviderChunk() {},
    appendOpenAIChunk() {}, appendConvertedChunk() {}, logError() {},
  }),
}));

const originalDataDir = process.env.DATA_DIR;
let tempDir, db, handleChat;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-disconnect-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({ requireApiKey: false });
  await db.createCombo({ name: "disconnect-combo", models: ["openai/gpt-5.5", "openai/gpt-5.4"] });
  ({ handleChat } = await import("../../src/sse/handlers/chat.js"));
});

afterAll(() => {
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(() => {
  vi.clearAllMocks();
  credentials.mockResolvedValue({ connectionId: "first", apiKey: "fixture", providerSpecificData: {} });
  cooldown.mockResolvedValue({ shouldFallback: true });
});

function request(controller, model = "openai/gpt-5.5", stream = false) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST", signal: controller.signal, headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "hello" }] }),
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe("chat client disconnect", () => {
  it("returns 499 without selecting credentials for an already aborted request", async () => {
    const controller = new AbortController();
    const inbound = request(controller);
    controller.abort(new Error("socket closed"));
    expect((await handleChat(inbound)).status).toBe(499);
    expect(credentials).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each(["openai/gpt-5.5", "disconnect-combo"])("aborts upstream before headers without fallback or cooldown (%s)", async (model) => {
    const controller = new AbortController();
    const started = deferred();
    upstreamFetch.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
      started.resolve(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const pending = handleChat(request(controller, model));
    const upstreamSignal = await started.promise;
    expect(upstreamSignal).toBeInstanceOf(AbortSignal);
    expect(upstreamSignal.aborted).toBe(false);
    controller.abort();
    expect((await pending).status).toBe(499);
    expect(upstreamSignal.aborted).toBe(true);
    expect(upstreamFetch).toHaveBeenCalledOnce();
    expect(credentials).toHaveBeenCalledOnce();
    expect(cooldown).not.toHaveBeenCalled();
  });

  it.each([false, true])("aborts upstream during body consumption (stream=%s)", async (stream) => {
    const controller = new AbortController();
    const started = deferred();
    upstreamFetch.mockImplementation(async (_url, { signal }) => {
      const body = new ReadableStream({
        start(streamController) {
          signal.addEventListener("abort", () => streamController.error(signal.reason), { once: true });
        },
        pull() { started.resolve(signal); },
      }, { highWaterMark: 0 });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    const pending = handleChat(request(controller, "openai/gpt-5.5", stream));
    let response, consuming;
    if (stream) {
      response = await pending;
      expect(response.status).toBe(200);
      consuming = response.text().catch(() => null);
    }
    const upstreamSignal = await started.promise;
    if (stream) {
      controller.abort();
      await consuming;
    } else {
      controller.abort();
      expect((await pending).status).toBe(499);
      expect(appendRequestLog).toHaveBeenCalledWith(expect.objectContaining({ status: "CANCELLED 499" }));
      expect(appendRequestLog).not.toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED 502" }));
    }
    expect(upstreamSignal.aborted).toBe(true);
    expect(upstreamFetch).toHaveBeenCalledOnce();
    expect(credentials).toHaveBeenCalledOnce();
    expect(cooldown).not.toHaveBeenCalled();
  });

  it("cancels the upstream reader even if the transport does not abort its response body", async () => {
    const controller = new AbortController();
    const started = deferred();
    const cancelled = deferred();
    upstreamFetch.mockResolvedValue(new Response(new ReadableStream({
      pull() { started.resolve(); }, cancel(reason) { cancelled.resolve(reason); },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }));
    const response = await handleChat(request(controller, "openai/gpt-5.5", true));
    const consuming = response.text();
    await started.promise;
    controller.abort();
    await consuming;
    expect(await cancelled.promise).toBe(controller.signal.reason);
  });

  it("interrupts an executor retry delay without opening another upstream connection", async () => {
    upstreamFetch.mockResolvedValue(new Response("overloaded", { status: 503 }));
    const executor = new BaseExecutor("fixture", {
      baseUrl: "https://fixture.invalid", retry: { 503: { attempts: 2, delayMs: 30_000 } },
    });
    const controller = new AbortController();
    const backingOff = deferred();
    const result = executor.execute({
      model: "fixture", body: {}, credentials: {}, signal: controller.signal,
      log: { debug: () => backingOff.resolve() },
    });
    await backingOff.promise;
    const reason = new Error("client gone");
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(upstreamFetch).toHaveBeenCalledOnce();
  });

  it("interrupts combo cooldown before starting the next model", async () => {
    const controller = new AbortController();
    const coolingDown = deferred();
    const handleSingleModel = vi.fn(async () => Response.json({ error: { message: "overloaded" } }, { status: 503 }));
    const result = handleComboChat({
      body: {}, models: ["openai/gpt-5.5", "openai/gpt-5.4"], handleSingleModel,
      signal: controller.signal, log: { info: (tag, message) => { if (message.includes("waiting")) coolingDown.resolve(); }, warn: () => {} },
    });
    await coolingDown.promise;
    controller.abort();
    await expect(result).rejects.toBe(controller.signal.reason);
    expect(handleSingleModel).toHaveBeenCalledOnce();
  });

  it("stops waiting for Fusion panel responses and does not start the judge", async () => {
    const controller = new AbortController();
    const handleSingleModel = vi.fn(() => new Promise(() => {}));
    const result = handleFusionChat({
      body: {}, models: ["openai/gpt-5.5", "openai/gpt-5.4"], handleSingleModel,
      signal: controller.signal, log: { info: () => {}, warn: () => {} },
    });
    controller.abort();
    await expect(result).rejects.toBe(controller.signal.reason);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(handleSingleModel.mock.calls.every(([, , isPanel]) => isPanel)).toBe(true);
  });
});
