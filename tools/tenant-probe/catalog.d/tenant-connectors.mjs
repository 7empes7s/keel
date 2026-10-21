/** Catalogue family: tenant connectors, partners and extensions (remaining kinds, batch 1). See ../catalog.mjs for the entry shape. */
// Read-only list or singleton reads, each one a type tenant discovery found
// readable but not backed up. Each grant needed is one the Collector already
// holds (DeviceManagementServiceConfig.Read.All, DeviceManagementApps.Read.All,
// CustomAuthenticationExtension.Read.All).
// No writer is built for any of them yet: the backup is a record to rebuild from.
export default [
  // Intune: the Apple push certificate every iOS, iPadOS and macOS device
  // checks in through. The certificate itself is left out of the read; the
  // Apple ID, topic and expiry are what a rebuild needs. A tenant that never
  // set up a singleton may answer 404: an observed absence, not a failure.
  { type: 'applePushNotificationCertificate', path: '/deviceManagement/applePushNotificationCertificate', version: 'v1.0', singleton: true,
    absentWhenNotFound: true, criticality: 'tier2', blastRadius: 'access-affecting',
    select: 'id,appleIdentifier,topicIdentifier,lastModifiedDateTime,expirationDateTime,certificateSerialNumber,certificateUploadStatus,certificateUploadFailureReason',
    note: 'An expired or replaced certificate cuts off every Apple device. Renew it with the same Apple ID.' },
  // Intune: connections to partner services.
  { type: 'mobileThreatDefenseConnector', path: '/deviceManagement/mobileThreatDefenseConnectors', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'Compliance policies can require the partner\'s threat level, so a missing connector blocks devices.' },
  { type: 'deviceManagementPartner', path: '/deviceManagement/deviceManagementPartners', version: 'v1.0', criticality: 'tier3', blastRadius: 'cosmetic' },
  { type: 'complianceManagementPartner', path: '/deviceManagement/complianceManagementPartners', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'remoteAssistancePartner', path: '/deviceManagement/remoteAssistancePartners', version: 'v1.0', criticality: 'tier3', blastRadius: 'cosmetic' },
  { type: 'deviceManagementExchangeConnector', path: '/deviceManagement/exchangeConnectors', version: 'v1.0', criticality: 'tier3', blastRadius: 'cosmetic' },
  { type: 'onPremisesConditionalAccessSettings', path: '/deviceManagement/conditionalAccessSettings', version: 'v1.0', singleton: true,
    absentWhenNotFound: true, criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'Exchange on-premises access for managed devices.' },
  // Intune: app categories, referenced by apps in the Company Portal.
  { type: 'mobileAppCategory', path: '/deviceAppManagement/mobileAppCategories', version: 'v1.0', criticality: 'tier3', blastRadius: 'cosmetic',
    note: 'Microsoft\'s built-in categories are listed beside the tenant\'s own.' },
  // Intune: Company Portal branding per group. Beta only.
  { type: 'intuneBrandingProfile', path: '/deviceManagement/intuneBrandingProfiles', version: 'beta', criticality: 'tier3', blastRadius: 'cosmetic',
    note: 'Logo images are returned only per profile.' },
  // Entra ID: custom authentication extensions, the outbound calls token
  // issuance and access package workflows make.
  { type: 'customAuthenticationExtension', path: '/identity/customAuthenticationExtensions', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'A missing extension fails the sign-in or workflow that calls it.' },
];
