// Roadmap task-103: qualified SharePoint configuration restore.
//
// Acceptance:
//  - a fixture setting restore re-reads and verifies;
//  - high-impact sharing changes need exact approval;
//  - an unqualified operation does zero writes;
//  - a later concurrent settings update invalidates promotion.
// Mutation checks:
//  - enable the write solely on a fixture pass;
//  - bypass content-effect approval;
//  - overwrite concurrent site configuration.
//
// Everything runs against the isolated test database and an in-memory fake Graph.
// No tenant is read or written.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { grantRole } from '../authz/administration.mjs';
import { recordSharePointRun } from '../collect/workloads/sharepoint.mjs';
import { WORKLOAD_WRITE_OPERATIONS, buildOperationLedger, workloadWriteQualification } from '../coverage/qualification.mjs';
import { planDeletionWaves, planWaves } from '../restore/wavePlanner.mjs';
import {
  SHAREPOINT_RESTORE_EVIDENCE_KIND, SHAREPOINT_WRITE_OPERATION, createSharePointRestoreArtifact, executeSharePointRestore,
  loadSharePointSource, planSharePointRestore,
} from '../restore/workloads/sharepoint.mjs';
import { ContentEffectApprovalError, approveContentEffects, contentEffectsDigest } from '../safety/contentEffects.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
    schemaReady = true;
  }
  return client;
}

const HOST = 'contoso.sharepoint.com';
const NOW = new Date('2026-10-03T12:00:00Z');
const SETTINGS_URL = 'https://graph.microsoft.com/v1.0/admin/sharepoint/settings';
const SITE = 'contoso.sharepoint.com,00000001-0000-4000-8000-000000000001,00000101-0000-4000-8000-000000000101';

// The source: what the tenant looked like when it was collected.
const SOURCE_SETTINGS = {
  sharingCapability: 'externalUserSharingOnly', sharingDomainRestrictionMode: 'allowList',
  sharingAllowedDomainList: ['fabrikam.com'], sharingBlockedDomainList: [], isResharingByExternalUsersEnabled: false,
};

let tenantSeq = 0;
const nextTenant = () => `sha256:task-103-${tenantSeq += 1}`;

let principalSeq = 0;
async function principal(client, label, role) {
  const email = `${label.replace(/[^a-z0-9-]/gi, '')}-${principalSeq += 1}@example.test`;
  const { rows } = await client.query(`INSERT INTO principal (email) VALUES ($1) RETURNING id`, [email]);
  if (role) await grantRole(client, { principalId: rows[0].id, role, grantedBy: rows[0].id, activeFrom: new Date(Date.now() - 60_000) });
  return rows[0].id;
}

async function recordSource(client, tenantRef, { settings = SOURCE_SETTINGS, coverage = {} } = {}) {
  const fieldCoverage = Object.fromEntries(Object.keys(settings).map((field) => [field, { status: coverage[field] ?? 'observed', operation: 'sharepoint.tenant-settings' }]));
  const run = await recordSharePointRun(client, {
    tenantRef,
    result: {
      workload: 'sharepoint-site-settings', tenantHost: HOST, outcome: 'complete',
      observedFrom: '2026-10-01T00:00:00Z', observedTo: '2026-10-01T00:01:00Z',
      tenant: { fields: settings, fieldCoverage },
      sites: [{
        siteId: SITE,
        fields: { displayName: 'Finance', name: 'finance', webUrl: `https://${HOST}/sites/finance`, createdDateTime: '2025-01-01T00:00:00Z', lastModifiedDateTime: '2026-09-01T00:00:00Z', hostname: HOST, appPermissionGrants: [] },
        fieldCoverage: Object.fromEntries(['displayName', 'name', 'webUrl', 'createdDateTime', 'lastModifiedDateTime', 'hostname', 'appPermissionGrants']
          .map((field) => [field, { status: 'observed', operation: 'sharepoint.site-properties' }])),
      }],
    },
  });
  return loadSharePointSource(client, { tenantRef, collectionId: run.id });
}

/** An in-memory /admin/sharepoint/settings. `onPatch` can refuse a write. */
function fakeSharePoint(initial, { onPatch } = {}) {
  const state = { settings: { '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#admin/sharepoint/settings', ...structuredClone(initial) } };
  const requests = [];
  async function transport(url, init) {
    const method = init?.method ?? 'GET';
    requests.push({ url, method, body: init?.body ?? null });
    if (url !== SETTINGS_URL) return { status: 404, headers: {}, body: { error: { code: 'itemNotFound' } } };
    if (method === 'GET') return { status: 200, headers: {}, body: structuredClone(state.settings) };
    if (method === 'PATCH') {
      const refused = onPatch?.(init.body);
      if (refused) return refused;
      Object.assign(state.settings, structuredClone(init.body));
      return { status: 200, headers: {}, body: structuredClone(state.settings) };
    }
    return { status: 405, headers: {}, body: null };
  }
  return { state, requests, transport, writes: () => requests.filter((request) => request.method !== 'GET') };
}

