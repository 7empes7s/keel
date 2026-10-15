/**
 * Wave 2 WKLD live gate: the record a live write capture of the cmdlet writers leaves
 * (workloadWritesLive.mjs), and the check every such record must pass.
 *
 * One record per written workload (mail flow, Exchange settings, Teams org-wide
 * policies, Teams voice and live event policies, Purview retention and DLP, Purview
 * retention labels). Within it, each writer family that has a KEEL-RT- fixture holds
 * one write capture: a harmless setting moved, read back, and put back.
 *
 * What a capture may change, decided here so the capture and the check agree:
 *  - only an object whose name starts with KEEL-RT- (the prefix, never an exact name);
 *  - a text field from CAPTURE_TEXT_FIELDS (a comment or description), or, on a
 *    policy (never a rule, which acts on real mail), a switch;
 *  - only a change the WKLD content-effect classifier finds nothing in, both ways.
 * Nothing else is ever chosen, so no capture can shorten retention, release a hold or
 * widen who sees content.
 */
import { WKLD_WRITE_OPERATIONS } from '../../engine/restore/workloads/writeDeclarations.mjs';
import { classifyWorkloadEffects, WORKLOAD_EFFECT_RULES } from '../../engine/restore/workloads/cmdletSettings.mjs';
import { exchangeSecretProblems } from './exchangeAcceptance.mjs';

export const WORKLOAD_WRITES_LIVE_GATE = 'workload-writers-live-acceptance';
export const WORKLOAD_WRITES_LIVE_OPERATION = 'workload.writer-qualification';
export const WORKLOAD_WRITES_CREDENTIAL_MODE = 'collector-read+restorer-write';
export const WORKLOAD_WRITES_TRANSPORT = 'powershell-cmdlet-job';
export const WORKLOAD_FIXTURE_PREFIX = 'KEEL-RT-';
// The text fields a capture writes, in order of preference.
export const CAPTURE_TEXT_FIELDS = Object.freeze(['Comments', 'Comment', 'Description', 'AdminDisplayName', 'Notes']);
// A policy re-created by an add capture is named this, plus a random suffix.
export const CAPTURE_CREATE_PREFIX = `${WORKLOAD_FIXTURE_PREFIX}capture-`;

const MODULE_VERSION_RE = /^\d+\.\d+\.\d+(\.\d+)?$/;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A capture belongs to the record it is in: no older than this before observedAt.
const CAPTURE_WINDOW_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const LABELS = Object.freeze({
  'exchange-mail-flow': 'Mail flow',
  'exchange-extended': 'Exchange settings',
  'teams-org-policies': 'Teams org-wide policies',
  'teams-voice-policies': 'Teams voice and live event policies',
  'purview-retention-dlp': 'Purview retention and DLP',
  'purview-governance': 'Purview retention labels',
});

/** Each written workload: its label, module, and the write operations it declares. */
export const WRITTEN_WORKLOADS = Object.freeze(Object.fromEntries(Object.keys(LABELS).map((workload) => {
  const operations = Object.keys(WKLD_WRITE_OPERATIONS).filter((id) => WKLD_WRITE_OPERATIONS[id].workload === workload);
  const modules = [...new Set(operations.map((id) => WKLD_WRITE_OPERATIONS[id].module))];
  if (operations.length === 0 || modules.length !== 1) throw new Error(`${workload}: expected declared writes in one module`);
  return [workload, Object.freeze({ label: LABELS[workload], module: modules[0], operations: Object.freeze(operations) })];
})));

/** The record file for one workload, beside the other live acceptance records. */
export const workloadWritesRecordFile = (workload) => `workload-writers-${workload}-live-acceptance.json`;

/** True for a KEEL-RT- name. The prefix decides; no exact fixture name is ever checked. */
export function isFixtureName(name) {
  return typeof name === 'string' && name.toUpperCase().startsWith(WORKLOAD_FIXTURE_PREFIX);
}

/** The name an object is known by: a Teams policy's tag name, else its Name. */
export function fixtureNameOf(resource) {
  const identity = resource?.fields?.Identity;
  if (typeof identity === 'string' && /^tag:/i.test(identity)) return identity.slice(4);
  return typeof resource?.fields?.Name === 'string' ? resource.fields.Name : null;
}

