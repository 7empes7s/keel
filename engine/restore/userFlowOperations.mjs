/**
 * Issue #995: guest sign-up user flows (b2xIdentityUserFlow) and the custom
 * attributes they ask for (identityUserFlowAttribute).
 *
 * A user flow decides who can sign themselves up as a guest, so every write to
 * one sits behind the restore approval (restore/approvalHeld.mjs, "access-changing"
 * effects on its kind and its parts). A missing flow is created with its name
 * (B2X_1_<name>), kind and version; then, and on an existing flow, its parts are
 * made to hold what the backup holds:
 *
 *  - identity providers: one the flow lacks is added when the tenant has it set
 *    up (only a reference to it is sent, never a client id or secret); one the
 *    tenant does not have is a manual step. One the flow has that the backup
 *    does not is never taken away (a manual step).
 *  - attribute assignments: added (when the attribute exists live) or updated,
 *    then put in the backup's order. A custom attribute is matched in the target
 *    by name when its id (which carries the tenant's extension app id) differs.
 *  - languages: turned on or off as in the backup. Custom page text is not
 *    backed up.
 *  - API connectors: the backup's connector at each step is bound again when it
 *    exists live (by id, else by name). A missing connector is a manual step: its
 *    password or certificate is never readable, so KEEL never makes one.
 *
 * A flow is never deleted. A custom attribute is created or its description
 * updated; a built-in one is Microsoft's and is skipped. Its data type cannot
 * change after it is made, so a different data type live is a manual step,
 * never a delete.
 *
 * Issue #1008: an API connector (identityApiConnector) is created and updated
 * behind the restore approval: its name and target URL only. Graph never
 * returns its password or certificate, and a create must carry one, so a
 * create sends basic authentication under a random name and password nobody
 * ever sees (never the backup's authenticationConfiguration). The connector
 * therefore cannot call its API until a person sets the real password or
 * certificate, which every write lists as a step. This writer never binds a
 * connector to a user flow; the flow's own writer does that.
 *
 * Routes follow the Graph v1.0 references and are fixture-tested, not
 * live-qualified.
 */
import { randomBytes } from 'node:crypto';

import { defineRecord, outcomeDetail, sameValue } from './recordWriter.mjs';
import { createdOnce, readAllPages, withApprovalGate } from './approvalHeld.mjs';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const DOCS = 'https://learn.microsoft.com/en-us/graph/api';
const v1 = (page) => `${DOCS}/${page}?view=graph-rest-1.0`;

export const USER_FLOWS = '/identity/b2xUserFlows';
export const USER_FLOW_ATTRIBUTES = '/identity/userFlowAttributes';
const IDENTITY_PROVIDERS = '/identity/identityProviders';
const API_CONNECTORS = '/identity/apiConnectors';
const FLOW_PREFIX = 'B2X_1_';
const USER_FLOW_PORTAL = 'Entra admin center > External Identities > User flows';
const PROVIDERS_PORTAL = 'Entra admin center > External Identities > All identity providers';
const CONNECTORS_PORTAL = 'Entra admin center > External Identities > API connectors';

// The steps of a flow an API connector can run at (userFlowApiConnectorConfiguration).
export const API_CONNECTOR_STEPS = Object.freeze(['postFederationSignup', 'postAttributeCollection']);
// What an attribute assignment says about how the attribute is asked; its attribute is set on create.
export const ASSIGNMENT_FIELDS = Object.freeze(['displayName', 'isOptional', 'requiresVerification', 'userInputType', 'userAttributeValues']);
// The parts of a flow written after it (its approval fields other than its kind).
const FLOW_PARTS = Object.freeze(['identityProviders', 'userAttributeAssignments', 'languages', 'apiConnectorConfiguration']);

const lower = (value) => String(value ?? '').toLowerCase();
const flowPath = (targetId) => `${USER_FLOWS}/${encodeURIComponent(targetId)}`;
const step = (requirement, description) => Object.freeze({ kind: 'manual-setting', requirement, description });
const list = (value) => (Array.isArray(value) ? value : []);
const attributeIdOf = (assignment) => assignment?.userAttribute?.id ?? assignment?.id ?? null;
const isCustomId = (id) => /^extension_/i.test(String(id ?? ''));

