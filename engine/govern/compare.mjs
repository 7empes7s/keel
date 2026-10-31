/**
 * Wave 2 CMP: compare two points of an estate.
 *
 * Three modes, one result shape:
 *   compareSnapshots   any two completed snapshots (the same tenant, or two tenants)
 *   compareWithLive    a completed snapshot against the tenant as it is now, read with
 *                      GETs only (the collector's own reads); nothing is stored
 *   compareTenants     the latest completed snapshot of one tenant against another's
 *
 * Each compare has three sections:
 *   settings   every catalogue type, keyed by natural key (engine/cir/naturalKey.mjs)
 *   workloads  the newest workload collection at or before each side's time
 *   content    the content index (engine/content/index.mjs) at each side's time
 *
 * Rules the result keeps:
 * - A type or workload that one side did not read completely is "not compared", never
 *   reported as added or removed: a failed read is not an emptied tenant.
 * - Two different tenants are compared portably: every reference is replaced by the
 *   natural key it points to and every remaining id is masked, so objects that differ
 *   only in their ids are the same. Types whose key is itself a tenant id cannot be
 *   matched across tenants and are listed as such.
 * - Content in one tenant is compared item by item (added, removed, changed, by
 *   container). Content ids are tenant-bound, so two tenants are compared by what they
 *   hold: item counts, bytes and how much of the content exists in both.
 * - Lists are bounded (MAX_ITEMS, MAX_FIELDS); totals are always exact.
 *
 * Read-only throughout: every query here is a SELECT, and the live read goes through
 * collectWithOutcomes, whose reader has no write method.
 */
import { createHash } from 'node:crypto';
import { objectName } from '../cir/objectName.mjs';
import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { HASH_VERSION, canonicalHash } from '../cir/canonicalHash.mjs';
import { ID_KEY_TYPES } from '../cir/naturalKey.mjs';
import { collectWithOutcomes } from '../collect/entraAdapter.mjs';
import { EXCHANGE_WORKLOAD, comparableMailboxSetting } from '../collect/workloads/exchange.mjs';
import { loadSymbolContext } from '../store/resourceSymbols.mjs';
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { comparedSettings, semanticChange } from './semanticDrift.mjs';
import { changeBlastRadius } from '../safety/blastRadius.mjs';
import { templateFamilyOf } from '../insights/taxonomy.mjs';
import { diffNormal, maskCredentials, sameForDiff } from '../safety/diffHygiene.mjs';

export const COMPARE_VERSION = 1;
export const COMPARE_SECTIONS = Object.freeze(['settings', 'workloads', 'content']);
/** At most this many items per type, workload or container are listed; the rest are counted. */
export const MAX_ITEMS = 200;
/** At most this many field differences per item are listed. */
export const MAX_FIELDS = 20;
/** At most this many content items are listed per compare. */
export const MAX_CONTENT_ITEMS = 500;

export class CompareError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CompareError';
    this.code = code;
  }
}

const GUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HAS_GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const READ = new Set(['complete', 'complete-empty']);
const CHANGE_ORDER = { removed: 0, changed: 1, added: 2 };

// Ids that are the same in every tenant (global templates, branding languages) stay
// matchable; every other id-keyed type is tenant-bound.
const GLOBAL_ID_TYPES = new Set(['directorySettingTemplate', 'directoryRoleTemplate', 'deviceManagementTemplate', 'organizationalBrandingLocalization']);
// Users are keyed by UPN, which carries the tenant's own domain.
export const TENANT_BOUND_TYPES = new Set([...[...ID_KEY_TYPES].filter((type) => !GLOBAL_ID_TYPES.has(type)), 'user']);

const CATALOG_PATH = new Map(CATALOG.map((entry) => [entry.type, entry.path ?? '']));

/** The Microsoft service a catalogue type, workload or content workload belongs to. */
export function serviceOf(kind, name) {
  if (kind === 'settings') {
    return /^\/device(Management|AppManagement)/.test(CATALOG_PATH.get(name) ?? '') ? 'Intune' : 'Entra ID';
  }
  if (/^(exchange|group-conversations)/.test(name)) return 'Exchange Online';
  if (/^teams/.test(name)) return 'Teams';
  if (/^purview/.test(name)) return 'Purview';
  if (/^sharepoint/.test(name)) return 'SharePoint';
  if (/^onedrive/.test(name)) return 'OneDrive';
  if (/^power-platform/.test(name)) return 'Power Platform';
  if (/^planner/.test(name)) return 'Planner';
  return 'Other';
}

