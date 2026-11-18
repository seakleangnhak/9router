const rate = (count, total) => total ? `${(100 * count / total).toFixed(1)}% (${count}/${total})` : "—";

export default function RoutingHealth({ health }) {
  return (
    <section aria-labelledby="routing-health-heading" className="space-y-2">
      <h3 id="routing-health-heading" className="text-sm font-semibold">Routing Health</h3>
      <p className="text-xs text-text-muted">{health.traceCount} traces · {health.clientDisconnects} client disconnects{health.interruptedUploads > 0 && ` · ${health.interruptedUploads} interrupted uploads`}{health.truncatedTraces > 0 && ` · ${health.truncatedTraces} traces truncated`}</p>
      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        {health.providers.length ? <table className="w-full table-fixed text-left text-xs sm:table-auto sm:text-sm">
          <caption className="sr-only">Routing health by provider. Account fallback is the share of classified attempts with an account fallback decision; combo transitions are not counted. Upstream errors are the share of attempts with an observed upstream HTTP status of 400 or higher or a stream error, among attempts with an observed upstream HTTP status. First token latency is measured from upstream execution start. Unfinished traces, client disconnects and interrupted uploads are excluded.</caption>
          <thead className="border-b border-border text-xs text-text-muted"><tr>
            <th scope="col" className="p-2 sm:p-3">Provider</th>
            <th scope="col" aria-label="Account fallback" className="p-2 sm:p-3"><span className="hidden sm:inline">Account </span>Fallback</th>
            <th scope="col" aria-label="Upstream errors" className="p-2 sm:p-3"><span className="hidden sm:inline">Upstream </span>Errors</th>
            <th scope="col" aria-label="Median first token" className="p-2 sm:p-3"><span className="hidden sm:inline">Median </span>First token</th>
          </tr></thead>
          <tbody className="divide-y divide-border">{health.providers.map((row) => <tr key={row.provider}>
            <th scope="row" className="wrap-anywhere p-2 font-medium sm:p-3">{row.provider}</th>
            <td className="p-2 tabular-nums sm:whitespace-nowrap sm:p-3">{rate(row.fallbacks, row.attempts)}</td>
            <td className="p-2 tabular-nums sm:whitespace-nowrap sm:p-3">{rate(row.upstreamErrors, row.upstreamSamples)}</td>
            <td className="p-2 tabular-nums sm:whitespace-nowrap sm:p-3">{row.medianFirstTokenMs == null ? "—" : `${row.medianFirstTokenMs.toLocaleString()} ms (n=${row.latencySamples})`}</td>
          </tr>)}</tbody>
        </table> : <p className="p-4 text-sm text-text-muted">No routing attempts yet.</p>}
      </div>
    </section>
  );
}
