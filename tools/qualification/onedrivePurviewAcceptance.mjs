/**
 * Roadmap task-123: the OneDrive and Purview configuration live-acceptance gate.
 *
 * This is the evidence contract and its gate validator. It is registered in
 * tools/release/qualification.mjs (GATE_VALIDATORS) and checks the `subject` of a
 * record captured by tools/qualification/onedrivePurviewLive.mjs against the task-106
 * production declarations it qualifies:
 *  - three reads: onedrive.site-settings (Get-PnPTenantSite -Identity, PnP session),
 *    purview.label-definitions (Get-Label) and purview.label-publication
 *    (Get-LabelPolicy), both in the Security & Compliance session;
 *  - two writes, each with its own capture: purview.label.update (Set-Label, only the
 *    admin-facing Comment, changed and put back) and purview.label-policy.update
 *    (Set-LabelPolicy -AddLabels, add-only: a put-back would unpublish the label).
 *    No OneDrive write is declared, so OneDrive is qualified read-only.
 *
 * What a passing subject proves, beyond the generic verifier (signature, capture log
 * digest, gate, tenant, freshness, --require-live):
 *  - identity: operation, build, credential mode, two distinct credential references
 *    (the collector reads; only the restorer runs a Set- cmdlet), both module versions,
 *    and the directory tenant the task-122 Exchange record names;
 *  - prerequisites: tasks 106 and 122 are named; the declarations exist in this build;
 *    the task-122 Exchange record it names verifies on its own for the same tenant and
 *    build (which needs Teams, then SharePoint). Exchange, Teams or SharePoint proof is
 *    a prerequisite, never OneDrive or Purview proof;
 *  - family-specific privilege: what each app holds is recorded per family (OneDrive,
 *    Purview) as declared grants, and each family is checked against its own needs;
 *  - fixtures: one KEEL-RT-* OneDrive personal site on the -my host of the SharePoint
 *    record's tenant, one KEEL-RT-* label and one KEEL-RT-* publishing policy whose
 *    audience is fixtures only. No other site, label or policy is written; every other
 *    label and policy definition reads the same at the end as at the start;
 *  - zero content calls: every cmdlet is re-checked against the task-106 allowlists.
 *    No file, list item, item-applied label, label usage or per-file permission is read;
 *  - inherited versus explicit state was recorded for every OneDrive field;
 *  - guarded post-state: the label's protection never moved (its whole definition reads
 *    as it started); the policy only gained the fixture label, nothing else changed;
 *  - refusals observed, not overridden: a protection-weakening write, an unpublish, an
 *    item-label read and a path inside the OneDrive were refused before sending; a
 *    preservation-locked label was refused by the production restore planner; no write
 *    went to an object that reports a lock; a platform error came back structured;
 *  - module versions and documentation retrieval are recorded; no credential material.
 *
 * It never sends anything and never enables anything. A verified record is turned into
 * ledger evidence only by tools/qualification/onedrivePurviewLive.mjs.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { WORKLOAD_DESCRIPTORS } from '../../engine/collect/workloadContract.mjs';
import {
  INHERITANCE_STATES, ONEDRIVE_FIELDS, ONEDRIVE_MODULE, ONEDRIVE_OPERATION, OneDriveScopeError, assertOneDriveCmdlet, oneDriveSite,
} from '../../engine/collect/workloads/onedrive.mjs';
import { LABEL_FIELDS, POLICY_FIELDS, PURVIEW_MODULE, PURVIEW_OPERATIONS, assertPurviewCmdlet } from '../../engine/collect/workloads/purview.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../../engine/coverage/qualification.mjs';
import { EXCHANGE_LIVE_GATE } from './exchangeAcceptance.mjs';

export const ONEDRIVE_PURVIEW_LIVE_GATE = 'onedrive-purview-live-acceptance';
export const ONEDRIVE_PURVIEW_LIVE_OPERATION = 'onedrive-purview.configuration-qualification';
export const ONEDRIVE_PURVIEW_CREDENTIAL_MODE = 'collector-read+restorer-write';
export const ONEDRIVE_PURVIEW_PREREQUISITES = Object.freeze(['task-106', 'task-122']);
export const ONEDRIVE_PURVIEW_READS = Object.freeze([ONEDRIVE_OPERATION, ...PURVIEW_OPERATIONS]);
export const ONEDRIVE_PURVIEW_LABEL_WRITE = 'purview.label.update';
export const ONEDRIVE_PURVIEW_POLICY_WRITE = 'purview.label-policy.update';
export const ONEDRIVE_PURVIEW_WRITES = Object.freeze([ONEDRIVE_PURVIEW_LABEL_WRITE, ONEDRIVE_PURVIEW_POLICY_WRITE]);
export const ONEDRIVE_PURVIEW_TRANSPORT = 'powershell-cmdlet-job';
export const ONEDRIVE_PURVIEW_FIXTURE_PREFIX = 'keel-rt-';
// The only label property a capture changes: admin-facing, never protection.
export const ONEDRIVE_PURVIEW_LABEL_TOGGLE = 'Comment';
// Writes a capture sends: the label comment changed then put back; one label added to the policy.
export const ONEDRIVE_PURVIEW_EXPECTED_WRITES = Object.freeze({ [ONEDRIVE_PURVIEW_LABEL_WRITE]: 2, [ONEDRIVE_PURVIEW_POLICY_WRITE]: 1 });
// Policy locations: every entry must name a fixture; `All` publishes to the whole tenant.
export const ONEDRIVE_PURVIEW_POLICY_LOCATIONS = Object.freeze(['ExchangeLocation', 'ModernGroupLocation', 'SharePointLocation', 'OneDriveLocation']);
// Calls a capture asks KEEL to make; each must be refused before anything is sent.
export const ONEDRIVE_PURVIEW_REFUSAL_PROBES = Object.freeze({
  protectionWeakening: Object.freeze({ module: PURVIEW_MODULE, cmdlet: 'Set-Label', parameter: 'EncryptionEnabled' }),
  unpublish: Object.freeze({ module: PURVIEW_MODULE, cmdlet: 'Set-LabelPolicy', parameter: 'RemoveLabels' }),
  itemLabels: Object.freeze({ module: PURVIEW_MODULE, cmdlet: 'Export-ContentExplorerData', parameter: null }),
  oneDriveContent: Object.freeze({ module: ONEDRIVE_MODULE, cmdlet: 'Get-PnPListItem', parameter: null }),
});
// A capture belongs to the record it is in: no older than this before observedAt.
export const ONEDRIVE_PURVIEW_CAPTURE_WINDOW_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MODULE_VERSION_RE = /^\d+\.\d+\.\d+(\.\d+)?$/;
const SECRET_KEY = /(token|secret|password|passwd|private.?key|bearer|authorization|cookie|thumbprint|certpath|keypath|pfx)/i;
const SECRET_VALUE = /^(eyJ[\w-]+\.[\w-]+\.|Bearer\s)|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const VOLATILE = new Set(['WhenChangedUTC']);

const MODULE_OF = Object.freeze({
  [ONEDRIVE_OPERATION]: ONEDRIVE_MODULE,
  'purview.label-definitions': PURVIEW_MODULE,
  'purview.label-publication': PURVIEW_MODULE,
  [ONEDRIVE_PURVIEW_LABEL_WRITE]: PURVIEW_MODULE,
  [ONEDRIVE_PURVIEW_POLICY_WRITE]: PURVIEW_MODULE,
});
// The family whose grants each operation draws on. One family's grants never cover the other's.
const FAMILY_OF = Object.freeze({
  [ONEDRIVE_OPERATION]: 'onedrive', 'purview.label-definitions': 'purview', 'purview.label-publication': 'purview',
  [ONEDRIVE_PURVIEW_LABEL_WRITE]: 'purview', [ONEDRIVE_PURVIEW_POLICY_WRITE]: 'purview',
});

export function onedrivePurviewReadDescriptor(id) {
  return WORKLOAD_DESCRIPTORS.find((descriptor) => descriptor.id === id) ?? null;
}

/** The module version an operation is bound to, from the record's module versions. */
export function onedrivePurviewOperationVersion(id, modules) {
  const module = MODULE_OF[id];
  return module ? modules?.[module] ?? null : null;
}

