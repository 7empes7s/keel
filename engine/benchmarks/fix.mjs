/**
 * "Make it pass" (CoreView gap 6): a failing control that declares a fix
 * (registry.mjs, `fix`) can be put right by a one-value restore. The fix names
 * one top-level setting of one object and its new value; everything else on the
 * object is written back exactly as it is live, so nothing but that one value
 * changes. The write goes through the normal restore path: a dry run that binds
 * this plan into its digest, a request for approval, a decision by someone
 * else, and a promotion that reads the tenant again and refuses on any change.
 *
 * Nothing here writes to a tenant. planComplianceFix() is pure; the CLI
 * (cli/keel-restore.mjs, complianceFix scope) does the reads and the write.
 */
import { assertTenantRef } from '../store/tenantRef.mjs';
import { objectNameSql } from '../cir/objectName.mjs';
import { controlFor, fixMatcherFor, semanticFacts } from './registry.mjs';
import { newestWorkloadRead } from './runChecks.mjs';

export class ComplianceFixRefusal extends Error {}

/** The control's declared fix, or null when it has none. */
export function fixFor(controlId) {
  return controlFor(controlId)?.fix ?? null;
}

/**
 * A fix on a service read (the mail protection policies) rather than on a backed-up
 * object: it changes one setting of one policy through the workload restore
 * (workloadFix.mjs). Its target names the policy and the setting.
 */
export function isWorkloadFix(fix) {
  return Boolean(fix?.workload);
}

/** One setting of one policy, as the Compliance page and the restore name it. */
export function workloadFixTarget(resourceKey, setting) {
  return `${resourceKey}#${setting}`;
}

/** The policy and setting a target names, or null when it is not one. */
export function parseWorkloadFixTarget(target) {
  const at = typeof target === 'string' ? target.lastIndexOf('#') : -1;
  if (at <= 0 || at === target.length - 1) return null;
  return { resourceKey: target.slice(0, at), setting: target.slice(at + 1) };
}

/** Whether this setting of this policy (its stored fields) fails the control and the fix would change it. */
export function workloadSettingNeedsFix(controlId, fact, setting) {
  const fix = fixFor(controlId);
  if (!isWorkloadFix(fix) || !Object.prototype.hasOwnProperty.call(fix.settings, setting)) return false;
  return fixMatcherFor(fix.matcher)(fact, setting) === true;
}

/** Whether this object is one the control's fix would change. */
export function needsFix(controlId, { resourceType, payload }) {
  const fix = fixFor(controlId);
  if (isWorkloadFix(fix)) return false;
  if (!fix || resourceType !== fix.resourceType || !payload || typeof payload !== 'object') return false;
  return fixMatcherFor(fix.matcher)(semanticFacts(resourceType, payload)) === true;
}

/**
 * The plan for one object, from its LIVE state: what the setting is now and what
 * it becomes. Refused when the control has no fix, the object is not there, or
 * it no longer needs the fix (it already passes).
 */
export function planComplianceFix({ controlId, naturalKey, live }) {
  const control = controlFor(controlId);
  if (!control) throw new ComplianceFixRefusal(`the control ${controlId} is not known`);
  const fix = control.fix;
  if (!fix) throw new ComplianceFixRefusal('this control has no fix Keel can apply');
  if (!live || live.naturalKey !== naturalKey) {
    throw new ComplianceFixRefusal(`${naturalKey} is not in the tenant now; nothing to fix`);
  }
  if (live.resourceType !== fix.resourceType) {
    throw new ComplianceFixRefusal(`${naturalKey} is not a ${fix.resourceType}`);
  }
  if (!needsFix(controlId, live)) {
    throw new ComplianceFixRefusal(`${naturalKey} already passes this control; nothing to fix`);
  }
  const from = Object.prototype.hasOwnProperty.call(live.payload, fix.field) ? live.payload[fix.field] : null;
  return Object.freeze({
    controlId,
    evaluatorVersion: control.evaluatorVersion,
    naturalKey,
    resourceType: fix.resourceType,
    targetId: live.sourceId ?? null,
    field: fix.field,
    from,
    to: fix.to,
  });
}