/** The body of a user flow create: its name without the B2X_1_ Graph adds, its kind and version. */
function userFlowBody(body, { verb, payload }) {
  // The parts are written after the flow (afterWrite), never in its own body.
  const out = Object.fromEntries(Object.entries(body).filter(([field]) => !FLOW_PARTS.includes(field)));
  if (verb !== 'create') return out;
  const name = String(payload?.id ?? '');
  return { id: name.startsWith(FLOW_PREFIX) ? name.slice(FLOW_PREFIX.length) : name, ...out };
}

/** Reads one list, or fails the restore with what could not be read. */
async function readList(io, path, label) {
  const listed = await readAllPages(io, 'v1.0', path);
  if (listed.error) return { error: `could not read the ${label} (${listed.error})` };
  return { value: listed.value };
}

/** The flow's parts as they are live, read from their own routes. */
async function liveParts(io, targetId) {
  if (!targetId) return { identityProviders: [], userAttributeAssignments: [], languages: [], apiConnectorConfiguration: {} };
  const base = flowPath(targetId);
  const providers = await readList(io, `${base}/identityProviders`, 'user flow\'s identity providers');
  if (providers.error) return providers;
  const assignments = await readList(io, `${base}/userAttributeAssignments?$expand=userAttribute`, 'user flow\'s attributes');
  if (assignments.error) return assignments;
  const languages = await readList(io, `${base}/languages`, 'user flow\'s languages');
  if (languages.error) return languages;
  const connectors = await io.retryOperation(() => io.writer.read('v1.0',
    `${base}?$expand=apiConnectorConfiguration/postFederationSignup,apiConnectorConfiguration/postAttributeCollection`));
  if (connectors?.ok !== true) return { error: `could not read the user flow's API connectors (${outcomeDetail(connectors)})` };
  return {
    identityProviders: providers.value, userAttributeAssignments: assignments.value, languages: languages.value,
    apiConnectorConfiguration: connectors.body?.apiConnectorConfiguration ?? {},
  };
}

/** What the tenant has set up: identity providers, user flow attributes and API connectors. */
async function tenantParts(io) {
  const providers = await readList(io, IDENTITY_PROVIDERS, 'identity providers');
  if (providers.error) return providers;
  const attributes = await readList(io, USER_FLOW_ATTRIBUTES, 'user flow attributes');
  if (attributes.error) return attributes;
  const connectors = await readList(io, API_CONNECTORS, 'API connectors');
  if (connectors.error) return connectors;
  return { providers: providers.value, attributes: attributes.value, connectors: connectors.value };
}

/**
 * The live attribute a backed-up assignment's attribute is, or null: the same id,
 * else (a custom attribute, whose id carries the tenant's extension app id) a
 * custom attribute with the same name.
 */
// The name the restore approval shows for an attribute (safety/contentEffects.mjs).
const nameFromId = (id) => String(id ?? '').replace(/^extension_[0-9a-f]{32}_/i, '');

function liveAttributeFor(assignment, attributes) {
  const id = attributeIdOf(assignment);
  const same = attributes.find((attribute) => lower(attribute?.id) === lower(id));
  if (same) return same;
  if (!isCustomId(id)) return null;
  // Only the name the approval showed is matched: the name in the id, which the
  // backup's display name and the live attribute's id and name must all agree with.
  const name = nameFromId(id);
  const shown = assignment?.userAttribute?.displayName;
  if (shown && lower(shown) !== lower(name)) return null;
  const named = attributes.filter((attribute) => attribute?.userFlowAttributeType === 'custom'
    && lower(attribute?.displayName) === lower(name) && lower(nameFromId(attribute?.id)) === lower(name));
  return named.length === 1 ? named[0] : null;
}

const assignmentBody = (assignment, attributeId) => ({
  ...Object.fromEntries(ASSIGNMENT_FIELDS.map((field) => [field, assignment?.[field] ?? (field === 'userAttributeValues' ? [] : null)])
    .filter(([, value]) => value !== null)),
  userAttribute: { id: attributeId },
});

