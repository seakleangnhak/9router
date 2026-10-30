import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const holder = vi.hoisted(() => ({ adapter: null }));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: async () => holder.adapter }));
import {
  getCodexAutoReset, updateCodexAutoReset, listEnabledCodexAutoResets,
  claimCodexResetAccount, updateCodexResetAccount, releaseCodexResetAccount,
} from "@/lib/db/repos/codexResetRepo.js";
const { DatabaseSync } = await import("node:sqlite").catch(() => ({ DatabaseSync: null }));

describe.skipIf(!DatabaseSync)("Codex durable reset state", () => {
  let db;
  let scratch;
  let path;
  function open() {
    db = new DatabaseSync(path);
    db.exec("CREATE TABLE IF NOT EXISTS kv(scope TEXT, key TEXT, value TEXT, PRIMARY KEY(scope,key))");
    holder.adapter = {
      driver: "node:sqlite",
      get: (sql, params) => db.prepare(sql).get(...params),
      all: (sql, params) => db.prepare(sql).all(...params),
      run: (sql, params) => db.prepare(sql).run(...params),
      transaction: (fn) => {
        db.exec("BEGIN IMMEDIATE");
        try { const result = fn(); db.exec("COMMIT"); return result; }
        catch (error) { db.exec("ROLLBACK"); throw error; }
      },
    };
  }
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "codex-reset-test-"));
    path = join(scratch, "fixture.sqlite");
    open();
  });
  afterEach(() => { db.close(); rmSync(scratch, { recursive: true, force: true }); });

  it("defaults to Off and persists independent per-connection modes across reopen", async () => {
    expect((await getCodexAutoReset("new")).mode).toBe("off");
    await updateCodexAutoReset("a", { mode: "smart" });
    await updateCodexAutoReset("b", { mode: "auto" });
    await updateCodexAutoReset("a", { reason: "Learning usage" });
    db.close(); open();
    expect(await getCodexAutoReset("a")).toMatchObject({ mode: "smart", reason: "Learning usage" });
    expect((await listEnabledCodexAutoResets()).map((entry) => entry.connectionId).sort()).toEqual(["a", "b"]);
    await updateCodexAutoReset("a", { mode: "off" });
    expect((await listEnabledCodexAutoResets()).map((entry) => entry.connectionId)).toEqual(["b"]);
  });

  it("persists pending ID after lease release and database reopen", async () => {
    await claimCodexResetAccount("account", "owner", Date.now(), 60000);
    await updateCodexResetAccount("account", "owner", { pending: { redeemRequestId: "same-id", creditId: "selected-credit" } });
    await releaseCodexResetAccount("account", "owner");
    db.close(); open();
    const next = await claimCodexResetAccount("account", "next-owner", Date.now(), 60000);
    expect(next.pending).toEqual({ redeemRequestId: "same-id", creditId: "selected-credit" });
  });

  it("excludes competing owners and never releases another owner's lease", async () => {
    await claimCodexResetAccount("account", "owner", Date.now(), 60000);
    expect(await claimCodexResetAccount("account", "other", Date.now(), 60000)).toBeNull();
    await releaseCodexResetAccount("account", "other");
    expect(await claimCodexResetAccount("account", "other", Date.now(), 60000)).toBeNull();
    await expect(updateCodexResetAccount("account", "other", { pending: null })).rejects.toThrow("lock expired");
  });

  it("reclaims expired lease without losing previous redemption intent", async () => {
    const start = Date.now();
    await claimCodexResetAccount("account", "old", start, 60000);
    await updateCodexResetAccount("account", "old", { pending: { redeemRequestId: "keep-id" } });
    const next = await claimCodexResetAccount("account", "new", start + 60001, 60000);
    expect(next).toMatchObject({ leaseOwner: "new", pending: { redeemRequestId: "keep-id" } });
    await releaseCodexResetAccount("account", "old");
    expect(await claimCodexResetAccount("account", "third", start + 60002, 60000)).toBeNull();
  });

  it("blocks automatic spending on sql.js even for a previously enabled account", async () => {
    await updateCodexAutoReset("a", { mode: "smart" });
    holder.adapter.driver = "sql.js";
    await expect(updateCodexAutoReset("a", { mode: "auto" })).rejects.toThrow("native SQLite");
    await expect(claimCodexResetAccount("account", "owner", Date.now(), 60000)).rejects.toThrow("native SQLite");
    expect(await claimCodexResetAccount("account", "manual", Date.now(), 60000, false)).toBeTruthy();
    expect((await updateCodexAutoReset("a", { mode: "off" })).mode).toBe("off");
  });
});
