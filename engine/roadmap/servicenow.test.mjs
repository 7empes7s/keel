/**
 * Roadmap task-97 boundary tests: the ServiceNow adapter (engine/itsm/adapters/servicenow.mjs)
 * over the real task-96 mirror (engine/itsm/bridge.mjs, engine/itsm/outbox.mjs), approval
 * decisions with current grants (govern/approvals.mjs), the job queue's idempotency and the
 * evidence chain, against an isolated test database. ServiceNow itself is a fake instance
 * behind an injected fetch: no ServiceNow instance is contacted, and nothing here proves
 * ServiceNow's API or any real workflow (that is task-118's gate).
 *
 * Required mutation checks:
 *
 * - Hardcode default change-request states.   (the non-default workflow's own values decide,
 *                                               and its "approved" value means nothing)
 * - Accept unsigned unauthenticated callback.  (an unsigned callback the instance would even
 *                                               agree with is refused before the bridge)
 * - Lose pending mirror after network error.   (a network error leaves the update pending and
 *                                               it is delivered later; the decision stands)
 */
import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  SERVICENOW_ADAPTER_NAME, SERVICENOW_SIGNATURE_HEADER, ServiceNowAdapterError, canonicalStatus, createServiceNowAdapter,
  handleServiceNowCallback, loadServiceNowAdapter, runServiceNowCycle, saveServiceNowConfig, serviceNowConfigProblems,
  serviceNowStatus,
} from '../itsm/adapters/servicenow.mjs';
import { listMirror, mapExternalIdentity, mirrorApprovalRequest, reconcileRecord } from '../itsm/bridge.mjs';
import { drainItsmOutbox, listItsmOutbox } from '../itsm/outbox.mjs';
import { requestApproval } from '../govern/approvals.mjs';
import { verifyChain } from '../govern/evidence.mjs';
import { checkServiceNowConfig } from '../../tools/qualification/servicenow.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
const client = await database.connect();
after(async () => {
  await client.end();
  await database.cleanup();
});

const schema = readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8');
await client.query(schema);
await client.query(schema); // additive and retry-safe

const ADMIN = '11111111-1111-4111-8111-111111111111';
const REQUESTER = '22222222-2222-4222-8222-222222222222';
const APPROVER = '33333333-3333-4333-8333-333333333333';
const VIEWER = '55555555-5555-4555-8555-555555555555';
await client.query(
  `INSERT INTO principal (id, email, display_name, disabled_at) VALUES
     ($1, 'admin@example.com', 'Admin', NULL), ($2, 'requester@example.com', 'Requester', NULL),
     ($3, 'approver@example.com', 'Approver', NULL), ($4, 'viewer@example.com', 'Viewer', NULL)`,
  [ADMIN, REQUESTER, APPROVER, VIEWER],
);
await client.query(
  `INSERT INTO role_grant (principal_id, role, granted_by, reason, active_until) VALUES
     ($1, 'admin', 'test', 'configures ServiceNow', NULL), ($1, 'viewer', 'test', 'reads', NULL),
     ($2, 'restorer', 'test', 'requests remediation', NULL),
     ($3, 'approver', 'test', 'change approver', NULL), ($4, 'viewer', 'test', 'read only', NULL)`,
  [ADMIN, REQUESTER, APPROVER, VIEWER],
);

const TOKEN = 'fixture-oauth-token-never-logged';
const CALLBACK_SECRET = 'fixture-callback-secret';
const SECRETS = { 'env:KEEL_SERVICENOW_TOKEN': TOKEN, 'env:KEEL_SERVICENOW_CALLBACK_SECRET': CALLBACK_SECRET };
const resolveSecret = (reference) => {
  if (!(reference in SECRETS)) throw new Error(`unresolved credential reference: ${reference}`);
  return SECRETS[reference];
};

