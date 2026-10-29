/**
 * Custom Exchange admin role restore: the live gate for its write
 * (engine/restore/workloads/exchangeRoleDefinitions.mjs). A record holds one capture by
 * tools/qualification/exchangeRoleDefinitionsLive.mjs on the test tenant:
 *  - a KEEL-RT-capture-role- role recreated by the writer's own create-and-trim step with
 *    the restorer, from a built-in parent, with fewer cmdlets and parameters than the
 *    parent holds, so the trim is exercised;
 *  - its entries and description read back with the collector, exactly as planned;
 *  - the parent role's entries unchanged.
 *
 * It never sends a request and never enables anything. A verified record becomes ledger
 * evidence only through exchangeRoleDefinitionsLive.mjs's import seam.
 */
import { EXCHANGE_ROLE_MODULE, EXCHANGE_ROLE_WRITE_OPERATIONS, ROLE_READ_CMDLETS, ROLE_WRITE_CMDLETS } from '../../engine/restore/workloads/exchangeRoleDeclarations.mjs';
import { captureTimeProblems, secretProblems } from './sharepointAcceptance.mjs';

export const ROLE_WRITES_LIVE_GATE = 'exchange-role-definitions-writes-live-acceptance';
export const ROLE_WRITES_LIVE_OPERATION = 'exchange-role-definitions.role-writer-qualification';
export const ROLE_WRITES_CREDENTIAL_MODE = 'collector-read+restorer-write';
export const ROLE_WRITES_TRANSPORT = 'powershell-cmdlet-job';
export const ROLE_WRITES_RECORD_FILE = `${ROLE_WRITES_LIVE_GATE}.json`;
export const ROLE_CAPTURE_PREFIX = 'KEEL-RT-capture-role-';
const MODULE_VERSION_RE = /^\d+\.\d+\.\d+(\.\d+)?$/;
const WRITES = new Set(Object.keys(ROLE_WRITE_CMDLETS));
const READS = new Set(Object.keys(ROLE_READ_CMDLETS));

/** The writes a record proves: sent, read back as planned, and the parent left alone. */
export function provenRoleWrites(subject) {
  return (Array.isArray(subject?.writes) ? subject.writes : []).filter((capture) => capture?.ok === true && capture.readBackVerified === true
    && capture.collateralUnchanged === true);
}

function captureProblems(capture, { moduleVersion, observedAt }) {
  const id = capture?.operationId;
  if (!EXCHANGE_ROLE_WRITE_OPERATIONS[id]) return [`${id ?? 'a capture'} is not a declared Exchange role write`];
  const problems = [];
  if (capture.synthetic !== false) problems.push(`${id}: synthetic or unlabelled capture`);
  if (capture.version !== moduleVersion) problems.push(`${id}: not captured at the recorded ${EXCHANGE_ROLE_MODULE} version`);
  if (typeof capture.fixture !== 'string' || !capture.fixture.startsWith(ROLE_CAPTURE_PREFIX)) problems.push(`${id}: wrote ${capture.fixture ?? 'nothing named'}, not a ${ROLE_CAPTURE_PREFIX}* role`);
  if (capture.collateralUnchanged !== true) problems.push(`${id}: the parent role changed, or was not checked`);
  if (!(capture.trimmedParameters > 0)) problems.push(`${id}: no parameter was trimmed, so the trim step was not shown to work`);
  problems.push(...captureTimeProblems(id, capture.capturedAt, observedAt));
  return problems;
}

