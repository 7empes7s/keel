/**
 * Exchange organization settings no other workload reads: the audit log switch, message
 * encryption (IRM and Purview Message Encryption), the perimeter and free/busy (availability)
 * settings, message classifications and policy tips, the room and equipment property
 * schema, and the partner applications and on-premises organization a hybrid set-up adds.
 *
 * A workload of its own (`exchange-org-config`), so turning it on never depends on, or
 * holds back, the other Exchange cmdlet workloads.
 *
 * Rules (the same as the other Exchange cmdlet workloads):
 *  - Read only. Only the Get cmdlets in FAMILIES run, with no parameters. No writer exists.
 *  - Declared fields only. Anything else an answer carries is dropped unread (the OME
 *    logo bytes, distinguished names). No declared field holds a secret; a
 *    credential-shaped value is still redacted.
 *  - Identity. Objects there can be many of are keyed by their Guid (it survives a
 *    rename). The organization-wide settings exist once per tenant and are keyed
 *    `organization`; a second answer that disagrees is a conflict, never a silent pick.
 *  - Errors are structured. A failed read is `failed` or `denied`, never an empty list.
 *  - Disabled until qualified. Nothing is sent unless the Exchange mailbox workload is
 *    qualified AND every read here is live-qualified and enabled.
 */
import { registerWorkload } from '../registry.mjs';
import { runCmdlet } from '../../powershell/jobQueue.mjs';
import { exchangeActivation, structuredFailure } from './exchange.mjs';
import {
  emptyRead, guidOf, ledgerRows, objectsFrom, recordCmdletRun, recordDisabledRun, summarize,
} from './cmdletFamilies.mjs';

export const EXCHANGE_ORG_CONFIG_WORKLOAD = 'exchange-org-config';
export const EXCHANGE_ORG_CONFIG_MODULE = 'ExchangeOnlineManagement';
export const DEFAULT_MAX_OBJECTS = 1000;

const WHEN = 'WhenChangedUTC';
const byGuid = (body) => guidOf(body.Guid);
// One object per tenant: the identity is the tenant itself.
const ORGANIZATION = 'organization';
const once = () => ORGANIZATION;

const family = (operation, cmdlet, prefix, identity, fields) => Object.freeze({
  operation: `${EXCHANGE_ORG_CONFIG_WORKLOAD}.${operation}`, cmdlet, prefix, identity, fields: Object.freeze(fields),
});

/**
 * The families, in the order a list shows them: audit first, then encryption, then
 * sharing free/busy, then labels shown to users, then hybrid. Fields were declared from
 * Microsoft's cmdlet documentation (the matching Set- parameters), not measured live;
 * the live read check confirms them.
 */
