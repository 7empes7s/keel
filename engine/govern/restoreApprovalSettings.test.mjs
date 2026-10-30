import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import {
  RESTORE_APPROVAL_SERVICES,
  RESTORE_APPROVAL_SETTING_EVIDENCE_KIND,
  RestoreApprovalSettingError,
  effectsNeedApproval,
  getRestoreApprovalSettings,
  serviceForResourceType,
  setRestoreApprovalSetting,
} from './restoreApprovalSettings.mjs';
import { grantRole } from '../authz/administration.mjs';
import { createDryRunArtifact } from '../restore/dryRunArtifact.mjs';
import {
  ContentEffectApprovalError,
  assertContentEffectApproval,
  classifyContentEffects,
  dryRunsAwaitingContentEffectApproval,
  loadContentEffectReview,
} from '../safety/contentEffects.mjs';
import { CONTENT_EFFECT_RULES } from '../safety/contentEffects.mjs';
import { WORKLOAD_EFFECT_RULES } from '../restore/workloads/cmdletSettings.mjs';
import { createSnapshot } from '../store/db.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

// Restore approvals as a customer setting: on for every service until someone turns it
// off, every change in the audit record, and the content-effect gate follows it.
const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const TENANT = 'sha256:restore-approvals';
const OTHER_TENANT = 'sha256:restore-approvals-other';

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(schemaSql());
    schemaReady = true;
  }
  return client;
}

async function principal(client, role) {
  const { rows } = await client.query('INSERT INTO principal (email) VALUES ($1) RETURNING id', [`${randomUUID()}@contoso.example`]);
  if (role) await grantRole(client, { principalId: rows[0].id, role, grantedBy: rows[0].id });
  return rows[0].id;
}

const update = (resourceType, before, after, naturalKey) => ({
  naturalKey, resourceType, verb: 'update', payload: after, live: { state: 'present', payload: before, targetId: 'id-1' },
});

// A Purview label kept for less time, and a SharePoint tenant shared more widely.
const purviewEffects = () => classifyContentEffects([
  update('retentionLabel', { retentionDuration: { days: 2555 } }, { retentionDuration: { days: 30 } }, 'retentionLabel:KEEL-RT-Finance'),
]).effects;
const sharepointEffects = () => classifyContentEffects([
  update('sharepointTenantSettings', { sharingCapability: 'disabled' }, { sharingCapability: 'externalUserAndGuestSharing' }, 'sharepointTenantSettings:tenant'),
]).effects;

async function artifactWithEffects(client, { tenantRef = TENANT, requestedBy, effects }) {
  const snapshotId = await createSnapshot(client, { tenantRef });
  return createDryRunArtifact(client, {
    id: randomUUID(), tenantRef, snapshotId, selection: ['x'], closureKeys: ['x'], targetTenantId: 't',
    collectorConfigPath: 'c', targetConfigPath: 'r', waves: [], patches: [], results: {},
    currentStateFingerprint: 'f', digest: 'd', status: 'completed', requestedBy, contentEffects: effects,
  });
}

test('restored kinds land in their service; a kind Keel cannot place has none', () => {
  assert.equal(serviceForResourceType('retentionLabel'), 'Purview');
  assert.equal(serviceForResourceType('sharepointTenantSettings'), 'SharePoint');
  assert.equal(serviceForResourceType('exchangeTransportRule'), 'Exchange');
  assert.equal(serviceForResourceType('groupLifecyclePolicy'), 'Entra');
  assert.equal(serviceForResourceType('deviceManagementScript'), 'Intune');
  assert.equal(serviceForResourceType(undefined), null);
  // Every effect sample is placed, so none falls back to "always needs approval" by accident.
  for (const effect of [...purviewEffects(), ...sharepointEffects()]) assert.ok(serviceForResourceType(effect.resourceType));
});

test('every kind with a high-impact rule lands in the service its name says, so a setting never lifts the wrong service', () => {
  const expected = (type) => (/^exchange/.test(type) ? 'Exchange'
    : /^teams/.test(type) ? 'Teams'
      : /^(purview|retentionLabel$|ediscovery)/.test(type) ? 'Purview'
        : /^sharepoint/.test(type) ? 'SharePoint'
          : /^(device|configurationPolicy$|windowsManagedAppProtection$|managedAppPolicy$|mobileApp)/.test(type) ? 'Intune'
            : 'Entra');
  const types = [...Object.keys(CONTENT_EFFECT_RULES), ...Object.keys(WORKLOAD_EFFECT_RULES)];
  assert.ok(types.length > 40);
  for (const type of types) assert.equal(serviceForResourceType(type), expected(type), type);
});

