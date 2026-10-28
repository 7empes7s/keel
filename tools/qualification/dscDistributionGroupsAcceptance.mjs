/**
 * Distribution list restore through Microsoft365DSC: the live gate for its two writes
 * (engine/restore/workloads/dscDistributionGroups.mjs). A record holds one capture by
 * tools/qualification/dscDistributionGroupsLive.mjs on the test tenant:
 *  - a KEEL-RT-capture- distribution list created through the writer's own DSC transport
 *    with the restorer, read back with the collector (the add);
 *  - the declared settings of a seeded KEEL-RT-capture- list (one with members, an owner
 *    and a moderator, made by the operator) changed and read back, with everything KEEL
 *    never sends (members, owners, moderators, senders, addresses, the settings it does
 *    not write) checked unchanged (the update);
 *  - that seeded list found by its Guid, and an unknown Guid not found, as the writer
 *    reads every backed-up list.
 *
 * It never sends a request and never enables anything. A verified record becomes ledger
 * evidence only through dscDistributionGroupsLive.mjs's import seam.
 */
import { DSC_MODULE, DSC_MODULE_VERSION } from '../../engine/powershell/dscJob.mjs';
import { DSC_RESOURCES, DSC_WRITE_OPERATIONS } from '../../engine/restore/workloads/dscDeclarations.mjs';
import { captureTimeProblems, secretProblems } from './sharepointAcceptance.mjs';

export const DSC_WRITES_LIVE_GATE = 'dsc-distribution-groups-writes-live-acceptance';
export const DSC_WRITES_LIVE_OPERATION = 'exchange-distribution-groups.dsc-writer-qualification';
export const DSC_WRITES_CREDENTIAL_MODE = 'collector-read+restorer-write';
export const DSC_WRITES_TRANSPORT = 'dsc-resource-job';
export const DSC_WRITES_RECORD_FILE = `${DSC_WRITES_LIVE_GATE}.json`;
export const DSC_CAPTURE_PREFIX = 'KEEL-RT-capture-';
const MODULE_VERSION_RE = /^\d+\.\d+\.\d+(\.\d+)?$/;
const RESOURCES = new Set(Object.keys(DSC_RESOURCES));

/** The writes a record proves: sent, read back as written, and nothing undeclared changed. */
export function provenDscWrites(subject) {
  return (Array.isArray(subject?.writes) ? subject.writes : []).filter((capture) => capture?.ok === true && capture.readBackVerified === true
    && capture.collateralUnchanged === true);
}

function captureProblems(capture, { moduleVersion, observedAt }) {
  const id = capture?.operationId;
  if (!DSC_WRITE_OPERATIONS[id]) return [`${id ?? 'a capture'} is not a declared distribution list write`];
  const problems = [];
  if (capture.synthetic !== false) problems.push(`${id}: synthetic or unlabelled capture`);
  if (capture.version !== moduleVersion) problems.push(`${id}: not captured at the recorded ${DSC_MODULE} version`);
  if (typeof capture.fixture !== 'string' || !capture.fixture.startsWith(DSC_CAPTURE_PREFIX)) problems.push(`${id}: wrote ${capture.fixture ?? 'nothing named'}, not a ${DSC_CAPTURE_PREFIX}* list`);
  if (capture.collateralUnchanged !== true) problems.push(`${id}: a field KEEL never sends changed, or was not checked`);
  problems.push(...captureTimeProblems(id, capture.capturedAt, observedAt));
  return problems;
}

