// Roadmap task-117: Sentinel workspace ingestion qualification.
//
// Acceptance:
//  - a valid independently captured record verifies;
//  - altered signature/digest, wrong tenant/build/operation, stale evidence and a
//    missing prerequisite fail;
//  - duplicate deliveries are deduplicated LOGICALLY by stable event id (never a
//    claim of unique physical rows or exactly-once ingestion), actual delay and
//    errors are preserved, and a missing event fails.
// Mutation checks:
//  - accept missing external evidence;
//  - accept mismatched tenant or operation;
//  - elevate fixture evidence to live-qualified.
//
// The capture tool drives the PRODUCTION task-80 adapter and the production query
// transport against an in-memory fake workspace (ingestion endpoint plus query API).
// Records are signed with a test-only key in a temporary directory. No workspace is
// read or written, and no record produced here is persisted as release evidence.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { signEvidence, verifyEvidence, verifyEvidenceFile } from '../../tools/release/qualification.mjs';
import {
  SENTINEL_LIVE_GATE, SENTINEL_SENDER_ROLES, sentinelRequiredDocumentation,
} from '../../tools/qualification/sentinelAcceptance.mjs';
import {
  captureSentinelAcceptance, logAnalyticsQueryTransport, main as sentinelMain, sentinelCapturePlan,
  sentinelQualificationFromAcceptance, writeSentinelAcceptanceFiles,
} from '../../tools/qualification/sentinelLive.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const KEY = 'test-only';
const tenantRef = tenantRefFor('sentinel-live-fixture');
const OTHER_TENANT_REF = tenantRefFor('another-tenant');
const build = 'fixture-build';
const WORKSPACE = '5e5e5e5e-0000-4000-8000-000000000117';
const ENDPOINT = 'https://keel-rt-dce.eastus-1.ingest.monitor.azure.com';
const DCR = 'dcr-0123456789abcdef0123456789abcdef';
const DESTINATION = 'dest-keel-rt-sentinel';
const SENDER_TOKEN = 'fixture-sender-token-DO-NOT-LEAK';
const READER_TOKEN = 'fixture-reader-token-DO-NOT-LEAK';
const observed = Date.parse('2026-10-04T08:00:00Z');
const verifyNow = new Date('2026-10-04T09:00:00Z');

