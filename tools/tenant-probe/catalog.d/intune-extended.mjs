/** Catalogue family: Intune, extended (wave 1: CAT-INTUNE). See ../catalog.mjs for the entry shape. */
// Every entry is a read-only read. Endpoints follow Graph's documented
// Intune routes and are unmeasured until the operator's first collect run on
// the test tenant; most are beta-only, a fidelity risk the spec flags.
// Policy assignments sit on a separate /assignments route; they are read per
// policy as relationship reads (ASSIGNMENT_ROUTES in engine/collect/relationships.mjs).
export default [
  // Scripts. Graph leaves the script body out of list reads and returns it
  // only on a GET of the single script, so each script is listed, then read
  // on its own (restore gaps batch 4). Tagging with `id` keeps the payload as
  // Graph returns it: the tag is the script's own id.
  ...[
    ['deviceManagementScript', 'deviceManagementScripts', 'Windows PowerShell scripts.'],
    ['deviceShellScript', 'deviceShellScripts', 'macOS shell scripts.'],
    ['deviceHealthScript', 'deviceHealthScripts', 'Remediations. Microsoft-published scripts are listed beside tenant ones.'],
    ['deviceComplianceScript', 'deviceComplianceScripts', 'Custom compliance discovery scripts.'],
  ].map(([type, collection, note]) => ({
    type, path: `/deviceManagement/${collection}/{parent}`, version: 'beta', criticality: 'tier2', blastRadius: 'access-affecting',
    parent: { path: `/deviceManagement/${collection}`, select: 'id', key: 'id', as: 'id' },
    // A script deleted between the list and its own read is gone, not a failed read.
    absentWhenNotFound: true,
    note: `${note} The script body is read per script.`,
  })),
  // Targeting. Filters and scope tags are referenced by id from assignments
  // and role assignments, so they restore before the objects that use them.
  { type: 'assignmentFilter', path: '/deviceManagement/assignmentFilters', version: 'beta', criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'A changed filter rule silently widens or narrows every assignment that uses it.' },
  { type: 'roleScopeTag', path: '/deviceManagement/roleScopeTags', version: 'beta', criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'The built-in Default tag (id 0) exists in every tenant.' },
  // Windows updates. Update rings are deviceConfiguration objects
  // (windowsUpdateForBusinessConfiguration) and are already collected there.
  { type: 'windowsFeatureUpdateProfile', path: '/deviceManagement/windowsFeatureUpdateProfiles', version: 'beta', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'windowsQualityUpdateProfile', path: '/deviceManagement/windowsQualityUpdateProfiles', version: 'beta', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'windowsDriverUpdateProfile', path: '/deviceManagement/windowsDriverUpdateProfiles', version: 'beta', criticality: 'tier3', blastRadius: 'cosmetic' },
  // Administrative templates (ADMX). A policy's configured settings are a
  // separate collection, listed only when expanded; the values entered for
  // each setting (its presentation values) sit one level further down and are
  // read per setting (restore gaps batch 5), so a restore can put them back.
  { type: 'groupPolicyConfiguration', path: '/deviceManagement/groupPolicyConfigurations', version: 'beta', criticality: 'tier2', blastRadius: 'access-affecting',
    query: '$expand=definitionValues($expand=definition)',
    childReads: {
      field: 'definitionValues', as: 'presentationValues', query: '$expand=presentation',
      path: '/deviceManagement/groupPolicyConfigurations/{item}/definitionValues/{child}/presentationValues',
    },
    note: 'The values of each setting are read per setting.' },
  { type: 'groupPolicyUploadedDefinitionFile', path: '/deviceManagement/groupPolicyUploadedDefinitionFiles', version: 'beta', criticality: 'tier3', blastRadius: 'cosmetic',
    note: 'Imported custom ADMX files. The file content is returned only per file.' },
  // Compliance notification emails. The message text per language is a
  // separate collection, listed only when expanded.
  { type: 'notificationMessageTemplate', path: '/deviceManagement/notificationMessageTemplates', version: 'v1.0', criticality: 'tier3', blastRadius: 'cosmetic',
    query: '$expand=localizedNotificationMessages' },
  // Autopilot registrations. Graph never returns the hardware hash, so a
  // deleted registration is re-imported from the device, not restored.
  { type: 'windowsAutopilotDeviceIdentity', path: '/deviceManagement/windowsAutopilotDeviceIdentities', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'Hardware hash is not readable; restore needs a re-import from the device.' },
  // Intune RBAC: who holds each Intune role, over which groups and scope tags.
  // Beta carries roleScopeTagIds, which v1.0 leaves out.
  { type: 'deviceManagementRoleAssignment', path: '/deviceManagement/roleAssignments', version: 'beta', criticality: 'tier1', blastRadius: 'access-affecting',
    note: 'Intune admin access. Pairs with deviceManagementRoleDefinition.' },
];
