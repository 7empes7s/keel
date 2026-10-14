/**
 * The content item index (Wave 1, package CONT): which items the content store holds
 * and which chunks make each one up. Tables are in engine/store/schema.d/70-content.sql.
 *
 * Two implementations with one shape, used by ./store.mjs:
 *   hasChunk(id) -> boolean
 *   addChunk({ id, keyId, objectName, plainBytes, storedBytes })
 *   findItem({ tenantRef, workload, container, itemKey, version }) -> row | null
 *   insertItem(row) -> the stored row (the existing one when that version is already held)
 *   getItem(id) -> row | null
 *   listItems({ container, since, after, tenantRef, workload, limit }) -> rows, oldest first
 *     `since` is inclusive (an item stored in that millisecond is listed again, never
 *     dropped). `after` is an exact cursor: the { createdAt, id } of the last row read;
 *     rows sort by (createdAt, id), so paging with it neither repeats nor skips.
 * A row is { id, tenantRef, workload, container, itemKey, version, metadata, sha256,
 * bytes, chunks: [[chunkId, plainBytes], ...], keyId, newBytes, createdAt }.
 */
import { randomUUID } from 'node:crypto';

const ITEM_COLUMNS = `id, tenant_ref, workload, container, item_key, version, metadata, sha256, bytes, chunks, key_id, new_bytes, created_at`;

function fromRow(row) {
  return row ? {
    id: row.id, tenantRef: row.tenant_ref, workload: row.workload, container: row.container, itemKey: row.item_key,
    version: row.version, metadata: row.metadata, sha256: row.sha256, bytes: Number(row.bytes), chunks: row.chunks,
    keyId: row.key_id, newBytes: Number(row.new_bytes), createdAt: row.created_at,
  } : null;
}

/** The Postgres index. `client` is a pg client or pool on a database with the full schema. */
export function createPgContentIndex(client) {
  const findItem = async ({ tenantRef, workload, container, itemKey, version }) => fromRow((await client.query(
    `SELECT ${ITEM_COLUMNS} FROM content_item
      WHERE tenant_ref = $1 AND workload = $2 AND container = $3 AND item_key = $4 AND version = $5`,
    [tenantRef, workload, container, itemKey, version],
  )).rows[0]);
  return Object.freeze({
    async hasChunk(id) {
      return (await client.query('SELECT 1 FROM content_chunk WHERE id = $1', [id])).rowCount > 0;
    },
    async addChunk({ id, keyId, objectName, plainBytes, storedBytes }) {
      await client.query(
        `INSERT INTO content_chunk (id, key_id, object_name, plain_bytes, stored_bytes) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [id, keyId, objectName, plainBytes, storedBytes],
      );
    },
    findItem,
    async insertItem(row) {
      const { rows: [inserted] } = await client.query(
        `INSERT INTO content_item (tenant_ref, workload, container, item_key, version, metadata, sha256, bytes, chunks, key_id, new_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (tenant_ref, workload, container, item_key, version) DO NOTHING
         RETURNING ${ITEM_COLUMNS}`,
        [row.tenantRef, row.workload, row.container, row.itemKey, row.version, row.metadata, row.sha256, row.bytes,
          JSON.stringify(row.chunks), row.keyId, row.newBytes],
      );
      return fromRow(inserted) ?? findItem(row);
    },
    async getItem(id) {
      return fromRow((await client.query(`SELECT ${ITEM_COLUMNS} FROM content_item WHERE id = $1`, [id])).rows[0]);
    },
    async listItems({ container, since = null, after = null, tenantRef = null, workload = null, limit = 1000 }) {
      const { rows } = await client.query(
        `SELECT ${ITEM_COLUMNS} FROM content_item
          WHERE container = $1 AND ($2::timestamptz IS NULL OR created_at >= $2)
            AND ($3::text IS NULL OR tenant_ref = $3) AND ($4::text IS NULL OR workload = $4)
            AND ($6::timestamptz IS NULL OR (created_at, id) > ($6, $7::uuid))
          ORDER BY created_at, id LIMIT $5`,
        [container, since, tenantRef, workload, limit, after?.createdAt ?? null, after?.id ?? null],
      );
      return rows.map(fromRow);
    },
  });
}

/** The same index in memory, for fixtures (createMemoryContentStore). */
export function createMemoryContentIndex({ now = () => new Date() } = {}) {
  const chunks = new Map();
  const items = new Map();
  const keyOf = ({ tenantRef, workload, container, itemKey, version }) => JSON.stringify([tenantRef, workload, container, itemKey, version]);
  const byKey = new Map();
  let sequence = 0;
  return Object.freeze({
    chunks,
    items,
    async hasChunk(id) { return chunks.has(id); },
    async addChunk(chunk) { if (!chunks.has(chunk.id)) chunks.set(chunk.id, { ...chunk }); },
    async findItem(identity) { return byKey.get(keyOf(identity)) ?? null; },
    async insertItem(row) {
      const held = byKey.get(keyOf(row));
      if (held) return held;
      // Strictly increasing times, so `since` paging is exact even within one millisecond.
      const at = new Date(Math.max(now().valueOf(), sequence + 1));
      sequence = at.valueOf();
      const stored = Object.freeze({ ...row, id: randomUUID(), createdAt: at });
      items.set(stored.id, stored);
      byKey.set(keyOf(row), stored);
      return stored;
    },
    async getItem(id) { return items.get(id) ?? null; },
    async listItems({ container, since = null, after = null, tenantRef = null, workload = null, limit = 1000 }) {
      const past = (row) => !after || row.createdAt > after.createdAt || (+row.createdAt === +after.createdAt && row.id > after.id);
      return [...items.values()]
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .filter((row) => row.container === container && (!since || row.createdAt >= since) && past(row)
          && (!tenantRef || row.tenantRef === tenantRef) && (!workload || row.workload === workload))
        .slice(0, limit);
    },
  });
}
