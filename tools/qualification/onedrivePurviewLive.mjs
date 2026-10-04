#!/usr/bin/env node
/**
 * Roadmap task-123: capture and import OneDrive and Purview configuration
 * live-acceptance evidence. The operator runs this; builders and CI never point it at
 * a tenant.
 *
 *   node tools/qualification/onedrivePurviewLive.mjs plan \
 *        --fixture-site https://<tenant>-my.sharepoint.com/personal/keel-rt-... \
 *        --fixture-label KEEL-RT-... --fixture-policy KEEL-RT-...
 *     Offline (the default). Prints every cmdlet a capture would send. No network.
 *
 *   [KEEL_QUALIFICATION_HMAC_KEY=...] \
 *   node tools/qualification/onedrivePurviewLive.mjs capture --confirm-live-tenant-write \
 *        --tenant-ref sha256:... --directory-tenant-id <guid> \
 *        --fixture-site <url> --fixture-label KEEL-RT-... --fixture-policy KEEL-RT-... \
 *        --collector-ref app:<collector app id> --restorer-ref app:<restorer app id> \
 *        --collector-config /etc/keel/purview-collector.json --restorer-config /etc/keel/purview-restorer.json \
 *        --pnp-module-version <x.y.z> --exchange-module-version <x.y.z> --grants grants.json --docs docs.json \
 *        --exchange-evidence docs/release/qualifications/exchange-live-acceptance.json \
 *        --out docs/release/qualifications/onedrive-purview-live-acceptance.json [--build <sha>] [--powershell-image <tag>]
 *
 * Before anything is sent, the task-122 Exchange record must verify with --require-live
 * for the same tenant and build, and sit beside --out (with the Teams and SharePoint
 * records behind it): OneDrive and Purview are qualified only after Exchange, and no
 * Exchange, Teams or SharePoint proof is ever OneDrive or Purview proof.
 *
 * What a capture does, in order (and nothing else):
 *  0. offline: asks KEEL to weaken a label (Set-Label -EncryptionEnabled), unpublish a
 *     label (Set-LabelPolicy -RemoveLabels), read labeled items
 *     (Export-ContentExplorerData), list OneDrive items (Get-PnPListItem) and address a
 *     path inside the OneDrive. All must be refused before sending;
 *  1. collector: Get-PnPTenantSite -Identity {fixture OneDrive}; Get-Label; Get-LabelPolicy;
 *  2. collector: Get-PnPTenantSite -Identity of an absent keel-rt-* OneDrive, to capture
 *     a platform error as it comes back (it must not exist);
 *  3. offline: the production restore planner is handed the fixture label as if it
 *     reported a preservation lock; it must refuse;
 *  4. restorer: Get-Label/Get-LabelPolicy; Set-Label -Comment on the fixture label; read
 *     back; Set-Label -Comment back to the original; read back;
 *  5. restorer: Set-LabelPolicy -AddLabels {fixture label} on the fixture policy; read
 *     back. Never put back: removing a label from a policy unpublishes it.
 * Only the KEEL-RT fixtures are written. No file, list item, item-applied label, label
 * usage or per-file permission is read. No label's protection is changed, no label is
 * unpublished or deleted, nothing is written to an object that reports a lock, and no
 * OneDrive setting is written (no OneDrive write is declared). The policy must publish
 * to KEEL-RT fixtures only, so adding the label changes nothing for a real user.
 *
 * Cmdlets run through the bounded task-106 job transport (engine/powershell/jobQueue.mjs):
 * parameters are JSON data, never script source. Cmdlet credentials stay in the tenant
 * config files the container reads; the record carries references only. With
 * KEEL_QUALIFICATION_HMAC_KEY set the record is signed as `keel-release-runner`;
 * without it the record cannot verify.
 *
 * ledgerEvidenceFromOneDrivePurviewAcceptance() is the import seam: a record that passes
 * `verify --require-live` becomes task-101 read evidence for the three reads and one live
 * write capture per Purview write. Anything less becomes nothing.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ONEDRIVE_FIELDS, ONEDRIVE_MODULE, ONEDRIVE_OPERATION, oneDriveCmdlet, oneDriveSite, readOneDriveSite } from '../../engine/collect/workloads/onedrive.mjs';
import {
  POLICY_FIELDS, PURVIEW_MODULE, definitionFingerprint, labelKey, purviewCmdlet, readPurview,
} from '../../engine/collect/workloads/purview.mjs';
import { planPurviewRestore } from '../../engine/restore/workloads/purview.mjs';
import { QUALIFICATION_CONTRACT_VERSION, signEvidence, verifyEvidence } from '../release/qualification.mjs';
import { EXCHANGE_LIVE_GATE } from './exchangeAcceptance.mjs';
import {
  ONEDRIVE_PURVIEW_CREDENTIAL_MODE, ONEDRIVE_PURVIEW_FIXTURE_PREFIX, ONEDRIVE_PURVIEW_LABEL_TOGGLE, ONEDRIVE_PURVIEW_LABEL_WRITE,
  ONEDRIVE_PURVIEW_LIVE_GATE, ONEDRIVE_PURVIEW_LIVE_OPERATION, ONEDRIVE_PURVIEW_POLICY_LOCATIONS, ONEDRIVE_PURVIEW_POLICY_WRITE,
  ONEDRIVE_PURVIEW_PREREQUISITES, ONEDRIVE_PURVIEW_REFUSAL_PROBES, ONEDRIVE_PURVIEW_TRANSPORT,
  onedrivePurviewFingerprint, onedrivePurviewFixtureSite, onedrivePurviewIsFixtureName, onedrivePurviewMyHost, onedrivePurviewOperationVersion,
  onedrivePurviewPolicyAudienceProblems,
} from './onedrivePurviewAcceptance.mjs';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODULE_VERSION_RE = /^\d+\.\d+\.\d+(\.\d+)?$/;
const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');
const listOf = (value) => (Array.isArray(value) ? value.map(String) : value === null || value === undefined || value === '' ? [] : [String(value)]);
const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** Refuses anything but a KEEL-RT OneDrive, label and policy. */
export function onedrivePurviewFixtureProblems({ fixtureSite, fixtureLabel, fixturePolicy }) {
  const problems = [];
  let myHost = null;
  try { myHost = new URL(fixtureSite).hostname.toLowerCase(); } catch { /* reported below */ }
  if (!myHost || !onedrivePurviewFixtureSite(fixtureSite, myHost)) {
    problems.push(`--fixture-site must be a disposable ${ONEDRIVE_PURVIEW_FIXTURE_PREFIX}* OneDrive personal site (https://<tenant>-my.sharepoint.com/personal/${ONEDRIVE_PURVIEW_FIXTURE_PREFIX}...)`);
  }
  if (!onedrivePurviewIsFixtureName(fixtureLabel)) problems.push(`--fixture-label must be a disposable ${ONEDRIVE_PURVIEW_FIXTURE_PREFIX}* label name`);
  if (!onedrivePurviewIsFixtureName(fixturePolicy)) problems.push(`--fixture-policy must be a disposable ${ONEDRIVE_PURVIEW_FIXTURE_PREFIX}* label policy name`);
  return problems;
}