const assignmentDiffers = (desired, live) => ASSIGNMENT_FIELDS.filter((field) => !sameValue(
  field === 'userAttributeValues' ? list(desired?.[field]) : desired?.[field],
  field === 'userAttributeValues' ? list(live?.[field]) : live?.[field],
));

/**
 * A connector the tenant has: the backup's by id, else the one with its name. The
 * restore approval shows a connector by its name, so a connector is bound only when
 * its name is the backup's (an id match under another name is not used).
 */
function liveConnectorFor(connector, connectors) {
  const byId = connectors.find((candidate) => lower(candidate?.id) === lower(connector?.id)
    && (!connector?.displayName || lower(candidate?.displayName) === lower(connector.displayName)));
  if (byId) return byId;
  const named = connectors.filter((candidate) => connector?.displayName && lower(candidate?.displayName) === lower(connector.displayName));
  return named.length === 1 ? named[0] : null;
}

/**
 * The writes and manual steps that make the flow's parts hold the backup's.
 * Every write body names only ids, flags and the attribute questions: never an
 * identity provider's or connector's secret, certificate or sign-in address.
 */
export function planUserFlowParts(payload, live, tenant, targetId) {
  const base = flowPath(targetId ?? payload?.id ?? '');
  const writes = [];
  const steps = [];
  const name = payload?.id ?? 'this user flow';

  // Identity providers: added when the tenant has them, never taken away.
  const onFlow = new Set(list(live.identityProviders).map((provider) => lower(provider?.id)));
  const inTenant = new Set(list(tenant.providers).map((provider) => lower(provider?.id)));
  const wanted = list(payload?.identityProviders).map((provider) => provider?.id).filter(Boolean);
  for (const id of wanted) {
    if (onFlow.has(lower(id))) continue;
    if (!inTenant.has(lower(id))) {
      steps.push(step(`identityProvider:${id}`, `The identity provider ${id} is not set up in this tenant, so it was not added to ${name}. `
        + `Set it up in ${PROVIDERS_PORTAL} (its client id and secret are never backed up), then add it to the flow in ${USER_FLOW_PORTAL}.`));
      continue;
    }
    writes.push({ part: 'identityProviders', id, method: 'POST', path: `${base}/identityProviders/$ref`, body: { '@odata.id': `${GRAPH}/identityProviders/${encodeURIComponent(id)}` } });
  }
  const extraProviders = list(live.identityProviders).map((provider) => provider?.id).filter((id) => id && !wanted.some((want) => lower(want) === lower(id)));
  if (extraProviders.length > 0) {
    steps.push(step('identityProvider:extra', `${name} also lets guests sign up with ${extraProviders.join(', ')}, which the backup does not. `
      + `A restore never takes an identity provider away: remove it by hand in ${USER_FLOW_PORTAL} if it should go.`));
  }

  // Attribute assignments: added or updated, then put in the backup's order.
  const liveAssignments = list(live.userAttributeAssignments);
  const order = [];
  for (const assignment of list(payload?.userAttributeAssignments)) {
    const backupId = attributeIdOf(assignment);
    const attribute = liveAttributeFor(assignment, list(tenant.attributes));
    if (!attribute) {
      steps.push(step(`userAttribute:${backupId}`, `The attribute ${assignment?.userAttribute?.displayName ?? assignment?.displayName ?? backupId} is not in this tenant, so ${name} does not ask for it. `
        + `Restore the custom attribute first (or create it in Entra admin center > External Identities > Custom user attributes), then run the restore again.`));
      continue;
    }
    order.push(attribute.id);
    const current = liveAssignments.find((held) => lower(attributeIdOf(held)) === lower(attribute.id));
    if (!current) {
      writes.push({ part: 'userAttributeAssignments', id: attribute.id, method: 'POST', path: `${base}/userAttributeAssignments`, body: assignmentBody(assignment, attribute.id) });
      continue;
    }
    const differs = assignmentDiffers(assignment, current);
    if (differs.length > 0) {
      writes.push({
        part: 'userAttributeAssignments', id: attribute.id, method: 'PATCH', path: `${base}/userAttributeAssignments/${encodeURIComponent(current.id ?? attribute.id)}`,
        body: Object.fromEntries(differs.map((field) => [field, field === 'userAttributeValues' ? list(assignment[field]) : assignment[field] ?? null])),
      });
    }
  }
  const liveOrder = liveAssignments.map((held) => attributeIdOf(held)).filter((id) => order.some((want) => lower(want) === lower(id)));
  const added = writes.some((write) => write.part === 'userAttributeAssignments' && write.method === 'POST');
  if (order.length > 1 && (added || !sameValue(liveOrder.map(lower), order.map(lower)))) {
    // Graph's setOrder lists every attribute the flow asks for: the backup's, then any others live has.
    const others = liveAssignments.map((held) => attributeIdOf(held)).filter((id) => id && !order.some((want) => lower(want) === lower(id)));
    writes.push({ part: 'userAttributeOrder', method: 'POST', path: `${base}/userAttributeAssignments/setOrder`, body: { newAssignmentOrder: { order: [...order, ...others] } } });
  }
  const extraAttributes = liveAssignments.map((held) => attributeIdOf(held)).filter((id) => id && !order.some((want) => lower(want) === lower(id))
    && !list(payload?.userAttributeAssignments).some((assignment) => lower(attributeIdOf(assignment)) === lower(id)));
  if (extraAttributes.length > 0) {
    steps.push(step('userAttribute:extra', `${name} also asks for ${extraAttributes.join(', ')}, which the backup does not. `
      + `A restore never takes an attribute out of a flow: remove it by hand in ${USER_FLOW_PORTAL} if it should go.`));
  }

  // Languages: turned on or off as in the backup; a flow cannot gain a language.
  const liveLanguages = new Map(list(live.languages).map((language) => [lower(language?.id), language]));
  for (const language of list(payload?.languages)) {
    if (typeof language?.isEnabled !== 'boolean') continue;
    const current = liveLanguages.get(lower(language.id));
    if (!current) {
      if (targetId) steps.push(step(`language:${language.id}`, `The language ${language.id} is not offered for ${name} here, so it could not be turned ${language.isEnabled ? 'on' : 'off'}.`));
      continue;
    }
    if (current.isEnabled === language.isEnabled) continue;
    writes.push({ part: 'languages', id: language.id, method: 'PATCH', path: `${base}/languages/${encodeURIComponent(current.id)}`, body: { isEnabled: language.isEnabled } });
  }
  if (list(payload?.languages).length > 0) {
    // Page text a person changed is not readable through the backup's reads.
    steps.push(step('language:pageText', `Custom page text of ${name} (language overrides) is not backed up: if the flow showed changed text, upload it again in ${USER_FLOW_PORTAL} > Languages.`));
  }

  // API connectors: bound again when they exist; a missing one is a manual step.
  const wantSteps = payload?.apiConnectorConfiguration && typeof payload.apiConnectorConfiguration === 'object' ? payload.apiConnectorConfiguration : {};
  const haveSteps = live.apiConnectorConfiguration && typeof live.apiConnectorConfiguration === 'object' ? live.apiConnectorConfiguration : {};
  for (const stepName of API_CONNECTOR_STEPS) {
    const want = wantSteps[stepName];
    const have = haveSteps[stepName];
    if (!want?.id && !want?.displayName) {
      if (have?.id) {
        steps.push(step(`apiConnector:${stepName}`, `${name} runs the API connector ${have.displayName ?? have.id} at ${stepName}, which the backup does not. `
          + `A restore never takes a connector off a flow: remove it by hand in ${USER_FLOW_PORTAL} > API connectors if it should go.`));
      }
      continue;
    }
    const connector = liveConnectorFor(want, list(tenant.connectors));
    if (!connector) {
      steps.push(step(`apiConnector:${stepName}`, `The API connector ${want.displayName ?? want.id}, which ${name} runs at ${stepName}, is not in this tenant. `
        + `Its password or certificate is never readable, so KEEL does not make it: create it in ${CONNECTORS_PORTAL}, then choose it for ${stepName} in ${USER_FLOW_PORTAL} > API connectors.`));
      continue;
    }
    if (lower(have?.id) === lower(connector.id)) continue;
    writes.push({
      part: 'apiConnectorConfiguration', id: stepName, method: 'PUT', path: `${base}/apiConnectorConfiguration/${stepName}/$ref`,
      body: { '@odata.id': `${GRAPH}${API_CONNECTORS}/${encodeURIComponent(connector.id)}` }, connectorId: connector.id,
    });
  }
  return { writes, steps };
}

