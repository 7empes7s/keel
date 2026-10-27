/**
 * Exchange admin role groups (Get-RoleGroup): Organization Management, Recipient
 * Management, Help Desk and the tenant's own groups, with the roles each grants and who
 * is in it.
 *
 * A workload of its own (`exchange-role-groups`), beside the Exchange admin roles and
 * role assignments read from Microsoft Graph (catalogue types exchangeRoleDefinition and
 * exchangeRoleAssignment). Graph names a role group in an assignment only by path
 * ("/RoleGroups/<id>"); this read is what turns that id into the group's name, and keeps
 * a record of the group to rebuild from.
 *
 * Rules (the same as the other Exchange cmdlet workloads):
 *  - Read only. Only Get-RoleGroup runs, with no parameters. No writer exists.
 *  - Declared fields only. Anything else an answer carries is dropped unread. Members
 *    and ManagedBy are names Exchange returns, never a credential.
 *  - Identity is the Guid (it survives a rename; the name is kept as a field).
 *  - Errors are structured. A failed read is `failed` or `denied`, never an empty list.
 *  - Disabled until qualified. Nothing is sent unless the Exchange mailbox workload is
 *    qualified AND this read is live-qualified and enabled. So a new tenant, or this
 *    code reaching a tenant before its live capture, changes nothing else Keel reads.
 */
import { registerWorkload } from '../registry.mjs';
import { runCmdlet } from '../../powershell/jobQueue.mjs';
import { exchangeActivation, structuredFailure } from './exchange.mjs';
import {
  emptyRead, guidOf, ledgerRows, objectsFrom, recordCmdletRun, recordDisabledRun, summarize,
} from './cmdletFamilies.mjs';

export const EXCHANGE_ROLE_GROUPS_WORKLOAD = 'exchange-role-groups';
export const EXCHANGE_ROLE_GROUPS_MODULE = 'ExchangeOnlineManagement';
export const DEFAULT_MAX_OBJECTS = 1000;

const byGuid = (body) => guidOf(body.Guid);

/** The family. Fields are from Microsoft's Get-RoleGroup documentation. */
export const FAMILIES = Object.freeze({
  roleGroup: Object.freeze({
    operation: 'exchange-role-groups.role-groups', cmdlet: 'Get-RoleGroup', prefix: 'role-group', identity: byGuid,
    fields: Object.freeze([
      'Name', 'DisplayName', 'Description', 'RoleGroupType', 'Roles', 'Members', 'ManagedBy', 'ExchangeObjectId', 'WhenChangedUTC',
    ]),
  }),
});
export const FAMILY_NAMES = Object.freeze(Object.keys(FAMILIES));
export const EXCHANGE_ROLE_GROUPS_OPERATIONS = Object.freeze(FAMILY_NAMES.map((name) => FAMILIES[name].operation));

/** The registry descriptor. `enabledByDefault: false` until live qualification. */
export const EXCHANGE_ROLE_GROUPS_DESCRIPTOR = Object.freeze({
  type: 'exchangeRoleGroups',
  workload: EXCHANGE_ROLE_GROUPS_WORKLOAD,
  adapter: 'exchange-role-groups',
  readOnly: true,
  enabledByDefault: false,
  operations: EXCHANGE_ROLE_GROUPS_OPERATIONS,
});

// The only cmdlet this workload runs, with no parameters.
// ops/powershell/run-cmdlet.ps1 ($AllowedExchangeRoleGroups) holds the same list and checks it again.
export const EXCHANGE_ROLE_GROUPS_CMDLET_PARAMETERS = Object.freeze({ 'Get-RoleGroup': Object.freeze([]) });
export const EXCHANGE_ROLE_GROUPS_CMDLETS = new Set(Object.keys(EXCHANGE_ROLE_GROUPS_CMDLET_PARAMETERS));

export class ExchangeRoleGroupsScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExchangeRoleGroupsScopeError';
  }
}

/** Throws unless the cmdlet is Get-RoleGroup with no parameters. */
export function assertExchangeRoleGroupsCmdlet({ cmdlet, parameters = {} }) {
  const allowed = EXCHANGE_ROLE_GROUPS_CMDLET_PARAMETERS[cmdlet];
  if (!allowed) throw new ExchangeRoleGroupsScopeError(`${cmdlet} is not an Exchange role group read KEEL runs; this workload never writes`);
  for (const name of Object.keys(parameters)) {
    if (!allowed.includes(name)) throw new ExchangeRoleGroupsScopeError(`${cmdlet} does not take ${name} from KEEL`);
  }
  return true;
}