// The out-of-the-box change_request approval field and its values.
const DEFAULT_CONFIG = {
  instanceUrl: 'https://keel-fixture.service-now.com',
  table: 'change_request',
  credential: { tokenRef: 'env:KEEL_SERVICENOW_TOKEN' },
  fields: {
    state: 'approval', approver: 'u_keel_approver.user_name', planVersion: 'u_keel_plan_version',
    planDigest: 'u_keel_plan_digest', keelRequest: 'u_keel_request', keelDecision: 'u_keel_decision',
  },
  states: { approved: ['approved'], rejected: ['rejected'] },
  callback: { secretRef: 'env:KEEL_SERVICENOW_CALLBACK_SECRET', maxSkewSeconds: 300 },
};

// A non-default workflow: its own table and gate field. Its value "approved" is an
// intermediate step (the CAB agreed, security has not); only gate_passed decides.
const CUSTOM_CONFIG = {
  instanceUrl: 'https://keel-fixture-custom.service-now.com',
  table: 'u_keel_gated_change',
  credential: { tokenRef: 'env:KEEL_SERVICENOW_TOKEN' },
  fields: {
    state: 'u_gate', approver: 'u_gate_owner.email', planVersion: 'u_plan_rev', planDigest: 'u_plan_hash',
    keelRequest: 'u_keel_ref', keelDecision: 'u_keel_outcome',
  },
  states: { approved: ['gate_passed'], rejected: ['gate_blocked', 'gate_withdrawn'] },
  callback: { secretRef: 'env:KEEL_SERVICENOW_CALLBACK_SECRET', maxSkewSeconds: 120 },
};

/**
 * A fake ServiceNow instance behind fetch: the Table API's GET and PATCH on one record,
 * dot-walked read fields, sys_mod_count, 404 for an unknown sys_id, and injectable
 * failures (a thrown network error, or an HTTP status).
 */
function fakeInstance(config) {
  const records = new Map();
  const calls = [];
  const failures = [];
  const origin = new URL(config.instanceUrl).origin;
  async function fetchImpl(url, init) {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    assert.equal(init.headers.authorization, `Bearer ${TOKEN}`, 'every call carries the referenced token');
    const failure = failures.shift();
    if (failure === 'network') throw Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') });
    if (typeof failure === 'number') return new Response(JSON.stringify({ error: { message: 'denied' } }), { status: failure });
    const parsed = new URL(url);
    assert.equal(parsed.origin, origin);
    const match = parsed.pathname.match(/^\/api\/now\/table\/([a-z0-9_]+)\/([0-9a-f]{32})$/);
    assert.ok(match, `unexpected path ${parsed.pathname}`);
    assert.equal(match[1], config.table, 'the configured table is used');
    const record = records.get(match[2]);
    if (!record) return new Response(JSON.stringify({ error: { message: 'No Record found' } }), { status: 404 });
    if (init.method === 'PATCH') {
      const body = JSON.parse(init.body);
      assert.ok(!(config.fields.state in body), 'KEEL never writes the approval state field');
      Object.assign(record, body);
      record.sys_mod_count += 1;
      return Response.json({ result: { ...record } });
    }
    assert.equal(init.method, 'GET');
    assert.equal(parsed.searchParams.get('sysparm_display_value'), 'false');
    assert.equal(parsed.searchParams.get('sysparm_exclude_reference_link'), 'true');
    const result = {};
    for (const field of parsed.searchParams.get('sysparm_fields').split(',')) result[field] = String(record[field] ?? '');
    return Response.json({ result });
  }
  return {
    records, calls, failures, fetchImpl,
    /** What a person does in the instance: sets the gate and who decided, mod count moves. */
    decide(sysId, value, user) {
      const record = records.get(sysId);
      record[config.fields.state] = value;
      record[config.fields.approver] = user;
      record.sys_mod_count += 1;
    },
    /** The body and signed header the instance-side business rule would send. */
    callbackFor(sysId, { at = new Date(), secret = CALLBACK_SECRET, overrides = {} } = {}) {
      const record = records.get(sysId);
      const fields = [config.fields.state, config.fields.approver, config.fields.planVersion, config.fields.planDigest];
      const rawBody = JSON.stringify({
        sys_id: sysId, sys_mod_count: record.sys_mod_count,
        record: { ...Object.fromEntries(fields.map((field) => [field, String(record[field] ?? '')])), ...overrides },
      });
      const t = String(Math.floor(at.getTime() / 1000));
      const v1 = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('base64');
      return { rawBody, headers: new Headers({ [SERVICENOW_SIGNATURE_HEADER]: `t=${t},v1=${v1}` }) };
    },
  };
}

