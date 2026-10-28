/**
 * SharePoint structure restore: the live gate for its seven writes
 * (engine/restore/workloads/sharepointStructureWrites.mjs). A record holds one capture by
 * tools/qualification/sharepointStructureWritesLive.mjs on the test tenant:
 *  - a KEEL-RT-capture- site script and site design added, read back, changed, read back;
 *  - a KEEL-RT- hub's description changed, read back and put back;
 *  - optionally a KEEL-RT- site registered as a hub, read back (it stays a hub);
 *  - on a /sites/KEEL-RT-* site, a KEEL-RT-capture- list, site column and content type
 *    added and the navigation put back, through the restore's own template builder.
 *
 * It never sends a request and never enables anything. A verified record becomes ledger
 * evidence only through sharepointStructureWritesLive.mjs's import seam.
 */
import { SHAREPOINT_STRUCTURE_WRITE_OPERATIONS } from '../../engine/restore/workloads/sharepointStructureWrites.mjs';
import { TEMPLATE_ELEMENTS } from '../../engine/restore/workloads/sharepointStructure.mjs';
import { captureTimeProblems, secretProblems } from './sharepointAcceptance.mjs';

export const STRUCTURE_WRITES_LIVE_GATE = 'sharepoint-structure-writes-live-acceptance';
export const STRUCTURE_WRITES_LIVE_OPERATION = 'sharepoint-structure.writer-qualification';
export const STRUCTURE_WRITES_CREDENTIAL_MODE = 'collector-read+restorer-write';
export const STRUCTURE_WRITES_TRANSPORT = 'powershell-cmdlet-job';
export const STRUCTURE_WRITES_RECORD_FILE = `${STRUCTURE_WRITES_LIVE_GATE}.json`;
export const STRUCTURE_FIXTURE_PREFIX = 'KEEL-RT-';
export const STRUCTURE_CAPTURE_PREFIX = `${STRUCTURE_FIXTURE_PREFIX}capture-`;
export const STRUCTURE_MODULE = 'PnP.PowerShell';
const MODULE_VERSION_RE = /^\d+\.\d+\.\d+(\.\d+)?$/;
const WRITE_METHODS = new Set(Object.values(SHAREPOINT_STRUCTURE_WRITE_OPERATIONS).map((write) => write.method));

const isFixture = (name) => typeof name === 'string' && name.toUpperCase().startsWith(STRUCTURE_FIXTURE_PREFIX.toUpperCase());

/** True for a /sites/KEEL-RT-* (or /teams/KEEL-RT-*) site collection address. */
export function isFixtureSite(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts.length === 2 && ['sites', 'teams'].includes(parts[0].toLowerCase()) && isFixture(decodeURIComponent(parts[1]));
  } catch { return false; }
}

/**
 * The writes a record proves: sent, read back as written and, for a change to an object
 * that was there before (a hub, the navigation), put back as it was.
 */
export function provenStructureWrites(subject) {
  return (Array.isArray(subject?.writes) ? subject.writes : []).filter((capture) => capture?.ok === true && capture.readBackVerified === true
    && (capture.putBack !== true || capture.restoredToOriginal === true));
}

function captureProblems(capture, { moduleVersion, observedAt }) {
  const id = capture?.operationId;
  const write = SHAREPOINT_STRUCTURE_WRITE_OPERATIONS[id];
  if (!write) return [`${id ?? 'a capture'} is not a declared SharePoint structure write`];
  const problems = [];
  if (capture.synthetic !== false) problems.push(`${id}: synthetic or unlabelled capture`);
  if (capture.version !== moduleVersion) problems.push(`${id}: not captured at the recorded ${STRUCTURE_MODULE} version`);
  if (write.family === 'siteTemplate' ? !isFixtureSite(capture.fixture) : !isFixture(capture.fixture)) {
    problems.push(`${id}: wrote ${capture.fixture ?? 'nothing named'}, not a ${STRUCTURE_FIXTURE_PREFIX} fixture`);
  }
  if (id.endsWith('.add') && write.family !== 'hubSite' && !String(capture.fixture ?? '').startsWith(STRUCTURE_CAPTURE_PREFIX)) {
    problems.push(`${id}: an add capture creates a ${STRUCTURE_CAPTURE_PREFIX}* object`);
  }
  if (write.family === 'siteTemplate') {
    const added = capture.added ?? {};
    for (const part of ['lists', 'siteColumns', 'contentTypes']) {
      if (!Array.isArray(added[part]) || added[part].length !== 1) problems.push(`${id}: expected one ${part} added`);
    }
    if (capture.navigation !== true) problems.push(`${id}: the navigation was not written and put back`);
    if (!Array.isArray(capture.elements) || capture.elements.some((name) => !TEMPLATE_ELEMENTS.includes(name))) problems.push(`${id}: the template held an element KEEL never sends`);
  }
  if ((id === 'sharepoint-structure.hub-site.update' || write.family === 'siteTemplate') && capture.putBack !== true) problems.push(`${id}: the change was not put back`);
  problems.push(...captureTimeProblems(id, capture.capturedAt, observedAt));
  return problems;
}

