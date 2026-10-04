// Roadmap task-105: Exchange mailbox configuration adapter.
//
// Acceptance:
//  - a quoted hostile mailbox identifier remains one argument;
//  - unknown RBAC blocks writes;
//  - no content enumeration;
//  - output errors persist structured;
//  - a hold-releasing operation refuses without qualified approval.
// Mutation checks:
//  - interpolate the mailbox identity into script source;
//  - treat a cmdlet exit error as an empty success;
//  - bypass the hold effect guard.
//
// Everything runs against the isolated test database, an in-memory Graph and a fake
// PowerShell container that plays the ops/powershell/run-cmdlet.ps1 contract through
// the real engine/powershell/jobQueue.mjs spawn path. No tenant or mailbox is touched.
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { grantRole } from '../authz/administration.mjs';
import {
  CLIENT_ACCESS_FIELDS, EXCHANGE_CMDLET_PARAMETERS, EXCHANGE_OPERATIONS, ExchangeScopeError, MAILBOX_SETTING_FIELDS, ORGANIZATION_FIELDS,
  RETENTION_FIELDS, assertExchangeCmdlet, assertExchangeRequest, collectExchange, exchangeActivation, readExchange, recordExchangeRun,
} from '../collect/workloads/exchange.mjs';
import { SHAREPOINT_OPERATIONS } from '../collect/workloads/sharepoint.mjs';
import { TEAMS_OPERATIONS } from '../collect/workloads/teams.mjs';
import { scopeProblems } from '../collect/workloadContract.mjs';
import { buildCoverageReport } from '../coverage/report.mjs';
import { workloadWriteQualification } from '../coverage/qualification.mjs';
import { cmdletJob } from '../powershell/jobQueue.mjs';
import { planDeletionWaves, planWaves } from '../restore/wavePlanner.mjs';
import {
  EXCHANGE_CLIENT_ACCESS_WRITE, EXCHANGE_MAILBOX_SETTINGS_WRITE, EXCHANGE_ORGANIZATION_WRITE, EXCHANGE_RESTORE_EVIDENCE_KIND,
  EXCHANGE_RETENTION_WRITE, EXCHANGE_WRITE_OPERATIONS, createExchangeRestoreArtifact, executeExchangeRestore, loadExchangeSource,
  planExchangeRestore, readLiveExchange,
} from '../restore/workloads/exchange.mjs';
import { approveContentEffects, contentEffectsDigest } from '../safety/contentEffects.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
    schemaReady = true;
  }
  return client;
}

const NOW = new Date('2026-10-04T12:00:00Z');
const TENANT = '00000000-0000-4000-8000-0000000000c1';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000000f2';
const MAILBOX = 'keel-rt-fixture@contoso.test';
const MODULE_VERSION = '3.5.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';
// Identities a careless transport would turn into PowerShell. Each is legal to name.
const HOSTILE = Object.freeze([
  "o'brien@contoso.test",
  "alice'; Remove-Mailbox -Identity bob -Confirm:$false; '",
  '"bob" -Identity carol',
  '$(Remove-Mailbox carol)',
  'dave`; Set-Mailbox -LitigationHoldEnabled:$false',
]);

let tenantSeq = 0;
const nextTenant = () => `sha256:task-105-${tenantSeq += 1}`;

const SETTINGS = Object.freeze({
  automaticRepliesSetting: { status: 'disabled', externalAudience: 'none', internalReplyMessage: '', externalReplyMessage: '' },
  timeZone: 'UTC', language: { locale: 'en-US', displayName: 'English (United States)' },
  workingHours: { daysOfWeek: ['monday', 'tuesday'], startTime: '08:00:00.0000000', endTime: '17:00:00.0000000', timeZone: { name: 'UTC' } },
  dateFormat: 'yyyy-MM-dd', timeFormat: 'HH:mm', delegateMeetingMessageDeliveryOptions: 'sendToDelegateOnly', userPurpose: 'user',
});
const CAS = Object.freeze({
  OWAEnabled: true, ActiveSyncEnabled: true, PopEnabled: false, ImapEnabled: false, MAPIEnabled: true, EwsEnabled: true, SmtpClientAuthenticationDisabled: true,
});
const RETENTION = Object.freeze({
  LitigationHoldEnabled: false, RetentionHoldEnabled: false, SingleItemRecoveryEnabled: true, RetainDeletedItemsFor: '14.00:00:00',
  InPlaceHolds: [], ComplianceTagHoldApplied: false, DelayHoldApplied: false, DelayReleaseHoldApplied: false, LitigationHoldDuration: 'Unlimited',
});
const ORGANIZATION = Object.freeze({
  FocusedInboxOn: true, MailTipsAllTipsEnabled: true, MailTipsExternalRecipientsTipsEnabled: false, MailTipsGroupMetricsEnabled: true,
  MailTipsLargeAudienceThreshold: 25, OAuth2ClientProfileEnabled: true, SmtpActionableMessagesEnabled: true, ConnectorsEnabled: true,
});

function mailboxState(overrides = {}) {
  return {
    settings: { ...structuredClone(SETTINGS), ...structuredClone(overrides.settings ?? {}) },
    cas: { ...CAS, ...(overrides.cas ?? {}) },
    retention: { ...structuredClone(RETENTION), ...structuredClone(overrides.retention ?? {}) },
  };
}

// The cmdlet allowlist the container enforces, parsed from the script it ships.
function containerAllowlist() {
  const script = readFileSync(new URL('../../ops/powershell/run-cmdlet.ps1', import.meta.url), 'utf8');
  const block = /\$Allowed = @\{([\s\S]*?)\n\}/.exec(script)[1];
  return Object.fromEntries([...block.matchAll(/'([A-Za-z-]+)'\s*=\s*@\(([^)]*)\)/g)]
    .map(([, name, list]) => [name, [...list.matchAll(/'([A-Za-z0-9]+)'/g)].map((match) => match[1])]));
}
const ALLOWLIST = containerAllowlist();

