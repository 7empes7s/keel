/**
 * Issue #994: restore of authentication contexts and staged rollout, the
 * certificate authority step, and the certificate-based authentication method
 * settings that are never written.
 *
 * Exercises engine/restore/signInSettingsOperations.mjs and the x509 part of
 * engine/restore/tenantPolicyOperations.mjs through the production applyWave()
 * path. Microsoft Graph is an in-memory fake only; no tenant is read or written.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { lockoutGateFor } from '../../cli/keel-restore.mjs';
import { COLLECT_RELATIONSHIPS } from '../../cli/keel-collect.mjs';
import { RELATIONSHIP_FAMILIES, collectRelationships } from '../collect/relationships.mjs';
import { SIGN_IN_HANDLER, SIGN_IN_PROOF, SIGN_IN_WRITE_PATHS } from '../coverage/capabilities.d/entra.mjs';
import { OPERATIONS, capabilityFor, isSupportedClaim } from '../coverage/capabilities.mjs';
import { EXPANSION_INVENTORY, TYPE_DECISIONS, buildExpansionInventory, qualificationFor } from '../coverage/qualification.mjs';
import { applyWave } from '../restore/applyEngine.mjs';
import {
  attachAuthenticationContextConsumers, attachRolloutAppliesTo, certificateAuthorityReview, contextConsumers,
} from '../restore/signInSettingsOperations.mjs';
import {
  METHOD_CONFIGURATION_FIELDS, METHOD_TRUST_FIELDS, checkedMethodFields, methodConfigurationWrites, tenantPolicyWriteRefusal,
} from '../restore/tenantPolicyOperations.mjs';
import { writerFor } from '../restore/writers/registry.mjs';
import { TRUST_FIELDS } from '../restore/workloads/writeDeclarations.mjs';
import { classifyContentEffects, disclosureFor } from '../safety/contentEffects.mjs';

const governor = { async acquire() {}, observeRetryAfter() {} };
const CONTEXTS = '/identity/conditionalAccess/authenticationContextClassReferences';
const ROLLOUTS = '/policies/featureRolloutPolicies';
const OPEN_GATE = Object.freeze({ evaluate: () => ({ allowed: true, reason: null }) });
const CLOSED_GATE = Object.freeze({ evaluate: () => ({ allowed: false, reason: 'a break-glass account is not ready' }) });

/**
 * A small fake of the Graph routes these writers use. Every write is kept in
 * `bodies`. A PATCH of an absent context creates it under that id (Graph's
 * upsert), a rollout POST gets a new id, and appliesTo/$ref adds a group.
 */
function signInGraph({ contexts = [], policies = [], rollouts = [], groups = [] } = {}) {
  const store = {
    contexts: new Map(contexts.map((entry) => [entry.id, { ...entry }])),
    rollouts: new Map(rollouts.map((entry) => [entry.id, { appliesTo: [], ...entry }])),
    policies, groups,
  };
  const bodies = [];
  let next = 0;
  const ok = (body, status = 200) => ({ ok: true, status, body });
  const missing = { ok: false, status: 404, body: { error: { code: 'Request_ResourceNotFound' } } };
  return {
    store, bodies,
    async read(version, requested) {
      const [path, query = ''] = requested.split('?');
      const params = new URLSearchParams(query);
      if (path === '/identity/conditionalAccess/policies') return ok({ value: policies });
      if (path === CONTEXTS) return ok({ value: [...store.contexts.values()] });
      const context = new RegExp(`^${CONTEXTS}/([^/]+)$`).exec(path);
      if (context) return store.contexts.has(decodeURIComponent(context[1])) ? ok(store.contexts.get(decodeURIComponent(context[1]))) : missing;
      if (path === ROLLOUTS) return ok({ value: [...store.rollouts.values()].map(({ appliesTo: _groups, ...rest }) => rest) });
      const rollout = new RegExp(`^${ROLLOUTS}/([^/]+)$`).exec(path);
      if (rollout) {
        const found = store.rollouts.get(decodeURIComponent(rollout[1]));
        if (!found) return missing;
        const { appliesTo, ...rest } = found;
        return ok(params.get('$expand') === 'appliesTo' ? { ...rest, appliesTo: appliesTo.map((id) => ({ id })) } : rest);
      }
      if (path === '/groups') {
        const filter = /^(mailNickname|displayName) eq '(.*)'$/.exec(params.get('$filter') ?? '');
        const value = filter ? groups.filter((group) => group[filter[1]] === filter[2].replace(/''/g, "'")) : groups;
        return ok({ value });
      }
      return missing;
    },
    async write(version, path, { method, body }) {
      bodies.push({ method, path, body });
      const context = new RegExp(`^${CONTEXTS}/([^/]+)$`).exec(path);
      if (context && method === 'PATCH') {
        const id = decodeURIComponent(context[1]);
        store.contexts.set(id, { id, ...(store.contexts.get(id) ?? {}), ...body });
        return ok(null, 204);
      }
      if (path === ROLLOUTS && method === 'POST') {
        next += 1;
        const created = { id: `rollout-${next}`, appliesTo: [], ...body };
        store.rollouts.set(created.id, created);
        return ok({ ...created }, 201);
      }
      const ref = new RegExp(`^${ROLLOUTS}/([^/]+)/appliesTo/\\$ref$`).exec(path);
      if (ref && method === 'POST') {
        const found = store.rollouts.get(decodeURIComponent(ref[1]));
        if (!found) return missing;
        const id = body['@odata.id'].split('/').pop();
        if (found.appliesTo.includes(id)) return { ok: false, status: 400, body: { error: { message: 'One or more added object references already exist' } } };
        found.appliesTo.push(id);
        return ok(null, 204);
      }
      const rollout = new RegExp(`^${ROLLOUTS}/([^/]+)$`).exec(path);
      if (rollout && method === 'PATCH') {
        const found = store.rollouts.get(decodeURIComponent(rollout[1]));
        if (!found) return missing;
        Object.assign(found, body);
        return ok(null, 204);
      }
      return { ok: false, status: 400, body: { error: { message: `fake has no route for ${method} ${path}` } } };
    },
  };
}