function onedrivePurviewCanonical(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(onedrivePurviewCanonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${onedrivePurviewCanonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** The fingerprint of a definition's kept fields (save time and `skip` excluded). */
export function onedrivePurviewFingerprint(fields, keys, skip = []) {
  if (!fields || typeof fields !== 'object') return null;
  const kept = Object.fromEntries(keys.filter((key) => !VOLATILE.has(key) && !skip.includes(key)).map((key) => [key, fields[key] ?? null]));
  return createHash('sha256').update(onedrivePurviewCanonical(kept)).digest('hex');
}

/** True for a disposable fixture name: KEEL-RT-*, any case. */
export function onedrivePurviewIsFixtureName(name) {
  return typeof name === 'string' && name.toLowerCase().startsWith(ONEDRIVE_PURVIEW_FIXTURE_PREFIX) && name.length > ONEDRIVE_PURVIEW_FIXTURE_PREFIX.length;
}

/** The tenant's OneDrive host for a SharePoint tenant host: contoso.sharepoint.com -> contoso-my.sharepoint.com. */
export function onedrivePurviewMyHost(tenantHost) {
  const match = typeof tenantHost === 'string' ? /^([a-z0-9-]+)\.sharepoint\.com$/i.exec(tenantHost) : null;
  return match ? `${match[1].toLowerCase()}-my.sharepoint.com` : null;
}

/** The normalized fixture OneDrive URL, or null unless it is a KEEL-RT-* personal site on `myHost`. */
export function onedrivePurviewFixtureSite(url, myHost) {
  let normalized;
  try {
    normalized = oneDriveSite(url, myHost);
  } catch (error) {
    if (error instanceof OneDriveScopeError || error instanceof TypeError) return null;
    throw error;
  }
  return onedrivePurviewIsFixtureName(normalized.split('/').pop()) ? normalized : null;
}

/** Every location entry of a policy names a fixture (no `All`, nothing else). Empty is allowed. */
export function onedrivePurviewPolicyAudienceProblems(fields) {
  const problems = [];
  for (const location of ONEDRIVE_PURVIEW_POLICY_LOCATIONS) {
    const value = fields?.[location];
    const entries = Array.isArray(value) ? value.map(String) : value === null || value === undefined || value === '' ? [] : [String(value)];
    for (const entry of entries) {
      if (!entry.toLowerCase().includes(ONEDRIVE_PURVIEW_FIXTURE_PREFIX)) problems.push(`${location} publishes to ${entry}, not only to KEEL-RT fixtures`);
    }
  }
  return problems;
}

/** The documentation every qualified operation was declared from. */
export function onedrivePurviewRequiredDocumentation() {
  const urls = ONEDRIVE_PURVIEW_READS.map((id) => onedrivePurviewReadDescriptor(id)?.source?.url);
  for (const id of ONEDRIVE_PURVIEW_WRITES) urls.push(WORKLOAD_WRITE_OPERATIONS[id]?.source);
  return [...new Set(urls.filter(Boolean))];
}

/** The permissions and roles each credential needs, per family, from the production declarations. */
export function onedrivePurviewRequiredGrants() {
  const empty = () => ({ permissions: new Set(), roles: new Set() });
  const out = { collector: { onedrive: empty(), purview: empty() }, restorer: { purview: empty() } };
  const add = (bucket, rbac) => {
    for (const permission of rbac?.permissions ?? []) bucket.permissions.add(permission);
    for (const role of rbac?.roles ?? []) bucket.roles.add(role);
  };
  for (const id of ONEDRIVE_PURVIEW_READS) add(out.collector[FAMILY_OF[id]], onedrivePurviewReadDescriptor(id)?.rbac);
  for (const id of ONEDRIVE_PURVIEW_WRITES) add(out.restorer[FAMILY_OF[id]], WORKLOAD_WRITE_OPERATIONS[id]?.rbac);
  const sorted = (bucket) => ({ permissions: [...bucket.permissions].sort(), roles: [...bucket.roles].sort() });
  return {
    collector: { onedrive: sorted(out.collector.onedrive), purview: sorted(out.collector.purview) },
    restorer: { purview: sorted(out.restorer.purview) },
  };
}

/** Every key path whose name or value looks like credential material. */
export function onedrivePurviewSecretProblems(value, path = '$') {
  const problems = [];
  if (Array.isArray(value)) value.forEach((item, index) => problems.push(...onedrivePurviewSecretProblems(item, `${path}[${index}]`)));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) problems.push(`${path}.${key} looks like credential material`);
      problems.push(...onedrivePurviewSecretProblems(child, `${path}.${key}`));
    }
  } else if (typeof value === 'string' && SECRET_VALUE.test(value)) problems.push(`${path} holds credential material`);
  return problems;
}

