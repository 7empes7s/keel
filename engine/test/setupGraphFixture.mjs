// Task 76: an in-memory Microsoft Graph for the setup host's boundary tests.
// install() replaces globalThis.fetch so the real GraphReader and GraphWriter
// run unchanged against it; every request (method, path) is recorded so a test
// can prove which side wrote and which only read. No network is touched.
import { createHash } from 'node:crypto';

export const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';
export const TENANT_ID = '00000000-0000-0000-0000-0000000000c1';
export const COLLECTOR_APP_ID = '11111111-1111-4111-8111-111111111111';
export const RESTORER_APP_ID = '22222222-2222-4222-8222-222222222222';
export const OPERATOR_ID = '33333333-3333-4333-8333-333333333333';
export const PRIVILEGED_ROLE_ADMIN = 'e8611ab8-c189-46e8-94e1-60213ab1f814';

const COLLECTOR_SCOPES = ['User.Read.All', 'Group.Read.All', 'RoleManagement.Read.Directory', 'Policy.Read.All',
  'DeviceManagementConfiguration.Read.All', 'DeviceManagementManagedDevices.Read.All', 'Application.Read.All'];
const RESTORER_SCOPES = ['Group.ReadWrite.All', 'Policy.ReadWrite.ConditionalAccess', 'RoleManagement.ReadWrite.Directory'];
const ALL_SCOPES = [...new Set([...COLLECTOR_SCOPES, ...RESTORER_SCOPES, 'MailboxSettings.ReadWrite', 'Directory.ReadWrite.All'])];

