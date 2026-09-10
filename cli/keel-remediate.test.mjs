import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createSnapshot, insertResourceVersion } from '../engine/store/db.mjs';
import { seedFromSnapshot } from '../engine/govern/baseline.mjs';
import { createIsolatedTestDatabase } from '../engine/test/dbTestHelper.mjs';
import { main, resolveRestoreScope, runCli, runRemediate } from './keel-remediate.mjs';

const noopLogger = { log() {}, error() {} };

// --- resolveRestoreScope: driftIds -> {snapshotId, selection}, against a real database ---
{
  const database = await createIsolatedTestDatabase(import.meta.url);
  let client;
  try {
    client = await database.connect();
    await client.query(readFileSync(new URL('../engine/store/schema.sql', import.meta.url), 'utf8'));
    const tenantRef = 'sha256:keel-remediate-test';

    const baselineSnapshotId = await createSnapshot(client, { tenantRef });
    await insertResourceVersion(client, {
      snapshotId: baselineSnapshotId,
      resource: {
        naturalKey: 'group:Finance', resourceType: 'group', payload: { displayName: 'Finance' },
        payloadHash: 'finance-before', criticality: 'tier1', blastRadius: 'access-affecting',
        fidelity: 'full', provenance: { adapter: 'test' },
      },
    });
    await insertResourceVersion(client, {
      snapshotId: baselineSnapshotId,
      resource: {
        naturalKey: 'group:HR', resourceType: 'group', payload: { displayName: 'HR' },
        payloadHash: 'hr-before', criticality: 'tier1', blastRadius: 'access-affecting',
        fidelity: 'full', provenance: { adapter: 'test' },
      },
    });
    const baselineId = await seedFromSnapshot(client, {
      tenantRef, snapshotId: baselineSnapshotId, setBy: 'test-admin',
    });
    const observedSnapshotId = await createSnapshot(client, { tenantRef });

    async function insertDrift(naturalKey) {
      const { rows } = await client.query(
        `INSERT INTO drift
           (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type,
            before_hash, after_hash, before_payload, after_payload, blast_radius)
         VALUES ($1,$2,$3,$4,'group','modified','before','after','{}','{}','access-affecting')
         RETURNING *`,
        [tenantRef, baselineId, observedSnapshotId, naturalKey],
      );
      return rows[0];
    }

    const financeDrift = await insertDrift('group:Finance');
    const hrDrift = await insertDrift('group:HR');

    const single = await resolveRestoreScope(client, { driftIds: [financeDrift.id] });
    assert.equal(single.snapshotId, baselineSnapshotId);
    assert.deepEqual(single.selection, ['group:Finance']);

    const multi = await resolveRestoreScope(client, { driftIds: [financeDrift.id, hrDrift.id] });
    assert.equal(multi.snapshotId, baselineSnapshotId);
    assert.deepEqual([...multi.selection].sort(), ['group:Finance', 'group:HR']);

    await assert.rejects(
      () => resolveRestoreScope(client, { driftIds: ['00000000-0000-0000-0000-000000000000'] }),
      /drift not found/,
    );

    // A second, unrelated baseline makes the two drift rows span different baselines —
    // remediation must refuse rather than guess which baseline to restore toward.
    const otherSnapshotId = await createSnapshot(client, { tenantRef });
    await insertResourceVersion(client, {
      snapshotId: otherSnapshotId,
      resource: {
        naturalKey: 'group:Ops', resourceType: 'group', payload: { displayName: 'Ops' },
        payloadHash: 'ops-before', criticality: 'tier1', blastRadius: 'access-affecting',
        fidelity: 'full', provenance: { adapter: 'test' },
      },
    });
    const otherBaselineId = await seedFromSnapshot(client, {
      tenantRef, snapshotId: otherSnapshotId, setBy: 'test-admin',
    });
    const { rows: opsDriftRows } = await client.query(
      `INSERT INTO drift
         (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type,
          before_hash, after_hash, before_payload, after_payload, blast_radius)
       VALUES ($1,$2,$3,'group:Ops','group','modified','before','after','{}','{}','access-affecting')
       RETURNING *`,
      [tenantRef, otherBaselineId, observedSnapshotId],
    );
    await assert.rejects(
      () => resolveRestoreScope(client, { driftIds: [financeDrift.id, opsDriftRows[0].id] }),
      /must share the same baseline/,
    );
  } finally {
    await client?.end();
    await database.cleanup();
  }
}

