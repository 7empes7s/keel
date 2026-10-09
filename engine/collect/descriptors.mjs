/**
 * Graph-native ResourceTypeDescriptors (spec §7.1) for all 54 catalogue types.
 * Registration is static; the adapter id is a declaration, never a fallback.
 * criticality / blastRadius come from CATALOG and fidelity from FIDELITY.
 *
 * The first six M1 types retain their historical order. The next 22 were
 * enabled after natural-key measurement on 2026-09-08. Phase 3 enables the
 * remaining 24 after all endpoints were measured HTTP 200 with existing
 * consent. Empty collections are valid observations, not coverage failures.
 *
 * Every Phase 3 type remains read-only and not remappable. Portable keys and
 * writability have not been verified. Explicit id keys preserve distinct
 * inventory records even when names collide; the certificate singleton uses
 * a constant. Global templates are reference catalogues, never restore claims.
 */

import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { FIDELITY } from '../cir/canonicalize.mjs';
import { ID_KEY_TYPES } from '../cir/naturalKey.mjs';

const CATALOG_BY_TYPE = new Map(CATALOG.map((entry) => [entry.type, entry]));

// Per-type descriptor details the catalog does not carry. Only non-default
// values are listed:
//   naturalKeyStrategy — how naturalKeyFor()/canonicalize.mjs's keyFor() keys
//     the type. Default 'displayName' is naturalKey()'s fallback branch
//     (displayName ?? name ?? id), used by every type without a named case
//     there or an override in canonicalize.mjs's keyFor().
//   remappable — default false. True only where the type's references can be
//     remapped at apply time; when unsure, understate.
const DETAILS = {
  ...Object.fromEntries([...ID_KEY_TYPES].map((type) => [type, { naturalKeyStrategy: 'id' }])),
  certificateBasedAuthConfiguration: { naturalKeyStrategy: 'constant' },
  // UPN is tenant-bound and passwords are never readable — a user cannot be
  // remapped into another tenant as the same principal.
  user: {
    naturalKeyStrategy: 'userPrincipalName',
    remappable: false,
    unsupportedFields: ['passwordProfile'],
  },
  authenticationStrengthPolicy: { naturalKeyStrategy: 'displayName', remappable: true },
  group: { naturalKeyStrategy: 'mailNickname', remappable: true },
  roleAssignment: {
    naturalKeyStrategy: 'composed:roleDefinition@principal@directoryScope',
    remappable: true,
  },
  namedLocation: { naturalKeyStrategy: 'displayName', remappable: true },
  conditionalAccessPolicy: { naturalKeyStrategy: 'displayName', remappable: true },
  domain: { naturalKeyStrategy: 'id' },
  subscribedSku: { naturalKeyStrategy: 'skuPartNumber' },
  application: { naturalKeyStrategy: 'appId' },
  servicePrincipal: { naturalKeyStrategy: 'appId' },
  roleDefinition: { naturalKeyStrategy: 'roleTemplateId' },
  directoryRole: { naturalKeyStrategy: 'roleTemplateId' },
  // Measured 2026-09-08: this type has no id, displayName, or name field at
  // all — Graph identifies a partner purely by tenantId. See
  // canonicalize.mjs's keyFor() for the override; naturalKeyStrategy is
  // documented here to match.
  crossTenantAccessPolicyPartner: { naturalKeyStrategy: 'tenantId' },
  // True Graph singleton (catalog: singleton: true) with no id/displayName/
  // name either. keyFor() in canonicalize.mjs gives it a fixed constant key
  // — safe because a second object of this type can never exist to collide
  // with it.
  adminConsentRequestPolicy: { naturalKeyStrategy: 'constant' },
  // Roadmap task-149: two more tenant singletons. Each has exactly one object
  // per tenant, so a constant key can never collide.
  identitySecurityDefaultsEnforcementPolicy: { naturalKeyStrategy: 'constant' },
  crossTenantAccessPolicyConfigurationDefault: { naturalKeyStrategy: 'constant' },
  // Measured 2026-09-08, zero collisions and zero GUID-fallback for every
  // object of these types in the probe tenant (see the natural-key widening
  // report). All genuinely have a human-assigned displayName or name in
  // practice — the bare fallback is left as-is rather than given a
  // redundant explicit case, and is justified here plus in the
  // JUSTIFIED_DISPLAYNAME_FALLBACK allowlist in registry.test.mjs, which
  // pins this list so a future silent regression fails the test.
  organization: { naturalKeyStrategy: 'displayName' },
  groupSetting: { naturalKeyStrategy: 'displayName' },
  administrativeUnit: { naturalKeyStrategy: 'displayName' },
  identityProvider: { naturalKeyStrategy: 'displayName' },
  authenticationMethodsPolicy: { naturalKeyStrategy: 'displayName' },
  authorizationPolicy: { naturalKeyStrategy: 'displayName' },
  crossTenantAccessPolicy: { naturalKeyStrategy: 'displayName' },
  permissionGrantPolicy: { naturalKeyStrategy: 'displayName' },
  accessReviewScheduleDefinition: { naturalKeyStrategy: 'displayName' },
  deviceConfiguration: { naturalKeyStrategy: 'displayName' },
  deviceCompliancePolicy: { naturalKeyStrategy: 'displayName' },
  configurationPolicy: { naturalKeyStrategy: 'displayName' }, // Graph returns `name`, not `displayName`, for this type — still the same fallback branch.
  deviceManagementRoleDefinition: { naturalKeyStrategy: 'displayName' },
  mobileApp: { naturalKeyStrategy: 'displayName' },
};

