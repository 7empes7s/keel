/**
 * Roadmap task-73 boundary tests: measured freshness, recoverable point and
 * recovery time. Exercises the production engine/coverage/recoveryMetrics.mjs
 * reader and writer and cli/keel-recovery-metrics.mjs against the isolated test
 * database, with real snapshots, relationship reads, evidence, restore jobs and
 * (for one copy) a real recovery manifest verified against its artifact bytes.
 *
 * Required mutation checks:
 * - Use configured schedule as achieved RPO.
 * - Count failed restore as successful timing.
 * - Hide unmeasured state (the portal view half lives in
 *   portal/test/resilience-view.test.ts).
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { after, before, test } from 'node:test';

import { main as recoveryMetricsCli } from '../../cli/keel-recovery-metrics.mjs';
import { recordOffsiteCopy } from '../coverage/offsiteCopy.mjs';
import {
  OFFSITE_COPY_EVIDENCE_KIND, classifyRestoreJob, computeFreshness, loadRecoveryMetrics, typeDependency,
} from '../coverage/recoveryMetrics.mjs';
import { RECOVERY_DRILL_EVIDENCE_KIND } from '../coverage/recoveryReadiness.mjs';
import { exportSnapshot } from '../export/configExport.mjs';
import { sha256Hex } from '../export/manifest.mjs';
import { appendEvidence } from '../govern/evidence.mjs';
import { buildRecoveryManifest, currentSchemaPin } from '../storage/recoveryManifest.mjs';
import { insertResourceVersion } from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const NOW = new Date('2026-10-03T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const TYPES = ['group', 'user'];
const silent = () => {};

let database;
let client;
let tmp;

before(async () => {
  database = await createIsolatedTestDatabase(import.meta.url);
  client = await database.connect();
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  tmp = mkdtempSync(join(tmpdir(), 'keel-recovery-metrics-'));
});

after(async () => {
  await client?.end();
  await database?.cleanup();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function snapshot(tenantRef, { startedAt, completedAt, digest, status = 'complete' }) {
  const { rows: [row] } = await client.query(
    `INSERT INTO snapshot (tenant_ref, started_at, completed_at, status, coverage_digest)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [tenantRef, startedAt, completedAt, status, digest],
  );
  return row.id;
}

async function edgeSet(tenantRef, snapshotId, { parentType = 'group', family = 'members', parent = 'g1', outcome, at }) {
  await client.query(
    `INSERT INTO relationship_edge_set
       (snapshot_id, tenant_ref, parent_type, parent_source_id, family, edge_type, direction, outcome, started_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, 'member', 'out', $6, $7, $7)`,
    [snapshotId, tenantRef, parentType, parent, family, outcome, at],
  );
}

const ok = (count = 1) => ({ outcome: 'complete', itemCount: count });

function metrics(tenantRef, requiredTypes = TYPES) {
  return loadRecoveryMetrics(client, { tenantRef, requiredTypes, now: NOW });
}

const passesVerification = async () => ({ ok: true, recoveryComplete: true, failures: [], incomplete: [] });

async function copy(tenantRef, { observationIds, shippedAt, remoteSha256 = 'a'.repeat(64), dumpSha256 = 'a'.repeat(64), verify = passesVerification, manifestTenantRef = tenantRef }) {
  return recordOffsiteCopy(client, {
    tenantRef,
    manifest: { tenantRef: manifestTenantRef, generatedAt: shippedAt, dump: { sha256: dumpSha256 }, observationIds },
    remoteSha256,
    shippedAt,
    actor: 'keel-offsite',
    verify,
    eventSink: silent,
  });
}

test('a failed or partial latest collection never improves the achieved RPO', async () => {
  const tenantRef = 'sha256:rm-latest-failed';
  await snapshot(tenantRef, { startedAt: '2026-10-03T06:00:00Z', completedAt: '2026-10-03T06:10:00Z', digest: { user: ok(3), group: ok(2) } });
  // A newer run: user failed outright, group only partly read. Neither is a success.
  await snapshot(tenantRef, {
    startedAt: '2026-10-03T11:00:00Z', completedAt: '2026-10-03T11:05:00Z',
    digest: { user: { outcome: 'failed', error: 'throttled' }, group: { outcome: 'partial', itemCount: 1 } },
  });
  // A run that deliberately did not read user is not an observation either.
  await snapshot(tenantRef, { startedAt: '2026-10-03T11:30:00Z', completedAt: '2026-10-03T11:31:00Z', digest: { user: { outcome: 'not-requested' } } });
  // A run that never completed proves nothing.
  await snapshot(tenantRef, { startedAt: '2026-10-03T11:40:00Z', completedAt: null, status: 'running', digest: { user: ok(), group: ok() } });

  const { freshness } = await metrics(tenantRef);
  assert.equal(freshness.state, 'measured');
  assert.equal(freshness.achievedRpoMs, 6 * HOUR, 'the last SUCCESS (06:00) decides the age, not the failed 11:00 run');
  assert.equal(freshness.oldestDependency.since, '2026-10-03T06:00:00.000Z');
  assert.deepEqual(freshness.latestFailures.map((failure) => [failure.type, failure.outcome]).sort(), [['group', 'partial'], ['user', 'failed']]);
  assert.deepEqual(freshness.gaps, []);

  // The pure computation agrees: a newer failure next to an older success.
  const pure = computeFreshness({
    required: [typeDependency('user')],
    observations: [
      { dependency: 'type:user', success: true, startedAt: '2026-10-03T10:00:00.000Z', completedAt: '2026-10-03T10:01:00.000Z' },
      { dependency: 'type:user', success: false, outcome: 'failed', startedAt: '2026-10-03T11:59:00.000Z', completedAt: '2026-10-03T11:59:30.000Z' },
    ],
    now: NOW,
  });
  assert.equal(pure.achievedRpoMs, 2 * HOUR);
});

test('the oldest required relationship read decides the age, and a never-read type is a gap', async () => {
  const tenantRef = 'sha256:rm-relationships';
  const s1 = await snapshot(tenantRef, { startedAt: '2026-10-03T02:00:00Z', completedAt: '2026-10-03T02:30:00Z', digest: { user: ok(), group: ok() } });
  await edgeSet(tenantRef, s1, { outcome: 'complete', at: '2026-10-03T02:10:00Z' });
  await edgeSet(tenantRef, s1, { parentType: 'group', family: 'owners', outcome: 'unsupported', at: '2026-10-03T02:10:00Z' });
  const s2 = await snapshot(tenantRef, { startedAt: '2026-10-03T11:00:00Z', completedAt: '2026-10-03T11:20:00Z', digest: { user: ok(), group: ok() } });
  // The newer membership read stopped part way: it does not refresh the family.
  await edgeSet(tenantRef, s2, { outcome: 'complete', at: '2026-10-03T11:05:00Z' });
  await edgeSet(tenantRef, s2, { parent: 'g2', outcome: 'partial', at: '2026-10-03T11:06:00Z' });

  let { freshness } = await metrics(tenantRef);
  assert.equal(freshness.required, 3, 'two types and one read family; an unsupported-only family is not required');
  assert.equal(freshness.state, 'measured');
  assert.equal(freshness.oldestDependency.kind, 'relationship');
  assert.equal(freshness.oldestDependency.since, '2026-10-03T02:10:00.000Z');
  assert.equal(freshness.achievedRpoMs, 9 * HOUR + 50 * 60 * 1000);

  // A required type KEEL has never read successfully: the RPO cannot be stated.
  ({ freshness } = await metrics(tenantRef, [...TYPES, 'conditionalAccessPolicy']));
  assert.equal(freshness.state, 'gaps');
  assert.equal(freshness.achievedRpoMs, null);
  assert.deepEqual(freshness.gaps.map((gap) => gap.type), ['conditionalAccessPolicy']);
});

test('configured cadence is reported as configuration and never used as the achieved RPO', async () => {
  const tenantRef = 'sha256:rm-schedule';
  await client.query(
    `INSERT INTO schedule (tenant_ref, job_kind, tier, cadence, next_due_at)
     VALUES ($1, 'collect', 'tier1', '{"every":"hour","n":1,"atTime":null}', $2),
            ($1, 'offsite', NULL, '{"every":"day","n":1,"atTime":"05:00"}', $2)`,
    [tenantRef, NOW],
  );
  let result = await metrics(tenantRef);
  assert.equal(result.configured.cadence.length, 2);
  assert.equal(result.configured.objectives, null, 'KEEL stores no recovery objective');
  // Collection is scheduled hourly, but nothing was ever collected.
  assert.equal(result.freshness.state, 'unmeasured');
  assert.equal(result.freshness.achievedRpoMs, null);
  assert.equal(result.recoverablePoint.state, 'unmeasured');
  assert.equal(result.recoverablePoint.ageMs, null);

  // A nine-hour-old success under an hourly schedule is nine hours old.
  await snapshot(tenantRef, { startedAt: '2026-10-03T03:00:00Z', completedAt: '2026-10-03T03:05:00Z', digest: { user: ok(), group: ok() } });
  result = await metrics(tenantRef);
  assert.equal(result.freshness.achievedRpoMs, 9 * HOUR);
});

test('a newer off-site copy lacking a required observation does not advance the recoverable point', async () => {
  const tenantRef = 'sha256:rm-offsite';
  const s1 = await snapshot(tenantRef, { startedAt: '2026-10-02T06:00:00Z', completedAt: '2026-10-02T06:10:00Z', digest: { user: ok(), group: ok() } });
  const s2 = await snapshot(tenantRef, { startedAt: '2026-10-03T06:00:00Z', completedAt: '2026-10-03T06:10:00Z', digest: { user: ok(), group: { outcome: 'failed' } } });
  await edgeSet(tenantRef, s1, { outcome: 'complete', at: '2026-10-02T06:05:00Z' });

  await copy(tenantRef, { observationIds: [`${s1}:user`, `${s1}:group`], shippedAt: '2026-10-02T07:00:00Z' });
  let { recoverablePoint } = await metrics(tenantRef);
  assert.equal(recoverablePoint.state, 'measured');
  assert.equal(recoverablePoint.point, '2026-10-02T06:00:00.000Z');
  assert.equal(recoverablePoint.ageMs, 30 * HOUR);

  // Newer dump: its group read failed and it holds no membership read, so it recovers
  // nothing complete. The point stays at the older copy.
  await copy(tenantRef, { observationIds: [`${s2}:user`, `${s2}:group`], shippedAt: '2026-10-03T07:00:00Z' });
  // Newer dump whose remote checksum did not match, and one whose manifest failed verification.
  const both = [`${s1}:user`, `${s1}:group`];
  await copy(tenantRef, { observationIds: both, shippedAt: '2026-10-03T08:00:00Z', remoteSha256: 'b'.repeat(64) });
  await copy(tenantRef, { observationIds: both, shippedAt: '2026-10-03T09:00:00Z', verify: async () => ({ ok: false, failures: ['dump checksum mismatch'] }) });
  // A copy recorded for another tenant never joins this one.
  await copy('sha256:rm-offsite-other', { observationIds: both, shippedAt: '2026-10-03T10:00:00Z' });

  ({ recoverablePoint } = await metrics(tenantRef));
  assert.equal(recoverablePoint.point, '2026-10-02T06:00:00.000Z', 'nothing newer advanced the point');
  assert.equal(recoverablePoint.fromCopy.shippedAt, '2026-10-02T07:00:00.000Z');
  const reasons = recoverablePoint.copies.map((entry) => entry.reason);
  assert.deepEqual(reasons, ['verified-offsite-copy', 'missing-required-observation', 'remote-checksum-mismatch', 'manifest-not-verified']);
  assert.deepEqual(recoverablePoint.copies[1].missing.sort(), ['relationship:group/members', 'type:group']);
  assert.equal(recoverablePoint.latestCopy.reason, 'manifest-not-verified', 'the newest copy is shown even though it does not count');
});

test('an off-site copy is verified against its actual artifact bytes before it counts', async () => {
  const tenantRef = 'sha256:rm-real-manifest';
  const snapshotId = await snapshot(tenantRef, { startedAt: '2026-10-03T04:00:00Z', completedAt: '2026-10-03T04:05:00Z', digest: { user: ok(1) } });
  await insertResourceVersion(client, {
    snapshotId,
    resource: {
      naturalKey: 'user:ana@example.test', resourceType: 'user',
      payload: { id: 'u1', userPrincipalName: 'ana@example.test', displayName: 'Fixture User' },
      payloadHash: 'fixture-hash', criticality: 'tier1', blastRadius: 'access-affecting', fidelity: 'read-only',
      provenance: { adapter: 'fixture', collectedAt: '2026-10-03T04:01:00.000Z', fidelity: 'read-only' },
    },
  });
  const { exportDir } = await exportSnapshot(client, { tenantRef, snapshotId, exportRoot: join(tmp, 'export') });
  const exportManifestBytes = await readFile(join(exportDir, 'manifest.json'));
  const dumpBytes = gzipSync('COPY public.fixture (id) FROM stdin;\n');
  const dumpPath = join(tmp, 'dump.sql.gz');
  writeFileSync(dumpPath, dumpBytes);
  const schemaPin = await currentSchemaPin();
  const build = { revision: 'c'.repeat(40), schemaPin };
  const manifest = buildRecoveryManifest({
    tenantRef,
    build,
    dump: { path: dumpPath, sha256: sha256Hex(dumpBytes), bytes: dumpBytes.length },
    observationIds: [`${snapshotId}:user`],
    configExport: { manifestPath: join(exportDir, 'manifest.json'), manifestSha256: sha256Hex(exportManifestBytes) },
    evidenceCheckpoint: { headSeq: 1, headHash: 'd'.repeat(64), recordCount: 1 },
    residency: { provider: 'local-disk' },
  });
  const manifestPath = join(tmp, 'recovery.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const cli = (extra) => recoveryMetricsCli({
    argv: ['record-offsite', '--tenant-ref', tenantRef, '--db-url', 'postgres://fixture.invalid/unused',
      '--recovery-manifest', manifestPath, '--actor', 'keel-offsite', '--shipped-at', '2026-10-03T05:00:00Z',
      '--build-revision', build.revision, '--schema-pin', build.schemaPin, '--config-export-dir', exportDir, ...extra],
    connectFn: () => database.connect(),
    logger: { log: silent, error: silent },
  });

  assert.equal(await cli(['--remote-sha256', sha256Hex(dumpBytes)]), 0);
  let { recoverablePoint } = await metrics(tenantRef, ['user']);
  assert.equal(recoverablePoint.point, '2026-10-03T04:00:00.000Z');

  // The dump on disk no longer matches the manifest: recorded, visible, never counted.
  writeFileSync(dumpPath, gzipSync('tampered'));
  assert.equal(await cli(['--remote-sha256', sha256Hex(dumpBytes)]), 1);
  // A manifest pinned to this tenant cannot be recorded under another.
  writeFileSync(dumpPath, dumpBytes);
  const foreign = await recordOffsiteCopy(client, {
    tenantRef: 'sha256:rm-real-manifest-other', manifest, remoteSha256: sha256Hex(dumpBytes), shippedAt: '2026-10-03T06:00:00Z',
    actor: 'keel-offsite', verifyOptions: { expectedBuild: build, configExportDir: exportDir }, eventSink: silent,
  });
  assert.equal(foreign.verdict.counts, false);

  ({ recoverablePoint } = await metrics(tenantRef, ['user']));
  assert.equal(recoverablePoint.copies.length, 2);
  assert.equal(recoverablePoint.copies[1].reason, 'manifest-not-verified');
  assert.equal(recoverablePoint.point, '2026-10-03T04:00:00.000Z');
  const { rows } = await client.query('SELECT count(*)::int AS n FROM evidence WHERE kind = $1 AND tenant_ref = $2', [OFFSITE_COPY_EVIDENCE_KIND, tenantRef]);
  assert.equal(rows[0].n, 2);
});

function drill({ tenantRef, outcome = 'passed', startedAt, elapsedMs, cleanup = 'complete', mode = 'live' }) {
  const finishedAt = new Date(new Date(startedAt).getTime() + elapsedMs).toISOString();
  return appendEvidence(client, {
    tenantRef,
    kind: RECOVERY_DRILL_EVIDENCE_KIND,
    subject: {
      tenantRef, mode, scope: 'bounded-same-tenant', outcome, startedAt, finishedAt, elapsedMs,
      elapsedSource: 'observed-clock', bounds: { maxElapsedMs: 30 * 60 * 1000, maxWrites: 40 },
      cleanup: { status: cleanup, residuals: [] }, objects: ['group:keel-rehearsal-fixture'],
    },
    actor: 'operator',
    eventSink: silent,
  });
}

async function restoreJob(tenantRef, { status, startedAt, finishedAt, params }) {
  const snapshotId = await snapshot(tenantRef, { startedAt: '2026-10-01T00:00:00Z', completedAt: '2026-10-01T00:01:00Z', digest: { user: ok() } });
  const { rows: [plan] } = await client.query(
    `INSERT INTO restore_dry_run (tenant_ref, snapshot_id, selection, closure_keys, target_tenant_id, collector_config_path,
       target_config_path, waves, patches, results, current_state_fingerprint, digest, status, requested_by)
     VALUES ($1, $2, '[]', '[]', 'fixture', '/c', '/t', '[]', '[]', '[]', 'f', 'd', 'completed', 'operator') RETURNING id`,
    [tenantRef, snapshotId],
  );
  const { rows: [job] } = await client.query(
    `INSERT INTO job (kind, params, status, requested_by, started_at, finished_at)
     VALUES ('restore', $1, $2, 'operator', $3, $4) RETURNING id`,
    [params ?? { artifactId: plan.id, mode: 'enforce' }, status, startedAt, finishedAt],
  );
  return { planId: plan.id, jobId: job.id };
}

test('a failed drill or failed restore never improves the observed recovery time', async () => {
  const tenantRef = 'sha256:rm-recovery-time';
  await drill({ tenantRef, startedAt: '2026-10-01T10:00:00.000Z', elapsedMs: 8 * 60 * 1000 });
  // Faster, but failed, offline, or left residual objects: none is a sample.
  await drill({ tenantRef, outcome: 'failed', startedAt: '2026-10-02T10:00:00.000Z', elapsedMs: 30 * 1000 });
  await drill({ tenantRef, mode: 'offline', startedAt: '2026-10-02T11:00:00.000Z', elapsedMs: 1000 });
  await drill({ tenantRef, cleanup: 'failed', startedAt: '2026-10-02T12:00:00.000Z', elapsedMs: 2000 });
  // A restore that failed fast, one cancelled, and one that succeeded but is not yet verified.
  await restoreJob(tenantRef, { status: 'failed', startedAt: '2026-10-03T08:00:00Z', finishedAt: '2026-10-03T08:00:05Z' });
  await restoreJob(tenantRef, { status: 'cancelled', startedAt: '2026-10-03T08:10:00Z', finishedAt: '2026-10-03T08:10:01Z' });
  const pending = await restoreJob(tenantRef, { status: 'succeeded', startedAt: '2026-10-03T09:00:00Z', finishedAt: '2026-10-03T09:02:00Z' });
  await client.query(
    `INSERT INTO recovery_completion_item (tenant_ref, restore_ref, natural_key, resource_type, mechanism, kind, requirement, description)
     VALUES ($1, $2, 'application:Payroll', 'application', 'recreate', 'service-validation', 'validate', 'check the service')`,
    [tenantRef, pending.planId],
  );
  // A dry run (not an enforced restore) is never a recovery.
  await restoreJob(tenantRef, { status: 'succeeded', startedAt: '2026-10-03T09:30:00Z', finishedAt: '2026-10-03T09:30:01Z', params: { compensates: 'x', artifactId: 'y' } });
  // A restore of another tenant's plan never joins this tenant.
  await restoreJob('sha256:rm-recovery-time-other', { status: 'succeeded', startedAt: '2026-10-03T10:00:00Z', finishedAt: '2026-10-03T10:00:01Z' });

  let { recoveryTime } = await metrics(tenantRef);
  assert.equal(recoveryTime.state, 'measured');
  assert.equal(recoveryTime.samples, 1);
  assert.equal(recoveryTime.latestMs, 8 * 60 * 1000);
  assert.equal(recoveryTime.worstMs, 8 * 60 * 1000);
  assert.equal(recoveryTime.medianMs, 8 * 60 * 1000);
  assert.deepEqual(recoveryTime.attempts.map((attempt) => attempt.reason), [
    'live-bounded-drill', 'outcome-failed', 'offline-validation', 'cleanup-failed',
    'restore-failed', 'restore-cancelled', 'awaiting-verification',
  ]);
  assert.equal(recoveryTime.lastAttempt.counts, false);

  // Once its last completion item is verified, the restore counts, timed to that verification.
  await client.query(`UPDATE recovery_completion_item SET state = 'verified', closed_at = '2026-10-03T09:20:00Z' WHERE restore_ref = $1`, [pending.planId]);
  ({ recoveryTime } = await metrics(tenantRef));
  assert.equal(recoveryTime.samples, 2);
  assert.equal(recoveryTime.latestMs, 20 * 60 * 1000);
  assert.equal(recoveryTime.worstMs, 20 * 60 * 1000);
  assert.equal(recoveryTime.medianMs, 14 * 60 * 1000);

  // The classifier alone: a failed job with perfect timings is still not a sample.
  assert.equal(classifyRestoreJob({ status: 'failed', started_at: '2026-10-03T00:00:00Z', finished_at: '2026-10-03T00:00:01Z' }).counts, false);
});

test('no samples reads unmeasured everywhere, and the CLI reports it', async () => {
  const tenantRef = 'sha256:rm-empty';
  const lines = [];
  const code = await recoveryMetricsCli({
    argv: ['report', '--tenant-ref', tenantRef, '--db-url', 'postgres://fixture.invalid/unused'],
    connectFn: () => database.connect(),
    logger: { log: (line) => lines.push(line), error: silent },
    now: () => NOW,
  });
  assert.equal(code, 0);
  const report = JSON.parse(lines.join('\n'));
  assert.equal(report.tenantRef, tenantRef);
  assert.equal(report.freshness.state, 'unmeasured');
  assert.equal(report.freshness.achievedRpoMs, null);
  assert.equal(report.recoverablePoint.state, 'unmeasured');
  assert.equal(report.recoveryTime.state, 'unmeasured');
  assert.equal(report.recoveryTime.samples, 0);
  assert.equal(report.recoveryTime.latestMs, null);
  assert.equal(report.readiness.state, 'unmeasured');
  assert.ok(report.freshness.gaps.length > 0, 'every collected type is listed as a gap');
});

test('reads are pinned to one tenant: foreign rows never count and a raw tenant id is refused', async () => {
  const tenantRef = 'sha256:rm-scope';
  const other = 'sha256:rm-scope-other';
  const foreignSnapshot = await snapshot(other, { startedAt: '2026-10-03T11:00:00Z', completedAt: '2026-10-03T11:01:00Z', digest: { user: ok(), group: ok() } });
  await edgeSet(other, foreignSnapshot, { outcome: 'complete', at: '2026-10-03T11:00:30Z' });
  await drill({ tenantRef: other, startedAt: '2026-10-03T10:00:00.000Z', elapsedMs: 60 * 1000 });
  // This tenant's copy lists the other tenant's observations: they are not readable here.
  await copy(tenantRef, { observationIds: [`${foreignSnapshot}:user`, `${foreignSnapshot}:group`], shippedAt: '2026-10-03T11:30:00Z' });

  const result = await metrics(tenantRef);
  assert.equal(result.freshness.state, 'unmeasured');
  assert.equal(result.freshness.required, 2, 'another tenant\'s relationship reads are not required here');
  assert.equal(result.recoverablePoint.state, 'unmeasured');
  assert.equal(result.recoverablePoint.copies[0].reason, 'missing-required-observation');
  assert.equal(result.recoveryTime.samples, 0);
  assert.equal(result.readiness.countedDrills, 0);

  await assert.rejects(() => loadRecoveryMetrics(client, { tenantRef: '00000000-0000-0000-0000-0000000000c1', requiredTypes: TYPES }), /derived tenant reference/);
  await assert.rejects(() => recordOffsiteCopy(client, { tenantRef: 'raw-tenant', manifest: {}, shippedAt: NOW, actor: 'x' }), /derived tenant reference/);
});
