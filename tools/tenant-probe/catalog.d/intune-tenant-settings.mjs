/** Catalogue family: Intune tenant settings (remaining kinds, batch 3). See ../catalog.mjs for the entry shape. */
// Read-only list, singleton or per-object reads. Each path is in the operator's export of
// what tenant discovery found readable but not backed up (Q100, run of
// 2026-10-19), so the grant each needs is one the Collector already holds.
// Most are beta only, a fidelity risk the spec flags.
// Who a policy is assigned to sits on a separate /assignments route and is not
// read for these types yet.
export default [
  // Compliance policies built in the settings catalog (Linux and newer platforms).
  // Like configurationPolicy, the settings are a separate collection, listed
  // only when expanded. The actions for noncompliance are returned only when one
  // policy is read with them expanded, so each policy is listed, then read on its
  // own with both (restore gaps batch 7).
  { type: 'deviceManagementCompliancePolicy', path: '/deviceManagement/compliancePolicies/{parent}', version: 'beta', criticality: 'tier1', blastRadius: 'access-affecting',
    parent: { path: '/deviceManagement/compliancePolicies', select: 'id', key: 'id', as: 'id' },
    query: '$expand=settings,scheduledActionsForRule($expand=scheduledActionConfigurations)',
    // A policy deleted between the list and its own read is gone, not a failed read.
    absentWhenNotFound: true,
    note: 'Compliance feeds Conditional Access. The settings and actions for noncompliance are read per policy.' },
  // Reusable settings groups (for example firewall rule addresses) that settings
  // catalog policies reference by id.
  { type: 'deviceManagementReusablePolicySetting', path: '/deviceManagement/reusablePolicySettings', version: 'beta', criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'Policies that use a group refer to it by id, so it is rebuilt before them.' },
  // Policy sets: bundles of apps and policies assigned together. What a set
  // holds (its items) is returned only when one set is read with the items
  // expanded, so each set is listed, then read on its own (restore gaps batch 6).
  { type: 'policySet', path: '/deviceAppManagement/policySets/{parent}', version: 'beta', criticality: 'tier3', blastRadius: 'cosmetic',
    parent: { path: '/deviceAppManagement/policySets', select: 'id', key: 'id', as: 'id' },
    query: '$expand=items',
    // A set deleted between the list and its own read is gone, not a failed read.
    absentWhenNotFound: true,
    note: 'The apps and policies in each set are read per set.' },
  // Apple Volume Purchase Program tokens. The token itself is a secret and is
  // left out of the read; the Apple ID, organization and expiry are what a
  // renewal needs. Issue #466: v1.0 has no countryOrRegionCode, so it is not
  // selected (Graph answers 400 for an unknown property).
  { type: 'vppToken', path: '/deviceAppManagement/vppTokens', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting',
    select: 'id,organizationName,vppTokenAccountType,appleId,expirationDateTime,lastSyncDateTime,lastModifiedDateTime,state,lastSyncStatus,automaticallyUpdateApps',
    note: 'An expired token stops app licences syncing. Renew it with the same Apple ID.' },
  // Apple Automated Device Enrollment (DEP) tokens. Graph never returns the
  // token file; the Apple ID and expiry are what a renewal needs.
  { type: 'depOnboardingSetting', path: '/deviceManagement/depOnboardingSettings', version: 'beta', criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'An expired token stops new Apple devices enrolling. Renew it with the same Apple ID.' },
  // Managed Google Play binding. Company codes carry enrollment tokens and QR
  // codes, so they are left out of the read. Issue #466: Graph has no
  // androidDeviceAdministratorEnrollmentEnabled here, so it is not selected.
  { type: 'androidManagedStoreAccountEnterpriseSettings', path: '/deviceManagement/androidManagedStoreAccountEnterpriseSettings', version: 'beta', singleton: true,
    absentWhenNotFound: true, criticality: 'tier2', blastRadius: 'access-affecting',
    select: 'id,bindStatus,lastAppSyncDateTime,lastAppSyncStatus,ownerUserPrincipalName,ownerOrganizationName,lastModifiedDateTime,enrollmentTarget,targetGroupIds,deviceOwnerManagementEnabled',
    note: 'A broken binding stops Android Enterprise enrollment and app sync. Rebind with the same Google account.' },
  // Device cleanup rules: when Intune removes devices that stopped checking in.
  { type: 'managedDeviceCleanupRule', path: '/deviceManagement/managedDeviceCleanupRules', version: 'beta', criticality: 'tier3', blastRadius: 'cosmetic' },
  // Windows hotpatch quality update policies.
  { type: 'windowsQualityUpdatePolicy', path: '/deviceManagement/windowsQualityUpdatePolicies', version: 'beta', criticality: 'tier2', blastRadius: 'access-affecting' },
  // Multi admin approval: which changes need a second admin, and who approves.
  { type: 'operationApprovalPolicy', path: '/deviceManagement/operationApprovalPolicies', version: 'beta', criticality: 'tier1', blastRadius: 'access-affecting',
    note: 'A missing policy lets one admin make changes that should need a second one.' },
  // macOS custom attribute scripts. Graph leaves the script body out of list
  // reads, so each script is listed, then read on its own (restore gaps batch
  // 5, as for the scripts in intune-extended.mjs).
  { type: 'deviceCustomAttributeShellScript', path: '/deviceManagement/deviceCustomAttributeShellScripts/{parent}', version: 'beta', criticality: 'tier3', blastRadius: 'cosmetic',
    parent: { path: '/deviceManagement/deviceCustomAttributeShellScripts', select: 'id', key: 'id', as: 'id' },
    // A script deleted between the list and its own read is gone, not a failed read.
    absentWhenNotFound: true,
    note: 'The script body is read per script.' },
];
