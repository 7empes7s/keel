// Live operator run Q45 (2026-10-13, test tenant): three writes that landed were
// recorded as uncertain because post-write verification compared what Graph
// sets on its own. A group created and a Conditional Access policy created read
// back with server-assigned fields, OData annotations (including
// `authenticationStrength@odata.context`, which embeds the new policy's id) and
// uncaptured properties as null; a group restored from deleted items read back
// with `expirationDateTime`, `renewedDateTime` and `securityIdentifier` it never
// had in the snapshot. Verification must ignore all of that and still fail when
// a written value reads back different.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { applyWave } from './applyEngine.mjs';
import { ThrottleGovernor } from './throttleGovernor.mjs';
import { verificationView } from '../reconcile/writableProjection.mjs';

const governor = new ThrottleGovernor({ 'target/entra/write': { capacity: 100, refillPerSecond: 100 } });

// What GET /groups/{id} returns without $select: the full default projection,
// server-assigned values, and every property the object does not use as null.
function groupReadBack(id, written) {
  return {
    '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#groups/$entity',
    id,
    deletedDateTime: null,
    classification: null,
    createdDateTime: '2026-10-13T13:24:10Z',
    creationOptions: [],
    description: null,
    expirationDateTime: '2027-04-11T13:24:10Z',
    groupTypes: [],
    isAssignableToRole: null,
    mail: null,
    mailEnabled: false,
    mailNickname: null,
    membershipRule: null,
    membershipRuleProcessingState: null,
    onPremisesDomainName: null,
    onPremisesLastSyncDateTime: null,
    onPremisesSecurityIdentifier: null,
    onPremisesSyncEnabled: null,
    preferredDataLocation: null,
    preferredLanguage: null,
    proxyAddresses: [],
    renewedDateTime: '2026-10-13T13:24:10Z',
    resourceBehaviorOptions: [],
    resourceProvisioningOptions: [],
    securityEnabled: true,
    securityIdentifier: 'S-1-12-1-1111111111-2222222222-3333333333-444444444',
    theme: null,
    uniqueName: null,
    visibility: null,
    onPremisesProvisioningErrors: [],
    serviceProvisioningErrors: [],
    ...written,
  };
}

// What GET /identity/conditionalAccess/policies/{id} returns: the live Q45 shape.
function policyReadBack(id, written) {
  return {
    ...written,
    '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#identity/conditionalAccess/policies/$entity',
    id,
    templateId: null,
    createdDateTime: '2026-10-13T21:32:21.4104309Z',
    modifiedDateTime: null,
    deletedDateTime: null,
    sessionControls: null,
    grantControls: {
      ...written.grantControls,
      authenticationStrength: null,
      'authenticationStrength@odata.context': `https://graph.microsoft.com/v1.0/$metadata#identity/conditionalAccess/policies('${id}')/grantControls/authenticationStrength/$entity`,
    },
  };
}

/**
 * A Graph-like fake. POST creates and answers with the full read-back; a
 * restore brings back the deleted object under its own id; PATCH merges.
 * `tamper` changes the stored object after each write, to model a written
 * value that does not stick.
 */
function graphLikeWriter({ deleted = new Map(), tamper = (object) => object } = {}) {
  const objects = new Map();
  const calls = [];
  let next = 0;
  return {
    calls,
    objects,
    write: async (version, path, opts) => {
      calls.push({ kind: 'write', path, method: opts.method, body: opts.body });
      if (opts.method === 'POST' && path.endsWith('/restore')) {
        const id = path.split('/').at(-2);
        const object = deleted.get(id);
        objects.set(`/groups/${id}`, tamper(object));
        return { ok: true, status: 200, body: object };
      }
      if (opts.method === 'POST') {
        next += 1;
        const id = `new-${next}`;
        const object = path === '/groups' ? groupReadBack(id, opts.body) : policyReadBack(id, opts.body);
        objects.set(`${path}/${id}`, tamper(object));
        return { ok: true, status: 201, body: object };
      }
      if (opts.method === 'PATCH') {
        objects.set(path, tamper({ ...objects.get(path), ...opts.body }));
        return { ok: true, status: 204, body: null };
      }
      return { ok: false, status: 405, body: null };
    },
    read: async (version, path) => {
      calls.push({ kind: 'read', path });
      const object = objects.get(path.replace(/\?.*$/, ''));
      return object ? { ok: true, status: 200, body: structuredClone(object) } : { ok: false, status: 404, body: null };
    },
  };
}

function fakeJournal() {
  const outcomes = [];
  return {
    outcomes,
    async query(text, values) {
      if (text.includes('INSERT INTO rollback_entry')) return { rows: [{ id: `entry-${outcomes.length + 1}` }] };
      if (text.includes('SET outcome')) outcomes.push({ outcome: values[1], detail: values[4] });
      return { rows: [] };
    },
  };
}

