/**
 * Roadmap task-120: the SharePoint configuration workload live-acceptance gate.
 *
 * This is the evidence contract and its gate validator. It is registered in
 * tools/release/qualification.mjs (GATE_VALIDATORS) and checks the `subject` of
 * a record captured by tools/qualification/sharepointLive.mjs against the
 * production declarations it qualifies:
 *  - the task-101 read descriptors (sharepoint.tenant-settings, site-discovery,
 *    site-properties, site-permissions) at the API version KEEL calls now;
 *  - the task-103 write (sharepoint.tenant-settings.update) and its five fields.
 *
 * What a passing subject proves, beyond the generic verifier (signature or
 * artifact digest, gate, tenant, freshness, --require-live):
 *  - identity: operation, build, credential mode, and two distinct credential
 *    references (collector reads, restorer writes; the collector holds no write
 *    permission);
 *  - prerequisites: tasks 101-103 are named and their declarations exist in this
 *    build; every read has a successful non-synthetic capture at its version;
 *    the grants cover every declared permission and role;
 *  - fixture: one disposable `KEEL-RT-*` site on the tenant host, and no other
 *    site addressed by id;
 *  - zero content calls: every logged request is re-checked against the task-101
 *    scope validator, and the only writes are the restorer's PATCHes to
 *    /admin/sharepoint/settings;
 *  - guarded post-state: a supported field was changed, read back as written,
 *    then put back, and the final settings match the starting fingerprint;
 *  - throttle behaviour and documentation retrieval are recorded;
 *  - no credential material anywhere in the record.
 *
 * It never sends a request and never enables anything. A verified record is
 * turned into ledger evidence only by tools/qualification/sharepointLive.mjs.
 */
import { WORKLOAD_DESCRIPTORS, scopeProblems } from '../../engine/collect/workloadContract.mjs';
import { siteInScope } from '../../engine/collect/workloads/sharepoint.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../../engine/coverage/qualification.mjs';

export const SHAREPOINT_LIVE_GATE = 'sharepoint-live-acceptance';
export const SHAREPOINT_LIVE_OPERATION = 'sharepoint.configuration-qualification';
export const SHAREPOINT_LIVE_CREDENTIAL_MODE = 'collector-read+restorer-write';
export const SHAREPOINT_LIVE_PREREQUISITES = Object.freeze(['task-101', 'task-102', 'task-103']);
export const SHAREPOINT_LIVE_READS = Object.freeze([
  'sharepoint.tenant-settings', 'sharepoint.site-discovery', 'sharepoint.site-properties', 'sharepoint.site-permissions',
]);
export const SHAREPOINT_LIVE_WRITE = 'sharepoint.tenant-settings.update';
export const FIXTURE_SITE_PREFIX = 'KEEL-RT-';
// A capture belongs to the record it is in: no older than this before observedAt.
export const CAPTURE_WINDOW_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const SECRET_KEY = /(token|secret|password|passwd|private.?key|bearer|authorization|cookie)/i;
const SECRET_VALUE = /^(eyJ[\w-]+\.[\w-]+\.|Bearer\s)|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

export function readDescriptor(id) {
  return WORKLOAD_DESCRIPTORS.find((descriptor) => descriptor.id === id) ?? null;
}

/** The documentation every qualified operation was declared from. */
export function requiredDocumentation() {
  const urls = SHAREPOINT_LIVE_READS.map((id) => readDescriptor(id)?.source?.url);
  urls.push(WORKLOAD_WRITE_OPERATIONS[SHAREPOINT_LIVE_WRITE]?.source);
  return urls.filter(Boolean);
}

/** The permissions and roles each credential must hold, from the production declarations. */
export function requiredGrants() {
  const collector = { permissions: new Set(), roles: new Set() };
  for (const id of SHAREPOINT_LIVE_READS) {
    const descriptor = readDescriptor(id);
    for (const permission of descriptor?.rbac?.permissions ?? []) collector.permissions.add(permission);
    for (const role of descriptor?.rbac?.roles ?? []) collector.roles.add(role);
  }
  const write = WORKLOAD_WRITE_OPERATIONS[SHAREPOINT_LIVE_WRITE];
  return {
    collector: { permissions: [...collector.permissions].sort(), roles: [...collector.roles].sort() },
    restorer: { permissions: [...(write?.rbac?.permissions ?? [])], roles: [...(write?.rbac?.roles ?? [])] },
  };
}

/** Every key path in the record whose name or value looks like credential material. */
export function secretProblems(value, path = '$') {
  const problems = [];
  if (Array.isArray(value)) value.forEach((item, index) => problems.push(...secretProblems(item, `${path}[${index}]`)));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) problems.push(`${path}.${key} looks like credential material`);
      problems.push(...secretProblems(child, `${path}.${key}`));
    }
  } else if (typeof value === 'string' && SECRET_VALUE.test(value)) problems.push(`${path} holds credential material`);
  return problems;
}

