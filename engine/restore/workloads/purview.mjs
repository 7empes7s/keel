/**
 * Roadmap task-106: qualified Purview sensitivity label configuration restore.
 *
 * One plan covers the labels and label policies it is asked for. It holds at most
 * one DISTINCT operation per target, each with its own qualification, outcome and
 * evidence row:
 *  - label:  one Set-Label with the changed display text (DisplayName, Tooltip, Comment);
 *  - policy: one Set-LabelPolicy -AddLabels with the labels the source published and
 *            the live policy no longer does.
 * Everything else stays manual, and nothing KEEL writes can weaken protection:
 *  - encryption, content marking, site and group protection, priority, disabling,
 *    removing a label from a policy, policy locations and settings are a compliance
 *    administrator's to change. A difference is listed, with whether it would weaken
 *    protection, and never written;
 *  - a label or policy that no longer exists is not recreated (it would get a new
 *    id, and items labeled with the old one are not relabeled); one that is new is
 *    never deleted;
 *  - item-applied labels, label usage and labeled content are never read, written
 *    or claimed as recovered.
 *
 * Rules:
 *  - Immutable plan, persisted as a restore_dry_run artifact; the task-66 approval and
 *    promotion checks are the existing ones.
 *  - Disabled until qualified, per operation (coverage/qualification.mjs): its own
 *    live write proof, its read-back enabled, the Exchange cmdlet write (and so Teams
 *    and SharePoint) qualified first, and the restorer's grants observed.
 *  - Preservation lock. A target whose live definition reports a lock is refused at
 *    plan time (the task-66 lock check) and again before writing; a platform lock
 *    refusal is recorded and never retried.
 *  - No overwrite. All targets are re-read first; a change since the plan makes only
 *    that target's operation `stale`.
 *  - Errors are structured; an ambiguous outcome is reconciled by re-reading and is
 *    never sent a second time.
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  PURVIEW_EXCLUDED_CONTENT, PURVIEW_GROUPS, PURVIEW_WORKLOAD, definitionFingerprint, purviewCmdlet, readPurview,
} from '../../collect/workloads/purview.mjs';
import { structuredFailure } from '../../collect/workloads/exchange.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../../coverage/qualification.mjs';
import { appendEvidence } from '../../govern/evidence.mjs';
import { CmdletError } from '../../powershell/jobQueue.mjs';
import { assertContentEffectApproval, classifyContentEffects, isPreservationLockFailure } from '../../safety/contentEffects.mjs';
import { createDryRunArtifact, getDryRunArtifact, validateArtifactForApproval } from '../dryRunArtifact.mjs';

export const PURVIEW_LABEL_WRITE = 'purview.label.update';
export const PURVIEW_POLICY_WRITE = 'purview.label-policy.update';
export const PURVIEW_WRITE_OPERATIONS = Object.freeze([PURVIEW_LABEL_WRITE, PURVIEW_POLICY_WRITE]);
export const PURVIEW_RESTORE_EVIDENCE_KIND = 'workload-restore';
const CONFIG_PATH = 'workload:purview-labels';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

for (const id of PURVIEW_WRITE_OPERATIONS) if (!WORKLOAD_WRITE_OPERATIONS[id]) throw new Error(`${id} is not a declared workload write`);

const OPERATIONS = Object.freeze({
  label: { operationId: PURVIEW_LABEL_WRITE, resourceType: 'purviewLabel', cmdlet: 'Set-Label' },
  policy: { operationId: PURVIEW_POLICY_WRITE, resourceType: 'purviewLabelPolicy', cmdlet: 'Set-LabelPolicy' },
});
const LABEL_WRITABLE = Object.freeze(WORKLOAD_WRITE_OPERATIONS[PURVIEW_LABEL_WRITE].fields);
// Identity and save time: not configuration KEEL compares.
const NOT_COMPARED = new Set(['Name', 'WhenChangedUTC']);

function canonical(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const sha256 = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const same = (a, b) => canonical(a ?? null) === canonical(b ?? null);
const truthy = (value) => value === true || value === 'true' || value === 'True';
const list = (value) => (Array.isArray(value) ? value.map(String) : value === null || value === undefined || value === '' ? [] : [String(value)]);
const lower = (values) => values.map((value) => value.toLowerCase());

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function purviewPlanDigest(plan) {
  const { digest, ...rest } = plan;
  return sha256(rest);
}

/**
 * Whether restoring `field` from `live` back to `source` would weaken protection.
 * Declared, not measured. `true` means it would, `null` that KEEL cannot tell
 * (treated the same way: it is never written).
 */
