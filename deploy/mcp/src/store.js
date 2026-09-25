import pg from "pg";
import { config } from "./config.js";

let pool = null;
export function getPool() {
  if (!pool) pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });
  return pool;
}
export async function closePool() {
  if (pool) await pool.end();
  pool = null;
}

// Все значения ключей вкладки (prefix-*) → Map(key → value).
export async function readPrefix(prefix) {
  const { rows } = await getPool().query(
    "SELECT key, value FROM kv_store WHERE key LIKE $1",
    [`${prefix}-%`]
  );
  return new Map(rows.map((r) => [r.key, r.value]));
}

// Атомарное изменение ключей вкладки. Совместимо с сайтом: каждая запись
// повышает version, поэтому открытая страница при следующем сохранении
// получит 409 и сольёт наши правки со своими, а не затрёт их.
// mutate(kv) получает Map(key → value) всех ключей вкладки (изменять можно
// прямо её) и возвращает результат для ответа.
export async function updatePrefix(prefix, mutate) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Сериализует одновременные записи MCP в одну вкладку, в т.ч. создание
    // ещё не существующих ключей (их нельзя заблокировать через FOR UPDATE).
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`pmo-mcp:${prefix}`]);
    const { rows } = await client.query(
      "SELECT key, value, version FROM kv_store WHERE key LIKE $1 ORDER BY key FOR UPDATE",
      [`${prefix}-%`]
    );
    const before = new Map(rows.map((r) => [r.key, JSON.stringify(r.value)]));
    const kv = new Map(rows.map((r) => [r.key, r.value]));
    const result = await mutate(kv);
    for (const [key, value] of kv) {
      const json = JSON.stringify(value);
      if (before.get(key) === json) continue;
      if (before.has(key)) {
        await client.query(
          "UPDATE kv_store SET value = $2, updated_at = now(), version = version + 1 WHERE key = $1",
          [key, json]
        );
      } else {
        await client.query(
          `INSERT INTO kv_store (key, value, updated_at, version) VALUES ($1, $2, now(), 1)
           ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now(), version = kv_store.version + 1`,
          [key, json]
        );
      }
    }
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Однократно проставляет служебные _rid строкам, у которых их нет (данные,
// сохранённые до появления ID). Правило то же, что в браузере, поэтому
// открытые страницы вычисляют у себя ровно такие же ID.
export async function normalizeRowIds(ensureRowIds) {
  const client = await getPool().connect();
  let changed = 0;
  try {
    const { rows } = await client.query("SELECT key FROM kv_store");
    for (const { key } of rows) {
      await client.query("BEGIN");
      const cur = await client.query("SELECT value FROM kv_store WHERE key = $1 FOR UPDATE", [key]);
      if (cur.rows.length && ensureRowIds(key, cur.rows[0].value)) {
        await client.query(
          "UPDATE kv_store SET value = $2, updated_at = now(), version = version + 1 WHERE key = $1",
          [key, JSON.stringify(cur.rows[0].value)]
        );
        changed++;
      }
      await client.query("COMMIT");
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return changed;
}

export async function ensureVersionColumn() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await getPool().query("ALTER TABLE kv_store ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1");
}
