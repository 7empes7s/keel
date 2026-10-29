/**
 * Wave 2 ENTRA boundary tests: best-effort recreate of incomplete
 * configurations, and the writers for app consents and for token lifetime,
 * token issuance, claims mapping, home realm discovery and app consent
 * policies.
 *
 * Exercises engine/restore/directoryPolicyOperations.mjs and
 * engine/restore/bestEffortRecreate.mjs through the production applyWave()
 * path. Microsoft Graph is an in-memory fake only; no tenant is read or
 * written.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { fakeGraph } from '../../tools/qualification/operations.mjs';
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { ENTRA_PROOF, ENTRA_WRITE_OPERATIONS, ENTRA_WRITE_PATHS } from '../coverage/capabilities.d/entra.mjs';
import { OPERATIONS, capabilityFor, isSupportedClaim } from '../coverage/capabilities.mjs';
import { completenessFor } from '../coverage/completeness.mjs';
import { TYPE_DECISIONS, buildExpansionInventory, qualificationFor } from '../coverage/qualification.mjs';
import { applyWave } from '../restore/applyEngine.mjs';
import {
  ADMIN_CENTER_PATHS, bestEffortCreate, byHandSteps, followUpSteps, recreateBody,
} from '../restore/bestEffortRecreate.mjs';
import { completionItemsFor } from '../restore/completion.mjs';
import { DIRECTORY_POLICY_RECORDS, definitionProblem } from '../restore/directoryPolicyOperations.mjs';
import { buildReconciliationPlan } from '../reconcile/reconciliationPlan.mjs';

const governor = { async acquire() {}, observeRetryAfter() {} };
const STS_TYPES = ['tokenLifetimePolicy', 'tokenIssuancePolicy', 'claimsMappingPolicy', 'homeRealmDiscoveryPolicy'];
const WRITER_TYPES = [...STS_TYPES, 'permissionGrantPolicy', 'oauth2PermissionGrant', 'servicePrincipalCreationPolicy'];
const SETS = '(?:permissionGrantPolicies|servicePrincipalCreationPolicies)';
const CREATION = '/policies/servicePrincipalCreationPolicies';

/**
 * fakeGraph plus: a collection read lists the objects under it (with the
 * clientId filter Graph offers for grants), every write is recorded, and an
 * optional override changes what reads return.
 */
function directoryGraph({ readOverride = null } = {}) {
  const graph = fakeGraph();
  const bodies = [];
  const write = graph.write.bind(graph);
  const read = graph.read.bind(graph);
  graph.write = async (version, path, request) => {
    bodies.push({ method: request.method, path, body: request.body });
    // A permission grant policy is created under the id it is given.
    if (request.method === 'POST' && path === '/policies/permissionGrantPolicies') {
      const created = { ...request.body };
      graph.objects.set(`${path}/${request.body.id}`, created);
      return { ok: true, status: 201, body: created };
    }
    // Graph gives a created app creation policy its own id; it is a custom one.
    if (request.method === 'POST' && path === CREATION) {
      const created = { ...request.body, id: `creation-${graph.objects.size + 1}`, isBuiltIn: false };
      graph.objects.set(`${path}/${created.id}`, created);
      return { ok: true, status: 201, body: created };
    }
    // A condition set is added to its policy's list.
    const set = new RegExp(`^(/policies/${SETS}/[^/]+)/(includes|excludes)$`).exec(path);
    if (set && request.method === 'POST') {
      if (!graph.objects.has(set[1])) return { ok: false, status: 404, body: null };
      const listPath = `${set[1]}/${set[2]}`;
      const list = graph.objects.get(listPath)?.value ?? [];
      const created = { ...request.body, id: `condition-${list.length + 1}` };
      graph.objects.set(listPath, { value: [...list, created] });
      return { ok: true, status: 201, body: created };
    }
    // A condition set is removed from its policy's list by its id.
    const member = new RegExp(`^(/policies/${SETS}/[^/]+/(?:includes|excludes))/([^/]+)$`).exec(path);
    if (member && request.method === 'DELETE') {
      const list = graph.objects.get(member[1])?.value ?? [];
      const id = decodeURIComponent(member[2]);
      if (!list.some((condition) => condition.id === id)) return { ok: false, status: 404, body: null };
      // Graph refuses a consent policy with no include (issue #294, Q75).
      if (member[1].endsWith('/includes') && list.length === 1) {
        return { ok: false, status: 400, body: { error: { code: 'Request_BadRequest', message: 'PermissionGrantPolicy should contain an Includes PermissionGrantConditionSet.' } } };
      }
      graph.objects.set(member[1], { value: list.filter((condition) => condition.id !== id) });
      return { ok: true, status: 204, body: null };
    }
    return write(version, path, request);
  };
  graph.read = async (version, requested) => {
    const [path, query = ''] = requested.split('?');
    const collection = Object.values(DIRECTORY_POLICY_RECORDS).some((entry) => entry.collection === path);
    let result;
    if (collection) {
      const clientId = /clientId eq '([^']*)'/.exec(decodeURIComponent(query))?.[1];
      const value = [...graph.objects.entries()]
        .filter(([key]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/'))
        .map(([, object]) => object)
        .filter((object) => !clientId || object.clientId === clientId);
      result = { ok: true, status: 200, body: { value } };
    } else {
      const set = new RegExp(`^/policies/${SETS}/[^/]+/(includes|excludes)$`).exec(path);
      result = set && !graph.objects.has(path) && graph.objects.has(path.replace(/\/(includes|excludes)$/, ''))
        ? { ok: true, status: 200, body: { value: [] } }
        : await read(version, requested);
      // An app creation policy comes back with its condition sets expanded (Q111).
      if (result.ok && path.startsWith(`${CREATION}/`) && !path.slice(CREATION.length + 1).includes('/')) {
        const sets = Object.fromEntries(['includes', 'excludes'].map((name) => [name, graph.objects.get(`${path}/${name}`)?.value ?? []]));
        result = { ...result, body: { ...result.body, ...sets } };
      }
    }
    return readOverride && result.ok ? { ...result, body: readOverride(result.body, path) } : result;
  };
  graph.bodies = bodies;
  return graph;
}

