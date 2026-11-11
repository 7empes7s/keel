/**
 * Issue #1073: attack simulation training. Graph v1.0 creates and updates only
 * simulations (POST and PATCH /security/attackSimulation/simulations); payloads,
 * login pages, landing pages, end-user notifications and automations are list
 * and get only, so they stay by hand (qualification.mjs cites the docs).
 *
 *  - A simulation is always written as a draft. Launching or scheduling one
 *    sends phishing emails to real people, so a restore never does it: every
 *    body says status 'draft', never carries launchDateTime, and
 *    assertDraftOnly() refuses any body that would launch. Launching is a
 *    manual step, and the simulation's results and history are never recreated.
 *  - Its payload, login page and landing page are bound with
 *    `payload@odata.bind`, `loginPage@odata.bind` and `landingPage@odata.bind`
 *    to the target's item: the same id, else the tenant's own item with the
 *    same name. A missing one holds the simulation (recreate it by hand first).
 *  - The people it targets (addressBook account target emails) must exist in
 *    the target; a missing one holds the simulation.
 *  - Graph changes only drafts, so an update of a launched simulation is a
 *    manual step. A simulation made by an automation is skipped: the automation
 *    makes its own.
 *  - Training, notification and app consent settings are not written (they
 *    name Microsoft's trainings and notifications by ids the backup does not
 *    read); the launch step asks a person to check them.
 *
 * Create answers 202 with no body, so the new simulation is found by its name.
 * Only create and update are registered. Fixture-tested, not live-qualified.
 */
import { remappingFor } from '../coverage/qualification.mjs';
import { readAllPages } from './approvalHeld.mjs';
import { applyRecordWrite, defineRecord } from './recordWriter.mjs';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const ROOT = '/security/attackSimulation';
export const SIMULATIONS = `${ROOT}/simulations`;
const PERMISSION = 'AttackSimulation.ReadWrite.All';
const PORTAL = 'the Microsoft Defender portal, under Email and collaboration, Attack simulation training';

/** The statuses that send emails: a restore never writes them. */
export const LAUNCHING_STATUSES = Object.freeze(['scheduled', 'running']);

// The content a simulation binds, in the order Graph's create names it.
const CONTENT = Object.freeze({
  payload: Object.freeze({ collection: 'payloads', words: 'payload', where: 'Content library, Payloads' }),
  loginPage: Object.freeze({ collection: 'loginPages', words: 'login page', where: 'Content library, Login pages' }),
  landingPage: Object.freeze({ collection: 'landingPages', words: 'landing page', where: 'Content library, Landing pages' }),
});
const TARGETS = Object.freeze(['includedAccountTarget', 'excludedAccountTarget']);

const lower = (value) => String(value ?? '').toLowerCase();
const odataText = (value) => String(value ?? '').replaceAll("'", "''");
const nameOf = (payload) => (payload?.displayName ? `"${payload.displayName}"` : 'this simulation');

/**
 * Throws when a simulation write body would launch or schedule it: a status
 * other than draft, or a launch date. Every write goes through this.
 */
export function assertDraftOnly(body) {
  if (lower(body?.status) !== 'draft') {
    throw new Error(`refused: an attack simulation is only ever written as a draft, and this body says status ${JSON.stringify(body?.status ?? null)}`);
  }
  if (body.launchDateTime !== undefined) throw new Error('refused: an attack simulation write never sets a launch date');
}

/** The emails an account target names (none for includeAll or an empty target). */
const targetEmails = (target) => (Array.isArray(target?.accountTargetEmails) ? target.accountTargetEmails.filter((email) => typeof email === 'string' && email) : []);
const sameTarget = (left, right) => lower(left?.type) === lower(right?.type)
  && JSON.stringify(targetEmails(left).map(lower).sort()) === JSON.stringify(targetEmails(right).map(lower).sort());
const sameContent = (left, right) => lower(left?.id) === lower(right?.id);