/** The live payload with only the fixed setting changed. */
export function fixedPayload(payload, plan) {
  return { ...payload, [plan.field]: plan.to };
}

/**
 * The objects the newest complete backup holds that the fix would change, with
 * their names and the value now and after. What the Compliance page offers to fix;
 * the dry run checks the live tenant again before anything is planned.
 */
export async function listFixCandidates(client, { tenantRef, controlId, limit = 50, now = new Date() }) {
  assertTenantRef(tenantRef);
  const fix = fixFor(controlId);
  if (!fix) return [];
  if (isWorkloadFix(fix)) return listWorkloadFixCandidates(client, { tenantRef, controlId, fix, limit, now });
  const { rows } = await client.query(
    `WITH newest AS (
       SELECT s.id, s.completed_at FROM snapshot s
        WHERE s.tenant_ref = $1 AND s.completed_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM resource_version rv WHERE rv.snapshot_id = s.id AND rv.resource_type = $2)
        ORDER BY s.completed_at DESC, s.started_at DESC LIMIT 1
     )
     SELECT rv.natural_key, rv.resource_type, rv.payload, newest.id AS snapshot_id, newest.completed_at,
            ${objectNameSql('rv.payload', 'rv.resource_type')} AS display_name
       FROM resource_version rv JOIN newest ON newest.id = rv.snapshot_id
      WHERE rv.resource_type = $2
      ORDER BY rv.natural_key`,
    [tenantRef, fix.resourceType],
  );
  return rows
    .filter((row) => needsFix(controlId, { resourceType: row.resource_type, payload: row.payload }))
    .slice(0, limit)
    .map((row) => ({
      naturalKey: row.natural_key,
      resourceType: row.resource_type,
      name: row.display_name ? String(row.display_name) : null,
      field: fix.field,
      from: Object.prototype.hasOwnProperty.call(row.payload, fix.field) ? row.payload[fix.field] : null,
      to: fix.to,
      snapshotId: String(row.snapshot_id),
      seenAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    }));
}

/** The newest complete backup of this tenant that holds the object: the restore's source. */
export async function newestSnapshotWith(client, { tenantRef, naturalKey }) {
  assertTenantRef(tenantRef);
  const { rows } = await client.query(
    `SELECT s.id FROM snapshot s
      WHERE s.tenant_ref = $1 AND s.completed_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM resource_version rv WHERE rv.snapshot_id = s.id AND rv.natural_key = $2)
      ORDER BY s.completed_at DESC, s.started_at DESC LIMIT 1`,
    [tenantRef, naturalKey],
  );
  return rows[0] ? String(rows[0].id) : null;
}

/**
 * For a fix on a service read: each failing setting of each policy in the newest run
 * that read the policies in full (the run the check itself uses), one row per setting.
 * `snapshotId` holds that run's id; the dry run reads the tenant again.
 */
async function listWorkloadFixCandidates(client, { tenantRef, controlId, fix, limit, now }) {
  const read = await newestWorkloadRead(client, { tenantRef, resourceType: fix.workload, parts: [fix.family], now });
  if (!read || read.observation.completeness !== 'complete') return [];
  const candidates = [];
  for (const fact of read.resources) {
    for (const setting of Object.keys(fix.settings)) {
      if (!workloadSettingNeedsFix(controlId, fact, setting)) continue;
      candidates.push({
        naturalKey: workloadFixTarget(fact.id, setting),
        resourceType: fix.resourceType,
        name: typeof fact.Name === 'string' && fact.Name ? fact.Name : null,
        field: setting,
        from: fact[setting] ?? null,
        to: fix.settings[setting],
        snapshotId: read.collectionId,
        seenAt: read.observation.window.endedAt,
      });
    }
  }
  return candidates
    .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')) || a.naturalKey.localeCompare(b.naturalKey))
    .slice(0, limit);
}