/** Whether the flow's parts read back as the writes left them. */
function partsMismatch(writes, live) {
  const wrong = [];
  for (const write of writes) {
    if (write.part === 'identityProviders' && !list(live.identityProviders).some((provider) => lower(provider?.id) === lower(write.id))) wrong.push(`identity provider ${write.id}`);
    if (write.part === 'userAttributeAssignments') {
      const held = list(live.userAttributeAssignments).find((assignment) => lower(attributeIdOf(assignment)) === lower(write.id));
      const sent = ASSIGNMENT_FIELDS.filter((field) => field in write.body);
      if (!held || assignmentDiffers(write.body, held).some((field) => sent.includes(field))) wrong.push(`attribute ${write.id}`);
    }
    if (write.part === 'userAttributeOrder') {
      const got = list(live.userAttributeAssignments).map((assignment) => lower(attributeIdOf(assignment)));
      const want = write.body.newAssignmentOrder.order.map(lower);
      if (!sameValue(got.filter((id) => want.includes(id)), want.filter((id) => got.includes(id)))) wrong.push('attribute order');
    }
    if (write.part === 'languages') {
      const held = list(live.languages).find((language) => lower(language?.id) === lower(write.id));
      if (held?.isEnabled !== write.body.isEnabled) wrong.push(`language ${write.id}`);
    }
    if (write.part === 'apiConnectorConfiguration' && lower(live.apiConnectorConfiguration?.[write.id]?.id) !== lower(write.connectorId)) wrong.push(`API connector at ${write.id}`);
  }
  return wrong;
}

