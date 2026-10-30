/** Catalogue family: Intune. See ../catalog.mjs for the entry shape. */
export default [
  { type: 'deviceConfiguration', path: '/deviceManagement/deviceConfigurations', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  // Issue #155: Graph needs a compliance policy's actions for noncompliance to
  // create it, and lists them only when expanded.
  { type: 'deviceCompliancePolicy', path: '/deviceManagement/deviceCompliancePolicies', version: 'v1.0', criticality: 'tier1', blastRadius: 'access-affecting',
    query: '$expand=scheduledActionsForRule($expand=scheduledActionConfigurations)',
    note: 'Compliance feeds CA. A wrong compliance policy locks users out indirectly.' },
  // Issue #155: a settings catalog policy's settings are a separate collection,
  // listed only when expanded; without them the backup holds only the name.
  { type: 'configurationPolicy', path: '/deviceManagement/configurationPolicies', version: 'beta', criticality: 'tier2', blastRadius: 'access-affecting',
    query: '$expand=settings',
    note: 'Settings catalog. Beta-only; a fidelity risk the spec flags.' },
  { type: 'deviceEnrollmentConfiguration', path: '/deviceManagement/deviceEnrollmentConfigurations', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'deviceManagementRoleDefinition', path: '/deviceManagement/roleDefinitions', version: 'v1.0', criticality: 'tier1', blastRadius: 'access-affecting' },
  { type: 'deviceCategory', path: '/deviceManagement/deviceCategories', version: 'v1.0', criticality: 'tier3', blastRadius: 'cosmetic' },
  { type: 'termsAndConditions', path: '/deviceManagement/termsAndConditions', version: 'beta', criticality: 'tier3', blastRadius: 'cosmetic' },
  { type: 'windowsAutopilotDeploymentProfile', path: '/deviceManagement/windowsAutopilotDeploymentProfiles', version: 'beta', criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'Beta-only surface — a fidelity risk the spec flags for Intune.' },
  { type: 'deviceManagementIntent', path: '/deviceManagement/intents', version: 'beta', criticality: 'tier2', blastRadius: 'access-affecting' },
  // The templates older endpoint security and security baseline policies are
  // made from. An intent names only its templateId; the template's
  // templateSubtype says which Defender area it is (antivirus, firewall, ...).
  // Read-only reference data. intentCount moves whenever a policy is made, so
  // it is not selected. Off (liveGate) until a live read passes.
  { type: 'deviceManagementTemplate', path: '/deviceManagement/templates', version: 'beta', criticality: 'tier3', blastRadius: 'cosmetic',
    select: 'id,displayName,description,versionInfo,isDeprecated,templateType,templateSubtype,platformType,publishedDateTime',
    liveGate: 'endpoint security templates: off until a live read of /beta/deviceManagement/templates passes',
    note: 'Reference catalogue of Microsoft templates. Used to file older endpoint security policies by area; never restored.' },
  { type: 'managedDevice', path: '/deviceManagement/managedDevices', version: 'v1.0', criticality: 'tier3', blastRadius: 'cosmetic', pageCap: 5,
    note: 'Device records are re-enrolled, not restored. Counted for scale only.' },
  // Restore gaps batch 19: the categories an app is in are a separate
  // collection, read per app (only each category's id and name), so a restore
  // can put the app back in them. Sorted by name: Graph promises no order.
  // An app in no category keeps no list, so it reads as before this batch.
  { type: 'mobileApp', path: '/deviceAppManagement/mobileApps', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting', pageCap: 20,
    itemReads: { as: 'categories', path: '/deviceAppManagement/mobileApps/{item}/categories?$select=id,displayName', sortBy: 'displayName', omitEmpty: true } },
  // Restore gaps batch 13: the apps an iOS or Android app protection policy (or
  // an app configuration policy) covers are a separate collection, read per
  // policy, so a restore can recreate a policy with its apps.
  { type: 'managedAppPolicy', path: '/deviceAppManagement/managedAppPolicies', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting',
    itemReads: {
      as: 'apps',
      byType: {
        '#microsoft.graph.iosManagedAppProtection': '/deviceAppManagement/iosManagedAppProtections/{item}/apps',
        '#microsoft.graph.androidManagedAppProtection': '/deviceAppManagement/androidManagedAppProtections/{item}/apps',
      },
    } },
  { type: 'targetedManagedAppConfiguration', path: '/deviceAppManagement/targetedManagedAppConfigurations', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting',
    itemReads: { as: 'apps', path: '/deviceAppManagement/targetedManagedAppConfigurations/{item}/apps' } },
  { type: 'mobileAppConfiguration', path: '/deviceAppManagement/mobileAppConfigurations', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
];