const run = (graph, wave, options = {}) => applyWave(graph, governor, wave, {
  targetTenant: 'fixture', mode: 'enforce', readAfterWriteOptions: { attempts: 1, delayMs: 0 }, ...options,
});

/** The effects the dry run would list for these resources, as the promotion hands them to the writers. */
const approvalsFor = (resources) => classifyContentEffects(resources).effects;

const caPolicy = (name, contexts) => ({
  id: `ca-${name}`, displayName: name, state: 'enabledForReportingButNotEnforced',
  conditions: { applications: { includeApplications: [], includeAuthenticationContextClassReferences: contexts } },
});

function contextResource(verb, { payload = {}, live = null, consumers = undefined } = {}) {
  const snapshot = { id: 'c3', displayName: 'KEEL-RT-994-context', description: 'step-up for finance', isAvailable: true, ...payload };
  return {
    naturalKey: `authenticationContextClassReference:${snapshot.id}`, resourceType: 'authenticationContextClassReference', verb,
    payload: snapshot, references: [], blastRadius: 'access-affecting',
    ...(live ? { targetId: live.id, live: { state: 'present', targetId: live.id, payload: live } } : {}),
    ...(consumers !== undefined ? { authenticationContextConsumers: consumers } : {}),
  };
}

const UNUSED = contextConsumers('c3', { snapshotPolicies: [], livePolicies: [] });

// ------------------------------------------------------------- registration

test('authentication contexts and staged rollout are fixture-tested creates and updates through their own writer; delete is not registered', () => {
  for (const [type, path] of Object.entries(SIGN_IN_WRITE_PATHS)) {
    assert.deepEqual(OPERATIONS.filter((operation) => isSupportedClaim(capabilityFor(type, operation).claim)), ['create', 'update'], type);
    for (const operation of ['create', 'update']) {
      const capability = capabilityFor(type, operation);
      assert.equal(capability.handler, SIGN_IN_HANDLER);
      assert.equal(capability.proofRef, SIGN_IN_PROOF);
      assert.equal(capability.path, path);
      assert.equal(writerFor(type, operation)?.handler, SIGN_IN_HANDLER);
    }
    assert.equal(qualificationFor(type).decision, 'automated', type);
  }
  // A context is upserted under its own id; a rollout create gets a new one.
  assert.equal(capabilityFor('authenticationContextClassReference', 'create').idOutcome, 'preserved');
  assert.equal(capabilityFor('featureRolloutPolicy', 'create').idOutcome, 'server-assigned');
  const statuses = new Map(buildExpansionInventory().batches.flatMap((batch) => batch.types).map((entry) => [entry.resourceType, entry.status]));
  assert.equal(statuses.get('authenticationContextClassReference'), 'qualified-subset');
  assert.equal(statuses.get('featureRolloutPolicy'), 'qualified-subset');
});

