import { strict as assert } from 'node:assert';
import { resolveSymbol, resolvePlan } from './resolver.mjs';

// Order per spec §8.2: exact match (1) beats a mapping-table override (2) beats
// prior-restore provenance (3) beats unresolved (4). Each branch below uses a
// DIFFERENT symbol so a step firing out of order changes which target id comes
// back, not just whether one comes back — a fixture that reused one symbol for
// two branches would prove nothing (feedback: fixtures must diverge).
const targetIndex = new Map([['group:FIN-Admins', 'target-id-exact']]);
const mappingTable = new Map([
  ['group:Legacy-VPN-Users', 'group:VPN-Legacy'], // maps to a symbol ALSO in targetIndex
  ['group:Orphaned', 'group:Nowhere'],             // maps to a symbol NOT in targetIndex
]);
const runProvenance = new Map([['group:Created-This-Run', 'target-id-provenance']]);
targetIndex.set('group:VPN-Legacy', 'target-id-mapped');

assert.deepEqual(resolveSymbol('group:FIN-Admins', { targetIndex, mappingTable, runProvenance }),
  { resolved: true, targetId: 'target-id-exact', via: 'exact-match' });
assert.deepEqual(resolveSymbol('group:Legacy-VPN-Users', { targetIndex, mappingTable, runProvenance }),
  { resolved: true, targetId: 'target-id-mapped', via: 'mapping-table' });
assert.deepEqual(resolveSymbol('group:Created-This-Run', { targetIndex, mappingTable, runProvenance }),
  { resolved: true, targetId: 'target-id-provenance', via: 'prior-restore' });
assert.equal(resolveSymbol('group:Orphaned', { targetIndex, mappingTable, runProvenance }).resolved, false);
assert.equal(resolveSymbol('group:Never-Seen', { targetIndex, mappingTable, runProvenance }).resolved, false);
// Global constants always resolve verbatim — never consult the target index.
assert.deepEqual(resolveSymbol('global:GlobalAdministrator', { targetIndex, mappingTable, runProvenance }),
  { resolved: true, targetId: 'global:GlobalAdministrator', via: 'global-constant' });
// null symbol = unresolvable at collection time (already known, not a lookup miss).
assert.equal(resolveSymbol(null, { targetIndex, mappingTable, runProvenance }).reason, 'unresolvable-at-collection');

// resolvePlan aggregates across resources and separates required vs optional.
const resources = [
  { naturalKey: 'conditionalAccessPolicy:X', references: [
    { field: 'a', symbol: 'group:FIN-Admins', required: true },
    { field: 'b', symbol: 'group:Never-Seen', required: true },
    { field: 'c', symbol: 'group:Never-Seen-2', required: false },
  ] },
];
const plan = resolvePlan(resources, { targetIndex, mappingTable, runProvenance });
assert.equal(plan.unresolved.length, 2);
assert.equal(plan.unresolved.filter((u) => u.required).length, 1);
assert.equal(plan.resolved[0].resolvedReferences[0].targetId, 'target-id-exact');

console.log('resolver.test.mjs — all assertions passed');
