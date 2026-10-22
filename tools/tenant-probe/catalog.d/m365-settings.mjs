/** Catalogue family: Microsoft 365 tenant settings (remaining kinds, batch 7). See ../catalog.mjs for the entry shape. */
// Read-only list or singleton reads. Each path is in the operator's export of
// what tenant discovery found readable but not backed up (Q104, run 3 of
// 2026-10-21), so the grant each needs is one the Collector already holds.
// All are v1.0 reads.
// No writer is built for any of them yet: the backup is a record to rebuild from.
// None of these objects holds a secret.
// Sensitivity labels read through Graph are the same labels the Purview label
// workload backs up with Get-Label, so they are not read again here
// (engine/discovery/catalogue.mjs WORKLOAD_GRAPH_PATHS).
export default [
  // The whole SharePoint and OneDrive tenant settings object: site creation,
  // sync app limits, idle session sign-out, Loop, legacy authentication and the
  // default storage limits. The SharePoint workload reads only its five sharing
  // fields (and restores those); this keeps the rest.
  { type: 'sharepointSettings', path: '/admin/sharepoint/settings', version: 'v1.0', singleton: true, absentWhenNotFound: true,
    criticality: 'tier1', blastRadius: 'access-affecting',
    note: 'isLegacyAuthProtocolsEnabled and isUnmanagedSyncAppForTenantRestricted change who can reach files.' },
  // Item insights: whether people cards and search show documents a person
  // worked on, for the tenant and one group it is turned off for.
  { type: 'itemInsightsSettings', path: '/admin/people/itemInsights', version: 'v1.0', singleton: true, absentWhenNotFound: true,
    criticality: 'tier3', blastRadius: 'access-affecting',
    note: 'disabledForGroup names a group by id, so the group is rebuilt first.' },
  // Copilot (Microsoft Search) connectors to outside data. The connection's
  // schema and its items are read per connection and are not backed up.
  { type: 'externalConnection', path: '/external/connections', version: 'v1.0',
    criticality: 'tier3', blastRadius: 'access-affecting',
    note: 'configuration.authorizedAppIds lists the apps allowed to push items into the connection.' },
  // Attack simulation training: automations that launch simulations on a
  // schedule, and the simulations themselves.
  { type: 'simulationAutomation', path: '/security/attackSimulation/simulationAutomations', version: 'v1.0',
    criticality: 'tier3', blastRadius: 'cosmetic' },
  // The report on each simulation (who clicked) is results, not settings, so
  // it is left out of the read.
  { type: 'attackSimulation', path: '/security/attackSimulation/simulations', version: 'v1.0',
    criticality: 'tier3', blastRadius: 'cosmetic',
    select: 'id,attackTechnique,attackType,automationId,completionDateTime,createdBy,createdDateTime,description,displayName,durationInDays,endUserNotificationSetting,excludedAccountTarget,includedAccountTarget,isAutomated,lastModifiedBy,lastModifiedDateTime,launchDateTime,oAuthConsentAppDetail,payloadDeliveryPlatform,status,trainingSetting',
    note: 'A simulation names its payload, landing page and login page by id.' },
];
