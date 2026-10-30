/**
 * Distribution list restore through Microsoft365DSC (the keel-dsc profile): the first
 * setting KEEL puts back with DSC, because Microsoft Graph can read distribution lists
 * and mail-enabled security groups but cannot create or change them.
 *
 * Source: the `exchange-distribution-groups` backup, family `distributionGroup`
 * (engine/collect/workloads/exchangeRecipients.mjs, Get-DistributionGroup). The live
 * side, the write and the read-back all go through one resource, EXODistributionGroup,
 * one allowlisted call at a time (engine/powershell/dscJob.mjs, ops/powershell/run-dsc.ps1).
 *
 * One plan covers the lists of one recorded collection, or the ones named in it. Each
 * list is one DISTINCT operation with its own qualification, outcome and evidence row:
 *  - update: the list still exists (found by its Guid): a Set with the declared settings,
 *            where the ones that differ take the backup's value;
 *  - add:    the list is gone and no other list uses its name: a Set that creates it with
 *            its name, display name, alias, primary address, type and settings. It gets a
 *            new identity, so what pointed at the old one (permissions granted to a
 *            mail-enabled security group, rules naming it) is listed, not claimed.
 * Everything else is listed for an administrator with both values, and nothing is
 * deleted (a Set always carries Ensure = Present):
 *  - who manages, moderates, may send to or send for the list (ManagedBy, ModeratedBy,
 *    AcceptMessagesOnlyFromSendersOrMembers, RejectMessagesFromSendersOrMembers,
 *    GrantSendOnBehalfTo): privilege and delivery grants, decided by a person;
 *  - its addresses once it exists (Alias, PrimarySmtpAddress, EmailAddresses) and a rename;
 *  - its members: the Entra group backup keeps them; this writer does not add members;
 *  - room lists and other group types.
 *
 * Rules (the same as the other workload writers):
 *  - Immutable plan, persisted as a restore_dry_run artifact; promotion needs the
 *    existing approval by someone other than the requester.
 *  - Disabled until qualified, per operation: a live write capture on this tenant at the
 *    pinned Microsoft365DSC version, the read-back enabled, and the restorer's grants observed.
 *  - Content effect guard. Turning RequireSenderAuthenticationEnabled off lets anyone
 *    outside the organization mail every member: an `externally-sharing` effect that
 *    needs the separate, current high-impact approval; without it nothing is sent.
 *  - No overwrite. Every list is read again just before it is written; a change since
 *    the plan makes only that list's operation `stale`.
 *  - Test tenant fixtures only (fixtureGuard.mjs): on the test tenant every list written
 *    is named KEEL-RT-*, at plan time and again before writing.
 *  - No trust, certificate, federation or sign-in field is declared (isTrustField).
 *  - Errors are structured; an ambiguous outcome is reconciled by reading again and is
 *    never sent a second time.
 */
import { createHash, randomUUID } from 'node:crypto';

import { appendEvidence } from '../../govern/evidence.mjs';
import { DSC_MODULE_VERSION, DscError, DscScopeError, runDsc } from '../../powershell/dscJob.mjs';
import { assertContentEffectApproval, disclosureFor } from '../../safety/contentEffects.mjs';
import { createDryRunArtifact, getDryRunArtifact, validateArtifactForApproval } from '../dryRunArtifact.mjs';
import { TEST_TENANT_REFS, fixtureProblem } from './fixtureGuard.mjs';
import {
  CREATE_FIELDS, DISTRIBUTION_GROUP_ADD, DISTRIBUTION_GROUP_FAMILY, DISTRIBUTION_GROUP_RESOURCE, DISTRIBUTION_GROUP_TYPES as TYPES,
  DISTRIBUTION_GROUP_UPDATE, DISTRIBUTION_GROUPS_WORKLOAD, DSC_RESOURCES, DSC_RESTORE_EVIDENCE_KIND, DSC_WRITE_OPERATIONS, LISTED_FIELDS, LISTED_WHY,
  MAX_DSC_TARGETS, NOT_CARRIED, OBSERVED_ONLY, UPDATE_FIELDS,
} from './dscDeclarations.mjs';

