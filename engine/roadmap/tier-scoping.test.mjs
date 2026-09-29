/**
 * Roadmap task-49 boundary tests: Scope Graph reads by tier without changing
 * identity. Exercises the production adapter registry, entra adapter and
 * snapshot persistence against adversarial fixtures and the isolated test
 * database — including the three required mutation checks:
 *
 * - Filter after collection instead of before.
 * - Remove cross-tier fallback.
 * - Label unrequested type complete-empty.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { collectWithOutcomes, M1_TYPES } from '../collect/entraAdapter.mjs';
import { get } from '../collect/registry.mjs';
import { collectSnapshot } from '../collect/snapshot.mjs';
import { diffSnapshots } from '../govern/diffSnapshots.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const GA_TEMPLATE = '62e90394-69f5-4237-9190-012177145e10'; // real Global Administrator template id
const U1 = '11111111-1111-1111-1111-111111111111';
const RA1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const user = (id, upn) => ({ id, userPrincipalName: upn, onPremisesSyncEnabled: false });
const assignment = (principalId) => ({
  id: RA1, roleDefinitionId: GA_TEMPLATE, principalId, directoryScopeId: '/',
});
const ok = (items) => ({ items, pages: 1, status: 200, error: null });
const ORG_OK = ok([{ id: 'org-1', displayName: 'Fixture Org' }]);

/** Fake GraphReader seam that also records every path it was asked to read. */
function scopedReader(routes, calls = []) {
  return {
    calls,
    async collect(version, path) {
      calls.push(path);
      for (const [prefix, result] of Object.entries(routes)) {
        if (path.startsWith(prefix)) return typeof result === 'function' ? result() : result;
      }
      return { items: [], pages: 1, status: 200, error: null };
    },
  };
}

// --------------------------------------------------------- registry-level: adapter selection precedes any HTTP read

test('M1_TYPES span all three tiers, so tier scoping is a meaningful boundary here', () => {
  const criticalities = new Set(M1_TYPES.map((type) => get(type).descriptor.criticality));
  assert.ok(criticalities.has('tier1') && criticalities.has('tier2') && criticalities.has('tier3'),
    'the fixtures below only prove something if the M1 types actually span tiers');
});

test('required mutation "filter after collection instead of before": an excluded type is never fetched', async () => {
  const calls = [];
  const reader = scopedReader({}, calls);
  const { coverageDigest } = await collectWithOutcomes(reader, { tenantId: 'fixture-tenant', tier: 'tier1' });

  for (const type of M1_TYPES) {
    if (get(type).descriptor.criticality === 'tier1') continue;
    assert.deepEqual(coverageDigest[type], { outcome: 'not-requested', itemCount: null },
      `${type} is tier-excluded and must be the explicit not-requested marker, never a fetched-then-discarded outcome`);
  }
  // Each graph-native adapter issues exactly one collectRaw call per type in
  // this fixture (no pagination follow-ups triggered) — if tier filtering
  // moved back to after collection, every M1 type would be fetched instead
  // of only the tier1 subset.
  const tier1Count = M1_TYPES.filter((type) => get(type).descriptor.criticality === 'tier1').length;
  assert.equal(calls.length, tier1Count,
    'reader call log contains only requested-tier endpoints');
  assert.ok(tier1Count < M1_TYPES.length, 'sanity: some type must actually be excluded by tier1');
});

test('derived mutation "organization exempted from the tier check": a tier1 type is excluded like any other type under tier2/tier3', async () => {
  for (const tier of ['tier2', 'tier3']) {
    const calls = [];
    const reader = scopedReader({ '/organization': ORG_OK }, calls);
    const { coverageDigest } = await collectWithOutcomes(reader, { tenantId: 'fixture-tenant', tier });

    assert.equal(get('organization').descriptor.criticality, 'tier1',
      'sanity: this only proves something if organization is really tier1');
    assert.deepEqual(coverageDigest.organization, { outcome: 'not-requested', itemCount: null },
      `organization is tier1, so a ${tier}-only run must never fetch it — no special exemption for this type`);
    assert.equal(calls.some((p) => p.startsWith('/organization')), false,
      `reader call log under ${tier} contains only requested-tier endpoints, including organization`);
  }
});

