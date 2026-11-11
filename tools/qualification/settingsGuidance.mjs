/**
 * Reviewed live-gate guidance (live-gate-plan.mjs FIXTURE_GUIDANCE) for the
 * Microsoft 365 admin center settings (restore gaps batch 20) and issue #1074's
 * Defender, Intune connector and Microsoft 365 settings, kept here so the plan
 * stays within its size budget. The plan spreads each where its entries stood,
 * so the run order is unchanged.
 */
export const ADMIN_CENTER_GUIDANCE = Object.freeze({
  // Restore gaps, batch 20: Microsoft 365 admin center org settings, each
  // drifted by one harmless value and set back right after the run.
  formsSettings: {
    kind: 'tenant-setting', fixture: 'the Microsoft Forms org settings',
    select: 'formsSettings', drift: 'switch settings.isBingImageSearchEnabled to the other value; write the original down first; never change an external sharing field or the phishing scan',
    note: 'Set the original value back right after the run.',
  },
  microsoft365AppsInstallationOptions: {
    kind: 'tenant-setting', fixture: 'the Microsoft 365 Apps installation options',
    select: 'microsoft365AppsInstallationOptions', drift: 'switch appsForWindows.isVisioEnabled to the other value; write the original down first',
    note: 'Only what people may install themselves from the portal changes, for a few minutes; installed apps are not touched. Set the original value back right after the run.',
  },
  appsAndServicesSettings: {
    kind: 'tenant-setting', fixture: 'the user owned apps and services settings',
    select: 'appsAndServicesSettings', drift: 'switch settings.isAppAndServicesTrialEnabled to the other value; write the original down first; never turn the Office Store on',
    note: 'Set the original value back right after the run.',
  },
  adminReportSettings: {
    kind: 'tenant-setting', fixture: 'the usage report privacy setting',
    select: 'adminReportSettings', drift: 'if displayConcealedNames is false, set it to true (the restore puts back false only if it is not withheld, so expect a manual step instead); if it is true, set it to false and let the restore hide names again',
    note: 'Set the original value back right after the run.',
  },
  pronounsSettings: {
    kind: 'tenant-setting', fixture: 'the pronouns org setting',
    select: 'pronounsSettings', drift: 'switch isEnabledInOrganization to the other value; write the original down first',
    note: 'Set the original value back right after the run.',
  },
});

/** `prefix` is the plan's FIXTURE_PREFIX. */
export const serviceSettingGuidance = (prefix) => ({
  // Issue #1074: Defender, Intune connector and Microsoft 365 settings. A rule
  // has no response actions and is never turned on; the partner kinds need a
  // connected partner, which the test tenant may not have.
  defenderDetectionRule: {
    kind: 'named-object', fixture: `custom detection rule ${prefix}-rule (query DeviceProcessEvents | where FileName == "keel-rt.exe", daily, low severity alert, no response actions), turned off`,
    select: `${prefix}-rule`, drift: 'delete it: the restore recreates it turned off; then change its alert title: the restore puts it back',
    note: 'Never add a response action and never turn it on. Delete the rule after the run.',
  },
  defenderIdentitySensor: {
    kind: 'tenant-setting', fixture: 'an installed Defender for Identity sensor on a test server',
    select: 'defenderIdentitySensor', drift: 'change its description; write the original down first; never turn on delayed updates or remove a domain controller',
    note: 'If the tenant has no sensor, record that and skip this kind. Set the original description back right after the run.',
  },
  securityZone: {
    kind: 'named-object', fixture: `exposure management zone ${prefix}-zone (description Fixture) with no environments`,
    select: `${prefix}-zone`, drift: 'delete it: the restore recreates it; then change its description: the restore puts it back',
    note: 'Never add an environment. Delete the zone after the run.',
  },
  itemInsightsSettings: {
    kind: 'tenant-setting', fixture: 'the item insights org setting',
    select: 'itemInsightsSettings', drift: 'if isEnabledInOrganization is true, set it to false and let the restore turn it on (expect it to wait for the approval); never change the group it is turned off for',
    note: 'Set the original value back right after the run.',
  },
  todoSettings: {
    kind: 'tenant-setting', fixture: 'the Microsoft To Do org settings',
    select: 'todoSettings', drift: 'switch isPushNotificationEnabled to the other value; write the original down first; never turn external sharing or joining on',
    note: 'The read of this setting answered 500 on 2026-10-28: first check a new backup holds it. Set the original value back right after the run.',
  },
  externalConnection: {
    kind: 'named-object', fixture: 'Copilot connector connection keelrtconnection (name KEEL-RT-connector, description Fixture) with no schema, no items and no allowed apps',
    select: 'keelrtconnection', drift: 'delete it: the restore recreates it under the same id; then change its description: the restore puts it back',
    note: 'Never allow an app to push items. Delete the connection after the run.',
  },
  mobileThreatDefenseConnector: {
    kind: 'tenant-setting', fixture: 'a connected mobile threat defense connector',
    select: 'mobileThreatDefenseConnector', drift: 'change how many days the partner may stay silent; write the original down first; expect the restore to wait for the approval',
    note: 'If the tenant has no connected partner, record that and skip this kind. Never turn a platform or a block on. Set the original value back right after the run.',
  },
  deviceManagementPartner: {
    kind: 'tenant-setting', fixture: 'a connected device management partner',
    select: 'deviceManagementPartner', drift: 'add the empty KEEL-RT-148-group to the groups that enroll through the partner; expect the restore to wait for the approval',
    note: 'If the tenant has no connected partner, record that and skip this kind. Remove the group again right after the run.',
  },
  complianceManagementPartner: {
    kind: 'tenant-setting', fixture: 'a connected compliance partner',
    select: 'complianceManagementPartner', drift: 'add the empty KEEL-RT-148-group to one platform\'s groups; expect the restore to wait for the approval',
    note: 'If the tenant has no connected partner, record that and skip this kind. Remove the group again right after the run.',
  },
  deviceManagementDerivedCredentialSettings: {
    kind: 'tenant-setting', fixture: 'the derived credential issuer settings',
    select: 'deviceManagementDerivedCredentialSettings', drift: 'change the renewal threshold by a few points; write the original down first; never change the issuer or the help page',
    note: 'If the tenant has no derived credential issuer, record that and skip this kind. Set the original value back right after the run.',
  },
});
