/**
 * Roadmap task-122: the Exchange configuration workload live-acceptance gate.
 *
 * This is the evidence contract and its gate validator. It is registered in
 * tools/release/qualification.mjs (GATE_VALIDATORS) and checks the `subject` of
 * a record captured by tools/qualification/exchangeLive.mjs against the production
 * declarations it qualifies:
 *  - the task-105 reads (exchange.mailbox-settings over Graph; exchange.client-access,
 *    exchange.mailbox-hold and exchange.organization-config as cmdlets);
 *  - three of the four task-105 writes, each with its own capture:
 *    exchange.mailbox-settings.update, exchange.client-access.update and
 *    exchange.mailbox-retention.update. The fourth, exchange.organization-config.update
 *    (Set-OrganizationConfig), changes the whole tenant: it is NOT part of this
 *    capture, a record that sends it fails, and it stays unqualified until the
 *    operator decides otherwise (docs/roadmap/exchange-live-acceptance.md).
 *
 * What a passing subject proves, beyond the generic verifier (signature, capture
 * log digest, gate, tenant, freshness, --require-live):
 *  - identity: operation, build, credential mode, two distinct credential references
 *    (the collector reads, the restorer writes; the collector holds no Graph write
 *    permission and never runs a Set- cmdlet), and the directory tenant the Exchange
 *    organization reports;
 *  - prerequisites: tasks 105 and 121 are named; the Exchange declarations exist in
 *    this build; and the task-121 Teams record it names verifies on its own, for the
 *    same tenant and build (which in turn needs the task-120 SharePoint record).
 *    Teams or SharePoint proof is a prerequisite, never Exchange proof;
 *  - fixture: one disposable `keel-rt-*` user mailbox in the managed tenant. No other
 *    mailbox is addressed, except one deliberately absent `keel-rt-*` identity used to
 *    capture a platform error;
 *  - zero content calls: every Graph request is re-checked against the task-105
 *    request shapes and the task-101 scope validator; every cmdlet against the
 *    task-105 cmdlet allowlist. No message, folder, rule, calendar or contact is read;
 *  - argument-safe execution: the record names the bounded cmdlet transport, and
 *    each cmdlet's parameters are recorded as data;
 *  - guarded post-state: a mailbox setting and a client-access switch were changed,
 *    read back and put back; deleted-item retention was only EXTENDED (never
 *    shortened), and no hold was touched. Nothing releases a hold or shortens
 *    retention, in the log or in the post-state;
 *  - refusals and platform errors: an unsupported held/locked field was refused
 *    before anything was sent, and a platform error came back structured;
 *  - throttle behaviour, the module version and documentation retrieval are recorded;
 *  - no credential material anywhere in the record.
 *
 * It never sends a request and never enables anything. A verified record is turned
 * into ledger evidence only by tools/qualification/exchangeLive.mjs.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { WORKLOAD_DESCRIPTORS, scopeProblems } from '../../engine/collect/workloadContract.mjs';
import {
  CLIENT_ACCESS_FIELDS, EXCHANGE_MODULE, EXCHANGE_OPERATIONS, MAILBOX_SETTING_FIELDS, ORGANIZATION_FIELDS, RETENTION_FIELDS,
  assertExchangeCmdlet, assertExchangeRequest,
} from '../../engine/collect/workloads/exchange.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../../engine/coverage/qualification.mjs';
import { TEAMS_LIVE_GATE } from './teamsAcceptance.mjs';

export const EXCHANGE_LIVE_GATE = 'exchange-live-acceptance';
export const EXCHANGE_LIVE_OPERATION = 'exchange.configuration-qualification';
export const EXCHANGE_LIVE_CREDENTIAL_MODE = 'collector-read+restorer-write';
export const EXCHANGE_LIVE_PREREQUISITES = Object.freeze(['task-105', 'task-121']);
export const EXCHANGE_LIVE_READS = EXCHANGE_OPERATIONS;
export const EXCHANGE_LIVE_SETTINGS_WRITE = 'exchange.mailbox-settings.update';
export const EXCHANGE_LIVE_CAS_WRITE = 'exchange.client-access.update';
export const EXCHANGE_LIVE_RETENTION_WRITE = 'exchange.mailbox-retention.update';
export const EXCHANGE_LIVE_WRITES = Object.freeze([EXCHANGE_LIVE_SETTINGS_WRITE, EXCHANGE_LIVE_CAS_WRITE, EXCHANGE_LIVE_RETENTION_WRITE]);
// Organization-wide: excluded from the capture until the operator decides (see the doc).
export const EXCHANGE_LIVE_EXCLUDED_WRITES = Object.freeze(['exchange.organization-config.update']);
export const EXCHANGE_FIXTURE_PREFIX = 'keel-rt-';
export const EXCHANGE_TRANSPORT = 'powershell-cmdlet-job';
// The properties a capture changes: one per write, each a supported, non-hold setting.
export const EXCHANGE_SETTINGS_TOGGLE = 'timeZone';
export const EXCHANGE_CAS_TOGGLE = 'PopEnabled';
export const EXCHANGE_RETENTION_PROPERTY = 'RetainDeletedItemsFor';
// Exchange Online's ceiling for deleted item retention.
export const EXCHANGE_MAX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// Retention fields a capture must leave exactly as it found them (holds and recovery).
export const EXCHANGE_HOLD_WRITE_FIELDS = Object.freeze(['LitigationHoldEnabled', 'RetentionHoldEnabled', 'SingleItemRecoveryEnabled']);
// A held/locked field the capture asks KEEL to write; KEEL must refuse it before sending.
export const EXCHANGE_REFUSAL_PROBE = Object.freeze({ cmdlet: 'Set-Mailbox', parameter: 'LitigationHoldDuration' });
// Writes a capture sends, by operation: change then put back; extend once.
export const EXCHANGE_EXPECTED_WRITES = Object.freeze({
  [EXCHANGE_LIVE_SETTINGS_WRITE]: 2, [EXCHANGE_LIVE_CAS_WRITE]: 2, [EXCHANGE_LIVE_RETENTION_WRITE]: 1,
});
// A capture belongs to the record it is in: no older than this before observedAt.
export const EXCHANGE_CAPTURE_WINDOW_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MODULE_VERSION_RE = /^\d+\.\d+\.\d+(\.\d+)?$/;
const DURATION_RE = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})$/;

const SECRET_KEY = /(token|secret|password|passwd|private.?key|bearer|authorization|cookie|thumbprint|certpath|keypath)/i;
const SECRET_VALUE = /^(eyJ[\w-]+\.[\w-]+\.|Bearer\s)|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

const WRITE_CMDLET = Object.freeze({ 'Set-CASMailbox': EXCHANGE_LIVE_CAS_WRITE, 'Set-Mailbox': EXCHANGE_LIVE_RETENTION_WRITE });
export const EXCHANGE_SUPPORTED_FIELDS = Object.freeze({
  mailboxSettings: MAILBOX_SETTING_FIELDS, clientAccess: CLIENT_ACCESS_FIELDS, retention: RETENTION_FIELDS, organization: ORGANIZATION_FIELDS,
});

export function exchangeReadDescriptor(id) {
  return WORKLOAD_DESCRIPTORS.find((descriptor) => descriptor.id === id) ?? null;
}

/** The version a read or write is bound to: its Graph version, or the module version. */
export function exchangeOperationVersion(id, moduleVersion) {
  const read = exchangeReadDescriptor(id);
  if (read) return read.operation.kind === 'graph' ? read.operation.version : moduleVersion ?? null;
  const write = WORKLOAD_WRITE_OPERATIONS[id];
  if (!write) return null;
  return write.kind === 'cmdlet' ? moduleVersion ?? null : write.version;
}