/** A OneDrive under the fixture's host that must not exist, for the platform-error probe. */
export function onedrivePurviewProbeSite(fixtureSite, suffix = randomBytes(6).toString('hex')) {
  return `https://${new URL(fixtureSite).hostname.toLowerCase()}/personal/${ONEDRIVE_PURVIEW_FIXTURE_PREFIX}absent-${suffix}`;
}

/** Offline: the cmdlets a capture would send, in order. */
export function onedrivePurviewCapturePlan({ fixtureSite, fixtureLabel, fixturePolicy }) {
  const problems = onedrivePurviewFixtureProblems({ fixtureSite, fixtureLabel, fixturePolicy });
  if (problems.length) throw new Error(problems.join('; '));
  const refused = (probe, what) => ({ step: 0, credential: 'none', refused: `${probe.cmdlet}${probe.parameter ? ` -${probe.parameter}` : ''} (${what}; refused before sending)` });
  const p = ONEDRIVE_PURVIEW_REFUSAL_PROBES;
  return [
    refused(p.protectionWeakening, 'weakens protection'),
    refused(p.unpublish, 'unpublishes a label'),
    refused(p.itemLabels, 'item-applied labels'),
    refused(p.oneDriveContent, 'OneDrive content'),
    { step: 0, credential: 'none', refused: `${fixtureSite}/Documents (a path inside the OneDrive; refused before sending)` },
    { step: 1, credential: 'collector', module: ONEDRIVE_MODULE, cmdlet: 'Get-PnPTenantSite', parameters: { Identity: fixtureSite }, operationId: ONEDRIVE_OPERATION },
    { step: 1, credential: 'collector', module: PURVIEW_MODULE, cmdlet: 'Get-Label', parameters: {}, operationId: 'purview.label-definitions' },
    { step: 1, credential: 'collector', module: PURVIEW_MODULE, cmdlet: 'Get-LabelPolicy', parameters: {}, operationId: 'purview.label-publication' },
    { step: 2, credential: 'collector', module: ONEDRIVE_MODULE, cmdlet: 'Get-PnPTenantSite', parameters: { Identity: `https://<fixture host>/personal/${ONEDRIVE_PURVIEW_FIXTURE_PREFIX}absent-<random>` }, expect: 'a structured platform error' },
    { step: 3, credential: 'none', refused: `restore plan for ${fixtureLabel} reported as preservation-locked (planner must refuse; nothing sent)` },
    { step: 4, credential: 'restorer', module: PURVIEW_MODULE, cmdlet: 'Get-Label + Get-LabelPolicy', parameters: {}, operationId: ONEDRIVE_PURVIEW_LABEL_WRITE },
    { step: 4, credential: 'restorer', module: PURVIEW_MODULE, cmdlet: 'Set-Label', parameters: { Identity: `<${fixtureLabel} immutable id>`, [ONEDRIVE_PURVIEW_LABEL_TOGGLE]: '<KEEL-RT qualification marker>' }, operationId: ONEDRIVE_PURVIEW_LABEL_WRITE },
    { step: 4, credential: 'restorer', module: PURVIEW_MODULE, cmdlet: 'Get-Label + Get-LabelPolicy', parameters: {}, operationId: ONEDRIVE_PURVIEW_LABEL_WRITE, note: 'read back' },
    { step: 4, credential: 'restorer', module: PURVIEW_MODULE, cmdlet: 'Set-Label', parameters: { Identity: `<${fixtureLabel} immutable id>`, [ONEDRIVE_PURVIEW_LABEL_TOGGLE]: '<original>' }, operationId: ONEDRIVE_PURVIEW_LABEL_WRITE },
    { step: 4, credential: 'restorer', module: PURVIEW_MODULE, cmdlet: 'Get-Label + Get-LabelPolicy', parameters: {}, operationId: ONEDRIVE_PURVIEW_LABEL_WRITE, note: 'read back' },
    { step: 5, credential: 'restorer', module: PURVIEW_MODULE, cmdlet: 'Set-LabelPolicy', parameters: { Identity: `<${fixturePolicy} immutable id>`, AddLabels: [fixtureLabel] }, operationId: ONEDRIVE_PURVIEW_POLICY_WRITE, note: 'add only; never put back' },
    { step: 5, credential: 'restorer', module: PURVIEW_MODULE, cmdlet: 'Get-Label + Get-LabelPolicy', parameters: {}, operationId: ONEDRIVE_PURVIEW_POLICY_WRITE, note: 'read back' },
  ];
}

