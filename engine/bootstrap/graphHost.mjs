// Task 76: the production setup host. Composes the task-74 planner readers and
// the task-75 executor adapters over Microsoft Graph for one deployment.
//
// Reading and writing are kept apart the same way the product keeps collection
// and restore apart:
// - Every observation goes through tools/tenant-probe/graph.mjs's GraphReader,
//   which has no way to send anything but GET, authenticated with the
//   Collector credential. Readers and observe() never write.
// - Writes go through engine/restore/graphWriter.mjs with the Restorer
//   credential, and only from ensure(). Every write operation ships DISABLED:
//   an operation runs only when the deployment's setup config names it with
//   `enabled: true`, a qualification mode and an expiry. A disabled operation
//   is never qualified, so the executor stops before ensure() is reached, and
//   ensure() refuses again on its own before sending anything.
// - Creating an app registration and recording a KEEL permission are never
//   automated here: a new registration's app id cannot be bound to a credential
//   reference before approval (task-75), and the KEEL permission is the
//   deployment's own binding of a credential to its role.
//
// A registration is identified by the app id of the credential the deployment
// configured for that role, never by display name, so an unrelated app is
// never adopted. Unknown is never absent: a failed read throws, except the
// Intune role check (which needs DeviceManagementRBAC.Read.All, a grant the
// Collector's registered scopes do not include) and the licence list (shown
// for visibility only); those are reported as not checked.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

import { AUTOMATION_KILL_SWITCH_PATH } from '../policy/execute.mjs';
import { GraphWriter } from '../restore/graphWriter.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';
import { GraphReader } from '../../tools/tenant-probe/graph.mjs';
import { assertTokenFree, decodeRoles, getToken as defaultGetToken } from '../../tools/tenant-probe/auth.mjs';
import { planBootstrap } from './plan.mjs';
import { GRAPH_RESOURCE_APP_ID, registeredWorkloads } from './prerequisites.mjs';

export const SETUP_HOST_PROJECTION = 'identity-v1';

// The only identity operations this host can perform, each behind its own flag.
export const SETUP_WRITE_OPERATIONS = Object.freeze(['grant-consent', 'update-required-access']);
// Planner actions this host never automates, whatever the configuration says.
export const SETUP_REFUSED_OPERATIONS = Object.freeze(['create-registration', 'configure-keel-permission']);

// The KEEL permission each configured credential carries by deployment binding.
const KEEL_PERMISSION = Object.freeze({ collector: 'keel.collect', restorer: 'keel.restore' });
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reference = (value) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:/.@_-]{0,255}$/.test(value);
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);

export class SetupReadError extends Error {
  constructor(what, result) {
    super(`setup host: could not read ${what} (${result?.status ?? 'no status'}${result?.code ? ` ${result.code}` : ''})`);
    this.name = 'SetupReadError';
    this.status = result?.status ?? null;
  }
}

function assertCredentialConfig(mode, config, tenantId) {
  for (const field of ['tenantId', 'clientId', 'certPath', 'keyPath']) {
    if (typeof config?.[field] !== 'string' || config[field].length === 0) {
      throw new TypeError(`setup host: ${mode} credential config has no ${field}`);
    }
  }
  if (!GUID.test(config.clientId)) throw new TypeError(`setup host: ${mode} clientId must be an app id`);
  if (config.tenantId !== tenantId) throw new TypeError(`setup host: ${mode} credential belongs to another tenant`);
}

/** Parses the per-operation enable flags. Anything not named stays disabled. */
export function parseSetupOperations(operations = {}) {
  if (operations === null || typeof operations !== 'object' || Array.isArray(operations)) {
    throw new TypeError('setup host: operations must be an object');
  }
  const parsed = {};
  for (const [name, entry] of Object.entries(operations)) {
    if (!SETUP_WRITE_OPERATIONS.includes(name)) {
      throw new TypeError(`setup host: '${name}' is not an operation this host can perform`);
    }
    if (typeof entry?.enabled !== 'boolean') throw new TypeError(`setup host: ${name}.enabled must be true or false`);
    if (!entry.enabled) continue;
    if (!['fixture-tested', 'live-qualified'].includes(entry.qualification)) {
      throw new TypeError(`setup host: enabled ${name} needs qualification fixture-tested or live-qualified`);
    }
    if (Number.isNaN(Date.parse(entry.expiresAt))) throw new TypeError(`setup host: enabled ${name} needs an expiresAt`);
    parsed[name] = Object.freeze({ enabled: true, qualification: entry.qualification, expiresAt: new Date(entry.expiresAt).toISOString() });
  }
  return Object.freeze(parsed);
}