const empty = (value) => value === null || value === undefined || value === '';
/** Equal as a capture compares them: an empty text and no value are the same. */
export const sameValue = (a, b) => (empty(a) && empty(b)) || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function effectsOf(write, from, to) {
  return classifyWorkloadEffects([{ naturalKey: 'capture', resourceType: write.resourceType, verb: 'update', payload: to, live: { state: 'present', payload: from } }]);
}

/**
 * Text fields first, then (on a policy only) switches. A field with an effect rule is
 * never a candidate: some rules depend on other fields of the object (an inbound
 * connector's Enabled while ScanAndDropRecipients is set), which the check cannot see.
 */
function candidateFields(write) {
  const ruled = new Set((WORKLOAD_EFFECT_RULES[write.resourceType] ?? []).map((entry) => entry.field));
  const text = CAPTURE_TEXT_FIELDS.filter((field) => write.fields.includes(field) && !ruled.has(field));
  const switches = /Rule$/.test(write.resourceType) ? [] : write.fields.filter((field) => !text.includes(field) && !ruled.has(field));
  return [...text.map((field) => ({ field, type: 'text' })), ...switches.map((field) => ({ field, type: 'switch' }))];
}

/** Whether a capture may write `field` of this write at all (the check's view, without the object). */
export function captureFieldAllowed(write, field, type) {
  return candidateFields(write).some((candidate) => candidate.field === field && candidate.type === type);
}

/**
 * The one change a capture makes to `resource` for `write`: { field, type, before,
 * after }, or { reason } when nothing on it can be changed harmlessly. `marker` is
 * the text written to a text field.
 */
export function chooseCaptureChange(write, resource, { marker }) {
  const fields = resource?.fields ?? {};
  for (const { field, type } of candidateFields(write)) {
    if (resource?.fieldCoverage?.[field]?.status !== 'observed') continue;
    const before = fields[field] ?? null;
    let after;
    if (type === 'text') {
      if (!(before === null || typeof before === 'string')) continue;
      after = before === marker ? `${marker} (again)` : marker;
    } else {
      if (typeof before !== 'boolean') continue;
      after = !before;
    }
    const to = { ...fields, [field]: after };
    if (effectsOf(write, fields, to).length || effectsOf(write, to, fields).length) continue;
    return { field, type, before, after };
  }
  return { reason: 'no comment, description or harmless switch on it can be changed without a content effect' };
}

const declaredFor = (workload) => WRITTEN_WORKLOADS[workload]?.operations ?? [];

function timeProblems(label, capturedAt, observedAt) {
  const at = Date.parse(capturedAt ?? '');
  if (Number.isNaN(at)) return [`${label}: no capture time`];
  if (Number.isNaN(observedAt)) return [];
  if (at > observedAt + CLOCK_SKEW_MS) return [`${label}: captured after the record was observed`];
  if (observedAt - at > CAPTURE_WINDOW_MS) return [`${label}: captured more than 24h before the record (stale capture)`];
  return [];
}

/** Whether `capture.identity` (what was sent as -Identity) can only be the recorded fixture. */
function identityNamesFixture(write, kind, capture) {
  const identity = capture.identity;
  if (typeof identity !== 'string' || !identity || typeof capture.fixture !== 'string') return false;
  if (kind === 'add' || write.identity === 'name') return identity === capture.fixture;
  if (write.identity === 'policy') return identity.toLowerCase() === `tag:${capture.fixture.toLowerCase()}`;
  return GUID_RE.test(identity);
}

/** Whether a write request is one a capture made: its cmdlet, its object, its one field, its value or the put-back. */
function requestFits(capture, request) {
  const parameters = request?.parameters;
  if (request?.cmdlet !== capture?.method || !parameters || typeof parameters !== 'object') return false;
  const keys = Object.keys(parameters).sort();
  if (capture.field === 'Identity' || keys.length !== 2 || keys.join() !== ['Identity', capture.field].sort().join()) return false;
  if (parameters.Identity !== capture.identity) return false;
  const value = parameters[capture.field];
  if (capture.kind === 'add') return value === capture.target;
  return sameValue(value, capture.target) || sameValue(value, capture.before);
}

/**
 * What makes one write capture unacceptable in a record: a write that is not declared,
 * not on a fixture, not a harmless field, or not of this record. Any of these fails
 * the whole record.
 */