const dir = mkdtempSync(join(tmpdir(), 'keel-sentinel-live-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/**
 * The fake workspace. Ingestion appends one physical row per accepted record (a
 * redelivery is a second physical row, as in Log Analytics). The query API runs the
 * two capture queries by their scope and, for the logical one, the dedup view.
 */
function fakeWorkspace({ throttleFirst = false, loseAckOnce = null, dropSeq = null, poisonSeq = null, replayFails = false, lagMs = 4000, clock } = {}) {
  const rows = [];
  const ingests = [];
  const queries = [];
  let ingestCount = 0;
  let lostAck = false;
  const response = (status, { headers = {}, body = null } = {}) => ({
    status, ok: status >= 200 && status < 300, headers: new Headers(headers), text: async () => (body ? JSON.stringify(body) : ''),
  });
  const fetchImpl = async (url, init) => {
    const target = new URL(url);
    if (target.hostname.endsWith('.ingest.monitor.azure.com')) {
      ingestCount += 1;
      assert.equal(init.headers.Authorization, `Bearer ${SENDER_TOKEN}`, 'ingestion uses the sender token');
      assert.equal(target.pathname, `/dataCollectionRules/${DCR}/streams/Custom-KeelEvents`);
      const [record] = JSON.parse(init.body);
      const replay = ingests.some((item) => item.KeelEventId === record.KeelEventId && item.accepted);
      ingests.push({ KeelEventId: record.KeelEventId, clientRequestId: init.headers['x-ms-client-request-id'], accepted: false });
      if (throttleFirst && ingestCount === 1) return response(429, { headers: { 'retry-after': '0', 'x-ms-request-id': 'svc-429' } });
      if (poisonSeq === record.SourceSequence) return response(400, { headers: { 'x-ms-request-id': 'svc-400' } });
      if (replayFails && replay) return response(503, {});
      ingests.at(-1).accepted = true;
      if (dropSeq !== record.SourceSequence) {
        rows.push({ ...record, IngestedAt: new Date(clock.peek() + lagMs).toISOString() });
      }
      // A lost acknowledgement: the row landed, the response never arrived.
      if (loseAckOnce === record.SourceSequence && !lostAck) { lostAck = true; throw new Error('socket hang up'); }
      return response(204, { headers: { 'x-ms-request-id': `svc-${ingestCount}` } });
    }
    if (target.hostname === 'api.loganalytics.io') {
      assert.equal(init.headers.authorization, `Bearer ${READER_TOKEN}`, 'queries use the reader token');
      assert.equal(target.pathname, `/v1/workspaces/${WORKSPACE}/query`);
      const { query } = JSON.parse(init.body);
      queries.push(query);
      const where = /TenantRef == '([^']+)' and DestinationId == '([^']+)' and CorrelationId == '([^']+)'/.exec(query);
      let matched = rows.filter((row) => row.TenantRef === where[1] && row.DestinationId === where[2] && row.CorrelationId === where[3]);
      if (/summarize arg_max\(TimeGenerated, \*\) by TenantRef, DestinationId, KeelEventId/.test(query)) {
        const byKey = new Map();
        for (const row of matched) byKey.set(`${row.TenantRef}|${row.DestinationId}|${row.KeelEventId}`, row);
        matched = [...byKey.values()];
      }
      const columns = ['KeelEventId', 'TenantRef', 'DestinationId', 'CorrelationId', 'SourceSequence', 'TimeGenerated', 'IngestedAt'];
      return response(200, { body: { tables: [{ name: 'PrimaryResult', columns: columns.map((name) => ({ name })), rows: matched.map((row) => columns.map((name) => row[name])) }] } });
    }
    return response(404);
  };
  return { fetchImpl, rows, ingests, queries };
}

function steppingClock(start = observed) {
  let at = start;
  const clock = () => { at += 1000; return new Date(at); };
  clock.peek = () => at;
  return clock;
}

const documentation = () => sentinelRequiredDocumentation().map((url) => ({ url, retrievedAt: '2026-10-03T12:00:00Z' }));

async function capture(behaviour = {}, overrides = {}) {
  const clock = steppingClock();
  const workspace = fakeWorkspace({ ...behaviour, clock });
  const result = await captureSentinelAcceptance({
    ingestFetch: workspace.fetchImpl,
    senderToken: () => SENDER_TOKEN,
    query: logAnalyticsQueryTransport({ token: READER_TOKEN, workspaceId: WORKSPACE, fetchImpl: workspace.fetchImpl }),
    tenantRef, build, destinationId: DESTINATION,
    workspace: { workspaceId: WORKSPACE, endpoint: ENDPOINT, dcrImmutableId: DCR },
    credentials: { sender: 'env:KEEL_SENTINEL_SENDER_CREDENTIAL', reader: 'app:keel-sentinel-reader' },
    roles: { sender: ['Monitoring Metrics Publisher'], reader: ['Log Analytics Reader'] },
    documentation: documentation(), runId: 'keel-rt-sentinel-fixture', now: clock, sleep: async () => {}, queryAttempts: 2, queryDelayMs: 0,
    ...overrides,
  });
  return { ...result, workspace };
}

let counter = 0;
async function capturedFiles(behaviour, overrides) {
  const result = await capture(behaviour, overrides);
  const outPath = join(dir, `sentinel-record-${counter += 1}.json`);
  const { evidence, logPath } = writeSentinelAcceptanceFiles({ ...result, outPath, hmacKey: KEY });
  return { ...result, evidence, outPath, logPath };
}

const options = (extra = {}) => ({ gate: SENTINEL_LIVE_GATE, tenantRef, build, now: verifyNow, hmacKey: KEY, requireLive: true, ...extra });
const verifyIn = (evidence, extra) => verifyEvidence(evidence, { ...options(extra), evidenceDir: dir });
const failuresOf = (evidence, extra) => verifyIn(evidence, extra).failures.join('\n');
/** Applies a change and re-signs it with the trusted test key, as a dishonest capture would. */
const resign = (evidence, change) => signEvidence(change(structuredClone(evidence)), KEY);

