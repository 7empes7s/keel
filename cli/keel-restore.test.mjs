import { strict as assert } from 'node:assert';
import { applyWave } from '../engine/restore/applyEngine.mjs';
import { planWaves } from '../engine/restore/wavePlanner.mjs';
import { runCli, runRestore } from './keel-restore.mjs';

const testDbUrl = process.env.KEEL_DB_TEST_URL;
assert.ok(testDbUrl, 'KEEL_DB_TEST_URL must be set for restore CLI tests');

// Plan task 8: an enforce run always promotes a completed dry-run artifact — a plan
// scope can no longer reach --enforce directly (see the "plan-scoped bypass" test
// below). These write-path fixtures (provenance rewriting, wave/patch failure
// handling) are about runRestore's enforce mechanics, not the artifact-validation
// logic itself (covered separately by dryRunArtifact.test.mjs and the
// artifactPromotionFakes tests below) — so restoreFakes() supplies an already-
// completed fake artifact and stubs validateArtifactForExecution, letting these
// fixtures promote directly via --artifact instead of re-deriving one through a real
// dry run (which cannot itself observe real target ids for not-yet-created
// resources and so can never reach 'completed' for a create-then-reference scope).
const FIXTURE_ARTIFACT_ID = '99999999-0000-4000-8000-000000000099';
const artifactArgv = [
  'node', 'keel-restore.mjs',
  '--artifact', FIXTURE_ARTIFACT_ID,
  '--enforce',
];
const configs = new Map([
  ['/fixtures/restorer.json', JSON.stringify({
    tenantId: 'target-tenant', clientId: 'restorer-client', certPath: '/fixtures/restorer.cer', keyPath: '/fixtures/restorer.key',
  })],
  ['/fixtures/collector.json', JSON.stringify({
    tenantId: 'target-tenant', clientId: 'collector-client', certPath: '/fixtures/collector.cer', keyPath: '/fixtures/collector.key',
  })],
]);

function readFixture(path) {
  const config = configs.get(path);
  if (!config) throw new Error(`unexpected fixture read: ${path}`);
  return config;
}

function restoreResources() {
  return {
    versions: [
      {
        id: 'source-group', natural_key: 'group:Finance', resource_type: 'group',
        payload: { displayName: 'Finance', mailNickname: 'finance' }, blast_radius: 'access-affecting',
      },
      {
        id: 'source-role-assignment', natural_key: 'roleAssignment:GlobalAdmin:Finance', resource_type: 'roleAssignment',
        payload: { principalId: 'source-group-id', roleDefinitionId: 'global-admin-id', directoryScopeId: '/' }, blast_radius: 'access-affecting',
      },
    ],
    references: [
      { from_version: 'source-role-assignment', field_path: 'principalId', to_symbol: 'group:Finance', required: true },
    ],
    waves: [['group:Finance'], ['roleAssignment:GlobalAdmin:Finance']],
    patches: [],
  };
}

function patchResources() {
  return {
    versions: [
      {
        id: 'source-finance', natural_key: 'group:Finance', resource_type: 'group',
        payload: { displayName: 'Finance', mailNickname: 'finance' }, blast_radius: 'access-affecting',
      },
      {
        id: 'source-parent', natural_key: 'group:Parent', resource_type: 'group',
        payload: { displayName: 'Parent', mailNickname: 'parent' }, blast_radius: 'access-affecting',
      },
    ],
    references: [],
    waves: [['group:Finance'], ['group:Parent']],
    patches: [
      { naturalKey: 'group:Finance', field: 'parentGroupId', symbol: 'group:Parent' },
      { naturalKey: 'group:Parent', field: 'parentGroupId', symbol: 'group:Finance' },
    ],
  };
}

function cyclicResources() {
  return {
    versions: [
      {
        id: 'source-policy', natural_key: 'conditionalAccessPolicy:Protect-Admins', resource_type: 'conditionalAccessPolicy',
        payload: {
          displayName: 'Protect Admins', state: 'enabled',
          conditions: { users: { excludeGroups: ['source-group-id'] } },
        }, blast_radius: 'tenant-lockout',
      },
      {
        id: 'source-group', natural_key: 'group:Admins', resource_type: 'group',
        payload: { displayName: 'Admins', mailNickname: 'admins', parentGroupId: 'source-policy-id' }, blast_radius: 'access-affecting',
      },
    ],
    references: [
      { from_version: 'source-policy', field_path: 'conditions.users.excludeGroups[0]', to_symbol: 'group:Admins', required: true },
      { from_version: 'source-group', field_path: 'parentGroupId', to_symbol: 'conditionalAccessPolicy:Protect-Admins', required: true },
    ],
  };
}

