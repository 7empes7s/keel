/**
 * Roadmap task-115: the evidence contract for native recovery credential
 * qualification (gate `native-live-acceptance`).
 *
 * Task-64 chooses a recovery mechanism; it can only plan a soft-delete restore
 * as automated for a type whose route is qualified. This module says what an
 * independently captured runner record must contain before any route can be
 * called live-qualified, and checks a record against that contract:
 *
 *  - every operation is bound to the task-64 prerequisite (its retention days
 *    and native route names, read from the production module, not restated);
 *  - an automated operation names a disposable KEEL-RT-* / keel-rehearsal-*
 *    fixture, keeps the object id across delete → restore, records the
 *    retention deadline derived from Graph's deletedDateTime, and finished
 *    before that deadline;
 *  - every automated claim is confirmed by the raw captured Graph exchanges in
 *    the proof artifact (its bytes are digest-checked by qualification.mjs);
 *  - a route that is not available records a manual handoff, never automated
 *    support. Named locations stay manual (operator decision), and a
 *    Conditional Access policy restore is fixture-tested only (task-152): this
 *    gate refuses an automated claim for either outright;
 *  - the run is bounded (objects touched and elapsed time) and carries no
 *    credential material — references only.
 *
 * This module never talks to Microsoft. The capture tool
 * (tools/qualification/nativeRecovery.mjs) produces records; this checks them.
 */
import { NATIVE_RECOVERY_ROUTES, SOFT_DELETE_RETENTION_DAYS, softDeleteDeadline } from './recoveryMechanism.mjs';

export const NATIVE_LIVE_GATE = 'native-live-acceptance';
export const NATIVE_LIVE_OPERATION = 'native-recovery.live-acceptance';
export const NATIVE_LIVE_PREREQUISITE = 'task-64';
export const NATIVE_LIVE_CREDENTIAL_MODE = 'restorer';
export const NATIVE_LIVE_MAX_OBJECTS = 3;
export const NATIVE_LIVE_MAX_ELAPSED_MS = 15 * 60 * 1000;
/** Documentation checked by the runner must be at most this old at capture time. */
export const NATIVE_LIVE_DOCS_MAX_AGE_DAYS = 90;

/** A disposable fixture: the operator's sandbox guardrails allow writes to nothing else. */
export const DISPOSABLE_FIXTURE_PATTERN = /^(KEEL-RT-|keel-rehearsal-)/i;

/**
 * Directory soft-delete routes (Graph v1.0 directory deleted items). The
 * collection is where the live object is read and deleted; the name field is
 * what identifies the fixture by name. Permissions are the least-privileged
 * application permissions the runner is expected to hold; the record states
 * the permissions it actually used.
 */
export const DIRECTORY_RESTORE_ROUTES = Object.freeze({
  group: Object.freeze({ collection: '/groups', nameField: 'displayName', permission: 'Group.ReadWrite.All' }),
  user: Object.freeze({ collection: '/users', nameField: 'userPrincipalName', permission: 'User.ReadWrite.All' }),
  application: Object.freeze({ collection: '/applications', nameField: 'displayName', permission: 'Application.ReadWrite.All' }),
});
export const DIRECTORY_RESTORE_ROUTE = 'directory-deleted-items';
export const DIRECTORY_RESTORE_DOCS = 'https://learn.microsoft.com/en-us/graph/api/directory-deleteditems-restore?view=graph-rest-1.0';
export const DIRECTORY_RESTORE_OPERATION = 'restore-soft-deleted';

/** Roadmap task-152: restored by KEEL, but fixture-tested only; never live-qualified by this gate. */
export const FIXTURE_ONLY_RESTORE_TYPES = Object.freeze(['conditionalAccessPolicy']);

const DAY_MS = 24 * 60 * 60 * 1000;
const SECRET_KEY = /secret|password|private.?key|token|assertion|credential.?value/i;
const SECRET_VALUE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./;