async function onedrivePurviewReadUntil(readOnce, matches, { sleep, attempts, delayMs }) {
  let body = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) await sleep(delayMs);
    body = await readOnce();
    if (matches(body)) return { body, matched: true };
  }
  return { body, matched: false };
}

/** The fingerprint of every label and policy definition except the fixtures. */
function onedrivePurviewOthersFingerprint(result, keys) {
  if (!result || result.failures?.length) return null;
  const rows = result.resources.filter((item) => !keys.includes(item.resourceKey))
    .map((item) => [item.resourceKey, definitionFingerprint(item)]).sort(([a], [b]) => a.localeCompare(b));
  return sha256Hex(JSON.stringify(rows));
}

const findByName = (result, kind, name) => (result?.resources ?? []).filter((item) => item.kind === kind && sameText(item.fields?.Name, name));
const observedFields = (entry) => Object.entries(entry?.fieldCoverage ?? {}).filter(([, coverage]) => coverage?.status === 'observed').map(([field]) => field);

/**
 * Runs a capture. `collector` and `restorer` are each `{ powershell }`: the runCmdlet
 * options for that identity's tenant config. `tenantHost` is the SharePoint tenant host
 * the verified prerequisite chain names. Returns the unsigned record and the raw
 * capture log; it never signs and never writes files.
 */
