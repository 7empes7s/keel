/** Catalogue family: Conditional Access. See ../catalog.mjs for the entry shape. */
export default [
  { type: 'conditionalAccessPolicy', path: '/identity/conditionalAccess/policies', version: 'v1.0', criticality: 'tier1', blastRadius: 'tenant-lockout',
    note: 'Always restored report-only (spec §10.2).' },
  // Custom authentication strengths are tenant-created objects with
  // tenant-random ids. Collected so grantControls.authenticationStrength.id
  // resolves by natural key instead of reading as unresolvable; the three
  // built-in strengths are Microsoft-global ids (WELL_KNOWN in references.mjs).
  { type: 'authenticationStrengthPolicy', path: '/policies/authenticationStrengthPolicies', version: 'v1.0', criticality: 'tier1', blastRadius: 'tenant-lockout' },
  { type: 'namedLocation', path: '/identity/conditionalAccess/namedLocations', version: 'v1.0', criticality: 'tier1', blastRadius: 'tenant-lockout' },
  { type: 'authenticationContextClassReference', path: '/identity/conditionalAccess/authenticationContextClassReferences', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
];