const readLedger = (tenantRef, enabled = true) => ({
  tenantRef,
  rows: [{ id: 'sharepoint.tenant-settings', state: enabled ? 'live-qualified' : 'fixture-tested', enabled }],
});
const liveWrite = (tenantRef, extra = {}) => ({
  operationId: SHAREPOINT_WRITE_OPERATION, kind: 'live-write-capture', synthetic: false, tenantRef,
  capturedAt: '2026-10-02T00:00:00Z', version: 'v1.0', ok: true, readBackVerified: true, proofRef: 'capture.json@sha256:x', ...extra,
});
const qualified = (tenantRef) => workloadWriteQualification(SHAREPOINT_WRITE_OPERATION, {
  readLedger: readLedger(tenantRef), evidence: [liveWrite(tenantRef)], tenantRef, now: NOW,
});

async function planned(client, tenantRef, live, { requester } = {}) {
  const source = await recordSource(client, tenantRef);
  const plan = planSharePointRestore({ source, live, tenantHost: HOST });
  const requestedBy = requester ?? await principal(client, `${tenantRef}-requester`, 'restorer');
  const artifact = await createSharePointRestoreArtifact(client, { tenantRef, plan, requestedBy });
  return { plan, artifact, requestedBy };
}

// ------------------------------------------------------------------- the plan

test('the plan writes only the supported tenant fields; site settings stay manual and server-owned fields are excluded', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const source = await recordSource(client, tenantRef, { coverage: { sharingBlockedDomainList: 'denied' } });
  const live = { ...SOURCE_SETTINGS, sharingCapability: 'externalUserAndGuestSharing', sharingBlockedDomainList: ['contoso-rival.com'], deletedUserPersonalSiteRetentionPeriodInDays: 30 };
  const plan = planSharePointRestore({ source, live, tenantHost: HOST });

  assert.equal(plan.operations.length, 1);
  assert.deepEqual(plan.operations[0].body, { sharingCapability: 'externalUserSharingOnly' });
  assert.deepEqual(Object.keys(plan.operations[0].body).filter((field) => !WORKLOAD_WRITE_OPERATIONS[SHAREPOINT_WRITE_OPERATION].fields.includes(field)), []);
  // A field the source could not read is not restored from a guess.
  assert.ok(plan.manual.some((item) => item.field === 'sharingBlockedDomainList' && /denied in the source/.test(item.reason)));
  assert.equal('sharingBlockedDomainList' in plan.operations[0].body, false);
  // Sites: properties and app grants are manual; ids, URLs and timestamps are never written.
  const siteKey = `site:${SITE}`;
  assert.deepEqual(plan.manual.filter((item) => item.resourceKey === siteKey && ['displayName', 'name', 'appPermissionGrants'].includes(item.field)).map((item) => item.field).sort(), ['appPermissionGrants', 'displayName', 'name']);
  assert.ok(plan.manual.some((item) => item.resourceKey === siteKey && item.field === 'sharingCapability'));
  assert.deepEqual(plan.excluded.filter((item) => item.reason === 'server-owned').map((item) => item.field).sort(), ['createdDateTime', 'hostname', 'lastModifiedDateTime', 'webUrl']);
  // Narrowing sharing has no content effect.
  assert.deepEqual(plan.contentEffects, []);
  // Immutable.
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.operations[0].body));
  assert.throws(() => { plan.operations[0].body.sharingCapability = 'disabled'; }, TypeError);
  // A source from another SharePoint tenant is refused.
  assert.throws(() => planSharePointRestore({ source, live, tenantHost: 'fabrikam.sharepoint.com' }), /different SharePoint tenant/);
});

test('workload types never enter Entra waves', () => {
  assert.throws(() => planWaves([{ naturalKey: 'sharepoint:tenant-settings', resourceType: 'sharepointTenantSettings', payload: {}, references: [] }]), /workload restore path/);
  assert.throws(() => planDeletionWaves([{ naturalKey: 'site:x', resourceType: 'sharepointSite', payload: {}, references: [] }]), /workload restore path/);
});

// ------------------------------------------------------------ qualification

