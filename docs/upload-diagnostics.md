# Diagnose slow OpenCode uploads

Prior captures showed Traefik cutting off some requests at its 60-second read deadline before 9Router routed them. That identifies the cutoff, not why an upload was slow. Measure through the same ingress before changing limits.

1. Start `custom-server.js` temporarily with `NINEROUTER_REQUEST_DIAGNOSTICS=true` and `NINEROUTER_REQUEST_TRACES=true`. Use the following Traefik JSON access log only on isolated synthetic traffic: Traefik logs the raw header before 9Router can validate it.

   ```yaml
   accessLog:
     format: json
     fields:
       defaultMode: drop
       names:
         StartUTC: keep
         Duration: keep
         OriginDuration: keep
         DownstreamStatus: keep
         OriginStatus: keep
       headers:
         defaultMode: drop
         names:
           X-9Router-Probe-Id: keep
           X-9Router-Request-Id: keep
   ```

2. Make one normal OpenCode request and note its UTC start, upload size, and any `X-9Router-Request-Id` returned. Match Traefik's `response_` header, not a caller-supplied request header. Compare with isolated synthetic uploads: send the same body once at normal speed, once throttled, and once directly to 9Router at the same throttle if available. Use a fresh lowercase UUIDv4 in `X-9Router-Probe-Id` for each synthetic request. Match `request_x-9router-probe-id` case-insensitively in Traefik JSON to `probeId` in `[RequestDiagnostics]`; use the resulting 9Router `requestId` to open the trace. Unmarked failures with no response ID can only be matched approximately by time.

   ```sh
   # Test endpoint, no real prompt or provider key. This isolates body upload.
   node -e 'process.stdout.write(JSON.stringify({input:"x".repeat(80*1024)}))' > probe.json
   PROBE_ID=$(node -p 'require("node:crypto").randomUUID()')
   curl --http1.1 --max-time 120 --limit-rate 1k -sS -D - -o /dev/null \
     -H "X-9Router-Probe-Id: $PROBE_ID" -H 'Content-Type: application/json' \
     --data-binary @probe.json https://YOUR-TEST-INGRESS/v1/responses
   ```

3. Read the evidence:
   - **Edge row, no matching 9Router log:** ingress did not reach the normal request handler. Check proxy buffering and h2c; a disconnect before h2c replay cannot appear in Request Traces.
   - **`bodyComplete: false`, `bodyReadMs: null`:** upload broke before routing. Compare wall time with the entrypoint's `readTimeout` and compare direct versus proxied throughput.
   - **`bodyReadMs` recorded; upstream start recorded:** upload completed. Compare the gap to upstream start, then to first token, to separate router delay from upstream work. A gap without upstream start is not proof of provider latency.
   - **`responseCompletedEventWritten: true` with `response_closed`:** 9Router wrote the Responses completion event before the connection closed. This does not prove the client received it; do not treat it as an upload timeout.

Disable temporary logging after capture. Do not retain authorization headers, cookies, request bodies, or query strings. Probe IDs are caller-supplied markers, not trusted identity. Do not change Traefik limits based on one probe.