/** Runs one cmdlet through the bounded job transport. */
export async function exchangeRoleGroupsCmdlet({ cmdlet, parameters = {} }, powershell = {}) {
  assertExchangeRoleGroupsCmdlet({ cmdlet, parameters });
  const { tenantConfigPath = null, ...options } = powershell;
  return runCmdlet({ module: EXCHANGE_ROLE_GROUPS_MODULE, cmdlet, parameters, tenantConfigPath }, { ...options, allowedCmdlets: EXCHANGE_ROLE_GROUPS_CMDLETS });
}

async function readFamily(family, { powershell, maxObjects }) {
  const spec = FAMILIES[family];
  let output;
  try {
    ({ output } = await exchangeRoleGroupsCmdlet({ cmdlet: spec.cmdlet }, powershell));
  } catch (error) {
    return emptyRead({ failure: { family, operation: spec.operation, ...structuredFailure(error) } });
  }
  return { ...emptyRead(), ...objectsFrom(family, spec, output, { maxObjects }) };
}

/**
 * Reads the named families (all by default). Pure apart from the injected PowerShell
 * options: no database, no gate. Callers outside tests use collectExchangeRoleGroups.
 */
export async function readExchangeRoleGroups({ powershell = {}, families = FAMILY_NAMES, skipped = [], maxObjects = DEFAULT_MAX_OBJECTS, now = () => new Date() }) {
  for (const family of families) if (!FAMILIES[family]) throw new TypeError(`unknown Exchange role group family ${family}`);
  const observedFrom = now().toISOString();
  const reads = {};
  for (const family of families) reads[family] = await readFamily(family, { powershell, maxObjects });
  // Every tenant has Microsoft's built-in role groups, so an empty answer is a gap.
  return summarize({
    workload: EXCHANGE_ROLE_GROUPS_WORKLOAD, families, reads, skipped, required: ['roleGroup'], maxObjects,
    observedFrom, observedTo: now().toISOString(),
  });
}

/**
 * Whether live collection may run. The Exchange mailbox workload must be qualified
 * first, and this read must be live-qualified and enabled.
 */
export function exchangeRoleGroupsActivation(ledger) {
  const { rows, describe } = ledgerRows(ledger);
  const reasons = [];
  const exchange = exchangeActivation(ledger);
  if (!exchange.enabled) reasons.push(`Exchange is not qualified yet, and role groups follow it: ${exchange.reasons.join('; ')}`);
  for (const id of EXCHANGE_ROLE_GROUPS_OPERATIONS) if (!rows.get(id)?.enabled) reasons.push(describe(id));
  return { enabled: reasons.length === 0, reasons, families: [...FAMILY_NAMES], skipped: [] };
}

export const recordExchangeRoleGroupsRun = (client, { tenantRef, result }) => recordCmdletRun(client, EXCHANGE_ROLE_GROUPS_WORKLOAD, { tenantRef, result });

/** The gated entry point. Without qualification it records a `disabled` run and sends nothing. */
export async function collectExchangeRoleGroups(client, { tenantRef, ledger, powershell, maxObjects, now }) {
  const activation = exchangeRoleGroupsActivation(ledger);
  if (!activation.enabled) {
    const run = await recordDisabledRun(client, EXCHANGE_ROLE_GROUPS_WORKLOAD, { tenantRef, reasons: activation.reasons, now });
    return { run, result: null, activation };
  }
  const result = await readExchangeRoleGroups({ powershell, families: activation.families, maxObjects, now });
  const run = await recordExchangeRoleGroupsRun(client, { tenantRef, result });
  return { run, result, activation };
}

/** Registry adapter: a direct call is refused until the workload is enabled. */
export const exchangeRoleGroupsAdapter = Object.freeze({
  async collect() {
    throw new Error('the Exchange role group workload adapter is disabled until live qualification; use collectExchangeRoleGroups with the ledger');
  },
});

registerWorkload(EXCHANGE_ROLE_GROUPS_DESCRIPTOR, exchangeRoleGroupsAdapter);