function describe(type) {
  const entry = CATALOG_BY_TYPE.get(type);
  if (!entry) throw new Error(`no catalog entry for resource type ${type}`);
  const details = DETAILS[type] ?? {};
  return {
    type,
    fidelity: FIDELITY[type] ?? 'read-only',
    unsupportedFields: details.unsupportedFields ?? [],
    criticality: entry.criticality,
    blastRadius: entry.blastRadius,
    naturalKeyStrategy: details.naturalKeyStrategy ?? 'displayName',
    remappable: details.remappable ?? false,
    adapter: `graph-native/${type}`,
  };
}

// The original six M1 types, in historical collection order. Order is
// load-bearing: entraAdapter.mjs derives M1_TYPES from DESCRIPTORS and
// engine/collect/registry.test.mjs pins this exact prefix as a regression
// guard — these six must never be removed or reordered by a later widening.
const LIVE_SINCE_M1 = [
  'user',
  'authenticationStrengthPolicy',
  'group',
  'roleAssignment',
  'namedLocation',
  'conditionalAccessPolicy',
];

// First widening on 2026-09-08: measured portable keys for these 22 types.
const WIDENED_2026_09_08 = [
  'organization',
  'domain',
  'subscribedSku',
  'groupSetting',
  'administrativeUnit',
  'identityProvider',
  'application',
  'servicePrincipal',
  'directoryRole',
  'roleDefinition',
  'authenticationMethodsPolicy',
  'authorizationPolicy',
  'crossTenantAccessPolicy',
  'crossTenantAccessPolicyPartner',
  'permissionGrantPolicy',
  'adminConsentRequestPolicy',
  'accessReviewScheduleDefinition',
  'deviceConfiguration',
  'deviceCompliancePolicy',
  'configurationPolicy',
  'deviceManagementRoleDefinition',
  'mobileApp',
];

// Phase 3: policy / role recovery first, then device / app configuration and
// tenant data. Managed devices and contacts retain catalogue tier3 criticality.
const PHASE3_TYPES = [
  'certificateBasedAuthConfiguration',
  'homeRealmDiscoveryPolicy',
  'roleEligibilitySchedule',
  'oauth2PermissionGrant',
  'directoryRoleTemplate',
  'directorySettingTemplate',
  'authenticationContextClassReference',
  'activityBasedTimeoutPolicy',
  'claimsMappingPolicy',
  'tokenIssuancePolicy',
  'tokenLifetimePolicy',
  'featureRolloutPolicy',
  'accessPackage',
  'connectedOrganization',
  'deviceEnrollmentConfiguration',
  'deviceCategory',
  'managedAppPolicy',
  'targetedManagedAppConfiguration',
  'mobileAppConfiguration',
  'termsAndConditions',
  'windowsAutopilotDeploymentProfile',
  'deviceManagementIntent',
  'managedDevice',
  'contact',
];

// Roadmap task-149: tenant-wide security singletons that were not collected.
// Security defaults was read only by the sign-in path gate; the cross-tenant
// default lives under /default, not on the root crossTenantAccessPolicy object.
const WIDENED_2026_10_09 = [
  'identitySecurityDefaultsEnforcementPolicy',
  'crossTenantAccessPolicyConfigurationDefault',
];

export const DESCRIPTORS = [...LIVE_SINCE_M1, ...WIDENED_2026_09_08, ...PHASE3_TYPES, ...WIDENED_2026_10_09].map(describe);

// Retain the metadata export used by coverage consumers. Every type is now collected.
export const ALL_DESCRIPTORS = DESCRIPTORS;