export async function captureOneDrivePurviewAcceptance({
  collector, restorer, directoryTenantId, tenantHost, fixtureSite, fixtureLabel, fixturePolicy, probeSite = null, tenantRef, build, credentials, grants,
  modules, exchangeQualification, documentation = [], now = () => new Date(), sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  readBackAttempts = 5, readBackDelayMs = 5000,
}) {
  const problems = onedrivePurviewFixtureProblems({ fixtureSite, fixtureLabel, fixturePolicy });
  if (typeof directoryTenantId !== 'string' || !GUID_RE.test(directoryTenantId)) problems.push('--directory-tenant-id must be the managed tenant id (a GUID)');
  const myHost = onedrivePurviewMyHost(tenantHost);
  if (!myHost) problems.push('the SharePoint prerequisite names no tenant host');
  else if (!problems.length && new URL(fixtureSite).hostname.toLowerCase() !== myHost) problems.push(`--fixture-site must be on ${myHost}, the OneDrive host of the qualified SharePoint tenant`);
  for (const [flag, module] of [['--pnp-module-version', ONEDRIVE_MODULE], ['--exchange-module-version', PURVIEW_MODULE]]) {
    if (typeof modules?.[module] !== 'string' || !MODULE_VERSION_RE.test(modules[module])) problems.push(`${flag} must be the ${module} version in the container (x.y.z)`);
  }
  if (problems.length) throw new Error(problems.join('; '));
  if (!tenantRef || !build) throw new Error('a capture needs --tenant-ref and a build');
  if (!credentials?.collector || !credentials?.restorer || credentials.collector === credentials.restorer) {
    throw new Error('a capture needs two separate credential references (collector, restorer)');
  }
  if (exchangeQualification?.gate !== EXCHANGE_LIVE_GATE || !exchangeQualification.captureLogSha256) {
    throw new Error('a capture needs the verified task-122 Exchange record: OneDrive and Purview are qualified only after Exchange');
  }
  const tenant = directoryTenantId.toLowerCase();
  const site = oneDriveSite(fixtureSite, myHost);
  const probe = probeSite ?? onedrivePurviewProbeSite(site);
  if (!onedrivePurviewFixtureSite(probe, myHost) || sameText(probe, site)) throw new Error('the platform-error probe must be another keel-rt-* OneDrive');

  const requests = [];
  const log = { requests, values: {} };
  const entry = (credential, module, cmdlet, parameters) => ({ credential, transport: ONEDRIVE_PURVIEW_TRANSPORT, module, cmdlet, parameters: { ...parameters }, outcome: 'ok', at: now().toISOString() });
  // Reads go through the production readers; each cmdlet they send is logged with its outcome.
  const readSite = async (credential, side, url) => {
    const logged = entry(credential, ONEDRIVE_MODULE, 'Get-PnPTenantSite', { Identity: url });
    const result = await readOneDriveSite({ url, powershell: side.powershell ?? {} });
    const failed = Object.values(result.fieldCoverage).find((coverage) => coverage.status === 'failed' || coverage.status === 'denied');
    if (failed) Object.assign(logged, { outcome: failed.status, error: { code: failed.error?.code ?? null, errorId: failed.error?.errorId ?? null } });
    requests.push(logged);
    return { result, failed };
  };
  const readLabels = async (credential, side) => {
    const result = await readPurview({ powershell: side.powershell ?? {} });
    for (const [cmdlet, group] of [['Get-Label', 'label'], ['Get-LabelPolicy', 'policy']]) {
      const failure = result.failures.find((item) => item.group === group);
      requests.push({ ...entry(credential, PURVIEW_MODULE, cmdlet, {}), ...(failure ? { outcome: failure.status, error: { code: failure.error?.code ?? null, errorId: failure.error?.errorId ?? null } } : {}) });
    }
    return result;
  };
  // Writes: the allowlist is checked before the job is written; a refused call is never sent or logged.
  const writeAs = (credential, side) => async (cmdlet, parameters) => {
    const logged = entry(credential, PURVIEW_MODULE, cmdlet, parameters);
    try {
      const { output } = await purviewCmdlet({ cmdlet, parameters }, side.powershell ?? {});
      requests.push(logged);
      return output;
    } catch (error) {
      if (error?.name === 'PurviewScopeError') throw error;
      requests.push({ ...logged, outcome: 'failed', error: { code: error?.detail?.code ?? 'ERROR', errorId: error?.detail?.errorId ?? null } });
      throw error;
    }
  };
  const restore = writeAs('restorer', restorer);

  // 0. Offline refusals: none of these leaves this process.
  const sentBefore = requests.length;
  const refusals = {};
  const attempt = async (name, run) => {
    const probeSpec = ONEDRIVE_PURVIEW_REFUSAL_PROBES[name];
    refusals[name] = { cmdlet: probeSpec?.cmdlet ?? null, parameter: probeSpec?.parameter ?? null, refused: false, sent: false };
    const before = requests.length;
    try { await run(); } catch (error) { refusals[name].refused = true; refusals[name].reason = error.message; }
    refusals[name].sent = requests.length !== before;
  };
  await attempt('protectionWeakening', () => restore('Set-Label', { Identity: fixtureLabel, EncryptionEnabled: false }));
  await attempt('unpublish', () => restore('Set-LabelPolicy', { Identity: fixturePolicy, RemoveLabels: [fixtureLabel] }));
  await attempt('itemLabels', () => restore('Export-ContentExplorerData', {}));
  await attempt('oneDriveContent', () => oneDriveCmdlet({ cmdlet: 'Get-PnPListItem', parameters: {} }, collector.powershell ?? {}));
  await attempt('oneDrivePath', async () => oneDriveSite(`${site}/Documents/Shared`, myHost));
  delete refusals.oneDrivePath.cmdlet;
  delete refusals.oneDrivePath.parameter;
  refusals.oneDrivePath.path = `${site}/Documents/Shared`;
  if (requests.length !== sentBefore) throw new Error('a refusal probe was sent; nothing more is attempted');

  // 1. Reads, by the collector.
  const reads = [];
  const capture = (id, ok, error = null) => {
    reads.push({ operationId: id, version: onedrivePurviewOperationVersion(id, modules), capturedAt: now().toISOString(), ok, synthetic: false, ...(id === ONEDRIVE_OPERATION ? { form: 'Get-PnPTenantSite -Identity' } : {}), ...(error ? { error } : {}) });
  };
  const siteRead = await readSite('collector', collector, site);
  const siteObserved = !siteRead.failed && observedFields(siteRead.result).length > 0;
  const siteProblem = Object.values(siteRead.result.fieldCoverage).find((coverage) => coverage.error)?.error?.message;
  capture(ONEDRIVE_OPERATION, siteObserved, siteObserved ? null : siteProblem ?? 'no site settings were observed');
  const labelsStart = await readLabels('collector', collector);
  for (const [id, group] of [['purview.label-definitions', 'label'], ['purview.label-publication', 'policy']]) {
    const failure = labelsStart.failures.find((item) => item.group === group);
    capture(id, !failure, failure ? failure.error?.message ?? failure.status : null);
  }
  const inheritance = Object.fromEntries(Object.keys(ONEDRIVE_FIELDS).map((field) => [field, siteRead.result.fieldCoverage[field]?.inheritance ?? null]));
  const labels = findByName(labelsStart, 'label', fixtureLabel);
  const policies = findByName(labelsStart, 'policy', fixturePolicy);
  const label = labels.length === 1 ? labels[0] : null;
  const policy = policies.length === 1 ? policies[0] : null;
  const supportedFields = { onedrive: observedFields(siteRead.result), label: observedFields(label), policy: observedFields(policy) };
  const fixtureKeys = [label?.resourceKey, policy?.resourceKey].filter(Boolean);

  // 2. A platform error, as it comes back: the absent probe OneDrive.
  const probeRead = await readSite('collector', collector, probe);
  const platformError = { site: probe, status: probeRead.failed?.status ?? 'ok', error: null };
  if (probeRead.failed) {
    const { code = null, errorId = null, category = null, message = null } = probeRead.failed.error ?? {};
    platformError.error = { code, errorId, category, message };
  }

  // 3. Preservation lock, observed through the production planner: never overridden.
  refusals.preservationLock = { refused: false, sent: false };
  if (label) {
    const before = requests.length;
    try {
      const plan = planPurviewRestore({
        source: { collectionId: 'qualification-lock-probe', outcome: 'complete', observations: [{ ...label, fields: { ...label.fields, [ONEDRIVE_PURVIEW_LABEL_TOGGLE]: `${label.fields[ONEDRIVE_PURVIEW_LABEL_TOGGLE] ?? ''} (lock probe)` } }] },
        live: { resources: [{ ...label, lock: 'locked' }], failures: [] },
        tenantId: tenant,
        targets: [labelKey(label.id)],
      });
      const refusal = plan.refusals.find((item) => /preservation-locked/.test(item.reason));
      refusals.preservationLock.refused = Boolean(refusal);
      refusals.preservationLock.reason = refusal?.reason ?? 'the planner did not refuse a locked label';
    } catch (error) {
      refusals.preservationLock.reason = error.message;
    }
    refusals.preservationLock.sent = requests.length !== before;
  }

  const fixtureSiteFacts = { url: site, template: siteRead.result.fields.Template ?? null, lockState: siteRead.result.fields.LockState ?? null };
  const fixtureLabelFacts = { id: label?.id ?? null, name: label?.fields?.Name ?? null, lock: label?.lock ?? null };
  const fixturePolicyFacts = {
    id: policy?.id ?? null, name: policy?.fields?.Name ?? null, lock: policy?.lock ?? null,
    locations: Object.fromEntries(ONEDRIVE_PURVIEW_POLICY_LOCATIONS.map((location) => [location, policy?.fields?.[location] ?? null])),
  };

  let refusal = null;
  if (!reads.every((item) => item.ok)) refusal = 'a read failed; nothing was written';
  else if (!/^SPSPERS/i.test(String(fixtureSiteFacts.template ?? ''))) refusal = 'the fixture site did not answer as a OneDrive personal site; nothing was written';
  else if (!label) refusal = `${labels.length} labels are named ${fixtureLabel}; exactly one KEEL-RT label is needed; nothing was written`;
  else if (!policy) refusal = `${policies.length} policies are named ${fixturePolicy}; exactly one KEEL-RT policy is needed; nothing was written`;
  else if (label.lock === 'locked' || policy.lock === 'locked') refusal = 'a fixture reports a preservation lock; KEEL never writes a locked object; nothing was written';
  else if (onedrivePurviewPolicyAudienceProblems(policy.fields).length) refusal = `the fixture policy is not fixture-only (${onedrivePurviewPolicyAudienceProblems(policy.fields).join('; ')}); nothing was written`;
  else if (platformError.status === 'ok') refusal = 'the platform-error probe OneDrive exists; it must not; nothing was written';
  else if (refusals.preservationLock.refused !== true) refusal = 'the restore planner did not refuse a preservation-locked label; nothing was written';

  const timing = { sleep, attempts: readBackAttempts, delayMs: readBackDelayMs };
  const writes = {
    label: { operationId: ONEDRIVE_PURVIEW_LABEL_WRITE, version: onedrivePurviewOperationVersion(ONEDRIVE_PURVIEW_LABEL_WRITE, modules), synthetic: false, writeMode: 'reversible-change', property: ONEDRIVE_PURVIEW_LABEL_TOGGLE, ok: false, readBackVerified: false, restoredToOriginal: false, preFingerprint: null, finalFingerprint: null },
    policy: { operationId: ONEDRIVE_PURVIEW_POLICY_WRITE, version: onedrivePurviewOperationVersion(ONEDRIVE_PURVIEW_POLICY_WRITE, modules), synthetic: false, writeMode: 'add-only', addedLabel: label?.fields?.Name ?? null, ok: false, readBackVerified: false, before: null, after: null, preFingerprint: null, finalFingerprint: null },
  };
  let finalRead = labelsStart;
  if (refusal) {
    for (const item of Object.values(writes)) { item.error = refusal; item.capturedAt = now().toISOString(); }
  } else {
    const read = () => readLabels('restorer', restorer);
    finalRead = await onedrivePurviewLabelRoundTrip({ write: restore, read, label, capture: writes.label, log, timing, marker: `KEEL-RT qualification ${now().toISOString()}` }) ?? finalRead;
    writes.label.capturedAt = now().toISOString();
    if (writes.label.restoredToOriginal === true) {
      finalRead = await onedrivePurviewPolicyAdd({ write: restore, read, label, policy, capture: writes.policy, timing }) ?? finalRead;
    } else {
      writes.policy.error = 'the label comment is not back; the policy was not written';
    }
    writes.policy.capturedAt = now().toISOString();
  }

  const captureLog = `${JSON.stringify(log, null, 2)}\n`;
  const record = {
    contractVersion: QUALIFICATION_CONTRACT_VERSION,
    gate: ONEDRIVE_PURVIEW_LIVE_GATE,
    tenantRef,
    build,
    operation: ONEDRIVE_PURVIEW_LIVE_OPERATION,
    credentialMode: ONEDRIVE_PURVIEW_CREDENTIAL_MODE,
    observedAt: now().toISOString(),
    evidenceLevel: 'live-qualified',
    synthetic: false,
    subject: {
      prerequisites: [...ONEDRIVE_PURVIEW_PREREQUISITES],
      exchangeQualification: { gate: EXCHANGE_LIVE_GATE, evidence: exchangeQualification.evidence, captureLogSha256: exchangeQualification.captureLogSha256 },
      directoryTenantId: tenant,
      fixtureSite: fixtureSiteFacts,
      fixtureLabel: fixtureLabelFacts,
      fixturePolicy: fixturePolicyFacts,
      execution: { transport: ONEDRIVE_PURVIEW_TRANSPORT, modules: { [ONEDRIVE_MODULE]: modules[ONEDRIVE_MODULE], [PURVIEW_MODULE]: modules[PURVIEW_MODULE] } },
      credentials: { collector: credentials.collector, restorer: credentials.restorer },
      grants,
      reads,
      supportedFields,
      inheritance,
      writes,
      tenantDefinitions: {
        labels: labelsStart.resources.filter((item) => item.kind === 'label').length,
        policies: labelsStart.resources.filter((item) => item.kind === 'policy').length,
        otherFingerprint: onedrivePurviewOthersFingerprint(labelsStart, fixtureKeys),
        finalOtherFingerprint: onedrivePurviewOthersFingerprint(finalRead, fixtureKeys),
      },
      refusals,
      platformError,
      requests: requests.map(({ at, ...request }) => request),
      documentation,
      captureLogSha256: sha256Hex(captureLog),
    },
  };
  const needsManualRevert = log.values.labelWritten === true && writes.label.restoredToOriginal !== true;
  return { record, captureLog, needsManualRevert };
}

