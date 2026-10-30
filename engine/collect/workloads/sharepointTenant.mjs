/**
 * SharePoint and OneDrive tenant settings through PnP PowerShell, on the admin site:
 *  - the whole tenant object (Get-PnPTenant): sharing defaults, default link type and
 *    permission, guest expiry, unmanaged-device and network access, legacy sign-in,
 *    OneDrive retention and storage, site and page settings, Loop and version history;
 *  - OneDrive sync limits (Get-PnPTenantSyncClientRestriction): sync only from
 *    domain-joined PCs, Mac sync, blocked file types;
 *  - idle sign-out (Get-PnPBrowserIdleSignout);
 *  - Restricted SharePoint Search (Get-PnPTenantRestrictedSearchMode) and the sites it
 *    allows (Get-PnPTenantRestrictedSearchAllowedList).
 *
 * A workload of its own (`sharepoint-tenant`), beside the Graph read of
 * /admin/sharepoint/settings (`sharepoint-site-settings`), which holds only a subset.
 *
 * Rules (the same as the other cmdlet workloads):
 *  - Read only. Only the five Get cmdlets above run, with no parameters. No writer exists.
 *  - Declared fields only. Anything else an answer carries is dropped unread. Values PnP
 *    serialises as enum numbers are stored by name; time spans are stored in seconds.
 *  - Each read is one tenant-wide object, keyed `<prefix>:tenant`.
 *  - Errors are structured. A failed read is `failed` or `denied`, never an empty object.
 *  - Disabled until qualified, per read: each family runs only once its own ledger row is
 *    live-qualified and enabled. A family not switched on yet is listed as skipped.
 */
import { registerWorkload } from '../registry.mjs';
import { runCmdlet } from '../../powershell/jobQueue.mjs';
import { structuredFailure } from './exchange.mjs';
import {
  emptyRead, ledgerRows, notExposed, objectsFrom, recordCmdletRun, recordDisabledRun, summarize,
} from './cmdletFamilies.mjs';

export const SHAREPOINT_TENANT_WORKLOAD = 'sharepoint-tenant';
export const SHAREPOINT_TENANT_MODULE = 'PnP.PowerShell';
const TENANT = () => 'tenant';

// PnP and CSOM enums, by number, as ConvertTo-Json writes them (names are from the
// SharePoint Online tenant administration types). The ScubaGear rules read the same
// numbers back (engine/benchmarks/scubagear/adapters.mjs).
export const ENUMS = Object.freeze({
  sharing: ['Disabled', 'ExternalUserSharingOnly', 'ExternalUserAndGuestSharing', 'ExistingExternalUserSharingOnly'],
  domainMode: ['None', 'AllowList', 'BlockList'],
  linkType: ['None', 'Direct', 'Internal', 'AnonymousAccess'],
  linkPermission: ['None', 'View', 'Edit'],
  anonymousLink: ['None', 'View', 'Edit'],
  conditionalAccess: ['AllowFullAccess', 'AllowLimitedAccess', 'BlockAccess', 'AuthenticationContext'],
  limitedAccessFiles: ['OfficeOnlineFilesOnly', 'WebPreviewableFiles', 'OtherFiles'],
  specialCharacters: ['NoPreference', 'Allowed', 'Disallowed'],
  restrictedSearch: ['Disabled', 'Enabled'],
  sharingState: ['Unspecified', 'On', 'Off'],
});

/** An enum value by name: a number (or a numeric string) is looked up, a name passes through. */
export function enumName(names, value) {
  if (Number.isInteger(value)) return names[value] ?? value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return names[Number(value)] ?? value;
  return value;
}

/** A .NET TimeSpan as seconds: ConvertTo-Json writes it as an object (Ticks, TotalSeconds),
 * a string "[d.]hh:mm:ss" passes through PowerShell's own text, a number is seconds. */
export function timeSpanSeconds(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'object' && !Array.isArray(value)) {
    if (Number.isFinite(value.TotalSeconds)) return Math.round(value.TotalSeconds);
    if (Number.isFinite(value.Ticks)) return Math.round(value.Ticks / 1e7);
    return value;
  }
  const match = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(String(value).trim());
  if (!match) return value;
  const [, days = '0', hours, minutes, seconds] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

const lowerSorted = (value) => (Array.isArray(value) ? [...new Set(value.map((item) => String(item).toLowerCase()))].sort() : value);

/** Copies `body` with each `convert[field]` applied to the fields it carries. */
const converting = (convert) => (body) => {
  const out = { ...body };
  for (const [field, fn] of Object.entries(convert)) if (out[field] !== undefined) out[field] = fn(out[field]);
  return out;
};

