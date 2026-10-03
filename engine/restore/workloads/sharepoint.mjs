/**
 * Roadmap task-103: qualified SharePoint configuration restore.
 *
 * It writes back exactly one kind of setting: the tenant-wide sharing settings
 * Graph exposes at /admin/sharepoint/settings, and only the five fields the
 * task-102 reader observes. Everything else stays manual:
 *  - per-site settings (sharing, lock state, labels) need the SharePoint admin
 *    interface, which is not qualified;
 *  - site app permission grants hand an application access to content, so they
 *    are re-granted by a person;
 *  - server-owned fields (ids, URLs, timestamps) are never written.
 *
 * Rules:
 *  - Immutable plan. planSharePointRestore() freezes the source, the exact PATCH
 *    body, manual items, content effects and a fingerprint of the live settings.
 *    It is persisted as a restore_dry_run artifact, so the task-66 approval and
 *    promotion checks are the existing ones, unchanged.
 *  - Disabled until qualified. executeSharePointRestore() sends nothing unless the
 *    write is live-qualified and enabled (coverage/qualification.mjs). A fixture
 *    pass alone never enables it.
 *  - Exact approval. A change that widens sharing needs the separate content-effect
 *    approval of exactly those effects.
 *  - No overwrite. Settings are re-read before the write; if they changed since the
 *    plan, nothing is written and a new dry run is required.
 *  - Verified. After the write the settings are read back and each written field is
 *    compared. A preservation-lock refusal is reported, never retried.
 *  - No content. This never reads or writes files, list items or messages, and makes
 *    no claim that content is recovered.
 */
import { createHash, randomUUID } from 'node:crypto';

import { TENANT_FIELDS, SITE_FIELDS, UNSUPPORTED_SITE_FIELDS, SHAREPOINT_WORKLOAD } from '../../collect/workloads/sharepoint.mjs';
import { WORKLOAD_DESCRIPTORS, readGraphConfiguration } from '../../collect/workloadContract.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../../coverage/qualification.mjs';
import { appendEvidence } from '../../govern/evidence.mjs';
import { assertContentEffectApproval, classifyContentEffects, isPreservationLockFailure } from '../../safety/contentEffects.mjs';
import { createDryRunArtifact, getDryRunArtifact, validateArtifactForApproval } from '../dryRunArtifact.mjs';

export const SHAREPOINT_WRITE_OPERATION = 'sharepoint.tenant-settings.update';
export const SHAREPOINT_RESTORE_EVIDENCE_KIND = 'workload-restore';
export const TENANT_RESOURCE_KEY = 'tenant';
const RESOURCE_TYPE = 'sharepointTenantSettings';
const NATURAL_KEY = 'sharepoint:tenant-settings';
const CONFIG_PATH = 'workload:sharepoint-site-settings';
const GRAPH = 'https://graph.microsoft.com';

const write = WORKLOAD_WRITE_OPERATIONS[SHAREPOINT_WRITE_OPERATION];
const readBack = WORKLOAD_DESCRIPTORS.find((descriptor) => descriptor.id === write.readBack);
if (write.fields.some((field) => !Object.hasOwn(TENANT_FIELDS, field))) {
  throw new Error('every written SharePoint field must be one the reader observes');
}

// Fields the platform owns. Never written, never shown as restorable.
const SERVER_OWNED_SITE_FIELDS = Object.freeze(['createdDateTime', 'lastModifiedDateTime', 'webUrl', 'hostname']);
const MANUAL_SITE_REASON = Object.freeze({
  displayName: 'site properties are not written by KEEL; rename the site in SharePoint',
  name: 'site properties are not written by KEEL; the site URL name is changed in SharePoint admin',
  appPermissionGrants: 'an app permission grant hands an application access to site content; a person re-grants it',
});

