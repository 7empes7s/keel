/**
 * Issue #1073: attack simulations (attackSimulationOperations.mjs), from the
 * catalog read through the store to the restore, against an in-memory attack
 * simulation Graph in the shapes the v1.0 references document
 * (attacksimulationroot-list-simulations, attacksimulationroot-post-simulation,
 * simulation-update). The applyWave tests drive the production path: this file
 * is the remapping proof qualification.mjs records for create and update.
 */
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { get } from '../collect/registry.mjs';
import { capabilityFor } from '../coverage/capabilities.mjs';
import { TYPE_DECISIONS, remappingFor } from '../coverage/qualification.mjs';
import { createSnapshot, getResourceVersions, insertResourceVersion } from '../store/db.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { GraphReader } from '../../tools/tenant-probe/graph.mjs';
import { catalogEntryFor } from '../../tools/tenant-probe/catalog.mjs';
import { applyWave } from './applyEngine.mjs';
import { LAUNCHING_STATUSES, SIMULATIONS, assertDraftOnly, simulationRequest } from './attackSimulationOperations.mjs';
import { TRUST_FIELD_PATTERN } from './workloads/writeDeclarations.mjs';

const G = 'https://graph.microsoft.com/v1.0';
const ROOT = '/security/attackSimulation';
const FAST = { readAfterWriteOptions: { attempts: 2, delayMs: 0 } };
const governor = { async acquire() {}, observeRetryAfter() {} };

const SOURCE_SIMULATION = 'f1b13829-3829-f1b1-2938-b1f12938b1a1';
const SOURCE_PAYLOAD = 'aaaaaaaa-0000-4000-8000-000000001073';
const TARGET_PAYLOAD = 'bbbbbbbb-0000-4000-8000-000000001073';
const LANDING_PAGE = 'cccccccc-0000-4000-8000-000000001073';
const KEY = `attackSimulation:${SOURCE_SIMULATION}`;
const CARLA = 'carla@contoso.example';

/** A simulation as Graph lists it with the catalog's $select: a finished credential harvest. */
const graphSimulation = (extra = {}) => ({
  id: SOURCE_SIMULATION, displayName: 'KEEL-RT-1073-simulation', description: 'Quarterly phishing test',
  attackType: 'social', attackTechnique: 'credentialHarvesting', payloadDeliveryPlatform: 'email',
  status: 'succeeded', durationInDays: 7, isAutomated: false, automationId: '',
  createdDateTime: '2026-09-01T10:00:00Z', lastModifiedDateTime: '2026-09-01T10:00:00Z',
  launchDateTime: '2026-09-02T09:00:00Z', completionDateTime: '2026-09-09T09:00:00Z',
  createdBy: { id: 'aaaaaaaa-0000-4000-8000-000000000001', displayName: 'Admin', email: 'admin@contoso.example' },
  lastModifiedBy: { id: 'aaaaaaaa-0000-4000-8000-000000000001', displayName: 'Admin', email: 'admin@contoso.example' },
  includedAccountTarget: { '@odata.type': '#microsoft.graph.addressBookAccountTargetContent', type: 'addressBook', accountTargetEmails: [CARLA] },
  excludedAccountTarget: null,
  trainingSetting: { settingType: 'microsoftCustom' },
  endUserNotificationSetting: { notificationPreference: 'microsoft', settingType: 'training' },
  oAuthConsentAppDetail: null,
  ...extra,
});

// ------------------------------------------------------------------- backup

const respond = (body, status = 200) => ({ ok: status === 200, status, headers: { get: () => null }, json: async () => body });
async function withRoutes(routes, fn) {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, opts) => {
    assert.equal(opts.method, 'GET', 'reads only');
    urls.push(url);
    assert.ok(routes[url], `unexpected request ${url}`);
    return routes[url]();
  };
  try { return { result: await fn(), urls }; } finally { globalThis.fetch = original; }
}
const SIMULATION_LIST = `${G}${SIMULATIONS}?$select=${catalogEntryFor('attackSimulation').select}`;
const ROUTES = {
  [SIMULATION_LIST]: () => respond({ value: [graphSimulation()] }),
  [`${G}${SIMULATIONS}/${SOURCE_SIMULATION}/payload`]: () => respond({
    '@odata.context': `${G}/$metadata#security/attackSimulation/simulations('${SOURCE_SIMULATION}')/payload/$entity`,
    id: SOURCE_PAYLOAD, displayName: 'KEEL-RT-1073-payload', source: 'tenant', status: 'ready', technique: 'credentialHarvesting',
  }),
  // A simulation with no login page of its own answers 404 for it.
  [`${G}${SIMULATIONS}/${SOURCE_SIMULATION}/loginPage`]: () => respond({ error: { code: 'ResourceNotFound' } }, 404),
  [`${G}${SIMULATIONS}/${SOURCE_SIMULATION}/landingPage`]: () => respond({ id: LANDING_PAGE, displayName: 'Microsoft Landing Page Template', source: 'global' }),
};
const reader = () => new GraphReader(async () => 'fixture-token');