export {
  CREATE_FIELDS, DISTRIBUTION_GROUP_ADD, DISTRIBUTION_GROUP_FAMILY, DISTRIBUTION_GROUP_RESOURCE, DISTRIBUTION_GROUP_UPDATE, DISTRIBUTION_GROUPS_WORKLOAD,
  DSC_RESOURCES, DSC_RESTORE_EVIDENCE_KIND, DSC_WRITE_OPERATIONS, LISTED_FIELDS, MAX_DSC_TARGETS, OBSERVED_ONLY, UPDATE_FIELDS,
};


// ------------------------------------------------------------ values

function canonical(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const sha256 = (value) => createHash('sha256').update(canonical(value)).digest('hex');

/** One comparable form: 'True'/'False' as booleans, '' and [] as null, lists sorted case-blind. */
export function normalize(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value === 'True' || value === 'true') return true;
  if (value === 'False' || value === 'false') return false;
  if (Array.isArray(value)) {
    const items = value.filter((item) => item !== null && item !== undefined && item !== '').map(String);
    return items.length ? [...new Set(items)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())) : null;
  }
  return value;
}
const sameValue = (a, b) => {
  const left = normalize(a);
  const right = normalize(b);
  if (typeof left === 'string' && typeof right === 'string') return left.toLowerCase() === right.toLowerCase();
  if (Array.isArray(left) && Array.isArray(right)) return canonical(left.map((item) => item.toLowerCase())) === canonical(right.map((item) => item.toLowerCase()));
  return canonical(left) === canonical(right);
};
/** A value the DSC transport can carry: a scalar or a list of strings, never null. */
const sendable = (value) => value !== null && (['string', 'number', 'boolean'].includes(typeof value) || (Array.isArray(value) && value.every((item) => typeof item === 'string')));

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const COMPARED = Object.freeze(['Name', 'Type', 'Alias', 'PrimarySmtpAddress', ...UPDATE_FIELDS, ...LISTED_FIELDS]);
/** The live state a plan was made against: present or absent, and the compared properties. */
function liveFingerprint(state) {
  if (!state || state.Ensure !== 'Present') return 'absent';
  return sha256(Object.fromEntries(COMPARED.map((field) => [field, normalize(state[field])])));
}

// ------------------------------------------------------------ live reads

/** A DSC runner for one connection: (request) -> runDsc answer. */
export function dscRunner(powershell = {}, { run = runDsc, env = process.env } = {}) {
  const { tenantConfigPath = null, timeoutMs, credentialRoot, stagingRoot, scriptMount, dockerBin, spawnFn } = powershell;
  const options = Object.fromEntries(Object.entries({ timeoutMs, credentialRoot, stagingRoot, scriptMount, dockerBin, spawnFn }).filter(([, value]) => value !== undefined));
  return (request) => run({ ...request, tenantConfigPath }, { ...options, resources: DSC_RESOURCES, image: env.KEEL_DSC_IMAGE || undefined });
}

/**
 * A Get for one identity (a Guid or a name). Name carries the same value: the resource
 * needs a Name, and if its lookup ever fell back from Identity to Name, a backed-up name
 * sent beside a Guid could find another list that now uses that name.
 */
const getCall = (identity) => ({ method: 'Get', properties: { Identity: identity, Name: identity, Ensure: 'Present' } });

/**
 * Reads each list live: by its Guid first, then, for one that is gone, by its backed-up
 * name (to tell "gone" from "its name is now used by another list"). Two DSC jobs at most.
 * Returns { [guid]: { byGuid, byName } } where each is a Get result, or throws.
 */
export async function readLiveLists(dsc, lists) {
  const out = {};
  if (!lists.length) return out;
  const first = await dsc({ resource: DISTRIBUTION_GROUP_RESOURCE, calls: lists.map(({ guid }) => getCall(guid)) });
  lists.forEach(({ guid }, index) => { out[guid] = { byGuid: first.results[index], byName: null }; });
  const gone = lists.filter(({ guid }) => out[guid].byGuid.ok && out[guid].byGuid.state?.Ensure !== 'Present');
  if (gone.length) {
    const second = await dsc({ resource: DISTRIBUTION_GROUP_RESOURCE, calls: gone.map(({ name }) => getCall(name)) });
    gone.forEach(({ guid }, index) => { out[guid].byName = second.results[index]; });
  }
  return out;
}

// ------------------------------------------------------------ planning

