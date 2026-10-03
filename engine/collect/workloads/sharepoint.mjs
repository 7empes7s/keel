/**
 * Roadmap task-102: the first workload read adapter. It reads SharePoint
 * configuration:
 *  - tenant sharing settings;
 *  - each site's properties;
 *  - each site's own app permission grants.
 * Every request goes through the task-101 contract. It never reads files, list items
 * or messages, and never per-file permissions.
 *
 * Rules:
 *  - Disabled until qualified. collectSharePointSites() sends nothing unless every
 *    operation it needs is live-qualified AND enabled in the task-101 ledger. Fixture
 *    tests drive readSharePointSites() directly.
 *  - Tenant scope comes from configuration. `tenantHost` (contoso.sharepoint.com) is
 *    given by the caller, never derived from a site URL. A discovered site on any other
 *    host, or whose composite id names another host, is recorded out of scope and
 *    never read.
 *  - Coverage is per field. Each supported field records where it came from (its
 *    task-101 operation) and whether it was observed, denied, failed or is unknown. A
 *    field KEEL does not support is always `unknown`, never a default value. One
 *    denied or failed field makes the whole read `partial`, never `complete`.
 *  - Bounded. Discovery stops at `maxSites` and reports `partial`. Every read pages
 *    through readGraphConfiguration, which honours Retry-After and refuses a next page
 *    outside its own path.
 *  - Consistent. Sites are keyed by id, so a site Graph returns on two pages is one
 *    observation. All observations of one run share the run's observation window.
 */
import { registerWorkload } from '../registry.mjs';
import { WORKLOAD_DESCRIPTORS, readGraphConfiguration } from '../workloadContract.mjs';

export const SHAREPOINT_WORKLOAD = 'sharepoint-site-settings';
export const DEFAULT_MAX_SITES = 500;

const operation = (id) => WORKLOAD_DESCRIPTORS.find((descriptor) => descriptor.id === id);
export const SHAREPOINT_OPERATIONS = Object.freeze([
  'sharepoint.tenant-settings', 'sharepoint.site-discovery', 'sharepoint.site-properties', 'sharepoint.site-permissions',
]);

/** The registry descriptor. `enabledByDefault: false` until live qualification. */
export const SHAREPOINT_DESCRIPTOR = Object.freeze({
  type: 'sharepointSite',
  workload: SHAREPOINT_WORKLOAD,
  adapter: 'sharepoint-site-settings',
  readOnly: true,
  enabledByDefault: false,
  operations: SHAREPOINT_OPERATIONS,
});

// Supported fields: name -> [operation, how to read it from that operation's body].
export const TENANT_FIELDS = Object.freeze({
  sharingCapability: (body) => body.sharingCapability,
  sharingDomainRestrictionMode: (body) => body.sharingDomainRestrictionMode,
  sharingAllowedDomainList: (body) => body.sharingAllowedDomainList,
  sharingBlockedDomainList: (body) => body.sharingBlockedDomainList,
  isResharingByExternalUsersEnabled: (body) => body.isResharingByExternalUsersEnabled,
});
export const SITE_FIELDS = Object.freeze({
  displayName: ['sharepoint.site-properties', (body) => body.displayName],
  name: ['sharepoint.site-properties', (body) => body.name],
  webUrl: ['sharepoint.site-properties', (body) => body.webUrl],
  createdDateTime: ['sharepoint.site-properties', (body) => body.createdDateTime],
  lastModifiedDateTime: ['sharepoint.site-properties', (body) => body.lastModifiedDateTime],
  hostname: ['sharepoint.site-properties', (body) => body.siteCollection?.hostname],
  appPermissionGrants: ['sharepoint.site-permissions', (items) => items.map((grant) => ({
    id: grant.id ?? null,
    roles: Array.isArray(grant.roles) ? [...grant.roles].sort() : [],
    applications: (grant.grantedToIdentitiesV2 ?? grant.grantedToIdentities ?? [])
      .map((identity) => identity?.application)
      .filter(Boolean)
      .map((application) => ({ id: application.id ?? null, displayName: application.displayName ?? null })),
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)))],
});
// Site settings KEEL does not read: they need the SharePoint admin interface
// (Get-PnPTenantSite), which is not qualified for this adapter. Always unknown.
export const UNSUPPORTED_SITE_FIELDS = Object.freeze([
  'sharingCapability', 'lockState', 'sensitivityLabel', 'conditionalAccessPolicy', 'externalUserExpirationInDays',
]);
const UNSUPPORTED_REASON = 'not read: needs the SharePoint admin interface, which is not qualified for this adapter';