/**
 * The families, in the order the portal lists them: the tenant object, then the
 * narrower settings. Fields are from the PnP PowerShell and SharePoint Online tenant
 * administration documentation, grouped as the SharePoint admin center groups them.
 * Counters and usage totals (StorageQuotaAllocated and the like) are left out: they move
 * on their own and are not settings.
 */
export const FAMILIES = Object.freeze({
  tenantSettings: Object.freeze({
    operation: 'sharepoint-tenant.tenant', cmdlet: 'Get-PnPTenant', prefix: 'tenant-settings', identity: TENANT,
    fields: Object.freeze([
      // Sharing
      'SharingCapability', 'OneDriveSharingCapability', 'SharingDomainRestrictionMode', 'SharingAllowedDomainList', 'SharingBlockedDomainList',
      'DefaultSharingLinkType', 'DefaultLinkPermission', 'FileAnonymousLinkType', 'FolderAnonymousLinkType', 'RequireAnonymousLinksExpireInDays',
      'ExternalUserExpirationRequired', 'ExternalUserExpireInDays', 'EmailAttestationRequired', 'EmailAttestationReAuthDays',
      'RequireAcceptingAccountMatchInvitedAccount', 'PreventExternalUsersFromResharing', 'NotifyOwnersWhenItemsReshared',
      'BccExternalSharingInvitations', 'ShowEveryoneClaim', 'ShowEveryoneExceptExternalUsersClaim', 'ShowAllUsersClaim',
      'ShowPeoplePickerSuggestionsForGuestUsers', 'ODBAccessRequests', 'ODBMembersCanShare',
      // Access control
      'ConditionalAccessPolicy', 'AllowDownloadingNonWebViewableFiles', 'AllowEditing', 'LimitedAccessFileType',
      'IPAddressEnforcement', 'IPAddressAllowList', 'IPAddressWACTokenLifetime', 'LegacyAuthProtocolsEnabled',
      'DisableCustomAppAuthentication', 'DisallowInfectedFileDownload',
      // OneDrive
      'OrphanedPersonalSitesRetentionPeriod', 'OneDriveStorageQuota', 'NotificationsInOneDriveForBusinessEnabled',
      // Sites and pages
      'NoAccessRedirectUrl', 'CommentsOnSitePagesDisabled', 'SocialBarOnSitePagesDisabled', 'DisablePersonalListCreation',
      'DelayDenyAddAndCustomizePagesEnforcement', 'SearchResolveExactEmailOrUPN', 'SpecialCharactersStateInFileFolderNames',
      'DisabledWebPartIds', 'ExternalServicesEnabled', 'MarkNewFilesSensitiveByDefault', 'EnableAIPIntegration',
      // Loop and version history
      'IsLoopEnabled', 'EnableAutoExpirationVersionTrim', 'ExpireVersionsAfterDays', 'MajorVersionLimit',
    ]),
    prepare: converting({
      SharingCapability: (value) => enumName(ENUMS.sharing, value),
      OneDriveSharingCapability: (value) => enumName(ENUMS.sharing, value),
      SharingDomainRestrictionMode: (value) => enumName(ENUMS.domainMode, value),
      DefaultSharingLinkType: (value) => enumName(ENUMS.linkType, value),
      DefaultLinkPermission: (value) => enumName(ENUMS.linkPermission, value),
      FileAnonymousLinkType: (value) => enumName(ENUMS.anonymousLink, value),
      FolderAnonymousLinkType: (value) => enumName(ENUMS.anonymousLink, value),
      ConditionalAccessPolicy: (value) => enumName(ENUMS.conditionalAccess, value),
      LimitedAccessFileType: (value) => enumName(ENUMS.limitedAccessFiles, value),
      SpecialCharactersStateInFileFolderNames: (value) => enumName(ENUMS.specialCharacters, value),
      ODBAccessRequests: (value) => enumName(ENUMS.sharingState, value),
      ODBMembersCanShare: (value) => enumName(ENUMS.sharingState, value),
      DisabledWebPartIds: lowerSorted,
    }),
  }),
  syncClientRestriction: Object.freeze({
    operation: 'sharepoint-tenant.sync-client-restriction', cmdlet: 'Get-PnPTenantSyncClientRestriction', prefix: 'sync-client', identity: TENANT,
    fields: Object.freeze([
      'TenantRestrictionEnabled', 'AllowedDomainList', 'BlockMacSync', 'ExcludedFileExtensions', 'DisableReportProblemDialog',
      'OptOutOfGrooveBlock', 'OptOutOfGrooveSoftBlock',
    ]),
    prepare: converting({ AllowedDomainList: lowerSorted, ExcludedFileExtensions: lowerSorted }),
  }),
  browserIdleSignout: Object.freeze({
    operation: 'sharepoint-tenant.idle-sign-out', cmdlet: 'Get-PnPBrowserIdleSignout', prefix: 'idle-sign-out', identity: TENANT,
    fields: Object.freeze(['Enabled', 'WarnAfter', 'SignOutAfter']),
    prepare: converting({ WarnAfter: timeSpanSeconds, SignOutAfter: timeSpanSeconds }),
  }),
  restrictedSearchMode: Object.freeze({
    operation: 'sharepoint-tenant.restricted-search-mode', cmdlet: 'Get-PnPTenantRestrictedSearchMode', prefix: 'restricted-search', identity: TENANT, license: 'Microsoft 365 Copilot',
    fields: Object.freeze(['Mode']),
    // The cmdlet answers with the mode itself ("Enabled", or its enum number), or an object holding it.
    prepare: (body) => converting({ Mode: (value) => enumName(ENUMS.restrictedSearch, value) })(
      body !== null && typeof body === 'object' ? body : { Mode: body },
    ),
  }),
  restrictedSearchAllowedSites: Object.freeze({
    operation: 'sharepoint-tenant.restricted-search-allowed-sites', cmdlet: 'Get-PnPTenantRestrictedSearchAllowedList',
    prefix: 'restricted-search-sites', identity: TENANT, license: 'Microsoft 365 Copilot',
    fields: Object.freeze(['SiteUrls']),
    // The cmdlet answers with the allowed site URLs, one per item: kept as one sorted list.
    whole: true,
  }),
});
export const FAMILY_NAMES = Object.freeze(Object.keys(FAMILIES));
export const SHAREPOINT_TENANT_OPERATIONS = Object.freeze(FAMILY_NAMES.map((name) => FAMILIES[name].operation));