/** The backed-up lists the plan covers: every distribution list, or the named ones. */
function targetObservations(source, targets) {
  const lists = (source.observations ?? []).filter((item) => item.kind === DISTRIBUTION_GROUP_FAMILY);
  if (!targets.length) return lists;
  const wanted = new Set(targets.map((target) => String(target).toLowerCase()));
  const picked = lists.filter((item) => [item.resourceKey, item.identity, item.fields?.Name].some((value) => typeof value === 'string' && wanted.has(value.toLowerCase())));
  const known = new Set(picked.flatMap((item) => [item.resourceKey, item.identity, item.fields?.Name].filter(Boolean).map((value) => value.toLowerCase())));
  const unknown = [...wanted].filter((target) => !known.has(target));
  if (unknown.length) throw new Error(`the backup holds no distribution list named ${unknown.join(', ')}`);
  return picked;
}

/**
 * The backed-up fields the collector actually observed. A field it could not read, or
 * redacted because the value looked like a credential, holds no value KEEL may write
 * (the same rule as the other cmdlet writers).
 */
export function recordedFields(observation) {
  const fields = observation?.fields ?? {};
  const coverage = observation?.fieldCoverage ?? {};
  return Object.fromEntries(Object.entries(fields).filter(([field]) => coverage[field]?.status === 'observed'));
}

const listed = (resourceKey, field, before, after, reason) => ({ resourceKey, field, before: normalize(before), after: normalize(after), reason });

/**
 * Builds the frozen plan. `source` is the recorded collection (loadWorkloadSource);
 * `live` is readLiveLists' answer for the same lists.
 */
