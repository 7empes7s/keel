/**
 * Roadmap task-118: the ServiceNow non-default workflow live-acceptance gate.
 *
 * This is the evidence contract and its gate validator. It is registered in
 * tools/release/qualification.mjs (GATE_VALIDATORS) and checks the `subject` of a
 * record captured by tools/qualification/servicenowLive.mjs against the production
 * code it qualifies: the task-97 adapter (engine/itsm/adapters/servicenow.mjs) over the
 * task-96 canonical approval mirror (engine/itsm/bridge.mjs).
 *
 * What a passing subject proves, beyond the generic verifier (runner signature,
 * capture log digest, gate, tenant, freshness, --require-live):
 *  - identity: operation, build, credential mode, and every scenario belongs to the
 *    record's tenant;
 *  - prerequisites: tasks 96 and 97 are named; the instance was declared
 *    non-production by a named operator for exactly this host, and the instance did not
 *    report itself as production; the workflow mapping is complete under this build's
 *    serviceNowConfigProblems and is NOT the out-of-the-box change_request approval;
 *    callbacks are signed; at least two distinct test users are mapped to distinct
 *    KEEL principals, each acting under its own credential reference;
 *  - both directions of one non-default approval workflow, each with one canonical
 *    KEEL action:
 *      callback-duplicate  a signed instance callback decides once; its redelivery is a
 *                          duplicate; the decision is written back to the instance;
 *      lost-callback       the callback is withheld; a poll decides once, a second poll
 *                          is a duplicate, the late callback is already-decided;
 *      conflict            KEEL decided first in the portal; the instance's opposite
 *                          decision is a conflict, KEEL's decision stands and the
 *                          instance is told so;
 *      revoked-approver    a mapped test user whose KEEL grant was revoked approves in
 *                          the instance; the external "approved" state stays on the
 *                          record, and KEEL decides nothing and mints no job;
 *  - the capture log (bound by digest) shows every instance decision made by a declared
 *    test user under that user's own credential, no request by anyone else, and no KEEL
 *    write to the approval state field;
 *  - documentation retrieval is recorded, and no credential material is in the record.
 *
 * It never sends a request and never enables anything.
 */
import {
  SERVICENOW_ADAPTER_NAME, SERVICENOW_DOC_SOURCE, serviceNowConfigProblems,
} from '../../engine/itsm/adapters/servicenow.mjs';
import { secretProblems } from './sharepointAcceptance.mjs';

export const SERVICENOW_LIVE_GATE = 'servicenow-live-acceptance';
export const SERVICENOW_LIVE_OPERATION = 'servicenow.non-default-workflow-qualification';
export const SERVICENOW_LIVE_CREDENTIAL_MODE = 'keel-oauth-reference+test-user-references';
export const SERVICENOW_LIVE_PREREQUISITES = Object.freeze(['task-96', 'task-97']);
export const SERVICENOW_LIVE_SCENARIOS = Object.freeze(['callback-duplicate', 'lost-callback', 'conflict', 'revoked-approver']);
export const SERVICENOW_MIN_TEST_USERS = 2;
// The instance-side relay table the shipped business rule writes signed callbacks into.
export const SERVICENOW_RELAY_FIELDS = Object.freeze({ record: 'u_record', signature: 'u_signature', body: 'u_body' });
// The ServiceNow system property that marks a production instance.
export const SERVICENOW_PRODUCTION_PROPERTY = 'glide.installation.production';
export const SERVICENOW_PRODUCTION_FLAGS = Object.freeze(['false', 'absent', 'unreadable', 'true']);
export const SERVICENOW_CAPTURE_WINDOW_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const SYS_ID = /^[0-9a-f]{32}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const CREDENTIAL_REF = /^env:[A-Z_][A-Z0-9_]{0,127}$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The documentation the qualified behaviour was declared from. */
export function serviceNowRequiredDocumentation() {
  return [SERVICENOW_DOC_SOURCE.url];
}

/**
 * True when a mapping is the out-of-the-box change_request approval: its own table,
 * its `approval` field and only the stock `approved` / `rejected` values. Task-118
 * qualifies a workflow that is NOT this.
 */
