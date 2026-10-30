/**
 * Roadmap task-66 boundary tests: guarding the irreversible effects of
 * configuration changes.
 *
 * Exercises engine/safety/contentEffects.mjs, the applyWave preservation-lock
 * handling and the full cli/keel-restore.mjs dry-run -> approval -> promotion
 * path against the isolated test database and an in-memory fake Graph. No
 * tenant is read or written. Required mutation checks:
 *
 * - Classify hold release as cosmetic.
 * - Reuse approval after effect change.
 * - Retry around preservation lock.
 */
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { grantRole, revokeRole } from '../authz/administration.mjs';
import { canonicalHash } from '../cir/canonicalHash.mjs';
import { applyWave } from '../restore/applyEngine.mjs';
import { createDryRunArtifact, getDryRunArtifactById } from '../restore/dryRunArtifact.mjs';
import {
  CONTENT_EFFECTS, ContentEffectApprovalError, approveContentEffects, assertContentEffectApproval, classifyContentEffects,
  contentEffectsDigest, contentEffectsReviewPath, disclosureFor, isPreservationLockFailure, loadContentEffectReview,
} from '../safety/contentEffects.mjs';
import { resolveDryRuns } from '../govern/references.mjs';
import { createSnapshot, completeSnapshot, insertResourceVersion } from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { fakeGraph } from '../../tools/qualification/operations.mjs';
import { runRestore } from '../../cli/keel-restore.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const TENANT = 'sha256:task-66';
const governor = { async acquire() {}, observeRetryAfter() {} };
const quiet = { log() {}, error() {} };

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(schemaSql());
    schemaReady = true;
  }
  return client;
}

async function principal(client, email, role) {
  const { rows } = await client.query(`INSERT INTO principal (email) VALUES ($1) RETURNING id`, [email]);
  const grant = role ? await grantRole(client, { principalId: rows[0].id, role, grantedBy: rows[0].id }) : null;
  return { id: rows[0].id, grantId: grant?.id ?? null };
}

const update = (resourceType, before, after, naturalKey = `${resourceType}:x`) => ({
  naturalKey, resourceType, verb: 'update', payload: after, live: { state: 'present', payload: before, targetId: 'id-1' },
});

// --------------------------------------------------------------- classification

test('shortened retention, released holds, widened sharing and destroying actions are classified with disclosures', () => {
  const { effects, refusals } = classifyContentEffects([
    update('retentionLabel', { displayName: 'Finance', retentionDuration: { days: 2555 }, actionAfterRetentionPeriod: 'none' },
      { displayName: 'Finance', retentionDuration: { days: 30 }, actionAfterRetentionPeriod: 'delete' }),
    update('group', { displayName: 'Board', visibility: 'Private' }, { displayName: 'Board', visibility: 'Public' }),
    update('authorizationPolicy', { allowInvitesFrom: 'adminsAndGuestInviters' }, { allowInvitesFrom: 'everyone' }),
    update('groupSetting', { values: [{ name: 'AllowGuestsToAccessGroups', value: 'false' }] }, { values: [{ name: 'AllowGuestsToAccessGroups', value: 'true' }] }),
  ]);
  assert.deepEqual(refusals, []);
  assert.deepEqual(effects.map((e) => `${e.resourceType}:${e.field}:${e.effect}`).sort(), [
    'authorizationPolicy:allowInvitesFrom:externally-sharing',
    'group:visibility:externally-sharing',
    'groupSetting:values[AllowGuestsToAccessGroups]:externally-sharing',
    'retentionLabel:actionAfterRetentionPeriod:irreversible',
    'retentionLabel:retentionDuration.days:retention-reducing',
  ]);
  // Disclosure: content is not backed up, and an inverse setting recovers nothing.
  for (const effect of CONTENT_EFFECTS) {
    assert.match(disclosureFor(effect), /backs up configuration, not content/);
    assert.match(disclosureFor(effect), /does not bring it back/);
  }
  assert.ok(effects.every((effect) => effect.disclosure === disclosureFor(effect.effect)));
});

test('mutation check: releasing or deleting a hold is hold-releasing, never cosmetic', () => {
  const released = classifyContentEffects([update('ediscoveryHoldPolicy', { displayName: 'Case 12', isEnabled: true }, { displayName: 'Case 12', isEnabled: false })]);
  assert.deepEqual(released.effects.map((e) => e.effect), ['hold-releasing']);
  const deleted = classifyContentEffects([{ naturalKey: 'ediscoveryHoldPolicy:Case 12', resourceType: 'ediscoveryHoldPolicy', verb: 'delete', payload: null, live: { state: 'present', payload: { isEnabled: true } } }]);
  assert.deepEqual(deleted.effects.map((e) => e.effect), ['hold-releasing']);
});

test('a benign or unchanged setting proceeds with no effect; narrowing is not an effect', () => {
  const { effects, refusals } = classifyContentEffects([
    update('group', { displayName: 'Board', visibility: 'Private' }, { displayName: 'Board members', visibility: 'Private' }),
    update('group', { displayName: 'Old', visibility: 'Public' }, { displayName: 'Old', visibility: 'Private' }),
    update('retentionLabel', { retentionDuration: { days: 30 } }, { retentionDuration: { days: 365 } }),
    update('conditionalAccessPolicy', { state: 'enabled' }, { state: 'enabledForReportingButNotEnforced', conditions: { users: { excludeGuestsOrExternalUsers: { guestOrExternalUserTypes: 'b2bCollaborationGuest' } } } }),
    { naturalKey: 'group:new', resourceType: 'group', verb: 'create', payload: { visibility: 'Public' }, live: null },
  ]);
  assert.deepEqual(effects, []);
  assert.deepEqual(refusals, [], 'reviewed types are judged by their rules, not by field names');
});

