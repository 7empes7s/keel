// Wave 2 WKLD: workload writers for mail flow, the Exchange settings READ-EXO added,
// Teams org-wide, voice and live event policies, and Purview retention and DLP.
//
// Acceptance:
//  - a fixture restore for each written family puts the drifted setting back and
//    verifies it by read-back;
//  - idempotent: a second run against the restored tenant plans nothing and writes nothing;
//  - a shortening, release or widening is a classified content effect and is blocked
//    until someone other than the requester approves exactly those effects;
//  - a preservation lock refuses; nothing is ever deleted; a Guid-keyed object that is
//    gone is not re-created, a named Teams policy is;
//  - run-cmdlet.ps1 allows exactly the declared write cmdlets and parameters.
//
// Everything runs against the isolated test database and a fake PowerShell container
// behind the real engine/powershell/jobQueue.mjs spawn path, which enforces the
// allowlists parsed from ops/powershell/run-cmdlet.ps1. Every fixture object is named
// KEEL-RT-. No tenant is touched.
//
// Qualification: these writes are declared in writeDeclarations.mjs and are not in
// coverage/qualification.mjs yet, so the tests pass the executors an enabled
// qualification directly, the shape workloadWriteQualification returns.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { grantRole } from '../authz/administration.mjs';
import { OPERATOR_TEST_TENANT_POLICY, standingPolicyRefusal } from '../govern/approvalPolicy.mjs';
import { FAMILIES as EXCHANGE_EXTENDED_FAMILIES, readExchangeExtended, recordExchangeExtendedRun } from '../collect/workloads/exchangeExtended.mjs';
import { FAMILIES as MAIL_FLOW_FAMILIES, readMailFlow, recordMailFlowRun } from '../collect/workloads/mailFlow.mjs';
import { FAMILIES as PURVIEW_EXTENDED_FAMILIES, readPurviewExtended, recordPurviewExtendedRun } from '../collect/workloads/purviewExtended.mjs';
import { FAMILIES as RETENTION_DLP_FAMILIES, readRetentionDlp, recordRetentionDlpRun } from '../collect/workloads/purviewRetentionDlp.mjs';
import { FAMILIES as TEAMS_EXTENDED_FAMILIES, readTeamsExtended, recordTeamsExtendedRun } from '../collect/workloads/teamsExtended.mjs';
import { FAMILIES as TEAMS_POLICY_FAMILIES, readTeamsPolicies, recordTeamsPolicyRun } from '../collect/workloads/teamsPolicies.mjs';
import {
  BENIGN_FIELDS, WORKLOAD_EFFECT_RULES, WorkloadWriteScopeError, createWorkloadSettingsArtifact, executeWorkloadSettingsRestore,
  loadWorkloadSource, planWorkloadSettingsRestore, resolveNamedTargets, restoreReadFamilies, unreviewedWrittenFields, weakensMailProtection, workloadWriteCmdlet, writeCmdletParameters, writeFamilies,
} from '../restore/workloads/cmdletSettings.mjs';
import { WORKLOAD_RESTORES } from '../restore/workloads/dispatch.mjs';
import { fixtureProblem, isFixtureName } from '../restore/workloads/fixtureGuard.mjs';
import { TRUST_FIELDS, WKLD_WRITE_OPERATIONS, isTrustField } from '../restore/workloads/writeDeclarations.mjs';
import { approveContentEffects, contentEffectsDigest } from '../safety/contentEffects.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { fakeCmdletContainer } from '../test/fakeCmdletContainer.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(schemaSql());
    schemaReady = true;
  }
  return client;
}

const NOW = new Date('2026-10-15T12:00:00Z');
const TENANT = '00000000-0000-4000-8000-0000000000d1';
let tenantSeq = 0;
const nextTenant = () => `sha256:wkld-${tenantSeq += 1}`;
let principalSeq = 0;
async function principal(client, label, role = null) {
  const { rows } = await client.query(`INSERT INTO principal (email) VALUES ($1) RETURNING id`, [`${label}-${principalSeq += 1}@example.test`]);
  if (role) await grantRole(client, { principalId: rows[0].id, role, grantedBy: rows[0].id, activeFrom: new Date(Date.now() - 60_000) });
  return rows[0].id;
}

// Each written workload: its collector's families, how it reads and records, and its module.
const WORKLOADS = Object.freeze({
  'exchange-mail-flow': { families: MAIL_FLOW_FAMILIES, read: readMailFlow, record: recordMailFlowRun, module: 'ExchangeOnlineManagement', keyed: 'guid' },
  'exchange-extended': { families: EXCHANGE_EXTENDED_FAMILIES, read: readExchangeExtended, record: recordExchangeExtendedRun, module: 'ExchangeOnlineManagement', keyed: 'guid' },
  'teams-org-policies': { families: TEAMS_POLICY_FAMILIES, read: readTeamsPolicies, record: recordTeamsPolicyRun, module: 'MicrosoftTeams', keyed: 'policy' },
  'teams-voice-policies': { families: TEAMS_EXTENDED_FAMILIES, read: readTeamsExtended, record: recordTeamsExtendedRun, module: 'MicrosoftTeams', keyed: 'policy' },
  'purview-retention-dlp': { families: RETENTION_DLP_FAMILIES, read: readRetentionDlp, record: recordRetentionDlpRun, module: 'ExchangeOnlineManagement', keyed: 'guid' },
  'purview-governance': { families: PURVIEW_EXTENDED_FAMILIES, read: readPurviewExtended, record: recordPurviewExtendedRun, module: 'ExchangeOnlineManagement', keyed: 'guid' },
});

// The allowlists run-cmdlet.ps1 ships, cmdlet names with digits included (Set-AtpPolicyForO365).
const SCRIPT = readFileSync(new URL('../../ops/powershell/run-cmdlet.ps1', import.meta.url), 'utf8');
function allowlist(variable) {
  const block = new RegExp(`\\$${variable} = @\\{([\\s\\S]*?)\\n\\}`).exec(SCRIPT)[1];
  return Object.fromEntries([...block.matchAll(/'([A-Za-z0-9-]+)'\s*=\s*@\(([^)]*)\)/g)]
    .map(([, name, entries]) => [name, [...entries.matchAll(/'([A-Za-z0-9]+)'/g)].map((match) => match[1])]));
}
const WRITE_TABLES = { exo: 'AllowedExchangeWrites', ipps: 'AllowedPurviewWrites', teams: 'AllowedTeamsWrites' };
const MODULE_TABLES = {
  ExchangeOnlineManagement: ['AllowedMailFlow', 'AllowedExchangeExtended', 'AllowedPurviewRetentionDlp', 'AllowedPurviewExtended', WRITE_TABLES.exo, WRITE_TABLES.ipps],
  MicrosoftTeams: ['AllowedTeamsPolicy', 'AllowedTeamsExtended', WRITE_TABLES.teams],
};
const moduleAllowlist = (module) => Object.assign({}, ...MODULE_TABLES[module].map(allowlist));

// Every transport rule action that deletes, holds, rejects, copies, sends, routes or encrypts mail.
const TRANSPORT_ACTIONS = [
  'RedirectMessageTo', 'BlindCopyTo', 'AddToRecipients', 'ModerateMessageByUser', 'GenerateIncidentReport', 'RouteMessageOutboundConnector',
  'ApplyRightsProtectionTemplate', 'RejectMessageReasonText', 'RejectMessageEnhancedStatusCode',
];
const effectsOf = (plan) => plan.contentEffects.map((effect) => `${effect.field}:${effect.effect}`).sort();

