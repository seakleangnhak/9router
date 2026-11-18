import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { currentRequestTrace, recordTraceTier, startTraceAttempt } from "../../src/lib/requestTraces.js";
import { GET as readTraces } from "../../src/app/api/usage/request-traces/route.js";

const require = createRequire(import.meta.url);
const originalCreateServer = http.createServer;
let server;
let port;
let handler;
let logSpy;

function records() {
  return logSpy.mock.calls
    .filter(([prefix]) => prefix === "[RequestDiagnostics]")
    .map(([, json]) => JSON.parse(json));
}

function post(path = "/v1/responses", headers = {}, body = "{}") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", agent: false, headers: {
      "Content-Length": Buffer.byteLength(body), ...headers,
    } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res));
    });
    req.on("error", reject);
    req.end(body);
  });
}

beforeAll(async () => {
  delete require.cache[require.resolve("../../custom-server.js")];
  require("../../custom-server.js");
  server = http.createServer((req, res) => handler(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = server.address().port;
});

beforeEach(() => {
  vi.stubEnv("NINEROUTER_REQUEST_DIAGNOSTICS", "true");
  logSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  handler = (req, res) => {
    req.resume();
    req.on("end", () => res.end("ok"));
  };
});

afterEach(() => {
  server.closeAllConnections();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  http.createServer = originalCreateServer;
});

describe("HTTP request diagnostics", () => {
  it("records completion without consuming the body or trusting a supplied request ID", async () => {
    let receivedBody;
    handler = async (req, res) => {
      expect(req.readableFlowing).toBeNull();
      expect(req.headers).not.toHaveProperty("x-9router-probe-id");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      receivedBody = Buffer.concat(chunks).toString();
      res.end("ok");
    };
    const response = await post("/v1/responses", { "X-9Router-Request-Id": "forged-secret", "X-9Router-Probe-Id": "invalid-secret" }, "request-body-secret");
    const logs = records();

    expect(receivedBody).toBe("request-body-secret");
    expect(logs.map((record) => record.event)).toEqual(["start", "response_finished"]);
    expect(logs[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers["x-9router-request-id"]).toBe(logs[0].requestId);
    expect(logs[0]).not.toHaveProperty("probeId");
    expect(logs[1]).toMatchObject({
      requestId: logs[0].requestId,
      expectedContentLength: 19,
      bodyComplete: true,
      bodyRead: true,
      responseStarted: true,
      status: 200,
      responseFinished: true,
    });
    expect(logs[1].bodyReadMs).toBeGreaterThanOrEqual(0);
    expect(logs[1].elapsedMs).toBeGreaterThanOrEqual(logs[1].bodyReadMs);
    expect(JSON.stringify(logs)).not.toContain("secret");
  });

  it("records an interrupted upload once, without claiming an HTTP status", async () => {
    vi.stubEnv("NINEROUTER_REQUEST_TRACES", "true");
    let sawRequest;
    const requestSeen = new Promise((resolve) => { sawRequest = resolve; });
    let responseClosed;
    const closed = new Promise((resolve) => { responseClosed = resolve; });
    handler = (req, res) => {
      expect(req.headers).not.toHaveProperty("x-9router-probe-id");
      req.on("error", () => {});
      req.resume();
      res.on("close", responseClosed);
      sawRequest();
    };
    const socket = net.connect(port, "127.0.0.1");
    await once(socket, "connect");
    const probeId = "12345678-1234-4234-8234-123456789abc";
    socket.write(`POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nX-9Router-Probe-Id: ${probeId}\r\nContent-Length: 10000\r\n\r\npartial-secret`);
    await requestSeen;
    socket.destroy();
    await closed;

    const logs = records();
    expect(logs.map((record) => record.event)).toEqual(["start", "request_aborted"]);
    expect(logs[0].probeId).toBe(probeId);
    expect(logs[0].requestId).not.toBe(probeId);
    expect(logs[1]).toMatchObject({
      probeId,
      expectedContentLength: 10000,
      bodyComplete: false,
      bodyRead: false,
      bodyReadMs: null,
      responseStarted: false,
      status: null,
      responseFinished: false,
    });
    expect(JSON.stringify(logs)).not.toContain("secret");
    const response = readTraces(new Request(`http://localhost/api/usage/request-traces?id=${logs[0].requestId}`));
    const { traces } = await response.json();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ upload: "interrupted", terminalReason: "upload_interrupted", status: null, attempts: [] });
    expect(traces[0]).not.toHaveProperty("probeId");
  });

  it.each([false, true])("records a closed response after a complete upload (headers sent: %s)", async (sendHeaders) => {
    let ready;
    const requestRead = new Promise((resolve) => { ready = resolve; });
    let responseClosed;
    const closed = new Promise((resolve) => { responseClosed = resolve; });
    handler = (req, res) => {
      req.resume();
      res.on("close", responseClosed);
      req.on("end", () => {
        if (sendHeaders) res.write("first chunk");
        ready();
      });
    };
    const socket = net.connect(port, "127.0.0.1");
    await once(socket, "connect");
    socket.write("POST /api/v1/responses HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{}");
    await requestRead;
    socket.destroy();
    await closed;

    const logs = records();
    expect(logs.map((record) => record.event)).toEqual(["start", "response_closed"]);
    expect(logs[1]).toMatchObject({
      bodyComplete: true,
      bodyRead: true,
      responseStarted: sendHeaders,
      status: sendHeaders ? 200 : null,
      responseFinished: false,
    });
  });

  it.each([
    ["/v1/chat/completions?api_key=query-secret", "/v1/chat/completions"],
    ["/api/v1/prompt-secret?token=query-secret", "/api/v1/:path"],
    ["/codex/path-secret", "/codex/:path"],
    ["/responses/unknown-secret", "/responses/:path"],
  ])("does not log credentials or arbitrary path segments from %s", async (path, expectedPath) => {
    await post(path, { Authorization: "Bearer header-secret", Cookie: "session=cookie-secret" }, "body-secret");
    expect(records()).toHaveLength(2);
    expect(records()[0].path).toBe(expectedPath);
    expect(JSON.stringify(records())).not.toContain("secret");
  });

  it("leaves unrelated routes and disabled diagnostics untouched", async () => {
    let response = await post("/api/settings?token=secret");
    expect(records()).toHaveLength(0);
    expect(response.headers["x-9router-request-id"]).toBeUndefined();

    vi.stubEnv("NINEROUTER_REQUEST_DIAGNOSTICS", "false");
    response = await post();
    expect(records()).toHaveLength(0);
    expect(response.headers["x-9router-request-id"]).toBeUndefined();
  });

  it("finds requests by generated ID without retaining caller values or enabling console logs", async () => {
    vi.stubEnv("NINEROUTER_REQUEST_DIAGNOSTICS", "false");
    vi.stubEnv("NINEROUTER_REQUEST_TRACES", "true");
    handler = async (req, res) => {
      for await (const _chunk of req) { /* drain */ }
      const context = currentRequestTrace();
      expect(res.getHeader("X-9Router-Request-Id")).toBe(context.trace.requestId);
      recordTraceTier(context, "requestedTier", "ultrafast");
      const failed = startTraceAttempt(context, "codex", "gpt-6.2-sol");
      failed.update("account_fallback", 429);
      failed.onForwardedTier(undefined);
      const panel = startTraceAttempt(context, "openai", "gpt-6.2-sol");
      panel.update("response_accepted", 200);
      panel.bindResponse(new Response());
      panel.onTier("priority");
      panel.onForwardedTier("upstream-secret");
      const next = startTraceAttempt(context, "provider-secret", "model-secret");
      next.update("response_accepted", 200);
      next.onToken();
      next.onForwardedTier("ultrafast");
      next.onError("upstream_stream_error");
      const original = new Response();
      const wrapped = new Response();
      next.bindResponse(original);
      context.trackWrappedResponse(original, wrapped);
      context.selectResponse(wrapped);
      expect(context.trace.actualTier).toBeNull();
      next.onTier("default");
      next.onTier("upstream-secret");
      next.onTier("auto");
      expect(context.trace.actualTier).toBe("default");
      res.end("response-secret");
    };
    const { headers } = await post("/codex/path-secret?key=query-secret", { "X-9Router-Request-Id": "forged-secret" }, "prompt-secret");
    const id = headers["x-9router-request-id"];
    const request = new Request(`http://localhost/api/usage/request-traces?id=${id.toUpperCase()}`);
    const response = readTraces(request);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const data = await response.json();
    expect(data.traces).toHaveLength(1);
    expect(data.traces[0]).toMatchObject({
      requestId: id, path: "/codex", upload: "complete", firstTokenMs: expect.any(Number),
      terminalReason: "stream_error", status: 200, requestedTier: "ultrafast", actualTier: "default",
      attempts: [
        { provider: "codex", model: "gpt-6.2-sol", outcome: "account_fallback", status: 429, forwardedTier: null },
        { provider: "openai", model: "gpt-6.2-sol", outcome: "response_accepted", status: 200, actualTier: "priority", forwardedTier: "other" },
        { provider: "custom", model: null, outcome: "response_accepted", streamError: "upstream_stream_error", actualTier: "default", forwardedTier: "ultrafast" },
      ],
    });
    expect(JSON.stringify(data)).not.toContain("secret");
    expect(records()).toHaveLength(0);
    expect(readTraces(new Request("http://localhost/api/usage/request-traces?id=forged-secret")).status).toBe(400);
  });

  it.each([
    ["/v1/responses/compact", "/v1/responses/compact"],
    ["/v1beta/models/cx/model-secret:generateContent?key=query-secret", "/v1beta/models/:model:generateContent"],
    ["/api/v1beta/models/model-secret:streamGenerateContent", "/api/v1beta/models/:model:streamGenerateContent"],
  ])("captures %s using a fixed endpoint label", async (path, expectedPath) => {
    vi.stubEnv("NINEROUTER_REQUEST_TRACES", "true");
    const id = (await post(path)).headers["x-9router-request-id"];
    const { traces } = await readTraces(new Request(`http://localhost/api/usage/request-traces?id=${id}`)).json();
    expect(traces[0].path).toBe(expectedPath);
    expect(traces[0].actualTier).toBeNull();
    expect(JSON.stringify(traces)).not.toContain("secret");
  });

  it("bounds history, isolates concurrent contexts, and keeps rejected traffic from evicting admitted traces", async () => {
    vi.stubEnv("NINEROUTER_REQUEST_DIAGNOSTICS", "false");
    vi.stubEnv("NINEROUTER_REQUEST_TRACES", "true");
    handler = async (req, res) => {
      for await (const _chunk of req) { /* drain */ }
      const context = currentRequestTrace();
      expect(context.trace.requestId).toBe(res.getHeader("X-9Router-Request-Id"));
      if (!req.headers["x-test-admit"]) return res.writeHead(401).end();
      context.admit();
      for (let i = 0; i < 33; i++) startTraceAttempt(context, "codex", "gpt-6.2-sol");
      res.end("ok");
    };
    const admitted = { "x-test-admit": "yes" };
    const first = (await post(undefined, admitted)).headers["x-9router-request-id"];
    for (let i = 0; i < 10; i++) await Promise.all(Array.from({ length: 20 }, () => post(undefined, admitted)));
    for (let i = 0; i < 3; i++) await Promise.all(Array.from({ length: 20 }, () => post()));
    const list = await readTraces(new Request("http://localhost/api/usage/request-traces")).json();
    expect(list.traces).toHaveLength(250);
    expect(list.traces.filter((trace) => trace.status === 401)).toHaveLength(50);
    expect(list.traces.some((trace) => trace.requestId === first)).toBe(false);
    const kept = list.traces.find((trace) => trace.status === 200);
    expect(kept.attempts).toHaveLength(32);
    expect(kept.droppedAttempts).toBe(1);
  });
});
