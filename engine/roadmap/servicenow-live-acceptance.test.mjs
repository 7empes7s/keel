// Roadmap task-118: ServiceNow non-default workflow qualification.
//
// Acceptance:
//  - a valid independently captured record verifies;
//  - altered signature/digest, wrong tenant/build/operation, stale evidence and a
//    missing prerequisite fail;
//  - one non-default approval workflow is exercised in both directions, including a
//    lost callback, a duplicate callback, a conflict and a revoked approver, and every
//    scenario shows one canonical KEEL action; an external "approved" state is never
//    authority on its own.
// Mutation checks:
//  - accept missing external evidence;
//  - accept mismatched tenant or operation;
//  - elevate fixture evidence to live-qualified.
//
// The capture tool drives the PRODUCTION task-97 adapter and task-96 bridge (isolated
// test database) against an in-memory fake NON-PRODUCTION instance: the Table API, two
// test users acting under their own tokens, the workflow setting the approver, and the
// instance-side relay rule signing each decision. Records are signed with a test-only
// key in a temporary directory. No instance is contacted, and no record produced here
// is persisted as release evidence.
import { strict as assert } from 'node:assert';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SERVICENOW_SIGNATURE_HEADER } from '../itsm/adapters/servicenow.mjs';
import { signEvidence, verifyEvidence, verifyEvidenceFile } from '../../tools/release/qualification.mjs';
import {
  SERVICENOW_LIVE_GATE, SERVICENOW_LIVE_SCENARIOS, serviceNowRequiredDocumentation,
} from '../../tools/qualification/servicenowAcceptance.mjs';
import {
  captureServiceNowAcceptance, main as serviceNowMain, serviceNowCapturePlan, serviceNowCaptureRefusals,
  serviceNowDatabaseRefusals, serviceNowQualificationFromAcceptance, writeServiceNowAcceptanceFiles,
} from '../../tools/qualification/servicenowLive.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const KEY = 'test-only';
const tenantRef = tenantRefFor('servicenow-live-fixture');
const OTHER_TENANT_REF = tenantRefFor('another-tenant');
const build = 'fixture-build';
const HOST = 'keel-fixture-nonprod.service-now.com';

const KEEL_TOKEN = 'fixture-keel-oauth-token-DO-NOT-LEAK';
const CALLBACK_SECRET = 'fixture-callback-secret-DO-NOT-LEAK';
const USER_ONE = 'qa.approver.one@example.com';
const USER_TWO = 'qa.approver.two@example.com';
const USER_TOKENS = { [USER_ONE]: 'fixture-user-one-token-DO-NOT-LEAK', [USER_TWO]: 'fixture-user-two-token-DO-NOT-LEAK' };
const SECRETS = {
  'env:KEEL_SERVICENOW_TOKEN': KEEL_TOKEN,
  'env:KEEL_SERVICENOW_CALLBACK_SECRET': CALLBACK_SECRET,
  'env:KEEL_SN_TEST_USER_ONE': USER_TOKENS[USER_ONE],
  'env:KEEL_SN_TEST_USER_TWO': USER_TOKENS[USER_TWO],
};
const resolveSecret = (reference) => {
  if (!(reference in SECRETS)) throw new Error(`unresolved credential reference: ${reference}`);
  return SECRETS[reference];
};

// A non-default workflow: its own table and gate field; "approved" is not a decision there.
const CONFIG = {
  instanceUrl: `https://${HOST}`,
  table: 'u_keel_gated_change',
  credential: { tokenRef: 'env:KEEL_SERVICENOW_TOKEN' },
  fields: {
    state: 'u_gate', approver: 'u_gate_owner.email', planVersion: 'u_plan_rev', planDigest: 'u_plan_hash',
    keelRequest: 'u_keel_ref', keelDecision: 'u_keel_outcome',
  },
  states: { approved: ['gate_passed'], rejected: ['gate_blocked', 'gate_withdrawn'] },
  callback: { secretRef: 'env:KEEL_SERVICENOW_CALLBACK_SECRET', maxSkewSeconds: 120 },
};
const TEST_USERS = [
  { externalUser: USER_ONE, credentialRef: 'env:KEEL_SN_TEST_USER_ONE' },
  { externalUser: USER_TWO, credentialRef: 'env:KEEL_SN_TEST_USER_TWO' },
];
const RELAY = 'u_keel_callback_relay';