let guidSeq = 0;
const guid = () => `00000000-0000-4000-8000-${String(guidSeq += 1).padStart(12, '0')}`;
const getKey = (spec) => `${spec.cmdlet}${spec.parameters?.QuarantinePolicyType ? `:${spec.parameters.QuarantinePolicyType}` : ''}`;

/** One fixture object of a family: every read field set, named KEEL-RT-. */
function fixture(workload, family, { identity = null, policy = null } = {}) {
  const spec = WORKLOADS[workload].families[family];
  const body = Object.fromEntries(spec.fields.map((field) => [field, `KEEL-RT-${field}`]));
  if (WORKLOADS[workload].keyed === 'guid') body.Guid = identity ?? guid();
  else body.Identity = identity ?? 'Global';
  if ('Policy' in body) body.Policy = policy;
  if ('Name' in body) body.Name = `KEEL-RT-${family}-${body.Guid ?? body.Identity}`;
  if ('RestrictiveRetention' in body) body.RestrictiveRetention = false;
  return body;
}

/** A tenant with one object per written family (Teams policy lists also hold a named policy). */
function tenantState(workload) {
  const state = {};
  const families = writeFamilies(workload);
  const put = (family, body) => { (state[getKey(WORKLOADS[workload].families[family])] ??= []).push(body); };
  for (const [family, ops] of Object.entries(families)) {
    if (family.endsWith('Rule') && WORKLOADS[workload].families[family].policyFamily) continue;
    put(family, fixture(workload, family));
    if (ops.add) put(family, fixture(workload, family, { identity: `Tag:KEEL-RT-${family}` }));
  }
  // Retention and DLP rules sit under their policy.
  for (const [family, spec] of Object.entries(WORKLOADS[workload].families)) {
    if (!families[family] || !spec.policyFamily) continue;
    const parent = state[getKey(WORKLOADS[workload].families[spec.policyFamily])][0];
    put(family, fixture(workload, family, { policy: parent.Guid }));
  }
  return state;
}

/** Which state list a write cmdlet changes, from the declarations. */
function writeTargets(workload) {
  const targets = {};
  for (const write of Object.values(WKLD_WRITE_OPERATIONS)) {
    if (write.workload !== workload) continue;
    (targets[write.method] ??= new Set()).add(getKey(WORKLOADS[workload].families[write.family]));
  }
  return targets;
}

/**
 * A fake tenant for one workload behind the real jobQueue spawn path. `hooks.cmdlet`
 * may return { error }, 'crash' (nothing applied) or 'apply-then-crash'.
 */
/**
 * Set-QuarantinePolicy as live (#339): a quarantine policy by its Name; the global settings
 * only as DefaultGlobalTag, though their read answers Name DefaultGlobalPolicy.
 */
function quarantineTarget(state, identity) {
  const id = String(identity).toLowerCase();
  if (id === 'defaultglobaltag') return state['Get-QuarantinePolicy:GlobalQuarantinePolicy']?.[0] ?? null;
  return (state['Get-QuarantinePolicy'] ?? []).find((body) => String(body.Name ?? '').toLowerCase() === id) ?? null;
}

function fakeTenant(workload, { state = tenantState(workload), hooks = {} } = {}) {
  const { module } = WORKLOADS[workload];
  const targets = writeTargets(workload);
  const writes = [];
  const container = fakeCmdletContainer({
    module,
    allowlist: moduleAllowlist(module),
    answer(cmdlet, parameters) {
      if (cmdlet.startsWith('Get-')) return state[`${cmdlet}${parameters.QuarantinePolicyType ? `:${parameters.QuarantinePolicyType}` : ''}`] ?? [];
      writes.push({ cmdlet, parameters });
      const hook = hooks.cmdlet?.({ cmdlet, parameters, state });
      if (hook?.error || hook === 'crash') return hook;
      const { Identity, ...values } = parameters;
      const lists = [...(targets[cmdlet] ?? [])].map((key) => (state[key] ??= []));
      if (cmdlet.startsWith('New-')) {
        lists[0].push({ Identity: `Tag:${Identity}`, ...values });
      } else if (cmdlet === 'Set-QuarantinePolicy' && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(Identity))) {
        // As live (#339): Set-QuarantinePolicy fails its Identity argument transformation on a Guid; it takes the Name.
        return { error: { message: `Cannot process argument transformation on parameter 'Identity'. Cannot convert value "${Identity}"`, category: 'InvalidData', errorId: 'ParameterArgumentTransformationError,Set-QuarantinePolicy' } };
      } else {
        const found = cmdlet === 'Set-QuarantinePolicy' ? quarantineTarget(state, Identity) : lists.flat().find((body) => String(body.Guid ?? '').toLowerCase() === String(Identity).toLowerCase()
          || String(body.Identity ?? '').toLowerCase() === String(Identity).toLowerCase());
        if (!found) return { error: { message: `The operation couldn't be performed because object '${Identity}' couldn't be found.`, category: 'NotSpecified', errorId: 'ManagementObjectNotFoundException' } };
        Object.assign(found, values, 'WhenChangedUTC' in found ? { WhenChangedUTC: NOW.toISOString() } : {});
      }
      return hook === 'apply-then-crash' ? 'crash' : [];
    },
  });
  return { state, writes, calls: container.calls, powershell: container.powershell };
}

const readFor = (workload) => ({ powershell }) => WORKLOADS[workload].read({ powershell, families: restoreReadFamilies(workload) });

async function recordSource(client, tenantRef, workload, tenant) {
  const result = await readFor(workload)({ powershell: tenant.powershell });
  const run = await WORKLOADS[workload].record(client, { tenantRef, result });
  return loadWorkloadSource(client, { tenantRef, collectionId: run.id, workload });
}

async function planned(client, tenantRef, workload, { source, live, targets = [], ...options }) {
  const read = await readFor(workload)({ powershell: live.powershell });
  const plan = planWorkloadSettingsRestore({ workload, source, live: read, tenantId: TENANT, tenantRef, targets, ...options });
  const requestedBy = await principal(client, 'requester');
  const artifact = await createWorkloadSettingsArtifact(client, { tenantRef, plan, requestedBy });
  return { plan, artifact, requestedBy };
}

const enabled = (workload) => Object.fromEntries(Object.entries(WKLD_WRITE_OPERATIONS)
  .filter(([, write]) => write.workload === workload)
  .map(([id]) => [id, { operationId: id, state: 'live-qualified', enabled: true, reasons: [] }]));

const execute = (client, tenantRef, workload, artifact, live, qualifications = enabled(workload), options = {}) => executeWorkloadSettingsRestore(client, {
  tenantRef, artifactId: artifact.id, tenantId: TENANT, workload, read: readFor(workload), powershell: live.powershell, qualifications, ...options,
});

async function approveEffects(client, tenantRef, artifact, plan) {
  const approver = await principal(client, 'approver', 'approver');
  await approveContentEffects(client, {
    tenantRef, artifactId: artifact.id, approverId: approver, effectsDigest: contentEffectsDigest(plan.contentEffects), justification: 'KEEL-RT- fixture restore',
  });
}

// ------------------------------------------------------------ every family