/** Deleted item retention ("d.hh:mm:ss") in milliseconds, or null when unreadable. */
export function exchangeDurationMs(value) {
  const match = typeof value === 'string' ? DURATION_RE.exec(value) : null;
  if (!match) return null;
  const [, days = '0', hours, minutes, seconds] = match;
  if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) return null;
  return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

/** The "d.hh:mm:ss" form Exchange answers with. */
export function exchangeDurationText(ms) {
  const total = Math.floor(ms / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const days = Math.floor(total / 86400);
  return `${days}.${pad(Math.floor((total % 86400) / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function exchangeCanonical(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(exchangeCanonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${exchangeCanonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** The fingerprint of one observation group: only the fields KEEL keeps, never content. */
export function exchangeGroupFingerprint(body, fields) {
  if (!body || typeof body !== 'object') return null;
  return createHash('sha256').update(exchangeCanonical(Object.fromEntries(fields.map((field) => [field, body[field] ?? null])))).digest('hex');
}

/** The documentation every qualified Exchange operation was declared from. */
export function exchangeRequiredDocumentation() {
  const urls = EXCHANGE_LIVE_READS.map((id) => exchangeReadDescriptor(id)?.source?.url);
  for (const id of EXCHANGE_LIVE_WRITES) urls.push(WORKLOAD_WRITE_OPERATIONS[id]?.source);
  return [...new Set(urls.filter(Boolean))];
}

/** The permissions and roles each credential must hold, from the production declarations. */
export function exchangeRequiredGrants() {
  const collect = (ids, lookup) => {
    const permissions = new Set();
    const roles = new Set();
    for (const id of ids) {
      const rbac = lookup(id)?.rbac;
      for (const permission of rbac?.permissions ?? []) permissions.add(permission);
      for (const role of rbac?.roles ?? []) roles.add(role);
    }
    return { permissions: [...permissions].sort(), roles: [...roles].sort() };
  };
  return {
    collector: collect(EXCHANGE_LIVE_READS, exchangeReadDescriptor),
    restorer: collect(EXCHANGE_LIVE_WRITES, (id) => WORKLOAD_WRITE_OPERATIONS[id]),
  };
}

/** Permissions only a writer needs. The collector must hold none of them. */
export function exchangeWriteOnlyPermissions() {
  const { collector, restorer } = exchangeRequiredGrants();
  return restorer.permissions.filter((permission) => !collector.permissions.includes(permission));
}

/** Every key path in the record whose name or value looks like credential material. */
export function exchangeSecretProblems(value, path = '$') {
  const problems = [];
  if (Array.isArray(value)) value.forEach((item, index) => problems.push(...exchangeSecretProblems(item, `${path}[${index}]`)));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) problems.push(`${path}.${key} looks like credential material`);
      problems.push(...exchangeSecretProblems(child, `${path}.${key}`));
    }
  } else if (typeof value === 'string' && SECRET_VALUE.test(value)) problems.push(`${path} holds credential material`);
  return problems;
}

/** True for a disposable fixture identity: keel-rt-*, a UPN, nothing else. */
export function exchangeIsFixtureIdentity(identity) {
  return typeof identity === 'string' && identity.toLowerCase().startsWith(EXCHANGE_FIXTURE_PREFIX) && /^[^\s@/]+@[^\s@/]+$/.test(identity);
}

function exchangeCaptureTimeProblems(label, capturedAt, observedAt) {
  const at = Date.parse(capturedAt ?? '');
  if (Number.isNaN(at)) return [`${label}: no valid capture time`];
  if (Number.isNaN(observedAt)) return [];
  if (at > observedAt + CLOCK_SKEW_MS) return [`${label}: captured after the record was observed`];
  if (observedAt - at > EXCHANGE_CAPTURE_WINDOW_MS) return [`${label}: captured more than 24h before the record (stale capture)`];
  return [];
}

function exchangeMissing(held, needed) {
  const have = new Set(Array.isArray(held) ? held : []);
  return needed.filter((item) => !have.has(item));
}

const sameIdentity = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

function exchangeGraphRequestProblems(label, request, { identity, counts }) {
  const failures = [];
  if (typeof request.path !== 'string' || !request.path.startsWith('/')) return [`${label}: no Graph path`];
  if (request.version !== 'v1.0') failures.push(`${label}: not the declared API version`);
  try {
    assertExchangeRequest(`https://graph.microsoft.com/${request.version}${request.path}`, request.method);
  } catch (error) {
    return [...failures, `${label}: content call or undeclared shape: ${error.message}`];
  }
  const match = /^\/users\/(.+)\/mailboxSettings$/.exec(decodeURIComponent(request.path));
  if (!match || !sameIdentity(match[1], identity)) failures.push(`${label}: addresses a mailbox other than the keel-rt fixture`);
  if (request.method === 'GET') {
    const scope = scopeProblems({ kind: 'graph', method: 'GET', endpoint: request.path });
    if (scope.length) failures.push(`${label}: content call: ${scope.join('; ')}`);
    return failures;
  }
  if (request.credential !== 'restorer') return [...failures, `${label}: not an allowed write (only the restorer writes the fixture mailbox)`];
  // A throttled write was not applied; Retry-After resends it, so it is not counted.
  if (request.status !== 429 && request.status !== 503) counts[EXCHANGE_LIVE_SETTINGS_WRITE] += 1;
  return failures;
}

