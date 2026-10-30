/**
 * READ-MDE-IOC: Microsoft Defender for Endpoint indicators (custom allow and block
 * lists for file hashes, certificates, IP addresses, domains and URLs), read-only.
 *
 * A workload of its own (`defender-endpoint-indicators`) with one read, the List
 * Indicators API (GET https://api.security.microsoft.com/api/indicators). Each
 * indicator becomes one observation, keyed by its id.
 *
 * Rules (as for Power Platform, engine/collect/workloads/powerPlatform.mjs):
 *  - Read only. The transport (readOnlyDefenderIndicatorsTransport) refuses anything but
 *    a GET with no body of the one declared request shape, before it is sent. No write
 *    capability exists for this workload.
 *  - Configuration only. Alerts, machines, investigations and advanced hunting are never
 *    requested: the shape does not admit them. Fields beyond the declared ones are
 *    dropped unread; a credential-shaped value is redacted and never stored.
 *  - Duplicates are checked: a second copy of an id that disagrees is a conflict and
 *    makes the run partial.
 *  - Disabled until qualified. collectDefenderIndicators() sends nothing unless the read
 *    is live-qualified and enabled in the task-101 ledger.
 *
 * Access: the collector app needs the WindowsDefenderATP application permission
 * Ti.Read.All (Read all IOCs). Tokens are issued for the legacy resource
 * https://api.securitycenter.microsoft.com, which the API still requires on the
 * api.security.microsoft.com host.
 */
import { registerWorkload } from '../registry.mjs';
import { WORKLOAD_DESCRIPTORS, readRestConfiguration } from '../workloadContract.mjs';
import { redactPayload } from '../../telemetry/events.mjs';
import { getToken } from '../../../tools/tenant-probe/auth.mjs';

export const DEFENDER_INDICATORS_WORKLOAD = 'defender-endpoint-indicators';
export const DEFENDER_INDICATORS_OPERATION = 'defender.endpoint-indicators';
// The API answers at most 10,000 indicators per request ($top). A full page with no next link
// is followed with $skip, up to MAX_PAGES; a full last page is treated as possibly cut short.
export const PAGE_SIZE = 10000;
export const MAX_PAGES = 5;

const operation = () => WORKLOAD_DESCRIPTORS.find((descriptor) => descriptor.id === DEFENDER_INDICATORS_OPERATION);

/**
 * The one family. Fields were declared from Microsoft's documentation (Indicator resource
 * type), not measured live. `createdBy` and `lastUpdatedBy` say who added or last changed
 * the indicator; the Changes page shows them.
 */
export const FAMILIES = Object.freeze({
  indicator: Object.freeze({
    operation: DEFENDER_INDICATORS_OPERATION, prefix: 'indicator', identity: 'id',
    fields: Object.freeze([
      'indicatorType', 'indicatorValue', 'action', 'title', 'description', 'severity', 'generateAlert', 'recommendedActions',
      'category', 'mitreTechniques', 'application', 'rbacGroupNames', 'rbacGroupIds', 'expirationTime', 'externalID',
      'sourceType', 'createdBy', 'createdBySource', 'creationTimeDateTimeUtc', 'lastUpdatedBy', 'lastUpdateTime',
    ]),
  }),
});
export const FAMILY_NAMES = Object.freeze(Object.keys(FAMILIES));
export const DEFENDER_INDICATORS_OPERATIONS = Object.freeze([DEFENDER_INDICATORS_OPERATION]);

/** The registry descriptor. `enabledByDefault: false` until live qualification. */
export const DEFENDER_INDICATORS_DESCRIPTOR = Object.freeze({
  type: 'defenderEndpointIndicators',
  workload: DEFENDER_INDICATORS_WORKLOAD,
  adapter: 'defender-endpoint-indicators',
  readOnly: true,
  enabledByDefault: false,
  operations: DEFENDER_INDICATORS_OPERATIONS,
});

// The only request this workload sends. Anything else is refused before it leaves.
export const DEFENDER_INDICATORS_REQUEST_SHAPES = Object.freeze([
  { host: 'api.security.microsoft.com', path: /^\/api\/indicators$/ },
]);
const ALLOWED_QUERY = new Set(['$top', '$skip']);

export class DefenderIndicatorsScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DefenderIndicatorsScopeError';
  }
}

/** Throws unless the request is a GET of the indicators list. */
export function assertDefenderIndicatorsRequest(url, init = {}) {
  const method = String(init.method ?? 'GET').toUpperCase();
  if (method !== 'GET' || init.body !== undefined) throw new DefenderIndicatorsScopeError(`Defender indicator collection is read-only: refused ${method} ${url}`);
  const parsed = new URL(url);
  const path = decodeURIComponent(parsed.pathname);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || !DEFENDER_INDICATORS_REQUEST_SHAPES.some((shape) => shape.host === parsed.host && shape.path.test(path))) {
    throw new DefenderIndicatorsScopeError(`${parsed.hostname}${path} is not the Defender indicators list; alerts, devices and investigations are never read`);
  }
  for (const key of parsed.searchParams.keys()) {
    if (!ALLOWED_QUERY.has(key.toLowerCase())) throw new DefenderIndicatorsScopeError(`${path}: query ${key} is not allowed`);
  }
  return true;
}