export function weakensProtection(group, field, live, source) {
  if (group === 'label') {
    switch (field) {
      case 'EncryptionEnabled': case 'ApplyContentMarkingHeaderEnabled': case 'ApplyContentMarkingFooterEnabled':
      case 'ApplyWaterMarkingEnabled': case 'SiteAndGroupProtectionEnabled':
        return truthy(live) && !truthy(source);
      case 'Disabled': return !truthy(live) && truthy(source);
      case 'SiteAndGroupProtectionAllowAccessToGuestUsers': return !truthy(live) && truthy(source);
      case 'EncryptionOfflineAccessDays': return typeof live === 'number' && typeof source === 'number' ? source > live || source === -1 : null;
      case 'DisplayName': case 'Tooltip': case 'Comment': return false;
      default: return null;
    }
  }
  if (field === 'Enabled') return truthy(live) && !truthy(source);
  if (field === 'Labels' || /Location$/.test(field)) {
    const kept = lower(list(source));
    return lower(list(live)).some((entry) => !kept.includes(entry));
  }
  return null;
}

function manualReason(group, field, live, source) {
  const weakens = weakensProtection(group, field, live, source);
  if (weakens === true) return { reason: 'restoring this would weaken protection; KEEL never writes it, a compliance administrator decides', weakensProtection: true };
  if (weakens === null) return { reason: 'KEEL cannot tell whether this weakens protection, so it never writes it; a compliance administrator decides', weakensProtection: null };
  return { reason: 'KEEL does not write this setting; a compliance administrator applies it', weakensProtection: false };
}

function planTarget({ observation, live, manual }) {
  const group = live.kind;
  const changes = [];
  for (const field of PURVIEW_GROUPS[group].fields) {
    if (NOT_COMPARED.has(field)) continue;
    const sourceStatus = observation.fieldCoverage?.[field]?.status ?? 'unknown';
    const liveStatus = live.fieldCoverage?.[field]?.status ?? 'unknown';
    if (sourceStatus !== 'observed') { manual.push({ resourceKey: live.resourceKey, field, reason: `${sourceStatus} in the source collection, so there is no value to restore` }); continue; }
    if (liveStatus !== 'observed') { manual.push({ resourceKey: live.resourceKey, field, reason: `${liveStatus} in the live read, so no change is planned` }); continue; }
    const after = observation.fields[field] ?? null;
    const before = live.fields[field] ?? null;
    if (group === 'policy' && field === 'Labels') {
      const now = lower(list(before));
      const then = lower(list(after));
      const add = list(after).filter((label) => !now.includes(label.toLowerCase()));
      const removed = list(before).filter((label) => !then.includes(label.toLowerCase()));
      if (add.length) changes.push({ field: 'AddLabels', before: list(before), after: add });
      if (removed.length) {
        manual.push({ resourceKey: live.resourceKey, field, reason: `removing ${removed.join(', ')} from this policy would unpublish them and weaken protection; KEEL never does that`, weakensProtection: true });
      }
      continue;
    }
    if (same(before, after)) continue;
    if (group === 'label' && LABEL_WRITABLE.includes(field)) { changes.push({ field, before, after }); continue; }
    manual.push({ resourceKey: live.resourceKey, field, ...manualReason(group, field, before, after) });
  }
  return changes;
}

/**
 * Builds the frozen plan. `source` is a recorded task-106 collection
 * (loadPurviewCollection); `live` is readPurview(...) read now. `targets` lists the
 * label and policy resource keys to restore (`label:{id}`, `label-policy:{id}`).
 */