export function serviceNowWorkflowIsDefault({ table, fields, approvedValues, rejectedValues }) {
  const only = (values, stock) => Array.isArray(values) && values.length > 0 && values.every((value) => value === stock);
  return table === 'change_request' && fields?.state === 'approval'
    && only(approvedValues, 'approved') && only(rejectedValues, 'rejected');
}

/** The adapter config a recorded workflow mapping stands for (references only). */
export function serviceNowConfigFromWorkflow(subject) {
  const workflow = subject?.workflow ?? {};
  return {
    instanceUrl: `https://${subject?.instance?.host ?? ''}`,
    table: workflow.table,
    credential: { tokenRef: subject?.credentials?.keel },
    fields: workflow.fields,
    states: { approved: workflow.approvedValues, rejected: workflow.rejectedValues },
    ...(subject?.credentials?.callbackSigning
      ? { callback: { secretRef: subject.credentials.callbackSigning, maxSkewSeconds: workflow.callbackWindowSeconds } }
      : {}),
  };
}

function captureTimeProblems(label, capturedAt, observedAt) {
  const at = Date.parse(capturedAt ?? '');
  if (Number.isNaN(at)) return [`${label}: no valid capture time`];
  if (Number.isNaN(observedAt)) return [];
  if (at > observedAt + CLOCK_SKEW_MS) return [`${label}: captured after the record was observed`];
  if (observedAt - at > SERVICENOW_CAPTURE_WINDOW_MS) return [`${label}: captured more than 24h before the record (stale capture)`];
  return [];
}

function prerequisiteProblems(subject, observedAt) {
  const failures = [];
  const named = new Set(Array.isArray(subject.prerequisites) ? subject.prerequisites : []);
  for (const task of SERVICENOW_LIVE_PREREQUISITES) if (!named.has(task)) failures.push(`missing prerequisite: ${task}`);

  // The instance: declared non-production for exactly this host, and not self-reported production.
  const instance = subject.instance ?? {};
  if (typeof instance.host !== 'string' || !HOST_RE.test(instance.host)) failures.push('missing prerequisite: no instance host');
  const declaration = instance.declaredNonProduction ?? {};
  if (declaration.host !== instance.host) failures.push('missing prerequisite: the instance was not declared non-production by the operator');
  if (typeof declaration.declaredBy !== 'string' || !declaration.declaredBy.trim()) failures.push('missing prerequisite: the non-production declaration names no operator');
  failures.push(...captureTimeProblems('non-production declaration', declaration.declaredAt, observedAt));
  if (!SERVICENOW_PRODUCTION_FLAGS.includes(instance.productionFlag)) failures.push('the instance production flag was not recorded');
  if (instance.productionFlag === 'true') failures.push(`the instance reports ${SERVICENOW_PRODUCTION_PROPERTY}=true: a production instance is refused`);

  // The workflow: complete under this build, non-default, signed callbacks.
  const workflow = subject.workflow ?? {};
  for (const item of serviceNowConfigProblems(serviceNowConfigFromWorkflow(subject))) {
    failures.push(`missing prerequisite: workflow mapping ${item.code} (${item.message})`);
  }
  if (!subject.credentials?.callbackSigning) failures.push('missing prerequisite: callbacks are not signed');
  if (serviceNowWorkflowIsDefault(workflow)) failures.push('the workflow is the out-of-the-box change_request approval, not a non-default workflow');
  if (workflow.isDefault !== false) failures.push('the record does not state the workflow is non-default');
  if (typeof workflow.relayTable !== 'string' || !/^u_[a-z0-9_]{1,78}$/.test(workflow.relayTable)) {
    failures.push('missing prerequisite: no callback relay table');
  }

  // Test users: at least two, distinct, mapped, each with its own credential reference.
  const users = Array.isArray(subject.testUsers) ? subject.testUsers : [];
  if (users.length < SERVICENOW_MIN_TEST_USERS) failures.push(`missing prerequisite: at least ${SERVICENOW_MIN_TEST_USERS} mapped test users are needed, found ${users.length}`);
  const names = new Set();
  const principals = new Set();
  const refs = new Set([subject.credentials?.keel, subject.credentials?.callbackSigning]);
  for (const [index, user] of users.entries()) {
    if (typeof user?.externalUser !== 'string' || !user.externalUser) failures.push(`test user ${index}: no external user`);
    else if (names.has(user.externalUser)) failures.push(`test user ${index}: listed twice`);
    names.add(user?.externalUser);
    if (typeof user?.principalId !== 'string' || !user.principalId) failures.push(`missing prerequisite: test user ${user?.externalUser ?? index} is not mapped to a KEEL principal`);
    else if (principals.has(user.principalId)) failures.push(`test user ${user.externalUser}: shares a KEEL principal with another test user`);
    principals.add(user?.principalId);
    if (typeof user?.credentialRef !== 'string' || !CREDENTIAL_REF.test(user.credentialRef)) failures.push(`test user ${user?.externalUser ?? index}: no credential reference`);
    else if (refs.has(user.credentialRef)) failures.push(`test user ${user.externalUser}: shares a credential with KEEL or another test user`);
    refs.add(user?.credentialRef);
  }
  const keelPrincipals = subject.keelPrincipals ?? {};
  for (const role of ['requester', 'portalApprover']) {
    if (typeof keelPrincipals[role] !== 'string' || !keelPrincipals[role]) failures.push(`missing prerequisite: no KEEL ${role} principal`);
    else if (principals.has(keelPrincipals[role])) failures.push(`the KEEL ${role} is also a test user's principal`);
  }
  return failures;
}

