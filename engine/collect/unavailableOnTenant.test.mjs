import { strict as assert } from 'node:assert';
import { collectM1, collectWithOutcomes, neededTypes, unavailableOnTenant, M1_TYPES, MISSING_PREREQUISITE } from './entraAdapter.mjs';
import { exitCodeForDigest } from '../../cli/keel-collect.mjs';
import { snapshotHasFullCoverage } from '../schedules/completions.mjs';

// Issue #289: the tenant answers lifecycle workflows with a licence refusal and
// API connectors with a feature-not-enabled refusal, on every read.
const licence = { status: 403, code: 'Forbidden', error: 'Insufficient license to complete this operation. User workflows require an Entra ID Governance license.' };
const signUp = { status: 400, code: 'AADB2C99039', error: 'Self service sign up is not enabled for the tenant.' };
const denied = { status: 403, code: 'Authorization_RequestDenied', error: 'Insufficient privileges to complete the operation.' };

assert.equal(unavailableOnTenant(licence), true);
assert.equal(unavailableOnTenant(signUp), true);
assert.equal(unavailableOnTenant({ status: 400, error: 'AADB2C99039: self service sign up is not enabled' }), true);
assert.equal(unavailableOnTenant(denied), false, 'a missing permission is a failure, not an unavailable type');
assert.equal(unavailableOnTenant({ status: 500, error: 'Insufficient license' }), false);
assert.equal(unavailableOnTenant(null), false);

const reader = (failures) => ({
  async collect(version, path) {
    for (const [prefix, error] of failures) {
      if (path.startsWith(prefix)) return { items: [], pages: 0, status: error.status, error };
    }
    if (path.startsWith('/organization')) return { items: [{ id: '00000000-0000-0000-0000-000000000001' }], pages: 1, status: 200, error: null };
    return { items: [], pages: 1, status: 200, error: null };
  },
});
const unlicensed = reader([
  ['/identityGovernance/lifecycleWorkflows/', licence],
  ['/identity/apiConnectors', signUp],
]);
// lifecyclePolicy (batch 8) sits under the same unlicensed lifecycle workflows path.
const skipped = ['lifecycleWorkflow', 'lifecycleWorkflowCustomTaskExtension', 'lifecycleManagementSettings', 'identityApiConnector', 'lifecyclePolicy'];

// Without a needed set, collectM1 stays fail-fast on any failed type.
await assert.rejects(() => collectM1(unlicensed), /collecting lifecycleWorkflow failed: Insufficient license/);

// With one, an unavailable type the caller does not need is left out (not read,
// never an empty list), and every other type is still read.
const collected = await collectM1(unlicensed, { needed: new Set(['conditionalAccessPolicy', 'group']) });
const types = collected.map(([type]) => type);
assert.deepEqual(types, M1_TYPES.filter((type) => !skipped.includes(type)));

// A needed type that is unavailable still fails, naming the type.
await assert.rejects(
  () => collectM1(unlicensed, { needed: new Set(['lifecycleWorkflow']) }),
  /collecting lifecycleWorkflow failed: Insufficient license/,
);

// Any other failure still fails, needed or not.
await assert.rejects(
  () => collectM1(reader([['/identity/apiConnectors', denied]]), { needed: new Set(['group']) }),
  /collecting identityApiConnector failed: Insufficient privileges/,
);

// neededTypes reads canonical resources and stored rows alike, plus extra types.
assert.deepEqual(
  [...neededTypes([{ resourceType: 'group' }, { resource_type: 'namedLocation' }, { resourceType: 'group' }, {}], ['roleAssignment'])].sort(),
  ['group', 'namedLocation', 'roleAssignment'],
);
assert.deepEqual([...neededTypes(undefined)], []);

// Issue #309: a snapshot collection records each type the tenant has no licence
// or feature for as unavailable, with its reason, and the run still exits 0.
{
  const { collected, coverageDigest } = await collectWithOutcomes(unlicensed);
  for (const type of skipped) {
    assert.equal(coverageDigest[type].outcome, 'unavailable', type);
    assert.equal(coverageDigest[type].reason, MISSING_PREREQUISITE);
    assert.equal(coverageDigest[type].itemCount, null, 'an unavailable type is never an invented zero');
  }
  assert.equal(coverageDigest.lifecycleWorkflow.httpStatus, 403);
  assert.equal(coverageDigest.identityApiConnector.graphCode, 'AADB2C99039');
  assert.equal(collected.some(([type]) => skipped.includes(type)), false, 'an unavailable type is not stored as read');
  assert.equal(coverageDigest.group.outcome, 'complete-empty');
  assert.equal(exitCodeForDigest(coverageDigest), 0);
  assert.equal(snapshotHasFullCoverage({ status: 'complete', coverage_digest: coverageDigest }), true);
}

// A missing permission is still a failed type and a failed run.
{
  const { coverageDigest } = await collectWithOutcomes(reader([['/identity/apiConnectors', denied]]));
  assert.equal(coverageDigest.identityApiConnector.outcome, 'failed');
  assert.equal(exitCodeForDigest(coverageDigest), 1);
  assert.equal(snapshotHasFullCoverage({ status: 'complete', coverage_digest: coverageDigest }), false);
}

// A licence refusal after a page was read is a partial read, which still fails.
{
  const midway = {
    async collect(version, path) {
      if (path.startsWith('/identityGovernance/lifecycleWorkflows/workflows')) return { items: [{ id: 'w1' }], pages: 1, status: 403, error: licence };
      if (path.startsWith('/organization')) return { items: [{ id: '00000000-0000-0000-0000-000000000001' }], pages: 1, status: 200, error: null };
      return { items: [], pages: 1, status: 200, error: null };
    },
  };
  const { coverageDigest } = await collectWithOutcomes(midway);
  assert.equal(coverageDigest.lifecycleWorkflow.outcome, 'partial');
  assert.equal(exitCodeForDigest(coverageDigest), 1);
}
