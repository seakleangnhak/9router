import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import * as proxyFetchModule from "../../open-sse/utils/proxyFetch.js";

const credentials = { accessToken: "fixture-token", connectionId: "fixture" };
const responsesUrl = "https://chatgpt.com/backend-api/codex/responses";

afterEach(() => vi.restoreAllMocks());

describe("Codex compact routing", () => {
  it.each(["gpt-6.2-sol", "gpt-6.2-astra"])("forwards Ultrafast on %s Responses, not Compact", async (model) => {
    const fetchMock = vi.spyOn(proxyFetchModule, "proxyAwareFetch")
      .mockImplementation(async () => Response.json({ output: [] }));
    const executor = new CodexExecutor();
    const request = { model, input: "hello", service_tier: "ultrafast", reasoning: { effort: "ultra" } };
    await executor.execute({ model, stream: true, credentials, body: { ...request } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(responsesUrl);
    expect(init.headers["x-openai-internal-codex-responses-lite"]).toBe("true");
    expect(JSON.parse(init.body)).toMatchObject({ model, service_tier: "ultrafast", reasoning: { effort: "ultra" } });

    await executor.execute({ model, stream: false, credentials, body: { ...request, _compact: true } });
    const [compactUrl, compactInit] = fetchMock.mock.calls[1];
    expect(compactUrl).toBe(`${responsesUrl}/compact`);
    expect(JSON.parse(compactInit.body)).not.toHaveProperty("service_tier");
  });

  it.each(["gpt-5.6-terra", "gpt-6.1-sol"])("isolates normal and repeated compact requests for %s", async (model) => {
    const fetchMock = vi.spyOn(proxyFetchModule, "proxyAwareFetch")
      .mockImplementation(async () => Response.json({ output: [] }));
    const executor = new CodexExecutor();
    for (const compact of [false, true, true, false]) {
      await executor.execute({
        model, stream: !compact, credentials,
        body: {
          model, input: "hello", instructions: "Keep key facts.",
          text: { verbosity: "low" }, tools: [],
          ...(compact ? { _compact: true } : {}),
        },
      });
      const [url, options] = fetchMock.mock.calls.at(-1);
      const body = JSON.parse(options.body);
      expect(url).toBe(`${responsesUrl}${compact ? "/compact" : ""}`);
      expect(body).not.toHaveProperty("_compact");
      if (compact) {
        expect(body).toMatchObject({ model, instructions: "Keep key facts." });
        expect(body.input).toHaveLength(1);
        for (const key of ["text", "tools", "stream", "store", "reasoning", "include", "parallel_tool_calls"]) {
          expect(body).not.toHaveProperty(key);
        }
        expect(options.headers["x-openai-internal-codex-responses-lite"]).toBeUndefined();
      } else {
        expect(body.text).toEqual({ verbosity: "low" });
      }
    }
  });

  it("keeps compact routing across an HTTP retry interleaved with a normal request", async () => {
    const model = "gpt-6.1-sol";
    const executor = new CodexExecutor();
    executor.config = { ...executor.config, retry: { 502: { attempts: 1, delayMs: 0 } } };
    const fetchMock = vi.spyOn(proxyFetchModule, "proxyAwareFetch")
      .mockImplementation(async () => Response.json({ output: [] }));
    fetchMock.mockImplementationOnce(async () => {
      await executor.execute({ model, body: { model, input: "normal" }, stream: true, credentials });
      return new Response("", { status: 502 });
    });
    await executor.execute({ model, body: { model, input: "compact", _compact: true }, stream: false, credentials });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${responsesUrl}/compact`, responsesUrl, `${responsesUrl}/compact`,
    ]);
  });

  it("keeps compact routing across an SSE overload retry", async () => {
    const model = "gpt-6.1-sol";
    const executor = new CodexExecutor();
    executor.config = { ...executor.config, retry: { 503: { attempts: 1, delayMs: 0 } } };
    const fetchMock = vi.spyOn(proxyFetchModule, "proxyAwareFetch")
      .mockResolvedValueOnce(new Response('event: error\ndata: {"type":"service_unavailable_error"}\n\n'))
      .mockResolvedValueOnce(Response.json({ output: [] }));
    const result = await executor.execute({
      model, body: { model, input: "compact", _compact: true }, stream: false, credentials,
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${responsesUrl}/compact`, `${responsesUrl}/compact`,
    ]);
    await expect(result.response.json()).resolves.toEqual({ output: [] });
  });
});
