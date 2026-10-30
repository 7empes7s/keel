/**
 * The declarations of the Exchange admin role writer (exchangeRoleDefinitions.mjs): its
 * workload, its one write and the cmdlets it may run. Kept apart, with no engine imports
 * beyond the trust-field rule, so engine/coverage/qualification.mjs can spread the write
 * in without an import cycle (the writer imports the evidence and dry-run modules, which
 * import qualification).
 *
 * Microsoft Graph lists and gets Exchange management roles (beta
 * /roleManagement/exchange/roleDefinitions) but cannot create one, so the writer uses
 * Exchange Online PowerShell: New-ManagementRole copies the chosen entries from a parent
 * role, and the new role's entries are then trimmed to the backup (an entry the backup
 * does not have is removed, a parameter it does not have is removed from its entry).
 */
import { isTrustField } from './writeDeclarations.mjs';

export const EXCHANGE_ROLES_WORKLOAD = 'exchange-role-definitions';
export const EXCHANGE_ROLE_RESOURCE_TYPE = 'exchangeRoleDefinition';
export const EXCHANGE_ROLE_ADD = 'exchange-role-definitions.role.add';
export const EXCHANGE_ROLE_EVIDENCE_KIND = 'workload-restore';
export const EXCHANGE_ROLE_MODULE = 'ExchangeOnlineManagement';
// The Exchange admin role read (Get-RoleGroup) must be enabled for the write to run. The
// writer's own role reads (Get-ManagementRole, Get-ManagementRoleEntry) run in the same
// session with the same grants, and the write's live capture exercises them.
export const EXCHANGE_ROLE_READ_BACK = 'exchange-role-groups.role-groups';
export const MAX_ROLE_TARGETS = 25;

/** What New-ManagementRole is sent: the role's name, its parent, its description and the cmdlets copied from the parent. */
export const CREATE_FIELDS = Object.freeze(['Name', 'Parent', 'Description', 'EnabledCmdlets']);

/**
 * The cmdlets this writer runs and the parameters each may take. ops/powershell/run-cmdlet.ps1
 * holds the same two tables ($AllowedExchangeRoleReads, $AllowedExchangeRoleWrites; a test
 * keeps them equal) and checks each entry identity names one role entry, never a wildcard.
 * Set- and Remove-ManagementRoleEntry run only on a role this writer created in the same
 * operation (exchangeRoleDefinitions.mjs checks it before each call).
 */
export const ROLE_READ_CMDLETS = Object.freeze({
  'Get-ManagementRole': Object.freeze([]),
  'Get-ManagementRoleEntry': Object.freeze(['Identity']),
});
export const ROLE_WRITE_CMDLETS = Object.freeze({
  'New-ManagementRole': Object.freeze([...CREATE_FIELDS]),
  'Set-ManagementRoleEntry': Object.freeze(['Identity', 'Parameters', 'RemoveParameter']),
  'Remove-ManagementRoleEntry': Object.freeze(['Identity', 'Confirm']),
});

const EXO_RBAC = Object.freeze({ permissions: Object.freeze(['Exchange.ManageAsApp']), roles: Object.freeze(['Exchange Administrator']) });

function declare(id, { name, method, fields, source }) {
  const trust = fields.filter((field) => isTrustField(EXCHANGE_ROLE_RESOURCE_TYPE, field));
  if (trust.length) throw new Error(`${id}: ${trust.join(', ')} decide trust or sign-in and are never written`);
  return [id, Object.freeze({
    workload: EXCHANGE_ROLES_WORKLOAD, family: 'managementRole', resourceType: EXCHANGE_ROLE_RESOURCE_TYPE,
    kind: 'cmdlet', module: EXCHANGE_ROLE_MODULE, session: 'exo', method, name, readBack: EXCHANGE_ROLE_READ_BACK,
    fields: Object.freeze([...fields]), rbac: EXO_RBAC, grantsRequired: true, source,
  })];
}

/**
 * The one write, in the shape of WORKLOAD_WRITE_OPERATIONS (coverage/qualification.mjs
 * spreads it in). Fields follow Microsoft's New-ManagementRole documentation; the live
 * capture records whether Exchange Online takes them.
 */
export const EXCHANGE_ROLE_WRITE_OPERATIONS = Object.freeze(Object.fromEntries([
  declare(EXCHANGE_ROLE_ADD, {
    name: 'Custom Exchange admin roles that no longer exist',
    method: 'New-ManagementRole (from the parent role), then Set- and Remove-ManagementRoleEntry on the new role',
    fields: CREATE_FIELDS,
    source: 'https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/new-managementrole',
  }),
]));
