/**
 * What to do next about each change feed row (insights track, IN-FEED), and whether
 * someone has already dealt with it.
 *
 * One next step per row, the first that applies:
 *
 * 1. `accepted`, `ignored`, `undone`: the change was decided under Changes › Open changes.
 *    An audit row takes the decision of the backup change that found the same object after it.
 * 2. `decide`: the change is still open under Open changes; "Accept or undo" opens its panel
 *    there (/changes?open=<id>). An audit row links to the open change for the same object.
 * 3. `restore`: the object was deleted and a backup from before the change holds it.
 * 4. `site` / `onedrive`: a content backup found a change in who can reach a site (links to
 *    the site's page) or a OneDrive (no page: the row says where to look).
 * 5. `audit`: only the audit log saw it.
 * 6. `closed`: a backup or service change that is no longer open, without a decision: a later
 *    change or a new approved setup replaced it.
 *
 * A row is dealt with when it is decided or closed, or when an alert keyed to its object
 * (alert.resource_key = the row's object key) was acknowledged or resolved after the change.
 * An open alert does not count. Callers count "needs a look" from `dealtWith` only.
 *
 * Every read is one bounded query for the whole page (never one per row). People who
 * decided are named the way "Hide people's names" says (`namer`).
 */
import { displayPerson } from './people.mjs';
import { IGNORE_STILL_COUNTS_SQL, OPEN_DRIFT_PREDICATE } from '../store/openDrift.mjs';

export const NEXT_STEP_KINDS = Object.freeze(['accepted', 'ignored', 'undone', 'decide', 'restore', 'site', 'onedrive', 'audit', 'closed']);