test('an unclassified dangerous transition on an unreviewed type refuses until classified', () => {
  const { effects, refusals } = classifyContentEffects([
    update('mobileAppConfiguration', { displayName: 'Baseline', remoteWipeAfterDays: 0 }, { displayName: 'Baseline', remoteWipeAfterDays: 14 }),
    update('mobileAppConfiguration', { displayName: 'Old name' }, { displayName: 'New name' }),
  ]);
  assert.deepEqual(effects, []);
  assert.equal(refusals.length, 1);
  assert.match(refusals[0].reason, /unclassified-content-effect: mobileAppConfiguration changes remoteWipeAfterDays/);
});

// ------------------------------------------------------------ Intune (issue #155)

const create = (resourceType, payload, naturalKey = `${resourceType}:${payload.displayName ?? payload.name}`) => ({ naturalKey, resourceType, verb: 'create', payload, live: null });
const complianceWith = (...actionTypes) => ({
  '@odata.type': '#microsoft.graph.windows10CompliancePolicy', displayName: 'Windows baseline', passwordRequired: true,
  scheduledActionsForRule: [{ ruleName: 'PasswordRequired', scheduledActionConfigurations: actionTypes.map((actionType) => ({ actionType, gracePeriodHours: 24, notificationTemplateId: null, notificationMessageCCList: [] })) }],
});

test('Q43 step 25: creating a device configuration with hotspot and shared app data settings passes the guard', () => {
  const { effects, refusals } = classifyContentEffects([
    create('deviceConfiguration', {
      '@odata.type': '#microsoft.graph.windows10GeneralConfiguration', displayName: 'Windows restrictions',
      internetSharingBlocked: true, sharedUserAppDataAllowed: false, storageBlockRemovableStorage: true, cameraBlocked: true,
    }),
    update('deviceConfiguration', { displayName: 'Windows restrictions', internetSharingBlocked: true, sharedUserAppDataAllowed: false },
      { displayName: 'Windows restrictions', internetSharingBlocked: false, sharedUserAppDataAllowed: true }),
    update('deviceConfiguration', { '@odata.type': '#microsoft.graph.androidWorkProfileGeneralDeviceConfiguration', displayName: 'Work profile', workProfileDataSharingType: 'preventAny', factoryResetBlocked: true },
      { '@odata.type': '#microsoft.graph.androidWorkProfileGeneralDeviceConfiguration', displayName: 'Work profile', workProfileDataSharingType: 'allowPersonalToWork', factoryResetBlocked: false }),
    create('deviceCompliancePolicy', complianceWith('block', 'notification', 'remoteLock')),
  ]);
  assert.deepEqual(refusals, [], 'device sharing settings are configuration, not content effects');
  assert.deepEqual(effects, []);
});

// ------------------------------------------- applications (live gate Q45, 11/13/14)

const app = Object.freeze({
  displayName: 'Payroll connector', signInAudience: 'AzureADMyOrg', appId: 'source-appid', publisherDomain: 'source.example',
  isFallbackPublicClient: false, publicClient: { redirectUris: ['https://login.microsoftonline.com/common/oauth2/nativeclient'] },
  web: { redirectUris: ['https://payroll.example/signin'], implicitGrantSettings: { enableIdTokenIssuance: false, enableAccessTokenIssuance: false } },
  spa: { redirectUris: [] }, identifierUris: ['api://source-appid'], tags: ['payroll'],
  requiredResourceAccess: [{ resourceAppId: '00000003-0000-0000-c000-000000000000', resourceAccess: [{ id: 'e1fe6dd8-ba31-4d61-89e7-88639da4683d', type: 'Scope' }] }],
});

test('Q45 steps 11, 13, 14: an application create, update or soft-delete restore that changes publicClient passes the guard', () => {
  const { effects, refusals } = classifyContentEffects([
    create('application', app, 'application:source-appid'),
    update('application', { displayName: app.displayName, isFallbackPublicClient: false }, { ...app, isFallbackPublicClient: true }, 'application:updated'),
    { naturalKey: 'application:restored', resourceType: 'application', verb: 'restore-soft-deleted', payload: app,
      live: { state: 'soft-deleted', payload: { displayName: app.displayName, appId: app.appId, deletedDateTime: '2026-10-13T00:00:00Z' }, targetId: 'app-1' } },
  ]);
  assert.deepEqual(refusals, [], 'publicClient is sign-in configuration on a reviewed type, not an unclassified content effect');
  assert.deepEqual(effects, []);
});

test('the same publicClient change is still refused on a type nobody has reviewed', () => {
  const { refusals } = classifyContentEffects([
    update('unreviewedAppType', { displayName: 'x' }, { displayName: 'x', publicClient: { redirectUris: ['ms-app://x'] }, isFallbackPublicClient: true }),
  ]);
  assert.equal(refusals.length, 1);
  assert.match(refusals[0].reason, /unclassified-content-effect: unreviewedAppType changes publicClient, isFallbackPublicClient/);
});

// ------------------------------------------- access package catalogs (issue #700)

const catalog = Object.freeze({ displayName: 'KEEL-RT-Catalog', description: 'Fixture', state: 'published', isExternallyVisible: false });

test('issue #700: an access package catalog restored as not externally visible passes the guard, create or update', () => {
  const { effects, refusals } = classifyContentEffects([
    create('accessPackageCatalog', catalog, 'accessPackageCatalog:created'),
    update('accessPackageCatalog', catalog, { ...catalog, description: 'Restored' }, 'accessPackageCatalog:updated'),
    update('accessPackageCatalog', { ...catalog, isExternallyVisible: true }, catalog, 'accessPackageCatalog:narrowed'),
  ]);
  assert.deepEqual(refusals, [], 'isExternallyVisible is classified, never an unclassified content effect');
  assert.deepEqual(effects, [], 'not visible, or made not visible, exposes nothing');
});

