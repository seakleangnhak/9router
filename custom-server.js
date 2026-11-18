const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const { pathToFileURL } = require("url");

const origCreate = http.createServer.bind(http);

// Per-process secret proving x-9r-real-ip was stamped below rather than sent by the client.
// A bare `next start` / `next dev` never loads this file, so it cannot produce a matching
// header even though the env var is inherited by child processes. Named like x-9r-cli-token
// so the request-detail header sanitizer redacts it too.
const PEER_TOKEN = crypto.randomBytes(24).toString("hex");
process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;

let backgroundRefreshStarted = false;
const traceContext = new AsyncLocalStorage();
const recentTraces = new Map();
const ingressTraces = new Map();
const TRACE_LIMIT = 200;
const INGRESS_TRACE_LIMIT = 50;
const traceEndpoints = new Set(["/chat/completions", "/responses", "/responses/compact", "/messages", "/api/chat"]);
const diagnosticEndpoints = new Set([
  "", ...traceEndpoints, "/messages/count_tokens", "/models",
  "/embeddings", "/images/generations", "/audio/speech", "/audio/transcriptions", "/audio/voices", "/search",
]);

globalThis[Symbol.for("9router.requestTraces")] = {
  current: () => traceContext.getStore(),
  list: (id) => id ? [recentTraces.get(id) ?? ingressTraces.get(id)].filter(Boolean)
    : [...recentTraces.values(), ...ingressTraces.values()].reverse()
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
};

function retainTrace(history, limit, trace) {
  history.set(trace.requestId, trace);
  if (history.size > limit) history.delete(history.keys().next().value);
}

function observeResponsesCompletion(res, onComplete) {
  const write = res.write;
  let prefix = "", completed = false, hasData = false, observed = false;
  const maxPrefix = "event: response.completed\r".length + 1;
  res.write = function observeWrite(chunk, encoding, callback) {
    const result = write.call(this, chunk, encoding, callback);
    if (observed || this.destroyed || this.statusCode !== 200 || this.getHeader("content-encoding")
      || !/^text\/event-stream(?:;|$)/i.test(this.getHeader("content-type"))) return result;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8")
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    // Keep only a short line prefix across writes; never store SSE payloads.
    for (let start = 0; start < bytes.length;) {
      const newline = bytes.indexOf(10, start);
      const end = newline === -1 ? bytes.length : newline;
      prefix += bytes.toString("latin1", start, Math.min(end, start + maxPrefix - prefix.length));
      if (newline === -1) break;
      const line = prefix.endsWith("\r") ? prefix.slice(0, -1) : prefix;
      prefix = "";
      start = newline + 1;
      if (line === "event: response.completed" || line === "event:response.completed") completed = true;
      else if (line.startsWith("event:")) completed = false;
      else if (line.startsWith("data:") && line.slice(5).trim()) hasData = true;
      else if (!line) {
        if (completed && hasData) {
          observed = true;
          onComplete();
          if (this.write === observeWrite) this.write = write;
          break;
        }
        completed = hasData = false;
      }
    }
    return result;
  };
}

