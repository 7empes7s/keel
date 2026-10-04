/**
 * Roadmap task-106: the OneDrive site-level configuration read adapter.
 *
 * For each OneDrive site it is configured to cover, it reads ONE observation: the
 * site's own sharing and container settings, through `Get-PnPTenantSite -Identity`
 * (the task-101 `onedrive.site-settings` operation). Files, folders, list items,
 * item-applied labels and per-file permissions are never requested.
 *
 * Rules:
 *  - Named sites only, no crawl. Sites are named in configuration as personal site
 *    URLs on the tenant's `-my.sharepoint.com` host (at most 50 per run). Nothing
 *    enumerates OneDrive sites or anything inside one. A URL on another host, or one
 *    that addresses a path inside a site, is `refused` and nothing is sent.
 *  - Inherited versus explicit. A OneDrive site setting can carry its own value or
 *    follow the tenant's OneDrive default. Each field records which it is
 *    (`explicit`, `inherited` or `undetermined`) next to the value the site reports.
 *    An inherited value is what the site shows, not a value the site owns: when the
 *    tenant default moves, the site's shown value moves with it, and that is not a
 *    site change. compareOneDriveSites() keeps the two apart.
 *  - Its own qualification. The cmdlet is the one SharePoint's `sharepoint.site-sharing`
 *    declares, but SharePoint proof is never OneDrive proof: activation needs the
 *    `onedrive.site-settings` row itself live-qualified and enabled, after Exchange
 *    (and so Teams and SharePoint) is qualified.
 *  - Read-only. No OneDrive write is declared. Every difference is reported for a
 *    person to act on; a locked site is flagged and never changed or unlocked.
 *  - Errors are structured, as in the Exchange adapter: a cmdlet error is `failed` or
 *    `denied`, never an empty success, and an empty answer is `unknown`.
 */
import { registerWorkload } from '../registry.mjs';
import { runCmdlet } from '../../powershell/jobQueue.mjs';
import { exchangeActivation, structuredFailure } from './exchange.mjs';

export const ONEDRIVE_WORKLOAD = 'onedrive-site-settings';
export const ONEDRIVE_MODULE = 'PnP.PowerShell';
export const ONEDRIVE_OPERATION = 'onedrive.site-settings';
export const ONEDRIVE_OPERATIONS = Object.freeze([ONEDRIVE_OPERATION]);
export const DEFAULT_MAX_SITES = 50;

/** The registry descriptor. `enabledByDefault: false` until live qualification. */
export const ONEDRIVE_DESCRIPTOR = Object.freeze({
  type: 'onedriveSite',
  workload: ONEDRIVE_WORKLOAD,
  adapter: 'onedrive-site-settings',
  readOnly: true,
  enabledByDefault: false,
  operations: ONEDRIVE_OPERATIONS,
});

// How each kept field is attributed. `explicit`: the site owns the value.
// `inheritedWhen(value, body)`: true when the site follows the tenant's OneDrive
// default for it, false when the site carries its own value, null when the answer
// cannot tell. `undetermined`: the cmdlet answer does not say. Declared from the
// PnP and SharePoint Online documentation; not measured against a tenant.
const explicit = Object.freeze({ kind: 'explicit' });
const undetermined = Object.freeze({ kind: 'undetermined' });
const inheritedIfNone = Object.freeze({ kind: 'conditional', inheritedWhen: (value) => (value === undefined || value === null ? null : value === 'None') });
const inheritedUnlessOverride = (flag) => Object.freeze({
  kind: 'conditional',
  inheritedWhen: (_value, body) => (typeof body[flag] === 'boolean' ? body[flag] === false : null),
});

export const ONEDRIVE_FIELDS = Object.freeze({
  Template: explicit,
  Owner: explicit,
  SharingCapability: explicit,
  SharingDomainRestrictionMode: explicit,
  SharingAllowedDomainList: explicit,
  SharingBlockedDomainList: explicit,
  DefaultSharingLinkType: inheritedIfNone,
  DefaultLinkPermission: inheritedIfNone,
  OverrideTenantExternalUserExpirationPolicy: explicit,
  ExternalUserExpirationInDays: inheritedUnlessOverride('OverrideTenantExternalUserExpirationPolicy'),
  OverrideTenantAnonymousLinkExpirationPolicy: explicit,
  AnonymousLinkExpirationInDays: inheritedUnlessOverride('OverrideTenantAnonymousLinkExpirationPolicy'),
  StorageQuota: undetermined,
  StorageQuotaWarningLevel: undetermined,
  LockState: explicit,
  // The sensitivity label applied to the site as a container. Not a file's label.
  SensitivityLabel: explicit,
  ConditionalAccessPolicy: explicit,
});
export const INHERITANCE_STATES = Object.freeze(['explicit', 'inherited', 'undetermined']);

