/**
 * Issue #1074: the protection effects of the Defender, Intune connector and
 * Microsoft 365 settings restores (engine/restore/serviceSettingsOperations.mjs).
 * Spread into PROTECTION_EFFECT_RULES (contentEffects.mjs), so the dry run lists
 * each one and the writer sends it only once it was approved, or the customer
 * turned restore approvals off for the service.
 *
 * A rule fails closed: a value live does not hold reads as a change.
 */
const at = (path) => (payload) => path.split('.').reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), payload);
const effectRule = (field, effect, when, read = at(field)) => Object.freeze({ field, effect, when, read, detail: null });

// A canonical form with nulls dropped and keys sorted, so the same value read in
// another key order is no change.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).filter((key) => !key.includes('@odata.') && value[key] !== null && value[key] !== undefined)
    .sort().map((key) => [key, canonical(value[key])]));
}
const text = (value) => JSON.stringify(canonical(value ?? null));
const list = (value) => (Array.isArray(value) ? value : []);

const turnsOn = (before, after) => after === true && before !== true;
const turnsOff = (before, after) => after === false && before !== false;
const rises = (before, after) => typeof after === 'number' && !(typeof before === 'number' && before >= after);
const falls = (before, after) => typeof after === 'number' && !(typeof before === 'number' && before <= after);
const changes = (before, after) => text(before) !== text(after);
const dropsEntry = (before, after) => list(before).some((entry) => !list(after).map(text).includes(text(entry)));
const addsEntry = (before, after) => list(after).some((entry) => !list(before).map(text).includes(text(entry)));
// A cleared or other group the setting is turned off for reaches the people of the old one.
const leavesGroup = (before, after) => typeof before === 'string' && before.length > 0 && before !== after;

// Mobile threat defense: each switch decides whether devices are checked by the
// partner, or blocked when the partner has no data. Off weakens what compliance
// checks; on can make devices noncompliant, and Conditional Access then blocks them.
const MTD_SWITCHES = Object.freeze([
  'androidEnabled', 'iosEnabled', 'windowsEnabled',
  'androidMobileApplicationManagementEnabled', 'iosMobileApplicationManagementEnabled', 'windowsMobileApplicationManagementEnabled',
  'androidDeviceBlockedOnMissingPartnerData', 'iosDeviceBlockedOnMissingPartnerData', 'windowsDeviceBlockedOnMissingPartnerData',
  'partnerUnsupportedOsVersionBlocked', 'microsoftDefenderForEndpointAttachEnabled',
]);
const MTD_APP_DATA = Object.freeze(['allowPartnerToCollectIOSApplicationMetadata', 'allowPartnerToCollectIOSPersonalApplicationMetadata']);
export const MTD_WRITABLE_FIELDS = Object.freeze([...MTD_SWITCHES, ...MTD_APP_DATA, 'partnerUnresponsivenessThresholdInDays']);

export const COMPLIANCE_PARTNER_ASSIGNMENTS = Object.freeze(['androidEnrollmentAssignments', 'iosEnrollmentAssignments', 'macOsEnrollmentAssignments', 'windowsEnrollmentAssignments']);
// A partner assignment names its group by id; the effect compares the targets.
const targets = (field) => (payload) => list(payload?.[field]).map((entry) => canonical(entry?.target ?? entry)).sort((a, b) => text(a).localeCompare(text(b)));

// A rule's response actions (isolate a device, disable a user), under either name Graph has used.
const ruleActions = (payload) => {
  const actions = payload?.detectionAction?.responseActions ?? payload?.detectionAction?.automatedActions ?? null;
  return actions && (!Array.isArray(actions) || actions.length > 0) && Object.keys(actions).length > 0 ? canonical(actions) : null;
};
// A rule's query decides which devices and users its actions reach; it counts only when the rule has actions.
const actingQuery = (payload) => (ruleActions(payload) ? (payload?.queryCondition?.queryText ?? null) : null);

export const SERVICE_SETTING_PROTECTION_RULES = Object.freeze({
  // A custom detection rule is created turned off, so a create carries no effect.
  defenderDetectionRule: { rules: [
    effectRule('detectionAction.responseActions', 'acts-on-accounts', (before, after) => after !== null && changes(before, after), ruleActions),
    effectRule('queryCondition.queryText', 'acts-on-accounts', (before, after) => after !== null && changes(before, after), actingQuery),
  ] },
  // Delayed updates, or a domain controller dropped from a standalone sensor, leave servers unwatched.
  defenderIdentitySensor: { rules: [
    effectRule('settings.isDelayedDeploymentEnabled', 'weakens-protection', turnsOn),
    effectRule('settings.domainControllerDnsNames', 'weakens-protection', dropsEntry),
  ] },
  // People cards and search show the documents people worked on.
  itemInsightsSettings: { rules: [
    effectRule('isEnabledInOrganization', 'weakens-protection', turnsOn),
    effectRule('disabledForGroup', 'weakens-protection', leavesGroup),
  ] },
  todoSettings: { rules: [
    effectRule('isExternalJoinEnabled', 'externally-sharing', turnsOn),
    effectRule('isExternalShareEnabled', 'externally-sharing', turnsOn),
  ] },
  // The apps that may push items into a connection, and so into Copilot and search.
  externalConnection: { judgesCreates: true, rules: [
    effectRule('configuration.authorizedAppIds', 'access-changing', addsEntry),
  ] },
  mobileThreatDefenseConnector: { rules: [
    ...MTD_SWITCHES.flatMap((field) => [effectRule(field, 'weakens-protection', turnsOff), effectRule(field, 'acts-on-accounts', turnsOn)]),
    ...MTD_APP_DATA.map((field) => effectRule(field, 'externally-sharing', turnsOn)),
    effectRule('partnerUnresponsivenessThresholdInDays', 'weakens-protection', rises),
    effectRule('partnerUnresponsivenessThresholdInDays', 'acts-on-accounts', falls),
  ] },
  // Which users must enroll their devices through the partner.
  deviceManagementPartner: { rules: [
    effectRule('groupsRequiringPartnerEnrollment', 'acts-on-accounts', changes, targets('groupsRequiringPartnerEnrollment')),
  ] },
  // Devices in an added group get their compliance from the partner, not Intune;
  // a removed group falls back to Intune's own compliance policies.
  complianceManagementPartner: { rules: COMPLIANCE_PARTNER_ASSIGNMENTS.flatMap((field) => [
    effectRule(field, 'weakens-protection', addsEntry, targets(field)),
    effectRule(field, 'acts-on-accounts', dropsEntry, targets(field)),
  ]) },
  // The help page the Company Portal sends people to when they set up a derived credential.
  deviceManagementDerivedCredentialSettings: { rules: [
    effectRule('helpUrl', 'weakens-protection', changes),
  ] },
});