const guid = (seed) => {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export const roleId = (scope) => guid(`role:${scope}`);

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** A JWT-shaped fake token carrying only a tenant claim. */
export const fakeToken = (tenantId = TENANT_ID) => `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ tid: tenantId, appid: 'fixture' })}.c2lnbmF0dXJl`;
export const fakeGetToken = (tenantId = TENANT_ID) => async () => ({ accessToken: fakeToken(tenantId), expiresAt: Date.now() + 3600_000 });

/**
 * A tenant where the Collector and Restorer registrations exist and are
 * consented. `restorerExtra` are grants beyond what setup asks for.
 */
export function fixtureTenant({
  collectorScopes = COLLECTOR_SCOPES, restorerScopes = RESTORER_SCOPES, restorerExtra = ['MailboxSettings.ReadWrite'],
  intuneAssigned = true, intuneReadable = true, operatorActive = false, operatorEligible = true,
} = {}) {
  const graphSp = { id: guid('graph-sp'), appId: GRAPH_APP_ID, appRoles: ALL_SCOPES.map((value) => ({ id: roleId(value), value, allowedMemberTypes: ['Application'] })) };
  const apps = new Map();
  const sps = new Map();
  const grants = new Map();
  const register = (appId, displayName, declared, granted) => {
    const app = { id: guid(`app:${appId}`), appId, displayName,
      requiredResourceAccess: [{ resourceAppId: GRAPH_APP_ID, resourceAccess: declared.map((scope) => ({ id: roleId(scope), type: 'Role' })) }] };
    const sp = { id: guid(`sp:${appId}`), appId, displayName };
    apps.set(appId, app);
    sps.set(appId, sp);
    grants.set(sp.id, granted.map((scope) => ({ id: guid(`grant:${sp.id}:${scope}`), principalId: sp.id, resourceId: graphSp.id, appRoleId: roleId(scope) })));
  };
  register(COLLECTOR_APP_ID, 'KEEL Collector', COLLECTOR_SCOPES, collectorScopes);
  register(RESTORER_APP_ID, 'KEEL Restorer', [...RESTORER_SCOPES, ...restorerExtra], [...restorerScopes, ...restorerExtra]);
  const collectorSp = sps.get(COLLECTOR_APP_ID).id;
  const state = {
    graphSp, apps, sps, grants,
    directoryRoles: operatorActive ? [{ principalId: OPERATOR_ID, roleDefinitionId: PRIVILEGED_ROLE_ADMIN, directoryScopeId: '/' }] : [],
    eligibility: operatorEligible ? [{ principalId: OPERATOR_ID, roleDefinitionId: PRIVILEGED_ROLE_ADMIN }] : [],
    intune: { readable: intuneReadable, definitions: [{ id: 'rd-read-only-operator', displayName: 'Read Only Operator' }],
      assignments: { 'rd-read-only-operator': [{ id: 'ra-1', members: ['group-intune-readers'] }] },
      memberships: { [collectorSp]: intuneAssigned ? ['group-intune-readers'] : ['group-other'] } },
    requests: [],
  };
  return state;
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const notFound = () => json(404, { error: { code: 'Request_ResourceNotFound', message: 'not found' } });
const forbidden = () => json(403, { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' } });
const pick = (object, select) => (select ? Object.fromEntries(select.split(',').filter((k) => k in object).map((k) => [k, object[k]])) : object);
const principalFilter = (filter) => /principalId eq '([^']+)'/.exec(filter ?? '')?.[1];

function route(state, method, url, body) {
  const path = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, ''));
  const select = url.searchParams.get('$select');
  let match;
  if (method === 'GET') {
    if ((match = /^\/servicePrincipals\(appId='([^']+)'\)$/.exec(path))) {
      if (match[1] === GRAPH_APP_ID) return json(200, pick(state.graphSp, select));
      const sp = state.sps.get(match[1]);
      return sp ? json(200, pick(sp, select)) : notFound();
    }
    if ((match = /^\/applications\(appId='([^']+)'\)$/.exec(path))) {
      const app = state.apps.get(match[1]);
      return app ? json(200, pick(app, select)) : notFound();
    }
    if ((match = /^\/servicePrincipals\/([^/]+)\/appRoleAssignments$/.exec(path))) return json(200, { value: state.grants.get(match[1]) ?? [] });
    if ((match = /^\/servicePrincipals\/([^/]+)\/transitiveMemberOf\/microsoft\.graph\.group$/.exec(path))) {
      return json(200, { value: (state.intune.memberships[match[1]] ?? []).map((id) => ({ id })) });
    }
    if (path === '/roleManagement/directory/roleAssignments') {
      const who = principalFilter(url.searchParams.get('$filter'));
      return json(200, { value: state.directoryRoles.filter((a) => a.principalId === who) });
    }
    if (path === '/roleManagement/directory/roleEligibilitySchedules') {
      const who = principalFilter(url.searchParams.get('$filter'));
      return json(200, { value: state.eligibility.filter((a) => a.principalId === who) });
    }
    if (path.startsWith('/deviceManagement/')) {
      if (!state.intune.readable) return forbidden();
      if (path === '/deviceManagement/roleDefinitions') return json(200, { value: state.intune.definitions });
      if ((match = /^\/deviceManagement\/roleDefinitions\/([^/]+)\/roleAssignments$/.exec(path))) {
        return json(200, { value: (state.intune.assignments[match[1]] ?? []).map((a) => ({ id: a.id })) });
      }
      if ((match = /^\/deviceManagement\/roleAssignments\/([^/]+)$/.exec(path))) {
        const found = Object.values(state.intune.assignments).flat().find((a) => a.id === match[1]);
        return found ? json(200, found) : notFound();
      }
    }
    if (path === '/subscribedSkus') return json(200, { value: [{ skuPartNumber: 'ENTERPRISEPREMIUM' }] });
    return notFound();
  }
  if (method === 'POST' && (match = /^\/servicePrincipals\/([^/]+)\/appRoleAssignments$/.exec(path))) {
    const list = state.grants.get(match[1]) ?? [];
    const grant = { id: guid(`grant:${match[1]}:${body.appRoleId}`), ...body };
    list.push(grant);
    state.grants.set(match[1], list);
    return json(201, grant);
  }
  if (method === 'PATCH' && (match = /^\/applications\/([^/]+)$/.exec(path))) {
    const app = [...state.apps.values()].find((candidate) => candidate.id === match[1]);
    if (!app) return notFound();
    Object.assign(app, body);
    return new Response(null, { status: 204 });
  }
  return json(405, { error: { code: 'MethodNotAllowed', message: `${method} ${path}` } });
}

/** Routes every fetch to the fixture tenant; returns a restore function. */
export function installFixtureGraph(state) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    state.requests.push({ method, host: url.host, path: url.pathname, query: url.search });
    if (url.host !== 'graph.microsoft.com') return json(400, { error: { code: 'UnexpectedHost' } });
    const body = init.body ? JSON.parse(init.body) : null;
    return route(state, method, url, body);
  };
  return () => { globalThis.fetch = original; };
}

export const writesIn = (state) => state.requests.filter((request) => request.method !== 'GET');
