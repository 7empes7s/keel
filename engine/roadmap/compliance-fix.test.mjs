/**
 * CoreView gap 6, "Make it pass": a failing compliance control that declares a
 * fix is put right by a one-value restore, through the normal dry run and
 * approval. Exercises engine/benchmarks/fix.mjs, the registry's fix contract,
 * complianceFindings' fix candidates, the worker's argument checks and the full
 * cli/keel-restore.mjs dry run -> approval -> promotion path, against the
 * isolated test database and an in-memory fake Graph. No tenant is read or
 * written. Mutation checks:
 *
 * - Write the fix without an approved request, or with the requester's own.
 * - Write anything but the one setting (other live values are kept).
 * - Promote after the object changed live since the dry run.
 * - Plan a fix for an object that already passes.
 */
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { canonicalHash } from '../cir/canonicalHash.mjs';
import { approveRequest, requestApproval, SelfApprovalError } from '../govern/approvals.mjs';
import { grantRole } from '../authz/administration.mjs';
import { complianceFindings } from '../govern/baselineCompliance.mjs';
import { recordEvaluation } from '../benchmarks/evaluate.mjs';
import { ComplianceFixRefusal, fixFor, fixedPayload, listFixCandidates, needsFix, planComplianceFix } from '../benchmarks/fix.mjs';
import { controlFor, registerControl, registerFixMatcher, registerPredicate } from '../benchmarks/registry.mjs';
import { getDryRunArtifactById } from '../restore/dryRunArtifact.mjs';
import { listJournal } from '../restore/rollbackJournal.mjs';
import { createSnapshot, completeSnapshot, insertResourceVersion } from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';
import { fakeGraph } from '../../tools/qualification/operations.mjs';
import { main, runRestore } from '../../cli/keel-restore.mjs';
import { JOB_HANDLERS as HANDLERS } from '../../cli/keel-worker.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const quiet = { log() {}, error() {} };
const CONTROL = 'keel-custom.named-location.no-untrusted-all-countries';
const KEY = 'namedLocation:KEEL-RT-Anywhere';
const LOCATIONS = '/identity/conditionalAccess/namedLocations';
const risky = Object.freeze({
  '@odata.type': '#microsoft.graph.countryNamedLocation',
  id: 'nl-1',
  displayName: 'KEEL-RT-Anywhere',
  isTrusted: true,
  countriesAndRegions: ['FR', 'MA'],
  includeUnknownCountriesAndRegions: true,
});
const live = (payload = risky) => ({ naturalKey: KEY, resourceType: 'namedLocation', sourceId: payload.id, payload });

// ------------------------------------------------------------------ registry

test('the named-location control declares a one-setting fix; the registry refuses an unsafe one', () => {
  assert.deepEqual({ ...fixFor(CONTROL) }, {
    resourceType: 'namedLocation', field: 'includeUnknownCountriesAndRegions', to: false,
    matcher: 'named-location-trusts-unknown-countries',
  });
  assert.equal(fixFor('keel-custom.group.role-assignable-not-synced'), null, 'a control with no safe one-value fix declares none');
  assert.equal(controlFor('keel-custom.role-assignment.admin-count-at-most').fix, null);

  registerPredicate('fix-test-predicate', () => 'pass');
  registerFixMatcher('fix-test-matcher', () => true);
  const base = {
    title: 't', description: 'd', framework: 'keel-custom', edition: '1.0.0', profile: 'default', evaluatorVersion: 1,
    requiredObservations: [{ resourceType: 'namedLocation', maxAgeMs: 1000 }], predicate: { name: 'fix-test-predicate' },
  };
  assert.throws(() => registerControl({ ...base, controlId: 'fix-test.a', fix: { resourceType: 'group', field: 'displayName', to: 'x', matcher: 'fix-test-matcher' } }), /one the control reads/);
  assert.throws(() => registerControl({ ...base, controlId: 'fix-test.b', fix: { resourceType: 'namedLocation', field: 'id', to: 'x', matcher: 'fix-test-matcher' } }), /not a setting Keel writes/);
  assert.throws(() => registerControl({ ...base, controlId: 'fix-test.c', fix: { resourceType: 'namedLocation', field: 'conditions.users', to: 'x', matcher: 'fix-test-matcher' } }), /one top-level setting/);
  assert.throws(() => registerControl({ ...base, controlId: 'fix-test.d', fix: { resourceType: 'namedLocation', field: 'isTrusted', to: { a: 1 }, matcher: 'fix-test-matcher' } }), /plain value/);
  assert.throws(() => registerControl({ ...base, controlId: 'fix-test.e', fix: { resourceType: 'namedLocation', field: 'isTrusted', to: false, matcher: 'nope' } }), /not allowlisted/);
  assert.throws(() => registerControl({ ...base, controlId: 'fix-test.f', fix: { resourceType: 'namedLocation', field: 'madeUpField', to: false, matcher: 'fix-test-matcher' } }), /not a setting Keel writes/);
});