let sequence = 0;
function sysId() {
  sequence += 1;
  return sequence.toString(16).padStart(32, 'a');
}

async function pendingRequest(tenantRef, params = { driftIds: [`drift-${(sequence += 1)}`] }) {
  return requestApproval(client, { tenantRef, action: 'remediate', params, requestedBy: REQUESTER, justification: 'roll back' });
}

async function requestRow(id) {
  const { rows: [row] } = await client.query('SELECT * FROM approval_request WHERE id = $1', [id]);
  return row;
}

async function jobsFor(requestId) {
  const { rows } = await client.query('SELECT * FROM job WHERE idempotency_key = $1', [`approval:${requestId}`]);
  return rows;
}

async function decisionsFor(recordId) {
  const { rows } = await client.query('SELECT * FROM itsm_decision WHERE record_id = $1 ORDER BY version', [recordId]);
  return rows;
}

/** A pending request mirrored to a new record in the fake instance, with KEEL's
 * outbound record update delivered (version and digest now on the record). */
async function mirrored(tenantRef, instance, adapter, params) {
  const request = await pendingRequest(tenantRef, params);
  const ref = sysId();
  instance.records.set(ref, { sys_id: ref, sys_mod_count: 0, [adapter.config.fields.state]: 'requested' });
  const record = await mirrorApprovalRequest(client, { tenantRef, adapter: SERVICENOW_ADAPTER_NAME, externalRef: ref, requestId: request.id, requestedBy: ADMIN });
  await drainItsmOutbox(client, { tenantRef, adapter, now: new Date() });
  assert.equal(instance.records.get(ref)[adapter.config.fields.planVersion], String(record.version), 'the record update reached the instance');
  return { request, record, ref };
}

/** A tenant of its own per test, so one test's outbound events never reach another's
 * fake instance. */
async function setupTenant(tenantRef, config) {
  const user = config === CUSTOM_CONFIG ? 'amara@example.com' : 'amara';
  await mapExternalIdentity(client, { tenantRef, adapter: SERVICENOW_ADAPTER_NAME, externalUser: user, principalId: APPROVER, requestedBy: ADMIN });
  await mapExternalIdentity(client, { tenantRef, adapter: SERVICENOW_ADAPTER_NAME, externalUser: 'vince', principalId: VIEWER, requestedBy: ADMIN });
  await saveServiceNowConfig(client, { tenantRef, config, requestedBy: ADMIN });
  return tenantRef;
}

