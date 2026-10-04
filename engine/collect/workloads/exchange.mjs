/**
 * Roadmap task-105: the Exchange mailbox and organization configuration read adapter.
 * For each mailbox it is configured to cover, it reads three distinct observations:
 *  - mailbox settings (automatic replies, time zone, language, working hours, date
 *    and time formats, delegate meeting delivery) through Graph mailboxSettings;
 *  - client access (OWA, ActiveSync, POP, IMAP, MAPI, EWS, SMTP AUTH) through
 *    Get-CASMailbox;
 *  - hold and retention state (litigation hold, retention hold, single item recovery,
 *    deleted item retention, and the holds Purview owns) through Get-Mailbox.
 * Once per run it may also read the organization's Exchange configuration through
 * Get-OrganizationConfig. That is its own observation, never mixed into a mailbox.
 *
 * Rules:
 *  - Configuration only, no content enumeration. Every Graph request must match
 *    EXCHANGE_REQUEST_SHAPES (the mailboxSettings path, no query) and every cmdlet
 *    must be in EXCHANGE_CMDLETS with only its listed parameters. Messages, folders,
 *    inbox rules, calendars, contacts, folder statistics, searches and exports are
 *    never requested. Mailboxes are named in configuration; nothing enumerates the
 *    tenant's mailboxes.
 *  - Bounded PowerShell argument transport. A cmdlet call is a JSON job whose
 *    parameters are data (engine/powershell/jobQueue.mjs runCmdlet); a mailbox
 *    identity, however it is quoted, stays one argument and is never placed in
 *    script source.
 *  - Errors are structured. A cmdlet error, a non-zero exit or a malformed answer is
 *    recorded as `failed` (or `denied`) with { code, cmdlet, message, category,
 *    errorId }, never as an empty success. An empty successful answer is `unknown`.
 *  - Disabled until qualified. collectExchange() sends nothing unless Teams (and so
 *    SharePoint) is qualified AND every Exchange read is live-qualified and enabled
 *    in the task-101 ledger. Fixture tests drive readExchange() directly.
 */
import { registerWorkload } from '../registry.mjs';
import { WORKLOAD_DESCRIPTORS, readGraphConfiguration } from '../workloadContract.mjs';
import { CmdletError, runCmdlet } from '../../powershell/jobQueue.mjs';
import { teamsActivation } from './teams.mjs';

export const EXCHANGE_WORKLOAD = 'exchange-mailbox-settings';
export const EXCHANGE_MODULE = 'ExchangeOnlineManagement';
export const DEFAULT_MAX_MAILBOXES = 50;

const operation = (id) => WORKLOAD_DESCRIPTORS.find((descriptor) => descriptor.id === id);
export const EXCHANGE_OPERATIONS = Object.freeze([
  'exchange.mailbox-settings', 'exchange.client-access', 'exchange.mailbox-hold', 'exchange.organization-config',
]);

/** The registry descriptor. `enabledByDefault: false` until live qualification. */
export const EXCHANGE_DESCRIPTOR = Object.freeze({
  type: 'exchangeMailbox',
  workload: EXCHANGE_WORKLOAD,
  adapter: 'exchange-mailbox-settings',
  readOnly: true,
  enabledByDefault: false,
  operations: EXCHANGE_OPERATIONS,
});

// What each observation keeps. Anything else in an answer is dropped unread.
export const MAILBOX_SETTING_FIELDS = Object.freeze([
  'automaticRepliesSetting', 'timeZone', 'language', 'workingHours', 'dateFormat', 'timeFormat',
  'delegateMeetingMessageDeliveryOptions', 'userPurpose',
]);
export const CLIENT_ACCESS_FIELDS = Object.freeze([
  'OWAEnabled', 'ActiveSyncEnabled', 'PopEnabled', 'ImapEnabled', 'MAPIEnabled', 'EwsEnabled', 'SmtpClientAuthenticationDisabled',
]);
// Holds Purview or an administrator owns. Observed, never written by KEEL.
export const COMPLIANCE_HOLD_FIELDS = Object.freeze(['InPlaceHolds', 'ComplianceTagHoldApplied', 'DelayHoldApplied', 'DelayReleaseHoldApplied', 'LitigationHoldDuration']);
export const RETENTION_FIELDS = Object.freeze([
  'LitigationHoldEnabled', 'RetentionHoldEnabled', 'SingleItemRecoveryEnabled', 'RetainDeletedItemsFor', ...COMPLIANCE_HOLD_FIELDS,
]);
export const ORGANIZATION_FIELDS = Object.freeze([
  'FocusedInboxOn', 'MailTipsAllTipsEnabled', 'MailTipsExternalRecipientsTipsEnabled', 'MailTipsGroupMetricsEnabled',
  'MailTipsLargeAudienceThreshold', 'OAuth2ClientProfileEnabled', 'SmtpActionableMessagesEnabled', 'ConnectorsEnabled',
]);
export const EXCHANGE_GROUPS = Object.freeze({
  mailboxSettings: Object.freeze({ fields: MAILBOX_SETTING_FIELDS, operation: 'exchange.mailbox-settings' }),
  clientAccess: Object.freeze({ fields: CLIENT_ACCESS_FIELDS, operation: 'exchange.client-access', cmdlet: 'Get-CASMailbox' }),
  retention: Object.freeze({ fields: RETENTION_FIELDS, operation: 'exchange.mailbox-hold', cmdlet: 'Get-Mailbox' }),
  organization: Object.freeze({ fields: ORGANIZATION_FIELDS, operation: 'exchange.organization-config', cmdlet: 'Get-OrganizationConfig' }),
});
// Mailbox content. Never requested, never stored, never counted as configuration.
export const EXCHANGE_EXCLUDED_CONTENT = Object.freeze([
  'messages', 'mailFolders', 'messageRules', 'archiveFolder', 'inferenceClassification', 'calendar', 'events',
  'contacts', 'attachments', 'folderStatistics', 'mailboxStatistics',
]);

