/**
 * READ-PP: Power Platform and Power BI tenant settings, read-only.
 *
 * A workload of its own (`power-platform-settings`). Six families, each its own
 * task-101 operation (engine/collect/workloadContract.mjs) and one admin REST read:
 *  - environments (Power Platform admin API, api.bap.microsoft.com);
 *  - data loss prevention (DLP) policies, with their connector groups and the
 *    environments they apply to (same API);
 *  - the tenant settings: who may create environments and Power Pages sites, and
 *    whether apps can be shared with everyone (same API; one object, read by a POST
 *    with no body, the only way Microsoft offers it);
 *  - tenant isolation: whether connections to and from other tenants are blocked
 *    (same API; one object, addressed by the tenant id);
 *  - the connectors available in each environment (Power Apps admin API,
 *    api.powerapps.com), one read per environment;
 *  - Power BI tenant settings (Fabric admin API, api.fabric.microsoft.com).
 * Every object becomes one observation, keyed by its stable name (see FAMILIES).
 *
 * Rules:
 *  - Read only. The transport (readOnlyPowerPlatformTransport) refuses anything but a
 *    GET with no body (or, for the tenant settings read alone, a POST with no body), and
 *    any request that is not one of POWER_PLATFORM_REQUEST_SHAPES, before it is sent. No write capability exists for this workload.
 *  - Configuration only. Apps, flows, user connections, Power BI workspaces, datasets
 *    and reports are never requested: the contract refuses those path segments and the
 *    shapes do not admit them. Anything an answer carries beyond a family's declared
 *    fields (a connector's swagger, a creator's identity) is dropped unread. A value
 *    shaped like a credential is redacted by the shared redactor and never stored.
 *  - Duplicates are checked. An identity answered twice keeps the first copy; a second
 *    copy that disagrees is recorded under `conflicts` and makes the run partial.
 *  - Disabled until qualified. collectPowerPlatform() sends nothing unless the
 *    environments read is live-qualified and enabled. Every other family runs only when
 *    its own row is enabled, and is otherwise listed as skipped, which makes the run
 *    partial: its settings are not backed up.
 */
import { registerWorkload } from '../registry.mjs';
import { WORKLOAD_DESCRIPTORS, readRestConfiguration } from '../workloadContract.mjs';
import { redactPayload } from '../../telemetry/events.mjs';
import { getToken } from '../../../tools/tenant-probe/auth.mjs';

export const POWER_PLATFORM_WORKLOAD = 'power-platform-settings';
export const DEFAULT_MAX_OBJECTS = 2000;
export const DEFAULT_MAX_ENVIRONMENTS = 100;

const operation = (id) => WORKLOAD_DESCRIPTORS.find((descriptor) => descriptor.id === id);

/**
 * The families. `top` fields are read from the object itself, `properties` fields
 * from its `properties` member (how the Power Platform admin APIs nest them). Fields
 * were declared from Microsoft's documentation, not measured live.
 */
export const FAMILIES = Object.freeze({
  environment: Object.freeze({
    operation: 'powerplatform.environments', prefix: 'environment', identity: 'name',
    top: Object.freeze(['location']),
    properties: Object.freeze([
      'displayName', 'description', 'environmentSku', 'azureRegion', 'isDefault', 'createdTime', 'states',
      'linkedEnvironmentMetadata', 'protectionStatus', 'governanceConfiguration', 'retentionPeriod',
    ]),
  }),
  dlpPolicy: Object.freeze({
    operation: 'powerplatform.dlp-policies', prefix: 'dlp-policy', identity: 'name',
    top: Object.freeze([
      'displayName', 'defaultConnectorsClassification', 'connectorGroups', 'environmentType', 'environments',
      'createdTime', 'lastModifiedTime', 'etag', 'isLegacySchemaVersion',
    ]),
    properties: Object.freeze([]),
  }),
  connector: Object.freeze({
    operation: 'powerplatform.connectors', prefix: 'connector', identity: 'name', perEnvironment: true,
    top: Object.freeze(['type']),
    properties: Object.freeze(['displayName', 'description', 'tier', 'publisher', 'isCustomApi', 'capabilities', 'createdTime', 'changedTime']),
  }),
  // One object per tenant. Only the settings ScubaGear's rules judge are kept: the rest
  // of the answer is optional per tenant, and a missing one would make every run partial.
  tenantSettings: Object.freeze({
    operation: 'powerplatform.tenant-settings', prefix: 'tenant-settings', singleton: 'tenant',
    top: Object.freeze([
      'disableEnvironmentCreationByNonAdminUsers', 'disableTrialEnvironmentCreationByNonAdminUsers', 'disablePortalsCreationByNonAdminUsers',
      'powerPlatform',
    ]),
    properties: Object.freeze([]),
  }),
  // One object per tenant, addressed by the tenant id. A null answer means isolation was
  // never set up; it is kept as { neverConfigured: true }, the way ScubaGear reads it.
  tenantIsolation: Object.freeze({
    operation: 'powerplatform.tenant-isolation', prefix: 'tenant-isolation', singleton: 'tenant', perTenant: true,
    top: Object.freeze([]),
    properties: Object.freeze(['isDisabled', 'allowedTenants']),
  }),
  powerBiSetting: Object.freeze({
    operation: 'powerbi.tenant-settings', prefix: 'powerbi-setting', identity: 'settingName',
    top: Object.freeze([
      'title', 'enabled', 'canSpecifySecurityGroups', 'tenantSettingGroup', 'enabledSecurityGroups', 'excludedSecurityGroups',
      'properties', 'delegateToCapacity', 'delegateToDomain', 'delegateToWorkspace',
    ]),
    properties: Object.freeze([]),
  }),
});
export const FAMILY_NAMES = Object.freeze(Object.keys(FAMILIES));
export const POWER_PLATFORM_OPERATIONS = Object.freeze(FAMILY_NAMES.map((name) => FAMILIES[name].operation));
export const CORE_OPERATIONS = Object.freeze(['powerplatform.environments']);