/** The task-64 prerequisite as the production code defines it today. */
export function nativeLivePrerequisite() {
  return {
    task: NATIVE_LIVE_PREREQUISITE,
    retentionDays: SOFT_DELETE_RETENTION_DAYS,
    nativeRoutes: Object.fromEntries(Object.entries(NATIVE_RECOVERY_ROUTES).map(([type, route]) => [type, route.route])),
  };
}

/** The raw Graph exchanges an automated operation must have produced, in order. */
export function expectedExchanges(resourceType, objectId) {
  const route = DIRECTORY_RESTORE_ROUTES[resourceType];
  return [
    { step: 'read-live', method: 'GET', path: `${route.collection}/${objectId}`, status: 200 },
    { step: 'delete', method: 'DELETE', path: `${route.collection}/${objectId}`, status: 204 },
    { step: 'read-deleted', method: 'GET', path: `/directory/deletedItems/${objectId}`, status: 200 },
    { step: 'restore', method: 'POST', path: `/directory/deletedItems/${objectId}/restore`, status: 200 },
    { step: 'read-back', method: 'GET', path: `${route.collection}/${objectId}`, status: 200 },
  ];
}

function scanForCredentialMaterial(value, path, failures) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => scanForCredentialMaterial(item, `${path}[${i}]`, failures));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) failures.push(`credential material refused at ${path}.${key}`);
      scanForCredentialMaterial(item, `${path}.${key}`, failures);
    }
  } else if (typeof value === 'string' && SECRET_VALUE.test(value)) {
    failures.push(`credential material refused at ${path}`);
  }
}

function time(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? null : parsed;
}

function parseArtifact(artifactBytes) {
  if (!artifactBytes) return { capture: null, failure: 'raw capture artifact is missing — external evidence is required' };
  try {
    return { capture: JSON.parse(artifactBytes.toString('utf8')), failure: null };
  } catch {
    return { capture: null, failure: 'raw capture artifact is not valid JSON' };
  }
}

function validateDocs(op, label, observedAt, failures) {
  const docs = op.docs;
  if (!docs || typeof docs !== 'object') {
    failures.push(`${label}: Microsoft documentation check is not recorded`);
    return;
  }
  let host = null;
  try { host = new URL(docs.url).host; } catch { /* reported below */ }
  if (host !== 'learn.microsoft.com') failures.push(`${label}: documentation must be a learn.microsoft.com page`);
  const retrievedAt = time(docs.retrievedAt);
  if (retrievedAt === null) failures.push(`${label}: documentation retrieval date is missing`);
  else if (observedAt !== null && (retrievedAt > observedAt || observedAt - retrievedAt > NATIVE_LIVE_DOCS_MAX_AGE_DAYS * DAY_MS)) {
    failures.push(`${label}: documentation was not checked within ${NATIVE_LIVE_DOCS_MAX_AGE_DAYS} days before capture`);
  }
}

