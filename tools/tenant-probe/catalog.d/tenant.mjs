/** Catalogue family: Tenant settings. See ../catalog.mjs for the entry shape. */
export default [
  { type: 'organization', path: '/organization', version: 'v1.0', criticality: 'tier1', blastRadius: 'tenant-lockout' },
  { type: 'domain', path: '/domains', version: 'v1.0', criticality: 'tier1', blastRadius: 'tenant-lockout',
    note: 'Missing domains were a named cause of the CoreView UPN failures.' },
  { type: 'subscribedSku', path: '/subscribedSkus', version: 'v1.0', criticality: 'tier1', blastRadius: 'access-affecting',
    note: 'Licence availability is a hard precondition for user restore.' },
  // Measured v1.0 endpoint: the type is named directorySettingTemplate,
  // but its collection is groupSettingTemplates.
  { type: 'directorySettingTemplate', path: '/groupSettingTemplates', version: 'v1.0', criticality: 'tier3', blastRadius: 'cosmetic' },
  { type: 'groupSetting', path: '/groupSettings', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  // Issue #156: basic tenant settings that were never backed up.
  // Company branding (sign-in page text, colours, layout). Graph answers 404
  // when the tenant has no branding, which is a valid empty observation
  // (absentWhenNotFound). The default branding is read with Accept-Language 0;
  // any other language returns that language's localization instead.
  { type: 'organizationalBranding', path: '/organization/{org}/branding', version: 'v1.0', criticality: 'tier3', blastRadius: 'cosmetic',
    needsOrgId: true, singleton: true, absentWhenNotFound: true, acceptLanguage: '0' },
  { type: 'organizationalBrandingLocalization', path: '/organization/{org}/branding/localizations', version: 'v1.0', criticality: 'tier3', blastRadius: 'cosmetic',
    needsOrgId: true, absentWhenNotFound: true },
  // Group expiration. Zero or one policy per tenant; an empty list is valid.
  { type: 'groupLifecyclePolicy', path: '/groupLifecyclePolicies', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'A shorter lifetime can expire and delete Microsoft 365 groups.' },
];