test('a missing mapping disables the adapter visibly and nothing is sent', async () => {
  assert.deepEqual(serviceNowConfigProblems(DEFAULT_CONFIG), []);
  assert.deepEqual(serviceNowConfigProblems(CUSTOM_CONFIG), []);
  const tenantRef = 'sha256:servicenow-incomplete';
  const incomplete = structuredClone(CUSTOM_CONFIG);
  delete incomplete.states.rejected;
  delete incomplete.fields.approver;
  const problems = serviceNowConfigProblems(incomplete).map((item) => item.code);
  assert.deepEqual(problems.sort(), ['field-approver', 'states-rejected']);
  assert.throws(() => createServiceNowAdapter({ config: incomplete, fetchImpl: () => assert.fail('no call'), resolveSecret }),
    (error) => error instanceof ServiceNowAdapterError && error.code === 'disabled' && error.problems.length === 2);

  // Ambiguity is a missing mapping too: one value meaning both outcomes, or one field for two roles.
  const overlap = structuredClone(DEFAULT_CONFIG);
  overlap.states.rejected = ['approved'];
  assert.ok(serviceNowConfigProblems(overlap).some((item) => item.code === 'states-overlap'));
  const sameField = structuredClone(DEFAULT_CONFIG);
  sameField.fields.keelDecision = sameField.fields.planDigest;
  assert.ok(serviceNowConfigProblems(sameField).some((item) => item.code === 'field-overlap'));
  const plainHttp = { ...DEFAULT_CONFIG, instanceUrl: 'http://keel-fixture.service-now.com' };
  assert.ok(serviceNowConfigProblems(plainHttp).some((item) => item.code === 'instance-url'));

  // Not set up at all: off, and says so.
  const before = await serviceNowStatus(client, { tenantRef, principalId: VIEWER });
  assert.equal(before.configured, false);
  assert.equal(before.enabled, false);
  assert.deepEqual(before.problems.map((item) => item.code), ['not-configured']);

  // Stored incomplete: the status names each missing mapping in words, a cycle does nothing.
  await saveServiceNowConfig(client, { tenantRef, config: incomplete, requestedBy: ADMIN });
  const status = await serviceNowStatus(client, { tenantRef, principalId: VIEWER });
  assert.equal(status.configured, true);
  assert.equal(status.enabled, false);
  assert.ok(status.problems.some((item) => /No state value is mapped to rejected/.test(item.message)));
  assert.ok(status.problems.some((item) => /person who decided/.test(item.message)));
  let called = 0;
  const cycle = await runServiceNowCycle(client, { tenantRef, fetchImpl: () => { called += 1; }, resolveSecret });
  assert.equal(cycle.enabled, false);
  assert.equal(cycle.problems.length, 2);
  assert.equal(called, 0, 'a disabled adapter never contacts the instance');
  await assert.rejects(loadServiceNowAdapter(client, { tenantRef, resolveSecret }), (error) => error.code === 'disabled');

  // Credentials are references only; a viewer cannot change the config.
  for (const leaked of [
    { ...DEFAULT_CONFIG, credential: { tokenRef: `Bearer ${TOKEN}` } },
    { ...DEFAULT_CONFIG, credential: { tokenRef: 'env:KEEL_SERVICENOW_TOKEN', token: TOKEN } },
    { ...DEFAULT_CONFIG, instanceUrl: 'https://admin:hunter22@keel-fixture.service-now.com' },
    { ...DEFAULT_CONFIG, password: 'x' },
  ]) {
    await assert.rejects(saveServiceNowConfig(client, { tenantRef, config: leaked, requestedBy: ADMIN }), (error) => error.code === 'invalid');
  }
  await assert.rejects(saveServiceNowConfig(client, { tenantRef, config: DEFAULT_CONFIG, requestedBy: VIEWER }), (error) => error.code === 'not-authorized');
  const { rows: [stored] } = await client.query('SELECT config FROM itsm_adapter_config WHERE tenant_ref = $1', [tenantRef]);
  assert.ok(!JSON.stringify(stored.config).includes(TOKEN));
});