function captureTimeProblems(label, capturedAt, observedAt) {
  const at = Date.parse(capturedAt ?? '');
  if (Number.isNaN(at)) return [`${label}: no valid capture time`];
  if (Number.isNaN(observedAt)) return [];
  if (at > observedAt + CLOCK_SKEW_MS) return [`${label}: captured after the record was observed`];
  if (observedAt - at > CAPTURE_WINDOW_MS) return [`${label}: captured more than 24h before the record (stale capture)`];
  return [];
}

function missing(held, needed) {
  const have = new Set(Array.isArray(held) ? held : []);
  return needed.filter((item) => !have.has(item));
}

function siteIdOf(path) {
  const match = /^\/sites\/([^/?]+)/.exec(path);
  if (!match) return null;
  const id = decodeURIComponent(match[1]);
  return id === 'getAllSites' ? null : id;
}

function requestProblems(requests, { fixtureSiteId }) {
  const failures = [];
  if (!Array.isArray(requests) || requests.length === 0) return ['no request log recorded'];
  const write = WORKLOAD_WRITE_OPERATIONS[SHAREPOINT_LIVE_WRITE];
  let patches = 0;
  for (const [index, request] of requests.entries()) {
    const label = `request ${index} (${request?.method ?? '?'} ${request?.path ?? '?'})`;
    if (!['collector', 'restorer'].includes(request?.credential)) { failures.push(`${label}: unknown credential`); continue; }
    if (typeof request.path !== 'string' || !request.path.startsWith('/')) { failures.push(`${label}: no Graph path`); continue; }
    if (request.version !== 'v1.0') failures.push(`${label}: not the declared API version`);
    const siteId = siteIdOf(request.path);
    if (siteId && siteId !== fixtureSiteId) failures.push(`${label}: addresses a site other than the KEEL-RT fixture`);
    if (request.method === 'GET') {
      const scope = scopeProblems({ kind: 'graph', method: 'GET', endpoint: request.path });
      if (scope.length) failures.push(`${label}: content call: ${scope.join('; ')}`);
      if (request.credential === 'restorer' && request.path !== write.endpoint) {
        failures.push(`${label}: the restorer reads only the settings it writes`);
      }
    } else if (request.method === write.method && request.path === write.endpoint && request.credential === 'restorer') {
      patches += 1;
    } else {
      failures.push(`${label}: not an allowed write (only the restorer PATCHes ${write.endpoint})`);
    }
  }
  if (patches !== 2) failures.push(`expected exactly 2 settings writes (change, then put back), found ${patches}`);
  return failures;
}

