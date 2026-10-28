/**
 * The declarations of the Microsoft365DSC distribution list writer
 * (dscDistributionGroups.mjs): its workload, fields, the DSC allowlist and its two writes.
 * Kept apart, with no engine imports beyond the DSC module name and the trust-field rule,
 * so engine/coverage/qualification.mjs can spread the writes in without an import cycle
 * (the writer itself imports the evidence and dry-run modules, which import qualification).
 */
import { DSC_MODULE } from '../../powershell/dscJob.mjs';
import { isTrustField } from './writeDeclarations.mjs';

export const DISTRIBUTION_GROUPS_WORKLOAD = 'exchange-distribution-groups';
export const DISTRIBUTION_GROUP_FAMILY = 'distributionGroup';
export const DISTRIBUTION_GROUP_RESOURCE = 'EXODistributionGroup';
export const DISTRIBUTION_GROUP_UPDATE = 'exchange-distribution-groups.distribution-group.update';
export const DISTRIBUTION_GROUP_ADD = 'exchange-distribution-groups.distribution-group.add';
export const DSC_RESTORE_EVIDENCE_KIND = 'workload-restore';
// The read the backup comes from, which must be enabled for a write to run.
export const READ_BACK = 'exchange-distribution-groups.distribution-groups';
export const MAX_DSC_TARGETS = 50;

/** Settings KEEL writes on a list that exists. */
export const UPDATE_FIELDS = Object.freeze([
  'DisplayName', 'HiddenFromAddressListsEnabled', 'MemberJoinRestriction', 'MemberDepartRestriction',
  'RequireSenderAuthenticationEnabled', 'ModerationEnabled', 'SendModerationNotifications', 'SendOofMessageToOriginatorEnabled',
]);
/** What a re-created list is created with: its addresses, then the same settings. */
export const CREATE_FIELDS = Object.freeze(['Alias', 'PrimarySmtpAddress', ...UPDATE_FIELDS]);
/** Compared and listed for an administrator, never sent. */
export const LISTED_FIELDS = Object.freeze([
  'ManagedBy', 'ModeratedBy', 'GrantSendOnBehalfTo', 'AcceptMessagesOnlyFromSendersOrMembers', 'RejectMessagesFromSendersOrMembers',
  'EmailAddresses',
]);
// What each listed field decides, in plain words.
export const LISTED_WHY = Object.freeze({
  ManagedBy: 'who owns the list (owners can change its members)',
  ModeratedBy: 'who approves messages to the list',
  GrantSendOnBehalfTo: 'who may send on behalf of the list',
  AcceptMessagesOnlyFromSendersOrMembers: 'who may send to the list',
  RejectMessagesFromSendersOrMembers: 'who may not send to the list',
  EmailAddresses: 'the list\'s other addresses',
  Alias: 'the list\'s alias (part of its address)',
  PrimarySmtpAddress: 'the list\'s main address',
});
// Backed-up settings this resource does not carry; listed when a re-created list had them set.
export const NOT_CARRIED = Object.freeze(['ReportToManagerEnabled', 'ReportToOriginatorEnabled', 'BypassModerationFromSendersOrMembers', 'MailTip']);
/**
 * Read, never sent: the members and the settings KEEL does not write. A Set must leave
 * them as they were, and the live capture checks that it does.
 */
export const OBSERVED_ONLY = Object.freeze(['Members', ...NOT_CARRIED, 'BypassNestedModerationEnabled']);

/** The allowlist the DSC job transport and run-dsc.ps1 hold (a test keeps them equal). */
export const DSC_RESOURCES = Object.freeze({
  [DISTRIBUTION_GROUP_RESOURCE]: Object.freeze({
    properties: Object.freeze(['Identity', 'Name', 'Ensure', 'DisplayName', 'Alias', 'PrimarySmtpAddress', 'Type', ...UPDATE_FIELDS.slice(1), ...LISTED_FIELDS, ...OBSERVED_ONLY]),
    writable: Object.freeze(['Identity', 'Name', 'Ensure', 'DisplayName', 'Alias', 'PrimarySmtpAddress', 'Type', ...UPDATE_FIELDS.slice(1)]),
  }),
});

// Exchange recipient type -> the EXODistributionGroup Type KEEL can create.
export const DISTRIBUTION_GROUP_TYPES = Object.freeze({ MailUniversalDistributionGroup: 'Distribution', MailUniversalSecurityGroup: 'Security' });

const EXO_RBAC = Object.freeze({ permissions: Object.freeze(['Exchange.ManageAsApp']), roles: Object.freeze(['Exchange Administrator']) });
const DOCS = 'https://learn.microsoft.com/en-us/powershell/module/exchangepowershell';
function declare(id, { name, fields, method, source }) {
  const trust = fields.filter((field) => isTrustField('exchangeDistributionGroup', field));
  if (trust.length) throw new Error(`${id}: ${trust.join(', ')} decide trust or sign-in and are never written`);
  return [id, Object.freeze({
    workload: DISTRIBUTION_GROUPS_WORKLOAD, family: DISTRIBUTION_GROUP_FAMILY, resourceType: 'exchangeDistributionGroup',
    kind: 'cmdlet', module: DSC_MODULE, session: 'dsc', resource: DISTRIBUTION_GROUP_RESOURCE, method, name, readBack: READ_BACK,
    fields: Object.freeze([...fields]), rbac: EXO_RBAC, grantsRequired: true, source,
  })];
}

/**
 * The two writes, in the shape of WORKLOAD_WRITE_OPERATIONS (coverage/qualification.mjs
 * spreads them in). `kind: 'cmdlet'` with module Microsoft365DSC binds each proof to the
 * pinned Microsoft365DSC version. Field names follow Microsoft's Set-DistributionGroup and
 * New-DistributionGroup documentation, which EXODistributionGroup mirrors; the live
 * capture records any name the module does not have.
 */
export const DSC_WRITE_OPERATIONS = Object.freeze(Object.fromEntries([
  declare(DISTRIBUTION_GROUP_UPDATE, {
    name: 'Distribution list settings', method: 'EXODistributionGroup Set (existing list)', fields: UPDATE_FIELDS,
    source: `${DOCS}/set-distributiongroup`,
  }),
  declare(DISTRIBUTION_GROUP_ADD, {
    name: 'Distribution lists that no longer exist', method: 'EXODistributionGroup Set (Ensure Present, new list)', fields: ['Name', 'Type', ...CREATE_FIELDS],
    source: `${DOCS}/new-distributiongroup`,
  }),
]));