/** The registry descriptor. `enabledByDefault: false` until live qualification. */
export const SHAREPOINT_TENANT_DESCRIPTOR = Object.freeze({
  type: 'sharepointTenant',
  workload: SHAREPOINT_TENANT_WORKLOAD,
  adapter: 'sharepoint-tenant',
  readOnly: true,
  enabledByDefault: false,
  operations: SHAREPOINT_TENANT_OPERATIONS,
});

// The cmdlets this workload runs, none with a parameter.
// ops/powershell/run-cmdlet.ps1 ($AllowedPnPTenant) holds the same list and checks it again.
export const SHAREPOINT_TENANT_CMDLET_PARAMETERS = Object.freeze(Object.fromEntries(FAMILY_NAMES.map((name) => [FAMILIES[name].cmdlet, Object.freeze([])])));
export const SHAREPOINT_TENANT_CMDLETS = new Set(Object.keys(SHAREPOINT_TENANT_CMDLET_PARAMETERS));

export class SharePointTenantScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SharePointTenantScopeError';
  }
}

/** Throws unless the cmdlet is one of the five reads, with no parameters. */
export function assertSharePointTenantCmdlet({ cmdlet, parameters = {} }) {
  const allowed = SHAREPOINT_TENANT_CMDLET_PARAMETERS[cmdlet];
  if (!allowed) throw new SharePointTenantScopeError(`${cmdlet} is not a SharePoint tenant settings read KEEL runs; this workload never writes`);
  for (const name of Object.keys(parameters)) {
    if (!allowed.includes(name)) throw new SharePointTenantScopeError(`${cmdlet} does not take ${name} from KEEL`);
  }
  return true;
}

/** Runs one cmdlet through the bounded job transport. */
export async function sharePointTenantCmdlet({ cmdlet, parameters = {} }, powershell = {}) {
  assertSharePointTenantCmdlet({ cmdlet, parameters });
  const { tenantConfigPath = null, ...options } = powershell;
  return runCmdlet({ module: SHAREPOINT_TENANT_MODULE, cmdlet, parameters, tenantConfigPath }, { ...options, allowedCmdlets: SHAREPOINT_TENANT_CMDLETS });
}

/** The allowed site list as one object: URLs from strings or from objects carrying Url. */
function allowedSitesBody(output) {
  const urls = [];
  for (const item of output) {
    const url = typeof item === 'string' ? item : (item && typeof item === 'object' ? (item.Url ?? item.url ?? item.SiteUrl) : null);
    if (typeof url !== 'string' || !url.trim()) return null;
    urls.push(url.trim().replace(/\/+$/, '').toLowerCase());
  }
  return { SiteUrls: [...new Set(urls)].sort() };
}

