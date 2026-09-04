// /opt/keel/engine/contract.test.mjs
import { strict as assert } from 'node:assert';
import { GraphWriter } from './restore/graphWriter.mjs';
import { resolvePlan } from './graph/resolver.mjs';
import { buildGapReport, isPlanClean } from './graph/preflight.mjs';
import { assertBreakGlassCoverage } from './safety/breakGlassInvariant.mjs';
import { refuseIfSynced } from './safety/syncedObjectGuard.mjs';
import { canonicalizeAll, NaturalKeyCollisionError } from './cir/canonicalize.mjs';

// 1. Mixed 200/429 batch -> partial failure, not success (§11.3).
globalThis.fetch = async () => ({
  ok: true, status: 200,
  json: async () => ({ responses: [{ id: '1', status: 200, body: {} }, { id: '2', status: 429, headers: { 'Retry-After': '5' }, body: {} }] }),
});
const batchResult = await new GraphWriter(async () => 'x').batch('v1.0', [
  { id: '1', method: 'POST', url: '/groups', body: {} }, { id: '2', method: 'POST', url: '/groups', body: {} },
]);
assert.equal(batchResult.ok, false, 'contract: mixed 200/429 batch must report partial failure');

// 2. Unresolved required symbol -> plan refuses to execute (§8.3).
const { unresolved } = resolvePlan(
  [{ naturalKey: 'x', references: [{ field: 'f', symbol: 'group:Missing', required: true }] }],
  { targetIndex: new Map(), mappingTable: new Map(), runProvenance: new Map() },
);
const report = buildGapReport({ resources: [{ naturalKey: 'x' }], unresolved });
assert.equal(isPlanClean(report), false, 'contract: a required unresolved symbol must make the plan not-clean');

// 3. Break-glass excluded from zero policies -> invariant fails, run must abort (§10.4).
const bg = assertBreakGlassCoverage({
  breakGlassUserIds: ['bg-1', 'bg-2'],
  caPoliciesInRestoreSet: [{ naturalKey: 'ca:X', conditions: { users: { excludeUsers: [] } } }],
});
assert.equal(bg.ok, false, 'contract: break-glass excluded from zero policies must fail the invariant');

// 4. Synced object in restore set -> refused (§10.6).
assert.equal(refuseIfSynced({ payload: { onPremisesSyncEnabled: true } }).refused, true,
  'contract: a synced object must be refused for cloud-side restore');

// 5. Natural-key collision at collection -> hard error (§6.1).
assert.throws(
  () => canonicalizeAll([['group', [
    { id: 'a', mailNickname: 'DUPE' }, { id: 'b', mailNickname: 'DUPE' },
  ]]]),
  NaturalKeyCollisionError,
  'contract: a natural-key collision at collection must be a hard error',
);

console.log('contract.test.mjs — all 5 spec §19.3 failure modes covered — all assertions passed');