const database = await createIsolatedTestDatabase(import.meta.url);
const client = await database.connect();
const dir = mkdtempSync(join(tmpdir(), 'keel-servicenow-live-'));
after(async () => {
  await client.end();
  await database.cleanup();
  rmSync(dir, { recursive: true, force: true });
});
const schema = readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8');
await client.query(schema);

/**
 * The fake non-production instance. KEEL's token may create records and write KEEL's
 * fields; a test user's token may only set the gate, after which the workflow names
 * that user as approver and the relay business rule writes a signed callback.
 */
let instances = 0;
function fakeInstance({ productionFlag = 'false', relaySecret = CALLBACK_SECRET, relayOff = false } = {}) {
  const records = new Map();
  const relay = [];
  const calls = [];
  let next = 0;
  const salt = (instances += 1).toString(16).padStart(4, '0');
  const actors = new Map([[KEEL_TOKEN, 'keel'], ...Object.entries(USER_TOKENS).map(([user, token]) => [token, user])]);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url);
    assert.equal(target.hostname, HOST, 'only the declared non-production host is contacted');
    const actor = actors.get(String(init.headers?.authorization ?? '').replace(/^Bearer /, ''));
    calls.push({ actor, method: init.method ?? 'GET', path: target.pathname, body: init.body ? JSON.parse(init.body) : null });
    if (!actor) return json(401, { error: { message: 'User Not Authenticated' } });
    if (target.pathname === '/api/now/table/sys_properties') {
      assert.equal(target.searchParams.get('sysparm_query'), 'name=glide.installation.production');
      return json(200, { result: productionFlag === null ? [] : [{ name: 'glide.installation.production', value: productionFlag }] });
    }
    if (target.pathname === `/api/now/table/${RELAY}`) {
      assert.equal(actor, 'keel');
      const sysId = /^u_record=([0-9a-f]{32})\^/.exec(target.searchParams.get('sysparm_query'))?.[1];
      return json(200, { result: relay.filter((row) => row.u_record === sysId).reverse() });
    }
    const match = /^\/api\/now\/table\/([a-z0-9_]+)(?:\/([0-9a-f]{32}))?$/.exec(target.pathname);
    assert.ok(match && match[1] === CONFIG.table, `unexpected path ${target.pathname}`);
    if (init.method === 'POST' && !match[2]) {
      assert.equal(actor, 'keel');
      next += 1;
      const sysId = `${salt}${next.toString(16).padStart(28, 'c')}`;
      records.set(sysId, { sys_id: sysId, sys_mod_count: 0, u_gate: 'requested', ...JSON.parse(init.body) });
      return json(201, { result: { sys_id: sysId } });
    }
    const record = records.get(match[2]);
    if (!record) return json(404, { error: { message: 'No Record found' } });
    if (init.method === 'PATCH') {
      const body = JSON.parse(init.body);
      if (actor === 'keel') {
        assert.ok(!('u_gate' in body), 'KEEL never writes the approval state field');
        Object.assign(record, body);
        record.sys_mod_count += 1;
        return json(200, { result: { ...record } });
      }
      assert.deepEqual(Object.keys(body), ['u_gate'], 'a test user sets only the gate');
      record.u_gate = body.u_gate;
      record['u_gate_owner.email'] = actor; // the workflow names who decided
      record.sys_mod_count += 1;
      if (!relayOff) {
        // ops/servicenow/keel-callback-relay.js
        const fields = ['u_gate', 'u_gate_owner.email', 'u_plan_rev', 'u_plan_hash'];
        const rawBody = JSON.stringify({
          sys_id: record.sys_id, sys_mod_count: String(record.sys_mod_count),
          record: Object.fromEntries(fields.map((field) => [field, String(record[field] ?? '')])),
        });
        const t = String(Math.floor(Date.now() / 1000));
        const v1 = createHmac('sha256', relaySecret).update(`${t}.${rawBody}`).digest('base64');
        relay.push({ sys_id: `r${relay.length}`.padEnd(32, '0'), u_record: record.sys_id, u_signature: `t=${t},v1=${v1}`, u_body: rawBody });
      }
      return json(200, { result: { ...record } });
    }
    const result = {};
    for (const field of target.searchParams.get('sysparm_fields').split(',')) result[field] = String(record[field] ?? '');
    return json(200, { result });
  };
  return { fetchImpl, records, relay, calls };
}