function structuralProblems(capture, { workload, moduleVersion, observedAt }) {
  const id = capture?.operationId;
  const write = WKLD_WRITE_OPERATIONS[id];
  if (!write || write.workload !== workload) return [`${id ?? 'a write'}: not a declared ${workload} write in this build`];
  const problems = [];
  const kind = id.endsWith('.add') ? 'add' : 'update';
  if (capture.kind !== kind) problems.push(`${id}: recorded as ${capture.kind ?? 'unlabelled'}, declared as ${kind}`);
  if (capture.method !== write.method) problems.push(`${id}: sent ${capture.method ?? 'nothing'}, declared ${write.method}`);
  if (capture.synthetic !== false) problems.push(`${id}: a synthetic capture is never live proof`);
  if (capture.version !== moduleVersion) problems.push(`${id}: captured at ${capture.version ?? 'an unknown version'}, the record says ${moduleVersion}`);
  if (!isFixtureName(capture.fixture)) problems.push(`${id}: the object written is not a ${WORKLOAD_FIXTURE_PREFIX} fixture`);
  if (kind === 'add' && !String(capture.fixture ?? '').toUpperCase().startsWith(CAPTURE_CREATE_PREFIX.toUpperCase())) {
    problems.push(`${id}: a created policy must be named ${CAPTURE_CREATE_PREFIX}*`);
  }
  if (!identityNamesFixture(write, kind, capture)) problems.push(`${id}: the object named to ${write.method} is not the ${WORKLOAD_FIXTURE_PREFIX} fixture recorded`);
  if (!write.fields.includes(capture.field) || !captureFieldAllowed(write, capture.field, capture.type)) {
    problems.push(`${id}: ${capture.field ?? 'no field'} is not a field a capture may write`);
  } else if (capture.type === 'switch' && (typeof capture.before !== 'boolean' || capture.target !== !capture.before)) {
    problems.push(`${id}: a switch capture must flip a true/false value`);
  } else if (capture.type === 'text' && (typeof capture.target !== 'string' || !(capture.before === null || capture.before === undefined || typeof capture.before === 'string'))) {
    problems.push(`${id}: a text capture must write text over text`);
  } else if (kind === 'update') {
    const from = { [capture.field]: capture.before ?? null };
    const to = { [capture.field]: capture.target ?? null };
    if (effectsOf(write, from, to).length || effectsOf(write, to, from).length) problems.push(`${id}: the change has a content effect`);
  }
  if (!Array.isArray(capture.contentEffects) || capture.contentEffects.length) problems.push(`${id}: the capture recorded a content effect`);
  problems.push(...timeProblems(id, capture.capturedAt, observedAt));
  return problems;
}

/**
 * Why an acceptable capture is still not proof: the write failed, was not read back,
 * or was not put back. Such a capture stays in the record as a result; it proves nothing.
 */
export function outcomeProblems(capture) {
  const id = capture?.operationId;
  const problems = [];
  if (capture?.ok !== true) problems.push(`${id}: the write failed${capture?.error ? ` (${capture.error})` : ''}`);
  if (capture?.readBackVerified !== true) problems.push(`${id}: the write was not read back`);
  if (!String(id).endsWith('.add') && capture?.restoredToOriginal !== true) problems.push(`${id}: the setting was not put back`);
  return problems;
}

/** The writes of a verified record that count as proof. */
export function provenWrites(subject) {
  return (Array.isArray(subject?.writes) ? subject.writes : []).filter((capture) => outcomeProblems(capture).length === 0);
}