function exchangeCmdletRequestProblems(label, request, { identity, probeIdentity, counts, retentionStart }) {
  const failures = [];
  const parameters = request.parameters && typeof request.parameters === 'object' && !Array.isArray(request.parameters) ? request.parameters : null;
  if (!parameters) return [`${label}: parameters not recorded as data`];
  try {
    assertExchangeCmdlet({ cmdlet: request.cmdlet, parameters });
  } catch (error) {
    return [`${label}: content call or undeclared cmdlet: ${error.message}`];
  }
  if (request.cmdlet === 'Set-OrganizationConfig') {
    return [`${label}: an organization-wide write is not part of this capture; it is an open operator decision`];
  }
  if (request.cmdlet === 'Get-OrganizationConfig') {
    if (request.credential !== 'collector') failures.push(`${label}: only the collector reads the organization`);
    return failures;
  }
  const target = parameters.Identity;
  const probe = request.cmdlet === 'Get-Mailbox' && probeIdentity && sameIdentity(target, probeIdentity);
  if (probe) {
    if (request.outcome === 'ok') failures.push(`${label}: the platform-error probe identity answered; it must not exist`);
    return failures;
  }
  if (!sameIdentity(target, identity)) failures.push(`${label}: addresses a mailbox other than the keel-rt fixture`);
  if (request.cmdlet.startsWith('Get-')) return failures;
  if (request.credential !== 'restorer') return [...failures, `${label}: not an allowed write (only the restorer writes the fixture mailbox)`];
  const writeId = WRITE_CMDLET[request.cmdlet];
  counts[writeId] += 1;
  const names = Object.keys(parameters).filter((name) => name !== 'Identity');
  if (request.cmdlet === 'Set-CASMailbox' && (names.length !== 1 || names[0] !== EXCHANGE_CAS_TOGGLE)) {
    failures.push(`${label}: changes more than the ${EXCHANGE_CAS_TOGGLE} switch`);
  }
  if (request.cmdlet === 'Set-Mailbox') {
    for (const name of names.filter((field) => EXCHANGE_HOLD_WRITE_FIELDS.includes(field))) {
      failures.push(`${label}: writes ${name}; a capture never releases or changes a hold`);
    }
    if (names.some((name) => name !== EXCHANGE_RETENTION_PROPERTY)) failures.push(`${label}: changes more than ${EXCHANGE_RETENTION_PROPERTY}`);
    if (names.includes(EXCHANGE_RETENTION_PROPERTY)) {
      const to = exchangeDurationMs(parameters[EXCHANGE_RETENTION_PROPERTY]);
      if (to === null || retentionStart === null || to <= retentionStart) failures.push(`${label}: shortens or does not extend deleted item retention`);
      else if (to > EXCHANGE_MAX_RETENTION_MS) failures.push(`${label}: sets retention beyond the 30-day ceiling`);
    }
  }
  return failures;
}

