// engine/itsm/adapters/servicenow.mjs
//
// Roadmap task-97 (WS8): the ServiceNow adapter for the task-96 canonical approval
// mirror (../bridge.mjs, ../outbox.mjs). KEEL keeps the one canonical decision; a
// ServiceNow record is a mirror of it, and its approval state is only a REQUEST that
// KEEL decide, never authority on its own.
//
// API contract implemented (Global Constraint 8):
//   Source:     https://www.servicenow.com/docs/r/api-reference/rest-apis/c_TableAPI.html
//   Retrieved:  2026-10-04, from the search index only: the page itself is blocked by this
//               build environment's egress proxy, so nothing beyond the points below was
//               verified, and nothing here is proven against an instance (task-118).
//   Read:       GET   {instance}/api/now/table/{table}/{sys_id}
//                     ?sysparm_fields=a,b.c&sysparm_display_value=false
//                     &sysparm_exclude_reference_link=true
//               200 with { result: { field: value } } (dot-walked fields keep their dotted
//               key); 404 when no record has that sys_id.
//   Write:      PATCH {instance}/api/now/table/{table}/{sys_id}, a partial update of the
//               fields in the JSON body.
//   Auth:       OAuth bearer token, referenced by credential.tokenRef (env:NAME). The
//               token never enters config, the outbox, errors or evidence.
//   Callback:   ServiceNow does not sign outbound REST messages. The instance side (a
//               business rule or flow, built in task-118) signs the body with
//               GlideCertificateEncryption.generateMac(key, 'HmacSHA256', data), which
//               returns base64, and sends header
//               x-keel-servicenow-signature: t=<unix seconds>,v1=<base64 HMAC-SHA256 of "t.body">.
//
// Rules:
//
// 1. EVERY MAPPING IS EXPLICIT. The table, the field that carries the approval state,
//    the state values that mean approved and rejected, the field that names the
//    approver, and the fields KEEL writes the plan version, digest and decision into are
//    all configuration. Nothing defaults to the out-of-the-box change_request workflow.
//    A missing or ambiguous mapping disables the adapter and names what is missing
//    (serviceNowConfigProblems); a disabled adapter neither sends nor reads.
// 2. A CALLBACK IS AUTHENTICATED AND THEN CONFIRMED. An unsigned callback, a bad
//    signature or a timestamp outside the window is refused before the bridge sees it.
//    A signed callback is then re-read from the instance with KEEL's own credential; it
//    acts only if the instance shows the same state, approver, version and digest. Its
//    event id is servicenow:<sys_id>:<sys_mod_count>, so a replay inside the window is a
//    duplicate in the bridge's inbox and acts no further.
// 3. AUTHORITY STAYS IN KEEL. Whatever the record says, receiveCallback decides only for
//    the record's current version and digest, through a mapped, enabled principal who is
//    an eligible approver now (task-96).
// 4. A FAILED UPDATE IS NEVER LOST OR SILENT. deliver() throws on every failure, so the
//    outbox keeps the event pending and retries it (a network error, a timeout, 401,
//    408, 429, 5xx) or quarantines it with its reason (400, 403, 404, 422). The canonical
//    decision is never rolled back, and held-back updates are shown on the integrations page.
// 5. KEEL never writes the approval state field: it writes only the plan version, plan
//    digest, request and decision fields, so its own writes cannot be read back as an
//    approval.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { can } from '../../authz/can.mjs';
import { findPrincipalById } from '../../authz/principals.mjs';
import { appendEvidence } from '../../govern/evidence.mjs';
import { ITSM_CALLBACK_EVIDENCE_KIND, receiveCallback, reconcileRecord, runMirrorCycle } from '../bridge.mjs';

export const SERVICENOW_ADAPTER_NAME = 'servicenow';
export const SERVICENOW_CONFIG_EVIDENCE_KIND = 'itsm-adapter-config';
export const SERVICENOW_SIGNATURE_HEADER = 'x-keel-servicenow-signature';
export const SERVICENOW_DEFAULT_TIMEOUT_MS = 10 * 1000;
export const SERVICENOW_MAX_SKEW_SECONDS = 900;
export const SERVICENOW_DOC_SOURCE = Object.freeze({
  url: 'https://www.servicenow.com/docs/r/api-reference/rest-apis/c_TableAPI.html',
  retrievedAt: '2026-10-04',
  retrieval: 'search index only; the page was blocked by the build egress proxy',
  api: 'REST Table API (GET and PATCH /api/now/table/{table}/{sys_id})',
  credentialMode: 'oauth-bearer-token-reference',
  callbackSigning: 'GlideCertificateEncryption.generateMac HmacSHA256 (base64), instance-side, built in task-118',
});

