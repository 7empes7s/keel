/**
 * Roadmap task-45 boundary tests: versioned observation and release evidence
 * contracts. Exercises the production observation contract, coverage report
 * integration, readiness recorder and qualification verifier against
 * adversarial fixtures — including the three required mutation checks:
 * ignoring tenant_ref on observation joins, converting an unknown probe to
 * pass, and dropping observation-window mismatches.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSnapshot } from '../collect/snapshot.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { buildCoverageReport, reportObservationWindows } from '../coverage/report.mjs';
import { readCoverageOutcome, readTypeObservation } from '../coverage/snapshots.mjs';
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import {
  COMPLETENESS_STATES,
  CrossTenantObservationError,
  EVIDENCE_LEVELS,
  OBSERVATION_CONTRACT_VERSION,
  assertSimultaneous,
  defineObservation,
  joinObservations,
  readObservation,
} from '../contracts/observation.mjs';
import { buildReadiness } from '../../tools/release/readiness.mjs';
import {
  QUALIFICATION_CONTRACT_VERSION,
  signEvidence,
  verifyEvidence,
} from '../../tools/release/qualification.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const QUALIFICATION_CLI = join(ROOT, 'tools/release/qualification.mjs');
const READINESS_CLI = join(ROOT, 'tools/release/readiness.mjs');

function runCli(cli, args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

// ---------------------------------------------------------------- contract
{
  assert.equal(OBSERVATION_CONTRACT_VERSION, 1);
  assert.deepEqual(EVIDENCE_LEVELS, ['fixture-tested', 'live-qualified', 'unknown']);
  assert.ok(COMPLETENESS_STATES.includes('partial'));

  const observation = defineObservation({
    tenantRef: 'sha256:t',
    observationId: 'snap:group',
    resourceType: 'group',
    window: { startedAt: '2026-09-15T08:00:00Z', endedAt: '2026-09-15T08:05:00Z' },
    sourceBuild: 'a'.repeat(40),
    completeness: 'complete',
    evidenceLevel: 'fixture-tested',
  });
  assert.equal(observation.contractVersion, 1);
  assert.ok(Object.isFrozen(observation));
  assert.ok(Object.isFrozen(observation.window));

  for (const bad of [
    { tenantRef: '' },
    { window: { startedAt: 'not-a-date', endedAt: '2026-09-15T08:05:00Z' } },
    { window: { startedAt: '2026-09-15T08:05:00Z', endedAt: '2026-09-15T08:00:00Z' } },
    { completeness: 'simultaneous' },
    { evidenceLevel: 'verified' },
  ]) {
    assert.throws(() => defineObservation({
      tenantRef: 'sha256:t', observationId: 'o', resourceType: 'group',
      window: { startedAt: '2026-09-15T08:00:00Z', endedAt: '2026-09-15T08:05:00Z' },
      completeness: 'complete', evidenceLevel: 'unknown', ...bad,
    }), undefined, JSON.stringify(bad));
  }
}

// ------------------------------------------------------- legacy/unit reads
{
  const ctx = {
    tenantRef: 'sha256:t',
    observationId: 'snap:group',
    resourceType: 'group',
    snapshotWindow: { startedAt: new Date('2026-09-15T08:00:00Z'), endedAt: new Date('2026-09-15T08:05:00Z') },
  };
  const legacyCount = readObservation(5, ctx);
  assert.equal(legacyCount.legacy, true);
  assert.equal(legacyCount.contractVersion, 0);
  assert.equal(legacyCount.completeness, 'complete');
  assert.equal(legacyCount.itemCount, 5);
  // A legacy row carries no proof: the level is always unknown, the window
  // falls back to the enclosing run bounds, and nothing is promoted.
  assert.equal(legacyCount.evidenceLevel, 'unknown');
  assert.deepEqual(legacyCount.window, {
    startedAt: '2026-09-15T08:00:00.000Z', endedAt: '2026-09-15T08:05:00.000Z',
  });
  assert.equal(readObservation(0, ctx).completeness, 'unknown', 'legacy zero cannot prove an empty read');
  assert.equal(readObservation({ outcome: 'complete', itemCount: 0 }, ctx).completeness, 'complete');
  assert.equal(readObservation({ outcome: 'failed', itemCount: null }, ctx).completeness, 'failed');
  assert.equal(readObservation(null, ctx).completeness, 'unknown');
  assert.equal(readObservation(null, { ...ctx, snapshotWindow: null }).window, null);

  // Versioned digest entries read with their own per-type window and level.
  const versioned = readObservation({
    contractVersion: 1,
    window: { startedAt: '2026-09-15T07:00:00Z', endedAt: '2026-09-15T07:01:00Z' },
    completeness: 'partial',
    evidenceLevel: 'fixture-tested',
    sourceBuild: 'b'.repeat(40),
  }, ctx);
  assert.equal(versioned.contractVersion, 1);
  assert.equal(versioned.completeness, 'partial');
  assert.equal(versioned.evidenceLevel, 'fixture-tested');
  assert.deepEqual(versioned.window, {
    startedAt: '2026-09-15T07:00:00.000Z', endedAt: '2026-09-15T07:01:00.000Z',
  });

  // A versioned entry naming a different tenant than its enclosing snapshot
  // is rejected, never joined.
  assert.throws(
    () => readObservation({
      contractVersion: 1, tenantRef: 'sha256:foreign',
      window: { startedAt: '2026-09-15T07:00:00Z', endedAt: '2026-09-15T07:01:00Z' },
      completeness: 'complete', evidenceLevel: 'unknown',
    }, ctx),
    CrossTenantObservationError,
  );
  assert.throws(() => readObservation(5, { ...ctx, tenantRef: '' }), TypeError);

  // readTypeObservation composes the same read from snapshot row columns.
  const fromRow = readTypeObservation({
    resourceType: 'group',
    coverageEntry: 7,
    snapshotId: '00000000-0000-0000-0000-000000000001',
    snapshotStartedAt: '2026-09-15T08:00:00Z',
    snapshotCompletedAt: '2026-09-15T08:05:00Z',
    tenantRef: 'sha256:t',
  });
  assert.equal(fromRow.observationId, '00000000-0000-0000-0000-000000000001:group');
  assert.equal(fromRow.evidenceLevel, 'unknown');

  // The legacy coverage outcome reader keeps its exact prior meaning, and a
  // versioned entry is covered by completeness, not by mere presence.
  assert.deepEqual(readCoverageOutcome(5), { covered: true, itemCount: 5 });
  assert.deepEqual(readCoverageOutcome(0), { covered: false, itemCount: 0 });
  assert.deepEqual(readCoverageOutcome({ outcome: 'complete', itemCount: 0 }), { covered: true, itemCount: 0 });
  assert.deepEqual(readCoverageOutcome({
    contractVersion: 1, completeness: 'complete', itemCount: 3,
  }), { covered: true, itemCount: 3 });
  assert.deepEqual(readCoverageOutcome({
    contractVersion: 1, completeness: 'partial', itemCount: 3,
  }), { covered: false, itemCount: 3 });
}

// --------------------------- simultaneity and tenant-checked join (mutations)
{
  const base = {
    tenantRef: 'sha256:t', resourceType: 'group',
    completeness: 'complete', evidenceLevel: 'unknown',
  };
  const a = defineObservation({
    ...base, observationId: 'a',
    window: { startedAt: '2026-09-15T08:00:00Z', endedAt: '2026-09-15T08:05:00Z' },
  });
  const b = defineObservation({
    ...base, observationId: 'b',
    window: { startedAt: '2026-09-15T08:00:00Z', endedAt: '2026-09-15T08:05:00Z' },
  });
  const c = defineObservation({
    ...base, observationId: 'c',
    window: { startedAt: '2026-09-15T09:00:00Z', endedAt: '2026-09-15T09:05:00Z' },
  });
  assert.deepEqual(assertSimultaneous([a, b]), { simultaneous: true, mismatches: [] });
  // Mutation pin: dropping the window mismatch must fail here. Different
  // windows are never labeled simultaneous.
  const mixed = assertSimultaneous([a, c]);
  assert.equal(mixed.simultaneous, false);
  assert.equal(mixed.mismatches.length, 1);
  assert.equal(mixed.mismatches[0].reason, 'window-mismatch');
  assert.equal(mixed.mismatches[0].a, 'a');
  assert.equal(mixed.mismatches[0].b, 'c');
  const unknownWindow = assertSimultaneous([a, { ...c, window: null }]);
  assert.equal(unknownWindow.simultaneous, false);
  assert.equal(unknownWindow.mismatches[0].reason, 'window-unknown');

  const joined = joinObservations([c, a]);
  assert.deepEqual(joined.map((o) => o.observationId), ['a', 'c'], 'sorted by window end');
  // Mutation pin: ignoring tenant_ref on the join must fail here.
  assert.throws(
    () => joinObservations([a, { ...c, tenantRef: 'sha256:other' }]),
    CrossTenantObservationError,
  );
  assert.throws(() => joinObservations([{ ...a, tenantRef: '' }]), TypeError);
}

// ------------------------------------------------------------- DB fixtures
const database = await createIsolatedTestDatabase(import.meta.url);
const tmp = mkdtempSync(join(tmpdir(), 'keel-foundation-'));
let client;
const reader = {
  async collect(version, path) {
    if (path.startsWith('/groups?')) return { items: [{ id: 'g1', mailNickname: 'group-1' }] };
    if (path.startsWith('/users?')) return { items: [{ id: 'u1', userPrincipalName: 'user@example.test' }] };
    if (path === '/roleManagement/directory/roleAssignments') return { items: [], error: { status: 403, error: 'denied' } };
    return { items: [], error: null };
  },
};
const setSnapshotTimes = async (id, startedAt, completedAt) => client.query(
  'UPDATE snapshot SET started_at = $2, completed_at = $3 WHERE id = $1',
  [id, startedAt, completedAt],
);

try {
  client = await database.connect();
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));

  // Legacy digest rows keep their exact old reading, with the snapshot run
  // bounds as the observation window and an unknown evidence level.
  const legacyTenant = 'sha256:foundation-legacy';
  const legacyStarted = '2026-09-10T10:00:00.000Z';
  const legacyCompleted = '2026-09-10T10:04:00.000Z';
  await client.query(
    `INSERT INTO snapshot (tenant_ref, started_at, completed_at, status, coverage_digest)
     VALUES ($1, $2, $3, 'complete', $4)`,
    [legacyTenant, legacyStarted, legacyCompleted, JSON.stringify({ group: 5, namedLocation: 0 })],
  );
  const legacyReport = await buildCoverageReport(client, {
    tenantRef: legacyTenant, catalog: CATALOG, descriptors: DESCRIPTORS,
    now: new Date('2026-09-10T10:10:00.000Z'),
  });
  const legacyByType = new Map(legacyReport.types.map((t) => [t.type, t]));
  assert.equal(legacyByType.get('group').status, 'covered');
  assert.equal(legacyByType.get('namedLocation').status, 'failed', 'legacy zero lacks an outcome');
  const legacyObservation = legacyByType.get('group').observation;
  assert.equal(legacyObservation.legacy, true);
  assert.equal(legacyObservation.evidenceLevel, 'unknown');
  assert.equal(legacyObservation.tenantRef, legacyTenant);
  assert.deepEqual(legacyObservation.window, { startedAt: legacyStarted, endedAt: legacyCompleted });
  assert.equal(legacyByType.get('user').observation, null, 'never-collected has no observation');
  assert.deepEqual(legacyReport.observationContract, {
    version: OBSERVATION_CONTRACT_VERSION, atomicTenantImage: false,
  });

  // Mixed-tier fixtures: tier1 and tier2 runs at different times merge per
  // type; the result is not an atomic tenant image and the differing windows
  // are surfaced, never labeled simultaneous.
  const tierTenant = 'sha256:foundation-tiers';
  const tier1 = await collectSnapshot(client, { reader, tenantRef: tierTenant, tenantId: 'fixture-tenant', tier: 'tier1' });
  await setSnapshotTimes(tier1.snapshotId, '2026-09-15T08:00:00Z', '2026-09-15T08:05:00Z');
  const tier2 = await collectSnapshot(client, { reader, tenantRef: tierTenant, tenantId: 'fixture-tenant', tier: 'tier2' });
  await setSnapshotTimes(tier2.snapshotId, '2026-09-15T09:00:00Z', '2026-09-15T09:05:00Z');

  const tierReport = await buildCoverageReport(client, {
    tenantRef: tierTenant, catalog: CATALOG, descriptors: DESCRIPTORS,
    now: new Date('2026-09-15T09:10:00.000Z'),
  });
  const tierByType = new Map(tierReport.types.map((t) => [t.type, t]));
  assert.equal(tierByType.get('group').status, 'covered');
  assert.equal(tierByType.get('group').itemCount, 1);
  assert.equal(tierByType.get('user').status, 'covered');
  assert.equal(tierByType.get('roleAssignment').status, 'failed');
  assert.equal(tierByType.get('contact').status, 'never-collected', 'unrequested tier is not collected');
  const groupObservation = tierByType.get('group').observation;
  const userObservation = tierByType.get('user').observation;
  assert.deepEqual(groupObservation.window, {
    startedAt: '2026-09-15T08:00:00.000Z', endedAt: '2026-09-15T08:05:00.000Z',
  });
  assert.deepEqual(userObservation.window, {
    startedAt: '2026-09-15T09:00:00.000Z', endedAt: '2026-09-15T09:05:00.000Z',
  });
  assert.equal(groupObservation.observationId, `${tier1.snapshotId}:group`);
  assert.equal(userObservation.observationId, `${tier2.snapshotId}:user`);
  assert.equal(tierReport.observationContract.atomicTenantImage, false);
  const windows = reportObservationWindows(tierReport);
  assert.ok(windows.size >= 2, 'mixed-tier report spans more than one observation window');
  assert.ok(windows.get('2026-09-15T08:00:00.000Z/2026-09-15T08:05:00.000Z').includes('group'));
  assert.ok(windows.get('2026-09-15T09:00:00.000Z/2026-09-15T09:05:00.000Z').includes('user'));
  const simultaneity = assertSimultaneous([groupObservation, userObservation]);
  assert.equal(simultaneity.simultaneous, false, 'different per-type windows are not simultaneous');
  assert.equal(simultaneity.mismatches[0].reason, 'window-mismatch');

  // A versioned digest entry reads with its own window and evidence level.
  const versionedTenant = 'sha256:foundation-versioned';
  await client.query(
    `INSERT INTO snapshot (tenant_ref, started_at, completed_at, status, coverage_digest)
     VALUES ($1, '2026-09-15T07:00:00Z', '2026-09-15T07:10:00Z', 'complete', $2)`,
    [versionedTenant, JSON.stringify({
      group: {
        contractVersion: 1,
        tenantRef: versionedTenant,
        window: { startedAt: '2026-09-15T07:00:00Z', endedAt: '2026-09-15T07:02:00Z' },
        sourceBuild: 'c'.repeat(40),
        completeness: 'complete',
        evidenceLevel: 'fixture-tested',
        itemCount: 3,
      },
    })],
  );
  const versionedReport = await buildCoverageReport(client, {
    tenantRef: versionedTenant, catalog: [], descriptors: DESCRIPTORS.filter((d) => d.type === 'group'),
    now: new Date('2026-09-15T09:10:00.000Z'),
  });
  const versionedEntry = versionedReport.types[0];
  assert.equal(versionedEntry.status, 'covered');
  assert.equal(versionedEntry.itemCount, 3);
  assert.equal(versionedEntry.observation.contractVersion, 1);
  assert.equal(versionedEntry.observation.evidenceLevel, 'fixture-tested');
  assert.equal(versionedEntry.observation.sourceBuild, 'c'.repeat(40));
  assert.deepEqual(versionedEntry.observation.window, {
    startedAt: '2026-09-15T07:00:00.000Z', endedAt: '2026-09-15T07:02:00.000Z',
  });

  // Negative fixture: a stored digest entry claiming another tenant is a
  // cross-tenant join and the whole report refuses it.
  const foreignTenant = 'sha256:foundation-foreign';
  await client.query(
    `INSERT INTO snapshot (tenant_ref, started_at, completed_at, status, coverage_digest)
     VALUES ($1, '2026-09-15T07:00:00Z', '2026-09-15T07:10:00Z', 'complete', $2)`,
    [foreignTenant, JSON.stringify({
      group: {
        contractVersion: 1,
        tenantRef: 'sha256:not-this-tenant',
        window: { startedAt: '2026-09-15T07:00:00Z', endedAt: '2026-09-15T07:02:00Z' },
        completeness: 'complete',
        evidenceLevel: 'live-qualified',
        itemCount: 9,
      },
    })],
  );
  await assert.rejects(
    buildCoverageReport(client, {
      tenantRef: foreignTenant, catalog: [], descriptors: DESCRIPTORS.filter((d) => d.type === 'group'),
      now: new Date('2026-09-15T09:10:00.000Z'),
    }),
    CrossTenantObservationError,
    'cross-tenant digest entries are rejected, never joined',
  );
} finally {
  await client?.end();
  await database.cleanup();
}

// --------------------------------------------------------------- readiness
{
  const revisions = { '/repo/source': 'a'.repeat(40), '/repo/deployed': 'b'.repeat(40) };
  const execFn = (args) => {
    const path = args[1];
    if (args[2] === 'rev-parse') return `${revisions[path]}\n`;
    if (args[2] === 'status') return '';
    throw new Error(`unexpected git invocation: ${args}`);
  };
  const options = {
    execFn,
    sourcePath: '/repo/source',
    deployedPath: '/repo/deployed',
    portalUrl: 'http://portal.test',
    now: new Date('2026-09-15T12:00:00.000Z'),
  };

  // Health 200 plus an unauthorized feature probe does not prove feature
  // parity: the probe is 'unauthorized' and the verdict stays 'not-ready'.
  const denied = await buildReadiness({
    ...options,
    sessionAssertion: 'session-sentinel-value',
    fetchFn: async (url) => ({ status: url.pathname === '/api/health' ? 200 : 403 }),
  });
  assert.equal(denied.portal.health.ok, true);
  assert.ok(denied.probes.every((p) => p.outcome === 'unauthorized'));
  assert.equal(denied.verdict, 'not-ready');
  assert.equal(denied.revisionMatch, false);

  // Mutation pin: removing the revisionMatch===false trigger must fail here.
  // A source/deployed revision mismatch alone — health 200, a session and
  // every feature probe passing — is still 'not-ready', never 'ready'.
  const revisionMismatch = await buildReadiness({
    ...options,
    sessionAssertion: 'session-sentinel-value',
    fetchFn: async () => ({ status: 200 }),
  });
  assert.equal(revisionMismatch.portal.health.ok, true);
  assert.ok(revisionMismatch.probes.every((p) => p.outcome === 'pass'));
  assert.equal(revisionMismatch.revisionMatch, false);
  assert.equal(revisionMismatch.verdict, 'not-ready');

  // Mutation pin: an unknown probe can never become a pass. A missing
  // session yields unknown outcomes and an unknown verdict — never 'ready'.
  const noSession = await buildReadiness({
    ...options,
    deployedPath: '/repo/source', // revisions match; only the session is missing
    sessionAssertion: null,
    fetchFn: async () => ({ status: 200 }),
  });
  assert.equal(noSession.revisionMatch, true);
  assert.ok(noSession.probes.every((p) => p.outcome === 'unknown' && p.reason === 'no-session'));
  assert.equal(noSession.verdict, 'unknown');
  assert.notEqual(noSession.verdict, 'ready');

  const unreachable = await buildReadiness({
    ...options,
    sessionAssertion: 'session-sentinel-value',
    fetchFn: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(unreachable.portal.health.ok, false);
  assert.ok(unreachable.probes.every((p) => p.outcome === 'unknown' && p.reason === 'unreachable'));
  assert.equal(unreachable.verdict, 'not-ready');

  const ready = await buildReadiness({
    ...options,
    deployedPath: '/repo/source',
    sessionAssertion: 'session-sentinel-value',
    fetchFn: async () => ({ status: 200 }),
  });
  assert.equal(ready.verdict, 'ready');
  assert.ok(ready.probes.every((p) => p.outcome === 'pass'));

  // A healthy portal, a session and matching revisions still do not prove
  // readiness when a feature probe is unreachable: an unknown probe outcome
  // holds the verdict at 'unknown', never 'ready'.
  const probeUnknown = await buildReadiness({
    ...options,
    deployedPath: '/repo/source',
    sessionAssertion: 'session-sentinel-value',
    fetchFn: async (url) => {
      if (url.pathname === '/api/health') return { status: 200 };
      if (url.pathname === '/api/coverage') throw new Error('ECONNREFUSED');
      return { status: 200 };
    },
  });
  assert.equal(probeUnknown.portal.health.ok, true);
  assert.equal(probeUnknown.probes.find((p) => p.feature === 'coverage').outcome, 'unknown');
  assert.equal(probeUnknown.verdict, 'unknown');
  assert.notEqual(probeUnknown.verdict, 'ready');

  // A failing (5xx) probe is evidence against parity: 'not-ready'.
  const probeFailed = await buildReadiness({
    ...options,
    deployedPath: '/repo/source',
    sessionAssertion: 'session-sentinel-value',
    fetchFn: async (url) => ({ status: url.pathname === '/api/drift' ? 500 : 200 }),
  });
  assert.equal(probeFailed.probes.find((p) => p.feature === 'drift').outcome, 'fail');
  assert.equal(probeFailed.verdict, 'not-ready');

  // An unknown deployed revision is never 'ready' even when every probe passes.
  const unknownRevision = await buildReadiness({
    ...options,
    execFn: (args) => {
      if (args[1] === '/repo/deployed') throw new Error('not a git repo');
      return execFn(args);
    },
    sessionAssertion: 'session-sentinel-value',
    fetchFn: async () => ({ status: 200 }),
  });
  assert.equal(unknownRevision.deployed, null);
  assert.equal(unknownRevision.revisionMatch, null);
  assert.equal(unknownRevision.verdict, 'unknown');

  // Session material never appears in the recorded readiness document.
  assert.ok(!JSON.stringify(ready).includes('session-sentinel-value'));
  assert.ok(!JSON.stringify(denied).includes('session-sentinel-value'));

  // The CLI itself records unknowns honestly and never prints the session.
  const readinessOut = join(tmp, 'readiness.json');
  const cliRun = runCli(READINESS_CLI, [
    '--portal-url', 'http://127.0.0.1:59999',
    '--source', '/opt/keel',
    '--deployed', join(tmp, 'no-such-deployed-path'),
    '--out', readinessOut,
  ], { KEEL_PORTAL_SESSION: 'session-sentinel-value' });
  assert.equal(cliRun.status, 0, cliRun.stderr);
  assert.ok(!cliRun.stdout.includes('session-sentinel-value'), 'session headers are never printed');
  const recorded = JSON.parse(readFileSync(readinessOut, 'utf8'));
  assert.equal(recorded.deployed, null, 'absent deployed checkout records unknown, not a guess');
  assert.ok(recorded.source.revision);
  assert.equal(recorded.portal.health.ok, false);
  assert.ok(recorded.probes.every((p) => p.outcome === 'unknown'));
  assert.equal(recorded.verdict, 'not-ready');
  assert.ok(!JSON.stringify(recorded).includes('session-sentinel-value'));
}

// ----------------------------------------------------------- qualification
{
  const key = 'test-hmac-key-not-a-secret';
  const now = new Date('2026-09-15T12:00:00.000Z');
  const baseEvidence = {
    contractVersion: QUALIFICATION_CONTRACT_VERSION,
    gate: 'release-readiness',
    tenantRef: 'sha256:tenant-a',
    build: 'a'.repeat(40),
    operation: 'portal.readiness',
    credentialMode: 'portal-session',
    observedAt: '2026-09-15T11:00:00.000Z',
    evidenceLevel: 'fixture-tested',
    synthetic: true,
    subject: {
      verdict: 'ready',
      sourceRevision: 'a'.repeat(40),
      deployedRevision: 'a'.repeat(40),
      probes: [{ feature: 'coverage', outcome: 'pass' }],
    },
  };
  const verify = (evidence, options = {}) => verifyEvidence(evidence, { hmacKey: key, now, ...options });

  // Trusted runner signature proves the fixture gate.
  const signed = signEvidence(baseEvidence, key, 'keel-fixture-runner');
  assert.deepEqual(verify(signed), { ok: true, failures: [] });

  // Missing proof, wrong key and untrusted identity all fail closed.
  for (const [label, evidence, options] of [
    ['no proof at all', baseEvidence, {}],
    ['wrong signing key', signEvidence(baseEvidence, 'other-key', 'keel-fixture-runner'), {}],
    ['untrusted runner', signEvidence(baseEvidence, key, 'rogue-runner'), {}],
    ['no verification key', signed, { hmacKey: null }],
  ]) {
    const result = verify(evidence, options);
    assert.equal(result.ok, false, label);
    assert.ok(result.failures.some((f) => f.startsWith('missing proof')), label);
  }

  // An independently verifiable artifact digest is an alternative proof.
  const artifactPath = join(tmp, 'artifact.bin');
  writeFileSync(artifactPath, 'artifact-bytes');
  const artifactDigest = createHash('sha256').update('artifact-bytes').digest('hex');
  const artifactEvidence = {
    ...baseEvidence,
    proof: { artifact: { path: artifactPath, sha256: artifactDigest } },
  };
  assert.deepEqual(verify(artifactEvidence), { ok: true, failures: [] });
  writeFileSync(artifactPath, 'tampered-bytes');
  assert.equal(verify(artifactEvidence).ok, false, 'digest mismatch fails');
  writeFileSync(artifactPath, 'artifact-bytes');

  // Tenant binding: evidence for another tenant is a cross-tenant join.
  const crossTenant = verify(signed, { tenantRef: 'sha256:tenant-b' });
  assert.equal(crossTenant.ok, false);
  assert.ok(crossTenant.failures.some((f) => f.includes('cross-tenant')));

  // Gate binding, freshness and schema failures.
  assert.equal(verify(signed, { gate: 'other-gate' }).ok, false);
  assert.equal(verify({ ...baseEvidence, gate: 'unregistered-gate', proof: signed.proof }).ok, false,
    'unregistered gates fail closed');
  assert.ok(verify({
    ...signEvidence({ ...baseEvidence, observedAt: '2026-08-01T00:00:00.000Z' }, key, 'keel-fixture-runner'),
  }).failures.some((f) => f.includes('stale')), 'stale observations fail');
  assert.ok(verify({
    ...signEvidence({ ...baseEvidence, observedAt: '2026-09-16T00:00:00.000Z' }, key, 'keel-fixture-runner'),
  }).failures.some((f) => f.includes('future')), 'future observations fail');
  assert.equal(verify({ ...baseEvidence, contractVersion: 2, proof: signed.proof }).ok, false);
  assert.equal(verify(null).ok, false);
  const badSubject = verify(signEvidence({
    ...baseEvidence, subject: { ...baseEvidence.subject, verdict: 'not-ready' },
  }, key, 'keel-fixture-runner'));
  assert.equal(badSubject.ok, false, 'a not-ready subject cannot qualify the readiness gate');
  const mismatchedRevisions = verify(signEvidence({
    ...baseEvidence,
    subject: { ...baseEvidence.subject, deployedRevision: 'd'.repeat(40) },
  }, key, 'keel-fixture-runner'));
  assert.equal(mismatchedRevisions.ok, false, 'differing source/deployed revisions cannot qualify');
  const failedProbeSubject = verify(signEvidence({
    ...baseEvidence,
    subject: { ...baseEvidence.subject, probes: [{ feature: 'coverage', outcome: 'unauthorized' }] },
  }, key, 'keel-fixture-runner'));
  assert.equal(failedProbeSubject.ok, false, 'a non-pass probe cannot qualify the readiness gate');

  // Fabricated live qualification is rejected: --require-live refuses
  // synthetic fixtures, fixture-tested levels and synthetic runner identities.
  for (const [label, evidence] of [
    ['synthetic fixture', signed],
    ['fixture-tested level', signEvidence({ ...baseEvidence, synthetic: false }, key, 'keel-release-runner')],
    ['synthetic runner', signEvidence({ ...baseEvidence, evidenceLevel: 'live-qualified', synthetic: false }, key, 'keel-fixture-runner')],
  ]) {
    const result = verify(evidence, { requireLive: true });
    assert.equal(result.ok, false, label);
  }
  const liveEvidence = signEvidence({
    ...baseEvidence, evidenceLevel: 'live-qualified', synthetic: false,
  }, key, 'keel-release-runner');
  assert.deepEqual(verify(liveEvidence, { requireLive: true }), { ok: true, failures: [] });

  // CLI end-to-end: valid fixture evidence passes verification; the same
  // record under --require-live, a fabricated live claim, a proof-less record
  // and a cross-tenant invocation all exit nonzero. The CLI checks freshness
  // against the real clock, so these fixtures are stamped fresh.
  const cliBase = { ...baseEvidence, observedAt: new Date().toISOString() };
  const cliSigned = signEvidence(cliBase, key, 'keel-fixture-runner');
  const evidencePath = join(tmp, 'evidence.json');
  writeFileSync(evidencePath, JSON.stringify(cliSigned, null, 2));
  const pass = runCli(QUALIFICATION_CLI, ['verify', '--gate', 'release-readiness', '--evidence', evidencePath], {
    KEEL_QUALIFICATION_HMAC_KEY: key,
  });
  assert.equal(pass.status, 0, pass.stderr);
  assert.deepEqual(JSON.parse(pass.stdout), { ok: true, failures: [] });

  const requireLive = runCli(QUALIFICATION_CLI, ['verify', '--gate', 'release-readiness', '--evidence', evidencePath, '--require-live'], {
    KEEL_QUALIFICATION_HMAC_KEY: key,
  });
  assert.equal(requireLive.status, 1, '--require-live rejects synthetic fixtures');
  assert.ok(requireLive.stdout.includes('synthetic'));

  const fabricatedPath = join(tmp, 'fabricated-live.json');
  writeFileSync(fabricatedPath, JSON.stringify(signEvidence({
    ...cliBase, evidenceLevel: 'live-qualified', synthetic: true,
  }, key, 'keel-release-runner'), null, 2));
  const fabricated = runCli(QUALIFICATION_CLI, ['verify', '--gate', 'release-readiness', '--evidence', fabricatedPath, '--require-live'], {
    KEEL_QUALIFICATION_HMAC_KEY: key,
  });
  assert.equal(fabricated.status, 1, 'a relabeled fixture cannot pass as live-qualified');
  assert.ok(fabricated.stdout.includes('synthetic'));

  const prooflessPath = join(tmp, 'proofless.json');
  writeFileSync(prooflessPath, JSON.stringify(cliBase, null, 2));
  const proofless = runCli(QUALIFICATION_CLI, ['verify', '--gate', 'release-readiness', '--evidence', prooflessPath], {
    KEEL_QUALIFICATION_HMAC_KEY: key,
  });
  assert.equal(proofless.status, 1, 'missing proof exits nonzero');
  assert.ok(proofless.stdout.includes('missing proof'));

  const foreign = runCli(QUALIFICATION_CLI, ['verify', '--gate', 'release-readiness', '--evidence', evidencePath, '--tenant', 'sha256:tenant-b'], {
    KEEL_QUALIFICATION_HMAC_KEY: key,
  });
  assert.equal(foreign.status, 1, 'cross-tenant evidence exits nonzero');
  assert.ok(foreign.stdout.includes('cross-tenant'));

  const unknownGate = runCli(QUALIFICATION_CLI, ['verify', '--gate', 'not-a-gate', '--evidence', evidencePath], {
    KEEL_QUALIFICATION_HMAC_KEY: key,
  });
  assert.equal(unknownGate.status, 1, 'unregistered gates exit nonzero');
  assert.ok(!pass.stdout.includes(key), 'key material is never printed');
}

rmSync(tmp, { recursive: true, force: true });
console.log('foundation.test.mjs — all assertions passed');