test('the backup names each simulation\'s payload and landing page by id and name, and keeps none it has not', async () => {
  const { result, urls } = await withRoutes(ROUTES, () => get('attackSimulation').adapter.collect(reader()));
  assert.equal(urls.length, 4);
  const [simulation] = result;
  assert.deepEqual(simulation.payload, { id: SOURCE_PAYLOAD, displayName: 'KEEL-RT-1073-payload' });
  assert.deepEqual(simulation.landingPage, { id: LANDING_PAGE, displayName: 'Microsoft Landing Page Template' });
  assert.equal('loginPage' in simulation, false);
});

const database = await createIsolatedTestDatabase(import.meta.url);
const client = await database.connect();
await client.query(schemaSql());
after(async () => { await client.end(); await database.cleanup(); });

/** The backup's simulation as the store gives it back. */
async function storedSimulation(extra = {}) {
  const { result } = await withRoutes(ROUTES, () => get('attackSimulation').adapter.collect(reader()));
  const stored = canonicalizeAll([['attackSimulation', [{ ...result[0], ...extra }]]])[0];
  const snapshotId = await createSnapshot(client, { tenantRef: 'sha256:attack-simulation-test' });
  await insertResourceVersion(client, { snapshotId, resource: { ...stored, fidelity: stored.provenance.fidelity } });
  const [row] = await getResourceVersions(client, { snapshotId });
  return { naturalKey: row.naturalKey ?? stored.naturalKey, resourceType: 'attackSimulation', payload: row.payload, references: stored.references ?? [] };
}

test('the stored simulation keeps the content it binds', async () => {
  const resource = await storedSimulation();
  assert.equal(resource.naturalKey, KEY);
  assert.equal(resource.payload.payload.id, SOURCE_PAYLOAD);
  assert.equal(resource.payload.landingPage.id, LANDING_PAGE);
});

// ------------------------------------------------------------------ restore

/**
 * Attack simulation training in memory. Content and people are what the target
 * holds; a create answers 202 with no body, like Graph. `fail` names path
 * prefixes whose reads answer 500.
 */