// Never requested, never stored, never counted as configuration.
export const ONEDRIVE_EXCLUDED_CONTENT = Object.freeze([
  'files', 'folders', 'listItems', 'driveItems', 'itemSensitivityLabels', 'itemPermissions', 'sharingLinks', 'versions', 'recycleBin',
]);

// The only cmdlet this workload runs, and the only parameter it may receive.
// ops/powershell/run-cmdlet.ps1 ($AllowedPnP) holds the same list and checks it again.
export const ONEDRIVE_CMDLET_PARAMETERS = Object.freeze({
  'Get-PnPTenantSite': Object.freeze(['Identity']),
});
export const ONEDRIVE_CMDLETS = new Set(Object.keys(ONEDRIVE_CMDLET_PARAMETERS));

export class OneDriveScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OneDriveScopeError';
  }
}

/** Throws unless the cmdlet and every parameter name are allowlisted. */
export function assertOneDriveCmdlet({ cmdlet, parameters = {} }) {
  const allowed = ONEDRIVE_CMDLET_PARAMETERS[cmdlet];
  if (!allowed) throw new OneDriveScopeError(`${cmdlet} is not a OneDrive configuration cmdlet KEEL runs; files, items and per-file permissions are never read`);
  for (const name of Object.keys(parameters)) {
    if (!allowed.includes(name)) throw new OneDriveScopeError(`${cmdlet} does not take ${name} from KEEL`);
  }
  return true;
}

/**
 * A OneDrive site as an operator names it: `https://contoso-my.sharepoint.com/personal/alice_contoso_com`.
 * Returns the normalized URL. Throws OneDriveScopeError for anything else: another
 * host, a path inside the site, a query or a fragment.
 */
export function oneDriveSite(value, myHost) {
  if (typeof myHost !== 'string' || !/^[a-z0-9-]+-my\.sharepoint\.com$/i.test(myHost)) {
    throw new TypeError('myHost must be the tenant\'s OneDrive host, such as contoso-my.sharepoint.com');
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 400) throw new OneDriveScopeError('a OneDrive site is a URL of at most 400 characters');
  let url;
  try { url = new URL(value); } catch { throw new OneDriveScopeError(`${value} is not a URL`); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== myHost.toLowerCase()) throw new OneDriveScopeError(`${value} is not on ${myHost}`);
  if (url.search || url.hash || url.username || url.password || url.port) throw new OneDriveScopeError(`${value} carries a query, fragment or credentials`);
  const segments = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
  if (segments.length !== 2 || segments[0].toLowerCase() !== 'personal' || !/^[A-Za-z0-9_.-]+$/.test(segments[1])) {
    throw new OneDriveScopeError(`${value} is not a personal site root; KEEL never addresses a path inside a OneDrive`);
  }
  return `https://${myHost.toLowerCase()}/personal/${segments[1]}`;
}

export const siteKey = (url) => `onedrive:${url.toLowerCase()}`;

/** Runs one OneDrive cmdlet through the bounded job transport. */
export async function oneDriveCmdlet({ cmdlet, parameters = {} }, powershell = {}) {
  assertOneDriveCmdlet({ cmdlet, parameters });
  const { tenantConfigPath = null, ...options } = powershell;
  return runCmdlet({ module: ONEDRIVE_MODULE, cmdlet, parameters, tenantConfigPath }, { ...options, allowedCmdlets: ONEDRIVE_CMDLETS });
}

function inheritanceOf(spec, value, body) {
  if (spec.kind === 'explicit') return 'explicit';
  if (spec.kind === 'undetermined') return 'undetermined';
  const inherited = spec.inheritedWhen(value, body);
  if (inherited === null) return 'undetermined';
  return inherited ? 'inherited' : 'explicit';
}