function restoreFakes({
  resourceSet = restoreResources(),
  failPatch = false,
  applyWave: applyWaveFn = applyWave,
  planWaves: planWavesFn,
} = {}) {
  const state = { connectUrls: [], clientEnds: 0, writes: [], waveCalls: [], waveResults: [], priorStates: [] };
  const client = {
    query: async (sql, values) => {
      // Task-61: no relationship edges were observed in these fixture snapshots (legacy).
      if (/FROM relationship_edge_set/.test(sql)) return { rows: [] };
      if (/INSERT INTO rollback_entry/.test(sql)) {
        state.priorStates.push(values);
        return { rows: [] };
      }
      throw new Error(`unexpected test-database query: ${sql}`);
    },
    end: async () => { state.clientEnds += 1; },
  };
  // Plan task 8: an enforce run only ever promotes a completed dry-run artifact. This
  // fixture's own selection scope is what the artifact freezes — the closure is still
  // recomputed for real from resourceSet by the REAL dependencyClosure.
  const fakeArtifact = {
    id: FIXTURE_ARTIFACT_ID,
    status: 'completed',
    snapshotId: 'source-snapshot',
    selection: resourceSet.versions.map((v) => v.natural_key),
    reconciliationResources: null,
    collectorConfigPath: '/fixtures/collector.json',
    targetConfigPath: '/fixtures/restorer.json',
    digest: 'fixture-digest',
    currentStateFingerprint: 'fixture-fingerprint',
  };
  const bodiesByPath = new Map();

  class FakeReader {
    async collect(version, path) {
      assert.equal(version, 'v1.0');
      if (path === '/identity/conditionalAccess/policies' || path.startsWith('/roleManagement/directory/roleAssignments')
        || path.startsWith('/groups?') || path === '/directory/deletedItems/microsoft.graph.group') {
        return { items: [], capped: false, error: null };
      }
      throw new Error(`unexpected reader collection: ${path}`);
    }

    async get(version, path) {
      assert.equal(version, 'v1.0');
      if (path === '/policies/authenticationMethodsPolicy') return { ok: true, status: 200, body: { id: 'authenticationMethodsPolicy' } };
      if (path === '/policies/identitySecurityDefaultsEnforcementPolicy') return { ok: true, status: 200, body: { id: 'identitySecurityDefaultsEnforcementPolicy', isEnabled: true } };
      if (path.startsWith('/users/')) return { ok: true, status: 200, body: { id: 'break-glass-id', accountEnabled: true } };
      throw new Error(`unexpected reader read: ${path}`);
    }
  }

  class FakeWriter {
    async write(version, path, options) {
      assert.equal(version, 'v1.0');
      state.writes.push({ path, options });
      if (options.method === 'PATCH' && failPatch) return { ok: false, status: 400, body: { error: 'patch failed' } };

      if (options.method === 'PATCH') {
        bodiesByPath.set(path, { ...(bodiesByPath.get(path) ?? {}), ...options.body });
        return { ok: true, status: 204, body: null };
      }

      const targetId = path === '/groups'
        ? (options.body.displayName === 'Finance' ? 'target-group-id'
          : options.body.displayName === 'Admins' ? 'target-admins-group-id' : 'target-parent-id')
        : path === '/identity/conditionalAccess/policies' ? 'target-policy-id'
          : 'target-role-assignment-id';
      bodiesByPath.set(`${path}/${targetId}`, options.body);
      return { ok: true, status: 201, body: { id: targetId } };
    }

    async read(version, path) {
      assert.equal(version, 'v1.0');
      return { ok: true, status: 200, body: bodiesByPath.get(path) };
    }
  }

  return {
    state,
    dependencies: {
      connect: async (url) => {
        assert.equal(url, testDbUrl, 'restore CLI tests must use KEEL_DB_TEST_URL only');
        state.connectUrls.push(url);
        return client;
      },
      getResourceVersions: async () => resourceSet.versions,
      getReferences: async () => resourceSet.references,
      planWaves: planWavesFn ?? (() => ({ waves: resourceSet.waves, patches: resourceSet.patches })),
      getToken: async () => ({ accessToken: 'fake-token' }),
      GraphReader: FakeReader,
      collectM1: async () => [],
      canonicalizeAll: () => [{
        naturalKey: 'roleAssignment:GlobalAdministrator:break-glass', resourceType: 'roleAssignment', sourceId: 'target-break-glass-role-id',
        payload: { principalId: 'break-glass-id' },
      }],
      GraphWriter: FakeWriter,
      ThrottleGovernor: class { async acquire() {} },
      applyWave: async (...args) => {
        state.waveCalls.push(args[2].map((resource) => resource.naturalKey));
        const result = await applyWaveFn(...args);
        state.waveResults.push(result);
        return result;
      },
      getDryRunArtifactById: async () => fakeArtifact,
      // This is exhaustively covered elsewhere (dryRunArtifact.test.mjs,
      // artifactPromotionFakes below) — stubbed here so these write-path fixtures
      // don't have to also fabricate a digest/fingerprint that matches what this
      // fixture's own fake resources would freshly recompute.
      validateArtifactForExecution: () => ({ ok: true }),
    },
  };
}

async function runFixture(dependencies, { logger = { log() {}, error() {} } } = {}) {
  return runCli({
    argv: artifactArgv,
    readFile: readFixture,
    dbUrl: testDbUrl,
    dependencies,
    logger,
  });
}

// The group ID produced by wave one reaches wave two as run provenance, so the
// role assignment's source-tenant principal ID is rewritten before its write.
{
  const fixture = restoreFakes();
  const exitCode = await runFixture(fixture.dependencies);
  assert.equal(exitCode, 0, JSON.stringify(fixture.state.waveResults));
  assert.deepEqual(fixture.state.connectUrls, [testDbUrl]);
  assert.equal(fixture.state.clientEnds, 1);
  const roleAssignmentWrite = fixture.state.writes.find(({ path, options }) =>
    path === '/roleManagement/directory/roleAssignments' && options.method === 'POST');
  assert.ok(roleAssignmentWrite, 'expected the second-wave role assignment write');
  assert.equal(roleAssignmentWrite.options.body.principalId, 'target-group-id');
}