test('certificate authorities are manual by design in TYPE_DECISIONS and the ledger, with no write registered', () => {
  assert.equal(TYPE_DECISIONS.certificateBasedAuthConfiguration.decision, 'manual');
  assert.match(TYPE_DECISIONS.certificateBasedAuthConfiguration.reason, /^manual by design/);
  assert.equal(EXPANSION_INVENTORY.certificateBasedAuthConfiguration.status, 'manual');
  for (const operation of OPERATIONS) assert.equal(isSupportedClaim(capabilityFor('certificateBasedAuthConfiguration', operation).claim), false, operation);
});

// ------------------------------------------------------- authentication contexts

test('a context create is an upsert: one PATCH to the backup\'s own id, never a POST or another id', async () => {
  const graph = signInGraph();
  const resource = contextResource('create', { consumers: UNUSED });
  const result = await run(graph, [resource]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied[0].targetId, 'c3');
  assert.deepEqual(graph.bodies, [{
    method: 'PATCH', path: `${CONTEXTS}/c3`, body: { displayName: 'KEEL-RT-994-context', description: 'step-up for finance', isAvailable: true },
  }]);
  assert.deepEqual(graph.store.contexts.get('c3'), { id: 'c3', displayName: 'KEEL-RT-994-context', description: 'step-up for finance', isAvailable: true });
  // A re-run writes nothing: the id holds the backup's values.
  const again = await run(graph, [contextResource('update', { live: graph.store.contexts.get('c3'), consumers: UNUSED })]);
  assert.deepEqual(again.failed, []);
  assert.equal(graph.bodies.length, 1);
});

test('a context is only ever written to its own id: a live object under another id, or an id outside c1..c99, is refused before any write', async () => {
  const graph = signInGraph();
  const other = contextResource('update', { live: { id: 'c4', displayName: 'x', isAvailable: true }, consumers: UNUSED });
  const outOfRange = contextResource('create', { payload: { id: 'c100' }, consumers: UNUSED });
  const result = await run(graph, [other, outOfRange]);
  assert.equal(result.failed.length, 2);
  assert.match(result.failed.find((entry) => entry.naturalKey === other.naturalKey).error, /only ever written to its own id/);
  assert.match(result.failed.find((entry) => entry.naturalKey === outOfRange.naturalKey).error, /not one of c1\.\.c99/);
  assert.deepEqual(graph.bodies, []);
});

test('the dry run lists in plain English the Conditional Access policies in the backup and live that use the id', async () => {
  const live = [caPolicy('Finance step-up', ['c3']), caPolicy('Unrelated', ['c7'])];
  const backup = [caPolicy('Finance step-up (old name)', ['C3']), caPolicy('Other', [])];
  const graph = signInGraph({ policies: live });
  const [resource] = await attachAuthenticationContextConsumers([contextResource('create')], {
    snapshotPolicies: backup, reader: { collect: async () => ({ items: live, error: null }) },
  });
  assert.deepEqual(resource.authenticationContextConsumers, { snapshot: ['Finance step-up (old name)'], live: ['Finance step-up'], inUse: true });
  const result = await run(graph, [resource], { mode: 'dry-run' });
  assert.deepEqual(result.failed, []);
  const { usedBy } = result.applied[0];
  assert.match(usedBy, /Authentication context c3 is used by: in the backup, Conditional Access policy "Finance step-up \(old name\)"; live, Conditional Access policy "Finance step-up"\./);
  assert.match(usedBy, /SharePoint sites and sensitivity labels/);
  assert.doesNotMatch(usedBy, /Unrelated|Other/);
  assert.deepEqual(graph.bodies, [], 'a dry run writes nothing');

  // Nothing uses it: said as plainly. A failed live read is treated as used.
  assert.match((await run(signInGraph(), [contextResource('create', { consumers: UNUSED })], { mode: 'dry-run' })).applied[0].usedBy, /Nothing in the backup or live uses authentication context c3\./);
  const [unread] = await attachAuthenticationContextConsumers([contextResource('create')], { snapshotPolicies: [], reader: { collect: async () => ({ items: undefined, error: { status: 403 } }) } });
  assert.equal(unread.authenticationContextConsumers.inUse, null);
});

