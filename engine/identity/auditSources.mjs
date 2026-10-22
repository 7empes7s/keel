/**
 * Who made a change: reading Microsoft's own audit logs with the Collector.
 *
 * Two logs are read today, both through Microsoft Graph with read permissions the
 * Collector already holds:
 *
 *   audit         Microsoft Entra audit log   GET /auditLogs/directoryAudits   AuditLog.Read.All
 *   intune-audit  Intune audit log            GET /deviceManagement/auditEvents DeviceManagementConfiguration.Read.All
 *
 * Exchange, SharePoint, Teams, Purview, Power Platform and Defender changes are kept in
 * the Purview (unified) audit log. KEEL does not read it yet: Graph's audit log query
 * API needs AuditLogsQuery.Read.All, which the Collector does not hold. Changes of those
 * services say so plainly (reason `audit-source-not-read`), never "nobody".
 *
 * Each audit record becomes one minimized event per object it names (task 91's fact:
 * object id, operation, bounded activity name, actor kind and object id). No UPN,
 * display name, IP address or changed value leaves this module.
 */
import { createHash } from 'node:crypto';
import { redactSecrets } from '../../tools/tenant-probe/graph.mjs';
import { typeInfo } from '../insights/taxonomy.mjs';
import { ingestAudit } from './auditIngest.mjs';

export const AUDIT_SOURCES = Object.freeze({
  audit: Object.freeze({ service: 'Entra', label: 'Microsoft Entra audit log', lookbackDays: 30 }),
  'intune-audit': Object.freeze({ service: 'Intune', label: 'Intune audit log', lookbackDays: 30 }),
});

// The unified audit log Microsoft keeps for every other service, and what reading it
// would take. Named so the page can say what is missing.
export const UNIFIED_AUDIT = Object.freeze({ label: 'Purview audit log', permission: 'AuditLogsQuery.Read.All' });

// Relationship changes (diffSnapshots.mjs EDGE_RESOURCE_TYPE) are audited on their parent.
const EDGE_SOURCES = Object.freeze({
  groupMembership: 'audit', groupOwnership: 'audit', groupTransitiveMembership: 'audit',
  applicationOwnership: 'audit', servicePrincipalOwnership: 'audit', appRoleGrant: 'audit',
  policyAssignment: 'intune-audit',
});
const SERVICE_SOURCES = Object.freeze({ Entra: 'audit', Intune: 'intune-audit' });

/** Which audit log records changes of this type: { source, service }; source is null when KEEL reads none. */
export function auditSourceFor(resourceType) {
  if (EDGE_SOURCES[resourceType]) {
    const source = EDGE_SOURCES[resourceType];
    return { source, service: AUDIT_SOURCES[source].service };
  }
  const service = typeInfo(resourceType).service;
  return { source: SERVICE_SOURCES[service] ?? null, service };
}

const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guid = (value) => (typeof value === 'string' && OBJECT_ID.test(value) ? value.toLowerCase() : null);

/**
 * The Microsoft object ids an audit record about this change would name: the object's
 * own id from its saved copy, or for a relationship change (`edge:<type>:<parent>:<target>`)
 * the parent and the target.
 */
export function changeObjectIds({ naturalKey, before, after }) {
  const ids = [];
  if (typeof naturalKey === 'string' && naturalKey.startsWith('edge:')) {
    const [, , parent, target] = naturalKey.split(':');
    ids.push(guid(parent), guid(target));
  } else {
    ids.push(guid(after?.id), guid(before?.id));
  }
  return [...new Set(ids.filter(Boolean))];
}

function typeName(value) {
  if (typeof value !== 'string') return 'other';
  const last = value.split('.').at(-1).replace(/[^A-Za-z0-9]/g, '');
  if (!/^[A-Za-z]/.test(last)) return 'other';
  return (last.charAt(0).toLowerCase() + last.slice(1)).slice(0, 64);
}