// A null result is not provenance. The same plan therefore fails before the
// second wave can send its unresolved source-tenant reference to the writer.
{
  let waveCount = 0;
  const fixture = restoreFakes({
    applyWave: async (...args) => {
      waveCount += 1;
      if (waveCount === 1) return { applied: [{ naturalKey: 'group:Finance', targetId: null }], skipped: [], failed: [] };
      return applyWave(...args);
    },
  });
  const exitCode = await runFixture(fixture.dependencies);
  assert.equal(exitCode, 1);
  assert.equal(fixture.state.writes.length, 0, 'unresolved provenance must fail before any writer call');
  assert.deepEqual(fixture.state.waveCalls, [['group:Finance'], ['roleAssignment:GlobalAdmin:Finance']]);
  assert.equal(fixture.state.clientEnds, 1);
}

// A failed wave stops the run before later waves can write, returns a non-zero
// CLI outcome, and still closes the test-database client.
{
  const fixture = restoreFakes({
    applyWave: async () => ({ applied: [], skipped: [], failed: [{ naturalKey: 'group:Finance', error: 'write failed' }] }),
  });
  const exitCode = await runFixture(fixture.dependencies);
  assert.equal(exitCode, 1);
  assert.deepEqual(fixture.state.waveCalls, [['group:Finance']]);
  assert.equal(fixture.state.writes.length, 0);
  assert.deepEqual(fixture.state.connectUrls, [testDbUrl]);
  assert.equal(fixture.state.clientEnds, 1);
}

// A failed deferred patch has the same non-zero CLI outcome, closes the test
// client, and stops before a later patch can write.
{
  const fixture = restoreFakes({ resourceSet: patchResources(), failPatch: true });
  const exitCode = await runFixture(fixture.dependencies);
  assert.equal(exitCode, 1);
  const patchWrites = fixture.state.writes.filter(({ options }) => options.method === 'PATCH');
  assert.equal(patchWrites.length, 1, 'a failed patch must stop later patch writes');
  assert.deepEqual(fixture.state.connectUrls, [testDbUrl]);
  assert.equal(fixture.state.clientEnds, 1);
}

// The CLI passes the planner's deferred-edge metadata into phase one. The
// cyclic policy is created without its group edge, then gets a nested,
// report-only verified patch only after both fake target IDs exist.
{
  const fixture = restoreFakes({ resourceSet: cyclicResources(), planWaves });
  const exitCode = await runFixture(fixture.dependencies);
  assert.equal(exitCode, 0, JSON.stringify(fixture.state.waveResults));
  const phaseOnePolicyWrite = fixture.state.writes.find(({ path, options }) =>
    path === '/identity/conditionalAccess/policies' && options.method === 'POST');
  assert.equal(phaseOnePolicyWrite.options.body.conditions.users.excludeGroups[0], undefined);
  const deferredPatchWrite = fixture.state.writes.find(({ path, options }) =>
    path === '/identity/conditionalAccess/policies/target-policy-id' && options.method === 'PATCH');
  assert.deepEqual(deferredPatchWrite.options.body, {
    conditions: { users: { excludeGroups: ['target-admins-group-id'] } },
    state: 'enabledForReportingButNotEnforced',
  });
  assert.equal(fixture.state.clientEnds, 1);
}

// --- plan task 17: selection-driven restore (portal-design §4.1) ---
// The job carries only the operator's RAW selection; the CLI recomputes the
// dependency closure from the snapshot server-side and restores exactly that.
function selectionResources() {
  return {
    versions: [
      {
        id: 'v-policy', natural_key: 'conditionalAccessPolicy:Protect-Admins', resource_type: 'conditionalAccessPolicy',
        payload: {
          displayName: 'Protect Admins', state: 'enabled',
          conditions: { users: { excludeGroups: ['source-admins-id'] } },
        }, blast_radius: 'tenant-lockout',
      },
      {
        id: 'v-admins', natural_key: 'group:Admins', resource_type: 'group',
        payload: { displayName: 'Admins', mailNickname: 'admins' }, blast_radius: 'access-affecting',
      },
      {
        id: 'v-unrelated', natural_key: 'group:Unrelated', resource_type: 'group',
        payload: { displayName: 'Unrelated', mailNickname: 'unrelated' }, blast_radius: 'access-affecting',
      },
    ],
    references: [
      { from_version: 'v-policy', field_path: 'conditions.users.excludeGroups[0]', to_symbol: 'group:Admins', required: true },
    ],
  };
}