test('issue #700: making an access package catalog externally visible, on create or update, is externally-sharing', () => {
  const visible = { ...catalog, isExternallyVisible: true };
  const { effects, refusals } = classifyContentEffects([
    create('accessPackageCatalog', visible, 'accessPackageCatalog:created'),
    update('accessPackageCatalog', catalog, visible, 'accessPackageCatalog:updated'),
    update('accessPackageCatalog', visible, { ...visible, description: 'Still visible' }, 'accessPackageCatalog:unchanged'),
  ]);
  assert.deepEqual(refusals, []);
  assert.deepEqual(effects.map(({ naturalKey, field, effect, before, after }) => ({ naturalKey, field, effect, before, after })), [
    { naturalKey: 'accessPackageCatalog:created', field: 'isExternallyVisible', effect: 'externally-sharing', before: null, after: true },
    { naturalKey: 'accessPackageCatalog:updated', field: 'isExternallyVisible', effect: 'externally-sharing', before: false, after: true },
  ]);
  assert.equal(effects[0].disclosure, disclosureFor('externally-sharing'));
});

// ------------------------------------- iOS and Android app protection (issue #705)

// The live Q229 fixture: Graph's defaults, no wipe settings chosen by us.
const iosProtection = Object.freeze({
  '@odata.type': '#microsoft.graph.iosManagedAppProtection', displayName: 'KEEL-RT-ios-mam', description: 'Fixture',
  periodOfflineBeforeAccessCheck: 'PT12H', periodOnlineBeforeAccessCheck: 'PT30M', periodOfflineBeforeWipeIsEnforced: 'P90D',
  allowedInboundDataTransferSources: 'allApps', allowedOutboundDataTransferDestinations: 'allApps',
  allowedOutboundClipboardSharingLevel: 'managedAppsWithPasteIn', allowedOutboundClipboardSharingExceptionLength: 0,
  dataBackupBlocked: false, saveAsBlocked: false, printBlocked: false, pinRequired: true, maximumPinRetries: 5,
  appActionIfMaximumPinRetriesExceeded: 'block', appActionIfDeviceComplianceRequired: 'block',
  appActionIfUnableToAuthenticateUser: null, mobileThreatDefenseRemediationAction: 'block',
  minimumWipeOsVersion: null, minimumWipeAppVersion: null, minimumWipeSdkVersion: null,
});
const androidProtection = Object.freeze({
  ...iosProtection, '@odata.type': '#microsoft.graph.androidManagedAppProtection', displayName: 'KEEL-RT-android-mam',
  minimumWipePatchVersion: null, minimumWipeCompanyPortalVersion: null, wipeAfterCompanyPortalUpdateDeferralInDays: 0,
  appActionIfAndroidDeviceManufacturerNotAllowed: 'block', appActionIfDeviceLockNotSet: 'block',
});
const appPolicy = (payload, extra = {}) => ({ ...create('managedAppPolicy', payload, `managedAppPolicy:${payload.displayName}`), ...extra });
const shape = (effects) => effects.map(({ naturalKey, field, effect, before, after }) => ({ naturalKey, field, effect, before, after }));

test('issue #705: an unassigned iOS or Android app protection create is classified, never an unclassified content effect', () => {
  const { effects, refusals } = classifyContentEffects([appPolicy(iosProtection), appPolicy(androidProtection)]);
  assert.deepEqual(refusals, [], 'the wipe and clipboard fields are classified');
  assert.deepEqual(effects, [], 'a policy assigned to no one reaches no device');
});

test('issue #705: an assigned app protection create with an offline wipe needs the irreversible approval; its clipboard level does not', () => {
  const { effects, refusals } = classifyContentEffects([appPolicy(iosProtection, { newAssignments: ['group:KEEL-RT-Users'] })]);
  assert.deepEqual(refusals, []);
  assert.deepEqual(shape(effects), [
    { naturalKey: 'managedAppPolicy:KEEL-RT-ios-mam', field: 'periodOfflineBeforeWipeIsEnforced', effect: 'irreversible', before: null, after: 'P90D' },
  ], 'a new policy only ever narrows clipboard sharing, so the level is not an effect');
  assert.deepEqual(effects[0].newAssignments, ['group:KEEL-RT-Users']);
  assert.equal(effects[0].disclosure, disclosureFor('irreversible'));
});

test('issue #705: app protection wipes that are new, sooner or wider are irreversible on update', () => {
  const after = {
    ...androidProtection, periodOfflineBeforeWipeIsEnforced: 'P30D', minimumWipeOsVersion: '14.0', minimumWipePatchVersion: '2024-06-01',
    minimumWipeCompanyPortalVersion: '5.0.6000', wipeAfterCompanyPortalUpdateDeferralInDays: 30,
    appActionIfMaximumPinRetriesExceeded: 'wipe', appActionIfDeviceLockNotSet: 'wipe',
  };
  const before = { ...androidProtection, minimumWipePatchVersion: '2024-01-01' };
  const { effects, refusals } = classifyContentEffects([update('managedAppPolicy', before, after, 'managedAppPolicy:android')]);
  assert.deepEqual(refusals, []);
  assert.deepEqual(shape(effects), [
    { naturalKey: 'managedAppPolicy:android', field: 'appActionIf* (actions that wipe)', effect: 'irreversible', before: [], after: ['appActionIfDeviceLockNotSet', 'appActionIfMaximumPinRetriesExceeded'] },
    { naturalKey: 'managedAppPolicy:android', field: 'minimumWipeCompanyPortalVersion', effect: 'irreversible', before: null, after: '5.0.6000' },
    { naturalKey: 'managedAppPolicy:android', field: 'minimumWipeOsVersion', effect: 'irreversible', before: null, after: '14.0' },
    { naturalKey: 'managedAppPolicy:android', field: 'minimumWipePatchVersion', effect: 'irreversible', before: '2024-01-01', after: '2024-06-01' },
    { naturalKey: 'managedAppPolicy:android', field: 'periodOfflineBeforeWipeIsEnforced', effect: 'irreversible', before: 'P90D', after: 'P30D' },
    { naturalKey: 'managedAppPolicy:android', field: 'wipeAfterCompanyPortalUpdateDeferralInDays', effect: 'irreversible', before: 0, after: 30 },
  ]);
});

