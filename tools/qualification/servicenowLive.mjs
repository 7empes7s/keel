#!/usr/bin/env node
/**
 * Roadmap task-118: capture and import ServiceNow non-default workflow live-acceptance
 * evidence. The operator runs this against a NON-PRODUCTION ServiceNow instance that
 * they have declared as such; builders and CI never point it at an instance.
 *
 *   node tools/qualification/servicenowLive.mjs plan --config <adapter config.json> --test-users <users.json>
 *     Offline (the default). Prints the preflight refusals and every step a capture
 *     would take. No network, no database.
 *
 *   KEEL_SERVICENOW_QUALIFICATION_DB_URL=postgres://.../keel_servicenow_qualification \
 *   [KEEL_QUALIFICATION_HMAC_KEY=...] <the env variables the config and users reference> \
 *   node tools/qualification/servicenowLive.mjs capture \
 *        --confirm-non-production-instance <instance host> --declared-by <operator name> \
 *        --config <adapter config.json> --test-users <users.json> --tenant-ref sha256:... \
 *        --docs docs.json --out docs/release/qualifications/servicenow-live-acceptance.json \
 *        [--relay-table u_keel_callback_relay] [--record-template template.json] [--build <sha>]
 *
 * Refusals before anything is sent: the instance host is not the one the operator
 * declared non-production on the command line; the adapter config has a missing
 * mapping, holds a secret value, has no signed callbacks, or is the out-of-the-box
 * change_request approval; fewer than two test users, a test user without its own
 * env: credential reference, or one sharing KEEL's; the KEEL database is the
 * production one (KEEL_DB_URL) or not named as a qualification database. Then the
 * capture reads the instance's glide.installation.production property and refuses an
 * instance that reports itself as production.
 *
 * What a capture does (and nothing else). In a dedicated KEEL qualification database
 * it creates a requester, a portal approver and one approver principal per declared
 * test user, maps each test user to its principal and saves the adapter config. Then,
 * for each of four scenarios, it creates one record in the configured table, opens a
 * KEEL approval request for a placeholder plan (a job is minted in the qualification
 * database only, and nothing runs it), mirrors it through the PRODUCTION task-96/97
 * path, and lets one declared test user decide in the instance under that user's own
 * credential:
 *   callback-duplicate  the instance's signed callback is handed to KEEL twice;
 *   lost-callback       the callback is withheld, KEEL polls twice, then the callback
 *                       arrives late;
 *   conflict            KEEL's portal approver rejects first, then the test user approves;
 *   revoked-approver    the second test user's KEEL grant is revoked, then that user
 *                       approves.
 * Callbacks are signed by the instance itself (ops/servicenow/keel-callback-relay.js, a
 * business rule writing each signed callback into a relay table); the capture reads
 * them back with KEEL's credential and hands them to handleServiceNowCallback exactly
 * as received. KEEL never writes the approval state field; only test users do.
 *
 * Credential values are resolved from env: references at call time and are never
 * written. The record and its capture log carry references only. With
 * KEEL_QUALIFICATION_HMAC_KEY set the record is signed as `keel-release-runner`;
 * without it the record cannot verify.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { grantRole, revokeRole } from '../../engine/authz/administration.mjs';
import {
  SERVICENOW_ADAPTER_NAME, SERVICENOW_SIGNATURE_HEADER, createServiceNowAdapter, defaultResolveSecret, handleServiceNowCallback,
  runServiceNowCycle, saveServiceNowConfig, serviceNowConfigProblems,
} from '../../engine/itsm/adapters/servicenow.mjs';
import { mapExternalIdentity, mirrorApprovalRequest, reconcileRecord } from '../../engine/itsm/bridge.mjs';
import { drainItsmOutbox } from '../../engine/itsm/outbox.mjs';
import { rejectRequest, requestApproval } from '../../engine/govern/approvals.mjs';
import { pseudonymizeCapture } from './pseudonymize.mjs';
import { QUALIFICATION_CONTRACT_VERSION, signEvidence, verifyEvidence } from '../release/qualification.mjs';
import {
  SERVICENOW_LIVE_CREDENTIAL_MODE, SERVICENOW_LIVE_GATE, SERVICENOW_LIVE_OPERATION, SERVICENOW_LIVE_PREREQUISITES,
  SERVICENOW_LIVE_SCENARIOS, SERVICENOW_MIN_TEST_USERS, SERVICENOW_PRODUCTION_PROPERTY, SERVICENOW_RELAY_FIELDS,
  serviceNowWorkflowIsDefault,
} from './servicenowAcceptance.mjs';

export const SERVICENOW_DEFAULT_RELAY_TABLE = 'u_keel_callback_relay';
const CREDENTIAL_REF = /^env:[A-Z_][A-Z0-9_]{0,127}$/;
const SYS_ID = /^[0-9a-f]{32}$/;
const QUALIFICATION_DB_NAME = /(^|_)(qualification|test)(_|$)/;

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');

function hostOf(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Every reason a capture must not start, before anything is sent. Empty means the
 * operator declared this host non-production and the mapping and users are usable.
 */
