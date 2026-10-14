// Post-write verification and convergence compare what KEEL wrote, never what
// the server manages. Reproduces the live test-tenant demotions of steps 1, 3
// and 48: a group create, a group soft-delete restore and a Conditional Access
// create all landed, but the read-back carried server-assigned values (id,
// createdDateTime, expirationDateTime, securityIdentifier), properties the
// snapshot never held, and property annotations such as
// `grantControls.authenticationStrength@odata.context` that name the new object,
// so each write was reported "created object did not verify" or "residual
// drift after update". A writable field the snapshot holds must still fail.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { applyWave } from './applyEngine.mjs';
import { ThrottleGovernor } from './throttleGovernor.mjs';
import { verificationView } from '../reconcile/writableProjection.mjs';

const governor = new ThrottleGovernor({ 'target/entra/write': { capacity: 100, refillPerSecond: 100 } });
const fast = { readAfterWriteOptions: { attempts: 1, delayMs: 0 } };

// What Graph adds on a read-back without $select, by collection.
function serverView(path, id, body) {
  const common = {
    '@odata.context': `https://graph.microsoft.com/v1.0/$metadata#${path.slice(1)}/$entity`,
    id,
    createdDateTime: '2026-10-13T09:00:00Z',
  };
  if (path === '/groups') {
    return {
      description: null, visibility: null, membershipRule: null, preferredDataLocation: null,
      ...body, ...common,
      expirationDateTime: '2027-10-13T09:00:00Z', renewedDateTime: '2026-10-13T09:00:00Z',
      securityIdentifier: `S-1-12-1-${id}`, deletedDateTime: null,
      proxyAddresses: [], resourceProvisioningOptions: [], onPremisesSyncEnabled: null,
    };
  }
  return {
    ...body, ...common,
    modifiedDateTime: null, templateId: null, sessionControls: null,
    conditions: {
      ...body.conditions,
      platforms: null, locations: null,
      users: { excludeUsers: [], includeGroups: [], ...body.conditions.users },
    },
    grantControls: {
      customAuthenticationFactors: [], termsOfUse: [], ...body.grantControls,
      'authenticationStrength@odata.context': `https://graph.microsoft.com/v1.0/$metadata#identity/conditionalAccess/policies('${id}')/grantControls/authenticationStrength/$entity`,
      authenticationStrength: null,
    },
  };
}

// A Graph-like fake: creates and restores answer with the server's view of the
// object, and `tamper` lets a test change what reads back.
function graphLike({ tamper = (body) => body } = {}) {
  const objects = new Map();
  const deleted = new Map();
  const writes = [];
  return {
    objects, deleted, writes,
    write: async (version, path, opts) => {
      writes.push({ path, method: opts.method, body: opts.body });
      const restore = /^\/directory\/deletedItems\/([^/]+)\/restore$/.exec(path);
      if (restore) {
        const entry = deleted.get(restore[1]);
        deleted.delete(restore[1]);
        objects.set(entry.path, entry.body);
        return { ok: true, status: 200, body: entry.body };
      }
      if (opts.method === 'PATCH') {
        objects.set(path, { ...objects.get(path), ...opts.body });
        return { ok: true, status: 204, body: null };
      }
      const id = `new-${objects.size + 1}`;
      const object = serverView(path, id, opts.body);
      objects.set(`${path}/${id}`, object);
      return { ok: true, status: 201, body: object };
    },
    read: async (version, path) => {
      const object = objects.get(path.replace(/\?.*$/, ''));
      return object ? { ok: true, status: 200, body: tamper(structuredClone(object)) } : { ok: false, status: 404, body: null };
    },
  };
}

const run = (graph, resources) => applyWave(graph, governor, resources, { targetTenant: 'target', mode: 'enforce', ...fast });

const groupSnapshot = {
  '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#groups/$entity',
  id: 'source-group', createdDateTime: '2025-01-01T00:00:00Z', renewedDateTime: '2025-01-01T00:00:00Z',
  expirationDateTime: '2026-01-01T00:00:00Z', securityIdentifier: 'S-1-12-1-source',
  displayName: 'KEEL-RT-group', mailNickname: 'keel-rt-group', mailEnabled: false, securityEnabled: true, groupTypes: [],
  description: 'Restore fixture',
};
const group = { naturalKey: 'group:KEEL-RT-group', resourceType: 'group', blastRadius: 'access-affecting', payload: groupSnapshot };

