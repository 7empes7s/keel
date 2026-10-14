/** Catalogue family: Users, groups, applications and service principals. See ../catalog.mjs for the entry shape. */
export default [
  // Operator decision (2026-09-08): users stay on the DAILY backup tier, so
  // this entry carries tier2 even though the spec's default for users is
  // tier1. Do not "fix" this upward — tier1 collection is hourly and would
  // multiply user collection 24x against that explicit decision.
  { type: 'user', path: '/users', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting',
    select: 'id,userPrincipalName,displayName,accountEnabled,onPremisesSyncEnabled,onPremisesImmutableId,userType,usageLocation,assignedLicenses,employeeId,createdDateTime,'
      // Roadmap task-150: the reviewed restorable attributes and how each licence is assigned.
      + 'givenName,surname,jobTitle,department,companyName,officeLocation,employeeType,city,state,country,streetAddress,postalCode,'
      + 'mobilePhone,businessPhones,preferredLanguage,licenseAssignmentStates',
    pageCap: 20,
    note: 'onPremisesSyncEnabled drives the AD-sync guard — synced users must not be cloud-restored.' },
  { type: 'group', path: '/groups', version: 'v1.0', criticality: 'tier1', blastRadius: 'access-affecting',
    select: 'id,displayName,description,mailNickname,groupTypes,securityEnabled,mailEnabled,membershipRule,membershipRuleProcessingState,onPremisesSyncEnabled,isAssignableToRole,visibility,createdDateTime,assignedLicenses',
    pageCap: 20 },
  { type: 'administrativeUnit', path: '/directory/administrativeUnits', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'contact', path: '/contacts', version: 'v1.0', criticality: 'tier3', blastRadius: 'cosmetic', pageCap: 5 },
];