function simulationGraph({ simulations = [], payloads = [], landingPages = [], loginPages = [], users = [{ userPrincipalName: CARLA, mail: CARLA }], fail = [] } = {}) {
  const content = { payloads, landingPages, loginPages };
  const state = { simulations: simulations.map((row) => structuredClone(row)) };
  const calls = [];
  let next = 0;
  const ok = (status, body) => ({ ok: true, status, body: structuredClone(body) });
  const notFound = () => ({ ok: false, status: 404, body: { error: { code: 'ResourceNotFound' } } });
  const unbind = (body) => Object.fromEntries(Object.entries(body).map(([key, value]) => {
    const bound = /^(\w+)@odata\.bind$/.exec(key);
    return bound ? [bound[1], { id: String(value).split('/').pop() }] : [key, value];
  }));
  return {
    state,
    calls,
    async read(version, path) {
      calls.push({ method: 'GET', version, path });
      const [base, rawQuery = ''] = path.split('?');
      const query = decodeURIComponent(rawQuery);
      if (fail.some((prefix) => base.startsWith(prefix))) return { ok: false, status: 500, body: { error: { code: 'InternalServerError' } } };
      const named = /displayName eq '((?:[^']|'')*)'/.exec(query)?.[1]?.replaceAll("''", "'");
      if (base === SIMULATIONS) return ok(200, { value: state.simulations.filter((row) => !named || row.displayName === named) });
      const part = /^\/security\/attackSimulation\/simulations\/([^/]+)\/(payload|loginPage|landingPage)$/.exec(base);
      if (part) {
        const held = state.simulations.find((row) => row.id === part[1])?.[part[2]];
        return held?.id ? ok(200, { id: held.id, displayName: 'As bound' }) : notFound();
      }
      const one = /^\/security\/attackSimulation\/simulations\/([^/]+)$/.exec(base);
      if (one) {
        const row = state.simulations.find((candidate) => candidate.id === one[1]);
        return row ? ok(200, Object.fromEntries(Object.entries(row).filter(([key]) => !['payload', 'loginPage', 'landingPage'].includes(key)))) : notFound();
      }
      const item = /^\/security\/attackSimulation\/(payloads|loginPages|landingPages)(?:\/([^/]+))?$/.exec(base);
      if (item) {
        if (item[2]) return content[item[1]].find((row) => row.id === item[2]) ? ok(200, content[item[1]].find((row) => row.id === item[2])) : notFound();
        assert.match(query, /source eq 'tenant'/);
        return ok(200, { value: content[item[1]].filter((row) => row.source === 'tenant' && (!named || row.displayName === named)) });
      }
      if (base === '/users') {
        const emails = [...query.matchAll(/(?:userPrincipalName|mail) eq '([^']*)'/g)].map(([, email]) => email.toLowerCase());
        return ok(200, { value: users.filter((row) => emails.includes(row.userPrincipalName.toLowerCase())).map((row, index) => ({ id: `user-${index}`, ...row })) });
      }
      return notFound();
    },
    async write(version, path, { method, body }) {
      calls.push({ method, version, path, body: structuredClone(body) });
      if (method === 'POST' && path === SIMULATIONS) {
        next += 1;
        state.simulations.push({ ...unbind(body), id: `simulation-${next}` });
        return ok(202, null);
      }
      const one = /^\/security\/attackSimulation\/simulations\/([^/]+)$/.exec(path);
      if (method === 'PATCH' && one) {
        const index = state.simulations.findIndex((row) => row.id === one[1]);
        if (index < 0) return notFound();
        state.simulations[index] = { ...state.simulations[index], ...unbind(body) };
        return ok(202, null);
      }
      return notFound();
    },
  };
}

const writes = (graph) => graph.calls.filter((call) => call.method !== 'GET');
const targetPayload = (extra = {}) => ({ id: TARGET_PAYLOAD, displayName: 'KEEL-RT-1073-payload', source: 'tenant', ...extra });
const globalLandingPage = { id: LANDING_PAGE, displayName: 'Microsoft Landing Page Template', source: 'global' };
const run = (graph, resources, extra = {}) => applyWave(graph, governor, resources, { targetTenant: 'fixture-tenant', mode: 'enforce', ...FAST, ...extra });

/** Every write body: a draft, no launch date, no trust field, at any depth. */
function onlyDrafts(graph) {
  for (const call of writes(graph)) {
    assert.equal(call.body.status, 'draft', `${call.method} ${call.path} sends status ${call.body.status}`);
    assert.ok(!LAUNCHING_STATUSES.includes(call.body.status));
    assert.equal('launchDateTime' in call.body, false);
    assert.equal(TRUST_FIELD_PATTERN.test(JSON.stringify(Object.keys(call.body))), false);
  }
}

test('remapping proof: create and update are qualified by this file', () => {
  for (const verb of ['create', 'update']) {
    assert.equal(remappingFor('attackSimulation', verb).proofRef, 'engine/restore/attackSimulationOperations.test.mjs');
    assert.equal(capabilityFor('attackSimulation', verb).claim, 'fixture-tested');
  }
  assert.equal(TYPE_DECISIONS.attackSimulation.decision, 'automated');
});

test('a launched simulation is recreated as a draft bound to the target\'s payload, and launching is left to a person', async () => {
  const resource = { ...(await storedSimulation({ status: 'scheduled' })), verb: 'create' };
  assert.equal(resource.payload.status, 'scheduled');
  const graph = simulationGraph({ payloads: [targetPayload()], landingPages: [globalLandingPage] });
  const result = await run(graph, [resource]);
  assert.deepEqual(result.failed, [], JSON.stringify(result.failed));
  assert.equal(result.applied.length, 1);
  const [post] = writes(graph);
  assert.equal(post.method, 'POST');
  assert.equal(post.path, SIMULATIONS);
  // The backup's payload is not in the target: the one with its name is bound instead.
  assert.equal(post.body['payload@odata.bind'], `${G}${ROOT}/payloads/${TARGET_PAYLOAD}`);
  assert.equal(post.body['landingPage@odata.bind'], `${G}${ROOT}/landingPages/${LANDING_PAGE}`);
  assert.equal('loginPage@odata.bind' in post.body, false);
  for (const field of ['payload', 'landingPage', 'trainingSetting', 'endUserNotificationSetting', 'createdBy', 'completionDateTime', 'id']) assert.equal(field in post.body, false, field);
  assert.deepEqual(post.body.includedAccountTarget.accountTargetEmails, [CARLA]);
  onlyDrafts(graph);
  assert.equal(graph.state.simulations[0].status, 'draft');
  assert.equal(result.applied[0].targetId, 'simulation-1');
  const launch = result.applied[0].completion.find((step) => step.requirement === 'attackSimulationLaunch');
  assert.match(launch.description, /never launches it/);
  assert.match(launch.description, /training, end-user notifications/);
});

