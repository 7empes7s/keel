/**
 * Issue #995: guest sign-up user flows and their custom attributes, driven through
 * the production applyWave path against the fixture Graph. No live tenant.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { classifyContentEffects } from '../safety/contentEffects.mjs';
import { buildLiveIndex } from '../reconcile/liveState.mjs';
import { fakeGraph } from '../../tools/qualification/operations.mjs';
import { applyWave } from './applyEngine.mjs';
import { planUserFlowParts, USER_FLOW_RECORDS } from './userFlowOperations.mjs';

const governor = { async acquire() {}, observeRetryAfter() {} };
const SOURCE_APP = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TARGET_APP = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const FLOW = 'B2X_1_KEEL-RT-flow';
const FLOW_PATH = `/identity/b2xUserFlows/${FLOW}`;
const SECRETS = ['fixture-client-secret', 'fixture-client-id', 'fixture-connector-password', 'https://keel-rt.example/check'];

/** A tenant with one identity provider, two attributes (one custom) and one API connector. */
function tenant() {
  const graph = fakeGraph();
  graph.objects.set('/identity/identityProviders/EmailOtpSignup-OAUTH', { id: 'EmailOtpSignup-OAUTH', displayName: 'Email one-time passcode' });
  graph.objects.set(`/identity/userFlowAttributes/extension_${TARGET_APP}_KEELRTAttr`, {
    id: `extension_${TARGET_APP}_KEELRTAttr`, displayName: 'KEELRTAttr', dataType: 'string', userFlowAttributeType: 'custom',
  });
  graph.objects.set('/identity/userFlowAttributes/city', { id: 'city', displayName: 'City', dataType: 'string', userFlowAttributeType: 'builtIn' });
  graph.objects.set('/identity/apiConnectors/conn-target', { id: 'conn-target', displayName: 'KEEL-RT-check' });
  return graph;
}

/** The backed-up flow: it holds more than the collector keeps, to show none of it is sent. */
const backupFlow = () => ({
  id: FLOW, userFlowType: 'signUpOrSignIn', userFlowTypeVersion: 1,
  identityProviders: [
    { id: 'EmailOtpSignup-OAUTH', name: 'Email one-time passcode', clientId: 'fixture-client-id', clientSecret: 'fixture-client-secret' },
    { id: 'Google-OAUTH', name: 'Google', clientId: 'fixture-client-id', clientSecret: 'fixture-client-secret' },
  ],
  userAttributeAssignments: [
    {
      id: `extension_${SOURCE_APP}_KEELRTAttr`, displayName: 'KEEL-RT attribute', isOptional: false, requiresVerification: false,
      userInputType: 'textBox', userAttributeValues: [], userAttribute: { id: `extension_${SOURCE_APP}_KEELRTAttr`, displayName: 'KEELRTAttr' },
    },
    { id: 'city', displayName: 'City', isOptional: true, requiresVerification: false, userInputType: 'textBox', userAttributeValues: [], userAttribute: { id: 'city' } },
  ],
  languages: [{ id: 'en', isEnabled: true }, { id: 'fr', isEnabled: false }],
  apiConnectorConfiguration: {
    postFederationSignup: { id: 'conn-source', displayName: 'KEEL-RT-check', targetUrl: 'https://keel-rt.example/check', authenticationConfiguration: { password: 'fixture-connector-password' } },
    postAttributeCollection: { id: 'conn-gone', displayName: 'KEEL-RT-gone' },
  },
});

const flowResource = (verb, payload, live = null) => ({
  naturalKey: `b2xIdentityUserFlow:${FLOW.toLowerCase()}`, resourceType: 'b2xIdentityUserFlow', verb, payload, references: [],
  ...(live ? { live, targetId: live.targetId } : {}),
});

async function restore(graph, resource, { approved = true, mode = 'enforce' } = {}) {
  return applyWave(graph, governor, [resource], {
    targetTenant: 'fixture-tenant', mode,
    approvedContentEffects: approved ? classifyContentEffects([resource]).effects : [],
  });
}