export function planDistributionGroupRestore({
  source, live, tenantId, tenantRef, targets = [], testTenantRefs = TEST_TENANT_REFS,
}) {
  if (!source?.collectionId) throw new TypeError('a distribution list restore needs a recorded source collection');
  if (typeof tenantRef !== 'string' || !tenantRef) throw new TypeError('a distribution list restore plan needs the tenant');
  if (typeof tenantId !== 'string' || !/^[0-9a-f-]{36}$/i.test(tenantId)) throw new TypeError('tenantId must be the managed tenant\'s directory id');
  if (!['complete', 'complete-empty', 'partial'].includes(source.outcome)) throw new Error(`a ${source.outcome} collection is not a restore source`);
  const observations = targetObservations(source, targets);
  if (observations.length > MAX_DSC_TARGETS) throw new Error(`a plan covers at most ${MAX_DSC_TARGETS} lists; name them with --target`);

  const operations = [];
  const manual = [];
  const refusals = [];
  const liveFingerprints = {};
  const resources = [];
  for (const observation of [...observations].sort((a, b) => a.resourceKey.localeCompare(b.resourceKey))) {
    const key = observation.resourceKey;
    const guid = observation.identity;
    const backup = recordedFields(observation);
    const naturalKey = `${DISTRIBUTION_GROUPS_WORKLOAD}:${key}`;
    const type = TYPES[backup.RecipientTypeDetails];
    if (!type) {
      manual.push(listed(key, null, null, null, `it is a ${backup.RecipientTypeDetails ?? 'group of unknown type'}; KEEL's writer restores distribution lists and mail-enabled security groups only, so an administrator restores it`));
      continue;
    }
    if (typeof guid !== 'string' || typeof backup.Name !== 'string' || !backup.Name) {
      manual.push(listed(key, null, null, null, 'the backup does not name this list (no Guid or Name), so it cannot be matched safely'));
      continue;
    }
    const read = live?.[guid];
    const failed = !read || !read.byGuid?.ok || (read.byName && !read.byName.ok);
    if (failed) {
      const error = read?.byGuid?.error ?? read?.byName?.error ?? null;
      manual.push({ ...listed(key, null, null, null, 'the list could not be read live, so no change is planned'), error });
      liveFingerprints[key] = null;
      continue;
    }
    const current = read.byGuid.state?.Ensure === 'Present' ? read.byGuid.state : null;
    if (!current && read.byName?.state?.Ensure === 'Present') {
      manual.push(listed(key, 'Name', backup.Name, read.byName.state.Name, 'the backed-up list is gone and another list now uses its name; an administrator decides which one to keep'));
      liveFingerprints[key] = null;
      continue;
    }
    liveFingerprints[key] = liveFingerprint(current);
    const names = [backup.Name, current?.Name].filter(Boolean);
    const notFixture = fixtureProblem({ tenantRef, testTenantRefs, label: key, names });
    if (notFixture) {
      refusals.push({ naturalKey, reason: `not-a-fixture: ${notFixture}` });
      continue;
    }

    // A field the backup did not record (unreadable or redacted) is never written; say so once.
    for (const field of ['Alias', 'PrimarySmtpAddress', ...UPDATE_FIELDS]) {
      const status = observation.fieldCoverage?.[field]?.status ?? 'unknown';
      if (status !== 'observed') manual.push(listed(key, field, current?.[field] ?? null, null, `the backup did not record this value (${status}), so KEEL does not write it; an administrator checks it`));
    }
    let op;
    if (current) {
      if (normalize(current.Type) && normalize(current.Type) !== type) {
        manual.push(listed(key, 'Type', type, current.Type, 'the list changed type; Exchange cannot convert it back, so an administrator decides'));
      }
      if (!sameValue(current.Name, backup.Name)) manual.push(listed(key, 'Name', current.Name, backup.Name, 'the list was renamed; KEEL does not rename it back'));
      for (const field of ['Alias', 'PrimarySmtpAddress', ...LISTED_FIELDS]) {
        if (Object.hasOwn(backup, field) && !sameValue(current[field], backup[field])) manual.push(listed(key, field, current[field], backup[field], `${LISTED_WHY[field]}; an administrator applies it`));
      }
      const changes = [];
      for (const field of UPDATE_FIELDS) {
        if (!Object.hasOwn(backup, field) || sameValue(current[field], backup[field])) continue;
        if (!sendable(normalize(backup[field]))) {
          manual.push(listed(key, field, current[field], backup[field], 'the backup holds no value KEEL can send; an administrator applies it'));
          continue;
        }
        changes.push({ field, before: normalize(current[field]), after: normalize(backup[field]) });
      }
      if (!changes.length) continue;
      // The whole declared set goes in the Set: the changed fields take the backup's value,
      // the others keep the live one, so nothing declared is left to a resource default.
      const properties = { Identity: current.Name, Name: current.Name, Ensure: 'Present' };
      for (const field of UPDATE_FIELDS) {
        const change = changes.find((item) => item.field === field);
        const value = change ? change.after : normalize(current[field]);
        if (sendable(value)) properties[field] = value;
      }
      op = { kind: 'update', operationId: DISTRIBUTION_GROUP_UPDATE, changes, properties, readIdentity: guid };
    } else {
      const changes = [{ field: 'Name', before: null, after: backup.Name }, { field: 'Type', before: null, after: type }];
      const properties = { Identity: backup.Name, Name: backup.Name, Ensure: 'Present', Type: type };
      for (const field of CREATE_FIELDS) {
        const value = normalize(backup[field]);
        if (value === null) continue;
        if (!sendable(value)) { manual.push(listed(key, field, null, backup[field], 'the backup holds no value KEEL can send; an administrator applies it')); continue; }
        properties[field] = value;
        changes.push({ field, before: null, after: value });
      }
      for (const field of LISTED_FIELDS) {
        if (normalize(backup[field]) !== null) manual.push(listed(key, field, null, backup[field], `${LISTED_WHY[field]}; the re-created list starts without it, so an administrator applies it`));
      }
      for (const field of NOT_CARRIED) {
        if (normalize(backup[field]) !== null) manual.push(listed(key, field, null, backup[field], 'KEEL\'s distribution list writer does not carry this setting; an administrator applies it'));
      }
      manual.push(listed(key, 'Members', null, null, 'the re-created list starts with no members; the Entra group backup lists them, and an administrator adds them'));
      manual.push(listed(key, null, null, null, `the re-created list gets a new identity: permissions${type === 'Security' ? ' granted to this security group' : ''}, mail flow rules and anything else that named the old one do not come back`));
      op = { kind: 'add', operationId: DISTRIBUTION_GROUP_ADD, changes, properties, readIdentity: backup.Name };
    }
    operations.push({ key, resourceKey: key, naturalKey, guid, ...op });
    resources.push({ naturalKey, verb: op.kind, before: current, after: { ...(current ?? { RequireSenderAuthenticationEnabled: true }), ...op.properties } });
  }

  const plan = {
    workload: DISTRIBUTION_GROUPS_WORKLOAD,
    writer: 'microsoft365dsc',
    moduleVersion: DSC_MODULE_VERSION,
    tenantId: tenantId.toLowerCase(),
    targets: observations.map((item) => item.resourceKey).sort(),
    source: { collectionId: source.collectionId, observedTo: source.observedTo ?? null, outcome: source.outcome },
    operations,
    manual,
    excluded: [],
    contentEffects: distributionGroupEffects(resources),
    refusals,
    liveFingerprints,
  };
  plan.digest = distributionGroupPlanDigest(plan);
  return deepFreeze(plan);
}