// One token per credential, kept in memory only and never returned or logged.
// The token's tenant must be the deployment's tenant before anything is read.
function tokenSource(config, getToken) {
  let cached = null;
  return async () => {
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.accessToken;
    const token = await getToken(config);
    if (decodeRoles(token.accessToken).tenantId !== config.tenantId) {
      throw new Error('setup host: token was issued for another tenant');
    }
    cached = token;
    return token.accessToken;
  };
}

const quoted = (value) => `'${String(value).replace(/'/g, "''")}'`;

async function getOne(graph, path, what) {
  const result = await graph.get('v1.0', path);
  if (result.ok) return result.body;
  // 404 is Graph's authoritative "no such object"; anything else is unknown.
  if (result.status === 404) return null;
  throw new SetupReadError(what, result);
}

async function getAll(graph, path, what, options) {
  const result = await graph.collect('v1.0', path, options);
  if (result.error) throw new SetupReadError(what, result.error);
  if (result.capped) throw new SetupReadError(`${what} (incomplete)`, null);
  return result.items;
}

const intuneRoleNames = () => [...new Set(registeredWorkloads()
  .flatMap((r) => r.workloadRoles.filter((role) => role.resolution === 'workload-lookup').map((role) => role.displayName)))];

/**
 * One read-only look at what onboarding depends on. `bindings` maps each
 * identity to its configured app id. Returns the planner's reader shapes plus
 * what ensure() needs to converge without guessing.
 */