/** Gate validator for the task-120 record. Returns failure reasons; empty means the subject holds. */
export function validateSharePointLiveSubject(evidence, { tenantRef, build } = {}) {
  const failures = [];
  if (evidence.status === 'pending') return ['SharePoint live evidence pending: no record has been captured'];
  if (!tenantRef || !build) failures.push('SharePoint expected tenant/build identity required');
  if (build && evidence.build !== build) failures.push(`SharePoint build mismatch: evidence is '${evidence.build}', required '${build}'`);
  if (evidence.operation !== SHAREPOINT_LIVE_OPERATION) {
    failures.push(`SharePoint operation mismatch: expected '${SHAREPOINT_LIVE_OPERATION}', got '${evidence.operation ?? 'missing'}'`);
  }
  if (evidence.credentialMode !== SHAREPOINT_LIVE_CREDENTIAL_MODE) {
    failures.push(`SharePoint requires credential mode '${SHAREPOINT_LIVE_CREDENTIAL_MODE}'`);
  }
  failures.push(...secretProblems(evidence));

  const subject = evidence.subject;
  if (!subject || typeof subject !== 'object') return [...failures, 'subject is missing'];
  const observedAt = Date.parse(evidence.observedAt ?? '');

  // Prerequisites: named, and present in this build.
  const write = WORKLOAD_WRITE_OPERATIONS[SHAREPOINT_LIVE_WRITE];
  for (const task of missing(subject.prerequisites, SHAREPOINT_LIVE_PREREQUISITES)) failures.push(`missing prerequisite: ${task}`);
  if (!write) failures.push(`prerequisite missing in this build: ${SHAREPOINT_LIVE_WRITE} is not declared`);
  for (const id of SHAREPOINT_LIVE_READS) if (!readDescriptor(id)) failures.push(`prerequisite missing in this build: ${id} is not declared`);

  // Credentials: references only, two distinct identities.
  const credentials = subject.credentials ?? {};
  for (const role of ['collector', 'restorer']) {
    if (typeof credentials[role] !== 'string' || !credentials[role].trim()) failures.push(`no ${role} credential reference`);
  }
  if (credentials.collector && credentials.collector === credentials.restorer) {
    failures.push('collector and restorer must be separate credentials');
  }
  const needed = requiredGrants();
  for (const role of ['collector', 'restorer']) {
    const held = subject.grants?.[role];
    for (const permission of missing(held?.permissions, needed[role].permissions)) failures.push(`missing prerequisite: ${role} lacks ${permission}`);
    for (const adminRole of missing(held?.roles, needed[role].roles)) failures.push(`missing prerequisite: ${role} lacks role ${adminRole}`);
  }
  if (write && (subject.grants?.collector?.permissions ?? []).some((permission) => write.rbac.permissions.includes(permission))) {
    failures.push('the collector holds the write permission; read and write credentials are not separated');
  }

  // The disposable fixture site.
  const tenantHost = subject.tenantHost;
  const site = subject.fixtureSite ?? {};
  if (typeof tenantHost !== 'string' || !/^[a-z0-9-]+\.sharepoint\.com$/i.test(tenantHost)) failures.push('no SharePoint tenant host');
  else if (!siteInScope(site, tenantHost)) failures.push('the fixture site is not a well-formed site on the tenant host');
  let siteName = '';
  try { siteName = decodeURIComponent(new URL(site.webUrl).pathname.split('/').filter(Boolean).pop() ?? ''); } catch { siteName = ''; }
  if (!siteName.startsWith(FIXTURE_SITE_PREFIX)) failures.push(`the fixture site is not a disposable ${FIXTURE_SITE_PREFIX}* site`);

  // Reads: one successful, non-synthetic capture per operation, at the declared version.
  const reads = Array.isArray(subject.reads) ? subject.reads : [];
  for (const id of SHAREPOINT_LIVE_READS) {
    const descriptor = readDescriptor(id);
    const capture = reads.find((item) => item?.operationId === id);
    if (!capture) { failures.push(`missing prerequisite: no live capture of ${id}`); continue; }
    if (capture.synthetic !== false) failures.push(`${id}: synthetic or unlabelled capture`);
    if (capture.ok !== true) failures.push(`${id}: the read failed`);
    if (descriptor && capture.version !== descriptor.operation.version) {
      failures.push(`${id}: captured at ${capture.version ?? 'unknown'}, not ${descriptor.operation.version}`);
    }
    failures.push(...captureTimeProblems(id, capture.capturedAt, observedAt));
  }
  if (write) {
    for (const field of missing(subject.supportedFields, write.fields)) failures.push(`supported field not observed live: ${field}`);
  }

  // The write: changed, read back, put back, final state equals the start.
  const capture = subject.write ?? {};
  if (capture.operationId !== SHAREPOINT_LIVE_WRITE) failures.push(`missing prerequisite: no live capture of ${SHAREPOINT_LIVE_WRITE}`);
  else {
    if (capture.synthetic !== false) failures.push('write: synthetic or unlabelled capture');
    if (write && capture.version !== write.version) failures.push(`write: captured at ${capture.version ?? 'unknown'}, not ${write.version}`);
    if (write && !write.fields.includes(capture.field)) failures.push(`write: ${capture.field ?? 'no field'} is not a supported written field`);
    if (capture.writeMode !== 'reversible-change') failures.push('write: a same-value write does not prove the platform applies a change');
    if (capture.ok !== true) failures.push('write: the write failed');
    if (capture.readBackVerified !== true) failures.push('write: the change was not read back as written');
    if (capture.restoredToOriginal !== true) failures.push('write: the setting was not put back');
    if (typeof capture.preFingerprint !== 'string' || capture.preFingerprint !== capture.finalFingerprint) {
      failures.push('write: the final settings do not match the starting settings');
    }
    failures.push(...captureTimeProblems('write', capture.capturedAt, observedAt));
  }

  // The raw capture log is bound into the signed subject, so swapping the log and
  // its proof digest together still breaks the record.
  if (typeof subject.captureLogSha256 !== 'string' || subject.captureLogSha256 !== evidence.proof?.artifact?.sha256) {
    failures.push('the capture log digest is not bound to the signed subject');
  }

  // Zero content calls and fixture-only addressing, re-derived from the request log.
  failures.push(...requestProblems(subject.requests, { fixtureSiteId: site.id }));

  const throttle = subject.throttle;
  if (!throttle || !Number.isInteger(throttle.retryAfterResponses) || throttle.retryAfterResponses < 0) {
    failures.push('throttle behaviour not recorded');
  }

  const docs = Array.isArray(subject.documentation) ? subject.documentation : [];
  for (const url of requiredDocumentation()) {
    const entry = docs.find((item) => item?.url === url);
    if (!entry || Number.isNaN(Date.parse(entry.retrievedAt ?? ''))) failures.push(`documentation not retrieved: ${url}`);
  }
  return failures;
}
