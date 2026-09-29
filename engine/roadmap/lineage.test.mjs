/**
 * Roadmap task-50 boundary tests: stable resource lineage across rename and
 * recovery. Exercises the production resourceLineage.mjs store against the
 * isolated test database, plus its consumption by diffSnapshots.mjs,
 * engine/graph/resolver.mjs and engine/cir/canonicalize.mjs — including the
 * three required mutation checks:
 *
 * - Merge resources solely by reused name.
 * - Resolve expired alias as current.
 * - Drop recovery provenance requirement.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { diffSnapshots } from '../govern/diffSnapshots.mjs';
import { resolveSymbol, resolvePlan } from '../graph/resolver.mjs';
import {
  recordLineage,
  tombstoneMissingLineages,
  currentLineageFor,
  naturalKeyAsOf,
  resolveNaturalKey,
  recordRecovery,
  recoveryChainFor,
  loadRecoveryContext,
} from '../store/resourceLineage.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const GA_TEMPLATE = '62e90394-69f5-4237-9190-012177145e10'; // real Global Administrator template id
const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
const RA1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const assignment = (principalId) => ({
  id: RA1, roleDefinitionId: GA_TEMPLATE, principalId, directoryScopeId: '/',
});

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

async function freshSchema(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  return client;
}

// ------------------------------------------------------- rename preserves lineage

test('recordLineage: a same source-id rename preserves the lineage id and closes the old alias', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:lineage-rename';
  const t1 = new Date('2026-01-01T00:00:00Z');
  const t2 = new Date('2026-01-02T00:00:00Z');

  const first = await recordLineage(client, {
    tenantRef, resourceType: 'group', sourceId: U1, naturalKey: 'group:before-rename', observedAt: t1,
  });
  const renamed = await recordLineage(client, {
    tenantRef, resourceType: 'group', sourceId: U1, naturalKey: 'group:after-rename', observedAt: t2,
  });

  assert.equal(renamed.lineageId, first.lineageId, 'the same source id never gets a new lineage row');
  assert.equal(renamed.renamed, true);

  const current = await currentLineageFor(client, { tenantRef, resourceType: 'group', sourceId: U1 });
  assert.equal(current.natural_key, 'group:after-rename');
  assert.equal(current.tombstoned_at, null);

  // Acceptance: a historical snapshot still resolves its then-current identity.
  assert.equal(await naturalKeyAsOf(client, { lineageId: first.lineageId, asOf: new Date('2026-01-01T12:00:00Z') }),
    'group:before-rename');
  assert.equal(await naturalKeyAsOf(client, { lineageId: first.lineageId, asOf: new Date('2026-01-03T00:00:00Z') }),
    'group:after-rename');

  // Mutation pin: an expired (closed) alias must never resolve as the CURRENT
  // one. It still resolves (this lineage is the only one that ever held the
  // old name) but is explicitly reported stale.
  const staleLookup = await resolveNaturalKey(client, { tenantRef, resourceType: 'group', naturalKey: 'group:before-rename' });
  assert.deepEqual(staleLookup, { resolved: true, lineageId: first.lineageId, stale: true },
    'mutation pin: resolving an expired alias must report stale: true, never current');
  const liveLookup = await resolveNaturalKey(client, { tenantRef, resourceType: 'group', naturalKey: 'group:after-rename' });
  assert.deepEqual(liveLookup, { resolved: true, lineageId: first.lineageId, stale: false });

  // A no-op re-observation under the same name changes nothing.
  const noop = await recordLineage(client, {
    tenantRef, resourceType: 'group', sourceId: U1, naturalKey: 'group:after-rename', observedAt: t2,
  });
  assert.equal(noop.renamed, false);
});

test('diffSnapshots: a rename (same lineage) yields one modified entry, never removed+added', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:lineage-diff-rename';

  const before = await recordLineage(client, {
    tenantRef, resourceType: 'group', sourceId: U1, naturalKey: 'group:old-name',
    observedAt: new Date('2026-02-01T00:00:00Z'),
  });
  await recordLineage(client, {
    tenantRef, resourceType: 'group', sourceId: U1, naturalKey: 'group:new-name',
    observedAt: new Date('2026-02-02T00:00:00Z'),
  });

  const baselineRows = [
    { natural_key: 'group:old-name', resource_type: 'group', payload_hash: 'h1', hash_version: 1, blast_radius: 'access-affecting' },
  ];
  const observedRows = [
    { natural_key: 'group:new-name', resource_type: 'group', payload_hash: 'h1', hash_version: 1, blast_radius: 'access-affecting' },
  ];
  const lineageByKey = new Map([
    ['group:old-name', before.lineageId],
    ['group:new-name', before.lineageId],
  ]);
  const drift = diffSnapshots(baselineRows, observedRows, { lineageOf: (row) => lineageByKey.get(row.natural_key) });

  assert.equal(drift.length, 1, 'acceptance: rename yields ONE resource history, not a removed+added pair');
  assert.deepEqual(drift[0], {
    naturalKey: 'group:new-name',
    resourceType: 'group',
    changeType: 'modified',
    beforeHash: 'h1',
    afterHash: 'h1',
    blastRadius: 'access-affecting',
    renamedFrom: 'group:old-name',
    lineageId: before.lineageId,
  });

  // Without a lineage lookup at all, the original (pre-task-50) behavior is
  // unchanged: a rename looks like an ordinary removed+added pair.
  const legacy = diffSnapshots(baselineRows, observedRows);
  assert.equal(legacy.length, 2);
  assert.deepEqual(legacy.map((d) => d.changeType).sort(), ['added', 'removed']);
});

// -------------------------------------------------- unrelated name reuse never merges

test('diffSnapshots: unrelated name reuse under a new source id never merges (mutation pin: reused-name merge)', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:lineage-name-reuse';

  const alice = await recordLineage(client, {
    tenantRef, resourceType: 'group', sourceId: U1, naturalKey: 'group:alice',
    observedAt: new Date('2026-03-01T00:00:00Z'),
  });
  await tombstoneMissingLineages(client, { tenantRef, resourceType: 'group', observedSourceIds: [], observedAt: new Date('2026-03-02T00:00:00Z') });
  const clone = await recordLineage(client, {
    tenantRef, resourceType: 'group', sourceId: U2, naturalKey: 'group:alice-clone',
    observedAt: new Date('2026-03-03T00:00:00Z'),
  });
  assert.notEqual(clone.lineageId, alice.lineageId, 'a brand-new source id always starts a brand-new lineage');

  const baselineRows = [
    { natural_key: 'group:alice', resource_type: 'group', payload_hash: 'h1', hash_version: 1, blast_radius: 'access-affecting' },
  ];
  const observedRows = [
    { natural_key: 'group:alice-clone', resource_type: 'group', payload_hash: 'h2', hash_version: 1, blast_radius: 'access-affecting' },
  ];
  const lineageByKey = new Map([
    ['group:alice', alice.lineageId],
    ['group:alice-clone', clone.lineageId],
  ]);
  const drift = diffSnapshots(baselineRows, observedRows, { lineageOf: (row) => lineageByKey.get(row.natural_key) });

  // Mutation pin: "Merge resources solely by reused name" — a candidate
  // removed+added pair must NEVER be collapsed unless lineage ids actually
  // match. Two genuinely different lineages must stay two separate entries.
  assert.equal(drift.length, 2,
    'mutation pin: unrelated lineages must never be merged into one rename entry');
  assert.deepEqual(drift.map((d) => d.changeType).sort(), ['added', 'removed']);
  assert.equal(drift.some((d) => 'renamedFrom' in d), false);
});

test('diffSnapshots: rows with unknown (falsy) lineage on both sides are never merged into a false rename (mutation pin: dropped unknown-lineage guard)', () => {
  const baselineRows = [
    { natural_key: 'group:old-unrelated', resource_type: 'group', payload_hash: 'h1', hash_version: 1, blast_radius: 'access-affecting' },
  ];
  const observedRows = [
    { natural_key: 'group:new-unrelated', resource_type: 'group', payload_hash: 'h2', hash_version: 1, blast_radius: 'access-affecting' },
  ];
  // The caller's lineageOf genuinely does not know either row's lineage (e.g.
  // a resource type task-50 never tracks) and returns undefined for both.
  // Mutation pin: without the `if (!beforeLineage) continue;` guard,
  // `lineageOf(after) === beforeLineage` (undefined === undefined) would be
  // true, silently collapsing two unrelated rows into one false 'modified'
  // (renamed) entry purely because neither side's lineage is known.
  const drift = diffSnapshots(baselineRows, observedRows, { lineageOf: () => undefined });

  assert.equal(drift.length, 2,
    'mutation pin: rows with unknown lineage on both sides must never be merged into a rename');
  assert.deepEqual(drift.map((d) => d.changeType).sort(), ['added', 'removed']);
  assert.equal(drift.some((d) => 'renamedFrom' in d), false);
});

test('diffSnapshots: the SAME natural key reused by a different lineage splits into removed+added, never a false modified', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:lineage-same-key-reuse';

  const first = await recordLineage(client, {
    tenantRef, resourceType: 'group', sourceId: U1, naturalKey: 'group:shared-name',
    observedAt: new Date('2026-04-01T00:00:00Z'),
  });
  const second = await recordLineage(client, {
    tenantRef, resourceType: 'group', sourceId: U2, naturalKey: 'group:shared-name-collision-source',
    observedAt: new Date('2026-04-02T00:00:00Z'),
  });
  assert.notEqual(first.lineageId, second.lineageId);

  // Both rows happen to carry the identical natural_key text (a coincidental
  // collision this diff window must never treat as one resource's history).
  const baselineRows = [
    { natural_key: 'group:shared-name', resource_type: 'group', payload_hash: 'before', hash_version: 1, blast_radius: 'access-affecting' },
  ];
  const observedRows = [
    { natural_key: 'group:shared-name', resource_type: 'group', payload_hash: 'after', hash_version: 1, blast_radius: 'access-affecting' },
  ];
  const drift = diffSnapshots(baselineRows, observedRows, {
    lineageOf: (row) => (row.payload_hash === 'before' ? first.lineageId : second.lineageId),
  });

  assert.equal(drift.length, 2, 'a same-key, different-lineage collision must split into removed+added');
  const removed = drift.find((d) => d.changeType === 'removed');
  const added = drift.find((d) => d.changeType === 'added');
  assert.equal(removed.beforeHash, 'before');
  assert.equal(added.afterHash, 'after');

  // Without lineage information the plain natural-key diff (unchanged from
  // before task 50) would have silently reported this as one 'modified' row.
  const legacy = diffSnapshots(baselineRows, observedRows);
  assert.deepEqual(legacy, [{
    naturalKey: 'group:shared-name', resourceType: 'group', changeType: 'modified',
    beforeHash: 'before', afterHash: 'after', blastRadius: 'access-affecting',
  }]);
});

// ------------------------------------------------------------- ambiguous alias

test('resolveNaturalKey: an alias two distinct tombstoned lineages both held is ambiguous and refuses', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:lineage-ambiguous';

  await recordLineage(client, { tenantRef, resourceType: 'group', sourceId: U1, naturalKey: 'group:bob' });
  await tombstoneMissingLineages(client, { tenantRef, resourceType: 'group', observedSourceIds: [] });
  await recordLineage(client, { tenantRef, resourceType: 'group', sourceId: U2, naturalKey: 'group:bob' });
  await tombstoneMissingLineages(client, { tenantRef, resourceType: 'group', observedSourceIds: [] });

  const lookup = await resolveNaturalKey(client, { tenantRef, resourceType: 'group', naturalKey: 'group:bob' });
  assert.deepEqual(lookup, { resolved: false, reason: 'ambiguous-alias' },
    'acceptance: ambiguous alias refuses target resolution instead of guessing');
});

test('resolver.mjs: an ambiguous lineage entry refuses; an unambiguous one resolves stale, never as fresh as prior-restore', () => {
  const targetIndex = new Map();
  const mappingTable = new Map();
  const runProvenance = new Map([['group:fresh', 'target-id-fresh']]);
  const lineage = new Map([
    ['group:ambiguous-name', { ambiguous: true }],
    ['group:recovered', { targetId: 'target-id-recovered' }],
    ['group:fresh', { targetId: 'target-id-wrong-if-used' }], // must never be consulted: prior-restore wins first
  ]);

  assert.deepEqual(
    resolveSymbol('group:ambiguous-name', { targetIndex, mappingTable, runProvenance, lineage }),
    { resolved: false, reason: 'ambiguous-alias' },
  );
  assert.deepEqual(
    resolveSymbol('group:recovered', { targetIndex, mappingTable, runProvenance, lineage }),
    { resolved: true, targetId: 'target-id-recovered', via: 'lineage-recovery', stale: true },
  );
  // Resolution order is unchanged: prior-restore still outranks lineage.
  assert.deepEqual(
    resolveSymbol('group:fresh', { targetIndex, mappingTable, runProvenance, lineage }),
    { resolved: true, targetId: 'target-id-fresh', via: 'prior-restore' },
  );
  // No lineage map at all: fully backward compatible with pre-task-50 callers.
  assert.equal(resolveSymbol('group:recovered', { targetIndex, mappingTable, runProvenance }).resolved, false);

  const plan = resolvePlan(
    [{ naturalKey: 'x', references: [{ field: 'a', symbol: 'group:ambiguous-name', required: true }] }],
    { targetIndex, mappingTable, runProvenance, lineage },
  );
  assert.equal(plan.unresolved[0].reason, 'ambiguous-alias');
});

// ---------------------------------------------------------- recovery provenance

test('recordRecovery: requires evidence, distinct lineages and a tombstoned predecessor (mutation pin: dropped provenance requirement)', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:lineage-recovery-guards';

  const predecessor = await recordLineage(client, { tenantRef, resourceType: 'group', sourceId: U1, naturalKey: 'group:old' });
  const successor = await recordLineage(client, { tenantRef, resourceType: 'group', sourceId: U2, naturalKey: 'group:new' });

  // Mutation pin: recording a recovery link without evidence must be refused.
  await assert.rejects(
    () => recordRecovery(client, {
      tenantRef, predecessorLineageId: predecessor.lineageId, successorLineageId: successor.lineageId,
      evidence: {}, recordedBy: 'operator@example.test',
    }),
    /resource-lineage-recovery-requires-evidence/,
    'mutation pin: dropping the evidence requirement must not silently succeed',
  );
  await assert.rejects(
    () => recordRecovery(client, {
      tenantRef, predecessorLineageId: predecessor.lineageId, successorLineageId: successor.lineageId,
      evidence: null, recordedBy: 'operator@example.test',
    }),
    /resource-lineage-recovery-requires-evidence/,
  );

  // A live (non-tombstoned) predecessor cannot be "recovered from" — it has not gone anywhere.
  await assert.rejects(
    () => recordRecovery(client, {
      tenantRef, predecessorLineageId: predecessor.lineageId, successorLineageId: successor.lineageId,
      evidence: { restoreRunId: 'run-1' }, recordedBy: 'operator@example.test',
    }),
    /resource-lineage-recovery-predecessor-not-tombstoned/,
  );

  await tombstoneMissingLineages(client, { tenantRef, resourceType: 'group', observedSourceIds: [U2] });

  await assert.rejects(
    () => recordRecovery(client, {
      tenantRef, predecessorLineageId: predecessor.lineageId, successorLineageId: predecessor.lineageId,
      evidence: { restoreRunId: 'run-1' }, recordedBy: 'operator@example.test',
    }),
    /resource-lineage-recovery-requires-distinct-lineages/,
  );

  // With real evidence and a tombstoned predecessor, the link succeeds.
  const { recoveryId } = await recordRecovery(client, {
    tenantRef, predecessorLineageId: predecessor.lineageId, successorLineageId: successor.lineageId,
    evidence: { restoreRunId: 'run-1', matchedBy: 'admin-attestation' }, recordedBy: 'operator@example.test',
  });
  assert.ok(recoveryId);

  const chain = await recoveryChainFor(client, { tenantRef, lineageId: successor.lineageId });
  assert.deepEqual(chain, [successor.lineageId, predecessor.lineageId]);
});

test('recordRecovery: refuses a predecessor or successor lineage that belongs to a different tenant (mutation pin: cross-tenant recovery link)', async (t) => {
  const client = await freshSchema(t);
  const tenantA = 'sha256:lineage-recovery-tenant-a';
  const tenantB = 'sha256:lineage-recovery-tenant-b';

  const aPredecessor = await recordLineage(client, { tenantRef: tenantA, resourceType: 'group', sourceId: U1, naturalKey: 'group:a-old' });
  await tombstoneMissingLineages(client, { tenantRef: tenantA, resourceType: 'group', observedSourceIds: [] });
  const aSuccessor = await recordLineage(client, { tenantRef: tenantA, resourceType: 'group', sourceId: U2, naturalKey: 'group:a-new' });

  const bPredecessor = await recordLineage(client, { tenantRef: tenantB, resourceType: 'group', sourceId: U1, naturalKey: 'group:b-old' });
  await tombstoneMissingLineages(client, { tenantRef: tenantB, resourceType: 'group', observedSourceIds: [] });
  const bSuccessor = await recordLineage(client, { tenantRef: tenantB, resourceType: 'group', sourceId: U2, naturalKey: 'group:b-new' });

  // Mutation pin: a caller authenticated as tenant B must never be able to link
  // tenant A's predecessor lineage into a recovery — the row id exists, but it
  // belongs to someone else's tenant.
  await assert.rejects(
    () => recordRecovery(client, {
      tenantRef: tenantB, predecessorLineageId: aPredecessor.lineageId, successorLineageId: bSuccessor.lineageId,
      evidence: { restoreRunId: 'cross-tenant-1' }, recordedBy: 'operator@example.test',
    }),
    /resource-lineage-recovery-unknown-predecessor/,
    'mutation pin: dropping the tenant filter on the predecessor lookup must not silently succeed',
  );

  // Same for the successor side: tenant B must never be able to declare
  // tenant A's lineage its own successor.
  await assert.rejects(
    () => recordRecovery(client, {
      tenantRef: tenantB, predecessorLineageId: bPredecessor.lineageId, successorLineageId: aSuccessor.lineageId,
      evidence: { restoreRunId: 'cross-tenant-2' }, recordedBy: 'operator@example.test',
    }),
    /resource-lineage-recovery-unknown-successor/,
    'mutation pin: dropping the tenant filter on the successor lookup must not silently succeed',
  );

  // The same-tenant link still succeeds — this isn't a blanket refusal.
  const { recoveryId } = await recordRecovery(client, {
    tenantRef: tenantB, predecessorLineageId: bPredecessor.lineageId, successorLineageId: bSuccessor.lineageId,
    evidence: { restoreRunId: 'same-tenant' }, recordedBy: 'operator@example.test',
  });
  assert.ok(recoveryId);
});

test("recoveryChainFor: never walks into another tenant's recovery row, even when its successor_id matches (mutation pin: dropped tenant_ref filter)", async (t) => {
  const client = await freshSchema(t);
  const tenantA = 'sha256:lineage-chain-tenant-a';
  const tenantB = 'sha256:lineage-chain-tenant-b';

  const la = await recordLineage(client, { tenantRef: tenantA, resourceType: 'group', sourceId: U1, naturalKey: 'group:a-only' });
  const lb = await recordLineage(client, { tenantRef: tenantB, resourceType: 'group', sourceId: U2, naturalKey: 'group:b-only' });

  // A forged/corrupted recovery row belonging to tenant B whose successor_id
  // happens to be tenant A's lineage id — this must never be constructible
  // through recordRecovery's own tenant guards (see the test above), but
  // recoveryChainFor must independently refuse to walk it even if such a row
  // exists, e.g. from a bug elsewhere or a compromised writer.
  await client.query(
    `INSERT INTO resource_lineage_recovery (tenant_ref, predecessor_id, successor_id, evidence, recorded_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantB, lb.lineageId, la.lineageId, JSON.stringify({ forged: true }), 'attacker@example.test'],
  );

  const chain = await recoveryChainFor(client, { tenantRef: tenantA, lineageId: la.lineageId });
  assert.deepEqual(chain, [la.lineageId],
    "mutation pin: dropping the tenant_ref filter on recoveryChainFor must not silently succeed — it must never return tenant B's lineage");
});

test("loadRecoveryContext: never returns another tenant's recovery-linked symbol, even under a colliding source id (mutation pin: cross-tenant recovery leak)", async (t) => {
  const client = await freshSchema(t);
  const tenantA = 'sha256:lineage-context-tenant-a';
  const tenantB = 'sha256:lineage-context-tenant-b';

  // Both tenants happen to use the SAME source id for their own predecessor —
  // a tenant-blind query would let one tenant's row overwrite the other's
  // entry in the returned map, keyed only by that shared source id.
  const aPredecessor = await recordLineage(client, { tenantRef: tenantA, resourceType: 'user', sourceId: U1, naturalKey: 'user:a-old@contoso.test' });
  await tombstoneMissingLineages(client, { tenantRef: tenantA, resourceType: 'user', observedSourceIds: [] });
  const aSuccessor = await recordLineage(client, { tenantRef: tenantA, resourceType: 'user', sourceId: U2, naturalKey: 'user:a-new@contoso.test' });
  await recordRecovery(client, {
    tenantRef: tenantA, predecessorLineageId: aPredecessor.lineageId, successorLineageId: aSuccessor.lineageId,
    evidence: { restoreRunId: 'tenant-a-run' }, recordedBy: 'operator@example.test',
  });

  const bPredecessor = await recordLineage(client, { tenantRef: tenantB, resourceType: 'user', sourceId: U1, naturalKey: 'user:b-old@fabrikam.test' });
  await tombstoneMissingLineages(client, { tenantRef: tenantB, resourceType: 'user', observedSourceIds: [] });
  const bSuccessor = await recordLineage(client, { tenantRef: tenantB, resourceType: 'user', sourceId: U2, naturalKey: 'user:b-new@fabrikam.test' });
  await recordRecovery(client, {
    tenantRef: tenantB, predecessorLineageId: bPredecessor.lineageId, successorLineageId: bSuccessor.lineageId,
    evidence: { restoreRunId: 'tenant-b-run' }, recordedBy: 'operator@example.test',
  });

  const contextA = await loadRecoveryContext(client, { tenantRef: tenantA });
  assert.deepEqual(contextA.get(U1), { symbol: 'user:a-new@contoso.test', type: 'user' },
    "mutation pin: dropping the tenant filter must not let tenant B's recovery for the same source id win");
  assert.equal(contextA.size, 1, "tenant A's context must only ever contain its own recovery links");

  const contextB = await loadRecoveryContext(client, { tenantRef: tenantB });
  assert.deepEqual(contextB.get(U1), { symbol: 'user:b-new@fabrikam.test', type: 'user' });
  assert.equal(contextB.size, 1, "tenant B's context must only ever contain its own recovery links");
});

test('canonicalizeAll: a recovery-linked predecessor id resolves through the recovery context, marked stale', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:lineage-canonicalize-recovery';

  const predecessor = await recordLineage(client, { tenantRef, resourceType: 'user', sourceId: U1, naturalKey: 'user:ana@contoso.test' });
  await tombstoneMissingLineages(client, { tenantRef, resourceType: 'user', observedSourceIds: [] });
  const successor = await recordLineage(client, { tenantRef, resourceType: 'user', sourceId: U2, naturalKey: 'user:ana.rebuilt@contoso.test' });
  await recordRecovery(client, {
    tenantRef, predecessorLineageId: predecessor.lineageId, successorLineageId: successor.lineageId,
    evidence: { restoreRunId: 'run-42' }, recordedBy: 'operator@example.test',
  });

  const lineageContext = await loadRecoveryContext(client, { tenantRef });
  assert.deepEqual(lineageContext.get(U1), { symbol: 'user:ana.rebuilt@contoso.test', type: 'user' });

  // The roleAssignment references the OLD (predecessor) guid — neither in the
  // current batch nor in task-48's plain (non-tombstoned) context — resolving
  // only through the recovery-linked lineage fallback.
  const resources = canonicalizeAll([['roleAssignment', [assignment(U1)]]], { lineage: lineageContext });
  const ra = resources.find((r) => r.resourceType === 'roleAssignment');
  assert.equal(ra.naturalKey, 'roleAssignment:global:GlobalAdministrator@user:ana.rebuilt@contoso.test@/');
  assert.deepEqual(ra.provenance.symbolContext.staleKeyParts, [U1]);
  assert.deepEqual(ra.provenance.symbolContext.staleReferences, ['principalId']);
  const principal = ra.references.find((r) => r.field === 'principalId');
  assert.equal(principal.symbol, 'user:ana.rebuilt@contoso.test');
  assert.equal(principal.stale, true);

  // task-48's plain `context` still takes priority over the recovery fallback
  // when both would resolve the same guid (current/live identity wins).
  const liveContext = new Map([[U1, { symbol: 'user:still-live@contoso.test', type: 'user' }]]);
  const withBothContexts = canonicalizeAll([['roleAssignment', [assignment(U1)]]], { context: liveContext, lineage: lineageContext });
  const raBoth = withBothContexts.find((r) => r.resourceType === 'roleAssignment');
  assert.equal(raBoth.naturalKey, 'roleAssignment:global:GlobalAdministrator@user:still-live@contoso.test@/');
});

// -------------------------------------------------------- tombstone semantics

test('tombstoneMissingLineages: only lineages absent from the observed set are tombstoned, and re-observation clears it', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:lineage-tombstone';

  await recordLineage(client, { tenantRef, resourceType: 'group', sourceId: U1, naturalKey: 'group:stays' });
  const gone = await recordLineage(client, { tenantRef, resourceType: 'group', sourceId: U2, naturalKey: 'group:goes' });

  const { tombstoned } = await tombstoneMissingLineages(client, { tenantRef, resourceType: 'group', observedSourceIds: [U1] });
  assert.equal(tombstoned, 1);

  const staysRow = await currentLineageFor(client, { tenantRef, resourceType: 'group', sourceId: U1 });
  assert.equal(staysRow.tombstoned_at, null);
  const goesRow = await currentLineageFor(client, { tenantRef, resourceType: 'group', sourceId: U2 });
  assert.notEqual(goesRow.tombstoned_at, null);

  // Re-observation (undelete) clears the tombstone, exactly like resource_symbol.
  const revived = await recordLineage(client, { tenantRef, resourceType: 'group', sourceId: U2, naturalKey: 'group:goes-again' });
  assert.equal(revived.lineageId, gone.lineageId);
  const revivedRow = await currentLineageFor(client, { tenantRef, resourceType: 'group', sourceId: U2 });
  assert.equal(revivedRow.tombstoned_at, null);
  assert.equal(revivedRow.natural_key, 'group:goes-again');
});

console.log('lineage.test.mjs — all assertions passed');