test('a fix is planned from the live object and changes exactly one setting', () => {
  assert.equal(needsFix(CONTROL, live()), true);
  const plan = planComplianceFix({ controlId: CONTROL, naturalKey: KEY, live: live() });
  assert.deepEqual({ ...plan }, {
    controlId: CONTROL, evaluatorVersion: 1, naturalKey: KEY, resourceType: 'namedLocation', targetId: 'nl-1',
    field: 'includeUnknownCountriesAndRegions', from: true, to: false,
  });
  const fixed = fixedPayload(risky, plan);
  assert.deepEqual(Object.keys(fixed).filter((key) => JSON.stringify(fixed[key]) !== JSON.stringify(risky[key])), ['includeUnknownCountriesAndRegions']);

  const passing = { ...risky, includeUnknownCountriesAndRegions: false };
  assert.throws(() => planComplianceFix({ controlId: CONTROL, naturalKey: KEY, live: live(passing) }), /already passes/);
  assert.throws(() => planComplianceFix({ controlId: CONTROL, naturalKey: KEY, live: undefined }), /not in the tenant now/);
  assert.throws(() => planComplianceFix({ controlId: 'keel-custom.group.role-assignable-not-synced', naturalKey: KEY, live: live() }), ComplianceFixRefusal);
});

// ------------------------------------------------------------- database paths

const TENANT_ID = 'tenant-gap6';
const TENANT = tenantRefFor(TENANT_ID);
const configs = new Map([
  ['/fixtures/collector.json', JSON.stringify({ tenantId: TENANT_ID, clientId: 'collector', certPath: 'c.pem', keyPath: 'c.key' })],
  ['/fixtures/restorer.json', JSON.stringify({ tenantId: TENANT_ID, clientId: 'restorer', certPath: 'r.pem', keyPath: 'r.key' })],
]);
const readFile = (path) => configs.get(path) ?? (() => { throw new Error(`unexpected config read: ${path}`); })();

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(schemaSql());
    schemaReady = true;
  }
  return client;
}

async function seedSnapshot(client, payloads) {
  const snapshotId = await createSnapshot(client, { tenantRef: TENANT });
  for (const payload of payloads) {
    await insertResourceVersion(client, {
      snapshotId,
      resource: {
        naturalKey: `namedLocation:${payload.displayName}`, resourceType: 'namedLocation', payload,
        payloadHash: canonicalHash(payload, 'namedLocation'),
        criticality: 'tier1', blastRadius: 'tenant-lockout', fidelity: 'full', provenance: { adapter: 'test' },
      },
    });
  }
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: {} });
  return snapshotId;
}

function cliDependencies(graph) {
  const locations = () => [...graph.objects].filter(([path]) => path.startsWith(`${LOCATIONS}/`)).map(([, body]) => body);
  class Reader {
    async collect(_version, path) {
      return { items: path.split('?')[0] === LOCATIONS ? locations() : [], capped: false, error: null };
    }
    // The sign-in path singletons the gate reads around a tenant-lockout write.
    async get(_version, path) {
      if (path === '/policies/authenticationMethodsPolicy') return { ok: true, status: 200, body: { id: 'authenticationMethodsPolicy' } };
      if (path === '/policies/identitySecurityDefaultsEnforcementPolicy') return { ok: true, status: 200, body: { id: 'identitySecurityDefaultsEnforcementPolicy', isEnabled: false } };
      if (path.startsWith('/users/')) return { ok: true, status: 200, body: { id: 'break-glass-id', accountEnabled: true } };
      throw new Error(`unexpected read: ${path}`);
    }
  }
  return {
    getToken: async () => ({ accessToken: 'fake-token' }),
    GraphReader: Reader,
    GraphWriter: class { constructor() { return graph; } },
    collectM1: async () => [],
    canonicalizeAll: () => [
      { naturalKey: 'roleAssignment:GlobalAdministrator:break-glass', resourceType: 'roleAssignment', sourceId: 'ra-1', payload: { principalId: 'break-glass-id', roleDefinitionId: '62e90394-69f5-4237-9190-012177145e10' } },
      ...locations().map((body) => ({
        naturalKey: `namedLocation:${body.displayName}`, resourceType: 'namedLocation', sourceId: body.id, payload: body,
      })),
    ],
    loadLockoutGateInputs: async () => ({ configured: false }),
    loadGroupMembership: async () => () => null,
  };
}

