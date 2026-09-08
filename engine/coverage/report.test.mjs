import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { connect } from '../store/db.mjs';
import { buildCoverageReport } from './report.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';

const url = process.env.KEEL_DB_TEST_URL;
if (!url) throw new Error('KEEL_DB_TEST_URL not set — source /etc/keel/db.env first');

const admin = new pg.Client({ connectionString: url });
await admin.connect();
await admin.query(
  'DROP TABLE IF EXISTS evidence, disposition, drift, baseline_resource, baseline, resource_reference, rollback_entry, resource_version, plan, snapshot CASCADE',
);
await admin.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
await admin.end();

const client = await connect(url);
const tenantRef = 'sha256:coverage-test';
const now = new Date('2026-09-08T12:00:00.000Z');

// One completed collection: group healthy, namedLocation returned ZERO items
// (the missing-scope empty-200 trap), user healthy. The 22 types widened into
// DESCRIPTORS on 2026-09-08 also get realistic non-zero counts here — a real
// completed collection populates the digest for every registered type it
// collects, and leaving them out of this fixture would make them read as
// 'failed' (digest-absent) rather than the 'covered' a healthy run over the
// widened set actually produces.
await client.query(
  `INSERT INTO snapshot (tenant_ref, status, completed_at, coverage_digest)
   VALUES ($1, 'complete', now(), $2)`,
  [tenantRef, JSON.stringify({
    user: 12, group: 5, roleAssignment: 3, conditionalAccessPolicy: 2,
    namedLocation: 0, authenticationStrengthPolicy: 1,
    organization: 1, domain: 2, subscribedSku: 4, groupSetting: 1,
    administrativeUnit: 3, identityProvider: 2, application: 9,
    servicePrincipal: 14, directoryRole: 6, roleDefinition: 6,
    authenticationMethodsPolicy: 1, authorizationPolicy: 1,
    crossTenantAccessPolicy: 1, crossTenantAccessPolicyPartner: 2,
    permissionGrantPolicy: 2, adminConsentRequestPolicy: 1,
    accessReviewScheduleDefinition: 1, deviceConfiguration: 3,
    deviceCompliancePolicy: 2, configurationPolicy: 4,
    deviceManagementRoleDefinition: 1, mobileApp: 5,
  })],
);

const report = await buildCoverageReport(client, { tenantRef, catalog: CATALOG, descriptors: DESCRIPTORS, now });
const byType = new Map(report.types.map((t) => [t.type, t]));

// 1. descriptor + healthy collection → covered
const group = byType.get('group');
assert.equal(group.status, 'covered');
assert.equal(group.covered, true);
assert.equal(group.itemCount, 5);
assert.ok(group.lastCollectedAt, 'last successful collection time is reported');
assert.equal(group.adapter, 'graph-native/group');
assert.equal(group.criticality, 'tier1');
assert.equal(group.blastRadius, 'access-affecting');
assert.equal(group.remappable, true);

// 2. ZERO items → FAILED, not covered (anti-overclaim)
const namedLocation = byType.get('namedLocation');
assert.equal(namedLocation.status, 'failed');
assert.equal(namedLocation.covered, false);
assert.equal(namedLocation.itemCount, 0);

// 3. catalog entry with no descriptor → explicitly not-covered
// `domain` was widened into DESCRIPTORS on 2026-09-08 (see descriptors.mjs), so it no longer
// exemplifies "no descriptor" — `contact` is one of the 19 zero-object types descriptors.mjs's
// header documents as deliberately left out, so it's still guaranteed uncollected.
const contact = byType.get('contact');
assert.equal(contact.status, 'not-covered');
assert.equal(contact.covered, false);
assert.equal(contact.adapter, null);
assert.equal(report.types.length, CATALOG.length, 'the report enumerates the unknown, not just the known');
assert.equal(
  report.types.filter((t) => t.status === 'not-covered').length,
  CATALOG.length - DESCRIPTORS.length,
);

// 4. declared fidelity is never presented as verified without a drill
assert.deepEqual(group.fidelity, { declared: 'full', verifiedBy: null });
assert.deepEqual(byType.get('user').fidelity, { declared: 'read-only', verifiedBy: null });

// summary
assert.equal(report.tenantRef, tenantRef);
assert.equal(report.generatedAt, now.toISOString());
// covered = all 28 descriptor types except namedLocation (0 items, deliberately failed above)
assert.equal(report.summary.covered, DESCRIPTORS.length - 1);
assert.equal(report.summary.failed, 1);
assert.equal(report.summary.notCovered, CATALOG.length - DESCRIPTORS.length);

// A tenant with no completed snapshot: registered types are never-collected,
// still not covered.
const emptyReport = await buildCoverageReport(client, {
  tenantRef: 'sha256:no-snapshots', catalog: CATALOG, descriptors: DESCRIPTORS, now,
});
assert.equal(emptyReport.snapshot, null);
assert.equal(emptyReport.summary.covered, 0);
for (const t of emptyReport.types) {
  if (DESCRIPTORS.some((d) => d.type === t.type)) assert.equal(t.status, 'never-collected');
  assert.equal(t.covered, false);
}

await client.end();
console.log('report.test.mjs — all assertions passed');
