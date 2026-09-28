/**
 * Roadmap task-48 boundary tests: tenant-scoped historical identity context
 * for collection. Exercises the production canonicalizer, snapshot persistence
 * and symbol-context store against adversarial fixtures and the isolated test
 * database — including the three required mutation checks:
 *
 * - Skip persistent context in composed keys.
 * - Tombstone IDs after partial read.
 * - Drop tenant qualification.
 *
 * Plus three derived boundary cases a prior review found uncovered:
 * mixed-case Graph GUID resolution, a complete-empty enumeration tombstoning
 * previously live aliases with zero new observations of that type, and a
 * complete-empty read in the CURRENT run excluding its own stale context
 * before canonicalizing (no same-run resurrection of a genuinely deleted id).
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { collectSnapshot } from '../collect/snapshot.mjs';
import { loadSymbolContext, recordSymbolContext, seedSymbolContext } from '../store/resourceSymbols.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const GA_TEMPLATE = '62e90394-69f5-4237-9190-012177145e10'; // real Global Administrator template id
const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
const U3 = '33333333-3333-3333-3333-333333333333';
const U4 = '44444444-4444-4444-4444-444444444444';
const ORG = '99999999-9999-9999-9999-999999999999';
const RA1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const user = (id, upn) => ({ id, userPrincipalName: upn, onPremisesSyncEnabled: false });
const assignment = (principalId) => ({
  id: RA1, roleDefinitionId: GA_TEMPLATE, principalId, directoryScopeId: '/',
});

/** Fake GraphReader seam: path-prefix overrides, everything else complete-empty. */
function fakeReader(overrides = {}) {
  return {
    async collect(version, path) {
      for (const [prefix, result] of Object.entries(overrides)) {
        if (path.startsWith(prefix)) return typeof result === 'function' ? result() : result;
      }
      return { items: [], pages: 1, status: 200, error: null };
    },
  };
}

const ok = (items) => ({ items, pages: 1, status: 200, error: null });
const denied = { items: [], pages: 0, error: { status: 403, code: 'Error_AccessDenied', error: 'denied' } };
const ORG_OK = ok([{ id: ORG, displayName: 'Fixture Org' }]);

async function roleAssignmentRows(client, snapshotId) {
  const { rows } = await client.query(
    `SELECT natural_key, provenance FROM resource_version
      WHERE snapshot_id = $1 AND resource_type = 'roleAssignment'`,
    [snapshotId],
  );
  return rows;
}

async function referenceSymbols(client, snapshotId) {
  const { rows } = await client.query(
    `SELECT rr.field_path, rr.to_symbol FROM resource_reference rr
       JOIN resource_version rv ON rv.id = rr.from_version
      WHERE rv.snapshot_id = $1 AND rv.resource_type = 'roleAssignment'`,
    [snapshotId],
  );
  return new Map(rows.map((row) => [row.field_path, row.to_symbol]));
}

