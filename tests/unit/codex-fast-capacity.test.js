import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { getModelInfoCore } from "../../open-sse/services/model.js";
import * as proxyFetchModule from "../../open-sse/utils/proxyFetch.js";

afterEach(() => vi.restoreAllMocks());

function streamFromText(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

describe("Codex fast tier and capacity handling", () => {
  it("routes a catalog model alias to Codex for the CLI fast toggle", async () => {
    await expect(getModelInfoCore("gpt-6.1-sol", { "gpt-6.1-sol": "cx/gpt-6.1-sol" }))
      .resolves.toEqual({ provider: "codex", model: "gpt-6.1-sol" });
  });

  it.each([
    [FORMATS.OPENAI_RESPONSES, "priority", "priority"],
    [FORMATS.OPENAI_RESPONSES, "fast", "priority"],
    [FORMATS.OPENAI_RESPONSES, "default", undefined],
    [FORMATS.OPENAI_RESPONSES, undefined, undefined],
    [FORMATS.OPENAI, "priority", "priority"],
    [FORMATS.OPENAI, "fast", "priority"],
    [FORMATS.OPENAI, "default", undefined],
    [FORMATS.OPENAI, undefined, undefined],
  ])("sends %s tier %s as %s for GPT-6.1 Sol", async (sourceFormat, tier, expected) => {
    const fetchMock = vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockResolvedValue({
      ok: true, status: 200, headers: new Map(),
    });
    const model = "gpt-6.1-sol";
    const request = {
      model,
      reasoning: { effort: "high" },
      ...(tier !== undefined ? { service_tier: tier } : {}),
      ...(sourceFormat === FORMATS.OPENAI
        ? { messages: [{ role: "user", content: "hello" }] }
        : { input: "hello" }),
    };
    const credentials = { accessToken: "fixture-token", connectionId: "fixture" };
    const body = translateRequest(sourceFormat, FORMATS.OPENAI_RESPONSES, model,
      request, true, credentials, "codex");

    await new CodexExecutor().execute({ model, body, stream: true, credentials });

    const [url, options] = fetchMock.mock.calls[0];
    const outbound = JSON.parse(options.body);
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(options.headers["x-openai-internal-codex-responses-lite"]).toBe("true");
    expect(outbound.model).toBe(model);
    expect(outbound.service_tier).toBe(expected);
    expect(outbound.reasoning.effort).toBe("high");
  });

  it("maps Codex fast tier to priority and max reasoning to xhigh", () => {
    const executor = new CodexExecutor();
    const body = executor.transformRequest("gpt-reserve", {
      model: "gpt-reserve",
      input: "hi",
      reasoning_effort: "max",
      service_tier: "fast",
    }, true, {});

    expect(body.service_tier).toBe("priority");
    expect(body.reasoning.effort).toBe("xhigh");
  });

  it("uses ChatGPT workspace header fallback", () => {
    const executor = new CodexExecutor();
    const headers = executor.buildHeaders({
      accessToken: "token",
      connectionId: "conn_1",
      providerSpecificData: { chatgptAccountId: "acct_1" },
    });

    expect(headers["ChatGPT-Account-ID"]).toBe("acct_1");
  });

  it("classifies 200-SSE model capacity as account fallback", async () => {
    const executor = new CodexExecutor();
    const response = new Response(streamFromText([
      "event: error",
      'data: {"error":{"message":"Selected model is at capacity. Please try a different model."}}',
      "",
    ].join("\n")), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.accountFallback).toBe(true);
    expect(peek.message).toBe("Selected model is at capacity. Please try a different model.");
  });

  it("reassembles normal SSE after peeking", async () => {
    const executor = new CodexExecutor();
    const text = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"OK"}',
      "",
    ].join("\n");
    const response = new Response(streamFromText(text), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    await expect(new Response(peek.replacementBody).text()).resolves.toBe(text);
  });
});

describe("Codex reasoning normalization", () => {
  it.each([
    ["gpt-5.6-sol", "max", "max"],
    ["gpt-5.6-sol", "ultra", "ultra"],
    ["gpt-5.6-terra", "max", "max"],
    ["gpt-5.6-terra", "ultra", "ultra"],
    ["gpt-5.6-luna", "max", "max"],
    ["gpt-5.6-luna", "ultra", "max"],
  ])("normalizes %s effort %s to %s", (model, effort, expected) => {
    const body = new CodexExecutor().transformRequest(model, {
      model,
      input: "hi",
      reasoning: { effort },
    }, true, {});

    expect(body.reasoning.effort).toBe(expected);
  });

  it("resolves review models before applying the reasoning matrix", () => {
    const body = new CodexExecutor().transformRequest("gpt-5.6-terra-review", {
      model: "gpt-5.6-terra-review",
      input: "hi",
      reasoning_effort: "ultra",
    }, true, {});

    expect(body.model).toBe("gpt-5.6-terra");
    expect(body.reasoning.effort).toBe("ultra");
  });
});