/** Reads one OneDrive site's settings. Used by the reader and by comparisons. */
export async function readOneDriveSite({ url, powershell }) {
  const entry = { url, fields: {}, fieldCoverage: {} };
  const fieldNames = Object.keys(ONEDRIVE_FIELDS);
  const mark = (coverage) => { for (const field of fieldNames) entry.fieldCoverage[field] = { ...coverage, operation: ONEDRIVE_OPERATION }; };
  let output;
  try {
    ({ output } = await oneDriveCmdlet({ cmdlet: 'Get-PnPTenantSite', parameters: { Identity: url } }, powershell));
  } catch (error) {
    mark(structuredFailure(error));
    return entry;
  }
  if (output.length > 1) {
    mark({ status: 'failed', error: { code: 'AMBIGUOUS_IDENTITY', cmdlet: 'Get-PnPTenantSite', message: `${output.length} sites answered one URL; KEEL reads exactly one`, category: null, errorId: null } });
    return entry;
  }
  const [body] = output;
  if (!body) {
    mark({ status: 'unknown', reason: 'the read succeeded and returned no site' });
    return entry;
  }
  // SharePoint's site reading does not transfer: the answer must be a personal site.
  if (typeof body.Template === 'string' && !/^SPSPERS/i.test(body.Template)) {
    mark({ status: 'refused', error: { code: 'NOT_ONEDRIVE', cmdlet: 'Get-PnPTenantSite', message: `the site answered with template ${body.Template}, not a OneDrive personal site`, category: null, errorId: null } });
    return entry;
  }
  for (const [field, spec] of Object.entries(ONEDRIVE_FIELDS)) {
    const value = body[field];
    if (value === undefined) {
      entry.fieldCoverage[field] = { status: 'unknown', operation: ONEDRIVE_OPERATION, inheritance: 'undetermined' };
      continue;
    }
    entry.fields[field] = value;
    entry.fieldCoverage[field] = { status: 'observed', operation: ONEDRIVE_OPERATION, inheritance: inheritanceOf(spec, value, body) };
  }
  return entry;
}

/**
 * Reads the named OneDrive sites. Pure apart from the injected PowerShell options:
 * no database, no gate. Callers outside tests use collectOneDrive.
 */
export async function readOneDrive({ powershell = {}, sites = [], myHost, maxSites = DEFAULT_MAX_SITES, now = () => new Date() }) {
  if (!Array.isArray(sites)) throw new TypeError('sites must be a list of OneDrive site URLs');
  const observedFrom = now().toISOString();
  const named = [];
  const outOfScope = [];
  const seen = new Set();
  let capped = false;
  for (const value of sites) {
    let url;
    try {
      url = oneDriveSite(value, myHost);
    } catch (error) {
      if (!(error instanceof OneDriveScopeError)) throw error;
      outOfScope.push({ site: String(value), reason: error.message });
      continue;
    }
    if (seen.has(url.toLowerCase())) continue;
    if (named.length >= maxSites) { capped = true; outOfScope.push({ site: url, reason: `more than ${maxSites} sites were named` }); continue; }
    seen.add(url.toLowerCase());
    named.push(url);
  }
  const resources = [];
  for (const url of named) resources.push({ resourceKey: siteKey(url), ...(await readOneDriveSite({ url, powershell })) });

  const statuses = resources.flatMap((entry) => Object.values(entry.fieldCoverage).map((coverage) => coverage.status));
  const fieldCounts = statuses.reduce((counts, status) => ({ ...counts, [status]: (counts[status] ?? 0) + 1 }), {});
  let outcome;
  if (resources.length === 0) outcome = outOfScope.length ? 'failed' : 'complete-empty';
  else if (!statuses.includes('observed')) outcome = 'failed';
  else if (capped || outOfScope.length || statuses.some((status) => status !== 'observed')) outcome = 'partial';
  else outcome = 'complete';
  return {
    workload: ONEDRIVE_WORKLOAD,
    outcome,
    observedFrom,
    observedTo: now().toISOString(),
    discovery: { sites: named.length, capped, maxSites, crawl: false },
    resources,
    outOfScope,
    fieldCounts,
  };
}

const canonical = (value) => JSON.stringify(value ?? null, (_key, inner) => (inner && typeof inner === 'object' && !Array.isArray(inner)
  ? Object.fromEntries(Object.keys(inner).sort().map((key) => [key, inner[key]]))
  : inner));

/** A lock an administrator or the platform put on the site. KEEL never changes or unlocks it. */
export function siteLocked(fields) {
  const state = fields?.LockState;
  return typeof state === 'string' && state.length > 0 && state.toLowerCase() !== 'unlock';
}

// An observation recorded before inheritance was tracked carries none; it reads
// as undetermined, never as explicit.
const inheritanceIn = (observation, field) => {
  const value = observation?.fieldCoverage?.[field]?.inheritance;
  return INHERITANCE_STATES.includes(value) ? value : 'undetermined';
};

/**
 * Compares two observations of one OneDrive site (a recorded one and a newer one).
 * Returns { changes, unknown, locked }. Each change is one of:
 *  - `value`: the site's own value changed;
 *  - `inheritance`: the site started or stopped following the tenant default
 *    (even when the shown value is the same);
 *  - `inherited-default`: both sides follow the tenant default and the shown value
 *    moved, which is a tenant change, not a site change (`siteChange: false`).
 * No OneDrive write is declared, so every change is `restore: 'manual'`.
 */