// The only cmdlets this workload runs, and the only parameters each may receive.
// ops/powershell/run-cmdlet.ps1 holds the same list and checks it again.
export const EXCHANGE_CMDLET_PARAMETERS = Object.freeze({
  'Get-OrganizationConfig': Object.freeze([]),
  'Get-Mailbox': Object.freeze(['Identity']),
  'Get-CASMailbox': Object.freeze(['Identity']),
  'Set-CASMailbox': Object.freeze(['Identity', ...CLIENT_ACCESS_FIELDS]),
  'Set-Mailbox': Object.freeze(['Identity', 'LitigationHoldEnabled', 'RetentionHoldEnabled', 'SingleItemRecoveryEnabled', 'RetainDeletedItemsFor']),
  'Set-OrganizationConfig': Object.freeze([...ORGANIZATION_FIELDS]),
});
export const EXCHANGE_CMDLETS = new Set(Object.keys(EXCHANGE_CMDLET_PARAMETERS));

export const EXCHANGE_REQUEST_SHAPES = Object.freeze([
  { method: 'GET', path: /^\/v1\.0\/users\/[^/]+\/mailboxSettings$/ },
  { method: 'PATCH', path: /^\/v1\.0\/users\/[^/]+\/mailboxSettings$/ },
]);

export class ExchangeScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExchangeScopeError';
  }
}

/** Throws unless the request is the mailboxSettings configuration shape. */
export function assertExchangeRequest(url, method = 'GET') {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://graph.microsoft.com') throw new ExchangeScopeError(`${url} is not a Microsoft Graph request`);
  const path = decodeURIComponent(parsed.pathname);
  if (!EXCHANGE_REQUEST_SHAPES.some((shape) => shape.method === method && shape.path.test(path))) {
    throw new ExchangeScopeError(`${method} ${path} is not an Exchange configuration request; mail, folders, rules and calendars are never read`);
  }
  if ([...parsed.searchParams.keys()].length) throw new ExchangeScopeError(`${method} ${path}: no query is allowed (no $expand, $select or filter into content)`);
  return true;
}

/** Throws unless the cmdlet and every parameter name are allowlisted. */
export function assertExchangeCmdlet({ cmdlet, parameters = {} }) {
  const allowed = EXCHANGE_CMDLET_PARAMETERS[cmdlet];
  if (!allowed) throw new ExchangeScopeError(`${cmdlet} is not an Exchange configuration cmdlet KEEL runs; content, searches and exports are never read`);
  for (const name of Object.keys(parameters)) {
    if (!allowed.includes(name)) throw new ExchangeScopeError(`${cmdlet} does not take ${name} from KEEL`);
  }
  return true;
}

/**
 * A mailbox identity as an operator names it: a UPN, alias or object id. It may
 * contain quotes (o'brien@contoso.com), which is why it is never put in script
 * source. Control characters and absurd lengths are refused.
 */
export function mailboxIdentity(value) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 320) {
    throw new TypeError('a mailbox identity is a non-empty string of at most 320 characters with no surrounding space');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new TypeError('a mailbox identity cannot contain control characters');
  return value;
}

export const mailboxKey = (identity) => `mailbox:${identity.toLowerCase()}`;

/**
 * Runs one Exchange cmdlet through the bounded job transport. `powershell` holds
 * runCmdlet options (image, tenantConfigPath, spawnFn for tests).
 */