/**
 * A fake Exchange: an in-memory Graph for mailboxSettings and a fake container behind
 * the real jobQueue spawn path. The container plays run-cmdlet.ps1: it accepts only
 * { mode: 'cmdlet', cmdlet, parameters } with an allowlisted cmdlet and parameter
 * names, and binds parameters by splatting, so each value is exactly one argument.
 * `hooks.cmdlet({ cmdlet, args, state })` may return 'crash', 'timeout',
 * 'apply-then-timeout', { error } or { output } to override a call.
 */
function fakeExchange({ mailboxes = { [MAILBOX]: mailboxState() }, organization = ORGANIZATION, hooks = {} } = {}) {
  const state = { mailboxes: structuredClone(mailboxes), organization: structuredClone(organization) };
  const requests = [];
  const jobs = [];
  const calls = [];
  const argv = [];
  let contentCalls = 0;
  const json = (body, status = 200) => ({ status, headers: {}, body });

  async function transport(url, init) {
    const method = init?.method ?? 'GET';
    const parsed = new URL(url);
    requests.push({ url, method, body: init?.body ?? null });
    if (/messages|mailFolders|messageRules|calendar|events|contacts|inferenceClassification|\$expand/i.test(parsed.pathname + parsed.search)) {
      contentCalls += 1;
      return json({ value: [{ id: 'msg-x', subject: 'Q3 board pack', body: { content: 'secret' } }] });
    }
    const match = /^\/v1\.0\/users\/(.+)\/mailboxSettings$/.exec(parsed.pathname);
    if (!match) return json({ error: { code: 'NotFound' } }, 404);
    const failed = hooks.graph?.({ method, identity: decodeURIComponent(match[1]), body: init?.body ?? null, state });
    if (failed === 'throw') throw new Error('socket hang up');
    if (failed) return failed;
    const mailbox = state.mailboxes[decodeURIComponent(match[1])];
    if (!mailbox) return json({ error: { code: 'ErrorItemNotFound' } }, 404);
    if (method === 'PATCH') {
      Object.assign(mailbox.settings, structuredClone(init.body));
      return json(structuredClone(mailbox.settings));
    }
    // Adversarial: a body carrying content-adjacent properties. Never stored.
    return json({ '@odata.context': `${GRAPH}/$metadata#users('x')/mailboxSettings`, archiveFolder: 'AAMkAD-archive', ...structuredClone(mailbox.settings) });
  }

  const envelope = (stdout, exitCode = 0) => ({ stdout: JSON.stringify(stdout), exitCode });
  const notFound = (identity) => envelope({ ok: false, error: { message: `The operation couldn't be performed because object '${identity}' couldn't be found.`, category: 'NotSpecified', errorId: 'ManagementObjectNotFoundException' } }, 1);

  function run(job) {
    const keys = Object.keys(job).filter((key) => key !== 'jobId').sort();
    if (job.mode !== 'cmdlet' || keys.some((key) => !['adapter', 'cmdlet', 'mode', 'module', 'parameters', 'tenantConfigPath'].includes(key))) {
      return { stdout: '', stderr: `run-job.sh: refused descriptor with ${keys.join(',')}`, exitCode: 2 };
    }
    const allowed = ALLOWLIST[job.cmdlet];
    if (!allowed) return envelope({ ok: false, error: { message: `cmdlet ${job.cmdlet} is not allowed`, errorId: 'CmdletNotAllowed' } }, 1);
    const args = [];
    for (const [name, value] of Object.entries(job.parameters ?? {})) {
      if (!allowed.includes(name)) return envelope({ ok: false, error: { message: `parameter ${name} is not allowed`, errorId: 'ParameterNotAllowed' } }, 1);
      if (value && typeof value === 'object' && !Array.isArray(value)) return envelope({ ok: false, error: { message: `${name} must be a scalar`, errorId: 'ParameterNotScalar' } }, 1);
      args.push([name, value]); // splatting: one value, one argument
    }
    calls.push({ cmdlet: job.cmdlet, args });
    const override = hooks.cmdlet?.({ cmdlet: job.cmdlet, args, state });
    if (override === 'crash') return { stdout: '', stderr: 'pwsh: Fatal error. Internal CLR error. (0x80131506)', exitCode: 134 };
    if (override === 'timeout') return { timeout: true };
    if (override?.error) return envelope({ ok: false, error: override.error }, 1);
    if (override?.output) return envelope({ ok: true, output: override.output });
    const apply = () => {
      const identity = job.parameters.Identity;
      const mailbox = identity === undefined ? null : state.mailboxes[identity];
      if (job.cmdlet === 'Get-OrganizationConfig') return envelope({ ok: true, output: [{ Identity: 'contoso.onmicrosoft.com', Guid: 'g', ...state.organization }] });
      if (job.cmdlet === 'Set-OrganizationConfig') { Object.assign(state.organization, Object.fromEntries(args)); return envelope({ ok: true, output: [] }); }
      if (!mailbox) return notFound(identity);
      // Adversarial: the cmdlet objects carry content-adjacent properties. Never stored.
      if (job.cmdlet === 'Get-CASMailbox') return envelope({ ok: true, output: [{ Identity: identity, RecentMessageSubjects: ['Q3 board pack'], ...mailbox.cas }] });
      if (job.cmdlet === 'Get-Mailbox') return envelope({ ok: true, output: [{ Identity: identity, ArchiveStatus: 'Active', TotalItemSize: '1.2 GB', ...mailbox.retention }] });
      const { Identity, ...values } = Object.fromEntries(args);
      if (job.cmdlet === 'Set-CASMailbox') Object.assign(mailbox.cas, values);
      if (job.cmdlet === 'Set-Mailbox') Object.assign(mailbox.retention, values);
      return envelope({ ok: true, output: [] });
    };
    if (override === 'apply-then-timeout') { apply(); return { timeout: true }; }
    return apply();
  }

  function spawnFn(bin, args) {
    argv.push([bin, ...args]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    let input = '';
    child.stdin = {
      write(chunk) { input += chunk; },
      end() {
        queueMicrotask(() => {
          const job = JSON.parse(input);
          jobs.push(job);
          const result = run(job);
          if (result.timeout) return; // never answers; jobQueue times out
          if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
          if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
          child.emit('close', result.exitCode);
        });
      },
    };
    return child;
  }

  return {
    state, requests, jobs, calls, argv, transport,
    powershell: { spawnFn, timeoutMs: 50, tenantConfigPath: '/etc/keel/restorer.json' },
    contentCalls: () => contentCalls,
    writes: () => [...requests.filter((request) => request.method !== 'GET').map((request) => `${request.method} mailboxSettings`), ...calls.filter((call) => call.cmdlet.startsWith('Set-')).map((call) => call.cmdlet)],
  };
}

const ledgerRow = (id, enabled) => ({ id, state: enabled ? 'live-qualified' : 'fixture-tested', enabled });
function readLedger(tenantRef, { upstream = true, exchange = true } = {}) {
  return {
    tenantRef,
    rows: [
      ...SHAREPOINT_OPERATIONS.map((id) => ledgerRow(id, upstream)),
      ...TEAMS_OPERATIONS.map((id) => ledgerRow(id, upstream)),
      ...EXCHANGE_OPERATIONS.map((id) => ledgerRow(id, typeof exchange === 'boolean' ? exchange : exchange.includes(id))),
    ],
  };
}
const liveWrite = (operationId, tenantRef, extra = {}) => ({
  operationId, kind: 'live-write-capture', synthetic: false, tenantRef,
  capturedAt: '2026-10-02T00:00:00Z', version: operationId.startsWith('exchange.') && operationId !== EXCHANGE_MAILBOX_SETTINGS_WRITE ? MODULE_VERSION : 'v1.0',
  ok: true, readBackVerified: true, proofRef: `${operationId}.json@sha256:x`, ...extra,
});
const RESTORER_GRANTS = Object.freeze({ permissions: ['MailboxSettings.ReadWrite', 'Exchange.ManageAsApp'], roles: ['Exchange Administrator'] });
/** Qualification of every Exchange write. */
function qualifications(tenantRef, {
  upstream = true, exchange = EXCHANGE_WRITE_OPERATIONS, grants = RESTORER_GRANTS, runtime = { modules: { ExchangeOnlineManagement: MODULE_VERSION } },
} = {}) {
  const evidence = [
    ...(upstream ? [liveWrite('sharepoint.tenant-settings.update', tenantRef), liveWrite('teams.settings.update', tenantRef)] : []),
    ...exchange.map((id) => liveWrite(id, tenantRef)),
  ];
  const ledger = readLedger(tenantRef);
  return Object.fromEntries(EXCHANGE_WRITE_OPERATIONS.map((id) => [id, workloadWriteQualification(id, { readLedger: ledger, evidence, tenantRef, now: NOW, runtime, grants })]));
}

let principalSeq = 0;
async function principal(client, label, role) {
  const email = `${label.replace(/[^a-z0-9-]/gi, '')}-${principalSeq += 1}@example.test`;
  const { rows } = await client.query(`INSERT INTO principal (email) VALUES ($1) RETURNING id`, [email]);
  if (role) await grantRole(client, { principalId: rows[0].id, role, grantedBy: rows[0].id, activeFrom: new Date(Date.now() - 60_000) });
  return rows[0].id;
}

/** The source: a recorded collection of the mailbox and organization as they were. */
async function recordSource(client, tenantRef, { mailbox = mailboxState(), identity = MAILBOX, hooks = {} } = {}) {
  const exchange = fakeExchange({ mailboxes: { [identity]: mailbox }, hooks });
  const result = await readExchange({ transport: exchange.transport, powershell: exchange.powershell, mailboxes: [identity], now: () => NOW });
  const run = await recordExchangeRun(client, { tenantRef, result });
  return { source: await loadExchangeSource(client, { tenantRef, collectionId: run.id }), result, run };
}

async function planned(client, tenantRef, { source, exchange, identity = MAILBOX, includeOrganization = true, requester } = {}) {
  const recorded = source ?? (await recordSource(client, tenantRef, { identity })).source;
  const live = await readLiveExchange({ transport: exchange.transport, powershell: exchange.powershell, mailbox: identity, includeOrganization });
  exchange.requests.length = 0;
  exchange.calls.length = 0;
  exchange.jobs.length = 0;
  const plan = planExchangeRestore({ source: recorded, live, tenantId: TENANT, mailbox: identity, includeOrganization });
  const requestedBy = requester ?? await principal(client, `${tenantRef}-requester`, 'restorer');
  const artifact = await createExchangeRestoreArtifact(client, { tenantRef, plan, requestedBy });
  return { plan, artifact, requestedBy };
}

/** A live mailbox that drifted: time zone changed, OWA off, Focused Inbox off. */
function drifted({ identity = MAILBOX, retention = {}, hooks = {} } = {}) {
  return fakeExchange({
    mailboxes: { [identity]: mailboxState({ settings: { timeZone: 'Pacific Standard Time' }, cas: { OWAEnabled: false }, retention }) },
    organization: { ...ORGANIZATION, FocusedInboxOn: false },
    hooks,
  });
}

const byKind = (result, kind) => result.operations.find((op) => op.kind === kind);
async function evidenceRows(client, tenantRef) {
  const { rows } = await client.query(`SELECT subject FROM evidence WHERE tenant_ref = $1 AND kind = $2 ORDER BY seq`, [tenantRef, EXCHANGE_RESTORE_EVIDENCE_KIND]);
  return rows.map((row) => row.subject);
}

// ------------------------------------------------------------------- reads

test('the reader keeps mailbox settings, client access, holds and organization configuration as distinct observations and enumerates no content', async () => {
  const exchange = fakeExchange();
  const result = await readExchange({ transport: exchange.transport, powershell: exchange.powershell, mailboxes: [MAILBOX], now: () => NOW });
  assert.equal(result.outcome, 'complete');
  assert.deepEqual(result.resources.map((entry) => entry.resourceKey), [`mailbox:${MAILBOX}`, 'organization']);
  const [mailbox, organization] = result.resources;
  assert.deepEqual(mailbox.fields.mailboxSettings.timeZone, 'UTC');
  assert.deepEqual(mailbox.fields.clientAccess, CAS);
  assert.deepEqual(mailbox.fields.retention.InPlaceHolds, []);
  assert.deepEqual(organization.fields.organization, ORGANIZATION);
  assert.equal(mailbox.fieldCoverage['mailboxSettings.timeZone'].operation, 'exchange.mailbox-settings');
  assert.equal(mailbox.fieldCoverage['clientAccess.OWAEnabled'].operation, 'exchange.client-access');
  assert.equal(mailbox.fieldCoverage['retention.LitigationHoldEnabled'].operation, 'exchange.mailbox-hold');
  assert.equal(organization.fieldCoverage['organization.FocusedInboxOn'].operation, 'exchange.organization-config');
  const counted = Object.values(result.fieldCounts).reduce((sum, count) => sum + count, 0);
  assert.equal(counted, MAILBOX_SETTING_FIELDS.length + CLIENT_ACCESS_FIELDS.length + RETENTION_FIELDS.length + ORGANIZATION_FIELDS.length);

  // No content: no content request, no content cmdlet, nothing content-adjacent stored.
  assert.equal(exchange.contentCalls(), 0);
  assert.deepEqual(exchange.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`), [`GET /v1.0/users/${encodeURIComponent(MAILBOX)}/mailboxSettings`]);
  assert.deepEqual(exchange.calls.map((call) => call.cmdlet), ['Get-CASMailbox', 'Get-Mailbox', 'Get-OrganizationConfig']);
  assert.doesNotMatch(JSON.stringify(result), /archiveFolder|AAMkAD|RecentMessageSubjects|Q3 board pack|TotalItemSize|ArchiveStatus/);

  // Every content shape is refused before it is sent, whatever its container.
  for (const url of [
    `${GRAPH}/users/${MAILBOX}/messages`, `${GRAPH}/users/${MAILBOX}/mailFolders/inbox/messages`, `${GRAPH}/users/${MAILBOX}/mailFolders/inbox/messageRules`,
    `${GRAPH}/users/${MAILBOX}/calendar/events`, `${GRAPH}/users/${MAILBOX}/contacts`, `${GRAPH}/users/${MAILBOX}/mailboxSettings?$expand=messages`,
    `${GRAPH}/users/${MAILBOX}/mailboxSettings/archiveFolder`, `https://evil.example/v1.0/users/${MAILBOX}/mailboxSettings`,
  ]) assert.throws(() => assertExchangeRequest(url, 'GET'), ExchangeScopeError, url);
  for (const cmdlet of ['Search-Mailbox', 'Get-MailboxFolderStatistics', 'New-MailboxExportRequest', 'Get-MessageTrace', 'Get-MailboxStatistics', 'Get-InboxRule', 'New-ComplianceSearch', 'Remove-Mailbox']) {
    assert.throws(() => assertExchangeCmdlet({ cmdlet }), ExchangeScopeError, cmdlet);
  }
  assert.throws(() => assertExchangeCmdlet({ cmdlet: 'Get-Mailbox', parameters: { Identity: MAILBOX, Filter: '*' } }), /does not take Filter/);
  assert.notEqual(scopeProblems({ kind: 'cmdlet', cmdlet: 'Get-MailboxFolderStatistics', module: 'x' }).length, 0);
  // The Node and container allowlists are the same list.
  assert.deepEqual(Object.fromEntries(Object.entries(EXCHANGE_CMDLET_PARAMETERS).map(([name, list]) => [name, [...list]])), ALLOWLIST);
});

