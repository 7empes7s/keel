/**
 * Task 91: evidence-based change attribution.
 *
 * A change KEEL observed (a drift row: one resource, its changed fields, and the window
 * between the last time KEEL saw it unchanged and the collection that saw it changed)
 * is attributed to the account that made it only from task-88 audit evidence:
 *
 *   exact      one actor, and only that actor, has an audit record that names THIS
 *              resource (type and Microsoft object id, never a display name), an
 *              operation consistent with the change, fields that do not contradict
 *              it, inside the window; AND the audit log is known to be complete for
 *              the whole window.
 *   plausible  a record names this resource but the log is incomplete for the window,
 *              or several actors' records name it; or no record names it and exactly
 *              one account signed in during the window (sign-in context only).
 *   unknown    everything else: no audit log, a retention gap, a revoked or failed
 *              read, an organization archive KEEL does not read, a resource whose
 *              identity cannot be resolved, or several accounts signed in nearby.
 *
 * Temporal proximity alone is never exact: a sign-in carries no resource and no
 * operation, so it supports at most `plausible`.
 *
 * Minimization: an audit fact keeps the event id and time, the target's type and
 * object id, the operation, a bounded activity name, the changed field NAMES (never
 * values) and the actor's kind and object id. A sign-in fact keeps the event id, time
 * and the actor's kind and object id. No UPN, display name, IP address, user agent,
 * token or payload is stored. An actor is named from KEEL's own collected inventory
 * (the user or service principal resource with that object id in the same tenant),
 * and only when the reader's entity scope can see that resource.
 *
 * Tenant isolation: facts are keyed and read by tenant_ref, the classifier refuses a
 * fact from another tenant, and actor names resolve through the same tenant's
 * lineage, so an object id shared across tenants never joins them.
 */
import { ownershipVisibleTo } from '../authz/entityScope.mjs';
import { redactSecrets } from '../../tools/tenant-probe/graph.mjs';

export const ATTRIBUTION_VERDICTS = Object.freeze(['exact', 'plausible', 'unknown']);
export const MAX_ATTRIBUTED_CHANGES = 200;
const MAX_EVENTS_PER_CHANGE = 50;
const MAX_SIGN_IN_ACTORS = 10;
const MAX_FIELDS = 64;
const DEFAULT_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPE_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const ACTIVITY = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,95}$/;
const ACTOR_KINDS = Object.freeze(['user', 'servicePrincipal']);
// Microsoft directoryAudit operationType values and KEEL's normalized ones.
const OPERATIONS = Object.freeze({
  Add: 'create', Update: 'update', Delete: 'delete', Assign: 'update', Unassign: 'update',
  create: 'create', update: 'update', delete: 'delete',
});
// Which audited operation can explain which observed change.
const CHANGE_OPERATIONS = Object.freeze({ added: ['create'], modified: ['update'], removed: ['delete'] });

export class AttributionFactError extends Error {}