// The fields KEEL reads and writes, each mapped explicitly to a ServiceNow field.
export const SERVICENOW_FIELD_ROLES = Object.freeze({
  state: 'the field whose value is the approval state',
  approver: 'the person who decided (a field of the table or a dot-walked reference field)',
  planVersion: 'the field KEEL writes the plan version into',
  planDigest: 'the field KEEL writes the plan digest into',
  keelRequest: 'the field KEEL writes its approval request id into',
  keelDecision: 'the field KEEL writes its canonical decision into',
});
const READ_ROLES = ['state', 'approver', 'planVersion', 'planDigest'];
const WRITE_ROLES = ['planVersion', 'planDigest', 'keelRequest', 'keelDecision'];

const TABLE_NAME = /^[a-z][a-z0-9_]{0,79}$/;
const FIELD_PATH = /^[a-z][a-z0-9_]{0,79}(\.[a-z][a-z0-9_]{0,79}){0,3}$/;
const SYS_ID = /^[0-9a-f]{32}$/;
const CREDENTIAL_REF = /^env:[A-Z_][A-Z0-9_]{0,127}$/;
const STATE_VALUE = /^[^\s,][^,]{0,79}$/;
const SECRET_VALUE_PATTERNS = [
  /Bearer\s+\S{8,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /:\/\/[^\s/:@]+:[^\s/@]+@/,
];
const CONFIG_KEYS = new Set(['instanceUrl', 'table', 'credential', 'fields', 'states', 'callback']);

/** A refused adapter operation. `code`: disabled, invalid, not-authorized. */
export class ServiceNowAdapterError extends Error {
  constructor(code, message, problems = []) {
    super(message);
    this.code = code;
    this.problems = problems;
  }
}

/** A refused inbound callback, before the bridge saw it. `code`: callbacks-off,
 * unsigned, bad-signature, stale-timestamp, malformed, instance-mismatch, unknown-record. */
export class ServiceNowCallbackError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function problem(code, message) {
  return { code, message };
}

function secretShaped(value) {
  if (typeof value === 'string') return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
  if (Array.isArray(value)) return value.some(secretShaped);
  if (isObject(value)) return Object.values(value).some(secretShaped);
  return false;
}

/**
 * Every reason the adapter cannot run with this config, as { code, message }. An empty
 * list means every mapping is present and unambiguous. Nothing is defaulted.
 */
export function serviceNowConfigProblems(config) {
  if (!isObject(config)) return [problem('not-configured', 'ServiceNow is not set up.')];
  const problems = [];
  let url = null;
  try {
    url = new URL(String(config.instanceUrl ?? ''));
  } catch {
    url = null;
  }
  if (!url || url.protocol !== 'https:' || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search) {
    problems.push(problem('instance-url', 'The instance address is missing or is not a plain https address.'));
  }
  if (typeof config.table !== 'string' || !TABLE_NAME.test(config.table)) {
    problems.push(problem('table', 'The ServiceNow table holding the change records is not set.'));
  }
  if (!isObject(config.credential) || typeof config.credential.tokenRef !== 'string' || !CREDENTIAL_REF.test(config.credential.tokenRef)) {
    problems.push(problem('credential', 'The name of the stored ServiceNow access token is not set.'));
  }
  const fields = isObject(config.fields) ? config.fields : {};
  for (const role of Object.keys(SERVICENOW_FIELD_ROLES)) {
    if (typeof fields[role] !== 'string' || !FIELD_PATH.test(fields[role])) {
      problems.push(problem(`field-${role}`, `No field is mapped for ${SERVICENOW_FIELD_ROLES[role]}.`));
    }
  }
  for (const role of WRITE_ROLES) {
    if (typeof fields[role] === 'string' && fields[role].includes('.')) {
      problems.push(problem(`field-${role}`, `The field for ${SERVICENOW_FIELD_ROLES[role]} must be a field of the table itself.`));
    }
  }
  const mapped = Object.keys(SERVICENOW_FIELD_ROLES).map((role) => fields[role]).filter((value) => typeof value === 'string');
  if (new Set(mapped).size !== mapped.length) {
    problems.push(problem('field-overlap', 'Two roles are mapped to the same ServiceNow field.'));
  }
  const states = isObject(config.states) ? config.states : {};
  for (const outcome of ['approved', 'rejected']) {
    const values = states[outcome];
    if (!Array.isArray(values) || values.length === 0 || !values.every((value) => typeof value === 'string' && STATE_VALUE.test(value))) {
      problems.push(problem(`states-${outcome}`, `No state value is mapped to ${outcome}.`));
    }
  }
  if (Array.isArray(states.approved) && Array.isArray(states.rejected)
    && states.approved.some((value) => states.rejected.includes(value))) {
    problems.push(problem('states-overlap', 'A state value is mapped to both approved and rejected.'));
  }
  if (config.callback !== undefined && config.callback !== null) {
    const callback = config.callback;
    if (!isObject(callback) || typeof callback.secretRef !== 'string' || !CREDENTIAL_REF.test(callback.secretRef)) {
      problems.push(problem('callback-secret', 'Callbacks are on but the name of the stored signing secret is not set.'));
    } else if (callback.maxSkewSeconds !== undefined
      && !(Number.isInteger(callback.maxSkewSeconds) && callback.maxSkewSeconds >= 30 && callback.maxSkewSeconds <= SERVICENOW_MAX_SKEW_SECONDS)) {
      problems.push(problem('callback-window', `The callback time window must be between 30 and ${SERVICENOW_MAX_SKEW_SECONDS} seconds.`));
    }
  }
  return problems;
}

/** Refuses config that holds a secret value or a key the adapter does not know. */
function assertStorableConfig(config) {
  if (!isObject(config)) throw new ServiceNowAdapterError('invalid', 'the ServiceNow config must be an object');
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new ServiceNowAdapterError('invalid', `unknown ServiceNow config key: ${key}`);
  }
  if (secretShaped(config)) throw new ServiceNowAdapterError('invalid', 'the ServiceNow config must hold credential references, not secret values');
  for (const [path, value] of [['credential.tokenRef', config.credential?.tokenRef], ['callback.secretRef', config.callback?.secretRef]]) {
    if (value !== undefined && value !== null && (typeof value !== 'string' || !CREDENTIAL_REF.test(value))) {
      throw new ServiceNowAdapterError('invalid', `${path} must be a credential reference such as env:KEEL_SERVICENOW_TOKEN`);
    }
  }
  if (isObject(config.credential) && Object.keys(config.credential).some((key) => key !== 'tokenRef')) {
    throw new ServiceNowAdapterError('invalid', 'credential may only hold tokenRef');
  }
  if (isObject(config.callback) && Object.keys(config.callback).some((key) => !['secretRef', 'maxSkewSeconds'].includes(key))) {
    throw new ServiceNowAdapterError('invalid', 'callback may only hold secretRef and maxSkewSeconds');
  }
}