export function planPurviewRestore({ source, live, tenantId, targets }) {
  if (!source?.collectionId) throw new TypeError('a Purview restore needs a recorded source collection');
  if (typeof tenantId !== 'string' || !GUID_RE.test(tenantId)) throw new TypeError('tenantId must be the managed tenant\'s directory id');
  if (!['complete', 'complete-empty', 'partial'].includes(source.outcome)) throw new Error(`a ${source.outcome} collection is not a restore source`);
  if (!Array.isArray(targets) || targets.length === 0) throw new TypeError('name at least one label or label policy to restore');
  const keys = [...new Set(targets.map((key) => String(key).toLowerCase()))];
  for (const key of keys) if (!/^(label|label-policy):[0-9a-f-]{36}$/.test(key)) throw new TypeError(`${key} is not a label or label policy key`);

  const manual = [];
  const excluded = [];
  const operations = [];
  const resources = [];
  const lock = {};
  const liveFingerprints = {};
  const failedGroups = new Set((live?.failures ?? []).map((failure) => failure.group));

  for (const key of keys) {
    const group = key.startsWith('label-policy:') ? 'policy' : 'label';
    excluded.push(...PURVIEW_EXCLUDED_CONTENT.map((field) => ({ resourceKey: key, field, reason: 'labeled content and item-applied labels are never read or restored' })));
    if (failedGroups.has(group)) {
      const failure = live.failures.find((item) => item.group === group);
      manual.push({ resourceKey: key, field: null, reason: `the live ${group} read was ${failure.status}, so no change is planned`, error: failure.error ?? null });
      liveFingerprints[key] = null;
      continue;
    }
    const observation = (source.observations ?? []).find((item) => item.resourceKey === key);
    const current = (live?.resources ?? []).find((item) => item.resourceKey === key);
    liveFingerprints[key] = current ? definitionFingerprint(current) : 'absent';
    lock[key] = current?.lock ?? null;
    if (!observation && !current) { manual.push({ resourceKey: key, field: null, reason: 'neither the source nor the live read has this object' }); continue; }
    if (!observation) { manual.push({ resourceKey: key, field: null, reason: 'the source has no observation of this object (it is newer); KEEL never deletes a label or a policy' }); continue; }
    if (!current) {
      manual.push({ resourceKey: key, field: null, reason: 'it no longer exists; KEEL does not recreate it (a new object gets a new id, and items labeled with the old one are not relabeled)' });
      continue;
    }
    const changes = planTarget({ observation, live: current, manual });
    if (!changes.length) continue;
    const spec = OPERATIONS[group];
    const values = Object.fromEntries(changes.map(({ field, after }) => [field, after]));
    operations.push({
      key: `${group}:${key}`, kind: group, group, resourceKey: key, operationId: spec.operationId, naturalKey: `purview:${key}`,
      cmdlet: spec.cmdlet, changes, parameters: { Identity: current.id, ...values },
    });
    const payload = group === 'policy'
      ? { ...current.fields, Labels: [...list(current.fields.Labels), ...values.AddLabels ?? []] }
      : { ...current.fields, ...values };
    resources.push({
      naturalKey: `purview:${key}`, resourceType: spec.resourceType, verb: 'update', payload,
      live: { state: 'present', payload: { ...current.fields, ...(current.lock === 'locked' ? { isPreservationLocked: true } : {}) } },
    });
  }

  // The task-66 classifier refuses an object under a preservation lock.
  const classified = resources.length ? classifyContentEffects(resources) : { effects: [], refusals: [] };
  const plan = {
    workload: PURVIEW_WORKLOAD,
    tenantId: tenantId.toLowerCase(),
    targets: keys,
    source: { collectionId: source.collectionId, observedTo: source.observedTo ?? null, outcome: source.outcome },
    operations,
    manual,
    excluded,
    lock,
    contentEffects: classified.effects,
    refusals: classified.refusals,
    liveFingerprints,
  };
  plan.digest = purviewPlanDigest(plan);
  return deepFreeze(plan);
}

/** Persists the plan as an immutable dry-run artifact. */
export async function createPurviewRestoreArtifact(client, { tenantRef, plan, requestedBy }) {
  return createDryRunArtifact(client, {
    id: randomUUID(),
    tenantRef,
    snapshotId: null,
    selection: plan.targets.map((key) => `purview:${key}`),
    closureKeys: [...new Set([...plan.targets.map((key) => `purview:${key}`), ...plan.operations.map((op) => op.naturalKey)])],
    targetTenantId: plan.tenantId,
    collectorConfigPath: CONFIG_PATH,
    targetConfigPath: CONFIG_PATH,
    reconciliationResources: null,
    waves: [],
    patches: [],
    guardRefusals: plan.refusals,
    results: { operations: plan.operations.length, manual: plan.manual.length },
    currentStateFingerprint: sha256(plan.liveFingerprints),
    digest: plan.digest,
    status: plan.refusals.length ? 'refused' : 'completed',
    requestedBy,
    contentEffects: plan.contentEffects,
    workloadRestore: plan,
  });
}

