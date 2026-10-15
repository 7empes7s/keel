/**
 * Gap 5 (site permissions audit, 2026-10-15): restore a SharePoint site's app
 * grants (Sites.Selected permissions) from a recorded sharepoint-site-settings
 * collection, through Graph site permissions.
 *
 * One plan covers one site. Per application in the backup:
 *  - missing now: re-created (POST /sites/{id}/permissions) with the backup's role;
 *  - present with a narrower role: raised to the backup's role (PATCH);
 *  - present with the same role: nothing;
 *  - present with a wider role, more than one grant for it, an unknown role or no
 *    application: manual. KEEL never narrows or removes a grant on its own.
 * A grant on the site now that the backup does not have is listed as manual too.
 *
 * Rules, the same as the other workload restores (sharepoint.mjs):
 *  - Never wider than the backup. Every body names exactly the backup's
 *    applications and at most the backup's role; execute re-checks this.
 *  - Immutable plan, persisted as a restore_dry_run artifact; the two-person
 *    approval and promotion checks are the existing ones.
 *  - Disabled until qualified. Nothing is sent unless every write the plan uses is
 *    live-qualified and enabled (coverage/qualification.mjs).
 *  - Exact approval. Granting an app access to content is a content effect, so it
 *    needs the separate content-effect approval of exactly those effects.
 *  - No overwrite. The site's grants are re-read before writing; if they changed
 *    since the plan, nothing is written and a new dry run is required.
 *  - Verified. After writing, the grants are read back and each write is checked.
 *  - Idempotent. Once restored, a new dry run plans nothing, and the same artifact
 *    run again is stale and writes nothing.
 */
import { createHash, randomUUID } from 'node:crypto';

import { SITE_FIELDS } from '../../collect/workloads/sharepoint.mjs';
import { WORKLOAD_DESCRIPTORS, readGraphConfiguration } from '../../collect/workloadContract.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../../coverage/qualification.mjs';
import { appendEvidence } from '../../govern/evidence.mjs';
import {
  assertContentEffectApproval, classifyContentEffects, isPreservationLockFailure, siteRoleAt, siteRoleRank,
} from '../../safety/contentEffects.mjs';
import { createDryRunArtifact, getDryRunArtifact, validateArtifactForApproval } from '../dryRunArtifact.mjs';
import { loadSharePointSource } from './sharepoint.mjs';

export const SITE_GRANTS_RESTORE = 'sharepoint-site-grants';
export const SITE_GRANT_ADD = 'sharepoint.site-permissions.add';
export const SITE_GRANT_UPDATE = 'sharepoint.site-permissions.update';
export const SITE_GRANT_WRITE_OPERATIONS = Object.freeze([SITE_GRANT_ADD, SITE_GRANT_UPDATE]);
export const SITE_GRANTS_RESTORE_EVIDENCE_KIND = 'workload-restore';
const RESOURCE_TYPE = 'sharepointSiteAppGrant';
const CONFIG_PATH = `workload:${SITE_GRANTS_RESTORE}`;
const GRAPH = 'https://graph.microsoft.com';
const readBack = WORKLOAD_DESCRIPTORS.find((descriptor) => descriptor.id === 'sharepoint.site-permissions');
const normalise = SITE_FIELDS.appPermissionGrants[1];
for (const id of SITE_GRANT_WRITE_OPERATIONS) {
  if (WORKLOAD_WRITE_OPERATIONS[id]?.readBack !== readBack.id) throw new Error(`${id} must be a declared write read back through ${readBack.id}`);
}

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

/** The applications a grant names, as one key ("" when it names none). */
export const grantAppKey = (grant) => (grant.applications ?? []).map((application) => String(application.id ?? '').toLowerCase()).sort().join(',');

/** The live grants as KEEL compares them (the collector's own normal form). */
export function liveGrantsFingerprint(grants) {
  return sha256(grants);
}

export function siteGrantsPlanDigest(plan) {
  const { digest, ...rest } = plan;
  return sha256(rest);
}

function naturalKey(siteId, appKey) {
  return `sharepoint:site-app-grant:${siteId}:${appKey}`;
}

/**
 * True when a planned write grants no more than its backup grant: exactly the
 * backup's applications, at most the backup's role.
 */