export const FAMILIES = Object.freeze({
  adminAuditLog: family('admin-audit-log', 'Get-AdminAuditLogConfig', 'admin-audit-log', once, [
    'Name', 'UnifiedAuditLogIngestionEnabled', 'AdminAuditLogEnabled', 'AdminAuditLogCmdlets', 'AdminAuditLogParameters',
    'AdminAuditLogExcludedCmdlets', 'AdminAuditLogAgeLimit', 'LogLevel', WHEN,
  ]),
  irm: family('irm', 'Get-IRMConfiguration', 'irm', once, [
    'AzureRMSLicensingEnabled', 'InternalLicensingEnabled', 'ExternalLicensingEnabled', 'SimplifiedClientAccessEnabled',
    'SimplifiedClientAccessEncryptOnlyDisabled', 'SimplifiedClientAccessDoNotForwardDisabled', 'DecryptAttachmentOnDownload',
    'EnablePdfEncryption', 'JournalReportDecryptionEnabled', 'ClientAccessServerEnabled', 'SearchEnabled', 'TransportDecryptionSetting',
    'EDiscoverySuperUserEnabled', 'RejectIfRecipientHasNoRights', 'AutomaticServiceUpdateEnabled', 'LicensingLocation', WHEN,
  ]),
  messageEncryption: family('message-encryption', 'Get-OMEConfiguration', 'ome', byGuid, [
    'Identity', 'BackgroundColor', 'DisclaimerText', 'EmailText', 'IntroductionText', 'PortalText', 'ReadButtonText',
    'PrivacyStatementUrl', 'ExternalMailExpiryInterval', 'OTPEnabled', 'SocialIdSignIn',
  ]),
  perimeter: family('perimeter', 'Get-PerimeterConfig', 'perimeter', once, [
    'Name', 'GatewayIPAddresses', 'InternalServerIPAddresses', WHEN,
  ]),
  availability: family('availability', 'Get-AvailabilityConfig', 'availability', once, [
    'Name', 'OrgWideAccount', 'PerUserAccount', WHEN,
  ]),
  availabilityAddressSpace: family('availability-address-spaces', 'Get-AvailabilityAddressSpace', 'availability-address-space', byGuid, [
    'Name', 'ForestName', 'AccessMethod', 'UseServiceAccount', 'ProxyUrl', 'TargetAutodiscoverEpr', WHEN,
  ]),
  messageClassification: family('message-classifications', 'Get-MessageClassification', 'message-classification', byGuid, [
    'Name', 'DisplayName', 'SenderDescription', 'RecipientDescription', 'ClassificationID', 'DisplayPrecedence',
    'PermissionMenuVisible', 'RetainClassificationEnabled', 'Locale', WHEN,
  ]),
  policyTip: family('policy-tips', 'Get-PolicyTipConfig', 'policy-tip', byGuid, [
    'Name', 'Action', 'Locale', 'Value', WHEN,
  ]),
  resourceConfig: family('resource-config', 'Get-ResourceConfig', 'resource-config', once, [
    'Name', 'ResourcePropertySchema', WHEN,
  ]),
  partnerApplication: family('partner-applications', 'Get-PartnerApplication', 'partner-application', byGuid, [
    'Name', 'Enabled', 'ApplicationIdentifier', 'Realm', 'AuthMetadataUrl', 'IssuerIdentifier', 'AcceptSecurityIdentifierInformation',
    'AccountType', 'LinkedAccount', WHEN,
  ]),
  onPremisesOrganization: family('on-premises-organizations', 'Get-OnPremisesOrganization', 'on-premises-organization', byGuid, [
    'Name', 'OrganizationName', 'OrganizationGuid', 'HybridDomains', 'InboundConnector', 'OutboundConnector',
    'OrganizationRelationship', 'Comment', WHEN,
  ]),
});
export const FAMILY_NAMES = Object.freeze(Object.keys(FAMILIES));
export const EXCHANGE_ORG_CONFIG_OPERATIONS = Object.freeze(FAMILY_NAMES.map((name) => FAMILIES[name].operation));
// Every Exchange Online tenant has these, so an empty answer is a gap, not "none set".
export const REQUIRED_FAMILIES = Object.freeze(['adminAuditLog', 'irm', 'messageEncryption', 'perimeter', 'resourceConfig']);

/** The registry descriptor. `enabledByDefault: false` until live qualification. */
export const EXCHANGE_ORG_CONFIG_DESCRIPTOR = Object.freeze({
  type: 'exchangeOrgConfig',
  workload: EXCHANGE_ORG_CONFIG_WORKLOAD,
  adapter: 'exchange-org-config',
  readOnly: true,
  enabledByDefault: false,
  operations: EXCHANGE_ORG_CONFIG_OPERATIONS,
});

// The only cmdlets this workload runs, none with parameters.
// ops/powershell/run-cmdlet.ps1 ($AllowedExchangeOrgConfig) holds the same list and checks it again.
export const EXCHANGE_ORG_CONFIG_CMDLET_PARAMETERS = Object.freeze(Object.fromEntries(FAMILY_NAMES.map((name) => [FAMILIES[name].cmdlet, Object.freeze([])])));
export const EXCHANGE_ORG_CONFIG_CMDLETS = new Set(Object.keys(EXCHANGE_ORG_CONFIG_CMDLET_PARAMETERS));

export class ExchangeOrgConfigScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExchangeOrgConfigScopeError';
  }
}

/** Throws unless the cmdlet is one of the reads above, given no parameters. */
export function assertExchangeOrgConfigCmdlet({ cmdlet, parameters = {} }) {
  const allowed = EXCHANGE_ORG_CONFIG_CMDLET_PARAMETERS[cmdlet];
  if (!allowed) throw new ExchangeOrgConfigScopeError(`${cmdlet} is not an Exchange organization setting read KEEL runs; this workload never writes`);
  for (const name of Object.keys(parameters)) {
    if (!allowed.includes(name)) throw new ExchangeOrgConfigScopeError(`${cmdlet} does not take ${name} from KEEL`);
  }
  return true;
}

