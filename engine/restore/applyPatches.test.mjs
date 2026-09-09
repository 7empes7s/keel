import { strict as assert } from 'node:assert';
import { applyPatches, applyWave } from './applyEngine.mjs';
import { ThrottleGovernor } from './throttleGovernor.mjs';
import { phaseOneResources, planWaves } from './wavePlanner.mjs';

function fakeWriter({ readBody } = {}) {
  const writes = [];
  const reads = [];
  return {
    writes,
    reads,
    write: async (version, path, opts) => {
      writes.push({ version, path, opts });
      return { ok: true, status: 204, body: null };
    },
    read: async (version, path) => {
      reads.push({ version, path });
      return { ok: true, status: 200, body: typeof readBody === 'function' ? readBody() : readBody };
    },
  };
}

const governor = new ThrottleGovernor({ 'target/entra/write': { capacity: 100, refillPerSecond: 100 } });
const patch = {
  naturalKey: 'group:FIN-Admins', resourceType: 'group', field: 'parentGroupId',
  symbol: 'group:FIN-Parent', sourceValue: 'source-parent-id',
};
const appliedIds = new Map([
  ['group:FIN-Admins', 'group-id-1'],
  ['group:FIN-Parent', 'group-id-2'],
]);

// A resolved symbol PATCHes the resource that carries the deferred field, with
// the target resource's id as the field value and no other payload fields.
const writer = fakeWriter({ readBody: { parentGroupId: 'group-id-2' } });
const result = await applyPatches(writer, governor, [patch], {
  targetTenant: 'target', mode: 'enforce', appliedIds,
});
assert.equal(writer.writes.length, 1);
assert.equal(writer.reads.length, 1);
assert.deepEqual(writer.writes[0], {
  version: 'v1.0', path: '/groups/group-id-1',
  opts: { method: 'PATCH', body: { parentGroupId: 'group-id-2' } },
});
assert.equal(result.applied.length, 1);

// A missing symbol is reported rather than silently skipped, and is not an
// exception that would conceal the rest of the run's outcome.
const unresolvedResult = await applyPatches(fakeWriter(), governor, [
  { naturalKey: 'group:FIN-Admins', field: 'parentGroupId', symbol: 'group:Missing' },
], { targetTenant: 'target', mode: 'enforce', appliedIds });
assert.equal(unresolvedResult.failed.length, 1);
assert.equal(unresolvedResult.failed[0].reason, 'patch symbol group:Missing was never applied');

// Dry-run records the intended patch but performs no writes.
const dryWriter = fakeWriter();
const dryResult = await applyPatches(dryWriter, governor, [patch], {
  targetTenant: 'target', mode: 'dry-run', appliedIds,
});
assert.equal(dryWriter.writes.length, 0);
assert.equal(dryWriter.reads.length, 0);
assert.equal(dryResult.applied.length, 1);

// Dot-and-array paths become nested JSON rather than a literal dotted key.
// Conditional Access remains report-only even during the deferred phase.
const dottedPatch = {
  naturalKey: 'conditionalAccessPolicy:Protect-Admins', resourceType: 'conditionalAccessPolicy',
  field: 'conditions.users.excludeGroups[0]', symbol: 'group:FIN-Parent', sourceValue: 'source-parent-id',
};
const dottedAppliedIds = new Map([
  ['conditionalAccessPolicy:Protect-Admins', 'policy-id'],
  ['group:FIN-Parent', 'group-id-2'],
]);
const dottedWriter = fakeWriter({
  readBody: { conditions: { users: { excludeGroups: ['group-id-2'] } } },
});
const dottedResult = await applyPatches(dottedWriter, governor, [dottedPatch], {
  targetTenant: 'target', mode: 'enforce', appliedIds: dottedAppliedIds,
});
assert.deepEqual(dottedWriter.writes[0], {
  version: 'v1.0', path: '/identity/conditionalAccess/policies/policy-id',
  opts: {
    method: 'PATCH',
    body: {
      conditions: { users: { excludeGroups: ['group-id-2'] } },
      state: 'enabledForReportingButNotEnforced',
    },
  },
});
assert.equal(dottedResult.applied.length, 1);

// A known old source value is retried as read-after-write staleness. It is
// still a failed patch if it remains old after the bounded retries.
let staleReads = 0;
const staleWriter = fakeWriter({
  readBody: () => {
    staleReads += 1;
    return { parentGroupId: 'source-parent-id' };
  },
});
const staleResult = await applyPatches(staleWriter, governor, [patch], {
  targetTenant: 'target', mode: 'enforce', appliedIds,
  readAfterWriteOptions: { attempts: 2, delayMs: 0 },
});
assert.equal(staleReads, 2, 'the known old value must be retried');
assert.equal(staleResult.applied.length, 0);
assert.equal(staleResult.failed.length, 1, 'a 204 with a stale reread is not applied');