test('a valid independently captured record verifies; replayed deliveries are physical duplicates, one logical event each', async () => {
  const { evidence, outPath, record, workspace } = await capturedFiles();
  assert.deepEqual(verifyEvidenceFile(outPath, options()), { ok: true, failures: [] });
  const { subject } = record;
  assert.equal(subject.probes.length, 5);
  // Initial delivery plus a full replay after a restart: two physical rows per event.
  assert.equal(subject.results.physicalRows, 10);
  assert.equal(subject.results.logicalEvents, 5);
  assert.equal(subject.results.physicalDuplicates, 5);
  assert.deepEqual(subject.results.missingEventIds, []);
  assert.equal(subject.replay.restartedAdapter, true);
  assert.equal(subject.deliveries.filter((item) => item.phase === 'replay' && item.outcome === 'accepted').length, 5);
  // The dedup identity is the stable KEEL event id; the diagnostic request id changes per request.
  for (const probe of subject.probes) {
    const sends = workspace.ingests.filter((item) => item.KeelEventId === probe.eventId);
    assert.equal(sends.length, 2);
    assert.notEqual(sends[0].clientRequestId, sends[1].clientRequestId);
  }
  assert.deepEqual(subject.dedupKey, ['TenantRef', 'DestinationId', 'KeelEventId']);
  assert.equal(subject.deliverySemantics, 'at-least-once');
  assert.ok(!subject.claims.includes('exactly-once') && !subject.claims.includes('unique-physical-rows'));
  // Actual delay: the fake lands each row 4 s after the clock reading at send time.
  assert.ok(Object.values(subject.results.delayMs.perEvent).every((ms) => ms >= 3000 && ms <= 5000), JSON.stringify(subject.results.delayMs));
  assert.equal(evidence.proof.runner.identity, 'keel-release-runner');
  // Two read-only queries; the logical one is the task-80 dedup view.
  assert.ok(workspace.queries.every((query) => /^KeelEvents_CL\n\| where TenantRef == /.test(query)));
  assert.match(subject.receiver.logicalQuery, /summarize arg_max\(TimeGenerated, \*\) by TenantRef, DestinationId, KeelEventId/);
  const text = readFileSync(outPath, 'utf8') + readFileSync(outPath.replace(/\.json$/, '.capture.json'), 'utf8');
  assert.doesNotMatch(text, /DO-NOT-LEAK|bearer\s|authorization/i);
});

test('actual errors and delay are preserved: a throttled and a lost acknowledgement still verify, and are recorded', async () => {
  const { evidence, record } = await capturedFiles({ throttleFirst: true, loseAckOnce: 2, lagMs: 90 * 1000 });
  assert.deepEqual(verifyIn(evidence), { ok: true, failures: [] });
  const { results, deliveries } = record.subject;
  assert.equal(results.errors.retry, 1);
  assert.equal(results.errors.uncertain, 1);
  assert.equal(results.retryAfterResponses, 1);
  assert.match(deliveries.find((item) => item.outcome === 'retry').error, /HTTP 429/);
  assert.match(deliveries.find((item) => item.outcome === 'uncertain').error, /outcome unknown/);
  // The lost acknowledgement landed a row AND was redelivered: three physical rows, one logical event.
  assert.equal(results.physicalRows, 11);
  assert.equal(results.logicalEvents, 5);
  assert.ok(results.delayMs.max >= 89 * 1000);

  // A summary that hides an error or invents a delay fails.
  for (const [change, pattern] of [
    [(e) => { e.subject.results.errors.uncertain = 0; return e; }, /results.errors does not match/],
    [(e) => { e.subject.results.retryAfterResponses = 0; return e; }, /results.retryAfterResponses does not match/],
    [(e) => { e.subject.deliveries = e.subject.deliveries.filter((item) => item.outcome === 'accepted'); return e; }, /results.errors does not match/],
    [(e) => { e.subject.results.delayMs.max = 100; return e; }, /results.delayMs does not match/],
    [(e) => { e.subject.deliveries.find((item) => item.outcome === 'retry').error = null; return e; }, /must keep its error/],
    [(e) => { e.subject.receiver.rawRows[0].IngestedAt = '2026-10-04T07:00:00.000Z'; return e; }, /ingested before it was sent/],
  ]) {
    assert.match(failuresOf(resign(evidence, change)), pattern);
  }
});