async function onedrivePurviewLabelRoundTrip({ write, read, label, capture, log, timing, marker }) {
  const pick = (result) => (result?.resources ?? []).find((item) => item.resourceKey === label.resourceKey) ?? null;
  let last = null;
  try {
    last = await read();
    const before = pick(last);
    if (!before) { capture.error = 'the fixture label was not re-read; nothing was written'; return last; }
    capture.preFingerprint = definitionFingerprint(before);
    const original = before.fields[ONEDRIVE_PURVIEW_LABEL_TOGGLE] ?? '';
    log.values.originalComment = original;
    await write('Set-Label', { Identity: label.id, [ONEDRIVE_PURVIEW_LABEL_TOGGLE]: marker });
    log.values.labelWritten = true;
    const seen = await onedrivePurviewReadUntil(async () => (last = await read()), (result) => pick(result)?.fields?.[ONEDRIVE_PURVIEW_LABEL_TOGGLE] === marker, timing);
    capture.readBackVerified = seen.matched;
    // Always put the comment back once a write was accepted, whatever the read-back said.
    let revertError = null;
    try {
      await write('Set-Label', { Identity: label.id, [ONEDRIVE_PURVIEW_LABEL_TOGGLE]: original });
    } catch (error) {
      revertError = error;
    }
    const restored = await onedrivePurviewReadUntil(async () => (last = await read()), (result) => (pick(result)?.fields?.[ONEDRIVE_PURVIEW_LABEL_TOGGLE] ?? '') === original, timing);
    capture.restoredToOriginal = restored.matched;
    capture.finalFingerprint = pick(restored.body) ? definitionFingerprint(pick(restored.body)) : null;
    capture.ok = revertError === null;
    if (!restored.matched) capture.error = `PUTTING THE LABEL COMMENT BACK FAILED${revertError ? ` (${revertError.message})` : ''}: set ${ONEDRIVE_PURVIEW_LABEL_TOGGLE} on ${label.fields.Name} back by hand`;
  } catch (error) {
    capture.error ??= error.message;
    if (log.values.labelWritten === true && capture.restoredToOriginal !== true) {
      capture.error = `THE LABEL COMMENT MAY NOT BE BACK (${error.message}): check ${label.fields.Name} by hand`;
    }
  }
  return last;
}

