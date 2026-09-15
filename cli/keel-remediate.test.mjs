import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { completeSnapshot, createSnapshot, insertResourceVersion } from '../engine/store/db.mjs';
import { seedFromSnapshot } from '../engine/govern/baseline.mjs';
import { createIsolatedTestDatabase } from '../engine/test/dbTestHelper.mjs';
import { fullSuccessfulCoverageDigest } from '../engine/test/fullSuccessfulCoverage.mjs';
import { applyWave } from '../engine/restore/applyEngine.mjs';
import { main, resolveRestoreScope, runCli, runRemediate } from './keel-remediate.mjs';

const noopLogger = { log() {}, error() {} };
const testDbUrl = process.env.KEEL_DB_TEST_URL;
assert.ok(testDbUrl, 'KEEL_DB_TEST_URL must be set for remediation CLI tests');

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
    await completeSnapshot(client, {
      id: baselineSnapshotId,
      status: 'complete',
      coverageDigest: fullSuccessfulCoverageDigest(),
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
    assert.deepEqual(single.reconciliationResources, [{
      naturalKey: 'group:Finance', resourceType: 'group', payload: { displayName: 'Finance' },
      blastRadius: 'access-affecting',
    }]);

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
    await completeSnapshot(client, {
      id: otherSnapshotId,
      status: 'complete',
      coverageDigest: fullSuccessfulCoverageDigest(),
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

// --- an enforce-mode automated remediation persists a dry run, then promotes only
// that immutable artifact. The raw snapshot/reconciliation scope never appears on the
// enforcement call, so this cannot weaken restore's direct-enforce gate. ---
{
  const calls = [];
  const result = await runRemediate({
    driftIds: ['drift-1'],
    targetConfig: { tenantId: 'target' },
    collectorConfig: { tenantId: 'target', clientId: 'collector' },
    targetConfigPath: '/fixtures/target.json',
    collectorConfigPath: '/fixtures/collector.json',
    mode: 'enforce',
    requestedBy: 'policy-run-as-principal',
    readFile: () => '{}',
    dbUrl: 'postgres://unused',
    logger: noopLogger,
    dependencies: {
      connect: async () => ({ end: async () => {} }),
      resolveRestoreScope: async (client, { driftIds }) => {
        assert.deepEqual(driftIds, ['drift-1']);
        return {
          snapshotId: 'snapshot-1',
          selection: ['group:Finance'],
          reconciliationResources: [{
            naturalKey: 'group:Finance', resourceType: 'group', payload: { displayName: 'Finance' },
            blastRadius: 'access-affecting',
          }],
        };
      },
      runRestore: async (options) => {
        calls.push(options);
        if (options.mode === 'dry-run') return { artifactId: options.persistArtifactId };
        return { applied: [] };
      },
      createArtifactId: () => 'automatic-remediation-artifact',
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].snapshotId, 'snapshot-1');
  assert.equal(calls[0].selection, undefined);
  assert.deepEqual(calls[0].reconciliationResources, [{
    naturalKey: 'group:Finance', resourceType: 'group', payload: { displayName: 'Finance' },
    blastRadius: 'access-affecting',
  }]);
  assert.equal(calls[0].targetConfig.tenantId, 'target');
  assert.equal(calls[0].mode, 'dry-run');
  assert.equal(calls[0].persistArtifactId, 'automatic-remediation-artifact');
  assert.equal(calls[0].requestedBy, 'policy-run-as-principal');
  assert.deepEqual(
    calls[1],
    {
      artifactId: 'automatic-remediation-artifact', mode: 'enforce',
      acceptDegradation: undefined, readFile: calls[0].readFile,
      dbUrl: 'postgres://unused', dependencies: calls[0].dependencies, logger: noopLogger,
    },
    'enforcement is artifact-only; mutable restore scope and credentials are loaded from the dry-run artifact',
  );
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
      if (path.startsWith('/groups?') || path === '/directory/deletedItems/microsoft.graph.group') {
        return { items: [], capped: false, error: null };
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
      resolveRestoreScope: async () => ({
        snapshotId: 'snapshot-1',
        selection: ['group:Finance'],
        reconciliationResources: [{
          naturalKey: 'group:Finance', resourceType: 'group', payload: { displayName: 'Finance' },
          blastRadius: 'access-affecting',
        }],
      }),
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

// Modified, added, and removed drift all take the same automatic-remediation
// path through the real reconciliation builder, wave planner, and apply engine.
// Only the Graph/token boundaries and local test database are faked.
{
  const globalAdministrator = '62e90394-69f5-4237-9190-012177145e10';
  const desiredFinance = { displayName: 'Finance', mailNickname: 'Finance' };
  const desiredHr = { displayName: 'HR', mailNickname: 'HR' };
  const priorFinance = { id: 'target-finance-id', displayName: 'Finance drifted', mailNickname: 'Finance' };
  const priorAdded = { id: 'target-added-id', displayName: 'Added after baseline', mailNickname: 'Added' };
  const priorHr = { id: 'target-hr-id', displayName: 'HR', mailNickname: 'HR', deletedDateTime: '2026-09-08T00:00:00Z' };
  const roleAssignment = {
    id: 'target-break-glass-role-id', roleDefinitionId: globalAdministrator,
    principalId: 'break-glass-id', directoryScopeId: '/',
  };
  const liveGroups = new Map([
    [priorFinance.id, { ...priorFinance }],
    [priorAdded.id, { ...priorAdded }],
  ]);
  const deletedGroups = new Map([[priorHr.id, { ...priorHr }]]);
  const state = { verbs: [], writes: [], verificationReads: [], journals: [], connects: 0 };

  class FakeReader {
    async collect(version, path) {
      assert.equal(version, 'v1.0');
      if (path.startsWith('/groups?')) return { items: [...liveGroups.values()], capped: false, error: null };
      if (path === '/directory/deletedItems/microsoft.graph.group') {
        return { items: [...deletedGroups.values()], capped: false, error: null };
      }
      if (path === '/identity/conditionalAccess/policies') return { items: [], capped: false, error: null };
      if (path.startsWith('/roleManagement/directory/roleAssignments')) {
        return { items: [roleAssignment], capped: false, error: null };
      }
      throw new Error(`unexpected collector read: ${path}`);
    }

    async get(version, path) {
      assert.equal(version, 'v1.0');
      if (path === '/policies/authenticationMethodsPolicy') return { ok: true, status: 200, body: { id: 'methods' } };
      if (path === '/policies/identitySecurityDefaultsEnforcementPolicy') return { ok: true, status: 200, body: { id: 'defaults', isEnabled: false } };
      if (path.startsWith('/users/break-glass-id')) return { ok: true, status: 200, body: { id: 'break-glass-id', accountEnabled: true } };
      throw new Error(`unexpected collector get: ${path}`);
    }
  }

  class FakeWriter {
    async write(version, path, options) {
      assert.equal(version, 'v1.0');
      state.writes.push({ path, method: options.method, body: options.body });
      if (options.method === 'PATCH' && path === '/groups/target-finance-id') {
        liveGroups.set('target-finance-id', { ...liveGroups.get('target-finance-id'), ...options.body });
        return { ok: true, status: 204, body: null };
      }
      if (options.method === 'POST' && path === '/directory/deletedItems/target-hr-id/restore') {
        deletedGroups.delete('target-hr-id');
        liveGroups.set('target-hr-id', { ...desiredHr, id: 'target-hr-id' });
        return { ok: true, status: 200, body: { id: 'target-hr-id' } };
      }
      if (options.method === 'DELETE' && path === '/groups/target-added-id') {
        liveGroups.delete('target-added-id');
        return { ok: true, status: 204, body: null };
      }
      throw new Error(`unexpected Graph write: ${options.method} ${path}`);
    }

    async read(version, path) {
      assert.equal(version, 'v1.0');
      state.verificationReads.push(path);
      const targetId = path.split('/').at(-1);
      const group = liveGroups.get(targetId);
      return group
        ? { ok: true, status: 200, body: group }
        : { ok: false, status: 404, body: null };
    }
  }

  const database = await createIsolatedTestDatabase(import.meta.url);
  let client;
  try {
    client = await database.connect();
    await client.query(readFileSync(new URL('../engine/store/schema.sql', import.meta.url), 'utf8'));
    const tenantRef = 'sha256:keel-remediate-e2e';
    const baselineSnapshotId = await createSnapshot(client, { tenantRef });
    for (const resource of [
      { naturalKey: 'group:Finance', resourceType: 'group', payload: desiredFinance },
      { naturalKey: 'group:HR', resourceType: 'group', payload: desiredHr },
    ]) {
      await insertResourceVersion(client, {
        snapshotId: baselineSnapshotId,
        resource: {
          ...resource, criticality: 'tier1', blastRadius: 'access-affecting',
          fidelity: 'full', provenance: { adapter: 'test' },
        },
      });
    }
    await completeSnapshot(client, {
      id: baselineSnapshotId,
      status: 'complete',
      coverageDigest: fullSuccessfulCoverageDigest(),
    });
    const baselineId = await seedFromSnapshot(client, {
      tenantRef, snapshotId: baselineSnapshotId, setBy: 'test-admin',
    });
    const observedSnapshotId = await createSnapshot(client, { tenantRef });
    const driftIds = [];
    for (const [naturalKey, changeType, beforeHash, afterHash] of [
      ['group:Finance', 'modified', 'finance-before', 'finance-after'],
      ['group:Added', 'added', null, 'added-after'],
      ['group:HR', 'removed', 'hr-before', null],
    ]) {
      const { rows } = await client.query(
        `INSERT INTO drift
           (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type,
            before_hash, after_hash, before_payload, after_payload, blast_radius)
         VALUES ($1,$2,$3,$4,'group',$5,$6,$7,'{}','{}','access-affecting')
         RETURNING id`,
        [tenantRef, baselineId, observedSnapshotId, naturalKey, changeType, beforeHash, afterHash],
      );
      driftIds.push(rows[0].id);
    }

    const result = await runRemediate({
      driftIds,
      targetConfig: { tenantId: 'target', clientId: 'restorer', certPath: '/r.cer', keyPath: '/r.key' },
      collectorConfig: { tenantId: 'target', clientId: 'collector', certPath: '/c.cer', keyPath: '/c.key' },
      targetConfigPath: '/fixtures/restorer.json',
      collectorConfigPath: '/fixtures/collector.json',
      mode: 'enforce',
      requestedBy: 'policy-run-as-principal',
      readFile: (path) => {
        if (path === '/fixtures/restorer.json') {
          return JSON.stringify({ tenantId: 'target', clientId: 'restorer', certPath: '/r.cer', keyPath: '/r.key' });
        }
        if (path === '/fixtures/collector.json') {
          return JSON.stringify({ tenantId: 'target', clientId: 'collector', certPath: '/c.cer', keyPath: '/c.key' });
        }
        throw new Error(`unexpected config read: ${path}`);
      },
      dbUrl: database.url,
      logger: noopLogger,
      dependencies: {
        getToken: async () => ({ accessToken: 'fake-token' }),
        GraphReader: FakeReader,
        collectM1: async () => [
          ['group', [...liveGroups.values()]],
          ['roleAssignment', [roleAssignment]],
        ],
        GraphWriter: FakeWriter,
        ThrottleGovernor: class { async acquire() {} },
        applyWave: async (...args) => {
          if (args[3].mode === 'enforce') {
            state.verbs.push(...args[2].map((resource) => ({
              naturalKey: resource.naturalKey, verb: resource.verb, targetId: resource.targetId,
            })));
          }
          return applyWave(...args);
        },
      },
    });

    assert.deepEqual(state.verbs, [
      { naturalKey: 'group:Finance', verb: 'update', targetId: 'target-finance-id' },
      { naturalKey: 'group:HR', verb: 'restore-soft-deleted', targetId: 'target-hr-id' },
      { naturalKey: 'group:Added', verb: 'delete', targetId: 'target-added-id' },
    ]);
    assert.deepEqual(state.writes.map(({ path, method }) => ({ path, method })), [
      { path: '/groups/target-finance-id', method: 'PATCH' },
      { path: '/directory/deletedItems/target-hr-id/restore', method: 'POST' },
      { path: '/groups/target-added-id', method: 'DELETE' },
    ]);
    assert.deepEqual(state.verificationReads, [
      '/groups/target-finance-id',
      '/groups/target-hr-id',
      '/groups/target-added-id',
    ]);
    const { rows: journalRows } = await client.query(
      'SELECT natural_key, prior_state FROM rollback_entry WHERE run_id = $1',
      [`run-selection-${baselineSnapshotId}`],
    );
    assert.equal(journalRows.length, 3, 'each mutating resource has one truthful pre-write journal entry');
    assert.deepEqual(new Map(journalRows.map((row) => [row.natural_key, row.prior_state])), new Map([
      ['group:Finance', priorFinance],
      ['group:HR', priorHr],
      ['group:Added', priorAdded],
    ]));
    assert.equal(result.resources.find((resource) => resource.naturalKey === 'group:Finance').verb, 'update');
    assert.equal(result.resources.find((resource) => resource.naturalKey === 'group:Added').verb, 'delete');
    assert.equal(result.resources.find((resource) => resource.naturalKey === 'group:HR').verb, 'restore-soft-deleted');
    const { rows: artifacts } = await client.query(
      'SELECT selection, status FROM restore_dry_run WHERE snapshot_id = $1', [baselineSnapshotId],
    );
    assert.equal(artifacts.length, 1, 'automatic remediation persists exactly one immutable dry-run artifact');
    assert.equal(artifacts[0].status, 'completed');
    assert.deepEqual(
      [...artifacts[0].selection].sort(),
      ['group:Added', 'group:Finance', 'group:HR'],
    );
  } finally {
    await client?.end();
    await database.cleanup();
  }
}

console.log('keel-remediate.test.mjs — all assertions passed');