test('an unset tier retains full collection: every type is fetched, exactly current behavior', async () => {
  const calls = [];
  const reader = scopedReader({}, calls);
  const { coverageDigest } = await collectWithOutcomes(reader, { tenantId: 'fixture-tenant' });
  assert.equal(calls.length, M1_TYPES.length, 'full scan retains current behavior: one call per type');
  assert.ok(M1_TYPES.every((type) => coverageDigest[type].outcome !== 'not-requested'),
    'an unscoped collection never marks a type not-requested');
});

test('required mutation "label unrequested type complete-empty": not-requested is distinct from a genuine empty success', async () => {
  const reader = scopedReader({});
  const { coverageDigest } = await collectWithOutcomes(reader, { tenantId: 'fixture-tenant', tier: 'tier3' });
  const tier1Type = M1_TYPES.find((type) => get(type).descriptor.criticality === 'tier1');
  // A tier1 type under a tier3-only run stays not-requested (itemCount null)
  // — never coerced into the complete-empty shape (itemCount 0) a real
  // successful empty read would carry, even though the reader would have
  // happily returned an empty array had it been asked.
  assert.deepEqual(coverageDigest[tier1Type], { outcome: 'not-requested', itemCount: null });
  assert.notDeepEqual(coverageDigest[tier1Type], { outcome: 'complete-empty', itemCount: 0 });
});

// ------------------------------------------------------------------ DB integration
const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

async function freshSchema(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  return client;
}

async function roleAssignmentKey(client, snapshotId) {
  const { rows } = await client.query(
    `SELECT natural_key, provenance FROM resource_version
      WHERE snapshot_id = $1 AND resource_type = 'roleAssignment'`,
    [snapshotId],
  );
  return rows[0];
}

test('acceptance: tier1 storage keeps only tier1 resources; tier2 stays not-requested, not stored', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:tier-scoping-storage';
  const run = await collectSnapshot(client, {
    reader: scopedReader({
      '/organization': ORG_OK,
      '/users?': ok([user(U1, 'ana@contoso.test')]),
      '/roleManagement/directory/roleAssignments': ok([assignment(U1)]),
    }),
    tenantRef, tenantId: 'fixture-tenant', tier: 'tier1',
  });
  const { rows } = await client.query(
    `SELECT resource_type, criticality FROM resource_version WHERE snapshot_id = $1`,
    [run.snapshotId],
  );
  assert.ok(rows.length > 0, 'the tier1 run stored something');
  assert.ok(rows.every((r) => r.criticality === 'tier1'), 'only tier1 resources are stored');
  assert.equal(rows.some((r) => r.resource_type === 'user'), false, 'the tier2 user is never stored');
  assert.deepEqual(run.coverageDigest.user, { outcome: 'not-requested', itemCount: null });
});

test('acceptance: cross-tier reproduction — a tier1 roleAssignment resolves its tier2 principal from persisted history, with zero calls to the tier2 endpoint', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:tier-scoping-repro';

  // A weekly (unscoped) run establishes the tier2 user's identity.
  await collectSnapshot(client, {
    reader: scopedReader({
      '/organization': ORG_OK,
      '/users?': ok([user(U1, 'ana@contoso.test')]),
      '/roleManagement/directory/roleAssignments': ok([assignment(U1)]),
    }),
    tenantRef, tenantId: 'fixture-tenant',
  });

  // The next hourly tier1 run's call log must contain no /users request at
  // all — the weekly update is already available to it through the
  // persisted identity context, not a live refetch.
  const calls = [];
  const run = await collectSnapshot(client, {
    reader: scopedReader({
      '/organization': ORG_OK,
      '/roleManagement/directory/roleAssignments': ok([assignment(U1)]),
    }, calls),
    tenantRef, tenantId: 'fixture-tenant', tier: 'tier1',
  });
  assert.equal(calls.some((p) => p.startsWith('/users')), false,
    'reader call log contains only requested-tier endpoints');
  const row = await roleAssignmentKey(client, run.snapshotId);
  assert.equal(row.natural_key, 'roleAssignment:global:GlobalAdministrator@user:ana@contoso.test@/',
    'the real user/roleDefinition/roleAssignment cross-tier reproduction: resolved via history, not a live tier2 fetch');
  assert.deepEqual(row.provenance.symbolContext.staleKeyParts, [U1]);
});