// A Microsoft operation name can hold one very long CamelCase word (Intune's
// "UpdateWindowsFeatureUpdateProfileAssignmentsAsync ..." is 49 letters). redactSecrets
// takes any 48+ character run for a token, and the stored fact refuses a redacted
// activity, which failed the whole page (issue #552). A long word that reads as a name
// is split into its parts: capitalised words, short acronyms ("IOS"), short numbers
// ("Windows10") and an optional lowercase first word ("ios..."). A two-letter part must
// be a known short word ("To", "By", "Id"). At least three quarters of the letters must
// sit in words (three or more letters with a vowel, or a known short word). Random
// tokens fail this as often as the old CamelCase-only rule did or more (letters-only
// tokens) and always in practice for tokens with digits, hex or all-caps.
// Anything still token-shaped drops the activity (it is optional); the event is kept.
const SHORT_WORDS = new Set(['To', 'Of', 'In', 'On', 'By', 'Up', 'As', 'At', 'Is', 'Or', 'No', 'An', 'If', 'Me', 'My',
  'Id', 'Do', 'Go', 'Be', 'Os', 'Ad', 'Ip', 'Pc', 'Vm', 'Ui', 'Ux', 'Ok', 'Us']);
const NAME_PART = /[A-Z][a-z]{1,15}(?![a-z])|[A-Z]{2,5}(?=[A-Z][a-z]|\d|$)|\d{1,4}(?!\d)/y;
const isWord = (part) => SHORT_WORDS.has(part) || (/^[A-Z]?[a-z]{2,}$/.test(part) && /[aeiouy]/i.test(part));
function nameParts(word) {
  const lead = /^[a-z]{2,12}(?=[A-Z])/.exec(word)?.[0] ?? '';
  const parts = lead ? [lead] : [];
  NAME_PART.lastIndex = lead.length;
  while (NAME_PART.lastIndex < word.length) {
    const match = NAME_PART.exec(word);
    if (!match || (/^[A-Z][a-z]$/.test(match[0]) && !SHORT_WORDS.has(match[0]))) return null;
    parts.push(match[0]);
  }
  return parts.filter(isWord).join('').length * 4 >= word.length * 3 ? parts : null;
}
// The whole name is checked for tokens before it is cut to 96 characters, so a token
// near the end cannot be stored as a shorter prefix.
function activityName(value) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[^A-Za-z0-9 ._()-]/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').map((word) => (word.length >= 48 ? nameParts(word)?.join(' ') ?? word : word))
    .join(' ');
  if (!/^[A-Za-z0-9]/.test(clean) || redactSecrets(clean) !== clean) return null;
  return clean.slice(0, 96).trim();
}

const ENTRA_OPERATIONS = Object.freeze({ add: 'create', update: 'update', delete: 'delete', assign: 'update', unassign: 'update' });
const INTUNE_OPERATIONS = Object.freeze({
  create: 'create', delete: 'delete', patch: 'update', update: 'update', action: 'update', assign: 'update', set: 'update',
});

// Microsoft record ids are kept as they are when short. A long one (Entra's B2C ids run
// past 48 characters) looks like a token to redactSecrets, which would reject the whole
// page (issue #514), so it becomes a stable SHA-256 prefix instead.
function recordRef(id) {
  const clean = String(id).replace(/[^a-zA-Z0-9_:.-]/g, '');
  if (clean && clean.length <= 100 && redactSecrets(clean) === clean) return clean;
  return `h${createHash('sha256').update(String(id)).digest('hex').slice(0, 32)}`;
}
const ref = (prefix, id, index) => `${prefix}:${recordRef(id)}:${index}`;