export async function migrateChangeAttribution(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS audit_change_fact (
      tenant_ref text NOT NULL, source_event_id text NOT NULL,
      occurred_at timestamptz NOT NULL,
      target_type text NOT NULL, target_id text NOT NULL,
      operation text NOT NULL CHECK (operation IN ('create','update','delete')),
      activity text, fields text[] NOT NULL DEFAULT '{}',
      actor_kind text NOT NULL CHECK (actor_kind IN ('user','servicePrincipal')),
      actor_id text NOT NULL,
      PRIMARY KEY (tenant_ref, source_event_id)
    );
    CREATE INDEX IF NOT EXISTS audit_change_fact_target
      ON audit_change_fact(tenant_ref, target_type, target_id, occurred_at);
    CREATE TABLE IF NOT EXISTS audit_sign_in_fact (
      tenant_ref text NOT NULL, source_event_id text NOT NULL,
      occurred_at timestamptz NOT NULL,
      actor_kind text NOT NULL CHECK (actor_kind IN ('user','servicePrincipal')),
      actor_id text NOT NULL,
      PRIMARY KEY (tenant_ref, source_event_id)
    );
    CREATE INDEX IF NOT EXISTS audit_sign_in_fact_time ON audit_sign_in_fact(tenant_ref, occurred_at);
  `);
}

function objectId(value, what) {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) throw new AttributionFactError(`invalid ${what}`);
  return value.toLowerCase();
}
function actorKind(value) {
  if (!ACTOR_KINDS.includes(value)) throw new AttributionFactError('invalid actor kind');
  return value;
}

/**
 * The minimized attribution fact carried by one adapter event, or null when the event
 * carries none. Audit events may carry
 *   change: { targetType, targetId, operation, activity?, fields?, actorKind, actorId }
 * and sign-in events may carry actor: { kind, id }. Anything else on the event is
 * ignored; an invalid fact refuses the whole page (the cursor does not advance).
 */
export function minimizeAttributionFact(source, event) {
  if (source === 'audit') {
    const change = event?.change;
    if (change === undefined) return null;
    if (!change || typeof change !== 'object') throw new AttributionFactError('invalid change');
    if (typeof change.targetType !== 'string' || !TYPE_NAME.test(change.targetType)) throw new AttributionFactError('invalid target type');
    const operation = OPERATIONS[change.operation];
    if (!operation) throw new AttributionFactError('invalid operation');
    let activity = null;
    if (change.activity !== undefined && change.activity !== null) {
      if (typeof change.activity !== 'string' || !ACTIVITY.test(change.activity) || redactSecrets(change.activity) !== change.activity) {
        throw new AttributionFactError('invalid activity');
      }
      activity = change.activity;
    }
    const fields = change.fields ?? [];
    if (!Array.isArray(fields) || fields.length > MAX_FIELDS || fields.some((field) => typeof field !== 'string' || !FIELD_NAME.test(field))) {
      throw new AttributionFactError('invalid fields');
    }
    return {
      kind: 'change', targetType: change.targetType, targetId: objectId(change.targetId, 'target id'), operation, activity,
      fields: [...new Set(fields)].sort(), actorKind: actorKind(change.actorKind), actorId: objectId(change.actorId, 'actor id'),
    };
  }
  if (source === 'sign-in') {
    const actor = event?.actor;
    if (actor === undefined) return null;
    if (!actor || typeof actor !== 'object') throw new AttributionFactError('invalid actor');
    return { kind: 'sign-in', actorKind: actorKind(actor.kind), actorId: objectId(actor.id, 'actor id') };
  }
  return null;
}

/** Persists a minimized fact; called inside task 88's page transaction. */
export async function insertAttributionFact(client, { tenantRef, eventId, occurredAt, fact }) {
  if (fact.kind === 'change') {
    const result = await client.query(
      `INSERT INTO audit_change_fact (tenant_ref, source_event_id, occurred_at, target_type, target_id, operation, activity, fields, actor_kind, actor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [tenantRef, eventId, occurredAt, fact.targetType, fact.targetId, fact.operation, fact.activity, fact.fields, fact.actorKind, fact.actorId],
    );
    return result.rowCount;
  }
  const result = await client.query(
    `INSERT INTO audit_sign_in_fact (tenant_ref, source_event_id, occurred_at, actor_kind, actor_id)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [tenantRef, eventId, occurredAt, fact.actorKind, fact.actorId],
  );
  return result.rowCount;
}

/** Same retention rule as task 88's minimized events. */
export async function pruneAttributionFacts(client, { tenantRef, source, until, retentionDays }) {
  const table = source === 'audit' ? 'audit_change_fact' : 'audit_sign_in_fact';
  await client.query(`DELETE FROM ${table} WHERE tenant_ref=$1 AND occurred_at < $2::timestamptz - $3 * interval '1 day'`,
    [tenantRef, until, retentionDays]);
}

const ms = (value) => (value instanceof Date ? value.getTime() : Date.parse(value));

/**
 * Whether one source's log is known to be complete for [from, until], from task 88's
 * own run evidence. Only `complete` / `complete-empty` runs prove traversal of their
 * window. A window older than what KEEL's own retention keeps, or overlapping a
 * retention gap Microsoft reported, is a gap. Statuses:
 *   covered | retention-gap | read-scope-revoked | read-failed | not-read |
 *   archive-reference | not-configured
 */
export function coverageFromRuns({ runs, state }, { from, until }) {
  if (!runs.length && !state) return { status: 'not-configured' };
  const windows = [];
  const gaps = [];
  let keptFrom = -Infinity;
  let archiveRef = null;
  let lastFailure = null;
  for (const run of runs) {
    const evidence = run.evidence ?? {};
    if (evidence.retentionGap) gaps.push(evidence.retentionGap);
    if (evidence.archiveRef) archiveRef ??= evidence.archiveRef;
    if (['complete', 'complete-empty'].includes(evidence.status) && evidence.window) {
      windows.push([ms(evidence.window.from), ms(evidence.window.until)]);
      if (Number.isSafeInteger(evidence.retentionDays)) {
        keptFrom = Math.max(keptFrom, ms(evidence.window.until) - evidence.retentionDays * 86400000);
      }
    }
    if (!lastFailure && ['read-scope-revoked', 'read-failed', 'invalid-page', 'failed'].includes(evidence.status)) lastFailure = evidence.status;
  }
  if (state?.retention_gap) gaps.push(state.retention_gap);
  const lo = ms(from), hi = ms(until);
  if (gaps.some((gap) => ms(gap.from) < hi && ms(gap.until) > lo) || lo < keptFrom) return { status: 'retention-gap' };
  // Does the union of completed windows cover [lo, hi]?
  windows.sort((a, b) => a[0] - b[0]);
  let reach = lo;
  for (const [start, end] of windows) {
    if (start > reach) break;
    reach = Math.max(reach, end);
  }
  if (reach >= hi && windows.length) return { status: 'covered' };
  if (lastFailure === 'read-scope-revoked') return { status: 'read-scope-revoked' };
  if (lastFailure) return { status: 'read-failed' };
  if (archiveRef && !windows.length) return { status: 'archive-reference' };
  return { status: 'not-read' };
}

const actorKey = (fact) => `${fact.actorKind}:${fact.actorId}`;
const within = (fact, window) => ms(fact.occurredAt) > ms(window.from) && ms(fact.occurredAt) <= ms(window.until);

function fieldsAgree(changeFields, factFields) {
  if (!changeFields?.length || !factFields?.length) return true;
  return factFields.some((field) => changeFields.includes(field) || changeFields.includes(field.split('.')[0]));
}

const UNKNOWN_FROM_COVERAGE = Object.freeze({
  'not-configured': 'audit-log-not-configured',
  'retention-gap': 'audit-retention-gap',
  'read-scope-revoked': 'audit-read-scope-revoked',
  'read-failed': 'audit-read-failed',
  'not-read': 'audit-window-not-read',
  'archive-reference': 'audit-in-organization-archive',
});

/**
 * Pure classification of one change. `change` is
 *   { resourceType, sourceId | null, changeType, fields, window: { from, until } }.
 * Returns { verdict, reason, actors: [{ kind, id }], evidence: [fact] }.
 */
export function classifyAttribution({ tenantRef, change, auditFacts, signInFacts, auditCoverage, signInCoverage }) {
  const result = (verdict, reason, actors = [], evidence = []) => ({ verdict, reason, actors, evidence });
  if (!change.sourceId) return result('unknown', 'resource-identity-unresolved');
  const operations = CHANGE_OPERATIONS[change.changeType] ?? [];
  const direct = auditFacts.filter((fact) => fact.tenantRef === tenantRef
    && fact.targetType === change.resourceType
    && fact.targetId === change.sourceId
    && operations.includes(fact.operation)
    && within(fact, change.window)
    && fieldsAgree(change.fields, fact.fields));
  const actorsOf = (facts) => {
    const seen = new Map();
    for (const fact of facts) seen.set(actorKey(fact), { kind: fact.actorKind, id: fact.actorId });
    return [...seen.values()];
  };
  const directActors = actorsOf(direct);
  if (directActors.length === 1) {
    return auditCoverage.status === 'covered'
      ? result('exact', 'audit-record-names-resource', directActors, direct)
      : result('plausible', 'audit-log-incomplete', directActors, direct);
  }
  if (directActors.length > 1) return result('plausible', 'several-actors-changed-resource', directActors, direct);
  if (auditCoverage.status !== 'covered') return result('unknown', UNKNOWN_FROM_COVERAGE[auditCoverage.status] ?? 'audit-read-failed');
  const nearby = actorsOf(signInFacts.filter((fact) => fact.tenantRef === tenantRef && within(fact, change.window)));
  // Several accounts merely signed in: none of them is named (minimization).
  if (nearby.length > 1) return result('unknown', 'several-nearby-sign-ins');
  if (nearby.length === 1 && signInCoverage.status === 'covered') return result('plausible', 'sign-in-proximity-only', nearby);
  return result('unknown', 'no-audit-record-names-resource');
}

async function tableExists(client, name) {
  const { rows: [row] } = await client.query('SELECT to_regclass($1) AS name', [name]);
  return Boolean(row.name);
}

async function coverageFor(client, tenantRef, source, window) {
  if (!await tableExists(client, 'audit_ingest_run')) return { status: 'not-configured' };
  const { rows: [state] } = await client.query('SELECT * FROM audit_ingest_state WHERE tenant_ref=$1 AND source=$2', [tenantRef, source]);
  const { rows: runs } = await client.query(
    'SELECT evidence FROM audit_ingest_run WHERE tenant_ref=$1 AND source=$2 ORDER BY started_at DESC, id DESC LIMIT 100', [tenantRef, source],
  );
  return coverageFromRuns({ runs, state: state ?? null }, window);
}

/** The one lineage that held (type, key) at `at`, or null when none or several did. */
async function lineagesFor(client, tenantRef, changes) {
  const { rows } = await client.query(
    `SELECT c.idx, l.id AS lineage_id, l.source_id
       FROM unnest($2::text[], $3::text[], $4::timestamptz[]) WITH ORDINALITY AS c(rtype, nkey, at, idx)
       JOIN resource_lineage l ON l.tenant_ref = $1 AND l.resource_type = c.rtype
       JOIN resource_lineage_alias a ON a.lineage_id = l.id AND a.natural_key = c.nkey
        AND a.valid_from <= c.at AND (a.valid_until IS NULL OR a.valid_until > c.at)`,
    [tenantRef, changes.map((c) => c.resourceType), changes.map((c) => c.naturalKey), changes.map((c) => new Date(c.window.until))],
  );
  const byIndex = new Map();
  for (const row of rows) {
    const list = byIndex.get(Number(row.idx)) ?? [];
    if (!list.some((entry) => entry.lineageId === row.lineage_id)) list.push({ lineageId: row.lineage_id, sourceId: row.source_id });
    byIndex.set(Number(row.idx), list);
  }
  return changes.map((_, index) => {
    const list = byIndex.get(index + 1) ?? [];
    return list.length === 1 ? list[0] : null;
  });
}

/** Actor names from this tenant's own collected users / service principals. */
async function actorNames(client, tenantRef, actors, scope, at) {
  if (!actors.length) return new Map();
  const { rows } = await client.query(
    `SELECT l.resource_type, l.source_id, a.natural_key,
            e.state, e.entity_code, e.entity_codes, e.expires_at
       FROM resource_lineage l
       JOIN resource_lineage_alias a ON a.lineage_id = l.id AND a.valid_until IS NULL
       LEFT JOIN resource_ownership_evidence e ON e.lineage_id = l.id AND e.tenant_ref = l.tenant_ref AND e.superseded_at IS NULL
      WHERE l.tenant_ref = $1 AND (l.resource_type, lower(l.source_id)) IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
    [tenantRef, actors.map((actor) => actor.kind), actors.map((actor) => actor.id)],
  );
  const names = new Map();
  for (const row of rows) {
    const ownership = { state: row.state, entityCode: row.entity_code, entityCodes: row.entity_codes ?? [], expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null };
    if (!ownershipVisibleTo(scope, ownership, at)) continue;
    const key = String(row.natural_key);
    names.set(`${row.resource_type}:${String(row.source_id).toLowerCase()}`, key.slice(key.indexOf(':') + 1));
  }
  return names;
}

