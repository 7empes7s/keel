import { strict as assert } from 'node:assert';
import {
  assertSelectionClosed,
  dependencyClosure,
  selectionGuardRefusals,
} from './selection.mjs';

function res(naturalKey, refs, extra = {}) {
  return {
    naturalKey,
    resourceType: naturalKey.split(':')[0],
    restorePriority: 100,
    payload: {},
    references: refs,
    ...extra,
  };
}

// Fixture: a Conditional Access policy that excludes a group, which in turn has a
// parent group — selecting the policy must pull in BOTH, transitively.
const caPolicy = res('conditionalAccessPolicy:Protect-Admins', [
  { field: 'conditions.users.excludeGroups[0]', symbol: 'group:Admins', required: true },
  { field: 'conditions.applications.includeApplications[0]', symbol: 'global:Office365', required: true },
]);
const adminsGroup = res('group:Admins', [
  { field: 'parentGroupId', symbol: 'group:Parent', required: true },
]);
const parentGroup = res('group:Parent', []);
const unrelated = res('group:Unrelated', []);
const candidates = [caPolicy, adminsGroup, parentGroup, unrelated];

// --- the closure pulls in direct and transitive dependencies, with reasons ---
{
  const closure = dependencyClosure(candidates, ['conditionalAccessPolicy:Protect-Admins']);
  assert.deepEqual(closure.selected, ['conditionalAccessPolicy:Protect-Admins']);
  assert.deepEqual(
    closure.keys,
    ['conditionalAccessPolicy:Protect-Admins', 'group:Admins', 'group:Parent'],
    'the closure must include the referenced group AND its transitive parent',
  );
  assert.deepEqual(
    closure.resources.map((r) => r.naturalKey),
    closure.keys,
    'the resource list is the closure, sorted by natural key',
  );

  const addedGroup = closure.added.find((a) => a.naturalKey === 'group:Admins');
  assert.deepEqual(
    addedGroup.reasons,
    [{ requiredBy: 'conditionalAccessPolicy:Protect-Admins', field: 'conditions.users.excludeGroups[0]' }],
    'an addition must name the requiring resource and the field path',
  );
  const addedParent = closure.added.find((a) => a.naturalKey === 'group:Parent');
  assert.deepEqual(
    addedParent.reasons,
    [{ requiredBy: 'group:Admins', field: 'parentGroupId' }],
    'a transitive addition must name its immediate requirer',
  );
  assert.ok(
    !closure.added.some((a) => a.naturalKey === 'conditionalAccessPolicy:Protect-Admins'),
    'an explicitly selected resource is never reported as added',
  );
}

// --- global: references never pull anything in (they always resolve, spec §6.1) ---
{
  const closure = dependencyClosure(candidates, ['conditionalAccessPolicy:Protect-Admins']);
  assert.ok(
    !closure.keys.some((key) => key.startsWith('global:')),
    'a global constant must not enter the closure',
  );
  assert.ok(
    !closure.unresolvedReferences.some((u) => u.symbol.startsWith('global:')),
    'a global constant is not an unresolved reference either',
  );
}

// --- out-of-set references are reported, never silently dropped ---
{
  const dangling = res('conditionalAccessPolicy:Dangling', [
    { field: 'conditions.users.includeUsers[0]', symbol: 'user:deleted-account', required: true },
  ]);
  const closure = dependencyClosure([...candidates, dangling], ['conditionalAccessPolicy:Dangling']);
  assert.deepEqual(
    closure.unresolvedReferences,
    [{ from: 'conditionalAccessPolicy:Dangling', field: 'conditions.users.includeUsers[0]', symbol: 'user:deleted-account' }],
    'an unresolvable reference must be surfaced with its source and field',
  );
  assert.deepEqual(closure.keys, ['conditionalAccessPolicy:Dangling']);
}

// --- an already-closed selection adds nothing ---
{
  const closure = dependencyClosure(candidates, [
    'conditionalAccessPolicy:Protect-Admins', 'group:Admins', 'group:Parent',
  ]);
  assert.deepEqual(closure.added, []);
  assert.deepEqual(assertSelectionClosed(candidates, closure.selected), []);
}

// --- assertSelectionClosed lists exactly the missing requirements, with reasons ---
{
  const missing = assertSelectionClosed(candidates, ['conditionalAccessPolicy:Protect-Admins']);
  assert.deepEqual(
    missing.map((m) => m.naturalKey),
    ['group:Admins', 'group:Parent'],
    'the deselect-refusal case must name every required-but-excluded resource',
  );
  assert.deepEqual(
    missing.find((m) => m.naturalKey === 'group:Admins').reasons,
    [{ requiredBy: 'conditionalAccessPolicy:Protect-Admins', field: 'conditions.users.excludeGroups[0]' }],
    'the refusal reason names the requiring resource and field',
  );
}

// --- a resource required by two selections carries both requirers ---
{
  const secondPolicy = res('conditionalAccessPolicy:Block-Legacy', [
    { field: 'conditions.users.excludeGroups[0]', symbol: 'group:Admins', required: true },
  ]);
  const closure = dependencyClosure(
    [...candidates, secondPolicy],
    ['conditionalAccessPolicy:Block-Legacy', 'conditionalAccessPolicy:Protect-Admins'],
  );
  const addedGroup = closure.added.find((a) => a.naturalKey === 'group:Admins');
  assert.deepEqual(
    addedGroup.reasons.map((r) => r.requiredBy),
    ['conditionalAccessPolicy:Block-Legacy', 'conditionalAccessPolicy:Protect-Admins'],
    'every requirer must be recorded, sorted deterministically',
  );
}

// --- a selected key absent from the candidate set fails loudly ---
{
  assert.throws(
    () => dependencyClosure(candidates, ['group:Does-Not-Exist']),
    /selected key is not present in the candidate set: group:Does-Not-Exist/,
  );
}

// --- inputs are never mutated ---
{
  const frozen = candidates.map((r) => Object.freeze({ ...r, references: Object.freeze([...r.references]) }));
  dependencyClosure(frozen, ['conditionalAccessPolicy:Protect-Admins']);
}

// --- a synced resource is refused at selection time with the guard's reason ---
{
  const synced = res('group:Synced', [], { payload: { onPremisesSyncEnabled: true } });
  const cloud = res('group:Cloud', [], { payload: { onPremisesSyncEnabled: false } });
  const closure = dependencyClosure([...candidates, synced, cloud], ['group:Synced', 'group:Cloud']);
  const refusals = selectionGuardRefusals(closure.resources);
  assert.deepEqual(
    refusals,
    [{
      naturalKey: 'group:Synced',
      reason: 'onPremisesSyncEnabled=true — source of authority is on-premises Active Directory, cloud-side restore is refused',
    }],
    'the synced-object guard refusal must surface at selection time',
  );
}

console.log('selection.test.mjs — all assertions passed');
