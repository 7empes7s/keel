/**
 * The change feed (insights track, IN-FEED).
 *
 * Every change Keel knows about, as one row each, from three places:
 *
 * - `drift`: a setting that differs from the approved setup (table drift). A change is
 *   listed once, at the first backup that found it; later backups that still find the
 *   same difference are not new changes.
 * - `service`: a service setting that changed between two reads (table workload_drift).
 * - `audit`: a create, update or delete the Microsoft audit log recorded
 *   (table audit_change_fact, Entra and Intune logs).
 *
 * Each row carries the kind of object in words, the object's name, the person or app who
 * made it (code-named when "Hide people's names" is on), the service, the priority and
 * when. groupChangeFeed (feedGroups.mjs) groups rows by type, service, priority, person or
 * day.
 *
 * A drift or service row names a person only when exactly one account's audit record
 * names the same object, with a matching operation, between the backup before and the
 * backup that found it. Otherwise the person is not known.
 */
import { objectNameSql } from '../cir/objectName.mjs';
import { DRIFT_ACTED_ON_PREDICATE, DRIFT_IGNORED_PREDICATE } from '../store/openDrift.mjs';
import { displayActor } from './people.mjs';
import { holdsGuid, lookupNames } from './names.mjs';
import { typeInfo } from './taxonomy.mjs';

export { FEED_GROUPINGS, feedGroupOf, groupChangeFeed } from './feedGroups.mjs';

export const FEED_SOURCES = Object.freeze(['drift', 'service', 'audit']);
export const DEFAULT_FEED_DAYS = 30;
export const MAX_FEED_DAYS = 90;
export const DEFAULT_FEED_LIMIT = 500;
export const MAX_FEED_LIMIT = 2000;

const DAY_MS = 24 * 60 * 60 * 1000;
const OPERATION_CHANGE = Object.freeze({ create: 'added', update: 'modified', delete: 'removed' });
// Which audit log a fact came from, by the prefix its event id carries (auditSources.mjs).
const AUDIT_SERVICE = Object.freeze({ entra: 'Entra', intune: 'Intune' });

// The fields a service read names a resource by, best first; keys that hold one
// tenant-wide group of settings rather than a named resource.
const SERVICE_NAME_FIELDS = Object.freeze(['displayName', 'DisplayName', 'name', 'Name', 'title', 'Title', 'webUrl', 'url', 'identity']);
const SERVICE_TENANT_KEYS = Object.freeze({ tenant: 'Sharing settings', organization: 'Organization settings' });

const iso = (value) => (value instanceof Date ? value : new Date(String(value))).toISOString();
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const usable = (value) => {
  const name = text(value);
  return name && !holdsGuid(name) ? name : null;
};

// Email addresses, and the account part of a OneDrive address, as code names.
const ADDRESSES = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const ONEDRIVE = /(\/personal\/)([A-Za-z0-9._-]+)/gi;

/**
 * Text as shown while names are hidden: every email address, and the account in a
 * OneDrive address, becomes the person's code name. Unchanged when `namer` is null. Pure.
 */
export function hidePeopleText(text, namer) {
  if (typeof text !== 'string' || typeof namer !== 'function') return text;
  return text
    .replace(ADDRESSES, (address) => namer(address.toLowerCase()))
    .replace(ONEDRIVE, (_match, prefix, account) => `${prefix}${namer(account.toLowerCase())}`);
}