function selectionFakes({ resourceSet = selectionResources() } = {}) {
  const state = { connectUrls: [], clientEnds: 0, dbQueries: 0, waveCalls: [], waveResults: [] };
  const client = {
    query: async (sql) => {
      // Task-61: no relationship edges were observed in these fixture snapshots (legacy).
      if (/FROM relationship_edge_set/.test(sql)) return { rows: [] };
      state.dbQueries += 1;
      throw new Error(`a selection restore must not query the plan table: ${sql}`);
    },
    end: async () => { state.clientEnds += 1; },
  };

  class FakeReader {
    async collect(version, path) {
      assert.equal(version, 'v1.0');
      if (path === '/identity/conditionalAccess/policies' || path.startsWith('/roleManagement/directory/roleAssignments')
        || path.startsWith('/groups?') || path === '/directory/deletedItems/microsoft.graph.group') {
        return { items: [], capped: false, error: null };
      }
      throw new Error(`unexpected reader collection: ${path}`);
    }

    async get(version, path) {
      assert.equal(version, 'v1.0');
      if (path === '/policies/authenticationMethodsPolicy') return { ok: true, status: 200, body: { id: 'authenticationMethodsPolicy' } };
      if (path === '/policies/identitySecurityDefaultsEnforcementPolicy') return { ok: true, status: 200, body: { id: 'identitySecurityDefaultsEnforcementPolicy', isEnabled: true } };
      if (path.startsWith('/users/')) return { ok: true, status: 200, body: { id: 'break-glass-id', accountEnabled: true } };
      throw new Error(`unexpected reader read: ${path}`);
    }
  }

  class FakeWriter {
    async write() { throw new Error('a dry-run restore must never write'); }
    async read(version, path) { throw new Error(`unexpected writer read: ${path}`); }
  }

  return {
    state,
    dependencies: {
      connect: async (url) => {
        assert.equal(url, testDbUrl, 'restore CLI tests must use KEEL_DB_TEST_URL only');
        state.connectUrls.push(url);
        return client;
      },
      getResourceVersions: async () => resourceSet.versions,
      getReferences: async () => resourceSet.references,
      planWaves, // the REAL planner — the closure-to-waves path is what is under test
      getToken: async () => ({ accessToken: 'fake-token' }),
      GraphReader: FakeReader,
      collectM1: async () => [],
      canonicalizeAll: () => [
        // group:Admins already exists in the target, so the dry-run can resolve the
        // policy's reference without run provenance from a real write.
        { naturalKey: 'group:Admins', resourceType: 'group', sourceId: 'target-admins-id', payload: { displayName: 'Admins' } },
        { naturalKey: 'roleAssignment:GlobalAdministrator:break-glass', resourceType: 'roleAssignment', sourceId: 'target-break-glass-role-id', payload: { principalId: 'break-glass-id' } },
      ],
      GraphWriter: FakeWriter,
      ThrottleGovernor: class { async acquire() {} },
      applyWave: async (...args) => {
        state.waveCalls.push(args[2].map((resource) => resource.naturalKey));
        const result = await applyWave(...args);
        state.waveResults.push(result);
        return result;
      },
    },
  };
}

function runSelectionCli(selection, dependencies, extraArgv = []) {
  return runCli({
    argv: [
      'node', 'keel-restore.mjs',
      '--snapshot-id', 'source-snapshot',
      ...selection.flatMap((key) => ['--select', key]),
      '--target-config', '/fixtures/restorer.json',
      '--collector-config', '/fixtures/collector.json',
      ...extraArgv,
    ],
    readFile: readFixture,
    dbUrl: testDbUrl,
    dependencies,
    logger: { log() {}, error() {} },
  });
}

// Selecting only the CA policy restores exactly the closure: the referenced group is
// pulled in and applied even though it was never selected, and the unrelated group —
// present in the same snapshot — is never planned at all.
{
  const fixture = selectionFakes();
  const exitCode = await runSelectionCli(['conditionalAccessPolicy:Protect-Admins'], fixture.dependencies);
  assert.equal(exitCode, 0, JSON.stringify(fixture.state.waveResults));
  assert.deepEqual(
    fixture.state.waveCalls,
    [['group:Admins'], ['conditionalAccessPolicy:Protect-Admins']],
    'the restore scope is the selection closure, not the whole snapshot',
  );
  const applied = fixture.state.waveResults.flatMap((r) => r.applied.map((a) => a.naturalKey));
  assert.ok(
    applied.includes('group:Admins'),
    'the pulled-in dependency must be applied even though it was not in the selection',
  );
  assert.ok(!applied.includes('group:Unrelated'), 'an unselected, unreferenced resource is never touched');
  assert.equal(fixture.state.dbQueries, 0, 'the selection path loads no plan row');
  assert.equal(fixture.state.clientEnds, 1);
}

// A selected key the snapshot does not contain fails loudly — restoring something the
// operator did not choose, silently, is the worse failure.
{
  const fixture = selectionFakes();
  const exitCode = await runSelectionCli(['group:Does-Not-Exist'], fixture.dependencies);
  assert.equal(exitCode, 1);
  assert.equal(fixture.state.waveCalls.length, 0, 'no wave may run when the selection cannot be resolved');
  assert.equal(fixture.state.clientEnds, 1);
}