function canonical(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const sha256 = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const same = (a, b) => canonical(a ?? null) === canonical(b ?? null);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** The live settings as KEEL compares them: every field Graph returned, minus annotations. */
export function liveSettingsFingerprint(live) {
  const projected = Object.fromEntries(Object.entries(live ?? {}).filter(([key]) => !key.startsWith('@odata')));
  return sha256(projected);
}

/** The plan's identity: everything an approver reviewed. */
export function workloadPlanDigest(plan) {
  const { digest, ...rest } = plan;
  return sha256(rest);
}

/**
 * Builds the frozen plan. `source` is a recorded task-102 collection
 * ({ collectionId, tenantHost, outcome, observedTo, observations: [{ resourceKey, fields, fieldCoverage }] });
 * `live` is the tenant settings body read now.
 */
export function planSharePointRestore({ source, live, tenantHost }) {
  if (!source?.collectionId) throw new TypeError('a SharePoint restore needs a recorded source collection');
  if (typeof tenantHost !== 'string' || source.tenantHost !== tenantHost) {
    throw new Error('the source collection was taken from a different SharePoint tenant');
  }
  if (!['complete', 'complete-empty', 'partial'].includes(source.outcome)) {
    throw new Error(`a ${source.outcome} collection is not a restore source`);
  }
  const observations = new Map((source.observations ?? []).map((entry) => [entry.resourceKey, entry]));
  const manual = [];
  const excluded = [];
  const changes = [];

  const tenant = observations.get(TENANT_RESOURCE_KEY);
  if (!tenant) manual.push({ resourceKey: TENANT_RESOURCE_KEY, field: null, reason: 'the source collection has no tenant settings' });
  for (const field of write.fields) {
    if (!tenant) break;
    const coverage = tenant.fieldCoverage?.[field]?.status ?? 'unknown';
    if (coverage !== 'observed') {
      manual.push({ resourceKey: TENANT_RESOURCE_KEY, field, reason: `${coverage} in the source collection, so there is no value to restore` });
      continue;
    }
    const after = tenant.fields?.[field] ?? null;
    const before = live?.[field] ?? null;
    if (!same(before, after)) changes.push({ field, before, after });
  }
  for (const field of Object.keys(tenant?.fields ?? {})) {
    if (!write.fields.includes(field)) excluded.push({ resourceKey: TENANT_RESOURCE_KEY, field, reason: 'not a written setting' });
  }

  for (const [resourceKey, entry] of observations) {
    if (!resourceKey.startsWith('site:')) continue;
    for (const field of Object.keys(SITE_FIELDS)) {
      if (SERVER_OWNED_SITE_FIELDS.includes(field)) {
        excluded.push({ resourceKey, field, reason: 'server-owned' });
        continue;
      }
      if (entry.fieldCoverage?.[field]?.status !== 'observed') continue;
      manual.push({ resourceKey, field, reason: MANUAL_SITE_REASON[field] });
    }
    for (const field of UNSUPPORTED_SITE_FIELDS) {
      manual.push({ resourceKey, field, reason: 'not read by KEEL (needs the SharePoint admin interface), so it is restored by hand' });
    }
  }

  const body = Object.fromEntries(changes.map(({ field, after }) => [field, after]));
  const { effects, refusals } = changes.length
    ? classifyContentEffects([{
      naturalKey: NATURAL_KEY, resourceType: RESOURCE_TYPE, verb: 'update', payload: { ...live, ...body }, live: { state: 'present', payload: live },
    }])
    : { effects: [], refusals: [] };

  const plan = {
    workload: SHAREPOINT_WORKLOAD,
    operationId: SHAREPOINT_WRITE_OPERATION,
    tenantHost,
    source: { collectionId: source.collectionId, observedTo: source.observedTo ?? null, outcome: source.outcome },
    operations: changes.length ? [{ resourceKey: TENANT_RESOURCE_KEY, naturalKey: NATURAL_KEY, method: write.method, endpoint: write.endpoint, changes, body }] : [],
    manual,
    excluded,
    contentEffects: effects,
    refusals,
    liveFingerprint: liveSettingsFingerprint(live),
  };
  plan.digest = workloadPlanDigest(plan);
  return deepFreeze(plan);
}

/** Reads a recorded task-102 collection as a restore source. */
export async function loadSharePointSource(client, { tenantRef, collectionId }) {
  const { rows: [run] } = await client.query(
    `SELECT * FROM workload_collection WHERE id::text = $1 AND tenant_ref = $2 AND workload = $3`,
    [collectionId, tenantRef, SHAREPOINT_WORKLOAD],
  );
  if (!run) return null;
  const { rows } = await client.query(
    `SELECT resource_key, fields, field_coverage FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key`,
    [run.id],
  );
  return {
    collectionId: run.id,
    tenantHost: run.digest?.tenantHost ?? null,
    outcome: run.outcome,
    observedTo: new Date(run.observed_to).toISOString(),
    observations: rows.map((row) => ({ resourceKey: row.resource_key, fields: row.fields, fieldCoverage: row.field_coverage })),
  };
}

/** Reads the live tenant settings through the task-101 contract. */
export async function readLiveSettings({ transport, sleep }) {
  const { items: [body = {}] } = await readGraphConfiguration(readBack, { transport, sleep });
  return body;
}

/** Persists the plan as an immutable dry-run artifact. */
export async function createSharePointRestoreArtifact(client, { tenantRef, plan, requestedBy }) {
  return createDryRunArtifact(client, {
    id: randomUUID(),
    tenantRef,
    snapshotId: null,
    selection: [NATURAL_KEY],
    closureKeys: [NATURAL_KEY],
    targetTenantId: plan.tenantHost,
    collectorConfigPath: CONFIG_PATH,
    targetConfigPath: CONFIG_PATH,
    reconciliationResources: null,
    waves: [],
    patches: [],
    guardRefusals: plan.refusals,
    results: { operations: plan.operations.length, manual: plan.manual.length },
    currentStateFingerprint: plan.liveFingerprint,
    digest: plan.digest,
    status: plan.refusals.length ? 'refused' : 'completed',
    requestedBy,
    contentEffects: plan.contentEffects,
    workloadRestore: plan,
  });
}

async function record(client, { tenantRef, artifactId, actor, result }) {
  await appendEvidence(client, {
    tenantRef,
    kind: SHAREPOINT_RESTORE_EVIDENCE_KIND,
    subject: { artifactId, operationId: SHAREPOINT_WRITE_OPERATION, outcome: result.outcome, writes: result.writes, verified: result.verified ?? [], reasons: result.reasons },
    actor,
  });
  return result;
}

/**
 * Promotes one approved artifact. `qualification` is
 * workloadWriteQualification(SHAREPOINT_WRITE_OPERATION, ...). `transport(url, init?)`
 * answers { status, headers, body }; init carries { method, body } for the write.
 * Outcomes: disabled, refused, stale, blocked-content-effect, no-change, failed,
 * verification-failed, verified. Only the last two follow a write.
 */
export async function executeSharePointRestore(client, {
  tenantRef, artifactId, tenantHost, transport, qualification, actor = null, sleep,
}) {
  const requests = [];
  const counted = async (url, init) => { requests.push({ url, method: init?.method ?? 'GET' }); return transport(url, init); };
  const artifact = await getDryRunArtifact(client, { id: artifactId, tenantRef });
  // The run acts for whoever requested the restore unless a caller names someone.
  const done = (result) => record(client, {
    tenantRef, artifactId, actor: actor ?? artifact?.requestedBy ?? 'keel', result: { writes: 0, ...result, requests },
  });

  const plan = artifact?.workloadRestore ?? null;
  if (!plan || plan.operationId !== SHAREPOINT_WRITE_OPERATION) {
    return done({ outcome: 'refused', reasons: ['no SharePoint restore plan with this id'] });
  }
  const promotable = validateArtifactForApproval(artifact);
  if (!promotable.ok) return done({ outcome: 'refused', reasons: [promotable.reason] });
  if (workloadPlanDigest(plan) !== plan.digest || artifact.digest !== plan.digest
      || !same(artifact.contentEffects ?? [], plan.contentEffects)) {
    return done({ outcome: 'refused', reasons: ['the stored plan no longer matches its digest; a new dry run is required'] });
  }
  if (plan.tenantHost !== tenantHost) {
    return done({ outcome: 'refused', reasons: [`the plan targets ${plan.tenantHost}, not ${tenantHost}`] });
  }
  // Qualification first: an unqualified write sends nothing at all.
  if (qualification?.operationId !== SHAREPOINT_WRITE_OPERATION || qualification.enabled !== true) {
    return done({ outcome: 'disabled', reasons: [...(qualification?.reasons ?? ['no write qualification was supplied'])] });
  }
  if (plan.operations.length === 0) return done({ outcome: 'no-change', reasons: ['the live settings already match the source'] });
  try {
    await assertContentEffectApproval(client, { artifact, effects: plan.contentEffects });
  } catch (error) {
    return done({ outcome: 'blocked-content-effect', reasons: [error.message] });
  }

  let live;
  try {
    live = await readLiveSettings({ transport: counted, sleep });
  } catch (error) {
    return done({ outcome: 'failed', reasons: [`could not re-read the settings before writing: ${error.message}`] });
  }
  if (liveSettingsFingerprint(live) !== plan.liveFingerprint) {
    return done({ outcome: 'stale', reasons: ['the SharePoint settings changed since the dry run; a new dry run is required'] });
  }

  const [operation] = plan.operations;
  const url = `${GRAPH}/${write.version}${write.endpoint}`;
  const response = await counted(url, { method: write.method, body: operation.body });
  if (response.status < 200 || response.status >= 300) {
    const locked = isPreservationLockFailure(response);
    return done({
      outcome: locked ? 'refused' : 'failed',
      writes: 1,
      reasons: [locked
        ? 'the platform refused the change under a preservation lock; KEEL does not retry or work around it'
        : `the write failed with HTTP ${response.status}; nothing is retried automatically`],
    });
  }

  let after;
  try {
    after = await readLiveSettings({ transport: counted, sleep });
  } catch (error) {
    return done({ outcome: 'verification-failed', writes: 1, reasons: [`the write was sent but could not be read back: ${error.message}`] });
  }
  const verified = [];
  const mismatched = [];
  for (const { field, after: expected } of operation.changes) {
    (same(after?.[field], expected) ? verified : mismatched).push(field);
  }
  return done({
    outcome: mismatched.length ? 'verification-failed' : 'verified',
    writes: 1,
    verified,
    reasons: mismatched.map((field) => `${field} did not read back as written`),
  });
}