const steps = (result) => [...(result.applied ?? []), ...(result.skipped ?? [])].flatMap((entry) => entry.completion ?? []);

test('the collector reads each flow\'s parts and keeps no identity provider or connector secret', async () => {
  const { CATALOG } = await import('../../tools/tenant-probe/catalog.mjs');
  const entry = CATALOG.find((candidate) => candidate.type === 'b2xIdentityUserFlow');
  assert.equal(entry.liveItemReads, true);
  const urls = [];
  const reader = {
    async collect(version, path) {
      urls.push(path);
      assert.equal(version, 'v1.0');
      if (path === '/identity/b2xUserFlows') return { items: [{ id: FLOW, userFlowType: 'signUpOrSignIn', userFlowTypeVersion: 1 }], pages: 1, error: null };
      if (path.endsWith('/identityProviders')) return { items: [{ id: 'Google-OAUTH', name: 'Google', type: 'Google', clientId: 'fixture-client-id', clientSecret: 'fixture-client-secret' }], pages: 1, error: null };
      if (path.includes('/userAttributeAssignments')) return { items: backupFlow().userAttributeAssignments, pages: 1, error: null };
      if (path.endsWith('/languages')) return { items: [{ id: 'fr', isEnabled: false, displayName: 'French' }, { id: 'en', isEnabled: true, displayName: 'English' }], pages: 1, error: null };
      return { items: [{ id: FLOW, apiConnectorConfiguration: backupFlow().apiConnectorConfiguration }], pages: 1, error: null };
    },
  };
  const live = await buildLiveIndex(reader, { resourceTypes: ['b2xIdentityUserFlow'], naturalKeyFor: (_type, object) => object.id });
  const flow = live.get(FLOW).payload;
  assert.deepEqual(urls, [
    '/identity/b2xUserFlows',
    `${FLOW_PATH}/identityProviders`,
    `${FLOW_PATH}/userAttributeAssignments?$expand=userAttribute`,
    `${FLOW_PATH}/languages`,
    `${FLOW_PATH}?$expand=apiConnectorConfiguration/postFederationSignup,apiConnectorConfiguration/postAttributeCollection`,
  ]);
  assert.deepEqual(flow.identityProviders, [{ id: 'Google-OAUTH', name: 'Google', type: 'Google' }]);
  assert.deepEqual(flow.userAttributeAssignments.map((assignment) => assignment.id), [`extension_${SOURCE_APP}_KEELRTAttr`, 'city'], 'in the order Graph lists them');
  assert.deepEqual(flow.languages.map((language) => language.id), ['en', 'fr']);
  assert.deepEqual(flow.apiConnectorConfiguration, {
    postFederationSignup: { id: 'conn-source', displayName: 'KEEL-RT-check' },
    postAttributeCollection: { id: 'conn-gone', displayName: 'KEEL-RT-gone' },
  });
  for (const secret of SECRETS) assert.ok(!JSON.stringify(flow).includes(secret), `${secret} is not backed up`);
});

test('a missing flow is recreated with its live identity providers, its attributes in order, its languages and its live API connector', async () => {
  const graph = tenant();
  const result = await restore(graph, flowResource('create', backupFlow()));
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied.length, 1);
  const flow = graph.objects.get(FLOW_PATH);
  assert.equal(flow.userFlowType, 'signUpOrSignIn');
  assert.deepEqual(flow.identityProviders.map((provider) => provider.id), ['EmailOtpSignup-OAUTH']);
  // The custom attribute is the target tenant's (another extension app id), found by name.
  assert.deepEqual(flow.userAttributeAssignments.map((assignment) => assignment.id), [`extension_${TARGET_APP}_KEELRTAttr`, 'city']);
  assert.equal(flow.userAttributeAssignments[1].isOptional, true);
  assert.deepEqual(flow.languages, [{ id: 'en', isEnabled: true }, { id: 'fr', isEnabled: false }]);
  assert.deepEqual(flow.apiConnectorConfiguration, { postFederationSignup: { id: 'conn-target', displayName: 'KEEL-RT-check' } });
  const create = graph.writes.find((write) => write.method === 'POST' && write.path === '/identity/b2xUserFlows');
  assert.ok(create, 'the flow is created');
  // A missing identity provider and a missing API connector are manual steps.
  const open = steps(result);
  assert.match(open.find((entry) => entry.requirement === 'identityProvider:Google-OAUTH')?.description ?? '', /not set up in this tenant/);
  assert.match(open.find((entry) => entry.requirement === 'apiConnector:postAttributeCollection')?.description ?? '', /KEEL-RT-gone.*postAttributeCollection.*never readable/s);
});

