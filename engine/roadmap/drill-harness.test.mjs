/**
 * Roadmap task-72 boundary tests: offline and bounded same-tenant recovery
 * drills. Exercises the production tools/rehearsal/qualification.mjs harness,
 * which drives the real tools/rehearsal/roundTrip.mjs round trip against fake
 * Graph clients and the isolated test database, and the production
 * engine/coverage/recoveryReadiness.mjs reader over the evidence it writes.
 *
 * Required mutation checks:
 * - Allow non-disposable target.
 * - Count offline pass as live recovery.
 * - Suppress failed cleanup.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import {
  DRILL_LIMITS, boundedWriter, buildDrillManifest, runBoundedDrill, runCli, validateDrillManifest,
  validateDrillPlan, verifyCleanup,
} from '../../tools/rehearsal/qualification.mjs';
import { tenantRefFor } from '../../tools/rehearsal/roundTrip.mjs';
import {
  RECOVERY_DRILL_EVIDENCE_KIND, classifyDrillRecord, loadRecoveryReadiness, summarizeRecoveryReadiness,
} from '../coverage/recoveryReadiness.mjs';
import { appendEvidence } from '../govern/evidence.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const PRODUCTION_URL = 'postgres://keel@db.internal:5432/keel';
const collector = JSON.parse(readFileSync(new URL('../../tools/rehearsal/fixtures/roundTrip-collector.json', import.meta.url), 'utf8'));
const restorer = JSON.parse(readFileSync(new URL('../../tools/rehearsal/fixtures/roundTrip-restorer.json', import.meta.url), 'utf8'));
const foreignCollector = { ...collector, tenantId: 'tenant-foreign-fixture' };
const START = new Date('2026-10-03T01:02:03.004Z');

let dir;
let collectorPath;
let restorerPath;
let database;
let client;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'keel-drill-'));
  collectorPath = join(dir, 'collector.json');
  restorerPath = join(dir, 'restorer.json');
  writeFileSync(collectorPath, JSON.stringify(collector));
  writeFileSync(restorerPath, JSON.stringify(restorer));
  database = await createIsolatedTestDatabase(import.meta.url);
  client = await database.connect();
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
});

after(async () => {
  await client?.end();
  await database?.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function manifest(overrides = {}) {
  return { ...buildDrillManifest({ collectorConfig: collector, now: START }), ...overrides };
}

/** A fake tenant holding only what the drill creates. Every write advances the fake clock. */
function fakeTenant({ purgeStatus = 204, tick = 1000 } = {}) {
  const state = { group: null, softDeleted: false, hardDeleted: false, writes: [], reads: 0, time: 0 };
  const getGroup = () => (state.group && !state.softDeleted
    ? { ok: true, status: 200, body: state.group }
    : { ok: false, status: 404, body: null });
  const reader = {
    collect: async (version, path) => {
      state.reads += 1;
      return { items: path.startsWith('/groups') && state.group && !state.softDeleted ? [state.group] : [] };
    },
    get: async (version, path) => {
      state.reads += 1;
      if (path.startsWith('/groups/')) return getGroup();
      if (path.startsWith('/directory/deletedItems/')) {
        return state.softDeleted && !state.hardDeleted
          ? { ok: true, status: 200, body: state.group }
          : { ok: false, status: 404, body: null };
      }
      throw new Error(`unexpected fake Graph read: ${path}`);
    },
  };
  const writer = {
    write: async (version, path, { method, body }) => {
      state.writes.push(`${method} ${path}`);
      state.time += tick;
      if (method === 'POST' && path === '/groups') {
        state.group = { ...body, id: 'drill-group-1' };
        return { ok: true, status: 201, body: state.group };
      }
      if (method === 'PATCH' && path === '/groups/drill-group-1') {
        state.group = { ...state.group, ...body };
        return { ok: true, status: 204, body: null };
      }
      if (method === 'DELETE' && path === '/groups/drill-group-1') {
        if (state.softDeleted) return { ok: false, status: 404, body: null };
        state.softDeleted = true;
        return { ok: true, status: 204, body: null };
      }
      if (method === 'DELETE' && path === '/directory/deletedItems/drill-group-1') {
        if (purgeStatus >= 300) return { ok: false, status: purgeStatus, body: { error: 'Authorization_RequestDenied' } };
        state.hardDeleted = true;
        return { ok: true, status: 204, body: null };
      }
      throw new Error(`unexpected fake Graph write: ${method} ${path}`);
    },
    read: async (version, path) => {
      if (path === '/groups/drill-group-1') return getGroup();
      throw new Error(`unexpected fake Graph writer read: ${path}`);
    },
  };
  return { state, reader, writer, clock: () => state.time };
}