/** The env:NAME resolver. An unresolvable reference is a visible error, never a fallback. */
export function defaultResolveSecret(reference) {
  if (typeof reference === 'string' && CREDENTIAL_REF.test(reference)) {
    const value = process.env[reference.slice('env:'.length)];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  throw new Error(`unresolved credential reference: ${String(reference)}`);
}

/** Maps a raw state value through the configured map only. Any value that is not
 * mapped is informational, so the bridge ignores it. */
export function canonicalStatus(config, value) {
  const raw = value === null || value === undefined ? '' : String(value);
  if (config.states.approved.includes(raw)) return 'approved';
  if (config.states.rejected.includes(raw)) return 'rejected';
  return `servicenow:${raw}`.slice(0, 64);
}

function transient(message) {
  return Object.assign(new Error(message), { permanent: false });
}

function permanent(message) {
  return Object.assign(new Error(message), { permanent: true });
}

const PERMANENT_STATUSES = new Set([400, 403, 404, 405, 409, 413, 422]);

/**
 * Builds the adapter from a stored config. Refuses (code 'disabled') when any mapping is
 * missing, so a half-configured adapter can never send or read. `fetchImpl` and
 * `resolveSecret` are injected by the boundary tests; nothing here contacts ServiceNow
 * unless a caller passes a real transport.
 */
export function createServiceNowAdapter({
  config, fetchImpl = globalThis.fetch, resolveSecret = defaultResolveSecret, timeoutMs = SERVICENOW_DEFAULT_TIMEOUT_MS,
} = {}) {
  const problems = serviceNowConfigProblems(config);
  if (problems.length > 0) {
    throw new ServiceNowAdapterError('disabled', `ServiceNow is off: ${problems.map((item) => item.message).join(' ')}`, problems);
  }
  if (typeof fetchImpl !== 'function') throw new ServiceNowAdapterError('invalid', 'a fetch implementation is required');
  const base = new URL(config.instanceUrl).origin;
  const { fields } = config;
  const readFields = [...new Set([...READ_ROLES.map((role) => fields[role]), 'sys_id', 'sys_mod_count'])];

  function recordUrl(sysId, query = '') {
    if (typeof sysId !== 'string' || !SYS_ID.test(sysId)) throw permanent('the external reference is not a ServiceNow sys_id');
    return `${base}/api/now/table/${config.table}/${sysId}${query}`;
  }

  async function call(method, url, body) {
    const token = await resolveSecret(config.credential.tokenRef);
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      // A network error or timeout: the outcome is unknown, so the event stays pending.
      throw transient(`ServiceNow ${method} did not complete: ${cause?.name === 'TimeoutError' ? 'timed out' : 'network error'}`);
    }
    return response;
  }

  function failure(method, response) {
    const message = `ServiceNow ${method} returned HTTP ${response.status}`;
    return PERMANENT_STATUSES.has(response.status) ? permanent(message) : transient(message);
  }

  /** The record as KEEL reads it, mapped through the config; null when it does not exist. */
  async function readRecord(sysId) {
    const query = `?sysparm_fields=${encodeURIComponent(readFields.join(','))}`
      + '&sysparm_display_value=false&sysparm_exclude_reference_link=true';
    const response = await call('GET', recordUrl(sysId, query));
    if (response.status === 404) return null;
    if (!response.ok) throw failure('GET', response);
    const body = await response.json().catch(() => null);
    if (!isObject(body?.result)) throw transient('ServiceNow GET returned no record');
    return body.result;
  }

  function normalize(result) {
    const version = Number.parseInt(String(result[fields.planVersion] ?? ''), 10);
    const approver = result[fields.approver];
    const digest = result[fields.planDigest];
    return {
      status: canonicalStatus(config, result[fields.state]),
      externalUser: typeof approver === 'string' && approver.length > 0 ? approver : null,
      version: Number.isInteger(version) ? version : null,
      planDigest: typeof digest === 'string' && digest.length > 0 ? digest : null,
    };
  }

  function writeBody(event) {
    const payload = event.payload ?? {};
    if (event.kind === 'record') {
      return {
        [fields.planVersion]: String(payload.version),
        [fields.planDigest]: String(payload.planDigest),
        [fields.keelRequest]: String(payload.requestId),
      };
    }
    if (event.kind === 'decision') {
      const outcome = payload.decision?.outcome;
      return { [fields.keelDecision]: `KEEL decision: ${outcome}; digest ${payload.decisionDigest}; event ${event.eventId}` };
    }
    if (event.kind === 'conflict') {
      return {
        [fields.keelDecision]: `KEEL decision: ${payload.canonicalOutcome} (ServiceNow said ${payload.externalStatus}; KEEL's decision stands); digest ${payload.decisionDigest ?? 'none'}; event ${event.eventId}`,
      };
    }
    throw permanent(`unknown outbound event kind: ${String(event.kind)}`);
  }

  return Object.freeze({
    name: SERVICENOW_ADAPTER_NAME,
    config,
    readFields,

    /** One outbox event to the record. Throws on every failure (rule 4). PATCH sets the
     * same values on a redelivery, so at-least-once delivery is idempotent. */
    async deliver(event) {
      const body = writeBody(event);
      const response = await call('PATCH', recordUrl(event.externalRef), body);
      if (!response.ok) throw failure('PATCH', response);
    },

    /** The record's current state for reconciliation, or null when it does not exist. */
    async fetchRecord(externalRef) {
      const result = await readRecord(externalRef);
      return result ? normalize(result) : null;
    },

    /**
     * Authenticates one inbound callback and normalizes it. Throws ServiceNowCallbackError
     * for an unsigned, wrongly signed, out-of-window or malformed callback.
     * Returns { sysId, modCount, event } where event is the bridge's normalized shape.
     */
    async verifyCallback({ headers, rawBody, now = new Date() }) {
      if (!isObject(config.callback)) throw new ServiceNowCallbackError('callbacks-off', 'callbacks are not set up; KEEL polls instead');
      const header = typeof headers?.get === 'function' ? headers.get(SERVICENOW_SIGNATURE_HEADER) : headers?.[SERVICENOW_SIGNATURE_HEADER];
      if (typeof header !== 'string' || header.length === 0) throw new ServiceNowCallbackError('unsigned', 'the callback is not signed');
      if (typeof rawBody !== 'string') throw new ServiceNowCallbackError('malformed', 'the callback body must be the raw request text');
      const parts = Object.fromEntries(header.split(',').map((part) => {
        const index = part.indexOf('=');
        return index > 0 ? [part.slice(0, index).trim(), part.slice(index + 1).trim()] : ['', ''];
      }));
      if (!/^\d{1,12}$/.test(parts.t ?? '') || typeof parts.v1 !== 'string' || parts.v1.length === 0) {
        throw new ServiceNowCallbackError('unsigned', 'the callback signature header is incomplete');
      }
      const secret = await resolveSecret(config.callback.secretRef);
      const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest();
      const given = Buffer.from(parts.v1, 'base64');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        throw new ServiceNowCallbackError('bad-signature', 'the callback signature does not match');
      }
      const window = config.callback.maxSkewSeconds ?? 300;
      if (Math.abs(Math.floor(now.getTime() / 1000) - Number(parts.t)) > window) {
        throw new ServiceNowCallbackError('stale-timestamp', 'the callback is outside the accepted time window');
      }
      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        throw new ServiceNowCallbackError('malformed', 'the callback body is not JSON');
      }
      const sysId = body?.sys_id;
      const modCount = Number.parseInt(String(body?.sys_mod_count ?? ''), 10);
      if (typeof sysId !== 'string' || !SYS_ID.test(sysId) || !Number.isInteger(modCount) || modCount < 0 || !isObject(body.record)) {
        throw new ServiceNowCallbackError('malformed', 'the callback needs sys_id, sys_mod_count and record');
      }
      const state = normalize(body.record);
      return {
        sysId, modCount,
        event: {
          eventId: `servicenow:${sysId}:${modCount}`, externalRef: sysId, ...state,
          reason: typeof body.reason === 'string' ? body.reason : null,
        },
      };
    },
  });
}