test('making a used context available is held behind the restore approval; its name and description are written without one', async () => {
  const consumers = contextConsumers('c3', { snapshotPolicies: [caPolicy('Finance step-up', ['c3'])], livePolicies: [] });
  const live = { id: 'c3', displayName: 'renamed', description: 'step-up for finance', isAvailable: false };
  const resource = contextResource('update', { live, consumers });

  // The dry run lists one 'changes-sign-in' effect for isAvailable, and none for the name.
  const effects = approvalsFor([resource]);
  assert.deepEqual(effects.map((effect) => `${effect.field}:${effect.effect}:${effect.before}->${effect.after}`), ['isAvailable:changes-sign-in:false->true']);
  assert.equal(effects[0].disclosure, disclosureFor('changes-sign-in'));

  const held = signInGraph({ contexts: [live] });
  const result = await run(held, [resource]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(held.bodies.map((write) => write.body), [{ displayName: 'KEEL-RT-994-context' }]);
  const step = result.applied[0].completion.find((entry) => entry.requirement === 'signInApproval');
  assert.match(step.description, /Set authentication context c3 to available/);
  assert.match(step.description, /approve "Changes sign-in"/);

  const approved = signInGraph({ contexts: [live] });
  const done = await run(approved, [resource], { approvedContentEffects: effects });
  assert.deepEqual(done.failed, []);
  assert.deepEqual(approved.bodies.map((write) => write.body), [{ displayName: 'KEEL-RT-994-context', isAvailable: true }]);
  assert.equal(done.applied[0].completion, undefined);

  // An availability change alone on a used id is skipped with the step.
  const onlyAvailability = contextResource('update', { live: { ...live, displayName: 'KEEL-RT-994-context' }, consumers });
  const skipped = await run(signInGraph({ contexts: [live] }), [onlyAvailability]);
  assert.equal(skipped.skipped.length, 1);
  assert.match(skipped.skipped[0].reason, /^manual: .*Changes sign-in/);
});

test('an availability change on a context nothing uses needs no approval and is no effect', async () => {
  const live = { id: 'c3', displayName: 'KEEL-RT-994-context', description: 'step-up for finance', isAvailable: false };
  const resource = contextResource('update', { live, consumers: UNUSED });
  assert.deepEqual(approvalsFor([resource]), []);
  const graph = signInGraph({ contexts: [live] });
  const result = await run(graph, [resource]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies.map((write) => write.body), [{ isAvailable: true }]);
  // What uses it was not worked out by the plan: KEEL treats it as used.
  assert.equal(approvalsFor([contextResource('update', { live })]).length, 1);
});

test('a context delete stays refused', async () => {
  const graph = signInGraph({ contexts: [{ id: 'c3', displayName: 'x', isAvailable: false }] });
  const resource = { ...contextResource('delete', { live: { id: 'c3', displayName: 'x', isAvailable: false } }), payload: null };
  const result = await run(graph, [resource]);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /not a registered write capability/);
  assert.deepEqual(graph.bodies, []);
});

// ------------------------------------------------------------ staged rollout

const ROLLOUT_GROUP = { id: 'src-group-1', name: 'KEEL-RT-994-rollout-group', mailNickname: 'KEEL-RT-994-rollout-group' };
const GONE_GROUP = { id: 'src-group-2', name: 'KEEL-RT-994-gone', mailNickname: 'KEEL-RT-994-gone' };
const LIVE_GROUP = { id: 'live-group-1', displayName: 'KEEL-RT-994-rollout-group', mailNickname: 'KEEL-RT-994-rollout-group' };
const EXTRA_GROUP = { id: 'live-group-9', displayName: 'KEEL-RT-994-extra', mailNickname: 'KEEL-RT-994-extra' };

function rolloutResource(verb, { payload = {}, live = null, desiredGroups = [ROLLOUT_GROUP], liveGroups = null } = {}) {
  const snapshot = {
    id: 'src-rollout', displayName: 'KEEL-RT-994-rollout', description: 'cloud sign-in pilot',
    feature: 'passwordHashSync', isAppliedToOrganization: false, isEnabled: true, ...payload,
  };
  return {
    naturalKey: `featureRolloutPolicy:${snapshot.id}`, resourceType: 'featureRolloutPolicy', verb, payload: snapshot, references: [], blastRadius: 'cosmetic',
    ...(live ? { targetId: live.id, live: { state: 'present', targetId: live.id, payload: live } } : {}),
    rolloutAppliesTo: {
      desired: { outcome: desiredGroups.length ? 'complete' : 'complete-empty', groups: desiredGroups },
      live: liveGroups ? { outcome: liveGroups.length ? 'complete' : 'complete-empty', groups: liveGroups } : null,
    },
  };
}