test('a quoted hostile mailbox identifier remains one argument, in reads and in writes', async (t) => {
  const mailboxes = Object.fromEntries(HOSTILE.map((identity, index) => [identity, mailboxState({ settings: { timeZone: `Zone ${index}` }, cas: { PopEnabled: index % 2 === 0 } })]));
  const exchange = fakeExchange({ mailboxes });
  const result = await readExchange({ transport: exchange.transport, powershell: exchange.powershell, mailboxes: HOSTILE, includeOrganization: false, now: () => NOW });
  assert.equal(result.outcome, 'complete');
  HOSTILE.forEach((identity, index) => {
    const entry = result.resources.find((resource) => resource.identity === identity);
    assert.equal(entry.fields.mailboxSettings.timeZone, `Zone ${index}`, identity);
    assert.equal(entry.fields.clientAccess.PopEnabled, index % 2 === 0, identity);
  });
  assert.equal(exchange.calls.length, HOSTILE.length * 2);
  exchange.calls.forEach((call, index) => {
    assert.deepEqual(call.args, [['Identity', HOSTILE[Math.floor(index / 2)]]], 'exactly one Identity argument, byte for byte');
  });
  for (const job of exchange.jobs) {
    assert.deepEqual(Object.keys(job).sort(), ['adapter', 'cmdlet', 'jobId', 'mode', 'module', 'parameters', 'tenantConfigPath']);
    assert.equal('script' in job || 'command' in job, false, 'the job carries no PowerShell source');
  }
  for (const args of exchange.argv) for (const identity of HOSTILE) assert.equal(args.some((arg) => arg.includes(identity)), false, 'no identity reaches the docker command line');

  // An identity that would leave the configuration path is refused for Graph, nothing sent.
  const pathy = 'eve/messages';
  const escaping = fakeExchange({ mailboxes: { [pathy]: mailboxState() } });
  const [escaped] = (await readExchange({ transport: escaping.transport, powershell: escaping.powershell, mailboxes: [pathy], includeOrganization: false })).resources;
  assert.equal(escaped.fieldCoverage['mailboxSettings.timeZone'].status, 'refused');
  assert.equal(escaping.requests.length, 0);
  assert.equal(escaping.contentCalls(), 0);
  assert.deepEqual(escaping.calls[0].args, [['Identity', pathy]]);

  // The job builder refuses what is not data.
  const allowedCmdlets = new Set(['Get-Mailbox']);
  assert.throws(() => cmdletJob({ module: 'm', cmdlet: 'Get-Mailbox', parameters: { Identity: { $type: 'ScriptBlock' } } }, { allowedCmdlets }), /never an object or script/);
  assert.throws(() => cmdletJob({ module: 'm', cmdlet: 'Get-Mailbox', parameters: { 'Identity; Remove-Mailbox': 'x' } }, { allowedCmdlets }), /not a parameter name/);
  assert.throws(() => cmdletJob({ module: 'm', cmdlet: 'Get-Mailbox', parameters: { Identity: 'a\nRemove-Mailbox b' } }, { allowedCmdlets }), /control character/);
  assert.throws(() => cmdletJob({ module: 'm', cmdlet: 'Get-Mailbox; Remove-Mailbox', parameters: {} }, { allowedCmdlets }), /not an allowed cmdlet/);

  // A write to a hostile identity passes it as the one Identity argument too.
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const identity = HOSTILE[1];
  const { source } = await recordSource(client, tenantRef, { identity });
  const live = fakeExchange({ mailboxes: { [identity]: mailboxState({ cas: { OWAEnabled: false } }) } });
  const { artifact } = await planned(client, tenantRef, { source, exchange: live, identity, includeOrganization: false });
  const restored = await executeExchangeRestore(client, { tenantRef, artifactId: artifact.id, tenantId: TENANT, transport: live.transport, powershell: live.powershell, qualifications: qualifications(tenantRef) });
  assert.equal(byKind(restored, 'client-access').outcome, 'verified');
  assert.deepEqual(live.calls.find((call) => call.cmdlet === 'Set-CASMailbox').args, [['Identity', identity], ['OWAEnabled', true]]);
  assert.equal(live.state.mailboxes[identity].cas.OWAEnabled, true);
});