const run = (graph, wave, options = {}) => applyWave(graph, governor, wave, {
  targetTenant: 'fixture', mode: 'enforce', readAfterWriteOptions: { attempts: 1, delayMs: 0 }, ...options,
});

const definitionFor = (type) => ({
  tokenLifetimePolicy: ['{"TokenLifetimePolicy":{"Version":1,"AccessTokenLifetime":"8:00:00"}}'],
  tokenIssuancePolicy: ['{"TokenIssuancePolicy":{"Version":1,"SigningAlgorithm":"http://www.w3.org/2001/04/xmldsig-more#rsa-sha256","TokenResponseSigningPolicy":"TokenOnly","SamlTokenVersion":"2.0"}}'],
  claimsMappingPolicy: ['{"ClaimsMappingPolicy":{"Version":1,"IncludeBasicClaimSet":"true","ClaimsSchema":[{"Source":"user","ID":"employeeid","JwtClaimType":"emp"}]}}'],
  homeRealmDiscoveryPolicy: ['{"HomeRealmDiscoveryPolicy":{"AccelerateToFederatedDomain":true,"PreferredDomain":"keel-rt.example"}}'],
}[type]);

function stsResource(type, verb, { payload = {}, live = null } = {}) {
  const snapshot = { id: `src-${type}`, displayName: `KEEL-RT-${type}`, definition: definitionFor(type), isOrganizationDefault: false, ...payload };
  return {
    naturalKey: `${type}:src-${type}`, resourceType: type, verb, payload: snapshot, references: [], blastRadius: 'access-affecting',
    ...(live ? { targetId: live.id, live: { state: 'present', targetId: live.id, payload: live } } : {}),
  };
}

// ------------------------------------------------------------- registration

test('each writer type is a fixture-tested create and update, delete is unsupported, and the ledger says automated', () => {
  assert.deepEqual(Object.keys(ENTRA_WRITE_PATHS).sort(), Object.keys(DIRECTORY_POLICY_RECORDS).sort());
  for (const type of WRITER_TYPES) {
    assert.equal(ENTRA_WRITE_PATHS[type], DIRECTORY_POLICY_RECORDS[type].collection, type);
    assert.equal(CATALOG.find((entry) => entry.type === type).path, DIRECTORY_POLICY_RECORDS[type].collection, `${type} writes the collection it is read from`);
    for (const operation of ENTRA_WRITE_OPERATIONS) {
      const capability = capabilityFor(type, operation);
      assert.equal(capability.claim, 'fixture-tested', `${type} ${operation}`);
      assert.equal(capability.proofRef, ENTRA_PROOF);
    }
    assert.deepEqual(OPERATIONS.filter((operation) => isSupportedClaim(capabilityFor(type, operation).claim)), ['create', 'update'], type);
    assert.equal(qualificationFor(type).decision, 'automated', type);
    assert.notEqual(completenessFor(type, TYPE_DECISIONS[type]).recreate, 'by-hand', type);
  }
  const inventory = buildExpansionInventory();
  const statuses = new Map(inventory.batches.flatMap((batch) => batch.types).map((entry) => [entry.resourceType, entry.status]));
  for (const type of WRITER_TYPES) assert.equal(statuses.get(type), 'qualified-subset', type);
});

test('the formerly unknown Entra types without a writer stay manual and are restored by hand', () => {
  const stillManual = ['certificateBasedAuthConfiguration', 'roleAssignmentSchedule', 'authenticationContextClassReference',
    'activityBasedTimeoutPolicy', 'featureRolloutPolicy', 'accessReviewScheduleDefinition', 'accessPackage', 'connectedOrganization'];
  for (const type of stillManual) {
    assert.equal(TYPE_DECISIONS[type].decision, 'manual', type);
    assert.equal(completenessFor(type, TYPE_DECISIONS[type]).recreate, 'by-hand', type);
  }
});

// ------------------------------------------------------- token and routing policies

for (const type of STS_TYPES) {
  test(`${type}: a create sends only the name and definition, never as the organization default, and verifies by read-back`, async () => {
    const graph = directoryGraph();
    const result = await run(graph, [stsResource(type, 'create')]);
    assert.deepEqual(result.failed, []);
    assert.equal(result.applied.length, 1);
    const [post] = graph.bodies;
    assert.equal(post.method, 'POST');
    assert.equal(post.path, DIRECTORY_POLICY_RECORDS[type].collection);
    assert.deepEqual(post.body, { displayName: `KEEL-RT-${type}`, definition: definitionFor(type), isOrganizationDefault: false });
    const { targetId, followUp } = result.applied[0];
    assert.ok(graph.objects.has(`${DIRECTORY_POLICY_RECORDS[type].collection}/${targetId}`));
    assert.deepEqual(followUp.map((step) => step.part), ['Which apps the policy is assigned to']);
  });
}

test('a policy that was the organization default is recreated as an ordinary one with a step to make it the default', async () => {
  const graph = directoryGraph();
  const result = await run(graph, [stsResource('homeRealmDiscoveryPolicy', 'create', { payload: { isOrganizationDefault: true } })]);
  assert.deepEqual(result.failed, []);
  assert.equal(graph.bodies[0].body.isOrganizationDefault, false);
  const parts = result.applied[0].followUp.map((step) => step.requirement);
  assert.ok(parts.includes('followUp:organization-default'), parts.join(', '));
  const step = result.applied[0].followUp.find((entry) => entry.requirement === 'followUp:organization-default');
  assert.match(step.description, /KEEL restored it as an ordinary policy/);
  assert.match(step.portalPath, /homeRealmDiscoveryPolicies/);
});