/** The manual step every written simulation carries: KEEL never launches it. */
function launchStep(payload) {
  const unwritten = ['trainingSetting', 'endUserNotificationSetting', 'oAuthConsentAppDetail'].filter((field) => payload?.[field] && Object.keys(payload[field]).length > 0);
  const check = unwritten.length ? ' Set its training, end-user notifications and app consent details again from the backup first: a restore does not write them.' : '';
  return Object.freeze({
    kind: 'manual-setting', requirement: 'attackSimulationLaunch', fields: Object.freeze(['status', 'launchDateTime', ...unwritten]),
    description: `KEEL restored ${nameOf(payload)} as a draft and never launches it, because launching sends phishing emails to real people.${check} `
      + `Launch it yourself in ${PORTAL}, Simulations, when it should run. Its results and history from before are not recreated.`,
  });
}

const held = (resource, fields, description) => ({
  skipped: {
    naturalKey: resource.naturalKey,
    reason: `manual: ${description}`,
    completion: [Object.freeze({ kind: 'manual-setting', requirement: 'attackSimulation', fields: Object.freeze(fields), description })],
  },
});
const failed = (resource, error) => ({ failed: { naturalKey: resource.naturalKey, error } });

/** The target's item for a backed-up payload, login page or landing page: { id }, { missing } or { error }. */
async function findContent(io, field, ref) {
  const { collection } = CONTENT[field];
  if (typeof ref?.id === 'string' && ref.id) {
    const byId = await io.retryOperation(() => io.writer.read('v1.0', `${ROOT}/${collection}/${encodeURIComponent(ref.id)}`));
    if (byId?.ok === true) return { id: byId.body?.id ?? ref.id };
    if (byId?.status !== 404) return { error: `the ${CONTENT[field].words} could not be read (status ${byId?.status ?? 'none'})` };
  }
  if (!ref?.displayName) return { missing: true };
  const listed = await readAllPages(io, 'v1.0', `${ROOT}/${collection}?$filter=source eq 'tenant' and displayName eq '${odataText(ref.displayName)}'`);
  if (listed.error) return { error: `the ${CONTENT[field].words}s could not be listed (${listed.error})` };
  const named = listed.value.filter((row) => lower(row?.displayName) === lower(ref.displayName));
  if (named.length > 1) return { ambiguous: true };
  return named.length === 1 ? { id: named[0].id } : { missing: true };
}

/** Whether a person with this email is in the target: true, false or { error }. */
async function personExists(io, email) {
  const listed = await readAllPages(io, 'v1.0', `/users?$filter=userPrincipalName eq '${odataText(email)}' or mail eq '${odataText(email)}'&$select=id,userPrincipalName,mail`);
  if (listed.error) return { error: `the people the simulation targets could not be looked up (${listed.error})` };
  return listed.value.some((row) => lower(row?.userPrincipalName) === lower(email) || lower(row?.mail) === lower(email));
}

/**
 * Points a backed-up simulation at the target: its content found by id or
 * name, and every person it targets present. Returns { resource }, { skipped } or { failed }.
 */