const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = (value) => (value == null ? null : new Date(value).toISOString());
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nameOf = (payload, resourceType) => objectName(payload, resourceType);
// The settings catalog template family (an Intune antivirus policy is a Defender
// endpoint security policy), so lists can file the item where it belongs.
const familyOf = (...payloads) => {
  const family = payloads.map(templateFamilyOf).find(Boolean);
  return family ? { templateFamily: family } : {};
};

/** A type's read outcome on one side. A side with no digest (fixtures, old rows) is 'unknown' and compared. */
export function typeOutcome(coverage, type) {
  if (!isPlainObject(coverage)) return 'unknown';
  const entry = coverage[type];
  if (typeof entry === 'number') return 'complete';
  if (!isPlainObject(entry)) return 'not-requested';
  return typeof entry.outcome === 'string' ? entry.outcome : 'unknown';
}

const comparable = (outcome) => outcome === 'unknown' || READ.has(outcome);

/**
 * Masks every GUID, also inside a longer string ("ref:servicePrincipal:<appId>"), so
 * id-only differences vanish. A reference to a global constant (a Microsoft app or
 * role the same in every tenant) keeps its id: it names the same thing everywhere.
 */
function maskIds(value) {
  if (typeof value === 'string') return value.startsWith('ref:global:') ? value : value.replace(GUID_ANYWHERE, '<id>');
  if (Array.isArray(value)) return value.map(maskIds);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, maskIds(inner)]));
  return value;
}

/**
 * A payload as another tenant would hold it: each reference (by the same path format
 * walkGuids uses) becomes `ref:<natural key>`, and every id left over is masked.
 */
export function portablePayload(payload, references = []) {
  const byPath = new Map(references.map((ref) => [ref.field_path ?? ref.field, ref.to_symbol ?? ref.symbol ?? null]));
  const walk = (node, path) => {
    if (byPath.has(path) && (typeof node === 'string')) return `ref:${byPath.get(path) ?? 'unresolved'}`;
    if (Array.isArray(node)) return node.map((item, index) => walk(item, `${path}[${index}]`));
    if (isPlainObject(node)) {
      return Object.fromEntries(Object.entries(node).map(([key, inner]) => [key, walk(inner, path ? `${path}.${key}` : key)]));
    }
    return node;
  };
  return maskIds(walk(payload, ''));
}

// Stored hashes are not trusted: a row hashed before a field was classified as
// server-owned would differ from one hashed after (issue #288), so both sides are
// projected under the current rules.
function settingsFingerprint(row, { portable }) {
  // In the form diffs compare (engine/safety/diffHygiene.mjs): two copies that differ
  // only in empty values or list order are the same.
  if (portable) return sha(diffNormal(comparedSettings(row.resource_type, portablePayload(row.payload, row.references))));
  return sha(diffNormal(comparedSettings(row.resource_type, row.payload)));
}

function fieldDifferences(resourceType, before, after) {
  const change = semanticChange({ resourceType, changeType: 'modified', before, after, limit: MAX_FIELDS });
  return {
    fields: change.fields.map(({ path, kind, before: was, after: now }) => ({ path, kind, before: was ?? null, after: now ?? null })),
    fieldsTotal: change.total,
  };
}

/**
 * The settings of an object found on one side only, so an added or removed object
 * shows what it holds, not only that it is there: each top-level setting is listed
 * as added (or removed) with its value. Fields Microsoft sets itself are left out.
 * An Intune script's text is never listed, only its size and fingerprint: that
 * redaction is applied once, inside semanticChange, for every caller of
 * fieldDifferences (Compare and Activity alike).
 */
export function presenceFields(resourceType, payload, changeType) {
  const added = changeType === 'added';
  return fieldDifferences(resourceType, added ? {} : payload, added ? payload : {});
}

/**
 * The settings section. `left` and `right` are { rows, coverage }: rows carry
 * natural_key, resource_type, payload, payload_hash, hash_version, blast_radius and,
 * when portable, references [{ field_path, to_symbol }].
 */
