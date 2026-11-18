import { readRequestTraces } from "@/lib/requestTraces.js";
import { aggregateRoutingHealth } from "@/lib/routingHealth.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function GET(request) {
  const id = new URL(request.url).searchParams.get("id");
  const headers = { "Cache-Control": "no-store" };
  if (id !== null && !UUID.test(id)) {
    return Response.json({ error: "Enter a full request ID." }, { status: 400, headers });
  }
  const history = readRequestTraces();
  const result = id ? readRequestTraces(id.toLowerCase()) : history;
  return Response.json({ ...result, health: history.enabled ? aggregateRoutingHealth(history.traces) : null }, { headers });
}
