/**
 * Wave 2 IDO: the identity object and Intune writers are reached through
 * applyWave's writer registry hook, and every registered pair has a capability
 * naming the same handler. Fixture Graph only; nothing reads or writes a tenant.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { capabilityFor } from '../coverage/capabilities.mjs';
import idoCapabilities from '../coverage/capabilities.d/ido.mjs';
import { applyWave } from './applyEngine.mjs';
import idoWriters from './writers/ido.mjs';
import { writerFor } from './writers/registry.mjs';
import { idoFakeGraph } from '../test/idoFakeGraph.mjs';

const governor = { async acquire() {}, observeRetryAfter() {} };
const OPTIONS = {
  targetTenant: 'fixture-tenant',
  deletionGuardOptions: { breakGlassUserIds: ['break-glass-1'], keelAppIds: [], caPolicies: [] },
  readAfterWriteOptions: { attempts: 1, delayMs: 0 },
};

test('every IDO writer pair has a fixture-tested capability naming the same handler', () => {
  for (const entry of idoWriters) {
    for (const verb of entry.verbs) {
      assert.equal(writerFor(entry.resourceType, verb)?.handler, entry.handler, `${entry.resourceType} ${verb}`);
      const capability = capabilityFor(entry.resourceType, verb);
      assert.equal(capability.handler, entry.handler, `${entry.resourceType} ${verb}`);
      assert.equal(capability.claim, 'fixture-tested', `${entry.resourceType} ${verb}`);
    }
  }
  for (const row of idoCapabilities) assert.notEqual(capabilityFor(row.resourceType, row.operation).claim, 'unsupported');
});

test('the built-in Intune create and update keep their own writer', () => {
  for (const type of ['deviceCompliancePolicy', 'deviceConfiguration', 'configurationPolicy']) {
    assert.equal(writerFor(type, 'create'), null);
    assert.equal(capabilityFor(type, 'create').handler, 'engine/restore/applyEngine.mjs#applyWave');
    assert.equal(capabilityFor(type, 'delete').handler, 'engine/restore/intuneOperations.mjs#applyIntuneExtendedWrite');
  }
  assert.equal(capabilityFor('servicePrincipal', 'create').handler, 'engine/restore/applyEngine.mjs#applyWave');
});

test('applyWave writes a user recreate, a service principal update and an unassigned policy delete through the registry', async () => {
  const sp = { id: 'sp-1', appId: 'app-1', displayName: 'KEEL-RT-App', servicePrincipalType: 'Application', appOwnerOrganizationId: 'tenant-1', notes: 'old' };
  const policy = { '@odata.type': '#microsoft.graph.windows10GeneralConfiguration', id: 'cfg-1', displayName: 'KEEL-RT-Old profile' };
  const graph = idoFakeGraph({ seed: { '/servicePrincipals/sp-1': sp, '/deviceManagement/deviceConfigurations/cfg-1': policy } });
  const wave = [
    {
      naturalKey: 'user:KEEL-RT-user@example.test', resourceType: 'user', verb: 'create', references: [], blastRadius: 'access-affecting',
      payload: { userPrincipalName: 'KEEL-RT-user@example.test', displayName: 'KEEL-RT User', accountEnabled: true },
    },
    {
      naturalKey: 'servicePrincipal:KEEL-RT-App', resourceType: 'servicePrincipal', verb: 'update', references: [], blastRadius: 'access-affecting',
      payload: { ...sp, notes: 'restored' }, live: { state: 'present', targetId: 'sp-1', payload: sp },
    },
    {
      naturalKey: 'deviceConfiguration:KEEL-RT-Old profile', resourceType: 'deviceConfiguration', verb: 'delete', references: [], blastRadius: 'access-affecting',
      payload: policy, live: { state: 'present', targetId: 'cfg-1', payload: policy },
    },
  ];
  const result = await applyWave(graph, governor, wave, { ...OPTIONS, observedCoverage: { deviceConfiguration: { outcome: 'complete' } } });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.applied.length, 3);
  assert.equal(result.applied[0].completion[0].requirement, 'password');
  assert.equal(graph.objects.get('/servicePrincipals/sp-1').notes, 'restored');
  assert.equal(graph.objects.has('/deviceManagement/deviceConfigurations/cfg-1'), false);
});

test('a dry run through applyWave writes nothing', async () => {
  const graph = idoFakeGraph();
  const result = await applyWave(graph, governor, [{
    naturalKey: 'roleScopeTag:KEEL-RT-Paris', resourceType: 'roleScopeTag', verb: 'create', references: [], blastRadius: 'access-affecting',
    payload: { id: '7', displayName: 'KEEL-RT-Paris' },
  }], { ...OPTIONS, mode: 'dry-run' });
  assert.equal(result.applied.length, 1);
  assert.equal(graph.calls.filter((call) => call.method !== 'GET').length, 0);
});