test('an altered signature or capture-log digest fails', async () => {
  const { evidence, logPath } = await capturedFiles();
  const forged = structuredClone(evidence);
  forged.proof.runner.signature = forged.proof.runner.signature.replace(/^./, (c) => (c === '0' ? '1' : '0'));
  assert.match(failuresOf(forged), /signature mismatch/);

  const edited = structuredClone(evidence);
  edited.subject.results.physicalDuplicates = 0;
  assert.match(failuresOf(edited), /signature mismatch/, 'any edit after signing breaks the signature');

  writeFileSync(logPath, readFileSync(logPath, 'utf8').replace('"accepted"', '"poison"'));
  assert.match(failuresOf(evidence), /artifact digest mismatch/);

  // A swapped log with a matching proof digest is still not the one the signature covers.
  const swapped = structuredClone(evidence);
  writeFileSync(join(dir, 'sentinel-swapped.capture.json'), '{}\n');
  swapped.proof.artifact = { path: 'sentinel-swapped.capture.json', sha256: 'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356' };
  const swappedFailures = failuresOf(swapped);
  assert.doesNotMatch(swappedFailures, /artifact digest mismatch/, 'the swapped log matches its own digest');
  assert.match(swappedFailures, /capture log digest is not bound/);
});

test('wrong tenant, build or operation fails, even when re-signed by the trusted runner', async () => {
  const { evidence } = await capturedFiles();
  assert.match(failuresOf(evidence, { tenantRef: OTHER_TENANT_REF }), /cross-tenant/);
  assert.match(failuresOf(evidence, { build: 'another-build' }), /Sentinel build mismatch/);
  assert.match(failuresOf(evidence, { tenantRef: null }), /expected tenant\/build/);
  for (const [change, pattern] of [
    [(e) => { e.operation = 'teams.configuration-qualification'; return e; }, /Sentinel operation mismatch/],
    [(e) => { e.operation = 'azure-monitor-logs-ingestion-delivery'; return e; }, /Sentinel operation mismatch/],
    [(e) => { e.credentialMode = 'entra-app-client-credentials'; return e; }, /credential mode/],
    [(e) => { e.gate = 'teams-live-acceptance'; return e; }, /gate mismatch/],
    [(e) => { e.tenantRef = OTHER_TENANT_REF; return e; }, /cross-tenant/],
    [(e) => { e.subject.destination.tenantRef = OTHER_TENANT_REF; return e; }, /destination belongs to another tenant/],
    [(e) => { e.subject.probes[1].tenantRef = OTHER_TENANT_REF; return e; }, /probe 1: belongs to another tenant/],
    [(e) => { e.subject.receiver.logicalRows[0].TenantRef = OTHER_TENANT_REF; return e; }, /logical row 0: belongs to another tenant/],
    [(e) => { e.subject.receiver.rawRows[3].DestinationId = 'dest-other'; return e; }, /raw row 3: belongs to another destination/],
    [(e) => { e.subject.receiver.rawRows[2].CorrelationId = 'keel-rt-sentinel-other'; return e; }, /raw row 2: belongs to another run/],
    [(e) => { e.subject.receiver.rawQuery = e.subject.receiver.rawQuery.replace(tenantRef, 'tenant:unscoped'); return e; }, /raw query is not scoped/],
    [(e) => { e.subject.credentials.reader = e.subject.credentials.sender; return e; }, /separate credentials/],
    [(e) => { e.subject.workspace.apiVersion = '2021-11-01-preview'; return e; }, /API version 2021-11-01-preview/],
  ]) {
    assert.match(failuresOf(resign(evidence, change)), pattern);
  }
});