test('a re-run finds the policy it created and writes nothing', async () => {
  const graph = directoryGraph();
  const resource = stsResource('tokenLifetimePolicy', 'create');
  const first = await run(graph, [resource]);
  const writes = graph.bodies.length;
  const second = await run(graph, [resource]);
  assert.deepEqual(second.failed, []);
  assert.equal(second.applied[0].targetId, first.applied[0].targetId);
  assert.equal(graph.bodies.length, writes, 'no second POST');
});

test('issue #294: a dry run plans no recreate for a policy a re-run would adopt', async () => {
  const twin = { id: 'live-1', displayName: 'KEEL-RT-tokenLifetimePolicy', definition: definitionFor('tokenLifetimePolicy'), isOrganizationDefault: false };
  const other = { id: 'live-2', displayName: 'Someone else\'s policy', definition: definitionFor('tokenLifetimePolicy'), isOrganizationDefault: false };
  const plan = async (live, extraResources = []) => buildReconciliationPlan({
    async collect(version, path) {
      assert.ok(path.startsWith('/policies/tokenLifetimePolicies'), path);
      return { items: live, error: null };
    },
  }, [stsResource('tokenLifetimePolicy', undefined), ...extraResources]);

  const adopted = (await plan([twin, other])).resources[0];
  assert.equal(adopted.verb, 'noop', adopted.verbReason);
  assert.match(adopted.verbReason, /adopts live live-1/);
  assert.equal(adopted.recovery.mechanism, 'none');

  assert.equal((await plan([other])).resources[0].verb, 'create', 'no twin: recreated');
  assert.equal((await plan([twin, { ...twin, id: 'live-3' }])).resources[0].verb, 'create', 'two twins: left to the writer, which refuses');
  assert.equal((await plan([{ ...twin, isOrganizationDefault: true }])).resources[0].verb, 'create', 'a different default flag still goes through the writer');
  const held = stsResource('tokenLifetimePolicy', undefined, { payload: { id: 'live-1' } });
  const withHeld = await plan([twin], [{ ...held, naturalKey: 'tokenLifetimePolicy:live-1' }]);
  assert.equal(withHeld.resources[0].verb, 'create', 'a live object the backup holds under its own key is not adopted by another');
});

test('a definition with other spacing is the same definition', async () => {
  const graph = directoryGraph();
  graph.objects.set('/policies/tokenLifetimePolicies/live-1', {
    id: 'live-1', displayName: 'KEEL-RT-tokenLifetimePolicy', isOrganizationDefault: false,
    definition: ['{ "TokenLifetimePolicy": { "Version": 1, "AccessTokenLifetime": "8:00:00" } }'],
  });
  const result = await run(graph, [stsResource('tokenLifetimePolicy', 'create')]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied[0].targetId, 'live-1');
  assert.equal(graph.bodies.length, 0);
});

test('an update PATCHes only changed fields and never the organization default flag', async () => {
  const graph = directoryGraph();
  const live = { id: 'live-2', displayName: 'Renamed', definition: definitionFor('claimsMappingPolicy'), isOrganizationDefault: false };
  graph.objects.set('/policies/claimsMappingPolicies/live-2', live);
  const result = await run(graph, [stsResource('claimsMappingPolicy', 'update', { payload: { isOrganizationDefault: true }, live })]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies, [{ method: 'PATCH', path: '/policies/claimsMappingPolicies/live-2', body: { displayName: 'KEEL-RT-claimsMappingPolicy' } }]);
  assert.equal(graph.objects.get('/policies/claimsMappingPolicies/live-2').isOrganizationDefault, false);
  assert.ok(result.applied[0].followUp.some((step) => step.requirement === 'followUp:organization-default'));
});

test('a definition that is not JSON fails before any write', async () => {
  assert.equal(definitionProblem(['{"ok":true}']), null);
  assert.match(definitionProblem(['{broken']), /not valid JSON/);
  assert.match(definitionProblem([]), /non-empty/);
  const graph = directoryGraph();
  const result = await run(graph, [stsResource('tokenIssuancePolicy', 'create', { payload: { definition: ['{broken'] } })]);
  assert.match(result.failed[0].error, /definition\[0\] is not valid JSON/);
  assert.equal(graph.bodies.length, 0);
});

test('a create that does not read back as written is failed, never applied', async () => {
  const graph = directoryGraph({ readOverride: (body, path) => (/\/policies\/tokenLifetimePolicies\/fixture-/.test(path) ? { ...body, displayName: 'Something else' } : body) });
  const result = await run(graph, [stsResource('tokenLifetimePolicy', 'create')]);
  assert.equal(result.applied.length, 0);
  assert.match(result.failed[0].error, /post-state did not verify: displayName/);
});

test('a dry run writes nothing', async () => {
  const graph = directoryGraph();
  const result = await run(graph, [stsResource('tokenLifetimePolicy', 'create')], { mode: 'dry-run' });
  assert.equal(result.applied.length, 1);
  assert.equal(graph.bodies.length, 0);
});

test('delete is refused before any write', async () => {
  const graph = directoryGraph();
  const live = { id: 'live-3', displayName: 'x', definition: definitionFor('tokenLifetimePolicy') };
  graph.objects.set('/policies/tokenLifetimePolicies/live-3', live);
  const result = await run(graph, [{ ...stsResource('tokenLifetimePolicy', 'delete', { live }) }]);
  assert.match(result.failed[0].error, /unsupported operation: tokenLifetimePolicy delete/);
  assert.ok(graph.objects.has('/policies/tokenLifetimePolicies/live-3'));
});