test('a non-default workflow maps to the same canonical approval', async () => {
  const DEFAULT_TENANT = await setupTenant('sha256:servicenow-default', DEFAULT_CONFIG);
  const CUSTOM_TENANT = await setupTenant('sha256:servicenow-custom', CUSTOM_CONFIG);
  const params = { driftIds: ['drift-same-plan'] };
  const defaultInstance = fakeInstance(DEFAULT_CONFIG);
  const customInstance = fakeInstance(CUSTOM_CONFIG);
  const defaultAdapter = createServiceNowAdapter({ config: DEFAULT_CONFIG, fetchImpl: defaultInstance.fetchImpl, resolveSecret });
  const customAdapter = createServiceNowAdapter({ config: CUSTOM_CONFIG, fetchImpl: customInstance.fetchImpl, resolveSecret });
  const a = await mirrored(DEFAULT_TENANT, defaultInstance, defaultAdapter, params);
  const b = await mirrored(CUSTOM_TENANT, customInstance, customAdapter, params);

  // KEEL wrote the plan into each workflow's own fields.
  assert.equal(customInstance.records.get(b.ref).u_plan_rev, '1');
  assert.equal(customInstance.records.get(b.ref).u_plan_hash, b.record.plan_digest);
  assert.equal(customInstance.records.get(b.ref).u_keel_ref, String(b.request.id));
  assert.equal(defaultInstance.records.get(a.ref).u_keel_plan_digest, a.record.plan_digest);

  // In the custom workflow "approved" is an intermediate step: it decides nothing.
  customInstance.decide(b.ref, 'approved', 'amara@example.com');
  assert.equal(canonicalStatus(CUSTOM_CONFIG, 'approved'), 'servicenow:approved');
  const intermediate = await reconcileRecord(client, { tenantRef: CUSTOM_TENANT, adapter: customAdapter, externalRef: b.ref });
  assert.equal(intermediate.outcome, 'ignored-status');
  assert.equal((await requestRow(b.request.id)).status, 'pending');
  assert.equal((await jobsFor(b.request.id)).length, 0);

  // Each workflow's own approved value decides, through the same mapped principal.
  defaultInstance.decide(a.ref, 'approved', 'amara');
  customInstance.decide(b.ref, 'gate_passed', 'amara@example.com');
  const viaDefault = await runServiceNowCycle(client, { tenantRef: DEFAULT_TENANT, fetchImpl: defaultInstance.fetchImpl, resolveSecret });
  const viaCustom = await runServiceNowCycle(client, { tenantRef: CUSTOM_TENANT, fetchImpl: customInstance.fetchImpl, resolveSecret });
  assert.equal(viaDefault.reconciled.applied, 1);
  assert.equal(viaCustom.reconciled.applied, 1);
  const [defaultDecision] = await decisionsFor(a.record.id);
  const [customDecision] = await decisionsFor(b.record.id);
  const canonical = (row) => ({
    outcome: row.decision.outcome, approver: row.decision.approver, action: row.decision.action,
    planDigest: row.decision.planDigest, version: row.decision.version, source: row.decision.source,
  });
  assert.deepEqual(canonical(customDecision), canonical(defaultDecision), 'the same canonical approval');
  assert.deepEqual(canonical(customDecision), {
    outcome: 'approved', approver: APPROVER, action: 'remediate', planDigest: b.record.plan_digest, version: 1, source: 'itsm',
  });
  assert.equal((await jobsFor(a.request.id)).length, 1);
  assert.equal((await jobsFor(b.request.id)).length, 1);

  // The custom rejection values reject; a rejection decides once, too.
  const c = await mirrored(CUSTOM_TENANT, customInstance, customAdapter);
  customInstance.decide(c.ref, 'gate_withdrawn', 'amara@example.com');
  assert.equal((await reconcileRecord(client, { tenantRef: CUSTOM_TENANT, adapter: customAdapter, externalRef: c.ref })).outcome, 'applied');
  assert.equal((await requestRow(c.request.id)).status, 'rejected');
  assert.equal((await jobsFor(c.request.id)).length, 0);
});

test('a lost callback is reconciled once', async () => {
  const DEFAULT_TENANT = await setupTenant('sha256:servicenow-lost', DEFAULT_CONFIG);
  const instance = fakeInstance(DEFAULT_CONFIG);
  const adapter = createServiceNowAdapter({ config: DEFAULT_CONFIG, fetchImpl: instance.fetchImpl, resolveSecret });
  const { request, record, ref } = await mirrored(DEFAULT_TENANT, instance, adapter);
  instance.decide(ref, 'approved', 'amara');
  const lateCallback = instance.callbackFor(ref); // sent by the instance, never arrived

  const first = await runServiceNowCycle(client, { tenantRef: DEFAULT_TENANT, fetchImpl: instance.fetchImpl, resolveSecret });
  assert.equal(first.reconciled.applied, 1);
  assert.equal((await requestRow(request.id)).status, 'approved');
  // Polling again, directly or by cycle, acts no further.
  const again = await reconcileRecord(client, { tenantRef: DEFAULT_TENANT, adapter, externalRef: ref });
  assert.equal(again.duplicate, true);
  const second = await runServiceNowCycle(client, { tenantRef: DEFAULT_TENANT, fetchImpl: instance.fetchImpl, resolveSecret });
  assert.equal(second.reconciled.applied ?? 0, 0);
  // The original callback arrives late: authentic, confirmed, and already decided.
  const late = await handleServiceNowCallback(client, { tenantRef: DEFAULT_TENANT, adapter, ...lateCallback });
  assert.equal(late.outcome, 'already-decided');
  assert.equal((await jobsFor(request.id)).length, 1, 'one action');
  assert.equal((await decisionsFor(record.id)).length, 1, 'one decision');
  // The canonical decision went back to the instance's decision field, not its state field.
  assert.match(instance.records.get(ref).u_keel_decision, /^KEEL decision: approved; digest [0-9a-f]{64}/);
});

