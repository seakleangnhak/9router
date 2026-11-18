"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, Button, Input } from "@/shared/components";
import { formatServiceTier as speedLabel } from "@/shared/utils/requestSpeed";
import RoutingHealth from "./RoutingHealth";

const ms = (value) => value == null ? "—" : `${value.toLocaleString()}\u00a0ms`;
const duration = (value) => value < 1000 ? ms(value) : `${(value / 1000).toLocaleString()}\u00a0s`;
const label = (value) => value?.replaceAll("_", " ") ?? "—";
const dateTime = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
const outcomes = {
  response_finished: ["Completed", "success"],
  upload_interrupted: ["Upload interrupted", "warning"],
  client_disconnected: ["Disconnected", "warning"],
  http_error: ["HTTP error", "error"],
  stream_error: ["Stream error", "error"],
};

function TraceRow({ trace, expand }) {
  const { requestId, startedAt, path, upload, uploadMs, expectedContentLength, clientTier, requestedTier, actualTier, firstTokenMs, status, durationMs, terminalReason, attempts, droppedAttempts } = trace;
  const [copyStatus, setCopyStatus] = useState("");
  const [outcome, variant] = outcomes[terminalReason] ?? ["In progress", "info"];
  return (
    <li>
      <details className="group/trace" open={expand || undefined}>
        <summary className="flex cursor-pointer list-none items-center gap-2 p-3 text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
          <span aria-hidden="true" className="material-symbols-outlined shrink-0 text-lg text-text-muted group-open/trace:rotate-90">chevron_right</span>
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
            <span className="w-full min-w-0 break-words font-medium text-text-main sm:w-auto sm:flex-1">{path}</span>
            <span className="flex shrink-0 items-center gap-2">
              <Badge variant={variant} className="text-text-main!">{outcome}</Badge>
              {status != null && <span className="text-xs tabular-nums text-text-muted"><span className="sr-only">HTTP </span>{status}</span>}
            </span>
            <span className="flex shrink-0 items-center gap-x-3 text-xs tabular-nums text-text-muted">
              <time dateTime={startedAt}>{dateTime.format(new Date(startedAt))}</time>
              {durationMs != null && <span className="sm:w-20 sm:text-right"><span className="sr-only">Duration: </span>{duration(durationMs)}</span>}
            </span>
          </span>
        </summary>
        <div className="space-y-3 border-t border-border px-4 py-3 sm:pl-9">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
            <span>Request ID</span>
            <code className="break-all text-text-main">{requestId}</code>
            {typeof navigator !== "undefined" && navigator.clipboard && (
              <Button type="button" size="xs" variant="ghost" onClick={async () => {
                try {
                  await navigator.clipboard.writeText(requestId);
                  setCopyStatus("Copied");
                } catch {
                  setCopyStatus("Copy failed");
                }
              }}>Copy ID</Button>
            )}
            <span role="status">{copyStatus}</span>
          </div>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {[
              ["Upload", `${label(upload)}${uploadMs == null ? "" : ` · ${ms(uploadMs)}`}`],
              ...(expectedContentLength == null ? [] : [["Expected size", `${expectedContentLength.toLocaleString()} B`]]),
              ["First upstream token", ms(firstTokenMs)],
              ["Requested speed", speedLabel(requestedTier, "Not set")],
              ["Actual speed", speedLabel(actualTier, terminalReason ? "Not reported" : "Not reported yet")],
              ...(clientTier !== requestedTier ? [["Client speed", speedLabel(clientTier, "Not set")]] : []),
            ].map(([name, value]) => (
              <div key={name}><dt className="text-text-muted">{name}</dt><dd className="text-text-main">{value}</dd></div>
            ))}
          </dl>
          <div>
            <h3 className="text-sm font-semibold">Routing attempts</h3>
            {attempts.length ? (
              <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-text-muted">
                {attempts.map((attempt, index) => (
                  <li key={index} className="break-words">
                    <span className="font-medium text-text-main">{attempt.provider}{attempt.model ? `/${attempt.model}` : ""}</span>
                    {` · +${ms(attempt.startedMs)} · ${label(attempt.outcome)}`}
                    {attempt.status != null && ` · HTTP ${attempt.status}`}
                    {attempt.upstreamStartedMs != null && ` · upstream at ${ms(attempt.upstreamStartedMs)}`}
                    {(attempt.upstreamStartedMs != null || attempt.forwardedTier !== undefined) && ` · forwarded ${speedLabel(attempt.forwardedTier, attempt.forwardedTier === null ? "no tier" : "not observed")}`}
                    {attempt.actualTier && ` · reported ${speedLabel(attempt.actualTier)}`}
                    {attempt.streamError && ` · ${label(attempt.streamError)}`}
                    {attempt.firstTokenMs != null && ` · first token at ${ms(attempt.firstTokenMs)}`}
                  </li>
                ))}
              </ol>
            ) : <p className="mt-1 text-sm text-text-muted">None</p>}
            {droppedAttempts > 0 && <p className="mt-1 text-sm text-text-muted">{droppedAttempts} more not retained</p>}
          </div>
        </div>
      </details>
    </li>
  );
}