test('a rollout create is held without its approval, and without the break-glass lockout gate', async () => {
  const resource = rolloutResource('create');
  const effects = approvalsFor([resource]);
  assert.deepEqual(effects.map((effect) => effect.field).sort(), ['appliesTo', 'feature', 'isAppliedToOrganization', 'isEnabled']);
  assert.ok(effects.every((effect) => effect.effect === 'changes-sign-in'));

  const noApproval = signInGraph({ groups: [LIVE_GROUP] });
  const held = await run(noApproval, [resource], { lockoutGate: OPEN_GATE });
  assert.deepEqual(noApproval.bodies, []);
  assert.equal(held.skipped.length, 1);
  assert.match(held.skipped[0].reason, /^manual: The staged rollout "KEEL-RT-994-rollout" is not recreated yet\..*approve "Changes sign-in"/);
  assert.deepEqual([...held.skipped[0].completion[0].fields].sort(), ['appliesTo', 'feature', 'isAppliedToOrganization']);

  for (const gate of [null, CLOSED_GATE]) {
    const graph = signInGraph({ groups: [LIVE_GROUP] });
    const result = await run(graph, [resource], { lockoutGate: gate, approvedContentEffects: effects });
    assert.deepEqual(graph.bodies, [], 'nothing is written without an allowing gate');
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /^tenant-lockout policy: featureRolloutPolicy (is written only behind|withheld by) the break-glass lockout gate/);
  }
});

test('an approved rollout create behind the gate lands switched off with its group; switching it on is a separate approved step', async () => {
  const resource = rolloutResource('create');
  const effects = approvalsFor([resource]);
  const withoutSwitch = effects.filter((effect) => effect.field !== 'isEnabled');

  const graph = signInGraph({ groups: [LIVE_GROUP, EXTRA_GROUP] });
  const result = await run(graph, [resource], { lockoutGate: OPEN_GATE, approvedContentEffects: withoutSwitch });
  assert.deepEqual(result.failed, []);
  const [post, ref] = graph.bodies;
  assert.deepEqual(post, {
    method: 'POST', path: ROLLOUTS,
    body: { displayName: 'KEEL-RT-994-rollout', description: 'cloud sign-in pilot', feature: 'passwordHashSync', isAppliedToOrganization: false, isEnabled: false },
  });
  assert.deepEqual(ref, { method: 'POST', path: `${ROLLOUTS}/rollout-1/appliesTo/$ref`, body: { '@odata.id': 'https://graph.microsoft.com/v1.0/directoryObjects/live-group-1' } });
  assert.equal(graph.bodies.length, 2, 'never switched on without its own approval');
  assert.equal(graph.store.rollouts.get('rollout-1').isEnabled, false);
  assert.deepEqual(graph.store.rollouts.get('rollout-1').appliesTo, ['live-group-1']);
  const step = result.applied[0].completion.find((entry) => entry.fields?.includes('isEnabled'));
  assert.match(step.description, /Switch the staged rollout "KEEL-RT-994-rollout" on \(KEEL recreates it switched off\)/);

  // With the switch approved too, it is turned on after the create, and read back on.
  const on = signInGraph({ groups: [LIVE_GROUP] });
  const switched = await run(on, [resource], { lockoutGate: OPEN_GATE, approvedContentEffects: effects });
  assert.deepEqual(switched.failed, []);
  assert.equal(on.bodies[0].body.isEnabled, false, 'the create itself is still off');
  assert.deepEqual(on.bodies.at(-1), { method: 'PATCH', path: `${ROLLOUTS}/rollout-1`, body: { isEnabled: true } });
  assert.equal(switched.applied[0].changes.switched, 'on');
});

test('rollout groups are add-only: a missing one is added, an extra live one is kept, and one missing live is a step', async () => {
  const live = { id: 'live-rollout', displayName: 'KEEL-RT-994-rollout', description: 'drifted', feature: 'passwordHashSync', isAppliedToOrganization: false, isEnabled: false };
  const resource = rolloutResource('update', {
    payload: { isEnabled: false }, live, desiredGroups: [ROLLOUT_GROUP, GONE_GROUP],
    liveGroups: [{ id: EXTRA_GROUP.id, name: EXTRA_GROUP.displayName, mailNickname: EXTRA_GROUP.mailNickname }],
  });
  const effects = approvalsFor([resource]);
  assert.deepEqual(effects.map((effect) => [effect.field, effect.before, effect.after]), [
    ['appliesTo', ['KEEL-RT-994-extra'], ['KEEL-RT-994-extra', 'KEEL-RT-994-gone', 'KEEL-RT-994-rollout-group']],
  ]);
  const graph = signInGraph({ rollouts: [{ ...live, appliesTo: [EXTRA_GROUP.id] }], groups: [LIVE_GROUP, EXTRA_GROUP] });
  const result = await run(graph, [resource], { lockoutGate: OPEN_GATE, approvedContentEffects: effects });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies.map((write) => `${write.method} ${write.path}`), [
    `PATCH ${ROLLOUTS}/live-rollout`, `POST ${ROLLOUTS}/live-rollout/appliesTo/$ref`,
  ]);
  assert.deepEqual(graph.bodies[0].body, { description: 'cloud sign-in pilot' });
  assert.ok(graph.bodies.every((write) => write.method !== 'DELETE'), 'a group is never removed');
  assert.deepEqual(graph.store.rollouts.get('live-rollout').appliesTo, [EXTRA_GROUP.id, LIVE_GROUP.id]);
  const step = result.applied[0].completion.find((entry) => entry.requirement === 'rolloutGroups');
  assert.match(step.description, /Add "KEEL-RT-994-gone" \(no group with that name exists in this tenant\)/);
});

