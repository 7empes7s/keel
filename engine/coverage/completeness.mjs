/**
 * Completeness records (coverage plan v3, package INCOMPLETE).
 *
 * Design principle (2026-10-14): nothing readable is skipped. An object KEEL can
 * read but not restore fully is backed up as an *incomplete configuration*: the
 * record says which parts are missing and why, so a restore can recreate what
 * is held and list the rest as follow-up steps.
 *
 * Every configuration type has exactly one of four coverage states, derived here
 * and never declared:
 *  - full: KEEL restores it itself and nothing is missing;
 *  - incomplete: recreated from the backup (by KEEL, or by hand until a writer
 *    exists) with follow-up steps for the missing parts;
 *  - microsoft-managed: Microsoft owns it, so there is nothing to restore;
 *  - not-readable: KEEL cannot read it (with the missing grant or the limit).
 *
 * A missing part names its reason:
 *  - secret: Microsoft never returns the value (client secrets, passwords);
 *  - read-only: it can be read but no tool can write it (history, synced data);
 *  - binary-route: a file on another route that the backup does not hold;
 *  - other-route: settings on a separate route that the backup does not hold yet;
 *  - microsoft-managed: Microsoft sets it, nobody writes it;
 *  - not-written: held in the backup, but KEEL does not write it yet.
 *
 * Text here is plain English: it is shown on the Coverage page and in
 * docs/coverage.md. Pure: no clock, no tenant, no network.
 */

export const COMPLETENESS_CONTRACT_VERSION = 1;
export const COVERAGE_STATES = Object.freeze(['full', 'incomplete', 'microsoft-managed', 'not-readable']);
export const MISSING_REASONS = Object.freeze(['secret', 'read-only', 'binary-route', 'other-route', 'microsoft-managed', 'not-written']);

/** Plain-English words for each reason, for the doc and the portal. */
export const REASON_WORDS = Object.freeze({
  secret: 'Microsoft never returns it',
  'read-only': 'no tool can write it',
  'binary-route': 'a file the backup does not hold',
  'other-route': 'stored separately and not in the backup yet',
  'microsoft-managed': 'set by Microsoft',
  'not-written': 'in the backup, but KEEL does not write it yet',
});

const WHOLE = 'The whole setting';

/**
 * A missing part. `items(payload)` (optional) lists the concrete instances in
 * one backed-up object (for example each client secret's name and expiry); a
 * part with `items` applies to an object only when it lists at least one.
 */
const part = (name, reason, items = null) => Object.freeze({ part: name, reason, ...(items ? { items } : {}) });

// ---- object-level extractors

const credentialItems = (field) => (payload) => (Array.isArray(payload?.[field]) ? payload[field] : []).map((credential) => Object.freeze({
  name: credential?.displayName ?? credential?.hint ?? credential?.keyId ?? 'unnamed',
  expires: credential?.endDateTime ?? null,
}));

const nameOf = (payload) => payload?.displayName ?? payload?.name ?? payload?.id ?? 'unnamed';
const always = (payload) => [Object.freeze({ name: nameOf(payload), expires: null })];

// Device configuration profiles whose secret values Microsoft never returns.
const CREDENTIAL_PROFILE = /wifi|wi-fi|vpn|certificate|pkcs|scep|email|easemail/i;
const credentialProfile = (payload) => (CREDENTIAL_PROFILE.test(String(payload?.['@odata.type'] ?? '')) ? always(payload) : []);