test('no write body sets a launching status, whatever the backup says', async () => {
  for (const status of [...LAUNCHING_STATUSES, 'succeeded', 'draft']) {
    const graph = simulationGraph({ payloads: [targetPayload({ id: SOURCE_PAYLOAD })], landingPages: [globalLandingPage] });
    const backup = { naturalKey: KEY, resourceType: 'attackSimulation', verb: 'create', payload: { ...graphSimulation({ status }), payload: { id: SOURCE_PAYLOAD } } };
    const result = await run(graph, [backup]);
    assert.equal(result.applied.length, 1, `${status}: ${JSON.stringify(result.failed)}`);
    assert.equal(writes(graph).length, 1);
    onlyDrafts(graph);
  }
});

test('a body that would launch or schedule is refused before it is sent', () => {
  for (const status of LAUNCHING_STATUSES) {
    assert.throws(() => simulationRequest({ displayName: 'x', status }), /only ever written as a draft/);
  }
  assert.throws(() => assertDraftOnly({ displayName: 'x' }), /only ever written as a draft/);
  assert.throws(() => assertDraftOnly({ status: 'draft', launchDateTime: '2026-12-01T00:00:00Z' }), /never sets a launch date/);
  assert.deepEqual(simulationRequest({ status: 'draft', payload: { id: TARGET_PAYLOAD, displayName: 'n' } }), { status: 'draft', 'payload@odata.bind': `${G}${ROOT}/payloads/${TARGET_PAYLOAD}` });
});

test('a missing payload holds the simulation, and nothing is written', async () => {
  const graph = simulationGraph({ landingPages: [globalLandingPage] });
  const result = await run(graph, [{ ...(await storedSimulation()), verb: 'create' }]);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /^manual: .*the payload "KEEL-RT-1073-payload", which is not in the target/);
  assert.equal(writes(graph).length, 0);
});

test('a backup that does not name its payload holds the create: Graph needs one', async () => {
  const graph = simulationGraph({ payloads: [targetPayload()] });
  const result = await run(graph, [{ naturalKey: KEY, resourceType: 'attackSimulation', verb: 'create', payload: graphSimulation() }]);
  assert.match(result.skipped[0]?.reason ?? '', /does not say which payload .* Take a new backup/);
  assert.equal(writes(graph).length, 0);
});

test('two target payloads with the backup\'s name hold the simulation', async () => {
  const graph = simulationGraph({ payloads: [targetPayload(), targetPayload({ id: 'other' })], landingPages: [globalLandingPage] });
  const result = await run(graph, [{ ...(await storedSimulation()), verb: 'create' }]);
  assert.match(result.skipped[0]?.reason ?? '', /more than one payload named/);
  assert.equal(writes(graph).length, 0);
});

test('a targeted person missing from the target holds the simulation', async () => {
  const graph = simulationGraph({ payloads: [targetPayload()], landingPages: [globalLandingPage], users: [] });
  const result = await run(graph, [{ ...(await storedSimulation()), verb: 'create' }]);
  assert.match(result.skipped[0]?.reason ?? '', /targets a person who is not in the target \(carla@contoso\.example\)/);
  assert.equal(writes(graph).length, 0);
});

test('a failed lookup sends nothing', async () => {
  for (const fail of [['/users'], [`${ROOT}/payloads`]]) {
    const graph = simulationGraph({ payloads: [targetPayload()], landingPages: [globalLandingPage], fail });
    const result = await run(graph, [{ ...(await storedSimulation()), verb: 'create' }]);
    assert.equal(result.failed.length, 1, String(fail));
    assert.match(result.failed[0].error, /^dependency: /);
    assert.equal(writes(graph).length, 0);
  }
});