for (const workload of Object.keys(WORKLOADS)) {
  test(`${workload}: every written family is restored, verified, and a second run writes nothing`, async (t) => {
    const client = await schemaClient(t);
    const tenantRef = nextTenant();
    const live = fakeTenant(workload);
    const source = await recordSource(client, tenantRef, workload, live);
    assert.ok(['complete', 'partial'].includes(source.outcome));

    // Drift the first written field of every object. Putting back a value that would
    // weaken mail protection (here: a spam action KEEL cannot rank) is listed, not written.
    const drifted = [];
    const weakening = [];
    for (const [id, write] of Object.entries(WKLD_WRITE_OPERATIONS)) {
      if (write.workload !== workload || !id.endsWith('.update')) continue;
      for (const body of live.state[getKey(WORKLOADS[workload].families[write.family])]) {
        const field = write.fields[0];
        const original = body[field];
        body[field] = `${original}-drifted`;
        (weakensMailProtection(write.resourceType, field, body[field], original) ? weakening : drifted).push(`${write.method}:${field}`);
      }
    }
    const { plan, artifact } = await planned(client, tenantRef, workload, { source, live });
    assert.deepEqual(plan.refusals, []);
    assert.equal(plan.manual.filter((entry) => entry.weakensProtection === true).length, weakening.length, 'each weakening change is listed for an administrator');
    const updates = plan.operations.filter((op) => op.kind === 'update');
    assert.equal(updates.length, drifted.length, 'one update per drifted object');
    assert.ok(updates.every((op) => op.changes.length === 1 && op.changes[0].after.startsWith('KEEL-RT-')));
    assert.ok(updates.every((op) => Object.keys(op.parameters).every((name) => name === 'Identity' || WKLD_WRITE_OPERATIONS[op.operationId].fields.includes(name))));
    if (plan.contentEffects.length) await approveEffects(client, tenantRef, artifact, plan);

    const result = await execute(client, tenantRef, workload, artifact, live);
    assert.equal(result.outcome, 'verified', JSON.stringify(result.operations.filter((op) => op.outcome !== 'verified')));
    assert.equal(live.writes.length, updates.length);
    assert.ok(live.writes.every((write) => /^Set-/.test(write.cmdlet)), 'only Set- cmdlets: nothing is deleted');

    // Idempotent: the restored tenant matches the source, so nothing is planned or sent.
    live.writes.length = 0;
    const again = await planned(client, tenantRef, workload, { source, live });
    assert.deepEqual(again.plan.operations, []);
    const second = await execute(client, tenantRef, workload, again.artifact, live);
    assert.equal(second.outcome, 'no-change');
    assert.deepEqual(live.writes, []);
  });
}

// ------------------------------------------------------------ specific rules

test('without a qualification every write is disabled and nothing is sent', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = fakeTenant('exchange-mail-flow');
  const source = await recordSource(client, tenantRef, 'exchange-mail-flow', live);
  live.state['Get-TransportRule'][0].Comments = 'changed by an administrator';
  const { artifact } = await planned(client, tenantRef, 'exchange-mail-flow', { source, live });
  const result = await execute(client, tenantRef, 'exchange-mail-flow', artifact, live, {});
  assert.equal(result.outcome, 'disabled');
  assert.match(result.operations[0].reasons[0], /no write qualification was supplied for mailflow\.transport-rule\.update/);
  assert.deepEqual(live.writes, []);
});

test('mail flow: a deleted rule is not re-created, a new one is never deleted, State and structured values are listed', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = fakeTenant('exchange-mail-flow');
  const rule = live.state['Get-TransportRule'][0];
  rule.Mode = 'Enforce';
  rule.Conditions = ['KEEL-RT-condition'];
  const source = await recordSource(client, tenantRef, 'exchange-mail-flow', live);
  const removed = live.state['Get-InboundConnector'].pop();
  live.state['Get-OutboundConnector'].push(fixture('exchange-mail-flow', 'outboundConnector'));
  rule.State = 'Disabled';
  rule.Mode = 'Audit';
  rule.SentTo = { Name: 'structured' };
  const { plan, artifact } = await planned(client, tenantRef, 'exchange-mail-flow', { source, live });
  const manual = (field, key = `transport-rule:${rule.Guid}`) => plan.manual.find((item) => item.resourceKey === key && item.field === field);
  assert.match(plan.manual.find((item) => item.resourceKey === `inbound-connector:${removed.Guid}`).reason, /does not re-create it/);
  assert.ok(plan.manual.some((item) => /never deletes it/.test(item.reason)));
  assert.match(manual('State').reason, /Enable-\/Disable-/);
  // The live value is structured, but the source value is text: that is sendable and restored.
  assert.deepEqual(plan.operations.map((op) => [op.cmdlet, op.parameters]), [['Set-TransportRule', { Identity: rule.Guid, Mode: 'Enforce', SentTo: 'KEEL-RT-SentTo' }]]);
  // Every change to a transport rule reaches different mail, so it needs the separate approval.
  assert.deepEqual(effectsOf(plan), ['Mode:irreversible', 'SentTo:irreversible']);
  await approveEffects(client, tenantRef, artifact, plan);

  // A lost answer is reconciled by re-reading, never resent.
  const crashing = fakeTenant('exchange-mail-flow', { state: live.state, hooks: { cmdlet: () => 'apply-then-crash' } });
  const result = await execute(client, tenantRef, 'exchange-mail-flow', artifact, crashing);
  assert.equal(result.outcome, 'verified');
  assert.match(result.operations[0].reasons[0], /unknown .*not resent/);
  assert.equal(crashing.writes.length, 1);

  // A structured source value is never sent.
  const tenant2 = nextTenant();
  const other = fakeTenant('exchange-mail-flow');
  other.state['Get-TransportRule'][0].SentTo = { Name: 'structured' };
  const structuredSource = await recordSource(client, tenant2, 'exchange-mail-flow', other);
  other.state['Get-TransportRule'][0].SentTo = 'KEEL-RT-now';
  const second = await planned(client, tenant2, 'exchange-mail-flow', { source: structuredSource, live: other });
  assert.deepEqual(second.plan.operations, []);
  assert.match(second.plan.manual.find((item) => item.field === 'SentTo').reason, /structured/);
});

// Q161: rules, connectors and policies are keyed by Guid, so `--target transport-rule:<name>`
// matched nothing and planned 0 changes without saying why.
test('mail flow: a target by name plans the same change as its Guid key; a shared name refuses and lists the Guid keys', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = fakeTenant('exchange-mail-flow');
  const rule = live.state['Get-TransportRule'][0];
  rule.Name = 'KEEL-RT-svc-change';
  rule.Mode = 'Audit';
  const source = await recordSource(client, tenantRef, 'exchange-mail-flow', live);
  rule.Mode = 'Enforce';
  const key = `transport-rule:${rule.Guid.toLowerCase()}`;

  const byName = await planned(client, tenantRef, 'exchange-mail-flow', { source, live, targets: ['transport-rule:keel-rt-SVC-change'] });
  const byGuid = await planned(client, tenantRef, 'exchange-mail-flow', { source, live, targets: [key] });
  assert.deepEqual(byName.plan.targets, [key]);
  assert.deepEqual(byName.plan.operations.map((op) => [op.cmdlet, op.parameters]), [['Set-TransportRule', { Identity: rule.Guid, Mode: 'Audit' }]]);
  assert.deepEqual(byName.plan.operations, byGuid.plan.operations);
  assert.equal(byName.plan.digest, byGuid.plan.digest);

  // A name nothing has is still listed as found nowhere, never silently dropped.
  const missing = await planned(client, tenantRef, 'exchange-mail-flow', { source, live, targets: ['transport-rule:KEEL-RT-absent'] });
  assert.deepEqual(missing.plan.operations, []);
  assert.deepEqual(missing.plan.manual.map((item) => [item.resourceKey, item.reason]), [['transport-rule:keel-rt-absent', 'neither the source nor the live read has this object']]);

  // Two rules with that name (one renamed into it since the backup, say): refused, each Guid key named.
  const twin = fixture('exchange-mail-flow', 'transportRule');
  twin.Name = 'KEEL-RT-svc-change';
  live.state['Get-TransportRule'].push(twin);
  const read = await readFor('exchange-mail-flow')({ powershell: live.powershell });
  assert.throws(
    () => planWorkloadSettingsRestore({ workload: 'exchange-mail-flow', source, live: read, tenantId: TENANT, tenantRef, targets: ['transport-rule:KEEL-RT-svc-change'] }),
    (error) => /names 2 objects; these are keyed by Guid/.test(error.message)
      && error.message.includes(`--target ${key}`) && error.message.includes(`--target transport-rule:${twin.Guid.toLowerCase()}`),
  );
});

