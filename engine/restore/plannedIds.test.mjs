// A dry run plans objects it would create with placeholder ids, so a later
// write in the same run that references one plans cleanly (issue #726: an app
// recreated, then its service principal). Placeholders never reach a write.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { applyPatches, applyWave } from './applyEngine.mjs';
import { assertNoPlannedIds, isPlannedId, plannedId, recordPlannedCreates } from './plannedIds.mjs';
import { recordAppliedIds } from '../../cli/keel-restore.mjs';
import { previewApplyPlan } from '../reconcile/previewApplyPlan.mjs';

const governor = { async acquire() {}, observeRetryAfter() {} };

// A dry run never calls the writer; any call fails the test.
const noWriter = {
  async write(_version, path) { throw new Error(`a dry run must never write: ${path}`); },
  async read(_version, path) { throw new Error(`a dry run must never read through the writer: ${path}`); },
};

const app = {
  naturalKey: 'application:source-appid', resourceType: 'application', verb: 'create',
  payload: { displayName: 'Payroll connector', signInAudience: 'AzureADMyOrg', appId: 'source-appid', tags: [] },
  references: [], blastRadius: 'access-affecting',
};
const servicePrincipal = {
  naturalKey: 'servicePrincipal:source-appid', resourceType: 'servicePrincipal', verb: 'create',
  payload: { appId: 'source-appid', accountEnabled: true, appRoleAssignmentRequired: true, tags: [] },
  references: [], blastRadius: 'access-affecting',
};

test('a dry-run create records a placeholder id and its appId; nothing else does', () => {
  const ids = new Map();
  const wave = [
    app,
    { naturalKey: 'group:Kept', resourceType: 'group', verb: 'update' },
    { naturalKey: 'group:Same', resourceType: 'group', verb: 'noop' },
    { naturalKey: 'group:Unverbed', resourceType: 'group' },
  ];
  const applied = [
    { naturalKey: app.naturalKey, targetId: null },
    { naturalKey: 'group:Kept', targetId: 'live-kept' },
    { naturalKey: 'group:Same', targetId: null },
    { naturalKey: 'group:Unverbed', targetId: null },
  ];
  recordPlannedCreates(ids, applied, wave, 'enforce');
  assert.equal(ids.size, 0, 'an enforce run never records a placeholder');

  recordPlannedCreates(ids, applied, wave, 'dry-run');
  assert.deepEqual([...ids], [
    ['application:source-appid', 'planned:application:source-appid'],
    ['application:source-appid#appId', 'planned:application:source-appid#appId'],
    ['group:Unverbed', 'planned:group:Unverbed'],
  ], 'a resource with no verb is a create, as applyWave treats it');
  assert.ok(isPlannedId(ids.get('group:Unverbed')));
  assert.equal(plannedId('group:X'), 'planned:group:X');

  const known = new Map([['application:source-appid#appId', 'real-new-appid']]);
  recordPlannedCreates(known, applied.slice(0, 1), wave, 'dry-run');
  assert.equal(known.get('application:source-appid#appId'), 'real-new-appid', 'a known value is never replaced');
});

test('a dry run plans a service principal whose application this run creates (#726)', async () => {
  const appliedIds = new Map();
  const options = { targetTenant: 'fixture', mode: 'dry-run', appliedIds };

  const first = await applyWave(noWriter, governor, [app], options);
  assert.deepEqual(first.failed, []);
  assert.deepEqual(first.applied, [{ naturalKey: app.naturalKey, targetId: null }]);
  recordAppliedIds(appliedIds, first.applied);
  recordPlannedCreates(appliedIds, first.applied, [app], 'dry-run');

  const second = await applyWave(noWriter, governor, [servicePrincipal], options);
  assert.deepEqual(second.failed, [], 'the principal plans against the app the run creates');
  assert.deepEqual(second.applied, [{ naturalKey: servicePrincipal.naturalKey, targetId: null }]);

  // Before this change the same dry run failed the principal.
  const without = await applyWave(noWriter, governor, [servicePrincipal], { ...options, appliedIds: new Map() });
  assert.match(without.failed[0]?.error ?? '', /no appId known for application:source-appid/);
});

test('a dry run plans a deferred patch whose target this run creates, and reports no placeholder', async () => {
  const appliedIds = new Map([
    ['group:Child', 'planned:group:Child'],
    ['group:Parent', 'planned:group:Parent'],
  ]);
  const result = await applyPatches(noWriter, governor, [
    { naturalKey: 'group:Child', resourceType: 'group', field: 'parentGroupId', symbol: 'group:Parent' },
  ], { targetTenant: 'fixture', mode: 'dry-run', appliedIds });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.applied, [{ naturalKey: 'group:Child', targetId: null }]);
});

test('a placeholder never reaches an enforce write', async () => {
  const appliedIds = new Map([['application:source-appid#appId', 'planned:application:source-appid#appId']]);
  assert.doesNotThrow(() => assertNoPlannedIds(appliedIds, 'dry-run'));
  assert.throws(() => assertNoPlannedIds(appliedIds, 'enforce'), /dry-run placeholder/);

  await assert.rejects(
    applyWave(noWriter, governor, [servicePrincipal], { targetTenant: 'fixture', mode: 'enforce', appliedIds }),
    /refusing to write: application:source-appid#appId holds the dry-run placeholder/,
  );
  await assert.rejects(
    applyPatches(noWriter, governor, [
      { naturalKey: 'group:Child', resourceType: 'group', field: 'parentGroupId', symbol: 'group:Parent' },
    ], { targetTenant: 'fixture', mode: 'enforce', appliedIds: new Map([['group:Child', 'c'], ['group:Parent', 'planned:group:Parent']]) }),
    /dry-run placeholder/,
  );
});

test('the restore preview plans the same application and service principal without a refusal', async () => {
  const refusals = await previewApplyPlan({
    resources: [app, servicePrincipal],
    waves: [[app.naturalKey], [servicePrincipal.naturalKey]],
    deletionWaves: [], patches: [], existingTargetIds: new Map(),
    deletionGuardOptions: { breakGlassUserIds: [], keelAppIds: [], caPolicies: [] },
    targetTenant: 'fixture',
  });
  assert.deepEqual(refusals, []);
});