test('the dry run reads but writes nothing, and lists the launch step', async () => {
  const graph = simulationGraph({ payloads: [targetPayload()], landingPages: [globalLandingPage] });
  const result = await run(graph, [{ ...(await storedSimulation()), verb: 'create' }], { mode: 'dry-run' });
  assert.equal(result.applied.length, 1);
  assert.ok(result.applied[0].completion.some((step) => step.requirement === 'attackSimulationLaunch'));
  assert.equal(writes(graph).length, 0);
});

test('a simulation with the backup\'s name already in the target is not created again', async () => {
  const graph = simulationGraph({ payloads: [targetPayload()], landingPages: [globalLandingPage], simulations: [{ id: 'live-1', displayName: 'KEEL-RT-1073-simulation', status: 'draft' }] });
  const result = await run(graph, [{ ...(await storedSimulation()), verb: 'create' }]);
  assert.match(result.skipped[0]?.reason ?? '', /already has a simulation named/);
  assert.equal(writes(graph).length, 0);
});

test('a simulation an automation made is left to the automation', async () => {
  const graph = simulationGraph({ payloads: [targetPayload()] });
  const result = await run(graph, [{ ...(await storedSimulation({ isAutomated: true, automationId: 'auto-1' })), verb: 'create' }]);
  assert.match(result.skipped[0]?.reason ?? '', /made by an attack simulation automation/);
  assert.equal(writes(graph).length, 0);
});

/** An update of the live draft `live` back to the backup. */
async function updateOf(live) {
  const resource = await storedSimulation();
  const graph = simulationGraph({ payloads: [targetPayload()], landingPages: [globalLandingPage], simulations: [live] });
  const livePayload = { ...live, payload: { id: live.payload.id, displayName: 'As bound' } };
  return { graph, resource: { ...resource, verb: 'update', targetId: live.id, live: { state: 'present', targetId: live.id, payload: livePayload } } };
}

test('a draft is changed back whole, still as a draft, with its payload bound and no page sent', async () => {
  const { graph, resource } = await updateOf({ ...graphSimulation({ id: 'live-1', status: 'draft', displayName: 'KEEL-RT-1073-simulation', durationInDays: 2 }), payload: { id: 'stale-payload' } });
  const result = await run(graph, [resource]);
  assert.deepEqual(result.failed, [], JSON.stringify(result.failed));
  assert.equal(result.applied.length, 1);
  const [patch] = writes(graph);
  assert.equal(patch.method, 'PATCH');
  assert.equal(patch.path, `${SIMULATIONS}/live-1`);
  assert.equal(patch.body.durationInDays, 7);
  assert.equal(patch.body['payload@odata.bind'], `${G}${ROOT}/payloads/${TARGET_PAYLOAD}`);
  for (const field of ['landingPage@odata.bind', 'loginPage@odata.bind', 'description', 'payloadDeliveryPlatform']) assert.equal(field in patch.body, false, field);
  onlyDrafts(graph);
});

test('a launched simulation is not changed: Graph changes only drafts, so a person compares it', async () => {
  const { graph, resource } = await updateOf({ ...graphSimulation({ id: 'live-1', status: 'running', durationInDays: 2 }), payload: { id: TARGET_PAYLOAD } });
  const result = await run(graph, [resource]);
  assert.equal(result.applied.length, 0);
  assert.match(result.skipped[0]?.reason ?? '', /has already been launched \(its status is running\)/);
  assert.equal(writes(graph).length, 0);
});

test('a draft that already matches the backup sends nothing', async () => {
  const { graph, resource } = await updateOf({ ...graphSimulation({ id: 'live-1', status: 'draft' }), payload: { id: TARGET_PAYLOAD } });
  const result = await run(graph, [resource]);
  assert.equal(result.applied.length, 1, JSON.stringify(result));
  assert.equal(result.applied[0].completion, undefined);
  assert.equal(writes(graph).length, 0);
});

test('a delete is not registered', async () => {
  assert.equal(capabilityFor('attackSimulation', 'delete').claim, 'unsupported');
  const graph = simulationGraph({ simulations: [{ id: 'live-1', displayName: 'x', status: 'draft' }] });
  const result = await run(graph, [{ naturalKey: KEY, resourceType: 'attackSimulation', verb: 'delete', payload: null, targetId: 'live-1', live: { targetId: 'live-1', payload: { id: 'live-1' } } }]);
  assert.equal(result.applied.length, 0);
  assert.equal(writes(graph).length, 0);
});