const stepsOf = (scenario) => (Array.isArray(scenario?.steps) ? scenario.steps : []);
const actions = (scenario, action) => stepsOf(scenario).filter((step) => step?.action === action);
const order = (scenario, action) => stepsOf(scenario).findIndex((step) => step?.action === action);

/** What each scenario must show: its steps in order, their outcomes, and the canonical result. */
function scenarioExpectationProblems(subject, scenario) {
  const failures = [];
  const label = `scenario ${scenario.name}`;
  const workflow = subject.workflow ?? {};
  const approved = Array.isArray(workflow.approvedValues) ? workflow.approvedValues : [];
  const users = new Map((subject.testUsers ?? []).map((user) => [user?.externalUser, user]));
  const keelPrincipals = subject.keelPrincipals ?? {};
  const canonical = scenario.canonical ?? {};
  const decisions = Array.isArray(canonical.decisions) ? canonical.decisions : [];
  const after = scenario.instanceAfter ?? {};
  const callbacks = actions(scenario, 'callback');
  const polls = actions(scenario, 'poll');
  const outcomesOf = (steps) => steps.map((step) => `${step.outcome}${step.duplicate ? ' (duplicate)' : ''}`).join(', ');

  // KEEL -> ServiceNow: the plan reached the record before anyone decided.
  const [delivered] = actions(scenario, 'outbound-record');
  const [readback] = actions(scenario, 'readback-record');
  if (delivered?.outcome !== 'delivered') failures.push(`${label}: the plan was not delivered to the instance`);
  if (readback?.outcome !== 'match') failures.push(`${label}: the instance did not read back the plan version, digest and request KEEL wrote`);
  if (after.planVersion !== String(scenario.version) || after.planDigest !== scenario.planDigest || after.keelRequest !== String(scenario.requestId)) {
    failures.push(`${label}: the instance record does not carry this scenario's plan`);
  }

  // ServiceNow -> KEEL: one decision in the instance, made by a declared test user.
  const decides = actions(scenario, 'decide');
  if (decides.length !== 1) failures.push(`${label}: expected one decision in the instance, found ${decides.length}`);
  const [decide] = decides;
  const user = users.get(decide?.actor);
  if (decide && !user) failures.push(`${label}: the instance decision was made by '${decide.actor}', not a declared test user`);
  if (decide && !approved.includes(decide.value)) failures.push(`${label}: the instance decision is not one of the workflow's approved values`);
  if (order(scenario, 'decide') < order(scenario, 'readback-record')) failures.push(`${label}: the instance decided before KEEL's plan reached it`);
  if (!approved.includes(after.state)) failures.push(`${label}: the instance record does not show the external approval`);
  if (decide && after.approver !== decide.actor) failures.push(`${label}: the instance does not name the test user who decided`);

  const jobs = canonical.jobs;
  const one = (outcome, source, decidedBy) => {
    if (canonical.requestStatus !== outcome) failures.push(`${label}: the KEEL request is '${canonical.requestStatus ?? 'missing'}', expected '${outcome}'`);
    if (decisions.length !== 1) failures.push(`${label}: expected one canonical decision, found ${decisions.length}`);
    const [decision] = decisions;
    if (decision && (decision.outcome !== outcome || decision.source !== source || decision.decidedBy !== decidedBy
        || decision.version !== scenario.version)) {
      failures.push(`${label}: the canonical decision is not ${outcome} by the expected principal from ${source} for version ${scenario.version}`);
    }
    if (decision && !after.keelDecision?.startsWith(`KEEL decision: ${outcome}`)) failures.push(`${label}: the instance was not told KEEL's decision`);
    return decision;
  };

  switch (scenario.name) {
    case 'callback-duplicate': {
      if (outcomesOf(callbacks) !== 'applied, applied (duplicate)') failures.push(`${label}: callbacks were [${outcomesOf(callbacks)}], expected [applied, applied (duplicate)]`);
      if (callbacks.length === 2 && callbacks[0].eventId !== callbacks[1].eventId) failures.push(`${label}: the redelivered callback has another event id`);
      const decision = one('approved', 'itsm', user?.principalId);
      if (decision && decision.externalEventId !== callbacks[0]?.eventId) failures.push(`${label}: the decision did not come from the signed callback`);
      if (jobs !== 1) failures.push(`${label}: one canonical KEEL action expected, found ${jobs} jobs`);
      break;
    }
    case 'lost-callback': {
      const withheld = actions(scenario, 'callback-withheld');
      if (withheld.length !== 1) failures.push(`${label}: no callback was withheld`);
      if (outcomesOf(polls) !== 'applied, applied (duplicate)') failures.push(`${label}: polls were [${outcomesOf(polls)}], expected [applied, applied (duplicate)]`);
      if (outcomesOf(callbacks) !== 'already-decided') failures.push(`${label}: the late callback was [${outcomesOf(callbacks)}], expected [already-decided]`);
      if (callbacks[0] && withheld[0] && callbacks[0].eventId !== withheld[0].eventId) failures.push(`${label}: the late callback is not the one withheld`);
      if (order(scenario, 'callback') < order(scenario, 'poll')) failures.push(`${label}: the late callback arrived before the poll`);
      const decision = one('approved', 'itsm', user?.principalId);
      if (decision && !String(decision.externalEventId ?? '').startsWith('reconcile:')) failures.push(`${label}: the decision did not come from the poll`);
      if (jobs !== 1) failures.push(`${label}: one canonical KEEL action expected, found ${jobs} jobs`);
      break;
    }
    case 'conflict': {
      const [portal] = actions(scenario, 'portal-decision');
      if (portal?.outcome !== 'rejected' || portal?.actor !== keelPrincipals.portalApprover) failures.push(`${label}: KEEL did not reject it in the portal first`);
      if (order(scenario, 'portal-decision') > order(scenario, 'decide')) failures.push(`${label}: the portal decision was not first`);
      if (outcomesOf(callbacks) !== 'conflict') failures.push(`${label}: the instance approval was [${outcomesOf(callbacks)}], expected [conflict]`);
      const [conflictOut] = actions(scenario, 'outbound-conflict');
      if (conflictOut?.outcome !== 'delivered') failures.push(`${label}: the conflict was not written back to the instance`);
      one('rejected', 'portal', keelPrincipals.portalApprover);
      if (!String(after.keelDecision ?? '').includes("KEEL's decision stands")) failures.push(`${label}: the instance does not show that KEEL's decision stands`);
      if (jobs !== 0) failures.push(`${label}: a rejected request minted ${jobs} jobs`);
      break;
    }
    case 'revoked-approver': {
      const [revoke] = actions(scenario, 'revoke-grant');
      if (!revoke || revoke.outcome !== 'revoked' || !user || revoke.principalId !== user.principalId) {
        failures.push(`${label}: the deciding test user's KEEL grant was not revoked first`);
      }
      if (order(scenario, 'revoke-grant') > order(scenario, 'decide')) failures.push(`${label}: the grant was revoked after the instance decision`);
      if (outcomesOf(callbacks) !== 'refused-not-eligible') failures.push(`${label}: the revoked approver's approval was [${outcomesOf(callbacks)}], expected [refused-not-eligible]`);
      // The external approved state is on the record; it is not authority on its own.
      if (canonical.requestStatus !== 'pending') failures.push(`${label}: an external approval from a revoked approver changed the KEEL request to '${canonical.requestStatus}'`);
      if (decisions.length !== 0) failures.push(`${label}: an external approval from a revoked approver recorded a canonical decision`);
      if (jobs !== 0) failures.push(`${label}: an external approval from a revoked approver minted ${jobs} jobs`);
      break;
    }
    default:
      failures.push(`${label}: unknown scenario`);
  }
  if (!Number.isInteger(jobs) || jobs > 1) failures.push(`${label}: more than one canonical KEEL action (${jobs} jobs)`);
  return failures;
}

