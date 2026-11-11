/**
 * Issue #1073: the attack simulation fixture for the operations harness
 * (operations.mjs): a simulation as the backup holds it, the content and person
 * the target needs for it, and the fake Graph routes for simulations.
 */
const ROOT = '/security/attackSimulation';
const SIMULATIONS = `${ROOT}/simulations`;

// A credential harvest simulation as the list returns it, with the payload,
// login and landing pages the backup reads per simulation.
export const ATTACK_SIMULATION_PAYLOAD = Object.freeze({
  displayName: 'Fixture simulation', description: 'Fixture', attackType: 'social', attackTechnique: 'credentialHarvesting',
  payloadDeliveryPlatform: 'email', status: 'draft', durationInDays: 7, isAutomated: false, automationId: '',
  createdDateTime: '2026-01-01T00:00:00Z', launchDateTime: null, completionDateTime: null,
  createdBy: { id: 'fixture-source-user', displayName: 'Fixture admin', email: 'admin@fixture.example' },
  includedAccountTarget: { '@odata.type': '#microsoft.graph.addressBookAccountTargetContent', type: 'addressBook', accountTargetEmails: ['carla@fixture.example'] },
  excludedAccountTarget: null, trainingSetting: null, endUserNotificationSetting: null, oAuthConsentAppDetail: null,
  payload: { id: 'fixture-payload', displayName: 'Fixture payload' },
  loginPage: { id: 'fixture-login-page', displayName: 'Fixture login page' },
  landingPage: { id: 'fixture-landing-page', displayName: 'Fixture landing page' },
});

/** The payload, pages and targeted person the target holds. */
export function seedAttackSimulation(graph) {
  for (const [collection, id] of [['payloads', 'fixture-payload'], ['loginPages', 'fixture-login-page'], ['landingPages', 'fixture-landing-page']]) {
    graph.objects.set(`${ROOT}/${collection}/${id}`, { id, displayName: 'Fixture content', source: 'tenant' });
  }
  graph.objects.set('/users/fixture-user', { id: 'fixture-user', userPrincipalName: 'carla@fixture.example', mail: 'carla@fixture.example' });
}

/** A create answers 202 with no body, like Graph, and each @odata.bind is kept as the bound object's id. */
export function attackSimulationWrite(objects, path, method, body, nextId) {
  if (!(method === 'POST' && path === SIMULATIONS) && !(method === 'PATCH' && path.startsWith(`${SIMULATIONS}/`) && objects.has(path))) return null;
  const fields = {};
  for (const [key, value] of Object.entries(body ?? {})) {
    const bound = /^(\w+)@odata\.bind$/.exec(key);
    if (bound) fields[bound[1]] = { id: decodeURIComponent(String(value).split('/').pop()) };
    else fields[key] = value;
  }
  if (method === 'PATCH') objects.set(path, { ...objects.get(path), ...fields });
  else {
    const id = `fixture-${nextId()}`;
    objects.set(`${path}/${id}`, { ...fields, id });
  }
  return { ok: true, status: 202, body: null };
}

/** The simulations by name, a simulation's bound content, and people by email; null for any other path. */
export function attackSimulationRead(objects, requested) {
  const [path, rawQuery = ''] = requested.split('?');
  const query = decodeURIComponent(rawQuery);
  const children = (prefix) => [...objects.entries()].filter(([key]) => key.startsWith(`${prefix}/`) && !key.slice(prefix.length + 1).includes('/')).map(([, object]) => object);
  if (path === SIMULATIONS) {
    const named = /displayName eq '((?:[^']|'')*)'/.exec(query)?.[1]?.replaceAll("''", "'");
    return { ok: true, status: 200, body: { value: children(SIMULATIONS).filter((object) => !named || object.displayName === named) } };
  }
  const part = /^(\/security\/attackSimulation\/simulations\/[^/]+)\/(payload|loginPage|landingPage)$/.exec(path);
  if (part) {
    const held = objects.get(part[1])?.[part[2]];
    return held?.id ? { ok: true, status: 200, body: held } : { ok: false, status: 404, body: null };
  }
  if (path === '/users') {
    const emails = [...query.matchAll(/(?:userPrincipalName|mail) eq '([^']*)'/g)].map(([, email]) => email.toLowerCase());
    const value = children('/users').filter((object) => emails.includes(String(object.userPrincipalName).toLowerCase()) || emails.includes(String(object.mail).toLowerCase()));
    return { ok: true, status: 200, body: { value } };
  }
  return null;
}