export async function exchangeCmdlet({ cmdlet, parameters = {} }, powershell = {}) {
  assertExchangeCmdlet({ cmdlet, parameters });
  const { tenantConfigPath = null, ...options } = powershell;
  return runCmdlet({ module: EXCHANGE_MODULE, cmdlet, parameters, tenantConfigPath }, { ...options, allowedCmdlets: EXCHANGE_CMDLETS });
}

const AUTHZ = /access (is )?denied|forbidden|unauthori[sz]ed|insufficient|not authorized|does not have permission|PermissionDenied|isn't within your current write scope|isn't in your scope/i;

/** The structured failure a coverage entry and an evidence row record. */
export function structuredFailure(error) {
  if (error instanceof CmdletError) {
    const denied = AUTHZ.test(`${error.detail.category ?? ''} ${error.detail.errorId ?? ''} ${error.detail.message ?? ''}`);
    return { status: denied ? 'denied' : 'failed', error: { ...error.detail } };
  }
  const httpStatus = Number.isInteger(error?.status) ? error.status : null;
  return {
    status: httpStatus === 401 || httpStatus === 403 ? 'denied' : 'failed',
    error: { code: httpStatus ? `HTTP_${httpStatus}` : 'ERROR', cmdlet: null, message: String(error?.message ?? error), category: null, errorId: null, httpStatus },
  };
}

/** Reads one cmdlet group for one identity (or the organization). */
async function readCmdletGroup(group, identity, powershell) {
  const { cmdlet, fields, operation: op } = EXCHANGE_GROUPS[group];
  const parameters = identity === null ? {} : { Identity: identity };
  const { output } = await exchangeCmdlet({ cmdlet, parameters }, powershell);
  if (output.length > 1) {
    throw new CmdletError(`${cmdlet}: ${output.length} objects answered one identity`, {
      code: 'AMBIGUOUS_IDENTITY', cmdlet, message: `${output.length} objects matched; KEEL reads exactly one`, category: null, errorId: null, exitCode: 0, stderr: null, jobId: null,
    });
  }
  const [body] = output;
  return { body: body ?? null, fields, operation: op };
}

function observe(entry, prefix, { body, fields, operation: op }) {
  const values = {};
  for (const field of fields) {
    const key = `${prefix}.${field}`;
    if (!body) {
      entry.fieldCoverage[key] = { status: 'unknown', operation: op, reason: 'the read succeeded and returned no object' };
      continue;
    }
    const value = body[field];
    values[field] = value ?? null;
    entry.fieldCoverage[key] = { status: value === undefined ? 'unknown' : 'observed', operation: op };
  }
  entry.fields[prefix] = body ? values : null;
}

function observeFailure(entry, prefix, fields, op, error) {
  const failed = structuredFailure(error);
  for (const field of fields) entry.fieldCoverage[`${prefix}.${field}`] = { ...failed, operation: op };
}

/** Reads one mailbox's three observations. Used by the reader and by the restore. */
export async function readMailbox({ identity, transport, powershell, sleep, groups = ['mailboxSettings', 'clientAccess', 'retention'] }) {
  mailboxIdentity(identity);
  const entry = { identity, fields: {}, fieldCoverage: {} };
  for (const group of groups) {
    const { fields, operation: op } = EXCHANGE_GROUPS[group];
    try {
      if (group === 'mailboxSettings') {
        const guarded = async (url, init) => { assertExchangeRequest(url, init?.method ?? 'GET'); return transport(url, init); };
        const { items: [body = null] } = await readGraphConfiguration(operation(op), { transport: guarded, sleep, substitute: { 'user-id': identity } });
        observe(entry, group, { body, fields, operation: op });
      } else {
        observe(entry, group, await readCmdletGroup(group, identity, powershell));
      }
    } catch (error) {
      if (error instanceof ExchangeScopeError) {
        // The identity would leave the configuration path (a `/` in it, say). Nothing was sent.
        const refused = { status: 'refused', error: { code: 'OUT_OF_SCOPE', cmdlet: null, message: error.message, category: null, errorId: null }, operation: op };
        for (const field of fields) entry.fieldCoverage[`${group}.${field}`] = refused;
        continue;
      }
      observeFailure(entry, group, fields, op, error);
    }
  }
  return entry;
}

/** Reads the organization configuration observation. */
export async function readOrganization({ powershell }) {
  const entry = { identity: null, fields: {}, fieldCoverage: {} };
  const { fields, operation: op } = EXCHANGE_GROUPS.organization;
  try {
    observe(entry, 'organization', await readCmdletGroup('organization', null, powershell));
  } catch (error) {
    observeFailure(entry, 'organization', fields, op, error);
  }
  return entry;
}