test('issue #705: app protection wipes that are removed, later or narrower are benign', () => {
  const before = {
    ...iosProtection, periodOfflineBeforeWipeIsEnforced: 'P30D', minimumWipeOsVersion: '16.0',
    appActionIfMaximumPinRetriesExceeded: 'wipe', allowedOutboundClipboardSharingLevel: 'allApps', allowedOutboundClipboardSharingExceptionLength: 40,
  };
  const after = {
    ...iosProtection, periodOfflineBeforeWipeIsEnforced: 'P90D', minimumWipeOsVersion: '15.0',
    appActionIfMaximumPinRetriesExceeded: 'block', allowedOutboundClipboardSharingLevel: 'blocked', allowedOutboundClipboardSharingExceptionLength: 10,
  };
  const { effects, refusals } = classifyContentEffects([
    update('managedAppPolicy', before, after, 'managedAppPolicy:narrowed'),
    update('managedAppPolicy', { ...iosProtection, periodOfflineBeforeWipeIsEnforced: 'PT2160H' }, iosProtection, 'managedAppPolicy:same-period'),
    update('managedAppPolicy', { ...iosProtection, periodOfflineBeforeWipeIsEnforced: 'P30D' }, { ...iosProtection, periodOfflineBeforeWipeIsEnforced: 'P0D' }, 'managedAppPolicy:off'),
  ]);
  assert.deepEqual(refusals, []);
  assert.deepEqual(effects, []);
});

test('issue #705: copying app protection work data to more apps is externally-sharing on update', () => {
  const { effects, refusals } = classifyContentEffects([update('managedAppPolicy',
    { ...iosProtection, allowedOutboundClipboardSharingLevel: 'managedApps' },
    { ...iosProtection, allowedOutboundClipboardSharingLevel: 'allApps', allowedOutboundClipboardSharingExceptionLength: 20 },
    'managedAppPolicy:wider')]);
  assert.deepEqual(refusals, []);
  assert.deepEqual(shape(effects), [
    { naturalKey: 'managedAppPolicy:wider', field: 'allowedOutboundClipboardSharingExceptionLength', effect: 'externally-sharing', before: 0, after: 20 },
    { naturalKey: 'managedAppPolicy:wider', field: 'allowedOutboundClipboardSharingLevel', effect: 'externally-sharing', before: 'managedApps', after: 'allApps' },
  ]);
});

test('issue #705 review: a maximum wipe OS version that is new or lower wipes more devices; a higher one is benign', () => {
  const { effects, refusals } = classifyContentEffects([
    update('managedAppPolicy', iosProtection, { ...iosProtection, maximumWipeOsVersion: '17.0' }, 'managedAppPolicy:new-max'),
    update('managedAppPolicy', { ...iosProtection, maximumWipeOsVersion: '18.0' }, { ...iosProtection, maximumWipeOsVersion: '17.2' }, 'managedAppPolicy:lower-max'),
    update('managedAppPolicy', { ...iosProtection, maximumWipeOsVersion: '17.0' }, { ...iosProtection, maximumWipeOsVersion: '18.0' }, 'managedAppPolicy:higher-max'),
  ]);
  assert.deepEqual(refusals, []);
  assert.deepEqual(shape(effects), [
    { naturalKey: 'managedAppPolicy:lower-max', field: 'maximumWipeOsVersion', effect: 'irreversible', before: '18.0', after: '17.2' },
    { naturalKey: 'managedAppPolicy:new-max', field: 'maximumWipeOsVersion', effect: 'irreversible', before: null, after: '17.0' },
  ]);
});

test('issue #705 review: sending work data to more apps is externally-sharing on update, never on create', () => {
  const { effects, refusals } = classifyContentEffects([
    update('managedAppPolicy', { ...iosProtection, allowedOutboundDataTransferDestinations: 'managedApps' }, iosProtection, 'managedAppPolicy:transfer-wider'),
    update('managedAppPolicy', iosProtection, { ...iosProtection, allowedOutboundDataTransferDestinations: 'none' }, 'managedAppPolicy:transfer-narrower'),
    appPolicy({ ...iosProtection, displayName: 'KEEL-RT-ios-open', periodOfflineBeforeWipeIsEnforced: 'P0D' }, { newAssignments: ['group:KEEL-RT-Users'] }),
  ]);
  assert.deepEqual(refusals, []);
  assert.deepEqual(shape(effects), [
    { naturalKey: 'managedAppPolicy:transfer-wider', field: 'allowedOutboundDataTransferDestinations', effect: 'externally-sharing', before: 'managedApps', after: 'allApps' },
  ]);
});

test('issue #705: an unreadable offline wipe period counts as shorter', () => {
  const { effects } = classifyContentEffects([update('managedAppPolicy', iosProtection, { ...iosProtection, periodOfflineBeforeWipeIsEnforced: 'soon' }, 'managedAppPolicy:odd')]);
  assert.deepEqual(effects.map((e) => e.field), ['periodOfflineBeforeWipeIsEnforced']);
});

// ------------------------------------- Windows app protection offline wipe period

