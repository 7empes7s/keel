// Gap D7: the "delete this natural key" restore scope, end to end through
// cli/keel-restore.mjs with fixtures only (no tenant is ever reached). A key that is
// live but absent from the snapshot is planned as a delete by the real
// reconciliation plan, persisted in the dry-run artifact, and executed only by
// promoting that artifact, through applyWave's existing delete guards.
import { strict as assert } from 'node:assert';
import { applyWave } from '../engine/restore/applyEngine.mjs';
import { runCli } from './keel-restore.mjs';

const DB_URL = 'postgres://fixture-only/keel_test';
const configs = new Map([
  ['/fixtures/restorer.json', JSON.stringify({
    tenantId: 'target-tenant', clientId: 'restorer-client', certPath: '/fixtures/restorer.cer', keyPath: '/fixtures/restorer.key',
  })],
  ['/fixtures/collector.json', JSON.stringify({
    tenantId: 'target-tenant', clientId: 'collector-client', certPath: '/fixtures/collector.cer', keyPath: '/fixtures/collector.key',
  })],
]);
function readFixture(path) {
  if (!configs.has(path)) throw new Error(`unexpected fixture read: ${path}`);
  return configs.get(path);
}

// The snapshot holds one group. The target holds that group, a stale group the
// snapshot never had, and a named location the snapshot never had.
const SNAPSHOT_VERSIONS = [{
  id: 'v-admins', natural_key: 'group:admins', resource_type: 'group',
  payload: { id: 'target-admins-id', displayName: 'Admins', mailNickname: 'admins' }, blast_radius: 'access-affecting',
}];
const LIVE = {
  group: [
    { id: 'target-admins-id', displayName: 'Admins', mailNickname: 'admins' },
    { id: 'target-stale-id', displayName: 'Stale', mailNickname: 'stale' },
  ],
  namedLocation: [{ id: 'target-office-id', displayName: 'Old Office' }],
};

