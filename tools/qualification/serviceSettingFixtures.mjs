/**
 * Issue #1074: the fixture harness's payloads (operations.mjs FIXTURE_PAYLOADS)
 * for the Defender, Intune connector and Microsoft 365 settings writers
 * (engine/restore/serviceSettingsOperations.mjs), in the shapes Graph documents,
 * and the drift each update fixture starts from. A rule is backed up turned off;
 * a partner is connected.
 */
export const SERVICE_SETTING_PAYLOADS = Object.freeze({
  defenderDetectionRule: {
    id: 'fixture-rule', displayName: 'Fixture detection rule', status: 'disabled', createdBy: 'fixture@fixture.example',
    queryCondition: { queryText: 'DeviceProcessEvents | where FileName == "fixture.exe"', lastModifiedDateTime: '2026-11-01T10:00:00Z' },
    schedule: { period: '24H', nextRunDateTime: '2026-11-02T10:00:00Z' },
    detectionAction: {
      alertTemplate: { title: 'Fixture alert', description: 'Fixture', severity: 'low', category: 'Execution', recommendedActions: null, mitreTechniques: [], impactedAssets: [] },
      organizationalScope: null, responseActions: [],
    },
  },
  defenderIdentitySensor: {
    id: 'fixture-sensor', displayName: 'FIXTURE-DC01', domainName: 'fixture.example', sensorType: 'domainControllerIntegrated', version: '2.239.18124.58593',
    deploymentStatus: 'upToDate', healthStatus: 'healthy', serviceStatus: 'running', openHealthIssuesCount: 0,
    settings: { '@odata.type': 'microsoft.graph.security.sensorSettings', description: 'Fixture', domainControllerDnsNames: ['FIXTURE-DC01.fixture.example'], isDelayedDeploymentEnabled: false },
  },
  securityZone: { id: 'fixture-zone', displayName: 'Fixture zone', description: 'Fixture', created: { by: 'fixture', dateTime: '2026-11-01T10:00:00Z' }, modified: { by: 'fixture', dateTime: '2026-11-01T10:00:00Z' } },
  itemInsightsSettings: { isEnabledInOrganization: true, disabledForGroup: null },
  todoSettings: { isExternalJoinEnabled: false, isExternalShareEnabled: false, isPushNotificationEnabled: true },
  externalConnection: {
    id: 'fixtureconnection', name: 'Fixture connector', description: 'Fixture', state: 'ready',
    configuration: { authorizedAppIds: [] }, activitySettings: { urlToItemResolvers: [] }, searchSettings: { searchResultTemplates: [] },
  },
  mobileThreatDefenseConnector: {
    id: 'fixture-mtd', partnerState: 'enabled', lastHeartbeatDateTime: '2026-11-01T10:00:00Z',
    androidEnabled: true, iosEnabled: true, windowsEnabled: false, androidMobileApplicationManagementEnabled: false, iosMobileApplicationManagementEnabled: false,
    androidDeviceBlockedOnMissingPartnerData: false, iosDeviceBlockedOnMissingPartnerData: false, windowsDeviceBlockedOnMissingPartnerData: false,
    partnerUnsupportedOsVersionBlocked: false, partnerUnresponsivenessThresholdInDays: 7,
    allowPartnerToCollectIOSApplicationMetadata: false, allowPartnerToCollectIOSPersonalApplicationMetadata: false, microsoftDefenderForEndpointAttachEnabled: false,
  },
  deviceManagementPartner: {
    id: 'fixture-dmp', displayName: 'Fixture partner', partnerAppType: 'multiTenantApp', partnerState: 'enabled', isConfigured: true, lastHeartbeatDateTime: '2026-11-01T10:00:00Z',
    groupsRequiringPartnerEnrollment: [],
  },
  complianceManagementPartner: {
    id: 'fixture-cmp', displayName: 'Fixture compliance partner', partnerState: 'enabled', lastHeartbeatDateTime: '2026-11-01T10:00:00Z',
    macOsOnboarded: true, androidOnboarded: false, iosOnboarded: false,
    macOsEnrollmentAssignments: [], androidEnrollmentAssignments: [], iosEnrollmentAssignments: [],
  },
  deviceManagementDerivedCredentialSettings: {
    id: 'fixture-derived', displayName: 'Fixture issuer', issuer: 'purebred', helpUrl: 'https://fixture.example/help', notificationType: 'companyPortal', renewalThresholdPercentage: 20,
  },
});

// Each drifts one setting its restore puts back.
export const SERVICE_SETTING_DRIFT = Object.freeze({
  defenderIdentitySensor: (payload) => ({ settings: { ...payload.settings, description: 'Drifted' } }),
  securityZone: () => ({ description: 'Drifted' }),
  itemInsightsSettings: () => ({ isEnabledInOrganization: false }),
  todoSettings: () => ({ isPushNotificationEnabled: false }),
  externalConnection: () => ({ description: 'Drifted' }),
  mobileThreatDefenseConnector: () => ({ partnerUnresponsivenessThresholdInDays: 14 }),
  deviceManagementPartner: () => ({ groupsRequiringPartnerEnrollment: [{ target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: 'fixture-group' } }] }),
  complianceManagementPartner: () => ({ macOsEnrollmentAssignments: [{ target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: 'fixture-group' } }] }),
  deviceManagementDerivedCredentialSettings: () => ({ renewalThresholdPercentage: 30 }),
});