function eventsFor(prefix, id, occurredAt, targets, base) {
  if (typeof id !== 'string' || !id || !Number.isFinite(Date.parse(occurredAt))) return [];
  const at = new Date(occurredAt).toISOString();
  if (!base || !targets.length) return [{ id: ref(prefix, id, 0), occurredAt: at }];
  return targets.map((target, index) => ({
    id: ref(prefix, id, index), occurredAt: at,
    change: { ...base, targetType: target.type, targetId: target.id },
  }));
}

/** One Entra directoryAudit record as minimized events (one per object it names). */
export function directoryAuditEvents(record) {
  const operation = ENTRA_OPERATIONS[String(record?.operationType ?? '').toLowerCase()];
  const success = String(record?.result ?? '').toLowerCase() === 'success';
  const user = guid(record?.initiatedBy?.user?.id);
  const app = guid(record?.initiatedBy?.app?.servicePrincipalId);
  const actor = user ? { actorKind: 'user', actorId: user } : app ? { actorKind: 'servicePrincipal', actorId: app } : null;
  const targets = (Array.isArray(record?.targetResources) ? record.targetResources : [])
    .map((target) => ({ id: guid(target?.id), type: typeName(target?.type) }))
    .filter((target) => target.id);
  const base = operation && success && actor
    ? { operation, activity: activityName(record.activityDisplayName), fields: [], ...actor }
    : null;
  return eventsFor('entra', record?.id, record?.activityDateTime, targets, base);
}

/**
 * One Intune auditEvent as minimized events. An app actor carries only its app id, so
 * `servicePrincipalFor(appId)` turns it into the service principal's object id (or null).
 */
export async function intuneAuditEvents(record, servicePrincipalFor = async () => null) {
  const operation = INTUNE_OPERATIONS[String(record?.activityOperationType ?? '').toLowerCase()];
  const success = String(record?.activityResult ?? '').toLowerCase() === 'success';
  const user = guid(record?.actor?.userId);
  let actor = user ? { actorKind: 'user', actorId: user } : null;
  if (!actor && guid(record?.actor?.applicationId) && operation && success) {
    const sp = guid(await servicePrincipalFor(guid(record.actor.applicationId)));
    if (sp) actor = { actorKind: 'servicePrincipal', actorId: sp };
  }
  const targets = (Array.isArray(record?.resources) ? record.resources : [])
    .map((target) => ({ id: guid(target?.resourceId), type: typeName(target?.type) }))
    .filter((target) => target.id);
  const base = operation && success && actor
    ? { operation, activity: activityName(record.activity ?? record.activityType), fields: [], ...actor }
    : null;
  return eventsFor('intune', record?.id, record?.activityDateTime, targets, base);
}

const PATHS = Object.freeze({
  audit: (from, until) => `/auditLogs/directoryAudits?$filter=${encodeURIComponent(`activityDateTime ge ${from} and activityDateTime le ${until}`)}`,
  'intune-audit': (from, until) => `/deviceManagement/auditEvents?$filter=${encodeURIComponent(`activityDateTime ge ${from} and activityDateTime le ${until}`)}`,
});

/**
 * The task-88 read-only adapter over Graph for one log. The whole window is read on the
 * first page request and kept, so the integer cursor is an offset into a stable, sorted
 * list. A window with more than `pageCap` Graph pages fails rather than claim a
 * complete read.
 */