// Delete waves use reverse topology in the real restore orchestration: the
// role assignment that refers to the group must be deleted before the group.
// This must not reuse the forward create/update planner.
{
  const group = {
    naturalKey: 'group:Finance', resourceType: 'group', targetId: 'target-group-id',
    payload: null, live: { targetId: 'target-group-id', payload: { id: 'target-group-id' } },
    references: [], blastRadius: 'access-affecting', restorePriority: 100, verb: 'delete',
  };
  const roleAssignment = {
    naturalKey: 'roleAssignment:GlobalAdministrator@group:Finance@/', resourceType: 'roleAssignment',
    targetId: 'target-role-assignment-id', payload: null,
    live: { targetId: 'target-role-assignment-id', payload: { id: 'target-role-assignment-id' } },
    references: [{ field: 'principalId', symbol: group.naturalKey, required: true }],
    blastRadius: 'access-affecting', restorePriority: 100, verb: 'delete',
  };
  const fixture = restoreFakes({
    applyWave: async (_writer, _governor, wave) => ({
      applied: wave.map((resource) => ({ naturalKey: resource.naturalKey, targetId: resource.targetId })),
      skipped: [], failed: [],
    }),
    planWaves: (resources) => {
      assert.deepEqual(resources, [], 'delete resources must not use the forward planner');
      return { waves: [], patches: [] };
    },
  });
  fixture.dependencies.buildReconciliationPlan = async () => ({ resources: [group, roleAssignment] });
  const exitCode = await runFixture(fixture.dependencies);
  assert.equal(exitCode, 0);
  assert.deepEqual(fixture.state.waveCalls, [
    [roleAssignment.naturalKey],
    [group.naturalKey],
  ]);
}

// Roadmap task-59: the delete is refused at execution when the CURRENT live
// state still has a dependent the plan neither deletes nor rewrites — before
// any write — instead of only logging the dangling reference.
{
  const group = {
    naturalKey: 'group:Finance', resourceType: 'group', targetId: 'target-group-id',
    payload: null, live: { targetId: 'target-group-id', payload: { id: 'target-group-id' } },
    references: [], blastRadius: 'access-affecting', restorePriority: 100, verb: 'delete',
  };
  const fixture = restoreFakes({
    applyWave: async () => { throw new Error('no wave may run when a live dependent would be left dangling'); },
    planWaves: () => ({ waves: [], patches: [] }),
  });
  fixture.dependencies.buildReconciliationPlan = async () => ({ resources: [group] });
  fixture.dependencies.canonicalizeAll = () => [
    { naturalKey: 'group:Finance', resourceType: 'group', sourceId: 'target-group-id', payload: {}, references: [] },
    {
      naturalKey: 'conditionalAccessPolicy:Finance-MFA', resourceType: 'conditionalAccessPolicy', sourceId: 'target-ca-id', payload: {},
      references: [{ field: 'conditions.users.includeGroups[0]', symbol: 'group:Finance', required: true }],
    },
  ];
  const errors = [];
  const exitCode = await runFixture(fixture.dependencies, { logger: { log() {}, error: (e) => errors.push(String(e)) } });
  assert.equal(exitCode, 1);
  assert.equal(fixture.state.waveCalls.length, 0);
  assert.match(errors.join('\n'), /blocked-dependent-impact: deleting group:Finance would leave conditionalAccessPolicy:Finance-MFA referencing it/);
}

// --select without --snapshot-id (and vice versa) is a usage error, not a partial run.
{
  const errors = [];
  const exitCode = await runCli({
    argv: ['node', 'keel-restore.mjs', '--select', 'group:Admins',
      '--target-config', '/fixtures/restorer.json', '--collector-config', '/fixtures/collector.json'],
    readFile: readFixture,
    dbUrl: testDbUrl,
    logger: { log() {}, error: (err) => errors.push(String(err)) },
  });
  assert.equal(exitCode, 1);
  assert.ok(errors.some((e) => e.includes('--select requires --snapshot-id')));
}
{
  const errors = [];
  const exitCode = await runCli({
    argv: ['node', 'keel-restore.mjs', '--snapshot-id', 'source-snapshot',
      '--target-config', '/fixtures/restorer.json', '--collector-config', '/fixtures/collector.json'],
    readFile: readFixture,
    dbUrl: testDbUrl,
    logger: { log() {}, error: (err) => errors.push(String(err)) },
  });
  assert.equal(exitCode, 1);
  assert.ok(errors.some((e) => e.includes('--snapshot-id requires at least one --select')));
}
// --plan and the selection scope are mutually exclusive.
{
  const errors = [];
  const exitCode = await runCli({
    argv: ['node', 'keel-restore.mjs', '--plan', 'fixture-plan',
      '--snapshot-id', 'source-snapshot', '--select', 'group:Admins',
      '--target-config', '/fixtures/restorer.json', '--collector-config', '/fixtures/collector.json'],
    readFile: readFixture,
    dbUrl: testDbUrl,
    logger: { log() {}, error: (err) => errors.push(String(err)) },
  });
  assert.equal(exitCode, 1);
  assert.ok(errors.some((e) => e.includes('mutually exclusive')));
}

// --- plan task 8: restore promotion requires an immutable dry-run artifact ---

// A direct selection-scoped enforce (no --artifact) is refused before it ever reaches
// the database, the target reader, or the writer — the direct-bypass this task closes.
{
  const errors = [];
  const exitCode = await runCli({
    argv: [
      'node', 'keel-restore.mjs',
      '--snapshot-id', 'source-snapshot', '--select', 'group:Admins',
      '--target-config', '/fixtures/restorer.json', '--collector-config', '/fixtures/collector.json',
      '--enforce',
    ],
    readFile: readFixture,
    dbUrl: testDbUrl,
    dependencies: {
      connect: async () => { throw new Error('a refused direct enforce must never connect to the database'); },
    },
    logger: { log() {}, error: (err) => errors.push(String(err)) },
  });
  assert.equal(exitCode, 1);
  assert.ok(errors.some((e) => e.includes('requires --artifact')));
}