async function targetSimulation(io, resource, verb) {
  const payload = resource.payload;
  if (!payload || typeof payload !== 'object') return failed(resource, 'the backup holds no simulation to write');
  if (payload.isAutomated === true || (typeof payload.automationId === 'string' && payload.automationId)) {
    return { skipped: { naturalKey: resource.naturalKey, reason: `${nameOf(payload)} was made by an attack simulation automation, which makes its own simulations, so it is not recreated; recreate the automation by hand in ${PORTAL}, Automations` } };
  }
  const rewritten = { ...payload };
  // Only the content this verb sends: an update sends the payload alone.
  const fields = Object.keys(CONTENT).filter((field) => payload[field] && (verb === 'create' || field === 'payload'));
  for (const field of fields) {
    const found = await findContent(io, field, payload[field]);
    if (found.error) return failed(resource, `dependency: ${found.error}; nothing was written`);
    const { words, where } = CONTENT[field];
    const label = payload[field].displayName ? `the ${words} "${payload[field].displayName}"` : `its ${words}`;
    if (found.ambiguous) return held(resource, [field], `The target has more than one ${words} named "${payload[field].displayName}", so ${nameOf(payload)} was not restored. Rename or remove the extra one in ${PORTAL}, ${where}, then run the restore again.`);
    if (found.missing) return held(resource, [field], `${nameOf(payload)} uses ${label}, which is not in the target, so it was not restored. Recreate it in ${PORTAL}, ${where}, from the backup, then run the restore again.`);
    rewritten[field] = { ...payload[field], id: found.id };
  }
  const missing = [];
  for (const field of TARGETS) {
    for (const email of targetEmails(payload[field])) {
      const exists = await personExists(io, email);
      if (exists?.error) return failed(resource, `dependency: ${exists.error}; nothing was written`);
      if (!exists) missing.push(email);
    }
  }
  if (missing.length > 0) {
    return held(resource, TARGETS.filter((field) => payload[field]), `${nameOf(payload)} targets ${missing.length === 1 ? 'a person who is' : `${missing.length} people who are`} not in the target (${missing.join(', ')}), so it was not restored. Restore or create them first, or pick the people again in ${PORTAL}, Simulations.`);
  }
  const ids = (value) => fields.map((field) => lower(value[field]?.id));
  if (JSON.stringify(ids(payload)) !== JSON.stringify(ids(rewritten)) && !remappingFor(resource.resourceType, verb).qualified) {
    return failed(resource, `unqualified-remapping: attackSimulation ${verb} would bind other content ids, and reference remapping is not proven for this operation`);
  }
  // The content ids are matched here, against the target itself, so their stored references
  // (unresolvable GUIDs to canonicalize) are not checked again by the record.
  const references = (resource.references ?? []).filter((ref) => !CONTENT[String(ref?.field ?? '').split('.')[0]]);
  return { resource: { ...resource, payload: rewritten, references, backupPayload: resource.backupPayload ?? payload, backupReferences: resource.backupReferences ?? resource.references } };
}

/** The request Graph takes: the body with each content object as an @odata.bind, checked as a draft. */
export function simulationRequest(body) {
  const request = {};
  for (const [key, value] of Object.entries(body)) {
    if (CONTENT[key]) {
      if (value?.id) request[`${key}@odata.bind`] = `${GRAPH}${ROOT}/${CONTENT[key].collection}/${value.id}`;
      continue;
    }
    request[key] = value;
  }
  assertDraftOnly(request);
  return request;
}

/** The live simulation with this name, or the error: { found } (null when absent), { ambiguous } or { error }. */
async function findByName(io, displayName) {
  const listed = await readAllPages(io, 'v1.0', `${SIMULATIONS}?$filter=displayName eq '${odataText(displayName)}'`);
  if (listed.error) return { error: `the simulations could not be listed (${listed.error})` };
  const named = listed.value.filter((row) => row?.displayName === displayName);
  if (named.length > 1) return { ambiguous: true };
  return { found: named[0] ?? null };
}

async function simulationPreflight(io, { payload, verb }) {
  if (verb !== 'create') return null;
  // A simulation created by an earlier run (Graph gives it a new id) is found by its name.
  const live = await findByName(io, payload.displayName);
  if (live.error) return live.error;
  if (live.ambiguous || live.found) return { skipped: `the target already has a simulation named ${nameOf(payload)}, so nothing is written` };
  return null;
}

/** Graph changes only drafts: a launched simulation is left for a person. */
async function simulationUpdateGuard(io, { resource, targetId }) {
  const live = await io.retryOperation(() => io.writer.read('v1.0', `${SIMULATIONS}/${encodeURIComponent(targetId)}`));
  if (live?.ok !== true) return { reason: `the simulation could not be read to check it is still a draft (status ${live?.status ?? 'none'}), so nothing was written` };
  if (lower(live.body?.status) === 'draft') return null;
  const description = `${nameOf(resource.payload)} has already been launched (its status is ${live.body?.status ?? 'unknown'}), and Graph changes only draft simulations, so it was not changed. Compare it with the backup in ${PORTAL}, Simulations.`;
  return { reason: `manual: ${description}`, completion: [Object.freeze({ kind: 'manual-setting', requirement: 'attackSimulation', fields: Object.freeze(['status']), description })] };
}