// ------------------------------------------------------- app consent policies

const grantPolicy = (extra = {}) => ({
  id: 'keel-rt-low-risk', displayName: 'KEEL-RT low risk', description: 'Low-risk delegated permissions',
  includes: [{ permissionType: 'delegated', permissionClassification: 'low', resourceApplication: 'any', permissions: ['all'], clientApplicationIds: ['all'] }],
  excludes: [],
  ...extra,
});
const grantResource = (verb, payload = grantPolicy(), extra = {}) => ({
  naturalKey: `permissionGrantPolicy:${payload.displayName}`, resourceType: 'permissionGrantPolicy', verb, payload,
  references: [], blastRadius: 'access-affecting', ...extra,
});

test('an app consent policy is recreated under its id with the include rules the backup holds', async () => {
  const graph = directoryGraph();
  const result = await run(graph, [grantResource('create')]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies.map((write) => `${write.method} ${write.path}`), [
    'POST /policies/permissionGrantPolicies',
    'POST /policies/permissionGrantPolicies/keel-rt-low-risk/includes',
  ]);
  assert.deepEqual(graph.bodies[0].body, { id: 'keel-rt-low-risk', displayName: 'KEEL-RT low risk', description: 'Low-risk delegated permissions' });
  assert.equal(result.applied[0].targetId, 'keel-rt-low-risk');
  assert.deepEqual(result.applied[0].followUp, [], 'the backup held the rules, so nothing is left');
});

test('a just-created app consent policy that 404s its rules until it replicates still gets them (issue #294)', async () => {
  const graph = directoryGraph();
  const write = graph.write;
  let notYet = 3;
  graph.write = async (version, path, request) => {
    if (/\/includes$/.test(path) && notYet > 0) {
      notYet -= 1;
      graph.bodies.push({ method: request.method, path, body: request.body });
      return { ok: false, status: 404, body: { error: { code: 'Request_ResourceNotFound' } } };
    }
    return write(version, path, request);
  };
  const result = await run(graph, [grantResource('create')], {
    readAfterWriteOptions: { attempts: 1, delayMs: 0, replicationDelayMs: 0 },
  });
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied[0].targetId, 'keel-rt-low-risk');
  assert.equal(graph.bodies.filter((w) => w.path.endsWith('/includes')).length, 4, 'three 404s, then the write lands');
  assert.equal(graph.objects.get('/policies/permissionGrantPolicies/keel-rt-low-risk/includes').value.length, 1);
});

test('an app consent policy whose rules keep 404ing fails after the replication wait, and other errors fail at once', async () => {
  for (const [status, expected] of [[404, 3], [400, 1]]) {
    const graph = directoryGraph();
    const write = graph.write;
    graph.write = async (version, path, request) => {
      if (/\/includes$/.test(path)) {
        graph.bodies.push({ method: request.method, path, body: request.body });
        return { ok: false, status, body: { error: { code: 'x' } } };
      }
      return write(version, path, request);
    };
    const result = await run(graph, [grantResource('create')], {
      readAfterWriteOptions: { attempts: 1, delayMs: 0, replicationAttempts: 3, replicationDelayMs: 0 },
    });
    assert.equal(result.failed.length, 1, String(status));
    assert.equal(graph.bodies.filter((w) => w.path.endsWith('/includes')).length, expected, String(status));
  }
});

test('an app consent policy without its rules in the backup leaves a step to set them', async () => {
  const graph = directoryGraph();
  const { includes: _i, excludes: _e, ...bare } = grantPolicy();
  const result = await run(graph, [grantResource('create', bare)]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies.map((write) => write.path), ['/policies/permissionGrantPolicies']);
  assert.deepEqual(result.applied[0].followUp.map((step) => step.part), ['The include and exclude rules of a custom policy']);
});

const POLICY = '/policies/permissionGrantPolicies/keel-rt-low-risk';
const lowInclude = grantPolicy().includes[0];
const mediumInclude = { ...lowInclude, permissionClassification: 'medium' };

test('an existing app consent policy is brought back to exactly the backup\'s rules, its only extra include removed once the backup\'s is in', async () => {
  const graph = directoryGraph();
  graph.objects.set(POLICY, { id: 'keel-rt-low-risk', displayName: 'Renamed', description: 'Low-risk delegated permissions' });
  graph.objects.set(`${POLICY}/includes`, { value: [{ id: 'extra', permissionType: 'application', resourceApplication: 'any', permissions: ['all'] }] });
  const result = await run(graph, [grantResource('create')]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies.map((write) => `${write.method} ${write.path}`), [
    `PATCH ${POLICY}`,
    `POST ${POLICY}/includes`,
    `DELETE ${POLICY}/includes/extra`,
  ]);
  assert.deepEqual(graph.bodies[0].body, { displayName: 'KEEL-RT low risk' });
  const includes = graph.objects.get(`${POLICY}/includes`).value;
  assert.equal(includes.length, 1, 'the extra rule is removed');
  assert.equal(includes[0].permissionType, 'delegated');
  const again = await run(graph, [grantResource('create')]);
  assert.deepEqual(again.failed, []);
  assert.equal(graph.bodies.length, 3, 'a second run writes nothing');
});