/** The registry descriptor. `enabledByDefault: false` until live qualification. */
export const POWER_PLATFORM_DESCRIPTOR = Object.freeze({
  type: 'powerPlatformSettings',
  workload: POWER_PLATFORM_WORKLOAD,
  adapter: 'power-platform-settings',
  readOnly: true,
  enabledByDefault: false,
  operations: POWER_PLATFORM_OPERATIONS,
});

// The only requests this workload sends. Anything else is refused before it leaves.
export const POWER_PLATFORM_REQUEST_SHAPES = Object.freeze([
  { host: 'api.bap.microsoft.com', path: /^\/providers\/Microsoft\.BusinessAppPlatform\/scopes\/admin\/environments$/ },
  { host: 'api.bap.microsoft.com', path: /^\/providers\/PowerPlatform\.Governance\/v2\/policies$/ },
  // Microsoft's only way to list the tenant settings: a POST with no body. The update is
  // another path (updateTenantSettings) and is refused like every other request.
  { host: 'api.bap.microsoft.com', path: /^\/providers\/Microsoft\.BusinessAppPlatform\/listTenantSettings$/i, method: 'POST' },
  { host: 'api.bap.microsoft.com', path: /^\/providers\/PowerPlatform\.Governance\/v1\/tenants\/[0-9a-fA-F-]{36}\/tenantIsolationPolicy$/ },
  { host: 'api.powerapps.com', path: /^\/providers\/Microsoft\.PowerApps\/scopes\/admin\/environments\/[A-Za-z0-9-]+\/apis$/ },
  { host: 'api.fabric.microsoft.com', path: /^\/v1\/admin\/tenantsettings$/ },
]);
const ALLOWED_QUERY = new Set(['api-version', '$skiptoken', 'skiptoken', 'continuationtoken']);
// The token audience each host is called with, from the declared operations.
const AUDIENCE = Object.freeze(Object.fromEntries(POWER_PLATFORM_OPERATIONS
  .map((id) => operation(id).operation).map((declared) => [declared.host, declared.audience])));

export class PowerPlatformScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PowerPlatformScopeError';
  }
}

/**
 * Throws unless the request is a read of one of the configuration shapes: a GET with no
 * body, or a POST with no body where the shape is a read Microsoft only offers as a POST.
 * Returns the method to send.
 */
export function assertPowerPlatformRequest(url, init = {}) {
  const method = String(init.method ?? 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(method) || init.body !== undefined) throw new PowerPlatformScopeError(`Power Platform collection is read-only: refused ${method} ${url}`);
  const parsed = new URL(url);
  const path = decodeURIComponent(parsed.pathname);
  const shape = parsed.protocol === 'https:' ? POWER_PLATFORM_REQUEST_SHAPES.find((item) => item.host === parsed.hostname && item.path.test(path)) : null;
  if (!shape) {
    throw new PowerPlatformScopeError(`${parsed.hostname}${path} is not a Power Platform configuration read; apps, flows, connections and Power BI content are never read`);
  }
  if (method !== (shape.method ?? 'GET')) throw new PowerPlatformScopeError(`Power Platform collection is read-only: refused ${method} ${url}`);
  for (const key of parsed.searchParams.keys()) {
    if (!ALLOWED_QUERY.has(key.toLowerCase())) throw new PowerPlatformScopeError(`${path}: query ${key} is not allowed`);
  }
  return method;
}