test('an unqualified write does zero writes; a fixture pass alone never enables it', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = { ...SOURCE_SETTINGS, sharingCapability: 'externalUserAndGuestSharing' };
  const { artifact } = await planned(client, tenantRef, live);

  const fixtureOnly = workloadWriteQualification(SHAREPOINT_WRITE_OPERATION, {
    readLedger: readLedger(tenantRef), evidence: [{ operationId: SHAREPOINT_WRITE_OPERATION, kind: 'fixture', synthetic: true, ok: true, proofRef: 'harness' }], tenantRef, now: NOW,
  });
  assert.equal(fixtureOnly.state, 'fixture-tested');
  assert.equal(fixtureOnly.enabled, false);

  const cases = {
    fixtureOnly,
    syntheticCapture: workloadWriteQualification(SHAREPOINT_WRITE_OPERATION, { readLedger: readLedger(tenantRef), evidence: [liveWrite(tenantRef, { synthetic: true })], tenantRef, now: NOW }),
    otherTenant: workloadWriteQualification(SHAREPOINT_WRITE_OPERATION, { readLedger: readLedger(tenantRef), evidence: [liveWrite('sha256:other')], tenantRef, now: NOW }),
    notReadBack: workloadWriteQualification(SHAREPOINT_WRITE_OPERATION, { readLedger: readLedger(tenantRef), evidence: [liveWrite(tenantRef, { readBackVerified: false })], tenantRef, now: NOW }),
    readNotEnabled: workloadWriteQualification(SHAREPOINT_WRITE_OPERATION, { readLedger: readLedger(tenantRef, false), evidence: [liveWrite(tenantRef)], tenantRef, now: NOW }),
    none: undefined,
  };
  for (const [name, qualification] of Object.entries(cases)) {
    assert.notEqual(qualification?.enabled, true, name);
    const graph = fakeSharePoint(live);
    const result = await executeSharePointRestore(client, { tenantRef, artifactId: artifact.id, tenantHost: HOST, transport: graph.transport, qualification });
    assert.equal(result.outcome, 'disabled', name);
    assert.equal(result.writes, 0, name);
    assert.equal(graph.requests.length, 0, `${name}: no request at all`);
  }
  assert.equal(qualified(tenantRef).enabled, true);
  // The write is not a catalogue type: the Entra ledger is unchanged by it.
  assert.equal(buildOperationLedger().types.some((row) => row.resourceType === 'sharepointTenantSettings'), false);
});

// ------------------------------------------------------------------ restore

test('a fixture setting restore writes only the changed fields, re-reads and verifies', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = { ...SOURCE_SETTINGS, sharingCapability: 'externalUserAndGuestSharing', unrelatedSetting: 'kept' };
  const { artifact, plan } = await planned(client, tenantRef, live);
  assert.equal(artifact.status, 'completed');
  assert.equal(artifact.snapshotId, null);
  assert.equal(artifact.workloadRestore.digest, plan.digest);

  const graph = fakeSharePoint(live);
  const result = await executeSharePointRestore(client, { tenantRef, artifactId: artifact.id, tenantHost: HOST, transport: graph.transport, qualification: qualified(tenantRef) });
  assert.equal(result.outcome, 'verified', result.reasons.join('; '));
  assert.deepEqual(result.verified, ['sharingCapability']);
  assert.deepEqual(graph.requests.map((request) => request.method), ['GET', 'PATCH', 'GET']);
  assert.deepEqual(graph.writes()[0].body, { sharingCapability: 'externalUserSharingOnly' });
  assert.equal(graph.state.settings.unrelatedSetting, 'kept');

  const { rows } = await client.query(`SELECT subject FROM evidence WHERE tenant_ref = $1 AND kind = $2`, [tenantRef, SHAREPOINT_RESTORE_EVIDENCE_KIND]);
  assert.equal(rows.at(-1).subject.outcome, 'verified');

  // A write the platform silently ignores is reported, not called verified.
  const { artifact: second } = await planned(client, tenantRef, live);
  const ignoring = fakeSharePoint(live, { onPatch: () => ({ status: 204, headers: {}, body: null }) });
  const ignored = await executeSharePointRestore(client, { tenantRef, artifactId: second.id, tenantHost: HOST, transport: ignoring.transport, qualification: qualified(tenantRef) });
  assert.equal(ignored.outcome, 'verification-failed');
  assert.match(ignored.reasons[0], /sharingCapability did not read back/);

  // The plan targets one SharePoint tenant only.
  const { artifact: third } = await planned(client, tenantRef, live);
  const elsewhere = fakeSharePoint(live);
  const wrongHost = await executeSharePointRestore(client, { tenantRef, artifactId: third.id, tenantHost: 'fabrikam.sharepoint.com', transport: elsewhere.transport, qualification: qualified(tenantRef) });
  assert.equal(wrongHost.outcome, 'refused');
  assert.equal(elsewhere.requests.length, 0);
});