async function symbolRow(client, tenantRef, type, sourceId) {
  const { rows } = await client.query(
    `SELECT * FROM resource_symbol
      WHERE tenant_ref = $1 AND resource_type = $2 AND source_id = $3`,
    [tenantRef, type, sourceId],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------- in-memory composition

test('canonicalizeAll: persistent context resolves composed keys and references with stale provenance', () => {
  const context = new Map([[U1, { symbol: 'user:ana@contoso.test', type: 'user' }]]);
  const resources = canonicalizeAll([['roleAssignment', [assignment(U1)]]], { context });
  const ra = resources.find((r) => r.resourceType === 'roleAssignment');

  // Mutation pin (1): skipping the persistent context in composed keys would
  // degrade this to unknown:<guid> — the historical resolution must hold.
  assert.equal(ra.naturalKey, 'roleAssignment:global:GlobalAdministrator@user:ana@contoso.test@/');

  // Stale provenance is recorded on the provenance jsonb — separate from the
  // payload the semantic hash covers — and on the resolved reference itself.
  assert.deepEqual(ra.provenance.symbolContext.staleKeyParts, [U1]);
  assert.deepEqual(ra.provenance.symbolContext.staleReferences, ['principalId']);
  const principal = ra.references.find((r) => r.field === 'principalId');
  assert.equal(principal.symbol, 'user:ana@contoso.test');
  assert.equal(principal.stale, true);
  const role = ra.references.find((r) => r.field === 'roleDefinitionId');
  assert.equal(role.symbol, 'global:GlobalAdministrator');
  assert.equal(role.stale, undefined, 'global constants carry no staleness');
});

test('canonicalizeAll: unknown ids stay unknown, and the current batch overrides context', () => {
  // No context entry: the id stays unresolved exactly as before task-48.
  const withoutContext = canonicalizeAll([['roleAssignment', [assignment(U1)]]]);
  const unresolved = withoutContext.find((r) => r.resourceType === 'roleAssignment');
  assert.equal(unresolved.naturalKey, `roleAssignment:global:GlobalAdministrator@unknown:${U1}@/`);
  assert.equal(unresolved.provenance.symbolContext, undefined);

  // Context that disagrees with the batch loses: a fresh observation always
  // wins over history, and no staleness is recorded.
  const context = new Map([[U1, { symbol: 'user:stale-name@contoso.test', type: 'user' }]]);
  const withBatch = canonicalizeAll([
    ['user', [user(U1, 'ana@contoso.test')]],
    ['roleAssignment', [assignment(U1)]],
  ], { context });
  const resolved = withBatch.find((r) => r.resourceType === 'roleAssignment');
  assert.equal(resolved.naturalKey, 'roleAssignment:global:GlobalAdministrator@user:ana@contoso.test@/');
  assert.equal(resolved.provenance.symbolContext, undefined);
  assert.equal(resolved.references.find((r) => r.field === 'principalId').stale, undefined);
});

// ------------------------------------------------------------ DB integration
const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

async function freshSchema(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  return client;
}

test('reproduction: tier1 roleAssignment to tier2 user keeps its resolved key when context exists', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:symbol-context-repro';

  // Run A: full collection. The tier2 user and the tier1 roleAssignment are
  // both observed; the assignment resolves against the in-batch user.
  const runA = await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': ok([user(U1, 'ana@contoso.test')]),
      '/roleManagement/directory/roleAssignments': ok([assignment(U1)]),
    }),
    tenantRef, tenantId: 'fixture-tenant',
  });
  const keyA = (await roleAssignmentRows(client, runA.snapshotId))[0].natural_key;
  assert.equal(keyA, 'roleAssignment:global:GlobalAdministrator@user:ana@contoso.test@/');
  const aliasA = await symbolRow(client, tenantRef, 'user', U1);
  assert.equal(aliasA.natural_key, 'user:ana@contoso.test');
  assert.equal(aliasA.tombstoned_at, null);

  // Run B: the tier2 user read fails (403); the tier1 assignment read succeeds.
  // The persistent context keeps the original resolved key instead of
  // degrading to unknown:<guid>.
  const runB = await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': denied,
      '/roleManagement/directory/roleAssignments': ok([assignment(U1)]),
    }),
    tenantRef, tenantId: 'fixture-tenant',
  });
  assert.equal(runB.coverageDigest.user.outcome, 'failed');
  const [rowB] = await roleAssignmentRows(client, runB.snapshotId);
  assert.equal(rowB.natural_key, keyA, 'mutation pin (1): composed key uses the persistent context');
  assert.deepEqual(rowB.provenance.symbolContext.staleKeyParts, [U1]);
  assert.deepEqual(rowB.provenance.symbolContext.staleReferences, ['principalId']);
  const symbolsB = await referenceSymbols(client, runB.snapshotId);
  assert.equal(symbolsB.get('principalId'), 'user:ana@contoso.test',
    'the persisted reference resolves through the same fallback context');

  // Run C (rename): the same source id returns with a new UPN. The current
  // batch overrides the alias; the historical snapshot's key is never rewritten.
  const runC = await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': ok([user(U1, 'ana.renamed@contoso.test')]),
      '/roleManagement/directory/roleAssignments': ok([assignment(U1)]),
    }),
    tenantRef, tenantId: 'fixture-tenant',
  });
  const aliasC = await symbolRow(client, tenantRef, 'user', U1);
  assert.equal(aliasC.natural_key, 'user:ana.renamed@contoso.test', 'current batch overrides persistent context');
  assert.equal(aliasC.tombstoned_at, null);
  assert.equal((await roleAssignmentRows(client, runC.snapshotId))[0].natural_key,
    'roleAssignment:global:GlobalAdministrator@user:ana.renamed@contoso.test@/');
  assert.equal((await roleAssignmentRows(client, runA.snapshotId))[0].natural_key, keyA,
    'historical snapshot keys are never rewritten');
});