const apply = (writer, resources, journal = fakeJournal()) => applyWave(writer, governor, resources, {
  targetTenant: 'target', mode: 'enforce', rollbackClient: journal, runId: 'run-q45', restoreRef: 'restore-q45',
  readAfterWriteOptions: { attempts: 2, delayMs: 0 },
});

// The snapshot as collected for the Q45 fixture group ($select projection).
const groupSnapshot = {
  id: 'source-group-id',
  groupTypes: [],
  visibility: null,
  displayName: 'KEEL-RT-148-group',
  mailEnabled: false,
  mailNickname: 'KEEL-RT-148-group',
  membershipRule: null,
  createdDateTime: '2026-10-10T20:18:33Z',
  securityEnabled: true,
  assignedLicenses: [],
  isAssignableToRole: null,
  onPremisesSyncEnabled: null,
  membershipRuleProcessingState: null,
};
const group = { naturalKey: 'group:KEEL-RT-148-group', resourceType: 'group', blastRadius: 'access-affecting', payload: groupSnapshot };

// The snapshot as collected for the Q45 fixture policy (the live capture's intended state).
const policySnapshot = {
  id: 'source-policy-id',
  state: 'enabledForReportingButNotEnforced',
  displayName: 'KEEL-RT-148-ca',
  templateId: null,
  createdDateTime: '2026-10-13T14:39:49.3959877Z',
  deletedDateTime: null,
  modifiedDateTime: null,
  sessionControls: null,
  conditions: {
    users: { includeUsers: [], excludeUsers: ['bg-1', 'bg-2'], includeGroups: ['source-group-id'], excludeGroups: [], includeRoles: [], excludeRoles: [],
      includeGuestsOrExternalUsers: null, excludeGuestsOrExternalUsers: null },
    applications: { includeApplications: ['All'], excludeApplications: [], includeUserActions: [], includeAuthenticationContextClassReferences: [], applicationFilter: null },
    clientAppTypes: ['all'],
    devices: null, locations: null, platforms: null,
    userRiskLevels: [], signInRiskLevels: [], servicePrincipalRiskLevels: [], insiderRiskLevels: null,
    clientApplications: null, authenticationFlows: null,
  },
  grantControls: {
    operator: 'OR', builtInControls: ['block'], termsOfUse: [], customAuthenticationFactors: [], authenticationStrength: null,
    'authenticationStrength@odata.context': "https://graph.microsoft.com/v1.0/$metadata#identity/conditionalAccess/policies('source-policy-id')/grantControls/authenticationStrength/$entity",
  },
};
const policy = { naturalKey: 'conditionalAccessPolicy:KEEL-RT-148-ca', resourceType: 'conditionalAccessPolicy', blastRadius: 'tenant-lockout', payload: policySnapshot };

test('a created group verifies although Graph adds createdDateTime, renewedDateTime, securityIdentifier and nulls', async () => {
  const journal = fakeJournal();
  const result = await apply(graphLikeWriter(), [group], journal);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.applied, [{ naturalKey: group.naturalKey, targetId: 'new-1' }]);
  assert.deepEqual(journal.outcomes.map((o) => o.outcome), ['succeeded']);
});

test('a created Conditional Access policy verifies although Graph adds id, createdDateTime and OData annotations', async () => {
  const journal = fakeJournal();
  const result = await apply(graphLikeWriter(), [{ ...policy, references: [] }], journal);
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(journal.outcomes.map((o) => o.outcome), ['succeeded']);
});

test('a group restored from deleted items converges although it reads back expirationDateTime, renewedDateTime and securityIdentifier', async () => {
  const deletedGroup = groupReadBack('original-group-id', {
    displayName: 'KEEL-RT-148-group', mailNickname: 'KEEL-RT-148-group', description: 'changed before deletion',
  });
  const desired = { ...groupSnapshot, id: 'original-group-id', description: 'baseline' };
  const writer = graphLikeWriter({ deleted: new Map([['original-group-id', deletedGroup]]) });
  const journal = fakeJournal();
  const result = await apply(writer, [{
    ...group, payload: desired, verb: 'restore-soft-deleted', targetId: 'original-group-id', deletedItemId: 'original-group-id',
  }], journal);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.applied, [{ naturalKey: group.naturalKey, targetId: 'original-group-id' }]);
  assert.deepEqual(journal.outcomes.map((o) => o.outcome), ['succeeded']);
  // The follow-up PATCH carried the description and none of the server-managed fields.
  const patch = writer.calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.body.description, 'baseline');
  for (const field of ['expirationDateTime', 'renewedDateTime', 'securityIdentifier', 'createdDateTime', 'id']) {
    assert.equal(Object.hasOwn(patch.body, field), false, field);
  }
});