function exchangeRequestProblems(requests, context) {
  if (!Array.isArray(requests) || requests.length === 0) return ['no request log recorded'];
  if (!context.identity) return ['no fixture mailbox to check the request log against'];
  const failures = [];
  const counts = Object.fromEntries(EXCHANGE_LIVE_WRITES.map((id) => [id, 0]));
  for (const [index, request] of requests.entries()) {
    const label = `request ${index} (${request?.transport ?? '?'} ${request?.method ?? request?.cmdlet ?? '?'} ${request?.path ?? ''})`.replace(/ \)$/, ')');
    if (!['collector', 'restorer'].includes(request?.credential)) { failures.push(`${label}: unknown credential`); continue; }
    if (request.transport === 'graph') failures.push(...exchangeGraphRequestProblems(label, request, { ...context, counts }));
    else if (request.transport === EXCHANGE_TRANSPORT) failures.push(...exchangeCmdletRequestProblems(label, request, { ...context, counts }));
    else failures.push(`${label}: not the Graph or bounded cmdlet transport`);
  }
  for (const [id, expected] of Object.entries(EXCHANGE_EXPECTED_WRITES)) {
    if (counts[id] !== expected) failures.push(`expected exactly ${expected} ${id} write(s), found ${counts[id]}`);
  }
  return failures;
}