const winProtection = Object.freeze({
  '@odata.type': '#microsoft.graph.windowsManagedAppProtection', displayName: 'KEEL-RT-win-mam', description: 'Fixture',
  printBlocked: true, allowedOutboundClipboardSharingLevel: 'none', periodOfflineBeforeWipeIsEnforced: 'P90D',
});
const winUpdate = (before, after, name) => update('windowsManagedAppProtection', { ...winProtection, ...before }, { ...winProtection, ...after }, `windowsManagedAppProtection:${name}`);

test('a Windows app protection restore that shortens or adds the offline wipe period needs the irreversible approval', () => {
  const { effects, refusals } = classifyContentEffects([
    winUpdate({}, { periodOfflineBeforeWipeIsEnforced: 'P1D' }, 'shorter'),
    winUpdate({ periodOfflineBeforeWipeIsEnforced: null }, { periodOfflineBeforeWipeIsEnforced: 'P30D' }, 'new'),
    winUpdate({ periodOfflineBeforeWipeIsEnforced: 'P0D' }, { periodOfflineBeforeWipeIsEnforced: 'PT12H' }, 'was-off'),
    { ...create('windowsManagedAppProtection', winProtection, 'windowsManagedAppProtection:created'), newAssignments: ['group:KEEL-RT-Users'] },
  ]);
  assert.deepEqual(refusals, []);
  assert.deepEqual(shape(effects), [
    { naturalKey: 'windowsManagedAppProtection:created', field: 'periodOfflineBeforeWipeIsEnforced', effect: 'irreversible', before: null, after: 'P90D' },
    { naturalKey: 'windowsManagedAppProtection:new', field: 'periodOfflineBeforeWipeIsEnforced', effect: 'irreversible', before: null, after: 'P30D' },
    { naturalKey: 'windowsManagedAppProtection:shorter', field: 'periodOfflineBeforeWipeIsEnforced', effect: 'irreversible', before: 'P90D', after: 'P1D' },
    { naturalKey: 'windowsManagedAppProtection:was-off', field: 'periodOfflineBeforeWipeIsEnforced', effect: 'irreversible', before: 'P0D', after: 'PT12H' },
  ]);
});

test('a Windows app protection offline wipe period that is off, longer or the same value written differently is no effect', () => {
  const { effects, refusals } = classifyContentEffects([
    winUpdate({}, { periodOfflineBeforeWipeIsEnforced: 'P0D' }, 'off'),
    winUpdate({ periodOfflineBeforeWipeIsEnforced: 'P30D' }, {}, 'longer'),
    winUpdate({}, { periodOfflineBeforeWipeIsEnforced: 'PT2160H' }, 'same'),
    winUpdate({ periodOfflineBeforeWipeIsEnforced: 'PT2160H' }, {}, 'same-reversed'),
    { ...create('windowsManagedAppProtection', { ...winProtection, periodOfflineBeforeWipeIsEnforced: 'P0D' }, 'windowsManagedAppProtection:created-off'),
      newAssignments: ['group:KEEL-RT-Users'] },
    { ...create('windowsManagedAppProtection', winProtection, 'windowsManagedAppProtection:unassigned'), newAssignments: [] },
  ]);
  assert.deepEqual(refusals, []);
  assert.deepEqual(effects, []);
});

test('a compliance policy that wipes or retires noncompliant devices is irreversible and needs the separate approval', async (t) => {
  const created = classifyContentEffects([create('deviceCompliancePolicy', complianceWith('block', 'wipe'))]);
  assert.deepEqual(created.refusals, []);
  assert.deepEqual(created.effects.map((e) => [e.field, e.effect, e.before, e.after]), [['scheduledActionsForRule[actionType]', 'irreversible', [], ['block', 'wipe']]]);
  assert.equal(created.effects[0].disclosure, disclosureFor('irreversible'));

  const retired = classifyContentEffects([update('deviceCompliancePolicy', complianceWith('block'), complianceWith('block', 'retire'))]);
  assert.deepEqual(retired.effects.map((e) => e.effect), ['irreversible']);
  // Dropping the wipe, or a backup without actions (live actions are kept), is benign.
  const softened = classifyContentEffects([
    update('deviceCompliancePolicy', complianceWith('wipe'), complianceWith('block')),
    update('deviceCompliancePolicy', complianceWith('wipe'), { displayName: 'Windows baseline', passwordRequired: false }),
  ]);
  assert.deepEqual(softened.effects, []);

  const client = await schemaClient(t);
  await assert.rejects(
    assertContentEffectApproval(client, { artifact: { id: crypto.randomUUID(), requestedBy: 'nobody' }, effects: created.effects }),
    /blocked-content-effect: 1 content effect\(s\) \(irreversible\)/,
  );
});

