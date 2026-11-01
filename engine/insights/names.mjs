/**
 * Object names, not ids (insights track, IN-NAMES).
 *
 * Given a tenant and a batch of ids, says what each one is in words a reader knows:
 * the kind of object (from taxonomy.mjs) and its display name from the newest backup
 * that holds it. Each id comes back with a status:
 *
 * - `found`: the newest complete backup that read its kind still holds it.
 * - `deleted`: an earlier backup held it, and a later complete backup that read its
 *   kind did not, even when that backup found no object of that kind at all. `deletedSince` is when that later backup started, and the name is
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

// Whether backup s2 read a kind completely. Its coverage record says so per kind:
// a complete read that found nothing ('complete-empty') counts, so the last object
// of a kind can be seen to go. Any other outcome (partial, failed, not-requested,
// unavailable) never counts, even when it saved some rows. Older backups without a
// per-kind outcome fall back to "it saved at least one row of that kind".
const readKindSql = (type) => `(CASE WHEN s2.coverage_digest->${type}->>'outcome' IS NOT NULL
       THEN s2.coverage_digest->${type}->>'outcome' IN ('complete', 'complete-empty')
       ELSE EXISTS (SELECT 1 FROM resource_version r2 WHERE r2.snapshot_id = s2.id AND r2.resource_type = ${type}) END)`;

// When a key went: the start of the first complete backup after its last sighting
// that read its kind but no longer held the key. Times stay in SQL, so microseconds
// are never lost on the way through JavaScript (lesson 2026-10-15).
const goneSinceSql = (key, type, lastSeen) => `(SELECT min(s2.started_at) FROM snapshot s2
   WHERE s2.tenant_ref = $1 AND s2.status = 'complete' AND s2.started_at > ${lastSeen}
     AND ${readKindSql(type)}
     AND NOT EXISTS (SELECT 1 FROM resource_version r3 WHERE r3.snapshot_id = s2.id AND r3.natural_key = ${key}))`;

// Whether backup `s` holds a version of the wanted id `w`: by backup key, or (a bare
// object id only, $3 in lower case) by the version's id or app id. Each test is one
// exact probe of an index on (what is matched, backup) (store/schema.d/92), so a miss
// reads no saved payload. Probes here are scalar (SELECT 1 ... LIMIT 1), never EXISTS:
// the planner may turn an EXISTS into one hashed read of every version it could match.
const holdsSql = (w, s) => `((SELECT 1 FROM resource_version rv WHERE rv.natural_key = ${w} AND rv.snapshot_id = ${s} LIMIT 1) IS NOT NULL
      OR (lower(${w}) = ANY($3::text[])
          AND ((SELECT 1 FROM resource_version rv WHERE lower(rv.payload->>'id') = lower(${w}) AND rv.snapshot_id = ${s} LIMIT 1) IS NOT NULL
            OR (SELECT 1 FROM resource_version rv WHERE lower(rv.payload->>'appId') = lower(${w}) AND rv.snapshot_id = ${s} LIMIT 1) IS NOT NULL)))`;

// Every version of the wanted id `w` saved in backup `s` (normally one; an app and its
// service principal share an app id), each read by one exact index probe.
const versionsInSql = (w, s) => `
        SELECT rv.natural_key, rv.resource_type, rv.payload->>'id' AS object_id, ${NAME_SQL} AS name
          FROM resource_version rv WHERE rv.natural_key = ${w} AND rv.snapshot_id = ${s}
        UNION
        SELECT rv.natural_key, rv.resource_type, rv.payload->>'id', ${NAME_SQL}
          FROM resource_version rv
         WHERE lower(${w}) = ANY($3::text[]) AND lower(rv.payload->>'id') = lower(${w}) AND rv.snapshot_id = ${s}
        UNION
        SELECT rv.natural_key, rv.resource_type, rv.payload->>'id', ${NAME_SQL}
          FROM resource_version rv
         WHERE lower(${w}) = ANY($3::text[]) AND lower(rv.payload->>'appId') = lower(${w}) AND rv.snapshot_id = ${s}`;

const usableNameSql = (name) => `(${name} IS NOT NULL AND ${name} !~* '${GUID.source}')`;

// For each wanted id, the newest saved version of the object it names (by backup key,
// or by the object's id or app id), its newest non-empty name, and the first complete
// backup after it that read its kind but no longer held it.
//
// Backlog 40: this used to read every saved version of each object in full to find the
// newest one. An object kept in every hourly backup has hundreds of versions, and for
// the Changes feed's ~500 ids the planner read the whole table twice: 11.5 s on live
// (operator queue Q305). Now each id is first checked to be saved at all (one index
// probe, so an id no backup holds costs nothing more), then the tenant's backups are
// walked newest first (snapshot_tenant_started_idx) until one holds it, and only that
// backup's versions are read. Older backups are walked only when the newest version has
// no usable name, and stop at the first that has one. LATERAL ... LIMIT keeps each walk
// per id, so the planner cannot turn it into a scan of every saved version.
const LOOKUP_SQL = `
  WITH wanted AS (SELECT unnest($2::text[]) AS id),
  latest AS (
    SELECT w.id AS wanted, b.id AS snapshot_id, b.started_at
      FROM wanted w
      CROSS JOIN LATERAL (
        SELECT s.id, s.started_at FROM snapshot s
         WHERE s.tenant_ref = $1 AND ${holdsSql('w.id', 's.id')}
         ORDER BY s.started_at DESC LIMIT 1) b
     WHERE (SELECT 1 FROM resource_version rv WHERE rv.natural_key = w.id LIMIT 1) IS NOT NULL
        OR (lower(w.id) = ANY($3::text[])
            AND ((SELECT 1 FROM resource_version rv WHERE lower(rv.payload->>'id') = lower(w.id) LIMIT 1) IS NOT NULL
              OR (SELECT 1 FROM resource_version rv WHERE lower(rv.payload->>'appId') = lower(w.id) LIMIT 1) IS NOT NULL))
  ),
  newest AS (
    SELECT DISTINCT ON (l.wanted) l.wanted, v.natural_key, v.resource_type, v.object_id, v.name,
           l.started_at AS last_seen, l.snapshot_id AS last_snapshot
      FROM latest l CROSS JOIN LATERAL (${versionsInSql('l.wanted', 'l.snapshot_id')}) v
     ORDER BY l.wanted, v.natural_key, v.name NULLS LAST
  )
  SELECT n.wanted, n.natural_key, n.resource_type, n.object_id, n.last_seen,
         CASE WHEN ${usableNameSql('n.name')} THEN n.name ELSE (
           SELECT v.name FROM snapshot s CROSS JOIN LATERAL (${versionsInSql('n.wanted', 's.id')}) v
            WHERE s.tenant_ref = $1 AND s.started_at <= n.last_seen AND ${usableNameSql('v.name')}
            ORDER BY s.started_at DESC LIMIT 1) END AS name,
         ${goneSinceSql('n.natural_key', 'n.resource_type', 'n.last_seen')} AS gone_since, n.last_snapshot
    FROM newest n`;

// Most backup keys are built from the object's name, so a renamed object is saved under
// a new key and its old key looks gone. An object whose Microsoft id is still in a later
// backup was renamed, not deleted: it is found, under its newest name.
// The newest version holding the same object id after the old key's last sighting
// (compared by snapshot, never by a time sent back from JavaScript), and whether that
// newer key was dropped later too: renamed, then deleted.
const RENAMED_SQL = `
  WITH latest AS (
    SELECT w.object_id, w.resource_type, v.natural_key, v.name, v.started_at
      FROM unnest($2::text[], $3::text[], $4::uuid[]) AS w(object_id, resource_type, after_snapshot)
      JOIN snapshot s0 ON s0.id = w.after_snapshot
      -- Newest backup first, one probe of the object id index (store/schema.d/92) each,
      -- stopping at the first that holds it. The exact match keeps the old meaning.
      CROSS JOIN LATERAL (
        SELECT rv.natural_key, ${NAME_SQL} AS name, s.started_at
          FROM snapshot s
          JOIN resource_version rv ON lower(rv.payload->>'id') = lower(w.object_id) AND rv.snapshot_id = s.id
         WHERE s.tenant_ref = $1 AND s.started_at > s0.started_at
           AND rv.resource_type = w.resource_type AND rv.payload->>'id' = w.object_id
         ORDER BY s.started_at DESC LIMIT 1) v
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
    const objectIds = [...new Set(asked.filter((id) => BARE_GUID.test(id)).map((id) => id.toLowerCase()))];
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
