/**
 * Exchange recipients and mailbox permissions: what Microsoft Graph cannot read or
 * write, so a lost distribution list or a shared mailbox's delegates could not be put
 * back from a Keel backup before.
 *
 * Two read-only workloads, in the Exchange Online session, so each lands in its own
 * group on the portal's lists:
 *  - `exchange-distribution-groups` ("Groups and address lists"): distribution lists and
 *    mail-enabled security groups (Get-DistributionGroup), dynamic distribution lists
 *    (Get-DynamicDistributionGroup) and the Exchange settings of Microsoft 365 groups
 *    (Get-UnifiedGroup: hidden from the address book, who may send, send on behalf).
 *    Members are not read here: Graph lists these groups and their members, and the
 *    Entra group backup already keeps them (matched by ExternalDirectoryObjectId).
 *  - `exchange-recipients` ("Mailboxes"): shared, room and equipment mailboxes
 *    (Get-Mailbox -RecipientTypeDetails), mail contacts (Get-MailContact), Send As
 *    rights on every recipient (Get-RecipientPermission, one call), Full Access and the
 *    other mailbox rights on each shared, room and equipment mailbox
 *    (Get-MailboxPermission -Identity <Guid>), and each room's and equipment's booking
 *    rules (Get-CalendarProcessing -Identity <Guid>). Send on behalf is a mailbox field
 *    (GrantSendOnBehalfTo).
 *
 * Rules (the same as the other Exchange cmdlet workloads):
 *  - Read only, configuration only. Only the Get cmdlets in each workload's
 *    CMDLET_PARAMETERS run. Fixed parameters take only the value KEEL set
 *    (ResultSize Unlimited, one RecipientTypeDetails); -Identity takes only a Guid a
 *    mailbox read answered in the same run. No mail, folder or calendar item is read.
 *  - Declared fields only. Anything else an answer carries is dropped unread. A
 *    credential-shaped value is redacted.
 *  - Identity is the Guid (it survives a rename; the name is kept as a field). Send As
 *    rights are kept per recipient, as Exchange names it in the answer; a mailbox's
 *    rights and booking rules are kept under the mailbox's Guid.
 *  - Inherited rights and the mailbox's own right on itself (NT AUTHORITY\SELF) are
 *    defaults, not settings, and are left out, so only what an admin granted is kept.
 *  - Errors are structured. A family that fails is `failed` or `denied`, never an empty list.
 *  - Disabled until qualified. Nothing is sent unless the Exchange mailbox workload is
 *    qualified AND every read of the workload is live-qualified and enabled.
 */
import { registerWorkload } from '../registry.mjs';
import { runCmdlet } from '../../powershell/jobQueue.mjs';
import { exchangeActivation, structuredFailure } from './exchange.mjs';
import {
  emptyRead, guidOf, ledgerRows, objectsFrom, recordCmdletRun, recordDisabledRun, summarize,
} from './cmdletFamilies.mjs';

export const EXCHANGE_DISTRIBUTION_GROUPS_WORKLOAD = 'exchange-distribution-groups';
export const EXCHANGE_RECIPIENTS_WORKLOAD = 'exchange-recipients';
export const EXCHANGE_RECIPIENTS_MODULE = 'ExchangeOnlineManagement';
export const DEFAULT_MAX_OBJECTS = 1000;

const ALL = Object.freeze({ ResultSize: 'Unlimited' });
const SELF = 'nt authority\\self';
const WHEN = 'WhenChangedUTC';
const byGuid = (body) => guidOf(body?.Guid);
const byMailbox = (body) => guidOf(body?.Mailbox);
// A recipient as Get-RecipientPermission names it (administrator text, bounded).
// eslint-disable-next-line no-control-regex
const NAME = /^[^\u0000-\u001f\u007f]{1,512}$/;
const byRecipientName = (body) => {
  const name = typeof body?.Identity === 'string' ? body.Identity.trim() : '';
  return NAME.test(name) ? name.toLowerCase() : null;
};