test('cmdlet output errors persist structured and are never an empty success', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const denied = { message: "The user isn't assigned to any management roles.", category: 'PermissionDenied', errorId: 'Microsoft.Exchange.Configuration.Tasks.ManagementRoleException' };
  const { result, run } = await recordSource(client, tenantRef, {
    hooks: {
      cmdlet: ({ cmdlet }) => {
        if (cmdlet === 'Get-CASMailbox') return { error: denied };
        if (cmdlet === 'Get-Mailbox') return 'crash';
        if (cmdlet === 'Get-OrganizationConfig') return { output: [] }; // a successful empty answer
        return null;
      },
    },
  });
  assert.equal(result.outcome, 'partial');
  const { rows } = await client.query(`SELECT resource_key, field_coverage FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key`, [run.id]);
  const coverage = Object.fromEntries(rows.map((row) => [row.resource_key, row.field_coverage]));
  const access = coverage[`mailbox:${MAILBOX}`]['clientAccess.OWAEnabled'];
  assert.equal(access.status, 'denied');
  assert.deepEqual(
    { code: access.error.code, cmdlet: access.error.cmdlet, category: access.error.category, errorId: access.error.errorId, exitCode: access.error.exitCode },
    { code: 'CMDLET_ERROR', cmdlet: 'Get-CASMailbox', category: 'PermissionDenied', errorId: denied.errorId, exitCode: 1 },
  );
  assert.match(access.error.message, /management roles/);
  const hold = coverage[`mailbox:${MAILBOX}`]['retention.LitigationHoldEnabled'];
  assert.equal(hold.status, 'failed');
  assert.equal(hold.error.code, 'NONZERO_EXIT');
  assert.match(hold.error.stderr, /Internal CLR error/);
  // A successful empty answer is unknown, never failed and never observed.
  assert.equal(coverage.organization['organization.FocusedInboxOn'].status, 'unknown');
  assert.equal(coverage[`mailbox:${MAILBOX}`]['mailboxSettings.timeZone'].status, 'observed');

  // A failed read is no basis: nothing is planned from it.
  const { source: fine } = await recordSource(client, tenantRef);
  const liveFailing = fakeExchange({ hooks: { cmdlet: ({ cmdlet }) => (cmdlet === 'Get-Mailbox' ? 'crash' : null) } });
  const failingLive = await readLiveExchange({ transport: liveFailing.transport, powershell: liveFailing.powershell, mailbox: MAILBOX });
  const noBasis = planExchangeRestore({ source: fine, live: failingLive, tenantId: TENANT, mailbox: MAILBOX });
  assert.ok(noBasis.manual.some((item) => item.field === 'retention' && item.error?.code === 'NONZERO_EXIT'));

  // A write the cmdlet rejects is `failed` with the structured error in its evidence row.
  const exchange = drifted({ hooks: { cmdlet: ({ cmdlet }) => (cmdlet === 'Set-CASMailbox' ? { error: { message: 'Mailbox is in a transient state.', category: 'InvalidOperation', errorId: 'TransientMailboxException' } } : null) } });
  const { artifact } = await planned(client, tenantRef, { source: fine, exchange });
  const restored = await executeExchangeRestore(client, { tenantRef, artifactId: artifact.id, tenantId: TENANT, transport: exchange.transport, powershell: exchange.powershell, qualifications: qualifications(tenantRef) });
  assert.equal(byKind(restored, 'client-access').outcome, 'failed');
  assert.equal(byKind(restored, 'client-access').error.errorId, 'TransientMailboxException');
  assert.equal(exchange.calls.filter((call) => call.cmdlet === 'Set-CASMailbox').length, 1, 'never resent');
  const row = (await evidenceRows(client, tenantRef)).find((subject) => subject.artifactId === artifact.id && subject.kind === 'client-access');
  assert.deepEqual({ outcome: row.outcome, code: row.error.code, cmdlet: row.error.cmdlet, category: row.error.category, errorId: row.error.errorId },
    { outcome: 'failed', code: 'CMDLET_ERROR', cmdlet: 'Set-CASMailbox', category: 'InvalidOperation', errorId: 'TransientMailboxException' });
  // The other operations kept their own outcomes.
  assert.equal(byKind(restored, 'mailbox-settings').outcome, 'verified');
  assert.equal(byKind(restored, 'organization').outcome, 'verified');
});