async function recordOperation(client, { tenantRef, artifactId, actor, op, result }) {
  await appendEvidence(client, {
    tenantRef,
    kind: PURVIEW_RESTORE_EVIDENCE_KIND,
    subject: {
      artifactId, operationId: op.operationId, kind: op.kind, target: op.resourceKey,
      outcome: result.outcome, writes: result.writes, attempts: result.attempts ?? result.writes, verified: result.verified ?? [],
      reasons: result.reasons, error: result.error ?? null,
    },
    actor,
  });
}

/**
 * Promotes one approved artifact. `qualifications` maps each Purview write
 * operationId to workloadWriteQualification(operationId, ...); `powershell` holds
 * the runCmdlet options.
 * Plan outcomes: refused, no-change, disabled, blocked-content-effect, verified, partial.
 * Operation outcomes: disabled, blocked-content-effect, refused, stale, failed,
 * verification-failed, verified.
 */
export async function executePurviewRestore(client, { tenantRef, artifactId, tenantId, powershell = {}, qualifications = {}, actor = null }) {
  const artifact = await getDryRunArtifact(client, { id: artifactId, tenantRef });
  const by = actor ?? artifact?.requestedBy ?? 'keel';
  const finish = async (result) => {
    await appendEvidence(client, {
      tenantRef, kind: PURVIEW_RESTORE_EVIDENCE_KIND,
      subject: { artifactId, operationId: 'purview.restore', outcome: result.outcome, operations: result.operations.map(({ key, outcome }) => ({ key, outcome })), reasons: result.reasons ?? [] },
      actor: by,
    });
    return result;
  };
  const refuse = (reason) => finish({ outcome: 'refused', operations: [], reasons: [reason] });

  const plan = artifact?.workloadRestore ?? null;
  if (!plan || plan.workload !== PURVIEW_WORKLOAD) return refuse('no Purview restore plan with this id');
  const promotable = validateArtifactForApproval(artifact);
  if (!promotable.ok) return refuse(promotable.reason);
  if (purviewPlanDigest(plan) !== plan.digest || artifact.digest !== plan.digest || !same(artifact.contentEffects ?? [], plan.contentEffects)) {
    return refuse('the stored plan no longer matches its digest; a new dry run is required');
  }
  if (String(tenantId ?? '').toLowerCase() !== plan.tenantId) return refuse(`the plan targets tenant ${plan.tenantId}, not ${tenantId}`);
  if (plan.operations.length === 0) return finish({ outcome: 'no-change', operations: [], reasons: ['the live configuration already matches the source'] });

  const results = new Map();
  const settle = async (op, result) => {
    const full = { writes: 0, verified: [], ...result };
    results.set(op.key, { key: op.key, kind: op.kind, operationId: op.operationId, ...full });
    await recordOperation(client, { tenantRef, artifactId, actor: by, op, result: full });
  };

  let runnable = [];
  for (const op of plan.operations) {
    const qualification = qualifications[op.operationId];
    if (qualification?.operationId !== op.operationId || qualification.enabled !== true) {
      await settle(op, { outcome: 'disabled', reasons: [...(qualification?.reasons ?? [`no write qualification was supplied for ${op.operationId}`])] });
    } else runnable.push(op);
  }
  if (runnable.length && plan.contentEffects.length) {
    try {
      await assertContentEffectApproval(client, { artifact, effects: plan.contentEffects });
    } catch (error) {
      for (const op of runnable.filter((item) => plan.contentEffects.some((effect) => effect.naturalKey === item.naturalKey))) {
        await settle(op, { outcome: 'blocked-content-effect', reasons: [error.message] });
      }
      runnable = runnable.filter((item) => !plan.contentEffects.some((effect) => effect.naturalKey === item.naturalKey));
    }
  }
  if (runnable.length) await runOperations(plan, runnable, { powershell, settle });

  const operations = plan.operations.map((op) => results.get(op.key));
  const outcomes = new Set(operations.map((op) => op.outcome));
  let outcome;
  if (outcomes.size === 1 && outcomes.has('verified')) outcome = 'verified';
  else if (outcomes.size === 1 && outcomes.has('disabled')) outcome = 'disabled';
  else if (outcomes.size === 1 && outcomes.has('blocked-content-effect')) outcome = 'blocked-content-effect';
  else outcome = 'partial';
  return finish({ outcome, operations, reasons: [] });
}