/** A requester who may ask for a restore (a real principal with the restorer role). */
async function requester(client) {
  const { rows: [person] } = await client.query(
    `INSERT INTO principal (email) VALUES ($1) RETURNING id`, [`restorer-${crypto.randomUUID()}@contoso.example`],
  );
  await grantRole(client, { principalId: person.id, role: 'restorer', grantedBy: person.id });
  return person.id;
}

const collectorConfig = JSON.parse(configs.get('/fixtures/collector.json'));
const targetConfig = JSON.parse(configs.get('/fixtures/restorer.json'));
const planFix = (run, artifactId, naturalKey = KEY) => run({
  complianceFix: { controlId: CONTROL, naturalKey }, mode: 'dry-run', persistArtifactId: artifactId, requestedBy: 'requester',
  collectorConfig, targetConfig, collectorConfigPath: '/fixtures/collector.json', targetConfigPath: '/fixtures/restorer.json',
});

test('Compliance lists the objects a fix would change, from the newest backup', async (t) => {
  const client = await schemaClient(t);
  const other = { ...risky, id: 'nl-2', displayName: 'KEEL-RT-Office', includeUnknownCountriesAndRegions: false };
  await seedSnapshot(client, [risky, other]);
  const candidates = await listFixCandidates(client, { tenantRef: TENANT, controlId: CONTROL });
  assert.deepEqual(candidates.map((c) => [c.naturalKey, c.name, c.field, c.from, c.to]), [
    [KEY, 'KEEL-RT-Anywhere', 'includeUnknownCountriesAndRegions', true, false],
  ]);

  await recordEvaluation(client, {
    tenantRef: TENANT, actor: 'test',
    result: {
      controlId: CONTROL, framework: 'keel-custom', edition: '1.0.0', profile: 'default', evaluatorVersion: 1,
      verdict: 'fail', reason: null, evidenceRefs: [], observationWindows: [], evaluatedAt: new Date().toISOString(),
    },
  });
  const { findings } = await complianceFindings(client, { tenantRef: TENANT });
  const finding = findings.find((entry) => entry.controlId === CONTROL);
  assert.deepEqual(finding.fix, { resourceType: 'namedLocation', field: 'includeUnknownCountriesAndRegions', to: false });
  assert.deepEqual(finding.fixCandidates.map((c) => c.naturalKey), [KEY]);
});

test('make it pass: a dry run sends nothing, needs another person\'s approval, then writes the one setting', async (t) => {
  const client = await schemaClient(t);
  await seedSnapshot(client, [risky]);
  const graph = fakeGraph();
  // Live differs from the backup in another field: the fix must keep the live value.
  graph.objects.set(`${LOCATIONS}/nl-1`, { ...risky, countriesAndRegions: ['FR', 'MA', 'ES'] });
  const run = (options) => runRestore({ readFile, dbUrl: database.url, dependencies: cliDependencies(graph), logger: quiet, ...options });

  const artifactId = crypto.randomUUID();
  const dry = await planFix(run, artifactId);
  assert.equal(graph.writes.length, 0, 'the dry run sends nothing');
  assert.deepEqual(dry.results.failed, []);
  const artifact = await getDryRunArtifactById(client, { id: artifactId });
  assert.equal(artifact.status, 'completed');
  assert.deepEqual(artifact.selection, [KEY]);
  assert.deepEqual([artifact.complianceFix.field, artifact.complianceFix.from, artifact.complianceFix.to], ['includeUnknownCountriesAndRegions', true, false]);

  // Never a direct enforce, from the API or the CLI.
  await assert.rejects(run({ complianceFix: { controlId: CONTROL, naturalKey: KEY }, mode: 'enforce', collectorConfig, targetConfig }), /only ever planned as a dry run/);
  await assert.rejects(main({
    argv: ['node', 'keel-restore.mjs', '--compliance-fix', CONTROL, '--object', KEY, '--collector-config', '/fixtures/collector.json', '--target-config', '/fixtures/restorer.json', '--enforce'],
    readFile, dbUrl: database.url, dependencies: {}, logger: quiet,
  }), /dry run only/);

  // Mutation check: no approval, or the requester's own, writes nothing.
  await assert.rejects(run({ artifactId, mode: 'enforce' }), /needs an approved request/);
  const person = await requester(client);
  const request = await requestApproval(client, { tenantRef: TENANT, action: 'restore', params: { artifactId }, requestedBy: person, executor: 'cli' });
  await assert.rejects(approveRequest(client, { tenantRef: TENANT, id: request.id, decidedBy: person }), SelfApprovalError);
  await assert.rejects(run({ artifactId, mode: 'enforce' }), /needs an approved request/);
  assert.equal(graph.writes.length, 0);

  await approveRequest(client, { tenantRef: TENANT, id: request.id, decidedBy: 'approver' });
  const result = await run({ artifactId, mode: 'enforce' });
  assert.deepEqual(result.results.failed, []);
  assert.deepEqual(graph.writes.map((w) => `${w.method} ${w.path}`), [`PATCH ${LOCATIONS}/nl-1`]);
  const after = graph.objects.get(`${LOCATIONS}/nl-1`);
  assert.equal(after.includeUnknownCountriesAndRegions, false, 'the control now passes for this object');
  assert.deepEqual(after.countriesAndRegions, ['FR', 'MA', 'ES'], 'mutation check: the live value of every other setting is kept');
  assert.equal(after.isTrusted, true);
  assert.equal(needsFix(CONTROL, live(after)), false);
  const journal = await listJournal(client, { restoreRef: artifactId });
  assert.equal(journal.length, 1, 'the write is journaled, so it can be undone');
});

