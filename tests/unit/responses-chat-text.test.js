import { describe, expect, it } from "vitest";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { filterToOpenAIFormat } from "../../open-sse/translator/formats/openai.js";

const toChat = (body) => translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "gpt-6.1-sol", body);
const toResponses = (body) => translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "gpt-6.1-sol", body);

describe("Responses and Chat Completions text controls", () => {
  it("maps verbosity without leaking text or mutating the source request", () => {
    const body = { input: "hello", text: { verbosity: "low" } };
    const original = structuredClone(body);

    const chat = toChat(body);

    expect(chat.verbosity).toBe("low");
    expect(chat).not.toHaveProperty("text");
    expect(chat).not.toHaveProperty("input");
    expect(chat.messages).toHaveLength(1);
    expect(body).toEqual(original);
  });

  const jsonSchema = {
    name: "result",
    schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
    strict: false,
  };
  it.each([
    [{ type: "json_schema", ...jsonSchema }, { type: "json_schema", json_schema: jsonSchema }],
    [{ type: "json_object" }, { type: "json_object" }],
    [{ type: "text" }, { type: "text" }],
  ])("round-trips format %j with verbosity", (format, responseFormat) => {
    const body = { input: "hello", text: { verbosity: "high", format: structuredClone(format) } };
    const original = structuredClone(body);
    const chat = toChat(body);

    expect(chat.response_format).toEqual(responseFormat);
    expect(chat.verbosity).toBe("high");
    expect(chat).not.toHaveProperty("text");
    expect(body).toEqual(original);

    const originalChat = structuredClone(chat);
    const responses = toResponses(chat);

    expect(responses.text).toEqual(original.text);
    for (const key of ["messages", "response_format", "verbosity"]) expect(responses).not.toHaveProperty(key);
    expect(chat).toEqual(originalChat);
  });

  it.each([FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI])("normalizes preconverted %s requests at the Chat boundary", (source) => {
    const text = { verbosity: "low", format: { type: "json_schema", ...jsonSchema } };
    const originalText = structuredClone(text);
    const messages = [{ role: "user", content: "hello" }];
    const chat = translateRequest(source, FORMATS.OPENAI, "gpt-6.1-sol", { messages, text });

    expect(chat.verbosity).toBe("low");
    expect(chat.response_format).toEqual({ type: "json_schema", json_schema: jsonSchema });
    expect(chat).not.toHaveProperty("text");
    expect(chat.messages).toEqual(messages);
    expect(text).toEqual(originalText);
  });

  it("normalizes text controls without manufacturing missing messages", () => {
    const chat = filterToOpenAIFormat({ text: { verbosity: "low" } });

    expect(chat.verbosity).toBe("low");
    expect(chat).not.toHaveProperty("text");
    expect(chat).not.toHaveProperty("messages");
  });

  it("retains native Responses text controls", () => {
    const text = { verbosity: "low", format: { type: "json_object" } };
    const responses = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES, "gpt-6.1-sol", { input: "hello", text });

    expect(responses.text).toEqual(text);
    expect(responses).not.toHaveProperty("verbosity");
    expect(responses).not.toHaveProperty("response_format");
  });
});