function observeRequest(req, res) {
  const diagnostics = process.env.NINEROUTER_REQUEST_DIAGNOSTICS === "true";
  const tracesEnabled = process.env.NINEROUTER_REQUEST_TRACES === "true";
  if (!diagnostics && !tracesEnabled) return;
  const pathname = String(req.url || "").split(/[?#]/, 1)[0];
  const match = /^(\/api\/v1beta|\/v1beta|\/api\/v1|\/v1\/v1|\/v1|\/codex|\/responses)(\/.*)?$/.exec(pathname);
  if (!match) return;
  const suffix = match[2] || "";
  const traceSuffix = suffix.replace(/\/$/, "");
  const beta = match[1].endsWith("v1beta");
  const generation = beta && /^\/models\/.+(?::|%3[aA])(generateContent|streamGenerateContent)$/.exec(traceSuffix);
  const tracePath = req.method !== "POST" ? null
    : beta ? (generation ? `${match[1]}/models/:model:${generation[1]}` : null)
      : match[1] === "/codex" ? "/codex"
      : match[1] === "/responses" ? (traceSuffix ? null : "/responses")
        : traceEndpoints.has(traceSuffix) ? match[1] + traceSuffix : null;
  const capture = tracePath && tracesEnabled;
  if (!diagnostics && !capture) return;
  // Only fixed endpoint names may enter logs; unknown suffixes can contain secrets.
  const diagnosticPath = beta && tracePath ? tracePath : match[1] + (diagnosticEndpoints.has(suffix) ? suffix : "/:path");
  const requestId = crypto.randomUUID();
  // Optional probe marker, never used as the router's request ID or for auth.
  const suppliedProbeId = diagnostics ? req.headers["x-9router-probe-id"] : undefined;
  const probeId = typeof suppliedProbeId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(suppliedProbeId)
    ? suppliedProbeId : undefined;
  const started = process.hrtime.bigint();
  const elapsedMs = () => Math.round(Number(process.hrtime.bigint() - started) / 1e6);
  const contentLength = req.headers["content-length"];
  const expectedContentLength = typeof contentLength === "string" && /^\d+$/.test(contentLength)
    && Number.isSafeInteger(Number(contentLength)) ? Number(contentLength) : null;
  let bodyReadMs = null;
  let terminalLogged = false;
  let admitted = false;
  let returnedAttempt;
  let responseCompletedEventWritten = false;
  const trace = capture ? {
    requestId, startedAt: new Date().toISOString(), path: tracePath,
    clientTier: null, requestedTier: null, actualTier: null, attempts: [], droppedAttempts: 0,
    upload: "pending", uploadMs: null, expectedContentLength,
    firstTokenMs: null, status: null, durationMs: null, terminalReason: null,
  } : null;

  res.setHeader("X-9Router-Request-Id", requestId);
  if ((diagnostics || trace) && req.method === "POST" && (match[1] === "/codex" || match[1] === "/responses" || traceSuffix === "/responses")) {
    observeResponsesCompletion(res, () => { responseCompletedEventWritten = true; });
  }
  const updateUpload = () => {
    if (trace && !terminalLogged) {
      trace.upload = "complete";
      trace.uploadMs ??= elapsedMs();
    }
  };
  const log = (event) => {
    if (!diagnostics) return;
    console.info("[RequestDiagnostics]", JSON.stringify({
      timestamp: new Date().toISOString(),
      requestId,
      probeId,
      event,
      method: http.METHODS.includes(req.method) ? req.method : "OTHER",
      path: diagnosticPath,
      elapsedMs: elapsedMs(),
      expectedContentLength,
      bodyComplete: req.complete === true,
      bodyRead: req.readableEnded === true,
      bodyReadMs,
      responseStarted: res.headersSent,
      status: res.headersSent ? res.statusCode : null,
      responseFinished: res.writableFinished,
      ...(responseCompletedEventWritten && { responseCompletedEventWritten: true }),
    }));
  };
  const onEnd = () => { bodyReadMs = elapsedMs(); updateUpload(); };
  const terminal = (event) => {
    if (terminalLogged) return;
    terminalLogged = true;
    if (trace) {
      if (req.complete) trace.upload = "complete";
      else if (trace.upload === "pending") trace.upload = event === "response_finished" ? "not_observed" : "interrupted";
      trace.status = res.headersSent ? res.statusCode : null;
      trace.durationMs = elapsedMs();
      trace.terminalReason = trace.upload === "interrupted" ? "upload_interrupted"
        : responseCompletedEventWritten && !returnedAttempt?.streamError && event === "response_closed" ? "completed_before_close"
          : event !== "response_finished" ? "client_disconnected"
          : trace.status >= 400 ? "http_error"
            : returnedAttempt?.streamError ? "stream_error" : "response_finished";
    }
    log(event);
    req.off("end", onEnd);
    req.off("aborted", onAborted);
    res.off("finish", onFinish);
    res.off("close", onClose);
  };
  const onAborted = () => terminal("request_aborted");
  const onFinish = () => terminal("response_finished");
  const onClose = () => terminal(res.writableFinished ? "response_finished" : "response_closed");

  req.once("end", onEnd);
  req.once("aborted", onAborted);
  res.once("finish", onFinish);
  res.once("close", onClose);
  log("start");
  if (trace) {
    // ponytail: bounded per-process history. Share storage only for cross-instance lookup.
    retainTrace(ingressTraces, INGRESS_TRACE_LIMIT, trace);
    const responses = new WeakMap();
    return {
      trace, elapsedMs, updateUpload, responses,
      get returnedAttempt() { return returnedAttempt; },
      admit() {
        if (admitted || terminalLogged) return;
        admitted = true;
        ingressTraces.delete(requestId);
        retainTrace(recentTraces, TRACE_LIMIT, trace);
      },
      selectResponse(response) {
        if (terminalLogged) return;
        returnedAttempt = responses.get(response);
        trace.actualTier = returnedAttempt?.actualTier ?? null;
      },
      trackWrappedResponse(original, wrapped) {
        const attempt = responses.get(original);
        if (attempt) responses.set(wrapped, attempt);
      },
    };
  }
}

function startBackgroundTokenRefreshFromCustomServer() {
  if (backgroundRefreshStarted) return;
  backgroundRefreshStarted = true;
  // Prefer source path (repo / standalone that still has src). Fail-open if missing
  // — initializeApp also starts the same scheduler when the Next app boots.
  const modPath = path.join(__dirname, "src", "sse", "services", "backgroundTokenRefresh.js");
  import(pathToFileURL(modPath).href)
    .then((m) => {
      try {
        m.startBackgroundTokenRefresh();
      } catch (e) {
        console.error("[BackgroundTokenRefresh] start failed:", e && e.message ? e.message : e);
      }
      const stop = () => {
        try {
          m.stopBackgroundTokenRefresh();
        } catch {
          /* ignore */
        }
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    })
    .catch((e) => {
      // Expected in published CLI standalone (src/ not on disk). App bootstrap covers it.
      if (process.env.DEBUG_BACKGROUND_TOKEN_REFRESH) {
        console.error("[BackgroundTokenRefresh] import failed:", e && e.message ? e.message : e);
      }
    });
}

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const wrapped = (req, res) => {
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
    // Trust forwarding headers only when the TCP peer is a local reverse proxy.
    // Direct/public sockets remain keyed by the unspoofable peer address.
    const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
    const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    delete req.headers["x-9r-peer-token"];
    req.headers["x-9r-real-ip"] = ip;
    req.headers["x-9r-peer-token"] = PEER_TOKEN;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
    const context = observeRequest(req, res);
    delete req.headers["x-9router-probe-id"];
    return traceContext.run(context, handler, req, res);
  };
  const server = origCreate(...rest, wrapped);
  server.once("listening", () => {
    startBackgroundTokenRefreshFromCustomServer();
  });
  const origEmit = server.emit;
  // JBR 25 sends h2c upgrades that the HTTP/1.1 server would otherwise close.
  server.emit = function (event, ...eventArgs) {
    const [req, socket, head] = eventArgs;
    if (event !== "upgrade" || String(req.headers.upgrade || "").toLowerCase() !== "h2c") {
      return origEmit.call(this, event, ...eventArgs);
    }

    const contentLength = Number(req.headers["content-length"] || 0);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      socket.destroy();
      return true;
    }
    const chunks = [head];
    let received = head.length;
    const serve = () => {
      // Replay the upgraded request through the existing HTTP/1.1 handler.
      const replay = new http.IncomingMessage(socket);
      Object.assign(replay, { method: req.method, url: req.url, headers: req.headers, complete: true });
      if (received) replay.push(Buffer.concat(chunks, received).subarray(0, contentLength));
      replay.push(null);
      const res = new http.ServerResponse(replay);
      res.shouldKeepAlive = false;
      res.assignSocket(socket);
      res.once("finish", () => socket.end());
      Promise.resolve().then(() => wrapped(replay, res)).catch((error) => {
        console.error("Failed to downgrade h2c request", error);
        socket.destroy();
      });
    };
    if (received >= contentLength) serve();
    else {
      socket.on("data", function readBody(chunk) {
        chunks.push(chunk);
        received += chunk.length;
        if (received < contentLength) return;
        socket.off("data", readBody);
        serve();
      });
      socket.resume();
    }
    delete req.headers.upgrade;
    delete req.headers["http2-settings"];
    req.headers.connection = "close";
    return true;
  };
  return server;
};

if (require.main === module) {
  const standalone = path.join(__dirname, "server.js");
  if (fs.existsSync(standalone)) {
    require(standalone);
  } else {
    // Repo checkout has no standalone build next to us. `next start` builds its HTTP
    // server in-process, so the wrapper above still sanitizes every request.
    const nextBin = require.resolve("next/dist/bin/next");
    process.argv = [process.argv[0], nextBin, "start", ...process.argv.slice(2)];
    require(nextBin);
  }
}