export async function observeTenant({ graph, tenantRef, bindings, operatorPrincipalId = null }) {
  const graphSp = await getOne(graph, `/servicePrincipals(appId='${GRAPH_RESOURCE_APP_ID}')?$select=id,appId,appRoles`, 'the Microsoft Graph service principal');
  if (!graphSp?.id) throw new SetupReadError('the Microsoft Graph service principal', { status: 404 });
  const roleById = new Map((graphSp.appRoles ?? []).map((role) => [role.id, role]));
  const roleName = (id) => roleById.get(id)?.value ?? `unknown-app-role:${id}`;

  const snapshot = {
    applications: [], servicePrincipals: [], appRoleAssignments: [], roleAssignments: [],
    roleEligibilitySchedules: [], subscribedSkus: [], unchecked: new Set(),
    graph: { id: graphSp.id, appRoles: (graphSp.appRoles ?? []).map((role) => ({ id: role.id, value: role.value, allowedMemberTypes: role.allowedMemberTypes ?? [] })) },
    byIdentity: {},
  };
  const principals = [];

  for (const [identity, appId] of Object.entries(bindings)) {
    const app = await getOne(graph, `/applications(appId=${quoted(appId)})?$select=id,appId,displayName,requiredResourceAccess`, `the ${identity} app registration`);
    const sp = await getOne(graph, `/servicePrincipals(appId=${quoted(appId)})?$select=id,appId,displayName`, `the ${identity} service principal`);
    if (app && app.appId !== appId) throw new SetupReadError(`the ${identity} app registration (app id mismatch)`, null);
    if (sp && sp.appId !== appId) throw new SetupReadError(`the ${identity} service principal (app id mismatch)`, null);
    snapshot.byIdentity[identity] = {
      appObjectId: app?.id ?? null, servicePrincipalId: sp?.id ?? null,
      requiredResourceAccess: (app?.requiredResourceAccess ?? []).map((entry) => ({
        resourceAppId: entry.resourceAppId,
        resourceAccess: (entry.resourceAccess ?? []).map((access) => ({ id: access.id, type: access.type })),
      })),
    };
    if (app) {
      snapshot.applications.push({
        tenantRef, id: app.id, appId: app.appId, displayName: app.displayName, keelIdentity: identity,
        requiredResourceAccess: (app.requiredResourceAccess ?? []).map((entry) => ({
          resourceAppId: entry.resourceAppId,
          scopes: entry.resourceAppId === GRAPH_RESOURCE_APP_ID
            ? (entry.resourceAccess ?? []).filter((access) => access.type === 'Role').map((access) => roleName(access.id))
            : [],
        })),
        // The deployment binds this app to its KEEL role by configuring it as
        // that role's credential; that binding is the KEEL permission.
        keelPermissions: [KEEL_PERMISSION[identity]],
      });
    }
    if (!sp) continue;
    snapshot.servicePrincipals.push({ tenantRef, id: sp.id, appId: sp.appId, displayName: sp.displayName });
    principals.push(sp.id);
    // Application permissions granted to this identity (admin consent).
    for (const grant of await getAll(graph, `/servicePrincipals/${sp.id}/appRoleAssignments?$select=principalId,resourceId,appRoleId`, `the ${identity} granted permissions`)) {
      if (grant.resourceId !== graphSp.id) continue;
      snapshot.appRoleAssignments.push({ tenantRef, principalId: sp.id, resourceAppId: GRAPH_RESOURCE_APP_ID, scope: roleName(grant.appRoleId) });
    }
  }

  if (operatorPrincipalId) principals.push(operatorPrincipalId);
  for (const principalId of principals) {
    for (const assignment of await getAll(graph, `/roleManagement/directory/roleAssignments?$filter=principalId eq ${quoted(principalId)}&$select=principalId,roleDefinitionId,directoryScopeId`, 'directory role assignments')) {
      snapshot.roleAssignments.push({ tenantRef, principalId: assignment.principalId, roleDefinitionId: assignment.roleDefinitionId, directoryScopeId: assignment.directoryScopeId ?? null });
    }
  }
  if (operatorPrincipalId) {
    for (const schedule of await getAll(graph, `/roleManagement/directory/roleEligibilitySchedules?$filter=principalId eq ${quoted(operatorPrincipalId)}&$select=principalId,roleDefinitionId`, 'PIM eligibility')) {
      snapshot.roleEligibilitySchedules.push({ tenantRef, principalId: schedule.principalId, roleDefinitionId: schedule.roleDefinitionId });
    }
  }

  // Intune roles are granted to security groups; an identity holds one when
  // its service principal is (transitively) in an assigned group.
  const wanted = intuneRoleNames();
  const sps = snapshot.servicePrincipals;
  if (wanted.length && sps.length) {
    try {
      const definitions = (await getAll(graph, '/deviceManagement/roleDefinitions?$select=id,displayName', 'Intune role definitions'))
        .filter((definition) => wanted.includes(definition.displayName));
      const groupsByRole = new Map();
      for (const definition of definitions) {
        const members = new Set();
        for (const assignment of await getAll(graph, `/deviceManagement/roleDefinitions/${definition.id}/roleAssignments?$select=id`, 'Intune role assignments')) {
          const detail = await getOne(graph, `/deviceManagement/roleAssignments/${assignment.id}?$select=id,members`, 'an Intune role assignment');
          if (!detail) throw new SetupReadError('an Intune role assignment', { status: 404 });
          for (const member of detail.members ?? []) members.add(member);
        }
        groupsByRole.set(definition.displayName, members);
      }
      for (const sp of sps) {
        const groups = new Set((await getAll(graph, `/servicePrincipals/${sp.id}/transitiveMemberOf/microsoft.graph.group?$select=id&$count=true`, 'group memberships', { consistencyLevel: true }))
          .map((group) => group.id));
        for (const [displayName, members] of groupsByRole) {
          if ([...members].some((member) => groups.has(member))) {
            snapshot.roleAssignments.push({ tenantRef, principalId: sp.id, displayName, source: 'intune' });
          }
        }
      }
    } catch (error) {
      if (!(error instanceof SetupReadError)) throw error;
      snapshot.unchecked.add('workload-rbac');
    }
  }

  try {
    for (const sku of await getAll(graph, '/subscribedSkus?$select=skuPartNumber', 'licences')) {
      snapshot.subscribedSkus.push({ tenantRef, skuPartNumber: sku.skuPartNumber });
    }
  } catch (error) {
    if (!(error instanceof SetupReadError)) throw error;
    snapshot.unchecked.add('licensing');
  }
  return assertTokenFree(snapshot, 'setup observation');
}