function scenarioProblems(evidence, subject, observedAt) {
  const failures = [];
  const scenarios = Array.isArray(subject.scenarios) ? subject.scenarios : [];
  const byName = new Map();
  for (const scenario of scenarios) {
    if (byName.has(scenario?.name)) failures.push(`scenario ${scenario?.name}: recorded twice`);
    byName.set(scenario?.name, scenario);
  }
  for (const name of SERVICENOW_LIVE_SCENARIOS) if (!byName.has(name)) failures.push(`missing scenario: ${name}`);
  const sysIds = new Set();
  for (const scenario of scenarios) {
    const label = `scenario ${scenario?.name ?? '?'}`;
    if (scenario?.tenantRef !== evidence.tenantRef) failures.push(`${label}: belongs to another tenant`);
    if (typeof scenario?.sysId !== 'string' || !SYS_ID.test(scenario.sysId)) failures.push(`${label}: no instance record sys_id`);
    else if (sysIds.has(scenario.sysId)) failures.push(`${label}: reuses another scenario's instance record`);
    sysIds.add(scenario?.sysId);
    if (!Number.isInteger(scenario?.version) || scenario.version < 1) failures.push(`${label}: no plan version`);
    if (typeof scenario?.planDigest !== 'string' || !scenario.planDigest) failures.push(`${label}: no plan digest`);
    for (const [index, step] of stepsOf(scenario).entries()) {
      failures.push(...captureTimeProblems(`${label} step ${index} (${step?.action ?? '?'})`, step?.at, observedAt));
      if (index > 0 && Date.parse(step?.at) < Date.parse(stepsOf(scenario)[index - 1]?.at)) failures.push(`${label} step ${index}: out of order`);
    }
    if (SERVICENOW_LIVE_SCENARIOS.includes(scenario?.name)) failures.push(...scenarioExpectationProblems(subject, scenario));
  }
  return failures;
}

