import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: async () => "fixture" }));

const originalDataDir = process.env.DATA_DIR;
let tempDir, db, createKey, updateKey, listKeys, deletePool, pool;

function request(body) {
  return new Request("http://localhost/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = (id) => ({ params: Promise.resolve({ id }) });

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-proxy-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  ({ POST: createKey, GET: listKeys } = await import("../../src/app/api/keys/route.js"));
  ({ PUT: updateKey } = await import("../../src/app/api/keys/[id]/route.js"));
  ({ DELETE: deletePool } = await import("../../src/app/api/proxy-pools/[id]/route.js"));
  pool = await db.createProxyPool({ name: "Private egress", proxyUrl: "http://fixture-user:fixture-password@proxy.invalid:8080" });
});

afterEach(() => {
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("per-key proxy persistence and management", () => {
  it("creates inherited or bound keys without exposing proxy credentials", async () => {
    const inherited = await createKey(request({ name: "Inherited" }));
    expect(inherited.status).toBe(201);
    expect((await inherited.json()).proxyPoolId).toBeNull();
    const created = await createKey(request({ name: "Bound", proxyPoolId: pool.id }));
    expect(created.status).toBe(201);
    const key = await created.json();
    expect(key.proxyPoolId).toBe(pool.id);
    expect((await db.getApiKeyByKey(key.key)).proxyPoolId).toBe(pool.id);
    const listed = await (await listKeys()).json();
    expect(listed.keys.find((entry) => entry.id === key.id).proxyPoolId).toBe(pool.id);
    expect(JSON.stringify({ key, listed })).not.toMatch(/fixture-user|fixture-password|proxy\.invalid|proxyUrl/);
  });

  it("preserves bindings, Fast mode, and access through independent updates, then clears explicitly", async () => {
    const key = await db.createApiKey("Policy", "fixture", false, "force", pool.id);
    const access = { restricted: true, allow: ["cx/gpt-6.1-sol"] };
    const changed = await updateKey(request({ access, isActive: false }), params(key.id));
    expect(changed.status).toBe(200);
    expect((await changed.json()).key).toMatchObject({ proxyPoolId: pool.id, fastMode: "force", access, isActive: false });
    const cleared = await updateKey(request({ proxyPoolId: null }), params(key.id));
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).key).toMatchObject({ proxyPoolId: null, fastMode: "force", access, isActive: false });
    const rebound = await updateKey(request({ proxyPoolId: pool.id }), params(key.id));
    expect(rebound.status).toBe(200);
    expect((await rebound.json()).key.proxyPoolId).toBe(pool.id);
  });

  it.each(["", " ", true, 1, [], {}, "missing-pool"])("rejects invalid proxy binding %j without mutation", async (proxyPoolId) => {
    const key = await db.createApiKey("Unchanged", "fixture", false, "on", pool.id);
    const before = await db.getApiKeyById(key.id);
    expect((await createKey(request({ name: "Invalid", proxyPoolId }))).status).toBe(400);
    expect((await updateKey(request({ proxyPoolId, isActive: false }), params(key.id))).status).toBe(400);
    expect(await db.getApiKeyById(key.id)).toEqual(before);
    expect(await db.getApiKeys()).toHaveLength(1);
  });

  it.each([
    { isActive: false },
    { proxyUrl: "" },
    { proxyUrl: "   " },
    { proxyUrl: "http://[invalid" },
    { proxyUrl: "socks5://proxy.invalid:1080" },
    { proxyUrl: "file:///secret" },
  ])("rejects unavailable pool %j while allowing unrelated key updates", async (updates) => {
    const key = await db.createApiKey("Existing", "fixture", false, "off", pool.id);
    await db.updateProxyPool(pool.id, updates);
    expect((await createKey(request({ name: "Invalid", proxyPoolId: pool.id }))).status).toBe(400);
    expect((await updateKey(request({ proxyPoolId: pool.id }), params(key.id))).status).toBe(400);
    expect((await updateKey(request({ fastMode: "on" }), params(key.id))).status).toBe(200);
    expect((await db.getApiKeyById(key.id)).proxyPoolId).toBe(pool.id);
  });

  it.each(["proxy.invalid:8080", "https://proxy.invalid:8443"])("accepts supported pool URL %s", async (proxyUrl) => {
    await db.updateProxyPool(pool.id, { proxyUrl });
    const created = await createKey(request({ name: "Supported", proxyPoolId: pool.id }));
    expect(created.status).toBe(201);
    expect((await created.json()).proxyPoolId).toBe(pool.id);
  });

  it("round-trips bindings in backups and restores old backups as inherited", async () => {
    const key = await db.createApiKey("Backup", "fixture", false, "force", pool.id);
    const snapshot = await db.exportDb();
    expect(snapshot.apiKeys[0].proxyPoolId).toBe(pool.id);
    await db.updateApiKey(key.id, { proxyPoolId: null });
    await db.importDb(snapshot);
    expect((await db.getApiKeyById(key.id)).proxyPoolId).toBe(pool.id);
    const legacy = { ...snapshot, apiKeys: snapshot.apiKeys.map(({ proxyPoolId, ...rest }) => rest) };
    await db.importDb(legacy);
    expect((await db.getApiKeyById(key.id)).proxyPoolId).toBeNull();
    for (const proxyPoolId of ["", 0, false, {}]) {
      await expect(db.importDb({ ...snapshot, apiKeys: [{ ...snapshot.apiKeys[0], proxyPoolId }] })).rejects.toThrow(/proxyPoolId/);
      expect((await db.getApiKeyById(key.id)).proxyPoolId).toBeNull();
      expect(await db.getProxyPoolById(pool.id)).not.toBeNull();
    }
    // Preserve an unavailable binding so restoring cannot silently enable direct egress.
    await db.importDb({ ...snapshot, proxyPools: [] });
    expect((await db.getApiKeyById(key.id)).proxyPoolId).toBe(pool.id);
  });

  it("blocks deleting a pool bound to an inactive key until binding is removed", async () => {
    const key = await db.createApiKey("Paused", "fixture", false, "off", pool.id);
    await db.updateApiKey(key.id, { isActive: false });
    const blocked = await deletePool(request({}), params(pool.id));
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ boundConnectionCount: 0, boundKeyCount: 1 });
    expect(await db.getProxyPoolById(pool.id)).not.toBeNull();
    await db.updateApiKey(key.id, { proxyPoolId: null });
    expect((await deletePool(request({}), params(pool.id))).status).toBe(200);
    expect(await db.getProxyPoolById(pool.id)).toBeNull();
  });
});