test('a rollout name or description change needs no approval but still the lockout gate', async () => {
  const live = { id: 'live-rollout', displayName: 'KEEL-RT-994-rollout', description: 'drifted', feature: 'passwordHashSync', isAppliedToOrganization: false, isEnabled: false };
  const resource = rolloutResource('update', { payload: { isEnabled: false }, live, desiredGroups: [], liveGroups: [] });
  assert.deepEqual(approvalsFor([resource]), []);
  const graph = signInGraph({ rollouts: [live] });
  assert.equal((await run(graph, [resource])).skipped.length, 1);
  const result = await run(graph, [resource], { lockoutGate: OPEN_GATE });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies, [{ method: 'PATCH', path: `${ROLLOUTS}/live-rollout`, body: { description: 'cloud sign-in pilot' } }]);
});

test('the restore loads the lockout gate when a rollout write is planned', async () => {
  let loaded = 0;
  const gate = await lockoutGateFor(null, [rolloutResource('create')], {
    tenantRef: 'tenant', loadInputs: async () => { loaded += 1; return { configured: true, accounts: [], inventory: {} }; },
  });
  assert.equal(loaded, 1);
  assert.equal(typeof gate.evaluate, 'function');
  assert.equal(await lockoutGateFor(null, [contextResource('create')], { tenantRef: 'tenant', loadInputs: async () => { throw new Error('not needed'); } }), null);
});

test('the backup collects the groups each rollout applies to, as their own edge with the group\'s natural key', async () => {
  assert.ok(COLLECT_RELATIONSHIPS.families.includes('rolloutAppliesTo'));
  assert.equal(RELATIONSHIP_FAMILIES.rolloutAppliesTo.parentType, 'featureRolloutPolicy');
  const reads = [];
  const reader = {
    async collect(version, path) {
      reads.push(path);
      return { items: [{ id: 'G-1', '@odata.type': '#microsoft.graph.group', displayName: 'KEEL-RT-994-rollout-group', mailNickname: 'keel-rt-994' }], error: null, pagesCompleted: 1 };
    },
  };
  const [observation] = await collectRelationships(reader, {
    tenantRef: 'tenant', parents: [{ type: 'featureRolloutPolicy', sourceId: 'rollout-1', naturalKey: 'featureRolloutPolicy:rollout-1' }], families: ['rolloutAppliesTo'],
  });
  assert.deepEqual(reads, ['/policies/featureRolloutPolicies/rollout-1/appliesTo?$select=id,displayName,mailNickname']);
  assert.equal(observation.outcome, 'complete');
  assert.deepEqual(observation.targets.map((target) => [target.targetId, target.attributes]), [['g-1', { displayName: 'KEEL-RT-994-rollout-group', mailNickname: 'keel-rt-994' }]]);
  const [attached] = attachRolloutAppliesTo([{ naturalKey: 'featureRolloutPolicy:rollout-1', resourceType: 'featureRolloutPolicy' }], {
    desired: new Map([['featureRolloutPolicy:rollout-1|rolloutAppliesTo', observation]]),
  });
  assert.deepEqual(attached.rolloutAppliesTo.desired.groups, [{ id: 'g-1', name: 'KEEL-RT-994-rollout-group', mailNickname: 'keel-rt-994' }]);
  assert.equal(attached.rolloutAppliesTo.live, null);
});

// --------------------------------------------------- certificate authorities

