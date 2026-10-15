/**
 * Gap 5: the gate for the live proof of the two site app grant writes
 * (sharepoint.site-permissions.add and .update). A record holds one capture by
 * tools/qualification/sharepointSiteGrantsLive.mjs on a KEEL-RT- site, granting a
 * KEEL-RT- application read, reading it back, raising it to write and reading it
 * back.
 *
 * It never sends a request and never enables anything. A verified record is
 * turned into ledger evidence only by sharepointSiteGrantsLive.mjs.
 */
import { scopeProblems } from '../../engine/collect/workloadContract.mjs';
import { siteInScope } from '../../engine/collect/workloads/sharepoint.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../../engine/coverage/qualification.mjs';
import { SITE_GRANT_ADD, SITE_GRANT_UPDATE } from '../../engine/restore/workloads/sharepointSiteGrants.mjs';
import { FIXTURE_SITE_PREFIX, captureTimeProblems, readDescriptor, secretProblems, siteIdOf } from './sharepointAcceptance.mjs';

export const SITE_GRANTS_LIVE_GATE = 'sharepoint-site-grants-live-acceptance';
export const SITE_GRANTS_LIVE_OPERATION = 'sharepoint.site-grants-qualification';
export const SITE_GRANTS_LIVE_CREDENTIAL_MODE = 'collector-read+restorer-write';
export const SITE_GRANTS_RECORD_FILE = `${SITE_GRANTS_LIVE_GATE}.json`;
export const SITE_GRANTS_LIVE_READS = Object.freeze(['sharepoint.site-discovery', 'sharepoint.site-permissions']);
export const SITE_GRANTS_LIVE_WRITES = Object.freeze([SITE_GRANT_ADD, SITE_GRANT_UPDATE]);
// The role each write sets on the fixture grant: add grants read, update raises it to write.
export const SITE_GRANTS_CAPTURE_ROLES = Object.freeze({ [SITE_GRANT_ADD]: 'read', [SITE_GRANT_UPDATE]: 'write' });
export const FIXTURE_APP_PREFIX = 'KEEL-RT-';

export function requiredDocumentation() {
  return [
    ...SITE_GRANTS_LIVE_READS.map((id) => readDescriptor(id)?.source?.url),
    ...SITE_GRANTS_LIVE_WRITES.map((id) => WORKLOAD_WRITE_OPERATIONS[id]?.source),
  ].filter(Boolean);
}

export function requiredGrants() {
  const collector = new Set(SITE_GRANTS_LIVE_READS.flatMap((id) => readDescriptor(id)?.rbac?.permissions ?? []));
  const restorer = new Set(SITE_GRANTS_LIVE_WRITES.flatMap((id) => WORKLOAD_WRITE_OPERATIONS[id]?.rbac?.permissions ?? []));
  return { collector: { permissions: [...collector].sort(), roles: [] }, restorer: { permissions: [...restorer].sort(), roles: [] } };
}

const missing = (held, needed) => needed.filter((item) => !(Array.isArray(held) ? held : []).includes(item));

function requestProblems(requests, { fixtureSiteId }) {
  if (!Array.isArray(requests) || requests.length === 0) return ['no request log recorded'];
  const failures = [];
  const grantsPath = `/sites/${encodeURIComponent(fixtureSiteId ?? '')}/permissions`;
  const counts = { POST: 0, PATCH: 0 };
  for (const [index, request] of requests.entries()) {
    const label = `request ${index} (${request?.method ?? '?'} ${request?.path ?? '?'})`;
    if (!['collector', 'restorer'].includes(request?.credential)) { failures.push(`${label}: unknown credential`); continue; }
    if (typeof request.path !== 'string' || !request.path.startsWith('/')) { failures.push(`${label}: no Graph path`); continue; }
    if (request.version !== 'v1.0') failures.push(`${label}: not the declared API version`);
    const siteId = siteIdOf(request.path);
    if (siteId && siteId !== fixtureSiteId) failures.push(`${label}: addresses a site other than the KEEL-RT fixture`);
    const path = request.path.split('?')[0];
    if (request.method === 'GET') {
      const scope = scopeProblems({ kind: 'graph', method: 'GET', endpoint: decodeURIComponent(path) });
      if (scope.length) failures.push(`${label}: content call: ${scope.join('; ')}`);
      if (request.credential === 'restorer' && path !== grantsPath) failures.push(`${label}: the restorer reads only the fixture's grants`);
    } else if (request.credential === 'restorer' && request.method === 'POST' && path === grantsPath) {
      counts.POST += 1;
    } else if (request.credential === 'restorer' && request.method === 'PATCH' && path.startsWith(`${grantsPath}/`) && !path.slice(grantsPath.length + 1).includes('/')) {
      counts.PATCH += 1;
    } else {
      failures.push(`${label}: not an allowed write (only the restorer POSTs or PATCHes the fixture's grants)`);
    }
  }
  if (counts.POST !== 1) failures.push(`expected exactly 1 grant created, found ${counts.POST}`);
  if (counts.PATCH !== 1) failures.push(`expected exactly 1 grant updated, found ${counts.PATCH}`);
  return failures;
}