const summary = (writes) => {
  const changes = {};
  for (const write of writes) (changes[write.part] ??= []).push(write.id ?? write.method);
  return changes;
};

/** In a dry run: the part writes and manual steps the enforce run would make. */
async function userFlowPlan(io, { payload, verb, targetId }) {
  const tenant = await tenantParts(io);
  if (tenant.error) return { userFlowParts: { error: tenant.error } };
  const live = verb === 'create' ? await liveParts(io, null) : await liveParts(io, targetId);
  if (live.error) return { userFlowParts: { error: live.error } };
  const { writes, steps } = planUserFlowParts(payload, live, tenant, targetId);
  return { ...summary(writes), ...(steps.length > 0 ? { manualSteps: steps.map((entry) => entry.description) } : {}) };
}

/** After the flow is made or read: its parts, written and read back. */
async function userFlowAfterWrite(io, { payload, targetId }) {
  const tenant = await tenantParts(io);
  if (tenant.error) return { error: tenant.error };
  const live = await liveParts(io, targetId);
  if (live.error) return { error: live.error };
  const { writes, steps } = planUserFlowParts(payload, live, tenant, targetId);
  for (const write of writes) {
    const result = await io.retryOperation(() => io.writer.write('v1.0', write.path, { method: write.method, body: write.body }));
    if (!result?.ok) return { error: `writing the user flow's ${write.part} (${write.id ?? write.method}) failed: ${outcomeDetail(result)}` };
  }
  if (writes.length === 0) return { completion: steps };
  let after = null;
  for (let attempt = 0; attempt < Math.max(1, io.readOptions?.attempts ?? 6); attempt += 1) {
    after = await liveParts(io, targetId);
    if (!after.error && partsMismatch(writes, after).length === 0) break;
    if (attempt < (io.readOptions?.attempts ?? 6) - 1) await new Promise((resolve) => setTimeout(resolve, io.readOptions?.delayMs ?? 3000));
  }
  if (after.error) return { error: `post-state: ${after.error}` };
  const wrong = partsMismatch(writes, after);
  if (wrong.length > 0) return { error: `post-state: ${wrong.join(', ')} did not read back as written` };
  return { changes: summary(writes), completion: steps };
}