export function serviceNowCaptureRefusals({ config, testUsers, declaredHost, declaredBy, relayTable = SERVICENOW_DEFAULT_RELAY_TABLE }) {
  const refusals = [];
  const host = hostOf(config?.instanceUrl);
  if (!declaredHost) refusals.push('the instance is not declared non-production: pass --confirm-non-production-instance <host>');
  else if (!host || host !== String(declaredHost).toLowerCase()) refusals.push(`the configured instance '${host ?? 'missing'}' is not the host declared non-production ('${declaredHost}')`);
  if (typeof declaredBy !== 'string' || !declaredBy.trim()) refusals.push('the non-production declaration needs --declared-by <operator name>');
  for (const item of serviceNowConfigProblems(config)) refusals.push(`adapter mapping: ${item.message}`);
  if (config && !config.callback) refusals.push('callbacks must be signed (callback.secretRef) to qualify both directions');
  if (config && serviceNowWorkflowIsDefault({
    table: config.table, fields: config.fields, approvedValues: config.states?.approved, rejectedValues: config.states?.rejected,
  })) refusals.push('the mapping is the out-of-the-box change_request approval; task-118 qualifies a non-default workflow');
  if (typeof relayTable !== 'string' || !/^u_[a-z0-9_]{1,78}$/.test(relayTable)) refusals.push('--relay-table must be a custom (u_) table');
  const users = Array.isArray(testUsers) ? testUsers : [];
  if (users.length < SERVICENOW_MIN_TEST_USERS) refusals.push(`at least ${SERVICENOW_MIN_TEST_USERS} test users are needed`);
  const seen = new Set([config?.credential?.tokenRef, config?.callback?.secretRef]);
  const names = new Set();
  for (const user of users) {
    const keys = Object.keys(user ?? {});
    if (keys.some((key) => !['externalUser', 'credentialRef'].includes(key))) refusals.push('a test user may hold only externalUser and credentialRef (a reference, never a value)');
    if (typeof user?.externalUser !== 'string' || !user.externalUser.trim() || user.externalUser.length > 256) refusals.push('a test user has no external user name');
    else if (names.has(user.externalUser)) refusals.push(`test user ${user.externalUser} is listed twice`);
    names.add(user?.externalUser);
    if (typeof user?.credentialRef !== 'string' || !CREDENTIAL_REF.test(user.credentialRef)) refusals.push(`test user ${user?.externalUser ?? '?'} needs its own env: credential reference`);
    else if (seen.has(user.credentialRef)) refusals.push(`test user ${user.externalUser} shares a credential with KEEL or another test user`);
    seen.add(user?.credentialRef);
  }
  return refusals;
}