function validateAutomated(op, label, { evidence, capture, observedAt, permissions }, failures) {
  const route = DIRECTORY_RESTORE_ROUTES[op.resourceType];
  if (!route) {
    failures.push(`${label}: ${op.resourceType} has no directory soft-delete route; record a manual handoff instead`);
    return null;
  }
  if (op.operation !== DIRECTORY_RESTORE_OPERATION) failures.push(`${label}: operation mismatch: expected '${DIRECTORY_RESTORE_OPERATION}', got '${op.operation ?? 'missing'}'`);
  if (op.route !== DIRECTORY_RESTORE_ROUTE) failures.push(`${label}: route mismatch: expected '${DIRECTORY_RESTORE_ROUTE}'`);
  if (!permissions.includes(route.permission)) failures.push(`${label}: credential does not record ${route.permission}`);
  validateDocs(op, label, observedAt, failures);

  const objectId = op.fixture?.objectId;
  if (typeof objectId !== 'string' || !objectId) failures.push(`${label}: fixture object id missing`);
  if (!DISPOSABLE_FIXTURE_PATTERN.test(op.fixture?.name ?? '')) {
    failures.push(`${label}: '${op.fixture?.name ?? 'missing'}' is not a disposable KEEL-RT-* or keel-rehearsal-* fixture`);
  }
  if (op.restoredObjectId !== objectId || op.idPreserved !== true) failures.push(`${label}: object id was not preserved across restore`);

  const deadline = softDeleteDeadline({ deletedDateTime: op.deletedDateTime });
  if (!deadline) failures.push(`${label}: deletedDateTime missing — retention deadline unprovable`);
  else if (op.retentionDeadline !== deadline) failures.push(`${label}: retention deadline does not equal deletedDateTime + ${SOFT_DELETE_RETENTION_DAYS} days`);
  const deletedAt = time(op.deletedDateTime);
  const restoredAt = time(op.restoredAt);
  if (restoredAt === null) failures.push(`${label}: restoredAt missing`);
  else {
    if (deadline && restoredAt >= Date.parse(deadline)) failures.push(`${label}: restore completed after the retention deadline`);
    if (deletedAt !== null && restoredAt < deletedAt) failures.push(`${label}: restore precedes deletion`);
    if (observedAt !== null && restoredAt > observedAt) failures.push(`${label}: restore is later than the record's observation time`);
  }

  // The raw capture must show exactly this delete → restore round trip.
  const captured = capture?.operations?.find((c) => c?.resourceType === op.resourceType && c?.objectId === objectId);
  if (!captured) {
    failures.push(`${label}: no raw captured exchanges for this object in the artifact`);
    return objectId;
  }
  const expected = expectedExchanges(op.resourceType, objectId);
  const exchanges = Array.isArray(captured.exchanges) ? captured.exchanges : [];
  for (const want of expected) {
    const got = exchanges.find((e) => e?.step === want.step);
    if (!got || got.method !== want.method || got.path !== want.path || got.status !== want.status) {
      failures.push(`${label}: captured ${want.step} exchange missing or not ${want.method} ${want.path} → ${want.status}`);
      continue;
    }
    if (want.step !== 'delete' && got.body?.id !== objectId) failures.push(`${label}: captured ${want.step} body names another object`);
  }
  const deletedBody = exchanges.find((e) => e?.step === 'read-deleted')?.body;
  if (deletedBody && deletedBody.deletedDateTime !== op.deletedDateTime) {
    failures.push(`${label}: deletedDateTime differs from the captured deleted-items read`);
  }
  const liveBody = exchanges.find((e) => e?.step === 'read-live')?.body;
  if (liveBody && liveBody[route.nameField] !== op.fixture?.name) failures.push(`${label}: fixture name differs from the captured live read`);
  return objectId;
}

/**
 * Validates a native-live-acceptance record. `artifactBytes` are the proof
 * artifact's bytes after qualification.mjs verified their digest (null when
 * the artifact is absent or failed verification). Returns failure strings.
 */