/** Gate validator. Returns failure reasons; empty means the subject holds. */
export function validateRoleWritesLiveSubject(evidence, context = {}) {
  const { tenantRef, build, artifact, runner } = context;
  const failures = [];
  if (!runner?.ok) failures.push(`role capture runner proof required (${runner?.reason ?? 'not checked'})`);
  if (!artifact?.ok) failures.push(`role capture log required (${artifact?.reason ?? 'not checked'})`);
  if (evidence.evidenceLevel === 'live-qualified' && (evidence.synthetic !== false || runner?.synthetic)) failures.push('fixture evidence cannot claim live qualification');
  if (!tenantRef || !build) failures.push('role capture expected tenant/build identity required');
  if (build && evidence.build !== build) failures.push(`build mismatch: evidence is '${evidence.build}', required '${build}'`);
  if (evidence.operation !== ROLE_WRITES_LIVE_OPERATION) failures.push(`operation mismatch: expected '${ROLE_WRITES_LIVE_OPERATION}'`);
  if (evidence.credentialMode !== ROLE_WRITES_CREDENTIAL_MODE) failures.push(`credential mode must be '${ROLE_WRITES_CREDENTIAL_MODE}'`);
  failures.push(...secretProblems(evidence));
  const subject = evidence.subject;
  if (!subject || typeof subject !== 'object') return [...failures, 'subject is missing'];

  const execution = subject.execution ?? {};
  if (execution.transport !== ROLE_WRITES_TRANSPORT || execution.module !== EXCHANGE_ROLE_MODULE) failures.push(`cmdlets must run through the bounded ${ROLE_WRITES_TRANSPORT} transport (${EXCHANGE_ROLE_MODULE})`);
  const moduleVersion = typeof execution.moduleVersion === 'string' && MODULE_VERSION_RE.test(execution.moduleVersion) ? execution.moduleVersion : null;
  if (!moduleVersion) failures.push(`no ${EXCHANGE_ROLE_MODULE} module version recorded`);

  const credentials = subject.credentials ?? {};
  for (const role of ['collector', 'restorer']) {
    if (typeof credentials[role] !== 'string' || !credentials[role].trim()) failures.push(`no ${role} credential reference`);
  }
  if (credentials.collector && credentials.collector === credentials.restorer) failures.push('collector and restorer must be separate credentials');
  for (const write of Object.values(EXCHANGE_ROLE_WRITE_OPERATIONS)) {
    for (const role of write.rbac.roles) if (!subject.grants?.restorer?.roles?.includes(role)) failures.push(`the restorer lacks ${role}`);
    for (const permission of write.rbac.permissions) if (!subject.grants?.restorer?.permissions?.includes(permission)) failures.push(`the restorer lacks ${permission}`);
  }

  const refusals = subject.refusals ?? {};
  for (const key of ['removeRole', 'undeclaredParameter']) {
    if (refusals[key]?.refused !== true || refusals[key]?.sent !== false) failures.push(`the ${key} probe was not refused before sending`);
  }
  if (!Array.isArray(subject.requests)) failures.push('the record lists no requests');
  for (const request of Array.isArray(subject.requests) ? subject.requests : []) {
    const cmdlet = request?.cmdlet;
    if (WRITES.has(cmdlet)) {
      if (request.credential !== 'restorer') failures.push(`${cmdlet} was sent with the ${request.credential} credential, not the restorer`);
      if (typeof request.role !== 'string' || !request.role.startsWith(ROLE_CAPTURE_PREFIX)) failures.push(`${cmdlet} named ${request.role ?? 'nothing'}, not a ${ROLE_CAPTURE_PREFIX}* role`);
    } else if (READS.has(cmdlet)) {
      if (!['collector', 'restorer'].includes(request.credential)) failures.push(`${cmdlet} was sent with no known credential`);
    } else failures.push(`${cmdlet ?? 'an unnamed cmdlet'} is not a cmdlet the Exchange role writer runs`);
  }

  const observedAt = Date.parse(evidence.observedAt ?? '');
  const writes = Array.isArray(subject.writes) ? subject.writes : [];
  const seen = new Set();
  for (const capture of writes) {
    if (seen.has(capture?.operationId)) failures.push(`${capture.operationId}: captured twice`);
    seen.add(capture?.operationId);
    if (capture?.ok === true) failures.push(...captureProblems(capture, { moduleVersion, observedAt }));
  }
  if (provenRoleWrites(subject).length === 0) failures.push('no write was captured and read back: the record proves nothing');
  return [...new Set(failures)];
}