/** Gate validator for a WKLD writer live capture record. */
export function validateWorkloadWritesLiveSubject(evidence, context = {}) {
  const { tenantRef, build, artifact, runner } = context;
  const failures = [];
  if (!runner?.ok) failures.push(`writer capture runner proof required (${runner?.reason ?? 'not checked'})`);
  if (!artifact?.ok) failures.push(`writer capture log required (${artifact?.reason ?? 'not checked'})`);
  if (evidence.evidenceLevel === 'live-qualified' && (evidence.synthetic !== false || runner?.synthetic)) {
    failures.push('fixture evidence cannot claim live qualification');
  }
  if (!tenantRef || !build) failures.push('writer capture expected tenant/build identity required');
  if (build && evidence.build !== build) failures.push(`build mismatch: evidence is '${evidence.build}', required '${build}'`);
  if (evidence.operation !== WORKLOAD_WRITES_LIVE_OPERATION) failures.push(`operation mismatch: expected '${WORKLOAD_WRITES_LIVE_OPERATION}'`);
  if (evidence.credentialMode !== WORKLOAD_WRITES_CREDENTIAL_MODE) failures.push(`credential mode must be '${WORKLOAD_WRITES_CREDENTIAL_MODE}'`);
  failures.push(...exchangeSecretProblems(evidence));

  const subject = evidence.subject;
  if (!subject || typeof subject !== 'object') return [...failures, 'subject is missing'];
  const workload = subject.workload;
  const declared = WRITTEN_WORKLOADS[workload];
  if (!declared) return [...failures, `unknown written workload '${workload ?? 'missing'}'`];

  const execution = subject.execution ?? {};
  if (execution.transport !== WORKLOAD_WRITES_TRANSPORT || execution.module !== declared.module) {
    failures.push(`cmdlets must run through the bounded ${WORKLOAD_WRITES_TRANSPORT} transport (${declared.module})`);
  }
  const moduleVersion = typeof execution.moduleVersion === 'string' && MODULE_VERSION_RE.test(execution.moduleVersion) ? execution.moduleVersion : null;
  if (!moduleVersion) failures.push(`no ${declared.module} module version recorded`);

  const credentials = subject.credentials ?? {};
  for (const role of ['collector', 'restorer']) {
    if (typeof credentials[role] !== 'string' || !credentials[role].trim()) failures.push(`no ${role} credential reference`);
  }
  if (credentials.collector && credentials.collector === credentials.restorer) failures.push('collector and restorer must be separate credentials');
  const held = subject.grants?.restorer;
  for (const id of declared.operations) {
    const { rbac } = WKLD_WRITE_OPERATIONS[id];
    for (const permission of rbac.permissions) if (!held?.permissions?.includes(permission)) failures.push(`the restorer lacks ${permission}`);
    for (const role of rbac.roles) if (!held?.roles?.includes(role)) failures.push(`the restorer lacks role ${role}`);
  }

  // Every write sent: a declared Set-/New- of this workload, by the restorer. Reads: the workload's collector.
  const methods = new Set(declared.operations.map((id) => WKLD_WRITE_OPERATIONS[id].method));
  for (const request of Array.isArray(subject.requests) ? subject.requests : []) {
    if (request?.read !== undefined) {
      if (request.read !== workload) failures.push(`a read of ${request.read} is not this workload's collector`);
      if (request.credential !== 'collector') failures.push(`a read was sent with the ${request.credential} credential, not the collector`);
    } else if (!methods.has(request?.cmdlet)) failures.push(`${request?.cmdlet ?? 'an unnamed cmdlet'} is not a declared ${workload} write`);
    else if (request.credential !== 'restorer') failures.push(`${request.cmdlet} was sent with the ${request.credential} credential, not the restorer`);
  }
  if (!Array.isArray(subject.requests)) failures.push('the record lists no requests');

  // Both refusal probes must have been refused here, before anything was sent.
  const refusals = subject.refusals ?? {};
  for (const key of ['remove', 'undeclaredParameter']) {
    if (refusals[key]?.refused !== true || refusals[key]?.sent !== false) failures.push(`the ${key} probe was not refused before sending`);
  }

  const observedAt = Date.parse(evidence.observedAt ?? '');
  const writes = Array.isArray(subject.writes) ? subject.writes : [];
  const seen = new Set();
  for (const capture of writes) {
    if (seen.has(capture?.operationId)) failures.push(`${capture.operationId}: captured twice`);
    seen.add(capture?.operationId);
    failures.push(...structuralProblems(capture, { workload, moduleVersion, observedAt }));
  }
  // Every write sent belongs to a capture: one request per add, a write and its put-back per update.
  const used = new Map();
  for (const request of Array.isArray(subject.requests) ? subject.requests : []) {
    if (request?.read !== undefined) continue;
    const capture = writes.find((item) => requestFits(item, request) && (used.get(item) ?? 0) < (item.kind === 'add' ? 1 : 2));
    if (!capture) failures.push(`${request?.cmdlet ?? 'a cmdlet'} on ${request?.parameters?.Identity ?? 'an unnamed object'}: no capture accounts for this write`);
    else used.set(capture, (used.get(capture) ?? 0) + 1);
  }
  if (provenWrites(subject).length === 0) failures.push('no write was captured, read back and put back: the record proves nothing');
  return failures;
}