async function onedrivePurviewPolicyAdd({ write, read, label, policy, capture, timing }) {
  const pick = (result) => (result?.resources ?? []).find((item) => item.resourceKey === policy.resourceKey) ?? null;
  const publishes = (entry) => listOf(entry?.fields?.Labels).some((name) => sameText(name, label.fields.Name) || sameText(name, label.id));
  let last = null;
  try {
    last = await read();
    const before = pick(last);
    if (!before) { capture.error = 'the fixture policy was not re-read; nothing was written'; return last; }
    capture.before = { Labels: listOf(before.fields.Labels) };
    capture.preFingerprint = onedrivePurviewFingerprint(before.fields, POLICY_FIELDS, ['Labels']);
    if (publishes(before)) {
      capture.error = `${label.fields.Name} is already published by ${before.fields.Name}; a capture never removes it to add it again (name a fresh KEEL-RT label); nothing was written`;
      return last;
    }
    await write('Set-LabelPolicy', { Identity: policy.id, AddLabels: [label.fields.Name] });
    capture.ok = true;
    const seen = await onedrivePurviewReadUntil(async () => (last = await read()), (result) => publishes(pick(result)), timing);
    capture.readBackVerified = seen.matched;
    const after = pick(seen.body);
    capture.after = after ? { Labels: listOf(after.fields.Labels) } : null;
    capture.finalFingerprint = after ? onedrivePurviewFingerprint(after.fields, POLICY_FIELDS, ['Labels']) : null;
  } catch (error) {
    capture.error = error.message;
  }
  return last;
}