export function validateNativeLiveAcceptance(evidence, { tenantRef = null, build = null, artifactBytes = null } = {}) {
  const failures = [];
  if (!tenantRef || !build) failures.push('native-live-acceptance requires the expected tenant and build identity');
  if (tenantRef && evidence.tenantRef !== tenantRef) failures.push('native-live-acceptance tenant mismatch');
  if (build && evidence.build !== build) failures.push('native-live-acceptance build mismatch');
  if (evidence.operation !== NATIVE_LIVE_OPERATION) {
    failures.push(`operation mismatch: expected '${NATIVE_LIVE_OPERATION}', got '${evidence.operation ?? 'missing'}'`);
  }
  if (evidence.credentialMode !== NATIVE_LIVE_CREDENTIAL_MODE) failures.push('native recovery requires the restorer credential mode');
  scanForCredentialMaterial(evidence, 'evidence', failures);

  const subject = evidence.subject;
  if (!subject || typeof subject !== 'object') return [...failures, 'subject is missing'];

  // Prerequisite: the record must have been captured against task-64 as it is now.
  const prerequisite = nativeLivePrerequisite();
  const recorded = subject.prerequisite;
  if (!recorded || recorded.task !== prerequisite.task) failures.push('task-64 prerequisite missing');
  else {
    if (recorded.retentionDays !== prerequisite.retentionDays) failures.push('prerequisite retention days differ from task-64');
    for (const [type, route] of Object.entries(prerequisite.nativeRoutes)) {
      if (recorded.nativeRoutes?.[type] !== route) failures.push(`prerequisite native route for ${type} differs from task-64`);
    }
  }

  const credential = subject.credential;
  if (credential?.mode !== NATIVE_LIVE_CREDENTIAL_MODE) failures.push('credential mode record must be the restorer');
  if (credential?.auth !== 'certificate') failures.push('credential must use certificate authentication');
  if (typeof credential?.clientRef !== 'string' || !credential.clientRef) failures.push('credential reference missing');
  const permissions = Array.isArray(credential?.permissions) ? credential.permissions : [];

  const { capture, failure: artifactFailure } = parseArtifact(artifactBytes);
  if (artifactFailure) failures.push(artifactFailure);
  else {
    if (capture.tenantRef !== evidence.tenantRef) failures.push('raw capture tenant differs from the record');
    if (capture.build !== evidence.build) failures.push('raw capture build differs from the record');
    if (subject.captureSha256 !== evidence.proof?.artifact?.sha256) failures.push('signed capture digest does not name the proof artifact');
  }

  const observedAt = time(evidence.observedAt);
  const operations = Array.isArray(subject.operations) ? subject.operations : [];
  if (operations.length === 0) failures.push('no native recovery operations recorded');
  const touched = new Set();
  let automated = 0;
  operations.forEach((op, i) => {
    const label = `operation ${i} (${op?.resourceType ?? 'unknown'})`;
    if (op?.outcome === 'automated') {
      if (NATIVE_RECOVERY_ROUTES[op.resourceType]) {
        failures.push(`${label}: Conditional Access recovery stays manual; an automated claim is refused`);
        return;
      }
      if (FIXTURE_ONLY_RESTORE_TYPES.includes(op.resourceType)) {
        failures.push(`${label}: Conditional Access policy restore is fixture-tested only; this gate never records it as live-qualified`);
        return;
      }
      const objectId = validateAutomated(op, label, { evidence, capture, observedAt, permissions }, failures);
      if (objectId) touched.add(`${op.resourceType}:${objectId}`);
      automated += 1;
    } else if (op?.outcome === 'manual-handoff') {
      if (typeof op.reason !== 'string' || !op.reason) failures.push(`${label}: a manual handoff must record its reason`);
      if (op.fixture || op.restoredObjectId) failures.push(`${label}: a manual handoff records no automated recovery`);
    } else {
      failures.push(`${label}: outcome '${op?.outcome ?? 'missing'}' is not a qualified recovery`);
    }
  });
  if (automated === 0) failures.push('no automated native recovery operation verified — nothing is qualified');

  const bounds = subject.bounds;
  if (!bounds || typeof bounds !== 'object') failures.push('test bounds missing');
  else {
    if (!(bounds.maxObjects >= 1 && bounds.maxObjects <= NATIVE_LIVE_MAX_OBJECTS)) failures.push(`bounded test must touch at most ${NATIVE_LIVE_MAX_OBJECTS} objects`);
    if (bounds.objectsTouched !== touched.size || touched.size > (bounds.maxObjects ?? 0)) failures.push('objects touched exceed or differ from the recorded bound');
    if (!(typeof bounds.elapsedMs === 'number' && bounds.elapsedMs >= 0 && bounds.elapsedMs <= NATIVE_LIVE_MAX_ELAPSED_MS)) {
      failures.push(`bounded test elapsed time must be recorded and at most ${NATIVE_LIVE_MAX_ELAPSED_MS / 60000} minutes`);
    }
  }
  return failures;
}