test('all tiers update context; tier-excluded types stay not-requested in storage', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:symbol-context-tiers';

  // A tier1 run stores only tier1 resources — the tier2 user is filtered out
  // of storage — but it was successfully read, so it still updates the
  // tenant's identity context.
  const run = await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': ok([user(U1, 'ana@contoso.test')]),
      '/roleManagement/directory/roleAssignments': ok([assignment(U1)]),
    }),
    tenantRef, tenantId: 'fixture-tenant', tier: 'tier1',
  });
  assert.deepEqual(run.coverageDigest.user, { outcome: 'not-requested', itemCount: null },
    'storage coverage keeps the not-requested marker');
  const { rows: storedUsers } = await client.query(
    `SELECT 1 FROM resource_version WHERE snapshot_id = $1 AND resource_type = 'user'`,
    [run.snapshotId],
  );
  assert.equal(storedUsers.length, 0, 'tier-excluded resources are not stored');
  const context = await loadSymbolContext(client, { tenantRef });
  assert.equal(context.get(U1)?.symbol, 'user:ana@contoso.test',
    'a tier-filtered run still records the identities it observed');
  assert.equal(context.get(RA1)?.symbol,
    'roleAssignment:global:GlobalAdministrator@user:ana@contoso.test@/');
});

test('tombstones: only a successful full enumeration may tombstone; failed/partial reads cannot', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:symbol-context-tombstone';
  const bothUsers = ok([user(U1, 'ana@contoso.test'), user(U2, 'bob@contoso.test')]);

  await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': bothUsers,
      '/roleManagement/directory/roleAssignments': ok([assignment(U2)]),
    }),
    tenantRef, tenantId: 'fixture-tenant',
  });
  assert.equal((await symbolRow(client, tenantRef, 'user', U2)).tombstoned_at, null);

  // A partial read observes U1 and then fails: it proves nothing about U2.
  const partial = await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': {
        items: [user(U1, 'ana@contoso.test')], pages: 1, status: 200, capped: true,
        error: { status: 500, code: 'Error_InternalServer', error: 'page 2 failed' },
      },
      '/roleManagement/directory/roleAssignments': ok([assignment(U2)]),
    }),
    tenantRef, tenantId: 'fixture-tenant',
  });
  assert.equal(partial.coverageDigest.user.outcome, 'partial');
  // Mutation pin (2): a partial read must never tombstone the ids it missed.
  assert.equal((await symbolRow(client, tenantRef, 'user', U2)).tombstoned_at, null,
    'mutation pin (2): partial reads cannot tombstone absent ids');
  assert.equal((await symbolRow(client, tenantRef, 'user', U2)).last_seen_at !== null, true);
  const afterPartial = await loadSymbolContext(client, { tenantRef });
  assert.equal(afterPartial.get(U2)?.symbol, 'user:bob@contoso.test',
    'the unobserved id still resolves after the partial read');
  const [partialRa] = await roleAssignmentRows(client, partial.snapshotId);
  assert.equal(partialRa.natural_key, 'roleAssignment:global:GlobalAdministrator@user:bob@contoso.test@/');

  // A successful full enumeration that no longer returns U2 tombstones it.
  const emptied = await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': ok([user(U1, 'ana@contoso.test')]),
      '/roleManagement/directory/roleAssignments': ok([assignment(U2)]),
    }),
    tenantRef, tenantId: 'fixture-tenant',
  });
  assert.equal(emptied.coverageDigest.user.outcome, 'complete');
  assert.notEqual((await symbolRow(client, tenantRef, 'user', U2)).tombstoned_at, null,
    'a complete enumeration tombstones the absent id');
  assert.equal((await symbolRow(client, tenantRef, 'user', U1)).tombstoned_at, null);

  // A tombstoned id never resolves again: the assignment degrades to unknown,
  // not to a resurrected historical identity.
  const [tombstonedRa] = await roleAssignmentRows(client, emptied.snapshotId);
  assert.equal(tombstonedRa.natural_key, `roleAssignment:global:GlobalAdministrator@unknown:${U2}@/`);
  assert.equal(await loadSymbolContext(client, { tenantRef }).then((c) => c.get(U2)), undefined);
});