/**
 * A user flow whose backup was taken before KEEL read its parts holds none of
 * them: writing it would add nothing and say nothing, so it is a manual step.
 */
function userFlowRefusal(resource, verb) {
  if (verb === 'delete') {
    return { outcome: 'skipped', reason: `manual: a restore never deletes a user flow; delete it by hand in ${USER_FLOW_PORTAL}` };
  }
  const payload = resource.payload ?? {};
  if (FLOW_PARTS.every((field) => payload[field] === undefined)) {
    const description = 'This backup was taken before KEEL backed up a user flow\'s identity providers, attributes, languages and API connectors, '
      + `so a restore cannot tell what the flow held. Nothing was written: set the flow up by hand in ${USER_FLOW_PORTAL}, or restore from a newer backup.`;
    return { outcome: 'skipped', reason: `manual: ${description}`, completion: [step('userFlowParts', description)] };
  }
  return null;
}

// ------------------------------------------------------- custom attributes

const builtIn = (payload) => payload?.userFlowAttributeType !== undefined && payload.userFlowAttributeType !== 'custom';

function attributeRefusal(resource, verb) {
  const payload = resource.payload ?? {};
  if (verb === 'delete') return { outcome: 'skipped', reason: 'manual: a restore never deletes a user flow attribute' };
  if (builtIn(payload) || builtIn(resource.live?.payload)) {
    return { outcome: 'skipped', reason: `manual: ${payload.displayName ?? payload.id} is a built-in attribute: Microsoft manages it` };
  }
  const live = resource.live?.payload;
  if (verb === 'update' && live && payload.dataType && live.dataType && lower(live.dataType) !== lower(payload.dataType)) return dataTypeStep(payload, live);
  return null;
}

function dataTypeStep(payload, live) {
  const description = `The attribute ${payload.displayName ?? payload.id} holds ${live.dataType} values here and ${payload.dataType} values in the backup. `
    + 'A data type cannot change after an attribute is made, and KEEL never deletes one (the values people gave would go with it). '
    + 'Nothing was written: decide by hand in Entra admin center > External Identities > Custom user attributes.';
  return { outcome: 'skipped', reason: `manual: ${description}`, completion: [step('dataType', description)] };
}

/**
 * Graph names a custom attribute extension_<the tenant's extension app id>_<name>,
 * so in another tenant the backup's id is new. Before a create, an attribute with
 * the same name is looked for: one with the same data type means the create is
 * done; another data type is a manual step, never a second attribute.
 */
async function attributeCreatePreflight(io, { payload, verb }) {
  if (verb !== 'create') return null;
  const listed = await readAllPages(io, 'v1.0', USER_FLOW_ATTRIBUTES);
  if (listed.error) return `could not list the user flow attributes to look for one with this name (${listed.error})`;
  const same = listed.value.find((attribute) => lower(attribute?.displayName) === lower(payload.displayName));
  if (!same) return null;
  if (builtIn(same)) return { skipped: `"${payload.displayName}" is a built-in attribute here: Microsoft manages it` };
  if (lower(same.dataType) !== lower(payload.dataType)) {
    const { reason, completion } = dataTypeStep(payload, same);
    return { skipped: reason.replace(/^manual: /, ''), completion };
  }
  return { skipped: `the attribute "${payload.displayName}" is already there with the backup's data type (${same.id}), so nothing is written` };
}

// ---------------------------------------------------------- API connectors

/**
 * Graph needs an authentication on create: basic authentication under a random
 * name and password, made for this one write and never kept, logged or journaled.
 * A call with it fails, so the connector cannot be used by mistake.
 */
function placeholderAuthentication() {
  return {
    '@odata.type': '#microsoft.graph.basicAuthentication',
    username: `keel-placeholder-${randomBytes(6).toString('hex')}`,
    password: randomBytes(36).toString('base64url'),
  };
}