test('every Guid-keyed workload resolves a target by name to the Guid key of that kind only', async (t) => {
  const client = await schemaClient(t);
  for (const workload of Object.keys(WORKLOADS).filter((name) => WORKLOADS[name].keyed === 'guid')) {
    const tenantRef = nextTenant();
    const live = fakeTenant(workload);
    const source = await recordSource(client, tenantRef, workload, live);
    const named = source.observations.filter((item) => typeof item.fields?.Name === 'string');
    assert.ok(named.length > 0, `${workload} has named objects`);
    for (const observation of named) {
      const prefix = observation.resourceKey.slice(0, observation.resourceKey.indexOf(':'));
      assert.deepEqual(resolveNamedTargets([`${prefix}:${observation.fields.Name}`], source.observations), [observation.resourceKey], `${workload} ${prefix}`);
    }
  }
  // The kind is part of the match: a name under another kind's prefix resolves to nothing.
  const observations = [{ resourceKey: 'transport-rule:00000000-0000-4000-8000-000000000001', fields: { Name: 'KEEL-RT-x' } }];
  assert.deepEqual(resolveNamedTargets(['inbound-connector:KEEL-RT-x'], observations), ['inbound-connector:keel-rt-x']);
  // An empty name never matches an object whose Name was not read.
  assert.deepEqual(resolveNamedTargets(['transport-rule:'], [{ resourceKey: 'transport-rule:00000000-0000-4000-8000-000000000002', fields: {} }]), ['transport-rule:']);
  // Non-Guid keys (domains, Teams policies) are matched as written, as before.
  const domains = [{ resourceKey: 'accepted-domain:contoso.com', fields: { Name: 'Contoso' } }];
  assert.deepEqual(resolveNamedTargets(['accepted-domain:Contoso'], domains), ['accepted-domain:contoso']);
  assert.deepEqual(resolveNamedTargets(['accepted-domain:contoso.com'], domains), ['accepted-domain:contoso.com']);
});

test('mail flow: a rule that would delete or copy mail is a content effect held for a separate approval', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = fakeTenant('exchange-mail-flow');
  const rule = live.state['Get-TransportRule'][0];
  rule.DeleteMessage = true;
  rule.BlindCopyTo = ['keel-rt-archive@contoso.test'];
  const source = await recordSource(client, tenantRef, 'exchange-mail-flow', live);
  rule.DeleteMessage = false;
  rule.BlindCopyTo = [];
  const { plan, artifact, requestedBy } = await planned(client, tenantRef, 'exchange-mail-flow', { source, live });
  assert.deepEqual(plan.contentEffects.map((effect) => `${effect.field}:${effect.effect}`), ['BlindCopyTo:externally-sharing', 'DeleteMessage:irreversible']);

  const blocked = await execute(client, tenantRef, 'exchange-mail-flow', artifact, live);
  assert.equal(blocked.outcome, 'blocked-content-effect');
  assert.deepEqual(live.writes, []);
  await assert.rejects(approveContentEffects(client, {
    tenantRef, artifactId: artifact.id, approverId: requestedBy, effectsDigest: contentEffectsDigest(plan.contentEffects), justification: 'self',
  }), /only a principal currently holding approve|someone other than the requester/);
  await approveEffects(client, tenantRef, artifact, plan);
  const approved = await execute(client, tenantRef, 'exchange-mail-flow', artifact, live);
  assert.equal(approved.outcome, 'verified');
  assert.equal(rule.DeleteMessage, true);
});

test('Teams: a deleted named policy is re-created as itself and listed for assignment; Global is only updated', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = fakeTenant('teams-voice-policies');
  const source = await recordSource(client, tenantRef, 'teams-voice-policies', live);
  const callingPolicies = live.state['Get-CsTeamsCallingPolicy'];
  const named = callingPolicies.find((body) => body.Identity === 'Tag:KEEL-RT-callingPolicy');
  live.state['Get-CsTeamsCallingPolicy'] = callingPolicies.filter((body) => body !== named);
  const { plan, artifact } = await planned(client, tenantRef, 'teams-voice-policies', { source, live });
  assert.deepEqual(plan.operations.map((op) => [op.kind, op.cmdlet, op.parameters.Identity]), [['add', 'New-CsTeamsCallingPolicy', 'KEEL-RT-callingPolicy']]);
  assert.deepEqual(plan.contentEffects, [], 'a re-created policy is assigned to nobody');
  assert.ok(plan.manual.some((item) => item.resourceKey === 'calling-policy:tag:keel-rt-callingpolicy' && /assigns it again/.test(item.reason)));
  const result = await execute(client, tenantRef, 'teams-voice-policies', artifact, live);
  assert.equal(result.outcome, 'verified');
  assert.equal(live.state['Get-CsTeamsCallingPolicy'].length, 2);

  live.writes.length = 0;
  const again = await planned(client, tenantRef, 'teams-voice-policies', { source, live });
  assert.deepEqual(again.plan.operations, []);
  assert.equal((await execute(client, tenantRef, 'teams-voice-policies', again.artifact, live)).outcome, 'no-change');
  assert.deepEqual(live.writes, []);
});

test('Teams: meeting policies are backed up and compared, and every difference is listed for an administrator', async (t) => {
  // Teams refuses New- and Set-CsTeamsMeetingPolicy to the app-only Restorer (403, errorCode 40301).
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = fakeTenant('teams-org-policies');
  // Not a written family, so the fake tenant does not seed it.
  const named = fixture('teams-org-policies', 'meetingPolicy', { identity: 'Tag:KEEL-RT-meetingPolicy' });
  const meetings = [fixture('teams-org-policies', 'meetingPolicy'), named];
  live.state['Get-CsTeamsMeetingPolicy'] = meetings;
  Object.assign(meetings[0], { AllowAnonymousUsersToJoinMeeting: true, NewMeetingRecordingExpirationDays: 30 });
  const source = await recordSource(client, tenantRef, 'teams-org-policies', live);
  live.state['Get-CsTeamsMeetingPolicy'] = meetings.filter((body) => body !== named);
  Object.assign(meetings[0], { AllowAnonymousUsersToJoinMeeting: false, NewMeetingRecordingExpirationDays: 120 });
  assert.equal(writeFamilies('teams-org-policies').meetingPolicy, undefined);

  const { plan } = await planned(client, tenantRef, 'teams-org-policies', { source, live });
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.contentEffects, []);
  const listed = plan.manual.filter((item) => item.resourceKey.startsWith('meeting-policy:'));
  assert.deepEqual(listed.map((item) => [item.resourceKey, item.field]), [
    ['meeting-policy:global', 'AllowAnonymousUsersToJoinMeeting'],
    ['meeting-policy:global', 'NewMeetingRecordingExpirationDays'],
    ['meeting-policy:tag:keel-rt-meetingpolicy', null],
  ]);
  assert.deepEqual([listed[0].before, listed[0].after], [false, true]);
  for (const item of listed) assert.match(item.reason, /Teams refuses changes to meeting policies/);
  assert.match(listed[2].reason, /no longer exists.*re-creates it/);
  assert.deepEqual(live.writes, []);
  for (const cmdlet of ['New-CsTeamsMeetingPolicy', 'Set-CsTeamsMeetingPolicy']) {
    await assert.rejects(workloadWriteCmdlet({ cmdlet, parameters: { Identity: 'KEEL-RT-x' } }), WorkloadWriteScopeError);
  }
});