// ------------------------------------------------------------- qualification

test('Exchange activates only on its own proof, after Teams; unknown RBAC blocks every write', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();

  // Reads: Teams not qualified, or one Exchange read missing, sends nothing.
  for (const [name, ledger] of Object.entries({
    teamsNotQualified: readLedger(tenantRef, { upstream: false, exchange: true }),
    exchangeFixtureOnly: readLedger(tenantRef, { exchange: false }),
    holdReadMissing: readLedger(tenantRef, { exchange: EXCHANGE_OPERATIONS.filter((id) => id !== 'exchange.mailbox-hold') }),
  })) {
    const exchange = fakeExchange();
    const { run, result, activation } = await collectExchange(client, { tenantRef, ledger, transport: exchange.transport, powershell: exchange.powershell, mailboxes: [MAILBOX], now: () => NOW });
    assert.equal(activation.enabled, false, name);
    assert.equal(run.outcome, 'disabled', name);
    assert.equal(result, null, name);
    assert.equal(exchange.requests.length + exchange.calls.length, 0, `${name}: no request and no cmdlet`);
  }
  assert.equal(exchangeActivation(readLedger(tenantRef)).enabled, true);

  // Writes: every one is disabled while the restorer's grants are unknown.
  const unknown = qualifications(tenantRef, { grants: null });
  for (const id of EXCHANGE_WRITE_OPERATIONS) {
    assert.equal(unknown[id].state, 'live-qualified', id);
    assert.equal(unknown[id].enabled, false, id);
    assert.ok(unknown[id].reasons.some((reason) => /grants are unknown/.test(reason)), id);
  }
  // Grants observed but short of the Exchange role: only the Graph write may run.
  const noRole = qualifications(tenantRef, { grants: { permissions: RESTORER_GRANTS.permissions, roles: [] } });
  assert.equal(noRole[EXCHANGE_MAILBOX_SETTINGS_WRITE].enabled, true);
  for (const id of [EXCHANGE_CLIENT_ACCESS_WRITE, EXCHANGE_RETENTION_WRITE, EXCHANGE_ORGANIZATION_WRITE]) {
    assert.equal(noRole[id].enabled, false, id);
    assert.ok(noRole[id].reasons.includes('the restorer lacks Exchange Administrator'), id);
  }
  // Teams proof missing, fixture proof only, or an unknown module version: disabled.
  for (const id of EXCHANGE_WRITE_OPERATIONS) {
    assert.equal(qualifications(tenantRef, { upstream: false })[id].enabled, false, `${id} without Teams`);
    assert.equal(workloadWriteQualification(id, { readLedger: readLedger(tenantRef), evidence: [{ operationId: id, kind: 'fixture', ok: true }], tenantRef, now: NOW, grants: RESTORER_GRANTS }).enabled, false, `${id} fixture`);
  }
  assert.equal(qualifications(tenantRef, { runtime: {} })[EXCHANGE_CLIENT_ACCESS_WRITE].enabled, false, 'a cmdlet write needs the module version in use');
  assert.equal(qualifications(tenantRef, { runtime: { modules: { ExchangeOnlineManagement: '3.6.0' } } })[EXCHANGE_RETENTION_WRITE].enabled, false, 'proof is bound to its module version');

  // A restore with unknown RBAC sends zero writes.
  const exchange = drifted();
  const { artifact } = await planned(client, tenantRef, { exchange });
  const result = await executeExchangeRestore(client, { tenantRef, artifactId: artifact.id, tenantId: TENANT, transport: exchange.transport, powershell: exchange.powershell, qualifications: unknown });
  assert.equal(result.outcome, 'disabled');
  assert.deepEqual(exchange.writes(), []);
  assert.equal(exchange.calls.length + exchange.requests.length, 0, 'not even a re-read');
});

