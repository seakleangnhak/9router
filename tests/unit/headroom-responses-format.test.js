import { describe, it, expect, vi, afterEach } from "vitest";
import { compressWithHeadroom } from "../../open-sse/rtk/headroom.js";

const options = {
  enabled: true,
  url: "http://headroom.test",
  model: "gpt-5",
  format: "openai-responses",
};

function mockCompression(edit = () => {}) {
  const fetch = vi.fn(async (_url, request) => {
    const payload = JSON.parse(request.body);
    const messages = structuredClone(payload.messages);
    edit(messages, payload);
    return {
      ok: true,
      json: async () => ({ messages, tokens_before: 100, tokens_after: 90, tokens_saved: 10 }),
    };
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function toolHistory() {
  return {
    input: [
      { type: "function_call_output", call_id: "call_first", output: "first tool result ".repeat(20) },
      { type: "function_call_output", call_id: "call_second", output: "second tool result ".repeat(20) },
    ],
  };
}

describe("compressWithHeadroom native Responses", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("compresses mixed Codex tool history without rebuilding native items or changing readonly text", async () => {
    const output = "successful tool output ".repeat(20);
    const body = {
      model: "codex-model",
      instructions: "Keep instructions exactly.",
      previous_response_id: "resp_previous",
      include: ["reasoning.encrypted_content"],
      store: false,
      tools: [{ type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } }],
      input: [
        { type: "message", id: "msg_system", role: "system", content: "system text" },
        { role: "developer", content: [{ type: "input_text", text: "developer text" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "user prompt" }, { type: "input_image", image_url: "https://example.test/image.png", detail: "high" }] },
        { type: "reasoning", id: "reasoning_1", encrypted_content: "opaque-encrypted-data", summary: [{ type: "summary_text", text: "private reasoning" }] },
        { type: "function_call", id: "fc_1", call_id: "call_exec", name: "exec_command", arguments: '{"cmd":"pwd"}', status: "completed" },
        { type: "function_call_output", id: "out_1", call_id: "call_exec", output, status: "completed" },
        { type: "custom_tool_call", id: "custom_1", call_id: "call_patch", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
        { type: "custom_tool_call_output", id: "out_2", call_id: "call_patch", output: [{ type: "text", text: output, annotations: [] }, { type: "input_image", image_url: "data:image/png;base64,opaque" }] },
        { type: "message", role: "assistant", id: "msg_assistant", content: [{ type: "output_text", text: "assistant text", annotations: [] }] },
        { type: "future_item", text: "opaque future text", output },
        { type: "item_reference", id: "ref_1" },
      ],
    };
    const expected = structuredClone(body);
    expected.input[5].output = "short";
    expected.input[7].output[0].text = "short";
    const input = body.input;
    const items = [...input];
    const customContent = input[7].output;
    const tools = body.tools;
    const fetch = mockCompression((messages) => {
      for (const message of messages) {
        if (message.role === "tool") message.content = "short";
      }
    });

    expect(await compressWithHeadroom(body, options)).not.toBeNull();
    expect(body).toEqual(expected);
    expect(body.input).toBe(input);
    input.forEach((item, index) => expect(item).toBe(items[index]));
    expect(body.input[7].output).toBe(customContent);
    expect(body.tools).toBe(tools);
    const payload = JSON.parse(fetch.mock.calls[0][1].body);
    expect(payload.messages.map(({ id }) => id)).toEqual(payload.messages.map((_, index) => `9router-headroom-${index}`));
    expect(payload.messages.filter(({ role }) => role === "tool").map(({ tool_call_id }) => tool_call_id)).toEqual(["call_exec", "call_patch"]);
    expect(payload.messages.map(({ content }) => content)).toEqual([
      body.instructions, "system text", "developer text", "user prompt", output, output,
    ]);
    for (const message of payload.messages) {
      expect(Object.keys(message).sort()).toEqual((message.role === "tool" ? ["id", "role", "content", "tool_call_id"] : ["id", "role", "content"]).sort());
    }
    expect(payload.config).toBeUndefined();
  });

  it.each(["input_text", "output_text", "text"])("copies only eligible %s tool-output text while preserving protected parts", async (type) => {
    const output = "long original output ".repeat(20);
    const body = {
      input: [
        { type: "function_call_output", call_id: "ok", output: [{ type, text: output, metadata: { source: "tool" } }, { type: "unknown", text: output }, { type, text: output, is_error: true }, { type, text: output, status: "error" }, { type, text: output, annotations: [{ start_index: 2, end_index: 10 }] }, { type, text: output, logprobs: [{ token: "long", logprob: -0.1 }] }] },
        { type: "custom_tool_call_output", call_id: "error_boolean", is_error: true, output },
        { type: "function_call_output", call_id: "error_status", status: "error", output },
      ],
    };
    const expected = structuredClone(body);
    expected.input[0].output[0].text = "short";
    const fetch = mockCompression((messages) => {
      expect(messages).toHaveLength(1);
      messages[0].content = [{ type: "text", text: "short" }];
    });

    expect(await compressWithHeadroom(body, options)).not.toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    expect(body).toEqual(expected);
  });

  it.each([undefined, false, true])("compresses user text only with explicit opt-in (%s)", async (compressUserMessages) => {
    const body = {
      instructions: "exact instructions",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "long user text ".repeat(20), annotations: [] }, { type: "input_text", text: "another user text ".repeat(20) }] },
        { type: "message", role: "assistant", content: "assistant answer" },
      ],
    };
    const expected = structuredClone(body);
    const fetch = mockCompression((messages, payload) => {
      expect(payload.config).toEqual({ compress_user_messages: true });
      for (const message of messages) {
        if (message.role === "user") message.content = "short";
      }
    });
    if (compressUserMessages) {
      expected.input[0].content.forEach((part) => { part.text = "short"; });
    }

    const result = await compressWithHeadroom(body, { ...options, compressUserMessages });
    expect(body).toEqual(expected);
    if (compressUserMessages) {
      expect(result).not.toBeNull();
      expect(fetch).toHaveBeenCalledOnce();
    } else {
      expect(result).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])("supports bare string input with user opt-in (%s)", async (compressUserMessages) => {
    const body = { instructions: "readonly instructions", input: "long user input ".repeat(20) };
    const expected = structuredClone(body);
    const fetch = mockCompression((messages) => {
      for (const message of messages) {
        if (message.role === "user") message.content = "short";
      }
    });
    const result = await compressWithHeadroom(body, { ...options, compressUserMessages });
    if (compressUserMessages) expected.input = "short";
    expect(body).toEqual(expected);
    expect(result === null).toBe(!compressUserMessages);
    expect(fetch.mock.calls).toHaveLength(compressUserMessages ? 1 : 0);
  });

  it("does not call Headroom when only opaque, error or readonly content exists", async () => {
    const body = {
      input: [
        { type: "message", role: "system", content: "system text" },
        { type: "message", role: "assistant", content: "assistant text" },
        { type: "message", role: "user", is_error: true, content: "error prompt" },
        { type: "function_call", call_id: "call_1", arguments: "opaque arguments" },
        { type: "reasoning", encrypted_content: "opaque encrypted content" },
        { type: "future_item", output: "opaque output" },
        { type: "function_call_output", is_error: true, output: "error output" },
        { type: "function_call_output", output: [{ type: "unknown", text: "opaque text" }, { type: "text", text: "error text", status: "error" }] },
      ],
    };
    const expected = structuredClone(body);
    const fetch = mockCompression();

    expect(await compressWithHeadroom(body, { ...options, compressUserMessages: true })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(body).toEqual(expected);
  });

  it.each(["system", "developer", "user"])("rejects changes to readonly %s text after an earlier valid tool shrink", async (role) => {
    const body = toolHistory();
    body.input.push({ type: "message", role, content: "protected text" });
    const expected = structuredClone(body);
    const diagnostics = {};
    const fetch = mockCompression((messages) => {
      messages[0].content = "short";
      messages.at(-1).content = "changed text";
    });

    expect(await compressWithHeadroom(body, { ...options, diagnostics })).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    expect(diagnostics.reason).toBe("proxy response changed protected Responses text");
    expect(body).toEqual(expected);
  });

  it("omits whitespace-only output while compressing eligible output in the same request", async () => {
    const body = toolHistory();
    body.input.unshift({ type: "function_call_output", call_id: "call_whitespace", output: " \n\t" });
    const expected = structuredClone(body);
    expected.input[1].output = "short";
    const fetch = mockCompression((messages) => {
      expect(messages).toHaveLength(2);
      expect(messages[0].tool_call_id).toBe("call_first");
      messages[0].content = "short";
    });

    expect(await compressWithHeadroom(body, options)).not.toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    expect(body).toEqual(expected);
  });

  it.each([
    ["removed message", (messages) => { messages.pop(); }],
    ["added message", (messages) => { messages.push({ ...messages[1] }); }],
    ["reordered same-role slots", (messages) => { messages.reverse(); }],
    ["changed slot ID", (messages) => { messages[1].id = "wrong-id"; }],
    ["missing slot ID", (messages) => { delete messages[1].id; }],
    ["changed role", (messages) => { messages[1].role = "assistant"; }],
    ["changed tool ID", (messages) => { messages[1].tool_call_id = "wrong-call"; }],
    ["missing tool ID", (messages) => { delete messages[1].tool_call_id; }],
    ["missing text", (messages) => { delete messages[1].content; }],
    ["empty replacement", (messages) => { messages[1].content = ""; }],
    ["blank replacement", (messages) => { messages[1].content = " \n\t"; }],
    ["expanded replacement", (messages) => { messages[1].content = messages[1].content.repeat(2); }],
    ["multiple text blocks", (messages) => { messages[1].content = [{ type: "text", text: "one" }, { type: "text", text: "two" }]; }],
    ["mixed content blocks", (messages) => { messages[1].content = [{ type: "text", text: "one" }, { type: "image_url", image_url: "opaque" }]; }],
    ["unknown text block", (messages) => { messages[1].content = [{ type: "future_text", text: "short" }]; }],
  ])("fails open atomically on %s", async (_name, change) => {
    const body = toolHistory();
    const expected = structuredClone(body);
    const fetch = mockCompression((messages) => {
      messages[0].content = "short";
      change(messages);
    });

    expect(await compressWithHeadroom(body, options)).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    expect(body).toEqual(expected);
  });

  it.each(["ééééé", "\\\\\\\\\\"])("rejects JSON-byte growth despite shorter text (%s)", async (replacement) => {
    const body = toolHistory();
    body.input[1].output = "123456789";
    const expected = structuredClone(body);
    const fetch = mockCompression((messages) => {
      messages[0].content = "short";
      messages[1].content = replacement;
    });

    expect(replacement.length).toBeLessThan(body.input[1].output.length);
    expect(await compressWithHeadroom(body, options)).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    expect(body).toEqual(expected);
  });

  it.each(["http", "network", "invalid json"])("leaves native requests unchanged on %s failure", async (failure) => {
    const body = toolHistory();
    const expected = structuredClone(body);
    const fetch = vi.fn(async () => {
      if (failure === "network") throw new Error("connection refused");
      return { ok: failure !== "http", status: 503, json: async () => { throw new Error("invalid JSON"); } };
    });
    vi.stubGlobal("fetch", fetch);

    expect(await compressWithHeadroom(body, options)).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    expect(body).toEqual(expected);
  });
});
