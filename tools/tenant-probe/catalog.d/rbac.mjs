/** Catalogue family: Directory roles and RBAC. See ../catalog.mjs for the entry shape. */
export default [
  { type: 'directoryRole', path: '/directoryRoles', version: 'v1.0', criticality: 'tier1', blastRadius: 'tenant-lockout' },
  { type: 'roleDefinition', path: '/roleManagement/directory/roleDefinitions', version: 'v1.0', criticality: 'tier1', blastRadius: 'tenant-lockout' },
  // A roleAssignment's roleDefinitionId may point at a CUSTOM roleDefinition
  // (above) OR at a BUILT-IN role template — a separate Microsoft-defined
  // catalog, identical GUIDs in every tenant. Confirmed 2026-09-03: dangling
  // roleDefinitionIds in the sandbox tenant resolved as directoryRoleTemplate.
  { type: 'directoryRoleTemplate', path: '/directoryRoleTemplates', version: 'v1.0', criticality: 'tier3', blastRadius: 'cosmetic',
    note: 'Global constant catalog, not tenant configuration. Rejects $top; follow nextLink verbatim.' },
  { type: 'roleAssignment', path: '/roleManagement/directory/roleAssignments', version: 'v1.0', criticality: 'tier1', blastRadius: 'tenant-lockout',
    pageCap: 20,
    note: 'Break-glass accounts live here. The invariant in spec §10.4 reads this set.' },
  { type: 'roleEligibilitySchedule', path: '/roleManagement/directory/roleEligibilitySchedules', version: 'v1.0', criticality: 'tier1', blastRadius: 'tenant-lockout',
    note: 'PIM schedules. Measured HTTP 200 with the reader’s Accept-Language header.' },
  // Roadmap task-151: active time-bound assignments (PIM activations and
  // assignments with an end date). Permanent ones also appear as roleAssignment.
  { type: 'roleAssignmentSchedule', path: '/roleManagement/directory/roleAssignmentSchedules', version: 'v1.0', criticality: 'tier1', blastRadius: 'tenant-lockout' },
  // Roadmap task-151: PIM role settings. Entra keeps one policy per directory
  // role; the policy does not name its role, so the policy assignments that
  // bind each policy to a roleDefinitionId are collected beside it. Both
  // collections require the scope filter; the rules are read inline.
  { type: 'unifiedRoleManagementPolicy', path: '/policies/roleManagementPolicies', version: 'v1.0', criticality: 'tier1', blastRadius: 'tenant-lockout',
    query: "$filter=scopeId eq '/' and scopeType eq 'DirectoryRole'&$expand=rules" },
  { type: 'unifiedRoleManagementPolicyAssignment', path: '/policies/roleManagementPolicyAssignments', version: 'v1.0', criticality: 'tier1', blastRadius: 'access-affecting',
    query: "$filter=scopeId eq '/' and scopeType eq 'DirectoryRole'" },
];