/**
 * A transport that can only read the shapes above. `tokenFor(audience)` returns an
 * access token for that API; each token is fetched once, on first use, and never
 * leaves the closure.
 */
export function readOnlyPowerPlatformTransport(tokenFor, fetchImpl = globalThis.fetch) {
  const tokens = new Map();
  return async (url, init = {}) => {
    const method = assertPowerPlatformRequest(url, init);
    const audience = AUDIENCE[new URL(url).hostname];
    if (!tokens.has(audience)) tokens.set(audience, await tokenFor(audience));
    const response = await fetchImpl(url, { method, headers: { authorization: `Bearer ${tokens.get(audience)}`, accept: 'application/json' } });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body };
  };
}

/** The production transport for one tenant config: certificate client credentials per API. */
export function powerPlatformTransportFor(config, { getTokenFn = getToken, fetchImpl } = {}) {
  return readOnlyPowerPlatformTransport(async (audience) => (await getTokenFn(config, { scope: `${audience}.default` })).accessToken, fetchImpl);
}

const canonical = (value) => JSON.stringify(value ?? null, (_key, inner) => (inner && typeof inner === 'object' && !Array.isArray(inner)
  ? Object.fromEntries(Object.keys(inner).sort().map((key) => [key, inner[key]]))
  : inner));

// Names are GUIDs, `Default-<tenant id>`, `shared_<connector>` or a setting name.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
/** The stable identity of one answer, or null when it has none KEEL trusts. */
export function objectIdentity(family, body) {
  if (FAMILIES[family].singleton) return body && typeof body === 'object' && !Array.isArray(body) ? FAMILIES[family].singleton : null;
  const value = body && typeof body === 'object' ? body[FAMILIES[family].identity] : null;
  return typeof value === 'string' && NAME.test(value) ? value : null;
}
export const powerPlatformKey = (family, identity) => `${FAMILIES[family].prefix}:${identity}`;

