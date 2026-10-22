import { strict as assert } from 'node:assert';
import { ALWAYS_NEEDED_TYPES, collectM1, collectWithOutcomes, neededTypes, unavailableOnTenant, M1_TYPES, MISSING_PREREQUISITE } from './entraAdapter.mjs';
import { exitCodeForDigest } from '../../cli/keel-collect.mjs';
import { PARTIAL_EXIT_CODE, incompleteTypesOf } from './incomplete.mjs';
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

// Issue #466: Intune answers 501 NotSupported for a feature the tenant's
// service does not offer; nothing of that kind can exist, so it is unavailable.
const notSupported = { status: 501, code: 'NotSupported', error: 'An error has occurred - Operation ID (for customer support): 00000000-0000-0000-0000-000000000000' };
assert.equal(unavailableOnTenant(notSupported), true);
assert.equal(unavailableOnTenant({ status: 500, code: 'InternalServerError', error: 'An error has occurred' }), false);

// Without a needed set, any other failure still fails.
await assert.rejects(
  () => collectM1(reader([['/identity/apiConnectors', denied]])),
  /collecting identityApiConnector failed: Insufficient privileges/,
);

// Issue #466: with one, a type the caller does not need that fails any other
// way (a bad $select, a 400) is left out and listed on `unread`, never stored
// as an empty list. A restore of Intune settings no longer stops on it.
{
  const badSelect = { status: 400, code: 'BadRequest', error: "Could not find a property named 'x' on type 'microsoft.graph.vppToken'." };
  const failing = reader([
    ['/identity/apiConnectors', denied],
    ['/deviceAppManagement/vppTokens', badSelect],
    ['/deviceManagement/exchangeConnectors', notSupported],
  ]);
  const result = await collectM1(failing, { needed: new Set(['deviceCategory']) });
  const read = result.map(([type]) => type);
  assert.equal(read.includes('identityApiConnector'), false);
  assert.equal(read.includes('vppToken'), false);
  assert.equal(read.includes('deviceManagementExchangeConnector'), false);
  assert.ok(read.includes('deviceCategory'));
  assert.deepEqual(result.unread.map((entry) => entry.type).sort(), ['identityApiConnector', 'vppToken'],
    'a failed read is listed; an unavailable feature (501) is not a failure');
  assert.match(result.unread.find((entry) => entry.type === 'vppToken').error, /collecting vppToken failed: Could not find a property/);
  assert.deepEqual(Object.keys(result).filter((key) => !/^\d+$/.test(key)), [], 'unread is not an entry of the result');

  // A needed type that fails still fails, naming the type.
  await assert.rejects(() => collectM1(failing, { needed: new Set(['vppToken']) }), /collecting vppToken failed: Could not find a property/);

  // The types the restore's safety checks and role assignment keys rely on
  // always fail, needed or not.
  for (const [prefix, type] of [['/identity/conditionalAccess/policies', 'conditionalAccessPolicy'], ['/organization', 'organization'], ['/groups', 'group']]) {
    assert.ok(ALWAYS_NEEDED_TYPES.has(type), type);
    await assert.rejects(
      () => collectM1(reader([[prefix, denied]]), { needed: new Set(['deviceCategory']) }),
      new RegExp(`collecting ${type} failed: Insufficient privileges`),
    );
  }

  // A clean read lists nothing as unread.
  assert.deepEqual((await collectM1(reader([]), { needed: new Set(['group']) })).unread, []);
}

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

// A missing permission is still a failed type. The other types read in full, so
// the run is partial (exit 3, #447), never a clean exit 0, and the type is named.
{
  const { coverageDigest } = await collectWithOutcomes(reader([['/identity/apiConnectors', denied]]));
  assert.equal(coverageDigest.identityApiConnector.outcome, 'failed');
  assert.equal(exitCodeForDigest(coverageDigest), PARTIAL_EXIT_CODE);
  assert.deepEqual(incompleteTypesOf(coverageDigest), [{ type: 'identityApiConnector', outcome: 'failed', httpStatus: 403 }]);
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
  assert.equal(exitCodeForDigest(coverageDigest), PARTIAL_EXIT_CODE);
  assert.deepEqual(incompleteTypesOf(coverageDigest).map((entry) => entry.type), ['lifecycleWorkflow']);
}

// Issue #447: nothing read in full is still a failed run (exit 1), and a digest of
// only unavailable or out-of-tier types has no gaps.
assert.equal(exitCodeForDigest({ a: { outcome: 'failed', httpStatus: 400 }, b: { outcome: 'not-requested' } }), 1);
assert.equal(exitCodeForDigest({ a: { outcome: 'partial' }, b: { outcome: 'unavailable' } }), 1);
assert.equal(exitCodeForDigest({ a: { outcome: 'complete' }, b: { outcome: 'unavailable' }, c: { outcome: 'not-requested' } }), 0);
assert.equal(exitCodeForDigest({ a: { outcome: 'complete-empty' }, z: { outcome: 'failed', httpStatus: 400 }, m: { outcome: 'partial' } }), PARTIAL_EXIT_CODE);
assert.deepEqual(incompleteTypesOf({ a: { outcome: 'complete' }, z: { outcome: 'failed', httpStatus: 400 }, m: { outcome: 'partial' }, n: {} }), [
  { type: 'm', outcome: 'partial', httpStatus: null },
  { type: 'n', outcome: 'unknown', httpStatus: null },
  { type: 'z', outcome: 'failed', httpStatus: 400 },
]);