// ------------------------------------------------------------------ restore

test('mailbox settings, client access and organization configuration restore as distinct verified operations', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const exchange = drifted();
  const { plan, artifact } = await planned(client, tenantRef, { exchange });
  assert.deepEqual(plan.operations.map((op) => op.operationId), [EXCHANGE_MAILBOX_SETTINGS_WRITE, EXCHANGE_CLIENT_ACCESS_WRITE, EXCHANGE_ORGANIZATION_WRITE]);
  assert.deepEqual(plan.contentEffects, []);
  assert.ok(plan.excluded.some((item) => item.field === 'messages'));
  assert.ok(plan.excluded.some((item) => item.field === 'mailboxSettings.userPurpose' && item.reason === 'server-owned'));

  const result = await executeExchangeRestore(client, { tenantRef, artifactId: artifact.id, tenantId: TENANT, transport: exchange.transport, powershell: exchange.powershell, qualifications: qualifications(tenantRef) });
  assert.equal(result.outcome, 'verified');
  assert.deepEqual(exchange.writes().sort(), ['PATCH mailboxSettings', 'Set-CASMailbox', 'Set-OrganizationConfig'].sort());
  assert.deepEqual(exchange.requests.find((request) => request.method === 'PATCH').body, { timeZone: 'UTC' }, 'only the changed setting');
  assert.deepEqual(exchange.calls.find((call) => call.cmdlet === 'Set-OrganizationConfig').args, [['FocusedInboxOn', true]]);
  assert.equal(exchange.state.mailboxes[MAILBOX].settings.timeZone, 'UTC');
  assert.equal(exchange.contentCalls(), 0);
  const rows = (await evidenceRows(client, tenantRef)).filter((subject) => subject.artifactId === artifact.id);
  assert.deepEqual(rows.map((row) => `${row.operationId}:${row.outcome}`), [
    `${EXCHANGE_MAILBOX_SETTINGS_WRITE}:verified`, `${EXCHANGE_CLIENT_ACCESS_WRITE}:verified`, `${EXCHANGE_ORGANIZATION_WRITE}:verified`, 'exchange.restore:verified',
  ]);

  // With only the client-access write qualified, only Set-CASMailbox is sent.
  const partial = drifted();
  const { artifact: second } = await planned(client, tenantRef, { exchange: partial });
  const only = await executeExchangeRestore(client, { tenantRef, artifactId: second.id, tenantId: TENANT, transport: partial.transport, powershell: partial.powershell, qualifications: qualifications(tenantRef, { exchange: [EXCHANGE_CLIENT_ACCESS_WRITE] }) });
  assert.equal(only.outcome, 'partial');
  assert.deepEqual(partial.writes(), ['Set-CASMailbox']);
  assert.equal(byKind(only, 'mailbox-settings').outcome, 'disabled');

  // A lost answer that applied is verified with one call; one that did not is failed. Neither is resent.
  for (const [hook, expected, applied] of [['apply-then-timeout', 'verified', true], ['timeout', 'failed', false]]) {
    const lossy = drifted({ hooks: { cmdlet: ({ cmdlet }) => (cmdlet === 'Set-CASMailbox' ? hook : null) } });
    const { artifact: lost } = await planned(client, tenantRef, { exchange: lossy, includeOrganization: false });
    const outcome = await executeExchangeRestore(client, { tenantRef, artifactId: lost.id, tenantId: TENANT, transport: lossy.transport, powershell: lossy.powershell, qualifications: qualifications(tenantRef) });
    assert.equal(byKind(outcome, 'client-access').outcome, expected, hook);
    assert.equal(lossy.calls.filter((call) => call.cmdlet === 'Set-CASMailbox').length, 1, `${hook}: sent once`);
    assert.equal(lossy.state.mailboxes[MAILBOX].cas.OWAEnabled, applied);
  }

  // A change after the plan makes only the operations it touches stale.
  const raced = drifted();
  const { artifact: racedArtifact } = await planned(client, tenantRef, { exchange: raced, includeOrganization: false });
  raced.state.mailboxes[MAILBOX].cas.PopEnabled = true;
  const stale = await executeExchangeRestore(client, { tenantRef, artifactId: racedArtifact.id, tenantId: TENANT, transport: raced.transport, powershell: raced.powershell, qualifications: qualifications(tenantRef) });
  assert.equal(byKind(stale, 'client-access').outcome, 'stale');
  assert.equal(byKind(stale, 'mailbox-settings').outcome, 'verified');

  // A plan run against another tenant id is refused with no request.
  const elsewhere = drifted();
  const { artifact: bound } = await planned(client, tenantRef, { exchange: elsewhere });
  const refused = await executeExchangeRestore(client, { tenantRef, artifactId: bound.id, tenantId: OTHER_TENANT, transport: elsewhere.transport, powershell: elsewhere.powershell, qualifications: qualifications(tenantRef) });
  assert.equal(refused.outcome, 'refused');
  assert.equal(elsewhere.requests.length + elsewhere.calls.length, 0);

  // Exchange types never enter Entra waves; coverage lists the disabled workload.
  assert.throws(() => planWaves([{ naturalKey: `exchange:mailbox:${MAILBOX}:retention`, resourceType: 'exchangeMailboxRetention', payload: {}, references: [] }]), /workload restore path/);
  assert.throws(() => planDeletionWaves([{ naturalKey: 'exchange:organization:organization', resourceType: 'exchangeOrganizationConfig', payload: {}, references: [] }]), /workload restore path/);
  const reportTenant = nextTenant();
  await collectExchange(client, { tenantRef: reportTenant, ledger: readLedger(reportTenant, { exchange: false }), transport: fakeExchange().transport, mailboxes: [MAILBOX], now: () => NOW });
  const report = await buildCoverageReport(client, { tenantRef: reportTenant, catalog: [], descriptors: [] });
  const entry = report.workloads.find((item) => item.workload === 'exchange-mailbox-settings');
  assert.equal(entry.status, 'disabled');
  assert.ok(entry.reasons.some((reason) => /exchange\.mailbox-settings is fixture-tested/.test(reason)));
});