async function simulationWrite(io, { verb, body, sent, targetId }) {
  let request;
  try {
    request = simulationRequest(verb === 'create' ? body : sent);
  } catch (error) {
    return { ok: false, status: null, error: error.message };
  }
  const path = verb === 'create' ? SIMULATIONS : `${SIMULATIONS}/${encodeURIComponent(targetId)}`;
  const result = await io.retryOperation(() => io.writer.write('v1.0', path, { method: verb === 'create' ? 'POST' : 'PATCH', body: request }));
  // 202 Accepted with no body: the simulation is read back by id, or by name after a create.
  return result?.ok ? { ok: true, status: result.status, body: null } : (result ?? { ok: false, error: `no response to the simulation ${verb}` });
}

/** The simulation with its payload, login page and landing page (each read on its own). */
async function simulationRead(io, { payload, targetId }) {
  let id = targetId;
  if (!id) {
    const live = await findByName(io, payload.displayName);
    if (live.error || live.ambiguous) return { ok: false, status: null, body: { error: live.error ?? 'more than one simulation has this name' } };
    if (!live.found) return { ok: false, status: 404, body: null };
    id = live.found.id;
  }
  const path = `${SIMULATIONS}/${encodeURIComponent(id)}`;
  const read = await io.retryOperation(() => io.writer.read('v1.0', path));
  if (read?.ok !== true) return read;
  const body = { ...read.body };
  for (const field of Object.keys(CONTENT)) {
    const part = await io.retryOperation(() => io.writer.read('v1.0', `${path}/${field}`));
    if (part?.ok === true && part.body?.id) body[field] = { id: part.body.id, displayName: part.body.displayName };
    else if (part?.ok !== true && part?.status !== 404) return { ok: false, status: part?.status ?? null, body: { error: `its ${CONTENT[field].words} could not be read` } };
  }
  return { ok: true, status: 200, body };
}

export const SIMULATION_RECORD = defineRecord({
  resourceType: 'attackSimulation', version: 'v1.0', collection: SIMULATIONS,
  operations: ['create', 'update'],
  // What Graph's update takes; a description, delivery platform, login page and
  // landing page are sent on create only.
  writable: ['displayName', 'attackTechnique', 'attackType', 'durationInDays', 'includedAccountTarget', 'excludedAccountTarget', 'payload'],
  createOnly: ['description', 'payloadDeliveryPlatform', 'loginPage', 'landingPage'],
  // Every body is a draft, whatever the backup's status was.
  transform: (body) => ({ ...body, status: 'draft' }),
  // Graph validates a draft's whole state on update, so every update sends it whole.
  updateSendsWhole: true,
  sameField: (field, desired, live) => (TARGETS.includes(field) ? sameTarget(desired, live) : CONTENT[field] ? sameContent(desired, live) : null),
  preflight: simulationPreflight, updateGuard: simulationUpdateGuard,
  writeVia: simulationWrite, readVia: simulationRead, writeRoute: SIMULATIONS,
  permission: PERMISSION, docs: 'https://learn.microsoft.com/en-us/graph/api/attacksimulationroot-post-simulation?view=graph-rest-1.0',
});

/** One simulation write: its content and people found in the target, then the record writes a draft. */
export async function applyAttackSimulationWrite(writer, resource, verb, ctx = {}) {
  if (resource.resourceType !== SIMULATION_RECORD.resourceType) return failed(resource, `${resource.resourceType} has no attack simulation record`);
  if (!SIMULATION_RECORD.operations.includes(verb)) return applyRecordWrite(writer, SIMULATION_RECORD, resource, verb, ctx);
  const io = { writer, retryOperation: ctx.retryOperation ?? ((operation) => operation()) };
  const targeted = await targetSimulation(io, resource, verb);
  if (!targeted.resource) return targeted;
  const result = await applyRecordWrite(writer, SIMULATION_RECORD, targeted.resource, verb, ctx);
  // A draft written (or planned) waits for a person to launch it; one already matching needs nothing.
  const { applied } = result;
  if (!applied || !(applied.changes?.fields?.length > 0)) return result;
  return { ...result, applied: { ...applied, completion: [...(applied.completion ?? []), launchStep(resource.payload)] } };
}
