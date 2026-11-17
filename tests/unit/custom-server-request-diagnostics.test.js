import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";

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
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      receivedBody = Buffer.concat(chunks).toString();
      res.end("ok");
    };
    const response = await post("/v1/responses", { "X-9Router-Request-Id": "forged-secret" }, "request-body-secret");
    const logs = records();

    expect(receivedBody).toBe("request-body-secret");
    expect(logs.map((record) => record.event)).toEqual(["start", "response_finished"]);
    expect(logs[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers["x-9router-request-id"]).toBe(logs[0].requestId);
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
    let sawRequest;
    const requestSeen = new Promise((resolve) => { sawRequest = resolve; });
    let responseClosed;
    const closed = new Promise((resolve) => { responseClosed = resolve; });
    handler = (req, res) => {
      req.on("error", () => {});
      req.resume();
      res.on("close", responseClosed);
      sawRequest();
    };
    const socket = net.connect(port, "127.0.0.1");
    await once(socket, "connect");
    socket.write("POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10000\r\n\r\npartial-secret");
    await requestSeen;
    socket.destroy();
    await closed;

    const logs = records();
    expect(logs.map((record) => record.event)).toEqual(["start", "request_aborted"]);
    expect(logs[1]).toMatchObject({
      expectedContentLength: 10000,
      bodyComplete: false,
      bodyRead: false,
      bodyReadMs: null,
      responseStarted: false,
      status: null,
      responseFinished: false,
    });
    expect(JSON.stringify(logs)).not.toContain("secret");
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
});