async function requireCapability(client, principalId, capability) {
  const principal = principalId ? await findPrincipalById(client, String(principalId)) : null;
  if (!principal || !(await can(client, principal, capability, new Date()))) {
    throw new ServiceNowAdapterError('not-authorized', `requires the ${capability} capability`);
  }
  return principal;
}

async function storedConfig(client, tenantRef) {
  const { rows: [row] } = await client.query(
    'SELECT * FROM itsm_adapter_config WHERE tenant_ref = $1 AND adapter = $2',
    [tenantRef, SERVICENOW_ADAPTER_NAME],
  );
  return row ?? null;
}

/**
 * Stores the tenant's ServiceNow config (configuration capability). An incomplete config
 * is stored, so the operator sees what is missing, and leaves the adapter off. A config
 * holding a secret value is refused. Returns { config, problems }.
 */
export async function saveServiceNowConfig(client, { tenantRef, config, requestedBy }) {
  await requireCapability(client, requestedBy, 'configuration');
  assertStorableConfig(config);
  const problems = serviceNowConfigProblems(config);
  await client.query(
    `INSERT INTO itsm_adapter_config (tenant_ref, adapter, config, updated_by)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_ref, adapter)
     DO UPDATE SET config = EXCLUDED.config, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [tenantRef, SERVICENOW_ADAPTER_NAME, JSON.stringify(config), String(requestedBy)],
  );
  await appendEvidence(client, {
    tenantRef,
    kind: SERVICENOW_CONFIG_EVIDENCE_KIND,
    subject: {
      adapter: SERVICENOW_ADAPTER_NAME, enabled: problems.length === 0, problems: problems.map((item) => item.code),
      table: typeof config.table === 'string' ? config.table : null,
    },
    actor: String(requestedBy),
  });
  return { config, problems };
}

/**
 * Loads the tenant's adapter. Throws ServiceNowAdapterError('disabled') with the
 * problems when ServiceNow is not set up or any mapping is missing.
 */
export async function loadServiceNowAdapter(client, { tenantRef, fetchImpl, resolveSecret, timeoutMs }) {
  const row = await storedConfig(client, tenantRef);
  if (!row) {
    const problems = serviceNowConfigProblems(null);
    throw new ServiceNowAdapterError('disabled', 'ServiceNow is not set up.', problems);
  }
  return createServiceNowAdapter({ config: row.config, fetchImpl, resolveSecret, timeoutMs });
}

async function refusedCallbackEvidence(client, { tenantRef, code, sysId = null }) {
  await appendEvidence(client, {
    tenantRef,
    kind: ITSM_CALLBACK_EVIDENCE_KIND,
    subject: { outcome: `refused-${code}`, adapter: SERVICENOW_ADAPTER_NAME, externalRef: sysId },
    actor: `itsm:${SERVICENOW_ADAPTER_NAME}`,
  });
}

/**
 * Handles one inbound ServiceNow callback: authenticate (rule 2), confirm against the
 * instance with KEEL's own credential, then hand it to the bridge, which decides only
 * through a mapped, currently eligible principal (rule 3). Returns the bridge's result,
 * or { outcome: 'refused-<code>' } for a callback refused before the bridge.
 */
export async function handleServiceNowCallback(client, { tenantRef, adapter, headers, rawBody, now = new Date() }) {
  let verified;
  try {
    verified = await adapter.verifyCallback({ headers, rawBody, now });
  } catch (error) {
    if (!(error instanceof ServiceNowCallbackError)) throw error;
    await refusedCallbackEvidence(client, { tenantRef, code: error.code });
    return { outcome: `refused-${error.code}`, duplicate: false, detail: { reason: error.message } };
  }
  const current = await adapter.fetchRecord(verified.sysId);
  if (!current) {
    await refusedCallbackEvidence(client, { tenantRef, code: 'unknown-record', sysId: verified.sysId });
    return { outcome: 'refused-unknown-record', duplicate: false, detail: {} };
  }
  const claimed = verified.event;
  const mismatch = ['status', 'externalUser', 'version', 'planDigest'].filter((key) => current[key] !== claimed[key]);
  if (mismatch.length > 0) {
    // Forged with a leaked secret, or overtaken by a later change: either way the
    // instance does not say this, so it does not act. Reconciliation reads the truth.
    await refusedCallbackEvidence(client, { tenantRef, code: 'instance-mismatch', sysId: verified.sysId });
    return { outcome: 'refused-instance-mismatch', duplicate: false, detail: { fields: mismatch } };
  }
  return receiveCallback(client, { tenantRef, adapter: SERVICENOW_ADAPTER_NAME, event: claimed });
}

/**
 * One ServiceNow cycle for a tenant: record portal decisions and deliver due outbound
 * events, then poll every record still waiting on a decision (authenticated polling;
 * the bridge's deterministic reconcile event id makes a second poll a duplicate).
 * A disabled adapter does nothing and says why.
 */
export async function runServiceNowCycle(client, { tenantRef, fetchImpl, resolveSecret, timeoutMs, now = null }) {
  let adapter;
  try {
    adapter = await loadServiceNowAdapter(client, { tenantRef, fetchImpl, resolveSecret, timeoutMs });
  } catch (error) {
    if (error instanceof ServiceNowAdapterError && error.code === 'disabled') {
      return { enabled: false, problems: error.problems };
    }
    throw error;
  }
  const delivery = await runMirrorCycle(client, { tenantRef, adapter, now });
  const { rows: open } = await client.query(
    `SELECT r.external_ref FROM itsm_record r JOIN approval_request q ON q.id = r.approval_request_id
      WHERE r.tenant_ref = $1 AND r.adapter = $2 AND r.subject_kind = 'approval_request' AND q.status = 'pending'
      ORDER BY r.created_at, r.id`,
    [tenantRef, SERVICENOW_ADAPTER_NAME],
  );
  const reconciled = {};
  let pollFailures = 0;
  for (const { external_ref: externalRef } of open) {
    try {
      const result = await reconcileRecord(client, { tenantRef, adapter, externalRef });
      const key = result.duplicate ? 'duplicate' : result.outcome;
      reconciled[key] = (reconciled[key] ?? 0) + 1;
    } catch {
      pollFailures += 1; // read again next cycle; nothing was decided
    }
  }
  return { enabled: true, problems: [], ...delivery, polled: open.length, reconciled, pollFailures };
}

/**
 * What the integrations page shows (read capability): whether ServiceNow is on, every
 * missing mapping in words, the mapping itself (references only, never secrets) and the
 * mirror's delivery health, including updates held back after a failed write.
 */
export async function serviceNowStatus(client, { tenantRef, principalId }) {
  await requireCapability(client, principalId, 'read');
  const row = await storedConfig(client, tenantRef);
  const config = row?.config ?? null;
  const problems = serviceNowConfigProblems(config);
  const { rows: [counts] } = await client.query(
    `SELECT
       (SELECT count(*)::int FROM itsm_record WHERE tenant_ref = $1 AND adapter = $2) AS records,
       (SELECT count(*)::int FROM itsm_record r JOIN approval_request q ON q.id = r.approval_request_id
          WHERE r.tenant_ref = $1 AND r.adapter = $2 AND q.status = 'pending') AS waiting,
       (SELECT count(*)::int FROM itsm_outbox_event WHERE tenant_ref = $1 AND adapter = $2 AND status = 'pending') AS pending,
       (SELECT count(*)::int FROM itsm_outbox_event WHERE tenant_ref = $1 AND adapter = $2 AND status = 'quarantined') AS held_back,
       (SELECT count(*)::int FROM itsm_inbox WHERE tenant_ref = $1 AND adapter = $2 AND outcome = 'conflict') AS conflicts`,
    [tenantRef, SERVICENOW_ADAPTER_NAME],
  );
  const { rows: heldBack } = await client.query(
    `SELECT e.event_id, e.kind, e.attempts, e.last_error, e.quarantine_reason, e.created_at, r.external_ref
       FROM itsm_outbox_event e JOIN itsm_record r ON r.id = e.record_id
      WHERE e.tenant_ref = $1 AND e.adapter = $2 AND e.status = 'quarantined'
      ORDER BY e.created_at DESC, e.id DESC LIMIT 20`,
    [tenantRef, SERVICENOW_ADAPTER_NAME],
  );
  let instanceHost = null;
  try {
    instanceHost = config ? new URL(String(config.instanceUrl)).host || null : null;
  } catch {
    instanceHost = null;
  }
  return {
    configured: Boolean(row),
    enabled: problems.length === 0,
    problems,
    mapping: config ? {
      instanceHost,
      table: typeof config.table === 'string' ? config.table : null,
      fields: isObject(config.fields) ? config.fields : {},
      approvedValues: Array.isArray(config.states?.approved) ? config.states.approved : [],
      rejectedValues: Array.isArray(config.states?.rejected) ? config.states.rejected : [],
      tokenRef: config.credential?.tokenRef ?? null,
      callbacks: isObject(config.callback) ? 'signed' : 'off',
      callbackSecretRef: config.callback?.secretRef ?? null,
    } : null,
    mirror: {
      records: counts.records, waiting: counts.waiting, pendingUpdates: counts.pending,
      heldBack: counts.held_back, conflicts: counts.conflicts,
    },
    heldBack: heldBack.map((event) => ({
      eventId: event.event_id, kind: event.kind, externalRef: event.external_ref, attempts: event.attempts,
      reason: event.quarantine_reason, lastError: event.last_error, createdAt: new Date(event.created_at).toISOString(),
    })),
    updatedAt: row ? new Date(row.updated_at).toISOString() : null,
    updatedBy: row?.updated_by ?? null,
    docSource: SERVICENOW_DOC_SOURCE,
  };
}