/**
 * A transport that can only read the indicators list. `tokenFor(audience)` returns an
 * access token; it is fetched once, on first use, and never leaves the closure.
 */
export function readOnlyDefenderIndicatorsTransport(tokenFor, fetchImpl = globalThis.fetch) {
  let token = null;
  return async (url, init = {}) => {
    assertDefenderIndicatorsRequest(url, init);
    token ??= await tokenFor(operation().operation.audience);
    // A redirect is never followed: it could leave the declared request shape.
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body };
  };
}

/** The production transport for one tenant config: certificate client credentials. */
export function defenderIndicatorsTransportFor(config, { getTokenFn = getToken, fetchImpl } = {}) {
  return readOnlyDefenderIndicatorsTransport(async (audience) => (await getTokenFn(config, { scope: `${audience}.default` })).accessToken, fetchImpl);
}

const canonical = (value) => JSON.stringify(value ?? null, (_key, inner) => (inner && typeof inner === 'object' && !Array.isArray(inner)
  ? Object.fromEntries(Object.keys(inner).sort().map((key) => [key, inner[key]]))
  : inner));

// Ids are numeric strings ("995"); the API has also answered them as numbers.
const ID = /^[0-9]{1,19}$/;
/** The stable identity of one indicator, or null when it has none KEEL trusts. */
export function indicatorIdentity(body) {
  const value = body && typeof body === 'object' ? body.id : null;
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === 'string' && ID.test(text) ? text : null;
}
export const indicatorKey = (identity) => `${FAMILIES.indicator.prefix}:${identity}`;

function observeIndicator(body) {
  const { fields, operation: op } = FAMILIES.indicator;
  const entry = { fields: {}, fieldCoverage: {} };
  for (const field of fields) {
    const value = body[field];
    if (value === undefined) {
      entry.fieldCoverage[field] = { status: 'unknown', operation: op };
      continue;
    }
    const redaction = { redactedFields: 0, seen: new WeakSet() };
    const clean = redactPayload(value, redaction);
    if (redaction.redactedFields > 0) {
      entry.fields[field] = clean;
      entry.fieldCoverage[field] = { status: 'redacted', operation: op, reason: 'the value looked like a credential and was not stored' };
      continue;
    }
    entry.fields[field] = value;
    entry.fieldCoverage[field] = { status: 'observed', operation: op };
  }
  return entry;
}

function keep(items, { maxObjects }) {
  const resources = [];
  const kept = new Map();
  const conflicts = [];
  let unidentified = 0;
  let capped = false;
  for (const body of items) {
    const identity = indicatorIdentity(body);
    if (!identity) { unidentified += 1; continue; }
    if (kept.has(identity)) {
      const first = kept.get(identity);
      if (first) {
        const other = observeIndicator(body);
        const fields = Object.keys(first.fieldCoverage).filter((field) => canonical(first.fields[field]) !== canonical(other.fields[field]));
        if (fields.length) conflicts.push({ resourceKey: first.resourceKey, fields });
      }
      continue;
    }
    if (resources.length >= maxObjects) { capped = true; kept.set(identity, null); continue; }
    const resource = { resourceKey: indicatorKey(identity), kind: 'indicator', identity, ...observeIndicator(body) };
    kept.set(identity, resource);
    resources.push(resource);
  }
  return { resources, capped, unidentified, conflicts };
}

// The same read, skipping the first `skip` indicators (the API documents $top and $skip, not next links).
function withSkip(descriptor, skip) {
  return Object.freeze({ ...descriptor, operation: Object.freeze({ ...descriptor.operation, endpoint: `${descriptor.operation.endpoint}&$skip=${skip}` }) });
}

/**
 * Reads the indicators. Pure apart from the injected transport: no database, no gate.
 * `families` is ['indicator'] or []; `skipped` lists what the caller did not read.
 * Callers outside tests use collectDefenderIndicators.
 */