// The same direct-bypass gate must hold inside runRestore() itself, independent of
// the CLI argv parser above — cli/keel-remediate.mjs imports and calls runRestore()
// directly, never going through main()'s argv-level copy of this check.
await assert.rejects(
  runRestore({
    snapshotId: 'source-snapshot',
    selection: ['group:Admins'],
    targetConfig: { tenantId: 'target-tenant' },
    collectorConfig: { tenantId: 'target-tenant', clientId: 'collector-client' },
    mode: 'enforce',
    dbUrl: testDbUrl,
    dependencies: {
      connect: async () => { throw new Error('a refused direct enforce must never connect to the database'); },
    },
    logger: { log() {} },
  }),
  (error) => error.message.includes('requires artifactId'),
  'runRestore() must itself refuse a raw snapshot/selection enforce, not rely solely on the CLI argv parser',
);

// The same internal gate must independently hold for a PLAN scope too — not just
// selection. cli/keel-remediate.mjs and cli/keel-worker.mjs both call runRestore()
// directly, never through main()'s argv parser, so a plan-scoped enforce that only
// the argv-level check refused (and not this one) would still be reachable from
// those callers. This is the exact variant a narrowed runRestore()-internal guard
// (e.g. one that special-cased planId) would let through undetected.
await assert.rejects(
  runRestore({
    planId: 'fixture-plan',
    targetConfig: { tenantId: 'target-tenant' },
    collectorConfig: { tenantId: 'target-tenant', clientId: 'collector-client' },
    mode: 'enforce',
    dbUrl: testDbUrl,
    dependencies: {
      connect: async () => { throw new Error('a refused direct plan enforce must never connect to the database'); },
    },
    logger: { log() {} },
  }),
  (error) => error.message.includes('requires artifactId'),
  'runRestore() must itself refuse a raw plan-scoped enforce, not rely solely on the CLI argv parser',
);

// A saved plan is not an exception to immutable review. This closes the previously
// surviving plan-scoped bypass before it opens a database connection.
{
  const errors = [];
  const exitCode = await runCli({
    argv: [
      'node', 'keel-restore.mjs', '--plan', 'fixture-plan',
      '--target-config', '/fixtures/restorer.json', '--collector-config', '/fixtures/collector.json',
      '--enforce',
    ],
    readFile: readFixture,
    dbUrl: testDbUrl,
    dependencies: {
      connect: async () => { throw new Error('a refused plan enforce must never connect to the database'); },
    },
    logger: { log() {}, error: (err) => errors.push(String(err)) },
  });
  assert.equal(exitCode, 1);
  assert.ok(errors.some((error) => error.includes('requires --artifact')));
}

