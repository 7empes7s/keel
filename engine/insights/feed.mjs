/**
 * The change feed (insights track, IN-FEED).
 *
 * Every change Keel knows about, as one row each, from three places:
 *
 * - `drift`: a setting that differs from the approved setup (table drift). A change is
 *   listed once, at the first backup that found it; later backups that still find the
 *   same difference are not new changes.
 * - `service`: a service setting that changed between two reads (table workload_drift).
 * - `backup`: who can reach a site or OneDrive, compared between two content backups
 *   (sharingExposure.mjs): an Everyone grant added or removed, anyone links added, new
 *   guests, the last owner removed. One row per change, named by the site.
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
 *
 * Each row also carries `flags` (flags.mjs): what the change does, when a rule knows it
 * ("Turned off: Require MFA for admins."). A critical flag makes the row critical, a high
 * flag raises a low or normal row to high. Only the JSON paths the rules read are selected.
 *
 * And each row carries `nextStep` (nextSteps.mjs): what to do next ("Accept or undo" under
 * Open changes, restore from a backup, see who can reach a site) or how it was dealt with,
 * read for the whole page at once.
 */
import { objectNameSql } from '../cir/objectName.mjs';
import { DRIFT_ACTED_ON_PREDICATE, DRIFT_IGNORED_PREDICATE } from '../store/openDrift.mjs';
import { MEMBERSHIP_KINDS, ROLE_ASSIGNMENT_KINDS, evaluateFlags, flagPathsSql, flaggedPriority, serviceFlagFieldsSql, serviceFlagValues } from './flags.mjs';
import { displayActor } from './people.mjs';
import { holdsGuid, lookupNames } from './names.mjs';
import { loadNextSteps } from './nextSteps.mjs';
import { ONEDRIVE_ACCESS_KIND, SITE_ACCESS_KIND, compareDriveExposure, compareSiteExposure, exposureActivity } from './sharingExposure.mjs';
import { builtInOf, objectTypeName, settingKind, typeInfo } from './taxonomy.mjs';
import { templateFamilySql } from './templateAreas.mjs';

export { FEED_GROUPINGS, feedGroupOf, groupChangeFeed } from './feedGroups.mjs';

export const FEED_SOURCES = Object.freeze(['drift', 'service', 'backup', 'audit']);
export const DEFAULT_FEED_DAYS = 30;
export const MAX_FEED_DAYS = 90;
export const DEFAULT_FEED_LIMIT = 500;
export const MAX_FEED_LIMIT = 2000;

const DAY_MS = 24 * 60 * 60 * 1000;
const OPERATION_CHANGE = Object.freeze({ create: 'added', update: 'modified', delete: 'removed' });
// Which audit log a fact came from, by the prefix its event id carries (auditSources.mjs).
const AUDIT_SERVICE = Object.freeze({ entra: 'Entra', intune: 'Intune' });

// The fields a service read names a resource by, best first (a Defender allow or block
// entry has no name: its sender, URL or hash is `Value`; a spoofed sender pair is named
// by the spoofed user); keys that hold one
// tenant-wide group of settings rather than a named resource.
const SERVICE_NAME_FIELDS = Object.freeze(['displayName', 'DisplayName', 'name', 'Name', 'title', 'Title', 'webUrl', 'url', 'Value', 'SpoofedUser', 'identity']);
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