test('a forged or replayed callback cannot widen authority', async () => {
  const DEFAULT_TENANT = await setupTenant('sha256:servicenow-forged', DEFAULT_CONFIG);
  const instance = fakeInstance(DEFAULT_CONFIG);
  const adapter = createServiceNowAdapter({ config: DEFAULT_CONFIG, fetchImpl: instance.fetchImpl, resolveSecret });
  const { request, ref } = await mirrored(DEFAULT_TENANT, instance, adapter);
  instance.decide(ref, 'approved', 'amara');
  const signed = instance.callbackFor(ref);
  const assertPending = async (label) => {
    assert.equal((await requestRow(request.id)).status, 'pending', label);
    assert.equal((await jobsFor(request.id)).length, 0, label);
  };

  // Unsigned, even though the instance would agree with every field: refused.
  const unsigned = await handleServiceNowCallback(client, { tenantRef: DEFAULT_TENANT, adapter, headers: new Headers(), rawBody: signed.rawBody });
  assert.equal(unsigned.outcome, 'refused-unsigned');
  await assertPending('unsigned');
  // Signed with another key, or an incomplete header.
  const wrongKey = instance.callbackFor(ref, { secret: 'guessed-secret' });
  assert.equal((await handleServiceNowCallback(client, { tenantRef: DEFAULT_TENANT, adapter, ...wrongKey })).outcome, 'refused-bad-signature');
  const noMac = { rawBody: signed.rawBody, headers: new Headers({ [SERVICENOW_SIGNATURE_HEADER]: `t=${Math.floor(Date.now() / 1000)}` }) };
  assert.equal((await handleServiceNowCallback(client, { tenantRef: DEFAULT_TENANT, adapter, ...noMac })).outcome, 'refused-unsigned');
  // A body altered after signing.
  const tampered = { headers: signed.headers, rawBody: signed.rawBody.replace('"amara"', '"vince"') };
  assert.equal((await handleServiceNowCallback(client, { tenantRef: DEFAULT_TENANT, adapter, ...tampered })).outcome, 'refused-bad-signature');
  // An authentic callback captured long ago and replayed: outside the window.
  const old = instance.callbackFor(ref, { at: new Date(Date.now() - 10 * 60 * 1000) });
  assert.equal((await handleServiceNowCallback(client, { tenantRef: DEFAULT_TENANT, adapter, ...old })).outcome, 'refused-stale-timestamp');
  // Signed with a leaked secret, claiming a decision the instance does not show.
  const forged = instance.callbackFor(ref, { overrides: { 'u_keel_approver.user_name': 'vince' } });
  const forgedResult = await handleServiceNowCallback(client, { tenantRef: DEFAULT_TENANT, adapter, ...forged });
  assert.equal(forgedResult.outcome, 'refused-instance-mismatch');
  assert.deepEqual(forgedResult.detail.fields, ['externalUser']);
  await assertPending('forged');
  for (const outcome of ['refused-unsigned', 'refused-bad-signature', 'refused-stale-timestamp', 'refused-instance-mismatch']) {
    const { rows } = await client.query(
      "SELECT 1 FROM evidence WHERE kind = 'itsm-callback' AND subject->>'outcome' = $1", [outcome],
    );
    assert.ok(rows.length > 0, `${outcome} is evidenced`);
  }

  // The authentic callback decides once; replaying it inside the window is a duplicate.
  const applied = await handleServiceNowCallback(client, { tenantRef: DEFAULT_TENANT, adapter, ...signed });
  assert.equal(applied.outcome, 'applied');
  const replay = await handleServiceNowCallback(client, { tenantRef: DEFAULT_TENANT, adapter, ...signed });
  assert.equal(replay.duplicate, true);
  assert.equal((await jobsFor(request.id)).length, 1);

  // An authentic, confirmed callback from a person without a current approve grant.
  const viewerPlan = await mirrored(DEFAULT_TENANT, instance, adapter);
  instance.decide(viewerPlan.ref, 'approved', 'vince');
  const viewerResult = await handleServiceNowCallback(client, { tenantRef: DEFAULT_TENANT, adapter, ...instance.callbackFor(viewerPlan.ref) });
  assert.equal(viewerResult.outcome, 'refused-not-eligible');
  assert.equal((await requestRow(viewerPlan.request.id)).status, 'pending');

  // An authentic approval of version 1, replayed after a re-plan to version 2.
  const replan = await mirrored(DEFAULT_TENANT, instance, adapter);
  instance.decide(replan.ref, 'approved', 'amara');
  const v1Callback = instance.callbackFor(replan.ref);
  instance.decide(replan.ref, 'requested', '');
  const newer = await pendingRequest(DEFAULT_TENANT);
  await mirrorApprovalRequest(client, { tenantRef: DEFAULT_TENANT, adapter: SERVICENOW_ADAPTER_NAME, externalRef: replan.ref, requestId: newer.id, requestedBy: ADMIN });
  await drainItsmOutbox(client, { tenantRef: DEFAULT_TENANT, adapter, now: new Date() });
  const stale = await handleServiceNowCallback(client, { tenantRef: DEFAULT_TENANT, adapter, ...v1Callback });
  assert.notEqual(stale.outcome, 'applied');
  assert.equal((await requestRow(newer.id)).status, 'pending');
  assert.equal((await jobsFor(newer.id)).length, 0);

  // Callbacks off: every callback is refused and polling is the only path.
  const pollingOnly = createServiceNowAdapter({ config: { ...DEFAULT_CONFIG, callback: undefined }, fetchImpl: instance.fetchImpl, resolveSecret });
  assert.equal((await handleServiceNowCallback(client, { tenantRef: DEFAULT_TENANT, adapter: pollingOnly, ...signed })).outcome, 'refused-callbacks-off');
});

