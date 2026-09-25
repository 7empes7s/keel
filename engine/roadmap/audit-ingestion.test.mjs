import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { migrateAuditIngestion, ingestAudit, readAuditEvidence, createFixtureAuditAdapter } from '../identity/auditIngest.mjs';
import { auditSizing } from '../identity/auditSizing.mjs';
import { runAuditIngestion } from '../../cli/keel-worker.mjs';

const from = '2026-09-01T00:00:00.000Z';
const until = '2026-09-25T00:00:00.000Z';
const event = (id, extra = {}) => ({ id, occurredAt: '2026-09-24T00:00:00.000Z', ...extra });
async function setup(t) {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  t.after(async () => { await client.end(); await db.cleanup(); });
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  await migrateAuditIngestion(client);
  await migrateAuditIngestion(client);
  const { rows: [principal] } = await client.query("INSERT INTO principal(email) VALUES ('audit-fixture@example.invalid') RETURNING *");
  await client.query("INSERT INTO role_grant(principal_id, role, granted_by) VALUES ($1, 'operator', 'fixture'), ($1, 'viewer', 'fixture')", [principal.id]);
  const options = { tenantRef: 'fixture', managedTenantRef: 'fixture', requestedBy: principal.id, source: 'audit', enabled: true,
    from, until, retentionDays: 30, maxRequests: 2, maxEvents: 10, maxDurationMs: 500, pageSize: 5 };
  return { client, db, options, principal };
}
const adapter = (pages) => createFixtureAuditAdapter({ tenantRef: 'fixture', pages });

test('restart and overlapping pages deduplicate stable source IDs; payloads and cursors are minimized', async (t) => {
  const { client, db, options } = await setup(t);
  const a = adapter([{ events: [event('a', { token: 'secret-canary', nested: { password: 'private-canary' } })], nextCursor: 1 },
    { events: [event('a'), event('b')], nextCursor: 2 }, { events: [], nextCursor: null }]);
  const first = await runAuditIngestion(client, { ...options, adapter: a, maxRequests: 1 });
  assert.equal(first.status, 'budget-exhausted');
  assert.equal(first.requests, 1);
  const secondClient = await db.connect();
  try {
    const second = await ingestAudit(secondClient, { ...options, adapter: a });
    assert.equal(second.status, 'complete');
    const evidence = await readAuditEvidence(secondClient, options);
    assert.equal(evidence.eventCount, 2);
    assert.equal(evidence.state.cursor, null);
    assert.equal(evidence.state.window_until.toISOString(), until);
    const raw = await secondClient.query('SELECT * FROM audit_ingest_event');
    assert.ok(!JSON.stringify(raw.rows).includes('canary'));
    assert.equal(raw.rows[0].source_event_id, 'a');
    assert.equal(evidence.runs[0].evidence.synthetic, true);
  } finally { await secondClient.end(); }
});

test('persistence failure cannot advance cursor or partially store a page', async (t) => {
  const { client, options } = await setup(t);
  await client.query(`CREATE FUNCTION reject_fixture_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$;
    CREATE TRIGGER reject_fixture BEFORE INSERT ON audit_ingest_event FOR EACH ROW EXECUTE FUNCTION reject_fixture_event()`);
  await assert.rejects(ingestAudit(client, { ...options, adapter: adapter([{ events: [event('a')], nextCursor: 1 }]) }), /persistence/);
  const state = await readAuditEvidence(client, options);
  assert.equal(state.state.cursor, null);
  assert.equal(state.eventCount, 0);
  await client.query('DROP TRIGGER reject_fixture ON audit_ingest_event');
  const seen = [];
  const a = adapter([{ events: [event('a')], nextCursor: null }]);
  const read = a.readPage;
  a.readPage = async (request) => { seen.push(request.cursor); return read(request); };
  await ingestAudit(client, { ...options, adapter: a });
  assert.deepEqual(seen, [null]);
});

