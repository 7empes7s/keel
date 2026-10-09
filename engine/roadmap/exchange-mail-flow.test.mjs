// Issue #153: Exchange mail flow and protection settings, read-only.
//
// Acceptance:
//  - each read is declared in workloadContract.mjs, passes the scope validator, is run
//    by the read-only probe, and ships disabled (fixture proof never enables it);
//  - no write capability exists for the workload;
//  - each object is one observation under a stable identity, with declared fields only
//    and nothing credential-shaped stored;
//  - an unlicensed Safe Links / Safe Attachments read is an observation, not a failure.
// Mutation checks:
//  - key transport rules by name instead of Guid (the rename test fails);
//  - count a not-licensed family as a failure (the outcome test fails);
//  - run a Defender read whose own row is not enabled (the activation test fails).
//
// Everything runs against the isolated test database and a fake PowerShell container
// that plays the ops/powershell/run-cmdlet.ps1 contract through the real
// engine/powershell/jobQueue.mjs spawn path. No tenant is touched.
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  CORE_OPERATIONS, FAMILIES, FAMILY_NAMES, MAIL_FLOW_CMDLET_PARAMETERS, MAIL_FLOW_DESCRIPTOR, MAIL_FLOW_OPERATIONS, MAIL_FLOW_WORKLOAD,
  MailFlowScopeError, assertMailFlowCmdlet, collectMailFlow, mailFlowActivation, objectIdentity, readMailFlow,
} from '../collect/workloads/mailFlow.mjs';
import { EXCHANGE_OPERATIONS } from '../collect/workloads/exchange.mjs';
import { WORKLOAD_DESCRIPTORS, buildWorkloadLedger, descriptorProblems } from '../collect/workloadContract.mjs';
import { listWorkloads } from '../collect/registry.mjs';
import { buildCoverageReport } from '../coverage/report.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../coverage/qualification.mjs';
import { planDeletionWaves, planWaves } from '../restore/wavePlanner.mjs';
import { redactPayload } from '../telemetry/events.mjs';
import { runFixtureHarness } from '../../tools/qualification/workloads.mjs';
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