function artifactPromotionFakes(artifacts, { targetHasAdminsGroup = false } = {}) {
  const state = { writes: [], clientEnds: 0 };
  const client = {
    query: async (sql) => {
      // Task-61: no relationship edges were observed in these fixture snapshots (legacy).
      if (/FROM relationship_edge_set/.test(sql)) return { rows: [] };
      if (/SELECT tenant_ref FROM snapshot/.test(sql)) return { rows: [{ tenant_ref: 'sha256:task-8-test' }] };
      if (/INSERT INTO rollback_entry/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
    end: async () => { state.clientEnds += 1; },
  };

  class FakeReader {
    async collect() { return { items: [], capped: false, error: null }; }
    async get(_version, path) {
      if (path === '/policies/authenticationMethodsPolicy') return { ok: true, status: 200, body: { id: 'methods' } };
      if (path === '/policies/identitySecurityDefaultsEnforcementPolicy') return { ok: true, status: 200, body: { id: 'defaults', isEnabled: false } };
      if (path.startsWith('/users/')) return { ok: true, status: 200, body: { id: 'break-glass-id', accountEnabled: true } };
      throw new Error(`unexpected reader read: ${path}`);
    }
  }

  const bodiesByPath = new Map();
  class FakeWriter {
    async write(_version, path, options) {
      state.writes.push({ path, options });
      bodiesByPath.set(`${path}/target-admins-id`, options.body);
      return { ok: true, status: 201, body: { id: 'target-admins-id' } };
    }
    async read(_version, path) {
      return { ok: true, status: 200, body: bodiesByPath.get(path) };
    }
  }

  return {
    state,
    dependencies: {
      connect: async (url) => {
        assert.equal(url, testDbUrl, 'promotion fixtures use KEEL_DB_TEST_URL only');
        return client;
      },
      getResourceVersions: async () => [{
        id: 'v-admins', natural_key: 'group:Admins', resource_type: 'group',
        payload: { displayName: 'Admins', mailNickname: 'admins' }, blast_radius: 'access-affecting',
      }],
      getReferences: async () => [],
      planWaves: () => ({ waves: [['group:Admins']], patches: [] }),
      buildReconciliationPlan: async (_reader, resources) => ({
        resources: resources.map((resource) => ({ ...resource, verb: 'create' })),
      }),
      getToken: async () => ({ accessToken: 'fake-token' }),
      GraphReader: FakeReader,
      collectM1: async () => [],
      canonicalizeAll: () => [
        {
          naturalKey: 'roleAssignment:GlobalAdministrator:break-glass', resourceType: 'roleAssignment',
          sourceId: 'target-break-glass-role-id', payload: { principalId: 'break-glass-id' },
        },
        ...(targetHasAdminsGroup ? [{
          naturalKey: 'group:Admins', resourceType: 'group', sourceId: 'target-admins-id',
          payload: { displayName: 'Admins', mailNickname: 'admins' },
        }] : []),
      ],
      GraphWriter: FakeWriter,
      ThrottleGovernor: class { async acquire() {} },
      createDryRunArtifact: async (_client, fields) => {
        const artifact = { ...fields, createdAt: new Date().toISOString() };
        artifacts.set(fields.id, artifact);
        return artifact;
      },
      getDryRunArtifactById: async (_client, { id }) => artifacts.get(id) ?? null,
    },
  };
}

function runDryRunArtifact(artifactId, dependencies, errors = []) {
  return runCli({
    argv: [
      'node', 'keel-restore.mjs', '--snapshot-id', 'source-snapshot', '--select', 'group:Admins',
      '--target-config', '/fixtures/restorer.json', '--collector-config', '/fixtures/collector.json',
      '--persist-artifact', artifactId, '--requested-by', 'principal-restorer',
    ],
    readFile: readFixture, dbUrl: testDbUrl, dependencies,
    logger: { log() {}, error: (error) => errors.push(String(error)) },
  });
}

function runArtifactPromotion(artifactId, dependencies, errors = []) {
  return runCli({
    argv: ['node', 'keel-restore.mjs', '--artifact', artifactId, '--enforce'],
    readFile: readFixture, dbUrl: testDbUrl, dependencies,
    logger: { log() {}, error: (error) => errors.push(String(error)) },
  });
}

// A clean dry run persists a completed artifact, and promoting it with an unchanged
// target succeeds. The promotion receives only the artifact id and actually writes.
{
  const artifacts = new Map();
  const dryRun = artifactPromotionFakes(artifacts);
  assert.equal(await runDryRunArtifact('11111111-0000-4000-8000-000000000001', dryRun.dependencies), 0);
  assert.equal(dryRun.state.writes.length, 0, 'a dry run must never write');
  const artifact = artifacts.get('11111111-0000-4000-8000-000000000001');
  assert.equal(artifact.status, 'completed');
  assert.deepEqual(artifact.selection, ['group:Admins']);
  assert.deepEqual(artifact.closureKeys, ['group:Admins']);
  assert.deepEqual(
    artifact.results,
    {
      applied: [{ naturalKey: 'group:Admins', targetId: null }],
      skipped: [], failed: [], notRemediable: [],
    },
    'the persisted dry-run artifact retains the actual per-resource result',
  );

  const promotion = artifactPromotionFakes(artifacts);
  assert.equal(await runArtifactPromotion(artifact.id, promotion.dependencies), 0);
  assert.equal(promotion.state.writes.length, 1, 'a completed immutable artifact promotes one write');
}

// Promotion must recheck the configs loaded from the artifact's paths, even when
// the dry run and the caller supplied separated credentials. Files can change
// between review and promotion without changing the immutable artifact itself.
{
  const artifacts = new Map();
  const dryRun = artifactPromotionFakes(artifacts);
  const artifactId = '33333333-0000-4000-8000-000000000003';
  assert.equal(await runDryRunArtifact(artifactId, dryRun.dependencies), 0);
  assert.equal(artifacts.get(artifactId).status, 'completed');
  const collectorConfig = JSON.parse(readFixture('/fixtures/collector.json'));
  const targetConfig = JSON.parse(readFixture('/fixtures/restorer.json'));

  for (const field of ['clientId', 'certPath', 'keyPath', 'tenantId']) {
    const promotion = artifactPromotionFakes(artifacts);
    const configReads = [];
    let tokenCalls = 0;
    promotion.dependencies.getToken = async () => {
      tokenCalls += 1;
      return { accessToken: 'fake-token' };
    };
    await assert.rejects(runRestore({
      artifactId,
      mode: 'enforce',
      collectorConfig,
      targetConfig,
      readFile: (path) => {
        configReads.push(path);
        const config = JSON.parse(readFixture(path));
        if (path === '/fixtures/restorer.json') {
          config[field] = field === 'tenantId' ? 'different-tenant' : collectorConfig[field];
        }
        return JSON.stringify(config);
      },
      dbUrl: testDbUrl,
      dependencies: promotion.dependencies,
      logger: { log() {} },
    }), field === 'tenantId'
      ? /Collector tenantId must match the Restorer tenantId/
      : /restore requires separate Collector and Restorer registrations and certificates/,
    `promotion must reject the freshly loaded ${field}, regardless of the caller's configs`);
    assert.deepEqual(configReads, ['/fixtures/collector.json', '/fixtures/restorer.json']);
    assert.equal(tokenCalls, 0, 'credential separation is checked before acquiring either token');
    assert.deepEqual(promotion.state.writes, [], 'non-separated credentials must never write');
    assert.equal(promotion.state.clientEnds, 1, 'refused promotion closes its database client');
  }

  const separatedPromotion = artifactPromotionFakes(artifacts);
  assert.equal(await runArtifactPromotion(artifactId, separatedPromotion.dependencies), 0);
  assert.equal(separatedPromotion.state.writes.length, 1, 'the same artifact still promotes with separated credentials');
  assert.equal(separatedPromotion.state.clientEnds, 1);
}

// Persistence failures must reach the CLI caller, including duplicate artifact IDs.
{
  const dryRun = artifactPromotionFakes(new Map());
  const errors = [];
  let persistenceAttempts = 0;
  dryRun.dependencies.createDryRunArtifact = async () => {
    persistenceAttempts += 1;
    throw Object.assign(new Error('duplicate key value violates unique constraint "restore_dry_run_pkey"'), {
      code: '23505',
    });
  };
  assert.equal(await runDryRunArtifact('11111111-0000-4000-8000-000000000001', dryRun.dependencies, errors), 1);
  assert.equal(persistenceAttempts, 1);
  assert.ok(errors.some((error) => error.includes('restore_dry_run_pkey')));
  assert.equal(dryRun.state.clientEnds, 1, 'a rejected artifact write still closes the database client');
  assert.equal(dryRun.state.writes.length, 0, 'a rejected dry run performs no Graph writes');
}

// Mutation (b): the target changed between dry run and promotion. Skipping the
// fingerprint comparison would make this test write; the promotion instead refuses
// before a single write and forces a fresh dry run.
{
  const artifacts = new Map();
  const dryRun = artifactPromotionFakes(artifacts);
  await runDryRunArtifact('22222222-0000-4000-8000-000000000002', dryRun.dependencies);
  const promotion = artifactPromotionFakes(artifacts, { targetHasAdminsGroup: true });
  const errors = [];
  assert.equal(
    await runArtifactPromotion('22222222-0000-4000-8000-000000000002', promotion.dependencies, errors),
    1,
  );
  assert.equal(promotion.state.writes.length, 0, 'a stale artifact must never write');
  assert.ok(errors.some((error) => error.includes('target has changed since the dry run')));
}

// Dependent-impact refusals in a preview or dry run are reported, not thrown: the
// operator sees the full plan with the delete refused, a persisted dry run would
// classify as refused (so the artifact gate blocks promotion), and nothing is
// written. Only a run that can write throws — and a missing mode counts as one.
{
  const dependentImpactFixture = () => {
    const group = {
      naturalKey: 'group:Finance', resourceType: 'group', targetId: 'target-group-id',
      payload: null, live: { targetId: 'target-group-id', payload: { id: 'target-group-id' } },
      references: [], blastRadius: 'access-affecting', restorePriority: 100, verb: 'delete',
    };
    const fixture = restoreFakes({ planWaves: () => ({ waves: [], patches: [] }) });
    fixture.dependencies.buildReconciliationPlan = async () => ({ resources: [group] });
    fixture.dependencies.canonicalizeAll = () => [
      { naturalKey: 'group:Finance', resourceType: 'group', sourceId: 'target-group-id', payload: {}, references: [] },
      {
        naturalKey: 'conditionalAccessPolicy:Finance-MFA', resourceType: 'conditionalAccessPolicy', sourceId: 'target-ca-id', payload: {},
        references: [{ field: 'conditions.users.includeGroups[0]', symbol: 'group:Finance', required: true }],
      },
      {
        naturalKey: 'roleAssignment:GlobalAdministrator:break-glass', resourceType: 'roleAssignment', sourceId: 'target-break-glass-role-id',
        payload: { principalId: 'break-glass-id' },
      },
    ];
    return fixture;
  };
  const scope = {
    snapshotId: 'source-snapshot',
    selection: ['group:Finance'],
    collectorConfig: { tenantId: 'target-tenant', clientId: 'collector-client' },
    targetConfig: { tenantId: 'target-tenant', clientId: 'restorer-client' },
    dbUrl: testDbUrl,
    logger: { log() {} },
  };
  const dependentImpact = /^blocked-dependent-impact: deleting group:Finance would leave conditionalAccessPolicy:Finance-MFA referencing it at conditions\.users\.includeGroups\[0\]$/;

  const preview = dependentImpactFixture();
  const previewResult = await runRestore({ ...scope, mode: 'dry-run', previewOnly: true, dependencies: preview.dependencies });
  const previewRefusal = previewResult.guardRefusals.find((refusal) => refusal.naturalKey === 'group:Finance');
  assert.ok(previewRefusal, 'the preview must report the dependent-impact delete as a refusal');
  assert.match(previewRefusal.reason, dependentImpact);
  assert.equal(previewResult.guardRefusals.filter((refusal) => refusal.naturalKey === 'group:Finance').length, 1,
    'a key is reported once even when several dependents or guards refuse it');
  assert.equal(preview.state.waveCalls.length, 0, 'a preview never runs a wave');
  assert.deepEqual(preview.state.writes, []);

  const dryRun = dependentImpactFixture();
  const dryRunResult = await runRestore({ ...scope, mode: 'dry-run', dependencies: dryRun.dependencies });
  assert.ok(dryRunResult.results.skipped.some((entry) => entry.naturalKey === 'group:Finance' && dependentImpact.test(entry.reason)),
    'a dry run reports the refused delete as skipped');
  assert.ok(!dryRunResult.results.applied.some((entry) => entry.naturalKey === 'group:Finance'),
    'a refused delete is never reported as applied');
  assert.deepEqual(dryRun.state.writes, [], 'a dry run writes nothing');

  const noMode = dependentImpactFixture();
  await assert.rejects(
    runRestore({ ...scope, mode: undefined, dependencies: noMode.dependencies }),
    /blocked-dependent-impact: deleting group:Finance/,
    'any mode other than an explicit dry run must refuse before a wave runs',
  );
  assert.equal(noMode.state.waveCalls.length, 0);
  assert.deepEqual(noMode.state.writes, []);
}

console.log('keel-restore.test.mjs — all assertions passed');