test('complete-empty tombstones every previously live alias when a type is later observed empty', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:symbol-context-complete-empty-tombstone';
  const bothUsers = ok([user(U1, 'ana@contoso.test'), user(U2, 'bob@contoso.test')]);

  // Run A: both users observed and live.
  await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': bothUsers,
    }),
    tenantRef, tenantId: 'fixture-tenant',
  });
  assert.equal((await symbolRow(client, tenantRef, 'user', U1)).tombstoned_at, null);
  assert.equal((await symbolRow(client, tenantRef, 'user', U2)).tombstoned_at, null);

  // Run B: a successful full enumeration returns ZERO users — complete-empty,
  // never a failure. Every previously live user alias must be tombstoned,
  // even though this run observed no user ids of its own to diff against:
  // the tombstone pass must not skip a type just because nothing new was
  // observed for it.
  const runB = await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': ok([]),
    }),
    tenantRef, tenantId: 'fixture-tenant',
  });
  assert.equal(runB.coverageDigest.user.outcome, 'complete-empty');
  assert.notEqual((await symbolRow(client, tenantRef, 'user', U1)).tombstoned_at, null,
    'a complete-empty enumeration tombstones previously live aliases of that type');
  assert.notEqual((await symbolRow(client, tenantRef, 'user', U2)).tombstoned_at, null,
    'a complete-empty enumeration tombstones previously live aliases of that type');
  const context = await loadSymbolContext(client, { tenantRef });
  assert.equal(context.get(U1), undefined);
  assert.equal(context.get(U2), undefined);
});

test('a same-run complete-empty enumeration excludes its own stale context (no same-run resurrection)', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:symbol-context-complete-empty-same-run';
  const T1 = '55555555-5555-5555-5555-555555555555';
  const roleDef = { id: T1, displayName: 'Custom Helpdesk Role', isBuiltIn: false, rolePermissions: [] };
  const customAssignment = { id: RA1, roleDefinitionId: T1, principalId: U1, directoryScopeId: '/' };

  // Run A: the tenant roleDefinition exists and is referenced.
  await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': ok([user(U1, 'ana@contoso.test')]),
      '/roleManagement/directory/roleDefinitions': ok([roleDef]),
      '/roleManagement/directory/roleAssignments': ok([customAssignment]),
    }),
    tenantRef, tenantId: 'fixture-tenant',
  });
  const aliasBefore = await symbolRow(client, tenantRef, 'roleDefinition', T1);
  assert.equal(aliasBefore.natural_key, 'roleDefinition:Custom Helpdesk Role');

  // Run B: the roleDefinition is genuinely gone. A SUCCESSFUL full
  // enumeration observes zero roleDefinitions (complete-empty, not a
  // failure) — but Graph still returns the now-dangling assignment in the
  // same run. Because roleDefinition was fully and successfully
  // re-enumerated THIS run, its stale context entry must be excluded before
  // canonicalizing: the reference must degrade to unknown, never resurrect
  // the deleted role from history within the same run.
  const runB = await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': ok([user(U1, 'ana@contoso.test')]),
      '/roleManagement/directory/roleDefinitions': ok([]),
      '/roleManagement/directory/roleAssignments': ok([customAssignment]),
    }),
    tenantRef, tenantId: 'fixture-tenant',
  });
  assert.equal(runB.coverageDigest.roleDefinition.outcome, 'complete-empty');
  const [rowB] = await roleAssignmentRows(client, runB.snapshotId);
  assert.equal(rowB.natural_key, `roleAssignment:unknown:${T1}@user:ana@contoso.test@/`,
    'a same-run complete-empty enumeration must exclude its own stale context, not resurrect the deleted role');

  // The matching DB tombstone is written for later runs too.
  assert.notEqual((await symbolRow(client, tenantRef, 'roleDefinition', T1)).tombstoned_at, null);
});