/** Every settings catalog value typed as a secret, anywhere in the policy. */
function secretSettings(payload) {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    if (/SecretSettingValue/i.test(String(node['@odata.type'] ?? ''))) {
      found.push(Object.freeze({ name: node.settingDefinitionId ?? 'secret setting', expires: null }));
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(payload?.settings ?? []);
  return found;
}

const synced = (payload) => (payload?.onPremisesSyncEnabled === true ? always(payload) : []);

/**
 * One record per catalogue type, reviewed by hand. `managed` marks a type
 * Microsoft owns; `unreadable` marks one KEEL cannot read (with `why`).
 * `whole` (by-hand types only) is the reason the whole setting is restored by
 * hand; it defaults to 'not-written'.
 */
export const COMPLETENESS = Object.freeze({
  // ---- tenant settings
  organization: { managed: true },
  domain: { whole: 'not-written', missing: [part('Proof that you own the domain (a DNS record you publish)', 'other-route')] },
  subscribedSku: { managed: true },
  directorySettingTemplate: { managed: true },
  groupSetting: { missing: [part('Settings on a single group', 'other-route'), part('A deleted tenant-wide setting', 'not-written')] },
  organizationalBranding: { missing: [part('Header logo', 'binary-route'), part('Content customization files', 'not-written')] },
  organizationalBrandingLocalization: { missing: [part('Header logo of each language', 'binary-route'), part('Adding or removing a language', 'not-written')] },
  groupLifecyclePolicy: { missing: [part('The list of groups a selected-groups policy covers', 'other-route'), part('A change that makes expiry more aggressive', 'not-written')] },
  administrativeUnit: { missing: [part('Members and admins scoped to the unit', 'other-route'), part('Dynamic membership rules and a deleted unit', 'not-written')] },

  // ---- users, groups, apps and admin roles
  user: { missing: [part('Password', 'secret'), part('Registered sign-in methods, such as MFA', 'secret'), part('Details synced from on-premises Active Directory', 'read-only', synced)] },
  group: {},
  contact: { whole: 'read-only' },
  application: { missing: [part('Client secrets', 'secret', credentialItems('passwordCredentials')), part('Certificates', 'secret', credentialItems('keyCredentials'))] },
  servicePrincipal: { missing: [
    part('Client secrets', 'secret', credentialItems('passwordCredentials')),
    part('Certificates', 'secret', credentialItems('keyCredentials')),
    part('Changed settings on an existing enterprise app', 'not-written'),
  ] },
  oauth2PermissionGrant: { whole: 'not-written' },
  identityProvider: { whole: 'not-written', missing: [part('Client secret', 'secret', always)] },
  certificateBasedAuthConfiguration: { whole: 'not-written' },
  directoryRole: { managed: true },
  roleDefinition: {},
  directoryRoleTemplate: { managed: true },
  roleAssignment: {},
  roleEligibilitySchedule: { missing: [part('Changing or removing an eligibility, and ones inherited through a group', 'not-written')] },
  unifiedRoleManagementPolicy: { missing: [part('A change that weakens protection', 'not-written')] },
  unifiedRoleManagementPolicyAssignment: { managed: true },
  roleAssignmentSchedule: { whole: 'not-written', missing: [part('Activations people made themselves', 'read-only')] },
  accessReviewScheduleDefinition: { whole: 'not-written', missing: [part('Past reviews and their decisions', 'read-only')] },
  accessPackage: { whole: 'not-written', missing: [part('Its catalog, assignment policies and resource roles', 'other-route'), part('Who holds the package now', 'read-only')] },
  connectedOrganization: { whole: 'not-written', missing: [part('Internal and external sponsors', 'other-route')] },

  // ---- sign-in and security policies
  conditionalAccessPolicy: {},
  authenticationStrengthPolicy: { missing: [part('A change to the allowed sign-in method combinations', 'not-written')] },
  namedLocation: {},
  authenticationContextClassReference: { whole: 'not-written' },
  authenticationMethodsPolicy: {},
  identitySecurityDefaultsEnforcementPolicy: {},
  authorizationPolicy: {},
  crossTenantAccessPolicy: {},
  crossTenantAccessPolicyConfigurationDefault: {},
  crossTenantAccessPolicyPartner: {},
  deviceRegistrationPolicy: { whole: 'not-written' },
  authenticationFlowsPolicy: {},
  permissionGrantPolicy: { whole: 'not-written', missing: [part('The include and exclude rules of a custom policy', 'other-route')] },
  adminConsentRequestPolicy: {},
  activityBasedTimeoutPolicy: { whole: 'not-written', missing: [part('Which apps the policy is assigned to', 'other-route')] },
  claimsMappingPolicy: { whole: 'not-written', missing: [part('Which apps the policy is assigned to', 'other-route')] },
  homeRealmDiscoveryPolicy: { whole: 'not-written', missing: [part('Which apps the policy is assigned to', 'other-route')] },
  tokenIssuancePolicy: { whole: 'not-written', missing: [part('Which apps the policy is assigned to', 'other-route')] },
  tokenLifetimePolicy: { whole: 'not-written', missing: [part('Which apps the policy is assigned to', 'other-route')] },
  featureRolloutPolicy: { whole: 'not-written', missing: [part('Which groups the rollout covers', 'other-route')] },

  // ---- Intune device management
  deviceConfiguration: { missing: [part('Passwords, keys and certificates in Wi-Fi, VPN, certificate and email profiles', 'secret', credentialProfile)] },
  deviceCompliancePolicy: {},
  configurationPolicy: { missing: [part('Secret settings', 'secret', secretSettings)] },
  deviceEnrollmentConfiguration: { whole: 'not-written' },
  deviceManagementRoleDefinition: { whole: 'not-written' },
  deviceCategory: { whole: 'not-written', missing: [part('Which devices are in the category', 'read-only')] },
  termsAndConditions: { whole: 'not-written', missing: [part('Who accepted the terms', 'read-only')] },
  windowsAutopilotDeploymentProfile: { whole: 'not-written', missing: [part('The registered device hardware it applies to', 'other-route')] },
  deviceManagementIntent: { whole: 'not-written', missing: [part('The baseline\'s settings', 'other-route')] },
  managedDevice: { managed: true },
  mobileApp: { whole: 'not-written', missing: [part('The app package', 'binary-route')] },
  managedAppPolicy: { whole: 'not-written', missing: [part('The list of protected apps', 'other-route')] },
  targetedManagedAppConfiguration: { whole: 'not-written', missing: [part('The apps it targets', 'other-route')] },
  mobileAppConfiguration: { whole: 'not-written' },
  // Wave 1 CAT-INTUNE. Assignments of these types are on a separate route.
  deviceManagementScript: { whole: 'not-written', missing: [part('The script itself', 'other-route'), part('Who the script is assigned to', 'other-route')] },
  deviceShellScript: { whole: 'not-written', missing: [part('The script itself', 'other-route'), part('Who the script is assigned to', 'other-route')] },
  deviceHealthScript: { whole: 'not-written', missing: [part('The detection and remediation scripts', 'other-route'), part('Who the remediation is assigned to', 'other-route'), part('Remediations published by Microsoft', 'microsoft-managed')] },
  deviceComplianceScript: { whole: 'not-written', missing: [part('The script itself', 'other-route')] },
  assignmentFilter: { whole: 'not-written' },
  roleScopeTag: { whole: 'not-written', missing: [part('The built-in Default tag', 'microsoft-managed')] },
  windowsFeatureUpdateProfile: { whole: 'not-written', missing: [part('Who the profile is assigned to', 'other-route')] },
  windowsQualityUpdateProfile: { whole: 'not-written', missing: [part('Who the profile is assigned to', 'other-route')] },
  windowsDriverUpdateProfile: { whole: 'not-written', missing: [part('Approved drivers', 'other-route'), part('Who the profile is assigned to', 'other-route')] },
  groupPolicyConfiguration: { whole: 'not-written', missing: [part('The values entered for each setting', 'other-route'), part('Who the template is assigned to', 'other-route')] },
  groupPolicyUploadedDefinitionFile: { whole: 'not-written', missing: [part('The template file content', 'binary-route')] },
  notificationMessageTemplate: { whole: 'not-written' },
  windowsAutopilotDeviceIdentity: { whole: 'secret', missing: [part('The device hardware hash', 'secret')] },
  deviceManagementRoleAssignment: { whole: 'not-written' },
});

const RECORD_FIELDS = new Set(['managed', 'unreadable', 'whole', 'missing']);

/**
 * The type's completeness, from its record and its qualification decision
 * ({ decision: 'automated' | 'manual' }). Throws on a record that contradicts
 * the decision, so a state can never be claimed without the writer behind it.
 */
export function completenessFor(resourceType, decision, { records = COMPLETENESS } = {}) {
  const record = records[resourceType];
  if (!record) throw new Error(`${resourceType}: no completeness record; add one to COMPLETENESS in engine/coverage/completeness.mjs`);
  const extra = Object.keys(record).filter((key) => !RECORD_FIELDS.has(key));
  if (extra.length > 0) throw new Error(`${resourceType}: completeness record carries unrecognised fields ${extra.join(', ')}`);
  const automated = decision?.decision === 'automated';
  if (!automated && decision?.decision !== 'manual') throw new Error(`${resourceType}: decision ${decision?.decision} is neither automated nor manual`);
  for (const item of record.missing ?? []) {
    if (!MISSING_REASONS.includes(item.reason)) throw new Error(`${resourceType}: missing part "${item.part}" has invalid reason ${item.reason}`);
  }

  if (record.managed) {
    if (automated) throw new Error(`${resourceType} is Microsoft-managed but has a registered writer`);
    return Object.freeze({ resourceType, state: 'microsoft-managed', recreate: 'none', missing: Object.freeze([]) });
  }
  if (record.unreadable) {
    if (typeof record.unreadable.why !== 'string' || record.unreadable.why.length === 0) throw new Error(`${resourceType}: not-readable needs a why`);
    return Object.freeze({ resourceType, state: 'not-readable', recreate: 'none', why: record.unreadable.why, missing: Object.freeze([]) });
  }
  if (automated && record.whole) throw new Error(`${resourceType} has a registered writer, so the whole setting is not restored by hand`);
  if (record.whole !== undefined && !MISSING_REASONS.includes(record.whole)) throw new Error(`${resourceType}: invalid whole-setting reason ${record.whole}`);
  const whole = automated ? [] : [part(WHOLE, record.whole ?? 'not-written')];
  const missing = Object.freeze([...whole, ...(record.missing ?? [])]);
  return Object.freeze({
    resourceType,
    state: missing.length === 0 ? 'full' : 'incomplete',
    recreate: automated ? 'keel' : 'by-hand',
    missing,
  });
}

/** One plain record of a missing part, for reports (no functions). */
const plainPart = (item, items) => Object.freeze({
  part: item.part, reason: item.reason, why: REASON_WORDS[item.reason], ...(items ? { items: Object.freeze(items) } : {}),
});

/**
 * One backed-up object: is it incomplete, and what is missing from it. A part
 * with an item list applies only when the object has such items (an app with
 * no secret is not missing a secret).
 */
export function assessObject(resourceType, payload, decision, options = {}) {
  const type = completenessFor(resourceType, decision, options);
  const missing = [];
  for (const item of type.missing) {
    if (!item.items) { missing.push(plainPart(item, null)); continue; }
    const items = item.items(payload);
    if (items.length > 0) missing.push(plainPart(item, items));
  }
  return Object.freeze({ resourceType, state: type.state, incomplete: missing.length > 0, missing: Object.freeze(missing) });
}

/**
 * A whole backup: `resources` are { resourceType, naturalKey, payload } rows;
 * `decisionFor(type)` returns the type's qualification decision. The backup is
 * incomplete when any object is; every incomplete object is listed with its
 * missing parts.
 */
export function assessBackup(resources, decisionFor, options = {}) {
  const objects = [];
  for (const resource of resources) {
    const assessed = assessObject(resource.resourceType, resource.payload, decisionFor(resource.resourceType), options);
    if (assessed.incomplete) objects.push(Object.freeze({ naturalKey: resource.naturalKey ?? null, ...assessed }));
  }
  return Object.freeze({ incomplete: objects.length > 0, incompleteObjects: objects.length, objects: Object.freeze(objects) });
}
