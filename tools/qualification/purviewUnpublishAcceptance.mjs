/**
 * Removing labels from a Purview label policy (purview.label-policy.remove-labels): the
 * live gate for that write (engine/restore/workloads/purview.mjs). A record holds one
 * capture by tools/qualification/purviewUnpublishLive.mjs on the test tenant:
 *  - one KEEL-RT- label removed from one KEEL-RT- label policy with the restorer, through
 *    the writer's own unpublish call (Set-LabelPolicy -RemoveLabels), and read back gone
 *    with the collector;
 *  - the policy put back as it started (the label published again with -AddLabels when it
 *    was published at the start), read back;
 *  - every other label and policy reads the same at the end as at the start.
 *
 * It never sends anything and never enables anything. A verified record becomes ledger
 * evidence only through purviewUnpublishLive.mjs's import seam.
 */
import { PURVIEW_MODULE } from '../../engine/collect/workloads/purview.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../../engine/coverage/qualification.mjs';
import { captureTimeProblems, secretProblems } from './sharepointAcceptance.mjs';

export const UNPUBLISH_LIVE_GATE = 'purview-label-unpublish-live-acceptance';
export const UNPUBLISH_LIVE_OPERATION = 'purview-labels.unpublish-qualification';
export const UNPUBLISH_WRITE = 'purview.label-policy.remove-labels';
export const UNPUBLISH_CREDENTIAL_MODE = 'collector-read+restorer-write';
export const UNPUBLISH_TRANSPORT = 'powershell-cmdlet-job';
export const UNPUBLISH_RECORD_FILE = `${UNPUBLISH_LIVE_GATE}.json`;
export const UNPUBLISH_FIXTURE_PREFIX = 'keel-rt-';
const MODULE_VERSION_RE = /^\d+\.\d+\.\d+(\.\d+)?$/;
const READS = new Set(['Get-Label', 'Get-LabelPolicy']);
const PROBES = Object.freeze(['ordinaryCall', 'undeclaredParameter']);

/** True for a disposable fixture name: KEEL-RT-*, any case. */
export function isUnpublishFixture(name) {
  return typeof name === 'string' && name.toLowerCase().startsWith(UNPUBLISH_FIXTURE_PREFIX) && name.length > UNPUBLISH_FIXTURE_PREFIX.length;
}

/** The writes a record proves: removed, read back gone, put back, and nothing else changed. */
export function provenUnpublishWrites(subject) {
  return (Array.isArray(subject?.writes) ? subject.writes : []).filter((capture) => capture?.ok === true && capture.readBackVerified === true
    && capture.putBack === true && capture.collateralUnchanged === true);
}

function captureProblems(capture, { moduleVersion, observedAt }) {
  const id = capture?.operationId;
  if (id !== UNPUBLISH_WRITE) return [`${id ?? 'a capture'} is not the label removal write`];
  const problems = [];
  if (capture.synthetic !== false) problems.push(`${id}: synthetic or unlabelled capture`);
  if (capture.version !== moduleVersion) problems.push(`${id}: not captured at the recorded ${PURVIEW_MODULE} version`);
  if (!isUnpublishFixture(capture.policy)) problems.push(`${id}: wrote to ${capture.policy ?? 'no named policy'}, not a KEEL-RT- policy`);
  if (!isUnpublishFixture(capture.label)) problems.push(`${id}: removed ${capture.label ?? 'no named label'}, not a KEEL-RT- label`);
  if (capture.readBackVerified !== true) problems.push(`${id}: the label was not read back gone`);
  if (capture.putBack !== true) problems.push(`${id}: the policy was not read back as it started`);
  if (capture.collateralUnchanged !== true) problems.push(`${id}: another label or policy changed, or was not checked`);
  problems.push(...captureTimeProblems(id, capture.capturedAt, observedAt));
  return problems;
}

/** The record's own request list must show the restorer's RemoveLabels of the fixture label, answered. */
function requestProblems(capture, requests) {
  const sent = requests.some((request) => request?.cmdlet === 'Set-LabelPolicy' && request.credential === 'restorer' && request.outcome === 'ok'
    && request.policy === capture.policy && request.parameters?.includes('RemoveLabels') && request.labels?.length === 1 && request.labels[0] === capture.label);
  return sent ? [] : [`${capture.operationId}: the record shows no answered Set-LabelPolicy -RemoveLabels of ${capture.label} on ${capture.policy}`];
}