/**
 * Turning RequireSenderAuthenticationEnabled off (or creating a list with it off) lets
 * anyone outside the organization mail every member: `externally-sharing`.
 */
export function distributionGroupEffects(resources) {
  const effects = [];
  for (const { naturalKey, before, after } of resources) {
    const was = normalize(before?.RequireSenderAuthenticationEnabled ?? true);
    const will = normalize(after?.RequireSenderAuthenticationEnabled ?? was);
    if (was !== false && will === false) {
      effects.push({
        naturalKey, resourceType: 'exchangeDistributionGroup', field: 'RequireSenderAuthenticationEnabled', effect: 'externally-sharing',
        before: was, after: will, disclosure: disclosureFor('externally-sharing'),
      });
    }
  }
  return effects;
}

export function distributionGroupPlanDigest(plan) {
  const { digest, ...rest } = plan;
  return sha256(rest);
}

/** Persists the plan as an immutable dry-run artifact. */
export async function createDistributionGroupArtifact(client, { tenantRef, plan, requestedBy, id = randomUUID() }) {
  const configPath = `workload:${plan.workload}`;
  return createDryRunArtifact(client, {
    id,
    tenantRef,
    snapshotId: null,
    selection: plan.targets.map((key) => `${plan.workload}:${key}`),
    closureKeys: [...new Set([...plan.targets.map((key) => `${plan.workload}:${key}`), ...plan.operations.map((op) => op.naturalKey)])],
    targetTenantId: plan.tenantId,
    collectorConfigPath: configPath,
    targetConfigPath: configPath,
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
    complianceFix: null,
  });
}

// ------------------------------------------------------------ execution

/** The list as read now for one operation, as { state } or { error }. */
async function readOne(dsc, op) {
  try {
    const { results: [result] } = await dsc({ resource: DISTRIBUTION_GROUP_RESOURCE, calls: [getCall(op.readIdentity)] });
    return result.ok ? { state: result.state ?? null } : { error: result.error?.message ?? 'the read failed' };
  } catch (error) {
    return { error: error.message };
  }
}

function readBackProblems(op, state) {
  if (state?.Ensure !== 'Present') return ['the list is not there'];
  return op.changes.filter(({ field, after }) => !sameValue(state[field], after)).map(({ field }) => `${field} did not read back as written`);
}

/**
 * Promotes one approved artifact. `dsc` is the restorer's DSC runner (dscRunner);
 * `qualifications` maps each write operationId to its qualification.
 * Plan outcomes: refused, no-change, disabled, blocked-content-effect, verified, partial.
 * Operation outcomes: disabled, blocked-content-effect, refused, stale, failed,
 * verification-failed, verified.
 */