test('mixed-case Graph GUIDs still resolve through history', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:symbol-context-mixed-case';
  const MIXED = 'AbCdEf12-3456-4789-9abc-def012345678';
  const mixedAssignment = { id: RA1, roleDefinitionId: GA_TEMPLATE, principalId: MIXED, directoryScopeId: '/' };

  // Run A: Graph returns the user id in mixed letter case (real Graph
  // responses do not guarantee consistent casing for the same GUID).
  await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': ok([user(MIXED, 'mixed@contoso.test')]),
    }),
    tenantRef, tenantId: 'fixture-tenant',
  });

  // Run B: the user read fails; the assignment references the same id.
  // Resolution must succeed regardless of letter case — both the alias
  // storage and every context lookup site normalize to lowercase.
  const runB = await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': denied,
      '/roleManagement/directory/roleAssignments': ok([mixedAssignment]),
    }),
    tenantRef, tenantId: 'fixture-tenant',
  });
  const [rowB] = await roleAssignmentRows(client, runB.snapshotId);
  assert.equal(rowB.natural_key, 'roleAssignment:global:GlobalAdministrator@user:mixed@contoso.test@/',
    'a mixed-case Graph GUID must resolve via history, not degrade to unknown');
});

test('name reuse: a reused UPN under a new source id is a distinct identity', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:symbol-context-reuse';

  await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': ok([user(U1, 'shared@contoso.test')]),
    }),
    tenantRef, tenantId: 'fixture-tenant',
  });

  // The old id disappears and a NEW id carries the same UPN: the new id gets
  // the name, the old id is tombstoned with its own history — never merged.
  await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': ok([user(U4, 'shared@contoso.test')]),
      '/roleManagement/directory/roleAssignments': ok([assignment(U4)]),
    }),
    tenantRef, tenantId: 'fixture-tenant',
  });
  const oldAlias = await symbolRow(client, tenantRef, 'user', U1);
  const newAlias = await symbolRow(client, tenantRef, 'user', U4);
  assert.notEqual(oldAlias.tombstoned_at, null, 'the disappeared id is tombstoned');
  assert.equal(newAlias.tombstoned_at, null);
  assert.equal(newAlias.natural_key, 'user:shared@contoso.test');
  const context = await loadSymbolContext(client, { tenantRef });
  assert.equal(context.get(U1), undefined, 'the tombstoned id no longer resolves');
  assert.equal(context.get(U4)?.symbol, 'user:shared@contoso.test');
});

test('tenant qualification: aliases never cross tenants (mutation pin 3)', async (t) => {
  const client = await freshSchema(t);
  const tenantA = 'sha256:symbol-context-tenant-a';
  const tenantB = 'sha256:symbol-context-tenant-b';

  // The same source id exists in both tenants with different identities;
  // U3 exists only in tenant A.
  await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': ok([user(U1, 'ana@a.test'), user(U3, 'only-a@a.test')]),
    }),
    tenantRef: tenantA, tenantId: 'fixture-tenant-a',
  });
  await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': ok([user(U1, 'bob@b.test')]),
    }),
    tenantRef: tenantB, tenantId: 'fixture-tenant-b',
  });

  // Mutation pin (3): dropping tenant qualification from the context load
  // would leak U3 into tenant B and confuse the shared id's identity.
  const contextB = await loadSymbolContext(client, { tenantRef: tenantB });
  assert.equal(contextB.get(U1)?.symbol, 'user:bob@b.test');
  assert.equal(contextB.has(U3), false, 'another tenant’s alias is never visible');

  // Mutation pin (3b): tenant B's user run above was a successful full
  // enumeration that observed only U1 — a complete enumeration tombstones
  // every previously live alias of that type IT DID NOT OBSERVE. U3 exists
  // only in tenant A and was never part of tenant B's batch. If the tombstone
  // UPDATE in recordSymbolContext dropped its `tenant_ref = $1` qualifier,
  // this same-type, cross-tenant UPDATE would match and tombstone tenant A's
  // U3 row too. Read the raw row directly (not through loadSymbolContext,
  // which has its own tenant filter) so this pins the UPDATE's qualifier
  // specifically.
  const aliasA3AfterB = await symbolRow(client, tenantA, 'user', U3);
  assert.equal(aliasA3AfterB.tombstoned_at, null,
    'mutation pin (3b): tenant B’s complete enumeration must never tombstone tenant A’s aliases');

  // Resolution under tenant B uses tenant B's identity for the shared id.
  const runB = await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': denied,
      '/roleManagement/directory/roleAssignments': ok([assignment(U1)]),
    }),
    tenantRef: tenantB, tenantId: 'fixture-tenant-b',
  });
  assert.equal((await roleAssignmentRows(client, runB.snapshotId))[0].natural_key,
    'roleAssignment:global:GlobalAdministrator@user:bob@b.test@/');

  // Tenant B's writes never mutate tenant A's aliases.
  const aliasA = await symbolRow(client, tenantA, 'user', U1);
  assert.equal(aliasA.natural_key, 'user:ana@a.test');

  // A tenant with no history has no bootstrap context: missing context stays
  // unresolved and can never invent an identity.
  const runC = await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': denied,
      '/roleManagement/directory/roleAssignments': ok([assignment(U1)]),
    }),
    tenantRef: 'sha256:symbol-context-tenant-c', tenantId: 'fixture-tenant-c',
  });
  assert.equal((await roleAssignmentRows(client, runC.snapshotId))[0].natural_key,
    `roleAssignment:global:GlobalAdministrator@unknown:${U1}@/`);
});