export function withinBackup(operation) {
  const { backup } = operation;
  const rank = siteRoleRank(operation.body.roles);
  if (rank < 0 || rank > siteRoleRank(backup.roles) || operation.body.roles.length !== 1) return false;
  if (operation.operationId === SITE_GRANT_UPDATE) return Object.keys(operation.body).join() === 'roles';
  const identities = operation.body.grantedToIdentities ?? [];
  const shaped = identities.every((identity) => Object.keys(identity ?? {}).join() === 'application'
    && Object.keys(identity.application ?? {}).every((key) => key === 'id' || key === 'displayName'));
  const named = identities.map((identity) => ({ id: identity?.application?.id ?? null }));
  return Object.keys(operation.body).sort().join() === 'grantedToIdentities,roles' && shaped
    && named.length === backup.applications.length && grantAppKey({ applications: named }) === grantAppKey(backup);
}

/**
 * Builds the frozen plan for one site. `source` is a recorded sharepoint-site-settings
 * collection (loadSharePointSource); `live` is the site's grants read now, in the
 * collector's normal form (readLiveSiteGrants).
 */
export function planSiteGrantsRestore({ source, live, tenantHost, siteId }) {
  if (!source?.collectionId) throw new TypeError('a site grant restore needs a recorded source collection');
  if (typeof tenantHost !== 'string' || source.tenantHost !== tenantHost) {
    throw new Error('the source collection was taken from a different SharePoint tenant');
  }
  if (!['complete', 'complete-empty', 'partial'].includes(source.outcome)) {
    throw new Error(`a ${source.outcome} collection is not a restore source`);
  }
  if (typeof siteId !== 'string' || siteId.split(',')[0].toLowerCase() !== tenantHost.toLowerCase()) {
    throw new Error('the site is not on this SharePoint tenant');
  }
  const resourceKey = `site:${siteId}`;
  const site = (source.observations ?? []).find((entry) => entry.resourceKey === resourceKey);
  if (!site) throw new Error('the source collection has no such site');
  const coverage = site.fieldCoverage?.appPermissionGrants?.status ?? 'unknown';
  const manual = [];
  const operations = [];
  if (coverage !== 'observed') {
    manual.push({ resourceKey, application: null, reason: `${coverage} in the source collection, so there is no grant to restore` });
  }
  const backups = coverage === 'observed' ? site.fields?.appPermissionGrants ?? [] : [];
  const liveByApp = new Map();
  for (const grant of live) liveByApp.set(grantAppKey(grant), [...(liveByApp.get(grantAppKey(grant)) ?? []), grant]);
  const backupKeys = new Set();

  for (const backup of backups) {
    const appKey = grantAppKey(backup);
    const label = (backup.applications ?? []).map((application) => application.displayName ?? application.id).join(', ') || null;
    const note = (reason) => manual.push({ resourceKey, application: label, reason });
    if (!appKey || (backup.applications ?? []).some((application) => !application.id)) { note('the grant names no application KEEL can re-grant'); continue; }
    if (backupKeys.has(appKey)) { note('the backup holds more than one grant for this application; a person re-grants it'); continue; }
    backupKeys.add(appKey);
    const rank = siteRoleRank(backup.roles);
    if (rank < 0) { note(`the backup role ${JSON.stringify(backup.roles)} is not one KEEL writes`); continue; }
    const current = liveByApp.get(appKey) ?? [];
    if (current.length > 1) { note('the site now holds more than one grant for this application; a person decides'); continue; }
    const target = { roles: [siteRoleAt(rank)] };
    const base = {
      resourceKey, naturalKey: naturalKey(siteId, appKey), application: label,
      backup: { id: backup.id ?? null, roles: [...backup.roles], applications: backup.applications.map(({ id, displayName }) => ({ id, displayName: displayName ?? null })) },
    };
    if (current.length === 0) {
      operations.push({
        ...base, operationId: SITE_GRANT_ADD, verb: 'create', before: null,
        body: { ...target, grantedToIdentities: backup.applications.map(({ id, displayName }) => ({ application: displayName ? { id, displayName } : { id } })) },
      });
      continue;
    }
    const [now] = current;
    const liveRank = siteRoleRank(now.roles);
    if (liveRank < 0) { note(`the site now holds role ${JSON.stringify(now.roles)}, which KEEL does not compare`); continue; }
    if (liveRank === rank) continue;
    if (liveRank > rank) { note('the grant is wider now than in the backup; KEEL never narrows a grant, a person decides'); continue; }
    if (!now.id) { note('the grant on the site has no id to update'); continue; }
    operations.push({ ...base, operationId: SITE_GRANT_UPDATE, verb: 'update', permissionId: now.id, before: { roles: [...now.roles] }, body: target });
  }
  for (const [appKey, grants] of liveByApp) {
    if (coverage !== 'observed' || backupKeys.has(appKey)) continue;
    const label = grants[0].applications.map((application) => application.displayName ?? application.id).join(', ') || null;
    manual.push({ resourceKey, application: label, reason: 'the site holds a grant the backup does not; KEEL never removes a grant' });
  }
  for (const operation of operations) {
    if (!withinBackup(operation)) throw new Error(`refusing a grant wider than the backup for ${operation.naturalKey}`);
  }

  const { effects, refusals } = classifyContentEffects(operations.map((operation) => ({
    naturalKey: operation.naturalKey,
    resourceType: RESOURCE_TYPE,
    verb: operation.verb,
    payload: { roles: operation.body.roles },
    live: operation.before ? { state: 'present', payload: operation.before } : { state: 'absent' },
  })));

  const plan = {
    workload: SITE_GRANTS_RESTORE,
    tenantHost,
    siteId,
    source: { collectionId: source.collectionId, observedTo: source.observedTo ?? null, outcome: source.outcome },
    operations,
    manual,
    excluded: [],
    contentEffects: effects,
    refusals,
    liveFingerprint: liveGrantsFingerprint(live),
  };
  plan.digest = siteGrantsPlanDigest(plan);
  return deepFreeze(plan);
}

