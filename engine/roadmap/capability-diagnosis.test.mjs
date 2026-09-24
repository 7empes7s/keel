/**
 * Roadmap task-53 boundary tests: license, consent and role diagnosis without
 * masking failures. Exercises the production engine/coverage/diagnosis.mjs,
 * engine/coverage/report.mjs, engine/store/tenantRef.mjs and
 * tools/tenant-probe/catalog.mjs against adversarial fixtures and the isolated
 * test database — including the three required mutation checks:
 *
 * - Classify every 403 as missing license.
 * - Use older SKU success over newer failure.
 * - Leak diagnosis into raw complete status.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  DIAGNOSIS_CONTRACT_VERSION, DIAGNOSIS_STATES, PREREQUISITE_EVIDENCE_MAX_AGE_MS,
  ROLE_TEMPLATES, diagnoseFailure, prerequisiteFor, registerFeaturePrerequisite,
} from '../coverage/diagnosis.mjs';
import { buildCoverageReport } from '../coverage/report.mjs';
import { CrossTenantObservationError } from '../contracts/observation.mjs';
import { assertTenantRef, tenantRefFor } from '../store/tenantRef.mjs';
import { CATALOG, catalogEntryFor } from '../../tools/tenant-probe/catalog.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const TENANT = 'sha256:diagnosis-test';
const NOW = new Date('2026-09-22T12:00:00.000Z');
const FRESH = '2026-09-22T11:00:00.000Z';
const FAILURE_403 = { httpStatus: 403, graphCode: 'Error_AccessDenied' };
const FEATURE = 'roleEligibilitySchedule'; // registered with all three dimensions

const skuWithPlan = (planName, status) => ({
  skuPartNumber: 'FIXTURE_SKU',
  servicePlans: [{ servicePlanName: planName, provisioningStatus: status }],
});
const skuEvidence = (skus, overrides = {}) => [{
  outcome: 'complete', observedAt: FRESH, tenantRef: TENANT, skus, ...overrides,
}];
const consentEvidence = (grantedScopes, overrides = {}) => [{
  outcome: 'complete', observedAt: FRESH, tenantRef: TENANT, grantedScopes, ...overrides,
}];
const roleEvidence = (assignedRoleIds, overrides = {}) => [{
  outcome: 'complete', observedAt: FRESH, tenantRef: TENANT, assignedRoleIds, ...overrides,
}];

// ---------------------------------------------------------------------------
// tenantRef boundary and catalog source-link
// ---------------------------------------------------------------------------

test('assertTenantRef accepts derived references and refuses raw/empty tenant ids', () => {
  assert.equal(assertTenantRef(TENANT), TENANT);
  assert.equal(assertTenantRef(tenantRefFor('fixture-tenant-id')), tenantRefFor('fixture-tenant-id'));
  for (const bad of [undefined, null, '', 'fixture-tenant-id', '9d5f0d14-4f47-4f96-b30e-2a96ba9a1f6a', 'sha256:']) {
    assert.throws(() => assertTenantRef(bad), TypeError, `${JSON.stringify(bad)} must be refused`);
  }
});

test('assertTenantRef refuses values that merely embed a sha256: suffix (anchored match)', () => {
  // A weakened pattern without its anchors would accept a raw tenant id that
  // happens to contain "sha256:…" — exactly the non-derived value this
  // boundary exists to refuse before it anchors a diagnosis join.
  for (const bad of [
    'xsha256:abc123', // prefix junk before the marker
    'raw-tenant-id sha256:deadbeef', // marker embedded after a space
    'sha256:abc sha256:def', // two embedded markers, first one invalid
    'sha256:abc123 trailing-junk', // trailing junk after an otherwise valid prefix
    'sha256:abc123\nsha256:def', // embedded marker on a later line
  ]) {
    assert.throws(() => assertTenantRef(bad), TypeError, `${JSON.stringify(bad)} must be refused`);
  }
});

test('catalogEntryFor source-links registry features to real measured endpoints', () => {
  assert.equal(catalogEntryFor('subscribedSku').path, '/subscribedSkus');
  assert.equal(catalogEntryFor('not-a-collected-type'), null);
  // Every CATALOG type resolves through the same lookup the registry uses.
  for (const entry of CATALOG) {
    assert.equal(catalogEntryFor(entry.type), entry);
  }
});

// ---------------------------------------------------------------------------
// Registry: versioned, source-linked, explicit
// ---------------------------------------------------------------------------

test('prerequisite registry is versioned and source-linked to documentation', () => {
  const prerequisite = prerequisiteFor(FEATURE);
  assert.equal(prerequisite.contractVersion, DIAGNOSIS_CONTRACT_VERSION);
  assert.equal(prerequisite.feature, FEATURE);
  assert.equal(prerequisite.endpoint, '/roleManagement/directory/roleEligibilitySchedules',
    'source-linked to the catalogue endpoint, not a free-floating string');
  assert.equal(prerequisite.servicePlan, 'AAD_PREMIUM_P2');
  assert.ok(prerequisite.consentScopes.includes('RoleManagement.Read.Directory'));
  assert.ok(prerequisite.requiredRoles.some((r) => r.templateId === ROLE_TEMPLATES.globalReader));
  assert.match(prerequisite.source.url, /^https:\/\/learn\.microsoft\.com\//);
  assert.ok(!Number.isNaN(Date.parse(prerequisite.source.retrievedAt)), 'retrieval date recorded');
  assert.deepEqual([...DIAGNOSIS_STATES], ['missing-license', 'disabled-plan', 'missing-scope', 'missing-role', 'unknown']);
  assert.ok(PREREQUISITE_EVIDENCE_MAX_AGE_MS > 0);
});

test('registering a prerequisite for an uncollected feature or without a source is refused', () => {
  assert.throws(
    () => registerFeaturePrerequisite({ feature: 'not-a-collected-type', source: { url: 'https://x', retrievedAt: '2026-09-22' } }),
    /nothing collects this feature/,
  );
  assert.throws(
    () => registerFeaturePrerequisite({ feature: 'organization' }),
    /source/,
  );
  assert.throws(
    () => registerFeaturePrerequisite({ feature: 'organization', consentScopes: [''], source: { url: 'https://x', retrievedAt: '2026-09-22' } }),
    /consentScopes/,
  );
  assert.throws(
    () => registerFeaturePrerequisite({ feature: 'organization', source: { url: 'https://x', retrievedAt: 'not-a-date' } }),
    /source/,
  );
});

// ---------------------------------------------------------------------------
// Distinct diagnoses, raw failure preserved
// ---------------------------------------------------------------------------

test('missing-license: a complete SKU read proving the plan is nowhere owned diagnoses the 403', () => {
  const result = diagnoseFailure({
    feature: FEATURE,
    failure: FAILURE_403,
    evidence: {
      sku: skuEvidence([skuWithPlan('AAD_PREMIUM_P1', 'Success')]),
      consent: consentEvidence(['RoleManagement.Read.Directory']),
      roles: roleEvidence([ROLE_TEMPLATES.globalReader]),
    },
    tenantRef: TENANT,
    now: NOW,
  });
  assert.equal(result.diagnosis, 'missing-license');
  assert.equal(result.confirmed.servicePlan, 'AAD_PREMIUM_P2');
  assert.equal(result.contractVersion, DIAGNOSIS_CONTRACT_VERSION);
  // The raw failure is preserved verbatim, named diagnosis or not.
  assert.deepEqual(result.original, FAILURE_403);
});

test('missing-license: a complete-empty SKU read (tenant owns nothing) is confirmed evidence', () => {
  const result = diagnoseFailure({
    feature: FEATURE,
    failure: FAILURE_403,
    evidence: { sku: skuEvidence([], { outcome: 'complete-empty' }) },
    tenantRef: TENANT,
    now: NOW,
  });
  assert.equal(result.diagnosis, 'missing-license');
});

test('disabled-plan: the plan is owned but only in Disabled form', () => {
  const result = diagnoseFailure({
    feature: FEATURE,
    failure: FAILURE_403,
    evidence: {
      sku: skuEvidence([
        skuWithPlan('AAD_PREMIUM_P2', 'Disabled'),
        skuWithPlan('AAD_PREMIUM_P1', 'Success'),
      ]),
      consent: consentEvidence(['RoleManagement.Read.Directory']),
      roles: roleEvidence([ROLE_TEMPLATES.globalReader]),
    },
    tenantRef: TENANT,
    now: NOW,
  });
  assert.equal(result.diagnosis, 'disabled-plan');
  assert.deepEqual(result.original, FAILURE_403);
});

test('missing-scope: license is fine but no acceptable scope is granted anywhere', () => {
  const result = diagnoseFailure({
    feature: FEATURE,
    failure: FAILURE_403,
    evidence: {
      sku: skuEvidence([skuWithPlan('AAD_PREMIUM_P2', 'Success')]),
      consent: consentEvidence(['User.Read.All', 'Group.Read.All']),
      roles: roleEvidence([ROLE_TEMPLATES.globalReader]),
    },
    tenantRef: TENANT,
    now: NOW,
  });
  assert.equal(result.diagnosis, 'missing-scope');
  assert.ok(result.confirmed.consentScopes.includes('RoleManagement.Read.Directory'));
  assert.deepEqual(result.original, FAILURE_403);
});

test('missing-role: license and scope are fine but no acceptable role is assigned anywhere in the tenant', () => {
  const result = diagnoseFailure({
    feature: FEATURE,
    failure: FAILURE_403,
    evidence: {
      sku: skuEvidence([skuWithPlan('AAD_PREMIUM_P2', 'Success')]),
      consent: consentEvidence(['RoleManagement.Read.Directory']),
      roles: roleEvidence(['9360feb5-f418-4baa-8175-e2a00bac4301']), // Directory Writers: not acceptable
    },
    tenantRef: TENANT,
    now: NOW,
  });
  assert.equal(result.diagnosis, 'missing-role');
  assert.ok(result.confirmed.requiredRoles.includes('Global Reader'));
  assert.deepEqual(result.original, FAILURE_403);
});

test('mutation pin (1): a 403 is NOT missing-license when the plan is owned and enabled', () => {
  // The mutated code classifies every 403 as missing license. With an enabled
  // plan, granted scope and assigned role, nothing is confirmed missing: the
  // ambiguous 403 stays unknown and keeps its original code.
  const result = diagnoseFailure({
    feature: FEATURE,
    failure: FAILURE_403,
    evidence: {
      sku: skuEvidence([skuWithPlan('AAD_PREMIUM_P2', 'Success')]),
      consent: consentEvidence(['RoleEligibilitySchedule.Read.Directory']),
      roles: roleEvidence([ROLE_TEMPLATES.privilegedRoleAdministrator]),
    },
    tenantRef: TENANT,
    now: NOW,
  });
  assert.equal(result.diagnosis, 'unknown');
  assert.notEqual(result.diagnosis, 'missing-license');
  assert.equal(result.reason, 'no-confirmed-missing-prerequisite');
  assert.deepEqual(result.original, FAILURE_403, 'the ambiguous 403 keeps its original status and code');
});

test('SKU ownership alone is insufficient: an enabled plan never clears or re-labels the failure', () => {
  // Owning the SKU does not establish user entitlement or consent. With the
  // plan enabled and consent/role evidence unusable, the failure is still
  // unexplained — unknown, never "not a license problem, must be fine".
  const result = diagnoseFailure({
    feature: FEATURE,
    failure: FAILURE_403,
    evidence: { sku: skuEvidence([skuWithPlan('AAD_PREMIUM_P2', 'Success')]) },
    tenantRef: TENANT,
    now: NOW,
  });
  assert.equal(result.diagnosis, 'unknown');
  assert.equal(result.checked.license, 'usable');
  assert.equal(result.checked.consent, 'no-observation');
  assert.equal(result.checked.roles, 'no-observation');
});

test('a non-authorization failure is never re-labeled as a licensing problem', () => {
  for (const failure of [
    { httpStatus: 500, graphCode: 'Error_InternalServer' },
    { httpStatus: 429, graphCode: 'TooManyRequests' },
    { httpStatus: null, graphCode: null },
  ]) {
    const result = diagnoseFailure({
      feature: FEATURE,
      failure,
      evidence: { sku: skuEvidence([]) }, // plan provably missing — irrelevant
      tenantRef: TENANT,
      now: NOW,
    });
    assert.equal(result.diagnosis, 'unknown', `${failure.httpStatus} must stay unknown`);
    assert.equal(result.reason, 'failure-not-authorization-shaped');
    assert.deepEqual(result.original, failure, 'the raw failure is preserved');
  }
});

test('an unregistered feature cannot be diagnosed', () => {
  const result = diagnoseFailure({
    feature: 'managedDevice',
    failure: FAILURE_403,
    evidence: { sku: skuEvidence([]) },
    tenantRef: TENANT,
    now: NOW,
  });
  assert.equal(result.diagnosis, 'unknown');
  assert.equal(result.reason, 'no-registered-prerequisite');
});

// ---------------------------------------------------------------------------
// Time qualification, tenant scoping, newest-mention-decides
// ---------------------------------------------------------------------------

test('mutation pin (2): a newer failed SKU read supersedes the older success', () => {
  // The mutated code would fall back to the older success (plan missing) and
  // diagnose missing-license. The newest mention decides: the SKU read now
  // fails, so the license dimension is unusable and the 403 stays unknown.
  const result = diagnoseFailure({
    feature: FEATURE,
    failure: FAILURE_403,
    evidence: {
      sku: [
        { outcome: 'complete', observedAt: '2026-09-22T09:00:00.000Z', tenantRef: TENANT, skus: [] },
        { outcome: 'failed', observedAt: FRESH, tenantRef: TENANT, skus: [] },
      ],
    },
    tenantRef: TENANT,
    now: NOW,
  });
  assert.equal(result.diagnosis, 'unknown');
  assert.notEqual(result.diagnosis, 'missing-license');
  assert.equal(result.checked.license, 'newest-read-failed');
  assert.deepEqual(result.original, FAILURE_403);

  // Order independence: the newest timestamp decides, not array position.
  const reordered = diagnoseFailure({
    feature: FEATURE,
    failure: FAILURE_403,
    evidence: {
      sku: [
        { outcome: 'failed', observedAt: FRESH, tenantRef: TENANT, skus: [] },
        { outcome: 'complete', observedAt: '2026-09-22T09:00:00.000Z', tenantRef: TENANT, skus: [] },
      ],
    },
    tenantRef: TENANT,
    now: NOW,
  });
  assert.equal(reordered.diagnosis, 'unknown');

  // The mirror image: newer success supersedes an older failure and DOES decide.
  const newerSuccess = diagnoseFailure({
    feature: FEATURE,
    failure: FAILURE_403,
    evidence: {
      sku: [
        { outcome: 'complete', observedAt: FRESH, tenantRef: TENANT, skus: [] },
        { outcome: 'failed', observedAt: '2026-09-22T09:00:00.000Z', tenantRef: TENANT, skus: [] },
      ],
    },
    tenantRef: TENANT,
    now: NOW,
  });
  assert.equal(newerSuccess.diagnosis, 'missing-license');
});

test('stale, future and untimed SKU observations cannot justify a diagnosis', () => {
  const stale = diagnoseFailure({
    feature: FEATURE,
    failure: FAILURE_403,
    evidence: { sku: skuEvidence([], { observedAt: '2026-09-22T08:00:00.000Z' }) }, // 4h old > 3h window
    tenantRef: TENANT,
    now: NOW,
  });
  assert.equal(stale.diagnosis, 'unknown');
  assert.equal(stale.checked.license, 'stale-observation');

  const future = diagnoseFailure({
    feature: FEATURE,
    failure: FAILURE_403,
    evidence: { sku: skuEvidence([], { observedAt: '2026-09-22T13:00:00.000Z' }) },
    tenantRef: TENANT,
    now: NOW,
  });
  assert.equal(future.diagnosis, 'unknown');
  assert.equal(future.checked.license, 'future-observation');

  const untimed = diagnoseFailure({
    feature: FEATURE,
    failure: FAILURE_403,
    evidence: { sku: skuEvidence([], { observedAt: null }) },
    tenantRef: TENANT,
    now: NOW,
  });
  assert.equal(untimed.diagnosis, 'unknown');
});

test('wrong-tenant evidence refuses the join instead of justifying a diagnosis', () => {
  assert.throws(
    () => diagnoseFailure({
      feature: FEATURE,
      failure: FAILURE_403,
      evidence: { sku: skuEvidence([], { tenantRef: 'sha256:another-tenant' }) },
      tenantRef: TENANT,
      now: NOW,
    }),
    CrossTenantObservationError,
  );
});

// ------------------------------------------------------------ DB integration
const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

async function seedSnapshot(client, {
  tenantRef, startedAt, completedAt, digest, resources = [],
}) {
  const { rows } = await client.query(
    `INSERT INTO snapshot (tenant_ref, started_at, completed_at, status, coverage_digest)
     VALUES ($1, $2, $3, 'complete', $4) RETURNING id`,
    [tenantRef, startedAt, completedAt, JSON.stringify(digest)],
  );
  const snapshotId = rows[0].id;
  for (const resource of resources) {
    await client.query(
      `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, $3, $4, $5, 'tier1', 'access-affecting', 'read-only', $6)`,
      [snapshotId, `${resource.type}:${resource.id}`, resource.type, JSON.stringify(resource.payload),
        `fixture-hash-${resource.id}`, JSON.stringify({ adapter: 'fixture' })],
    );
  }
  return snapshotId;
}

const structured = (outcome, extra = {}) => ({
  outcome, itemCount: null, ...extra,
});

test('report: a failed PIM read is diagnosed missing-license from SKU payloads, raw outcome untouched', async (t) => {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  const tenantRef = 'sha256:diagnosis-report';
  await seedSnapshot(client, {
    tenantRef,
    startedAt: '2026-09-22T10:00:00Z',
    completedAt: '2026-09-22T10:05:00Z',
    digest: {
      subscribedSku: structured('complete', { itemCount: 1, completedAt: '2026-09-22T10:04:00Z' }),
      oauth2PermissionGrant: structured('complete', { itemCount: 1, completedAt: '2026-09-22T10:04:00Z' }),
      roleAssignment: structured('complete', { itemCount: 1, completedAt: '2026-09-22T10:04:00Z' }),
      roleEligibilitySchedule: structured('failed', {
        httpStatus: 403, graphCode: 'Error_AccessDenied', error: 'denied',
        endpoint: '/roleManagement/directory/roleEligibilitySchedules', apiVersion: 'v1.0',
        startedAt: '2026-09-22T10:03:00Z', completedAt: '2026-09-22T10:03:30Z',
      }),
      group: structured('complete', { itemCount: 4, completedAt: '2026-09-22T10:04:00Z' }),
    },
    resources: [
      { type: 'subscribedSku', id: 'sku1', payload: skuWithPlan('AAD_PREMIUM_P1', 'Success') },
      { type: 'oauth2PermissionGrant', id: 'grant1', payload: { scope: 'User.Read.All' } },
      { type: 'roleAssignment', id: 'ra1', payload: { roleDefinitionId: ROLE_TEMPLATES.globalReader } },
      { type: 'group', id: 'g1', payload: { id: 'g1', displayName: 'Fixture' } },
    ],
  });

  const report = await buildCoverageReport(client, {
    tenantRef, catalog: CATALOG, descriptors: DESCRIPTORS, now: new Date('2026-09-22T11:00:00.000Z'),
  });
  const byType = new Map(report.types.map((entry) => [entry.type, entry]));

  const pim = byType.get('roleEligibilitySchedule');
  assert.equal(pim.diagnosis.diagnosis, 'missing-license');
  assert.equal(pim.diagnosis.confirmed.servicePlan, 'AAD_PREMIUM_P2');
  assert.deepEqual(pim.diagnosis.original, { httpStatus: 403, graphCode: 'Error_AccessDenied' });
  assert.match(pim.diagnosis.prerequisite.source.url, /^https:\/\/learn\.microsoft\.com\//);

  // Mutation pin (3): the diagnosis never leaks into the raw collection
  // outcome. Status, coverage, outcome and detail are exactly what the
  // collector recorded — diagnosis is an additional field only.
  assert.equal(pim.status, 'failed');
  assert.equal(pim.covered, false);
  assert.equal(pim.outcome, 'failed');
  assert.equal(pim.itemCount, null);
  assert.equal(pim.detail.graphCode, 'Error_AccessDenied');
  assert.equal(pim.detail.httpStatus, 403);
  assert.equal(report.summary.failed, 1, 'diagnosis does not change the failure counts');

  // A covered type carries no diagnosis at all — and stays covered.
  const group = byType.get('group');
  assert.equal(group.status, 'covered');
  assert.equal(group.diagnosis, null);
});

test('report: missing-scope and missing-role are diagnosed from consent and role payloads', async (t) => {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  const tenantRef = 'sha256:diagnosis-scope-role';
  await seedSnapshot(client, {
    tenantRef,
    startedAt: '2026-09-22T10:00:00Z',
    completedAt: '2026-09-22T10:05:00Z',
    digest: {
      subscribedSku: structured('complete', { itemCount: 1, completedAt: '2026-09-22T10:04:00Z' }),
      oauth2PermissionGrant: structured('complete', { itemCount: 2, completedAt: '2026-09-22T10:04:00Z' }),
      roleAssignment: structured('complete', { itemCount: 1, completedAt: '2026-09-22T10:04:00Z' }),
      roleEligibilitySchedule: structured('failed', {
        httpStatus: 403, graphCode: 'Error_AccessDenied', error: 'denied',
        completedAt: '2026-09-22T10:03:30Z',
      }),
      accessReviewScheduleDefinition: structured('failed', {
        httpStatus: 403, graphCode: 'Authorization_RequestDenied', error: 'denied',
        completedAt: '2026-09-22T10:03:31Z',
      }),
    },
    resources: [
      { type: 'subscribedSku', id: 'sku1', payload: skuWithPlan('AAD_PREMIUM_P2', 'Success') },
      { type: 'oauth2PermissionGrant', id: 'grant1', payload: { scope: 'User.Read.All AccessReview.Read.All' } },
      { type: 'oauth2PermissionGrant', id: 'grant2', payload: { scope: 'Group.Read.All' } },
      { type: 'roleAssignment', id: 'ra1', payload: { roleDefinitionId: '9360feb5-f418-4baa-8175-e2a00bac4301' } },
    ],
  });

  const report = await buildCoverageReport(client, {
    tenantRef, catalog: CATALOG, descriptors: DESCRIPTORS, now: new Date('2026-09-22T11:00:00.000Z'),
  });
  const byType = new Map(report.types.map((entry) => [entry.type, entry]));

  // PIM: license fine (P2 enabled), scope fine? No — PIM accepts
  // RoleEligibilitySchedule.Read.Directory or RoleManagement.Read.Directory;
  // neither is granted → missing-scope. Access reviews: AccessReview.Read.All
  // IS granted → scope fine, but no acceptable role is assigned anywhere →
  // missing-role.
  const pim = byType.get('roleEligibilitySchedule');
  assert.equal(pim.diagnosis.diagnosis, 'missing-scope');
  assert.equal(pim.outcome, 'failed', 'raw outcome untouched');

  const reviews = byType.get('accessReviewScheduleDefinition');
  assert.equal(reviews.diagnosis.diagnosis, 'missing-role');
  assert.equal(reviews.outcome, 'failed', 'raw outcome untouched');
});

test('report: a newer failed SKU read supersedes the older successful payloads', async (t) => {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  const tenantRef = 'sha256:diagnosis-supersede';

  // Older run: SKU read succeeded and the plan was missing — payloads that
  // would justify missing-license if they were allowed to decide.
  await seedSnapshot(client, {
    tenantRef,
    startedAt: '2026-09-22T08:00:00Z',
    completedAt: '2026-09-22T08:05:00Z',
    digest: {
      subscribedSku: structured('complete', { itemCount: 1, completedAt: '2026-09-22T08:04:00Z' }),
    },
    resources: [
      { type: 'subscribedSku', id: 'sku1', payload: skuWithPlan('AAD_PREMIUM_P1', 'Success') },
    ],
  });

  // Newer run: the SKU read now fails, and so does the PIM read.
  await seedSnapshot(client, {
    tenantRef,
    startedAt: '2026-09-22T10:00:00Z',
    completedAt: '2026-09-22T10:05:00Z',
    digest: {
      subscribedSku: structured('failed', {
        httpStatus: 403, graphCode: 'Error_AccessDenied', error: 'denied',
        completedAt: '2026-09-22T10:04:00Z',
      }),
      roleEligibilitySchedule: structured('failed', {
        httpStatus: 403, graphCode: 'Error_AccessDenied', error: 'denied',
        completedAt: '2026-09-22T10:03:30Z',
      }),
    },
  });

  const report = await buildCoverageReport(client, {
    tenantRef, catalog: CATALOG, descriptors: DESCRIPTORS, now: new Date('2026-09-22T11:00:00.000Z'),
  });
  const byType = new Map(report.types.map((entry) => [entry.type, entry]));

  // Mutation pin (2) at the report seam: the older successful SKU payloads
  // must NOT justify missing-license after the newer read failed.
  const pim = byType.get('roleEligibilitySchedule');
  assert.equal(pim.diagnosis.diagnosis, 'unknown');
  assert.notEqual(pim.diagnosis.diagnosis, 'missing-license');
  assert.equal(pim.diagnosis.checked.license, 'newest-read-failed');
  assert.equal(pim.status, 'failed');
  assert.equal(pim.outcome, 'failed');
  assert.equal(pim.detail.graphCode, 'Error_AccessDenied');
});

test('report: legacy digests stay readable — failed entries read unknown, nothing invented', async (t) => {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  const tenantRef = 'sha256:diagnosis-legacy';
  await client.query(
    `INSERT INTO snapshot (tenant_ref, started_at, completed_at, status, coverage_digest)
     VALUES ($1, '2026-09-22T10:00:00Z', '2026-09-22T10:05:00Z', 'complete', $2)`,
    [tenantRef, JSON.stringify({
      subscribedSku: 2,
      oauth2PermissionGrant: 1,
      roleAssignment: 3,
      roleEligibilitySchedule: { outcome: 'failed', itemCount: null, error: 'denied' },
      group: 5,
    })],
  );

  const report = await buildCoverageReport(client, {
    tenantRef, catalog: [], descriptors: DESCRIPTORS.filter((d) => ['subscribedSku', 'oauth2PermissionGrant', 'roleAssignment', 'roleEligibilitySchedule', 'group'].includes(d.type)),
    now: new Date('2026-09-22T11:00:00.000Z'),
  });
  const byType = new Map(report.types.map((entry) => [entry.type, entry]));

  // The legacy failure keeps its message-only shape; without an HTTP status it
  // is not authorization-shaped, so the diagnosis is unknown — and the raw
  // entry is exactly what the legacy digest recorded.
  const pim = byType.get('roleEligibilitySchedule');
  assert.equal(pim.status, 'failed');
  assert.equal(pim.outcome, 'failed');
  assert.match(pim.detail.message, /denied/);
  assert.equal(pim.detail.httpStatus, null, 'unevidenced legacy fields stay null');
  assert.equal(pim.diagnosis.diagnosis, 'unknown');
  assert.equal(pim.diagnosis.reason, 'failure-not-authorization-shaped');
  assert.deepEqual(pim.diagnosis.original, { httpStatus: null, graphCode: null });

  // Legacy bare counts keep their old meaning; nothing was rewritten.
  assert.equal(byType.get('group').status, 'covered');
  assert.equal(byType.get('group').diagnosis, null);
  assert.equal(byType.get('subscribedSku').status, 'covered');
});

test('report: an ambiguous 403 with all prerequisites satisfied stays unknown', async (t) => {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  const tenantRef = 'sha256:diagnosis-ambiguous';
  await seedSnapshot(client, {
    tenantRef,
    startedAt: '2026-09-22T10:00:00Z',
    completedAt: '2026-09-22T10:05:00Z',
    digest: {
      subscribedSku: structured('complete', { itemCount: 1, completedAt: '2026-09-22T10:04:00Z' }),
      oauth2PermissionGrant: structured('complete', { itemCount: 1, completedAt: '2026-09-22T10:04:00Z' }),
      roleAssignment: structured('complete', { itemCount: 1, completedAt: '2026-09-22T10:04:00Z' }),
      roleEligibilitySchedule: structured('failed', {
        httpStatus: 403, graphCode: 'Error_AccessDenied', error: 'denied',
        completedAt: '2026-09-22T10:03:30Z',
      }),
    },
    resources: [
      { type: 'subscribedSku', id: 'sku1', payload: skuWithPlan('AAD_PREMIUM_P2', 'Success') },
      { type: 'oauth2PermissionGrant', id: 'grant1', payload: { scope: 'RoleManagement.Read.Directory' } },
      { type: 'roleAssignment', id: 'ra1', payload: { roleDefinitionId: ROLE_TEMPLATES.globalReader } },
    ],
  });

  const report = await buildCoverageReport(client, {
    tenantRef, catalog: CATALOG, descriptors: DESCRIPTORS, now: new Date('2026-09-22T11:00:00.000Z'),
  });
  const pim = report.types.find((entry) => entry.type === 'roleEligibilitySchedule');

  // Every registered prerequisite is satisfiable on the evidence; the 403 has
  // no confirmed cause. Mutation pin (1) at the report seam: NOT missing-license.
  assert.equal(pim.diagnosis.diagnosis, 'unknown');
  assert.notEqual(pim.diagnosis.diagnosis, 'missing-license');
  assert.equal(pim.diagnosis.reason, 'no-confirmed-missing-prerequisite');
  assert.deepEqual(pim.diagnosis.original, { httpStatus: 403, graphCode: 'Error_AccessDenied' });
  assert.equal(pim.status, 'failed');
});

test('report: diagnosis is failed-only — never-collected and not-covered entries carry diagnosis: null', async (t) => {
  // A widened trigger (status !== 'covered') would attach a non-null diagnosis
  // object to never-collected entries, violating the documented invariant
  // "diagnosis: null for non-failed entries". This report contains all three
  // non-covered shapes beside a genuinely failed, diagnosable entry.
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  const tenantRef = 'sha256:diagnosis-trigger';
  await seedSnapshot(client, {
    tenantRef,
    startedAt: '2026-09-22T10:00:00Z',
    completedAt: '2026-09-22T10:05:00Z',
    digest: {
      subscribedSku: structured('complete', { itemCount: 1, completedAt: '2026-09-22T10:04:00Z' }),
      roleEligibilitySchedule: structured('failed', {
        httpStatus: 403, graphCode: 'Error_AccessDenied', error: 'denied',
        completedAt: '2026-09-22T10:03:30Z',
      }),
    },
    resources: [
      { type: 'subscribedSku', id: 'sku1', payload: skuWithPlan('AAD_PREMIUM_P1', 'Success') },
    ],
  });

  // 'domain' stays in the catalog but out of the descriptor set, so it takes
  // the explicit not-covered path; 'managedDevice' is a descriptor with no
  // observation at all, so it is never-collected.
  const report = await buildCoverageReport(client, {
    tenantRef,
    catalog: CATALOG,
    descriptors: DESCRIPTORS.filter((d) => d.type !== 'domain'),
    now: new Date('2026-09-22T11:00:00.000Z'),
  });
  const byType = new Map(report.types.map((entry) => [entry.type, entry]));

  // Control: the failed entry DOES get a diagnosis — the guard is failed-only,
  // not never-diagnose.
  const pim = byType.get('roleEligibilitySchedule');
  assert.equal(pim.status, 'failed');
  assert.equal(pim.diagnosis.diagnosis, 'missing-license');

  const covered = byType.get('subscribedSku');
  assert.equal(covered.status, 'covered');
  assert.equal(covered.diagnosis, null, 'covered entries carry no diagnosis');

  const neverCollected = byType.get('managedDevice');
  assert.equal(neverCollected.status, 'never-collected');
  assert.equal(neverCollected.outcome, null);
  assert.equal(neverCollected.detail, null);
  assert.equal(neverCollected.diagnosis, null,
    'a never-collected entry must NOT gain a diagnosis object — there is no failure to explain');

  const notCovered = byType.get('domain');
  assert.equal(notCovered.status, 'not-covered');
  assert.equal(notCovered.diagnosis, null, 'a not-covered catalog entry carries no diagnosis');

  // No invented diagnosis anywhere else: every non-failed entry in the whole
  // report carries diagnosis: null.
  for (const entry of report.types) {
    if (entry.status === 'failed') continue;
    assert.equal(entry.diagnosis, null, `${entry.type} (${entry.status}) must carry diagnosis: null`);
  }
});