/**
 * The capture log, read back from its digest-verified bytes: every instance decision
 * was a PATCH by that test user under that user's credential, nobody but KEEL and the
 * declared test users called the instance, and KEEL never wrote the approval state field.
 */
function captureLogProblems(subject, artifact) {
  if (!artifact?.ok) return [];
  let log;
  try {
    log = JSON.parse(Buffer.from(artifact.bytes).toString('utf8'));
  } catch {
    return ['the capture log is not JSON'];
  }
  const failures = [];
  const calls = Array.isArray(log?.calls) ? log.calls : [];
  if (log?.runId !== subject.runId) failures.push('the capture log belongs to another run');
  const users = new Map((subject.testUsers ?? []).map((user) => [user?.externalUser, user]));
  const stateField = subject.workflow?.fields?.state;
  for (const [index, call] of calls.entries()) {
    if (call?.host !== subject.instance?.host) failures.push(`capture log call ${index}: sent to another host`);
    if (call?.actor === 'keel') {
      if (call.credentialRef !== subject.credentials?.keel) failures.push(`capture log call ${index}: KEEL used another credential`);
      if (call.method === 'PATCH' && Array.isArray(call.fields) && call.fields.includes(stateField)) failures.push(`capture log call ${index}: KEEL wrote the approval state field`);
    } else if (!users.has(call?.actor)) {
      failures.push(`capture log call ${index}: made by '${call?.actor}', who is neither KEEL nor a declared test user`);
    } else if (call.credentialRef !== users.get(call.actor).credentialRef) {
      failures.push(`capture log call ${index}: test user ${call.actor} acted under another credential`);
    }
  }
  for (const scenario of Array.isArray(subject.scenarios) ? subject.scenarios : []) {
    for (const decide of actions(scenario, 'decide')) {
      const made = calls.some((call) => call?.actor === decide.actor && call.method === 'PATCH' && call.sysId === scenario.sysId
        && Array.isArray(call.fields) && call.fields.includes(stateField) && call.status >= 200 && call.status < 300);
      if (!made) failures.push(`scenario ${scenario.name}: the capture log has no PATCH by ${decide.actor} setting the approval state`);
    }
  }
  return failures;
}