// --- runRemediate: resolves the scope, then delegates to runRestore unchanged ---
{
  const calls = [];
  const result = await runRemediate({
    driftIds: ['drift-1'],
    targetConfig: { tenantId: 'target' },
    collectorConfig: { tenantId: 'target', clientId: 'collector' },
    mode: 'enforce',
    dbUrl: 'postgres://unused',
    logger: noopLogger,
    dependencies: {
      connect: async () => ({ end: async () => {} }),
      resolveRestoreScope: async (client, { driftIds }) => {
        assert.deepEqual(driftIds, ['drift-1']);
        return { snapshotId: 'snapshot-1', selection: ['group:Finance'] };
      },
      runRestore: async (options) => {
        calls.push(options);
        return { applied: [] };
      },
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].snapshotId, 'snapshot-1');
  assert.deepEqual(calls[0].selection, ['group:Finance']);
  assert.equal(calls[0].targetConfig.tenantId, 'target');
  assert.equal(calls[0].mode, 'enforce');
  assert.deepEqual(result, { applied: [] });
}

// --- main(): CLI plumbing enforces the read/write credential separation, same as restore ---
{
  const configs = new Map([
    ['/fixtures/same.json', JSON.stringify({
      tenantId: 't', clientId: 'same-client', certPath: '/same.cer', keyPath: '/same.key',
    })],
  ]);
  await assert.rejects(
    () => main({
      argv: [
        'node', 'keel-remediate.mjs', '--drift-id', 'drift-1',
        '--collector-config', '/fixtures/same.json', '--target-config', '/fixtures/same.json',
      ],
      readFile: (path) => configs.get(path),
      dependencies: { runRestore: async () => { throw new Error('must not reach runRestore'); } },
    }),
    /separate Collector and Restorer registrations/,
  );
}

// --- the §10.3 sign-in path gate applies to a remediate run exactly as it does to a
// restore, because runRemediate dispatches through the SAME runRestore. A mutation
// that special-cased "automatic" remediation to skip signInPathGate would pass every
// test above and fail only this one. ---
{
  let grantControls = ['mfa'];
  class FakeReader {
    async collect(version, path) {
      if (path === '/identity/conditionalAccess/policies') {
        return {
          items: [{ id: 'ca-1', displayName: 'Protect admins', grantControls: { builtInControls: grantControls } }],
          capped: false, error: null,
        };
      }
      if (path.startsWith('/roleManagement/directory/roleAssignments?')) {
        return {
          items: [{ id: 'role-1', principalId: 'break-glass-id', roleDefinitionId: 'global-admin', directoryScopeId: '/' }],
          capped: false, error: null,
        };
      }
      throw new Error(`unexpected reader collection: ${path}`);
    }

    async get(version, path) {
      if (path === '/policies/authenticationMethodsPolicy') return { ok: true, status: 200, body: { id: 'authenticationMethodsPolicy' } };
      if (path === '/policies/identitySecurityDefaultsEnforcementPolicy') return { ok: true, status: 200, body: { id: 'identitySecurityDefaultsEnforcementPolicy', isEnabled: true } };
      if (path.startsWith('/users/')) return { ok: true, status: 200, body: { id: 'break-glass-id', accountEnabled: true } };
      throw new Error(`unexpected reader read: ${path}`);
    }
  }

  class FakeWriter {
    async write() {
      // Applying the remediation flips the tenant's sign-in path underneath it —
      // exactly the change the gate exists to catch.
      grantControls = ['block'];
      return { ok: true, status: 201, body: { id: 'target-group-id' } };
    }

    async read() {
      return { ok: true, status: 200, body: { id: 'target-group-id', displayName: 'Finance' } };
    }
  }

  const exitCode = await runCli({
    argv: [
      'node', 'keel-remediate.mjs', '--drift-id', 'drift-1',
      '--collector-config', '/fixtures/collector.json', '--target-config', '/fixtures/target.json',
      '--enforce',
    ],
    readFile: (path) => {
      if (path === '/fixtures/collector.json') {
        return JSON.stringify({ tenantId: 't', clientId: 'collector', certPath: '/c.cer', keyPath: '/c.key' });
      }
      if (path === '/fixtures/target.json') {
        return JSON.stringify({ tenantId: 't', clientId: 'restorer', certPath: '/r.cer', keyPath: '/r.key' });
      }
      throw new Error(`unexpected fixture read: ${path}`);
    },
    logger: noopLogger,
    dependencies: {
      // --enforce makes runRestore record prior state before each write; the fake
      // just needs to accept that insert, not simulate a real rollback journal.
      connect: async () => ({ query: async () => ({ rows: [] }), end: async () => {} }),
      resolveRestoreScope: async () => ({ snapshotId: 'snapshot-1', selection: ['group:Finance'] }),
      getResourceVersions: async () => [{
        id: 'source-group', natural_key: 'group:Finance', resource_type: 'group',
        payload: { displayName: 'Finance' }, blast_radius: 'access-affecting',
      }],
      getReferences: async () => [],
      planWaves: () => ({ waves: [['group:Finance']], patches: [] }),
      getToken: async () => ({ accessToken: 'fake-token' }),
      GraphReader: FakeReader,
      collectM1: async () => [],
      canonicalizeAll: () => [],
      GraphWriter: FakeWriter,
      ThrottleGovernor: class { async acquire() {} },
    },
  });

  assert.equal(exitCode, 1, 'a changed sign-in path must fail the run, not merely warn');
}

console.log('keel-remediate.test.mjs — all assertions passed');