const connectorPath = (targetId) => `${API_CONNECTORS}/${encodeURIComponent(targetId)}`;

/** The create (with the placeholder authentication) or the update of the name and URL. */
function connectorWrite(io, { verb, body, sent, targetId }) {
  if (verb === 'create') {
    const authenticationConfiguration = placeholderAuthentication();
    return io.retryOperation(() => io.writer.write('v1.0', API_CONNECTORS, { method: 'POST', body: { ...body, authenticationConfiguration } }));
  }
  return io.retryOperation(() => io.writer.write('v1.0', connectorPath(targetId), { method: 'PATCH', body: sent }));
}

const connectorRead = (io, { targetId }) => io.retryOperation(() => io.writer.read('v1.0', connectorPath(targetId)));

/**
 * On an update, the step for the password or certificate KEEL never reads or
 * writes (a create lists it from the type's completeness record, as
 * `connectorCredential` too).
 */
function connectorCredentialSteps({ payload, verb }) {
  if (verb !== 'update') return [];
  const certificate = /certificate/i.test(String(payload?.authenticationConfiguration?.['@odata.type'] ?? ''));
  return [Object.freeze({
    kind: 'credential', requirement: 'connectorCredential',
    description: `KEEL never reads or writes the ${certificate ? 'certificate' : 'password'} of the API connector ${payload?.displayName ?? ''}. `
      + `Check in ${CONNECTORS_PORTAL} that it still uses the real one, and set it by hand if not.`,
  })];
}

const sameConnectorName = (row, payload) => lower(row?.displayName) === lower(payload?.displayName);

export const USER_FLOW_RECORDS = Object.freeze({
  // Every write is held behind the restore approval (withApprovalGate): the flow's
  // kind and its parts are "access-changing" effects (safety/contentEffects.mjs).
  // The parts are listed as writable for the gate and the plan, and written by
  // afterWrite through their own routes (transform keeps them out of the body).
  b2xIdentityUserFlow: defineRecord({
    resourceType: 'b2xIdentityUserFlow', version: 'v1.0', collection: USER_FLOWS,
    operations: ['create', 'update'], writable: FLOW_PARTS, createOnly: ['userFlowType', 'userFlowTypeVersion'],
    transform: userFlowBody, refusal: withApprovalGate(userFlowRefusal),
    afterWrite: userFlowAfterWrite, planChanges: userFlowPlan,
    permission: 'IdentityUserFlow.ReadWrite.All', docs: v1('identitycontainer-post-b2xuserflows'),
  }),
  identityUserFlowAttribute: defineRecord({
    resourceType: 'identityUserFlowAttribute', version: 'v1.0', collection: USER_FLOW_ATTRIBUTES,
    operations: ['create', 'update'], writable: ['description'], createOnly: ['displayName', 'dataType'],
    refusal: attributeRefusal, preflight: attributeCreatePreflight,
    permission: 'IdentityUserFlow.ReadWrite.All', docs: v1('identityuserflowattribute-post'),
  }),
  // Issue #1008: its name and target URL are "access-changing" effects
  // (safety/contentEffects.mjs), so every write waits for the restore approval.
  // A create first looks for a connector with the backup's name: the same URL
  // means it is done, another URL is left for a person.
  identityApiConnector: defineRecord({
    resourceType: 'identityApiConnector', version: 'v1.0', collection: API_CONNECTORS,
    operations: ['create', 'update'], writable: ['displayName', 'targetUrl'],
    refusal: withApprovalGate(),
    preflight: createdOnce({
      version: 'v1.0', path: API_CONNECTORS, label: 'API connector', matches: sameConnectorName,
      same: (row, payload) => row?.targetUrl === payload?.targetUrl,
    }),
    writeVia: connectorWrite, readVia: connectorRead,
    afterWrite: async (_io, step) => ({ completion: connectorCredentialSteps(step) }),
    planCompletion: connectorCredentialSteps,
    permission: 'APIConnectors.ReadWrite.All', docs: v1('identityapiconnector-create'),
  }),
});