test('Purview: shortening retention is held for approval, and a preservation lock refuses the policy and its rules', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = fakeTenant('purview-retention-dlp');
  const retentionRule = live.state['Get-RetentionComplianceRule'][0];
  retentionRule.RetentionDuration = 365;
  retentionRule.RetentionComplianceAction = 'Keep';
  const source = await recordSource(client, tenantRef, 'purview-retention-dlp', live);
  retentionRule.RetentionDuration = 3650;
  const { plan, artifact } = await planned(client, tenantRef, 'purview-retention-dlp', { source, live });
  assert.deepEqual(plan.contentEffects.map((effect) => `${effect.field}:${effect.effect}:${effect.before}->${effect.after}`), ['RetentionDuration:retention-reducing:3650->365']);
  assert.match(plan.contentEffects[0].disclosure, /not recoverable by KEEL/);
  const blocked = await execute(client, tenantRef, 'purview-retention-dlp', artifact, live);
  assert.equal(blocked.outcome, 'blocked-content-effect');
  assert.deepEqual(live.writes, []);
  await approveEffects(client, tenantRef, artifact, plan);
  assert.equal((await execute(client, tenantRef, 'purview-retention-dlp', artifact, live)).outcome, 'verified');
  assert.equal(retentionRule.RetentionDuration, 365);

  // Locked when planned: the policy and the rule under it are refused, nothing is sent.
  const tenant2 = nextTenant();
  const locked = fakeTenant('purview-retention-dlp');
  const lockedSource = await recordSource(client, tenant2, 'purview-retention-dlp', locked);
  const policy = locked.state['Get-RetentionCompliancePolicy'][0];
  policy.RestrictiveRetention = true;
  policy.Comment = 'changed';
  locked.state['Get-RetentionComplianceRule'][0].Comment = 'changed';
  const refused = await planned(client, tenant2, 'purview-retention-dlp', { source: lockedSource, live: locked });
  assert.equal(refused.artifact.status, 'refused');
  assert.equal(refused.plan.refusals.length, 2);
  assert.ok(refused.plan.refusals.every((item) => /preservation-locked/.test(item.reason)));
  assert.equal((await execute(client, tenant2, 'purview-retention-dlp', refused.artifact, locked)).outcome, 'refused');
  assert.deepEqual(locked.writes, []);

  // The platform refuses for a lock: recorded once, never retried.
  const tenant3 = nextTenant();
  const platform = fakeTenant('purview-retention-dlp', {
    hooks: { cmdlet: () => ({ error: { message: 'The policy is under Preservation Lock and cannot be changed.', category: 'InvalidOperation', errorId: 'PreservationLockException' } }) },
  });
  const platformSource = await recordSource(client, tenant3, 'purview-retention-dlp', platform);
  platform.state['Get-DlpCompliancePolicy'][0].Comment = 'changed';
  const third = await planned(client, tenant3, 'purview-retention-dlp', { source: platformSource, live: platform });
  const result = await execute(client, tenant3, 'purview-retention-dlp', third.artifact, platform);
  assert.deepEqual(result.operations.map((op) => op.outcome), ['refused']);
  assert.equal(platform.writes.length, 1);
});

test('a change after the plan makes only that object stale', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = fakeTenant('exchange-extended');
  const source = await recordSource(client, tenantRef, 'exchange-extended', live);
  live.state['Get-JournalRule'][0].Scope = 'Internal';
  live.state['Get-AddressList'][0].DisplayName = 'renamed';
  const { plan, artifact } = await planned(client, tenantRef, 'exchange-extended', { source, live });
  await approveEffects(client, tenantRef, artifact, plan);
  live.state['Get-AddressList'][0].RecipientFilter = 'edited by an administrator';
  const result = await execute(client, tenantRef, 'exchange-extended', artifact, live);
  assert.deepEqual(result.operations.map((op) => [op.cmdlet ?? op.operationId, op.outcome]).sort(), [
    ['exchange-extended.address-list.update', 'stale'], ['exchange-extended.journal-rule.update', 'verified'],
  ]);
  assert.deepEqual(live.writes.map((write) => write.cmdlet), ['Set-JournalRule']);
});

test('effects: a deleting rule moved to Enforce', async (t) => {
  const client = await schemaClient(t);
  // A rule that deletes mail reaches more mail when it moves from Audit to Enforce.
  const tenant3 = nextTenant();
  const mail = fakeTenant('exchange-mail-flow');
  const rule = mail.state['Get-TransportRule'][0];
  for (const action of TRANSPORT_ACTIONS) rule[action] = null;
  Object.assign(rule, { DeleteMessage: true, Quarantine: false, Mode: 'Enforce' });
  const mailSource = await recordSource(client, tenant3, 'exchange-mail-flow', mail);
  rule.Mode = 'Audit';
  const enforce = await planned(client, tenant3, 'exchange-mail-flow', { source: mailSource, live: mail });
  assert.deepEqual(effectsOf(enforce.plan), ['Mode:irreversible']);

  // An action KEEL does not write (CopyTo) still makes a change to the rule a content effect.
  const tenant5 = nextTenant();
  const copying = fakeTenant('exchange-mail-flow');
  const copier = copying.state['Get-TransportRule'][0];
  for (const action of TRANSPORT_ACTIONS) copier[action] = null;
  Object.assign(copier, { DeleteMessage: false, Quarantine: false, Actions: ['CopyTo'], Mode: 'Enforce' });
  const copySource = await recordSource(client, tenant5, 'exchange-mail-flow', copying);
  copier.Mode = 'Audit';
  const copy = await planned(client, tenant5, 'exchange-mail-flow', { source: copySource, live: copying });
  assert.deepEqual(effectsOf(copy.plan), ['Mode:externally-sharing']);

  // A spam rule decides which mailboxes its policy (auto-forwarding, deleting spam) covers.
  const tenant6 = nextTenant();
  const spam = fakeTenant('exchange-extended');
  const spamSource = await recordSource(client, tenant6, 'exchange-extended', spam);
  spam.state['Get-HostedOutboundSpamFilterRule'][0].From = ['keel-rt-narrowed@contoso.test'];
  spam.state['Get-HostedOutboundSpamFilterRule'][0].Comments = 'narrowed after an incident';
  const widened = await planned(client, tenant6, 'exchange-extended', { source: spamSource, live: spam });
  assert.deepEqual(effectsOf(widened.plan), ['From:externally-sharing']);

  // Quarantining is a loss too, both when it is turned on and on the rest of such a rule.
  const tenant4 = nextTenant();
  const held = fakeTenant('exchange-mail-flow');
  const quarantine = held.state['Get-TransportRule'][0];
  for (const action of TRANSPORT_ACTIONS) quarantine[action] = null;
  Object.assign(quarantine, { DeleteMessage: false, Quarantine: true, Mode: 'Enforce' });
  const heldSource = await recordSource(client, tenant4, 'exchange-mail-flow', held);
  Object.assign(quarantine, { Quarantine: false, Mode: 'Audit' });
  const quarantined = await planned(client, tenant4, 'exchange-mail-flow', { source: heldSource, live: held });
  assert.deepEqual(effectsOf(quarantined.plan), ['Mode:irreversible', 'Quarantine:irreversible']);
});