/** Gate validator. Returns failure reasons; empty means the subject holds. */
export function validateStructureWritesLiveSubject(evidence, context = {}) {
  const { tenantRef, build, artifact, runner } = context;
  const failures = [];
  if (!runner?.ok) failures.push(`structure capture runner proof required (${runner?.reason ?? 'not checked'})`);
  if (!artifact?.ok) failures.push(`structure capture log required (${artifact?.reason ?? 'not checked'})`);
  if (evidence.evidenceLevel === 'live-qualified' && (evidence.synthetic !== false || runner?.synthetic)) failures.push('fixture evidence cannot claim live qualification');
  if (!tenantRef || !build) failures.push('structure capture expected tenant/build identity required');
  if (build && evidence.build !== build) failures.push(`build mismatch: evidence is '${evidence.build}', required '${build}'`);
  if (evidence.operation !== STRUCTURE_WRITES_LIVE_OPERATION) failures.push(`operation mismatch: expected '${STRUCTURE_WRITES_LIVE_OPERATION}'`);
  if (evidence.credentialMode !== STRUCTURE_WRITES_CREDENTIAL_MODE) failures.push(`credential mode must be '${STRUCTURE_WRITES_CREDENTIAL_MODE}'`);
  failures.push(...secretProblems(evidence));
  const subject = evidence.subject;
  if (!subject || typeof subject !== 'object') return [...failures, 'subject is missing'];

  const execution = subject.execution ?? {};
  if (execution.transport !== STRUCTURE_WRITES_TRANSPORT || execution.module !== STRUCTURE_MODULE) failures.push(`cmdlets must run through the bounded ${STRUCTURE_WRITES_TRANSPORT} transport (${STRUCTURE_MODULE})`);
  const moduleVersion = typeof execution.moduleVersion === 'string' && MODULE_VERSION_RE.test(execution.moduleVersion) ? execution.moduleVersion : null;
  if (!moduleVersion) failures.push(`no ${STRUCTURE_MODULE} module version recorded`);

  const credentials = subject.credentials ?? {};
  for (const role of ['collector', 'restorer']) {
    if (typeof credentials[role] !== 'string' || !credentials[role].trim()) failures.push(`no ${role} credential reference`);
  }
  if (credentials.collector && credentials.collector === credentials.restorer) failures.push('collector and restorer must be separate credentials');
  const needed = new Set(Object.values(SHAREPOINT_STRUCTURE_WRITE_OPERATIONS).flatMap((write) => write.rbac.permissions));
  for (const permission of needed) if (!subject.grants?.restorer?.permissions?.includes(permission)) failures.push(`the restorer lacks ${permission}`);
  if (!isFixtureSite(subject.site)) failures.push(`the capture site is not a /sites/${STRUCTURE_FIXTURE_PREFIX}* site`);

  const refusals = subject.refusals ?? {};
  for (const key of ['remove', 'undeclaredParameter']) {
    if (refusals[key]?.refused !== true || refusals[key]?.sent !== false) failures.push(`the ${key} probe was not refused before sending`);
  }
  if (!Array.isArray(subject.requests)) failures.push('the record lists no requests');
  for (const request of Array.isArray(subject.requests) ? subject.requests : []) {
    if (request?.read !== undefined && request?.cmdlet === undefined) {
      if (request.read !== 'sharepoint-structure') failures.push(`a read of ${request.read} is not this workload's collector`);
      if (request.credential !== 'collector') failures.push(`a read was sent with the ${request.credential} credential, not the collector`);
    } else if (!WRITE_METHODS.has(request?.cmdlet)) failures.push(`${request?.cmdlet ?? 'an unnamed cmdlet'} is not a declared SharePoint structure write`);
    else if (request.credential !== 'restorer') failures.push(`${request.cmdlet} was sent with the ${request.credential} credential, not the restorer`);
  }

  const observedAt = Date.parse(evidence.observedAt ?? '');
  const writes = Array.isArray(subject.writes) ? subject.writes : [];
  const seen = new Set();
  for (const capture of writes) {
    if (seen.has(capture?.operationId)) failures.push(`${capture.operationId}: captured twice`);
    seen.add(capture?.operationId);
    if (capture?.ok === true || capture?.readBackVerified === true) failures.push(...captureProblems(capture, { moduleVersion, observedAt }));
  }
  if (provenStructureWrites(subject).length === 0) failures.push('no write was captured and read back: the record proves nothing');
  return failures;
}