export async function executeDistributionGroupRestore(client, {
  tenantRef, artifactId, tenantId, dsc, qualifications = {}, actor = null, testTenantRefs = TEST_TENANT_REFS,
}) {
  const artifact = await getDryRunArtifact(client, { id: artifactId, tenantRef });
  const by = actor ?? artifact?.requestedBy ?? 'keel';
  const finish = async (result) => {
    await appendEvidence(client, {
      tenantRef, kind: DSC_RESTORE_EVIDENCE_KIND,
      subject: { artifactId, operationId: `${DISTRIBUTION_GROUPS_WORKLOAD}.restore`, outcome: result.outcome, operations: result.operations.map(({ key, outcome }) => ({ key, outcome })), reasons: result.reasons ?? [] },
      actor: by,
    });
    return result;
  };
  const refuse = (reason) => finish({ outcome: 'refused', operations: [], reasons: [reason] });

  const plan = artifact?.workloadRestore ?? null;
  if (!plan || plan.workload !== DISTRIBUTION_GROUPS_WORKLOAD || plan.writer !== 'microsoft365dsc') return refuse('no distribution list restore plan with this id');
  const promotable = validateArtifactForApproval(artifact);
  if (!promotable.ok) return refuse(promotable.reason);
  if (distributionGroupPlanDigest(plan) !== plan.digest || artifact.digest !== plan.digest || canonical(artifact.contentEffects ?? []) !== canonical(plan.contentEffects)) {
    return refuse('the stored plan no longer matches its digest; a new dry run is required');
  }
  if (String(tenantId ?? '').toLowerCase() !== plan.tenantId) return refuse(`the plan targets tenant ${plan.tenantId}, not ${tenantId}`);
  if (plan.moduleVersion !== DSC_MODULE_VERSION) return refuse(`the plan was made with Microsoft365DSC ${plan.moduleVersion}; this build runs ${DSC_MODULE_VERSION}, so a new dry run is required`);
  if (plan.operations.length === 0) return finish({ outcome: 'no-change', operations: [], reasons: ['the live lists already match the backup'] });

  const results = new Map();
  const settle = async (op, result) => {
    const full = { writes: 0, verified: [], ...result };
    results.set(op.key, { key: op.key, kind: op.kind, operationId: op.operationId, ...full });
    await appendEvidence(client, {
      tenantRef, kind: DSC_RESTORE_EVIDENCE_KIND,
      subject: {
        artifactId, operationId: op.operationId, kind: op.kind, target: op.resourceKey, outcome: full.outcome, writes: full.writes,
        attempts: full.attempts ?? full.writes, verified: full.verified, reasons: full.reasons, error: full.error ?? null,
      },
      actor: by,
    });
  };

  let runnable = [];
  for (const op of plan.operations) {
    const qualification = qualifications[op.operationId];
    if (qualification?.operationId !== op.operationId || qualification.enabled !== true) {
      await settle(op, { outcome: 'disabled', reasons: [...(qualification?.reasons ?? [`no write qualification was supplied for ${op.operationId}`])] });
    } else runnable.push(op);
  }
  const affected = (op) => plan.contentEffects.some((effect) => effect.naturalKey === op.naturalKey);
  if (runnable.some(affected)) {
    try {
      await assertContentEffectApproval(client, { artifact, effects: plan.contentEffects });
    } catch (error) {
      for (const op of runnable.filter(affected)) await settle(op, { outcome: 'blocked-content-effect', reasons: [error.message] });
      runnable = runnable.filter((op) => !affected(op));
    }
  }

  for (const op of runnable) {
    // Read again just before writing: by Guid for a list that exists, by name for one to re-create.
    let now;
    try {
      const read = await readLiveLists(dsc, [{ guid: op.guid, name: op.properties.Name }]);
      const entry = read[op.guid];
      if (!entry.byGuid.ok || (entry.byName && !entry.byName.ok)) now = null;
      else if (entry.byGuid.state?.Ensure === 'Present') now = { fingerprint: liveFingerprint(entry.byGuid.state), state: entry.byGuid.state };
      else if (entry.byName?.state?.Ensure === 'Present') now = { fingerprint: 'taken', state: entry.byName.state };
      else now = { fingerprint: 'absent', state: null };
    } catch {
      now = null;
    }
    if (!now || now.fingerprint !== plan.liveFingerprints[op.resourceKey]) {
      await settle(op, { outcome: 'stale', reasons: ['the list changed since the dry run, or could not be read again; a new dry run is required'] });
      continue;
    }
    const notFixture = fixtureProblem({ tenantRef, testTenantRefs, label: op.resourceKey, names: [op.properties.Name, now.state?.Name].filter(Boolean) });
    if (notFixture) {
      await settle(op, { outcome: 'refused', reasons: [notFixture] });
      continue;
    }
    await runOperation(op, { dsc, settle });
  }

  const operations = plan.operations.map((op) => results.get(op.key));
  const outcomes = new Set(operations.map((op) => op.outcome));
  let outcome = 'partial';
  for (const single of ['verified', 'disabled', 'blocked-content-effect']) if (outcomes.size === 1 && outcomes.has(single)) outcome = single;
  return finish({ outcome, operations, reasons: [] });
}