// Who may send to a recipient, and who may send for it: shared by every recipient kind.
const DELIVERY = Object.freeze([
  'RequireSenderAuthenticationEnabled', 'AcceptMessagesOnlyFromSendersOrMembers', 'RejectMessagesFromSendersOrMembers',
  'HiddenFromAddressListsEnabled', 'GrantSendOnBehalfTo',
]);
const ADDRESS = Object.freeze(['Name', 'DisplayName', 'Alias', 'PrimarySmtpAddress', 'EmailAddresses']);
const MODERATION = Object.freeze(['ModerationEnabled', 'ModeratedBy', 'BypassModerationFromSendersOrMembers', 'SendModerationNotifications']);

const MAILBOX_FIELDS = Object.freeze([
  ...ADDRESS, 'RecipientTypeDetails', 'ExternalDirectoryObjectId', ...DELIVERY,
  'MessageCopyForSentAsEnabled', 'MessageCopyForSendOnBehalfEnabled', 'ForwardingAddress', 'ForwardingSmtpAddress',
  'DeliverToMailboxAndForward', 'ResourceCapacity', 'MailTip', WHEN,
]);
const mailbox = (type, operation, prefix) => Object.freeze({
  operation, cmdlet: 'Get-Mailbox', parameters: Object.freeze({ RecipientTypeDetails: type, ...ALL }), prefix, identity: byGuid,
  fields: MAILBOX_FIELDS,
});

/** One sorted list of rows, so the same rights read twice compare equal. */
const sortedRows = (rows) => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const rights = (value) => (Array.isArray(value) ? [...value].map(String).sort() : value == null ? [] : String(value).split(/,\s*/).sort());
// A switch can serialize as {"IsPresent": true} rather than true.
const flag = (value) => value === true || value?.IsPresent === true;
/** A row an admin granted: not inherited and not the mailbox's own SELF right. */
const granted = (row, who) => row && typeof row === 'object' && !flag(row.IsInherited)
  && !(typeof row[who] === 'string' && row[who].trim().toLowerCase() === SELF);
/** Who a granted row names, or null when it names no one KEEL can store. */
const principal = (value) => (typeof value === 'string' && NAME.test(value.trim()) ? value.trim() : null);

/** Get-RecipientPermission rows, one body per recipient: who may send as it. */
function sendAsByRecipient(output) {
  const byRecipient = new Map();
  for (const row of output) {
    if (!granted(row, 'Trustee')) continue;
    const key = byRecipientName(row);
    // A row with no usable recipient or trustee stays a body of its own, so it is counted as unidentified.
    if (!key || !principal(row.Trustee)) { byRecipient.set(Symbol('unidentified'), { Identity: null }); continue; }
    const body = byRecipient.get(key) ?? { Identity: row.Identity.trim(), Trustees: [] };
    body.Trustees.push({ Trustee: row.Trustee, AccessRights: rights(row.AccessRights), AccessControlType: row.AccessControlType ?? null });
    byRecipient.set(key, body);
  }
  return [...byRecipient.values()].map((body) => (body.Trustees ? { ...body, Trustees: sortedRows(body.Trustees) } : body));
}

/** Get-MailboxPermission rows for one mailbox, as one body: the rights an admin granted. */
function mailboxRights(output, parent) {
  const rows = output.filter((row) => granted(row, 'User'));
  // A granted row that names no user cannot be stored: the mailbox's rights are then
  // not known in full, so its entry is left out and counted as unidentified.
  if (rows.some((row) => !principal(row.User))) return [{ Mailbox: null }];
  return [{
    Mailbox: parent.identity,
    Permissions: sortedRows(rows.map((row) => ({ User: principal(row.User), AccessRights: rights(row.AccessRights), Deny: flag(row.Deny) }))),
  }];
}

/** Get-CalendarProcessing for one room or equipment mailbox: one body, under the mailbox. */
// Exchange answers exactly one object per mailbox; none is a gap, counted as unidentified.
const bookingRules = (output, parent) => (output.length ? [{ ...output[0], Mailbox: parent.identity }] : [{ Mailbox: null }]);