function exchangeWriteCaptureProblems(capture, id, { observedAt, moduleVersion }) {
  const failures = [];
  if (!capture || capture.operationId !== id) return [`missing prerequisite: no live capture of ${id}`];
  if (capture.synthetic !== false) failures.push(`${id}: synthetic or unlabelled capture`);
  const version = exchangeOperationVersion(id, moduleVersion);
  if (capture.version !== version) failures.push(`${id}: captured at ${capture.version ?? 'unknown'}, not ${version ?? 'a recorded module version'}`);
  if (capture.ok !== true) failures.push(`${id}: the write failed`);
  if (capture.readBackVerified !== true) failures.push(`${id}: the change was not read back as written`);
  failures.push(...exchangeCaptureTimeProblems(id, capture.capturedAt, observedAt));
  return failures;
}

function exchangeRoundTripProblems(capture, id, property) {
  if (!capture || capture.operationId !== id) return [];
  const failures = [];
  if (capture.writeMode !== 'reversible-change') failures.push(`${id}: a same-value write does not prove the platform applies a change`);
  if (capture.property !== property) failures.push(`${id}: ${capture.property ?? 'no property'} is not the qualified ${property} change`);
  if (capture.restoredToOriginal !== true) failures.push(`${id}: the setting was not put back`);
  if (typeof capture.preFingerprint !== 'string' || capture.preFingerprint !== capture.finalFingerprint) {
    failures.push(`${id}: the final configuration does not match the starting configuration`);
  }
  return failures;
}

/** Retention may only be extended: never shortened, and no hold field may move. */
function exchangeRetentionProblems(capture) {
  if (!capture || capture.operationId !== EXCHANGE_LIVE_RETENTION_WRITE) return [];
  const id = EXCHANGE_LIVE_RETENTION_WRITE;
  const failures = [];
  if (capture.writeMode !== 'extend-only') failures.push(`${id}: retention is qualified only by an extend-only write (a put-back would shorten it)`);
  if (capture.property !== EXCHANGE_RETENTION_PROPERTY) failures.push(`${id}: only ${EXCHANGE_RETENTION_PROPERTY} may be written`);
  const before = capture.before ?? {};
  const after = capture.after ?? {};
  const from = exchangeDurationMs(before[EXCHANGE_RETENTION_PROPERTY]);
  const to = exchangeDurationMs(after[EXCHANGE_RETENTION_PROPERTY]);
  if (from === null || to === null) failures.push(`${id}: retention before and after not recorded`);
  else if (to <= from) failures.push(`${id}: retention was shortened or not extended`);
  else if (to > EXCHANGE_MAX_RETENTION_MS) failures.push(`${id}: retention beyond the 30-day ceiling`);
  for (const field of EXCHANGE_HOLD_WRITE_FIELDS) {
    if (typeof before[field] !== 'boolean' || before[field] !== after[field]) failures.push(`${id}: ${field} changed or was not recorded; a hold is never released or changed`);
  }
  if (typeof capture.complianceHoldsFingerprint !== 'string' || capture.complianceHoldsFingerprint !== capture.finalComplianceHoldsFingerprint) {
    failures.push(`${id}: the holds Purview owns changed during the capture`);
  }
  return failures;
}