test('lost retention window is visible and survives subsequent successful runs', async (t) => {
  const { client, options } = await setup(t);
  const a = adapter([{ events: [], nextCursor: null, availableFrom: '2026-09-20T00:00:00.000Z' }]);
  const result = await ingestAudit(client, { ...options, adapter: a });
  assert.deepEqual(result.retentionGap, { from, until: '2026-09-20T00:00:00.000Z' });
  await ingestAudit(client, { ...options, adapter: adapter([{ events: [], nextCursor: null }]) });
  const evidence = await readAuditEvidence(client, options);
  assert.ok(evidence.runs.some((r) => r.evidence.retentionGap));
  assert.deepEqual(evidence.state.retention_gap, result.retentionGap);
});

test('revoked source read scope is distinct from empty success; failures never persist raw error payloads', async (t) => {
  const { client, options } = await setup(t);
  const denied = adapter([]);
  denied.readPage = async () => { throw Object.assign(new Error('Bearer secret-canary'), { status: 403 }); };
  const result = await ingestAudit(client, { ...options, adapter: denied });
  assert.equal(result.status, 'read-scope-revoked');
  const empty = await ingestAudit(client, { ...options, adapter: adapter([{ events: [], nextCursor: null }]) });
  assert.equal(empty.status, 'complete-empty');
  assert.ok(!JSON.stringify(await readAuditEvidence(client, options)).includes('secret-canary'));
});

test('infinite page stream, stalled requests and oversized pages terminate within configured budgets', async (t) => {
  const { client, options } = await setup(t);
  const a = adapter([]);
  let calls = 0;
  a.readPage = async () => ({ events: [], nextCursor: ++calls });
  assert.equal((await ingestAudit(client, { ...options, adapter: a })).status, 'budget-exhausted');
  assert.equal(calls, 2);
  a.readPage = async () => new Promise(() => {});
  assert.equal((await ingestAudit(client, { ...options, adapter: a, maxDurationMs: 20 })).status, 'budget-exhausted');
  a.readPage = async () => ({ events: Array.from({ length: 6 }, (_, i) => event(`e${i}`)), nextCursor: null });
  assert.equal((await ingestAudit(client, { ...options, adapter: a })).status, 'invalid-page');
});

test('authorization is current at worker, page persistence and reader boundaries; tenant and credentials cannot cross', async (t) => {
  const { client, options, principal } = await setup(t);
  const a = adapter([{ events: [], nextCursor: null }]);
  await assert.rejects(runAuditIngestion(client, { ...options, tenantRef: 'other', adapter: a }), /tenant/);
  await assert.rejects(ingestAudit(client, { ...options, adapter: { ...a, credentialMode: 'restorer' } }), /read-only/);
  const read = a.readPage;
  a.readPage = async (request) => {
    await client.query('UPDATE principal SET disabled_at = now() WHERE id = $1', [principal.id]);
    return read(request);
  };
  await assert.rejects(runAuditIngestion(client, { ...options, adapter: a }), /authorized/);
  await assert.rejects(readAuditEvidence(client, options), /authorized/);
  await assert.rejects(runAuditIngestion(client, { ...options, adapter: a }), /authorized/);
  assert.equal((await client.query('SELECT count(*) FROM audit_ingest_event')).rows[0].count, '0');
});

test('archive references avoid duplicate ingestion, missing migration reads as not configured, and sizing is honest', async (t) => {
  const { client, options } = await setup(t);
  const result = await ingestAudit(client, { ...options, archiveRef: 'archive:org-log-1' });
  assert.equal(result.status, 'archive-reference');
  assert.equal((await readAuditEvidence(client, options)).eventCount, 0);
  assert.equal(result.archiveRef, 'archive:org-log-1');
  assert.throws(() => auditSizing({ observedEvents: 2, storedBytes: 3, requests: 1, durationMs: 1, synthetic: false, costInputs: { perRequest: -1 } }), /cost/);
  const sizing = auditSizing({ observedEvents: 10, storedBytes: 1000, requests: 2, durationMs: 10, synthetic: true, costInputs: { perRequest: 0.1, perGiBMonth: 2 } });
  assert.equal(sizing.synthetic, true);
  assert.equal(sizing.estimatedRequestCost, 0.2);
  await client.query('DROP TABLE audit_ingest_run, audit_ingest_event, audit_ingest_state');
  assert.equal((await readAuditEvidence(client, options)).status, 'not-configured');
});