/** Gate validator. Returns failure reasons; empty means the subject holds. */
export function validateDscWritesLiveSubject(evidence, context = {}) {
  const { tenantRef, build, artifact, runner } = context;
  const failures = [];
  if (!runner?.ok) failures.push(`DSC capture runner proof required (${runner?.reason ?? 'not checked'})`);
  if (!artifact?.ok) failures.push(`DSC capture log required (${artifact?.reason ?? 'not checked'})`);
  if (evidence.evidenceLevel === 'live-qualified' && (evidence.synthetic !== false || runner?.synthetic)) failures.push('fixture evidence cannot claim live qualification');
  if (!tenantRef || !build) failures.push('DSC capture expected tenant/build identity required');
  if (build && evidence.build !== build) failures.push(`build mismatch: evidence is '${evidence.build}', required '${build}'`);
  if (evidence.operation !== DSC_WRITES_LIVE_OPERATION) failures.push(`operation mismatch: expected '${DSC_WRITES_LIVE_OPERATION}'`);
  if (evidence.credentialMode !== DSC_WRITES_CREDENTIAL_MODE) failures.push(`credential mode must be '${DSC_WRITES_CREDENTIAL_MODE}'`);
  failures.push(...secretProblems(evidence));
  const subject = evidence.subject;
  if (!subject || typeof subject !== 'object') return [...failures, 'subject is missing'];

  const execution = subject.execution ?? {};
  if (execution.transport !== DSC_WRITES_TRANSPORT || execution.module !== DSC_MODULE) failures.push(`resources must run through the bounded ${DSC_WRITES_TRANSPORT} transport (${DSC_MODULE})`);
  const moduleVersion = typeof execution.moduleVersion === 'string' && MODULE_VERSION_RE.test(execution.moduleVersion) ? execution.moduleVersion : null;
  if (!moduleVersion) failures.push(`no ${DSC_MODULE} module version recorded`);
  // The proof binds to the version this build pins, not only to the one the record names.
  else if (moduleVersion !== DSC_MODULE_VERSION) failures.push(`captured with ${DSC_MODULE} ${moduleVersion}; this build pins ${DSC_MODULE_VERSION}`);
  const identityRead = subject.identityRead ?? {};
  if (identityRead.byGuidFound !== true || identityRead.unknownGuidAbsent !== true) {
    failures.push('the seeded list was not found by its Guid, or an unknown Guid was found: the writer reads every list by Guid');
  }

  const credentials = subject.credentials ?? {};
  for (const role of ['collector', 'restorer']) {
    if (typeof credentials[role] !== 'string' || !credentials[role].trim()) failures.push(`no ${role} credential reference`);
  }
  if (credentials.collector && credentials.collector === credentials.restorer) failures.push('collector and restorer must be separate credentials');
  for (const write of Object.values(DSC_WRITE_OPERATIONS)) {
    for (const role of write.rbac.roles) if (!subject.grants?.restorer?.roles?.includes(role)) failures.push(`the restorer lacks ${role}`);
    for (const permission of write.rbac.permissions) if (!subject.grants?.restorer?.permissions?.includes(permission)) failures.push(`the restorer lacks ${permission}`);
  }

  const refusals = subject.refusals ?? {};
  for (const key of ['remove', 'listedField']) {
    if (refusals[key]?.refused !== true || refusals[key]?.sent !== false) failures.push(`the ${key} probe was not refused before sending`);
  }
  if (!Array.isArray(subject.requests)) failures.push('the record lists no requests');
  for (const request of Array.isArray(subject.requests) ? subject.requests : []) {
    if (!RESOURCES.has(request?.resource)) failures.push(`${request?.resource ?? 'an unnamed resource'} is not a DSC resource KEEL drives`);
    const methods = Array.isArray(request?.methods) ? request.methods : [];
    if (methods.includes('Set')) {
      if (request.credential !== 'restorer') failures.push(`a Set was sent with the ${request.credential} credential, not the restorer`);
      if (request.ensure !== 'Present') failures.push('a Set did not carry Ensure = Present');
      if (typeof request.name !== 'string' || !request.name.startsWith(DSC_CAPTURE_PREFIX)) failures.push(`a Set named ${request.name ?? 'nothing'}, not a ${DSC_CAPTURE_PREFIX}* list`);
    } else if (request.credential !== 'collector') failures.push(`a read was sent with the ${request.credential} credential, not the collector`);
  }

  const observedAt = Date.parse(evidence.observedAt ?? '');
  const writes = Array.isArray(subject.writes) ? subject.writes : [];
  const seen = new Set();
  for (const capture of writes) {
    if (seen.has(capture?.operationId)) failures.push(`${capture.operationId}: captured twice`);
    seen.add(capture?.operationId);
    // A capture recorded as not proven (a failed write, a field KEEL never sends that changed) proves nothing and is not checked.
    if (capture?.ok === true) failures.push(...captureProblems(capture, { moduleVersion, observedAt }));
  }
  if (provenDscWrites(subject).length === 0) failures.push('no write was captured and read back: the record proves nothing');
  return [...new Set(failures)];
}