/** Reads one site's grants now, in the collector's normal form. */
export async function readLiveSiteGrants({ transport, siteId, sleep }) {
  const { items } = await readGraphConfiguration(readBack, { transport, sleep, substitute: { 'site-id': siteId } });
  return normalise(items);
}

/** Persists the plan as an immutable dry-run artifact. */
export async function createSiteGrantsRestoreArtifact(client, { tenantRef, plan, requestedBy, id = randomUUID() }) {
  const keys = plan.operations.map((operation) => operation.naturalKey);
  return createDryRunArtifact(client, {
    id,
    tenantRef,
    snapshotId: null,
    selection: keys.length ? keys : [`site:${plan.siteId}`],
    closureKeys: keys.length ? keys : [`site:${plan.siteId}`],
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

/**
 * Promotes one approved artifact. `qualifications` maps each write operation id to
 * workloadWriteQualification(id, ...). `transport(url, init?)` answers
 * { status, headers, body }. Outcomes: disabled, refused, stale,
 * blocked-content-effect, no-change, failed, verification-failed, verified.
 */
export async function executeSiteGrantsRestore(client, {
  tenantRef, artifactId, tenantHost, transport, qualifications = {}, actor = null, sleep,
}) {
  const requests = [];
  const counted = async (url, init) => { requests.push({ url, method: init?.method ?? 'GET' }); return transport(url, init); };
  const artifact = await getDryRunArtifact(client, { id: artifactId, tenantRef });
  const done = async (result) => {
    const full = { writes: 0, verified: [], ...result, requests };
    await appendEvidence(client, {
      tenantRef,
      kind: SITE_GRANTS_RESTORE_EVIDENCE_KIND,
      subject: { artifactId, workload: SITE_GRANTS_RESTORE, outcome: full.outcome, writes: full.writes, verified: full.verified, reasons: full.reasons },
      actor: actor ?? artifact?.requestedBy ?? 'keel',
    });
    return full;
  };

  const plan = artifact?.workloadRestore ?? null;
  if (!plan || plan.workload !== SITE_GRANTS_RESTORE) return done({ outcome: 'refused', reasons: ['no site grant restore plan with this id'] });
  const promotable = validateArtifactForApproval(artifact);
  if (!promotable.ok) return done({ outcome: 'refused', reasons: [promotable.reason] });
  if (siteGrantsPlanDigest(plan) !== plan.digest || artifact.digest !== plan.digest
      || !same(artifact.contentEffects ?? [], plan.contentEffects)) {
    return done({ outcome: 'refused', reasons: ['the stored plan no longer matches its digest; a new dry run is required'] });
  }
  if (plan.tenantHost !== tenantHost) return done({ outcome: 'refused', reasons: [`the plan targets ${plan.tenantHost}, not ${tenantHost}`] });
  const wider = plan.operations.filter((operation) => !SITE_GRANT_WRITE_OPERATIONS.includes(operation.operationId) || !withinBackup(operation));
  if (wider.length) return done({ outcome: 'refused', reasons: wider.map((operation) => `${operation.naturalKey}: wider than the backup`) });
  if (plan.operations.length === 0) return done({ outcome: 'no-change', reasons: ['the site grants already match the backup'] });
  // Qualification first: if any write the plan uses is not qualified, nothing is sent.
  const off = [...new Set(plan.operations.map((operation) => operation.operationId))]
    .filter((id) => qualifications[id]?.operationId !== id || qualifications[id].enabled !== true);
  if (off.length) {
    return done({ outcome: 'disabled', reasons: off.flatMap((id) => (qualifications[id]?.reasons?.length ? qualifications[id].reasons.map((reason) => `${id}: ${reason}`) : [`${id}: no write qualification was supplied`])) });
  }
  try {
    await assertContentEffectApproval(client, { artifact, effects: plan.contentEffects });
  } catch (error) {
    return done({ outcome: 'blocked-content-effect', reasons: [error.message] });
  }

  let live;
  try {
    live = await readLiveSiteGrants({ transport: counted, siteId: plan.siteId, sleep });
  } catch (error) {
    return done({ outcome: 'failed', reasons: [`could not re-read the site grants before writing: ${error.message}`] });
  }
  if (liveGrantsFingerprint(live) !== plan.liveFingerprint) {
    return done({ outcome: 'stale', reasons: ['the site grants changed since the dry run; a new dry run is required'] });
  }
  // The stored plan must be exactly what the recorded backup and these grants give:
  // an edited plan (another app, a wider role) never reaches Graph, even with a
  // recomputed digest and its approved content effects left as they were.
  let source;
  try {
    source = await loadSharePointSource(client, { tenantRef, collectionId: plan.source.collectionId });
  } catch (error) {
    return done({ outcome: 'failed', reasons: [`could not re-load the source collection: ${error.message}`] });
  }
  let replanned = null;
  try {
    replanned = source ? planSiteGrantsRestore({ source, live, tenantHost: plan.tenantHost, siteId: plan.siteId }) : null;
  } catch { replanned = null; }
  if (replanned?.digest !== plan.digest) {
    return done({ outcome: 'refused', reasons: ['the stored plan is not what the recorded backup gives; a new dry run is required'] });
  }

  let writes = 0;
  for (const operation of plan.operations) {
    const declared = WORKLOAD_WRITE_OPERATIONS[operation.operationId];
    const path = declared.endpoint
      .replace('{site-id}', encodeURIComponent(plan.siteId))
      .replace('{permission-id}', encodeURIComponent(operation.permissionId ?? ''));
    const response = await counted(`${GRAPH}/${declared.version}${path}`, { method: declared.method, body: operation.body });
    writes += 1;
    if (response.status < 200 || response.status >= 300) {
      const locked = isPreservationLockFailure(response);
      return done({
        outcome: locked ? 'refused' : 'failed',
        writes,
        reasons: [locked
          ? `${operation.naturalKey}: the platform refused the change under a preservation lock; KEEL does not retry or work around it`
          : `${operation.naturalKey}: the write failed with HTTP ${response.status}; nothing is retried automatically`],
      });
    }
  }

  let after;
  try {
    after = await readLiveSiteGrants({ transport: counted, siteId: plan.siteId, sleep });
  } catch (error) {
    return done({ outcome: 'verification-failed', writes, reasons: [`the grants were written but could not be read back: ${error.message}`] });
  }
  const verified = [];
  const reasons = [];
  for (const operation of plan.operations) {
    const found = after.filter((grant) => grantAppKey(grant) === grantAppKey(operation.backup));
    const ok = found.length === 1 && siteRoleRank(found[0].roles) === siteRoleRank(operation.body.roles);
    if (ok) verified.push(operation.naturalKey);
    else reasons.push(`${operation.naturalKey} did not read back as written`);
  }
  return done({ outcome: reasons.length ? 'verification-failed' : 'verified', writes, verified, reasons });
}