/**
 * Reads the named mailboxes and, optionally, the organization. Pure apart from the
 * injected Graph transport and PowerShell options: no database, no gate. Callers
 * outside tests use collectExchange.
 */
export async function readExchange({
  transport, powershell = {}, mailboxes = [], includeOrganization = true, maxMailboxes = DEFAULT_MAX_MAILBOXES, sleep, now = () => new Date(),
}) {
  if (!Array.isArray(mailboxes)) throw new TypeError('mailboxes must be a list of mailbox identities');
  const observedFrom = now().toISOString();
  const seen = new Set();
  const named = [];
  const outOfScope = [];
  let capped = false;
  for (const identity of mailboxes) {
    mailboxIdentity(identity);
    if (seen.has(identity.toLowerCase())) continue;
    if (named.length >= maxMailboxes) { capped = true; outOfScope.push({ identity, reason: `more than ${maxMailboxes} mailboxes were named` }); continue; }
    seen.add(identity.toLowerCase());
    named.push(identity);
  }

  const resources = [];
  for (const identity of named) {
    const entry = await readMailbox({ identity, transport, powershell, sleep });
    resources.push({ resourceKey: mailboxKey(identity), ...entry });
  }
  if (includeOrganization) resources.push({ resourceKey: 'organization', ...(await readOrganization({ powershell })) });

  const statuses = resources.flatMap((entry) => Object.values(entry.fieldCoverage).map((coverage) => coverage.status));
  const fieldCounts = statuses.reduce((counts, status) => ({ ...counts, [status]: (counts[status] ?? 0) + 1 }), {});
  let outcome;
  if (resources.length === 0) outcome = 'complete-empty';
  else if (!statuses.includes('observed')) outcome = 'failed';
  else if (capped || statuses.some((status) => status !== 'observed')) outcome = 'partial';
  else outcome = 'complete';

  return {
    workload: EXCHANGE_WORKLOAD,
    outcome,
    observedFrom,
    observedTo: now().toISOString(),
    discovery: { mailboxes: named.length, organization: includeOrganization, capped, maxMailboxes },
    resources,
    outOfScope,
    fieldCounts,
  };
}

/**
 * Whether live collection may run. Teams, the workload before Exchange (which itself
 * follows SharePoint), must be qualified first, and every Exchange read must be
 * live-qualified and enabled on its own evidence.
 */
export function exchangeActivation(ledger) {
  const rows = new Map((ledger?.rows ?? []).map((row) => [row.id, row]));
  const reasons = [];
  const teams = teamsActivation(ledger);
  if (!teams.enabled) reasons.push(`Teams is not qualified yet, and Exchange follows it: ${teams.reasons.join('; ')}`);
  for (const id of EXCHANGE_OPERATIONS) {
    const row = rows.get(id);
    if (!row?.enabled) reasons.push(`${id} is ${row?.state ?? 'not in the ledger'}${row?.prerequisite ? `: ${row.prerequisite.message}` : ''}`);
  }
  return { enabled: reasons.length === 0, reasons };
}

/** Persists one run in one transaction; one row per mailbox and one for the organization. */
export async function recordExchangeRun(client, { tenantRef, result }) {
  await client.query('BEGIN');
  try {
    const { rows: [run] } = await client.query(
      `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, digest)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tenantRef, EXCHANGE_WORKLOAD, result.outcome, result.observedFrom, result.observedTo, {
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
        [run.id, resource.resourceKey, { identity: resource.identity, ...resource.fields }, resource.fieldCoverage],
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
export async function collectExchange(client, { tenantRef, ledger, transport, powershell, mailboxes, includeOrganization, maxMailboxes, sleep, now }) {
  const activation = exchangeActivation(ledger);
  if (!activation.enabled) {
    const at = (now?.() ?? new Date()).toISOString();
    const run = await recordExchangeRun(client, {
      tenantRef,
      result: { outcome: 'disabled', observedFrom: at, observedTo: at, reasons: activation.reasons },
    });
    return { run, result: null, activation };
  }
  const result = await readExchange({ transport, powershell, mailboxes, includeOrganization, maxMailboxes, sleep, now });
  const run = await recordExchangeRun(client, { tenantRef, result });
  return { run, result, activation };
}

/** Registry adapter: a direct call is refused until the workload is enabled. */
export const exchangeAdapter = Object.freeze({
  async collect() {
    throw new Error('the Exchange workload adapter is disabled until live qualification; use collectExchange with the ledger');
  },
});

registerWorkload(EXCHANGE_DESCRIPTOR, exchangeAdapter);
