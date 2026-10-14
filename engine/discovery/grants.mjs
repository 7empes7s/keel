/**
 * Wave 1 DISC: which application permission a refused read most likely needs.
 *
 * Graph sometimes names the permission in its 403 message; that wins. Otherwise the
 * longest matching path prefix below gives Microsoft's documented least-privileged
 * read permission. Either way the grant is a hint for an operator, never something
 * discovery requests or consents to.
 */

// Longest prefix wins. Paths are matched case-insensitively.
export const READ_GRANTS = Object.freeze({
  '/admin/sharepoint': 'SharePointTenantSettings.Read.All',
  '/admin/serviceAnnouncement': 'ServiceHealth.Read.All',
  '/agreements': 'Agreement.Read.All',
  '/applications': 'Application.Read.All',
  '/auditLogs': 'AuditLog.Read.All',
  '/communications': 'CallRecords.Read.All',
  '/contacts': 'OrgContact.Read.All',
  '/deviceAppManagement': 'DeviceManagementApps.Read.All',
  '/deviceManagement': 'DeviceManagementConfiguration.Read.All',
  '/deviceManagement/deviceEnrollmentConfigurations': 'DeviceManagementServiceConfig.Read.All',
  '/deviceManagement/managedDevices': 'DeviceManagementManagedDevices.Read.All',
  '/deviceManagement/roleAssignments': 'DeviceManagementRBAC.Read.All',
  '/deviceManagement/roleDefinitions': 'DeviceManagementRBAC.Read.All',
  '/deviceManagement/roleScopeTags': 'DeviceManagementRBAC.Read.All',
  '/deviceManagement/windowsAutopilotDeploymentProfiles': 'DeviceManagementServiceConfig.Read.All',
  '/deviceManagement/windowsAutopilotDeviceIdentities': 'DeviceManagementServiceConfig.Read.All',
  '/devices': 'Device.Read.All',
  '/directory': 'Directory.Read.All',
  '/directory/customSecurityAttributeDefinitions': 'CustomSecAttributeDefinition.Read.All',
  '/directoryRoles': 'RoleManagement.Read.Directory',
  '/domains': 'Domain.Read.All',
  '/external': 'ExternalConnection.Read.All',
  '/groups': 'Group.Read.All',
  '/identity': 'Policy.Read.All',
  '/identity/b2xUserFlows': 'IdentityUserFlow.Read.All',
  '/identity/customAuthenticationExtensions': 'CustomAuthenticationExtension.Read.All',
  '/identity/identityProviders': 'IdentityProvider.Read.All',
  '/identityGovernance/accessReviews': 'AccessReview.Read.All',
  '/identityGovernance/entitlementManagement': 'EntitlementManagement.Read.All',
  '/identityGovernance/lifecycleWorkflows': 'LifecycleWorkflows.Read.All',
  '/identityGovernance/termsOfUse': 'Agreement.Read.All',
  '/identityProtection': 'IdentityRiskEvent.Read.All',
  '/informationProtection': 'InformationProtectionPolicy.Read.All',
  '/oauth2PermissionGrants': 'DelegatedPermissionGrant.Read.All',
  '/organization': 'Organization.Read.All',
  '/places': 'Place.Read.All',
  '/policies': 'Policy.Read.All',
  '/print': 'Printer.Read.All',
  '/privacy': 'SubjectRightsRequest.Read.All',
  '/reports': 'Reports.Read.All',
  '/roleManagement': 'RoleManagement.Read.All',
  '/roleManagement/directory': 'RoleManagement.Read.Directory',
  '/security': 'SecurityEvents.Read.All',
  '/servicePrincipals': 'Application.Read.All',
  '/sites': 'Sites.Read.All',
  '/solutions/bookingBusinesses': 'Bookings.Read.All',
  '/subscribedSkus': 'Organization.Read.All',
  '/teams': 'TeamSettings.Read.All',
  '/teamwork': 'TeamworkTag.Read.All',
  '/users': 'User.Read.All',
});

const PREFIXES = Object.keys(READ_GRANTS).sort((a, b) => b.length - a.length);

// "API requires one of 'Policy.Read.All, Policy.ReadWrite.All'" and
// "Required scopes = [Sites.Read.All, Sites.ReadWrite.All]" are the two shapes Graph uses.
const NAMED = [/requires one of '([^']+)'/i, /required scopes\s*=\s*\[([^\]]+)\]/i];

/** { grant, source: 'graph'|'documented' } or null. */
export function missingGrant(path, message) {
  for (const pattern of NAMED) {
    const match = typeof message === 'string' ? message.match(pattern) : null;
    const first = match?.[1].split(',').map((part) => part.trim()).find(Boolean);
    if (first) return { grant: first, source: 'graph' };
  }
  const lower = String(path).toLowerCase();
  const prefix = PREFIXES.find((candidate) => {
    const key = candidate.toLowerCase();
    return lower === key || lower.startsWith(`${key}/`);
  });
  return prefix ? { grant: READ_GRANTS[prefix], source: 'documented' } : null;
}
