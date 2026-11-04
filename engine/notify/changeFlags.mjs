/** Flag observations share the alert lifecycle, routing, mute and escalation machinery. */
import { flagLabel } from '../insights/flagLabels.mjs';
import { schedulerPrincipal } from '../authz/systemPrincipal.mjs';
import { applyConditionEvent, notifyOccurrence, AlertAuthorizationError } from './alerts.mjs';
import { loadChangeFeed } from '../insights/feed.mjs';
import { evaluateFlags, FLAG_RULES, flagValues } from '../insights/flags.mjs';
import { can } from '../authz/can.mjs';
import { findPrincipalById } from '../authz/principals.mjs';
import { appendEvidenceInTransaction } from '../govern/evidence.mjs';

export async function flagSettings(client, { tenantRef }) {
  const { rows } = await client.query('SELECT flag_key, enabled FROM change_flag_setting WHERE tenant_ref = $1', [tenantRef]);
  const settings = new Map(rows.map((row) => [row.flag_key, row.enabled]));
  return FLAG_RULES.map((rule) => ({ key: rule.key, enabled: settings.get(rule.key) !== false,
    sentence: flagLabel(rule.key) }));
}

export async function setFlagEnabled(client, { tenantRef, key, enabled, actor }) {
  if (!FLAG_RULES.some((rule) => rule.key === key) || typeof enabled !== 'boolean') throw new TypeError('unknown flag or invalid enabled value');
  const principal = await findPrincipalById(client, actor);
  if (!principal || !await can(client, principal, 'policies')) throw new AlertAuthorizationError('policies capability required');
  await client.query('BEGIN');
  let evidence;
  try {
    evidence = await appendEvidenceInTransaction(client, { tenantRef, kind: 'alert-action', actor,
      subject: { action: 'change-flag-setting', flag: key, enabled } });
    await client.query(`INSERT INTO change_flag_setting (tenant_ref, flag_key, enabled) VALUES ($1,$2,$3)
      ON CONFLICT (tenant_ref, flag_key) DO UPDATE SET enabled = EXCLUDED.enabled`, [tenantRef, key, enabled]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  evidence.emit();
}

/** Exact source ids, with no feed age or row limit. Replaying retries incomplete writes. */
export async function syncChangeFlags(client, { tenantRef, source, ids, notify = null }) {
  const feed = await loadChangeFeed(client, { tenantRef, selection: { source, ids } });
  const settings = new Map((await flagSettings(client, { tenantRef })).map((setting) => [setting.key, setting.enabled]));
  const results = [];
  let dispatch = notify;
  const notifier = async () => (dispatch ??= { requestedBy: (await schedulerPrincipal(client)).id });
  // Oldest first: several events about one object can arrive in a single audit page.
  for (const row of [...feed.rows].reverse()) {
    if (source === 'drift') {
      const { rows: decided } = await client.query('SELECT 1 FROM disposition WHERE drift_id::text=$1 LIMIT 1', [row.id.slice(6)]);
      if (decided.length) {
        await resolveChangeFlags(client, { tenantRef, sourceId: row.id });
        continue;
      }
    }
    let resourceKey = row.object.key;
    if (source === 'audit') {
      const { rows: [object] } = await client.query(`SELECT rv.natural_key FROM resource_version rv JOIN snapshot s ON s.id=rv.snapshot_id
        WHERE s.tenant_ref = $1 AND lower(rv.payload->>'id') = lower($2) ORDER BY s.started_at DESC LIMIT 1`, [tenantRef, resourceKey]);
      resourceKey = object?.natural_key ?? resourceKey;
    }
    for (const flag of row.flags) {
      if (settings.get(flag.key) === false) continue;
      const eventId = `${row.id}:${flag.key}`;
      // Serialize the enrichment decision with other flag writers for this object.
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`change-flag:${tenantRef}:${resourceKey}`]);
      try {
        await client.query(`INSERT INTO change_flag_event (tenant_ref, source_id, flag_key, resource_key, observed_at, evaluation)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [tenantRef, row.id, flag.key, resourceKey, row.occurredAt, row.evaluation]);
        const { rows: [event] } = await client.query(`SELECT * FROM change_flag_event WHERE tenant_ref=$1 AND source_id=$2 AND flag_key=$3`, [tenantRef, row.id, flag.key]);
        if (event.resolved_at) continue;
        if (event.alert_id) {
          const { rows: [attached] } = await client.query('SELECT control FROM alert WHERE id=$1', [event.alert_id]);
          // An enriched event belongs to that baseline occurrence, even after it closes.
          if (attached?.control === 'baseline') {
            const { rows: [current] } = await client.query('SELECT * FROM alert WHERE id=$1', [event.alert_id]);
            if (current.condition_active) await notifyOccurrence(client, current, await notifier());
            continue;
          }
        }
        const { rows: [baseline] } = await client.query(`SELECT * FROM alert WHERE tenant_ref=$1 AND resource_key=$2
          AND control='baseline' AND condition='drift' AND condition_active`, [tenantRef, resourceKey]);
        if (baseline) {
          if (event.alert_id && event.alert_id !== baseline.id) await applyConditionEvent(client, {
            tenantRef, resourceKey, control: 'change-flag', condition: flag.key, status: 'resolved',
            eventId: `flag-fold:${baseline.id}:${baseline.occurrence}:${eventId}`, occurredAt: baseline.last_observed_at, source: 'change-flag',
          });
          const { rows: [enriched] } = await client.query(`UPDATE alert SET detail = detail || jsonb_build_object('changeFlags',
            coalesce(detail->'changeFlags', '{}'::jsonb) || jsonb_build_object($2::text, $3::text)),
            severity=CASE WHEN $4='critical' THEN 'critical' ELSE severity END, updated_at=now() WHERE id=$1 RETURNING *`,
          [baseline.id, eventId, flag.sentence, flag.severity]);
          await client.query(`UPDATE change_flag_event SET alert_id=$4, alert_occurrence=$5 WHERE tenant_ref=$1 AND source_id=$2 AND flag_key=$3`, [tenantRef, row.id, flag.key, baseline.id, baseline.occurrence]);
          await notifyOccurrence(client, enriched, await notifier());
          results.push({ outcome: 'enriched', alert: enriched });
        } else {
          const result = await applyConditionEvent(client, { tenantRef, resourceKey, control: 'change-flag', condition: flag.key,
            status: 'firing', eventId, occurredAt: row.occurredAt, severity: flag.severity === 'critical' ? 'critical' : 'warning',
            detail: { resourceType: row.type, changeType: row.change, changeId: row.id }, source: 'change-flag', notify: await notifier() });
          await client.query(`UPDATE change_flag_event SET alert_id=$4, alert_occurrence=$5 WHERE tenant_ref=$1 AND source_id=$2 AND flag_key=$3`, [tenantRef, row.id, flag.key, result.alert.id, result.alert.occurrence]);
          results.push(result);
        }
      } finally { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`change-flag:${tenantRef}:${resourceKey}`]); }
    }
  }
  return results;
}

/** Close flags for this exact source change; a decision also closes its enriched drift alert. */
export async function resolveChangeFlags(client, { tenantRef, sourceId, occurredAt = new Date(), reason = 'acted-on', key = null }) {
  const { rows } = await client.query(`SELECT e.*, a.control FROM change_flag_event e LEFT JOIN alert a ON a.id=e.alert_id
    WHERE e.tenant_ref=$1 AND e.source_id=$2 AND e.resolved_at IS NULL AND ($3::text IS NULL OR e.flag_key=$3)`, [tenantRef, sourceId, key]);
  for (const event of rows) {
    const { rows: newer } = await client.query(`SELECT 1 FROM change_flag_event WHERE alert_id=$1 AND resolved_at IS NULL AND observed_at > $2 LIMIT 1`, [event.alert_id, event.observed_at]);
    if (!newer.length && (event.control === 'change-flag' || (event.control === 'baseline' && reason === 'acted-on'))) await applyConditionEvent(client, {
      tenantRef, resourceKey: event.resource_key, control: event.control, condition: event.control === 'baseline' ? 'drift' : event.flag_key, status: 'resolved',
      eventId: `flag-clear:${sourceId}:${event.flag_key}:${reason}`, occurredAt, source: 'change-flag',
    });
    if (event.control === 'baseline') await client.query(`UPDATE alert SET detail=jsonb_set(detail,'{changeFlags}',coalesce(detail->'changeFlags','{}'::jsonb)-$2::text) WHERE id=$1`, [event.alert_id, `${sourceId}:${event.flag_key}`]);
    await client.query(`UPDATE change_flag_event SET resolved_at=$4 WHERE tenant_ref=$1 AND source_id=$2 AND flag_key=$3`,
      [tenantRef, sourceId, event.flag_key, occurredAt]);
  }
}

/** A later read clears only states its coverage can prove. Audit facts contain no
 * secret values or role-member identities: compare with the last complete pre-event
 * backup, and retain the flag when that evidence is unavailable. */
async function backupFlagCleared(client, { tenantRef, snapshotId, coveredTypes }, event) {
  const input = event.evaluation;
  const objectAt = async (snapshot, key, byId = false) => (await client.query(`SELECT rv.payload FROM resource_version rv JOIN snapshot s ON s.id=rv.snapshot_id
    WHERE s.id=$1 AND s.tenant_ref=$2 AND ${byId ? "lower(rv.payload->>'id')=lower($3)" : 'rv.natural_key=$3'} LIMIT 1`, [snapshot, tenantRef, key])).rows[0]?.payload;
  if (input.source === 'drift') {
    if (input.key.startsWith('edge:')) {
      const [, edgeType, parent, ...target] = input.key.split(':');
      const { rows: [set] } = await client.query(`SELECT id,outcome FROM relationship_edge_set
        WHERE snapshot_id=$1 AND tenant_ref=$2 AND edge_type=$3 AND parent_source_id=$4`, [snapshotId, tenantRef, edgeType, parent]);
      if (!set || !['complete', 'complete-empty'].includes(set.outcome)) return false;
      const { rows } = await client.query('SELECT 1 FROM relationship_edge WHERE set_id=$1 AND edge_key=$2', [set.id, target.join(':')]);
      return rows.length === 0;
    }
    if (!coveredTypes.includes(input.type)) return false;
    const current = await objectAt(snapshotId, event.resource_key);
    if (current && ['application','servicePrincipal'].includes(input.type)
      && (!Array.isArray(current.passwordCredentials) || !Array.isArray(current.keyCredentials))) return false;
    if (current && input.type === 'conditionalAccessPolicy' && typeof current.state !== 'string') return false;
    const next = { ...input, after: flagValues(input.type, current), change: current ? (input.before ? 'modified' : 'added') : 'removed' };
    return !evaluateFlags(next).some((flag) => flag.key === event.flag_key);
  }
  if (input.source !== 'audit') return false;
  const { rows: [previous] } = await client.query(`SELECT id FROM snapshot WHERE tenant_ref=$1 AND status='complete' AND completed_at < $2 ORDER BY completed_at DESC LIMIT 1`, [tenantRef, event.observed_at]);
  if (event.flag_key === 'ca-deleted-audit') {
    return coveredTypes.includes('conditionalAccessPolicy') && Boolean(await objectAt(snapshotId, input.key, true));
  }
  if (event.flag_key === 'app-credential-added-audit') {
    const type = 'servicePrincipal';
    if (!coveredTypes.includes(type)) return false;
    const current = await objectAt(snapshotId, input.key, true);
    if (!current) return true;
    if (!Array.isArray(current.passwordCredentials) || !Array.isArray(current.keyCredentials)) return false;
    const before = previous ? await objectAt(previous.id, input.key, true) : null;
    // With no before image, only an empty credential list proves removal.
    return !evaluateFlags({ source: 'drift', type, change: before ? 'modified' : 'added',
      before: flagValues(type, before), after: flagValues(type, current) }).some((flag) => flag.key === 'app-credential-added');
  }
  if (event.flag_key === 'admin-role-added-audit') {
    const type = /^add eligible/i.test(input.activity) ? 'roleEligibilitySchedule' : 'roleAssignment';
    if (!coveredTypes.includes(type)) return false;
    const assignments = async (snapshot) => (await client.query(`SELECT rv.natural_key FROM resource_version rv JOIN snapshot s ON s.id=rv.snapshot_id
      WHERE s.id=$1 AND s.tenant_ref=$2 AND rv.resource_type=$3 AND lower(rv.payload->>'roleDefinitionId')=lower($4)`, [snapshot, tenantRef, type, input.key])).rows.map((row) => row.natural_key);
    const before = new Set(previous ? await assignments(previous.id) : []);
    return (await assignments(snapshotId)).every((key) => before.has(key));
  }
  if (event.flag_key === 'app-permission-granted-audit') {
    const edges = async (snapshot) => {
      const { rows: [set] } = await client.query(`SELECT id,outcome FROM relationship_edge_set WHERE snapshot_id=$1 AND tenant_ref=$2 AND parent_source_id=$3 AND family='appRoleGrant'`, [snapshot, tenantRef, input.key]);
      if (!set || !['complete','complete-empty'].includes(set.outcome)) return null;
      return (await client.query('SELECT edge_key FROM relationship_edge WHERE set_id=$1', [set.id])).rows.map((row) => row.edge_key);
    };
    const current = await edges(snapshotId);
    if (!current) return false;
    const before = new Set(previous ? await edges(previous.id) ?? [] : []);
    return current.every((key) => before.has(key));
  }
  return false;
}

export async function resolveBackupFlags(client, options) {
  const { tenantRef, snapshotId, observedAt } = options;
  const { rows } = await client.query(`SELECT * FROM change_flag_event WHERE tenant_ref=$1 AND resolved_at IS NULL AND observed_at < $2`, [tenantRef, observedAt]);
  for (const event of rows) {
    if (!await backupFlagCleared(client, options, event)) continue;
    await resolveChangeFlags(client, { tenantRef, sourceId: event.source_id, occurredAt: observedAt, reason: `backup:${snapshotId}`, key: event.flag_key });
  }
}

/** Re-evaluate labels at read time so names always follow the current privacy setting.
 * @param {any} client
 * @param {{ tenantRef: string, alertIds: string[], namer?: ((key: string) => string) | null }} options
 */
export async function alertFlagDetails(client, { tenantRef, alertIds, namer = null }) {
  const { rows: events } = await client.query(`SELECT e.* FROM change_flag_event e JOIN alert a ON a.id=e.alert_id WHERE e.tenant_ref=$1 AND e.alert_id::text=ANY($2::text[])
    AND e.alert_occurrence=a.occurrence AND (e.resolved_at IS NULL OR NOT a.condition_active) ORDER BY e.observed_at`, [tenantRef, alertIds]);
  const details = new Map();
  for (const source of ['drift', 'service', 'audit']) {
    const selected = events.filter((event) => event.source_id.startsWith(`${source}:`));
    if (!selected.length) continue;
    const feed = await loadChangeFeed(client, { tenantRef, namer, selection: { source, ids: [...new Set(selected.map((event) => event.source_id.slice(source.length + 1)))] } });
    for (const event of selected) {
      const row = feed.rows.find((row) => row.id === event.source_id);
      const flag = row?.flags.find((flag) => flag.key === event.flag_key);
      const fallback = flag ?? evaluateFlags({ ...event.evaluation, name: null, context: { ...event.evaluation.context, roleName: null, groupName: null, appName: null } }).find((entry) => entry.key === event.flag_key);
      if (!fallback) continue;
      const list = details.get(event.alert_id) ?? [];
      list.push({ key: event.flag_key, sentence: fallback.sentence, name: row?.object.name ?? null, person: row?.person ?? null,
        changeId: row?.id ?? event.source_id, resolved: Boolean(event.resolved_at) });
      details.set(event.alert_id, list);
    }
  }
  return details;
}

export async function resolveServiceFlags(client, { tenantRef, collectionId, workload, observedAt, complete }) {
  const { rows } = await client.query(`SELECT * FROM change_flag_event WHERE tenant_ref=$1 AND resolved_at IS NULL AND observed_at < $2
    AND evaluation->>'source'='service' AND evaluation->>'type'=$3`, [tenantRef, observedAt, workload]);
  for (const event of rows) {
    const input = event.evaluation;
    const key = event.resource_key.slice(workload.length + 1);
    const { rows: [current] } = await client.query('SELECT fields, field_coverage FROM workload_observation WHERE collection_id=$1 AND resource_key=$2', [collectionId, key]);
    if (!current && !complete) continue;
    if (current && Object.keys(input.after ?? {}).some((path) => !Object.hasOwn(current.fields, path))) continue;
    const next = { ...input, change: current ? 'modified' : 'removed', after: current?.fields ?? {} };
    if (evaluateFlags(next).some((flag) => flag.key === event.flag_key)) continue;
    await resolveChangeFlags(client, { tenantRef, sourceId: event.source_id, key: event.flag_key, occurredAt: observedAt, reason: `collection:${collectionId}` });
  }
}

export async function drainAuditFlags(client, { tenantRef }) {
  // Page-sized chunks keep the exact-id name queries bounded without losing rows.
  for (;;) {
    const { rows } = await client.query('SELECT source_id FROM change_flag_pending WHERE tenant_ref=$1 ORDER BY source_id LIMIT 1000', [tenantRef]);
    if (!rows.length) return;
    const ids = rows.map((row) => row.source_id);
    await syncChangeFlags(client, { tenantRef, source: 'audit', ids });
    await client.query('DELETE FROM change_flag_pending WHERE tenant_ref=$1 AND source_id=ANY($2::text[])', [tenantRef, ids]);
  }
}

/** When baseline drift appears after an audit flag, fold that existing event too. */
export async function foldResourceFlags(client, { tenantRef, resourceKey }) {
  const { rows } = await client.query(`SELECT source_id FROM change_flag_event WHERE tenant_ref=$1 AND resource_key=$2 AND resolved_at IS NULL`, [tenantRef, resourceKey]);
  for (const source of ['drift', 'service', 'audit']) {
    const ids = [...new Set(rows.filter((row) => row.source_id.startsWith(`${source}:`)).map((row) => row.source_id.slice(source.length + 1)))];
    if (ids.length) await syncChangeFlags(client, { tenantRef, source, ids });
  }
}

/** A verified rollback is itself an observation; planning or skipping a write is not. */
export async function resolveRolledBackFlags(client, { tenantRef, resources, appliedKeys, observedAt = new Date() }) {
  const applied = new Set(appliedKeys);
  const restored = new Map(resources.filter((resource) => applied.has(resource.naturalKey)).map((resource) => [resource.naturalKey, resource]));
  if (!restored.size) return;
  const { rows } = await client.query(`SELECT * FROM change_flag_event WHERE tenant_ref=$1 AND resource_key=ANY($2::text[]) AND resolved_at IS NULL`, [tenantRef, [...restored.keys()]]);
  for (const event of rows) {
    const input = event.evaluation;
    if (input.source !== 'drift') continue;
    const resource = restored.get(event.resource_key);
    const next = { ...input, after: flagValues(input.type, resource.payload), change: resource.payload ? (input.before ? 'modified' : 'added') : 'removed' };
    if (evaluateFlags(next).some((flag) => flag.key === event.flag_key)) continue;
    await resolveChangeFlags(client, { tenantRef, sourceId: event.source_id, key: event.flag_key, occurredAt: observedAt });
  }
}