/** Distribution lists, dynamic distribution lists and Microsoft 365 group mail settings. */
export const DISTRIBUTION_GROUP_FAMILIES = Object.freeze({
  distributionGroup: Object.freeze({
    operation: 'exchange-distribution-groups.distribution-groups', cmdlet: 'Get-DistributionGroup', parameters: ALL,
    prefix: 'distribution-group', identity: byGuid,
    fields: Object.freeze([
      ...ADDRESS, 'RecipientTypeDetails', 'ExternalDirectoryObjectId', 'ManagedBy', 'MemberJoinRestriction', 'MemberDepartRestriction',
      ...DELIVERY, ...MODERATION, 'ReportToManagerEnabled', 'ReportToOriginatorEnabled', 'SendOofMessageToOriginatorEnabled', 'MailTip', WHEN,
    ]),
  }),
  dynamicDistributionGroup: Object.freeze({
    operation: 'exchange-distribution-groups.dynamic-distribution-groups', cmdlet: 'Get-DynamicDistributionGroup', parameters: ALL,
    prefix: 'dynamic-distribution-group', identity: byGuid,
    fields: Object.freeze([
      ...ADDRESS, 'RecipientFilter', 'IncludedRecipients', 'ConditionalCompany', 'ConditionalDepartment', 'ConditionalStateOrProvince',
      'ConditionalCustomAttribute1', 'ConditionalCustomAttribute2', 'RecipientContainer', 'ManagedBy', ...DELIVERY, ...MODERATION, 'MailTip', WHEN,
    ]),
  }),
  microsoft365Group: Object.freeze({
    operation: 'exchange-distribution-groups.microsoft-365-groups', cmdlet: 'Get-UnifiedGroup', parameters: ALL,
    prefix: 'microsoft-365-group', identity: byGuid,
    fields: Object.freeze([
      ...ADDRESS, 'ExternalDirectoryObjectId', 'AccessType', 'HiddenFromExchangeClientsEnabled', ...DELIVERY, ...MODERATION,
      'AutoSubscribeNewMembers', 'AlwaysSubscribeMembersToCalendarEvents', 'SubscriptionEnabled', 'Language', 'MailTip', WHEN,
    ]),
  }),
});

/**
 * Shared, room and equipment mailboxes, mail contacts and the rights on them. Parents
 * come before the families read once per parent (`parentFamily`, `perParent`).
 */
export const RECIPIENT_FAMILIES = Object.freeze({
  sharedMailbox: mailbox('SharedMailbox', 'exchange-recipients.shared-mailboxes', 'shared-mailbox'),
  roomMailbox: mailbox('RoomMailbox', 'exchange-recipients.room-mailboxes', 'room-mailbox'),
  equipmentMailbox: mailbox('EquipmentMailbox', 'exchange-recipients.equipment-mailboxes', 'equipment-mailbox'),
  mailContact: Object.freeze({
    operation: 'exchange-recipients.mail-contacts', cmdlet: 'Get-MailContact', parameters: ALL, prefix: 'mail-contact', identity: byGuid,
    fields: Object.freeze([...ADDRESS, 'ExternalEmailAddress', ...DELIVERY, 'MailTip', WHEN]),
  }),
  mailboxPermission: Object.freeze({
    operation: 'exchange-recipients.mailbox-permissions', cmdlet: 'Get-MailboxPermission', prefix: 'mailbox-permission', identity: byMailbox,
    parentFamily: Object.freeze(['sharedMailbox', 'roomMailbox', 'equipmentMailbox']), perParent: 'Identity', shape: mailboxRights,
    fields: Object.freeze(['Mailbox', 'Permissions']),
  }),
  sendAs: Object.freeze({
    operation: 'exchange-recipients.send-as', cmdlet: 'Get-RecipientPermission', parameters: ALL, prefix: 'send-as', identity: byRecipientName,
    shape: sendAsByRecipient, fields: Object.freeze(['Identity', 'Trustees']),
  }),
  calendarProcessing: Object.freeze({
    operation: 'exchange-recipients.calendar-processing', cmdlet: 'Get-CalendarProcessing', prefix: 'calendar-processing', identity: byMailbox,
    parentFamily: Object.freeze(['roomMailbox', 'equipmentMailbox']), perParent: 'Identity', shape: bookingRules,
    fields: Object.freeze([
      'Mailbox', 'AutomateProcessing', 'AllowConflicts', 'AllowRecurringMeetings', 'BookingWindowInDays', 'MaximumDurationInMinutes',
      'MinimumDurationInMinutes', 'EnforceSchedulingHorizon', 'ScheduleOnlyDuringWorkHours', 'ConflictPercentageAllowed', 'MaximumConflictInstances',
      'ForwardRequestsToDelegates', 'ResourceDelegates', 'AllBookInPolicy', 'BookInPolicy', 'AllRequestInPolicy', 'RequestInPolicy',
      'AllRequestOutOfPolicy', 'RequestOutOfPolicy', 'TentativePendingApproval', 'ProcessExternalMeetingMessages', 'AddOrganizerToSubject',
      'DeleteSubject', 'DeleteComments', 'DeleteAttachments', 'RemovePrivateProperty', 'DeleteNonCalendarItems', 'OrganizerInfo',
      'AddAdditionalResponse', 'AdditionalResponse', 'EnableResponseDetails',
    ]),
  }),
});

