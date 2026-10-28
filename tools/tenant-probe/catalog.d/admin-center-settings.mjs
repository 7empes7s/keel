/** Catalogue family: settings that only lacked a read permission (remaining kinds, batch 9). See ../catalog.mjs for the entry shape. */
// The delegated probe (operator queue Q151, 2026-10-22) found each of these
// refused with 403 only because the Collector does not hold the read
// permission Graph names (engine/discovery/grants.mjs READ_GRANTS has each
// one). Until the permission is granted the read is refused and the backup
// says which permission is missing; nothing else changes.
// Read-only list or singleton reads. No writer is built for any of them yet:
// the backup is a record to rebuild from.
// None of these objects holds a secret.
// `holdsNoReferences`: the object is only on/off switches and choices, never the
// id of another tenant object, so an unread copy cannot hide a reference to
// something a restore deletes (cli/keel-restore.mjs incompleteReadDeleteRefusals).
// The SharePoint term store is not read here: PnP exports whole term groups,
// terms included, with the grants the Collector already holds (the SharePoint
// structure backup), where Graph would need one read per term level.
export default [
  // Microsoft 365 admin center, Org settings. One object per tenant each.
  // Microsoft Forms: external sharing, phishing scans, names recorded.
  { type: 'formsSettings', path: '/admin/forms', version: 'beta', singleton: true, absentWhenNotFound: true, holdsNoReferences: true,
    criticality: 'tier3', blastRadius: 'access-affecting',
    note: 'Turning external sharing on lets people send forms and their answers outside the organisation.' },
  // Microsoft To Do: external joining and sharing of lists, push notifications.
  { type: 'todoSettings', path: '/admin/todo', version: 'beta', singleton: true, absentWhenNotFound: true, holdsNoReferences: true,
    criticality: 'tier3', blastRadius: 'access-affecting',
    note: 'isExternalJoinEnabled and isExternalShareEnabled decide whether lists reach people outside the organisation.' },
  // Which Microsoft 365 Apps people can install themselves, and the update channel.
  { type: 'microsoft365AppsInstallationOptions', path: '/admin/microsoft365Apps/installationOptions', version: 'v1.0', singleton: true, absentWhenNotFound: true, holdsNoReferences: true,
    criticality: 'tier3', blastRadius: 'cosmetic' },
  // Office Store access and whether people can start app trials.
  { type: 'appsAndServicesSettings', path: '/admin/appsAndServices', version: 'beta', singleton: true, absentWhenNotFound: true, holdsNoReferences: true,
    criticality: 'tier3', blastRadius: 'access-affecting',
    note: 'isOfficeStoreEnabled lets people add store add-ins to their apps.' },
  // Whether usage reports show real user, group and site names.
  { type: 'adminReportSettings', path: '/admin/reportSettings', version: 'v1.0', singleton: true, absentWhenNotFound: true, holdsNoReferences: true,
    criticality: 'tier3', blastRadius: 'cosmetic' },
  // Extra directory fields shown on profile cards in Teams, Outlook and Delve.
  { type: 'profileCardProperty', path: '/admin/people/profileCardProperties', version: 'v1.0',
    criticality: 'tier3', blastRadius: 'cosmetic' },
  // Whether people can set their pronouns on their profile.
  { type: 'pronounsSettings', path: '/admin/people/pronouns', version: 'v1.0', singleton: true, absentWhenNotFound: true, holdsNoReferences: true,
    criticality: 'tier3', blastRadius: 'cosmetic' },
  // Microsoft Defender custom detection rules: the hunting query, its schedule
  // and the response actions it takes (isolate a device, disable a user).
  { type: 'defenderDetectionRule', path: '/security/rules/detectionRules', version: 'beta',
    criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'A rule can isolate devices or disable users on its own, so a rule rebuilt by hand starts turned off.' },
  // Teams apps the organisation uploaded to its own app catalogue. Graph gives
  // the app details and versions but not the app package, which is uploaded
  // again from your own copy.
  { type: 'teamsCatalogApp', path: '/appCatalogs/teamsApps', version: 'v1.0',
    query: "$filter=distributionMethod eq 'organization'&$expand=appDefinitions",
    criticality: 'tier3', blastRadius: 'access-affecting',
    note: 'The app package is not readable through Graph; the backup keeps its details, versions and publishing state.' },
  // Viva Engage communities: name, description, privacy and owners.
  { type: 'engageCommunity', path: '/employeeExperience/communities', version: 'v1.0',
    criticality: 'tier3', blastRadius: 'access-affecting',
    note: 'Each community has a Microsoft 365 group behind it (groupId), so the group is rebuilt first.' },
];