test('CLI integration, independent sign-in cursor, disabled mode and retention pruning use production seams', async (t) => {
  const { runAuditCommand } = await import('../../cli/keel-worker.mjs');
  const { client, options } = await setup(t);
  assert.equal((await runAuditCommand(client, { ...options, enabled: false })).status, 'disabled');
  const fixturePages = [{ events: [event('recent'), { id: 'expired', occurredAt: from }], nextCursor: null }];
  const result = await runAuditCommand(client, { ...options, retentionDays: 7, fixturePages });
  assert.equal(result.insertedEvents, 2);
  assert.equal((await runAuditCommand(client, options, { report: true })).eventCount, 1);
  await runAuditCommand(client, { ...options, source: 'sign-in', fixturePages: [{ events: [event('recent')], nextCursor: 1 }], maxRequests: 1 });
  const signIns = await readAuditEvidence(client, { ...options, source: 'sign-in' });
  assert.equal(signIns.eventCount, 1);
  assert.equal(Number(signIns.state.cursor), 1);
  assert.equal((await readAuditEvidence(client, options)).state.cursor, null);
  await migrateAuditIngestion(client);
  assert.equal((await readAuditEvidence(client, options)).eventCount, 1);
});

test('event budget, untrusted IDs and cursors cannot persist token data or skip a page', async (t) => {
  const { client, options } = await setup(t);
  const a = adapter([{ events: [event('one')], nextCursor: 1 }, { events: [event('two')], nextCursor: 2 }]);
  const result = await ingestAudit(client, { ...options, maxEvents: 1, adapter: a });
  assert.equal(result.status, 'budget-exhausted');
  assert.equal(result.requests, 1);
  assert.equal(result.insertedEvents, 1);
  const bad = adapter([]);
  bad.readPage = async () => ({ events: [event('Bearer secret-canary')], nextCursor: null });
  assert.equal((await ingestAudit(client, { ...options, adapter: bad })).status, 'invalid-page');
  bad.readPage = async () => ({ events: [event('two')], nextCursor: 'https://example.invalid/?token=secret-canary' });
  assert.equal((await ingestAudit(client, { ...options, adapter: bad })).status, 'invalid-page');
  const evidence = await readAuditEvidence(client, options);
  assert.equal(Number(evidence.state.cursor), 1);
  assert.equal(evidence.eventCount, 1);
  assert.ok(!JSON.stringify(evidence).includes('secret-canary'));
});

test('restart resumes the saved subsequent window and refuses changing a partially ingested window', async (t) => {
  const { client, options } = await setup(t);
  await ingestAudit(client, { ...options, adapter: adapter([{ events: [], nextCursor: null }]) });
  const later = { ...options, until: '2026-09-26T00:00:00.000Z', maxRequests: 1 };
  const a = adapter([{ events: [], nextCursor: 1 }, { events: [], nextCursor: null }]);
  assert.equal((await ingestAudit(client, { ...later, adapter: a })).status, 'budget-exhausted');
  await assert.rejects(ingestAudit(client, { ...later, until: '2026-09-27T00:00:00.000Z', adapter: a }), /unfinished time window/);
  const seen = [];
  const read = a.readPage;
  a.readPage = async (request) => { seen.push(request); return read(request); };
  assert.equal((await ingestAudit(client, { ...later, adapter: a })).status, 'complete-empty');
  assert.equal(seen[0].from, until);
  assert.equal(seen[0].cursor, 1);
});
