import { expect, it, vi } from "vitest";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: async () => {},
  saveRequestUsage: async () => {},
  trackPendingRequest: () => {},
}));

it.each([
  ["passthrough", FORMATS.OPENAI, 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'],
  ["translate", FORMATS.OPENAI_RESPONSES, 'event: response.created\ndata: {"type":"response.created"}\n\n', 'event: response.output_text.delta\ndata: {"delta":"hi"}\n\n'],
])("observes tokens and stream errors in %s without changing output", async (mode, format, setup, token) => {
  const options = { mode, targetFormat: format, sourceFormat: format, model: "fixture" };
  const streamTrace = { onToken: vi.fn(), onError: vi.fn() };
  const error = 'event: error\ndata: {"type":"error","error":{"message":"upstream-secret"}}\n\n';
  const render = async (body, trace) => new Response(
    new Response(body).body.pipeThrough(createSSEStream({ ...options, streamTrace: trace }))
  ).text();
  await render(setup, streamTrace);
  expect(streamTrace.onToken).not.toHaveBeenCalled();
  streamTrace.onError.mockClear();
  expect(await render(setup + token + error, streamTrace)).toBe(await render(setup + token + error));
  expect(streamTrace.onToken).toHaveBeenCalledExactlyOnceWith();
  expect(streamTrace.onError).toHaveBeenCalledWith("upstream_stream_error");
  expect(JSON.stringify(streamTrace.onError.mock.calls)).not.toContain("secret");
});