test('a failed external update does not roll back the canonical decision silently', async () => {
  const DEFAULT_TENANT = await setupTenant('sha256:servicenow-failed', DEFAULT_CONFIG);
  const instance = fakeInstance(DEFAULT_CONFIG);
  const adapter = createServiceNowAdapter({ config: DEFAULT_CONFIG, fetchImpl: instance.fetchImpl, resolveSecret });
  const { request, record, ref } = await mirrored(DEFAULT_TENANT, instance, adapter);
  instance.decide(ref, 'approved', 'amara');
  assert.equal((await reconcileRecord(client, { tenantRef: DEFAULT_TENANT, adapter, externalRef: ref })).outcome, 'applied');

  // The network drops while KEEL writes the decision back: the update stays pending.
  instance.failures.push('network');
  const failed = await drainItsmOutbox(client, { tenantRef: DEFAULT_TENANT, adapter, now: new Date() });
  assert.deepEqual(failed, { delivered: 0, retried: 1, quarantined: 0 });
  const [, decisionEvent] = await listItsmOutbox(client, { tenantRef: DEFAULT_TENANT, recordId: record.id });
  assert.equal(decisionEvent.kind, 'decision');
  assert.equal(decisionEvent.status, 'pending');
  assert.match(decisionEvent.last_error, /network error/);
  assert.ok(!decisionEvent.last_error.includes(TOKEN), 'the token never reaches the outbox');
  assert.equal(instance.records.get(ref).u_keel_decision, undefined);
  assert.equal((await requestRow(request.id)).status, 'approved', 'the decision stands');
  const status = await serviceNowStatus(client, { tenantRef: DEFAULT_TENANT, principalId: VIEWER });
  assert.ok(status.mirror.pendingUpdates >= 1, 'the waiting update is visible');

  // The network is back: the same event is delivered once, later.
  const later = new Date(Date.now() + 60 * 1000);
  assert.equal((await drainItsmOutbox(client, { tenantRef: DEFAULT_TENANT, adapter, now: later })).delivered, 1);
  assert.match(instance.records.get(ref).u_keel_decision, new RegExp(`event keel:decision:${(await decisionsFor(record.id))[0].id}$`));

  // ServiceNow refuses the write for good (403): held back, shown, decision unchanged.
  const refused = await mirrored(DEFAULT_TENANT, instance, adapter);
  instance.decide(refused.ref, 'rejected', 'amara');
  assert.equal((await reconcileRecord(client, { tenantRef: DEFAULT_TENANT, adapter, externalRef: refused.ref })).outcome, 'applied');
  instance.failures.push(403);
  const quarantined = await drainItsmOutbox(client, { tenantRef: DEFAULT_TENANT, adapter, now: new Date() });
  assert.equal(quarantined.quarantined, 1);
  assert.equal((await requestRow(refused.request.id)).status, 'rejected', 'still the canonical decision');
  const shown = await serviceNowStatus(client, { tenantRef: DEFAULT_TENANT, principalId: VIEWER });
  assert.equal(shown.enabled, true);
  assert.equal(shown.mirror.heldBack, 1);
  assert.equal(shown.heldBack[0].externalRef, refused.ref);
  assert.match(shown.heldBack[0].lastError, /HTTP 403/);
  assert.equal(shown.heldBack[0].reason, 'rejected by adapter');
  assert.equal(shown.mapping.tokenRef, 'env:KEEL_SERVICENOW_TOKEN');
  assert.ok(!JSON.stringify(shown).includes(TOKEN) && !JSON.stringify(shown).includes(CALLBACK_SECRET));
  const mirror = await listMirror(client, { tenantRef: DEFAULT_TENANT, principalId: VIEWER });
  assert.equal(mirror.find((row) => row.externalRef === refused.ref).outbox.quarantined, 1);

  // Transient statuses are retried, a vanished record is held back.
  const transientStatuses = [401, 429, 503];
  for (const code of transientStatuses) {
    const plan = await pendingRequest(DEFAULT_TENANT);
    const ref2 = sysId();
    instance.records.set(ref2, { sys_id: ref2, sys_mod_count: 0, approval: 'requested' });
    await mirrorApprovalRequest(client, { tenantRef: DEFAULT_TENANT, adapter: SERVICENOW_ADAPTER_NAME, externalRef: ref2, requestId: plan.id, requestedBy: ADMIN });
    instance.failures.push(code);
    assert.equal((await drainItsmOutbox(client, { tenantRef: DEFAULT_TENANT, adapter, now: new Date(), batchSize: 1 })).retried, 1, `HTTP ${code} is retried`);
  }
  await assert.rejects(adapter.deliver({ eventId: 'e', kind: 'record', externalRef: 'b'.repeat(32), payload: { version: 1 } }),
    (error) => error.permanent === true && /HTTP 404/.test(error.message));
  assert.equal(await adapter.fetchRecord('c'.repeat(32)), null, 'an unknown record reads as absent');
  instance.failures.push('network');
  await assert.rejects(adapter.fetchRecord(ref), (error) => error.permanent === false);
  assert.equal((await verifyChain(client, { tenantRef: DEFAULT_TENANT })).ok, true);
});

test('the qualification check is offline and never claims a live result', () => {
  const ok = checkServiceNowConfig(CUSTOM_CONFIG, { tenantRef: 'sha256:servicenow-custom', now: new Date('2026-10-04T00:00:00Z'), build: 'test' });
  assert.equal(ok.evidenceLevel, 'fixture-tested');
  assert.equal(ok.synthetic, true);
  assert.equal(ok.gate, 'servicenow-approval-mirror');
  assert.equal(ok.subject.ok, true);
  assert.equal(ok.subject.stateMapping.approved[0], 'gate_passed');
  assert.equal(ok.subject.liveQualified, false);
  assert.equal(ok.docSource.retrievedAt, '2026-10-04');
  const missing = checkServiceNowConfig({ ...CUSTOM_CONFIG, states: { approved: ['gate_passed'] } }, { build: 'test' });
  assert.equal(missing.subject.ok, false);
  assert.deepEqual(missing.subject.problems.map((item) => item.code), ['states-rejected']);
  assert.ok(!JSON.stringify(ok).includes(TOKEN));
});