/** Runs one cmdlet through the bounded job transport. */
export async function exchangeOrgConfigCmdlet({ cmdlet, parameters = {} }, powershell = {}) {
  assertExchangeOrgConfigCmdlet({ cmdlet, parameters });
  const { tenantConfigPath = null, ...options } = powershell;
  return runCmdlet({ module: EXCHANGE_ORG_CONFIG_MODULE, cmdlet, parameters, tenantConfigPath }, { ...options, allowedCmdlets: EXCHANGE_ORG_CONFIG_CMDLETS });
}

async function readFamily(name, { powershell, maxObjects }) {
  const spec = FAMILIES[name];
  let output;
  try {
    ({ output } = await exchangeOrgConfigCmdlet({ cmdlet: spec.cmdlet }, powershell));
  } catch (error) {
    return emptyRead({ failure: { family: name, operation: spec.operation, ...structuredFailure(error) } });
  }
  return { ...emptyRead(), ...objectsFrom(name, spec, output, { maxObjects }) };
}

/**
 * Reads the named families (all by default). Pure apart from the injected PowerShell
 * options: no database, no gate. Callers outside tests use collectExchangeOrgConfig.
 */
export async function readExchangeOrgConfig({ powershell = {}, families = FAMILY_NAMES, skipped = [], maxObjects = DEFAULT_MAX_OBJECTS, now = () => new Date() }) {
  for (const name of families) if (!FAMILIES[name]) throw new TypeError(`unknown Exchange organization setting family ${name}`);
  const observedFrom = now().toISOString();
  const reads = {};
  for (const name of families) reads[name] = await readFamily(name, { powershell, maxObjects });
  return summarize({
    workload: EXCHANGE_ORG_CONFIG_WORKLOAD, families, reads, skipped, required: [...REQUIRED_FAMILIES], maxObjects,
    observedFrom, observedTo: now().toISOString(),
  });
}

/**
 * Whether live collection may run. The Exchange mailbox workload must be qualified
 * first, and every read here must be live-qualified and enabled.
 */
export function exchangeOrgConfigActivation(ledger) {
  const { rows, describe } = ledgerRows(ledger);
  const reasons = [];
  const exchange = exchangeActivation(ledger);
  if (!exchange.enabled) reasons.push(`Exchange is not qualified yet, and these settings follow it: ${exchange.reasons.join('; ')}`);
  for (const id of EXCHANGE_ORG_CONFIG_OPERATIONS) if (!rows.get(id)?.enabled) reasons.push(describe(id));
  return { enabled: reasons.length === 0, reasons, families: [...FAMILY_NAMES], skipped: [] };
}

export const recordExchangeOrgConfigRun = (client, { tenantRef, result }) => recordCmdletRun(client, EXCHANGE_ORG_CONFIG_WORKLOAD, { tenantRef, result });

/** The gated entry point. Without qualification it records a `disabled` run and sends nothing. */
export async function collectExchangeOrgConfig(client, { tenantRef, ledger, powershell, maxObjects, now }) {
  const activation = exchangeOrgConfigActivation(ledger);
  if (!activation.enabled) {
    const run = await recordDisabledRun(client, EXCHANGE_ORG_CONFIG_WORKLOAD, { tenantRef, reasons: activation.reasons, now });
    return { run, result: null, activation };
  }
  const result = await readExchangeOrgConfig({ powershell, families: activation.families, maxObjects, now });
  const run = await recordExchangeOrgConfigRun(client, { tenantRef, result });
  return { run, result, activation };
}

/** Registry adapter: a direct call is refused until the workload is enabled. */
export const exchangeOrgConfigAdapter = Object.freeze({
  async collect() {
    throw new Error('the Exchange organization settings workload adapter is disabled until live qualification; use collectExchangeOrgConfig with the ledger');
  },
});

registerWorkload(EXCHANGE_ORG_CONFIG_DESCRIPTOR, exchangeOrgConfigAdapter);