export function compareOneDriveSites(before, after) {
  const changes = [];
  const unknown = [];
  const locked = siteLocked(after?.fields) || siteLocked(before?.fields);
  for (const field of Object.keys(ONEDRIVE_FIELDS)) {
    const b = before?.fieldCoverage?.[field]?.status;
    const a = after?.fieldCoverage?.[field]?.status;
    if (b !== 'observed' || a !== 'observed') { unknown.push({ field, before: b ?? 'unknown', after: a ?? 'unknown' }); continue; }
    const from = { value: before.fields[field] ?? null, inheritance: inheritanceIn(before, field) };
    const to = { value: after.fields[field] ?? null, inheritance: inheritanceIn(after, field) };
    const valueChanged = canonical(from.value) !== canonical(to.value);
    let change = null;
    if (from.inheritance !== to.inheritance && from.inheritance !== 'undetermined' && to.inheritance !== 'undetermined') change = 'inheritance';
    else if (!valueChanged) continue;
    else if (from.inheritance === 'inherited' && to.inheritance === 'inherited') change = 'inherited-default';
    else change = 'value';
    changes.push({
      field, change, before: from, after: to, siteChange: change !== 'inherited-default',
      restore: 'manual',
      reason: locked
        ? `the site is locked (LockState ${after?.fields?.LockState ?? before?.fields?.LockState}); KEEL never changes or unlocks it`
        : 'KEEL declares no OneDrive write; a SharePoint administrator applies this change',
    });
  }
  return { changes, unknown, locked };
}

/**
 * Whether live collection may run. Exchange (which follows Teams and SharePoint)
 * must be qualified first, and the OneDrive read must be live-qualified and enabled
 * on its OWN row. `sharepoint.site-sharing` runs the same cmdlet and never counts.
 */
export function oneDriveActivation(ledger) {
  const rows = new Map((ledger?.rows ?? []).map((row) => [row.id, row]));
  const reasons = [];
  const exchange = exchangeActivation(ledger);
  if (!exchange.enabled) reasons.push(`Exchange is not qualified yet, and OneDrive follows it: ${exchange.reasons.join('; ')}`);
  for (const id of ONEDRIVE_OPERATIONS) {
    const row = rows.get(id);
    if (!row?.enabled) reasons.push(`${id} is ${row?.state ?? 'not in the ledger'}${row?.prerequisite ? `: ${row.prerequisite.message}` : ''}`);
  }
  return { enabled: reasons.length === 0, reasons };
}

/** Persists one run in one transaction; one row per site. */
export async function recordOneDriveRun(client, { tenantRef, result }) {
  await client.query('BEGIN');
  try {
    const { rows: [run] } = await client.query(
      `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, digest)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tenantRef, ONEDRIVE_WORKLOAD, result.outcome, result.observedFrom, result.observedTo, {
        discovery: result.discovery ?? null,
        fieldCounts: result.fieldCounts ?? {},
        outOfScope: result.outOfScope ?? [],
        reasons: result.reasons ?? [],
      }],
    );
    for (const resource of result.resources ?? []) {
      await client.query(
        `INSERT INTO workload_observation (collection_id, resource_key, fields, field_coverage)
         VALUES ($1,$2,$3,$4) ON CONFLICT (collection_id, resource_key) DO NOTHING`,
        [run.id, resource.resourceKey, { url: resource.url, ...resource.fields }, resource.fieldCoverage],
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
export async function collectOneDrive(client, { tenantRef, ledger, powershell, sites, myHost, maxSites, now }) {
  const activation = oneDriveActivation(ledger);
  if (!activation.enabled) {
    const at = (now?.() ?? new Date()).toISOString();
    const run = await recordOneDriveRun(client, { tenantRef, result: { outcome: 'disabled', observedFrom: at, observedTo: at, reasons: activation.reasons } });
    return { run, result: null, activation };
  }
  const result = await readOneDrive({ powershell, sites, myHost, maxSites, now });
  const run = await recordOneDriveRun(client, { tenantRef, result });
  return { run, result, activation };
}

/** Registry adapter: a direct call is refused until the workload is enabled. */
export const oneDriveAdapter = Object.freeze({
  async collect() {
    throw new Error('the OneDrive workload adapter is disabled until live qualification; use collectOneDrive with the ledger');
  },
});

registerWorkload(ONEDRIVE_DESCRIPTOR, oneDriveAdapter);