test('stale evidence fails: an old record, or old deliveries, queries or documentation inside a fresh record', async () => {
  const { evidence } = await capturedFiles();
  assert.match(failuresOf(evidence, { now: new Date('2026-11-10T00:00:00Z') }), /observation is stale/);
  assert.match(failuresOf(evidence, { maxAgeHours: 0.5 }), /observation is stale/);
  for (const [change, pattern] of [
    [(e) => { e.subject.deliveries[0].sentAt = '2026-09-30T08:00:00Z'; return e; }, /delivery 0 .*stale capture/],
    [(e) => { e.subject.receiver.queriedAt = '2026-09-01T08:00:00Z'; return e; }, /receiver query: .*stale capture/],
    [(e) => { e.subject.receiver.queriedAt = '2026-10-05T08:00:00Z'; return e; }, /receiver query: captured after the record/],
    [(e) => { e.subject.documentation[0].retrievedAt = null; return e; }, /documentation not retrieved/],
  ]) {
    assert.match(failuresOf(resign(evidence, change)), pattern);
  }
});

test('a missing prerequisite fails: task, workspace, DCR, stream, schema, roles or receiver query evidence', async () => {
  const { evidence } = await capturedFiles();
  for (const [change, pattern] of [
    [(e) => { e.subject.prerequisites = ['task-79']; return e; }, /missing prerequisite: task-80/],
    [(e) => { e.subject.prerequisites = ['task-80']; return e; }, /missing prerequisite: task-79/],
    [(e) => { delete e.subject.workspace.workspaceId; return e; }, /no Log Analytics workspace id/],
    [(e) => { delete e.subject.workspace.dcrImmutableId; return e; }, /missing prerequisite: data-collection-rule-immutable-id/],
    [(e) => { e.subject.workspace.endpoint = 'http://insecure.example'; return e; }, /missing prerequisite: data-collection-endpoint/],
    [(e) => { e.subject.workspace.streamName = 'Custom-Other'; return e; }, /stream is 'Custom-Other'/],
    [(e) => { e.subject.workspace.table = 'Other_CL'; return e; }, /table is 'Other_CL'/],
    [(e) => { e.subject.workspace.schemaColumns.pop(); return e; }, /stream schema is not the one this build declares/],
    [(e) => { e.subject.roles.sender = ['Reader']; return e; }, new RegExp(`sender lacks role ${SENTINEL_SENDER_ROLES[0]}`)],
    [(e) => { e.subject.roles.reader = []; return e; }, /reader lacks a workspace read role/],
    [(e) => { delete e.subject.credentials.sender; return e; }, /no sender credential reference/],
    [(e) => { delete e.subject.receiver; return e; }, /no receiver query evidence/],
    [(e) => { e.subject.destination.kind = 'syslog'; return e; }, /destination kind/],
    [(e) => { e.subject.probes = e.subject.probes.slice(0, 2); return e; }, /at least 3 probe events/],
    [(e) => { e.subject.replay.restartedAdapter = false; return e; }, /restart\/replay not exercised/],
    [(e) => { e.subject.deliveries = e.subject.deliveries.filter((item) => item.phase !== 'replay'); return e; }, /no event was redelivered/],
  ]) {
    assert.match(failuresOf(resign(evidence, change)), pattern);
  }
  // A replay the workspace refused is not a proven restart/replay.
  const { evidence: refused } = await capturedFiles({ replayFails: true });
  assert.match(failuresOf(refused), /no event was redelivered and accepted/);
});