test('issue #294: a drifted, wider include is replaced by the backup\'s, and a re-run converges to no writes', async () => {
  const graph = directoryGraph();
  graph.objects.set(POLICY, { id: 'keel-rt-low-risk', displayName: 'KEEL-RT low risk', description: 'Low-risk delegated permissions' });
  graph.objects.set(`${POLICY}/includes`, { value: [{ ...mediumInclude, id: 'drifted' }] });
  graph.objects.set(`${POLICY}/excludes`, { value: [] });
  const resource = grantResource('update', grantPolicy(), { targetId: 'keel-rt-low-risk', live: { state: 'present', targetId: 'keel-rt-low-risk', payload: graph.objects.get(POLICY) } });
  const result = await run(graph, [resource]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies.map((write) => `${write.method} ${write.path}`), [
    `POST ${POLICY}/includes`,
    `DELETE ${POLICY}/includes/drifted`,
  ], 'Graph refuses removing the only include, so the wider rule goes right after the backup\'s is added');
  assert.deepEqual(result.applied.map((applied) => applied.targetId), ['keel-rt-low-risk']);
  assert.deepEqual(graph.objects.get(`${POLICY}/includes`).value.map((condition) => condition.permissionClassification), ['low']);

  const dryRun = await run(graph, [resource], { mode: 'dry-run' });
  assert.deepEqual(dryRun.failed, []);
  const again = await run(graph, [resource]);
  assert.deepEqual(again.failed, []);
  assert.equal(graph.bodies.length, 2, 'a re-run from the same backup writes nothing');
});

test('issue #294 (Q79): a dry run plans no write for a consent policy whose rules match the backup under new ids', async () => {
  const backedUp = grantPolicy({ includes: [{ ...lowInclude, id: 'backup-include' }], excludes: [{ ...mediumInclude, id: 'backup-exclude' }] });
  const plan = async (live) => (await buildReconciliationPlan({
    async collect(version, path) {
      assert.equal(path, '/policies/permissionGrantPolicies');
      return { items: [live], error: null };
    },
  }, [{ ...grantResource(undefined, backedUp), naturalKey: `permissionGrantPolicy:${backedUp.id}`, sourceId: backedUp.id }], { sameTenant: true })).resources[0];

  const same = await plan(grantPolicy({ includes: [{ ...lowInclude, id: 'new-include' }], excludes: [{ ...mediumInclude, id: 'new-exclude' }] }));
  assert.equal(same.verb, 'noop', same.verbReason);
  assert.equal(same.recovery.mechanism, 'none');

  const wider = await plan(grantPolicy({ includes: [{ ...mediumInclude, id: 'backup-include' }], excludes: [{ ...mediumInclude, id: 'backup-exclude' }] }));
  assert.equal(wider.verb, 'update', 'a rule that differs in its fields is still a write');
  const noExclude = await plan(grantPolicy({ includes: [{ ...lowInclude, id: 'backup-include' }], excludes: [] }));
  assert.equal(noExclude.verb, 'update', 'a missing rule is still a write');
});

test('excludes converge too: a missing exclude is added before includes, an extra one removed last', async () => {
  const graph = directoryGraph();
  const backupExclude = { permissionType: 'delegated', resourceApplication: 'any', permissions: ['all'], clientApplicationIds: ['app-blocked'] };
  graph.objects.set(POLICY, { id: 'keel-rt-low-risk', displayName: 'KEEL-RT low risk', description: 'Low-risk delegated permissions' });
  graph.objects.set(`${POLICY}/includes`, { value: [{ ...mediumInclude, id: 'drifted' }] });
  graph.objects.set(`${POLICY}/excludes`, { value: [{ ...backupExclude, clientApplicationIds: ['app-other'], id: 'extra-exclude' }] });
  const result = await run(graph, [grantResource('create', grantPolicy({ excludes: [backupExclude] }))]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies.map((write) => `${write.method} ${write.path}`), [
    `POST ${POLICY}/excludes`,
    `POST ${POLICY}/includes`,
    `DELETE ${POLICY}/includes/drifted`,
    `DELETE ${POLICY}/excludes/extra-exclude`,
  ]);
  assert.deepEqual(graph.objects.get(`${POLICY}/excludes`).value.map((condition) => condition.clientApplicationIds), [['app-blocked']]);
});

test('issue #294: extra includes go first while another rule stays, and only the last waits for the backup\'s', async () => {
  const graph = directoryGraph();
  graph.objects.set(POLICY, { id: 'keel-rt-low-risk', displayName: 'KEEL-RT low risk', description: 'Low-risk delegated permissions' });
  graph.objects.set(`${POLICY}/includes`, { value: [{ ...mediumInclude, id: 'drifted-1' }, { ...mediumInclude, permissionType: 'application', id: 'drifted-2' }] });
  const result = await run(graph, [grantResource('create')]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies.map((write) => `${write.method} ${write.path}`), [
    `DELETE ${POLICY}/includes/drifted-1`,
    `POST ${POLICY}/includes`,
    `DELETE ${POLICY}/includes/drifted-2`,
  ]);
  assert.deepEqual(graph.objects.get(`${POLICY}/includes`).value.map((condition) => condition.permissionClassification), ['low']);
});

test('issue #294: a last-include refusal while the backup\'s include replicates is retried, and a lasting one fails', async () => {
  for (const [refusals, failed] of [[2, 0], [Infinity, 1]]) {
    const graph = directoryGraph();
    const write = graph.write;
    let left = refusals;
    graph.write = async (version, path, request) => {
      if (request.method === 'DELETE' && path === `${POLICY}/includes/drifted` && left > 0) {
        left -= 1;
        graph.bodies.push({ method: request.method, path, body: request.body });
        return { ok: false, status: 400, body: { error: { code: 'Request_BadRequest', message: 'PermissionGrantPolicy should contain an Includes PermissionGrantConditionSet.' } } };
      }
      return write(version, path, request);
    };
    graph.objects.set(POLICY, { id: 'keel-rt-low-risk', displayName: 'KEEL-RT low risk', description: 'Low-risk delegated permissions' });
    graph.objects.set(`${POLICY}/includes`, { value: [{ ...mediumInclude, id: 'drifted' }] });
    const result = await run(graph, [grantResource('create')], {
      readAfterWriteOptions: { attempts: 1, delayMs: 0, replicationAttempts: 4, replicationDelayMs: 0 },
    });
    assert.equal(result.failed.length, failed, String(refusals));
    assert.equal(graph.bodies.filter((w) => w.method === 'DELETE').length, failed ? 4 : 3, String(refusals));
    if (!failed) assert.deepEqual(graph.objects.get(`${POLICY}/includes`).value.map((condition) => condition.permissionClassification), ['low']);
  }
});

