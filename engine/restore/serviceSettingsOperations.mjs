/**
 * Issue #1074: restore of the last Defender, Intune connector and Microsoft 365
 * settings types that were restored by hand. Each is a record for the record
 * writer (recordWriter.mjs). SERVICE_SETTING_RECORDS are written through the
 * identity object writer, INTUNE_CONNECTOR_RECORDS through the Intune one; both
 * maps are spread into those writers' records, so they are registered, gated
 * and listed like every other record.
 *
 * What each writes, and what stays a step for a person:
 *  - Custom detection rules (beta): created under the backup's own id and
 *    always turned off, because a rule's response actions can isolate devices
 *    or disable users. A restore never turns a rule on or off: a rule that was
 *    on in the backup ends with a step to turn it on by hand. Changed response
 *    actions, or a changed query on a rule that has them, wait for the approval.
 *    Graph allows 10 rule writes a minute, so the writes are paced.
 *  - Defender for Identity sensors: the settings of a sensor that is installed
 *    (description, domain controllers, delayed updates). Installing one is manual.
 *  - Exposure management zones (beta): name and description; a zone made before
 *    by an earlier restore is found by name. The environments in a zone are not
 *    backed up.
 *  - Item insights and To Do settings: one object per tenant, updated in place.
 *  - Copilot connectors: the connection, under its own id, with its name,
 *    description, settings and the apps allowed to push items. Its schema and
 *    items are not backed up; the connector pushes them again.
 *  - Intune partner connections (mobile threat defense, device management and
 *    compliance partners): the settings of a connection that is active. The
 *    connection itself is made from the partner's console.
 *  - Derived credential issuer settings (beta): the help page, notification and
 *    renewal threshold. The issuer decides which certificates devices get, so it
 *    is never written (the trust-field rule) and a difference is a step.
 * Changes that loosen protection or act on devices and people are protection
 * effects (safety/serviceSettingEffects.mjs), written only once approved.
 */
import { PROTECTION_APPROVAL_STEP, protectionChangeApproved, protectionEffects } from '../safety/contentEffects.mjs';
import { COMPLIANCE_PARTNER_ASSIGNMENTS, MTD_WRITABLE_FIELDS } from '../safety/serviceSettingEffects.mjs';
import { readAllPages } from './approvalHeld.mjs';
import { changedRecordFields, defineRecord, sameValue } from './recordWriter.mjs';

const DOCS = 'https://learn.microsoft.com/en-us/graph/api';
const v1 = (page) => `${DOCS}/${page}?view=graph-rest-1.0`;
const beta = (page) => `${DOCS}/${page}?view=graph-rest-beta`;

const DEFENDER = 'Microsoft Defender portal';
const M365 = 'Microsoft 365 admin center';
const INTUNE = 'Intune admin center, under Tenant administration, Connectors and tokens';
const PORTALS = Object.freeze({
  defenderDetectionRule: `${DEFENDER}, under Investigation and response, Hunting, Custom detection rules`,
  defenderIdentitySensor: `${DEFENDER}, under System, Settings, Identities, Sensors`,
  itemInsightsSettings: `${M365}, under Settings, Org settings, Search and intelligence`,
  todoSettings: `${M365}, under Settings, Org settings, Microsoft To Do`,
  externalConnection: `${M365}, under Copilot, Connectors`,
  mobileThreatDefenseConnector: `${INTUNE}, Mobile Threat Defense`,
  deviceManagementPartner: `${INTUNE}, Partner device management`,
  complianceManagementPartner: `${INTUNE}, Partner compliance management`,
  deviceManagementDerivedCredentialSettings: `${INTUNE}, Derived credentials`,
});

/**
 * A record `refusal`: a write with protection effects is made only once each was
 * approved (or approvals are off for the service). A dry run plans it and lists
 * them. Otherwise the whole object waits, as a step for a person.
 */
function protectionHeldRefusal(resource, verb, ctx = {}) {
  if (verb === 'delete') return null;
  const effects = protectionEffects({ ...resource, verb });
  if (effects.length === 0 || protectionChangeApproved(resource, verb, ctx)) return null;
  const fields = [...new Set(effects.map((effect) => effect.field))];
  const portalPath = PORTALS[resource.resourceType];
  const description = `The backup changes ${fields.join(', ')}, which changes what protects or acts on devices and people. `
    + `Either ${PROTECTION_APPROVAL_STEP}, or set it by hand in the ${portalPath}. Nothing else in this object was written either.`;
  return Object.freeze({
    outcome: 'skipped',
    reason: `manual: ${description}`,
    completion: Object.freeze([Object.freeze({ kind: 'manual-setting', requirement: 'protectionApproval', fields: Object.freeze(fields), portalPath, description })]),
  });
}