const documentation = () => serviceNowRequiredDocumentation().map((url) => ({ url, retrievedAt: new Date(Date.now() - 3600 * 1000).toISOString() }));
let runs = 0;
async function capture(behaviour = {}, overrides = {}) {
  const instance = fakeInstance(behaviour);
  runs += 1;
  const result = await captureServiceNowAcceptance({
    client, fetchImpl: instance.fetchImpl, resolveSecret, tenantRef, build, config: CONFIG, testUsers: TEST_USERS,
    declaredHost: HOST, declaredBy: 'operator (fixture)', relayTable: RELAY, documentation: documentation(),
    runId: `keel-rt-servicenow-fixture-${runs}`, sleep: async () => {}, relayAttempts: 2, relayDelayMs: 0,
    ...overrides,
  });
  return { ...result, instance };
}
async function capturedFiles(behaviour, overrides) {
  const result = await capture(behaviour, overrides);
  const outPath = join(dir, `servicenow-record-${runs}.json`);
  const { evidence, logPath } = writeServiceNowAcceptanceFiles({ ...result, outPath, hmacKey: KEY });
  return { ...result, evidence, outPath, logPath };
}

const options = (extra = {}) => ({ gate: SERVICENOW_LIVE_GATE, tenantRef, build, hmacKey: KEY, requireLive: true, ...extra });
const verifyIn = (evidence, extra) => verifyEvidence(evidence, { ...options(extra), evidenceDir: dir });
const failuresOf = (evidence, extra) => verifyIn(evidence, extra).failures.join('\n');
/** Applies a change and re-signs it with the trusted test key, as a dishonest capture would. */
const resign = (evidence, change) => signEvidence(change(structuredClone(evidence)), KEY);
const scenario = (evidence, name) => evidence.subject.scenarios.find((item) => item.name === name);

const captured = await capturedFiles();