async function runOperation(op, { dsc, settle }) {
  let answer;
  try {
    // The write and its read-back in one job: one container start.
    answer = await dsc({ resource: DISTRIBUTION_GROUP_RESOURCE, calls: [{ method: 'Set', properties: op.properties }, getCall(op.readIdentity)] });
  } catch (error) {
    if (error instanceof DscScopeError) {
      await settle(op, { outcome: 'refused', reasons: [error.message] });
      return;
    }
    // The container refused the job or could not connect: it stops before the first call, so nothing was sent.
    if (error instanceof DscError && error.detail.code === 'DSC_JOB_REFUSED') {
      await settle(op, { outcome: error.detail.errorId === 'ConnectFailed' ? 'failed' : 'refused', reasons: [`${error.message}; nothing was sent`], error: error.detail });
      return;
    }
    // No answer (timeout, crash, no connection, malformed output): reconcile by reading, never resend.
    const read = await readOne(dsc, op);
    const problems = read.state ? readBackProblems(op, read.state) : [read.error];
    await settle(op, {
      outcome: problems.length ? 'failed' : 'verified', writes: 1, attempts: 1,
      verified: problems.length ? [] : op.changes.map(({ field }) => field),
      reasons: problems.length
        ? [`the write outcome was unknown (${error.message}) and the re-read does not show it; it was not resent`]
        : [`the write outcome was unknown (${error.message}); the re-read shows it applied, so it was not resent`],
    });
    return;
  }
  const [set, get] = answer.results;
  if (!set.ok) {
    // A Set can apply part of a change before it fails: the read-back in the same job says which fields now hold the backup's value.
    const after = get?.ok ? get.state : null;
    const applied = after ? op.changes.filter(({ field, after: value }) => sameValue(after[field], value)).map(({ field }) => field) : [];
    await settle(op, {
      outcome: /access|denied|forbidden|unauthori[sz]ed|permission/i.test(set.error?.message ?? '') ? 'refused' : 'failed', writes: 1, attempts: 1,
      verified: applied,
      reasons: [
        `the Set failed: ${set.error?.message ?? 'no message'}; nothing is retried automatically`,
        after ? (applied.length ? `the read-back shows ${applied.join(', ')} already hold the backup's value` : 'the read-back shows none of the changes applied') : 'the list could not be read back after the failed Set',
      ],
      error: set.error ?? null,
    });
    return;
  }
  const state = get.ok ? get.state : (await readOne(dsc, op)).state;
  const problems = state ? readBackProblems(op, state) : ['the list could not be read back'];
  await settle(op, {
    outcome: problems.length ? 'verification-failed' : 'verified', writes: 1, attempts: 1,
    verified: op.changes.filter(({ field, after }) => state && sameValue(state[field], after)).map(({ field }) => field),
    reasons: problems,
  });
}

// ------------------------------------------------------------ dispatch entry

/**
 * The dispatch.mjs entry. `load` is loadWorkloadSource; `runner` builds a DSC runner from
 * a connection's PowerShell options (the collector for the dry run, the restorer to promote).
 */
export function distributionGroupRestore({ load, runner = dscRunner } = {}) {
  return Object.freeze({
    label: 'Distribution lists',
    operations: Object.freeze(Object.keys(DSC_WRITE_OPERATIONS)),
    usage: '--collection <id> [--target <list name or Guid> ...]',
    async plan(client, { tenantRef, tenantId, request, connection }) {
      if (typeof request.collectionId !== 'string' || !request.collectionId) throw new Error('--collection <id> is required for this workload');
      const source = await load(client, { tenantRef, collectionId: request.collectionId, workload: DISTRIBUTION_GROUPS_WORKLOAD });
      if (!source) throw new Error(`no recorded distribution list collection ${request.collectionId} for this tenant`);
      const lists = targetObservations(source, request.targets ?? [])
        .map((item) => ({ guid: item.identity, fields: recordedFields(item) }))
        .filter(({ guid, fields }) => typeof guid === 'string' && typeof fields.Name === 'string' && TYPES[fields.RecipientTypeDetails])
        .map(({ guid, fields }) => ({ guid, name: fields.Name }));
      if (lists.length > MAX_DSC_TARGETS) throw new Error(`a plan covers at most ${MAX_DSC_TARGETS} lists; name them with --target`);
      const live = await readLiveLists(runner(connection.powershell), lists);
      return planDistributionGroupRestore({ source, live, tenantId, tenantRef, targets: request.targets ?? [] });
    },
    create: createDistributionGroupArtifact,
    execute: (client, { tenantRef, artifactId, tenantId, connection, qualifications }) => executeDistributionGroupRestore(client, {
      tenantRef, artifactId, tenantId, dsc: runner(connection.powershell), qualifications,
    }),
  });
}
