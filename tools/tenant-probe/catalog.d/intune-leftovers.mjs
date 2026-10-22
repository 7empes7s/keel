/** Catalogue family: remaining Intune settings (remaining kinds, batch 6). See ../catalog.mjs for the entry shape. */
// Read-only list or singleton reads. Each path is in the operator's export of
// what tenant discovery found readable but not backed up (Q104, run 3 of
// 2026-10-21), so the grant each needs is one the Collector already holds.
// All are beta only, a fidelity risk the spec flags.
// No writer is built for any of them yet: the backup is a record to rebuild from.
// Secrets are left out with $select: enrollment tokens, QR codes, the Wi-Fi
// password of an Android enrollment profile, and the Symantec certificate file
// with its password.
// Checked for secrets in batch 8 (last-leftovers.mjs): hardware (BIOS)
// configurations are read there without the settings file; uploaded group
// policy object files, eSIM activation code pools and Windows 10X resource
// access profiles are skipped with a reason (engine/discovery/notGaps.mjs).
export default [
  // Tenant-wide Intune settings: the compliance check-in window, how devices
  // with no compliance policy are marked, Company Portal contact details and
  // the device cleanup window. Runtime counters on the same object are left out.
  { type: 'deviceManagementSettings', path: '/deviceManagement', version: 'beta', singleton: true, absentWhenNotFound: true,
    criticality: 'tier1', blastRadius: 'access-affecting',
    // Issue #447: Graph sends a $select naming fields owned by other Intune
    // services (Windows data onboarding, admin consent, Endpoint analytics) to
    // the wrong backend, which answers HTTP 400. Only the core Intune fields
    // are read here.
    select: 'id,settings,intuneBrand,managedDeviceCleanupSettings',
    note: 'settings.secureByDefault marks devices with no compliance policy as not compliant, which Conditional Access reads.' },
  // Android Enterprise fully managed and dedicated device enrollment profiles.
  { type: 'androidDeviceOwnerEnrollmentProfile', path: '/deviceManagement/androidDeviceOwnerEnrollmentProfiles', version: 'beta',
    criticality: 'tier2', blastRadius: 'access-affecting',
    select: 'id,accountId,configureWifi,createdDateTime,description,deviceNameTemplate,displayName,enrollmentMode,enrollmentTokenType,isTeamsDeviceProfile,lastModifiedDateTime,roleScopeTagIds,tokenCreationDateTime,tokenExpirationDateTime,wifiHidden,wifiSecurityType,wifiSsid',
    note: 'A recreated profile gets a new token and QR code; the Wi-Fi password is typed again.' },
  // Legacy Android work profile enrollment profiles.
  { type: 'androidForWorkEnrollmentProfile', path: '/deviceManagement/androidForWorkEnrollmentProfiles', version: 'beta',
    criticality: 'tier3', blastRadius: 'access-affecting',
    select: 'id,accountId,createdDateTime,description,displayName,lastModifiedDateTime,tokenExpirationDateTime',
    note: 'A recreated profile gets a new token and QR code.' },
  // Apple enrollment profiles for devices users enroll themselves.
  { type: 'appleUserInitiatedEnrollmentProfile', path: '/deviceManagement/appleUserInitiatedEnrollmentProfiles', version: 'beta',
    criticality: 'tier2', blastRadius: 'access-affecting' },
  // Legacy Android work profile binding, one object per tenant.
  { type: 'androidForWorkSettings', path: '/deviceManagement/androidForWorkSettings', version: 'beta', singleton: true, absentWhenNotFound: true,
    criticality: 'tier3', blastRadius: 'access-affecting',
    note: 'The binding is made by signing in to Google; the backup keeps the account and target groups.' },
  // Derived credential issuer settings (smart card credentials on phones).
  { type: 'deviceManagementDerivedCredentialSettings', path: '/deviceManagement/derivedCredentials', version: 'beta',
    criticality: 'tier2', blastRadius: 'access-affecting' },
  // Microsoft Tunnel VPN server configurations and health thresholds.
  { type: 'microsoftTunnelConfiguration', path: '/deviceManagement/microsoftTunnelConfigurations', version: 'beta',
    criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'Sites and servers point to a configuration by id, so it is rebuilt first.' },
  { type: 'microsoftTunnelHealthThreshold', path: '/deviceManagement/microsoftTunnelHealthThresholds', version: 'beta',
    criticality: 'tier3', blastRadius: 'cosmetic' },
  // iOS line-of-business app provisioning profiles (the Apple .mobileprovision file).
  // Restore gaps batch 12: listed, then each profile read on its own, so the
  // backup holds the file whether or not the list returns it (like ADMX files).
  { type: 'iosLobAppProvisioningConfiguration', path: '/deviceAppManagement/iosLobAppProvisioningConfigurations/{parent}', version: 'beta',
    criticality: 'tier2', blastRadius: 'access-affecting',
    parent: { path: '/deviceAppManagement/iosLobAppProvisioningConfigurations', select: 'id', key: 'id', as: 'id' },
    absentWhenNotFound: true,
    note: 'An expired profile stops the apps it signs from opening. The payload is the profile file Apple issued, with no private key. Read per profile.' },
  // App dependencies and supersedence between Intune apps.
  { type: 'mobileAppRelationship', path: '/deviceAppManagement/mobileAppRelationships', version: 'beta',
    criticality: 'tier3', blastRadius: 'cosmetic',
    note: 'Both ends are apps by id, so the apps are rebuilt first.' },
  // Managed eBooks and their categories.
  { type: 'managedEBook', path: '/deviceAppManagement/managedEBooks', version: 'beta', criticality: 'tier3', blastRadius: 'cosmetic' },
  { type: 'managedEBookCategory', path: '/deviceAppManagement/managedEBookCategories', version: 'beta', criticality: 'tier3', blastRadius: 'cosmetic' },
  // Shared iPad cart to classroom associations (Intune for Education).
  { type: 'cartToClassAssociation', path: '/deviceManagement/cartToClassAssociations', version: 'beta', criticality: 'tier3', blastRadius: 'cosmetic' },
  // App protection policies for Windows (Edge on unmanaged Windows devices).
  // Not in managedAppPolicies on v1.0, so read on their own path. The apps a
  // policy covers are returned only when one policy is read with them
  // expanded, so each is listed, then read on its own (restore gaps batch 12).
  { type: 'windowsManagedAppProtection', path: '/deviceAppManagement/windowsManagedAppProtections/{parent}', version: 'beta',
    criticality: 'tier2', blastRadius: 'access-affecting',
    parent: { path: '/deviceAppManagement/windowsManagedAppProtections', select: 'id', key: 'id', as: 'id' },
    query: '$expand=apps',
    absentWhenNotFound: true,
    note: 'The apps each policy covers are read per policy. Who it is assigned to is not backed up yet.' },
  // Windows enterprise code signing certificates for line-of-business apps.
  // The certificate is the public part only.
  { type: 'enterpriseCodeSigningCertificate', path: '/deviceAppManagement/enterpriseCodeSigningCertificates', version: 'beta',
    criticality: 'tier3', blastRadius: 'access-affecting' },
  // The Symantec code signing certificate, one per tenant. The certificate file
  // and its password are left out of the read.
  { type: 'symantecCodeSigningCertificate', path: '/deviceAppManagement/symantecCodeSigningCertificate', version: 'beta', singleton: true, absentWhenNotFound: true,
    criticality: 'tier3', blastRadius: 'access-affecting',
    select: 'id,expirationDateTime,issuer,issuerName,status,subject,subjectName,uploadDateTime',
    note: 'The certificate file and its password are uploaded again from your own copy.' },
  // Endpoint analytics baselines that device scores are compared to.
  { type: 'userExperienceAnalyticsBaseline', path: '/deviceManagement/userExperienceAnalyticsBaselines', version: 'beta',
    criticality: 'tier3', blastRadius: 'cosmetic' },
];