export function compareSettings(left, right, { portable = false } = {}) {
  const byType = (rows) => {
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.resource_type)) map.set(row.resource_type, new Map());
      map.get(row.resource_type).set(row.natural_key, row);
    }
    return map;
  };
  const leftTypes = byType(left.rows);
  const rightTypes = byType(right.rows);
  const coverageTypes = [left.coverage, right.coverage].flatMap((coverage) => (isPlainObject(coverage) ? Object.keys(coverage) : []));
  const types = [...new Set([...leftTypes.keys(), ...rightTypes.keys(), ...coverageTypes])].sort();
  const totals = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  const groups = [];
  const notCompared = [];
  const unmatched = [];

  for (const resourceType of types) {
    const service = serviceOf('settings', resourceType);
    const before = leftTypes.get(resourceType) ?? new Map();
    const after = rightTypes.get(resourceType) ?? new Map();
    const leftOutcome = typeOutcome(left.coverage, resourceType);
    const rightOutcome = typeOutcome(right.coverage, resourceType);
    if (!comparable(leftOutcome) || !comparable(rightOutcome)) {
      // Both sides simply not asking for a type is not worth a line.
      if (leftOutcome === 'not-requested' && rightOutcome === 'not-requested' && before.size === 0 && after.size === 0) continue;
      notCompared.push({ resourceType, service, left: leftOutcome, right: rightOutcome });
      continue;
    }
    if (portable && TENANT_BOUND_TYPES.has(resourceType)) {
      if (before.size || after.size) unmatched.push({ resourceType, service, left: before.size, right: after.size });
      continue;
    }
    const group = { service, resourceType, added: 0, removed: 0, changed: 0, unchanged: 0, total: 0, items: [] };
    const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
    const unkeyed = { left: 0, right: 0 };
    for (const naturalKey of keys) {
      const was = before.get(naturalKey);
      const now = after.get(naturalKey);
      // Across tenants, a key holding an id (an app registered in one tenant, a key
      // that fell back to the object's id) found on one side only cannot be matched.
      if (portable && (!was || !now) && HAS_GUID.test(naturalKey)) {
        unkeyed[was ? 'left' : 'right'] += 1;
        continue;
      }
      if (was && !now) {
        group.removed += 1;
        const payload = portable ? portablePayload(was.payload, was.references) : was.payload;
        group.items.push({ naturalKey, name: nameOf(was.payload, resourceType), ...familyOf(was.payload), changeType: 'removed', blastRadius: changeBlastRadius(resourceType, was.payload, null, was.blast_radius ?? null), ...presenceFields(resourceType, payload, 'removed') });
        continue;
      }
      if (!was && now) {
        group.added += 1;
        const payload = portable ? portablePayload(now.payload, now.references) : now.payload;
        group.items.push({ naturalKey, name: nameOf(now.payload, resourceType), ...familyOf(now.payload), changeType: 'added', blastRadius: changeBlastRadius(resourceType, null, now.payload, now.blast_radius ?? null), ...presenceFields(resourceType, payload, 'added') });
        continue;
      }
      if (settingsFingerprint(was, { portable }) === settingsFingerprint(now, { portable })) {
        group.unchanged += 1;
        continue;
      }
      group.changed += 1;
      const differences = portable
        ? fieldDifferences(resourceType, portablePayload(was.payload, was.references), portablePayload(now.payload, now.references))
        : fieldDifferences(resourceType, was.payload, now.payload);
      group.items.push({ naturalKey, name: nameOf(now.payload, resourceType) ?? nameOf(was.payload, resourceType), ...familyOf(now.payload, was.payload), changeType: 'changed', blastRadius: changeBlastRadius(resourceType, was.payload, now.payload, now.blast_radius ?? null), ...differences });
    }
    if (unkeyed.left || unkeyed.right) unmatched.push({ resourceType, service, ...unkeyed });
    for (const key of ['added', 'removed', 'changed', 'unchanged']) totals[key] += group[key];
    if (group.added + group.removed + group.changed === 0) continue;
    group.items.sort((a, b) => CHANGE_ORDER[a.changeType] - CHANGE_ORDER[b.changeType] || a.naturalKey.localeCompare(b.naturalKey));
    group.total = group.items.length;
    // Counts per settings catalog template family over every changed item, listed or
    // not, so a page that files endpoint security policies under Defender counts the
    // ones past the list limit there too.
    const families = {};
    for (const item of group.items) {
      if (!item.templateFamily) continue;
      families[item.templateFamily] ??= { added: 0, removed: 0, changed: 0 };
      families[item.templateFamily][item.changeType] += 1;
    }
    if (Object.keys(families).length) group.families = families;
    group.items = group.items.slice(0, MAX_ITEMS);
    groups.push(group);
  }
  groups.sort((a, b) => a.service.localeCompare(b.service) || a.resourceType.localeCompare(b.resourceType));
  return { totals: { ...totals, notCompared: notCompared.length, unmatched: unmatched.length }, groups, notCompared, unmatched };
}

/** One workload field as two reads are compared: read-time noise is left out. */
function comparableField(workload, group, field, value) {
  return workload === EXCHANGE_WORKLOAD && group === 'mailboxSettings' ? comparableMailboxSetting(field, value) : value;
}

/** A workload observation's fields as `group.field` paths (identity is not a setting). */
function flattenFields(fields, workload) {
  const out = new Map();
  for (const [group, value] of Object.entries(fields ?? {})) {
    if (group === 'identity' || value === null || value === undefined) continue;
    if (isPlainObject(value)) for (const [field, inner] of Object.entries(value)) out.set(`${group}.${field}`, comparableField(workload, group, field, inner ?? null));
    else out.set(group, value);
  }
  return out;
}