test('no identity provider secret, connector password or sign-in address is in any write body', async () => {
  const graph = tenant();
  const bodies = [];
  const write = graph.write.bind(graph);
  graph.write = async (version, path, request) => { bodies.push(JSON.stringify(request.body ?? null)); return write(version, path, request); };
  const result = await restore(graph, flowResource('create', backupFlow()));
  assert.deepEqual(result.failed, []);
  assert.ok(bodies.length >= 6, 'the flow and its parts were written');
  for (const body of bodies) {
    for (const secret of SECRETS) assert.ok(!body.includes(secret), `${secret} not in ${body}`);
    assert.doesNotMatch(body, /clientSecret|clientId|password|targetUrl|authenticationConfiguration/i, body);
  }
  // Identity providers and connectors are sent as references only.
  const refs = bodies.filter((body) => body.includes('@odata.id')).map((body) => Object.keys(JSON.parse(body)));
  assert.ok(refs.length >= 2);
  for (const keys of refs) assert.deepEqual(keys, ['@odata.id']);
});

test('without an approval nothing is written: the flow waits for "changes access"', async () => {
  const graph = tenant();
  const result = await restore(graph, flowResource('create', backupFlow()), { approved: false });
  assert.deepEqual(result.applied, []);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /changes admin access/);
  assert.deepEqual(result.skipped[0].completion[0].fields, ['apiConnectorConfiguration', 'identityProviders', 'languages', 'userAttributeAssignments', 'userFlowType']);
  assert.deepEqual(graph.writes, []);
  // The dry run plans it and lists the parts it would write, without writing.
  const dry = await restore(graph, flowResource('create', backupFlow()), { approved: false, mode: 'dry-run' });
  assert.equal(dry.applied.length, 1);
  assert.deepEqual(graph.writes.filter((write) => write.method !== 'GET'), []);
  const changes = dry.applied[0].changes;
  assert.deepEqual(changes.identityProviders, ['EmailOtpSignup-OAUTH']);
  assert.deepEqual(changes.userAttributeAssignments, [`extension_${TARGET_APP}_KEELRTAttr`, 'city']);
  assert.ok(changes.manualSteps.some((text) => /Google-OAUTH/.test(text)));
});

test('a second run from the same backup writes nothing new: the flow is not created twice', async () => {
  const graph = tenant();
  const first = await restore(graph, flowResource('create', backupFlow()));
  assert.deepEqual(first.failed, []);
  const live = graph.objects.get(FLOW_PATH);
  const before = graph.writes.length;
  const second = await restore(graph, flowResource('update', backupFlow(), { state: 'present', targetId: FLOW, payload: live }));
  assert.deepEqual(second.failed, []);
  assert.deepEqual(graph.writes.slice(before), [], 'nothing is written the second time');
  assert.equal(graph.writes.filter((write) => write.method === 'POST' && write.path === '/identity/b2xUserFlows').length, 1);
  // A create planned again (the plan did not see the flow) is refused by Graph, never duplicated.
  const again = await restore(graph, flowResource('create', backupFlow()));
  assert.equal(again.applied.length, 0);
  assert.equal([...graph.objects.keys()].filter((key) => key === FLOW_PATH).length, 1);
});