function observeObject(family, body) {
  const { top, properties, operation: op } = FAMILIES[family];
  const entry = { fields: {}, fieldCoverage: {} };
  const sources = [...top.map((field) => [field, body[field]]), ...properties.map((field) => [field, body.properties?.[field]])];
  for (const [field, value] of sources) {
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

function structuredFailure(error) {
  return { status: 'failed', error: { message: String(error?.message ?? error), httpStatus: error?.status ?? null } };
}

/** Turns one read's answers into resources. `scopeKey` prefixes identities (the environment, for connectors). */
function keep(family, items, { maxObjects, scopeKey = null, environment = null }) {
  const resources = [];
  const kept = new Map();
  const conflicts = [];
  let unidentified = 0;
  let capped = false;
  for (const body of items) {
    const name = objectIdentity(family, body);
    if (!name) { unidentified += 1; continue; }
    const identity = scopeKey ? `${scopeKey}/${name}` : name;
    if (kept.has(identity)) {
      const first = kept.get(identity);
      if (first) {
        const other = observeObject(family, body);
        const fields = Object.keys(first.fieldCoverage).filter((field) => canonical(first.fields[field]) !== canonical(other.fields[field]));
        if (fields.length) conflicts.push({ resourceKey: first.resourceKey, fields });
      }
      continue;
    }
    if (resources.length >= maxObjects) { capped = true; kept.set(identity, null); continue; }
    const resource = { resourceKey: powerPlatformKey(family, identity), kind: family, identity, ...observeObject(family, body) };
    if (environment) resource.environment = environment;
    kept.set(identity, resource);
    resources.push(resource);
  }
  return { resources, capped, unidentified, conflicts };
}

async function readFamily(family, { transport, sleep, maxObjects, substitute, scopeKey, environment }) {
  try {
    const { items } = await readRestConfiguration(operation(FAMILIES[family].operation), { transport, sleep, substitute });
    // A null tenant isolation answer: never set up, which is itself the setting.
    if (family === 'tenantIsolation' && items.length === 0) {
      const resource = { resourceKey: powerPlatformKey(family, FAMILIES[family].singleton), kind: family, identity: FAMILIES[family].singleton,
        fields: { neverConfigured: true }, fieldCoverage: { neverConfigured: { status: 'observed', operation: FAMILIES[family].operation } } };
      return { resources: [resource], capped: false, unidentified: 0, conflicts: [], failure: null };
    }
    return { ...keep(family, items, { maxObjects, scopeKey, environment }), failure: null };
  } catch (error) {
    if (error instanceof PowerPlatformScopeError) throw error;
    return { resources: [], capped: false, unidentified: 0, conflicts: [], failure: { family, operation: FAMILIES[family].operation, ...(environment ? { environment } : {}), ...structuredFailure(error) } };
  }
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The tenant id a per-tenant read is addressed by: the one given, or else the one in the
 * default environment's name (always `Default-<tenant id>`), or null.
 */
export function powerPlatformTenantId(tenantId, environments) {
  if (typeof tenantId === 'string' && GUID.test(tenantId)) return tenantId;
  const fallback = (environments?.resources ?? [])
    .filter((resource) => resource.fields?.isDefault === true)
    .map((resource) => /^Default-(.+)$/.exec(resource.identity)?.[1])
    .filter((id) => id && GUID.test(id));
  return fallback.length === 1 ? fallback[0] : null;
}

/**
 * Reads the named families (all by default). Pure apart from the injected transport:
 * no database, no gate. `skipped` lists families the caller did not read, with the
 * reason. `tenantId` addresses the per-tenant read (tenant isolation); without it the
 * id is taken from the default environment's name. Callers outside tests use
 * collectPowerPlatform.
 */
export async function readPowerPlatform({
  transport, families = FAMILY_NAMES, skipped = [], maxObjects = DEFAULT_MAX_OBJECTS, maxEnvironments = DEFAULT_MAX_ENVIRONMENTS,
  sleep = async () => {}, now = () => new Date(), tenantId = null,
}) {
  for (const family of families) if (!FAMILIES[family]) throw new TypeError(`unknown Power Platform family ${family}`);
  const observedFrom = now().toISOString();
  const reads = new Map();
  const extraFailures = [];
  for (const family of families.filter((name) => !FAMILIES[name].perEnvironment && !FAMILIES[name].perTenant)) {
    reads.set(family, await readFamily(family, { transport, sleep, maxObjects }));
  }
  for (const family of families.filter((name) => FAMILIES[name].perTenant)) {
    const tenant = powerPlatformTenantId(tenantId, reads.get('environment'));
    if (!tenant) {
      extraFailures.push({ family, operation: FAMILIES[family].operation, status: 'failed', error: { message: 'the tenant id is not known (none given, and no default environment named after it was read)', httpStatus: null } });
      reads.set(family, { resources: [], capped: false, unidentified: 0, conflicts: [], failure: null });
      continue;
    }
    reads.set(family, await readFamily(family, { transport, sleep, maxObjects, substitute: { 'tenant-id': tenant } }));
  }
  let environmentsCapped = false;
  for (const family of families.filter((name) => FAMILIES[name].perEnvironment)) {
    const environments = reads.get('environment');
    if (!environments || environments.failure) {
      extraFailures.push({ family, operation: FAMILIES[family].operation, status: 'failed', error: { message: 'the environments were not read, so their connectors could not be', httpStatus: null } });
      reads.set(family, { resources: [], capped: false, unidentified: 0, conflicts: [], failure: null });
      continue;
    }
    const names = environments.resources.map((resource) => resource.identity);
    environmentsCapped = names.length > maxEnvironments;
    const merged = { resources: [], capped: environmentsCapped, unidentified: 0, conflicts: [], failure: null };
    for (const environment of names.slice(0, maxEnvironments)) {
      const read = await readFamily(family, {
        transport, sleep, maxObjects: maxObjects - merged.resources.length, substitute: { 'environment-name': environment }, scopeKey: environment, environment,
      });
      merged.resources.push(...read.resources);
      merged.capped ||= read.capped;
      merged.unidentified += read.unidentified;
      merged.conflicts.push(...read.conflicts);
      if (read.failure) extraFailures.push(read.failure);
    }
    reads.set(family, merged);
  }
  const all = families.map((family) => reads.get(family));
  const resources = all.flatMap((read) => read.resources);
  const failures = [...all.map((read) => read.failure).filter(Boolean), ...extraFailures];
  const capped = all.some((read) => read.capped);
  const unidentified = all.reduce((sum, read) => sum + read.unidentified, 0);
  const conflicts = all.flatMap((read) => read.conflicts);
  const statuses = resources.flatMap((entry) => Object.values(entry.fieldCoverage).map((coverage) => coverage.status));
  const fieldCounts = statuses.reduce((counts, status) => ({ ...counts, [status]: (counts[status] ?? 0) + 1 }), {});
  const perFamily = Object.fromEntries(families.map((family) => {
    const failed = failures.some((failure) => failure.family === family);
    return [family, { status: failed ? 'failed' : 'read', objects: reads.get(family).resources.length }];
  }));
  let outcome;
  // Nothing usable was read: no object was kept, and something failed or answered only
  // objects with no identity KEEL trusts.
  if (families.length > 0 && resources.length === 0 && (failures.length || unidentified > 0)) outcome = 'failed';
  else if (failures.length || skipped.length || capped || unidentified || conflicts.length
    || statuses.some((status) => status !== 'observed')) outcome = 'partial';
  else if (resources.length === 0) outcome = 'complete-empty';
  else outcome = 'complete';
  return {
    workload: POWER_PLATFORM_WORKLOAD,
    outcome,
    observedFrom,
    observedTo: now().toISOString(),
    discovery: { families: perFamily, objects: resources.length, capped, environmentsCapped, unidentified, conflicts, maxObjects, maxEnvironments, contentRead: false },
    resources,
    failures,
    skipped,
    fieldCounts,
  };
}

/**
 * Whether live collection may run, and which families. The environments read must be
 * live-qualified and enabled. Every other family runs only when its own row is
 * enabled; otherwise it is skipped with the row's reason.
 */
export function powerPlatformActivation(ledger) {
  const rows = new Map((ledger?.rows ?? []).map((row) => [row.id, row]));
  const describe = (id) => {
    const row = rows.get(id);
    return `${id} is ${row?.state ?? 'not in the ledger'}${row?.prerequisite ? `: ${row.prerequisite.message}` : ''}`;
  };
  const reasons = CORE_OPERATIONS.filter((id) => !rows.get(id)?.enabled).map(describe);
  const families = FAMILY_NAMES.filter((name) => rows.get(FAMILIES[name].operation)?.enabled);
  const skipped = FAMILY_NAMES.filter((name) => !families.includes(name))
    .map((name) => ({ family: name, operation: FAMILIES[name].operation, reason: describe(FAMILIES[name].operation) }));
  return { enabled: reasons.length === 0, reasons, families, skipped };
}

/** Persists one run in one transaction; one row per object. */
export async function recordPowerPlatformRun(client, { tenantRef, result }) {
  await client.query('BEGIN');
  try {
    const { rows: [run] } = await client.query(
      `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, digest)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tenantRef, POWER_PLATFORM_WORKLOAD, result.outcome, result.observedFrom, result.observedTo, {
        discovery: result.discovery ?? null,
        fieldCounts: result.fieldCounts ?? {},
        failures: result.failures ?? [],
        skipped: result.skipped ?? [],
        reasons: result.reasons ?? [],
      }],
    );
    for (const resource of result.resources ?? []) {
      const meta = { identity: resource.identity, kind: resource.kind, ...(resource.environment ? { environment: resource.environment } : {}) };
      await client.query(
        `INSERT INTO workload_observation (collection_id, resource_key, fields, field_coverage)
         VALUES ($1,$2,$3,$4) ON CONFLICT (collection_id, resource_key) DO NOTHING`,
        [run.id, resource.resourceKey, { ...meta, ...resource.fields }, resource.fieldCoverage],
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
export async function collectPowerPlatform(client, { tenantRef, ledger, transport, sleep, maxObjects, maxEnvironments, now, tenantId }) {
  const activation = powerPlatformActivation(ledger);
  if (!activation.enabled) {
    const at = (now?.() ?? new Date()).toISOString();
    const run = await recordPowerPlatformRun(client, { tenantRef, result: { outcome: 'disabled', observedFrom: at, observedTo: at, reasons: activation.reasons } });
    return { run, result: null, activation };
  }
  const result = await readPowerPlatform({ transport, families: activation.families, skipped: activation.skipped, maxObjects, maxEnvironments, sleep, now, tenantId });
  const run = await recordPowerPlatformRun(client, { tenantRef, result });
  return { run, result, activation };
}

/** Registry adapter: a direct call is refused until the workload is enabled. */
export const powerPlatformAdapter = Object.freeze({
  async collect() {
    throw new Error('the Power Platform workload adapter is disabled until live qualification; use collectPowerPlatform with the ledger');
  },
});

registerWorkload(POWER_PLATFORM_DESCRIPTOR, powerPlatformAdapter);