/** The name a service read lists a resource under, never an object id. Pure. */
export function serviceObjectName(resourceKey, fields) {
  if (SERVICE_TENANT_KEYS[resourceKey]) return SERVICE_TENANT_KEYS[resourceKey];
  for (const field of SERVICE_NAME_FIELDS) {
    const value = usable(fields?.[field]);
    if (value) return value.replace(/^https?:\/\//, '');
  }
  const index = resourceKey.indexOf(':');
  return usable(index === -1 ? resourceKey : resourceKey.slice(index + 1));
}

// A blast radius that can lock the tenant out outranks the kind's usual priority.
function priorityOf(info, blastRadius) {
  if (blastRadius === 'tenant-lockout') return { priority: 'critical', priorityReason: 'This change can lock admins or users out of the whole tenant.' };
  return { priority: info.priority, priorityReason: info.priorityReason ?? null };
}

function row({ id, source, occurredAt, type, service = null, blastRadius = null, object, change, activity = null, person = null }) {
  const info = typeInfo(type, service);
  const at = iso(occurredAt);
  return {
    id,
    source,
    occurredAt: at,
    day: at.slice(0, 10),
    type,
    typeName: info.name,
    service: info.service ?? service ?? null,
    ...priorityOf(info, blastRadius),
    object,
    change,
    activity,
    person,
  };
}

const DRIFT_NAME_SQL = `coalesce(${objectNameSql('r.after_payload', 'r.resource_type')}, ${objectNameSql('r.before_payload', 'r.resource_type')})`;

// A difference from the approved setup, at the first backup that found it. Detection keeps
// one row per open difference (store/governance.mjs reuseDrift) and writes a new one only
// once the earlier row was acted on, so a row is a repeat, and hidden, only when the newest
// earlier row for its key holds the same difference and nothing acted on it (or it is ignored
// now). The same change made again after a roll back is listed again.
// The person is every account whose audit record names the object (for a link, either end)
// between the backup before that one and the end of that one, with an operation that fits
// the change (any for a link).
const OBJECT_IDS_SQL = `(ARRAY(SELECT lower(m[1]) FROM regexp_matches(CASE WHEN r.natural_key LIKE 'edge:%' THEN r.natural_key ELSE '' END,
     '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', 'gi') AS m)
   || lower(coalesce(r.after_payload->>'id', r.before_payload->>'id')))`;

const DRIFT_SQL = `
  SELECT r.id, r.natural_key, r.resource_type, r.change_type, r.blast_radius, r.detected_at,
         ${DRIFT_NAME_SQL} AS name, coalesce(r.after_payload->>'id', r.before_payload->>'id') AS object_id, who.actors
    FROM drift r
    JOIN snapshot s ON s.id = r.observed_snapshot
    LEFT JOIN LATERAL (
      SELECT d.change_type, d.after_hash, ${DRIFT_ACTED_ON_PREDICATE} AS acted_on, ${DRIFT_IGNORED_PREDICATE} AS ignored
        FROM drift d
       WHERE d.tenant_ref = r.tenant_ref AND d.baseline_id = r.baseline_id AND d.natural_key = r.natural_key
         AND (d.detected_at < r.detected_at OR (d.detected_at = r.detected_at AND d.id < r.id))
       ORDER BY d.detected_at DESC, d.id DESC
       LIMIT 1
    ) prev ON true
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT a.actor_kind || ':' || lower(a.actor_id)) AS actors
        FROM audit_change_fact a
       WHERE a.tenant_ref = $1
         AND lower(a.target_id) = ANY (${OBJECT_IDS_SQL})
         AND a.occurred_at <= coalesce(s.completed_at, r.detected_at)
         AND a.occurred_at > coalesce(
               (SELECT max(p.started_at) FROM snapshot p WHERE p.tenant_ref = $1 AND p.status = 'complete' AND p.started_at < s.started_at),
               s.started_at - interval '30 days')
         AND (r.natural_key LIKE 'edge:%'
              OR a.operation = CASE r.change_type WHEN 'added' THEN 'create' WHEN 'removed' THEN 'delete' ELSE 'update' END)
    ) who ON true
   WHERE r.tenant_ref = $1 AND r.detected_at >= $2 AND r.detected_at <= $3
     AND NOT (prev.change_type IS NOT NULL AND prev.change_type = r.change_type
              AND prev.after_hash IS NOT DISTINCT FROM r.after_hash
              AND (NOT prev.acted_on OR prev.ignored))
   ORDER BY r.detected_at DESC, r.id
   LIMIT $4`;

const SERVICE_FIELDS_SQL = (alias) => `jsonb_build_object(${SERVICE_NAME_FIELDS.map((field) => `'${field}', ${alias}.fields->'${field}'`).join(', ')})`;

const SERVICE_SQL = `
  SELECT d.id, d.workload, d.resource_key, d.change_type, d.blast_radius, c.observed_to,
         CASE WHEN cur.collection_id IS NOT NULL THEN ${SERVICE_FIELDS_SQL('cur')} END AS current_names,
         CASE WHEN prev.collection_id IS NOT NULL THEN ${SERVICE_FIELDS_SQL('prev')} END AS previous_names
    FROM workload_drift d
    JOIN workload_collection c ON c.id = d.collection_id
    LEFT JOIN workload_observation cur ON cur.collection_id = d.collection_id AND cur.resource_key = d.resource_key
    LEFT JOIN workload_observation prev ON prev.collection_id = d.previous_collection_id AND prev.resource_key = d.resource_key
   WHERE d.tenant_ref = $1 AND c.observed_to >= $2 AND c.observed_to <= $3
   ORDER BY c.observed_to DESC, d.id
   LIMIT $4`;

const AUDIT_SQL = `
  SELECT source_event_id, occurred_at, target_type, target_id, operation, activity, actor_kind, actor_id
    FROM audit_change_fact
   WHERE tenant_ref = $1 AND occurred_at >= $2 AND occurred_at <= $3
   ORDER BY occurred_at DESC, source_event_id
   LIMIT $4`;

async function tableExists(client, name) {
  const { rows: [found] } = await client.query('SELECT to_regclass($1) AS name', [name]);
  return Boolean(found?.name);
}

const bounded = (value, fallback, max) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.min(Math.floor(number), max) : fallback;
};

/** "user:<id>" as an actor, or null when it is not one. */
function actorFrom(key) {
  const index = key.indexOf(':');
  const kind = key.slice(0, index);
  return kind === 'user' || kind === 'servicePrincipal' ? { kind, id: key.slice(index + 1) } : null;
}