test('a device profile or settings catalog policy that introduces or lowers a failed-sign-in wipe is irreversible; raising it is not', () => {
  const catalog = (value) => ({ name: 'Device lock', settings: [{ settingInstance: { settingDefinitionId: 'device_vendor_msft_policy_config_devicelock_maxdevicepasswordfailedattempts', simpleSettingValue: { value } } }] });
  const { effects, refusals } = classifyContentEffects([
    create('deviceConfiguration', { '@odata.type': '#microsoft.graph.iosGeneralDeviceConfiguration', displayName: 'iOS lock', passcodeSignInFailureCountBeforeWipe: 10 }),
    update('deviceConfiguration', { passwordSignInFailureCountBeforeFactoryReset: 10 }, { passwordSignInFailureCountBeforeFactoryReset: 5 }, 'deviceConfiguration:Android lock'),
    update('deviceConfiguration', { passwordSignInFailureCountBeforeFactoryReset: 5 }, { passwordSignInFailureCountBeforeFactoryReset: null }, 'deviceConfiguration:Android relax'),
    update('deviceConfiguration', { accountManagerPolicy: { accountDeletionPolicy: 'diskSpaceThreshold', inactiveThresholdDays: 30 } },
      { accountManagerPolicy: { accountDeletionPolicy: 'immediately', inactiveThresholdDays: 7 } }, 'deviceConfiguration:Shared PC'),
    create('configurationPolicy', catalog('8')),
    update('configurationPolicy', catalog('4'), catalog('8'), 'configurationPolicy:Device lock relax'),
  ]);
  assert.deepEqual(refusals, []);
  assert.deepEqual(effects.map((e) => `${e.naturalKey}:${e.field}:${e.effect}`).sort(), [
    'configurationPolicy:Device lock:settings[device_vendor_msft_policy_config_devicelock_maxdevicepasswordfailedattempts]:irreversible',
    'deviceConfiguration:Android lock:passwordSignInFailureCountBeforeFactoryReset:irreversible',
    'deviceConfiguration:Shared PC:accountManagerPolicy.accountDeletionPolicy:irreversible',
    'deviceConfiguration:Shared PC:accountManagerPolicy.inactiveThresholdDays:retention-reducing',
    'deviceConfiguration:iOS lock:passcodeSignInFailureCountBeforeWipe:irreversible',
  ]);
});

// ------------------------------------------------- mutation check: preservation lock

test('mutation check: a preservation-locked object is refused at planning and a lock refusal is never retried or worked around', async () => {
  const planned = classifyContentEffects([
    update('retentionLabel', { retentionDuration: { days: 2555 }, isPreservationLocked: true }, { retentionDuration: { days: 2555 }, displayName: 'renamed' }),
  ]);
  assert.match(planned.refusals[0].reason, /preservation-locked/);

  const graph = fakeGraph();
  graph.objects.set('/groups/locked', { id: 'locked', displayName: 'Old', mailNickname: 'locked' });
  let attempts = 0;
  const lockedWriter = {
    writes: graph.writes,
    async write(version, path, options) {
      graph.writes.push({ method: options.method, path });
      attempts += 1;
      return { ok: false, status: 400, body: { error: { code: 'PreservationLockViolation', message: 'Preservation Lock prevents this change' } } };
    },
    read: (version, path) => graph.read(version, path),
  };
  const result = await applyWave(lockedWriter, governor, [{
    naturalKey: 'group:locked', resourceType: 'group', verb: 'update', targetId: 'locked',
    payload: { displayName: 'New', mailNickname: 'locked' }, references: [], blastRadius: 'cosmetic',
  }], { targetTenant: 't', mode: 'enforce' });
  assert.equal(attempts, 1, 'the refused write is sent exactly once');
  assert.deepEqual(graph.writes.map((w) => w.method), ['PATCH'], 'no delete, recreate or other path follows');
  assert.match(result.failed[0].error, /^preservation-lock:/);
  assert.equal(isPreservationLockFailure({ body: { error: { message: 'ok' } } }), false);
});

// ------------------------------------ approval: separate, current, bound to the effects

async function artifactWithEffects(client, { requestedBy, effects }) {
  const snapshotId = await createSnapshot(client, { tenantRef: TENANT });
  return createDryRunArtifact(client, {
    id: crypto.randomUUID(), tenantRef: TENANT, snapshotId, selection: ['x'], closureKeys: ['x'], targetTenantId: 't',
    collectorConfigPath: 'c', targetConfigPath: 'r', waves: [], patches: [], results: {},
    currentStateFingerprint: 'f', digest: 'd', status: 'completed', requestedBy, contentEffects: effects,
  });
}

const shortened = (days) => classifyContentEffects([
  update('retentionLabel', { retentionDuration: { days: 2555 } }, { retentionDuration: { days } }, 'retentionLabel:Finance'),
]).effects;

test('shortened retention requires a separate approval by a current approver who is not the requester', async (t) => {
  const client = await schemaClient(t);
  const requester = await principal(client, 'req@contoso.example', 'approver');
  const approver = await principal(client, 'appr@contoso.example', 'approver');
  const viewer = await principal(client, 'view@contoso.example', 'viewer');
  const effects = shortened(30);
  const artifact = await artifactWithEffects(client, { requestedBy: requester.id, effects });
  const digest = contentEffectsDigest(effects);

  await assert.rejects(assertContentEffectApproval(client, { artifact, effects }), /blocked-content-effect/);
  await assert.rejects(approveContentEffects(client, { tenantRef: TENANT, artifactId: artifact.id, approverId: requester.id, effectsDigest: digest, justification: 'mine' }), /someone other than the requester/);
  await assert.rejects(approveContentEffects(client, { tenantRef: TENANT, artifactId: artifact.id, approverId: viewer.id, effectsDigest: digest, justification: 'x' }), /currently holding approve/);
  await assert.rejects(approveContentEffects(client, { tenantRef: TENANT, artifactId: artifact.id, approverId: approver.id, effectsDigest: digest, justification: '' }), /justification/);

  await approveContentEffects(client, { tenantRef: TENANT, artifactId: artifact.id, approverId: approver.id, effectsDigest: digest, justification: 'Legal confirmed 30 days' });
  const used = await assertContentEffectApproval(client, { artifact, effects });
  assert.equal(used.approved_by, approver.id);

  // A grant revoked before execution makes the approval no longer current.
  await revokeRole(client, { principalId: approver.id, grantId: approver.grantId, revokedBy: requester.id });
  await assert.rejects(assertContentEffectApproval(client, { artifact, effects }), ContentEffectApprovalError);
});