export function createGraphAuditAdapter({ tenantRef, reader, pageCap = 50 }) {
  let cached = null;
  const servicePrincipals = new Map();
  const servicePrincipalFor = async (appId) => {
    if (!servicePrincipals.has(appId)) {
      const res = await reader.get('v1.0', `/servicePrincipals(appId='${appId}')?$select=id`);
      servicePrincipals.set(appId, res.ok ? res.body?.id ?? null : null);
    }
    return servicePrincipals.get(appId);
  };
  return {
    tenantRef, credentialMode: 'collector-read-only', synthetic: false,
    async readPage({ source, from, until, cursor, limit }) {
      const key = `${source}|${from}|${until}`;
      if (cached?.key !== key) {
        const path = PATHS[source];
        if (!path) throw new Error('unsupported audit source');
        const read = await reader.collect('v1.0', path(from, until), { pageCap });
        if (read.error) throw Object.assign(new Error(`audit log read failed (${read.error.status})`), { status: read.error.status });
        if (read.capped) throw new Error('too many audit records for one window');
        const events = [];
        for (const record of read.items) {
          events.push(...(source === 'audit' ? directoryAuditEvents(record) : await intuneAuditEvents(record, servicePrincipalFor)));
        }
        const lo = Date.parse(from), hi = Date.parse(until);
        const inWindow = events.filter((event) => Date.parse(event.occurredAt) >= lo && Date.parse(event.occurredAt) <= hi);
        inWindow.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
        cached = { key, events: [...new Map(inWindow.map((event) => [event.id, event])).values()] };
      }
      const start = cursor ?? 0;
      const end = Math.min(start + limit, cached.events.length);
      return { events: cached.events.slice(start, end), nextCursor: end < cached.events.length ? end : null };
    },
  };
}

const DAY = 24 * 60 * 60 * 1000;
// Microsoft writes audit records a few minutes late; a window that ends now would be
// marked complete before its last records exist.
const SETTLE_MS = 15 * 60 * 1000;

/**
 * Reads each log forward from where the last run stopped, one day at a time, until it
 * reaches a quarter of an hour ago or `maxWindows` days were read. The first run starts
 * `lookbackDays` back. Never throws: a log that cannot be read is recorded by ingestAudit
 * as its run's status, which is what the change page then says.
 */
export async function ingestCollectorAudit(client, {
  tenantRef, reader, requestedBy, now = new Date(), sources = Object.keys(AUDIT_SOURCES), maxWindows = 31, log = () => {},
  adapterFor = (source) => createGraphAuditAdapter({ tenantRef, reader, source }),
}) {
  const results = {};
  const exists = await client.query("SELECT to_regclass('audit_ingest_state') AS name");
  if (!exists.rows[0].name) return { status: 'not-configured' };
  const end = new Date(now.getTime() - SETTLE_MS).toISOString();
  for (const source of sources) {
    const outcome = { windows: 0, status: null, insertedEvents: 0 };
    results[source] = outcome;
    try {
      for (let i = 0; i < maxWindows; i++) {
        const { rows: [state] } = await client.query(
          'SELECT window_from, window_until, complete FROM audit_ingest_state WHERE tenant_ref=$1 AND source=$2', [tenantRef, source],
        );
        let from;
        let until;
        if (state?.window_until && !state.complete) {
          // An unfinished window resumes exactly as it was asked.
          from = state.window_from.toISOString();
          until = state.window_until.toISOString();
        } else {
          from = state?.complete ? state.window_until.toISOString()
            : new Date(Date.parse(end) - AUDIT_SOURCES[source].lookbackDays * DAY).toISOString();
          if (from >= end) break;
          until = new Date(Math.min(Date.parse(from) + DAY, Date.parse(end))).toISOString();
        }
        const evidence = await ingestAudit(client, {
          tenantRef, managedTenantRef: tenantRef, requestedBy, source, enabled: true, from, until,
          adapter: adapterFor(source), retentionDays: 90, maxRequests: 100, maxEvents: 10000, maxDurationMs: 60000, pageSize: 1000,
        });
        outcome.windows++;
        outcome.status = evidence.status;
        outcome.insertedEvents += evidence.insertedEvents ?? 0;
        if (!['complete', 'complete-empty'].includes(evidence.status)) break;
      }
    } catch (error) {
      outcome.status = 'failed';
      outcome.error = error instanceof Error ? error.message : String(error);
    }
    log(`${AUDIT_SOURCES[source].label}: ${outcome.status ?? 'up to date'} (${outcome.windows} day(s) read, ${outcome.insertedEvents} new record(s))`);
  }
  return { status: 'ran', sources: results };
}