test('the read-back checks the whole rule sets: a rule left in place fails the write, never applies it', async () => {
  // Graph accepts the DELETE, but the drifted rule still reads back.
  const drifted = { ...mediumInclude, id: 'drifted' };
  const graph = directoryGraph({
    readOverride: (body, path) => (path === `${POLICY}/includes` && !body.value.some((rule) => rule.id === 'drifted')
      ? { value: [...body.value, drifted] } : body),
  });
  graph.objects.set(POLICY, { id: 'keel-rt-low-risk', displayName: 'KEEL-RT low risk', description: 'Low-risk delegated permissions' });
  graph.objects.set(`${POLICY}/includes`, { value: [{ ...lowInclude, id: 'kept' }, drifted] });
  const result = await run(graph, [grantResource('create')]);
  assert.deepEqual(graph.bodies.map((write) => `${write.method} ${write.path}`), [`DELETE ${POLICY}/includes/drifted`]);
  assert.equal(result.applied.length, 0);
  assert.match(result.failed[0].error, /includes read back with 0 rule\(s\) missing and 1 extra against the backup/);
});

test('a built-in app consent policy is skipped before any write', async () => {
  const graph = directoryGraph();
  const result = await run(graph, [grantResource('create', { id: 'microsoft-user-default-low', displayName: 'Default low' })]);
  assert.equal(result.applied.length, 0);
  assert.match(result.skipped[0].reason, /built-in app consent policy/);
  assert.equal(graph.bodies.length, 0);
});

// ----------------------------------------- app creation policies (restore gaps, batch 21)

const creationPolicy = (extra = {}) => ({
  id: 'policy-src', displayName: 'KEEL-RT-app-creation', description: 'Fixture', isBuiltIn: false,
  includes: [{ id: 'inc-src', applicationTenantIds: ['all'], applicationsFromVerifiedPublisherOnly: false }],
  excludes: [],
  ...extra,
});
const creationResource = (verb, payload = creationPolicy(), extra = {}) => ({
  naturalKey: `servicePrincipalCreationPolicy:${payload.id}`, resourceType: 'servicePrincipalCreationPolicy', verb, payload,
  references: [], blastRadius: 'access-affecting', ...extra,
});

test('batch 21: an app creation policy is recreated under a new id with its include conditions, and a re-run finds it by name', async () => {
  const graph = directoryGraph();
  const result = await run(graph, [creationResource('create')]);
  assert.deepEqual(result.failed, []);
  const [post, include] = graph.bodies;
  assert.equal(`${post.method} ${post.path}`, `POST ${CREATION}`);
  assert.deepEqual(post.body, { displayName: 'KEEL-RT-app-creation', description: 'Fixture' }, 'no id, no built-in flag');
  const { targetId } = result.applied[0];
  assert.notEqual(targetId, 'policy-src');
  assert.equal(`${include.method} ${include.path}`, `POST ${CREATION}/${targetId}/includes`);
  assert.deepEqual(include.body, { applicationTenantIds: ['all'], applicationsFromVerifiedPublisherOnly: false }, 'the rule id is never sent');
  assert.deepEqual(result.applied[0].followUp, [], 'the backup held the conditions, so nothing is left');

  const again = await run(graph, [creationResource('create')]);
  assert.deepEqual(again.failed, []);
  assert.equal(again.applied[0].targetId, targetId);
  assert.equal(graph.bodies.length, 2, 'a re-run writes nothing');
});

test('batch 21: a drifted app creation policy gets the backup\'s conditions back, read from the policy itself', async () => {
  const graph = directoryGraph();
  const path = `${CREATION}/policy-1`;
  graph.objects.set(path, { id: 'policy-1', displayName: 'KEEL-RT-app-creation', description: 'Changed', isBuiltIn: false });
  graph.objects.set(`${path}/includes`, { value: [{ id: 'inc-1', applicationTenantIds: ['all'], applicationsFromVerifiedPublisherOnly: false }] });
  graph.objects.set(`${path}/excludes`, { value: [{ id: 'exc-1', applicationTenantIds: ['tenant-x'] }] });
  const reads = [];
  const read = graph.read;
  graph.read = async (version, requested) => {
    reads.push(requested);
    return read(version, requested);
  };
  const live = { id: 'policy-1', displayName: 'KEEL-RT-app-creation', description: 'Changed', isBuiltIn: false };
  const result = await run(graph, [creationResource('update', creationPolicy({ id: 'policy-1' }), { targetId: 'policy-1', live: { state: 'present', targetId: 'policy-1', payload: live } })]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies.map((write) => `${write.method} ${write.path}`), [`PATCH ${path}`, `DELETE ${path}/excludes/exc-1`]);
  assert.deepEqual(graph.bodies[0].body, { description: 'Fixture' });
  assert.ok(!reads.some((requested) => /\/(includes|excludes)$/.test(requested)), 'the condition sets are never read on their own (Graph expands them on the policy)');
  assert.deepEqual(graph.objects.get(`${path}/excludes`).value, []);
});