function exchangeRefusalProblems(subject) {
  const failures = [];
  const refusal = subject.refusals?.heldField;
  if (refusal?.cmdlet !== EXCHANGE_REFUSAL_PROBE.cmdlet || refusal?.parameter !== EXCHANGE_REFUSAL_PROBE.parameter
      || refusal?.refused !== true || refusal?.sent !== false) {
    failures.push(`unsupported held field not shown refused: ${EXCHANGE_REFUSAL_PROBE.cmdlet} -${EXCHANGE_REFUSAL_PROBE.parameter} must be refused before anything is sent`);
  }
  const content = subject.refusals?.contentPath;
  if (content?.refused !== true || content?.sent !== false) failures.push('a content path was not shown refused before sending');
  const platform = subject.platformError;
  if (!platform || !exchangeIsFixtureIdentity(platform.identity)) failures.push('platform error not captured: no absent keel-rt-* probe identity');
  else {
    if (platform.status !== 'failed' && platform.status !== 'denied') failures.push('platform error: the probe was recorded as a success, not a structured failure');
    if (platform.error?.code !== 'CMDLET_ERROR' || typeof platform.error?.errorId !== 'string' || !platform.error.errorId
        || typeof platform.error?.message !== 'string' || !platform.error.message) {
      failures.push('platform error: the cmdlet error was not preserved with its code, errorId and message');
    }
  }
  return failures;
}

/**
 * The task-121 Teams record this one depends on. It must verify by itself, with
 * --require-live, for the same tenant and build (and so must the task-120 SharePoint
 * record it names). `verifyEvidence` is passed in by the release verifier.
 */
function exchangeReadPrerequisiteRecord(name, evidenceDir) {
  try {
    return JSON.parse(readFileSync(join(evidenceDir ?? process.cwd(), name), 'utf8'));
  } catch {
    return null;
  }
}

function exchangeTeamsPrerequisite(reference, { tenantRef, build, now, maxAgeHours, hmacKey, evidenceDir, trustedRunners, verifyEvidence }) {
  if (!reference || typeof reference !== 'object') return { failures: ['missing prerequisite: no task-121 Teams qualification record named'], record: null };
  if (reference.gate !== TEAMS_LIVE_GATE) return { failures: [`missing prerequisite: the named prerequisite is '${reference.gate ?? 'missing'}', not ${TEAMS_LIVE_GATE}`], record: null };
  if (typeof reference.evidence !== 'string' || !/^[\w.-]+\.json$/.test(reference.evidence)) {
    return { failures: ['missing prerequisite: the Teams record must be named as a file beside this one'], record: null };
  }
  if (typeof verifyEvidence !== 'function') return { failures: ['missing prerequisite: the Teams record cannot be verified here'], record: null };
  const record = exchangeReadPrerequisiteRecord(reference.evidence, evidenceDir);
  if (!record) return { failures: [`missing prerequisite: Teams record ${reference.evidence} is absent or unreadable`], record: null };
  const result = verifyEvidence(record, {
    gate: TEAMS_LIVE_GATE, tenantRef, build, requireLive: true, now, maxAgeHours, hmacKey, evidenceDir, trustedRunners,
  });
  const failures = result.ok ? [] : [`missing prerequisite: Teams record does not verify: ${result.failures.join('; ')}`];
  if (record.subject?.captureLogSha256 !== reference.captureLogSha256) {
    failures.push('missing prerequisite: the Teams record is not the one this capture named');
  }
  return { failures, record };
}

/**
 * Gate validator for the task-122 record. Returns failure reasons; empty means the
 * subject holds. `runner` is the release verifier's runner-proof result.
 */