test('duplicate deliveries are deduplicated logically by event id, never claimed as unique rows or exactly-once', async () => {
  const { evidence } = await capturedFiles({ loseAckOnce: 0 });
  assert.deepEqual(verifyIn(evidence), { ok: true, failures: [] });
  for (const [change, pattern] of [
    // Physical rows passed off as the logical view: one key appears twice.
    [(e) => { e.subject.receiver.logicalRows = e.subject.receiver.rawRows; e.subject.results.logicalEvents = e.subject.results.physicalRows; return e; }, /more than one row for a dedup key/],
    // A logical view that does not match the raw rows it was computed from.
    [(e) => { e.subject.receiver.rawRows = e.subject.receiver.rawRows.filter((row) => row.KeelEventId !== e.subject.probes[4].eventId); return e; }, /not the dedup view of the raw rows/],
    [(e) => { e.subject.claims.push('exactly-once'); return e; }, /unproven claim refused: exactly-once/],
    [(e) => { e.subject.claims.push('unique-physical-rows'); return e; }, /unproven claim refused: unique-physical-rows/],
    [(e) => { e.subject.deliverySemantics = 'exactly-once'; return e; }, /delivery semantics must be at-least-once/],
    [(e) => { e.subject.dedupKey = ['clientRequestId']; return e; }, /dedup key must be TenantRef, DestinationId, KeelEventId/],
    [(e) => { e.subject.results.physicalDuplicates = 0; e.subject.results.physicalRows = 5; return e; }, /results.physicalRows does not match/],
    [(e) => { e.subject.receiver.logicalQuery = e.subject.receiver.rawQuery; return e; }, /logical query is not the task-80 dedup view/],
    [(e) => { e.subject.probes[1].eventId = e.subject.probes[0].eventId; return e; }, /duplicate event id/],
    [(e) => { e.subject.probes[1].eventId = 'not-a-stable-id'; return e; }, /probe 1: no stable event id/],
  ]) {
    assert.match(failuresOf(resign(evidence, change)), pattern);
  }
});

test('a missing event fails: a dropped event, a poisoned event, or a row hidden from the record', async () => {
  const dropped = await capturedFiles({ dropSeq: 3 });
  const missingId = dropped.record.subject.probes[3].eventId;
  assert.deepEqual(dropped.record.subject.results.missingEventIds, [missingId], 'the capture records the missing event');
  assert.match(failuresOf(dropped.evidence), new RegExp(`missing event: ${missingId}`));
  assert.equal(dropped.workspace.queries.length, 4, 'the receiver was polled until the budget ran out');

  const poisoned = await capturedFiles({ poisonSeq: 1 });
  const poisonedFailures = failuresOf(poisoned.evidence);
  assert.match(poisonedFailures, /was never accepted on initial delivery/);
  assert.match(poisonedFailures, /missing event/);
  assert.equal(poisoned.record.subject.results.errors.poison, 2);

  const { evidence } = await capturedFiles();
  const hidden = resign(evidence, (e) => {
    const id = e.subject.probes[2].eventId;
    e.subject.receiver.rawRows = e.subject.receiver.rawRows.filter((row) => row.KeelEventId !== id);
    e.subject.receiver.logicalRows = e.subject.receiver.logicalRows.filter((row) => row.KeelEventId !== id);
    return e;
  });
  assert.match(failuresOf(hidden), /missing event: evt_/);
  const foreign = resign(evidence, (e) => {
    e.subject.receiver.rawRows.push({ ...e.subject.receiver.rawRows[0], KeelEventId: `evt_${'f'.repeat(64)}` });
    return e;
  });
  assert.match(failuresOf(foreign), /unexpected event evt_f+ in the workspace/);
});

test('missing external evidence fails: the checked-in pending record, an absent file, the release CLI', async () => {
  const pending = join(repo, 'docs/release/qualifications/sentinel-live-acceptance.json');
  const record = JSON.parse(readFileSync(pending, 'utf8'));
  assert.equal(record.status, 'pending');
  assert.equal(record.synthetic, true);
  assert.match(verifyEvidenceFile(pending, options()).failures.join('\n'), /pending/);
  assert.equal(verifyEvidenceFile(pending, options({ requireLive: false })).ok, false);
  assert.equal(verifyEvidenceFile(join(dir, 'absent.json'), options()).ok, false);
  // A record without its capture log, or without a runner signature, is not evidence.
  const { evidence, logPath } = await capturedFiles();
  rmSync(logPath);
  assert.match(failuresOf(evidence), /Sentinel capture artifact required/);
  const { proof, ...unsigned } = evidence;
  assert.match(failuresOf({ ...unsigned, proof: { artifact: proof.artifact } }, { requireLive: false }), /Sentinel runner proof required/);
  // The exact release command exits nonzero on the checked-in record.
  assert.throws(() => execFileSync(process.execPath, [
    'tools/release/qualification.mjs', 'verify', '--require-live', '--gate', SENTINEL_LIVE_GATE,
    '--evidence', 'docs/release/qualifications/sentinel-live-acceptance.json',
  ], { cwd: repo, stdio: 'pipe' }), (error) => error.status === 1 && /pending/.test(String(error.stdout)));
});