// A partner connection is made from the partner's console; KEEL only puts the
// settings of one that is active back.
const ACTIVE_PARTNER_STATES = Object.freeze({
  mobileThreatDefenseConnector: new Set(['available', 'enabled']),
  deviceManagementPartner: new Set(['enabled']),
  complianceManagementPartner: new Set(['enabled']),
});
function activePartnerRefusal(resource, verb) {
  if (verb !== 'update') return null;
  const state = resource.live?.payload?.partnerState;
  if (ACTIVE_PARTNER_STATES[resource.resourceType]?.has(state)) return null;
  return Object.freeze({
    outcome: 'skipped',
    reason: `manual: the partner connection is not active in Intune now (its state is ${state ?? 'not known'}). Connect it again from the partner's console, then restore again to put its settings back, or set them by hand in the ${PORTALS[resource.resourceType]}`,
  });
}
const partnerRefusal = (resource, verb, ctx) => activePartnerRefusal(resource, verb) ?? protectionHeldRefusal(resource, verb, ctx);

/**
 * A record `sameField`: a nested value reads the same when everything the backup
 * holds is there (a list in any order); a member Graph added on its own (a run
 * time, a newer property) is no difference.
 */
function holds(desired, live) {
  if (Array.isArray(desired)) {
    if (!Array.isArray(live) || live.length !== desired.length) return false;
    const left = [...live];
    return desired.every((item) => {
      const at = left.findIndex((candidate) => holds(item, candidate));
      if (at < 0) return false;
      left.splice(at, 1);
      return true;
    });
  }
  if (desired && typeof desired === 'object') {
    return Boolean(live) && typeof live === 'object' && !Array.isArray(live)
      && Object.keys(desired).filter((key) => !key.includes('@odata.')).every((key) => holds(desired[key], live[key]));
  }
  return sameValue(desired, live);
}
const sameHeldMembers = (fields) => (field, desired, live) => (fields.includes(field) ? holds(desired, live) : null);

// ------------------------------------------------------------ custom detection rules

const RULE_FIELDS = Object.freeze(['displayName', 'description', 'queryCondition', 'schedule', 'detectionAction']);
const ruleOn = (rule) => (typeof rule?.status === 'string' ? rule.status === 'enabled' : rule?.isEnabled === true);
const ruleState = (rule) => (ruleOn(rule) ? 'on' : 'off');
// What Graph sets itself inside a rule: when the query last changed, the next run.
const withoutRunTimes = (body) => {
  const out = { ...body };
  if (out.queryCondition && typeof out.queryCondition === 'object') {
    const { lastModifiedDateTime: _changed, ...query } = out.queryCondition;
    out.queryCondition = query;
  }
  if (out.schedule && typeof out.schedule === 'object') {
    const { nextRunDateTime: _next, ...schedule } = out.schedule;
    out.schedule = schedule;
  }
  return out;
};
// A rule is created under the backup's id and turned off; an update never sends its state.
const detectionRuleBody = (body, { verb, payload }) => (verb === 'create'
  ? { id: payload.id, ...withoutRunTimes(body), status: 'disabled' }
  : withoutRunTimes(body));

// The state the backup had and the rule does not have now is a step for a person.
function ruleStateStep(payload, live) {
  if (!live || ruleOn(payload) === ruleOn(live)) return null;
  const description = ruleOn(payload)
    ? `The rule was on in the backup and is off now. KEEL never turns a rule on, because its response actions can isolate devices or disable users. Check its response actions, then turn it on in the ${PORTALS.defenderDetectionRule}.`
    : `The rule was off in the backup and is on now. KEEL never turns a rule on or off; turn it off in the ${PORTALS.defenderDetectionRule} if it should be off.`;
  return Object.freeze({ kind: 'manual-setting', requirement: 'detectionRuleState', fields: Object.freeze(['status']), before: ruleState(live), after: ruleState(payload), description });
}

/**
 * Graph allows 10 custom detection rule writes a minute. Before each write the
 * writes of the last minute through the same writer are counted, and the write
 * waits until fewer than 10 remain. `ctx.ruleWritePace` ({ now, sleep }) is the
 * clock, for tests.
 */