/**
 * The newest changes in one tenant, newest first.
 * @param {{ query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }} client
 * @param {{ tenantRef: string, now?: Date, days?: number, limit?: number,
 *   namer?: ((key: string) => string) | null }} input
 *   `namer` comes from anonymity.mjs#readNamer: null shows names, else people are code-named.
 * @returns {Promise<{ since: string, until: string, rows: object[], truncated: boolean }>}
 */
export async function loadChangeFeed(client, { tenantRef, now = new Date(), days = DEFAULT_FEED_DAYS, limit = DEFAULT_FEED_LIMIT, namer = null }) {
  if (typeof tenantRef !== 'string' || !tenantRef) throw new TypeError('tenantRef is required');
  const span = bounded(days, DEFAULT_FEED_DAYS, MAX_FEED_DAYS);
  const cap = bounded(limit, DEFAULT_FEED_LIMIT, MAX_FEED_LIMIT);
  const until = new Date(now);
  const since = new Date(until.getTime() - span * DAY_MS);
  const window = [tenantRef, since, until, cap + 1];
  const read = async (table, sql) => ((await tableExists(client, table)) ? (await client.query(sql, window)).rows : []);
  const [drift, service, audit] = [await read('drift', DRIFT_SQL), await read('workload_drift', SERVICE_SQL), await read('audit_change_fact', AUDIT_SQL)];

  // One names read for every audited object and every account a row points to.
  const actorKeys = new Set();
  for (const entry of drift) for (const key of entry.actors ?? []) actorKeys.add(key);
  for (const entry of audit) actorKeys.add(`${entry.actor_kind}:${String(entry.actor_id).toLowerCase()}`);
  const actors = [...actorKeys].map(actorFrom).filter(Boolean);
  const names = await lookupNames(client, { tenantRef, ids: [...audit.map((entry) => String(entry.target_id)), ...actors.map((actor) => actor.id)] });
  const person = (actor) => {
    if (!actor) return null;
    const found = names.get(actor.id);
    return displayActor({ kind: actor.kind, id: actor.id, name: found?.status !== 'unknown' ? found?.name ?? null : null }, namer);
  };
  // While names are hidden, a person the change is about is code-named the same way as a
  // person who made one (by their object id), and addresses in keys and names are too.
  const shown = (type, objectId, object) => {
    if (typeof namer !== 'function') return object;
    const id = typeof objectId === 'string' && objectId ? objectId.toLowerCase() : null;
    return {
      ...object,
      key: hidePeopleText(object.key, namer),
      name: type === 'user' && id ? namer(id) : hidePeopleText(object.name, namer),
    };
  };
  // Only one account can be named; several, or none, leave it unknown.
  const onlyActor = (keys) => (Array.isArray(keys) && keys.length === 1 ? person(actorFrom(keys[0])) : null);

  const rows = [
    ...drift.map((entry) => row({
      id: `drift:${entry.id}`,
      source: 'drift',
      occurredAt: entry.detected_at,
      type: String(entry.resource_type),
      blastRadius: entry.blast_radius,
      object: shown(String(entry.resource_type), entry.object_id, { key: String(entry.natural_key), name: usable(entry.name), status: entry.change_type === 'removed' ? 'deleted' : 'found' }),
      change: String(entry.change_type),
      person: onlyActor(entry.actors),
    })),
    ...service.map((entry) => row({
      id: `service:${entry.id}`,
      source: 'service',
      occurredAt: entry.observed_to,
      type: String(entry.workload),
      blastRadius: entry.blast_radius,
      object: shown(String(entry.workload), null, {
        key: `${entry.workload}:${entry.resource_key}`,
        name: serviceObjectName(String(entry.resource_key), entry.change_type === 'removed' ? entry.previous_names : entry.current_names ?? entry.previous_names),
        status: entry.change_type === 'removed' ? 'deleted' : 'found',
      }),
      change: String(entry.change_type),
    })),
    ...audit.map((entry) => {
      const eventId = String(entry.source_event_id);
      const target = names.get(String(entry.target_id));
      const known = target && target.status !== 'unknown' && target.type;
      return row({
        id: `audit:${eventId}`,
        source: 'audit',
        occurredAt: entry.occurred_at,
        type: known ? target.type : String(entry.target_type),
        service: AUDIT_SERVICE[eventId.slice(0, eventId.indexOf(':'))] ?? null,
        object: shown(known ? target.type : null, String(entry.target_id), { key: String(entry.target_id), name: known ? target.name : null, status: known ? target.status : 'unknown' }),
        change: OPERATION_CHANGE[entry.operation] ?? 'modified',
        activity: text(entry.activity),
        person: person({ kind: String(entry.actor_kind), id: String(entry.actor_id).toLowerCase() }),
      });
    }),
  ].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
  return { since: since.toISOString(), until: until.toISOString(), rows: rows.slice(0, cap), truncated: rows.length > cap };
}