/** Planner read adapters over one lazily taken, shared observation. */
export function readersFor(observe) {
  let pending = null;
  const snapshot = () => (pending ??= observe());
  return {
    listApplications: async () => (await snapshot()).applications,
    listServicePrincipals: async () => (await snapshot()).servicePrincipals,
    listAppRoleAssignments: async () => (await snapshot()).appRoleAssignments,
    listRoleAssignments: async () => (await snapshot()).roleAssignments,
    listRoleEligibilitySchedules: async () => (await snapshot()).roleEligibilitySchedules,
    listSubscribedSkus: async () => (await snapshot()).subscribedSkus,
    uncheckedKinds: async () => [...(await snapshot()).unchecked],
  };
}

/**
 * Builds the deployment's setup host. Configs are the existing credential
 * files (tenantId, clientId, certPath, keyPath); only their paths become
 * credential references, and nothing secret is held beyond the in-memory token.
 */
export function createGraphSetupHost({
  tenantRef, tenantId, collector, restorer, operatorPrincipalId = null, build,
  qualificationMode = 'live-qualified', operations = {},
  getToken = defaultGetToken, killSwitchPath = AUTOMATION_KILL_SWITCH_PATH,
  reader = (getAccessToken) => new GraphReader(getAccessToken),
  writer = (getAccessToken) => new GraphWriter(getAccessToken),
}) {
  assertTenantRef(tenantRef);
  assertCredentialConfig('collector', collector?.config, tenantId);
  assertCredentialConfig('restorer', restorer?.config, tenantId);
  if (collector.config.clientId === restorer.config.clientId || collector.config.certPath === restorer.config.certPath
    || collector.config.keyPath === restorer.config.keyPath) {
    throw new TypeError('setup host: collector and restorer must be separate registrations and certificates');
  }
  if (!reference(collector.credentialRef) || !reference(restorer.credentialRef) || collector.credentialRef === restorer.credentialRef) {
    throw new TypeError('setup host: separate collector and restorer credential references required');
  }
  if (operatorPrincipalId !== null && !GUID.test(operatorPrincipalId)) throw new TypeError('setup host: operatorPrincipalId must be an object id');
  if (!reference(build)) throw new TypeError('setup host: a build identifier is required');
  if (!['fixture-tested', 'live-qualified'].includes(qualificationMode)) throw new TypeError('setup host: unknown qualification mode');
  const enabled = parseSetupOperations(operations);

  const credentials = Object.freeze({
    collector: Object.freeze({ credentialRef: collector.credentialRef, identityRef: collector.config.clientId }),
    restorer: Object.freeze({ credentialRef: restorer.credentialRef, identityRef: restorer.config.clientId }),
  });
  const bindings = { collector: collector.config.clientId, restorer: restorer.config.clientId };
  const collectorToken = tokenSource(collector.config, getToken);
  const restorerToken = tokenSource(restorer.config, getToken);
  // A fresh reader per observation: nothing is cached between looks.
  const observeNow = () => observeTenant({ graph: reader(collectorToken), tenantRef, bindings, operatorPrincipalId });

  const revision = `setup-host-${digest({ tenantRef, credentials, operatorPrincipalId, enabled, build, qualificationMode })}`;

  async function freshStep(context) {
    const snapshot = await observeNow();
    const plan = await planBootstrap({ tenantRef, workloads: context.plan.workloads, readAdapters: readersFor(async () => snapshot), operatorPrincipalId });
    const step = plan.steps.find((candidate) => candidate.id === context.step.id);
    if (!step) throw new Error('setup host: approved step is no longer derivable');
    return { snapshot, step };
  }

  const adapters = {
    async prerequisites(context) {
      if (context?.tenantRef !== tenantRef) throw new Error('setup host: tenant mismatch');
      return { revision, allowed: true, killSwitch: existsSync(killSwitchPath) };
    },

    async observe(context) {
      if (context?.tenantRef !== tenantRef) throw new Error('setup host: tenant mismatch');
      const { snapshot, step } = await freshStep(context);
      const result = { tenantRef };
      switch (step.kind) {
        case 'registration': {
          const bound = snapshot.byIdentity[step.identity];
          result.status = step.status === 'satisfied' ? 'satisfied' : step.reference ? 'partial' : 'absent';
          if (bound.appObjectId) Object.assign(result, { objectId: bound.appObjectId, appId: bindings[step.identity] });
          if (bound.servicePrincipalId) result.servicePrincipalId = bound.servicePrincipalId;
          break;
        }
        case 'graph-permission':
          result.status = step.status === 'satisfied' ? 'satisfied'
            : step.consentedScopes.some((scope) => step.requiredScopes.includes(scope)) ? 'partial' : 'absent';
          break;
        case 'workload-rbac':
          if (snapshot.unchecked.has('workload-rbac')) throw new Error('setup host: Intune role assignments could not be read');
          result.status = step.status === 'satisfied' ? 'satisfied' : 'absent';
          break;
        case 'pim-activation':
          // Active authority only: eligibility is not activation (task-75).
          result.status = operatorPrincipalId !== null && snapshot.roleAssignments.some((assignment) =>
            assignment.principalId === operatorPrincipalId && assignment.roleDefinitionId === step.templateId) ? 'satisfied' : 'absent';
          break;
        default:
          result.status = step.status === 'satisfied' ? 'satisfied' : 'absent';
      }
      return result;
    },

    async qualify({ tenantRef: ref, step, credentialRef, intentHash }) {
      const operation = enabled[step?.action];
      if (ref !== tenantRef || !operation || credentialRef !== credentials.restorer.credentialRef) return null;
      return { tenantRef, credentialRef, intentHash, operation: step.action, build,
        projection: SETUP_HOST_PROJECTION, status: operation.qualification, expiresAt: operation.expiresAt };
    },

    async ensure(context) {
      const { step } = context;
      // Refuse before any request: the executor already stops on qualification,
      // and this host does not rely on that alone.
      if (!enabled[step?.action]) throw new Error(`setup host: ${step?.action} is disabled`);
      if (context.tenantRef !== tenantRef || context.credentialRef !== credentials.restorer.credentialRef) {
        throw new Error('setup host: writes use the approved restorer credential for this tenant only');
      }
      const { snapshot, step: fresh } = await freshStep(context);
      const bound = snapshot.byIdentity[step.identity];
      const graphWriter = writer(restorerToken);
      const role = (scope) => {
        const found = snapshot.graph.appRoles.find((candidate) => candidate.value === scope && candidate.allowedMemberTypes.includes('Application'));
        if (!found) throw new Error(`setup host: Microsoft Graph has no application permission ${scope}`);
        return found;
      };
      const send = async (method, path, body) => {
        const result = await graphWriter.write('v1.0', path, { method, body });
        if (!result.ok) throw new Error(`setup host: ${method} failed (${result.status})`);
        return result.body;
      };
      if (step.action === 'grant-consent') {
        if (!bound.servicePrincipalId) throw new Error('setup host: the identity has no service principal to consent for');
        for (const scope of fresh.missingScopes) {
          await send('POST', `/servicePrincipals/${bound.servicePrincipalId}/appRoleAssignments`,
            { principalId: bound.servicePrincipalId, resourceId: snapshot.graph.id, appRoleId: role(scope).id });
        }
        return;
      }
      if (step.action === 'update-required-access') {
        if (!bound.appObjectId) throw new Error('setup host: creating an app registration is not automated');
        if (!bound.servicePrincipalId) await send('POST', '/servicePrincipals', { appId: bindings[step.identity] });
        const missing = fresh.missingFromRegistration.map((scope) => ({ id: role(scope).id, type: 'Role' }));
        if (missing.length) {
          const entries = bound.requiredResourceAccess.map((entry) => ({ ...entry, resourceAccess: [...entry.resourceAccess] }));
          let graphEntry = entries.find((entry) => entry.resourceAppId === GRAPH_RESOURCE_APP_ID);
          if (!graphEntry) entries.push(graphEntry = { resourceAppId: GRAPH_RESOURCE_APP_ID, resourceAccess: [] });
          graphEntry.resourceAccess.push(...missing);
          await send('PATCH', `/applications/${bound.appObjectId}`, { requiredResourceAccess: entries });
        }
        return;
      }
      throw new Error(`setup host: ${step.action} is not automated`);
    },
  };

  return Object.freeze({
    readers: readersFor(observeNow),
    adapters: Object.freeze(adapters),
    credentials,
    build,
    qualificationMode,
    operatorPrincipalId,
  });
}
