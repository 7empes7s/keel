import { strict as assert } from 'node:assert';
import { applyWave } from '../engine/restore/applyEngine.mjs';
import { planWaves } from '../engine/restore/wavePlanner.mjs';
import { runCli } from './keel-restore.mjs';

const testDbUrl = process.env.KEEL_DB_TEST_URL;
assert.ok(testDbUrl, 'KEEL_DB_TEST_URL must be set for restore CLI tests');

const argv = [
  'node', 'keel-restore.mjs',
  '--plan', 'fixture-plan',
  '--target-config', '/fixtures/restorer.json',
  '--collector-config', '/fixtures/collector.json',
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
    query: async (sql) => {
      assert.match(sql, /SELECT \* FROM plan/);
      return { rows: [{ id: 'fixture-plan', source_snapshot: 'source-snapshot', clean: true }] };
    },
    end: async () => { state.clientEnds += 1; },
  };
  const bodiesByPath = new Map();

  class FakeReader {
    async collect(version, path) {
      assert.equal(version, 'v1.0');
      if (path === '/identity/conditionalAccess/policies' || path.startsWith('/roleManagement/directory/roleAssignments?')) {
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
      recordPriorState: async (...args) => { state.priorStates.push(args); },
    },
  };
}

async function runFixture(dependencies) {
  return runCli({
    argv,
    readFile: readFixture,
    dbUrl: testDbUrl,
    dependencies,
    logger: { log() {}, error() {} },
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
      state.dbQueries += 1;
      throw new Error(`a selection restore must not query the plan table: ${sql}`);
    },
    end: async () => { state.clientEnds += 1; },
  };

  class FakeReader {
    async collect(version, path) {
      assert.equal(version, 'v1.0');
      if (path === '/identity/conditionalAccess/policies' || path.startsWith('/roleManagement/directory/roleAssignments?')) {
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
      recordPriorState: async () => { throw new Error('a dry-run restore must not journal'); },
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

console.log('keel-restore.test.mjs — all assertions passed');