/** Gate validator. Returns failure reasons; empty means the subject holds. */
export function validateSiteGrantsLiveSubject(evidence, { tenantRef, build } = {}) {
  const failures = [];
  if (!tenantRef || !build) failures.push('site grant expected tenant/build identity required');
  if (build && evidence.build !== build) failures.push(`site grant build mismatch: evidence is '${evidence.build}', required '${build}'`);
  if (evidence.operation !== SITE_GRANTS_LIVE_OPERATION) failures.push(`site grant operation mismatch: expected '${SITE_GRANTS_LIVE_OPERATION}'`);
  if (evidence.credentialMode !== SITE_GRANTS_LIVE_CREDENTIAL_MODE) failures.push(`site grant capture requires credential mode '${SITE_GRANTS_LIVE_CREDENTIAL_MODE}'`);
  failures.push(...secretProblems(evidence));
  const subject = evidence.subject;
  if (!subject || typeof subject !== 'object') return [...failures, 'subject is missing'];
  const observedAt = Date.parse(evidence.observedAt ?? '');

  const credentials = subject.credentials ?? {};
  for (const role of ['collector', 'restorer']) {
    if (typeof credentials[role] !== 'string' || !credentials[role].trim()) failures.push(`no ${role} credential reference`);
  }
  if (credentials.collector && credentials.collector === credentials.restorer) failures.push('collector and restorer must be separate credentials');
  const needed = requiredGrants();
  for (const role of ['collector', 'restorer']) {
    for (const permission of missing(subject.grants?.[role]?.permissions, needed[role].permissions)) failures.push(`missing prerequisite: ${role} lacks ${permission}`);
  }

  const site = subject.fixtureSite ?? {};
  if (typeof subject.tenantHost !== 'string' || !/^[a-z0-9-]+\.sharepoint\.com$/i.test(subject.tenantHost)) failures.push('no SharePoint tenant host');
  else if (!siteInScope(site, subject.tenantHost)) failures.push('the fixture site is not a well-formed site on the tenant host');
  let siteName = '';
  try { siteName = decodeURIComponent(new URL(site.webUrl).pathname.split('/').filter(Boolean).pop() ?? ''); } catch { siteName = ''; }
  if (!siteName.startsWith(FIXTURE_SITE_PREFIX)) failures.push(`the fixture site is not a disposable ${FIXTURE_SITE_PREFIX}* site`);
  if (typeof subject.application?.id !== 'string' || !String(subject.application?.displayName ?? '').startsWith(FIXTURE_APP_PREFIX)) {
    failures.push(`the granted application is not a ${FIXTURE_APP_PREFIX}* test application`);
  }

  const reads = Array.isArray(subject.reads) ? subject.reads : [];
  for (const id of SITE_GRANTS_LIVE_READS) {
    const capture = reads.find((item) => item?.operationId === id);
    if (!capture) { failures.push(`missing prerequisite: no live capture of ${id}`); continue; }
    if (capture.synthetic !== false) failures.push(`${id}: synthetic or unlabelled capture`);
    if (capture.ok !== true) failures.push(`${id}: the read failed`);
    if (capture.version !== readDescriptor(id)?.operation?.version) failures.push(`${id}: not captured at the declared version`);
    failures.push(...captureTimeProblems(id, capture.capturedAt, observedAt));
  }

  const writes = Array.isArray(subject.writes) ? subject.writes : [];
  for (const id of SITE_GRANTS_LIVE_WRITES) {
    const capture = writes.find((item) => item?.operationId === id);
    if (!capture) { failures.push(`missing prerequisite: no live capture of ${id}`); continue; }
    if (capture.synthetic !== false) failures.push(`${id}: synthetic or unlabelled capture`);
    if (capture.version !== WORKLOAD_WRITE_OPERATIONS[id]?.version) failures.push(`${id}: not captured at the declared version`);
    if (capture.role !== SITE_GRANTS_CAPTURE_ROLES[id]) failures.push(`${id}: wrote ${capture.role ?? 'no role'}, not ${SITE_GRANTS_CAPTURE_ROLES[id]}`);
    if (capture.ok !== true) failures.push(`${id}: the write failed`);
    if (capture.readBackVerified !== true) failures.push(`${id}: the write was not read back as written`);
    if (id === SITE_GRANT_ADD && !String(capture.grantedName ?? '').startsWith(FIXTURE_APP_PREFIX)) {
      failures.push(`${id}: the granted app did not read back as a ${FIXTURE_APP_PREFIX}* test application`);
    }
    failures.push(...captureTimeProblems(id, capture.capturedAt, observedAt));
  }

  if (typeof subject.captureLogSha256 !== 'string' || subject.captureLogSha256 !== evidence.proof?.artifact?.sha256) {
    failures.push('the capture log digest is not bound to the signed subject');
  }
  failures.push(...requestProblems(subject.requests, { fixtureSiteId: site.id }));
  if (!Number.isInteger(subject.throttle?.retryAfterResponses) || subject.throttle.retryAfterResponses < 0) failures.push('throttle behaviour not recorded');
  const docs = Array.isArray(subject.documentation) ? subject.documentation : [];
  for (const url of requiredDocumentation()) {
    const entry = docs.find((item) => item?.url === url);
    if (!entry || Number.isNaN(Date.parse(entry.retrievedAt ?? ''))) failures.push(`documentation not retrieved: ${url}`);
  }
  return failures;
}
