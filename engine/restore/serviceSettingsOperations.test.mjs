/**
 * Issue #1074: fixture tests for the Defender, Intune connector and Microsoft 365
 * settings writers (serviceSettingsOperations.mjs). Each drives the production
 * record writer against an in-memory Graph (engine/test/idoFakeGraph.mjs), with
 * objects in the shapes Graph documents; nothing here reads or writes a tenant.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { IDENTITY_RECORDS, applyIdentityObjectWrite } from './identityObjectOperations.mjs';
import { INTUNE_EXTENDED_RECORDS, applyIntuneExtendedWrite } from './intuneOperations.mjs';
import { INTUNE_CONNECTOR_RECORDS, RULE_WRITES_PER_MINUTE, SERVICE_SETTING_RECORDS } from './serviceSettingsOperations.mjs';
import { isTrustField } from './workloads/writeDeclarations.mjs';
import { idoFakeGraph } from '../test/idoFakeGraph.mjs';
import { classifyContentEffects, protectionEffects } from '../safety/contentEffects.mjs';

// A customer tenant: tenant-wide records are written there without the tenant-wide option.
const FAST = Object.freeze({ readAfterWriteOptions: { attempts: 1, delayMs: 0 }, tenantRef: 'sha256:customer0000000' });
const TEST_TENANT = Object.freeze({ ...FAST, tenantRef: 'sha256:keeltesttenant0', testTenantRefs: ['sha256:keeltesttenant0'] });
const writesOf = (graph) => graph.calls.filter((call) => call.method !== 'GET');
const writerOf = (type) => (SERVICE_SETTING_RECORDS[type] ? applyIdentityObjectWrite : applyIntuneExtendedWrite);
const resourceOf = (resourceType, payload, live = null) => ({
  naturalKey: payload.id ?? resourceType, resourceType, payload, references: [],
  ...(live ? { live: { state: 'present', targetId: live.id, payload: live } } : { live: { state: 'absent' } }),
});
const write = (type, payload, live, verb, ctx = FAST, seed = {}) => {
  const graph = idoFakeGraph({ seed });
  const result = writerOf(type)(graph, resourceOf(type, payload, live), verb, ctx);
  return result.then((outcome) => ({ graph, result: outcome }));
};
const approvedEffects = (type, payload, live, verb = 'update') => protectionEffects({ ...resourceOf(type, payload, live), verb });

// ------------------------------------------------------------ the records

test('issue #1074: each type is written through its own route, with only the verbs it is proven for', () => {
  const expected = {
    defenderDetectionRule: ['beta', '/security/rules/detectionRules', ['create', 'update'], 'CustomDetection.ReadWrite.All'],
    defenderIdentitySensor: ['v1.0', '/security/identities/sensors', ['update'], 'SecurityIdentitiesSensors.ReadWrite.All'],
    securityZone: ['beta', '/security/zones', ['create', 'update'], 'Zone.ReadWrite.All'],
    itemInsightsSettings: ['v1.0', '/admin/people/itemInsights', ['update'], 'PeopleSettings.ReadWrite.All'],
    todoSettings: ['beta', '/admin/todo', ['update'], 'OrgSettings-Todo.ReadWrite.All'],
    externalConnection: ['v1.0', '/external/connections', ['create', 'update'], 'ExternalConnection.ReadWrite.All'],
    mobileThreatDefenseConnector: ['v1.0', '/deviceManagement/mobileThreatDefenseConnectors', ['update'], 'DeviceManagementServiceConfig.ReadWrite.All'],
    deviceManagementPartner: ['v1.0', '/deviceManagement/deviceManagementPartners', ['update'], 'DeviceManagementServiceConfig.ReadWrite.All'],
    complianceManagementPartner: ['v1.0', '/deviceManagement/complianceManagementPartners', ['update'], 'DeviceManagementServiceConfig.ReadWrite.All'],
    deviceManagementDerivedCredentialSettings: ['beta', '/deviceManagement/derivedCredentials', ['update'], 'DeviceManagementConfiguration.ReadWrite.All'],
  };
  const all = { ...SERVICE_SETTING_RECORDS, ...INTUNE_CONNECTOR_RECORDS };
  assert.deepEqual(Object.keys(all).sort(), Object.keys(expected).sort());
  for (const [type, [version, collection, operations, permission]] of Object.entries(expected)) {
    const record = all[type];
    assert.deepEqual({ version: record.version, collection: record.collection, operations: [...record.operations], permission: record.permission },
      { version, collection, operations, permission }, type);
    // Registered with the identity or the Intune writer, so every gate of those applies.
    assert.equal((SERVICE_SETTING_RECORDS[type] ? IDENTITY_RECORDS : INTUNE_EXTENDED_RECORDS)[type], record, type);
    for (const field of [...(record.writable ?? []), ...record.createOnly]) assert.equal(isTrustField(type, field), false, `${type}.${field}`);
  }
  // One object per tenant: on the test tenant only with the tenant-wide option.
  for (const type of ['itemInsightsSettings', 'todoSettings', 'mobileThreatDefenseConnector', 'deviceManagementPartner', 'complianceManagementPartner', 'deviceManagementDerivedCredentialSettings']) {
    assert.equal(all[type].tenantWide, true, type);
  }
  for (const type of ['defenderDetectionRule', 'defenderIdentitySensor', 'securityZone', 'externalConnection']) assert.equal(all[type].tenantWide, false, type);
});

test('issue #1074: a verb that is not registered is refused and sends nothing', async () => {
  const cases = [
    ['defenderIdentitySensor', 'create'], ['defenderDetectionRule', 'delete'], ['securityZone', 'delete'], ['externalConnection', 'delete'],
    ['mobileThreatDefenseConnector', 'create'], ['complianceManagementPartner', 'delete'], ['deviceManagementDerivedCredentialSettings', 'create'],
  ];
  for (const [type, verb] of cases) {
    const live = { id: 'x-1', displayName: 'KEEL-RT-x', partnerState: 'enabled' };
    const { graph, result } = await write(type, { id: 'x-1', displayName: 'KEEL-RT-x' }, verb === 'create' ? null : live, verb, FAST, { [`${(SERVICE_SETTING_RECORDS[type] ?? INTUNE_CONNECTOR_RECORDS[type]).collection}/x-1`]: live });
    assert.match(result.failed?.error ?? '', /unsupported operation/, `${type} ${verb}`);
    assert.equal(writesOf(graph).length, 0, `${type} ${verb}`);
  }
});

// ------------------------------------------------------------ custom detection rules

const RULES = '/security/rules/detectionRules';
// The beta detectionRule as Graph returns it (security-detectionrule), turned on,
// with a response action that isolates the device.
const RULE = Object.freeze({
  '@odata.type': '#microsoft.graph.security.detectionRule',
  id: 'KEEL-RT-rule', displayName: 'KEEL-RT-rule', status: 'enabled', isEnabled: true,
  createdBy: 'admin@fixture.example', createdDateTime: '2026-10-01T09:00:00Z', lastModifiedBy: 'admin@fixture.example', lastModifiedDateTime: '2026-10-02T09:00:00Z',
  queryCondition: { queryText: 'DeviceProcessEvents | where FileName == "keel-rt.exe"', lastModifiedDateTime: '2026-10-02T09:00:00Z' },
  schedule: { period: '24H', nextRunDateTime: '2026-10-03T09:00:00Z' },
  lastRunDetails: { lastRunDateTime: '2026-10-02T09:00:00Z', status: 'completed', failureReason: null, errorCode: null },
  detectionAction: {
    alertTemplate: { title: 'KEEL-RT alert', description: 'Fixture', severity: 'low', category: 'Execution', recommendedActions: null, mitreTechniques: ['T1059'], impactedAssets: [] },
    organizationalScope: null,
    responseActions: [{ '@odata.type': '#microsoft.graph.security.isolateDeviceResponseAction', isolationType: 'full', identifier: 'deviceId' }],
  },
});
const ruleOff = Object.freeze({ ...RULE, status: 'disabled', isEnabled: false });

test('issue #1074: a detection rule is recreated under its own id and turned off, even when the backup had it on', async () => {
  const { graph, result } = await write('defenderDetectionRule', RULE, null, 'create');
  assert.equal(result.failed, undefined, result.failed?.error);
  const writes = writesOf(graph);
  assert.equal(writes.length, 1);
  assert.deepEqual([writes[0].method, writes[0].version, writes[0].path], ['POST', 'beta', RULES]);
  assert.equal(writes[0].body.id, 'KEEL-RT-rule');
  assert.equal(writes[0].body.status, 'disabled', 'a recreated rule is always off');
  assert.equal('isEnabled' in writes[0].body, false);
  for (const field of ['createdBy', 'lastModifiedBy', 'lastRunDetails', 'createdDateTime', 'lastModifiedDateTime']) assert.equal(field in writes[0].body, false, field);
  assert.equal('lastModifiedDateTime' in writes[0].body.queryCondition, false, 'the query time is Graph\'s');
  assert.equal('nextRunDateTime' in writes[0].body.schedule, false, 'the next run is Graph\'s');
  assert.equal(graph.objects.get(`${RULES}/KEEL-RT-rule`).status, 'disabled');
  // Turning it on is left to a person, who checks its response actions first.
  const step = result.applied.completion.find((item) => item.requirement === 'detectionRuleState');
  assert.deepEqual([step.before, step.after], ['off', 'on']);
  assert.match(step.description, /never turns a rule on/);
  // The dry run lists the same step and writes nothing.
  const dry = await write('defenderDetectionRule', RULE, null, 'create', { ...FAST, mode: 'dry-run' });
  assert.equal(writesOf(dry.graph).length, 0);
  assert.ok(dry.result.applied.completion.some((item) => item.requirement === 'detectionRuleState'));
});

test('issue #1074: a detection rule backed up off is recreated off with no step', async () => {
  const { graph, result } = await write('defenderDetectionRule', ruleOff, null, 'create');
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.equal(writesOf(graph)[0].body.status, 'disabled');
  assert.equal(result.applied.completion, undefined);
});

test('issue #1074: a detection rule update never sends its state, and a rule on now stays on', async () => {
  const live = { ...RULE, detectionAction: { ...RULE.detectionAction, alertTemplate: { ...RULE.detectionAction.alertTemplate, title: 'Drifted' } } };
  const { graph, result } = await write('defenderDetectionRule', ruleOff, live, 'update', FAST, { [`${RULES}/KEEL-RT-rule`]: live });
  assert.equal(result.failed ?? result.skipped, undefined, JSON.stringify(result));
  const writes = writesOf(graph);
  assert.equal(writes.length, 1);
  assert.deepEqual([writes[0].method, writes[0].path], ['PATCH', `${RULES}/KEEL-RT-rule`]);
  assert.deepEqual(Object.keys(writes[0].body), ['detectionAction']);
  assert.equal(graph.objects.get(`${RULES}/KEEL-RT-rule`).status, 'enabled', 'the restore did not turn the rule off');
  assert.match(result.applied.completion.find((item) => item.requirement === 'detectionRuleState').description, /turn it off/);
});

test('issue #1074: a detection rule that already matches sends nothing, and Graph\'s own run times are no difference', async () => {
  const live = { ...RULE, queryCondition: { ...RULE.queryCondition, lastModifiedDateTime: '2026-11-05T00:00:00Z' }, schedule: { ...RULE.schedule, nextRunDateTime: '2026-11-06T00:00:00Z' } };
  const { graph, result } = await write('defenderDetectionRule', RULE, live, 'update', FAST, { [`${RULES}/KEEL-RT-rule`]: live });
  assert.equal(result.failed ?? result.skipped, undefined, JSON.stringify(result));
  assert.deepEqual(result.applied.changes.fields, []);
  assert.equal(writesOf(graph).length, 0);
});

test('issue #1074: changed response actions, or a changed query on a rule with actions, wait for the approval', async () => {
  const noActions = { ...RULE, detectionAction: { ...RULE.detectionAction, responseActions: [] } };
  const otherQuery = { ...RULE, queryCondition: { queryText: 'DeviceProcessEvents | take 1' } };
  // Actions added to a rule make its query act too, so both are listed.
  const both = ['detectionAction.responseActions', 'queryCondition.queryText'];
  for (const [label, live, fields] of [['actions', noActions, both], ['query', otherQuery, ['queryCondition.queryText']]]) {
    const seed = { [`${RULES}/KEEL-RT-rule`]: live };
    const held = await write('defenderDetectionRule', RULE, live, 'update', FAST, seed);
    assert.match(held.result.skipped?.reason ?? '', /second person approves it/, label);
    assert.deepEqual(held.result.skipped.completion[0].fields, fields, label);
    assert.equal(writesOf(held.graph).length, 0, label);
    const effects = approvedEffects('defenderDetectionRule', RULE, live);
    assert.deepEqual(effects.map((effect) => [effect.field, effect.effect]), fields.map((field) => [field, 'acts-on-accounts']), label);
    assert.deepEqual(classifyContentEffects([{ ...resourceOf('defenderDetectionRule', RULE, live), verb: 'update' }]).effects.map((effect) => effect.field), fields, `${label}: listed in the dry run`);
    const dry = await write('defenderDetectionRule', RULE, live, 'update', { ...FAST, mode: 'dry-run' }, seed);
    assert.ok(dry.result.applied, label);
    assert.equal(writesOf(dry.graph).length, 0, label);
    const done = await write('defenderDetectionRule', RULE, live, 'update', { ...FAST, approvedContentEffects: effects }, seed);
    assert.equal(done.result.failed ?? done.result.skipped, undefined, `${label}: ${JSON.stringify(done.result)}`);
    assert.equal(writesOf(done.graph).length, 1, label);
  }
  // A query changed on a rule with no response actions acts on nobody.
  const plain = { ...noActions, queryCondition: { queryText: 'DeviceProcessEvents | take 1' } };
  assert.deepEqual(approvedEffects('defenderDetectionRule', noActions, plain), []);
  // A create is off, so it acts on nobody and needs no approval.
  assert.deepEqual(protectionEffects({ ...resourceOf('defenderDetectionRule', RULE), verb: 'create' }), []);
});

test('issue #1074: detection rule writes are paced to 10 a minute', async () => {
  let clock = Date.parse('2026-11-11T10:00:00Z');
  const slept = [];
  const pace = { now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; } };
  const graph = idoFakeGraph();
  const started = clock;
  for (let index = 0; index < RULE_WRITES_PER_MINUTE + 1; index += 1) {
    const rule = { ...ruleOff, id: `KEEL-RT-rule-${index}`, displayName: `KEEL-RT-rule-${index}` };
    const result = await applyIdentityObjectWrite(graph, resourceOf('defenderDetectionRule', rule), 'create', { ...FAST, ruleWritePace: pace });
    assert.equal(result.failed, undefined, result.failed?.error);
    clock += 1000;
  }
  assert.equal(writesOf(graph).length, RULE_WRITES_PER_MINUTE + 1);
  assert.equal(slept.length, 1, 'only the eleventh write waits');
  assert.equal(clock - started >= 60_000, true, 'the eleventh write went out a minute after the first');
  // A dry run neither waits nor counts.
  const dry = await applyIdentityObjectWrite(graph, resourceOf('defenderDetectionRule', { ...ruleOff, id: 'KEEL-RT-dry' }), 'create', { ...FAST, mode: 'dry-run', ruleWritePace: pace });
  assert.ok(dry.applied);
  assert.equal(slept.length, 1);
});

// ------------------------------------------------------------ Defender for Identity sensors

const SENSORS = '/security/identities/sensors';
// The v1.0 sensor as Graph returns it (security-sensor), a standalone sensor before version 3.
const SENSOR = Object.freeze({
  '@odata.type': '#microsoft.graph.security.sensor',
  id: 'aaaaaaaa-0000-4000-8000-000000107401', displayName: 'KEEL-RT-DC1', sensorType: 'domainControllerStandalone', version: '2.239.18124.58593',
  deploymentStatus: 'upToDate', createdDateTime: '2023-11-16T09:41:24.2585071Z', domainName: 'domain1.test.local', healthStatus: 'healthy', openHealthIssuesCount: 0, serviceStatus: 'running',
  settings: { '@odata.type': 'microsoft.graph.security.sensorSettings', description: 'dc1 settings', domainControllerDnsNames: ['DC1.domain1.test.local'], isDelayedDeploymentEnabled: false },
});
const sensorPath = `${SENSORS}/${SENSOR.id}`;

test('issue #1074: a sensor\'s settings are put back in place, without Graph\'s own fields', async () => {
  const live = { ...SENSOR, healthStatus: 'notHealthyLow', version: '2.240.0.0', settings: { ...SENSOR.settings, description: 'changed' } };
  const { graph, result } = await write('defenderIdentitySensor', SENSOR, live, 'update', FAST, { [sensorPath]: live });
  assert.equal(result.failed ?? result.skipped, undefined, JSON.stringify(result));
  const writes = writesOf(graph);
  assert.equal(writes.length, 1);
  assert.deepEqual([writes[0].method, writes[0].version, writes[0].path], ['PATCH', 'v1.0', sensorPath]);
  assert.deepEqual(writes[0].body, { settings: { description: 'dc1 settings', domainControllerDnsNames: ['DC1.domain1.test.local'], isDelayedDeploymentEnabled: false } });
  assert.equal(result.applied.completion, undefined);
});

test('issue #1074: settings Microsoft keeps fixed on a sensor are not sent and are a step for a person', async () => {
  const backup = { ...SENSOR, sensorType: 'domainControllerIntegrated', settings: { ...SENSOR.settings, domainControllerDnsNames: ['DC1.domain1.test.local', 'DC2.domain1.test.local'], description: 'restored' } };
  const live = { ...backup, settings: { ...SENSOR.settings, description: 'changed' } };
  const { graph, result } = await write('defenderIdentitySensor', backup, live, 'update', { ...FAST, approvedContentEffects: approvedEffects('defenderIdentitySensor', backup, live) }, { [sensorPath]: live });
  assert.equal(result.failed ?? result.skipped, undefined, JSON.stringify(result));
  assert.deepEqual(writesOf(graph)[0].body, { settings: { description: 'restored', isDelayedDeploymentEnabled: false } }, 'a domain controller sensor\'s own list is never sent');
  const step = result.applied.completion.find((item) => item.requirement === 'sensorSettings');
  assert.deepEqual(step.fields, ['settings.domainControllerDnsNames']);
  // On version 3 neither is sent.
  const v3 = { ...SENSOR, version: '3.1.0.0', settings: { ...SENSOR.settings, isDelayedDeploymentEnabled: true } };
  const v3live = { ...v3, settings: { ...SENSOR.settings, description: 'changed' } };
  const second = await write('defenderIdentitySensor', v3, v3live, 'update', { ...FAST, approvedContentEffects: approvedEffects('defenderIdentitySensor', v3, v3live) }, { [sensorPath]: v3live });
  assert.deepEqual(writesOf(second.graph)[0].body, { settings: { description: 'dc1 settings' } });
  assert.deepEqual(second.result.applied.completion.find((item) => item.requirement === 'sensorSettings').fields, ['settings.isDelayedDeploymentEnabled']);
});

test('issue #1074: delayed updates turned on, or a domain controller dropped, wait for the approval', async () => {
  const cases = [
    [{ ...SENSOR, settings: { ...SENSOR.settings, isDelayedDeploymentEnabled: true } }, SENSOR, 'settings.isDelayedDeploymentEnabled'],
    [{ ...SENSOR, settings: { ...SENSOR.settings, domainControllerDnsNames: [] } }, SENSOR, 'settings.domainControllerDnsNames'],
  ];
  for (const [backup, live, field] of cases) {
    const held = await write('defenderIdentitySensor', backup, live, 'update', FAST, { [sensorPath]: live });
    assert.deepEqual(held.result.skipped?.completion[0].fields, [field]);
    assert.equal(writesOf(held.graph).length, 0, field);
    const done = await write('defenderIdentitySensor', backup, live, 'update', { ...FAST, approvedContentEffects: approvedEffects('defenderIdentitySensor', backup, live) }, { [sensorPath]: live });
    assert.equal(done.result.failed ?? done.result.skipped, undefined, `${field}: ${JSON.stringify(done.result)}`);
  }
  // Turning delayed updates off again is written without approval.
  const loose = { ...SENSOR, settings: { ...SENSOR.settings, isDelayedDeploymentEnabled: true } };
  const { graph, result } = await write('defenderIdentitySensor', SENSOR, loose, 'update', FAST, { [sensorPath]: loose });
  assert.equal(result.failed ?? result.skipped, undefined, JSON.stringify(result));
  assert.equal(writesOf(graph).length, 1);
});

// ------------------------------------------------------------ exposure management zones

const ZONE = Object.freeze({
  '@odata.type': '#microsoft.graph.security.zone', id: 'aaaaaaaa00004000800000000107404', displayName: 'KEEL-RT-zone', description: 'Fixture',
  created: { by: 'Yarin', dateTime: '2026-10-01T12:00:00Z' }, modified: { by: 'Yarin', dateTime: '2026-10-01T12:00:00Z' },
});

test('issue #1074: a zone is recreated with its name and description, and found by name on the next run', async () => {
  const graph = idoFakeGraph({ seed: { '/security': {} } });
  const created = await applyIdentityObjectWrite(graph, resourceOf('securityZone', ZONE), 'create', FAST);
  assert.equal(created.failed, undefined, created.failed?.error);
  const posts = writesOf(graph);
  assert.equal(posts.length, 1);
  assert.deepEqual([posts[0].method, posts[0].version, posts[0].path], ['POST', 'beta', '/security/zones']);
  assert.deepEqual(posts[0].body, { displayName: 'KEEL-RT-zone', description: 'Fixture' });
  // Graph gives the zone a new id, so a second run from the same backup looks by name.
  const again = await applyIdentityObjectWrite(graph, resourceOf('securityZone', ZONE), 'create', FAST);
  assert.match(again.skipped?.reason ?? '', /already there/);
  assert.equal(writesOf(graph).length, 1, 'never a second zone');
  // A zone with the same name and another description is left for a person.
  const other = idoFakeGraph({ seed: { '/security': {}, '/security/zones/z-9': { id: 'z-9', displayName: 'keel-rt-zone', description: 'someone else\'s' } } });
  const refused = await applyIdentityObjectWrite(other, resourceOf('securityZone', ZONE), 'create', FAST);
  assert.match(refused.failed?.error ?? '', /already exists with another description/);
  assert.equal(writesOf(other).length, 0);
  // A list that could not be read is never taken as "no zone".
  const broken = idoFakeGraph();
  const failed = await applyIdentityObjectWrite(broken, resourceOf('securityZone', ZONE), 'create', FAST);
  assert.match(failed.failed?.error ?? '', /could not list the zones/);
  assert.equal(writesOf(broken).length, 0);
});

test('issue #1074: a zone update sends only what changed', async () => {
  const live = { ...ZONE, description: 'Drifted', modified: { by: 'someone', dateTime: '2026-11-01T00:00:00Z' } };
  const { graph, result } = await write('securityZone', ZONE, live, 'update', FAST, { [`/security/zones/${ZONE.id}`]: live });
  assert.equal(result.failed ?? result.skipped, undefined, JSON.stringify(result));
  assert.deepEqual(writesOf(graph)[0].body, { description: 'Fixture' });
});

// ------------------------------------------------------------ item insights and To Do

const singleton = (type, payload, live, ctx = FAST) => {
  const path = SERVICE_SETTING_RECORDS[type].collection;
  const graph = idoFakeGraph({ seed: { [path]: live } });
  return applyIdentityObjectWrite(graph, { naturalKey: type, resourceType: type, payload, references: [], live: { state: 'present', payload: live } }, 'update', ctx)
    .then((result) => ({ graph, result, path }));
};
const INSIGHTS = Object.freeze({ '@odata.context': 'x', isEnabledInOrganization: false, disabledForGroup: 'aaaaaaaa-0000-4000-8000-000000107403' });
const TODO = Object.freeze({ isExternalJoinEnabled: false, isExternalShareEnabled: false, isPushNotificationEnabled: true });

test('issue #1074: item insights and To Do settings are one object each, updated in place', async () => {
  let { graph, result, path } = await singleton('itemInsightsSettings', { isEnabledInOrganization: true, disabledForGroup: INSIGHTS.disabledForGroup }, { isEnabledInOrganization: true, disabledForGroup: null });
  // Turning it off for a group the live setting does not name is tightening.
  assert.equal(result.failed ?? result.skipped, undefined, JSON.stringify(result));
  assert.deepEqual([writesOf(graph)[0].method, writesOf(graph)[0].version, writesOf(graph)[0].path, writesOf(graph)[0].body],
    ['PATCH', 'v1.0', path, { disabledForGroup: INSIGHTS.disabledForGroup }]);
  ({ graph, result, path } = await singleton('todoSettings', TODO, { ...TODO, isPushNotificationEnabled: false }));
  assert.equal(result.failed ?? result.skipped, undefined, JSON.stringify(result));
  assert.deepEqual([writesOf(graph)[0].version, writesOf(graph)[0].path, writesOf(graph)[0].body], ['beta', '/admin/todo', { isPushNotificationEnabled: true }]);
  // Already matching: nothing is sent.
  ({ graph, result } = await singleton('todoSettings', TODO, TODO));
  assert.deepEqual(result.applied.changes.fields, []);
  assert.equal(writesOf(graph).length, 0);
});

test('issue #1074: insights turned on, a group cleared, or To Do sharing outside the organisation turned on wait for the approval', async () => {
  const cases = [
    ['itemInsightsSettings', { isEnabledInOrganization: true, disabledForGroup: INSIGHTS.disabledForGroup }, INSIGHTS, ['isEnabledInOrganization']],
    ['itemInsightsSettings', { isEnabledInOrganization: false, disabledForGroup: null }, INSIGHTS, ['disabledForGroup']],
    ['todoSettings', { ...TODO, isExternalShareEnabled: true, isExternalJoinEnabled: true }, TODO, ['isExternalJoinEnabled', 'isExternalShareEnabled']],
  ];
  for (const [type, backup, live, fields] of cases) {
    const held = await singleton(type, backup, live);
    assert.match(held.result.skipped?.reason ?? '', /second person approves it/, type);
    assert.deepEqual([...held.result.skipped.completion[0].fields].sort(), fields, type);
    assert.equal(writesOf(held.graph).length, 0, type);
    const effects = protectionEffects({ naturalKey: type, resourceType: type, payload: backup, live: { state: 'present', payload: live }, verb: 'update' });
    // Half an approval holds the whole object back.
    if (effects.length > 1) {
      const half = await singleton(type, backup, live, { ...FAST, approvedContentEffects: effects.slice(1) });
      assert.equal(writesOf(half.graph).length, 0, type);
    }
    const done = await singleton(type, backup, live, { ...FAST, approvedContentEffects: effects });
    assert.equal(done.result.failed ?? done.result.skipped, undefined, `${type}: ${JSON.stringify(done.result)}`);
    assert.equal(writesOf(done.graph).length, 1, type);
    const dry = await singleton(type, backup, live, { ...FAST, mode: 'dry-run' });
    assert.ok(dry.result.applied, type);
    assert.equal(writesOf(dry.graph).length, 0, type);
  }
});

test('issue #1074: on the test tenant a tenant-wide setting needs the tenant-wide option', async () => {
  for (const mode of ['dry-run', 'enforce']) {
    const { graph, result } = await singleton('todoSettings', TODO, { ...TODO, isPushNotificationEnabled: false }, { ...TEST_TENANT, mode });
    assert.match(result.skipped?.reason ?? '', /tenant-wide and needs a dry run made with --allow-tenant-wide-test-writes/, mode);
    assert.equal(graph.calls.length, 0, mode);
  }
  const { graph, result } = await singleton('todoSettings', TODO, { ...TODO, isPushNotificationEnabled: false }, { ...TEST_TENANT, allowTenantWide: true });
  assert.equal(result.failed ?? result.skipped, undefined, JSON.stringify(result));
  assert.equal(writesOf(graph).length, 1);
});

// ------------------------------------------------------------ Copilot connectors

const CONNECTION = Object.freeze({
  id: 'keelrtconnection', name: 'KEEL-RT-connector', description: 'Fixture', state: 'ready',
  configuration: { authorizedAppIds: ['d1b9b9b4-0000-4000-8000-00000000a001'] },
  activitySettings: { urlToItemResolvers: [{ '@odata.type': '#microsoft.graph.externalConnectors.itemIdResolver', priority: 1, itemId: '{slug}', urlMatchInfo: { baseUrls: ['https://fixture.example'], urlPattern: '/items/(?<slug>[^/]+)' } }] },
  searchSettings: { searchResultTemplates: [] },
});

test('issue #1074: a Copilot connection is recreated under its own id, and its allowed apps wait for the approval', async () => {
  const held = await write('externalConnection', CONNECTION, null, 'create');
  assert.deepEqual(held.result.skipped?.completion[0].fields, ['configuration.authorizedAppIds']);
  assert.equal(writesOf(held.graph).length, 0);
  const effects = approvedEffects('externalConnection', CONNECTION, null, 'create');
  assert.deepEqual(effects.map((effect) => [effect.field, effect.effect]), [['configuration.authorizedAppIds', 'access-changing']]);
  const { graph, result } = await write('externalConnection', CONNECTION, null, 'create', { ...FAST, approvedContentEffects: effects });
  assert.equal(result.failed ?? result.skipped, undefined, JSON.stringify(result));
  const post = writesOf(graph)[0];
  assert.deepEqual([post.method, post.version, post.path], ['POST', 'v1.0', '/external/connections']);
  assert.equal(post.body.id, 'keelrtconnection', 'the connector app pushes items to this id');
  assert.equal('state' in post.body, false);
  assert.equal(result.applied.targetId, 'keelrtconnection');
  // A connection with no allowed apps needs no approval.
  const plain = { ...CONNECTION, configuration: { authorizedAppIds: [] } };
  const free = await write('externalConnection', plain, null, 'create');
  assert.equal(free.result.failed ?? free.result.skipped, undefined, JSON.stringify(free.result));
});

test('issue #1074: a Copilot connection update sends only what changed', async () => {
  const live = { ...CONNECTION, description: 'Drifted' };
  const { graph, result } = await write('externalConnection', CONNECTION, live, 'update', FAST, { '/external/connections/keelrtconnection': live });
  assert.equal(result.failed ?? result.skipped, undefined, JSON.stringify(result));
  assert.deepEqual(writesOf(graph)[0].body, { description: 'Fixture' });
});

// ------------------------------------------------------------ Intune partner connections

const MTD = '/deviceManagement/mobileThreatDefenseConnectors/aaaaaaaa-0000-4000-8000-000000107402';
// The v1.0 mobileThreatDefenseConnector as Graph returns it.
const CONNECTOR = Object.freeze({
  '@odata.type': '#microsoft.graph.mobileThreatDefenseConnector', id: 'aaaaaaaa-0000-4000-8000-000000107402',
  lastHeartbeatDateTime: '2026-11-01T10:00:00Z', partnerState: 'enabled',
  androidMobileApplicationManagementEnabled: true, iosMobileApplicationManagementEnabled: true, windowsMobileApplicationManagementEnabled: false,
  androidEnabled: true, iosEnabled: true, windowsEnabled: false,
  androidDeviceBlockedOnMissingPartnerData: true, iosDeviceBlockedOnMissingPartnerData: true, windowsDeviceBlockedOnMissingPartnerData: false,
  partnerUnsupportedOsVersionBlocked: true, partnerUnresponsivenessThresholdInDays: 7,
  allowPartnerToCollectIOSApplicationMetadata: false, allowPartnerToCollectIOSPersonalApplicationMetadata: false, microsoftDefenderForEndpointAttachEnabled: false,
});

test('issue #1074: a mobile threat defense connector\'s settings are put back only while it is connected', async () => {
  const live = { ...CONNECTOR, androidEnabled: false, lastHeartbeatDateTime: '2026-11-11T10:00:00Z' };
  const effects = approvedEffects('mobileThreatDefenseConnector', CONNECTOR, live);
  assert.deepEqual(effects.map((effect) => [effect.field, effect.effect]), [['androidEnabled', 'acts-on-accounts']]);
  const held = await write('mobileThreatDefenseConnector', CONNECTOR, live, 'update', FAST, { [MTD]: live });
  assert.match(held.result.skipped?.reason ?? '', /second person approves it/);
  assert.equal(writesOf(held.graph).length, 0);
  const { graph, result } = await write('mobileThreatDefenseConnector', CONNECTOR, live, 'update', { ...FAST, approvedContentEffects: effects }, { [MTD]: live });
  assert.equal(result.failed ?? result.skipped, undefined, JSON.stringify(result));
  assert.deepEqual([writesOf(graph)[0].method, writesOf(graph)[0].path, writesOf(graph)[0].body], ['PATCH', MTD, { androidEnabled: true }]);
  // A connector that is not connected is set up from the partner's console first.
  for (const partnerState of ['unavailable', 'notSetUp', 'error', undefined]) {
    const offline = { ...live, partnerState };
    const refused = await write('mobileThreatDefenseConnector', CONNECTOR, offline, 'update', { ...FAST, approvedContentEffects: effects }, { [MTD]: offline });
    assert.match(refused.result.skipped?.reason ?? '', /not active in Intune now/, String(partnerState));
    assert.equal(refused.graph.calls.length, 0, String(partnerState));
  }
});

test('issue #1074: each connector switch off weakens protection, on acts on devices, and app data shared waits too', () => {
  const effect = (change) => approvedEffects('mobileThreatDefenseConnector', { ...CONNECTOR, ...change }, CONNECTOR).map((item) => `${item.field} ${item.effect}`);
  assert.deepEqual(effect({ iosDeviceBlockedOnMissingPartnerData: false }), ['iosDeviceBlockedOnMissingPartnerData weakens-protection']);
  assert.deepEqual(effect({ windowsEnabled: true }), ['windowsEnabled acts-on-accounts']);
  assert.deepEqual(effect({ allowPartnerToCollectIOSPersonalApplicationMetadata: true }), ['allowPartnerToCollectIOSPersonalApplicationMetadata externally-sharing']);
  assert.deepEqual(effect({ partnerUnresponsivenessThresholdInDays: 30 }), ['partnerUnresponsivenessThresholdInDays weakens-protection']);
  assert.deepEqual(effect({ partnerUnresponsivenessThresholdInDays: 1 }), ['partnerUnresponsivenessThresholdInDays acts-on-accounts']);
  assert.deepEqual(effect({ allowPartnerToCollectIOSApplicationMetadata: false }), [], 'no change, no effect');
});

const group = (groupId) => Object.freeze({ target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId } });
const GROUP = 'aaaaaaaa-0000-4000-8000-000000001074';

test('issue #1074: partner enrollment and compliance groups are put back behind the approval, only on a connected partner', async () => {
  const cases = [
    ['deviceManagementPartner', '/deviceManagement/deviceManagementPartners/p-1',
      { id: 'p-1', displayName: 'Jamf', partnerAppType: 'multiTenantApp', partnerState: 'enabled', isConfigured: true, lastHeartbeatDateTime: '2026-11-01T10:00:00Z', groupsRequiringPartnerEnrollment: [group(GROUP)] },
      { groupsRequiringPartnerEnrollment: [] }, [['groupsRequiringPartnerEnrollment', 'acts-on-accounts']]],
    ['complianceManagementPartner', '/deviceManagement/complianceManagementPartners/c-1',
      { id: 'c-1', displayName: 'Jamf compliance', partnerState: 'enabled', macOsOnboarded: true, androidOnboarded: false, iosOnboarded: false, lastHeartbeatDateTime: '2026-11-01T10:00:00Z',
        macOsEnrollmentAssignments: [group(GROUP)], androidEnrollmentAssignments: [], iosEnrollmentAssignments: [] },
      { macOsEnrollmentAssignments: [] }, [['macOsEnrollmentAssignments', 'weakens-protection']]],
  ];
  for (const [type, path, backup, drift, expected] of cases) {
    const live = { ...backup, ...drift };
    const effects = approvedEffects(type, backup, live);
    assert.deepEqual(effects.map((effect) => [effect.field, effect.effect]), expected, type);
    const held = await write(type, backup, live, 'update', FAST, { [path]: live });
    assert.match(held.result.skipped?.reason ?? '', /second person approves it/, type);
    assert.equal(writesOf(held.graph).length, 0, type);
    const { graph, result } = await write(type, backup, live, 'update', { ...FAST, approvedContentEffects: effects }, { [path]: live });
    assert.equal(result.failed ?? result.skipped, undefined, `${type}: ${JSON.stringify(result)}`);
    const writes = writesOf(graph);
    assert.equal(writes.length, 1, type);
    assert.deepEqual(writes[0].body, Object.fromEntries(Object.keys(drift).map((field) => [field, backup[field]])), type);
    for (const field of ['displayName', 'partnerState', 'isConfigured', 'macOsOnboarded', 'lastHeartbeatDateTime']) assert.equal(field in writes[0].body, false, `${type}: ${field}`);
    // Removing the group again on a restore acts on devices the other way.
    assert.equal(approvedEffects(type, live, backup).length, 1, type);
    // A partner that is not connected is connected again first.
    const offline = { ...live, partnerState: 'terminated' };
    const refused = await write(type, backup, offline, 'update', { ...FAST, approvedContentEffects: effects }, { [path]: offline });
    assert.match(refused.result.skipped?.reason ?? '', /partner's console/, type);
    assert.equal(writesOf(refused.graph).length, 0, type);
  }
});

// ------------------------------------------------------------ derived credentials

const DERIVED = '/deviceManagement/derivedCredentials/d-1';
// The beta deviceManagementDerivedCredentialSettings as Graph returns it.
const ISSUER = Object.freeze({
  '@odata.type': '#microsoft.graph.deviceManagementDerivedCredentialSettings', id: 'd-1',
  displayName: 'Purebred', helpUrl: 'https://help.fixture.example', issuer: 'purebred', notificationType: 'companyPortal', renewalThresholdPercentage: 20,
});

test('issue #1074: derived credential settings are put back, the issuer never', async () => {
  const live = { ...ISSUER, issuer: 'intercede', renewalThresholdPercentage: 40, notificationType: 'email' };
  const { graph, result } = await write('deviceManagementDerivedCredentialSettings', ISSUER, live, 'update', FAST, { [DERIVED]: live });
  assert.equal(result.failed ?? result.skipped, undefined, JSON.stringify(result));
  const writes = writesOf(graph);
  assert.equal(writes.length, 1);
  assert.deepEqual([writes[0].method, writes[0].version, writes[0].path], ['PATCH', 'beta', DERIVED]);
  assert.deepEqual(writes[0].body, { notificationType: 'companyPortal', renewalThresholdPercentage: 20 });
  assert.equal(graph.objects.get(DERIVED).issuer, 'intercede', 'the issuer is never written');
  const step = result.applied.completion.find((item) => item.requirement === 'trustFields');
  assert.deepEqual(step.fields, ['issuer']);
  // A changed help page waits for the approval.
  const moved = { ...ISSUER, helpUrl: 'https://elsewhere.example' };
  const held = await write('deviceManagementDerivedCredentialSettings', ISSUER, moved, 'update', FAST, { [DERIVED]: moved });
  assert.deepEqual(held.result.skipped?.completion[0].fields, ['helpUrl']);
  assert.equal(writesOf(held.graph).length, 0);
});

test('issue #1074: no write body of these types ever holds a trust field', async () => {
  const trust = (body) => Object.keys(body ?? {}).filter((field) => /issuer|certificate|trust|signin/i.test(field));
  const graph = idoFakeGraph({ seed: { [DERIVED]: { ...ISSUER, displayName: 'changed' } } });
  await applyIntuneExtendedWrite(graph, resourceOf('deviceManagementDerivedCredentialSettings', { ...ISSUER, issuer: 'xTec' }, { ...ISSUER, displayName: 'changed' }), 'update', FAST);
  for (const call of writesOf(graph)) assert.deepEqual(trust(call.body), [], call.path);
});