test('an existing flow gets back the attribute and language it lost, and the attribute order', async () => {
  const graph = tenant();
  await restore(graph, flowResource('create', backupFlow()));
  const flow = graph.objects.get(FLOW_PATH);
  // Drift: the custom attribute is taken off and French is turned back on.
  graph.objects.set(FLOW_PATH, { ...flow, userAttributeAssignments: flow.userAttributeAssignments.slice(1), languages: [{ id: 'en', isEnabled: true }, { id: 'fr', isEnabled: true }] });
  const drifted = graph.objects.get(FLOW_PATH);
  const resource = flowResource('update', backupFlow(), { state: 'present', targetId: FLOW, payload: drifted });
  const result = await restore(graph, resource);
  assert.deepEqual(result.failed, []);
  const after = graph.objects.get(FLOW_PATH);
  assert.deepEqual(after.userAttributeAssignments.map((assignment) => assignment.id), [`extension_${TARGET_APP}_KEELRTAttr`, 'city']);
  assert.equal(after.languages.find((language) => language.id === 'fr').isEnabled, false);
  assert.deepEqual(result.applied[0].changes.languages, ['fr']);
  // The approval names the parts by name, never by the tenant's extension app id.
  const effect = classifyContentEffects([resource]).effects.find((entry) => entry.field === 'userAttributeAssignments');
  assert.match(effect.after, /"attribute":"KEELRTAttr"/);
  assert.doesNotMatch(effect.after, new RegExp(SOURCE_APP));
});

test('a flow is never deleted, and an old backup without its parts is a manual step', async () => {
  const record = USER_FLOW_RECORDS.b2xIdentityUserFlow;
  assert.ok(!record.operations.includes('delete'));
  assert.match(record.refusal(flowResource('delete', backupFlow()), 'delete', { mode: 'enforce' }).reason, /never deletes a user flow/);
  const old = record.refusal(flowResource('update', { id: FLOW, userFlowType: 'signUpOrSignIn', userFlowTypeVersion: 1 }), 'update', { mode: 'enforce' });
  assert.equal(old.outcome, 'skipped');
  assert.match(old.reason, /taken before KEEL backed up/);
});

test('a flow the backup lacks parts of is not taken apart: extra providers, attributes and connectors are manual steps', () => {
  const live = {
    identityProviders: [{ id: 'EmailOtpSignup-OAUTH' }, { id: 'Facebook-OAUTH' }],
    userAttributeAssignments: [{ id: 'city', userAttribute: { id: 'city' } }, { id: 'country', userAttribute: { id: 'country' } }],
    languages: [], apiConnectorConfiguration: { postAttributeCollection: { id: 'conn-target', displayName: 'KEEL-RT-check' } },
  };
  const payload = { id: FLOW, identityProviders: [{ id: 'EmailOtpSignup-OAUTH' }], userAttributeAssignments: [{ id: 'city', userAttribute: { id: 'city' } }], languages: [], apiConnectorConfiguration: {} };
  const planned = planUserFlowParts(payload, live, { providers: [{ id: 'EmailOtpSignup-OAUTH' }], attributes: [{ id: 'city' }, { id: 'country' }], connectors: [] }, FLOW);
  assert.deepEqual(planned.writes, []);
  assert.deepEqual(planned.steps.map((entry) => entry.requirement).sort(), ['apiConnector:postAttributeCollection', 'identityProvider:extra', 'userAttribute:extra']);
});

// ------------------------------------------------------- custom attributes

const attributeResource = (verb, payload, live = null) => ({
  naturalKey: `identityUserFlowAttribute:${payload.id ?? payload.displayName}`, resourceType: 'identityUserFlowAttribute', verb, payload, references: [],
  ...(live ? { live, targetId: live.targetId } : {}),
});