test('fixture evidence is never elevated to live-qualified, and only a verified record becomes a claim', async () => {
  const { evidence } = await capturedFiles();
  const fixtureRunner = signEvidence(structuredClone(evidence), KEY, 'keel-fixture-runner');
  assert.match(failuresOf(fixtureRunner), /synthetic runner/);
  assert.match(failuresOf(fixtureRunner, { requireLive: false }), /Sentinel fixture evidence cannot claim live qualification/);
  const synthetic = resign(evidence, (e) => { e.synthetic = true; return e; });
  assert.match(failuresOf(synthetic, { requireLive: false }), /Sentinel fixture evidence cannot claim live/);
  const unlabelled = resign(evidence, (e) => { delete e.synthetic; return e; });
  assert.match(failuresOf(unlabelled, { requireLive: false }), /Sentinel fixture evidence cannot claim live/);
  const fixtureLevel = resign(evidence, (e) => { e.evidenceLevel = 'fixture-tested'; return e; });
  assert.match(failuresOf(fixtureLevel), /needs evidenceLevel 'live-qualified'/);
  // The task-80 offline check record is fixture-tested by construction and never this gate's evidence.
  const offline = JSON.parse(execFileSync(process.execPath, ['tools/qualification/sentinel.mjs', 'check', '--config', writeConfig()], { cwd: repo, encoding: 'utf8' }));
  assert.equal(offline.evidenceLevel, 'fixture-tested');
  assert.match(failuresOf(signEvidence({ ...offline, gate: SENTINEL_LIVE_GATE, tenantRef, build }, KEY)), /Sentinel operation mismatch/);

  const seam = { tenantRef, build, now: verifyNow, hmacKey: KEY, evidenceDir: dir };
  for (const bad of [fixtureRunner, synthetic, fixtureLevel]) {
    const imported = sentinelQualificationFromAcceptance(bad, seam);
    assert.equal(imported.ok, false);
    assert.equal(imported.claim, null);
  }
  const good = sentinelQualificationFromAcceptance(evidence, seam);
  assert.equal(good.ok, true, good.failures.join('; '));
  assert.deepEqual([good.claim.state, good.claim.deliverySemantics, good.claim.dedup], ['live-qualified', 'at-least-once', 'logical']);
  assert.match(good.claim.proofRef, /^sentinel-live-acceptance@[0-9a-f]{64}$/);
  // The same record never qualifies another tenant or build.
  assert.equal(sentinelQualificationFromAcceptance(evidence, { ...seam, tenantRef: OTHER_TENANT_REF }).ok, false);
  assert.equal(sentinelQualificationFromAcceptance(evidence, { ...seam, build: 'another-build' }).ok, false);
});

function writeConfig() {
  const path = join(dir, 'sentinel-config.json');
  writeFileSync(path, JSON.stringify({ endpoint: ENDPOINT, dcrImmutableId: DCR, credentialRef: 'env:KEEL_SENTINEL_SENDER_CREDENTIAL' }));
  return path;
}