export default function RequestTracesTab() {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState({ id: "" });
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    const params = query.id ? `?${new URLSearchParams({ id: query.id })}` : "";
    fetch(`/api/usage/request-traces${params}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (response.status === 400) return { error: "Enter a full request ID." };
        if (!response.ok) throw new Error("Request failed");
        return await response.json();
      })
      .then((data) => { if (!controller.signal.aborted) setResult({ query, data }); })
      .catch(() => { if (!controller.signal.aborted) setResult({ query, data: { error: "Could not load traces." } }); });
    return () => controller.abort();
  }, [query]);

  const data = result?.query.id === query.id ? result.data : null;
  const loading = result?.query !== query;
  return (
    <section aria-labelledby="request-traces-heading" className="space-y-3">
      <h2 id="request-traces-heading" className="sr-only">Request Traces</h2>
      {data?.enabled !== false && (
        <form role="search" aria-label="Request traces" className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); setQuery({ id: input.trim().toLowerCase() }); }}>
          <Input ref={inputRef} aria-label="Request ID" placeholder="Search by request ID" type="search" value={input} autoComplete="off" spellCheck={false} onChange={(event) => setInput(event.target.value)} className="min-w-32 flex-1 sm:max-w-xs" inputClassName="h-9" />
          <Button type="submit">Search</Button>
          <Button type="button" variant="secondary" aria-label="Refresh traces" title="Refresh traces" className="px-2.5" onClick={() => setQuery({ id: query.id })}>
            <span aria-hidden="true" className="material-symbols-outlined text-lg">refresh</span>
          </Button>
          {query.id && <Button type="button" variant="ghost" onClick={() => { setInput(""); setQuery({ id: "" }); inputRef.current?.focus(); }}>Clear</Button>}
        </form>
      )}
      <div aria-busy={loading} className="rounded-xl border border-border bg-surface">
        {!data ? <p role="status" className="p-4 text-sm text-text-muted">Loading traces…</p>
          : data.error ? <p role="alert" className="p-4 text-sm text-text-main">{data.error}</p>
            : !data.enabled ? (
              <div className="p-4 text-sm">
                <p className="font-medium">Trace capture is off</p>
                <p className="mt-1 break-words text-text-muted">{data.available ? "Restart with " : "Start custom-server.js with "}<code>NINEROUTER_REQUEST_TRACES=true</code>.</p>
              </div>
            ) : !data.traces.length ? <p role="status" className="p-4 text-sm text-text-muted">{query.id ? "No matching trace." : "No traces yet."}</p>
              : <ul className="divide-y divide-border">{data.traces.map((trace) => <TraceRow key={`${query.id}:${trace.requestId}`} trace={trace} expand={!!query.id} />)}</ul>}
      </div>
      {data?.enabled && <p className="text-xs text-text-muted">Metadata only · Clears on restart</p>}
      {data?.enabled && data.health && <RoutingHealth health={data.health} />}
    </section>
  );
}