async function readFamily(family, { powershell }) {
  const spec = FAMILIES[family];
  let output;
  try {
    ({ output } = await sharePointTenantCmdlet({ cmdlet: spec.cmdlet }, powershell));
  } catch (error) {
    // Restricted SharePoint Search comes with Microsoft 365 Copilot: a tenant without it may not offer the cmdlet.
    if (spec.license && notExposed(error)) {
      return emptyRead({
        unavailable: {
          family, operation: spec.operation, status: 'not-licensed', license: spec.license,
          reason: `${spec.cmdlet} is not available in this tenant: ${spec.license} is not licensed`, error: structuredFailure(error).error,
        },
      });
    }
    return emptyRead({ failure: { family, operation: spec.operation, ...structuredFailure(error) } });
  }
  let bodies;
  if (spec.whole) {
    const body = allowedSitesBody(output);
    // An answer KEEL cannot read as URLs is a failed read, never kept or counted as proof.
    if (!body) {
      return emptyRead({
        failure: { family, operation: spec.operation, status: 'failed', error: { code: 'BAD_ANSWER', message: `${spec.cmdlet} did not answer with site URLs` } },
      });
    }
    bodies = [body];
  } else {
    bodies = output.map((body) => (spec.prepare ? spec.prepare(body) : body));
  }
  return { ...emptyRead(), ...objectsFrom(family, spec, bodies, { maxObjects: 1 }) };
}

/**
 * Reads the named families (all by default). Pure apart from the injected PowerShell
 * options: no database, no gate. Callers outside tests use collectSharePointTenant.
 */
export async function readSharePointTenant({ powershell = {}, families = FAMILY_NAMES, skipped = [], now = () => new Date() }) {
  for (const family of families) if (!FAMILIES[family]) throw new TypeError(`unknown SharePoint tenant settings family ${family}`);
  const observedFrom = now().toISOString();
  const reads = {};
  for (const family of families) reads[family] = await readFamily(family, { powershell });
  // Every tenant has these settings, so an empty answer is a gap; the allowed site list
  // may be empty, and then it is read as an empty list.
  return summarize({
    workload: SHAREPOINT_TENANT_WORKLOAD, families, reads, skipped, maxObjects: 1,
    required: ['tenantSettings', 'syncClientRestriction', 'browserIdleSignout', 'restrictedSearchMode'],
    observedFrom, observedTo: now().toISOString(),
  });
}

/**
 * Whether live collection may run, per family: a family runs once its own read is
 * live-qualified and enabled. The others are listed as skipped (the run is partial).
 */
export function sharePointTenantActivation(ledger) {
  const { rows, describe } = ledgerRows(ledger);
  const families = FAMILY_NAMES.filter((name) => rows.get(FAMILIES[name].operation)?.enabled);
  const skipped = FAMILY_NAMES.filter((name) => !families.includes(name))
    .map((name) => ({ family: name, operation: FAMILIES[name].operation, reason: describe(FAMILIES[name].operation) }));
  return { enabled: families.length > 0, reasons: families.length ? [] : skipped.map((entry) => entry.reason), families, skipped };
}

export const recordSharePointTenantRun = (client, { tenantRef, result }) => recordCmdletRun(client, SHAREPOINT_TENANT_WORKLOAD, { tenantRef, result });

/** The gated entry point. Without qualification it records a `disabled` run and sends nothing. */
export async function collectSharePointTenant(client, { tenantRef, ledger, powershell, now }) {
  const activation = sharePointTenantActivation(ledger);
  if (!activation.enabled) {
    const run = await recordDisabledRun(client, SHAREPOINT_TENANT_WORKLOAD, { tenantRef, reasons: activation.reasons, now });
    return { run, result: null, activation };
  }
  const result = await readSharePointTenant({ powershell, families: activation.families, skipped: activation.skipped, now });
  const run = await recordSharePointTenantRun(client, { tenantRef, result });
  return { run, result, activation };
}

/** Registry adapter: a direct call is refused until the workload is enabled. */
export const sharePointTenantAdapter = Object.freeze({
  async collect() {
    throw new Error('the SharePoint tenant settings workload adapter is disabled until live qualification; use collectSharePointTenant with the ledger');
  },
});

registerWorkload(SHAREPOINT_TENANT_DESCRIPTOR, sharePointTenantAdapter);
