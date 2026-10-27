/**
 * Object names, not ids (insights track, IN-NAMES).
 *
 * Given a tenant and a batch of ids, says what each one is in words a reader knows:
 * the kind of object (from taxonomy.mjs) and its display name from the newest backup
 * that holds it. Each id comes back with a status:
 *
 * - `found`: the newest complete backup that read its kind still holds it.
 * - `deleted`: an earlier backup held it, and a later complete backup that read its
 *   kind did not. `deletedSince` is when that later backup started, and the name is
 *   the one it last had.
 * - `unknown`: no backup holds it. The name is the readable part of the key, if any.
 *
 * An id is a backup key ("group:Finance", "conditionalAccessPolicy:<id>") or a
 * Microsoft object id (the `id` or `appId` in the saved object). Names that hold an
 * object id are never returned, so a caller can show `name` without checking it.
 */
import { objectNameSql } from '../cir/objectName.mjs';
import { typeInfo } from './taxonomy.mjs';

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const BARE_GUID = new RegExp(`^${GUID.source}$`, 'i');
const NAME_SQL = objectNameSql('rv.payload', 'rv.resource_type');

/** At most this many ids per call; the rest come back unknown (bounded work per page). */
export const MAX_NAME_IDS = 2000;

/** True when the text holds an object id, so it must not be shown as a name. */
export const holdsGuid = (text) => GUID.test(String(text ?? ''));

const usableName = (value) => {
  const name = typeof value === 'string' ? value.trim() : '';
  return name && !holdsGuid(name) ? name : null;
};

/** The kind a backup key is stored under ("group" for "group:Finance"), or null. */
function keyType(key) {
  const index = key.indexOf(':');
  if (index <= 0) return null;
  const type = key.slice(0, index);
  return /^[a-z][A-Za-z0-9]*$/.test(type) ? type : null;
}

/** The readable part of a backup key ("Finance" for "group:Finance"), or null. */
function keyName(key) {
  const type = keyType(key);
  if (!type) return null;
  return usableName(key.slice(type.length + 1).replaceAll(':', ' · '));
}

/**
 * What a reader sees for one id, from what is known about it. Pure.
 * @param {string} id
 * @param {{ resourceType?: string | null, name?: string | null, objectId?: string | null,
 *   status: 'found' | 'deleted' | 'unknown', lastSeenAt?: string | null, deletedSince?: string | null }} entry
 */
export function describeObject(id, entry) {
  const type = entry.resourceType ?? keyType(id);
  const info = type ? typeInfo(type) : null;
  return {
    id,
    type: type ?? null,
    typeName: info?.name ?? 'Object',
    service: info?.service ?? null,
    name: usableName(entry.name) ?? (BARE_GUID.test(id) ? null : keyName(id)),
    objectId: typeof entry.objectId === 'string' && entry.objectId ? entry.objectId : null,
    status: entry.status,
    lastSeenAt: entry.lastSeenAt ?? null,
    deletedSince: entry.status === 'deleted' ? entry.deletedSince ?? null : null,
  };
}

/**
 * "Group · Finance", "Group · Finance (deleted since 2026-10-03)" or "Group · unnamed":
 * the plain one-line form for text that cannot carry a badge (CSV, logs, toasts).
 */
export function objectLabelText(object) {
  const name = object.name ?? 'unnamed';
  const gone = object.status === 'deleted' && object.deletedSince ? ` (deleted since ${object.deletedSince.slice(0, 10)})` : '';
  return `${object.typeName} · ${name}${gone}`;
}

const iso = (value) => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
};

// When a key went: the start of the first complete backup after its last sighting
// that read its kind but no longer held the key. Times stay in SQL, so microseconds
// are never lost on the way through JavaScript (lesson 2026-10-15).
const goneSinceSql = (key, type, lastSeen) => `(SELECT min(s2.started_at) FROM snapshot s2
   WHERE s2.tenant_ref = $1 AND s2.status = 'complete' AND s2.started_at > ${lastSeen}
     AND EXISTS (SELECT 1 FROM resource_version r2 WHERE r2.snapshot_id = s2.id AND r2.resource_type = ${type})
     AND NOT EXISTS (SELECT 1 FROM resource_version r3 WHERE r3.snapshot_id = s2.id AND r3.natural_key = ${key}))`;

