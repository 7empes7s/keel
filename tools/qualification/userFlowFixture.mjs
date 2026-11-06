/**
 * Issue #995: the guest sign-up user flow fake for the operations harness
 * (operations.mjs): Graph's routes for a flow and its parts.
 */

// Issue #995: a guest sign-up user flow keeps its parts on the flow object, each
// written and read through its own route, as Graph does.
const USER_FLOW = /^\/identity\/b2xUserFlows\/([^/]+)(?:\/(identityProviders|userAttributeAssignments|languages|apiConnectorConfiguration)(?:\/(.+))?)?$/;
export function userFlowWrite(objects, path, method, body) {
  if (method === 'POST' && path === '/identity/b2xUserFlows') {
    const id = `B2X_1_${body.id}`;
    if (objects.has(`${path}/${id}`)) return { ok: false, status: 409, body: { error: { code: 'AADB2C', message: 'a user flow with this name exists' } } };
    const created = { id, userFlowType: body.userFlowType, userFlowTypeVersion: body.userFlowTypeVersion };
    objects.set(`${path}/${id}`, { ...created, identityProviders: [], userAttributeAssignments: [], languages: [{ id: 'en', isEnabled: true }, { id: 'fr', isEnabled: true }], apiConnectorConfiguration: {} });
    return { ok: true, status: 201, body: created };
  }
  const match = USER_FLOW.exec(path);
  if (!match || !match[2]) return null;
  const flowPath = `/identity/b2xUserFlows/${match[1]}`;
  const flow = objects.get(flowPath);
  if (!flow) return { ok: false, status: 404, body: { error: { code: 'Request_ResourceNotFound' } } };
  const [, , part, rest] = match;
  const idOf = (bind) => decodeURIComponent(String(bind ?? '').split('/').pop());
  const save = (changes) => { objects.set(flowPath, { ...flow, ...changes }); return { ok: true, status: 204, body: null }; };
  if (part === 'identityProviders' && rest === '$ref' && method === 'POST') {
    const id = idOf(body['@odata.id']);
    if (!objects.has(`/identity/identityProviders/${id}`)) return { ok: false, status: 400, body: { error: { code: 'InvalidIdentityProvider' } } };
    return save({ identityProviders: [...flow.identityProviders, { id, name: id, type: id }] });
  }
  if (part === 'userAttributeAssignments' && !rest && method === 'POST') {
    const attribute = objects.get(`/identity/userFlowAttributes/${body.userAttribute?.id}`);
    if (!attribute) return { ok: false, status: 400, body: { error: { code: 'InvalidAttribute' } } };
    const assignment = { ...body, id: attribute.id, userAttribute: attribute };
    objects.set(flowPath, { ...flow, userAttributeAssignments: [...flow.userAttributeAssignments, assignment] });
    return { ok: true, status: 201, body: assignment };
  }
  if (part === 'userAttributeAssignments' && rest === 'setOrder' && method === 'POST') {
    const order = body.newAssignmentOrder.order;
    if (order.length !== flow.userAttributeAssignments.length) return { ok: false, status: 400, body: { error: { code: 'InvalidOrder' } } };
    return save({ userAttributeAssignments: order.map((id) => flow.userAttributeAssignments.find((assignment) => assignment.id === id)) });
  }
  if (part === 'userAttributeAssignments' && rest && method === 'PATCH') {
    const id = decodeURIComponent(rest);
    if (!flow.userAttributeAssignments.some((assignment) => assignment.id === id)) return { ok: false, status: 404, body: null };
    return save({ userAttributeAssignments: flow.userAttributeAssignments.map((assignment) => (assignment.id === id ? { ...assignment, ...body } : assignment)) });
  }
  if (part === 'languages' && rest && method === 'PATCH') {
    const id = decodeURIComponent(rest);
    if (!flow.languages.some((language) => language.id === id)) return { ok: false, status: 404, body: null };
    return save({ languages: flow.languages.map((language) => (language.id === id ? { ...language, ...body } : language)) });
  }
  const step = /^(postFederationSignup|postAttributeCollection)\/\$ref$/.exec(rest ?? '');
  if (part === 'apiConnectorConfiguration' && step && method === 'PUT') {
    const connector = objects.get(`/identity/apiConnectors/${idOf(body['@odata.id'])}`);
    if (!connector) return { ok: false, status: 400, body: { error: { code: 'InvalidApiConnector' } } };
    return save({ apiConnectorConfiguration: { ...flow.apiConnectorConfiguration, [step[1]]: { id: connector.id, displayName: connector.displayName } } });
  }
  return { ok: false, status: 405, body: null };
}
export function userFlowRead(objects, requested) {
  const [path, query = ''] = requested.split('?');
  const match = USER_FLOW.exec(path);
  if (!match) return null;
  const flow = objects.get(`/identity/b2xUserFlows/${match[1]}`);
  if (!flow) return { ok: false, status: 404, body: { error: { code: 'Request_ResourceNotFound' } } };
  if (match[2] && match[2] !== 'apiConnectorConfiguration' && !match[3]) return { ok: true, status: 200, body: { value: flow[match[2]] } };
  if (match[2]) return null;
  // The flow itself; its connector steps only when expanded, as Graph returns them.
  const { identityProviders: _providers, userAttributeAssignments: _assignments, languages: _languages, apiConnectorConfiguration, ...own } = flow;
  return { ok: true, status: 200, body: query.includes('apiConnectorConfiguration') ? { ...own, apiConnectorConfiguration } : own };
}