test('mutation check: an approval never carries over to changed effects', async (t) => {
  const client = await schemaClient(t);
  const requester = await principal(client, 'req2@contoso.example', 'restorer');
  const approver = await principal(client, 'appr2@contoso.example', 'approver');
  const approvedEffects = shortened(30);
  const artifact = await artifactWithEffects(client, { requestedBy: requester.id, effects: approvedEffects });
  await approveContentEffects(client, { tenantRef: TENANT, artifactId: artifact.id, approverId: approver.id, effectsDigest: contentEffectsDigest(approvedEffects), justification: 'ok at 30 days' });
  assert.ok(await assertContentEffectApproval(client, { artifact, effects: approvedEffects }));

  const changed = shortened(7);
  assert.notEqual(contentEffectsDigest(changed), contentEffectsDigest(approvedEffects));
  await assert.rejects(assertContentEffectApproval(client, { artifact, effects: changed }), /blocked-content-effect/);
  // Approving a stale digest is refused too: the approver must see the current effects.
  await assert.rejects(
    approveContentEffects(client, { tenantRef: TENANT, artifactId: artifact.id, approverId: approver.id, effectsDigest: 'stale', justification: 'x' }),
    /no longer match/,
  );
});

test('Q45: a CLI-planned dry run (no portal job) is reviewable and approvable, and the refusal says where', async (t) => {
  const client = await schemaClient(t);
  const requester = await principal(client, 'req-q45@contoso.example', 'approver');
  const approver = await principal(client, 'appr-q45@contoso.example', 'approver');
  const effects = classifyContentEffects([
    update('groupLifecyclePolicy', { groupLifetimeInDays: 400 }, { groupLifetimeInDays: 365 }, 'groupLifecyclePolicy:default'),
  ]).effects;
  assert.deepEqual(effects.map((e) => e.effect), ['retention-reducing']);
  // Persisted the way `keel-restore --persist-artifact` does: an artifact with no dry-run job.
  const artifact = await artifactWithEffects(client, { requestedBy: requester.id, effects });
  const digest = contentEffectsDigest(effects);

  // The inbox learns the restore carries content effects, though no portal job planned it.
  const plan = (await resolveDryRuns(client, { tenantRef: TENANT, ids: [artifact.id] })).get(artifact.id);
  assert.equal(plan.contentEffects, 1);
  assert.equal(plan.dryRunJobId, null);

  // The refusal at execution names where to approve.
  await assert.rejects(assertContentEffectApproval(client, { artifact, effects }), (error) => {
    assert.match(error.message, /^blocked-content-effect: 1 content effect\(s\) \(retention-reducing\)/);
    assert.ok(error.message.includes(`Approvals, then "Review content effects"`));
    assert.ok(error.message.includes(contentEffectsReviewPath(artifact.id)));
    return true;
  });

  const before = await loadContentEffectReview(client, { tenantRef: TENANT, artifactId: artifact.id });
  assert.equal(before.effectsDigest, digest, 'the review binds to the same digest the promotion gate checks');
  assert.equal(before.requestedBy, requester.id);
  assert.deepEqual(before.effects.map((e) => e.field), ['groupLifetimeInDays']);
  assert.deepEqual(before.approvals, []);
  assert.equal(await loadContentEffectReview(client, { tenantRef: 'sha256:other', artifactId: artifact.id }), null, 'another tenant reads it as absent');

  // Same rules: the requester cannot approve; a different approver can.
  await assert.rejects(approveContentEffects(client, { tenantRef: TENANT, artifactId: artifact.id, approverId: requester.id, effectsDigest: before.effectsDigest, justification: 'mine' }), /someone other than the requester/);
  await approveContentEffects(client, { tenantRef: TENANT, artifactId: artifact.id, approverId: approver.id, effectsDigest: before.effectsDigest, justification: 'Policy review agreed 365 days' });
  const reviewed = await loadContentEffectReview(client, { tenantRef: TENANT, artifactId: artifact.id });
  assert.deepEqual(reviewed.approvals.map((a) => a.approvedBy), [approver.id]);
  assert.equal((await assertContentEffectApproval(client, { artifact, effects })).approved_by, approver.id);
});

// ------------------------------------------------------- full CLI: dry run -> promote

const configs = new Map([
  ['/fixtures/collector.json', JSON.stringify({ tenantId: 'tenant-66', clientId: 'collector', certPath: 'c.pem', keyPath: 'c.key' })],
  ['/fixtures/restorer.json', JSON.stringify({ tenantId: 'tenant-66', clientId: 'restorer', certPath: 'r.pem', keyPath: 'r.key' })],
]);
const readFile = (path) => configs.get(path) ?? (() => { throw new Error(`unexpected config read: ${path}`); })();

function cliDependencies(graph) {
  class Reader {
    async collect(version, path) {
      if (path.startsWith('/groups')) return { items: [...graph.objects].filter(([key]) => key.startsWith('/groups/')).map(([, body]) => body), capped: false, error: null };
      return { items: [], capped: false, error: null };
    }

    async get(version, path) {
      if (path === '/policies/authenticationMethodsPolicy') return { ok: true, status: 200, body: { id: 'authenticationMethodsPolicy' } };
      if (path === '/policies/identitySecurityDefaultsEnforcementPolicy') return { ok: true, status: 200, body: { id: 'identitySecurityDefaultsEnforcementPolicy', isEnabled: true } };
      if (path.startsWith('/users/')) return { ok: true, status: 200, body: { id: 'break-glass-id', accountEnabled: true } };
      throw new Error(`unexpected read: ${path}`);
    }
  }
  return {
    getToken: async () => ({ accessToken: 'fake-token' }),
    GraphReader: Reader,
    GraphWriter: class { constructor() { return graph; } },
    collectM1: async () => [],
    canonicalizeAll: () => [
      { naturalKey: 'roleAssignment:GlobalAdministrator:break-glass', resourceType: 'roleAssignment', sourceId: 'ra-1', payload: { principalId: 'break-glass-id' } },
    ],
  };
}