function fakes(artifacts) {
  const state = { writes: [], reads: [], waveCalls: [], waveResults: [], journal: [] };
  const client = {
    query: async (sql, values) => {
      if (/SELECT tenant_ref FROM snapshot/.test(sql)) return { rows: [{ tenant_ref: 'sha256:d7-test' }] };
      if (/FROM snapshot WHERE id = \$1 AND tenant_ref = \$2/.test(sql)) return { rows: [] };
      if (/recovery_completion_item/.test(sql)) return { rows: [] };
      if (/INSERT INTO rollback_entry/.test(sql)) { state.journal.push(values); return { rows: [{ id: 'journal-1' }] }; }
      if (/UPDATE rollback_entry/.test(sql)) return { rows: [] };
      // Issue #485: no earlier restore created anything in the fixture tenant.
      if (/FROM rollback_entry e/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
    end: async () => {},
  };
  class FakeReader {
    async collect(version, path) {
      assert.equal(version, 'v1.0');
      if (path.startsWith('/groups?')) return { items: LIVE.group, capped: false, error: null };
      if (path.startsWith('/directory/deletedItems/microsoft.graph.group')) return { items: [], capped: false, error: null };
      if (path === '/identity/conditionalAccess/namedLocations') return { items: LIVE.namedLocation, capped: false, error: null };
      // The sign-in path gate's own reads: no policies or assignments in this fixture.
      if (path === '/identity/conditionalAccess/policies' || path.startsWith('/roleManagement/directory/roleAssignments')) {
        return { items: [], capped: false, error: null };
      }
      throw new Error(`unexpected reader collection: ${path}`);
    }
    async get(_version, path) {
      if (path === '/policies/authenticationMethodsPolicy') return { ok: true, status: 200, body: { id: 'methods' } };
      if (path === '/policies/identitySecurityDefaultsEnforcementPolicy') return { ok: true, status: 200, body: { id: 'defaults', isEnabled: false } };
      if (path.startsWith('/users/')) return { ok: true, status: 200, body: { id: 'break-glass-id', accountEnabled: true } };
      throw new Error(`unexpected reader read: ${path}`);
    }
  }
  class FakeWriter {
    async write(_version, path, options) {
      state.writes.push({ path, method: options.method });
      return { ok: true, status: 204, body: null };
    }
    async read(_version, path) {
      state.reads.push(path);
      return { ok: false, status: 404, body: null };
    }
  }
  return {
    state,
    dependencies: {
      connect: async () => client,
      getResourceVersions: async () => SNAPSHOT_VERSIONS,
      getReferences: async () => [],
      getToken: async () => ({ accessToken: 'fake-token' }),
      GraphReader: FakeReader,
      collectM1: async () => [],
      canonicalizeAll: () => [
        { naturalKey: 'roleAssignment:GlobalAdministrator:break-glass', resourceType: 'roleAssignment', sourceId: 'target-break-glass-role-id', payload: { principalId: 'break-glass-id' } },
        ...LIVE.group.map((group) => ({ naturalKey: `group:${group.mailNickname}`, resourceType: 'group', sourceId: group.id, payload: group, references: [] })),
        ...LIVE.namedLocation.map((location) => ({
          naturalKey: `namedLocation:${location.displayName}`, resourceType: 'namedLocation', sourceId: location.id, payload: location, references: [],
        })),
      ],
      GraphWriter: FakeWriter,
      ThrottleGovernor: class { async acquire() {} },
      applyWave: async (...args) => {
        state.waveCalls.push(args[2].map((resource) => ({ naturalKey: resource.naturalKey, verb: resource.verb })));
        const result = await applyWave(...args);
        state.waveResults.push(result);
        return result;
      },
      createDryRunArtifact: async (_client, fields) => {
        const artifact = { ...fields, createdAt: new Date().toISOString() };
        artifacts.set(fields.id, artifact);
        return artifact;
      },
      getDryRunArtifactById: async (_client, { id }) => artifacts.get(id) ?? null,
    },
  };
}

function runDeleteDryRun(keys, dependencies, { artifactId, extraArgv = [], errors = [] } = {}) {
  return runCli({
    argv: [
      'node', 'keel-restore.mjs', '--snapshot-id', 'source-snapshot',
      ...keys.flatMap((key) => ['--delete', key]),
      '--target-config', '/fixtures/restorer.json', '--collector-config', '/fixtures/collector.json',
      ...(artifactId ? ['--persist-artifact', artifactId, '--requested-by', 'principal-restorer'] : []),
      ...extraArgv,
    ],
    readFile: readFixture, dbUrl: DB_URL, dependencies,
    logger: { log() {}, error: (error) => errors.push(String(error)) },
  });
}

// --- the plan of a delete-scope restore: a dry run plans exactly the delete and
// persists it in the artifact; promoting that artifact deletes through applyWave. ---
{
  const artifacts = new Map();
  const artifactId = 'd7d7d7d7-0000-4000-8000-000000000001';
  const dryRun = fakes(artifacts);
  const errors = [];
  assert.equal(await runDeleteDryRun(['group:stale'], dryRun.dependencies, { artifactId, errors }), 0, errors.join('\n'));
  assert.equal(dryRun.state.writes.length, 0, 'a dry run never writes');
  assert.deepEqual(dryRun.state.waveCalls, [[{ naturalKey: 'group:stale', verb: 'delete' }]],
    'only the named key is planned, as a delete, in a delete wave');
  const artifact = artifacts.get(artifactId);
  assert.equal(artifact.status, 'completed', JSON.stringify(artifact.results));
  assert.deepEqual(artifact.selection, ['group:stale']);
  assert.deepEqual(artifact.reconciliationResources, [
    { naturalKey: 'group:stale', resourceType: 'group', payload: null, blastRadius: 'access-affecting' },
  ], 'the artifact carries the delete scope as desired absence');
  assert.deepEqual(artifact.results.applied.map((entry) => entry.naturalKey), ['group:stale']);

  // Promotion (what an approval's job runs): only the artifact id, then a journaled
  // DELETE of the live object, verified absent on re-read.
  const promotion = fakes(artifacts);
  const promotionErrors = [];
  const exitCode = await runCli({
    argv: ['node', 'keel-restore.mjs', '--artifact', artifactId, '--enforce'],
    readFile: readFixture, dbUrl: DB_URL, dependencies: promotion.dependencies,
    logger: { log() {}, error: (error) => promotionErrors.push(String(error)) },
  });
  assert.equal(exitCode, 0, promotionErrors.join('\n'));
  assert.deepEqual(promotion.state.writes, [{ path: '/groups/target-stale-id', method: 'DELETE' }]);
  assert.equal(promotion.state.journal.length, 1, 'the prior state is journaled before the delete');
  assert.deepEqual(promotion.state.reads, ['/groups/target-stale-id']);
}

// --- refused when the key is in the snapshot: nothing is read live or planned ---
{
  const fixture = fakes(new Map());
  const errors = [];
  assert.equal(await runDeleteDryRun(['group:admins'], fixture.dependencies, { errors }), 1);
  assert.ok(errors.some((error) => error.includes('refusing to delete group:admins: the snapshot holds this object')), errors.join('\n'));
  assert.equal(fixture.state.waveCalls.length, 0);
  assert.equal(fixture.state.writes.length, 0);
}

// --- refused for a type without a delete operation ---
{
  const fixture = fakes(new Map());
  const errors = [];
  assert.equal(await runDeleteDryRun(['user:someone@contoso.example'], fixture.dependencies, { errors }), 1);
  assert.ok(errors.some((error) => error.includes('Keel has no reviewed delete operation for user')), errors.join('\n'));
  assert.equal(fixture.state.waveCalls.length, 0);
}

// --- the guards still apply: a named location is tenant-lockout, so its delete is
// refused without break-glass evidence, and the dry run cannot be promoted. ---
{
  const artifacts = new Map();
  const artifactId = 'd7d7d7d7-0000-4000-8000-000000000002';
  const fixture = fakes(artifacts);
  const errors = [];
  assert.equal(await runDeleteDryRun(['namedLocation:Old Office'], fixture.dependencies, { artifactId, errors }), 0, errors.join('\n'));
  const artifact = artifacts.get(artifactId);
  assert.equal(artifact.status, 'refused');
  // The lockout gate (engine/safety/lockoutDeleteGate.mjs) names the missing evidence; this
  // fixture registers no break-glass readiness, so any of its refusals is the expected outcome.
  assert.equal(artifact.results.skipped.length, 1);
  assert.equal(artifact.results.skipped[0].naturalKey, 'namedLocation:Old Office');
  assert.match(artifact.results.skipped[0].reason, /^refusing to delete tenant-lockout resource: /);
  assert.equal(fixture.state.writes.length, 0);

  const promotion = fakes(artifacts);
  const promotionErrors = [];
  assert.equal(await runCli({
    argv: ['node', 'keel-restore.mjs', '--artifact', artifactId, '--enforce'],
    readFile: readFixture, dbUrl: DB_URL, dependencies: promotion.dependencies,
    logger: { log() {}, error: (error) => promotionErrors.push(String(error)) },
  }), 1);
  assert.ok(promotionErrors.some((error) => /not complete \(status: refused\)/.test(error)), promotionErrors.join('\n'));
  assert.equal(promotion.state.writes.length, 0);
}

// --- usage: --delete is its own scope ---
{
  const errors = [];
  const dependencies = { connect: async () => { throw new Error('a usage error must never connect'); } };
  assert.equal(await runDeleteDryRun(['group:stale'], dependencies, { extraArgv: ['--select', 'group:admins'], errors }), 1);
  assert.ok(errors.some((error) => error.includes('--delete and --select are separate restore scopes')));
  assert.equal(await runDeleteDryRun(['group:stale'], dependencies, { extraArgv: ['--enforce'], errors }), 1);
  assert.ok(errors.some((error) => error.includes('enforce requires --artifact')));
}

console.log('keel-restore-delete-scope.test.mjs — all assertions passed');