test('a missing custom attribute is created with its name, description and data type', async () => {
  const graph = fakeGraph();
  const payload = { id: `extension_${SOURCE_APP}_KEELRTAttr`, displayName: 'KEELRTAttr', description: 'KEEL-RT fixture', dataType: 'string', userFlowAttributeType: 'custom' };
  const result = await restore(graph, attributeResource('create', payload), { approved: false });
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied.length, 1);
  const post = graph.writes.find((write) => write.method === 'POST');
  assert.equal(post.path, '/identity/userFlowAttributes');
  const created = [...graph.objects.entries()].find(([key]) => key.startsWith('/identity/userFlowAttributes/'))[1];
  assert.deepEqual({ displayName: created.displayName, description: created.description, dataType: created.dataType }, { displayName: 'KEELRTAttr', description: 'KEEL-RT fixture', dataType: 'string' });
  // Run again: the attribute with that name is found, so none is made twice.
  const again = await restore(graph, attributeResource('create', payload), { approved: false });
  assert.equal(again.skipped.length, 1);
  assert.match(again.skipped[0].reason, /already there/);
  assert.equal(graph.writes.filter((write) => write.method === 'POST').length, 1);
});

test('a built-in attribute is skipped and a different data type is a manual step, never a delete', async () => {
  const graph = fakeGraph();
  const builtIn = { id: 'city', displayName: 'City', dataType: 'string', userFlowAttributeType: 'builtIn' };
  const skipped = await restore(graph, attributeResource('update', builtIn, { state: 'present', targetId: 'city', payload: { ...builtIn, description: 'other' } }));
  assert.match(skipped.skipped[0].reason, /built-in attribute: Microsoft manages it/);

  const payload = { id: 'extension_x_Size', displayName: 'Size', description: 'Shoe size', dataType: 'int64', userFlowAttributeType: 'custom' };
  const live = { ...payload, dataType: 'string' };
  graph.objects.set('/identity/userFlowAttributes/extension_x_Size', live);
  const changed = await restore(graph, attributeResource('update', payload, { state: 'present', targetId: payload.id, payload: live }));
  assert.equal(changed.skipped.length, 1);
  assert.match(changed.skipped[0].reason, /cannot change after an attribute is made/);
  assert.equal(changed.skipped[0].completion[0].requirement, 'dataType');
  // A create where one with that name and another data type exists is the same step.
  const created = await restore(graph, attributeResource('create', { ...payload, id: 'extension_y_Size' }));
  assert.match(created.skipped[0].reason, /cannot change after an attribute is made/);
  assert.deepEqual(graph.writes.filter((write) => write.method !== 'GET'), [], 'nothing is written or deleted');

  // Only the description is updated on an existing attribute.
  const same = { ...payload, dataType: 'string' };
  const described = await restore(graph, attributeResource('update', same, { state: 'present', targetId: payload.id, payload: { ...live, description: 'old' } }));
  assert.deepEqual(described.failed, []);
  assert.deepEqual(graph.writes.at(-1), { method: 'PATCH', path: '/identity/userFlowAttributes/extension_x_Size' });
  assert.equal(graph.objects.get('/identity/userFlowAttributes/extension_x_Size').description, 'Shoe size');
});

test('a connector or attribute is bound only under the name the approval shows', () => {
  const live = { identityProviders: [], userAttributeAssignments: [], languages: [], apiConnectorConfiguration: {} };
  const payload = {
    id: FLOW, identityProviders: [], languages: [],
    userAttributeAssignments: [{ id: `extension_${SOURCE_APP}_KEELRTAttr`, userAttribute: { id: `extension_${SOURCE_APP}_KEELRTAttr`, displayName: 'Other' } }],
    apiConnectorConfiguration: { postAttributeCollection: { id: 'conn-1', displayName: 'KEEL-RT-check' } },
  };
  const planned = planUserFlowParts(payload, live, {
    providers: [],
    attributes: [{ id: `extension_${TARGET_APP}_KEELRTAttr`, displayName: 'KEELRTAttr', userFlowAttributeType: 'custom' }],
    // Same id as the backup's connector, another name: not the connector the approval named.
    connectors: [{ id: 'conn-1', displayName: 'Someone else' }],
  }, FLOW);
  assert.deepEqual(planned.writes, []);
  assert.ok(planned.steps.some((entry) => entry.requirement === `userAttribute:extension_${SOURCE_APP}_KEELRTAttr`));
  assert.ok(planned.steps.some((entry) => entry.requirement === 'apiConnector:postAttributeCollection'));
});