/** Top-level field names that differ between two payloads. */
export function changedFields(before, after) {
  const a = before && typeof before === 'object' ? before : {};
  const b = after && typeof after === 'object' ? after : {};
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
    .sort();
}

/**
 * Attributes up to MAX_ATTRIBUTED_CHANGES changes in a bounded, batched read.
 * Each change: { id, resourceType, naturalKey, changeType, fields, window: { from, until } }
 * where `from` may be null (then a 90-day lookback before `until`).
 * `scope` is the reader's entity scope (central by default); it decides only whether
 * an actor may be named. The caller must already have authorized the changes.
 */
export async function attributeChanges(client, { tenantRef, changes, scope = { central: true }, at = new Date() }) {
  const bounded = changes.slice(0, MAX_ATTRIBUTED_CHANGES).map((change) => ({
    ...change,
    window: {
      from: new Date(change.window.from ? ms(change.window.from) : ms(change.window.until) - DEFAULT_LOOKBACK_MS).toISOString(),
      until: new Date(change.window.until).toISOString(),
    },
  }));
  if (!bounded.length) return [];
  const identities = await lineagesFor(client, tenantRef, bounded);
  const factsReady = await tableExists(client, 'audit_change_fact');
  const results = [];
  const allActors = new Map();
  for (const [index, change] of bounded.entries()) {
    const identity = identities[index];
    const auditCoverage = await coverageFor(client, tenantRef, 'audit', change.window);
    const signInCoverage = await coverageFor(client, tenantRef, 'sign-in', change.window);
    let auditFacts = [];
    let signInFacts = [];
    if (factsReady && identity) {
      ({ rows: auditFacts } = await client.query(
        `SELECT tenant_ref AS "tenantRef", source_event_id AS "sourceEventId", occurred_at AS "occurredAt",
                target_type AS "targetType", target_id AS "targetId", operation, activity, fields,
                actor_kind AS "actorKind", actor_id AS "actorId"
           FROM audit_change_fact
          WHERE tenant_ref = $1 AND target_type = $2 AND target_id = $3 AND occurred_at > $4 AND occurred_at <= $5
          ORDER BY occurred_at DESC, source_event_id LIMIT ${MAX_EVENTS_PER_CHANGE}`,
        [tenantRef, change.resourceType, identity.sourceId.toLowerCase(), change.window.from, change.window.until],
      ));
      ({ rows: signInFacts } = await client.query(
        `SELECT DISTINCT ON (actor_kind, actor_id) tenant_ref AS "tenantRef", source_event_id AS "sourceEventId",
                occurred_at AS "occurredAt", actor_kind AS "actorKind", actor_id AS "actorId"
           FROM audit_sign_in_fact
          WHERE tenant_ref = $1 AND occurred_at > $2 AND occurred_at <= $3
          ORDER BY actor_kind, actor_id, occurred_at DESC LIMIT ${MAX_SIGN_IN_ACTORS + 1}`,
        [tenantRef, change.window.from, change.window.until],
      ));
    }
    const verdict = classifyAttribution({
      tenantRef,
      change: { ...change, sourceId: identity ? identity.sourceId.toLowerCase() : null },
      auditFacts, signInFacts, auditCoverage, signInCoverage,
    });
    for (const actor of verdict.actors) allActors.set(`${actor.kind}:${actor.id}`, actor);
    results.push({ change, identity, verdict, coverage: { audit: auditCoverage.status, signIn: signInCoverage.status } });
  }
  const names = await actorNames(client, tenantRef, [...allActors.values()], scope, at);
  return results.map(({ change, identity, verdict, coverage }) => ({
    changeId: change.id,
    verdict: verdict.verdict,
    reason: verdict.reason,
    actors: verdict.actors.map((actor) => {
      const name = names.get(`${actor.kind}:${actor.id}`) ?? null;
      const central = scope?.central === true;
      // An actor outside the reader's entities is neither named nor identified.
      return { kind: actor.kind, id: name || central ? actor.id : null, name };
    }),
    evidence: verdict.evidence.map((fact) => ({
      sourceEventId: fact.sourceEventId, occurredAt: new Date(fact.occurredAt).toISOString(),
      operation: fact.operation, activity: fact.activity ?? null, fields: fact.fields ?? [],
    })),
    resourceObjectId: identity?.sourceId ?? null,
    window: change.window,
    coverage,
  }));
}