test('a Microsoft 365 group update converges although Graph adds exchangeResourceUrls and sharepointResourceUrls (#683)', async () => {
  const unifiedGroup = (written) => groupReadBack('community-group-id', {
    displayName: 'KEEL-RT-community', mailNickname: 'KEEL-RT-community', groupTypes: ['Unified'],
    mailEnabled: true, securityEnabled: false, visibility: 'Public',
    exchangeResourceUrls: ['https://outlook.office365.com/owa/?path=/group/KEEL-RT-community@example.test/mail'],
    sharepointResourceUrls: ['https://example.sharepoint.com/sites/KEEL-RT-community'],
    ...written,
  });
  const writer = graphLikeWriter();
  writer.objects.set('/groups/community-group-id', unifiedGroup({ description: 'drifted by Engage' }));
  const desired = {
    ...groupSnapshot, id: 'community-group-id', displayName: 'KEEL-RT-community', mailNickname: 'KEEL-RT-community',
    groupTypes: ['Unified'], mailEnabled: true, securityEnabled: false, visibility: 'Public', description: 'baseline',
  };
  const journal = fakeJournal();
  const result = await apply(writer, [{
    ...group, naturalKey: 'group:keel-rt-community', payload: desired, verb: 'update', targetId: 'community-group-id',
  }], journal);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.applied, [{ naturalKey: 'group:keel-rt-community', targetId: 'community-group-id' }]);
  assert.deepEqual(journal.outcomes.map((o) => o.outcome), ['succeeded']);
  const patch = writer.calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.body.description, 'baseline');
  for (const field of ['exchangeResourceUrls', 'sharepointResourceUrls']) assert.equal(Object.hasOwn(patch.body, field), false, field);
});

test('a written value that reads back different still fails verification', async (t) => {
  await t.test('group create', async () => {
    const writer = graphLikeWriter({ tamper: (object) => ({ ...object, displayName: 'renamed by someone else' }) });
    const journal = fakeJournal();
    const result = await apply(writer, [group], journal);
    assert.equal(result.applied.length, 0);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].error, /verification hash mismatch/);
    assert.deepEqual(result.failed[0].residual, ['displayName']);
    assert.deepEqual(journal.outcomes.map((o) => o.detail), ['created object did not verify']);
  });

  await t.test('Conditional Access policy create', async () => {
    const writer = graphLikeWriter({
      tamper: (object) => ({ ...object, conditions: { ...object.conditions, clientAppTypes: ['browser'] } }),
    });
    const result = await apply(writer, [{ ...policy, references: [] }]);
    assert.equal(result.applied.length, 0);
    assert.deepEqual(result.failed[0].residual, ['conditions.clientAppTypes.0']);
  });

  await t.test('a written value missing from the read-back', async () => {
    const writer = graphLikeWriter({ tamper: ({ displayName, ...object }) => object });
    const result = await apply(writer, [group]);
    assert.deepEqual(result.failed[0].residual, ['displayName']);
  });

  await t.test('group restore whose follow-up update does not stick', async () => {
    const deletedGroup = groupReadBack('original-group-id', {
      displayName: 'KEEL-RT-148-group', mailNickname: 'KEEL-RT-148-group', description: 'changed before deletion',
    });
    const writer = graphLikeWriter({
      deleted: new Map([['original-group-id', deletedGroup]]),
      tamper: (object) => ({ ...object, description: 'changed before deletion' }),
    });
    const journal = fakeJournal();
    const result = await apply(writer, [{
      ...group, payload: { ...groupSnapshot, id: 'original-group-id', description: 'baseline' },
      verb: 'restore-soft-deleted', targetId: 'original-group-id', deletedItemId: 'original-group-id',
    }], journal);
    assert.equal(result.applied.length, 0);
    assert.equal(result.failed[0].error, 'residual drift after update');
    assert.deepEqual(result.failed[0].residual, ['description']);
  });
});

test('verificationView drops server-owned fields, OData annotations at any depth and nulls, and keeps the rest', () => {
  assert.deepEqual(verificationView(policyReadBack('p-1', { displayName: 'P', grantControls: { operator: 'OR', builtInControls: ['block'] } }), 'conditionalAccessPolicy'), {
    displayName: 'P',
    grantControls: { operator: 'OR', builtInControls: ['block'] },
  });
  assert.deepEqual(verificationView(groupReadBack('g-1', { displayName: 'G', mailNickname: 'g' }), 'group'), {
    displayName: 'G', groupTypes: [], mailEnabled: false, mailNickname: 'g', securityEnabled: true,
  });
  // A nested object's own id stays: it is a reference, not the object's id.
  assert.deepEqual(
    verificationView({ grantControls: { authenticationStrength: { id: 'strength-1', '@odata.type': '#x' } } }, 'conditionalAccessPolicy'),
    { grantControls: { authenticationStrength: { id: 'strength-1' } } },
  );
  assert.throws(() => verificationView({}, 'notAType'), /unknown resourceType/);
});