test('widening sharing needs a separate approval of exactly these effects', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  // The source was more open than today: restoring it widens sharing.
  const live = { ...SOURCE_SETTINGS, sharingCapability: 'existingExternalUserSharingOnly', sharingAllowedDomainList: [], isResharingByExternalUsersEnabled: false };
  const { artifact, plan, requestedBy } = await planned(client, tenantRef, live);
  assert.deepEqual(plan.contentEffects.map((effect) => `${effect.field}:${effect.effect}`).sort(), [
    'sharingAllowedDomainList:externally-sharing', 'sharingCapability:externally-sharing',
  ]);
  assert.match(plan.contentEffects[0].disclosure, /backs up configuration, not content/);
  assert.deepEqual(artifact.contentEffects, plan.contentEffects);

  // No approval: nothing is read or written.
  const graph = fakeSharePoint(live);
  const blocked = await executeSharePointRestore(client, { tenantRef, artifactId: artifact.id, tenantHost: HOST, transport: graph.transport, qualification: qualified(tenantRef) });
  assert.equal(blocked.outcome, 'blocked-content-effect');
  assert.equal(graph.requests.length, 0);

  // The requester cannot approve their own effects, and a stale digest is refused.
  const approver = await principal(client, `${tenantRef}-approver`, 'approver');
  await grantRole(client, { principalId: requestedBy, role: 'approver', grantedBy: requestedBy, activeFrom: new Date(Date.now() - 60_000) });
  await assert.rejects(approveContentEffects(client, {
    tenantRef, artifactId: artifact.id, approverId: requestedBy, effectsDigest: contentEffectsDigest(plan.contentEffects), justification: 'mine',
  }), ContentEffectApprovalError);
  await assert.rejects(approveContentEffects(client, {
    tenantRef, artifactId: artifact.id, approverId: approver, effectsDigest: contentEffectsDigest(plan.contentEffects.slice(1)), justification: 'partial review',
  }), /no longer match/);
  assert.equal((await executeSharePointRestore(client, { tenantRef, artifactId: artifact.id, tenantHost: HOST, transport: graph.transport, qualification: qualified(tenantRef) })).outcome, 'blocked-content-effect');

  await approveContentEffects(client, {
    tenantRef, artifactId: artifact.id, approverId: approver, effectsDigest: contentEffectsDigest(plan.contentEffects), justification: 'partner access agreed with the data owner',
  });
  const result = await executeSharePointRestore(client, { tenantRef, artifactId: artifact.id, tenantHost: HOST, transport: graph.transport, qualification: qualified(tenantRef) });
  assert.equal(result.outcome, 'verified', result.reasons.join('; '));
  assert.equal(graph.state.settings.sharingCapability, 'externalUserSharingOnly');
});

test('a concurrent settings change after the dry run invalidates promotion with no write', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = { ...SOURCE_SETTINGS, sharingCapability: 'externalUserAndGuestSharing' };
  const { artifact } = await planned(client, tenantRef, live);

  // Someone changes a different setting in SharePoint admin after the plan.
  for (const change of [{ sharingBlockedDomainList: ['contoso-rival.com'] }, { unrelatedSetting: 'changed by an admin' }]) {
    const graph = fakeSharePoint({ ...live, ...change });
    const result = await executeSharePointRestore(client, { tenantRef, artifactId: artifact.id, tenantHost: HOST, transport: graph.transport, qualification: qualified(tenantRef) });
    assert.equal(result.outcome, 'stale');
    assert.equal(graph.writes().length, 0);
    assert.deepEqual(graph.state.settings.sharingBlockedDomainList, change.sharingBlockedDomainList ?? []);
  }
});

test('a preservation-lock refusal is reported once and never retried', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = { ...SOURCE_SETTINGS, sharingCapability: 'externalUserAndGuestSharing' };
  const { artifact } = await planned(client, tenantRef, live);
  const graph = fakeSharePoint(live, { onPatch: () => ({ status: 403, headers: {}, body: { error: { code: 'accessDenied', message: 'Blocked by PreservationLock policy' } } }) });
  const result = await executeSharePointRestore(client, { tenantRef, artifactId: artifact.id, tenantHost: HOST, transport: graph.transport, qualification: qualified(tenantRef) });
  assert.equal(result.outcome, 'refused');
  assert.match(result.reasons[0], /preservation lock/);
  assert.equal(graph.writes().length, 1);

  // A tampered stored plan is refused before anything is sent.
  const { artifact: other } = await planned(client, tenantRef, live);
  await client.query(`UPDATE restore_dry_run SET workload_restore = jsonb_set(workload_restore, '{operations,0,body,sharingCapability}', '"externalUserAndGuestSharing"') WHERE id = $1`, [other.id]);
  const clean = fakeSharePoint(live);
  const tampered = await executeSharePointRestore(client, { tenantRef, artifactId: other.id, tenantHost: HOST, transport: clean.transport, qualification: qualified(tenantRef) });
  assert.equal(tampered.outcome, 'refused');
  assert.equal(clean.requests.length, 0);
});