test('seeding: preexisting successful snapshots bootstrap the context without rewriting history', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:symbol-context-seed';

  // A legacy (pre-task-48) successful snapshot with stored user rows and a
  // bare-count digest entry — the shapes seedSymbolContext must consume.
  const { rows: [legacy] } = await client.query(
    `INSERT INTO snapshot (tenant_ref, started_at, completed_at, status, coverage_digest)
     VALUES ($1, '2026-09-10T10:00:00Z', '2026-09-10T10:05:00Z', 'complete', $2)
     RETURNING id`,
    [tenantRef, JSON.stringify({ user: 2, roleAssignment: 1 })],
  );
  await client.query(
    `INSERT INTO resource_version
       (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
     VALUES ($1, 'user:legacy@contoso.test', 'user', $2, 'legacyhash', 'tier2', 'access-affecting', 'read-only', '{}')`,
    [legacy.id, JSON.stringify({ id: U1, userPrincipalName: 'legacy@contoso.test' })],
  );

  // The seed itself: inserts the alias, rewrites nothing historical.
  const { seeded } = await seedSymbolContext(client, { tenantRef });
  assert.equal(seeded, 1);
  const seededRow = await symbolRow(client, tenantRef, 'user', U1);
  assert.equal(seededRow.natural_key, 'user:legacy@contoso.test');
  assert.equal(seededRow.source_snapshot, legacy.id);
  assert.equal(seededRow.tombstoned_at, null);

  // A fresh run with the user read failed resolves through the seeded context
  // — collectSnapshot seeds lazily when the context is empty.
  const tenant2 = 'sha256:symbol-context-seed-lazy';
  const { rows: [legacy2] } = await client.query(
    `INSERT INTO snapshot (tenant_ref, started_at, completed_at, status, coverage_digest)
     VALUES ($1, '2026-09-11T10:00:00Z', '2026-09-11T10:05:00Z', 'complete', $2)
     RETURNING id`,
    [tenant2, JSON.stringify({ user: { outcome: 'complete', itemCount: 1 } })],
  );
  await client.query(
    `INSERT INTO resource_version
       (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
     VALUES ($1, 'user:lazy@contoso.test', 'user', $2, 'legacyhash2', 'tier2', 'access-affecting', 'read-only', '{}')`,
    [legacy2.id, JSON.stringify({ id: U2, userPrincipalName: 'lazy@contoso.test' })],
  );
  const run = await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': denied,
      '/roleManagement/directory/roleAssignments': ok([assignment(U2)]),
    }),
    tenantRef: tenant2, tenantId: 'fixture-tenant',
  });
  assert.equal((await roleAssignmentRows(client, run.snapshotId))[0].natural_key,
    'roleAssignment:global:GlobalAdministrator@user:lazy@contoso.test@/',
    'collectSnapshot seeds missing bootstrap context from successful history');

  // Historical rows keep their stored keys exactly as collected.
  const { rows: historical } = await client.query(
    `SELECT natural_key FROM resource_version WHERE snapshot_id = ANY($1) ORDER BY natural_key`,
    [[legacy.id, legacy2.id]],
  );
  assert.deepEqual(historical.map((row) => row.natural_key), ['user:lazy@contoso.test', 'user:legacy@contoso.test']);

  // Seeding is retry-safe: a second seed changes nothing.
  assert.equal((await seedSymbolContext(client, { tenantRef })).seeded, 0);
});