/**
 * Gate validator for the task-118 record. Returns failure reasons; empty means the
 * subject holds. `runner` is the release verifier's runner-proof result.
 */
export function validateServiceNowLiveSubject(evidence, context = {}) {
  const { tenantRef, build, artifact, runner } = context;
  const failures = [];
  if (evidence.status === 'pending') return ['ServiceNow live evidence pending: no record has been captured'];
  // Both proofs: the runner signature over the record and the digest of its raw log.
  if (!runner?.ok) failures.push(`ServiceNow runner proof required (${runner?.reason ?? 'not checked'})`);
  if (!artifact?.ok) failures.push(`ServiceNow capture artifact required (${artifact?.reason ?? 'not checked'})`);
  if (evidence.evidenceLevel === 'live-qualified' && (evidence.synthetic !== false || runner?.synthetic)) {
    failures.push('ServiceNow fixture evidence cannot claim live qualification');
  }
  if (!tenantRef || !build) failures.push('ServiceNow expected tenant/build identity required');
  if (build && evidence.build !== build) failures.push(`ServiceNow build mismatch: evidence is '${evidence.build}', required '${build}'`);
  if (evidence.operation !== SERVICENOW_LIVE_OPERATION) {
    failures.push(`ServiceNow operation mismatch: expected '${SERVICENOW_LIVE_OPERATION}', got '${evidence.operation ?? 'missing'}'`);
  }
  if (evidence.credentialMode !== SERVICENOW_LIVE_CREDENTIAL_MODE) failures.push(`ServiceNow requires credential mode '${SERVICENOW_LIVE_CREDENTIAL_MODE}'`);
  failures.push(...secretProblems(evidence));

  const subject = evidence.subject;
  if (!subject || typeof subject !== 'object') return [...failures, 'subject is missing'];
  const observedAt = Date.parse(evidence.observedAt ?? '');
  if (typeof subject.runId !== 'string' || !/^[\w.:-]+$/.test(subject.runId)) failures.push('no run id');
  if (subject.adapter !== SERVICENOW_ADAPTER_NAME) failures.push(`the record is not for the ${SERVICENOW_ADAPTER_NAME} adapter`);

  failures.push(...prerequisiteProblems(subject, observedAt));
  failures.push(...scenarioProblems(evidence, subject, observedAt));
  failures.push(...captureLogProblems(subject, artifact));

  // The raw capture log is bound into the signed subject.
  if (typeof subject.captureLogSha256 !== 'string' || !SHA256_RE.test(subject.captureLogSha256)
      || subject.captureLogSha256 !== evidence.proof?.artifact?.sha256) {
    failures.push('the capture log digest is not bound to the signed subject');
  }

  const docs = Array.isArray(subject.documentation) ? subject.documentation : [];
  for (const url of serviceNowRequiredDocumentation()) {
    const entry = docs.find((item) => item?.url === url);
    if (!entry || Number.isNaN(Date.parse(entry.retrievedAt ?? ''))) failures.push(`documentation not retrieved: ${url}`);
  }
  return failures;
}