const policySnapshot = {
  '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#identity/conditionalAccess/policies/$entity',
  id: 'source-policy', createdDateTime: '2025-01-01T00:00:00Z',
  displayName: 'KEEL-RT-ca', state: 'enabledForReportingButNotEnforced',
  conditions: { users: { includeUsers: ['All'] }, applications: { includeApplications: ['All'] }, clientAppTypes: ['all'] },
  grantControls: {
    operator: 'OR', builtInControls: ['mfa'],
    'authenticationStrength@odata.context': "https://graph.microsoft.com/v1.0/$metadata#identity/conditionalAccess/policies('source-policy')/grantControls/authenticationStrength/$entity",
  },
};
const policy = { naturalKey: 'conditionalAccessPolicy:KEEL-RT-ca', resourceType: 'conditionalAccessPolicy', blastRadius: 'tenant-lockout', payload: policySnapshot };

test('a group create verifies although the read-back carries server-managed and unsnapshotted fields', async () => {
  const graph = graphLike();
  const result = await run(graph, [group]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.applied, [{ naturalKey: group.naturalKey, targetId: 'new-1' }]);
});

test('a Conditional Access create verifies although the read-back carries ids, timestamps and nested annotations', async () => {
  const graph = graphLike();
  const result = await run(graph, [policy]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied.length, 1);
});

test('a create whose written field reads back different still fails', async () => {
  const renamed = graphLike({ tamper: (body) => ({ ...body, description: 'Someone else' }) });
  const groupResult = await run(renamed, [group]);
  assert.equal(groupResult.applied.length, 0);
  assert.match(groupResult.failed[0]?.error ?? '', /verification hash mismatch/);

  const widened = graphLike({ tamper: (body) => ({ ...body, conditions: { ...body.conditions, users: { ...body.conditions.users, includeUsers: ['None'] } } }) });
  const policyResult = await run(widened, [policy]);
  assert.equal(policyResult.applied.length, 0);
  assert.match(policyResult.failed[0]?.error ?? '', /verification hash mismatch/);

  // A written field that does not read back at all is not verified either.
  const dropped = graphLike({ tamper: ({ description, ...rest }) => rest });
  assert.equal((await run(dropped, [group])).applied.length, 0);
});

test('a group soft-delete restore converges although the read-back carries server-managed and unsnapshotted fields', async () => {
  const graph = graphLike();
  graph.deleted.set('target-group', { path: '/groups/target-group', body: serverView('/groups', 'target-group', { ...groupSnapshot }) });
  const resource = { ...group, verb: 'restore-soft-deleted', targetId: 'target-group', deletedItemId: 'target-group' };
  const result = await run(graph, [resource]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.applied, [{ naturalKey: group.naturalKey, targetId: 'target-group' }]);
});

test('a group soft-delete restore whose written field stays different is residual drift', async () => {
  const graph = graphLike({ tamper: (body) => ({ ...body, description: 'Someone else' }) });
  graph.deleted.set('target-group', { path: '/groups/target-group', body: serverView('/groups', 'target-group', { ...groupSnapshot }) });
  const resource = { ...group, verb: 'restore-soft-deleted', targetId: 'target-group', deletedItemId: 'target-group' };
  const result = await run(graph, [resource]);
  assert.equal(result.applied.length, 0);
  assert.match(result.failed[0]?.error ?? '', /residual drift after update/);
  assert.deepEqual(result.failed[0].residual, ['description']);
});

test('verificationView keeps every written path and drops what was never written', () => {
  const written = { a: 1, nested: { b: [{ c: 2 }], 'x@odata.context': 'old' }, list: [1] };
  const live = { a: 1, extra: null, nested: { b: [{ c: 2, d: 3 }], 'x@odata.context': 'new', e: 4 }, list: [1, 2] };
  assert.deepEqual(verificationView(live, written), { a: 1, nested: { b: [{ c: 2 }] }, list: [1, 2] });
  assert.deepEqual(verificationView(written, written), { a: 1, nested: { b: [{ c: 2 }] }, list: [1] });
  assert.deepEqual(verificationView({}, written), {});
});
