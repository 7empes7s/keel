/**
 * Delta state for the content collectors, kept between runs (table content_sync_state,
 * engine/store/schema.d/71-content-sync-state.sql). A row is keyed by tenant, workload
 * and a state key (a mailbox, a OneDrive, a SharePoint library); its state is the
 * collector's own plain JSON. Two implementations with one shape:
 *   load({ tenantRef, workload, key }) -> state | null
 *   save({ tenantRef, workload, key, state })
 */
function requireKey({ tenantRef, workload, key }) {
  for (const [name, value] of Object.entries({ tenantRef, workload, key })) {
    if (typeof value !== 'string' || !value) throw new TypeError(`content sync state needs a ${name}`);
  }
}

/** The Postgres state store. `client` is a pg client or pool on a database with the full schema. */
export function createPgSyncState(client) {
  if (typeof client?.query !== 'function') throw new TypeError('content sync state needs a database client');
  return Object.freeze({
    async load(ref) {
      requireKey(ref);
      const { rows } = await client.query(
        'SELECT state FROM content_sync_state WHERE tenant_ref = $1 AND workload = $2 AND state_key = $3',
        [ref.tenantRef, ref.workload, ref.key],
      );
      return rows[0]?.state ?? null;
    },
    async save({ state, ...ref }) {
      requireKey(ref);
      await client.query(
        `INSERT INTO content_sync_state (tenant_ref, workload, state_key, state) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_ref, workload, state_key) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
        [ref.tenantRef, ref.workload, ref.key, JSON.stringify(state ?? null)],
      );
    },
  });
}

/** The same shape over memory, for fixture tests. States are copied in and out. */
export function createMemorySyncState() {
  const rows = new Map();
  const id = ({ tenantRef, workload, key }) => JSON.stringify([tenantRef, workload, key]);
  return Object.freeze({
    rows,
    async load(ref) {
      requireKey(ref);
      return rows.has(id(ref)) ? structuredClone(rows.get(id(ref))) : null;
    },
    async save({ state, ...ref }) {
      requireKey(ref);
      rows.set(id(ref), structuredClone(state ?? null));
    },
  });
}