/** Refuses a KEEL database that is the production one or not named for qualification. */
export function serviceNowDatabaseRefusals(url, env = process.env) {
  if (!url) return ['KEEL_SERVICENOW_QUALIFICATION_DB_URL is not set'];
  if (env.KEEL_DB_URL && url === env.KEEL_DB_URL) return ['the qualification database must not be the production KEEL database'];
  let name = '';
  try { name = decodeURIComponent(new URL(url).pathname.replace(/^\//, '')); } catch { return ['the qualification database URL is not a URL']; }
  if (!QUALIFICATION_DB_NAME.test(name)) return [`the database '${name}' is not named as a qualification database (…_qualification or …_test)`];
  return [];
}

/** Offline: what a capture would do, in order. */
export function serviceNowCapturePlan({ config, testUsers, relayTable = SERVICENOW_DEFAULT_RELAY_TABLE }) {
  const [first, second] = (testUsers ?? []).map((user) => user?.externalUser);
  const table = config?.table ?? '{table}';
  const state = config?.fields?.state ?? '{state field}';
  const plan = [
    { step: 'preflight', credential: 'keel', method: 'GET', path: `/api/now/table/sys_properties?name=${SERVICENOW_PRODUCTION_PROPERTY}` },
    { step: 'prepare', credential: 'none', action: 'qualification database: requester, portal approver, one approver per test user, identity map, adapter config' },
  ];
  for (const scenario of SERVICENOW_LIVE_SCENARIOS) {
    const actor = scenario === 'revoked-approver' ? second : first;
    plan.push(
      { scenario, credential: 'keel', method: 'POST', path: `/api/now/table/${table}`, action: 'create one record for this scenario' },
      { scenario, credential: 'keel', method: 'PATCH', path: `/api/now/table/${table}/{sys_id}`, action: 'mirror the plan (version, digest, request)' },
      ...(scenario === 'conflict' ? [{ scenario, credential: 'none', action: 'KEEL portal approver rejects; the decision is written back' }] : []),
      ...(scenario === 'revoked-approver' ? [{ scenario, credential: 'none', action: `revoke the KEEL approver grant of ${actor}` }] : []),
      { scenario, credential: actor ?? '{test user}', method: 'PATCH', path: `/api/now/table/${table}/{sys_id}`, action: `set ${state} to an approved value` },
      { scenario, credential: 'keel', method: 'GET', path: `/api/now/table/${relayTable}?${SERVICENOW_RELAY_FIELDS.record}={sys_id}`, action: 'read the signed callback' },
    );
  }
  return plan;
}

/**
 * The instance transport for the harness and the adapter: one fetch per call, the
 * credential resolved from its reference at call time, and every call logged with its
 * actor, credential reference, method, path, record and the field NAMES it wrote,
 * never a header, a value or a token.
 */
function serviceNowLoggedInstance({ config, fetchImpl, resolveSecret, log, now }) {
  const origin = new URL(config.instanceUrl).origin;
  const host = new URL(config.instanceUrl).hostname.toLowerCase();
  const tablePath = /^\/api\/now\/table\/([a-z0-9_]+)(?:\/([0-9a-f]{32}))?$/;
  const entry = (actor, credentialRef, method, url, body, status) => {
    const parsed = new URL(url);
    const match = tablePath.exec(parsed.pathname);
    log.calls.push({
      at: now().toISOString(), host: parsed.hostname.toLowerCase(), actor, credentialRef, method, path: parsed.pathname,
      table: match?.[1] ?? null, sysId: match?.[2] ?? null,
      fields: body && typeof body === 'object' ? Object.keys(body).sort() : [], status,
    });
  };
  /** The fetch the production adapter uses (KEEL's own credential). */
  const adapterFetch = async (url, init = {}) => {
    let status = 0;
    try {
      const response = await fetchImpl(url, init);
      status = response.status;
      return response;
    } finally {
      entry('keel', config.credential.tokenRef, init.method ?? 'GET', url, init.body ? JSON.parse(init.body) : null, status);
    }
  };
  /** One harness call as `actor` under `credentialRef`. Returns { status, body }. */
  const call = async ({ actor, credentialRef, method, path, query = {}, body }) => {
    const url = new URL(path, origin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    let status = 0;
    try {
      const token = await resolveSecret(credentialRef);
      const response = await fetchImpl(url.toString(), {
        method,
        headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15 * 1000),
      });
      status = response.status;
      const parsed = await response.json().catch(() => null);
      return { status, body: parsed };
    } catch {
      return { status, body: null };
    } finally {
      entry(actor, credentialRef, method, url.toString(), body ?? null, status);
    }
  };
  return { host, adapterFetch, call };
}

/** Reads glide.installation.production: 'true', 'false', 'absent' or 'unreadable'. */
async function serviceNowProductionFlag(instance, keelRef) {
  const { status, body } = await instance.call({
    actor: 'keel', credentialRef: keelRef, method: 'GET', path: '/api/now/table/sys_properties',
    query: { sysparm_query: `name=${SERVICENOW_PRODUCTION_PROPERTY}`, sysparm_fields: 'name,value', sysparm_limit: '1' },
  });
  if (status !== 200 || !Array.isArray(body?.result)) return 'unreadable';
  if (body.result.length === 0) return 'absent';
  return String(body.result[0]?.value).trim().toLowerCase() === 'true' ? 'true' : 'false';
}

/**
 * Creates the qualification principals in the KEEL qualification database, maps each
 * test user to its own approver principal and saves the adapter config. Returns the
 * principal ids and each test user's approver grant id.
 */
export async function prepareServiceNowQualification(client, { tenantRef, runId, config, testUsers }) {
  const principal = async (role, label) => {
    const { rows: [row] } = await client.query(
      'INSERT INTO principal (email, display_name) VALUES ($1, $2) RETURNING id',
      [`${label}+${runId}@keel-qualification.invalid`, `KEEL qualification ${label}`],
    );
    const grant = await grantRole(client, { principalId: String(row.id), role, grantedBy: `qualification:${runId}` });
    return { id: String(row.id), grantId: String(grant.id) };
  };
  const admin = await principal('admin', 'admin');
  const requester = await principal('restorer', 'requester');
  const portalApprover = await principal('approver', 'portal-approver');
  const users = [];
  for (const [index, user] of testUsers.entries()) {
    const approver = await principal('approver', `test-user-${index + 1}`);
    await mapExternalIdentity(client, {
      tenantRef, adapter: SERVICENOW_ADAPTER_NAME, externalUser: user.externalUser, principalId: approver.id, requestedBy: admin.id,
    });
    users.push({ externalUser: user.externalUser, credentialRef: user.credentialRef, principalId: approver.id, grantId: approver.grantId });
  }
  await saveServiceNowConfig(client, { tenantRef, config, requestedBy: admin.id });
  return { admin: admin.id, requester: requester.id, portalApprover: portalApprover.id, testUsers: users };
}

/**
 * Runs a capture. `client` is the KEEL qualification database (schema applied);
 * `fetchImpl` reaches the instance; `resolveSecret` resolves env: references. Returns
 * the unsigned record and the capture log, with tenant ids pseudonymized (pseudonymize.mjs); it never signs and never writes files.
 */
export async function captureServiceNowAcceptance({
  client, fetchImpl = globalThis.fetch, resolveSecret = defaultResolveSecret, tenantRef, build, config, testUsers,
  declaredHost, declaredBy, relayTable = SERVICENOW_DEFAULT_RELAY_TABLE, recordTemplate = null, documentation = [],
  runId = `keel-rt-servicenow-${randomUUID()}`, now = () => new Date(), sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  relayAttempts = 20, relayDelayMs = 3 * 1000,
}) {
  const refusals = serviceNowCaptureRefusals({ config, testUsers, declaredHost, declaredBy, relayTable });
  if (typeof tenantRef !== 'string' || !tenantRef) refusals.push('--tenant-ref is required');
  if (typeof build !== 'string' || !build) refusals.push('--build is required');
  if (refusals.length) throw new Error(`refused: ${refusals.join('; ')}`);
  const declaredAt = now().toISOString();

  const log = { runId, calls: [], callbacks: [] };
  const instance = serviceNowLoggedInstance({ config, fetchImpl, resolveSecret, log, now });
  const keelRef = config.credential.tokenRef;
  const productionFlag = await serviceNowProductionFlag(instance, keelRef);
  if (productionFlag === 'true') throw new Error(`refused: the instance reports ${SERVICENOW_PRODUCTION_PROPERTY}=true`);

  const prepared = await prepareServiceNowQualification(client, { tenantRef, runId, config, testUsers });
  const adapter = createServiceNowAdapter({ config, fetchImpl: instance.adapterFetch, resolveSecret });
  const { fields } = config;
  const approvedValue = config.states.approved[0];
  const cycle = () => runServiceNowCycle(client, { tenantRef, fetchImpl: instance.adapterFetch, resolveSecret });

  const scenarios = [];
  for (const name of SERVICENOW_LIVE_SCENARIOS) {
    const user = name === 'revoked-approver' ? prepared.testUsers[1] : prepared.testUsers[0];
    const steps = [];
    const step = (action, detail = {}) => { steps.push({ at: now().toISOString(), action, ...detail }); };

    // One record per scenario, created by KEEL's credential in the configured table.
    const created = await instance.call({
      actor: 'keel', credentialRef: keelRef, method: 'POST', path: `/api/now/table/${config.table}`,
      body: recordTemplate ?? { short_description: `KEEL qualification ${runId} ${name}` },
    });
    const sysId = created.body?.result?.sys_id;
    if (created.status !== 201 && created.status !== 200) throw new Error(`creating the ${name} record returned HTTP ${created.status}`);
    if (typeof sysId !== 'string' || !SYS_ID.test(sysId)) throw new Error(`creating the ${name} record returned no sys_id`);

    const request = await requestApproval(client, {
      tenantRef, action: 'remediate', params: { driftIds: [`keel-qualification-${runId}-${name}`] },
      requestedBy: prepared.requester, justification: `ServiceNow qualification ${runId} (${name}); placeholder plan, nothing runs`,
    });
    const record = await mirrorApprovalRequest(client, {
      tenantRef, adapter: SERVICENOW_ADAPTER_NAME, externalRef: sysId, requestId: request.id, requestedBy: prepared.admin,
    });
    step('mirror', { outcome: 'mirrored', recordId: String(record.id), requestId: String(request.id) });
    const outbound = await drainItsmOutbox(client, { tenantRef, adapter, now: new Date() });
    step('outbound-record', { direction: 'keel-to-servicenow', outcome: outbound.delivered >= 1 && !outbound.quarantined ? 'delivered' : 'not-delivered', ...outbound });
    const read = await adapter.fetchRecord(sysId);
    step('readback-record', {
      direction: 'servicenow-to-keel',
      outcome: read && read.version === record.version && read.planDigest === record.plan_digest ? 'match' : 'mismatch',
    });

    if (name === 'conflict') {
      await rejectRequest(client, {
        tenantRef, id: request.id, decidedBy: prepared.portalApprover, reason: `qualification ${runId}: KEEL decides first`,
      });
      step('portal-decision', { outcome: 'rejected', actor: prepared.portalApprover });
      const out = await cycle();
      step('outbound-decision', { direction: 'keel-to-servicenow', outcome: out.delivered >= 1 ? 'delivered' : 'not-delivered' });
    }
    if (name === 'revoked-approver') {
      await revokeRole(client, { principalId: user.principalId, grantId: user.grantId, revokedBy: prepared.admin });
      step('revoke-grant', { outcome: 'revoked', principalId: user.principalId });
    }

    // The test user decides in the instance, under that user's own credential.
    const decided = await instance.call({
      actor: user.externalUser, credentialRef: user.credentialRef, method: 'PATCH',
      path: `/api/now/table/${config.table}/${sysId}`, body: { [fields.state]: approvedValue },
    });
    if (decided.status !== 200) throw new Error(`test user ${user.externalUser} could not set ${fields.state} (HTTP ${decided.status})`);
    step('decide', { direction: 'servicenow', actor: user.externalUser, value: approvedValue });

    // The instance-signed callback for that decision, read from the relay table.
    let callback = null;
    for (let attempt = 1; attempt <= relayAttempts && !callback; attempt += 1) {
      const { status, body } = await instance.call({
        actor: 'keel', credentialRef: keelRef, method: 'GET', path: `/api/now/table/${relayTable}`,
        query: {
          sysparm_query: `${SERVICENOW_RELAY_FIELDS.record}=${sysId}^ORDERBYDESCsys_created_on`,
          sysparm_fields: ['sys_id', ...Object.values(SERVICENOW_RELAY_FIELDS)].join(','),
          sysparm_display_value: 'false',
        },
      });
      const rows = status === 200 && Array.isArray(body?.result) ? body.result : [];
      callback = rows.map((row) => {
        try {
          const parsed = JSON.parse(row[SERVICENOW_RELAY_FIELDS.body]);
          return parsed?.sys_id === sysId && parsed?.record?.[fields.state] === approvedValue
            ? { rawBody: row[SERVICENOW_RELAY_FIELDS.body], signature: row[SERVICENOW_RELAY_FIELDS.signature], modCount: Number(parsed.sys_mod_count) }
            : null;
        } catch {
          return null;
        }
      }).filter(Boolean).sort((a, b) => b.modCount - a.modCount)[0] ?? null;
      if (!callback && attempt < relayAttempts) await sleep(relayDelayMs);
    }
    if (!callback) throw new Error(`no signed callback reached ${relayTable} for the ${name} decision`);
    const deliver = async (label) => {
      log.callbacks.push({ at: now().toISOString(), scenario: name, delivery: label, sysId, bodySha256: sha256Hex(callback.rawBody) });
      const result = await handleServiceNowCallback(client, {
        tenantRef, adapter, headers: { [SERVICENOW_SIGNATURE_HEADER]: callback.signature }, rawBody: callback.rawBody,
      });
      step('callback', {
        direction: 'servicenow-to-keel', outcome: result.outcome, duplicate: Boolean(result.duplicate),
        eventId: `servicenow:${sysId}:${callback.modCount}`, delivery: label,
      });
      return result;
    };

    if (name === 'callback-duplicate') {
      await deliver('first');
      await deliver('redelivered');
      const out = await cycle();
      step('outbound-decision', { direction: 'keel-to-servicenow', outcome: out.delivered >= 1 ? 'delivered' : 'not-delivered' });
    } else if (name === 'lost-callback') {
      step('callback-withheld', { eventId: `servicenow:${sysId}:${callback.modCount}` });
      const polled = await cycle();
      const first = polled.reconciled?.applied === 1 ? 'applied' : Object.keys(polled.reconciled ?? {})[0] ?? 'none';
      step('poll', { direction: 'servicenow-to-keel', outcome: first, duplicate: false });
      const again = await reconcileRecord(client, { tenantRef, adapter, externalRef: sysId });
      step('poll', { direction: 'servicenow-to-keel', outcome: again.outcome, duplicate: Boolean(again.duplicate) });
      await deliver('late');
      const out = await cycle();
      step('outbound-decision', { direction: 'keel-to-servicenow', outcome: out.delivered >= 1 ? 'delivered' : 'not-delivered' });
    } else if (name === 'conflict') {
      await deliver('first');
      const out = await cycle();
      step('outbound-conflict', { direction: 'keel-to-servicenow', outcome: out.delivered >= 1 ? 'delivered' : 'not-delivered' });
    } else {
      await deliver('first');
    }

    // The canonical result in KEEL and the record as the instance shows it now.
    const { rows: [current] } = await client.query('SELECT status, decided_by FROM approval_request WHERE id = $1', [request.id]);
    const { rows: [{ jobs }] } = await client.query('SELECT count(*)::int AS jobs FROM job WHERE idempotency_key = $1', [`approval:${request.id}`]);
    const { rows: decisions } = await client.query(
      'SELECT outcome, source, version, decided_by, external_event_id, decision_digest FROM itsm_decision WHERE record_id = $1 ORDER BY version, recorded_at',
      [record.id],
    );
    const roles = ['state', 'approver', 'planVersion', 'planDigest', 'keelRequest', 'keelDecision'];
    const after = await instance.call({
      actor: 'keel', credentialRef: keelRef, method: 'GET', path: `/api/now/table/${config.table}/${sysId}`,
      query: { sysparm_fields: roles.map((role) => fields[role]).join(','), sysparm_display_value: 'false', sysparm_exclude_reference_link: 'true' },
    });
    scenarios.push({
      name, tenantRef, sysId, requestId: String(request.id), recordId: String(record.id), version: record.version, planDigest: record.plan_digest,
      steps,
      canonical: {
        requestStatus: current.status, decidedBy: current.decided_by ?? null, jobs,
        decisions: decisions.map((row) => ({
          outcome: row.outcome, source: row.source, version: row.version, decidedBy: row.decided_by,
          externalEventId: row.external_event_id, decisionDigest: row.decision_digest,
        })),
      },
      instanceAfter: Object.fromEntries(roles.map((role) => [role, after.body?.result?.[fields[role]] ?? null])),
    });
  }

  const captureLog = `${JSON.stringify(log, null, 2)}\n`;
  const host = hostOf(config.instanceUrl);
  const record = {
    contractVersion: QUALIFICATION_CONTRACT_VERSION,
    gate: SERVICENOW_LIVE_GATE,
    tenantRef,
    build,
    operation: SERVICENOW_LIVE_OPERATION,
    credentialMode: SERVICENOW_LIVE_CREDENTIAL_MODE,
    observedAt: now().toISOString(),
    evidenceLevel: 'live-qualified',
    synthetic: false,
    subject: {
      adapter: SERVICENOW_ADAPTER_NAME,
      prerequisites: [...SERVICENOW_LIVE_PREREQUISITES],
      runId,
      instance: { host, declaredNonProduction: { host: String(declaredHost).toLowerCase(), declaredBy, declaredAt }, productionFlag },
      workflow: {
        table: config.table, fields: { ...config.fields }, approvedValues: [...config.states.approved], rejectedValues: [...config.states.rejected],
        callbackWindowSeconds: config.callback.maxSkewSeconds ?? 300, relayTable, isDefault: false,
      },
      credentials: { keel: keelRef, callbackSigning: config.callback.secretRef },
      testUsers: prepared.testUsers.map(({ externalUser, credentialRef, principalId }) => ({ externalUser, credentialRef, principalId })),
      keelPrincipals: { requester: prepared.requester, portalApprover: prepared.portalApprover },
      scenarios,
      documentation,
      captureLogSha256: sha256Hex(captureLog),
    },
  };
  return pseudonymizeCapture({ record, log });
}

/**
 * Writes the record and its capture log side by side, binding the log's digest as
 * the artifact proof, and signs the record when a runner key is given.
 */
export function writeServiceNowAcceptanceFiles({ record, captureLog, outPath, hmacKey = null }) {
  const logPath = outPath.replace(/\.json$/, '') + '.capture.json';
  writeFileSync(logPath, captureLog);
  let evidence = { ...record, proof: { artifact: { path: basename(logPath), sha256: sha256Hex(captureLog) } } };
  if (hmacKey) evidence = signEvidence(evidence, hmacKey, 'keel-release-runner');
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  return { evidence, logPath };
}

/**
 * The import seam: a record that passes the gate with --require-live becomes one
 * live-qualified claim for this tenant's ServiceNow workflow mapping at this build.
 * Anything else becomes nothing. Nothing in production consumes it yet.
 */
export function serviceNowQualificationFromAcceptance(evidence, options = {}) {
  const result = verifyEvidence(evidence, { ...options, gate: SERVICENOW_LIVE_GATE, requireLive: true });
  if (!result.ok) return { ok: false, failures: result.failures, claim: null };
  const { subject } = evidence;
  return {
    ok: true,
    failures: [],
    claim: {
      adapter: SERVICENOW_ADAPTER_NAME, state: 'live-qualified', tenantRef: evidence.tenantRef, build: evidence.build,
      instanceHost: subject.instance.host, table: subject.workflow.table, stateField: subject.workflow.fields.state,
      approvedValues: [...subject.workflow.approvedValues], rejectedValues: [...subject.workflow.rejectedValues],
      scenarios: subject.scenarios.map((scenario) => scenario.name), observedAt: evidence.observedAt,
      proofRef: `${SERVICENOW_LIVE_GATE}@${subject.captureLogSha256}`,
    },
  };
}

function parseServiceNowArgs(argv) {
  const [command = 'plan', ...rest] = argv;
  const options = { command };
  const names = {
    '--confirm-non-production-instance': 'declaredHost', '--declared-by': 'declaredBy', '--config': 'config',
    '--test-users': 'testUsers', '--tenant-ref': 'tenantRef', '--docs': 'docs', '--out': 'out', '--build': 'build',
    '--relay-table': 'relayTable', '--record-template': 'recordTemplate',
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!names[arg]) throw new Error(`unknown argument: ${arg}`);
    options[names[arg]] = rest[++index];
  }
  return options;
}

export async function main(argv = process.argv.slice(2), {
  out = console.log, env = process.env, fetchImpl = globalThis.fetch, readFile = (path) => readFileSync(path, 'utf8'),
  connect = async (url) => (await import('../../engine/store/db.mjs')).connect(url),
} = {}) {
  const options = parseServiceNowArgs(argv);
  if (!['plan', 'capture'].includes(options.command)) throw new Error('usage: servicenowLive.mjs plan|capture ...');
  const config = options.config ? JSON.parse(readFile(options.config)) : null;
  const testUsers = options.testUsers ? JSON.parse(readFile(options.testUsers)) : [];
  const relayTable = options.relayTable ?? SERVICENOW_DEFAULT_RELAY_TABLE;
  const refusals = serviceNowCaptureRefusals({ config, testUsers, declaredHost: options.declaredHost, declaredBy: options.declaredBy, relayTable });
  if (options.command === 'plan') {
    out(JSON.stringify({ refusals, plan: serviceNowCapturePlan({ config, testUsers, relayTable }) }, null, 2));
    return 0;
  }
  const dbUrl = env.KEEL_SERVICENOW_QUALIFICATION_DB_URL;
  refusals.push(...serviceNowDatabaseRefusals(dbUrl, env));
  for (const [flag, key] of [['--tenant-ref', 'tenantRef'], ['--docs', 'docs'], ['--out', 'out']]) {
    if (!options[key]) refusals.push(`capture needs ${flag}`);
  }
  const build = options.build ?? env.KEEL_QUALIFICATION_BUILD;
  if (!build) refusals.push('capture needs --build (or KEEL_QUALIFICATION_BUILD): the build this capture qualifies');
  if (refusals.length) {
    out(JSON.stringify({ refused: refusals }, null, 2));
    return 2;
  }
  const outPath = resolve(options.out);
  const client = await connect(dbUrl);
  let record;
  let captureLog;
  try {
    await client.query(readFileSync(new URL('../../engine/store/schema.sql', import.meta.url), 'utf8'));
    ({ record, captureLog } = await captureServiceNowAcceptance({
      client, fetchImpl, tenantRef: options.tenantRef, build, config, testUsers,
      declaredHost: options.declaredHost, declaredBy: options.declaredBy, relayTable,
      recordTemplate: options.recordTemplate ? JSON.parse(readFile(options.recordTemplate)) : null,
      documentation: JSON.parse(readFile(options.docs)),
    }));
  } finally {
    await client.end();
  }
  const { evidence, logPath } = writeServiceNowAcceptanceFiles({ record, captureLog, outPath, hmacKey: env.KEEL_QUALIFICATION_HMAC_KEY ?? null });
  const result = verifyEvidence(evidence, {
    gate: SERVICENOW_LIVE_GATE, tenantRef: options.tenantRef, build, requireLive: true, evidenceDir: dirname(outPath),
    hmacKey: env.KEEL_QUALIFICATION_HMAC_KEY ?? null,
  });
  out(JSON.stringify({
    evidence: outPath, captureLog: logPath,
    scenarios: record.subject.scenarios.map((scenario) => ({ name: scenario.name, steps: scenario.steps.map((item) => `${item.action}:${item.outcome ?? ''}`) })),
    verify: result,
  }, null, 2));
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 2; });
}