function spyClient() {
  const calls = [];
  return { calls, query: async (...args) => { calls.push(args); return { rows: [] }; }, end: async () => {} };
}

async function evidenceCount() {
  const { rows } = await client.query('SELECT count(*)::int AS n FROM evidence WHERE kind = $1', [RECOVERY_DRILL_EVIDENCE_KIND]);
  return rows[0].n;
}

function live(tenant, overrides = {}) {
  return runBoundedDrill({
    mode: 'live',
    confirm: true,
    manifest: manifest(),
    collectorConfigPath: collectorPath,
    restorerConfigPath: restorerPath,
    dbUrl: process.env.KEEL_DB_TEST_URL,
    productionUrl: PRODUCTION_URL,
    writer: tenant.writer,
    reader: tenant.reader,
    client,
    clock: tenant.clock,
    log: () => {},
    ...overrides,
  });
}

test('offline mode is the default, makes zero writes and never counts as a recovery drill', async () => {
  const tenant = fakeTenant();
  const spy = spyClient();
  const evidenceBefore = await evidenceCount();
  const result = await runBoundedDrill({
    manifest: manifest(),
    collectorConfigPath: collectorPath,
    restorerConfigPath: restorerPath,
    dbUrl: process.env.KEEL_DB_TEST_URL,
    productionUrl: PRODUCTION_URL,
    writer: tenant.writer,
    reader: tenant.reader,
    client: spy,
    log: () => {},
  });
  assert.equal(result.mode, 'offline');
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.equal(result.countsAsRecoveryDrill, false);
  assert.equal(result.writes, 0);
  assert.deepEqual(tenant.state.writes, []);
  assert.equal(tenant.state.reads, 0, 'offline validation must not even read the tenant');
  assert.equal(spy.calls.length, 0, 'offline validation must not touch a database');
  assert.equal(await evidenceCount(), evidenceBefore, 'offline validation writes no evidence');

  // The CLI default is the same offline validation.
  const path = join(dir, 'manifest.json');
  writeFileSync(path, JSON.stringify(manifest()));
  const lines = [];
  const code = await runCli({
    argv: ['--manifest', path, '--config', collectorPath, '--restorer-config', restorerPath, '--db-url', process.env.KEEL_DB_TEST_URL],
    log: (line) => lines.push(line),
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(lines[0]).countsAsRecoveryDrill, false);
});

test('a live drill needs explicit opt-in; the CLI refuses before any credential is used', async () => {
  const tenant = fakeTenant();
  await assert.rejects(live(tenant, { confirm: false }), /--confirm-bounded-drill/);
  await assert.rejects(live(tenant, { confirm: 'yes' }), /--confirm-bounded-drill/);
  assert.deepEqual(tenant.state.writes, []);

  const path = join(dir, 'manifest-cli.json');
  writeFileSync(path, JSON.stringify(manifest()));
  let madeClients = 0;
  await assert.rejects(runCli({
    argv: ['--live', '--manifest', path, '--config', collectorPath, '--restorer-config', restorerPath],
    log: () => {},
    dependencies: { makeClients: async () => { madeClients += 1; return { writer: tenant.writer, reader: tenant.reader }; } },
  }), /--confirm-bounded-drill/);
  assert.equal(madeClients, 0);
});

test('a non-disposable target is refused by validation and at the write boundary', async () => {
  const target = manifest({ objects: [{ resourceType: 'group', naturalKey: 'group:production-admins' }] });
  const codes = validateDrillManifest(target, {
    collectorConfig: collector, restorerConfig: restorer, dbUrl: process.env.KEEL_DB_TEST_URL, productionUrl: PRODUCTION_URL,
  }).map((item) => item.code);
  assert.ok(codes.includes('non-disposable-target'), codes.join(','));
  assert.equal(validateDrillPlan({
    manifest: target, collectorConfigPath: collectorPath, restorerConfigPath: restorerPath,
    dbUrl: process.env.KEEL_DB_TEST_URL, productionUrl: PRODUCTION_URL,
  }).ok, false);

  const tenant = fakeTenant();
  await assert.rejects(live(tenant, { manifest: target }), /non-disposable-target/);
  assert.deepEqual(tenant.state.writes, []);

  // Tenant-wide or cloned-tenant rehearsal is not a bounded drill.
  const policy = manifest({ objects: [{ resourceType: 'conditionalAccessPolicy', naturalKey: 'conditionalAccessPolicy:all-users' }] });
  const policyCodes = validateDrillManifest(policy, { collectorConfig: collector, restorerConfig: restorer, dbUrl: process.env.KEEL_DB_TEST_URL, productionUrl: PRODUCTION_URL })
    .map((item) => item.code);
  assert.ok(policyCodes.includes('unsupported-resource-type') && policyCodes.includes('non-disposable-target'));
  const clone = manifest({ cloneTenant: true });
  assert.ok(validateDrillManifest(clone, { collectorConfig: collector, restorerConfig: restorer, dbUrl: process.env.KEEL_DB_TEST_URL, productionUrl: PRODUCTION_URL })
    .some((item) => item.code === 'unknown-field'));
  assert.ok(validateDrillManifest(manifest({ objects: [] }), { collectorConfig: collector, restorerConfig: restorer, dbUrl: process.env.KEEL_DB_TEST_URL, productionUrl: PRODUCTION_URL })
    .some((item) => item.code === 'no-objects'));
  assert.ok(validateDrillManifest(manifest({ bounds: { maxElapsedMs: DRILL_LIMITS.maxElapsedMs + 1, maxWrites: 10 } }), { collectorConfig: collector, restorerConfig: restorer, dbUrl: process.env.KEEL_DB_TEST_URL, productionUrl: PRODUCTION_URL })
    .some((item) => item.code === 'bounds-exceeded'));

  // The write boundary itself: an object outside the allowlist, or one this drill did not create.
  const inner = fakeTenant();
  const guarded = boundedWriter(inner.writer, { manifest: manifest(), clock: inner.clock, startedAt: 0 });
  await assert.rejects(
    guarded.write('v1.0', '/groups', { method: 'POST', body: { mailNickname: 'production-admins' } }),
    /non-disposable/,
  );
  await assert.rejects(
    guarded.write('v1.0', '/groups', { method: 'POST', body: { mailNickname: 'keel-rehearsal-other' } }),
    /not in the drill allowlist/,
  );
  await assert.rejects(
    guarded.write('v1.0', '/groups/someone-elses-group', { method: 'PATCH', body: { description: 'x' } }),
    /not an object this drill created/,
  );
  assert.deepEqual(inner.state.writes, []);
});

test('the production database is refused', async () => {
  const tenant = fakeTenant();
  const findings = validateDrillManifest(manifest(), {
    collectorConfig: collector, restorerConfig: restorer, dbUrl: PRODUCTION_URL, productionUrl: PRODUCTION_URL,
  });
  assert.ok(findings.some((item) => item.code === 'production-db'));
  assert.ok(validateDrillManifest(manifest(), { collectorConfig: collector, restorerConfig: restorer, dbUrl: undefined, productionUrl: PRODUCTION_URL })
    .some((item) => item.code === 'test-db-missing'));
  await assert.rejects(live(tenant, { dbUrl: PRODUCTION_URL }), /production-db/);
  assert.deepEqual(tenant.state.writes, []);
});

test('a foreign tenant cannot be selected', async () => {
  const foreign = buildDrillManifest({ collectorConfig: foreignCollector, now: START });
  const findings = validateDrillManifest(foreign, {
    collectorConfig: collector, restorerConfig: restorer, dbUrl: process.env.KEEL_DB_TEST_URL, productionUrl: PRODUCTION_URL,
  });
  assert.ok(findings.some((item) => item.code === 'foreign-tenant'));
  const tenant = fakeTenant();
  await assert.rejects(live(tenant, { manifest: foreign }), /foreign-tenant/);
  assert.deepEqual(tenant.state.writes, []);

  // A Restorer registered in another tenant is refused as well.
  assert.ok(validateDrillManifest(manifest(), {
    collectorConfig: collector, restorerConfig: { ...restorer, tenantId: 'tenant-foreign-fixture' },
    dbUrl: process.env.KEEL_DB_TEST_URL, productionUrl: PRODUCTION_URL,
  }).some((item) => item.code === 'foreign-tenant'));

  // Readiness never reads another tenant's drills.
  const record = {
    tenant_ref: tenantRefFor(foreignCollector),
    occurred_at: START.toISOString(),
    subject: { mode: 'live', scope: 'bounded-same-tenant', tenantRef: tenantRefFor(foreignCollector), outcome: 'passed', cleanup: { status: 'complete' } },
  };
  assert.equal(summarizeRecoveryReadiness([record], { tenantRef: tenantRefFor(collector) }).state, 'unmeasured');
  assert.equal(classifyDrillRecord({ ...record.subject }, { tenantRef: tenantRefFor(collector) }).reason, 'foreign-tenant');
});

test('a live bounded drill runs the real round trip, observes elapsed time and verifies cleanup', async () => {
  const tenant = fakeTenant({ tick: 1000 });
  const record = await live(tenant);
  assert.equal(record.outcome, 'passed', record.error ?? '');
  assert.equal(record.countsAsRecoveryDrill, true);
  assert.equal(record.cleanup.status, 'complete');
  assert.deepEqual(record.cleanup.verifiedAbsent, [{ objectId: 'drill-group-1', naturalKey: manifest().objects[0].naturalKey }]);
  assert.equal(tenant.state.hardDeleted, true);
  // Elapsed time is the observed clock difference, not the manifest bound or a constant.
  assert.equal(record.elapsedMs, tenant.state.time);
  assert.equal(record.elapsedMs, tenant.state.writes.length * 1000);
  assert.notEqual(record.elapsedMs, manifest().bounds.maxElapsedMs);
  assert.equal(new Date(record.finishedAt) - new Date(record.startedAt), record.elapsedMs);
  assert.equal(record.writes, tenant.state.writes.length);

  const readiness = await loadRecoveryReadiness(client, { tenantRef: tenantRefFor(collector) });
  assert.equal(readiness.state, 'drilled');
  assert.equal(readiness.countedDrills, 1);
  assert.equal(readiness.lastCountedDrill.elapsedMs, record.elapsedMs);
  assert.deepEqual(readiness.cleanupFailures, []);
});

test('the time bound is enforced from the observed clock', async () => {
  const tenant = fakeTenant({ tick: 1000 });
  const record = await live(tenant, { manifest: manifest({ bounds: { maxElapsedMs: 3000, maxWrites: 30 } }) });
  assert.equal(record.outcome, 'failed');
  assert.match(record.error, /time bound/);
  assert.equal(record.countsAsRecoveryDrill, false);
  // Cleanup still ran past the time bound and removed the created object.
  assert.equal(record.cleanup.status, 'complete');
  assert.equal(tenant.state.hardDeleted, true);
});

test('a failed cleanup is visible in the drill record and readiness', async () => {
  const tenant = fakeTenant({ purgeStatus: 403 });
  const record = await live(tenant);
  assert.equal(record.countsAsRecoveryDrill, false);
  assert.equal(record.cleanup.status, 'failed');
  assert.deepEqual(record.cleanup.residuals.map((item) => [item.surface, item.state]), [['deleted-items', 'present']]);

  const readiness = await loadRecoveryReadiness(client, { tenantRef: tenantRefFor(collector) });
  assert.equal(readiness.state, 'attention');
  assert.equal(readiness.cleanupFailures.length, 1);
  assert.equal(readiness.cleanupFailures[0].residuals[0].objectId, 'drill-group-1');
  assert.ok(readiness.notCounted.some((item) => item.reason === 'cleanup-failed'));

  // verifyCleanup reports a read it could not complete as unknown, not absent.
  const unknown = await verifyCleanup({ get: async () => { throw new Error('read refused'); } }, new Map([['g', 'group:keel-rehearsal-x']]));
  assert.equal(unknown.status, 'failed');
  assert.equal(unknown.residuals[0].state, 'unknown');
});

test('an offline pass recorded as evidence never counts as a live recovery', async () => {
  const tenantRef = tenantRefFor(collector);
  const offline = validateDrillPlan({
    manifest: manifest(), collectorConfigPath: collectorPath, restorerConfigPath: restorerPath,
    dbUrl: process.env.KEEL_DB_TEST_URL, productionUrl: PRODUCTION_URL,
  });
  assert.equal(offline.ok, true);
  assert.equal(offline.countsAsRecoveryDrill, false);

  const fresh = await createIsolatedTestDatabase(import.meta.url);
  const other = await fresh.connect();
  try {
    await other.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
    // A forged "passing" record that is offline but otherwise looks perfect.
    await appendEvidence(other, {
      tenantRef,
      kind: RECOVERY_DRILL_EVIDENCE_KIND,
      actor: 'keel-drill',
      subject: {
        ...offline, tenantRef, scope: 'bounded-same-tenant', outcome: 'passed', cleanup: { status: 'complete', residuals: [] },
        startedAt: START.toISOString(), finishedAt: new Date(START.getTime() + 5000).toISOString(), elapsedMs: 5000,
        elapsedSource: 'observed-clock', bounds: { maxElapsedMs: 60_000, maxWrites: 30 },
      },
    });
    const readiness = await loadRecoveryReadiness(other, { tenantRef });
    assert.equal(readiness.countedDrills, 0);
    assert.equal(readiness.state, 'unmeasured');
    assert.deepEqual(readiness.notCounted.map((item) => item.reason), ['offline-validation']);
  } finally {
    await other.end();
    await fresh.cleanup();
  }

  // Elapsed time must be the recorded observation; a claimed duration does not count.
  const subject = {
    mode: 'live', scope: 'bounded-same-tenant', tenantRef, outcome: 'passed', cleanup: { status: 'complete' },
    startedAt: START.toISOString(), finishedAt: new Date(START.getTime() + 5000).toISOString(), elapsedMs: 1,
    elapsedSource: 'observed-clock', bounds: { maxElapsedMs: 60_000 },
  };
  assert.equal(classifyDrillRecord(subject, { tenantRef }).reason, 'elapsed-not-observed');
  assert.equal(classifyDrillRecord({ ...subject, elapsedMs: 5000 }, { tenantRef }).counts, true);
  assert.equal(classifyDrillRecord({ ...subject, elapsedMs: 5000, elapsedSource: 'manifest' }, { tenantRef }).counts, false);
});
