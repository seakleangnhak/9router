import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const CONFIG_SCOPE = "codexAutoReset";
const ACCOUNT_SCOPE = "codexResetAccounts";

function read(db, scope, key) {
  return parseJson(db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [scope, key])?.value, {});
}

function write(db, scope, key, value) {
  db.run("INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value", [scope, key, stringifyJson(value)]);
}

export async function getCodexAutoReset(connectionId) {
  const db = await getAdapter();
  return { mode: "off", reason: "Automatic reset disabled.", ...read(db, CONFIG_SCOPE, connectionId) };
}

export async function listEnabledCodexAutoResets() {
  const db = await getAdapter();
  return db.all("SELECT key, value FROM kv WHERE scope = ?", [CONFIG_SCOPE])
    .map((row) => ({ connectionId: row.key, ...parseJson(row.value, {}) }))
    .filter((state) => state.mode === "auto" || state.mode === "smart");
}

export async function updateCodexAutoReset(connectionId, patch) {
  const db = await getAdapter();
  // ponytail: automatic spending requires durable native SQLite; add synchronous sql.js persistence before enabling its fallback.
  if (db.driver === "sql.js" && patch.mode && patch.mode !== "off") {
    throw new Error("Automatic resets require a native SQLite driver.");
  }
  let next;
  db.transaction(() => {
    next = { mode: "off", ...read(db, CONFIG_SCOPE, connectionId), ...patch };
    write(db, CONFIG_SCOPE, connectionId, next);
  });
  return next;
}

export async function claimCodexResetAccount(accountKey, owner, nowMs, leaseMs, requireDurable = true) {
  const db = await getAdapter();
  if (requireDurable && db.driver === "sql.js") throw new Error("Automatic resets require a native SQLite driver.");
  let account = null;
  db.transaction(() => {
    const current = read(db, ACCOUNT_SCOPE, accountKey);
    if (current.leaseUntil > nowMs) return;
    account = { ...current, leaseOwner: owner, leaseUntil: nowMs + leaseMs };
    write(db, ACCOUNT_SCOPE, accountKey, account);
  });
  return account;
}

export async function updateCodexResetAccount(accountKey, owner, patch) {
  const db = await getAdapter();
  let next;
  db.transaction(() => {
    const current = read(db, ACCOUNT_SCOPE, accountKey);
    if (current.leaseOwner !== owner || current.leaseUntil <= Date.now()) throw new Error("Codex reset lock expired.");
    next = { ...current, ...patch };
    write(db, ACCOUNT_SCOPE, accountKey, next);
  });
  return next;
}

export async function releaseCodexResetAccount(accountKey, owner) {
  const db = await getAdapter();
  db.transaction(() => {
    const current = read(db, ACCOUNT_SCOPE, accountKey);
    if (current.leaseOwner !== owner) return;
    delete current.leaseOwner;
    delete current.leaseUntil;
    write(db, ACCOUNT_SCOPE, accountKey, current);
  });
}