export async function readDefenderIndicators({
  transport, families = FAMILY_NAMES, skipped = [], maxObjects = PAGE_SIZE * MAX_PAGES, sleep = async () => {}, now = () => new Date(),
}) {
  for (const family of families) if (!FAMILIES[family]) throw new TypeError(`unknown Defender indicators family ${family}`);
  const observedFrom = now().toISOString();
  let read = { resources: [], capped: false, unidentified: 0, conflicts: [] };
  const failures = [];
  let pageFull = false;
  if (families.includes('indicator')) {
    try {
      const items = [];
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const descriptor = page === 0 ? operation() : withSkip(operation(), page * PAGE_SIZE);
        const { items: answered } = await readRestConfiguration(descriptor, { transport, sleep });
        items.push(...answered);
        // Fewer than a full page: that was the last one.
        pageFull = answered.length >= PAGE_SIZE;
        if (!pageFull) break;
      }
      read = keep(items, { maxObjects });
    } catch (error) {
      if (error instanceof DefenderIndicatorsScopeError) throw error;
      failures.push({ family: 'indicator', operation: DEFENDER_INDICATORS_OPERATION, status: 'failed', error: { message: String(error?.message ?? error), httpStatus: error?.status ?? null } });
    }
  }
  const { resources, unidentified, conflicts } = read;
  const capped = read.capped || pageFull;
  const statuses = resources.flatMap((entry) => Object.values(entry.fieldCoverage).map((coverage) => coverage.status));
  const fieldCounts = statuses.reduce((counts, status) => ({ ...counts, [status]: (counts[status] ?? 0) + 1 }), {});
  const perFamily = Object.fromEntries(families.map((family) => [family, { status: failures.length ? 'failed' : 'read', objects: resources.length }]));
  let outcome;
  if (families.length > 0 && resources.length === 0 && (failures.length || unidentified > 0)) outcome = 'failed';
  // An indicator need not carry every optional field (category, externalID...), so an
  // `unknown` field is not a gap here; a redacted one is.
  else if (failures.length || skipped.length || capped || unidentified || conflicts.length || statuses.includes('redacted')) outcome = 'partial';
  else if (resources.length === 0) outcome = 'complete-empty';
  else outcome = 'complete';
  return {
    workload: DEFENDER_INDICATORS_WORKLOAD,
    outcome,
    observedFrom,
    observedTo: now().toISOString(),
    discovery: { families: perFamily, objects: resources.length, capped, unidentified, conflicts, maxObjects, contentRead: false },
    resources,
    failures,
    skipped,
    fieldCounts,
  };
}

/** Whether live collection may run: the indicators read must be live-qualified and enabled. */
export function defenderIndicatorsActivation(ledger) {
  const row = (ledger?.rows ?? []).find((item) => item.id === DEFENDER_INDICATORS_OPERATION);
  if (row?.enabled) return { enabled: true, reasons: [], families: FAMILY_NAMES, skipped: [] };
  const reason = `${DEFENDER_INDICATORS_OPERATION} is ${row?.state ?? 'not in the ledger'}${row?.prerequisite ? `: ${row.prerequisite.message}` : ''}`;
  return { enabled: false, reasons: [reason], families: [], skipped: [] };
}

/** Persists one run in one transaction; one row per indicator. */
export async function recordDefenderIndicatorsRun(client, { tenantRef, result }) {
  await client.query('BEGIN');
  try {
    const { rows: [run] } = await client.query(
      `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, digest)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tenantRef, DEFENDER_INDICATORS_WORKLOAD, result.outcome, result.observedFrom, result.observedTo, {
        discovery: result.discovery ?? null,
        fieldCounts: result.fieldCounts ?? {},
        failures: result.failures ?? [],
        skipped: result.skipped ?? [],
        reasons: result.reasons ?? [],
      }],
    );
    for (const resource of result.resources ?? []) {
      await client.query(
        `INSERT INTO workload_observation (collection_id, resource_key, fields, field_coverage)
         VALUES ($1,$2,$3,$4) ON CONFLICT (collection_id, resource_key) DO NOTHING`,
        [run.id, resource.resourceKey, { identity: resource.identity, kind: resource.kind, ...resource.fields }, resource.fieldCoverage],
      );
    }
    await client.query('COMMIT');
    return run;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** The gated entry point. Without qualification it records a `disabled` run and sends nothing. */
export async function collectDefenderIndicators(client, { tenantRef, ledger, transport, sleep, maxObjects, now }) {
  const activation = defenderIndicatorsActivation(ledger);
  if (!activation.enabled) {
    const at = (now?.() ?? new Date()).toISOString();
    const run = await recordDefenderIndicatorsRun(client, { tenantRef, result: { outcome: 'disabled', observedFrom: at, observedTo: at, reasons: activation.reasons } });
    return { run, result: null, activation };
  }
  const result = await readDefenderIndicators({ transport, families: activation.families, maxObjects, sleep, now });
  const run = await recordDefenderIndicatorsRun(client, { tenantRef, result });
  return { run, result, activation };
}

/** Registry adapter: a direct call is refused until the workload is enabled. */
export const defenderIndicatorsAdapter = Object.freeze({
  async collect() {
    throw new Error('the Defender indicators workload adapter is disabled until live qualification; use collectDefenderIndicators with the ledger');
  },
});

registerWorkload(DEFENDER_INDICATORS_DESCRIPTOR, defenderIndicatorsAdapter);