test('a write with no answer that did not apply is failed once and never resent', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = fakeTenant('exchange-extended');
  const source = await recordSource(client, tenantRef, 'exchange-extended', live);
  live.state['Get-AddressList'][0].DisplayName = 'renamed';
  const { artifact } = await planned(client, tenantRef, 'exchange-extended', { source, live });
  const crashing = fakeTenant('exchange-extended', { state: live.state, hooks: { cmdlet: () => 'crash' } });
  const result = await execute(client, tenantRef, 'exchange-extended', artifact, crashing);
  assert.deepEqual(result.operations.map((op) => [op.outcome, op.writes]), [['failed', 1]]);
  assert.match(result.operations[0].reasons[0], /not resent/);
  assert.equal(crashing.writes.length, 1);
  assert.equal(live.state['Get-AddressList'][0].DisplayName, 'renamed');
});

test('a rule whose policy was not read, or a read stopped at its limit, plans nothing', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = fakeTenant('purview-retention-dlp');
  const source = await recordSource(client, tenantRef, 'purview-retention-dlp', live);
  const rule = live.state['Get-RetentionComplianceRule'][0];
  rule.Comment = 'changed';
  const read = await readFor('purview-retention-dlp')({ powershell: live.powershell });
  // The policy is missing from the live read: its lock is unknown, so the rule is not changed.
  const withoutPolicy = { ...read, resources: read.resources.filter((item) => item.kind !== 'retentionPolicy') };
  const orphan = planWorkloadSettingsRestore({ workload: 'purview-retention-dlp', source, live: withoutPolicy, tenantId: TENANT, tenantRef });
  assert.ok(orphan.operations.every((op) => op.family !== 'retentionRule'));
  assert.ok(orphan.manual.some((item) => /preservation lock is unknown/.test(item.reason)));
  // A rule the collector could not tie to any policy has an unknown lock too.
  const unnamed = { ...read, resources: read.resources.map((item) => (item.kind === 'retentionRule' ? { ...item, parentPolicy: null, parentStatus: 'none' } : item)) };
  const noPolicy = planWorkloadSettingsRestore({ workload: 'purview-retention-dlp', source, live: unnamed, tenantId: TENANT, tenantRef });
  assert.ok(noPolicy.operations.every((op) => op.family !== 'retentionRule'));
  // A capped read may have missed objects: every family is a gap.
  const capped = planWorkloadSettingsRestore({ workload: 'purview-retention-dlp', source, live: { ...read, discovery: { ...read.discovery, capped: true } }, tenantId: TENANT, tenantRef });
  assert.deepEqual(capped.operations, []);
  assert.ok(capped.manual.every((item) => /capped at its object limit/.test(item.reason)));
});

test('each write re-reads first: a policy gone after the plan makes its rule stale, and nothing is sent', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = fakeTenant('purview-retention-dlp');
  const source = await recordSource(client, tenantRef, 'purview-retention-dlp', live);
  live.state['Get-RetentionComplianceRule'][0].Comment = 'changed';
  const { plan, artifact } = await planned(client, tenantRef, 'purview-retention-dlp', { source, live });
  assert.deepEqual(plan.operations.map((op) => op.family), ['retentionRule']);
  live.state['Get-RetentionCompliancePolicy'] = [];
  const result = await execute(client, tenantRef, 'purview-retention-dlp', artifact, live);
  assert.deepEqual(result.operations.map((op) => op.outcome), ['stale']);
  assert.deepEqual(live.writes, []);
});

test('mail flow: connector trust, certificate and sender-IP fields are listed for an administrator, never written', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = fakeTenant('exchange-mail-flow');
  // The backup holds trust values an attacker or a stale copy could plant.
  const inbound = live.state['Get-InboundConnector'][0];
  const outbound = live.state['Get-OutboundConnector'][0];
  Object.assign(inbound, {
    TlsSenderCertificateName: '*.attacker.example', RestrictDomainsToCertificate: true, TreatMessagesAsInternal: true,
    TrustedOrganizations: ['attacker.example'], SenderIPAddresses: ['203.0.113.0/24'], RestrictDomainsToIPAddresses: true, EFSkipIPs: ['203.0.113.9'], RequireTls: false,
  });
  Object.assign(outbound, { TlsSettings: 'EncryptionOnly', TlsDomain: '*.attacker.example', SmartHosts: ['relay.attacker.example'] });
  const source = await recordSource(client, tenantRef, 'exchange-mail-flow', live);
  // Live has moved on (a partner certificate rotation, a removed range), and one harmless field drifted too.
  Object.assign(inbound, {
    TlsSenderCertificateName: 'mail.partner.example', RestrictDomainsToCertificate: false, TreatMessagesAsInternal: false,
    TrustedOrganizations: [], SenderIPAddresses: ['198.51.100.10'], RestrictDomainsToIPAddresses: false, EFSkipIPs: [], RequireTls: true,
    Comment: 'changed by an administrator',
  });
  Object.assign(outbound, { TlsSettings: 'DomainValidation', TlsDomain: 'mail.partner.example', SmartHosts: ['relay.partner.example'] });

  const { plan, artifact } = await planned(client, tenantRef, 'exchange-mail-flow', { source, live });
  const trustEntries = (key) => plan.manual.filter((item) => item.resourceKey === key && item.trust === true).map((item) => item.field).sort();
  assert.deepEqual(trustEntries(`inbound-connector:${inbound.Guid}`), [...TRUST_FIELDS.exchangeInboundConnector].sort());
  assert.deepEqual(trustEntries(`outbound-connector:${outbound.Guid}`), [...TRUST_FIELDS.exchangeOutboundConnector].sort());
  assert.ok(plan.manual.filter((item) => item.trust).every((item) => /never changes it/.test(item.reason) && /Exchange admin center/.test(item.reason)));
  // Only the harmless field is written.
  assert.deepEqual(plan.operations.map((op) => [op.cmdlet, op.parameters]), [['Set-InboundConnector', { Identity: inbound.Guid, Comment: 'KEEL-RT-Comment' }]]);

  const result = await execute(client, tenantRef, 'exchange-mail-flow', artifact, live);
  assert.equal(result.outcome, 'verified', JSON.stringify(result.operations));
  assert.deepEqual(live.writes.map((write) => Object.keys(write.parameters).sort()), [['Comment', 'Identity']]);
  assert.equal(inbound.TlsSenderCertificateName, 'mail.partner.example');
  assert.equal(inbound.TreatMessagesAsInternal, false);
  assert.equal(outbound.TlsDomain, 'mail.partner.example');
  assert.deepEqual(outbound.SmartHosts, ['relay.partner.example']);

  // An altered plan cannot send them either: the engine refuses before a job is built,
  // and the container allowlist (run-cmdlet.ps1) does not carry them.
  await assert.rejects(workloadWriteCmdlet({ cmdlet: 'Set-InboundConnector', parameters: { Identity: inbound.Guid, TlsSenderCertificateName: '*.attacker.example' } }), /does not take TlsSenderCertificateName/);
  await assert.rejects(workloadWriteCmdlet({ cmdlet: 'Set-OutboundConnector', parameters: { Identity: outbound.Guid, TlsDomain: '*.attacker.example' } }), /does not take TlsDomain/);
  await assert.rejects(workloadWriteCmdlet({ cmdlet: 'Set-OutboundConnector', parameters: { Identity: outbound.Guid, SmartHosts: ['relay.attacker.example'] } }), /does not take SmartHosts/);
  const shipped = allowlist(WRITE_TABLES.exo);
  for (const field of TRUST_FIELDS.exchangeInboundConnector) assert.ok(!shipped['Set-InboundConnector'].includes(field), field);
  for (const field of TRUST_FIELDS.exchangeOutboundConnector) assert.ok(!shipped['Set-OutboundConnector'].includes(field), field);
});