test('template pollution: global template catalogues never enter the tenant identity context', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:symbol-context-template';
  // A real tenant roleDefinition whose id collides with a built-in template's
  // GUID — templates are global constants, not tenant identity.
  const T1 = '55555555-5555-5555-5555-555555555555';
  const roleDef = { id: T1, displayName: 'Custom Helpdesk Role', isBuiltIn: false, rolePermissions: [] };
  const template = { id: T1, displayName: 'Helpdesk Administrator' };
  const customAssignment = { id: RA1, roleDefinitionId: T1, principalId: U1, directoryScopeId: '/' };

  // Run A: everything succeeds, including the global template catalogue.
  await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': ok([user(U1, 'ana@contoso.test')]),
      '/roleManagement/directory/roleDefinitions': ok([roleDef]),
      '/roleManagement/directory/roleAssignments': ok([customAssignment]),
      '/directoryRoleTemplates': ok([template]),
    }),
    tenantRef, tenantId: 'fixture-tenant',
  });

  // Mutation pin (4): if sourceIdFor stopped excluding template types, the
  // catalogue's successful enumeration would persist a template alias under
  // the shared GUID and pollute the tenant's fallback identity context.
  const { rows: templateRows } = await client.query(
    `SELECT 1 FROM resource_symbol
      WHERE tenant_ref = $1 AND resource_type IN ('directoryRoleTemplate', 'directorySettingTemplate')`,
    [tenantRef],
  );
  assert.equal(templateRows.length, 0,
    'mutation pin (4): global template catalogues never write identity aliases');
  const roleDefAlias = await symbolRow(client, tenantRef, 'roleDefinition', T1);
  assert.equal(roleDefAlias.natural_key, 'roleDefinition:Custom Helpdesk Role');

  // Run B: the roleDefinition read fails; the assignment must fall back to the
  // TENANT roleDefinition's identity — never to the template's symbol.
  const runB = await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': ok([user(U1, 'ana@contoso.test')]),
      '/roleManagement/directory/roleDefinitions': denied,
      '/roleManagement/directory/roleAssignments': ok([customAssignment]),
      '/directoryRoleTemplates': ok([template]),
    }),
    tenantRef, tenantId: 'fixture-tenant',
  });
  assert.equal(runB.coverageDigest.roleDefinition.outcome, 'failed');
  const contextB = await loadSymbolContext(client, { tenantRef });
  assert.deepEqual(contextB.get(T1), { symbol: 'roleDefinition:Custom Helpdesk Role', type: 'roleDefinition' },
    'the shared GUID resolves to the tenant identity, not the template');
  const [rowB] = await roleAssignmentRows(client, runB.snapshotId);
  assert.equal(rowB.natural_key,
    'roleAssignment:roleDefinition:Custom Helpdesk Role@user:ana@contoso.test@/');
  assert.deepEqual(rowB.provenance.symbolContext.staleKeyParts, [T1]);
});

test('tombstone lifecycle: a re-observed id comes back live with its fresh identity', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:symbol-context-undelete';
  const bothUsers = ok([user(U1, 'ana@contoso.test'), user(U2, 'bob@contoso.test')]);

  // Run A: U2 observed and live.
  await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': bothUsers,
      '/roleManagement/directory/roleAssignments': ok([assignment(U2)]),
    }),
    tenantRef, tenantId: 'fixture-tenant',
  });

  // Run B: a successful full enumeration without U2 tombstones it.
  await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': ok([user(U1, 'ana@contoso.test')]),
      '/roleManagement/directory/roleAssignments': ok([assignment(U2)]),
    }),
    tenantRef, tenantId: 'fixture-tenant',
  });
  assert.notEqual((await symbolRow(client, tenantRef, 'user', U2)).tombstoned_at, null);
  assert.equal(await loadSymbolContext(client, { tenantRef }).then((c) => c.get(U2)), undefined);

  // Run C: U2 returns (undeleted, under a new UPN). The current batch
  // overrides the tombstone: the id resolves again with its FRESH identity.
  const runC = await collectSnapshot(client, {
    reader: fakeReader({
      '/organization': ORG_OK,
      '/users?': ok([user(U1, 'ana@contoso.test'), user(U2, 'bob.undeleted@contoso.test')]),
      '/roleManagement/directory/roleAssignments': ok([assignment(U2)]),
    }),
    tenantRef, tenantId: 'fixture-tenant',
  });
  const aliasC = await symbolRow(client, tenantRef, 'user', U2);
  // Mutation pin (5): without clearing tombstoned_at on re-observation, the
  // undeleted id would stay tombstoned forever and never resolve again.
  assert.equal(aliasC.tombstoned_at, null,
    'mutation pin (5): re-observation clears the tombstone');
  assert.equal(aliasC.natural_key, 'user:bob.undeleted@contoso.test',
    'the rename is recorded on the same alias row');
  assert.equal((await loadSymbolContext(client, { tenantRef })).get(U2)?.symbol,
    'user:bob.undeleted@contoso.test');
  const [rowC] = await roleAssignmentRows(client, runC.snapshotId);
  assert.equal(rowC.natural_key,
    'roleAssignment:global:GlobalAdministrator@user:bob.undeleted@contoso.test@/');
  assert.equal(rowC.provenance.symbolContext, undefined,
    'a current-batch observation carries no staleness provenance');
});

