import { getProviderConnectionById } from "@/lib/db/index.js";
import { getCodexAutoReset, updateCodexAutoReset } from "@/lib/db/repos/codexResetRepo.js";
import { codexAutoResetStatus, codexResetAccountKey, configureCodexAutoReset } from "@/shared/services/codexAutoReset.js";
import { isAuthenticated } from "@/dashboardGuard";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

async function validConnection(connectionId) {
  const connection = await getProviderConnectionById(connectionId);
  return connection?.provider === "codex" && ["oauth", "access_token"].includes(connection.authType) ? connection : null;
}

export async function GET(request, { params }) {
  if (!await isAuthenticated(request)) return Response.json({ error: "Dashboard sign-in required." }, { status: 401, headers });
  const { connectionId } = await params;
  if (!await validConnection(connectionId)) return Response.json({ error: "Codex token connection not found." }, { status: 404, headers });
  return Response.json(codexAutoResetStatus(await getCodexAutoReset(connectionId)), { headers });
}

export async function PATCH(request, { params }) {
  if (!await isAuthenticated(request)) return Response.json({ error: "Dashboard sign-in required." }, { status: 401, headers });
  const origin = request.headers.get("origin");
  const allowedOrigins = [request.url, process.env.BASE_URL, process.env.NEXT_PUBLIC_BASE_URL]
    .filter(Boolean).flatMap((value) => { try { return [new URL(value).origin]; } catch { return []; } });
  if (origin && !allowedOrigins.includes(origin)) {
    return Response.json({ error: "Cross-origin changes are not allowed." }, { status: 403, headers });
  }
  const { connectionId } = await params;
  const connection = await validConnection(connectionId);
  if (!connection) return Response.json({ error: "Codex token connection not found." }, { status: 404, headers });
  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: "Invalid JSON." }, { status: 400, headers }); }
  if (!body || !["off", "auto", "smart"].includes(body.mode)) {
    return Response.json({ error: "Mode must be off, auto, or smart." }, { status: 400, headers });
  }
  if (body.mode !== "off" && body.acknowledged !== true) {
    return Response.json({ error: "Acknowledge irreversible reset-credit spending before enabling automatic resets." }, { status: 400, headers });
  }
  try {
    const state = await updateCodexAutoReset(connectionId, {
      mode: body.mode,
      accountKey: body.mode === "off" ? null : codexResetAccountKey(connection),
      reason: body.mode === "off" ? "Automatic reset disabled." : "Waiting for fresh quota, credit balance, and reset-bank data.",
      expiresAt: null,
    });
    await configureCodexAutoReset();
    return Response.json(codexAutoResetStatus(state), { headers });
  } catch {
    try {
      await updateCodexAutoReset(connectionId, { mode: "off", reason: "Configuration failed; automatic resets disabled." });
    } catch { /* A failed database write cannot safely enable new automation. */ }
    return Response.json({ error: "Could not configure automatic resets. Durable native SQLite is required." }, { status: 503, headers });
  }
}