// Trust fields outside connectors: the backup plants a value that would widen trust,
// live holds another, and one harmless field drifted too.
const TRUST_CASES = [
  {
    name: 'connection filter: allowed sender IP ranges and the safe list',
    workload: 'exchange-extended', getter: 'Get-HostedConnectionFilterPolicy', cmdlet: 'Set-HostedConnectionFilterPolicy', resourceType: 'exchangeConnectionFilterPolicy',
    planted: { IPAllowList: ['203.0.113.0/24'], EnableSafeList: true },
    current: { IPAllowList: [], EnableSafeList: false },
    harmless: ['AdminDisplayName', 'changed by an administrator'],
    where: /Microsoft Defender portal .*Connection filter policy/,
    altered: { IPAllowList: ['203.0.113.0/24'] },
  },
  {
    name: 'Teams federation: federated organizations, allowed and blocked domains, SIP space and discovered partners',
    workload: 'teams-org-policies', getter: 'Get-CsTenantFederationConfiguration', cmdlet: 'Set-CsTenantFederationConfiguration', resourceType: 'teamsFederationConfiguration',
    planted: {
      AllowFederatedUsers: true, AllowedDomains: ['attacker.example'], BlockedDomains: [], SharedSipAddressSpace: true, TreatDiscoveredPartnersAsUnverified: false,
    },
    current: {
      AllowFederatedUsers: false, AllowedDomains: ['partner.example'], BlockedDomains: ['blocked.example'], SharedSipAddressSpace: false, TreatDiscoveredPartnersAsUnverified: true,
    },
    harmless: ['BlockAllSubdomains', true],
    where: /Teams admin center > Users > External access/,
    altered: { AllowFederatedUsers: true },
  },
];
for (const c of TRUST_CASES) {
  test(`${c.name} are listed for an administrator, never written`, async (t) => {
    const client = await schemaClient(t);
    const tenantRef = nextTenant();
    const live = fakeTenant(c.workload);
    const [body] = live.state[c.getter];
    Object.assign(body, c.planted);
    const source = await recordSource(client, tenantRef, c.workload, live);
    Object.assign(body, c.current, { [c.harmless[0]]: c.harmless[1] });

    const { plan, artifact } = await planned(client, tenantRef, c.workload, { source, live });
    const trust = plan.manual.filter((item) => item.trust === true);
    assert.deepEqual(trust.map((item) => item.field).sort(), Object.keys(c.planted).sort());
    assert.ok(Object.keys(c.planted).every((field) => TRUST_FIELDS[c.resourceType].includes(field)));
    for (const item of trust) {
      assert.match(item.reason, /never changes it/);
      assert.match(item.reason, c.where);
      assert.deepEqual(item.after, c.planted[item.field]);
    }
    // Only the harmless field is written.
    const sent = plan.operations.filter((op) => op.cmdlet === c.cmdlet);
    assert.deepEqual(sent.map((op) => Object.keys(op.parameters).sort()), [['Identity', c.harmless[0]].sort()]);
    if (plan.contentEffects.length) await approveEffects(client, tenantRef, artifact, plan);

    const result = await execute(client, tenantRef, c.workload, artifact, live);
    assert.equal(result.outcome, 'verified', JSON.stringify(result.operations));
    assert.ok(live.writes.every((write) => Object.keys(write.parameters).every((name) => !TRUST_FIELDS[c.resourceType].includes(name))));
    for (const [field, value] of Object.entries(c.current)) assert.deepEqual(body[field], value, field);

    // An altered plan cannot send them, and the container allowlist does not carry them.
    const [field] = Object.keys(c.altered);
    await assert.rejects(workloadWriteCmdlet({ cmdlet: c.cmdlet, parameters: { Identity: body.Guid ?? body.Identity, ...c.altered } }), new RegExp(`does not take ${field}`));
    const shipped = { ...allowlist(WRITE_TABLES.exo), ...allowlist(WRITE_TABLES.teams) };
    for (const name of TRUST_FIELDS[c.resourceType]) assert.ok(!shipped[c.cmdlet].includes(name), name);
  });
}

test('no write declares a trust, certificate or sign-in field', () => {
  for (const [id, write] of Object.entries(WKLD_WRITE_OPERATIONS)) {
    assert.deepEqual(write.fields.filter((field) => isTrustField(write.resourceType, field)), [], id);
  }
  // The name check bites on fields no list names yet.
  assert.ok(['TlsSenderCertificateName', 'SigningCertificate', 'TrustedOrganizations', 'PassiveSignInUri', 'IssuerUri'].every((field) => isTrustField('anything', field)));
  assert.ok(!isTrustField('exchangeTransportRule', 'RouteMessageOutboundRequireTls'));
});

// ------------------------------------------------------------ declarations

test('run-cmdlet.ps1 allows exactly the declared write cmdlets and parameters, and no deleting cmdlet', () => {
  const declared = writeCmdletParameters();
  for (const [session, variable] of Object.entries(WRITE_TABLES)) {
    const shipped = allowlist(variable);
    const expected = Object.fromEntries(Object.entries(declared).filter(([, entry]) => entry.session === session).map(([name, entry]) => [name, entry.parameters]));
    assert.deepEqual(Object.fromEntries(Object.entries(shipped).map(([name, parameters]) => [name, [...parameters].sort()])), expected, variable);
  }
  assert.ok(Object.keys(declared).every((name) => /^(Set|New)-/.test(name)));
  assert.ok(Object.values(WKLD_WRITE_OPERATIONS).every((write) => write.grantsRequired === true && write.requires.length === 1));
  // The JS side refuses anything undeclared before a job is built.
  return Promise.all([
    assert.rejects(workloadWriteCmdlet({ cmdlet: 'Remove-TransportRule', parameters: { Identity: guid() } }), WorkloadWriteScopeError),
    assert.rejects(workloadWriteCmdlet({ cmdlet: 'Set-TransportRule', parameters: { Identity: guid(), State: 'Disabled' } }), /does not take State/),
  ]);
});

test('every written field that looks content-bearing has an effect rule or a stated reason', () => {
  assert.deepEqual(unreviewedWrittenFields(), []);
  // The check bites: a declared retention field with no rule is reported.
  const fake = { 'x.update': { resourceType: 'unreviewed', fields: ['RetentionDays', 'Comment'] } };
  assert.deepEqual(unreviewedWrittenFields(fake, WORKLOAD_EFFECT_RULES), ['x.update:RetentionDays']);
  for (const [type, rules] of Object.entries(WORKLOAD_EFFECT_RULES)) {
    const written = new Set(Object.values(WKLD_WRITE_OPERATIONS).filter((write) => write.resourceType === type).flatMap((write) => write.fields));
    for (const entry of rules) assert.ok(written.has(entry.field), `${type}.${entry.field} has a rule but is not written`);
  }
  assert.ok(Object.keys(BENIGN_FIELDS).length > 0);
});

test('dispatch has one entry per written workload, each listing exactly its own writes', () => {
  for (const workload of Object.keys(WORKLOADS)) {
    const entry = WORKLOAD_RESTORES[workload];
    assert.ok(entry, workload);
    assert.deepEqual([...entry.operations].sort(), Object.keys(WKLD_WRITE_OPERATIONS).filter((id) => WKLD_WRITE_OPERATIONS[id].workload === workload).sort());
  }
  // The user and group policy assignments are read but never written.
  assert.equal(writeFamilies('teams-voice-policies').userPolicyAssignment, undefined);
  assert.equal(writeFamilies('teams-voice-policies').groupPolicyAssignment, undefined);
});

