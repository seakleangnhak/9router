import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { resolveFastMode } from "../helpers/apiKeyFastMode.js";

function rowToKey(row) {
  if (!row) return null;
  const fastMode = resolveFastMode(row);
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    allowFastMode: fastMode !== "off",
    fastMode,
    createdAt: row.createdAt,
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId, allowFastMode = false, fastMode) {
  if (!machineId) throw new Error("machineId is required");
  fastMode = resolveFastMode({ fastMode, allowFastMode });
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    allowFastMode: fastMode !== "off",
    fastMode,
    createdAt: new Date().toISOString(),
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, allowFastMode, fastMode, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.allowFastMode ? 1 : 0, fastMode, apiKey.createdAt]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    merged.fastMode = resolveFastMode(data.fastMode !== undefined || data.allowFastMode !== undefined ? data : row);
    merged.allowFastMode = merged.fastMode !== "off";
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, allowFastMode = ?, fastMode = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, merged.allowFastMode ? 1 : 0, merged.fastMode, id]
    );
    result = merged;
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}

export async function canUseFastMode(key) {
  return await getApiKeyFastMode(key) !== "off";
}

export async function getApiKeyFastMode(key) {
  if (!key) return "off";
  const db = await getAdapter();
  const row = db.get(`SELECT fastMode, allowFastMode FROM apiKeys WHERE key = ? AND isActive = 1`, [key]);
  return row ? resolveFastMode(row) : "off";
}