/**
 * Writes the record and its capture log side by side, binding the log's digest as the
 * artifact proof, and signs the record when a runner key is given.
 */
export function writeOneDrivePurviewAcceptanceFiles({ record, captureLog, outPath, hmacKey = null }) {
  const logPath = outPath.replace(/\.json$/, '') + '.capture.json';
  writeFileSync(logPath, captureLog);
  let evidence = { ...record, proof: { artifact: { path: basename(logPath), sha256: sha256Hex(captureLog) } } };
  if (hmacKey) evidence = signEvidence(evidence, hmacKey, 'keel-release-runner');
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  return { evidence, logPath };
}

/**
 * The import seam: a record that passes the gate with --require-live becomes task-101
 * read evidence for the OneDrive and the two Purview reads, one live write capture per
 * Purview write, the collector's grants (both families), the restorer's grants and the
 * module versions the captures are bound to. Anything else yields none. Exchange, Teams
 * and SharePoint evidence come only from their own seams.
 */
export function ledgerEvidenceFromOneDrivePurviewAcceptance(evidence, options = {}) {
  const result = verifyEvidence(evidence, { ...options, gate: ONEDRIVE_PURVIEW_LIVE_GATE, requireLive: true });
  if (!result.ok) return { ok: false, failures: result.failures, reads: [], writes: [], grants: null, restorerGrants: null, runtime: null };
  const { subject, tenantRef } = evidence;
  const proofRef = `${ONEDRIVE_PURVIEW_LIVE_GATE}@${subject.captureLogSha256}`;
  const union = (...families) => ({
    permissions: [...new Set(families.flatMap((family) => family.permissions))].sort(),
    roles: [...new Set(families.flatMap((family) => family.roles))].sort(),
  });
  return {
    ok: true,
    failures: [],
    reads: subject.reads.map((item) => ({
      operationId: item.operationId, kind: 'live-capture', synthetic: false, tenantRef, capturedAt: item.capturedAt,
      version: item.version, ok: item.ok === true, error: null, observed: {}, proofRef,
    })),
    writes: [subject.writes.label, subject.writes.policy].map((item) => ({
      operationId: item.operationId, kind: 'live-write-capture', synthetic: false, tenantRef, capturedAt: item.capturedAt,
      version: item.version, ok: item.ok === true, readBackVerified: item.readBackVerified === true, proofRef,
    })),
    grants: union(subject.grants.collector.onedrive, subject.grants.collector.purview),
    restorerGrants: union(subject.grants.restorer.purview),
    runtime: { modules: { ...subject.execution.modules } },
  };
}

/** The SharePoint tenant host the verified Exchange -> Teams -> SharePoint chain names. */
export function onedrivePurviewChainHost(exchange, dir, readFile = (path) => readFileSync(path, 'utf8')) {
  try {
    const teams = JSON.parse(readFile(join(dir, basename(exchange.subject.teamsQualification.evidence))));
    const sharePoint = JSON.parse(readFile(join(dir, basename(teams.subject.sharePointQualification.evidence))));
    return sharePoint.subject?.tenantHost ?? null;
  } catch {
    return null;
  }
}