// A self-signed test certificate (CN=KEEL-RT-994 Test Root), made for this test with
// openssl and trusted nowhere; it expires 2036-11-01T12:23:39Z.
const TEST_CERT = 'MIIBlTCCATugAwIBAgIUeiIDJVtB7TSUV0fkyJI1xnWwehIwCgYIKoZIzj0EAwIwIDEeMBwGA1UEAwwVS0VFTC1SVC05OTQgVGVzdCBSb290MB4XDTI2MTEwNDEyMjMzOVoXDTM2MTEwMTEyMjMzOVowIDEeMBwGA1UEAwwVS0VFTC1SVC05OTQgVGVzdCBSb290MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE9N3gAraZQkn3/ol69JzqNWzRBOxFxBeGxtmIvGVL0tp2XaWUHIVtiK8bWKuo4n8EJ10p5SP5Jrblqb2F+AvUeaNTMFEwHQYDVR0OBBYEFEFwtXKY9mEFBhkS/Ztg8sF2HNylMB8GA1UdIwQYMBaAFEFwtXKY9mEFBhkS/Ztg8sF2HNylMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIgf2FWGguvCubH6hOczP+hHDjXlvBRtDYgFd/2p6Ohk2sCIQCFW7BpFhwYShYLOBWX2qfsA2dmoMJO4P9TuBKJgo9JwQ==';

function certificateResource(verb, { authorities, liveAuthorities = null } = {}) {
  return {
    naturalKey: 'certificateBasedAuthConfiguration:tenant', resourceType: 'certificateBasedAuthConfiguration', verb,
    payload: { id: 'cba', certificateAuthorities: authorities }, references: [], blastRadius: 'tenant-lockout',
    ...(liveAuthorities ? { live: { state: 'present', targetId: 'cba', payload: { id: 'cba', certificateAuthorities: liveAuthorities } } } : {}),
  };
}

test('certificate authorities produce a step per backed-up authority and no write', async () => {
  const root = { issuer: 'CN=KEEL-RT-994 Root', issuerSki: 'AA11', isRootAuthority: true, certificate: TEST_CERT, certificateRevocationListUrl: 'http://crl.example/root.crl' };
  const intermediate = { issuer: 'CN=KEEL-RT-994 Issuing', issuerSki: 'BB22', isRootAuthority: false, certificate: TEST_CERT, certificateRevocationListUrl: 'http://crl.example/issuing.crl' };
  const resource = certificateResource('update', {
    authorities: [root, intermediate],
    liveAuthorities: [{ ...root, certificateRevocationListUrl: 'http://crl.example/other.crl' }],
  });
  const graph = signInGraph();
  for (const mode of ['dry-run', 'enforce']) {
    const result = await run(graph, [resource], { mode, lockoutGate: OPEN_GATE });
    assert.deepEqual(result.failed, [], mode);
    assert.equal(result.skipped.length, 1, mode);
    const [step] = result.skipped[0].completion;
    assert.equal(step.requirement, 'certificateAuthorities');
    assert.ok(step.authorities.every((entry) => entry.expires === '2036-11-01T12:23:39.000Z'));
    assert.match(step.description, /expires 2036-11-01T12:23:39\.000Z/);
    assert.deepEqual(step.authorities.map((entry) => [entry.issuer, entry.kind, entry.crl, entry.status]), [
      ['CN=KEEL-RT-994 Root', 'root', 'http://crl.example/root.crl', 'different live (certificateRevocationListUrl)'],
      ['CN=KEEL-RT-994 Issuing', 'intermediate', 'http://crl.example/issuing.crl', 'missing live'],
    ]);
    assert.match(step.description, /never writes the trusted certificate authorities/);
    assert.match(step.description, /Entra admin center > Protection > Security Center > Certificate authorities/);
  }
  assert.deepEqual(graph.bodies, [], 'the certificate list is never written');
  // A create (nothing live) is the same step, with every authority not checked live.
  const created = await run(graph, [certificateResource('create', { authorities: [root] })]);
  assert.equal(created.skipped[0].completion[0].authorities[0].status, 'not checked live');
  assert.deepEqual(graph.bodies, []);
});

test('a certificate authority\'s expiry is read from its certificate when it parses, and is unknown otherwise', () => {
  const [unknown] = certificateAuthorityReview({ certificateAuthorities: [{ issuer: 'CN=x', certificate: 'not a certificate' }] }, null);
  assert.equal(unknown.expires, null);
  assert.equal(unknown.kind, 'intermediate');
});

// ------------------------------------------ certificate-based authentication method

