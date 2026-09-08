/**
 * ResourceTypeDescriptors (spec §7.1) for every resource type in the
 * tenant-probe catalog. One descriptor per type; the `adapter` field is the
 * STATIC, VERSIONED id of the serving adapter (spec §4.2) — it is a
 * declaration, never resolved at runtime, and there is deliberately no
 * fallback mechanism.
 *
 * criticality / blastRadius come from the tenant-probe CATALOG, the single
 * source of truth — duplicating those values here is what let `user` sit on
 * tier2 while the catalog said tier1. fidelity comes from cir/canonicalize.mjs
 * (the catalog has no fidelity field), defaulting to 'read-only': a type is
 * 'full' only where engine/restore/applyEngine.mjs's pathFor() has a write
 * path for it. Understating fidelity is safe; overstating it is a product
 * defect.
 *
 * DESCRIPTORS vs ALL_DESCRIPTORS: ALL_DESCRIPTORS covers all 52 catalog types
 * — the registry KNOWS about every type. DESCRIPTORS is the COLLECTED set —
 * entraAdapter.mjs registers each of these and derives M1_TYPES from them.
 *
 * DESCRIPTORS started as exactly the original six M1 types (still the first
 * six here, in the same historical order — see LIVE_SINCE_M1 below) and was
 * widened on 2026-09-08 after measuring naturalKeyFor()/naturalKey() against
 * a real tenant for all 52 catalog types (throwaway script; see
 * engine/collect/registry.test.mjs for the invariants that measurement now
 * backs, and engine/cir/canonicalize.mjs's keyFor() header for the two types
 * that needed an explicit key override). A type was added to WIDENED_2026_09_08
 * only if the measurement showed BOTH zero natural-key collisions AND zero
 * objects whose key silently fell through to a tenant-bound GUID (or, for
 * crossTenantAccessPolicyPartner/adminConsentRequestPolicy, only after a
 * proper composed key was added in canonicalize.mjs and RE-measured clean).
 *
 * Left OUT of collection, with the measured reason:
 *  - directorySettingTemplate, directoryRoleTemplate: measured CLEAN (0
 *    collisions, 0 GUID-fallback) but deliberately excluded anyway — both are
 *    Microsoft-global catalogs, not tenant resources to recreate, the same
 *    architectural call already made for directoryRoleTemplate before this
 *    widening (see the GLOBAL_ROLE_SYMBOLS comment in canonicalize.mjs).
 *  - deviceEnrollmentConfiguration: measured DIRTY — 4 of 5 objects in the
 *    probe tenant share the displayName "All users and all devices" (the
 *    default Limit/PlatformRestrictions/WindowsHelloForBusiness/... configs
 *    all name their target the same way). The `_<ConfigType>` suffix on
 *    `id` looks like the real distinguishing key but that's a guess at
 *    Microsoft's schema, not something this measurement confirmed — left out
 *    rather than ship an unverified composed key.
 *  - oauth2PermissionGrant, roleEligibilitySchedule: measured DIRTY — both
 *    default to Graph's opaque base64 composite `id` (no displayName/name
 *    field exists on either type), which is a real silent-GUID-fallback, not
 *    a heuristic false positive. Both look composable (grant: clientId +
 *    resourceId + principalId + consentType; schedule: role + principal +
 *    scope, like roleAssignment) but building and verifying that composition
 *    was out of scope for this pass — left out rather than guess.
 *  - Nineteen types returned ZERO objects in the measured tenant (contact,
 *    certificateBasedAuthConfiguration, authenticationContextClassReference,
 *    activityBasedTimeoutPolicy, claimsMappingPolicy, homeRealmDiscoveryPolicy,
 *    tokenIssuancePolicy, tokenLifetimePolicy, featureRolloutPolicy,
 *    accessPackage, connectedOrganization, deviceCategory, termsAndConditions,
 *    windowsAutopilotDeploymentProfile, deviceManagementIntent, managedDevice,
 *    managedAppPolicy, targetedManagedAppConfiguration, mobileAppConfiguration).
 *    Zero objects is vacuously "zero collisions, zero GUID-fallback", but
 *    that is an absence of evidence, not evidence of safety — "measure before
 *    claiming safe" only holds if there is something to measure. Left out
 *    until this tenant (or another) actually has data of these types to
 *    re-run the measurement against.
 */

import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { FIDELITY } from '../cir/canonicalize.mjs';

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

// Added 2026-09-08 — see the file header for the measurement that justifies
// each entry and the full list of what was deliberately left out.
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

export const DESCRIPTORS = [...LIVE_SINCE_M1, ...WIDENED_2026_09_08].map(describe);

// Every catalog type, collected first (the same descriptor objects as
// DESCRIPTORS), then the rest in catalog order. The "rest" here is exactly
// the types NOT wired into collection — see the file header for why each one
// is still out.
export const ALL_DESCRIPTORS = [
  ...DESCRIPTORS,
  ...CATALOG.filter((entry) => !DESCRIPTORS.some((d) => d.type === entry.type)).map((entry) =>
    describe(entry.type),
  ),
];