function failureStatus(error) {
  return error?.status === 401 || error?.status === 403 ? 'denied' : 'failed';
}

function failure(error) {
  return { status: failureStatus(error), httpStatus: Number.isInteger(error?.status) ? error.status : null, error: String(error?.message ?? error) };
}

// "hostname,siteCollectionGuid,webGuid": anything else is not a site id KEEL will put in a path.
const SITE_ID = /^[a-z0-9.-]+,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12},[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when a discovered site belongs to the configured tenant host. */
export function siteInScope(site, tenantHost) {
  const host = String(tenantHost).toLowerCase();
  if (!SITE_ID.test(String(site.id ?? ''))) return false;
  let urlHost = null;
  try { urlHost = new URL(site.webUrl).hostname.toLowerCase(); } catch { urlHost = null; }
  // Graph site ids are "hostname,siteCollectionId,webId".
  const idHost = String(site.id ?? '').split(',')[0].toLowerCase();
  return urlHost === host && idHost === host;
}

/**
 * Reads tenant settings, discovers sites and reads each in-scope site. Pure apart
 * from the injected transport: no database, no gate. Callers outside tests use
 * collectSharePointSites, which applies the qualification gate first.
 */
export async function readSharePointSites({
  transport, tenantHost, maxSites = DEFAULT_MAX_SITES, sleep, now = () => new Date(),
}) {
  if (typeof tenantHost !== 'string' || !/^[a-z0-9-]+\.sharepoint\.com$/i.test(tenantHost)) {
    throw new TypeError('tenantHost must be the tenant\'s SharePoint host, such as contoso.sharepoint.com');
  }
  const requests = [];
  const recordingTransport = async (url) => { requests.push(url); return transport(url); };
  const read = (id, substitute = {}) => readGraphConfiguration(operation(id), { transport: recordingTransport, sleep, substitute });
  const observedFrom = now().toISOString();

  // Tenant-wide sharing settings.
  const tenant = { fields: {}, fieldCoverage: {} };
  try {
    const { items: [body = {}] } = await read('sharepoint.tenant-settings');
    for (const [field, pick] of Object.entries(TENANT_FIELDS)) {
      const value = pick(body);
      tenant.fields[field] = value ?? null;
      tenant.fieldCoverage[field] = { status: value === undefined ? 'unknown' : 'observed', operation: 'sharepoint.tenant-settings' };
    }
  } catch (error) {
    for (const field of Object.keys(TENANT_FIELDS)) tenant.fieldCoverage[field] = { ...failure(error), operation: 'sharepoint.tenant-settings' };
  }

  // Discovery. A failed discovery means the site set is unknown, never empty.
  let discovered;
  let discovery;
  try {
    const { items, observed } = await read('sharepoint.site-discovery');
    discovered = items;
    discovery = { status: 'observed', pages: observed.pages };
  } catch (error) {
    discovered = null;
    discovery = { ...failure(error), pages: null };
  }

  const sites = new Map();
  const outOfScope = [];
  let capped = false;
  for (const site of discovered ?? []) {
    if (!site?.id || sites.has(site.id)) continue;
    if (!siteInScope(site, tenantHost)) {
      outOfScope.push({ siteId: String(site.id), webUrl: site.webUrl ?? null });
      continue;
    }
    if (sites.size >= maxSites) { capped = true; break; }
    sites.set(site.id, { siteId: site.id, fields: {}, fieldCoverage: {} });
  }

  for (const entry of sites.values()) {
    const substitute = { 'site-id': entry.siteId };
    let properties = null;
    let propertiesError = null;
    try {
      ({ items: [properties = {}] } = await read('sharepoint.site-properties', substitute));
    } catch (error) {
      propertiesError = error;
    }
    let grants = null;
    let grantsError = null;
    try {
      ({ items: grants } = await read('sharepoint.site-permissions', substitute));
    } catch (error) {
      grantsError = error;
    }
    for (const [field, [from, pick]] of Object.entries(SITE_FIELDS)) {
      const source = from === 'sharepoint.site-properties' ? { body: properties, error: propertiesError } : { body: grants, error: grantsError };
      if (source.error) {
        entry.fieldCoverage[field] = { ...failure(source.error), operation: from };
        continue;
      }
      const value = pick(source.body);
      entry.fields[field] = value ?? null;
      entry.fieldCoverage[field] = { status: value === undefined ? 'unknown' : 'observed', operation: from };
    }
    for (const field of UNSUPPORTED_SITE_FIELDS) entry.fieldCoverage[field] = { status: 'unknown', operation: null, reason: UNSUPPORTED_REASON };
  }

  const supportedStatuses = [
    ...Object.values(tenant.fieldCoverage).map((coverage) => coverage.status),
    ...[...sites.values()].flatMap((entry) => Object.keys(SITE_FIELDS).map((field) => entry.fieldCoverage[field].status)),
  ];
  const fieldCounts = supportedStatuses.reduce((counts, status) => ({ ...counts, [status]: (counts[status] ?? 0) + 1 }), {});
  let outcome;
  if (discovery.status !== 'observed') outcome = 'failed';
  else if (capped || supportedStatuses.some((status) => status !== 'observed')) outcome = 'partial';
  else outcome = sites.size === 0 ? 'complete-empty' : 'complete';

  return {
    workload: SHAREPOINT_WORKLOAD,
    tenantHost,
    outcome,
    observedFrom,
    observedTo: now().toISOString(),
    discovery: { ...discovery, sites: discovered === null ? null : sites.size, capped, maxSites },
    tenant,
    sites: [...sites.values()],
    outOfScope,
    fieldCounts,
    requests,
  };
}

/**
 * Whether live collection may run: every operation this adapter uses must be
 * live-qualified and enabled in the task-101 ledger.
 */
export function sharePointActivation(ledger) {
  const rows = new Map((ledger?.rows ?? []).map((row) => [row.id, row]));
  const reasons = SHAREPOINT_OPERATIONS
    .filter((id) => !rows.get(id)?.enabled)
    .map((id) => `${id} is ${rows.get(id)?.state ?? 'not in the ledger'}${rows.get(id)?.prerequisite ? `: ${rows.get(id).prerequisite.message}` : ''}`);
  return { enabled: reasons.length === 0, reasons };
}

/**
 * Persists one run. A run and its observations are written in one transaction;
 * each site is one row keyed by its id, so a re-recorded run cannot double it.
 */
export async function recordSharePointRun(client, { tenantRef, result }) {
  await client.query('BEGIN');
  try {
    const { rows: [run] } = await client.query(
      `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, digest)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tenantRef, result.workload, result.outcome, result.observedFrom, result.observedTo, {
        tenantHost: result.tenantHost ?? null,
        discovery: result.discovery ?? null,
        fieldCounts: result.fieldCounts ?? {},
        outOfScope: result.outOfScope ?? [],
        reasons: result.reasons ?? [],
      }],
    );
    const observations = result.tenant ? [{ key: 'tenant', fields: result.tenant.fields, fieldCoverage: result.tenant.fieldCoverage }] : [];
    for (const site of result.sites ?? []) observations.push({ key: `site:${site.siteId}`, fields: site.fields, fieldCoverage: site.fieldCoverage });
    for (const observation of observations) {
      await client.query(
        `INSERT INTO workload_observation (collection_id, resource_key, fields, field_coverage)
         VALUES ($1,$2,$3,$4) ON CONFLICT (collection_id, resource_key) DO NOTHING`,
        [run.id, observation.key, observation.fields, observation.fieldCoverage],
      );
    }
    await client.query('COMMIT');
    return run;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/**
 * The gated entry point. Without qualification it records a `disabled` run that
 * names what is missing, and sends no request.
 */
export async function collectSharePointSites(client, { tenantRef, ledger, transport, tenantHost, maxSites, sleep, now }) {
  const activation = sharePointActivation(ledger);
  if (!activation.enabled) {
    const at = (now?.() ?? new Date()).toISOString();
    const run = await recordSharePointRun(client, {
      tenantRef,
      result: { workload: SHAREPOINT_WORKLOAD, outcome: 'disabled', observedFrom: at, observedTo: at, tenantHost, reasons: activation.reasons },
    });
    return { run, result: null, activation };
  }
  const result = await readSharePointSites({ transport, tenantHost, maxSites, sleep, now });
  const run = await recordSharePointRun(client, { tenantRef, result });
  return { run, result, activation };
}

/**
 * Registry adapter. The Entra snapshot path collects DESCRIPTORS only, so it never
 * reaches this; a direct call is refused until the workload is enabled.
 */
export const sharePointAdapter = Object.freeze({
  async collect() {
    throw new Error('the SharePoint workload adapter is disabled until live qualification; use collectSharePointSites with the ledger');
  },
});

registerWorkload(SHAREPOINT_DESCRIPTOR, sharePointAdapter);