test('make it pass is refused when the object already passes, changed since the dry run, or is gone', async (t) => {
  const client = await schemaClient(t);
  await seedSnapshot(client, [risky]);
  const graph = fakeGraph();
  const run = (options) => runRestore({ readFile, dbUrl: database.url, dependencies: cliDependencies(graph), logger: quiet, ...options });

  // Gone live: nothing to fix.
  await assert.rejects(planFix(run, crypto.randomUUID()), /compliance fix refused: .* not in the tenant now/);
  // Already passing live: nothing planned.
  graph.objects.set(`${LOCATIONS}/nl-1`, { ...risky, includeUnknownCountriesAndRegions: false });
  await assert.rejects(planFix(run, crypto.randomUUID()), /already passes/);
  // A key no backup holds.
  await assert.rejects(planFix(run, crypto.randomUUID(), 'namedLocation:KEEL-RT-Unknown'), /no complete backup holds/);

  // Changed live between the dry run and the promotion: refused before any write.
  graph.objects.set(`${LOCATIONS}/nl-1`, { ...risky });
  const artifactId = crypto.randomUUID();
  await planFix(run, artifactId);
  const request = await requestApproval(client, { tenantRef: TENANT, action: 'restore', params: { artifactId }, requestedBy: await requester(client), executor: 'cli' });
  await approveRequest(client, { tenantRef: TENANT, id: request.id, decidedBy: 'approver' });
  graph.objects.set(`${LOCATIONS}/nl-1`, { ...risky, countriesAndRegions: ['FR'] });
  await assert.rejects(run({ artifactId, mode: 'enforce' }), /restore promotion refused: the target has changed since the dry run/);
  // Fixed outside Keel since: refused too, nothing written.
  graph.objects.set(`${LOCATIONS}/nl-1`, { ...risky, includeUnknownCountriesAndRegions: false });
  await assert.rejects(run({ artifactId, mode: 'enforce' }), /restore promotion refused: compliance fix refused: .* already passes/);
  assert.equal(graph.writes.length, 0);
});

// ------------------------------------------------------------------- worker

test('the worker passes only the control, the object and the server\'s config paths', () => {
  const args = HANDLERS.restore.argsFor({
    complianceFix: { controlId: CONTROL, naturalKey: KEY },
    collectorConfig: '/etc/keel/tenant.json', targetConfig: '/etc/keel/restorer.json', artifactId: 'a-1',
  }, { requested_by: 'p-1' });
  assert.deepEqual(args, [
    '--compliance-fix', CONTROL, '--object', KEY,
    '--collector-config', '/etc/keel/tenant.json', '--target-config', '/etc/keel/restorer.json',
    '--persist-artifact', 'a-1', '--requested-by', 'p-1',
  ]);
  assert.throws(() => HANDLERS.restore.argsFor({
    complianceFix: { controlId: CONTROL, naturalKey: KEY, field: 'isTrusted' },
    collectorConfig: 'c', targetConfig: 't', artifactId: 'a-1',
  }, { requested_by: 'p-1' }), /may carry only controlId and naturalKey/);
  // An enforce job is the artifact path alone: the fix scope beside it is ignored.
  assert.deepEqual(HANDLERS.restore.argsFor({
    complianceFix: { controlId: CONTROL, naturalKey: KEY }, mode: 'enforce',
    collectorConfig: 'c', targetConfig: 't', artifactId: 'a-1',
  }, { requested_by: 'p-1' }), ['--artifact', 'a-1', '--enforce']);
});