test('batch 21: a create that finds the policy by name brings its drifted conditions back to the backup\'s', async () => {
  const graph = directoryGraph();
  const path = `${CREATION}/policy-9`;
  graph.objects.set(path, { id: 'policy-9', displayName: 'KEEL-RT-app-creation', description: 'Fixture', isBuiltIn: false });
  graph.objects.set(`${path}/includes`, { value: [{ id: 'inc-9', applicationTenantIds: ['all'], applicationsFromVerifiedPublisherOnly: false }] });
  graph.objects.set(`${path}/excludes`, { value: [{ id: 'exc-9', applicationPublisherIds: ['publisher-x'] }] });
  // A listed policy with no built-in flag is never taken over by name.
  graph.objects.set(`${CREATION}/policy-unmarked`, { id: 'policy-unmarked', displayName: 'KEEL-RT-app-creation' });
  const result = await run(graph, [creationResource('create')]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied[0].targetId, 'policy-9');
  assert.deepEqual(graph.bodies.map((write) => `${write.method} ${write.path}`), [`DELETE ${path}/excludes/exc-9`]);
});

test('batch 21: a built-in or unmarked app creation policy is skipped before any write', async () => {
  for (const [extra, expect] of [[{ isBuiltIn: true, displayName: 'Default policy' }, /"Default policy" is a built-in app creation policy/], [{ isBuiltIn: undefined }, /does not say whether this app creation policy is built in/]]) {
    const graph = directoryGraph();
    const result = await run(graph, [creationResource('create', creationPolicy(extra))]);
    assert.equal(result.applied.length, 0);
    assert.match(result.skipped[0].reason, expect);
    assert.equal(graph.bodies.length, 0);
  }
});

test('batch 21: an app creation policy without its conditions in the backup leaves a step to set them', async () => {
  const graph = directoryGraph();
  const { includes: _i, excludes: _e, ...bare } = creationPolicy();
  const result = await run(graph, [creationResource('create', bare)]);
  assert.deepEqual(result.failed, []);
  assert.equal(graph.bodies.length, 1);
  assert.deepEqual(result.applied[0].followUp.map((step) => step.part), ['The include and exclude rules of a custom policy']);
});

// ------------------------------------------------------- delegated consents

const consent = (extra = {}) => ({
  id: 'src-grant', clientId: 'sp-client', consentType: 'AllPrincipals', principalId: null, resourceId: 'sp-graph', scope: 'User.Read Mail.Read', ...extra,
});
const consentResource = (verb, payload = consent(), extra = {}) => ({
  naturalKey: `oauth2PermissionGrant:${payload.id}`, resourceType: 'oauth2PermissionGrant', verb, payload,
  references: [], blastRadius: 'access-affecting', ...extra,
});

test('a consent is granted again with the backed-up scopes and verified', async () => {
  const graph = directoryGraph();
  const result = await run(graph, [consentResource('create')]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies, [{
    method: 'POST', path: '/oauth2PermissionGrants',
    body: { clientId: 'sp-client', consentType: 'AllPrincipals', resourceId: 'sp-graph', scope: 'Mail.Read User.Read' },
  }]);
  assert.deepEqual(result.applied[0].followUp, []);
});

test('an existing consent for the same app, resource and user is updated, never duplicated', async () => {
  const graph = directoryGraph();
  graph.objects.set('/oauth2PermissionGrants/live-grant', { id: 'live-grant', clientId: 'sp-client', consentType: 'Principal', principalId: 'user-1', resourceId: 'sp-graph', scope: 'User.Read' });
  graph.objects.set('/oauth2PermissionGrants/other-user', { id: 'other-user', clientId: 'sp-client', consentType: 'Principal', principalId: 'user-2', resourceId: 'sp-graph', scope: 'User.Read' });
  const result = await run(graph, [consentResource('create', consent({ consentType: 'Principal', principalId: 'user-1' }))]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied[0].targetId, 'live-grant');
  assert.deepEqual(graph.bodies, [{ method: 'PATCH', path: '/oauth2PermissionGrants/live-grant', body: { scope: 'Mail.Read User.Read' } }]);
  assert.equal(graph.objects.get('/oauth2PermissionGrants/other-user').scope, 'User.Read', 'another user\'s consent is untouched');
});

test('a consent the backup cannot drive fails before any write', async () => {
  const graph = directoryGraph();
  const noUser = await run(graph, [consentResource('create', consent({ consentType: 'Principal', principalId: null }))]);
  assert.match(noUser.failed[0].error, /no principalId/);
  const noScope = await run(graph, [consentResource('create', consent({ scope: ' ' }))]);
  assert.match(noScope.failed[0].error, /grants no scope/);
  assert.equal(graph.bodies.length, 0);
});

// ------------------------------------------------------- best-effort recreate

test('every type that can be incomplete has an admin center path', () => {
  for (const entry of CATALOG) {
    const state = completenessFor(entry.type, TYPE_DECISIONS[entry.type]);
    if (state.state !== 'incomplete') continue;
    assert.equal(typeof ADMIN_CENTER_PATHS[entry.type], 'string', `${entry.type} needs an admin center path`);
  }
  for (const type of Object.keys(ADMIN_CENTER_PATHS)) assert.ok(TYPE_DECISIONS[type], `${type} is a catalogue type`);
});

const incompleteApp = Object.freeze({
  displayName: 'KEEL-RT payroll', signInAudience: 'AzureADMyOrg', appId: 'source-appid',
  passwordCredentials: [{ keyId: 'k1', displayName: 'prod secret', hint: 'Abc', endDateTime: '2027-01-31T00:00:00Z' }],
  keyCredentials: [],
});