// For each wanted id, the newest saved version of the object it names (by backup key,
// or by the object's id or app id), its newest non-empty name, and the first complete
// backup after it that read its kind but no longer held it.
const LOOKUP_SQL = `
  WITH wanted AS (SELECT unnest($2::text[]) AS id),
  hits AS (
    SELECT w.id AS wanted, rv.natural_key, rv.resource_type, ${NAME_SQL} AS name,
           rv.payload->>'id' AS object_id, s.started_at, s.id AS snapshot_id
      FROM wanted w
      JOIN resource_version rv ON rv.natural_key = w.id
      JOIN snapshot s ON s.id = rv.snapshot_id AND s.tenant_ref = $1
    UNION ALL
    SELECT w.id, rv.natural_key, rv.resource_type, ${NAME_SQL}, rv.payload->>'id', s.started_at, s.id
      FROM wanted w
      JOIN snapshot s ON s.tenant_ref = $1
      JOIN resource_version rv ON rv.snapshot_id = s.id
     WHERE cardinality($3::text[]) > 0 AND w.id = ANY($3::text[])
       AND (lower(rv.payload->>'id') = lower(w.id) OR lower(rv.payload->>'appId') = lower(w.id))
  ),
  newest AS (
    SELECT DISTINCT ON (wanted) wanted, natural_key, resource_type, object_id, started_at AS last_seen, snapshot_id AS last_snapshot
      FROM hits ORDER BY wanted, started_at DESC, natural_key
  ),
  named AS (
    SELECT DISTINCT ON (wanted) wanted, name
      FROM hits WHERE name IS NOT NULL AND name !~* '${GUID.source}'
     ORDER BY wanted, started_at DESC
  )
  SELECT n.wanted, n.natural_key, n.resource_type, n.object_id, n.last_seen, m.name,
         ${goneSinceSql('n.natural_key', 'n.resource_type', 'n.last_seen')} AS gone_since, n.last_snapshot
    FROM newest n LEFT JOIN named m USING (wanted)`;

// Most backup keys are built from the object's name, so a renamed object is saved under
// a new key and its old key looks gone. An object whose Microsoft id is still in a later
// backup was renamed, not deleted: it is found, under its newest name.
// The newest version holding the same object id after the old key's last sighting
// (compared by snapshot, never by a time sent back from JavaScript), and whether that
// newer key was dropped later too: renamed, then deleted.
const RENAMED_SQL = `
  WITH latest AS (
    SELECT DISTINCT ON (w.object_id, w.resource_type) w.object_id, w.resource_type, rv.natural_key,
           ${NAME_SQL} AS name, s.started_at
      FROM unnest($2::text[], $3::text[], $4::uuid[]) AS w(object_id, resource_type, after_snapshot)
      JOIN snapshot s0 ON s0.id = w.after_snapshot
      JOIN snapshot s ON s.tenant_ref = $1 AND s.started_at > s0.started_at
      JOIN resource_version rv ON rv.snapshot_id = s.id AND rv.resource_type = w.resource_type AND rv.payload->>'id' = w.object_id
     ORDER BY w.object_id, w.resource_type, s.started_at DESC
  )
  SELECT l.object_id, l.resource_type, l.name, l.started_at,
         ${goneSinceSql('l.natural_key', 'l.resource_type', 'l.started_at')} AS gone_since
    FROM latest l`;

async function followRenames(client, tenantRef, result, lastSnapshots) {
  const gone = [...result.values()].filter((object) => object.status === 'deleted' && object.objectId && lastSnapshots.has(object.id));
  if (!gone.length) return;
  const { rows } = await client.query(RENAMED_SQL, [
    tenantRef, gone.map((object) => object.objectId), gone.map((object) => object.type), gone.map((object) => lastSnapshots.get(object.id)),
  ]);
  const renamed = new Map(rows.map((row) => [`${row.resource_type}|${row.object_id}`, row]));
  for (const object of gone) {
    const row = renamed.get(`${object.type}|${object.objectId}`);
    if (!row) continue;
    const goneSince = iso(row.gone_since);
    result.set(object.id, describeObject(object.id, {
      resourceType: object.type, name: usableName(row.name) ?? object.name, objectId: object.objectId,
      status: goneSince ? 'deleted' : 'found', lastSeenAt: iso(row.started_at), deletedSince: goneSince,
    }));
  }
}

/**
 * Names for a batch of ids in one tenant, in one read. Returns a Map from each id given
 * to `describeObject`'s shape. A failed read throws; callers that must not fail (pages)
 * catch it and show their own fallback.
 * @param {{ query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }} client
 * @param {{ tenantRef: string, ids: (string | null | undefined)[] }} input
 */
export async function lookupNames(client, { tenantRef, ids }) {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.trim()))];
  const result = new Map();
  const lastSnapshots = new Map();
  const asked = unique.slice(0, MAX_NAME_IDS);
  if (asked.length) {
    // Only bare object ids are matched against saved object ids: a backup key never is.
    const objectIds = asked.filter((id) => BARE_GUID.test(id));
    const { rows } = await client.query(LOOKUP_SQL, [tenantRef, asked, objectIds]);
    for (const row of rows) {
      if (row.last_snapshot) lastSnapshots.set(String(row.wanted), String(row.last_snapshot));
      const goneSince = iso(row.gone_since);
      result.set(String(row.wanted), describeObject(String(row.wanted), {
        resourceType: String(row.resource_type),
        name: row.name ?? null,
        objectId: row.object_id ?? null,
        status: goneSince ? 'deleted' : 'found',
        lastSeenAt: iso(row.last_seen),
        deletedSince: goneSince,
      }));
    }
  }
  await followRenames(client, tenantRef, result, lastSnapshots);
  for (const id of unique) if (!result.has(id)) result.set(id, describeObject(id, { status: 'unknown' }));
  return result;
}