async function seedGroup(client, payload) {
  const snapshotId = await createSnapshot(client, { tenantRef: TENANT });
  await insertResourceVersion(client, {
    snapshotId,
    resource: {
      naturalKey: 'group:board', resourceType: 'group', payload, payloadHash: canonicalHash(payload, 'group'),
      criticality: 'tier1', blastRadius: 'access-affecting', fidelity: 'full', provenance: { adapter: 'test' },
    },
  });
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: {} });
  return snapshotId;
}

const dryRun = (snapshotId, graph, artifactId, requestedBy) => runRestore({
  snapshotId, selection: ['group:board'], mode: 'dry-run', persistArtifactId: artifactId, requestedBy,
  collectorConfig: JSON.parse(configs.get('/fixtures/collector.json')), targetConfig: JSON.parse(configs.get('/fixtures/restorer.json')),
  collectorConfigPath: '/fixtures/collector.json', targetConfigPath: '/fixtures/restorer.json',
  readFile, dbUrl: database.url, dependencies: cliDependencies(graph), logger: quiet,
});
const promote = (artifactId, graph) => runRestore({ artifactId, mode: 'enforce', readFile, dbUrl: database.url, dependencies: cliDependencies(graph), logger: quiet });
const board = { displayName: 'Board', mailNickname: 'board', mailEnabled: false, securityEnabled: true, groupTypes: [] };

test('a sharing-widening restore is refused at promotion until separately approved; then it runs', async (t) => {
  const client = await schemaClient(t);
  const requester = await principal(client, 'req3@contoso.example', 'restorer');
  const approver = await principal(client, 'appr3@contoso.example', 'approver');
  const snapshotId = await seedGroup(client, { ...board, visibility: 'Public' });
  const graph = fakeGraph();
  graph.objects.set('/groups/board-id', { ...board, id: 'board-id', visibility: 'Private' });

  const artifactId = crypto.randomUUID();
  const dry = await dryRun(snapshotId, graph, artifactId, requester.id);
  assert.deepEqual(dry.contentEffects.map((e) => [e.naturalKey, e.field, e.effect]), [['group:board', 'visibility', 'externally-sharing']]);
  const artifact = await getDryRunArtifactById(client, { id: artifactId });
  assert.equal(artifact.status, 'completed');
  assert.deepEqual(artifact.contentEffects, dry.contentEffects);

  await assert.rejects(promote(artifactId, graph), /blocked-content-effect/);
  assert.equal(graph.writes.length, 0, 'nothing is written without the separate approval');

  await approveContentEffects(client, { tenantRef: TENANT, artifactId, approverId: approver.id, effectsDigest: contentEffectsDigest(artifact.contentEffects), justification: 'Board site was public before the incident' });
  const result = await promote(artifactId, graph);
  assert.deepEqual(result.results.failed, []);
  assert.equal(graph.objects.get('/groups/board-id').visibility, 'Public');
});

test('a benign restore with no content effect promotes without any extra approval', async (t) => {
  const client = await schemaClient(t);
  const requester = await principal(client, 'req4@contoso.example', 'restorer');
  const snapshotId = await seedGroup(client, { ...board, displayName: 'Board members', visibility: 'Private' });
  const graph = fakeGraph();
  graph.objects.set('/groups/board-id', { ...board, id: 'board-id', visibility: 'Private' });
  const artifactId = crypto.randomUUID();
  const dry = await dryRun(snapshotId, graph, artifactId, requester.id);
  assert.deepEqual(dry.contentEffects, []);
  const result = await promote(artifactId, graph);
  assert.deepEqual(result.results.failed, []);
  assert.equal(graph.objects.get('/groups/board-id').displayName, 'Board members');
});

// Restore approvals: the directions a restore used to hold back are effects now.
test('restore approvals: every held-back direction is an effect in a service the customer setting covers', async () => {
  const { PROTECTION_EFFECT_RULES } = await import('../safety/contentEffects.mjs');
  const { serviceForResourceType } = await import('../govern/restoreApprovalSettings.mjs');
  for (const [type, spec] of Object.entries(PROTECTION_EFFECT_RULES)) {
    assert.ok(serviceForResourceType(type), `${type} is placed in a service, so its approval setting applies`);
    for (const entry of spec.rules) assert.ok(CONTENT_EFFECTS.includes(entry.effect), `${type}.${entry.field}`);
  }
  // Only the loose direction is an effect; tightening is not.
  const loosen = classifyContentEffects([update('sharepointSettings', { isLegacyAuthProtocolsEnabled: false }, { isLegacyAuthProtocolsEnabled: true })]);
  assert.deepEqual(loosen.effects.map((e) => `${e.field}:${e.effect}`), ['isLegacyAuthProtocolsEnabled:weakens-protection']);
  assert.match(loosen.effects[0].disclosure, /less strict/);
  const tighten = classifyContentEffects([update('sharepointSettings', { isLegacyAuthProtocolsEnabled: true }, { isLegacyAuthProtocolsEnabled: false })]);
  assert.deepEqual(tighten.effects, []);
  // A field a protection rule reviews is not refused by its name (Forms external sharing).
  const forms = classifyContentEffects([update('formsSettings', { settings: { isExternalShareResultEnabled: false } }, { settings: { isExternalShareResultEnabled: true } })]);
  assert.deepEqual(forms.refusals, []);
  assert.deepEqual(forms.effects.map((e) => e.effect), ['externally-sharing']);
  const narrowed = classifyContentEffects([update('formsSettings', { settings: { isExternalShareResultEnabled: true } }, { settings: { isExternalShareResultEnabled: false } })]);
  assert.deepEqual([narrowed.effects, narrowed.refusals], [[], []]);
});