test('required mutation "remove cross-tier fallback": without persisted history, a cross-tier reference stays explicitly unresolved, never invented', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:tier-scoping-no-history';

  // No prior run: the tenant has no identity context at all. A tier1-only
  // run must not silently reach for the tier2 user to resolve the
  // reference — it stays unknown, exactly like an id never observed.
  const run = await collectSnapshot(client, {
    reader: scopedReader({
      '/organization': ORG_OK,
      '/roleManagement/directory/roleAssignments': ok([assignment(U1)]),
    }),
    tenantRef, tenantId: 'fixture-tenant', tier: 'tier1',
  });
  const row = await roleAssignmentKey(client, run.snapshotId);
  assert.equal(row.natural_key, `roleAssignment:global:GlobalAdministrator@unknown:${U1}@/`,
    'no cross-tier fallback exists without prior history — the id stays unresolved, never invented');
});

test('a later weekly update is available to the next hourly run', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:tier-scoping-weekly-then-hourly';

  // Weekly run 1: establishes the original identity.
  await collectSnapshot(client, {
    reader: scopedReader({
      '/organization': ORG_OK,
      '/users?': ok([user(U1, 'ana@contoso.test')]),
      '/roleManagement/directory/roleAssignments': ok([assignment(U1)]),
    }),
    tenantRef, tenantId: 'fixture-tenant',
  });

  // Hourly run 1 (tier1): resolves via the weekly identity.
  const hourly1 = await collectSnapshot(client, {
    reader: scopedReader({
      '/organization': ORG_OK,
      '/roleManagement/directory/roleAssignments': ok([assignment(U1)]),
    }),
    tenantRef, tenantId: 'fixture-tenant', tier: 'tier1',
  });
  const row1 = await roleAssignmentKey(client, hourly1.snapshotId);
  assert.equal(row1.natural_key, 'roleAssignment:global:GlobalAdministrator@user:ana@contoso.test@/');

  // Weekly run 2: the user is renamed.
  await collectSnapshot(client, {
    reader: scopedReader({
      '/organization': ORG_OK,
      '/users?': ok([user(U1, 'ana.renamed@contoso.test')]),
      '/roleManagement/directory/roleAssignments': ok([assignment(U1)]),
    }),
    tenantRef, tenantId: 'fixture-tenant',
  });

  // Hourly run 2 (tier1): the later weekly update is available to it.
  const hourly2 = await collectSnapshot(client, {
    reader: scopedReader({
      '/organization': ORG_OK,
      '/roleManagement/directory/roleAssignments': ok([assignment(U1)]),
    }),
    tenantRef, tenantId: 'fixture-tenant', tier: 'tier1',
  });
  const row2 = await roleAssignmentKey(client, hourly2.snapshotId);
  assert.equal(row2.natural_key, 'roleAssignment:global:GlobalAdministrator@user:ana.renamed@contoso.test@/',
    'a later weekly update is available to the next hourly run');

  // Historical snapshot 1 is never rewritten by the later run.
  const row1After = await roleAssignmentKey(client, hourly1.snapshotId);
  assert.equal(row1After.natural_key, row1.natural_key, 'historical snapshot keys are never rewritten by a later run');
});

test('no spurious delete/add drift from context metadata across consecutive tier1 runs', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:tier-scoping-no-drift';

  await collectSnapshot(client, {
    reader: scopedReader({
      '/organization': ORG_OK,
      '/users?': ok([user(U1, 'ana@contoso.test')]),
      '/roleManagement/directory/roleAssignments': ok([assignment(U1)]),
    }),
    tenantRef, tenantId: 'fixture-tenant',
  });

  const hourlyReader = () => scopedReader({
    '/organization': ORG_OK,
    '/roleManagement/directory/roleAssignments': ok([assignment(U1)]),
  });
  const runA = await collectSnapshot(client, {
    reader: hourlyReader(), tenantRef, tenantId: 'fixture-tenant', tier: 'tier1',
  });
  const runB = await collectSnapshot(client, {
    reader: hourlyReader(), tenantRef, tenantId: 'fixture-tenant', tier: 'tier1',
  });

  const rowsFor = async (snapshotId) => (await client.query(
    `SELECT natural_key, resource_type, payload_hash, hash_version, blast_radius
       FROM resource_version WHERE snapshot_id = $1 AND resource_type = 'roleAssignment'`,
    [snapshotId],
  )).rows;
  const drift = diffSnapshots(await rowsFor(runA.snapshotId), await rowsFor(runB.snapshotId));
  assert.deepEqual(drift, [],
    'two consecutive tier1 runs resolving the same historical context show zero drift');
});