const NOW = new Date('2026-10-09T12:00:00Z');
const EXO_VERSION = '3.5.0';
let tenantSeq = 0;
const nextTenant = () => `sha256:issue-153-${tenantSeq += 1}`;
const guid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000153`;
const WHEN = '2026-09-01T00:00:00Z';

// One or two objects per family, as Exchange answers them, with the extra
// properties a careless reader would keep.
const SAMPLE = Object.freeze({
  'Get-AcceptedDomain': [
    { Name: 'contoso.test', DomainName: 'Contoso.test', DomainType: 'Authoritative', Default: true, MatchSubDomains: false, Guid: guid(1), WhenChangedUTC: WHEN, OrganizationId: 'internal' },
    { Name: 'contoso.onmicrosoft.com', DomainName: 'contoso.onmicrosoft.com', DomainType: 'Authoritative', Default: false, MatchSubDomains: false, Guid: guid(2), WhenChangedUTC: WHEN },
  ],
  'Get-RemoteDomain': [
    { Name: 'Default', DomainName: '*', IsInternal: false, AllowedOOFType: 'External', AutoReplyEnabled: true, AutoForwardEnabled: false, DeliveryReportEnabled: true, NDREnabled: true, NDRDiagnosticInfoEnabled: true, MeetingForwardNotificationEnabled: false, TNEFEnabled: null, ContentType: 'MimeHtmlText', CharacterSet: null, NonMimeCharacterSet: null, TrustedMailInboundEnabled: false, TrustedMailOutboundEnabled: false, UseSimpleDisplayName: false, Guid: guid(3), WhenChangedUTC: WHEN },
  ],
  'Get-TransportRule': [
    {
      Name: 'Block executables', Guid: guid(4), State: 'Enabled', Mode: 'Enforce', Priority: 0, Comments: '', Description: 'If the message: Any attachment has executable content Take the following actions: reject the message', Conditions: ['AttachmentHasExecutableContentPredicate'], Exceptions: null, Actions: ['RejectMessageAction'],
      StopRuleProcessing: false, RuleErrorAction: 'Ignore', SenderAddressLocation: 'Header', ActivationDate: null, ExpiryDate: null,
      From: null, FromScope: null, SentTo: null, SentToScope: null, SenderDomainIs: null, RecipientDomainIs: null, FromAddressContainsWords: null,
      SubjectContainsWords: null, SubjectOrBodyContainsWords: null, AttachmentExtensionMatchesWords: null, AttachmentHasExecutableContent: true,
      SenderIpRanges: null, HeaderContainsMessageHeader: null, HeaderContainsWords: null,
      ExceptIfFrom: null, ExceptIfSentTo: null, ExceptIfSenderDomainIs: null, ExceptIfRecipientDomainIs: null, ExceptIfSenderIpRanges: null,
      SetSCL: null, SetHeaderName: null, SetHeaderValue: null, PrependSubject: null, RedirectMessageTo: null, BlindCopyTo: null, AddToRecipients: null,
      ModerateMessageByUser: null, RejectMessageReasonText: 'Executables are blocked', RejectMessageEnhancedStatusCode: '5.7.1', DeleteMessage: false, Quarantine: false,
      ApplyHtmlDisclaimerText: null, ApplyHtmlDisclaimerLocation: null, ApplyHtmlDisclaimerFallbackAction: null,
      RouteMessageOutboundConnector: null, RouteMessageOutboundRequireTls: false, ApplyRightsProtectionTemplate: null, GenerateIncidentReport: null,
      WhenChangedUTC: WHEN, RuleVersion: '15.0.5.6', ImmutableId: guid(4),
    },
  ],
  'Get-InboundConnector': [
    { Name: 'From partner', Guid: guid(5), Enabled: true, ConnectorType: 'Partner', ConnectorSource: 'Default', Comment: '', SenderDomains: ['smtp:partner.test;1'], SenderIPAddresses: ['203.0.113.0/24'], RestrictDomainsToIPAddresses: true, RestrictDomainsToCertificate: false, RequireTls: true, TlsSenderCertificateName: 'mail.partner.test', CloudServicesMailEnabled: false, TreatMessagesAsInternal: false, TrustedOrganizations: [], AssociatedAcceptedDomains: [], EFSkipLastIP: false, EFSkipIPs: [], EFSkipMailGateway: [], EFUsers: [], ScanAndDropRecipients: [], WhenChangedUTC: WHEN },
  ],
  'Get-OutboundConnector': [
    { Name: 'To smarthost', Guid: guid(6), Enabled: true, ConnectorType: 'Partner', ConnectorSource: 'Default', Comment: '', RecipientDomains: ['*'], SmartHosts: ['relay.contoso.test'], UseMXRecord: false, TlsSettings: 'DomainValidation', TlsDomain: 'relay.contoso.test', IsTransportRuleScoped: false, RouteAllMessagesViaOnPremises: false, CloudServicesMailEnabled: false, AllAcceptedDomains: false, SenderRewritingEnabled: false, TestMode: false, IsValidated: true, LastValidationTimestamp: '2026-10-08T00:00:00Z', WhenChangedUTC: WHEN },
  ],
  'Get-HostedContentFilterPolicy': [
    { Name: 'Default', Guid: guid(7), IsDefault: true, BulkThreshold: 7, SpamAction: 'MoveToJmf', HighConfidenceSpamAction: 'Quarantine', PhishSpamAction: 'Quarantine', HighConfidencePhishAction: 'Quarantine', BulkSpamAction: 'MoveToJmf', QuarantineRetentionPeriod: 30, SpamQuarantineTag: 'DefaultFullAccessPolicy', HighConfidenceSpamQuarantineTag: 'DefaultFullAccessPolicy', PhishQuarantineTag: 'DefaultFullAccessPolicy', HighConfidencePhishQuarantineTag: 'AdminOnlyAccessPolicy', BulkQuarantineTag: 'DefaultFullAccessPolicy', AllowedSenders: [], AllowedSenderDomains: [], BlockedSenders: [], BlockedSenderDomains: ['spam.test'], EnableLanguageBlockList: false, LanguageBlockList: [], EnableRegionBlockList: false, RegionBlockList: [], InlineSafetyTipsEnabled: true, SpamZapEnabled: true, PhishZapEnabled: true, TestModeAction: 'None', AddXHeaderValue: null, ModifySubjectValue: null, RedirectToRecipients: [], WhenChangedUTC: WHEN },
  ],
  'Get-AntiPhishPolicy': [
    { Name: 'Office365 AntiPhish Default', Guid: guid(8), IsDefault: true, Enabled: true, PhishThresholdLevel: 1, EnableSpoofIntelligence: true, EnableUnauthenticatedSender: true, EnableViaTag: true, AuthenticationFailAction: 'MoveToJmf', HonorDmarcPolicy: true, DmarcQuarantineAction: 'Quarantine', DmarcRejectAction: 'Reject', SpoofQuarantineTag: 'DefaultFullAccessPolicy', EnableMailboxIntelligence: true, EnableMailboxIntelligenceProtection: false, MailboxIntelligenceProtectionAction: 'NoAction', EnableOrganizationDomainsProtection: false, EnableTargetedDomainsProtection: false, TargetedDomainsToProtect: [], TargetedDomainProtectionAction: 'NoAction', EnableTargetedUserProtection: false, TargetedUsersToProtect: [], TargetedUserProtectionAction: 'NoAction', ExcludedDomains: [], ExcludedSenders: [], EnableFirstContactSafetyTips: false, EnableSimilarUsersSafetyTips: false, EnableSimilarDomainsSafetyTips: false, EnableUnusualCharactersSafetyTips: false, WhenChangedUTC: WHEN },
  ],
  'Get-MalwareFilterPolicy': [
    { Name: 'Default', Guid: guid(9), IsDefault: true, EnableFileFilter: true, FileTypes: ['ace', 'exe'], FileTypeAction: 'Reject', ZapEnabled: true, QuarantineTag: 'AdminOnlyAccessPolicy', EnableInternalSenderAdminNotifications: false, InternalSenderAdminAddress: null, EnableExternalSenderAdminNotifications: false, ExternalSenderAdminAddress: null, CustomNotifications: false, WhenChangedUTC: WHEN },
  ],
  'Get-DkimSigningConfig': [
    { Domain: 'contoso.test', Guid: guid(10), Enabled: true, Status: 'Valid', Selector1CNAME: 'selector1-contoso-test._domainkey.contoso.onmicrosoft.com', Selector2CNAME: 'selector2-contoso-test._domainkey.contoso.onmicrosoft.com', Selector1KeySize: 2048, Selector2KeySize: 2048, HeaderCanonicalization: 'Relaxed', BodyCanonicalization: 'Relaxed', RotateOnDate: '2026-12-01T00:00:00Z', WhenChangedUTC: WHEN, Selector1PublicKey: 'v=DKIM1; k=rsa; p=MIIBIjANBgkq', Selector2PublicKey: 'v=DKIM1; k=rsa; p=MIIBIjANBgkr', LastChecked: '2026-10-08T00:00:00Z' },
  ],
  'Get-SafeLinksPolicy': [
    { Name: 'Built-In Protection Policy', Guid: guid(11), IsBuiltInProtection: true, EnableSafeLinksForEmail: true, EnableSafeLinksForTeams: true, EnableSafeLinksForOffice: true, TrackClicks: true, AllowClickThrough: false, ScanUrls: true, EnableForInternalSenders: false, DeliverMessageAfterScan: true, DisableUrlRewrite: false, DoNotRewriteUrls: [], EnableOrganizationBranding: false, CustomNotificationText: null, UseTranslatedNotificationText: false, WhenChangedUTC: WHEN },
  ],
  'Get-SafeAttachmentPolicy': [
    { Name: 'Built-In Protection Policy', Guid: guid(12), IsBuiltInProtection: true, Enable: true, Action: 'Block', QuarantineTag: 'AdminOnlyAccessPolicy', Redirect: false, RedirectAddress: null, WhenChangedUTC: WHEN },
  ],
});

// The allowlists the container enforces, parsed from the script it ships.
function containerAllowlist(variable) {
  const script = readFileSync(new URL('../../ops/powershell/run-cmdlet.ps1', import.meta.url), 'utf8');
  const block = new RegExp(`\\$${variable} = @\\{([\\s\\S]*?)\\n\\}`).exec(script)[1];
  return Object.fromEntries([...block.matchAll(/'([A-Za-z-]+)'\s*=\s*@\(([^)]*)\)/g)]
    .map(([, name, entries]) => [name, [...entries.matchAll(/'([A-Za-z0-9]+)'/g)].map((match) => match[1])]));
}
const MAIL_FLOW_ALLOWED = containerAllowlist('AllowedMailFlow');
const NOT_FOUND = (cmdlet) => ({ message: `The term '${cmdlet}' is not recognized as a name of a cmdlet, function, script file, or executable program.`, category: 'ObjectNotFound', errorId: 'CommandNotFoundException' });

/**
 * A fake Exchange Online behind the real jobQueue spawn path. It plays run-cmdlet.ps1
 * for the mail flow session. `answers[cmdlet]` overrides the sample: a list is the
 * output, `{ error }` an error envelope, 'crash' a non-zero exit with no envelope.
 */
function fakeExchange({ answers = {} } = {}) {
  const calls = [];
  const envelope = (body, exitCode = 0) => ({ stdout: JSON.stringify(body), exitCode });
  function run(job) {
    const keys = Object.keys(job).filter((key) => key !== 'jobId').sort();
    if (job.mode !== 'cmdlet' || keys.some((key) => !['adapter', 'cmdlet', 'mode', 'module', 'parameters', 'tenantConfigPath'].includes(key))) {
      return { stdout: '', stderr: `run-job.sh: refused descriptor with ${keys.join(',')}`, exitCode: 2 };
    }
    if (job.module !== 'ExchangeOnlineManagement' || !MAIL_FLOW_ALLOWED[job.cmdlet]) {
      return envelope({ ok: false, error: { message: `cmdlet ${job.cmdlet} is not allowed`, category: null, errorId: 'CmdletNotAllowed' } }, 1);
    }
    for (const name of Object.keys(job.parameters ?? {})) {
      if (!MAIL_FLOW_ALLOWED[job.cmdlet].includes(name)) return envelope({ ok: false, error: { message: `parameter ${name} is not allowed`, category: null, errorId: 'ParameterNotAllowed' } }, 1);
    }
    calls.push({ cmdlet: job.cmdlet, parameters: job.parameters ?? {} });
    const answer = answers[job.cmdlet] ?? SAMPLE[job.cmdlet];
    if (answer === 'crash') return { stdout: '', stderr: 'pwsh: segmentation fault', exitCode: 139 };
    if (answer?.error) return envelope({ ok: false, error: answer.error }, 1);
    return envelope({ ok: true, output: structuredClone(answer) });
  }
  function spawnFn() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    let input = '';
    child.stdin = {
      write(chunk) { input += chunk; },
      end() {
        queueMicrotask(() => {
          const result = run(JSON.parse(input));
          if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
          if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
          child.emit('close', result.exitCode);
        });
      },
    };
    return child;
  }
  return { calls, powershell: { spawnFn, timeoutMs: 200, tenantConfigPath: '/etc/keel/tenant.json' } };
}

// ---------------------------------------------------------------- ledgers

const liveCapture = (operationId, tenantRef) => {
  const descriptor = WORKLOAD_DESCRIPTORS.find((item) => item.id === operationId);
  const version = descriptor.operation.kind === 'graph' ? descriptor.operation.version : descriptor.operation.module === 'PnP.PowerShell' ? '3.4.1' : EXO_VERSION;
  return { operationId, kind: 'live-capture', synthetic: false, tenantRef, capturedAt: '2026-10-08T00:00:00Z', version, ok: true, proofRef: `${operationId}@sha256:x` };
};
const fixtureRun = (operationId) => ({ operationId, kind: 'fixture', synthetic: true, ok: true, proofRef: `${operationId}.fixture` });
const GRANTS = Object.freeze({
  permissions: [...new Set(WORKLOAD_DESCRIPTORS.flatMap((descriptor) => descriptor.rbac.permissions))],
  roles: [...new Set(WORKLOAD_DESCRIPTORS.flatMap((descriptor) => descriptor.rbac.roles))],
});
const RUNTIME = Object.freeze({ modules: { ExchangeOnlineManagement: EXO_VERSION, 'PnP.PowerShell': '3.4.1', MicrosoftTeams: '6.0.0' } });
function ledgerWith(tenantRef, live) {
  const evidence = WORKLOAD_DESCRIPTORS.map((descriptor) => (live.includes(descriptor.id) ? liveCapture(descriptor.id, tenantRef) : fixtureRun(descriptor.id)));
  return buildWorkloadLedger({ evidence, grants: GRANTS, runtime: RUNTIME, tenantRef, now: NOW });
}
const ALL_READS = Object.freeze(WORKLOAD_DESCRIPTORS.map((descriptor) => descriptor.id));
const OTHER_READS = Object.freeze(ALL_READS.filter((id) => !MAIL_FLOW_OPERATIONS.includes(id)));

// ---------------------------------------------------------------- tests

test('each mail flow read is declared, in scope, probed, read-only and ships disabled', async () => {
  const declared = WORKLOAD_DESCRIPTORS.filter((descriptor) => descriptor.workload === MAIL_FLOW_WORKLOAD);
  assert.deepEqual(declared.map((descriptor) => descriptor.operation.cmdlet), [
    'Get-AcceptedDomain', 'Get-RemoteDomain', 'Get-TransportRule', 'Get-InboundConnector', 'Get-OutboundConnector',
    'Get-HostedContentFilterPolicy', 'Get-AntiPhishPolicy', 'Get-MalwareFilterPolicy', 'Get-DkimSigningConfig',
    'Get-SafeLinksPolicy', 'Get-SafeAttachmentPolicy',
  ]);
  assert.deepEqual(declared.map((descriptor) => descriptor.id), [...MAIL_FLOW_OPERATIONS]);
  for (const descriptor of declared) {
    assert.deepEqual(descriptorProblems(descriptor), [], descriptor.id);
    assert.equal(descriptor.operation.module, 'ExchangeOnlineManagement');
    assert.deepEqual(descriptor.operation.parameters, []);
    assert.match(descriptor.source.url, /^https:\/\/learn\.microsoft\.com\/en-us\/powershell\/module\/exchange\/get-/);
  }

  // The read-only probe runs each one in the Exchange Online session.
  const probe = readFileSync(new URL('../../ops/powershell/probe-workloads.ps1', import.meta.url), 'utf8');
  const exo = /# --- Exchange Online ---([\s\S]*?)# --- Security & Compliance/.exec(probe)[1];
  for (const descriptor of declared) assert.match(exo, new RegExp(`-Workload 'exo' -Name '${descriptor.operation.probeName}'`), descriptor.id);

  // No proof: disabled. Fixture proof: fixture-tested, still disabled.
  const bare = buildWorkloadLedger({ grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
  for (const id of MAIL_FLOW_OPERATIONS) {
    const row = bare.rows.find((item) => item.id === id);
    assert.equal(row.state, 'disabled', id);
    assert.equal(row.enabled, false, id);
  }
  const { evidence, results } = await runFixtureHarness({ descriptors: declared, runtime: RUNTIME });
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  const fixtured = buildWorkloadLedger({ descriptors: declared, evidence, grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
  assert.ok(fixtured.rows.every((row) => row.state === 'fixture-tested' && row.enabled === false));

  // Registered disabled; read-only; no write of any kind.
  assert.equal(MAIL_FLOW_DESCRIPTOR.enabledByDefault, false);
  assert.equal(MAIL_FLOW_DESCRIPTOR.readOnly, true);
  assert.ok(listWorkloads().some((descriptor) => descriptor.workload === MAIL_FLOW_WORKLOAD && descriptor.enabledByDefault === false));
  assert.deepEqual(Object.values(WORKLOAD_WRITE_OPERATIONS).filter((operation) => operation.workload === MAIL_FLOW_WORKLOAD), []);
  assert.ok(Object.keys(MAIL_FLOW_CMDLET_PARAMETERS).every((cmdlet) => cmdlet.startsWith('Get-')));
  assert.deepEqual(Object.fromEntries(Object.entries(MAIL_FLOW_CMDLET_PARAMETERS).map(([name, list]) => [name, [...list]])), MAIL_FLOW_ALLOWED,
    'the Node and container allowlists are identical');
  for (const cmdlet of ['Set-TransportRule', 'New-TransportRule', 'Remove-InboundConnector', 'Get-MessageTrace', 'Get-QuarantineMessage', 'Get-MailboxJunkEmailConfiguration']) {
    assert.throws(() => assertMailFlowCmdlet({ cmdlet }), MailFlowScopeError, cmdlet);
  }
  assert.throws(() => assertMailFlowCmdlet({ cmdlet: 'Get-TransportRule', parameters: { Identity: 'x' } }), /does not take Identity/);
});

test('every object is one observation under a stable identity, with declared fields only', async () => {
  const exchange = fakeExchange({
    answers: {
      // A rule renamed between runs keeps its key; a rule with no Guid is not guessed at;
      // a duplicate answer is stored once; a credential typed into a header value is redacted.
      'Get-TransportRule': [
        { ...SAMPLE['Get-TransportRule'][0], Name: 'Block executables (renamed)' },
        { ...SAMPLE['Get-TransportRule'][0] },
        { ...SAMPLE['Get-TransportRule'][0], Guid: guid(13), Name: 'Tag partner mail', SetHeaderName: 'X-Partner-Auth', SetHeaderValue: 'Bearer abcdefghijklmnopqrstuvwxyz' },
        { ...SAMPLE['Get-TransportRule'][0], Guid: 'not-a-guid', Name: 'Unidentified' },
      ],
    },
  });
  const result = await readMailFlow({ powershell: exchange.powershell, now: () => NOW });

  // One call per family, no parameters, nothing else.
  assert.deepEqual(exchange.calls.map((call) => call.cmdlet), FAMILY_NAMES.map((name) => FAMILIES[name].cmdlet));
  assert.ok(exchange.calls.every((call) => Object.keys(call.parameters).length === 0));

  const keys = result.resources.map((resource) => resource.resourceKey);
  assert.deepEqual(keys, [
    'accepted-domain:contoso.test', 'accepted-domain:contoso.onmicrosoft.com', 'remote-domain:*',
    `transport-rule:${guid(4)}`, `transport-rule:${guid(13)}`,
    `inbound-connector:${guid(5)}`, `outbound-connector:${guid(6)}`, `anti-spam-policy:${guid(7)}`, `anti-phish-policy:${guid(8)}`,
    `anti-malware-policy:${guid(9)}`, 'dkim:contoso.test', `safe-links-policy:${guid(11)}`, `safe-attachment-policy:${guid(12)}`,
  ]);
  const rule = result.resources.find((resource) => resource.resourceKey === `transport-rule:${guid(4)}`);
  assert.equal(rule.fields.Name, 'Block executables (renamed)', 'the first answer for a Guid is kept; a rename does not change the key');
  assert.equal(result.discovery.unidentified, 1);

  // Declared fields only: extras (DKIM public keys, validation times, internal ids) are dropped.
  for (const resource of result.resources) {
    const declared = FAMILIES[resource.kind].fields;
    assert.deepEqual(Object.keys(resource.fieldCoverage).sort(), [...declared].sort(), resource.resourceKey);
    assert.ok(Object.keys(resource.fields).every((field) => declared.includes(field)), resource.resourceKey);
  }
  const stored = JSON.stringify(result.resources);
  for (const dropped of ['Selector1PublicKey', 'MIIBIjANBgkq', 'LastValidationTimestamp', 'LastChecked', 'OrganizationId', 'RuleVersion']) {
    assert.ok(!stored.includes(dropped), dropped);
  }
  const tagged = result.resources.find((resource) => resource.resourceKey === `transport-rule:${guid(13)}`);
  assert.equal(tagged.fieldCoverage.SetHeaderValue.status, 'redacted');
  assert.ok(!stored.includes('abcdefghijklmnopqrstuvwxyz'));
  // Nothing left that the shared redactor would catch.
  const redaction = { redactedFields: 0, seen: new WeakSet() };
  redactPayload(result.resources.map((resource) => resource.fields), redaction);
  assert.equal(redaction.redactedFields, 0);

  // Identities: domains are lower-cased and validated; Guids must be Guids.
  assert.equal(objectIdentity('acceptedDomain', { DomainName: 'Contoso.TEST' }), 'contoso.test');
  assert.equal(objectIdentity('remoteDomain', { DomainName: '*' }), '*');
  assert.equal(objectIdentity('remoteDomain', { DomainName: '*.partner.test' }), '*.partner.test');
  assert.equal(objectIdentity('acceptedDomain', { DomainName: 'a/b' }), null);
  assert.equal(objectIdentity('dkimSigning', { Domain: 'contoso.test' }), 'contoso.test');
  assert.equal(objectIdentity('inboundConnector', { Name: 'From partner' }), null);
  assert.equal(result.outcome, 'partial', 'an unidentified object and a redacted value are gaps');

  const clean = await readMailFlow({ powershell: fakeExchange().powershell, now: () => NOW });
  assert.equal(clean.outcome, 'complete');
  assert.equal(clean.resources.length, 12);
  assert.ok(Object.values(clean.discovery.families).every((family) => family.status === 'read'));
});

test('an unlicensed Defender family is an observation; other failures are structured gaps', async () => {
  const unlicensed = fakeExchange({ answers: { 'Get-SafeLinksPolicy': { error: NOT_FOUND('Get-SafeLinksPolicy') }, 'Get-SafeAttachmentPolicy': { error: NOT_FOUND('Get-SafeAttachmentPolicy') } } });
  const result = await readMailFlow({ powershell: unlicensed.powershell, now: () => NOW });
  assert.equal(result.outcome, 'complete', 'a tenant without Defender for Office 365 has nothing more to back up');
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.unavailable.map((item) => [item.family, item.status]), [['safeLinksPolicy', 'not-licensed'], ['safeAttachmentPolicy', 'not-licensed']]);
  assert.match(result.unavailable[0].reason, /Microsoft Defender for Office 365 is not licensed/);
  assert.equal(result.unavailable[0].error.errorId, 'CommandNotFoundException');
  assert.equal(result.discovery.families.safeLinksPolicy.status, 'not-licensed');

  // A core cmdlet that is not found is a failure, not a licence question.
  const missingCore = await readMailFlow({ powershell: fakeExchange({ answers: { 'Get-TransportRule': { error: NOT_FOUND('Get-TransportRule') } } }).powershell });
  assert.equal(missingCore.outcome, 'partial');
  assert.deepEqual(missingCore.failures.map((failure) => [failure.family, failure.status, failure.error.errorId]), [['transportRule', 'failed', 'CommandNotFoundException']]);

  // Denied, crashed and empty answers.
  const mixed = await readMailFlow({
    powershell: fakeExchange({
      answers: {
        'Get-InboundConnector': { error: { message: "The user isn't assigned to any management roles. Access denied.", category: 'PermissionDenied', errorId: 'AccessDenied' } },
        'Get-OutboundConnector': 'crash',
        'Get-RemoteDomain': [],
      },
    }).powershell,
  });
  assert.equal(mixed.outcome, 'partial');
  assert.deepEqual(mixed.failures.map((failure) => [failure.family, failure.status, failure.error.code]), [['inboundConnector', 'denied', 'CMDLET_ERROR'], ['outboundConnector', 'failed', 'NONZERO_EXIT']]);
  assert.deepEqual(mixed.discovery.families.remoteDomain, { status: 'read', objects: 0 });

  const everything = Object.fromEntries(FAMILY_NAMES.map((name) => [FAMILIES[name].cmdlet, 'crash']));
  assert.equal((await readMailFlow({ powershell: fakeExchange({ answers: everything }).powershell })).outcome, 'failed');
});

test('collection stays off until Exchange and every core read are qualified; Defender reads need their own proof', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const exchange = fakeExchange();

  // Fixture proof only, or every mail flow read live but Exchange not: disabled, nothing sent.
  for (const ledger of [ledgerWith(tenantRef, OTHER_READS), ledgerWith(tenantRef, ALL_READS.filter((id) => !EXCHANGE_OPERATIONS.includes(id)))]) {
    const disabled = await collectMailFlow(client, { tenantRef, ledger, powershell: exchange.powershell, now: () => NOW });
    assert.equal(disabled.run.outcome, 'disabled');
    assert.equal(disabled.result, null);
  }
  assert.deepEqual(exchange.calls, [], 'nothing is sent while disabled');
  assert.match(mailFlowActivation(ledgerWith(tenantRef, OTHER_READS)).reasons.join('; '), /mailflow\.transport-rules is fixture-tested/);
  assert.match(mailFlowActivation(ledgerWith(tenantRef, ALL_READS.filter((id) => !EXCHANGE_OPERATIONS.includes(id)))).reasons[0], /Exchange is not qualified yet/);
  // One core read missing keeps the whole workload off.
  assert.equal(mailFlowActivation(ledgerWith(tenantRef, ALL_READS.filter((id) => id !== 'mailflow.dkim-signing'))).enabled, false);

  // Core reads live, Defender reads not: enabled, Defender families skipped and the run partial.
  const core = ledgerWith(tenantRef, [...OTHER_READS, ...CORE_OPERATIONS]);
  const activation = mailFlowActivation(core);
  assert.equal(activation.enabled, true);
  assert.deepEqual(activation.skipped.map((item) => item.family), ['safeLinksPolicy', 'safeAttachmentPolicy']);
  const partial = await collectMailFlow(client, { tenantRef, ledger: core, powershell: exchange.powershell, now: () => NOW });
  assert.equal(partial.run.outcome, 'partial');
  assert.ok(!exchange.calls.some((call) => ['Get-SafeLinksPolicy', 'Get-SafeAttachmentPolicy'].includes(call.cmdlet)), 'an unqualified Defender read is never sent');
  assert.match(partial.run.digest.skipped[0].reason, /mailflow\.safe-links-policies is fixture-tested/);

  // Everything live: complete, one stored observation per object.
  exchange.calls.length = 0;
  const full = await collectMailFlow(client, { tenantRef, ledger: ledgerWith(tenantRef, ALL_READS), powershell: exchange.powershell, now: () => NOW });
  assert.equal(full.run.outcome, 'complete');
  assert.equal(exchange.calls.length, FAMILY_NAMES.length);
  const { rows } = await client.query(`SELECT resource_key, fields, field_coverage FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key`, [full.run.id]);
  assert.equal(rows.length, 12);
  const dkim = rows.find((row) => row.resource_key === 'dkim:contoso.test');
  assert.equal(dkim.fields.identity, 'contoso.test');
  assert.equal(dkim.fields.kind, 'dkimSigning');
  assert.equal(dkim.fields.Selector1CNAME, 'selector1-contoso-test._domainkey.contoso.onmicrosoft.com');
  assert.equal(dkim.fields.Selector1PublicKey, undefined);
  assert.equal(dkim.field_coverage.Enabled.status, 'observed');

  // Coverage lists the workload; its type never enters an Entra wave.
  const report = await buildCoverageReport(client, { tenantRef, catalog: [], descriptors: [], now: NOW });
  const entry = report.workloads.find((item) => item.workload === MAIL_FLOW_WORKLOAD);
  assert.equal(entry.status, 'complete');
  assert.throws(() => planWaves([{ naturalKey: 'x', resourceType: 'exchangeMailFlow', verb: 'update', payload: {} }]), /workload restore path/);
  assert.throws(() => planDeletionWaves([{ naturalKey: 'x', resourceType: 'exchangeMailFlow', verb: 'delete', payload: {} }]), /workload restore path/);
});