const observed = (coverage, path) => {
  const entry = isPlainObject(coverage) ? coverage[path] : undefined;
  return entry === undefined || entry?.status === 'observed';
};

// The name a workload read carries for a resource (a SharePoint site's title), so the
// page never has to show the site id its key holds. Absent when the read had none.
const WORKLOAD_NAME_FIELDS = ['displayName', 'name', 'title', 'webUrl'];
function workloadName(...rows) {
  for (const row of rows) {
    for (const field of WORKLOAD_NAME_FIELDS) {
      const value = row?.fields?.[field];
      if (typeof value === 'string' && value.trim()) return value.replace(/^https?:\/\//, '').trim();
    }
  }
  return null;
}
const named = (item, ...rows) => {
  const name = workloadName(...rows);
  return name ? { ...item, name } : item;
};

/**
 * The workloads section. `left` and `right` map workload name to
 * { collectionId, outcome, at, observations: [{ resourceKey, fields, fieldCoverage }] }.
 */
export function compareWorkloads(left, right, { portable = false } = {}) {
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  const totals = { added: 0, removed: 0, changed: 0, unchanged: 0, notCompared: 0 };
  const groups = [];
  const clean = portable ? maskIds : (value) => value;
  for (const workload of names) {
    const was = left.get(workload) ?? null;
    const now = right.get(workload) ?? null;
    const sideOf = (side) => (side ? { collectionId: side.collectionId, outcome: side.outcome, at: iso(side.at) } : null);
    const group = { service: serviceOf('workload', workload), workload, left: sideOf(was), right: sideOf(now) };
    const usable = (side) => side && (READ.has(side.outcome) || side.outcome === 'partial');
    if (!usable(was) || !usable(now)) {
      totals.notCompared += 1;
      groups.push({ ...group, state: 'not-compared', reason: !was || !now ? 'not-collected' : 'collection-failed' });
      continue;
    }
    // Absence is only authority on a side whose collection read everything.
    const leftComplete = READ.has(was.outcome);
    const rightComplete = READ.has(now.outcome);
    const before = new Map(was.observations.map((row) => [row.resourceKey, row]));
    const after = new Map(now.observations.map((row) => [row.resourceKey, row]));
    const counts = { added: 0, removed: 0, changed: 0, unchanged: 0, unverified: 0, unverifiedFields: 0, unmatched: 0 };
    const items = [];
    for (const resourceKey of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const a = before.get(resourceKey);
      const b = after.get(resourceKey);
      // Across tenants a key holding an id (site:<id>) cannot be matched.
      if (portable && (!a || !b) && HAS_GUID.test(resourceKey)) { counts.unmatched += 1; continue; }
      if (a && !b) {
        if (rightComplete) { counts.removed += 1; items.push(named({ resourceKey, changeType: 'removed' }, a)); } else counts.unverified += 1;
        continue;
      }
      if (!a && b) {
        if (leftComplete) { counts.added += 1; items.push(named({ resourceKey, changeType: 'added' }, b)); } else counts.unverified += 1;
        continue;
      }
      const fa = flattenFields(a.fields, workload);
      const fb = flattenFields(b.fields, workload);
      const fields = [];
      for (const path of [...new Set([...fa.keys(), ...fb.keys()])].sort()) {
        if (!fa.has(path) || !fb.has(path) || !observed(a.fieldCoverage, path) || !observed(b.fieldCoverage, path)) {
          counts.unverifiedFields += 1;
          continue;
        }
        const x = clean(fa.get(path));
        const y = clean(fb.get(path));
        if (!sameForDiff(x, y)) fields.push({ path, kind: 'changed', before: maskCredentials(x, path), after: maskCredentials(y, path) });
      }
      if (fields.length === 0) { counts.unchanged += 1; continue; }
      counts.changed += 1;
      items.push(named({ resourceKey, changeType: 'changed', fields: fields.slice(0, MAX_FIELDS), fieldsTotal: fields.length }, b, a));
    }
    for (const key of ['added', 'removed', 'changed', 'unchanged']) totals[key] += counts[key];
    items.sort((x, y) => CHANGE_ORDER[x.changeType] - CHANGE_ORDER[y.changeType] || x.resourceKey.localeCompare(y.resourceKey));
    groups.push({ ...group, state: 'compared', ...counts, total: items.length, items: items.slice(0, MAX_ITEMS) });
  }
  groups.sort((a, b) => a.service.localeCompare(b.service) || a.workload.localeCompare(b.workload));
  return { totals, groups };
}

async function loadWorkloadSide(client, { tenantRef, at }) {
  const { rows: runs } = await client.query(
    `SELECT DISTINCT ON (workload) id, workload, outcome, created_at
       FROM workload_collection
      WHERE tenant_ref = $1 AND created_at <= $2
      ORDER BY workload, created_at DESC, id DESC`,
    [tenantRef, at],
  );
  const sides = new Map(runs.map((run) => [run.workload, { collectionId: run.id, outcome: run.outcome, at: run.created_at, observations: [] }]));
  if (runs.length) {
    const byId = new Map(runs.map((run) => [run.id, sides.get(run.workload)]));
    const { rows } = await client.query(
      `SELECT collection_id, resource_key, fields, field_coverage FROM workload_observation WHERE collection_id = ANY($1::uuid[])`,
      [runs.map((run) => run.id)],
    );
    for (const row of rows) byId.get(row.collection_id).observations.push({ resourceKey: row.resource_key, fields: row.fields, fieldCoverage: row.field_coverage });
  }
  return sides;
}

// Each content item at a time. Whether it still exists comes from its newest row: a
// deleted or removed marker in the metadata, or a SharePoint list item's
// `deleted:<version>` version, means it is gone. Its bytes come from its newest row
// that is not a drive record, since OneDrive and library files store the file and a
// small record under the same key, the record written last.
const LATEST_CONTENT = (tenant, at) => `
  SELECT latest.workload, latest.container, latest.item_key,
         coalesce(body.sha256, latest.sha256) AS sha256, coalesce(body.bytes, latest.bytes) AS bytes,
         coalesce(body.metadata, '{}'::jsonb) || latest.metadata AS metadata
    FROM (
      SELECT DISTINCT ON (workload, container, item_key) workload, container, item_key, sha256, bytes, metadata, version
        FROM content_item
       WHERE tenant_ref = ${tenant} AND created_at <= ${at}
       ORDER BY workload, container, item_key, created_at DESC, id DESC
    ) latest
    LEFT JOIN LATERAL (
      SELECT sha256, bytes, metadata FROM content_item c
       WHERE c.tenant_ref = ${tenant} AND c.created_at <= ${at} AND c.workload = latest.workload
         AND c.container = latest.container AND c.item_key = latest.item_key
         AND coalesce(c.metadata->>'kind', '') <> 'drive-record'
       ORDER BY c.created_at DESC, c.id DESC LIMIT 1
    ) body ON true
   WHERE NOT (coalesce(latest.metadata->>'deleted', '') = 'true' OR coalesce(latest.metadata->>'removed', '') = 'true'
              OR latest.version LIKE 'deleted:%')`;

const CONTENT_DIFF = `
  WITH l AS (${LATEST_CONTENT('$1', '$2')}), r AS (${LATEST_CONTENT('$3', '$4')}),
  d AS (
    SELECT coalesce(l.workload, r.workload) AS workload, coalesce(l.container, r.container) AS container,
           coalesce(l.item_key, r.item_key) AS item_key,
           CASE WHEN l.item_key IS NULL THEN 'added' WHEN r.item_key IS NULL THEN 'removed' ELSE 'changed' END AS change_type,
           l.sha256 AS before_sha256, r.sha256 AS after_sha256, l.bytes AS before_bytes, r.bytes AS after_bytes,
           coalesce(r.metadata, l.metadata) AS metadata
      FROM l FULL OUTER JOIN r ON l.workload = r.workload AND l.container = r.container AND l.item_key = r.item_key
     WHERE l.item_key IS NULL OR r.item_key IS NULL OR l.sha256 <> r.sha256)`;

function contentItemName(metadata) {
  for (const key of ['name', 'subject', 'displayName', 'title']) if (typeof metadata?.[key] === 'string') return metadata[key];
  return null;
}

/** The content section for one tenant at two times: item by item, by container. */
export async function compareContentItems(client, { tenantRef, leftAt, rightAt, rightTenantRef = tenantRef, limit = MAX_CONTENT_ITEMS }) {
  const params = [tenantRef, leftAt, rightTenantRef, rightAt];
  // One client runs one query at a time, so these are sequential.
  const { rows: counts } = await client.query(`${CONTENT_DIFF} SELECT workload, container, change_type, count(*)::int AS n FROM d GROUP BY 1, 2, 3`, params);
  const { rows: items } = await client.query(`${CONTENT_DIFF} SELECT * FROM d ORDER BY workload, container, change_type, item_key LIMIT $5`, [...params, limit]);
  const { rows: sizes } = await client.query(
    `WITH l AS (${LATEST_CONTENT('$1', '$2')}), r AS (${LATEST_CONTENT('$3', '$4')})
     SELECT 'left' AS side, workload, count(*)::int AS n FROM l GROUP BY workload
     UNION ALL SELECT 'right', workload, count(*)::int FROM r GROUP BY workload`,
    params,
  );
  const workloads = new Map();
  const workloadOf = (name) => {
    if (!workloads.has(name)) {
      workloads.set(name, { service: serviceOf('content', name), workload: name, leftItems: 0, rightItems: 0, added: 0, removed: 0, changed: 0, containers: new Map() });
    }
    return workloads.get(name);
  };
  for (const row of sizes) workloadOf(row.workload)[row.side === 'left' ? 'leftItems' : 'rightItems'] = row.n;
  const containerOf = (workload, container) => {
    if (!workload.containers.has(container)) workload.containers.set(container, { container, added: 0, removed: 0, changed: 0, items: [] });
    return workload.containers.get(container);
  };
  for (const row of counts) {
    const workload = workloadOf(row.workload);
    containerOf(workload, row.container)[row.change_type] += row.n;
    workload[row.change_type] += row.n;
  }
  for (const row of items) {
    containerOf(workloadOf(row.workload), row.container).items.push({
      itemKey: row.item_key, name: contentItemName(row.metadata), kind: row.metadata?.kind ?? null, changeType: row.change_type,
      beforeSha256: row.before_sha256, afterSha256: row.after_sha256,
      beforeBytes: row.before_bytes == null ? null : Number(row.before_bytes), afterBytes: row.after_bytes == null ? null : Number(row.after_bytes),
    });
  }
  const totals = { added: 0, removed: 0, changed: 0 };
  const groups = [...workloads.values()].map((workload) => {
    for (const key of Object.keys(totals)) totals[key] += workload[key];
    const containers = [...workload.containers.values()].sort((a, b) => a.container.localeCompare(b.container));
    return { ...workload, containers };
  }).sort((a, b) => a.service.localeCompare(b.service) || a.workload.localeCompare(b.workload));
  return { by: 'item', totals, groups, shown: items.length, total: totals.added + totals.removed + totals.changed };
}

/** The content section for two tenants: what each holds, and how much is held by both. */
export async function compareContentHoldings(client, { leftTenantRef, leftAt, rightTenantRef, rightAt }) {
  const params = [leftTenantRef, leftAt, rightTenantRef, rightAt];
  const { rows } = await client.query(
    `WITH l AS (${LATEST_CONTENT('$1', '$2')}), r AS (${LATEST_CONTENT('$3', '$4')}),
     ls AS (SELECT workload, count(*)::int AS items, coalesce(sum(bytes), 0)::bigint AS bytes, count(DISTINCT sha256)::int AS distinct_content FROM l GROUP BY workload),
     rs AS (SELECT workload, count(*)::int AS items, coalesce(sum(bytes), 0)::bigint AS bytes, count(DISTINCT sha256)::int AS distinct_content FROM r GROUP BY workload),
     shared AS (SELECT workload, count(*)::int AS n FROM (SELECT DISTINCT workload, sha256 FROM l) a JOIN (SELECT DISTINCT workload, sha256 FROM r) b USING (workload, sha256) GROUP BY workload)
     SELECT coalesce(ls.workload, rs.workload) AS workload,
            coalesce(ls.items, 0) AS left_items, coalesce(rs.items, 0) AS right_items,
            coalesce(ls.bytes, 0) AS left_bytes, coalesce(rs.bytes, 0) AS right_bytes,
            coalesce(ls.distinct_content, 0) AS left_distinct, coalesce(rs.distinct_content, 0) AS right_distinct,
            coalesce(shared.n, 0) AS shared
       FROM ls FULL OUTER JOIN rs ON rs.workload = ls.workload
       LEFT JOIN shared ON shared.workload = coalesce(ls.workload, rs.workload)
      ORDER BY 1`,
    params,
  );
  const groups = rows.map((row) => ({
    service: serviceOf('content', row.workload), workload: row.workload,
    leftItems: row.left_items, rightItems: row.right_items, leftBytes: Number(row.left_bytes), rightBytes: Number(row.right_bytes),
    inBoth: row.shared, onlyLeft: row.left_distinct - row.shared, onlyRight: row.right_distinct - row.shared,
  })).sort((a, b) => a.service.localeCompare(b.service) || a.workload.localeCompare(b.workload));
  const totals = groups.reduce((sum, group) => ({
    inBoth: sum.inBoth + group.inBoth, onlyLeft: sum.onlyLeft + group.onlyLeft, onlyRight: sum.onlyRight + group.onlyRight,
  }), { inBoth: 0, onlyLeft: 0, onlyRight: 0 });
  return { by: 'holdings', totals, groups };
}

async function loadSnapshot(client, snapshotId) {
  const { rows: [snapshot] } = await client.query(
    'SELECT id, tenant_ref, status, started_at, completed_at, coverage_digest FROM snapshot WHERE id::text = $1',
    [String(snapshotId)],
  );
  if (!snapshot) throw new CompareError('snapshot-not-found', `no snapshot ${snapshotId}`);
  if (snapshot.status !== 'complete' || !snapshot.completed_at) {
    throw new CompareError('snapshot-incomplete', `snapshot ${snapshotId} has not completed`);
  }
  return snapshot;
}

async function loadSnapshotRows(client, snapshotId, { references }) {
  const { rows } = await client.query(
    `SELECT id, natural_key, resource_type, payload, payload_hash, hash_version, blast_radius
       FROM resource_version WHERE snapshot_id = $1`,
    [snapshotId],
  );
  if (references && rows.length) {
    const { rows: refs } = await client.query(
      `SELECT rr.from_version, rr.field_path, rr.to_symbol
         FROM resource_reference rr JOIN resource_version rv ON rv.id = rr.from_version
        WHERE rv.snapshot_id = $1`,
      [snapshotId],
    );
    const byVersion = new Map();
    for (const ref of refs) {
      if (!byVersion.has(ref.from_version)) byVersion.set(ref.from_version, []);
      byVersion.get(ref.from_version).push(ref);
    }
    for (const row of rows) row.references = byVersion.get(row.id) ?? [];
  }
  return rows;
}

const describeSnapshot = (snapshot) => ({
  kind: 'snapshot', tenantRef: snapshot.tenant_ref, snapshotId: snapshot.id, at: iso(snapshot.completed_at),
});

function sectionsOf(sections) {
  const wanted = sections ?? COMPARE_SECTIONS;
  for (const section of wanted) {
    if (!COMPARE_SECTIONS.includes(section)) throw new CompareError('bad-section', `unknown section ${section}`);
  }
  return new Set(wanted);
}

async function assemble(client, { mode, left, right, leftSettings, rightSettings, sections, now, rightAt }) {
  const portable = left.tenantRef !== right.tenantRef;
  const result = {
    version: COMPARE_VERSION, mode, portable, generatedAt: iso(now), left, right,
    settings: null, workloads: null, content: null,
  };
  if (sections.has('settings')) result.settings = compareSettings(leftSettings, rightSettings, { portable });
  if (sections.has('workloads')) {
    const a = await loadWorkloadSide(client, { tenantRef: left.tenantRef, at: left.at });
    const b = await loadWorkloadSide(client, { tenantRef: right.tenantRef, at: rightAt });
    result.workloads = compareWorkloads(a, b, { portable });
  }
  if (sections.has('content')) {
    result.content = portable
      ? await compareContentHoldings(client, { leftTenantRef: left.tenantRef, leftAt: left.at, rightTenantRef: right.tenantRef, rightAt })
      : await compareContentItems(client, { tenantRef: left.tenantRef, leftAt: left.at, rightAt });
  }
  return result;
}

/** Any two completed snapshots. Snapshots of two tenants are compared portably. */
export async function compareSnapshots(client, { leftSnapshotId, rightSnapshotId, sections = COMPARE_SECTIONS, now = new Date() }) {
  const wanted = sectionsOf(sections);
  const a = await loadSnapshot(client, leftSnapshotId);
  const b = await loadSnapshot(client, rightSnapshotId);
  const portable = a.tenant_ref !== b.tenant_ref;
  const leftRows = wanted.has('settings') ? await loadSnapshotRows(client, a.id, { references: portable }) : [];
  const rightRows = wanted.has('settings') ? await loadSnapshotRows(client, b.id, { references: portable }) : [];
  const left = describeSnapshot(a);
  const right = describeSnapshot(b);
  return assemble(client, {
    mode: portable ? 'tenants' : 'snapshots', left, right, sections: wanted, now, rightAt: right.at,
    leftSettings: { rows: leftRows, coverage: a.coverage_digest }, rightSettings: { rows: rightRows, coverage: b.coverage_digest },
  });
}

/** The newest completed snapshot of a tenant, or null. */
export async function latestCompletedSnapshot(client, { tenantRef }) {
  const { rows: [snapshot] } = await client.query(
    `SELECT id FROM snapshot WHERE tenant_ref = $1 AND status = 'complete' AND completed_at IS NOT NULL
      ORDER BY completed_at DESC, id DESC LIMIT 1`,
    [tenantRef],
  );
  return snapshot?.id ?? null;
}

/** One tenant's latest completed snapshot against another's. */
export async function compareTenants(client, { leftTenantRef, rightTenantRef, sections = COMPARE_SECTIONS, now = new Date() }) {
  if (leftTenantRef === rightTenantRef) throw new CompareError('same-tenant', 'compare two different tenants, or two snapshots of one');
  const leftSnapshotId = await latestCompletedSnapshot(client, { tenantRef: leftTenantRef });
  const rightSnapshotId = await latestCompletedSnapshot(client, { tenantRef: rightTenantRef });
  if (!leftSnapshotId) throw new CompareError('no-snapshot', `no completed snapshot for ${leftTenantRef}`);
  if (!rightSnapshotId) throw new CompareError('no-snapshot', `no completed snapshot for ${rightTenantRef}`);
  const result = await compareSnapshots(client, { leftSnapshotId, rightSnapshotId, sections, now });
  return { ...result, mode: 'tenants' };
}

/**
 * The live side: the collector's own GET reads, canonicalized exactly as a snapshot
 * is, against the tenant's identity context. Nothing is written.
 */
export async function collectLiveSettings(client, { reader, tenantId, tenantRef }) {
  const result = await collectWithOutcomes(reader, { tenantId });
  const context = await loadSymbolContext(client, { tenantRef });
  const resources = canonicalizeAll(result.collected, { context });
  return {
    coverage: result.coverageDigest,
    rows: resources.map((resource) => ({
      natural_key: resource.naturalKey,
      resource_type: resource.resourceType,
      payload: resource.payload,
      payload_hash: canonicalHash(resource.payload, resource.resourceType),
      hash_version: HASH_VERSION,
      blast_radius: resource.blastRadius ?? null,
      references: resource.references.map((ref) => ({ field_path: ref.field, to_symbol: ref.symbol })),
    })),
  };
}

/**
 * A completed snapshot against the tenant now. Settings are read live; workloads and
 * content come from the newest stored collection and index (their reads need their own
 * gated collectors), which the result states as `latestStored`.
 */
export async function compareWithLive(client, {
  snapshotId, tenantRef, reader, tenantId, sections = COMPARE_SECTIONS, now = new Date(), collectLive = collectLiveSettings,
}) {
  const wanted = sectionsOf(sections);
  const snapshot = await loadSnapshot(client, snapshotId);
  if (snapshot.tenant_ref !== tenantRef) {
    throw new CompareError('tenant-mismatch', 'the snapshot belongs to another tenant than the one being read');
  }
  const leftRows = wanted.has('settings') ? await loadSnapshotRows(client, snapshot.id, { references: false }) : [];
  const live = wanted.has('settings') ? await collectLive(client, { reader, tenantId, tenantRef }) : { rows: [], coverage: null };
  const left = describeSnapshot(snapshot);
  const right = { kind: 'live', tenantRef, snapshotId: null, at: iso(now), latestStored: ['workloads', 'content'].filter((s) => wanted.has(s)) };
  return assemble(client, {
    mode: 'live', left, right, sections: wanted, now, rightAt: right.at,
    leftSettings: { rows: leftRows, coverage: snapshot.coverage_digest }, rightSettings: live,
  });
}

/** What the portal's pickers offer: each tenant with its newest completed snapshots. */
export async function listCompareSources(client, { limit = 50 } = {}) {
  const { rows } = await client.query(
    `SELECT tenant_ref, id, completed_at, n FROM (
       SELECT s.tenant_ref, s.id, s.completed_at,
              (SELECT count(*)::int FROM resource_version rv WHERE rv.snapshot_id = s.id) AS n,
              row_number() OVER (PARTITION BY s.tenant_ref ORDER BY s.completed_at DESC, s.id DESC) AS rank
         FROM snapshot s
        WHERE s.status = 'complete' AND s.completed_at IS NOT NULL) ranked
      WHERE rank <= $1
      ORDER BY tenant_ref, completed_at DESC, id DESC`,
    [limit],
  );
  const tenants = new Map();
  for (const row of rows) {
    if (!tenants.has(row.tenant_ref)) tenants.set(row.tenant_ref, { tenantRef: row.tenant_ref, snapshots: [] });
    tenants.get(row.tenant_ref).snapshots.push({ id: row.id, completedAt: iso(row.completed_at), resourceCount: row.n });
  }
  return [...tenants.values()];
}

/** Every difference a compare found, for a one-line summary. */
export function differenceCount(result) {
  const settings = result.settings ? result.settings.totals.added + result.settings.totals.removed + result.settings.totals.changed : 0;
  const workloads = result.workloads ? result.workloads.totals.added + result.workloads.totals.removed + result.workloads.totals.changed : 0;
  const content = !result.content ? 0 : result.content.by === 'item'
    ? result.content.total
    : result.content.totals.onlyLeft + result.content.totals.onlyRight;
  return { settings, workloads, content, total: settings + workloads + content };
}