function methodsPolicy(x509) {
  return {
    id: 'authenticationMethodsPolicy',
    authenticationMethodConfigurations: [{ id: 'X509Certificate', '@odata.type': '#microsoft.graph.x509CertificateAuthenticationMethodConfiguration', ...x509 }],
  };
}
const BINDINGS = [{ x509CertificateField: 'PrincipalName', userProperty: 'userPrincipalName', priority: 1 }];
const MODE = { x509CertificateAuthenticationDefaultMode: 'x509CertificateMultiFactor', rules: [] };

test('the x509 method\'s certificate fields go through the trust check and are never writable', () => {
  assert.deepEqual([...METHOD_CONFIGURATION_FIELDS.x509certificate], ['state', 'includeTargets', 'excludeTargets']);
  assert.deepEqual([...METHOD_TRUST_FIELDS.x509certificate], ['authenticationModeConfiguration', 'certificateUserBindings']);
  assert.deepEqual([...TRUST_FIELDS.authenticationMethodsPolicy], ['authenticationModeConfiguration', 'certificateUserBindings']);
  assert.throws(() => checkedMethodFields({ x509certificate: ['certificateUserBindings'] }), /x509certificate declares trust, certificate or sign-in fields a restore never writes: certificateUserBindings/);
  assert.throws(() => checkedMethodFields({ x509certificate: ['authenticationModeConfiguration'] }), /authenticationModeConfiguration/);
});

test('x509 bindings are never in a PATCH body: a state change writes the state only, and the binding difference is a step', async () => {
  const backup = methodsPolicy({ state: 'enabled', certificateUserBindings: BINDINGS, authenticationModeConfiguration: MODE });
  const live = methodsPolicy({ state: 'disabled', certificateUserBindings: [], authenticationModeConfiguration: { x509CertificateAuthenticationDefaultMode: 'x509CertificateSingleFactor', rules: [] } });
  const resource = {
    naturalKey: 'authenticationMethodsPolicy:tenant', resourceType: 'authenticationMethodsPolicy', verb: 'update', payload: backup, references: [], blastRadius: 'tenant-lockout',
    live: { state: 'present', targetId: 'authenticationMethodsPolicy', payload: live },
  };
  const [write] = methodConfigurationWrites(resource, backup);
  assert.deepEqual(write.body, { '@odata.type': '#microsoft.graph.x509CertificateAuthenticationMethodConfiguration', state: 'enabled' });

  const bodies = [];
  const graph = {
    policy: structuredClone(live),
    async read() { return { ok: true, status: 200, body: structuredClone(this.policy) }; },
    async write(version, path, { method, body }) {
      bodies.push({ method, path, body });
      const { '@odata.type': _type, ...fields } = body;
      this.policy.authenticationMethodConfigurations = this.policy.authenticationMethodConfigurations.map((config) => ({ ...config, ...fields }));
      return { ok: true, status: 204, body: null };
    },
  };
  const result = await run(graph, [resource], { lockoutGate: OPEN_GATE });
  assert.deepEqual(result.failed, []);
  assert.equal(bodies.length, 1);
  for (const { body } of bodies) {
    assert.ok(!Object.hasOwn(body, 'certificateUserBindings'), 'bindings never sent');
    assert.ok(!Object.hasOwn(body, 'authenticationModeConfiguration'), 'authentication mode never sent');
  }
  const step = result.applied[0].completion;
  assert.equal(step.requirement, 'certificateSignInSettings');
  assert.deepEqual([...step.fields], ['authenticationModeConfiguration', 'certificateUserBindings']);
  assert.match(step.description, /certificateUserBindings: backup \[.*PrincipalName.*\], live \[\]/);
  assert.match(step.description, /A restore never changes them/);
});

test('when only the x509 certificate fields differ, the update is skipped with the step and nothing is written', () => {
  const backup = methodsPolicy({ state: 'enabled', certificateUserBindings: BINDINGS });
  const live = methodsPolicy({ state: 'enabled', certificateUserBindings: [] });
  const resource = {
    naturalKey: 'authenticationMethodsPolicy:tenant', resourceType: 'authenticationMethodsPolicy', verb: 'update', payload: backup,
    live: { state: 'present', targetId: 'authenticationMethodsPolicy', payload: live },
  };
  assert.deepEqual(methodConfigurationWrites(resource, backup), [], 'the bindings alone are no write');
  const refusal = tenantPolicyWriteRefusal(resource, 'update', { lockoutGate: OPEN_GATE });
  assert.equal(refusal.outcome, 'skipped');
  assert.match(refusal.reason, /^manual: The certificate-based authentication settings \(certificateUserBindings\) differ from the backup/);
  assert.equal(refusal.completion.requirement, 'certificateSignInSettings');
});