export function validateExchangeLiveSubject(evidence, context = {}) {
  const { tenantRef, build, artifact, runner } = context;
  const failures = [];
  if (evidence.status === 'pending') return ['Exchange live evidence pending: no record has been captured'];
  // Both proofs: the runner signature over the record and the digest of its raw log.
  if (!runner?.ok) failures.push(`Exchange runner proof required (${runner?.reason ?? 'not checked'})`);
  if (!artifact?.ok) failures.push(`Exchange capture artifact required (${artifact?.reason ?? 'not checked'})`);
  if (evidence.evidenceLevel === 'live-qualified' && (evidence.synthetic !== false || runner?.synthetic)) {
    failures.push('Exchange fixture evidence cannot claim live qualification');
  }
  if (!tenantRef || !build) failures.push('Exchange expected tenant/build identity required');
  if (build && evidence.build !== build) failures.push(`Exchange build mismatch: evidence is '${evidence.build}', required '${build}'`);
  if (evidence.operation !== EXCHANGE_LIVE_OPERATION) {
    failures.push(`Exchange operation mismatch: expected '${EXCHANGE_LIVE_OPERATION}', got '${evidence.operation ?? 'missing'}'`);
  }
  if (evidence.credentialMode !== EXCHANGE_LIVE_CREDENTIAL_MODE) failures.push(`Exchange requires credential mode '${EXCHANGE_LIVE_CREDENTIAL_MODE}'`);
  failures.push(...exchangeSecretProblems(evidence));

  const subject = evidence.subject;
  if (!subject || typeof subject !== 'object') return [...failures, 'subject is missing'];
  const observedAt = Date.parse(evidence.observedAt ?? '');

  // Prerequisites: named, declared in this build, and the Teams record verifies.
  for (const task of exchangeMissing(subject.prerequisites, EXCHANGE_LIVE_PREREQUISITES)) failures.push(`missing prerequisite: ${task}`);
  for (const id of EXCHANGE_LIVE_READS) if (!exchangeReadDescriptor(id)) failures.push(`prerequisite missing in this build: ${id} is not declared`);
  for (const id of EXCHANGE_LIVE_WRITES) if (!WORKLOAD_WRITE_OPERATIONS[id]) failures.push(`prerequisite missing in this build: ${id} is not declared`);
  const teams = exchangeTeamsPrerequisite(subject.teamsQualification, { ...context, tenantRef, build });
  failures.push(...teams.failures);
  // Teams or SharePoint proof is never Exchange proof: this record's log must be its own.
  const upstreamLogs = [subject.teamsQualification?.captureLogSha256, teams.record?.subject?.sharePointQualification?.captureLogSha256].filter(Boolean);
  if (subject.captureLogSha256 && upstreamLogs.includes(subject.captureLogSha256)) {
    failures.push('a Teams or SharePoint capture log cannot stand in for the Exchange capture');
  }

  // Argument-safe execution: every cmdlet went through the bounded job transport.
  if (subject.execution?.transport !== EXCHANGE_TRANSPORT || subject.execution?.module !== EXCHANGE_MODULE) {
    failures.push(`cmdlets must run through the bounded ${EXCHANGE_TRANSPORT} transport (${EXCHANGE_MODULE})`);
  }
  const moduleVersion = typeof subject.execution?.moduleVersion === 'string' && MODULE_VERSION_RE.test(subject.execution.moduleVersion)
    ? subject.execution.moduleVersion : null;
  if (!moduleVersion) failures.push(`no ${EXCHANGE_MODULE} module version recorded`);

  // Credentials: references only, two distinct identities, separated grants.
  const credentials = subject.credentials ?? {};
  for (const role of ['collector', 'restorer']) {
    if (typeof credentials[role] !== 'string' || !credentials[role].trim()) failures.push(`no ${role} credential reference`);
  }
  if (credentials.collector && credentials.collector === credentials.restorer) failures.push('collector and restorer must be separate credentials');
  const needed = exchangeRequiredGrants();
  for (const role of ['collector', 'restorer']) {
    const held = subject.grants?.[role];
    for (const permission of exchangeMissing(held?.permissions, needed[role].permissions)) failures.push(`missing prerequisite: ${role} lacks ${permission}`);
    for (const adminRole of exchangeMissing(held?.roles, needed[role].roles)) failures.push(`missing prerequisite: ${role} lacks role ${adminRole}`);
  }
  const writeOnly = new Set(exchangeWriteOnlyPermissions());
  if ((subject.grants?.collector?.permissions ?? []).some((permission) => writeOnly.has(permission))) {
    failures.push('the collector holds a write permission; read and write credentials are not separated');
  }

  // The disposable fixture mailbox, in the managed tenant.
  const directoryTenantId = typeof subject.directoryTenantId === 'string' ? subject.directoryTenantId.toLowerCase() : null;
  if (!directoryTenantId || !GUID_RE.test(directoryTenantId)) failures.push('no managed directory tenant id');
  if (directoryTenantId && String(subject.organization?.externalDirectoryOrganizationId ?? '').toLowerCase() !== directoryTenantId) {
    failures.push('the Exchange organization belongs to another tenant');
  }
  const mailbox = subject.fixtureMailbox ?? {};
  const identity = exchangeIsFixtureIdentity(mailbox.identity) ? mailbox.identity : null;
  if (!identity) failures.push(`the fixture mailbox is not a disposable ${EXCHANGE_FIXTURE_PREFIX}* mailbox`);
  if (!sameIdentity(mailbox.userPrincipalName, mailbox.identity)) failures.push('the fixture mailbox did not answer as the identity named');
  if (mailbox.recipientTypeDetails !== 'UserMailbox') failures.push('the fixture is not a user mailbox');
  if (typeof mailbox.objectId !== 'string' || !GUID_RE.test(mailbox.objectId)) failures.push('the fixture mailbox has no directory object id');

  // Reads: one successful, non-synthetic capture per operation, at the version in use.
  const reads = Array.isArray(subject.reads) ? subject.reads : [];
  for (const id of EXCHANGE_LIVE_READS) {
    const capture = reads.find((item) => item?.operationId === id);
    if (!capture) { failures.push(`missing prerequisite: no live capture of ${id}`); continue; }
    if (capture.synthetic !== false) failures.push(`${id}: synthetic or unlabelled capture`);
    if (capture.ok !== true) failures.push(`${id}: the read failed`);
    const version = exchangeOperationVersion(id, moduleVersion);
    if (capture.version !== version) failures.push(`${id}: captured at ${capture.version ?? 'unknown'}, not ${version ?? 'a recorded module version'}`);
    failures.push(...exchangeCaptureTimeProblems(id, capture.capturedAt, observedAt));
  }
  for (const [group, fields] of Object.entries(EXCHANGE_SUPPORTED_FIELDS)) {
    for (const field of exchangeMissing(subject.supportedFields?.[group], fields)) failures.push(`supported field not observed live: ${group}.${field}`);
  }

  // Writes: each its own capture; the two reversible ones end where they started,
  // and retention is only ever extended.
  const writes = subject.writes ?? {};
  const byId = {
    [EXCHANGE_LIVE_SETTINGS_WRITE]: writes.mailboxSettings, [EXCHANGE_LIVE_CAS_WRITE]: writes.clientAccess, [EXCHANGE_LIVE_RETENTION_WRITE]: writes.retention,
  };
  for (const id of EXCHANGE_LIVE_WRITES) failures.push(...exchangeWriteCaptureProblems(byId[id], id, { observedAt, moduleVersion }));
  failures.push(...exchangeRoundTripProblems(writes.mailboxSettings, EXCHANGE_LIVE_SETTINGS_WRITE, EXCHANGE_SETTINGS_TOGGLE));
  failures.push(...exchangeRoundTripProblems(writes.clientAccess, EXCHANGE_LIVE_CAS_WRITE, EXCHANGE_CAS_TOGGLE));
  failures.push(...exchangeRetentionProblems(writes.retention));
  for (const id of EXCHANGE_LIVE_EXCLUDED_WRITES) {
    if (Object.values(writes).some((capture) => capture?.operationId === id)) failures.push(`${id} is not part of this capture; it is an open operator decision`);
  }

  // Unsupported held/locked fields refused, platform errors preserved.
  failures.push(...exchangeRefusalProblems(subject));

  // The raw capture log is bound into the signed subject.
  if (typeof subject.captureLogSha256 !== 'string' || !SHA256_RE.test(subject.captureLogSha256)
      || subject.captureLogSha256 !== evidence.proof?.artifact?.sha256) {
    failures.push('the capture log digest is not bound to the signed subject');
  }

  // Zero content calls, fixture-only addressing and the hold guard, re-derived from the log.
  failures.push(...exchangeRequestProblems(subject.requests, {
    identity, probeIdentity: subject.platformError?.identity ?? null,
    retentionStart: exchangeDurationMs(writes.retention?.before?.[EXCHANGE_RETENTION_PROPERTY]),
  }));

  const throttle = subject.throttle;
  if (!throttle || !Number.isInteger(throttle.retryAfterResponses) || throttle.retryAfterResponses < 0) {
    failures.push('throttle behaviour not recorded');
  }

  const docs = Array.isArray(subject.documentation) ? subject.documentation : [];
  for (const url of exchangeRequiredDocumentation()) {
    const entry = docs.find((item) => item?.url === url);
    if (!entry || Number.isNaN(Date.parse(entry.retrievedAt ?? ''))) failures.push(`documentation not retrieved: ${url}`);
  }
  return failures;
}