// An open change is listed under Open changes for this long (portal/lib/service-changes.ts).
const SERVICE_OPEN_DAYS = 30;
const SERVICE_LISTED = ['open', 'reopened', 'acknowledged'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const iso = (value) => (value == null ? null : (value instanceof Date ? value : new Date(String(value))).toISOString());

/** "3 Nov", or "3 Nov 2025" outside the current year (UTC). Pure. */
export function stepDate(at, now = new Date()) {
  const date = new Date(at);
  if (Number.isNaN(date.valueOf())) return '';
  const sameYear = date.getUTCFullYear() === new Date(now).getUTCFullYear();
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' });
}

const sameChain = (alias) => `${alias}.tenant_ref = r.tenant_ref AND ${alias}.baseline_id = r.baseline_id AND ${alias}.natural_key = r.natural_key
       AND (${alias}.id = r.id OR ${alias}.detected_at > r.detected_at)
       AND ${alias}.change_type = r.change_type AND ${alias}.after_hash IS NOT DISTINCT FROM r.after_hash`;

// Where each listed backup change stands. The same difference can be recorded by later
// backups too (one chain): a decision or undo on any row of the chain counts. Open means
// the newest row for the setting is of the chain, open, under the active approved setup.
const DRIFT_STATE_SQL = `
  SELECT r.id::text AS id, b.active AS baseline_active,
         latest.id::text AS latest_id, latest.open AS latest_open,
         (latest.change_type = r.change_type AND latest.after_hash IS NOT DISTINCT FROM r.after_hash) AS latest_same,
         dec.action AS decision, dec.actor AS decided_by, dec.decided_at,
         undo.finished_at AS undone_at, undo.approver AS undo_approver, undo.requested_by AS undo_requester
    FROM drift r
    JOIN baseline b ON b.id = r.baseline_id
    LEFT JOIN LATERAL (
      SELECT d.id, d.change_type, d.after_hash, ${OPEN_DRIFT_PREDICATE} AS open
        FROM drift d
       WHERE d.tenant_ref = r.tenant_ref AND d.baseline_id = r.baseline_id AND d.natural_key = r.natural_key
       ORDER BY d.detected_at DESC, d.id DESC
       LIMIT 1
    ) latest ON true
    LEFT JOIN LATERAL (
      SELECT p.action, p.actor, p.decided_at
        FROM drift c JOIN disposition p ON p.drift_id = c.id
       WHERE ${sameChain('c')} AND p.action IN ('accept', 'ignore')
         AND (p.action <> 'ignore' OR ${IGNORE_STILL_COUNTS_SQL})
       ORDER BY p.decided_at DESC
       LIMIT 1
    ) dec ON true
    LEFT JOIN LATERAL (
      SELECT j.finished_at, j.requested_by, a.decided_by AS approver
        FROM drift c
        JOIN job j ON j.kind = 'remediate' AND j.status = 'succeeded'
                  AND jsonb_typeof(j.params->'driftIds') = 'array' AND j.params->'driftIds' ? c.id::text
        LEFT JOIN approval_request a ON j.idempotency_key = 'approval:' || a.id::text
       WHERE ${sameChain('c')}
       ORDER BY j.finished_at DESC NULLS LAST
       LIMIT 1
    ) undo ON true
   WHERE r.tenant_ref = $1 AND r.id = ANY($2::uuid[])`;

// The newest backup change, under the active approved setup, to each object an audit row
// names, found at or after the earliest of those audit events.
const AUDIT_LINK_SQL = `
  SELECT DISTINCT ON (oid) oid, id::text AS id, detected_at FROM (
    SELECT lower(coalesce(d.after_payload->>'id', d.before_payload->>'id')) AS oid, d.id, d.detected_at
      FROM drift d JOIN baseline b ON b.id = d.baseline_id AND b.active
     WHERE d.tenant_ref = $1 AND d.detected_at >= $3
  ) found
   WHERE oid = ANY($2::text[])
   ORDER BY oid, detected_at DESC, id DESC`;

// Where each listed service change stands, by the rule Open changes lists them with
// (portal/lib/service-changes.ts): the newest change to its setting, found within 30 days,
// its alert open, reopened or acknowledged (or none raised). Accepted when the approved
// setup holds the read that found it, with the person who accepted it.
const SERVICE_STATE_SQL = `
  SELECT d.id::text AS id, c.observed_to >= $3 AS recent, a.state AS alert_state,
         ap.approved_by, ap.approved_at,
         NOT EXISTS (
           SELECT 1 FROM workload_drift n JOIN workload_collection nc ON nc.id = n.collection_id
            WHERE n.tenant_ref = d.tenant_ref AND n.workload = d.workload AND n.resource_key = d.resource_key AND n.id <> d.id
              AND (nc.observed_to > c.observed_to OR (nc.observed_to = c.observed_to AND n.detected_at > d.detected_at))
         ) AS newest
    FROM workload_drift d
    JOIN workload_collection c ON c.id = d.collection_id
    LEFT JOIN alert a ON a.tenant_ref = d.tenant_ref AND a.resource_key = d.workload || ':' || d.resource_key
                     AND a.control = 'baseline' AND a.condition = 'drift'
    LEFT JOIN workload_approved ap ON ap.tenant_ref = d.tenant_ref AND ap.workload = d.workload AND ap.resource_key = d.resource_key
                                  AND ap.collection_id = d.collection_id AND ap.approved_by IS NOT NULL
   WHERE d.tenant_ref = $1 AND d.id = ANY($2::uuid[])`;

// Alerts on the rows' objects that someone acknowledged or that were resolved.
const ALERTS_SQL = `
  SELECT id::text AS id, resource_key, state, acknowledged_by, acknowledged_at, resolved_at
    FROM alert
   WHERE tenant_ref = $1 AND resource_key = ANY($2::text[]) AND state IN ('acknowledged', 'resolved')`;

// The newest complete backup from before each deleted object's change that holds it, by
// its key or its Microsoft id (both indexed with the backup, schema.sql and schema.d/93).
const RESTORE_SQL = `
  SELECT x.row_id, pick.snapshot_id::text AS snapshot_id
    FROM unnest($2::text[], $3::text[], $4::text[], $5::timestamptz[]) AS x(row_id, natural_key, object_id, at)
    CROSS JOIN LATERAL (
      SELECT held.snapshot_id FROM (
        SELECT rv.snapshot_id, s.started_at FROM resource_version rv JOIN snapshot s ON s.id = rv.snapshot_id
         WHERE rv.natural_key = x.natural_key AND s.tenant_ref = $1 AND s.status = 'complete' AND s.started_at < x.at
        UNION ALL
        SELECT rv.snapshot_id, s.started_at FROM resource_version rv JOIN snapshot s ON s.id = rv.snapshot_id
         WHERE x.object_id IS NOT NULL AND lower(rv.payload->>'id') = x.object_id
           AND s.tenant_ref = $1 AND s.status = 'complete' AND s.started_at < x.at
      ) held
      ORDER BY held.started_at DESC
      LIMIT 1
    ) pick`;

async function tableExists(client, name) {
  const { rows: [found] } = await client.query('SELECT to_regclass($1) AS name', [name]);
  return Boolean(found?.name);
}

/** Keel accounts by id (one query), each as the page may show it. */
async function principalNames(client, ids, namer) {
  const wanted = [...new Set(ids.filter((id) => typeof id === 'string' && id))];
  const names = new Map();
  const uuids = wanted.filter((id) => UUID.test(id));
  if (uuids.length && await tableExists(client, 'principal')) {
    const { rows } = await client.query('SELECT id::text AS id, email, display_name, system_kind FROM principal WHERE id::text = ANY($1::text[])', [uuids]);
    for (const row of rows) {
      const ref = displayPerson({ kind: 'person', id: row.id, name: row.display_name ?? row.email, email: row.email, readable: true, system: row.system_kind != null }, namer);
      if (ref?.name) names.set(row.id, ref.name);
    }
  }
  // An account stored by its email (older records, tests): code-named like anyone else.
  for (const id of wanted) {
    if (names.has(id) || !id.includes('@')) continue;
    names.set(id, typeof namer === 'function' ? namer(id.trim().toLowerCase()) : id);
  }
  return names;
}

/**
 * The next step for each row, by row id.
 * @param {{ query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }} client
 * @param {{ tenantRef: string, now?: Date, namer?: ((key: string) => string) | null, items: Array<{
 *   id: string, source: 'drift' | 'service' | 'backup' | 'audit', occurredAt: string,
 *   key: string, objectId?: string | null, deleted?: boolean, backup?: 'site' | 'onedrive' | null }> }} input
 *   `key` is the stored object key (alert.resource_key), before any name is hidden.
 * @returns {Promise<Map<string, object>>}
 */
export async function loadNextSteps(client, { tenantRef, now = new Date(), namer = null, items }) {
  const steps = new Map();
  if (!items.length) return steps;
  const rowIdOf = (id) => id.slice(id.indexOf(':') + 1);
  const driftItems = items.filter((item) => item.source === 'drift' && UUID.test(rowIdOf(item.id)));
  const serviceItems = items.filter((item) => item.source === 'service' && UUID.test(rowIdOf(item.id)));
  const auditItems = items.filter((item) => item.source === 'audit' && item.objectId);
  const hasDrift = (driftItems.length || auditItems.length) && await tableExists(client, 'drift');

  // Audit rows: the backup change that found the same object after the audit event.
  const auditLinks = new Map();
  if (hasDrift && auditItems.length) {
    const earliest = auditItems.reduce((min, item) => (item.occurredAt < min ? item.occurredAt : min), auditItems[0].occurredAt);
    const ids = [...new Set(auditItems.map((item) => item.objectId.toLowerCase()))];
    const { rows } = await client.query(AUDIT_LINK_SQL, [tenantRef, ids, earliest]);
    const byObject = new Map(rows.map((row) => [String(row.oid), { id: String(row.id), at: iso(row.detected_at) }]));
    for (const item of auditItems) {
      const found = byObject.get(item.objectId.toLowerCase());
      if (found && found.at >= item.occurredAt) auditLinks.set(item.id, found.id);
    }
  }

  const driftStates = new Map();
  const driftIds = [...new Set([...driftItems.map((item) => rowIdOf(item.id)), ...auditLinks.values()])];
  if (hasDrift && driftIds.length) {
    for (const row of (await client.query(DRIFT_STATE_SQL, [tenantRef, driftIds])).rows) driftStates.set(String(row.id), row);
  }

  const serviceStates = new Map();
  if (serviceItems.length && await tableExists(client, 'workload_drift')) {
    const since = new Date(new Date(now).getTime() - SERVICE_OPEN_DAYS * 86_400_000);
    for (const row of (await client.query(SERVICE_STATE_SQL, [tenantRef, serviceItems.map((item) => rowIdOf(item.id)), since])).rows) serviceStates.set(String(row.id), row);
  }

  const alerts = new Map();
  if (await tableExists(client, 'alert')) {
    for (const row of (await client.query(ALERTS_SQL, [tenantRef, [...new Set(items.map((item) => item.key))]])).rows) {
      if (!alerts.has(row.resource_key)) alerts.set(row.resource_key, []);
      alerts.get(row.resource_key).push(row);
    }
  }

  // Decide each row's state first; deleted objects still without one look for a backup.
  const decided = new Map();
  for (const item of items) {
    if (item.source === 'drift' || (item.source === 'audit' && auditLinks.has(item.id))) {
      const id = item.source === 'drift' ? rowIdOf(item.id) : auditLinks.get(item.id);
      const state = driftStates.get(id);
      if (!state) continue;
      const decision = state.decision ? { at: iso(state.decided_at), action: String(state.decision), by: state.decided_by ?? null } : null;
      const undo = state.undone_at ? { at: iso(state.undone_at), by: state.undo_approver ?? null } : null;
      if (undo && (!decision || undo.at >= decision.at)) decided.set(item.id, { kind: 'undone', ...undo });
      else if (decision) decided.set(item.id, { kind: decision.action === 'accept' ? 'accepted' : 'ignored', at: decision.at, by: decision.by });
      else if (state.baseline_active && state.latest_open && state.latest_same) decided.set(item.id, { kind: 'decide', openId: String(state.latest_id) });
      else if (item.source === 'drift') decided.set(item.id, { kind: 'closed' });
    } else if (item.source === 'service') {
      const state = serviceStates.get(rowIdOf(item.id));
      if (!state) continue;
      if (state.approved_by) decided.set(item.id, { kind: 'accepted', at: iso(state.approved_at), by: state.approved_by });
      else if (state.newest && state.recent && (state.alert_state == null || SERVICE_LISTED.includes(state.alert_state))) decided.set(item.id, { kind: 'decide', openId: rowIdOf(item.id) });
      else decided.set(item.id, { kind: 'closed' });
    }
  }

  const restores = new Map();
  const deleted = items.filter((item) => item.deleted && item.source !== 'service' && !['accepted', 'ignored', 'undone', 'decide'].includes(decided.get(item.id)?.kind));
  if (deleted.length && await tableExists(client, 'resource_version')) {
    const { rows } = await client.query(RESTORE_SQL, [
      tenantRef,
      deleted.map((item) => item.id),
      deleted.map((item) => item.key),
      deleted.map((item) => (item.objectId ? item.objectId.toLowerCase() : null)),
      deleted.map((item) => item.occurredAt),
    ]);
    for (const row of rows) restores.set(String(row.row_id), String(row.snapshot_id));
  }

  // Alerts acknowledged or resolved after the change, newest first.
  const handledAlert = (item) => (alerts.get(item.key) ?? [])
    .map((alert) => ({ id: String(alert.id), state: String(alert.state), at: iso(alert.state === 'resolved' ? alert.resolved_at ?? alert.acknowledged_at : alert.acknowledged_at), by: alert.state === 'acknowledged' ? alert.acknowledged_by ?? null : null }))
    .filter((alert) => alert.at && alert.at >= item.occurredAt)
    .sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;

  const people = await principalNames(client, [
    ...[...decided.values()].map((state) => state.by),
    ...items.map((item) => handledAlert(item)?.by),
  ], namer);
  const who = (id) => (id ? people.get(id) ?? null : null);
  const on = (at) => stepDate(at, now);

  for (const item of items) {
    const state = decided.get(item.id);
    const alert = handledAlert(item);
    const alertNote = alert ? {
      id: alert.id, state: alert.state, at: alert.at,
      text: alert.state === 'resolved' ? `Its alert was resolved on ${on(alert.at)}.` : `Its alert was acknowledged${who(alert.by) ? ` by ${who(alert.by)}` : ''} on ${on(alert.at)}.`,
    } : null;
    let step;
    if (state?.kind === 'accepted') step = { kind: 'accepted', text: `Accepted${who(state.by) ? ` by ${who(state.by)}` : ''} on ${on(state.at)}.`, at: state.at };
    else if (state?.kind === 'ignored') step = { kind: 'ignored', text: `Ignored${who(state.by) ? ` by ${who(state.by)}` : ''} on ${on(state.at)}.`, at: state.at };
    else if (state?.kind === 'undone') step = { kind: 'undone', text: `Undone on ${on(state.at)}${who(state.by) ? `, approved by ${who(state.by)}` : ''}.`, at: state.at };
    else if (state?.kind === 'decide') {
      step = {
        kind: 'decide',
        text: item.source === 'audit' ? 'A backup found this change too. It is waiting under Open changes.' : 'Waiting under Open changes.',
        link: { label: 'Accept or undo', href: `/changes?open=${encodeURIComponent(state.openId)}` },
        points: { openChange: state.openId },
      };
    } else if (restores.has(item.id)) {
      const snapshot = restores.get(item.id);
      step = { kind: 'restore', text: 'Deleted. A backup from before this change holds it.', link: { label: 'Restore from the backup before this change', href: `/restore?snapshot=${encodeURIComponent(snapshot)}` }, points: { snapshot } };
    } else if (item.source === 'backup' && item.backup === 'site') {
      const site = item.key.startsWith('site:') ? item.key.slice('site:'.length) : item.key;
      step = { kind: 'site', text: 'Who can reach this site changed.', link: { label: 'See who can reach this site', href: `/sites/${encodeURIComponent(site)}` }, points: { site } };
    } else if (item.source === 'backup') {
      step = { kind: 'onedrive', text: 'Keel has no page for one OneDrive. Check who it is shared with in the SharePoint admin center, under the owner’s OneDrive.' };
    } else if (item.source === 'audit') {
      step = { kind: 'audit', text: 'Seen in the Microsoft audit log. The next backup shows whether it is still in place.' };
    } else {
      step = { kind: 'closed', text: 'No longer waiting: a later change or a new approved setup replaced it.' };
    }
    const settled = ['accepted', 'ignored', 'undone', 'closed'].includes(step.kind) || state?.kind === 'closed';
    steps.set(item.id, {
      link: null,
      points: {},
      ...step,
      ...(alertNote ? { alert: alertNote, points: { ...(step.points ?? {}), alert: alertNote.id } } : {}),
      dealtWith: settled || alertNote !== null,
    });
  }
  return steps;
}
