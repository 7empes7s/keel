/**
 * "Make it pass" for a control that rests on a service read (the Defender email
 * checks over the mail protection policies). The fix changes one setting of one
 * policy. It is planned as an ordinary workload restore (restore/workloads/
 * cmdletSettings.mjs) whose source is the policy as it is live with only that
 * setting changed, so every rule of that restore holds: the write is declared and
 * qualified, a content effect needs its own approval, the fixture guard applies, the
 * promotion needs an approval by someone other than the requester, the policy is read
 * again just before the write and any change since the dry run makes it stale, and
 * the write is read back.
 *
 * Nothing here writes to a tenant. planWorkloadComplianceFix() is pure; the CLI
 * (cli/keel-restore.mjs, complianceFix scope) does the reads.
 */
import { planWorkloadSettingsRestore, workloadSettingsPlanDigest } from '../restore/workloads/cmdletSettings.mjs';
import { ComplianceFixRefusal, fixFor, isWorkloadFix, parseWorkloadFixTarget, workloadSettingNeedsFix } from './fix.mjs';
import { controlFor } from './registry.mjs';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Why the live read cannot show this family, or null when it read it in full. */
function readGap(live, family) {
  const gap = [...(live?.failures ?? []), ...(live?.unavailable ?? [])].find((item) => item.family === family);
  if (gap) return gap.status ?? 'failed';
  if (live?.discovery?.capped) return 'capped at its object limit';
  return null;
}

/**
 * The workload restore plan for one fix, from the LIVE read of the policy's family.
 * `sourceCollectionId` is the service read the check used; it is recorded, and the
 * plan's source is the live policy with the one setting changed. Refused when the
 * control has no such fix, the policy is gone or could not be read, or the setting
 * already passes.
 */
export function planWorkloadComplianceFix({
  controlId, target, live, sourceCollectionId, tenantId, tenantRef, testTenantRefs, allowTenantWide = false,
}) {
  const control = controlFor(controlId);
  if (!control) throw new ComplianceFixRefusal(`the control ${controlId} is not known`);
  const fix = fixFor(controlId);
  if (!isWorkloadFix(fix)) throw new ComplianceFixRefusal('this control has no fix Keel can apply to a service setting');
  const named = parseWorkloadFixTarget(target);
  if (!named || !Object.prototype.hasOwnProperty.call(fix.settings, named.setting)) {
    throw new ComplianceFixRefusal(`${target} does not name a setting this control's fix changes`);
  }
  const { resourceKey, setting } = named;
  const gap = readGap(live, fix.family);
  if (gap) throw new ComplianceFixRefusal(`the live read of ${fix.family} was ${gap}, so ${resourceKey} could not be checked`);
  const entry = (live?.resources ?? []).find((item) => item.resourceKey === resourceKey) ?? null;
  if (!entry) throw new ComplianceFixRefusal(`${resourceKey} is not in the tenant now; nothing to fix`);
  if (entry.kind !== fix.family) throw new ComplianceFixRefusal(`${resourceKey} is not a ${fix.family}`);
  if (entry.fieldCoverage?.[setting]?.status !== 'observed') {
    throw new ComplianceFixRefusal(`${setting} of ${resourceKey} could not be read, so it could not be checked`);
  }
  if (!workloadSettingNeedsFix(controlId, { ...entry.fields, kind: entry.kind }, setting)) {
    throw new ComplianceFixRefusal(`${resourceKey} already passes this control; nothing to fix`);
  }
  if (typeof sourceCollectionId !== 'string' || !sourceCollectionId) {
    throw new ComplianceFixRefusal(`no complete service read holds ${resourceKey}`);
  }

  const to = fix.settings[setting];
  const source = {
    collectionId: sourceCollectionId,
    outcome: 'complete',
    observedTo: null,
    observations: [{
      resourceKey, kind: entry.kind, identity: entry.identity,
      fields: { ...entry.fields, [setting]: to },
      fieldCoverage: entry.fieldCoverage,
    }],
  };
  const base = planWorkloadSettingsRestore({
    workload: fix.workload, source, live, tenantId, tenantRef, targets: [resourceKey], allowTenantWide,
    ...(testTenantRefs ? { testTenantRefs } : {}),
  });
  const plan = structuredClone(base);
  plan.complianceFix = {
    controlId,
    evaluatorVersion: control.evaluatorVersion,
    naturalKey: target,
    resourceType: fix.resourceType,
    resourceKey,
    targetId: entry.identity ?? null,
    name: typeof entry.fields?.Name === 'string' ? entry.fields.Name : null,
    field: setting,
    from: entry.fields?.[setting] ?? null,
    to,
  };
  plan.digest = workloadSettingsPlanDigest(plan);
  return deepFreeze(plan);
}