// ------------------------------------------------------------ test tenant fixtures (#317)

test('the fixture guard matches the KEEL-RT- prefix only, and only on the test tenant', () => {
  const testTenantRefs = ['sha256:test'];
  const guard = (names, more = {}) => fixtureProblem({ tenantRef: 'sha256:test', testTenantRefs, label: 'x', names, ...more });
  assert.equal(guard(['KEEL-RT-anything']), null);
  assert.equal(guard(['keel-rt-lower case']), null);
  assert.match(guard(['Contoso KEEL-RT-rule']), /not one/);
  assert.match(guard(['KEEL-RT-a', 'Production']), /not one/);
  assert.match(guard([null]), /no name/);
  assert.match(guard(['KEEL-RT-a'], { tenantWide: true }), /tenant-wide/);
  assert.equal(guard(['Global'], { tenantWide: true, allowTenantWide: true }), null);
  // Off the test tenant a restore is not limited to fixtures.
  assert.equal(fixtureProblem({ tenantRef: 'sha256:customer', testTenantRefs, label: 'x', names: ['Production'], tenantWide: true }), null);
  assert.throws(() => fixtureProblem({ tenantRef: null, testTenantRefs, label: 'x', names: [] }), /needs the tenant/);
  assert.equal(isFixtureName('KEEL-RT-'), true);
  assert.equal(isFixtureName('KEEL-R-x'), false);
});

test('on the test tenant a non-fixture object is refused at plan time; a fixture beside it is planned', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const testTenantRefs = [tenantRef];
  const state = tenantState('exchange-mail-flow');
  const production = fixture('exchange-mail-flow', 'transportRule');
  production.Name = 'Contoso outbound disclaimer';
  state['Get-TransportRule'].push(production);
  const live = fakeTenant('exchange-mail-flow', { state });
  const source = await recordSource(client, tenantRef, 'exchange-mail-flow', live);
  for (const rule of live.state['Get-TransportRule']) rule.Comments = 'drifted';

  const { plan, artifact } = await planned(client, tenantRef, 'exchange-mail-flow', { source, live, testTenantRefs });
  const productionKey = plan.targets.find((key) => key.includes(production.Guid.toLowerCase()));
  assert.ok(productionKey);
  assert.deepEqual(plan.refusals.map((refusal) => refusal.naturalKey), [`exchange-mail-flow:${productionKey}`]);
  assert.match(plan.refusals[0].reason, /^not-a-fixture: .*Contoso outbound disclaimer/);
  assert.ok(plan.operations.some((op) => op.family === 'transportRule'));
  assert.ok(plan.operations.every((op) => op.key !== productionKey));
  // A refused plan is never promotable.
  assert.equal(artifact.status, 'refused');
  const result = await execute(client, tenantRef, 'exchange-mail-flow', artifact, live, enabled('exchange-mail-flow'), { testTenantRefs });
  assert.equal(result.outcome, 'refused');
  assert.equal(live.writes.length, 0);

  // Off the test tenant the same restore plans both rules.
  const other = await planned(client, tenantRef, 'exchange-mail-flow', { source, live, testTenantRefs: [] });
  assert.equal(other.plan.refusals.length, 0);
  assert.ok(other.plan.operations.some((op) => op.key === productionKey));
});

test('on the test tenant a fixture name is checked again before writing', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const state = tenantState('exchange-mail-flow');
  const production = fixture('exchange-mail-flow', 'transportRule');
  production.Name = 'Contoso outbound disclaimer';
  state['Get-TransportRule'] = [production];
  const live = fakeTenant('exchange-mail-flow', { state });
  const source = await recordSource(client, tenantRef, 'exchange-mail-flow', live);
  production.Comments = 'drifted';
  // A plan made where the guard did not apply (an older plan) still never writes the test tenant's real objects.
  const { plan, artifact } = await planned(client, tenantRef, 'exchange-mail-flow', { source, live, testTenantRefs: [] });
  const op = plan.operations.find((item) => item.family === 'transportRule');
  assert.ok(op);
  if (plan.contentEffects.length) await approveEffects(client, tenantRef, artifact, plan);
  const result = await execute(client, tenantRef, 'exchange-mail-flow', artifact, live, enabled('exchange-mail-flow'), { testTenantRefs: [tenantRef] });
  const refused = result.operations.find((item) => item.key === op.key);
  assert.equal(refused.outcome, 'refused');
  assert.match(refused.reasons[0], /KEEL-RT- fixtures/);
  assert.ok(live.writes.every((write) => write.parameters.Identity !== production.Guid));
});

test('a Global Teams policy is tenant-wide: refused on the test tenant unless the separate option is on', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const testTenantRefs = [tenantRef];
  const live = fakeTenant('teams-org-policies');
  const source = await recordSource(client, tenantRef, 'teams-org-policies', live);
  const [globalPolicy, namedPolicy] = live.state['Get-CsTeamsMessagingPolicy'];
  assert.equal(globalPolicy.Identity, 'Global');
  assert.equal(namedPolicy.Identity, 'Tag:KEEL-RT-messagingPolicy');
  globalPolicy.Description = 'drifted';
  namedPolicy.Description = 'drifted';
  const targets = ['messaging-policy:global', 'messaging-policy:tag:keel-rt-messagingpolicy'];

  const off = await planned(client, tenantRef, 'teams-org-policies', { source, live, targets, testTenantRefs });
  assert.deepEqual(off.plan.operations.map((op) => op.key), ['messaging-policy:tag:keel-rt-messagingpolicy']);
  assert.deepEqual(off.plan.refusals.map((refusal) => refusal.naturalKey), ['teams-org-policies:messaging-policy:global']);
  assert.match(off.plan.refusals[0].reason, /tenant-wide and needs a dry run made with --allow-tenant-wide-test-writes/);
  assert.equal(off.plan.allowTenantWide, undefined);

  const on = await planned(client, tenantRef, 'teams-org-policies', { source, live, targets, testTenantRefs, allowTenantWide: true });
  assert.deepEqual(on.plan.refusals, []);
  assert.deepEqual(on.plan.operations.map((op) => op.key).sort(), targets.sort());
  assert.equal(on.plan.allowTenantWide, true);
  assert.equal(on.artifact.status, 'completed');
  // The operator's standing approval does not cover a tenant-wide plan; a person approves it.
  const request = { action: 'restore' };
  const covered = { tenantRef, targetTenantId: TENANT, workloadRestore: off.plan };
  const refs = [tenantRef, tenantRefFor(TENANT)];
  assert.equal(standingPolicyRefusal({ policy: OPERATOR_TEST_TENANT_POLICY, tenantRef, request, artifact: covered, testTenantRefs: refs }), null);
  assert.match(standingPolicyRefusal({ policy: OPERATOR_TEST_TENANT_POLICY, tenantRef, request, artifact: { ...covered, workloadRestore: on.plan }, testTenantRefs: refs }), /a person approves it/);

  // With the option the Global policy is written and verified.
  if (on.plan.contentEffects.length) await approveEffects(client, tenantRef, on.artifact, on.plan);
  const result = await execute(client, tenantRef, 'teams-org-policies', on.artifact, live, enabled('teams-org-policies'), { testTenantRefs });
  assert.equal(result.outcome, 'verified');
  assert.equal(globalPolicy.Description, 'KEEL-RT-Description');
});
