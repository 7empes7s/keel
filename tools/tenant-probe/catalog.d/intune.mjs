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
  { type: 'managedDevice', path: '/deviceManagement/managedDevices', version: 'v1.0', criticality: 'tier3', blastRadius: 'cosmetic', pageCap: 5,
    note: 'Device records are re-enrolled, not restored. Counted for scale only.' },
  { type: 'mobileApp', path: '/deviceAppManagement/mobileApps', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting', pageCap: 20 },
  { type: 'managedAppPolicy', path: '/deviceAppManagement/managedAppPolicies', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'targetedManagedAppConfiguration', path: '/deviceAppManagement/targetedManagedAppConfigurations', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'mobileAppConfiguration', path: '/deviceAppManagement/mobileAppConfigurations', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
];