// `kind` is the kind a list files the object under when it differs from its stored type
// (an Intune antivirus policy is a Defender endpoint security policy, taxonomy settingKind).
// `builtIn` is the object's isBuiltIn flag when its kind holds both built-in and custom
// objects (an Entra admin role), so the row says which one it is.
function row({ id, source, occurredAt, type, kind = type, service = null, blastRadius = null, object, change, activity = null, person = null, builtIn = null, flags = [], evaluation = null }) {
  const info = typeInfo(kind, service);
  const at = iso(occurredAt);
  return {
    id,
    source,
    occurredAt: at,
    day: at.slice(0, 10),
    type,
    // The kind the row is listed as; differs from `type` only for a subkind.
    kind,
    // What this object is ("Built-in admin role"); kindName names its kind ("Admin role").
    typeName: objectTypeName(kind, builtIn, service),
    kindName: info.name,
    service: info.service ?? service ?? null,
    ...flaggedPriority(priorityOf(info, blastRadius), flags),
    object,
    change,
    activity,
    person,
    flags,
    ...(evaluation ? { evaluation } : {}),
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

// What a row's own values cannot say, from the backup that found it: the name of an admin
// role someone was given, whether a group someone joined can hold admin roles, and the name
// of an app permission (the API's appRoles list).
// A link key is edge:<type>:<parent id>:<target> (diffSnapshots.mjs); an app permission's
// target is <API id>:<permission id>. Read only for added rows of those kinds, each through
// the resource_version (lower(payload->>'id'), snapshot_id) index (schema.d/93).
const KEY_PART = (index) => `lower(split_part(r.natural_key, ':', ${index}))`;
const FLAG_CONTEXT_SQL = `CASE
    WHEN r.change_type = 'added' AND r.after_payload ? 'roleDefinitionId' AND r.resource_type IN (${ROLE_ASSIGNMENT_KINDS.map((kind) => `'${kind}'`).join(', ')}) THEN jsonb_build_object(
      'roleName', (SELECT rd.payload->>'displayName' FROM resource_version rd
                    WHERE lower(rd.payload->>'id') = lower(r.after_payload->>'roleDefinitionId') AND rd.snapshot_id = r.observed_snapshot
                      AND rd.resource_type = 'roleDefinition'
                    LIMIT 1))
    WHEN r.change_type = 'added' AND r.natural_key LIKE 'edge:%' AND r.resource_type IN (${MEMBERSHIP_KINDS.map((kind) => `'${kind}'`).join(', ')}) THEN (
      SELECT jsonb_build_object('roleAssignable', g.payload->'isAssignableToRole', 'groupName', g.payload->>'displayName')
        FROM resource_version g
       WHERE lower(g.payload->>'id') = ${KEY_PART(3)} AND g.snapshot_id = r.observed_snapshot AND g.resource_type = 'group'
       LIMIT 1)
    WHEN r.change_type = 'added' AND r.natural_key LIKE 'edge:%' AND r.resource_type = 'appRoleGrant' THEN jsonb_build_object(
      'permission', (SELECT role->>'value'
                       FROM resource_version api, jsonb_array_elements(CASE WHEN jsonb_typeof(api.payload->'appRoles') = 'array' THEN api.payload->'appRoles' ELSE '[]'::jsonb END) role
                      WHERE lower(api.payload->>'id') = ${KEY_PART(4)} AND api.snapshot_id = r.observed_snapshot
                        AND lower(role->>'id') = ${KEY_PART(5)}
                      LIMIT 1),
      'appName', (SELECT app.payload->>'displayName' FROM resource_version app
                   WHERE lower(app.payload->>'id') = ${KEY_PART(3)} AND app.snapshot_id = r.observed_snapshot LIMIT 1))
  END`;

const DRIFT_SQL = `
  SELECT r.id, r.natural_key, r.resource_type, r.change_type, r.blast_radius, r.detected_at,
         ${DRIFT_NAME_SQL} AS name, coalesce(r.after_payload->>'id', r.before_payload->>'id') AS object_id, who.actors,
         ${templateFamilySql({ typeExpr: 'r.resource_type', payloads: ['r.after_payload', 'r.before_payload'], tenantExpr: 'r.tenant_ref' })} AS template_family,
         coalesce(r.after_payload->'isBuiltIn', r.before_payload->'isBuiltIn') AS is_built_in,
         ${flagPathsSql('r.before_payload', 'r.resource_type')} AS flag_before,
         ${flagPathsSql('r.after_payload', 'r.resource_type')} AS flag_after,
         ${FLAG_CONTEXT_SQL} AS flag_context
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
         CASE WHEN prev.collection_id IS NOT NULL THEN ${SERVICE_FIELDS_SQL('prev')} END AS previous_names,
         ${serviceFlagFieldsSql('d.workload', 'd.fields')} AS flag_fields
    FROM workload_drift d
    JOIN workload_collection c ON c.id = d.collection_id
    LEFT JOIN workload_observation cur ON cur.collection_id = d.collection_id AND cur.resource_key = d.resource_key
    LEFT JOIN workload_observation prev ON prev.collection_id = d.previous_collection_id AND prev.resource_key = d.resource_key
   WHERE d.tenant_ref = $1 AND c.observed_to >= $2 AND c.observed_to <= $3
   ORDER BY c.observed_to DESC, d.id
   LIMIT $4`;

// Content backups that save who can reach a site or OneDrive (engine/content/sharepointSites.mjs
// SITES_WORKLOAD, engine/content/onedrives.mjs ONEDRIVE_WORKLOAD), and the SharePoint read
// that names sites (engine/collect/workloads/sharepoint.mjs).
const SITES_CONTENT = 'sharepoint-sites';
const ONEDRIVE_CONTENT = 'onedrive';
const SITE_READ = 'sharepoint-site-settings';
const EARLIER_ITEM = (alias, extra = '') => `
  SELECT p.metadata FROM content_item p
   WHERE p.tenant_ref = ${alias}.tenant_ref AND p.workload = ${alias}.workload AND p.container = ${alias}.container
     AND p.item_key = ${alias}.item_key ${extra}
     AND (p.created_at < ${alias}.created_at OR (p.created_at = ${alias}.created_at AND p.id < ${alias}.id))
   ORDER BY p.created_at DESC, p.id DESC LIMIT 1`;

// Each site's permissions as one backup saved them, beside the backup before. A site
// backed up for the first time has nothing to compare with and is left out.
const SITE_ACCESS_SQL = `
  SELECT c.id, c.container, c.created_at, c.metadata->'summary' AS summary, c.metadata->>'siteName' AS site_name,
         prev.metadata->'summary' AS previous_summary,
         (SELECT coalesce(o.fields->>'displayName', o.fields->>'name', o.fields->>'webUrl')
            FROM workload_observation o JOIN workload_collection w ON w.id = o.collection_id
           WHERE w.tenant_ref = $1 AND w.workload = '${SITE_READ}' AND o.resource_key = c.container
           ORDER BY w.created_at DESC LIMIT 1) AS read_name
    FROM content_item c
    JOIN LATERAL (${EARLIER_ITEM('c')}) prev ON true
   WHERE c.tenant_ref = $1 AND c.workload = '${SITES_CONTENT}' AND c.item_key = 'site/permissions'
     AND c.created_at >= $2 AND c.created_at <= $3
     AND coalesce(c.metadata->>'removed', '') <> 'true'
   ORDER BY c.created_at DESC, c.id
   LIMIT $4`;

// OneDrive files whose saved Everyone grants or links differ from their record before.
const DRIVE_ACCESS_SQL = `
  SELECT c.id, c.container, c.created_at, c.metadata->>'ownerName' AS owner_name,
         c.metadata->'exposure' AS exposure, prev.metadata->'exposure' AS previous_exposure
    FROM content_item c
    JOIN LATERAL (${EARLIER_ITEM('c', "AND p.metadata->>'kind' = 'drive-record'")}) prev ON true
   WHERE c.tenant_ref = $1 AND c.workload = '${ONEDRIVE_CONTENT}' AND c.metadata->>'kind' = 'drive-record'
     AND c.created_at >= $2 AND c.created_at <= $3
     AND jsonb_typeof(c.metadata->'exposure') = 'object' AND jsonb_typeof(prev.metadata->'exposure') = 'object'
     AND (c.metadata->'exposure'->'everyone' IS DISTINCT FROM prev.metadata->'exposure'->'everyone'
          OR c.metadata->'exposure'->'linkGrants' IS DISTINCT FROM prev.metadata->'exposure'->'linkGrants')
   ORDER BY c.created_at DESC, c.id
   LIMIT $4`;

const AUDIT_SQL = `
  SELECT source_event_id, occurred_at, target_type, target_id, operation, activity, fields, actor_kind, actor_id
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
 * @param {{ tenantRef: string, now?: Date, days?: number, limit?: number, selection?: { source: string, ids: string[] },
 *   namer?: ((key: string) => string) | null }} input
 *   `namer` comes from anonymity.mjs#readNamer: null shows names, else people are code-named.
 * @returns {Promise<{ since: string, until: string, rows: object[], truncated: boolean }>}
 */
export async function loadChangeFeed(client, { tenantRef, now = new Date(), days = DEFAULT_FEED_DAYS, limit = DEFAULT_FEED_LIMIT, namer = null, selection = null }) {
  if (typeof tenantRef !== 'string' || !tenantRef) throw new TypeError('tenantRef is required');
  const span = bounded(days, DEFAULT_FEED_DAYS, MAX_FEED_DAYS);
  const cap = bounded(limit, DEFAULT_FEED_LIMIT, MAX_FEED_LIMIT);
  const until = new Date(now);
  const since = new Date(until.getTime() - span * DAY_MS);
  const window = [tenantRef, selection ? new Date(0) : since, selection ? new Date('9999-01-01') : until, cap + 1];
  const read = async (table, sql) => {
    const source = { drift: 'drift', workload_drift: 'service', audit_change_fact: 'audit' }[table];
    if (selection && selection.source !== source) return [];
    if (!(await tableExists(client, table))) return [];
    if (!selection) return (await client.query(sql, window)).rows;
    // Collection consumers select exact rows, without the inbox's age or size limits.
    const column = { drift: 'r.id::text', workload_drift: 'd.id::text', audit_change_fact: 'source_event_id' }[table];
    const order = sql.lastIndexOf('   ORDER BY');
    const scoped = sql.slice(0, order) + ` AND ${column} = ANY($4::text[]) ` + sql.slice(order).replace('   LIMIT $4', '');
    return (await client.query(scoped, [...window.slice(0, 3), selection.ids])).rows;
  };
  const [drift, service, audit] = [await read('drift', DRIFT_SQL), await read('workload_drift', SERVICE_SQL), await read('audit_change_fact', AUDIT_SQL)];
  const [siteAccess, driveAccess] = [await read('content_item', SITE_ACCESS_SQL), await read('content_item', DRIVE_ACCESS_SQL)];

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
  // A name a flag sentence carries from a linked setting (a group, an app): never an id,
  // and with names hidden, addresses in it are code-named.
  const shownName = (value) => {
    const name = usable(value);
    return name && typeof namer === 'function' ? hidePeopleText(name, namer) : name;
  };
  // Only one account can be named; several, or none, leave it unknown.
  const onlyActor = (keys) => (Array.isArray(keys) && keys.length === 1 ? person(actorFrom(keys[0])) : null);

  const flagged = (input) => ({ flags: evaluateFlags(input), ...(selection ? { evaluation: input } : {}) });

  // One row per change a backup found in who can reach a site or OneDrive.
  // What the next step of each row is read by (nextSteps.mjs): the stored key and object
  // id, before any name is hidden.
  const raw = new Map();
  const backupRows = ({ id, at, type, service: serviceName, key, name, changes }) => changes.map((exposure) => {
    const object = { key, name, status: 'found' };
    const suffix = exposure.what === 'everyone' ? `${exposure.what}:${exposure.audience}` : exposure.what;
    raw.set(`backup:${id}:${suffix}`, { key, backup: type === SITE_ACCESS_KIND ? 'site' : 'onedrive' });
    return {
      ...row({
        id: `backup:${id}:${suffix}`,
        source: 'backup',
        occurredAt: at,
        type,
        object,
        change: exposure.change,
        activity: exposureActivity(exposure),
        flags: evaluateFlags({ source: 'backup', type, change: exposure.change, name: object.name, key: object.key, context: { exposure } }),
      }),
      service: serviceName,
    };
  });
  const sites = siteAccess.flatMap((entry) => backupRows({
    id: entry.id,
    at: entry.created_at,
    type: SITE_ACCESS_KIND,
    service: 'SharePoint',
    key: String(entry.container),
    name: shownName(entry.site_name) ?? shownName(entry.read_name),
    changes: compareSiteExposure(entry.previous_summary, entry.summary),
  }));
  // A OneDrive's changed files, one backup (day) at a time.
  const drives = new Map();
  for (const entry of driveAccess) {
    const at = iso(entry.created_at);
    const group = `${entry.container}@${at.slice(0, 10)}`;
    if (!drives.has(group)) drives.set(group, { container: String(entry.container), at, owner: text(entry.owner_name), files: [] });
    drives.get(group).files.push({ before: entry.previous_exposure, after: entry.exposure });
  }
  const oneDrives = [...drives.entries()].flatMap(([group, drive]) => {
    const owner = drive.owner && typeof namer === 'function' ? namer(drive.owner.toLowerCase()) : drive.owner;
    return backupRows({
      id: group,
      at: drive.at,
      type: ONEDRIVE_ACCESS_KIND,
      service: 'OneDrive',
      key: drive.container,
      name: owner ? `${owner}’s OneDrive` : 'OneDrive',
      changes: compareDriveExposure(drive.files),
    });
  });

  const rows = [
    ...sites,
    ...oneDrives,
    ...drift.map((entry) => {
      const type = String(entry.resource_type);
      const object = shown(type, entry.object_id, { key: String(entry.natural_key), name: usable(entry.name), status: entry.change_type === 'removed' ? 'deleted' : 'found' });
      raw.set(`drift:${entry.id}`, { key: String(entry.natural_key), objectId: text(entry.object_id), deleted: entry.change_type === 'removed' });
      const context = entry.flag_context ? { ...entry.flag_context, roleName: shownName(entry.flag_context.roleName), groupName: shownName(entry.flag_context.groupName), appName: shownName(entry.flag_context.appName) } : null;
      return row({
        id: `drift:${entry.id}`,
        source: 'drift',
        occurredAt: entry.detected_at,
        type,
        kind: settingKind(type, entry.template_family ?? null),
        builtIn: builtInOf({ isBuiltIn: entry.is_built_in }),
        blastRadius: entry.blast_radius,
        object,
        change: String(entry.change_type),
        person: onlyActor(entry.actors),
        ...flagged({ source: 'drift', type, change: String(entry.change_type), name: object.name, key: object.key, before: entry.flag_before, after: entry.flag_after, context }),
      });
    }),
    ...service.map((entry) => {
      raw.set(`service:${entry.id}`, { key: `${entry.workload}:${entry.resource_key}`, deleted: entry.change_type === 'removed' });
      const object = shown(String(entry.workload), null, {
        key: `${entry.workload}:${entry.resource_key}`,
        name: serviceObjectName(String(entry.resource_key), entry.change_type === 'removed' ? entry.previous_names : entry.current_names ?? entry.previous_names),
        status: entry.change_type === 'removed' ? 'deleted' : 'found',
      });
      return row({
        id: `service:${entry.id}`,
        source: 'service',
        occurredAt: entry.observed_to,
        type: String(entry.workload),
        blastRadius: entry.blast_radius,
        object,
        change: String(entry.change_type),
        ...flagged({ source: 'service', type: String(entry.workload), change: String(entry.change_type), name: object.name, key: object.key, ...serviceFlagValues(entry.flag_fields) }),
      });
    }),
    ...audit.map((entry) => {
      const eventId = String(entry.source_event_id);
      const target = names.get(String(entry.target_id));
      const known = target && target.status !== 'unknown' && target.type;
      const type = known ? target.type : String(entry.target_type);
      const object = shown(known ? target.type : null, String(entry.target_id), { key: String(entry.target_id), name: known ? target.name : null, status: known ? target.status : 'unknown' });
      const change = OPERATION_CHANGE[entry.operation] ?? 'modified';
      raw.set(`audit:${eventId}`, { key: String(entry.target_id), objectId: text(entry.target_id), deleted: change === 'removed' });
      return row({
        id: `audit:${eventId}`,
        source: 'audit',
        occurredAt: entry.occurred_at,
        type,
        service: AUDIT_SERVICE[eventId.slice(0, eventId.indexOf(':'))] ?? null,
        object,
        change,
        activity: text(entry.activity),
        person: person({ kind: String(entry.actor_kind), id: String(entry.actor_id).toLowerCase() }),
        ...flagged({
          source: 'audit', type, change, name: object.name, key: object.key, activity: text(entry.activity),
          operation: String(entry.operation), targetType: String(entry.target_type), fields: Array.isArray(entry.fields) ? entry.fields : [],
        }),
      });
    }),
  ].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
  const kept = selection ? rows : rows.slice(0, cap);
  // One next step per row, read for the whole page at once.
  const steps = await loadNextSteps(client, {
    tenantRef, now: until, namer,
    items: kept.map((entry) => ({ id: entry.id, source: entry.source, occurredAt: entry.occurredAt, objectId: null, deleted: false, backup: null, ...raw.get(entry.id) })),
  });
  return {
    since: since.toISOString(), until: until.toISOString(),
    rows: kept.map((entry) => ({ ...entry, nextStep: steps.get(entry.id) ?? null })),
    truncated: selection ? false : rows.length > cap,
  };
}