function parseOneDrivePurviewArgs(argv) {
  const [command = 'plan', ...rest] = argv;
  const options = { command, confirm: false };
  const names = {
    '--tenant-ref': 'tenantRef', '--directory-tenant-id': 'directoryTenantId', '--fixture-site': 'fixtureSite', '--fixture-label': 'fixtureLabel',
    '--fixture-policy': 'fixturePolicy', '--collector-ref': 'collectorRef', '--restorer-ref': 'restorerRef', '--collector-config': 'collectorConfig',
    '--restorer-config': 'restorerConfig', '--pnp-module-version': 'pnpVersion', '--exchange-module-version': 'exoVersion', '--grants': 'grants',
    '--docs': 'docs', '--out': 'out', '--build': 'build', '--exchange-evidence': 'exchangeEvidence', '--powershell-image': 'image',
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--confirm-live-tenant-write') options.confirm = true;
    else if (names[arg]) options[names[arg]] = rest[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const onedrivePurviewPowershellFor = (tenantConfigPath, image) => ({ tenantConfigPath, ...(image ? { image } : {}) });

export async function main(argv = process.argv.slice(2), {
  out = console.log, env = process.env, powershellFor = onedrivePurviewPowershellFor, readFile = (path) => readFileSync(path, 'utf8'),
} = {}) {
  const options = parseOneDrivePurviewArgs(argv);
  if (options.command === 'plan') {
    out(JSON.stringify(onedrivePurviewCapturePlan(options), null, 2));
    return 0;
  }
  if (options.command !== 'capture') throw new Error('usage: onedrivePurviewLive.mjs plan|capture ...');
  if (!options.confirm) {
    out(JSON.stringify(onedrivePurviewCapturePlan(options), null, 2));
    out('refused: a capture changes the fixture label\'s comment and publishes it in the fixture policy; rerun with --confirm-live-tenant-write');
    return 2;
  }
  for (const [flag, key] of [
    ['--tenant-ref', 'tenantRef'], ['--directory-tenant-id', 'directoryTenantId'], ['--collector-ref', 'collectorRef'], ['--restorer-ref', 'restorerRef'],
    ['--collector-config', 'collectorConfig'], ['--restorer-config', 'restorerConfig'], ['--pnp-module-version', 'pnpVersion'],
    ['--exchange-module-version', 'exoVersion'], ['--grants', 'grants'], ['--docs', 'docs'], ['--exchange-evidence', 'exchangeEvidence'], ['--out', 'out'],
  ]) {
    if (!options[key]) throw new Error(`capture needs ${flag}`);
  }
  if (options.collectorConfig === options.restorerConfig) throw new Error('the collector and restorer must use separate tenant config files');
  const build = options.build ?? env.KEEL_QUALIFICATION_BUILD;
  if (!build) throw new Error('capture needs --build (or KEEL_QUALIFICATION_BUILD): the build this capture qualifies');
  const outPath = resolve(options.out);
  const exchangePath = resolve(options.exchangeEvidence);
  if (dirname(exchangePath) !== dirname(outPath)) throw new Error('the Exchange record must sit beside --out, where the verifier reads it');
  // OneDrive and Purview follow Exchange: refuse before any cmdlet unless the task-122 record verifies.
  const exchange = JSON.parse(readFile(exchangePath));
  const exchangeResult = verifyEvidence(exchange, {
    gate: EXCHANGE_LIVE_GATE, tenantRef: options.tenantRef, build, requireLive: true, evidenceDir: dirname(exchangePath),
  });
  if (!exchangeResult.ok) {
    out(JSON.stringify({ refused: 'the task-122 Exchange record does not verify; OneDrive and Purview are qualified only after Exchange', failures: exchangeResult.failures }, null, 2));
    return 2;
  }
  const { record, captureLog, needsManualRevert } = await captureOneDrivePurviewAcceptance({
    collector: { powershell: powershellFor(options.collectorConfig, options.image) },
    restorer: { powershell: powershellFor(options.restorerConfig, options.image) },
    directoryTenantId: options.directoryTenantId,
    tenantHost: onedrivePurviewChainHost(exchange, dirname(exchangePath), readFile),
    fixtureSite: options.fixtureSite,
    fixtureLabel: options.fixtureLabel,
    fixturePolicy: options.fixturePolicy,
    tenantRef: options.tenantRef,
    build,
    modules: { [ONEDRIVE_MODULE]: options.pnpVersion, [PURVIEW_MODULE]: options.exoVersion },
    credentials: { collector: options.collectorRef, restorer: options.restorerRef },
    grants: JSON.parse(readFile(options.grants)),
    documentation: JSON.parse(readFile(options.docs)),
    exchangeQualification: { gate: EXCHANGE_LIVE_GATE, evidence: basename(exchangePath), captureLogSha256: exchange.subject.captureLogSha256 },
  });
  const { evidence, logPath } = writeOneDrivePurviewAcceptanceFiles({ record, captureLog, outPath, hmacKey: env.KEEL_QUALIFICATION_HMAC_KEY ?? null });
  const result = verifyEvidence(evidence, { gate: ONEDRIVE_PURVIEW_LIVE_GATE, tenantRef: options.tenantRef, build, requireLive: true, evidenceDir: dirname(outPath) });
  out(JSON.stringify({ evidence: outPath, captureLog: logPath, writes: record.subject.writes, verify: result }, null, 2));
  // 3: the fixture label's comment may not be back; the output says what to fix by hand.
  if (needsManualRevert) return 3;
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 2; });
}