/** Gate validator. Returns failure reasons; empty means the subject holds. */
export function validateUnpublishLiveSubject(evidence, context = {}) {
  const { tenantRef, build, artifact, runner } = context;
  const failures = [];
  if (!runner?.ok) failures.push(`unpublish capture runner proof required (${runner?.reason ?? 'not checked'})`);
  if (!artifact?.ok) failures.push(`unpublish capture log required (${artifact?.reason ?? 'not checked'})`);
  if (evidence.evidenceLevel === 'live-qualified' && (evidence.synthetic !== false || runner?.synthetic)) failures.push('fixture evidence cannot claim live qualification');
  if (!tenantRef || !build) failures.push('unpublish capture expected tenant/build identity required');
  if (build && evidence.build !== build) failures.push(`build mismatch: evidence is '${evidence.build}', required '${build}'`);
  if (evidence.operation !== UNPUBLISH_LIVE_OPERATION) failures.push(`operation mismatch: expected '${UNPUBLISH_LIVE_OPERATION}'`);
  if (evidence.credentialMode !== UNPUBLISH_CREDENTIAL_MODE) failures.push(`credential mode must be '${UNPUBLISH_CREDENTIAL_MODE}'`);
  failures.push(...secretProblems(evidence));
  const subject = evidence.subject;
  if (!subject || typeof subject !== 'object') return [...failures, 'subject is missing'];

  const execution = subject.execution ?? {};
  if (execution.transport !== UNPUBLISH_TRANSPORT || execution.module !== PURVIEW_MODULE) failures.push(`cmdlets must run through the bounded ${UNPUBLISH_TRANSPORT} transport (${PURVIEW_MODULE})`);
  const moduleVersion = typeof execution.moduleVersion === 'string' && MODULE_VERSION_RE.test(execution.moduleVersion) ? execution.moduleVersion : null;
  if (!moduleVersion) failures.push(`no ${PURVIEW_MODULE} module version recorded`);

  const credentials = subject.credentials ?? {};
  for (const role of ['collector', 'restorer']) {
    if (typeof credentials[role] !== 'string' || !credentials[role].trim()) failures.push(`no ${role} credential reference`);
  }
  if (credentials.collector && credentials.collector === credentials.restorer) failures.push('collector and restorer must be separate credentials');
  const { rbac } = WORKLOAD_WRITE_OPERATIONS[UNPUBLISH_WRITE];
  for (const role of rbac.roles) if (!subject.grants?.restorer?.roles?.includes(role)) failures.push(`the restorer lacks ${role}`);
  for (const permission of rbac.permissions) if (!subject.grants?.restorer?.permissions?.includes(permission)) failures.push(`the restorer lacks ${permission}`);

  const refusals = subject.refusals ?? {};
  for (const key of PROBES) {
    if (refusals[key]?.refused !== true || refusals[key]?.sent !== false) failures.push(`the ${key} probe was not refused before sending`);
  }
  const requests = Array.isArray(subject.requests) ? subject.requests : [];
  if (!Array.isArray(subject.requests)) failures.push('the record lists no requests');
  for (const request of requests) {
    const cmdlet = request?.cmdlet;
    if (cmdlet === 'Set-LabelPolicy') {
      if (request.credential !== 'restorer') failures.push(`${cmdlet} was sent with the ${request.credential} credential, not the restorer`);
      if (!isUnpublishFixture(request.policy)) failures.push(`${cmdlet} named ${request.policy ?? 'no policy'}, not a KEEL-RT- policy`);
      const labels = Array.isArray(request.labels) ? request.labels : [];
      if (labels.length !== 1 || !isUnpublishFixture(labels[0])) failures.push(`${cmdlet} named ${labels.join(', ') || 'no label'}, not exactly one KEEL-RT- label`);
      const parameters = Array.isArray(request.parameters) ? request.parameters : [];
      if (parameters.length !== 2 || !parameters.includes('Identity') || !(parameters.includes('RemoveLabels') || parameters.includes('AddLabels'))) {
        failures.push(`${cmdlet} sent ${parameters.join(', ') || 'nothing'}, not Identity with RemoveLabels or AddLabels alone`);
      }
    } else if (READS.has(cmdlet)) {
      if (!['collector', 'restorer'].includes(request.credential)) failures.push(`${cmdlet} was sent with no known credential`);
    } else failures.push(`${cmdlet ?? 'an unnamed cmdlet'} is not a cmdlet the label removal capture runs`);
  }

  const observedAt = Date.parse(evidence.observedAt ?? '');
  const writes = Array.isArray(subject.writes) ? subject.writes : [];
  const seen = new Set();
  for (const capture of writes) {
    if (seen.has(capture?.operationId)) failures.push(`${capture.operationId}: captured twice`);
    seen.add(capture?.operationId);
    if (capture?.ok === true) failures.push(...captureProblems(capture, { moduleVersion, observedAt }), ...requestProblems(capture, requests));
  }
  if (provenUnpublishWrites(subject).length === 0) failures.push('no label removal was captured, read back and put back: the record proves nothing');
  return [...new Set(failures)];
}