// An unexpected value is a real mismatch, not a staleness signature. A
// missing reference is retried as staleness, then failed if still missing.
let wrongReads = 0;
const wrongWriter = fakeWriter({
  readBody: () => {
    wrongReads += 1;
    return { parentGroupId: 'wrong-parent-id' };
  },
});
const wrongResult = await applyPatches(wrongWriter, governor, [patch], {
  targetTenant: 'target', mode: 'enforce', appliedIds,
  readAfterWriteOptions: { attempts: 2, delayMs: 0 },
});
assert.equal(wrongReads, 1);
assert.equal(wrongResult.failed.length, 1);

let missingReads = 0;
const missingWriter = fakeWriter({
  readBody: () => {
    missingReads += 1;
    return {};
  },
});
const missingResult = await applyPatches(missingWriter, governor, [patch], {
  targetTenant: 'target', mode: 'enforce', appliedIds,
  readAfterWriteOptions: { attempts: 2, delayMs: 0 },
});
assert.equal(missingReads, 2);
assert.equal(missingResult.failed.length, 1);

function merge(target, patchBody) {
  if (Array.isArray(target) || Array.isArray(patchBody)) return patchBody;
  if (!target || typeof target !== 'object' || !patchBody || typeof patchBody !== 'object') return patchBody;
  const result = { ...target };
  for (const [key, value] of Object.entries(patchBody)) result[key] = merge(target[key], value);
  return result;
}

// End-to-end synthetic cycle: phase one omits the policy-to-group edge,
// creates both symbols, then phase two restores and verifies that nested edge.
// All writer activity below is an in-memory fake.
const policy = {
  naturalKey: 'conditionalAccessPolicy:Protect-Admins', resourceType: 'conditionalAccessPolicy', restorePriority: 100,
  payload: {
    displayName: 'Protect Admins', state: 'enabled',
    conditions: { users: { excludeGroups: ['source-group-id'] } },
  },
  references: [{ field: 'conditions.users.excludeGroups[0]', symbol: 'group:Admins', required: true }],
};
const group = {
  naturalKey: 'group:Admins', resourceType: 'group', restorePriority: 100,
  payload: { displayName: 'Admins', mailNickname: 'admins', parentGroupId: 'source-policy-id' },
  references: [{ field: 'parentGroupId', symbol: 'conditionalAccessPolicy:Protect-Admins', required: true }],
};
const sourcePolicyPayload = structuredClone(policy.payload);
const { waves, patches } = planWaves([policy, group]);
assert.equal(patches.length, 1);
assert.equal(patches[0].field, 'conditions.users.excludeGroups[0]');

const bodies = new Map();
const cycleWriter = {
  writes: [],
  async write(version, path, opts) {
    this.writes.push({ version, path, opts });
    if (opts.method === 'POST') {
      const id = path === '/identity/conditionalAccess/policies' ? 'target-policy-id' : 'target-group-id';
      bodies.set(`${path}/${id}`, opts.body);
      return { ok: true, status: 201, body: { id } };
    }
    bodies.set(path, merge(bodies.get(path), opts.body));
    return { ok: true, status: 204, body: null };
  },
  async read(version, path) {
    return { ok: true, status: 200, body: bodies.get(path) };
  },
};
const provenance = new Map();
for (const waveKeys of waves) {
  const phaseOne = phaseOneResources(
    [policy, group].filter((resource) => waveKeys.includes(resource.naturalKey)),
    patches,
  );
  const phaseOnePolicy = phaseOne.find((resource) => resource.naturalKey === policy.naturalKey);
  if (phaseOnePolicy) {
    assert.equal(phaseOnePolicy.payload.conditions.users.excludeGroups[0], undefined, 'the deferred edge is absent in phase one');
    assert.equal(phaseOnePolicy.references.length, 0, 'the omitted edge cannot be rewritten during phase one');
    assert.deepEqual(policy.payload, sourcePolicyPayload, 'phase one must not mutate the source snapshot payload');
  }
  const waveResult = await applyWave(cycleWriter, governor, phaseOne, {
    targetTenant: 'target', mode: 'enforce', appliedIds: provenance,
  });
  assert.equal(waveResult.failed.length, 0, JSON.stringify(waveResult));
  for (const { naturalKey, targetId } of waveResult.applied) provenance.set(naturalKey, targetId);
}
assert.deepEqual([...provenance.keys()].sort(), [policy.naturalKey, group.naturalKey].sort());
const cycleResult = await applyPatches(cycleWriter, governor, patches, {
  targetTenant: 'target', mode: 'enforce', appliedIds: provenance,
});
assert.equal(cycleResult.failed.length, 0, JSON.stringify(cycleResult));
const deferredWrite = cycleWriter.writes.find(({ opts }) => opts.method === 'PATCH');
assert.deepEqual(deferredWrite.opts.body, {
  conditions: { users: { excludeGroups: ['target-group-id'] } },
  state: 'enabledForReportingButNotEnforced',
});
assert.equal(
  bodies.get('/identity/conditionalAccess/policies/target-policy-id').conditions.users.excludeGroups[0],
  'target-group-id',
);

console.log('applyPatches.test.mjs — all assertions passed');