test('a fixture restore of an incomplete app recreates it and lists the secret to set by name and expiry', async () => {
  const graph = directoryGraph();
  const result = await run(graph, [{
    naturalKey: 'application:source-appid', resourceType: 'application', verb: 'create', payload: incompleteApp,
    references: [], blastRadius: 'access-affecting',
  }]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied.length, 1);
  const post = graph.bodies.find((write) => write.method === 'POST');
  assert.ok(!('passwordCredentials' in post.body), 'a secret is never sent');

  const steps = followUpSteps('application', incompleteApp, TYPE_DECISIONS.application);
  assert.deepEqual(steps.map((step) => [step.kind, step.requirement]), [['credential', 'passwordCredentials']]);
  assert.deepEqual(steps[0].values, [{ name: 'prod secret', expires: '2027-01-31T00:00:00Z' }]);
  assert.equal(steps[0].portalPath, 'Microsoft Entra admin center > App registrations');

  const items = completionItemsFor({ resourceType: 'application', mechanism: 'recreate', payload: incompleteApp });
  const secret = items.filter((entry) => entry.requirement === 'passwordCredentials');
  assert.equal(secret.length, 1, 'the named step replaces the generic one');
  assert.match(secret[0].description, /"prod secret" \(the backed-up one expires 2027-01-31T00:00:00Z\)/);
  assert.match(secret[0].description, /Microsoft Entra admin center > App registrations/);
  assert.ok(!JSON.stringify(items).includes('Abc'), 'not even the secret hint is copied');
  assert.deepEqual(completionItemsFor({ resourceType: 'application', mechanism: 'recreate' }).map((entry) => entry.requirement),
    ['passwordCredentials', 'keyCredentials', 'adminConsent', 'newObjectId', 'signIn'], 'without the backup the items are as before');
});

test('a writer\'s follow-up steps become completion items; parts that are only a record are not', () => {
  const items = completionItemsFor({
    resourceType: 'tokenLifetimePolicy', mechanism: 'recreate',
    followUp: [
      { kind: 'follow-up', actionable: true, requirement: 'followUp:which-apps', description: 'Assign it again' },
      { kind: 'follow-up', actionable: false, requirement: 'followUp:history', description: 'A record only' },
    ],
  });
  assert.deepEqual(items.map((entry) => `${entry.kind}:${entry.requirement}`), ['integration:followUp:which-apps', 'integration:newObjectId', 'service-validation:serviceCheck']);
});

test('a type with no writer gets a by-hand step with the backed-up values and its admin center path', () => {
  // Wave 2 IDO gave lifecycle workflows a writer, so an access review is the example.
  const review = {
    id: 'ar-1', displayName: 'KEEL-RT quarterly review', createdDateTime: '2026-01-01T00:00:00Z',
    scope: { query: '/groups/g-1/transitiveMembers', queryType: 'MicrosoftGraph' }, settings: { recurrence: { pattern: { type: 'absoluteMonthly', interval: 3 } } },
  };
  const steps = byHandSteps('accessReviewScheduleDefinition', review, TYPE_DECISIONS.accessReviewScheduleDefinition);
  assert.equal(steps[0].requirement, 'followUp:recreate-by-hand');
  assert.equal(steps[0].portalPath, 'Microsoft Entra admin center > Identity Governance > Access reviews');
  assert.equal(steps[0].values.displayName, 'KEEL-RT quarterly review');
  assert.ok(!('id' in steps[0].values) && !('createdDateTime' in steps[0].values), 'ids and timestamps are not values to enter');
  assert.equal(steps[1].actionable, false, 'past reviews are a record only');
  assert.throws(() => byHandSteps('lifecycleWorkflow', {}, TYPE_DECISIONS.lifecycleWorkflow), /has a writer/);
  assert.throws(() => byHandSteps('application', incompleteApp, TYPE_DECISIONS.application), /has a writer/);
});

test('recreateBody keeps only what a create may send', () => {
  const body = recreateBody('identityApiConnector', {
    id: 'c1', displayName: 'KEEL-RT connector', targetUrl: 'https://example.invalid', '@odata.type': '#x', 'x@odata.context': 'y',
    authenticationConfiguration: { '@odata.type': '#microsoft.graph.basicAuthentication', username: 'keel' },
  });
  assert.deepEqual(Object.keys(body).sort(), ['authenticationConfiguration', 'displayName', 'targetUrl']);
  assert.deepEqual(Object.keys(recreateBody('identityApiConnector', { displayName: 'a', targetUrl: 'b' }, { fields: ['displayName'] })), ['displayName']);
});

test('bestEffortCreate adopts a matching object instead of making a twin, and refuses an ambiguous match', async () => {
  const graph = directoryGraph();
  const resource = { naturalKey: 'agreement:x', resourceType: 'agreement', payload: { displayName: 'KEEL-RT terms' } };
  graph.read = async () => ({ ok: true, status: 200, body: { value: [{ id: 'a1', displayName: 'KEEL-RT terms' }] } });
  const adopted = await bestEffortCreate(graph, resource, {
    path: '/identityGovernance/termsOfUse/agreements', body: { displayName: 'KEEL-RT terms' }, decision: TYPE_DECISIONS.agreement,
    match: (object) => object.displayName === 'KEEL-RT terms',
  });
  assert.equal(adopted.applied.targetId, 'a1');
  assert.equal(adopted.applied.adopted, true);
  assert.ok(adopted.applied.followUp.some((step) => step.part === 'The agreement documents'));
  graph.read = async () => ({ ok: true, status: 200, body: { value: [{ id: 'a1', displayName: 'KEEL-RT terms' }, { id: 'a2', displayName: 'KEEL-RT terms' }] } });
  const ambiguous = await bestEffortCreate(graph, resource, {
    path: '/identityGovernance/termsOfUse/agreements', body: {}, decision: TYPE_DECISIONS.agreement, match: (object) => object.displayName === 'KEEL-RT terms',
  });
  assert.match(ambiguous.failed.error, /2 existing agreement objects match/);
  assert.equal(graph.bodies.length, 0);
});