test('the capture tool is offline by default, refuses without confirmation, and its CLI captures a verifiable record', async () => {
  const sent = [];
  const counting = async (...args) => { sent.push(args[0]); throw new Error('no network in this test'); };
  const lines = [];
  const base = ['--tenant-ref', tenantRef, '--destination-id', DESTINATION];
  assert.equal(await sentinelMain(['plan', ...base], { out: (line) => lines.push(line), env: {}, fetchImpl: counting }), 0);
  const plan = JSON.parse(lines[0]);
  assert.equal(plan.filter((step) => step.credential === 'reader').length, 2);
  assert.deepEqual(sentinelCapturePlan({ tenantRef, destinationId: DESTINATION }).map((step) => step.step), [1, 2, 3, 4, 4]);
  assert.equal(await sentinelMain(['capture', ...base], { out: () => {}, env: {}, fetchImpl: counting }), 2);
  assert.equal(sent.length, 0, 'nothing is sent without --confirm-live-workspace-ingest');
  assert.throws(() => sentinelCapturePlan({ tenantRef: "x' or 1==1", destinationId: DESTINATION }), /tenant reference/);

  const full = [
    'capture', '--confirm-live-workspace-ingest', ...base, '--workspace-id', WORKSPACE, '--endpoint', ENDPOINT,
    '--dcr-immutable-id', DCR, '--sender-ref', 'env:KEEL_SENTINEL_SENDER_CREDENTIAL', '--reader-ref', 'app:keel-sentinel-reader',
    '--roles', join(dir, 'roles.json'), '--docs', join(dir, 'docs.json'), '--out', join(dir, 'cli-sentinel.json'), '--build', build,
  ];
  writeFileSync(join(dir, 'roles.json'), JSON.stringify({ sender: ['Monitoring Metrics Publisher'], reader: ['Log Analytics Reader'] }));
  writeFileSync(join(dir, 'docs.json'), JSON.stringify(sentinelRequiredDocumentation().map((url) => ({ url, retrievedAt: new Date().toISOString() }))));
  await assert.rejects(sentinelMain(full, { out: () => {}, env: {}, fetchImpl: counting }), /KEEL_SENTINEL_SENDER_TOKEN/);
  await assert.rejects(sentinelMain(full.map((arg) => (arg === 'app:keel-sentinel-reader' ? 'env:KEEL_SENTINEL_SENDER_CREDENTIAL' : arg)),
    { out: () => {}, env: { KEEL_SENTINEL_SENDER_TOKEN: SENDER_TOKEN, KEEL_SENTINEL_READER_TOKEN: READER_TOKEN }, fetchImpl: counting }), /separate from the sender/);
  await assert.rejects(sentinelMain(full.map((arg) => (arg === DCR ? '' : arg)),
    { out: () => {}, env: { KEEL_SENTINEL_SENDER_TOKEN: SENDER_TOKEN, KEEL_SENTINEL_READER_TOKEN: READER_TOKEN }, fetchImpl: counting }), /capture needs --dcr-immutable-id/);
  assert.equal(sent.length, 0, 'every refusal happens before any request');

  // End to end through the CLI against the fake workspace, with real time.
  const workspace = fakeWorkspace({ clock: { peek: () => Date.now() } });
  const output = [];
  const env = { KEEL_SENTINEL_SENDER_TOKEN: SENDER_TOKEN, KEEL_SENTINEL_READER_TOKEN: READER_TOKEN, KEEL_QUALIFICATION_HMAC_KEY: KEY };
  const code = await sentinelMain(full, { out: (line) => output.push(line), env, fetchImpl: workspace.fetchImpl });
  assert.equal(code, 0, output.join('\n'));
  assert.equal(JSON.parse(output[0]).verify.ok, true);
  assert.deepEqual(verifyEvidenceFile(join(dir, 'cli-sentinel.json'), options({ now: new Date() })), { ok: true, failures: [] });
  // Without the runner key the CLI still writes the record, but it does not verify.
  const unsignedOut = [];
  const unsignedCode = await sentinelMain(full.map((arg) => (arg.endsWith('cli-sentinel.json') ? join(dir, 'cli-unsigned.json') : arg)),
    { out: (line) => unsignedOut.push(line), env: { ...env, KEEL_QUALIFICATION_HMAC_KEY: undefined }, fetchImpl: fakeWorkspace({ clock: { peek: () => Date.now() } }).fetchImpl });
  assert.equal(unsignedCode, 1);
  assert.match(JSON.parse(unsignedOut[0]).verify.failures.join('\n'), /runner/);
});
