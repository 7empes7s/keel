// A create outside the policy-governed set posts a body projected through the
// server-owned classifier, never the raw collected snapshot. Reproduces the live
// test-tenant failure: a group, a namedLocation and a conditionalAccessPolicy
// whose snapshot payload still carries id, createdDateTime, @odata.context,
// securityIdentifier, assignedLicenses and onPremisesSyncEnabled were refused
// by Graph with 400 because those fields were posted as-is.
import { strict as assert } from 'node:assert';
import { applyWave } from './applyEngine.mjs';
import { ThrottleGovernor } from './throttleGovernor.mjs';

const SERVER_MANAGED = ['id', 'createdDateTime', 'modifiedDateTime', 'deletedDateTime', '@odata.context',
  'securityIdentifier', 'assignedLicenses', 'onPremisesSyncEnabled'];

// Behaves like Graph: a POST that carries a server-managed property is a 400;
// an accepted create is echoed back with the fields the server assigns.
function graphLikeWriter() {
  const calls = [];
  const created = new Map();
  return {
    calls,
    created,
    write: async (version, path, opts) => {
      calls.push({ kind: 'write', path, opts });
      if (path.endsWith('/assignLicense')) {
        const object = created.get(path.replace(/\/assignLicense$/, ''));
        object.assignedLicenses = opts.body.addLicenses.map(({ skuId, disabledPlans }) => ({ skuId, disabledPlans }));
        return { ok: true, status: 200, body: object };
      }
      const offending = SERVER_MANAGED.filter((field) => Object.hasOwn(opts.body ?? {}, field));
      if (offending.length > 0) {
        return { ok: false, status: 400, body: { error: { code: 'Request_BadRequest', message: `Property '${offending[0]}' is read-only and cannot be set.` } } };
      }
      const id = `new-${created.size + 1}`;
      const object = { ...opts.body, id, createdDateTime: '2026-10-12T00:00:00Z', '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#x' };
      if (path === '/groups') Object.assign(object, { securityIdentifier: 'S-1-12-1-9', onPremisesSyncEnabled: null, assignedLicenses: [] });
      created.set(`${path}/${id}`, object);
      return { ok: true, status: 201, body: object };
    },
    read: async (version, path) => {
      calls.push({ kind: 'read', path });
      const key = path.replace(/\?.*$/, '');
      const object = created.get(key);
      return object ? { ok: true, status: 200, body: object } : { ok: false, status: 404, body: null };
    },
  };
}

const governor = new ThrottleGovernor({ 'target/entra/write': { capacity: 100, refillPerSecond: 100 } });

const snapshotNoise = {
  '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#groups/$entity',
  id: 'source-object-id',
  createdDateTime: '2025-01-01T00:00:00Z',
  modifiedDateTime: '2025-02-01T00:00:00Z',
  deletedDateTime: null,
};

const group = { naturalKey: 'group:FIN-Admins', resourceType: 'group', blastRadius: 'access-affecting',
  payload: {
    ...snapshotNoise,
    displayName: 'Finance Admins', mailNickname: 'FIN-Admins', mailEnabled: false, securityEnabled: true, groupTypes: [],
    securityIdentifier: 'S-1-12-1-1', onPremisesSyncEnabled: false,
    assignedLicenses: [{ skuId: 'sku-e3', disabledPlans: ['plan-a'] }],
  } };
const namedLocation = { naturalKey: 'namedLocation:HQ', resourceType: 'namedLocation', blastRadius: 'tenant-lockout',
  payload: {
    ...snapshotNoise,
    '@odata.type': '#microsoft.graph.ipNamedLocation',
    displayName: 'HQ', isTrusted: true, ipRanges: [{ '@odata.type': '#microsoft.graph.iPv4CidrRange', cidrAddress: '203.0.113.0/24' }],
  } };
const caPolicy = { naturalKey: 'conditionalAccessPolicy:Block legacy', resourceType: 'conditionalAccessPolicy', blastRadius: 'tenant-lockout',
  payload: {
    ...snapshotNoise,
    displayName: 'Block legacy', state: 'enabledForReportingButNotEnforced', templateId: null,
    conditions: { users: { includeUsers: ['All'] }, applications: { includeApplications: ['All'] }, clientAppTypes: ['exchangeActiveSync', 'other'] },
    grantControls: { operator: 'OR', builtInControls: ['block'] },
  } };

const writer = graphLikeWriter();
const result = await applyWave(writer, governor, [group, namedLocation, caPolicy], { targetTenant: 'target', mode: 'enforce' });

assert.deepEqual(result.failed, [], `creates must not fail: ${JSON.stringify(result.failed)}`);
assert.deepEqual(result.skipped, []);
assert.equal(result.applied.length, 3);

const creates = writer.calls.filter((c) => c.kind === 'write' && !c.path.endsWith('/assignLicense'));
assert.deepEqual(creates.map((c) => c.path), ['/groups', '/identity/conditionalAccess/namedLocations', '/identity/conditionalAccess/policies']);
for (const { path, opts } of creates) {
  for (const field of SERVER_MANAGED) {
    assert.equal(Object.hasOwn(opts.body, field), false, `${path}: POST body must not carry ${field}`);
  }
}

// The writable and immutable fields are all still sent.
const [groupBody, locationBody, policyBody] = creates.map((c) => c.opts.body);
assert.deepEqual(groupBody, { displayName: 'Finance Admins', mailNickname: 'FIN-Admins', mailEnabled: false, securityEnabled: true, groupTypes: [] });
// @odata.type is what tells Graph which namedLocation subtype to create: kept.
assert.equal(locationBody['@odata.type'], '#microsoft.graph.ipNamedLocation');
assert.deepEqual(locationBody.ipRanges, namedLocation.payload.ipRanges);
assert.equal(locationBody.displayName, 'HQ');
assert.deepEqual(policyBody.conditions, caPolicy.payload.conditions);
assert.equal(policyBody.state, 'enabledForReportingButNotEnforced');
assert.equal(Object.hasOwn(policyBody, 'templateId'), false, 'templateId is server-owned for a policy');

// The group's licences still flow through assignLicense, add-only, after the create.
const licenceWrites = writer.calls.filter((c) => c.kind === 'write' && c.path.endsWith('/assignLicense'));
assert.equal(licenceWrites.length, 1);
assert.equal(licenceWrites[0].path, '/groups/new-1/assignLicense');
assert.deepEqual(licenceWrites[0].opts.body, { addLicenses: [{ skuId: 'sku-e3', disabledPlans: ['plan-a'] }], removeLicenses: [] });
assert.equal(result.applied.find((entry) => entry.naturalKey === 'group:FIN-Admins').targetId, 'new-1');

// A group without licences never touches assignLicense.
{
  const plain = graphLikeWriter();
  const { payload: { assignedLicenses, ...rest } } = group;
  const plainResult = await applyWave(plain, governor, [{ ...group, payload: rest }], { targetTenant: 'target', mode: 'enforce' });
  assert.deepEqual(plainResult.failed, []);
  assert.equal(plain.calls.filter((c) => c.path.endsWith('/assignLicense')).length, 0);
}