export const RULE_WRITES_PER_MINUTE = 10;
const RULE_WINDOW_MS = 60_000;
const ruleWrites = new WeakMap();
const sleepMs = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
async function paceRuleWrites(io, { resource, payload, verb, ctx }) {
  if (ctx.mode === 'dry-run' || !io.writer) return null;
  if (verb === 'update' && changedRecordFields(SERVICE_SETTING_RECORDS.defenderDetectionRule, payload, resource.live?.payload ?? {}, verb).length === 0) return null;
  const { now = Date.now, sleep = sleepMs } = ctx.ruleWritePace ?? {};
  const times = ruleWrites.get(io.writer) ?? [];
  ruleWrites.set(io.writer, times);
  for (;;) {
    while (times.length > 0 && now() - times[0] >= RULE_WINDOW_MS) times.shift();
    if (times.length < RULE_WRITES_PER_MINUTE) break;
    await sleep(RULE_WINDOW_MS - (now() - times[0]));
  }
  times.push(now());
  return null;
}

// ------------------------------------------------------------ Defender for Identity sensors

/**
 * Graph updates a sensor's domain controllers on standalone sensors only, and its
 * domain controllers and delayed updates on versions before 3, so those are left
 * out of what is sent there, and a difference in them is a step for a person.
 */
const sensorFixedFields = (sensor) => [
  ...(sensor?.sensorType === 'domainControllerIntegrated' || /^3\./.test(String(sensor?.version ?? '')) ? ['domainControllerDnsNames'] : []),
  ...(/^3\./.test(String(sensor?.version ?? '')) ? ['isDelayedDeploymentEnabled'] : []),
];
function sensorBody(body, { payload }) {
  if (!body.settings || typeof body.settings !== 'object') return body;
  const fixed = sensorFixedFields(payload);
  const settings = Object.fromEntries(Object.entries(body.settings).filter(([key]) => !key.includes('@odata.') && !fixed.includes(key)));
  return { ...body, settings };
}
function sensorStep(payload, live) {
  if (!live) return null;
  const fixed = sensorFixedFields(live);
  const fields = fixed.filter((field) => payload?.settings?.[field] !== undefined && !holds(payload.settings[field], live.settings?.[field]));
  if (fields.length === 0) return null;
  const description = `Microsoft does not let ${fields.join(' or ')} be changed on this sensor (${live.sensorType ?? 'unknown type'}, version ${live.version ?? 'unknown'}). Set it on the server or in the ${PORTALS.defenderIdentitySensor}, from the backup.`;
  return Object.freeze({ kind: 'manual-setting', requirement: 'sensorSettings', fields: Object.freeze(fields.map((field) => `settings.${field}`)), description });
}

// ------------------------------------------------------------ exposure management zones

// Graph gives a zone a new id, so a restore run again after a create would not
// know the zone it made. The zones are listed first: one with the backup's name
// and description is that zone; one with the name and another description is
// left for a person, never duplicated.
async function zoneMadeBefore(io, { payload, verb }) {
  if (verb !== 'create') return null;
  const listed = await readAllPages(io, 'beta', '/security/zones');
  if (listed.error) return `could not list the zones to look for one made before (${listed.error})`;
  const named = listed.value.filter((zone) => String(zone?.displayName ?? '').toLowerCase() === String(payload.displayName ?? '').toLowerCase());
  if (named.length === 0) return null;
  const same = named.find((zone) => sameValue(zone.description, payload.description));
  if (same) return { skipped: `the zone is already there (${same.id}), so nothing is written` };
  return `a zone named ${payload.displayName} already exists with another description; KEEL does not make a second one, so check it by hand`;
}

// ------------------------------------------------------------ records

