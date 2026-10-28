/**
 * Wave 1 DISC: which application permission a refused read most likely needs.
 *
 * Graph sometimes names the permission in its 403 message; that wins. Otherwise the
 * longest matching path prefix below gives Microsoft's documented least-privileged
 * read permission. Either way the grant is a hint for an operator, never something
 * discovery requests or consents to.
 *
 * The prefix table names an area's usual permission, not every path's. When the app
 * already holds the grant (its token's `roles`), Graph refused for another reason: a
 * narrower permission, an admin role, a licence it did not name, or no app-only
 * support. That is reported as `held`, so no one is told to grant what is granted.
 */

// Longest prefix wins. Paths are matched case-insensitively.
export const READ_GRANTS = Object.freeze({
  '/admin/appsAndServices': 'OrgSettings-AppsAndServices.Read.All',
  '/admin/forms': 'OrgSettings-Forms.Read.All',
  '/admin/microsoft365Apps': 'OrgSettings-Microsoft365Install.Read.All',
  '/admin/people': 'PeopleSettings.Read.All',
  '/admin/reportSettings': 'ReportSettings.Read.All',
  '/admin/sharepoint': 'SharePointTenantSettings.Read.All',
  '/admin/todo': 'OrgSettings-Todo.Read.All',
  '/admin/serviceAnnouncement': 'ServiceHealth.Read.All',
  '/agreements': 'Agreement.Read.All',
  '/appCatalogs': 'AppCatalog.Read.All',
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
  '/deviceManagement/virtualEndpoint': 'CloudPC.Read.All',
  '/deviceManagement/windowsAutopilotDeploymentProfiles': 'DeviceManagementServiceConfig.Read.All',
  '/deviceManagement/windowsAutopilotDeviceIdentities': 'DeviceManagementServiceConfig.Read.All',
  '/devices': 'Device.Read.All',
  '/directory': 'Directory.Read.All',
  '/directory/customSecurityAttributeDefinitions': 'CustomSecAttributeDefinition.Read.All',
  '/directoryRoles': 'RoleManagement.Read.Directory',
  '/domains': 'Domain.Read.All',
  '/employeeExperience/communities': 'Community.Read.All',
  '/external': 'ExternalConnection.Read.All',
  '/groups': 'Group.Read.All',
  '/identity': 'Policy.Read.All',
  '/identity/b2xUserFlows': 'IdentityUserFlow.Read.All',
  '/identity/customAuthenticationExtensions': 'CustomAuthenticationExtension.Read.All',
  '/identity/identityProviders': 'IdentityProvider.Read.All',
  '/identityGovernance/accessReviews': 'AccessReview.Read.All',
  '/identityGovernance/entitlementManagement': 'EntitlementManagement.Read.All',
  '/identityGovernance/lifecycleWorkflows': 'LifecycleWorkflows.Read.All',
  '/identityGovernance/privilegedAccess': 'PrivilegedAccess.Read.AzureADGroup',
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
  '/security/rules/detectionRules': 'CustomDetection.Read.All',
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

/** True when `held` (the app's granted roles) covers `grant`; ReadWrite covers Read. */
export function holdsGrant(held, grant) {
  if (!held || !grant) return false;
  const want = grant.toLowerCase();
  const writeVariant = want.replace('.read.', '.readwrite.');
  for (const role of held) {
    const have = String(role).toLowerCase();
    if (have === want || have === writeVariant) return true;
  }
  return false;
}

/**
 * { grant, source: 'graph'|'documented', held } or null. `held` is the app's granted
 * roles, or null when they are not known (then `held` is always false).
 */
export function missingGrant(path, message, held = null) {
  for (const pattern of NAMED) {
    const match = typeof message === 'string' ? message.match(pattern) : null;
    const named = match?.[1].split(',').map((part) => part.trim()).filter(Boolean) ?? [];
    if (named.length) {
      const holding = named.find((grant) => holdsGrant(held, grant));
      return { grant: holding ?? named[0], source: 'graph', held: Boolean(holding) };
    }
  }
  const lower = String(path).toLowerCase();
  const prefix = PREFIXES.find((candidate) => {
    const key = candidate.toLowerCase();
    return lower === key || lower.startsWith(`${key}/`);
  });
  if (!prefix) return null;
  const grant = READ_GRANTS[prefix];
  return { grant, source: 'documented', held: holdsGrant(held, grant) };
}

/** The application roles in an access token's `roles` claim, or null when it has none. */
export function tokenRoles(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return Array.isArray(payload?.roles) ? payload.roles.filter((role) => typeof role === 'string') : null;
  } catch {
    return null;
  }
}