test('a valid independently captured record verifies: both directions, one canonical KEEL action per scenario', async () => {
  const { evidence, outPath, record, instance } = captured;
  assert.deepEqual(verifyEvidenceFile(outPath, options()), { ok: true, failures: [] });
  assert.deepEqual(record.subject.scenarios.map((item) => item.name), [...SERVICENOW_LIVE_SCENARIOS]);
  const outcomes = (name, action) => scenario(record, name).steps.filter((step) => step.action === action)
    .map((step) => `${step.outcome}${step.duplicate ? '*' : ''}`);

  // KEEL -> ServiceNow: every scenario's plan reached its record and read back.
  for (const item of record.subject.scenarios) {
    assert.deepEqual(outcomes(item.name, 'outbound-record'), ['delivered']);
    assert.deepEqual(outcomes(item.name, 'readback-record'), ['match']);
    assert.equal(instance.records.get(item.sysId).u_plan_hash, item.planDigest);
    assert.equal(item.instanceAfter.state, 'gate_passed', 'the instance shows the external approval in every scenario');
  }
  // Duplicate callback: decides once.
  assert.deepEqual(outcomes('callback-duplicate', 'callback'), ['applied', 'applied*']);
  assert.equal(scenario(record, 'callback-duplicate').canonical.jobs, 1);
  assert.match(scenario(record, 'callback-duplicate').instanceAfter.keelDecision, /^KEEL decision: approved/);
  // Lost callback: the poll decides once; the late callback is already-decided.
  assert.deepEqual(outcomes('lost-callback', 'poll'), ['applied', 'applied*']);
  assert.deepEqual(outcomes('lost-callback', 'callback'), ['already-decided']);
  assert.equal(scenario(record, 'lost-callback').canonical.jobs, 1);
  assert.match(scenario(record, 'lost-callback').canonical.decisions[0].externalEventId, /^reconcile:/);
  // Conflict: KEEL's portal rejection stands and the instance is told.
  assert.deepEqual(outcomes('conflict', 'callback'), ['conflict']);
  assert.equal(scenario(record, 'conflict').canonical.requestStatus, 'rejected');
  assert.equal(scenario(record, 'conflict').canonical.jobs, 0);
  assert.match(scenario(record, 'conflict').instanceAfter.keelDecision, /KEEL decision: rejected \(ServiceNow said approved; KEEL's decision stands\)/);
  // Revoked approver: the external approval is on the record and decides nothing.
  assert.deepEqual(outcomes('revoked-approver', 'callback'), ['refused-not-eligible']);
  assert.equal(scenario(record, 'revoked-approver').canonical.requestStatus, 'pending');
  assert.deepEqual(scenario(record, 'revoked-approver').canonical.decisions, []);
  assert.equal(scenario(record, 'revoked-approver').canonical.jobs, 0);
  assert.equal(scenario(record, 'revoked-approver').instanceAfter.approver, USER_TWO);

  // Only KEEL and the two declared test users called the instance, each with its own token.
  assert.deepEqual([...new Set(instance.calls.map((call) => call.actor))].sort(), ['keel', USER_ONE, USER_TWO].sort());
  assert.ok(instance.calls.filter((call) => call.actor !== 'keel').every((call) => call.method === 'PATCH'));
  // References only: no token or secret value in the record or the log.
  assert.equal(evidence.proof.runner.identity, 'keel-release-runner');
  const text = readFileSync(outPath, 'utf8') + readFileSync(captured.logPath, 'utf8');
  assert.doesNotMatch(text, /DO-NOT-LEAK|bearer\s|authorization/i);
  assert.deepEqual(record.subject.testUsers.map((user) => user.credentialRef), ['env:KEEL_SN_TEST_USER_ONE', 'env:KEEL_SN_TEST_USER_TWO']);
});

test('the capture refuses an undeclared or production instance, a default workflow and unusable test users before sending anything', async () => {
  const ok = { config: CONFIG, testUsers: TEST_USERS, declaredHost: HOST, declaredBy: 'operator' };
  assert.deepEqual(serviceNowCaptureRefusals(ok), []);
  const cases = [
    [{ declaredHost: undefined }, /not declared non-production/],
    [{ declaredHost: 'prod.service-now.com' }, /is not the host declared non-production/],
    [{ declaredBy: '' }, /--declared-by/],
    [{ config: { ...CONFIG, table: 'change_request', fields: { ...CONFIG.fields, state: 'approval' }, states: { approved: ['approved'], rejected: ['rejected'] } } }, /out-of-the-box change_request/],
    [{ config: { ...CONFIG, callback: undefined } }, /callbacks must be signed/],
    [{ config: { ...CONFIG, states: { approved: ['gate_passed'] } } }, /No state value is mapped to rejected/],
    [{ testUsers: TEST_USERS.slice(0, 1) }, /at least 2 test users/],
    [{ testUsers: [TEST_USERS[0], { ...TEST_USERS[1], credentialRef: 'env:KEEL_SERVICENOW_TOKEN' }] }, /shares a credential/],
    [{ testUsers: [TEST_USERS[0], { ...TEST_USERS[1], credentialRef: USER_TOKENS[USER_TWO] }] }, /own env: credential reference/],
    [{ testUsers: [TEST_USERS[0], { ...TEST_USERS[1], password: 'x' }] }, /only externalUser and credentialRef/],
    [{ testUsers: [TEST_USERS[0], TEST_USERS[0]] }, /listed twice/],
  ];
  for (const [change, pattern] of cases) {
    const refusals = serviceNowCaptureRefusals({ ...ok, ...change });
    assert.ok(refusals.some((item) => pattern.test(item)), `${pattern}: ${refusals.join('; ')}`);
    const instance = fakeInstance();
    await assert.rejects(captureServiceNowAcceptance({
      client, fetchImpl: instance.fetchImpl, resolveSecret, tenantRef, build, documentation: [], ...ok, ...change,
    }), /^Error: refused:/);
    assert.equal(instance.calls.length, 0, 'nothing is sent before the refusals clear');
  }

  // The instance reports itself as production: refused after the one read, nothing created.
  const { rows: [{ before }] } = await client.query('SELECT count(*)::int AS before FROM principal');
  const production = fakeInstance({ productionFlag: 'true' });
  await assert.rejects(captureServiceNowAcceptance({
    client, fetchImpl: production.fetchImpl, resolveSecret, tenantRef, build, documentation: [], ...ok,
  }), /refused: the instance reports glide.installation.production=true/);
  assert.deepEqual(production.calls.map((call) => `${call.method} ${call.path}`), ['GET /api/now/table/sys_properties']);
  assert.equal(production.records.size, 0);
  const { rows: [{ count }] } = await client.query('SELECT count(*)::int AS count FROM principal');
  assert.equal(count, before, 'no qualification principal was created');

  // The KEEL database must be a dedicated qualification database.
  assert.deepEqual(serviceNowDatabaseRefusals('postgres://keel@db/keel_servicenow_qualification', {}), []);
  assert.match(serviceNowDatabaseRefusals('postgres://keel@db/keel', {})[0], /not named as a qualification database/);
  assert.match(serviceNowDatabaseRefusals('postgres://keel@db/keel_test', { KEEL_DB_URL: 'postgres://keel@db/keel_test' })[0], /must not be the production/);
  assert.match(serviceNowDatabaseRefusals(undefined, {})[0], /not set/);
});

test('altered signature or capture log digest fails', async () => {
  const { evidence, outPath, logPath } = captured;
  const tampered = structuredClone(evidence);
  scenario(tampered, 'revoked-approver').canonical.jobs = 0;
  scenario(tampered, 'conflict').canonical.requestStatus = 'approved';
  assert.match(failuresOf(tampered), /runner signature mismatch/);

  const forged = resign(evidence, (e) => { e.proof.runner.signature = 'ab'.repeat(32); return e; });
  assert.match(failuresOf({ ...forged, proof: { ...forged.proof, runner: { ...forged.proof.runner, signature: 'ab'.repeat(32) } } }), /runner signature mismatch/);

  // The capture log changed after the record was signed.
  const editedLog = join(dir, 'servicenow-edited.capture.json');
  writeFileSync(editedLog, readFileSync(logPath, 'utf8').replace(/"actor": "keel"/, '"actor": "someone"'));
  const relinked = resign(evidence, (e) => { e.proof.artifact.path = 'servicenow-edited.capture.json'; return e; });
  assert.match(failuresOf(relinked), /artifact digest mismatch/);
  // A record without its capture log fails even when signed.
  const noLog = resign(evidence, (e) => { delete e.proof.artifact; return e; });
  assert.match(failuresOf(noLog), /ServiceNow capture artifact required/);
  // The subject's digest must be the log's.
  const unbound = resign(evidence, (e) => { e.subject.captureLogSha256 = '0'.repeat(64); return e; });
  assert.match(failuresOf(unbound), /capture log digest is not bound/);
  assert.equal(verifyEvidenceFile(outPath, options()).ok, true, 'the original still verifies');
});

test('wrong tenant, build or operation fails', () => {
  const { evidence } = captured;
  assert.match(failuresOf(evidence, { tenantRef: OTHER_TENANT_REF }), /cross-tenant evidence refused/);
  assert.match(failuresOf(evidence, { build: 'another-build' }), /ServiceNow build mismatch/);
  assert.match(failuresOf(evidence, { build: null }), /expected tenant\/build identity required/);
  assert.match(failuresOf(resign(evidence, (e) => { e.operation = 'servicenow-table-api-approval-mirror'; return e; })), /ServiceNow operation mismatch/);
  assert.match(failuresOf(resign(evidence, (e) => { e.credentialMode = 'oauth-bearer-token-reference'; return e; })), /requires credential mode/);
  // One scenario captured for another tenant's KEEL records.
  assert.match(failuresOf(resign(evidence, (e) => { scenario(e, 'conflict').tenantRef = OTHER_TENANT_REF; return e; })), /scenario conflict: belongs to another tenant/);
  assert.match(failuresOf(evidence, { gate: 'sentinel-live-acceptance' }), /gate mismatch/);
});

test('stale evidence fails', () => {
  const { evidence } = captured;
  const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
  assert.match(failuresOf(resign(evidence, (e) => { e.observedAt = old; return e; })), /observation is stale/);
  // A record re-dated today around scenario steps captured days ago.
  const reDated = resign(evidence, (e) => {
    for (const item of e.subject.scenarios) for (const step of item.steps) step.at = new Date(Date.parse(step.at) - 3 * 24 * 3600 * 1000).toISOString();
    return e;
  });
  assert.match(failuresOf(reDated), /stale capture/);
  assert.match(failuresOf(resign(evidence, (e) => { e.subject.instance.declaredNonProduction.declaredAt = old; return e; })), /non-production declaration: captured more than 24h/);
});

test('a missing prerequisite fails', () => {
  const { evidence } = captured;
  const cases = [
    [(e) => { e.subject.prerequisites = ['task-96']; }, /missing prerequisite: task-97/],
    [(e) => { delete e.subject.instance.declaredNonProduction; }, /was not declared non-production/],
    [(e) => { e.subject.instance.declaredNonProduction.host = 'other.service-now.com'; }, /was not declared non-production/],
    [(e) => { e.subject.instance.productionFlag = 'true'; }, /a production instance is refused/],
    [(e) => { e.subject.workflow.table = 'change_request'; e.subject.workflow.fields.state = 'approval'; e.subject.workflow.approvedValues = ['approved']; e.subject.workflow.rejectedValues = ['rejected']; }, /out-of-the-box change_request approval/],
    [(e) => { delete e.subject.workflow.fields.approver; }, /workflow mapping field-approver/],
    [(e) => { delete e.subject.credentials.callbackSigning; }, /callbacks are not signed/],
    [(e) => { e.subject.testUsers = e.subject.testUsers.slice(0, 1); }, /at least 2 mapped test users/],
    [(e) => { delete e.subject.testUsers[1].principalId; }, /is not mapped to a KEEL principal/],
    [(e) => { e.subject.testUsers[1].credentialRef = e.subject.credentials.keel; }, /shares a credential/],
    [(e) => { e.subject.scenarios = e.subject.scenarios.filter((item) => item.name !== 'lost-callback'); }, /missing scenario: lost-callback/],
    [(e) => { e.subject.documentation = []; }, /documentation not retrieved/],
    [(e) => { e.subject.testUsers[0].token = KEEL_TOKEN; }, /looks like credential material/],
  ];
  for (const [change, pattern] of cases) {
    assert.match(failuresOf(resign(evidence, (e) => { change(e); return e; })), pattern);
  }
});

test('an external approval is never authority on its own, and one canonical KEEL action is enforced', () => {
  const { evidence } = captured;
  const cases = [
    // A revoked approver's external approval that KEEL acted on.
    [(e) => { const s = scenario(e, 'revoked-approver'); s.canonical.requestStatus = 'approved'; s.canonical.jobs = 1; }, /revoked approver changed the KEEL request|revoked approver minted 1 jobs/],
    [(e) => { scenario(e, 'revoked-approver').steps.find((step) => step.action === 'callback').outcome = 'applied'; }, /expected \[refused-not-eligible\]/],
    [(e) => { const s = scenario(e, 'revoked-approver'); s.steps = s.steps.filter((step) => step.action !== 'revoke-grant'); }, /grant was not revoked first/],
    // A conflict where the external approval won.
    [(e) => { scenario(e, 'conflict').canonical.jobs = 1; }, /rejected request minted 1 jobs/],
    [(e) => { scenario(e, 'conflict').instanceAfter.keelDecision = 'KEEL decision: rejected'; }, /does not show that KEEL's decision stands/],
    // A duplicate callback that acted twice.
    [(e) => { scenario(e, 'callback-duplicate').canonical.jobs = 2; }, /more than one canonical KEEL action|found 2 jobs/],
    [(e) => { const c = scenario(e, 'callback-duplicate').steps.filter((step) => step.action === 'callback'); c[1].duplicate = false; }, /expected \[applied, applied \(duplicate\)\]/],
    [(e) => { const s = scenario(e, 'callback-duplicate'); s.canonical.decisions.push({ ...s.canonical.decisions[0] }); }, /expected one canonical decision, found 2/],
    // A lost callback that was never withheld, or a second poll that acted again.
    [(e) => { const s = scenario(e, 'lost-callback'); s.steps = s.steps.filter((step) => step.action !== 'callback-withheld'); }, /no callback was withheld/],
    [(e) => { scenario(e, 'lost-callback').steps.filter((step) => step.action === 'poll')[1].duplicate = false; }, /polls were/],
    // A decision made by someone who is not a declared test user.
    [(e) => { scenario(e, 'conflict').steps.find((step) => step.action === 'decide').actor = 'admin'; }, /not a declared test user/],
    // KEEL's plan never reached the instance.
    [(e) => { scenario(e, 'conflict').steps.find((step) => step.action === 'readback-record').outcome = 'mismatch'; }, /did not read back the plan/],
  ];
  for (const [change, pattern] of cases) {
    assert.match(failuresOf(resign(evidence, (e) => { change(e); return e; })), pattern);
  }
});

test('the capture log binds who acted: only declared test users decide, under their own credential, and KEEL never writes the state', () => {
  const { evidence, logPath } = captured;
  const rebound = (name, edit) => {
    const log = JSON.parse(readFileSync(logPath, 'utf8'));
    edit(log);
    const text = `${JSON.stringify(log, null, 2)}\n`;
    writeFileSync(join(dir, name), text);
    const digest = createHash('sha256').update(text).digest('hex');
    return resign(evidence, (e) => { e.proof.artifact = { path: name, sha256: digest }; e.subject.captureLogSha256 = digest; return e; });
  };
  const decide = (log) => log.calls.find((call) => call.actor === USER_ONE);
  assert.match(failuresOf(rebound('log-a.json', (log) => { decide(log).actor = 'admin'; })), /neither KEEL nor a declared test user/);
  assert.match(failuresOf(rebound('log-b.json', (log) => { decide(log).credentialRef = 'env:KEEL_SN_TEST_USER_TWO'; })), /acted under another credential/);
  assert.match(failuresOf(rebound('log-c.json', (log) => { log.calls.find((call) => call.actor === 'keel' && call.method === 'PATCH').fields.push('u_gate'); })), /KEEL wrote the approval state field/);
  assert.match(failuresOf(rebound('log-d.json', (log) => { log.calls = log.calls.filter((call) => call.actor !== USER_TWO); })), /no PATCH by qa.approver.two@example.com/);
  assert.match(failuresOf(rebound('log-e.json', (log) => { log.calls[0].host = 'prod.service-now.com'; })), /sent to another host/);
  assert.equal(failuresOf(rebound('log-f.json', () => {})), '', 'an unchanged log re-bound still verifies');
});

test('an instance whose relay signs with another key yields a record that does not verify', async () => {
  const { evidence, record } = await capturedFiles({ relaySecret: 'not-the-callback-secret' });
  assert.deepEqual(scenario(record, 'callback-duplicate').steps.filter((step) => step.action === 'callback').map((step) => step.outcome),
    ['refused-bad-signature', 'refused-bad-signature']);
  // Polling (KEEL's own read) still decided it once; the signed-callback path did not.
  assert.equal(scenario(record, 'callback-duplicate').canonical.jobs, 1);
  assert.match(scenario(record, 'callback-duplicate').canonical.decisions[0].externalEventId, /^reconcile:/);
  const failures = failuresOf(evidence);
  assert.match(failures, /scenario callback-duplicate: the decision did not come from the signed callback/);
  assert.match(failures, /scenario callback-duplicate: callbacks were \[refused-bad-signature/);
  assert.match(failures, /scenario revoked-approver: the revoked approver's approval was \[refused-bad-signature\]/);

  // A relay that never writes a callback stops the capture: no record at all.
  await assert.rejects(capture({ relayOff: true }), /no signed callback reached u_keel_callback_relay/);
});

test('fixture evidence never elevates to live-qualified, and missing external evidence never verifies', () => {
  const { evidence } = captured;
  // Signed by the synthetic fixture runner: the gate refuses it even without --require-live.
  const fixtureSigned = signEvidence(structuredClone(evidence), KEY, 'keel-fixture-runner');
  assert.match(failuresOf(fixtureSigned, { requireLive: false }), /ServiceNow fixture evidence cannot claim live qualification/);
  const synthetic = resign(evidence, (e) => { e.synthetic = true; return e; });
  assert.match(failuresOf(synthetic, { requireLive: false }), /ServiceNow fixture evidence cannot claim live qualification/);
  assert.match(failuresOf(synthetic), /--require-live rejects synthetic fixtures/);
  assert.equal(serviceNowQualificationFromAcceptance(fixtureSigned, { tenantRef, build, hmacKey: KEY, evidenceDir: dir }).claim, null);

  // Missing external evidence: the checked-in placeholder, no record, no subject, no key.
  const placeholder = join(repo, 'docs/release/qualifications/servicenow-live-acceptance.json');
  const pending = verifyEvidenceFile(placeholder, options());
  assert.equal(pending.ok, false);
  assert.match(pending.failures.join('\n'), /pending/);
  const pendingWithFields = { ...evidence, status: 'pending' };
  assert.equal(verifyIn(pendingWithFields).ok, false, 'a pending status never verifies, whatever else the record holds');
  assert.match(failuresOf(resign(evidence, (e) => { delete e.subject; return e; })), /subject is missing/);
  assert.equal(verifyEvidenceFile(join(dir, 'absent.json'), options()).ok, false);
  assert.match(failuresOf(evidence, { hmacKey: null }), /ServiceNow runner proof required/);

  // The import seam turns only a verified live record into a claim.
  const imported = serviceNowQualificationFromAcceptance(evidence, { tenantRef, build, hmacKey: KEY, evidenceDir: dir });
  assert.equal(imported.ok, true, imported.failures.join('\n'));
  assert.equal(imported.claim.state, 'live-qualified');
  assert.equal(imported.claim.table, 'u_keel_gated_change');
  assert.deepEqual(imported.claim.approvedValues, ['gate_passed']);
  assert.equal(serviceNowQualificationFromAcceptance(evidence, { tenantRef: OTHER_TENANT_REF, build, hmacKey: KEY, evidenceDir: dir }).claim, null);
});

test('the CLI plans offline and refuses a capture without a declaration, a qualification database or a build', async () => {
  const files = { 'config.json': JSON.stringify(CONFIG), 'users.json': JSON.stringify(TEST_USERS), 'docs.json': '[]' };
  const readFile = (path) => files[path];
  const run = async (argv, env = {}) => {
    const lines = [];
    let connected = false;
    const code = await serviceNowMain(argv, {
      out: (line) => lines.push(line), env, readFile,
      fetchImpl: () => assert.fail('the CLI must not contact an instance here'), connect: async () => { connected = true; throw new Error('no'); },
    });
    return { code, output: JSON.parse(lines.join('\n')), connected };
  };
  const plan = await run(['plan', '--config', 'config.json', '--test-users', 'users.json']);
  assert.equal(plan.code, 0);
  assert.match(plan.output.refusals.join('\n'), /not declared non-production/);
  assert.equal(plan.output.plan.filter((item) => item.method === 'PATCH' && item.credential === USER_TWO).length, 1);
  assert.deepEqual(serviceNowCapturePlan({ config: CONFIG, testUsers: TEST_USERS }), plan.output.plan);

  const refused = await run(['capture', '--config', 'config.json', '--test-users', 'users.json', '--tenant-ref', tenantRef, '--docs', 'docs.json', '--out', join(dir, 'x.json')],
    { KEEL_SERVICENOW_QUALIFICATION_DB_URL: 'postgres://keel@localhost/keel' });
  assert.equal(refused.code, 2);
  assert.equal(refused.connected, false);
  const reasons = refused.output.refused.join('\n');
  assert.match(reasons, /not declared non-production/);
  assert.match(reasons, /not named as a qualification database/);
  assert.match(reasons, /capture needs --build/);
});