export const SERVICE_SETTING_RECORDS = Object.freeze({
  defenderDetectionRule: defineRecord({
    resourceType: 'defenderDetectionRule', version: 'beta', collection: '/security/rules/detectionRules',
    operations: ['create', 'update'], writable: RULE_FIELDS, transform: detectionRuleBody, sameField: sameHeldMembers(['queryCondition', 'schedule', 'detectionAction']),
    refusal: protectionHeldRefusal, preflight: paceRuleWrites,
    afterWrite: async (_io, { payload, live }) => {
      const step = ruleStateStep(payload, live);
      return step ? { completion: [step] } : null;
    },
    planCompletion: ({ payload, verb, before }) => [ruleStateStep(payload, verb === 'create' ? { status: 'disabled' } : before)].filter(Boolean),
    permission: 'CustomDetection.ReadWrite.All', docs: beta('security-rulesroot-post-detectionrules'),
  }),
  defenderIdentitySensor: defineRecord({
    resourceType: 'defenderIdentitySensor', version: 'v1.0', collection: '/security/identities/sensors',
    operations: ['update'], writable: ['settings'], transform: sensorBody, sameField: sameHeldMembers(['settings']),
    refusal: protectionHeldRefusal,
    // Judged on the sensor as it was before the write: an update does not send those settings.
    afterWrite: async (_io, { payload, before }) => {
      const step = sensorStep(payload, before);
      return step ? { completion: [step] } : null;
    },
    planCompletion: ({ payload, before }) => [sensorStep(payload, before)].filter(Boolean),
    permission: 'SecurityIdentitiesSensors.ReadWrite.All', docs: v1('security-sensor-update'),
  }),
  securityZone: defineRecord({
    resourceType: 'securityZone', version: 'beta', collection: '/security/zones',
    operations: ['create', 'update'], writable: ['displayName', 'description'], preflight: zoneMadeBefore,
    permission: 'Zone.ReadWrite.All', docs: beta('security-security-post-zones'),
  }),
  itemInsightsSettings: defineRecord({
    resourceType: 'itemInsightsSettings', tenantWide: true, version: 'v1.0', collection: '/admin/people/itemInsights',
    singleton: true, operations: ['update'], writable: ['isEnabledInOrganization', 'disabledForGroup'], refusal: protectionHeldRefusal,
    permission: 'PeopleSettings.ReadWrite.All', docs: v1('iteminsights-update'),
  }),
  todoSettings: defineRecord({
    resourceType: 'todoSettings', tenantWide: true, version: 'beta', collection: '/admin/todo',
    singleton: true, operations: ['update'], writable: ['isExternalJoinEnabled', 'isExternalShareEnabled', 'isPushNotificationEnabled'], refusal: protectionHeldRefusal,
    permission: 'OrgSettings-Todo.ReadWrite.All', docs: beta('admintodo-update'),
  }),
  // A connection is created under the backup's id, which the connector app
  // pushes its items to.
  externalConnection: defineRecord({
    resourceType: 'externalConnection', version: 'v1.0', collection: '/external/connections',
    operations: ['create', 'update'], writable: ['name', 'description', 'activitySettings', 'searchSettings', 'configuration'],
    transform: (body, { verb, payload }) => (verb === 'create' ? { id: payload.id, ...body } : body),
    sameField: sameHeldMembers(['activitySettings', 'searchSettings', 'configuration']), refusal: protectionHeldRefusal,
    permission: 'ExternalConnection.ReadWrite.All', docs: v1('externalconnectors-external-post-connections'),
  }),
});

// Each is one connection or issuer for the whole tenant, so on the test tenant
// it is written only with the tenant-wide option.
export const INTUNE_CONNECTOR_RECORDS = Object.freeze({
  mobileThreatDefenseConnector: defineRecord({
    resourceType: 'mobileThreatDefenseConnector', tenantWide: true, version: 'v1.0', collection: '/deviceManagement/mobileThreatDefenseConnectors',
    operations: ['update'], writable: MTD_WRITABLE_FIELDS, refusal: partnerRefusal,
    permission: 'DeviceManagementServiceConfig.ReadWrite.All', docs: v1('intune-onboarding-mobilethreatdefenseconnector-update'),
  }),
  deviceManagementPartner: defineRecord({
    resourceType: 'deviceManagementPartner', tenantWide: true, version: 'v1.0', collection: '/deviceManagement/deviceManagementPartners',
    operations: ['update'], writable: ['groupsRequiringPartnerEnrollment'], sameField: sameHeldMembers(['groupsRequiringPartnerEnrollment']), refusal: partnerRefusal,
    permission: 'DeviceManagementServiceConfig.ReadWrite.All', docs: v1('intune-onboarding-devicemanagementpartner-update'),
  }),
  complianceManagementPartner: defineRecord({
    resourceType: 'complianceManagementPartner', tenantWide: true, version: 'v1.0', collection: '/deviceManagement/complianceManagementPartners',
    operations: ['update'], writable: COMPLIANCE_PARTNER_ASSIGNMENTS, sameField: sameHeldMembers(COMPLIANCE_PARTNER_ASSIGNMENTS), refusal: partnerRefusal,
    permission: 'DeviceManagementServiceConfig.ReadWrite.All', docs: v1('intune-onboarding-compliancemanagementpartner-update'),
  }),
  // No writable list: every field but the issuer (a trust field, never sent) is
  // written, and an issuer that differs is the record writer's trust step.
  deviceManagementDerivedCredentialSettings: defineRecord({
    resourceType: 'deviceManagementDerivedCredentialSettings', tenantWide: true, version: 'beta', collection: '/deviceManagement/derivedCredentials',
    operations: ['update'], refusal: protectionHeldRefusal,
    permission: 'DeviceManagementConfiguration.ReadWrite.All', docs: beta('intune-raimportcerts-devicemanagementderivedcredentialsettings-update'),
  }),
});