test('seeding order: the newest successful snapshot identity wins per type', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:symbol-context-seed-order';

  // Two pre-task-48 snapshots: the id was renamed between them. Both are
  // successful observations of the same type.
  const insertLegacy = async (completedAt, naturalKey, upn) => {
    const { rows: [snap] } = await client.query(
      `INSERT INTO snapshot (tenant_ref, started_at, completed_at, status, coverage_digest)
       VALUES ($1, $2, $2, 'complete', $3)
       RETURNING id`,
      [tenantRef, completedAt, JSON.stringify({ user: { outcome: 'complete', itemCount: 1 } })],
    );
    await client.query(
      `INSERT INTO resource_version
         (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, 'user', $3, 'legacyhash', 'tier2', 'access-affecting', 'read-only', '{}')`,
      [snap.id, naturalKey, JSON.stringify({ id: U1, userPrincipalName: upn })],
    );
    return snap.id;
  };
  const olderId = await insertLegacy('2026-09-10T10:05:00Z', 'user:before-rename@contoso.test', 'before-rename@contoso.test');
  const newerId = await insertLegacy('2026-09-11T10:05:00Z', 'user:after-rename@contoso.test', 'after-rename@contoso.test');

  const { seeded } = await seedSymbolContext(client, { tenantRef });
  assert.equal(seeded, 1, 'one alias row for the one observed source id');
  const seededRow = await symbolRow(client, tenantRef, 'user', U1);
  // Mutation pin (6): seeding oldest-first would cover the type with the
  // stale pre-rename identity and skip the newest snapshot entirely.
  assert.equal(seededRow.natural_key, 'user:after-rename@contoso.test',
    'mutation pin (6): the newest snapshot identity wins, not the stale pre-rename one');
  assert.equal(seededRow.source_snapshot, newerId);
  assert.notEqual(seededRow.source_snapshot, olderId);
});

test('recordSymbolContext: only successful type outcomes write aliases', async () => {
  const tenantRef = 'sha256:symbol-context-outcomes';
  const client = await database.connect();
  try {
    await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
    const { rows: [snap] } = await client.query(
      `INSERT INTO snapshot (tenant_ref, status) VALUES ($1, 'complete') RETURNING id`,
      [tenantRef],
    );
    const resources = [
      { resourceType: 'group', sourceId: U2, naturalKey: 'group:fin-admins' },
      { resourceType: 'roleAssignment', sourceId: RA1, naturalKey: 'roleAssignment:k' },
    ];
    // complete-empty observes zero live ids, so there are no user resources to
    // record. group partial and roleAssignment failed prove nothing: nothing
    // about them may be written at all.
    await recordSymbolContext(client, {
      tenantRef, snapshotId: snap.id, resources,
      coverageDigest: {
        user: { outcome: 'complete-empty', itemCount: 0 },
        group: { outcome: 'partial', itemCount: 1 },
        roleAssignment: { outcome: 'failed', itemCount: null },
      },
    });
    assert.equal(await symbolRow(client, tenantRef, 'user', U1), null,
      'complete-empty observes zero live ids and writes no alias');
    assert.equal(await symbolRow(client, tenantRef, 'group', U2), null,
      'a partial outcome never writes aliases');
    assert.equal(await symbolRow(client, tenantRef, 'roleAssignment', RA1), null,
      'a failed outcome never writes aliases');
  } finally {
    await client.end();
  }
});