export class ExchangeRecipientsScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExchangeRecipientsScopeError';
  }
}

/**
 * The cmdlets a workload runs and the parameter names each may receive. The container
 * (ops/powershell/run-cmdlet.ps1, $AllowedExchangeRecipients) holds the union of both.
 */
function cmdletParameters(families) {
  const allowed = {};
  for (const spec of Object.values(families)) {
    const names = new Set(allowed[spec.cmdlet] ?? []);
    for (const name of Object.keys(spec.parameters ?? {})) names.add(name);
    if (spec.perParent) names.add(spec.perParent);
    allowed[spec.cmdlet] = names;
  }
  return Object.freeze(Object.fromEntries(Object.entries(allowed).map(([cmdlet, names]) => [cmdlet, Object.freeze([...names])])));
}

/** The values KEEL fixes for each cmdlet's parameters (every one but -Identity). */
function fixedValues(families) {
  const values = {};
  for (const spec of Object.values(families)) {
    for (const [name, value] of Object.entries(spec.parameters ?? {})) {
      ((values[spec.cmdlet] ??= {})[name] ??= new Set()).add(value);
    }
  }
  return values;
}

/**
 * One read-only workload over `families`. Returns its descriptor, allowlist, reader,
 * activation, recorder and gated collector, the same shape as exchangeRoleGroups.mjs.
 */