function onedrivePurviewCaptureTimeProblems(label, capturedAt, observedAt) {
  const at = Date.parse(capturedAt ?? '');
  if (Number.isNaN(at)) return [`${label}: no valid capture time`];
  if (Number.isNaN(observedAt)) return [];
  if (at > observedAt + CLOCK_SKEW_MS) return [`${label}: captured after the record was observed`];
  if (observedAt - at > ONEDRIVE_PURVIEW_CAPTURE_WINDOW_MS) return [`${label}: captured more than 24h before the record (stale capture)`];
  return [];
}

function onedrivePurviewMissing(held, needed) {
  const have = new Set(Array.isArray(held) ? held : []);
  return needed.filter((item) => !have.has(item));
}

const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const listOf = (value) => (Array.isArray(value) ? value.map(String) : value === null || value === undefined || value === '' ? [] : [String(value)]);

function onedrivePurviewReadRecord(name, evidenceDir) {
  try {
    return JSON.parse(readFileSync(join(evidenceDir ?? process.cwd(), name), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The task-122 Exchange record this one depends on. It must verify by itself, with
 * --require-live, for the same tenant and build (and so must the Teams and SharePoint
 * records behind it). Returns the Exchange record and the SharePoint tenant host the
 * chain names, for the tenant binding.
 */
function onedrivePurviewExchangePrerequisite(reference, { tenantRef, build, now, maxAgeHours, hmacKey, evidenceDir, trustedRunners, verifyEvidence }) {
  const none = (failure) => ({ failures: [failure], record: null, upstreamLogs: [], tenantHost: null });
  if (!reference || typeof reference !== 'object') return none('missing prerequisite: no task-122 Exchange qualification record named');
  if (reference.gate !== EXCHANGE_LIVE_GATE) return none(`missing prerequisite: the named prerequisite is '${reference.gate ?? 'missing'}', not ${EXCHANGE_LIVE_GATE}`);
  if (typeof reference.evidence !== 'string' || !/^[\w.-]+\.json$/.test(reference.evidence)) {
    return none('missing prerequisite: the Exchange record must be named as a file beside this one');
  }
  if (typeof verifyEvidence !== 'function') return none('missing prerequisite: the Exchange record cannot be verified here');
  const record = onedrivePurviewReadRecord(reference.evidence, evidenceDir);
  if (!record) return none(`missing prerequisite: Exchange record ${reference.evidence} is absent or unreadable`);
  const result = verifyEvidence(record, {
    gate: EXCHANGE_LIVE_GATE, tenantRef, build, requireLive: true, now, maxAgeHours, hmacKey, evidenceDir, trustedRunners,
  });
  const failures = result.ok ? [] : [`missing prerequisite: Exchange record does not verify: ${result.failures.join('; ')}`];
  if (record.subject?.captureLogSha256 !== reference.captureLogSha256) failures.push('missing prerequisite: the Exchange record is not the one this capture named');
  // Walk the chain the Exchange verifier just checked: Exchange -> Teams -> SharePoint.
  const teamsRef = record.subject?.teamsQualification;
  const teams = typeof teamsRef?.evidence === 'string' && /^[\w.-]+\.json$/.test(teamsRef.evidence) ? onedrivePurviewReadRecord(teamsRef.evidence, evidenceDir) : null;
  const spRef = teams?.subject?.sharePointQualification;
  const sharePoint = typeof spRef?.evidence === 'string' && /^[\w.-]+\.json$/.test(spRef.evidence) ? onedrivePurviewReadRecord(spRef.evidence, evidenceDir) : null;
  const upstreamLogs = [record.subject?.captureLogSha256, teamsRef?.captureLogSha256, spRef?.captureLogSha256].filter(Boolean);
  return { failures, record, upstreamLogs, tenantHost: sharePoint?.subject?.tenantHost ?? null };
}

function onedrivePurviewRequestProblems(requests, { site, probeSite, label, policy }) {
  if (!Array.isArray(requests) || requests.length === 0) return ['no request log recorded'];
  if (!site || !label?.id || !policy?.id) return ['no fixture site, label and policy to check the request log against'];
  const failures = [];
  const counts = Object.fromEntries(ONEDRIVE_PURVIEW_WRITES.map((id) => [id, 0]));
  for (const [index, request] of requests.entries()) {
    const tag = `request ${index} (${request?.cmdlet ?? '?'})`;
    if (!['collector', 'restorer'].includes(request?.credential)) { failures.push(`${tag}: unknown credential`); continue; }
    if (request.transport !== ONEDRIVE_PURVIEW_TRANSPORT) { failures.push(`${tag}: not the bounded cmdlet transport`); continue; }
    const parameters = request.parameters && typeof request.parameters === 'object' && !Array.isArray(request.parameters) ? request.parameters : null;
    if (!parameters) { failures.push(`${tag}: parameters not recorded as data`); continue; }
    try {
      if (request.module === ONEDRIVE_MODULE) assertOneDriveCmdlet({ cmdlet: request.cmdlet, parameters });
      else if (request.module === PURVIEW_MODULE) assertPurviewCmdlet({ cmdlet: request.cmdlet, parameters });
      else throw new Error(`module ${request.module ?? 'missing'} is neither ${ONEDRIVE_MODULE} nor ${PURVIEW_MODULE}`);
    } catch (error) {
      failures.push(`${tag}: content call or undeclared cmdlet: ${error.message}`);
      continue;
    }
    if (request.cmdlet === 'Get-PnPTenantSite') {
      if (request.credential !== 'collector') failures.push(`${tag}: only the collector reads the OneDrive site`);
      if (probeSite && sameText(parameters.Identity, probeSite)) {
        if (request.outcome === 'ok') failures.push(`${tag}: the platform-error probe site answered; it must not exist`);
      } else if (!sameText(parameters.Identity, site)) failures.push(`${tag}: addresses a OneDrive other than the KEEL-RT fixture`);
      continue;
    }
    if (request.cmdlet.startsWith('Get-')) continue;
    if (request.credential !== 'restorer') { failures.push(`${tag}: not an allowed write (only the restorer writes the fixtures)`); continue; }
    const names = Object.keys(parameters).filter((name) => name !== 'Identity');
    if (request.cmdlet === 'Set-Label') {
      counts[ONEDRIVE_PURVIEW_LABEL_WRITE] += 1;
      if (!sameText(parameters.Identity, label.id)) failures.push(`${tag}: writes a label other than the KEEL-RT fixture label`);
      if (names.length !== 1 || names[0] !== ONEDRIVE_PURVIEW_LABEL_TOGGLE) failures.push(`${tag}: changes more than the label's ${ONEDRIVE_PURVIEW_LABEL_TOGGLE}`);
    } else if (request.cmdlet === 'Set-LabelPolicy') {
      counts[ONEDRIVE_PURVIEW_POLICY_WRITE] += 1;
      if (!sameText(parameters.Identity, policy.id)) failures.push(`${tag}: writes a policy other than the KEEL-RT fixture policy`);
      const added = listOf(parameters.AddLabels);
      if (names.length !== 1 || names[0] !== 'AddLabels' || added.length !== 1 || !sameText(added[0], label.name)) {
        failures.push(`${tag}: publishes something other than exactly the KEEL-RT fixture label`);
      }
    }
  }
  for (const [id, expected] of Object.entries(ONEDRIVE_PURVIEW_EXPECTED_WRITES)) {
    if (counts[id] !== expected) failures.push(`expected exactly ${expected} ${id} write(s), found ${counts[id]}`);
  }
  if ((label.lock === 'locked' || policy.lock === 'locked') && Object.values(counts).some((count) => count > 0)) {
    failures.push('a write was sent to an object that reports a preservation lock; a lock is observed, never overridden');
  }
  return failures;
}

function onedrivePurviewWriteCaptureProblems(capture, id, { observedAt, modules }) {
  const failures = [];
  if (!capture || capture.operationId !== id) return [`missing prerequisite: no live capture of ${id}`];
  if (capture.synthetic !== false) failures.push(`${id}: synthetic or unlabelled capture`);
  const version = onedrivePurviewOperationVersion(id, modules);
  if (capture.version !== version) failures.push(`${id}: captured at ${capture.version ?? 'unknown'}, not ${version ?? 'a recorded module version'}`);
  if (capture.ok !== true) failures.push(`${id}: the write failed`);
  if (capture.readBackVerified !== true) failures.push(`${id}: the change was not read back as written`);
  failures.push(...onedrivePurviewCaptureTimeProblems(id, capture.capturedAt, observedAt));
  return failures;
}

function onedrivePurviewLabelWriteProblems(capture) {
  if (!capture || capture.operationId !== ONEDRIVE_PURVIEW_LABEL_WRITE) return [];
  const id = ONEDRIVE_PURVIEW_LABEL_WRITE;
  const failures = [];
  if (capture.writeMode !== 'reversible-change') failures.push(`${id}: a same-value write does not prove the platform applies a change`);
  if (capture.property !== ONEDRIVE_PURVIEW_LABEL_TOGGLE) failures.push(`${id}: ${capture.property ?? 'no property'} is not the qualified ${ONEDRIVE_PURVIEW_LABEL_TOGGLE} change`);
  if (capture.restoredToOriginal !== true) failures.push(`${id}: the label comment was not put back`);
  if (typeof capture.preFingerprint !== 'string' || capture.preFingerprint !== capture.finalFingerprint) {
    failures.push(`${id}: the label's definition (and so its protection) does not read as it started`);
  }
  return failures;
}

function onedrivePurviewPolicyWriteProblems(capture, label) {
  if (!capture || capture.operationId !== ONEDRIVE_PURVIEW_POLICY_WRITE) return [];
  const id = ONEDRIVE_PURVIEW_POLICY_WRITE;
  const failures = [];
  if (capture.writeMode !== 'add-only') failures.push(`${id}: publishing is qualified only by an add-only write (a put-back would unpublish the label)`);
  if (!label?.name || !sameText(capture.addedLabel, label.name)) failures.push(`${id}: the label added is not the KEEL-RT fixture label`);
  const before = listOf(capture.before?.Labels).map((name) => name.toLowerCase());
  const after = listOf(capture.after?.Labels).map((name) => name.toLowerCase());
  if (!capture.before || !capture.after) failures.push(`${id}: the policy's labels before and after were not recorded`);
  else {
    if (before.some((name) => !after.includes(name))) failures.push(`${id}: a label was removed from the policy; KEEL never unpublishes a label`);
    const added = after.filter((name) => !before.includes(name));
    if (added.length !== 1 || !sameText(added[0], label?.name)) failures.push(`${id}: the policy did not gain exactly the fixture label`);
  }
  if (typeof capture.preFingerprint !== 'string' || capture.preFingerprint !== capture.finalFingerprint) {
    failures.push(`${id}: a policy setting other than its labels changed (locations, mode or settings)`);
  }
  return failures;
}

function onedrivePurviewRefusalProblems(subject) {
  const failures = [];
  for (const [name, probe] of Object.entries(ONEDRIVE_PURVIEW_REFUSAL_PROBES)) {
    const refusal = subject.refusals?.[name];
    if (refusal?.cmdlet !== probe.cmdlet || refusal?.refused !== true || refusal?.sent !== false) {
      failures.push(`${name} not shown refused: ${probe.cmdlet}${probe.parameter ? ` -${probe.parameter}` : ''} must be refused before anything is sent`);
    }
  }
  const path = subject.refusals?.oneDrivePath;
  if (path?.refused !== true || path?.sent !== false) failures.push('a path inside the OneDrive was not shown refused before sending');
  const lock = subject.refusals?.preservationLock;
  if (lock?.refused !== true || lock?.sent !== false || !/preservation-locked/.test(String(lock?.reason ?? ''))) {
    failures.push('preservation lock not shown refused: the restore planner must refuse a locked label before anything is sent');
  }
  const platform = subject.platformError;
  if (!platform || typeof platform.site !== 'string' || !platform.site.toLowerCase().includes(`/personal/${ONEDRIVE_PURVIEW_FIXTURE_PREFIX}`)) {
    failures.push('platform error not captured: no absent KEEL-RT OneDrive probe');
  } else {
    if (platform.status !== 'failed' && platform.status !== 'denied') failures.push('platform error: the probe was recorded as a success, not a structured failure');
    if (platform.error?.code !== 'CMDLET_ERROR' || typeof platform.error?.errorId !== 'string' || !platform.error.errorId
        || typeof platform.error?.message !== 'string' || !platform.error.message) {
      failures.push('platform error: the cmdlet error was not preserved with its code, errorId and message');
    }
  }
  return failures;
}

/**
 * Gate validator for the task-123 record. Returns failure reasons; empty means the
 * subject holds. `runner` is the release verifier's runner-proof result.
 */
export function validateOneDrivePurviewLiveSubject(evidence, context = {}) {
  const { tenantRef, build, artifact, runner } = context;
  const failures = [];
  if (evidence.status === 'pending') return ['OneDrive and Purview live evidence pending: no record has been captured'];
  if (!runner?.ok) failures.push(`OneDrive/Purview runner proof required (${runner?.reason ?? 'not checked'})`);
  if (!artifact?.ok) failures.push(`OneDrive/Purview capture artifact required (${artifact?.reason ?? 'not checked'})`);
  if (evidence.evidenceLevel === 'live-qualified' && (evidence.synthetic !== false || runner?.synthetic)) {
    failures.push('OneDrive/Purview fixture evidence cannot claim live qualification');
  }
  if (!tenantRef || !build) failures.push('OneDrive/Purview expected tenant/build identity required');
  if (build && evidence.build !== build) failures.push(`OneDrive/Purview build mismatch: evidence is '${evidence.build}', required '${build}'`);
  if (evidence.operation !== ONEDRIVE_PURVIEW_LIVE_OPERATION) {
    failures.push(`OneDrive/Purview operation mismatch: expected '${ONEDRIVE_PURVIEW_LIVE_OPERATION}', got '${evidence.operation ?? 'missing'}'`);
  }
  if (evidence.credentialMode !== ONEDRIVE_PURVIEW_CREDENTIAL_MODE) failures.push(`OneDrive/Purview requires credential mode '${ONEDRIVE_PURVIEW_CREDENTIAL_MODE}'`);
  failures.push(...onedrivePurviewSecretProblems(evidence));

  const subject = evidence.subject;
  if (!subject || typeof subject !== 'object') return [...failures, 'subject is missing'];
  const observedAt = Date.parse(evidence.observedAt ?? '');

  // Prerequisites: named, declared in this build, and the Exchange record verifies.
  for (const task of onedrivePurviewMissing(subject.prerequisites, ONEDRIVE_PURVIEW_PREREQUISITES)) failures.push(`missing prerequisite: ${task}`);
  for (const id of ONEDRIVE_PURVIEW_READS) if (!onedrivePurviewReadDescriptor(id)) failures.push(`prerequisite missing in this build: ${id} is not declared`);
  for (const id of ONEDRIVE_PURVIEW_WRITES) if (!WORKLOAD_WRITE_OPERATIONS[id]) failures.push(`prerequisite missing in this build: ${id} is not declared`);
  const exchange = onedrivePurviewExchangePrerequisite(subject.exchangeQualification, { ...context, tenantRef, build });
  failures.push(...exchange.failures);
  // Exchange, Teams or SharePoint proof is never OneDrive or Purview proof: this log must be its own.
  if (subject.captureLogSha256 && [subject.exchangeQualification?.captureLogSha256, ...exchange.upstreamLogs].includes(subject.captureLogSha256)) {
    failures.push('an Exchange, Teams or SharePoint capture log cannot stand in for the OneDrive/Purview capture');
  }

  // The managed tenant: the one the Exchange record names.
  const directoryTenantId = typeof subject.directoryTenantId === 'string' ? subject.directoryTenantId.toLowerCase() : null;
  if (!directoryTenantId || !GUID_RE.test(directoryTenantId)) failures.push('no managed directory tenant id');
  else if (exchange.record && String(exchange.record.subject?.directoryTenantId ?? '').toLowerCase() !== directoryTenantId) {
    failures.push('the record names another directory tenant than its Exchange prerequisite');
  }

  // Argument-safe execution through the bounded job transport, with both module versions.
  if (subject.execution?.transport !== ONEDRIVE_PURVIEW_TRANSPORT) failures.push(`cmdlets must run through the bounded ${ONEDRIVE_PURVIEW_TRANSPORT} transport`);
  const modules = {};
  for (const module of [ONEDRIVE_MODULE, PURVIEW_MODULE]) {
    const version = subject.execution?.modules?.[module];
    if (typeof version === 'string' && MODULE_VERSION_RE.test(version)) modules[module] = version;
    else failures.push(`no ${module} module version recorded`);
  }

  // Credentials: references only, two identities, grants declared per family.
  const credentials = subject.credentials ?? {};
  for (const role of ['collector', 'restorer']) {
    if (typeof credentials[role] !== 'string' || !credentials[role].trim()) failures.push(`no ${role} credential reference`);
  }
  if (credentials.collector && credentials.collector === credentials.restorer) failures.push('collector and restorer must be separate credentials');
  const needed = onedrivePurviewRequiredGrants();
  for (const [role, families] of Object.entries(needed)) {
    for (const [family, need] of Object.entries(families)) {
      const held = subject.grants?.[role]?.[family];
      if (!held || !Array.isArray(held.permissions) || !Array.isArray(held.roles)) {
        failures.push(`missing prerequisite: the ${role}'s ${family} grants were not declared (never assumed)`);
        continue;
      }
      for (const permission of onedrivePurviewMissing(held.permissions, need.permissions)) failures.push(`missing prerequisite: ${role} lacks ${permission} for ${family}`);
      for (const adminRole of onedrivePurviewMissing(held.roles, need.roles)) failures.push(`missing prerequisite: ${role} lacks role ${adminRole} for ${family}`);
    }
  }

  // Fixtures: a KEEL-RT OneDrive on this tenant's -my host, a KEEL-RT label and policy.
  const myHost = onedrivePurviewMyHost(exchange.tenantHost);
  if (exchange.record && !myHost) failures.push('the SharePoint prerequisite names no tenant host to bind the OneDrive to');
  const site = myHost ? onedrivePurviewFixtureSite(subject.fixtureSite?.url, myHost) : null;
  if (!site) failures.push(`the fixture OneDrive is not a ${ONEDRIVE_PURVIEW_FIXTURE_PREFIX}* personal site on ${myHost ?? 'the tenant\'s -my host'}`);
  if (typeof subject.fixtureSite?.template !== 'string' || !/^SPSPERS/i.test(subject.fixtureSite.template)) failures.push('the fixture site did not answer as a OneDrive personal site');
  const label = subject.fixtureLabel ?? {};
  const policy = subject.fixturePolicy ?? {};
  if (!onedrivePurviewIsFixtureName(label.name) || typeof label.id !== 'string' || !GUID_RE.test(label.id)) failures.push(`the fixture label is not a ${ONEDRIVE_PURVIEW_FIXTURE_PREFIX}* label with an immutable id`);
  if (!onedrivePurviewIsFixtureName(policy.name) || typeof policy.id !== 'string' || !GUID_RE.test(policy.id)) failures.push(`the fixture policy is not a ${ONEDRIVE_PURVIEW_FIXTURE_PREFIX}* policy with an immutable id`);
  for (const problem of onedrivePurviewPolicyAudienceProblems(policy.locations)) failures.push(`the fixture policy is not fixture-only: ${problem}`);
  for (const [name, object] of [['label', label], ['policy', policy]]) {
    if (!['locked', 'unlocked', 'not-reported'].includes(object.lock)) failures.push(`the fixture ${name}'s lock state was not observed`);
  }

  // Reads: one successful, non-synthetic capture per operation, at its module's version.
  const reads = Array.isArray(subject.reads) ? subject.reads : [];
  for (const id of ONEDRIVE_PURVIEW_READS) {
    const capture = reads.find((item) => item?.operationId === id);
    if (!capture) { failures.push(`missing prerequisite: no live capture of ${id}`); continue; }
    if (capture.synthetic !== false) failures.push(`${id}: synthetic or unlabelled capture`);
    if (capture.ok !== true) failures.push(`${id}: the read failed`);
    const version = onedrivePurviewOperationVersion(id, modules);
    if (capture.version !== version) failures.push(`${id}: captured at ${capture.version ?? 'unknown'}, not ${version ?? 'a recorded module version'}`);
    failures.push(...onedrivePurviewCaptureTimeProblems(id, capture.capturedAt, observedAt));
  }
  const onedriveRead = reads.find((item) => item?.operationId === ONEDRIVE_OPERATION);
  if (onedriveRead && onedriveRead.form !== 'Get-PnPTenantSite -Identity') failures.push(`${ONEDRIVE_OPERATION}: not captured in the -Identity form the adapter uses`);
  for (const [group, fields] of Object.entries({ onedrive: Object.keys(ONEDRIVE_FIELDS), label: LABEL_FIELDS, policy: POLICY_FIELDS })) {
    for (const field of onedrivePurviewMissing(subject.supportedFields?.[group], fields)) failures.push(`supported field not observed live: ${group}.${field}`);
  }
  // Inherited versus explicit, recorded for every OneDrive field; a conditional field is determined.
  for (const [field, spec] of Object.entries(ONEDRIVE_FIELDS)) {
    const state = subject.inheritance?.[field];
    if (!INHERITANCE_STATES.includes(state)) failures.push(`inheritance not recorded for OneDrive field ${field}`);
    else if (spec.kind === 'conditional' && state === 'undetermined') failures.push(`inheritance of OneDrive field ${field} was not determined live`);
  }

  // Writes: each its own capture; the label ends as it started; the policy only gained the label.
  const writes = subject.writes ?? {};
  const byId = { [ONEDRIVE_PURVIEW_LABEL_WRITE]: writes.label, [ONEDRIVE_PURVIEW_POLICY_WRITE]: writes.policy };
  for (const id of ONEDRIVE_PURVIEW_WRITES) failures.push(...onedrivePurviewWriteCaptureProblems(byId[id], id, { observedAt, modules }));
  failures.push(...onedrivePurviewLabelWriteProblems(writes.label));
  failures.push(...onedrivePurviewPolicyWriteProblems(writes.policy, label));
  for (const [key, capture] of Object.entries(writes)) {
    if (!['label', 'policy'].includes(key)) failures.push(`${capture?.operationId ?? key} is not part of this capture (no OneDrive write is declared)`);
  }

  // Every other label and policy definition reads the same at the end as at the start.
  const others = subject.tenantDefinitions;
  if (!others || !Number.isInteger(others.labels) || !Number.isInteger(others.policies)
      || typeof others.otherFingerprint !== 'string' || others.otherFingerprint !== others.finalOtherFingerprint) {
    failures.push('a non-fixture label or policy definition changed during the capture, or was not checked');
  }

  failures.push(...onedrivePurviewRefusalProblems(subject));

  // The raw capture log is bound into the signed subject.
  if (typeof subject.captureLogSha256 !== 'string' || !SHA256_RE.test(subject.captureLogSha256)
      || subject.captureLogSha256 !== evidence.proof?.artifact?.sha256) {
    failures.push('the capture log digest is not bound to the signed subject');
  }

  // Zero content calls and fixture-only writes, re-derived from the log.
  failures.push(...onedrivePurviewRequestProblems(subject.requests, { site, probeSite: subject.platformError?.site ?? null, label, policy }));

  const docs = Array.isArray(subject.documentation) ? subject.documentation : [];
  for (const url of onedrivePurviewRequiredDocumentation()) {
    const entry = docs.find((item) => item?.url === url);
    if (!entry || Number.isNaN(Date.parse(entry.retrievedAt ?? ''))) failures.push(`documentation not retrieved: ${url}`);
  }
  return failures;
}
