// Gap P2: the committed live records are checked with the existing verifiers and
// overlaid on the coverage report; nothing here touches the committed files.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { capabilityFor, capabilitySummaryFor } from '../../engine/coverage/capabilities.mjs';
import { withLiveRecords } from '../../engine/coverage/report.mjs';
import { signEvidence } from '../release/qualification.mjs';
import { NO_KEY_REASON, WORKLOAD_LIVE_GATES, loadLiveRecords, plainReason } from './liveRecords.mjs';

const COMMITTED = new URL('../../docs/release/qualifications/', import.meta.url).pathname;
const TEST_TENANT = 'sha256:f7b3959300856957';
const KEY = randomBytes(32).toString('hex');
const scratch = mkdtempSync(join(tmpdir(), 'keel-live-records-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

/** A copy of the committed records, re-signed with this test's own key. */
function resignedCopy(name, { key = KEY, edit = (record) => record } = {}) {
  const dir = join(scratch, name);
  mkdirSync(join(dir, 'entra-live'), { recursive: true });
  for (const stem of ['user.update', 'group.create']) {
    const source = join(COMMITTED, 'entra-live', `${stem}.json`);
    writeJson(join(dir, 'entra-live', `${stem}.json`), signEvidence(edit(readJson(source)), key, 'keel-release-runner'));
    copyFileSync(join(COMMITTED, 'entra-live', `${stem}.capture.json`), join(dir, 'entra-live', `${stem}.capture.json`));
  }
  for (const { gate } of WORKLOAD_LIVE_GATES) {
    writeJson(join(dir, `${gate}.json`), signEvidence(edit(readJson(join(COMMITTED, `${gate}.json`))), key, 'keel-release-runner'));
    copyFileSync(join(COMMITTED, `${gate}.capture.json`), join(dir, `${gate}.capture.json`));
  }
  return dir;
}

const userUpdate = readJson(join(COMMITTED, 'entra-live', 'user.update.json'));
const groupCreate = readJson(join(COMMITTED, 'entra-live', 'group.create.json'));
const workloadObservedAt = Date.parse(readJson(join(COMMITTED, 'sharepoint-live-acceptance.json')).observedAt);
const fresh = new Date(Math.max(Date.parse(userUpdate.observedAt), Date.parse(groupCreate.observedAt), workloadObservedAt) + 24 * 60 * 60 * 1000);
const op = (records, resourceType, operation) => records.operations.find((r) => r.resourceType === resourceType && r.operation === operation);

test('a record signed with the configured key, on the test tenant and fresh, is live', () => {
  const dir = resignedCopy('valid');
  const records = loadLiveRecords({ dir, hmacKey: KEY, tenantRef: TEST_TENANT, now: fresh });
  const user = op(records, 'user', 'update');
  assert.equal(user.live, true, user.failures.join('; '));
  assert.equal(user.reason, null);
  assert.equal(user.expiresAt, new Date(Date.parse(userUpdate.observedAt) + 30 * 24 * 60 * 60 * 1000).toISOString());
  for (const workload of records.workloads) assert.equal(workload.live, true, `${workload.gate}: ${workload.failures.join('; ')}`);
  assert.equal(records.workloads.length, WORKLOAD_LIVE_GATES.length);

  // The overlay lifts the claim for this report only; the process registry is unchanged.
  assert.equal(capabilityFor('user', 'update').claim, 'fixture-tested');
  const summary = withLiveRecords(capabilitySummaryFor('user'), records);
  assert.equal(summary.operations.update.claim, 'live-qualified');
  assert.equal(summary.operations.update.proofRef, userUpdate.proofRef);
  assert.equal(summary.operations.update.liveRecord.live, true);
  assert.equal(capabilityFor('user', 'update').claim, 'fixture-tested');
  assert.equal(withLiveRecords(capabilitySummaryFor('user'), null).operations.update.claim, 'fixture-tested');
});

test('a signed record of a write that failed its live run is not live', () => {
  // The committed group create is a verified rerun (Q51); this copy keeps the run-2 outcome.
  const dir = resignedCopy('failed-write', { edit: (record) => (record.resourceType === 'group' ? { ...record, outcome: 'failed' } : record) });
  const records = loadLiveRecords({ dir, hmacKey: KEY, tenantRef: TEST_TENANT, now: fresh });
  const group = op(records, 'group', 'create');
  assert.equal(group.live, false);
  assert.match(group.failures.join(';'), /not verified by its read-back/);
  assert.equal(group.reason, 'the write did not read back as intended in the live run');
  assert.equal(withLiveRecords(capabilitySummaryFor('group'), records).operations.create.claim, 'fixture-tested');
});

test('a record with a sibling demotion is never live, however well it verifies (#294)', () => {
  const dir = resignedCopy('demoted');
  copyFileSync(join(COMMITTED, 'entra-live', 'group.create.demotion.json'), join(dir, 'entra-live', 'user.update.demotion.json'));
  const records = loadLiveRecords({ dir, hmacKey: KEY, tenantRef: TEST_TENANT, now: fresh });
  assert.equal(records.operations.some((record) => record.file.endsWith('.demotion.json')), false);
  const user = op(records, 'user', 'update');
  assert.equal(user.live, false);
  assert.match(user.failures.join(';'), /user\.update\.demotion\.json demotes this write/);
  assert.equal(user.reason, 'a later review withdrew this write from live');
  assert.equal(withLiveRecords(capabilitySummaryFor('user'), records).operations.update.claim, 'fixture-tested');
});

test('a record observed after its demotion is the verified rerun, and is checked as usual (#148)', () => {
  const dir = resignedCopy('rerun');
  const demotion = readJson(join(COMMITTED, 'entra-live', 'group.create.demotion.json'));
  const at = (offsetMs) => new Date(Date.parse(userUpdate.observedAt) + offsetMs).toISOString();
  writeJson(join(dir, 'entra-live', 'user.update.demotion.json'), { ...demotion, resourceType: 'user', operation: 'update', decidedAt: at(-60 * 1000) });
  const rerun = op(loadLiveRecords({ dir, hmacKey: KEY, tenantRef: TEST_TENANT, now: fresh }), 'user', 'update');
  assert.equal(rerun.live, true, rerun.failures.join('; '));

  // At the same instant, or with no readable date, the demotion still decides.
  for (const decidedAt of [at(0), 'not a date']) {
    writeJson(join(dir, 'entra-live', 'user.update.demotion.json'), { ...demotion, resourceType: 'user', operation: 'update', decidedAt });
    const user = op(loadLiveRecords({ dir, hmacKey: KEY, tenantRef: TEST_TENANT, now: fresh }), 'user', 'update');
    assert.equal(user.live, false, decidedAt);
    assert.match(user.failures.join(';'), /user\.update\.demotion\.json demotes this write/);
  }
});

test('without a key nothing is live and the reason says so', () => {
  const records = loadLiveRecords({ dir: resignedCopy('nokey'), hmacKey: null, tenantRef: TEST_TENANT, now: fresh });
  assert.equal(records.keyConfigured, false);
  for (const record of [...records.operations, ...records.workloads]) {
    assert.equal(record.live, false);
    assert.equal(record.reason, NO_KEY_REASON);
  }
  const loose = loadLiveRecords({ dir: resignedCopy('loosekey'), now: fresh, tenantRef: TEST_TENANT, missingKeyReason: 'the key file can be read by other users' });
  assert.equal(op(loose, 'user', 'update').reason, 'the key file can be read by other users');
  const summary = withLiveRecords(capabilitySummaryFor('user'), records);
  assert.equal(summary.operations.update.claim, 'fixture-tested');
  assert.equal(summary.operations.update.liveRecord.reason, NO_KEY_REASON);
});

test('a record signed with another key, or edited after signing, is not live', () => {
  const other = loadLiveRecords({ dir: resignedCopy('otherkey', { key: randomBytes(32).toString('hex') }), hmacKey: KEY, tenantRef: TEST_TENANT, now: fresh });
  assert.equal(op(other, 'user', 'update').live, false);
  assert.match(op(other, 'user', 'update').reason, /signature does not match/);
  for (const workload of other.workloads) assert.match(workload.reason, /signature does not match/);

  const dir = resignedCopy('tampered');
  const path = join(dir, 'entra-live', 'user.update.json');
  writeJson(path, { ...readJson(path), readBackVerified: true, build: 'edited-after-signing' });
  const tampered = loadLiveRecords({ dir, hmacKey: KEY, tenantRef: TEST_TENANT, now: fresh });
  assert.equal(op(tampered, 'user', 'update').live, false);
  assert.match(op(tampered, 'user', 'update').failures.join(';'), /signature mismatch/);
});

test('an expired record is not live and says it is more than 30 days old', () => {
  const late = new Date(Date.parse(userUpdate.observedAt) + 31 * 24 * 60 * 60 * 1000);
  const records = loadLiveRecords({ dir: resignedCopy('expired'), hmacKey: KEY, tenantRef: TEST_TENANT, now: late });
  assert.equal(op(records, 'user', 'update').live, false);
  assert.equal(op(records, 'user', 'update').reason, 'it is more than 30 days old');
  const lateWorkloads = loadLiveRecords({ dir: resignedCopy('expired-workloads'), hmacKey: KEY, tenantRef: TEST_TENANT, now: new Date(workloadObservedAt + 31 * 24 * 60 * 60 * 1000) });
  for (const workload of lateWorkloads.workloads) assert.equal(workload.live, false);
  assert.equal(lateWorkloads.workloads[0].reason, 'it is more than 30 days old');
});

test('a record from the test tenant never counts on another tenant', () => {
  const records = loadLiveRecords({ dir: resignedCopy('othertenant'), hmacKey: KEY, tenantRef: 'sha256:0000000000000000', now: fresh });
  assert.equal(op(records, 'user', 'update').live, false);
  assert.equal(op(records, 'user', 'update').reason, 'it was recorded on a different tenant');
  for (const workload of records.workloads) assert.equal(workload.live, false);
});

test('the committed records load, and none verifies without the real key', () => {
  const before = readFileSync(join(COMMITTED, 'entra-live', 'user.update.json'), 'utf8');
  const records = loadLiveRecords({ dir: COMMITTED, hmacKey: KEY, tenantRef: TEST_TENANT, now: fresh });
  assert.ok(records.operations.length > 0);
  assert.ok(records.operations.every((record) => !record.live && record.reason));
  assert.equal(readFileSync(join(COMMITTED, 'entra-live', 'user.update.json'), 'utf8'), before);
  assert.deepEqual(loadLiveRecords({ dir: join(scratch, 'absent') }).operations, []);
});

test('plain reasons never echo a tenant reference', () => {
  assert.equal(plainReason(["cross-tenant evidence refused: evidence is 'sha256:abc', required 'sha256:def'"]), 'it was recorded on a different tenant');
  assert.equal(plainReason(['something new']), 'it did not pass its checks');
});