function recipientWorkload({ workload, type, families, label }) {
  const names = Object.freeze(Object.keys(families));
  const operations = Object.freeze(names.map((name) => families[name].operation));
  const parameters = cmdletParameters(families);
  const cmdlets = new Set(Object.keys(parameters));
  const fixed = fixedValues(families);

  const descriptor = Object.freeze({ type, workload, adapter: workload, readOnly: true, enabledByDefault: false, operations });

  /** Throws unless the cmdlet is one of the reads above, with only its own parameters and values. */
  function assertCmdlet({ cmdlet, parameters: given = {} }) {
    const allowed = parameters[cmdlet];
    if (!allowed) throw new ExchangeRecipientsScopeError(`${cmdlet} is not an Exchange ${label} read KEEL runs; this workload never writes or reads mail`);
    for (const [name, value] of Object.entries(given)) {
      if (!allowed.includes(name)) throw new ExchangeRecipientsScopeError(`${cmdlet} does not take ${name} from KEEL`);
      if (name === 'Identity') {
        if (!guidOf(value)) throw new ExchangeRecipientsScopeError('Identity must be a mailbox Guid KEEL read');
      } else if (!fixed[cmdlet]?.[name]?.has(value)) {
        throw new ExchangeRecipientsScopeError(`${cmdlet} -${name} takes only ${[...(fixed[cmdlet]?.[name] ?? [])].join(' or ')}`);
      }
    }
    return true;
  }

  async function cmdletCall({ cmdlet, parameters: given = {} }, powershell = {}) {
    assertCmdlet({ cmdlet, parameters: given });
    const { tenantConfigPath = null, ...options } = powershell;
    return runCmdlet({ module: EXCHANGE_RECIPIENTS_MODULE, cmdlet, parameters: given, tenantConfigPath }, { ...options, allowedCmdlets: cmdlets });
  }

  async function call(family, given, powershell) {
    const { cmdlet, operation } = families[family];
    try {
      const { output } = await cmdletCall({ cmdlet, parameters: given }, powershell);
      return { output };
    } catch (error) {
      return { failure: { family, operation, ...(given.Identity ? { parameters: given } : {}), ...structuredFailure(error) } };
    }
  }

  /** A whole-tenant family: one call. */
  async function readFamily(family, { powershell, maxObjects }) {
    const spec = families[family];
    const answer = await call(family, spec.parameters ?? {}, powershell);
    if (answer.failure) return emptyRead({ failure: answer.failure });
    const bodies = spec.shape ? spec.shape(answer.output) : answer.output;
    return { ...emptyRead(), ...objectsFrom(family, spec, bodies, { maxObjects }) };
  }

  /**
   * A family read once per parent mailbox. A failed call fails that mailbox's entry
   * only; every other mailbox is still read. Calls stop at the object cap.
   */
  async function readPerParent(family, parents, { powershell, maxObjects }) {
    const spec = families[family];
    const read = { ...emptyRead(), failures: [] };
    const kept = new Map();
    const count = { value: 0 };
    for (const parent of parents) {
      if (count.value >= maxObjects) { read.capped = true; break; }
      const answer = await call(family, { [spec.perParent]: parent.identity }, powershell);
      if (answer.failure) { read.failures.push({ ...answer.failure, parent: parent.resourceKey }); continue; }
      const part = objectsFrom(family, spec, spec.shape(answer.output, parent), {
        maxObjects, kept, count, extra: () => ({ parent: parent.identity, parentStatus: 'found' }),
      });
      read.resources.push(...part.resources);
      read.conflicts.push(...part.conflicts);
      read.unidentified += part.unidentified;
      read.capped ||= part.capped;
    }
    if (parents.length > 0 && read.failures.length === parents.length) {
      const [first] = read.failures;
      return { ...read, failure: { family, operation: spec.operation, status: first.status, error: first.error, parents: read.failures.length } };
    }
    return read;
  }

  /** Reads the named families (all by default). Pure apart from the injected PowerShell options. */
  async function read({ powershell = {}, families: wanted = names, skipped = [], maxObjects = DEFAULT_MAX_OBJECTS, now = () => new Date() } = {}) {
    for (const family of wanted) if (!families[family]) throw new TypeError(`unknown Exchange ${label} family ${family}`);
    const observedFrom = now().toISOString();
    const reads = {};
    // Parents before children: the families are declared in that order.
    for (const family of names.filter((name) => wanted.includes(name))) {
      const spec = families[family];
      if (!spec.perParent) {
        reads[family] = await readFamily(family, { powershell, maxObjects });
        continue;
      }
      // A parent family that was not read leaves its children unread, which is a gap.
      const parentReads = spec.parentFamily.map((parent) => reads[parent]);
      if (parentReads.some((parent) => !parent || parent.failure || parent.capped)) {
        const missing = spec.parentFamily.filter((parent, index) => !parentReads[index] || parentReads[index].failure || parentReads[index].capped);
        reads[family] = emptyRead({
          failure: { family, operation: spec.operation, status: 'failed', error: { code: 'PARENT_NOT_READ', message: `not read because ${missing.join(', ')} was not read in full` } },
        });
        continue;
      }
      reads[family] = await readPerParent(family, parentReads.flatMap((parent) => parent.resources), { powershell, maxObjects });
    }
    // No family is required: a tenant may have no distribution list or shared mailbox.
    return summarize({ workload, families: wanted, reads, skipped, maxObjects, observedFrom, observedTo: now().toISOString() });
  }

  /** Whether live collection may run: Exchange first, then every read of this workload. */
  function activation(ledger) {
    const { rows, describe } = ledgerRows(ledger);
    const reasons = [];
    const exchange = exchangeActivation(ledger);
    if (!exchange.enabled) reasons.push(`Exchange is not qualified yet, and ${label} follow it: ${exchange.reasons.join('; ')}`);
    for (const id of operations) if (!rows.get(id)?.enabled) reasons.push(describe(id));
    return { enabled: reasons.length === 0, reasons, families: [...names], skipped: [] };
  }

  const record = (client, { tenantRef, result }) => recordCmdletRun(client, workload, { tenantRef, result });

  /** The gated entry point. Without qualification it records a `disabled` run and sends nothing. */
  async function collect(client, { tenantRef, ledger, powershell, maxObjects, now }) {
    const gate = activation(ledger);
    if (!gate.enabled) {
      const run = await recordDisabledRun(client, workload, { tenantRef, reasons: gate.reasons, now });
      return { run, result: null, activation: gate };
    }
    const result = await read({ powershell, families: gate.families, maxObjects, now });
    const run = await record(client, { tenantRef, result });
    return { run, result, activation: gate };
  }

  /** Registry adapter: a direct call is refused until the workload is enabled. */
  const adapter = Object.freeze({
    async collect() {
      throw new Error(`the Exchange ${label} workload adapter is disabled until live qualification; use its collector with the ledger`);
    },
  });
  registerWorkload(descriptor, adapter);

  return Object.freeze({
    workload, families, familyNames: names, operations, descriptor, cmdletParameters: parameters, assertCmdlet, read, activation, record, collect,
  });
}