const liveEntry = (live, op) => (live.failures.some((failure) => failure.group === op.group)
  ? null
  : live.resources.find((item) => item.resourceKey === op.resourceKey) ?? null);

async function runOperations(plan, runnable, { powershell, settle }) {
  // Re-read: nothing an operation touches may have changed since the dry run.
  const live = await readPurview({ powershell });
  for (const op of runnable) {
    const entry = liveEntry(live, op);
    if (!entry || definitionFingerprint(entry) !== plan.liveFingerprints[op.resourceKey]) {
      await settle(op, { outcome: 'stale', reasons: [`the live ${op.group} changed since the dry run, or could not be re-read; a new dry run is required`] });
      continue;
    }
    if (entry.lock === 'locked') {
      await settle(op, { outcome: 'refused', reasons: ['the object now reports a preservation lock; KEEL never changes a locked label or policy'] });
      continue;
    }
    await runCmdletOperation(op, { powershell, settle });
  }
}

function verifiedFields(op, entry) {
  const verified = [];
  const mismatched = [];
  for (const { field, after } of op.changes) {
    if (field === 'AddLabels') {
      const now = lower(list(entry.fields.Labels));
      (entry.fieldCoverage.Labels?.status === 'observed' && after.every((label) => now.includes(label.toLowerCase())) ? verified : mismatched).push(field);
    } else {
      (entry.fieldCoverage[field]?.status === 'observed' && same(entry.fields[field], after) ? verified : mismatched).push(field);
    }
  }
  return { verified, mismatched };
}

async function verify(op, { powershell, settle }, { ambiguous, cause }) {
  let entry = null;
  try {
    entry = liveEntry(await readPurview({ powershell }), op);
  } catch (error) {
    cause = cause ?? error.message;
  }
  if (!entry) {
    await settle(op, { outcome: 'verification-failed', writes: 1, attempts: 1, reasons: [`the write ${ambiguous ? 'had an unknown outcome' : 'was sent'} and could not be read back`] });
    return;
  }
  const { verified, mismatched } = verifiedFields(op, entry);
  if (!mismatched.length) {
    await settle(op, {
      outcome: 'verified', writes: 1, attempts: 1, verified,
      reasons: ambiguous ? [`the write outcome was unknown (${cause}); the re-read shows it applied, so it was not resent`] : [],
    });
    return;
  }
  await settle(op, {
    outcome: ambiguous ? 'failed' : 'verification-failed', writes: 1, attempts: 1, verified,
    reasons: ambiguous
      ? [`the write outcome was unknown (${cause}) and the re-read does not show it; it was not resent`]
      : mismatched.map((field) => `${field} did not read back as written`),
  });
}

async function runCmdletOperation(op, context) {
  try {
    await purviewCmdlet({ cmdlet: op.cmdlet, parameters: op.parameters }, context.powershell);
  } catch (error) {
    if (error instanceof CmdletError && error.detail.code === 'CMDLET_ERROR') {
      const failed = structuredFailure(error);
      if (isPreservationLockFailure({ error: error.detail })) {
        await context.settle(op, { outcome: 'refused', writes: 1, attempts: 1, reasons: ['the platform refused the change because of a preservation lock; KEEL never retries or works around it'], error: failed.error });
        return;
      }
      await context.settle(op, {
        outcome: failed.status === 'denied' ? 'refused' : 'failed', writes: 1, attempts: 1,
        reasons: [`${op.cmdlet} failed: ${error.detail.message}; nothing is retried automatically`], error: failed.error,
      });
      return;
    }
    // No answer (timeout, crash, malformed output): reconcile by reading, never resend.
    await verify(op, context, { ambiguous: true, cause: error.message });
    return;
  }
  await verify(op, context, { ambiguous: false, cause: null });
}