test('approvals are on for every service until someone turns one off; each change is in the audit record', async (t) => {
  const client = await schemaClient(t);
  const admin = await principal(client, 'admin');
  const defaults = await getRestoreApprovalSettings(client, { tenantRef: TENANT });
  assert.deepEqual(defaults.map((entry) => entry.service), [...RESTORE_APPROVAL_SERVICES]);
  assert.ok(defaults.every((entry) => entry.approvalRequired === true && entry.updatedBy === null));

  await assert.rejects(setRestoreApprovalSetting(client, { tenantRef: TENANT, service: 'Yammer', approvalRequired: false, actor: admin }), RestoreApprovalSettingError);
  await assert.rejects(setRestoreApprovalSetting(client, { tenantRef: TENANT, service: 'Purview', approvalRequired: 'no', actor: admin }), RestoreApprovalSettingError);
  await assert.rejects(setRestoreApprovalSetting(client, { tenantRef: TENANT, service: 'Purview', approvalRequired: false, actor: '' }), RestoreApprovalSettingError);

  const off = await setRestoreApprovalSetting(client, { tenantRef: TENANT, service: 'Purview', approvalRequired: false, actor: admin });
  assert.equal(off.changed, true);
  assert.equal(off.setting.approvalRequired, false);
  assert.equal(off.setting.updatedBy, admin);
  // The same value again changes nothing and writes no second record.
  assert.equal((await setRestoreApprovalSetting(client, { tenantRef: TENANT, service: 'Purview', approvalRequired: false, actor: admin })).changed, false);

  const after = await getRestoreApprovalSettings(client, { tenantRef: TENANT });
  assert.deepEqual(after.filter((entry) => !entry.approvalRequired).map((entry) => entry.service), ['Purview']);
  // Another tenant keeps its own default.
  assert.ok((await getRestoreApprovalSettings(client, { tenantRef: OTHER_TENANT })).every((entry) => entry.approvalRequired));

  const { rows } = await client.query('SELECT actor, subject FROM evidence WHERE kind = $1 ORDER BY seq', [RESTORE_APPROVAL_SETTING_EVIDENCE_KIND]);
  assert.deepEqual(rows.map((row) => [row.actor, row.subject.service, row.subject.approvalRequired, row.subject.previous]), [[admin, 'Purview', false, true]]);

  assert.equal((await setRestoreApprovalSetting(client, { tenantRef: TENANT, service: 'Purview', approvalRequired: true, actor: admin })).changed, true);
});

test('effects need approval unless every service they touch has it off; an unplaced effect or no tenant always needs it', async (t) => {
  const client = await schemaClient(t);
  const admin = await principal(client, 'admin');
  const tenantRef = `sha256:${randomUUID()}`;
  const mixed = [...purviewEffects(), ...sharepointEffects()];
  assert.deepEqual(await effectsNeedApproval(client, { tenantRef, effects: [] }), { required: false, services: [], waived: [] });
  assert.equal((await effectsNeedApproval(client, { tenantRef, effects: mixed })).required, true);

  await setRestoreApprovalSetting(client, { tenantRef, service: 'Purview', approvalRequired: false, actor: admin });
  assert.equal((await effectsNeedApproval(client, { tenantRef, effects: purviewEffects() })).required, false);
  // One service still on keeps the whole set waiting.
  assert.deepEqual(await effectsNeedApproval(client, { tenantRef, effects: mixed }), { required: true, services: ['Purview', 'SharePoint'], waived: ['Purview'] });

  await setRestoreApprovalSetting(client, { tenantRef, service: 'SharePoint', approvalRequired: false, actor: admin });
  assert.equal((await effectsNeedApproval(client, { tenantRef, effects: mixed })).required, false);
  assert.equal((await effectsNeedApproval(client, { tenantRef, effects: [...mixed, { resourceType: 'somethingKeelNeverMapped' }] })).required, true);
  assert.equal((await effectsNeedApproval(client, { tenantRef: undefined, effects: mixed })).required, true);
});

test('the content-effect gate follows the setting: off lets the restore make them, on blocks until someone approves', async (t) => {
  const client = await schemaClient(t);
  const admin = await principal(client, 'admin');
  const requester = await principal(client, 'restorer');
  const tenantRef = `sha256:${randomUUID()}`;
  const effects = purviewEffects();
  const artifact = await artifactWithEffects(client, { tenantRef, requestedBy: requester, effects });

  await assert.rejects(assertContentEffectApproval(client, { artifact, effects }), ContentEffectApprovalError);
  assert.deepEqual([...await dryRunsAwaitingContentEffectApproval(client, { tenantRef, artifactIds: [artifact.id] })], [artifact.id]);
  const waiting = await loadContentEffectReview(client, { tenantRef, artifactId: artifact.id });
  assert.equal(waiting.approvalRequired, true);
  assert.deepEqual(waiting.approvalWaivedFor, []);

  await setRestoreApprovalSetting(client, { tenantRef, service: 'Purview', approvalRequired: false, actor: admin });
  const cleared = await assertContentEffectApproval(client, { artifact, effects });
  assert.equal(cleared.notRequired, true, 'a truthy record, so the restore treats the effects as cleared');
  assert.deepEqual(cleared.services, ['Purview']);
  assert.deepEqual([...await dryRunsAwaitingContentEffectApproval(client, { tenantRef, artifactIds: [artifact.id] })], []);
  const review = await loadContentEffectReview(client, { tenantRef, artifactId: artifact.id });
  assert.equal(review.approvalRequired, false);
  assert.deepEqual(review.approvalWaivedFor, ['Purview']);

  // Mutation check: turning it back on blocks the same restore again.
  await setRestoreApprovalSetting(client, { tenantRef, service: 'Purview', approvalRequired: true, actor: admin });
  await assert.rejects(assertContentEffectApproval(client, { artifact, effects }), /blocked-content-effect/);

  // A dry run without a tenant (an old caller) is never waved through.
  await setRestoreApprovalSetting(client, { tenantRef, service: 'Purview', approvalRequired: false, actor: admin });
  await assert.rejects(assertContentEffectApproval(client, { artifact: { id: artifact.id, requestedBy: requester }, effects }), ContentEffectApprovalError);
});