test('a hold-releasing operation refuses without qualified approval, and never on a Purview hold', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  // The source had no litigation hold; today the mailbox is on hold. Restoring releases it.
  const exchange = drifted({ retention: { LitigationHoldEnabled: true } });
  const { plan, artifact, requestedBy } = await planned(client, tenantRef, { exchange, includeOrganization: false });
  assert.deepEqual(plan.contentEffects.map((effect) => `${effect.resourceType}:${effect.field}:${effect.effect}`), ['exchangeMailboxRetention:LitigationHoldEnabled:hold-releasing']);

  const blocked = await executeExchangeRestore(client, { tenantRef, artifactId: artifact.id, tenantId: TENANT, transport: exchange.transport, powershell: exchange.powershell, qualifications: qualifications(tenantRef) });
  assert.equal(byKind(blocked, 'retention').outcome, 'blocked-content-effect');
  assert.match(byKind(blocked, 'retention').reasons[0], /hold-releasing/);
  assert.equal(exchange.calls.some((call) => call.cmdlet === 'Set-Mailbox'), false, 'no hold change is sent');
  assert.equal(exchange.state.mailboxes[MAILBOX].retention.LitigationHoldEnabled, true);
  assert.equal(byKind(blocked, 'client-access').outcome, 'verified', 'the operations without an effect still run');

  // The requester cannot approve their own hold release.
  await assert.rejects(approveContentEffects(client, {
    tenantRef, artifactId: artifact.id, approverId: requestedBy, effectsDigest: contentEffectsDigest(plan.contentEffects), justification: 'self',
  }), /only a principal currently holding approve|someone other than the requester/);

  // A qualified approver approves exactly this effect: the hold is released and verified.
  const approver = await principal(client, `${tenantRef}-approver`, 'approver');
  await approveContentEffects(client, {
    tenantRef, artifactId: artifact.id, approverId: approver, effectsDigest: contentEffectsDigest(plan.contentEffects), justification: 'litigation closed; counsel confirmed release',
  });
  const approvedExchange = drifted({ retention: { LitigationHoldEnabled: true } });
  const approved = await executeExchangeRestore(client, { tenantRef, artifactId: artifact.id, tenantId: TENANT, transport: approvedExchange.transport, powershell: approvedExchange.powershell, qualifications: qualifications(tenantRef) });
  assert.equal(byKind(approved, 'retention').outcome, 'verified');
  assert.deepEqual(approvedExchange.calls.find((call) => call.cmdlet === 'Set-Mailbox').args, [['Identity', MAILBOX], ['LitigationHoldEnabled', false]]);

  // Shortening the deleted-item window is retention-reducing and is held back the same way.
  const shorter = await recordSource(client, tenantRef, { mailbox: mailboxState({ retention: { RetainDeletedItemsFor: '7.00:00:00', SingleItemRecoveryEnabled: false } }) });
  const shortening = fakeExchange();
  const { plan: shortPlan, artifact: shortArtifact } = await planned(client, tenantRef, { source: shorter.source, exchange: shortening, includeOrganization: false });
  assert.deepEqual(shortPlan.contentEffects.map((effect) => `${effect.field}:${effect.effect}`).sort(), ['RetainDeletedItemsFor:retention-reducing', 'SingleItemRecoveryEnabled:retention-reducing']);
  const short = await executeExchangeRestore(client, { tenantRef, artifactId: shortArtifact.id, tenantId: TENANT, transport: shortening.transport, powershell: shortening.powershell, qualifications: qualifications(tenantRef) });
  assert.equal(byKind(short, 'retention').outcome, 'blocked-content-effect');
  assert.deepEqual(shortening.writes(), []);

  // Turning a hold ON has no content effect and needs no approval.
  const enabling = await recordSource(client, tenantRef, { mailbox: mailboxState({ retention: { LitigationHoldEnabled: true } }) });
  const offNow = fakeExchange();
  const { plan: enablePlan, artifact: enableArtifact } = await planned(client, tenantRef, { source: enabling.source, exchange: offNow, includeOrganization: false });
  assert.deepEqual(enablePlan.contentEffects, []);
  const enabled = await executeExchangeRestore(client, { tenantRef, artifactId: enableArtifact.id, tenantId: TENANT, transport: offNow.transport, powershell: offNow.powershell, qualifications: qualifications(tenantRef) });
  assert.equal(byKind(enabled, 'retention').outcome, 'verified');

  // Under a hold Purview owns, a hold release is refused outright, whatever the approval.
  const purview = drifted({ retention: { LitigationHoldEnabled: true, InPlaceHolds: ['UniH7d2c-policy'] } });
  const { plan: purviewPlan, artifact: purviewArtifact } = await planned(client, tenantRef, { exchange: purview, includeOrganization: false });
  assert.match(purviewPlan.refusals[0].reason, /Purview/);
  assert.equal(purviewPlan.complianceHolds.InPlaceHolds[0], 'UniH7d2c-policy');
  const refused = await executeExchangeRestore(client, { tenantRef, artifactId: purviewArtifact.id, tenantId: TENANT, transport: purview.transport, powershell: purview.powershell, qualifications: qualifications(tenantRef) });
  assert.equal(refused.outcome, 'refused');
  assert.deepEqual(purview.writes(), []);
});