export const DISTRIBUTION_GROUPS = recipientWorkload({
  workload: EXCHANGE_DISTRIBUTION_GROUPS_WORKLOAD, type: 'exchangeDistributionGroups', families: DISTRIBUTION_GROUP_FAMILIES,
  label: 'distribution list',
});
export const RECIPIENTS = recipientWorkload({
  workload: EXCHANGE_RECIPIENTS_WORKLOAD, type: 'exchangeRecipients', families: RECIPIENT_FAMILIES, label: 'recipient',
});

export const readExchangeDistributionGroups = (options) => DISTRIBUTION_GROUPS.read(options);
export const readExchangeRecipients = (options) => RECIPIENTS.read(options);
export const collectExchangeDistributionGroups = (client, options) => DISTRIBUTION_GROUPS.collect(client, options);
export const collectExchangeRecipients = (client, options) => RECIPIENTS.collect(client, options);
export const recordExchangeDistributionGroupsRun = (client, options) => DISTRIBUTION_GROUPS.record(client, options);
export const recordExchangeRecipientsRun = (client, options) => RECIPIENTS.record(client, options);
export const exchangeDistributionGroupsActivation = (ledger) => DISTRIBUTION_GROUPS.activation(ledger);
export const exchangeRecipientsActivation = (ledger) => RECIPIENTS.activation(ledger);

/** Both workloads' cmdlets and parameter names: what run-cmdlet.ps1 must allow. */
export const EXCHANGE_RECIPIENTS_CMDLET_PARAMETERS = Object.freeze(Object.fromEntries(
  [...new Set([...Object.keys(DISTRIBUTION_GROUPS.cmdletParameters), ...Object.keys(RECIPIENTS.cmdletParameters)])].map((cmdlet) => [
    cmdlet, Object.freeze([...new Set([...(DISTRIBUTION_GROUPS.cmdletParameters[cmdlet] ?? []), ...(RECIPIENTS.cmdletParameters[cmdlet] ?? [])])]),
  ]),
));
