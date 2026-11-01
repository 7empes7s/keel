/**
 * Roadmap task-66: guard the irreversible effects of configuration changes.
 *
 * Some configuration writes do more than change configuration. They:
 *   - shorten how long content is kept       (retention-reducing)
 *   - release content from a legal hold      (hold-releasing)
 *   - expose content outside its audience    (externally-sharing)
 *   - destroy content outright               (irreversible)
 * Those effects land on CONTENT, which KEEL does not back up. Putting the
 * setting back later never recovers content that was deleted or disclosed in
 * between, and every effect carries a disclosure saying so.
 *
 * Classification is by EXPLICIT before/after field rules per resource type,
 * never by a guess:
 *  - A reviewed type has its dangerous transitions listed. Its other fields are
 *    configuration only.
 *  - On a type nobody has reviewed, a changed field whose name looks
 *    content-bearing (retention, hold, sharing, guest, wipe, ...) is an
 *    UNCLASSIFIED dangerous transition. It is refused until a rule classifies it.
 *  - An object under a platform preservation lock is never changed or deleted
 *    by KEEL, and a lock refusal from the platform is never retried or worked
 *    around.
 *
 * Classified effects are persisted with the dry run and folded into its plan
 * digest. Promotion then requires a SEPARATE high-impact approval with these
 * properties:
 *  - It is bound to the digest of exactly these effects; a changed effect
 *    invalidates it.
 *  - The approver is someone other than the requester.
 *  - The approver still holds `approve` when the restore runs.
 * Existing Conditional Access restrictions (report-only writes) are unchanged.
 */
import { createHash } from 'node:crypto';

import { can } from '../authz/can.mjs';
import { findPrincipalById } from '../authz/principals.mjs';
import { appendEvidence } from '../govern/evidence.mjs';
import { effectsNeedApproval, getRestoreApprovalSettings } from '../govern/restoreApprovalSettings.mjs';
import { selfApprovalAllowed, selfApprovalReasonProblem } from '../govern/approvalMode.mjs';
import { pimRuleWeakenings } from '../restore/adminRoleOperations.mjs';
import { SCRIPT_BODY_FIELDS, scriptFingerprint, scriptText } from './scriptBodies.mjs';

export const CONTENT_EFFECTS = Object.freeze(['retention-reducing', 'hold-releasing', 'externally-sharing', 'irreversible', 'runs-on-devices', 'weakens-protection', 'acts-on-accounts', 'blocks-sign-in']);
export const CONTENT_EFFECT_APPROVAL_EVIDENCE_KIND = 'content-effect-approval';

const NOT_BACKED_UP = 'KEEL backs up configuration, not content: content deleted or disclosed while this setting is in effect is not recoverable by KEEL, and restoring the previous setting later does not bring it back.';

const DISCLOSURES = Object.freeze({
  'retention-reducing': `Content older than the new retention period can be permanently deleted. ${NOT_BACKED_UP}`,
  'hold-releasing': `Content released from the hold can be deleted by users or by retention. ${NOT_BACKED_UP}`,
  'externally-sharing': `Content becomes visible to people outside its current audience. ${NOT_BACKED_UP}`,
  irreversible: `This change destroys content when it takes effect. ${NOT_BACKED_UP}`,
  // PR #435 follow-up: putting back an assigned script's text runs that text on devices.
  'runs-on-devices': 'This puts the backup\'s script text back. Intune then runs it on every device the script is assigned to, '
    + 'with administrator rights, the next time each device checks in. If the backup was changed after it was taken, that changed code runs. '
    + `Read the script before approving. A script can delete or send out data on those devices. ${NOT_BACKED_UP}`,
  // Restore approvals: settings a restore used to write in the stricter direction only.
  'weakens-protection': 'This puts back a security, sign-in or access setting that is less strict than the one in place now, '
    + `so more people, devices or apps can reach the organisation's data, or fewer checks apply. ${NOT_BACKED_UP}`,
  'acts-on-accounts': 'This turns on a rule or workflow that acts by itself on people\'s accounts, mail or devices: it can block access, '
    + `or run tasks that change, disable or delete accounts. ${NOT_BACKED_UP}`,
  'blocks-sign-in': 'This turns off sign-in for an app. The app, and every person, service or automation that uses it, '
    + `stops working until someone turns it back on. Check nobody relies on the app now before approving. ${NOT_BACKED_UP}`,
});

export function disclosureFor(effect) {
  return DISCLOSURES[effect];
}

// Ordered sharing scopes: a move to a wider scope expands who can see content.
const INVITE_SCOPE = ['none', 'adminsAndGuestInviters', 'adminsGuestInvitersAndAllMembers', 'everyone'];
const widens = (order) => (before, after) => {
  const b = order.indexOf(before);
  const a = order.indexOf(after);
  return a > -1 && (b === -1 ? a > 0 : a > b);
};
const becomes = (value) => (before, after) => before !== value && after === value;
const decreases = (before, after) => typeof before === 'number' && typeof after === 'number' && after < before;
// Task-103: SharePoint tenant sharing, narrowest to widest.
const SHAREPOINT_SHARING = ['disabled', 'existingExternalUserSharingOnly', 'externalUserSharingOnly', 'externalUserAndGuestSharing'];
// Gap 5: SharePoint site app grant roles, narrowest to widest. Graph reads a full
// control grant back as `owner`. A role set ranks as its widest role; -1 when a
// role is unknown (never ranked below a known one by mistake: callers refuse it).
const SITE_APP_ROLES = ['read', 'write', 'manage', 'fullcontrol'];
const SITE_ROLE_ALIASES = { owner: 'fullcontrol' };
export function siteRoleRank(roles) {
  const list = (Array.isArray(roles) ? roles : []).map((role) => SITE_ROLE_ALIASES[String(role).toLowerCase()] ?? String(role).toLowerCase());
  if (list.length === 0 || list.some((role) => !SITE_APP_ROLES.includes(role))) return -1;
  return Math.max(...list.map((role) => SITE_APP_ROLES.indexOf(role)));
}
/** The one role Graph is sent for a rank (the widest role of the set). */
export const siteRoleAt = (rank) => SITE_APP_ROLES[rank];
const raisesSiteRole = (before, after) => siteRoleRank(after) > (before == null ? -1 : siteRoleRank(before));
const listOf = (value) => (Array.isArray(value) ? value.map((item) => String(item).toLowerCase()) : []);
const removesEntry = (before, after) => listOf(before).some((item) => !listOf(after).includes(item));
const addsEntry = (before, after) => listOf(after).some((item) => !listOf(before).includes(item));
const truthy = (value) => value === true || value === 'true' || value === 'True';
const enabledToDisabled = (before, after) => truthy(before) && !truthy(after);
const disabledToEnabled = (before, after) => !truthy(before) && truthy(after);

// Gap D3: which groups expiry covers, narrowest first, and the renewal notice
// addresses (a ";" list, any case). Mirrors groupLifecycleReview.
const GROUP_EXPIRY_SCOPE = ['none', 'selected', 'all'];
const widensGroupExpiry = (before, after) => {
  const b = GROUP_EXPIRY_SCOPE.indexOf(String(before ?? '').toLowerCase());
  const a = GROUP_EXPIRY_SCOPE.indexOf(String(after ?? '').toLowerCase());
  return b > -1 && a > b;
};
const noticeAddresses = (value) => (typeof value === 'string'
  ? value.split(';').map((address) => address.trim().toLowerCase()).filter((address) => address.length > 0) : []);
// A backup without the field leaves the addresses alone (the writer sends only what the backup holds).
const dropsNoticeAddress = (before, after) => after !== undefined && noticeAddresses(before).some((address) => !noticeAddresses(after).includes(address));

// Task-105: automatic reply audiences, narrowest to widest.
const AUTOREPLY_AUDIENCE = ['none', 'contactsOnly', 'all'];
/** Exchange timespans read as "d.hh:mm:ss" (or "hh:mm:ss"); days as a number, null when unreadable. */
function timespanDays(value) {
  const match = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(value ?? ''));
  if (!match) return null;
  return Number(match[1] ?? 0) + Number(match[2]) / 24 + Number(match[3]) / 1440 + Number(match[4]) / 86400;
}

// A changed window that cannot be read is treated as shorter: the safe direction.
const shortensTimespan = (before, after) => {
  const b = timespanDays(before);
  const a = timespanDays(after);
  return b === null || a === null ? true : a < b;
};

// Intune (issue #155). Compliance actions that destroy or release a device:
// a wipe factory-resets it, a retire removes company data from it.
const DEVICE_DESTROYING_ACTIONS = ['wipe', 'retire'];
/** The distinct noncompliance action types of a compliance policy, lower-cased. */
const complianceActionTypes = (payload) => [...new Set(
  (Array.isArray(payload?.scheduledActionsForRule) ? payload.scheduledActionsForRule : [])
    .flatMap((rule) => (Array.isArray(rule?.scheduledActionConfigurations) ? rule.scheduledActionConfigurations : []))
    .map((action) => String(action?.actionType ?? '').toLowerCase()),
)].sort();
const addsDeviceDestroyingAction = (before, after) => DEVICE_DESTROYING_ACTIONS.some((action) => listOf(after).includes(action) && !listOf(before).includes(action));
// A failed-sign-in wipe threshold: null, 0 or absent means the device is never
// wiped. Introducing one, or lowering it, wipes the device after fewer attempts.
const positive = (value) => typeof value === 'number' && value > 0;
const wipeThresholdTightens = (before, after) => positive(after) && (!positive(before) || after < before);
/** A settings catalog value by its definition id, read from the policy's settings list. */
const catalogSetting = (definitionId) => (payload) => {
  const settings = Array.isArray(payload?.settings) ? payload.settings : [];
  const instance = settings.map((setting) => setting?.settingInstance).find((candidate) => candidate?.settingDefinitionId === definitionId);
  const value = instance?.simpleSettingValue?.value;
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
};
// Windows DeviceLock/MaxDevicePasswordFailedAttempts in the settings catalog: wipes the device after that many failures (0 = never).
const CATALOG_WIPE_THRESHOLD = 'device_vendor_msft_policy_config_devicelock_maxdevicepasswordfailedattempts';

// Restore gaps batch 12: an app protection "wipe" version. A device or app
// below it has its work data removed from the app. Introducing one, or raising
// it, removes that data from more devices.
// Android patch versions are dates (2024-01-01), so dashes split parts too.
const versionParts = (value) => String(value).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
const versionAbove = (left, right) => {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
};
const hasVersion = (value) => typeof value === 'string' && value.trim().length > 0;
const wipeVersionRises = (before, after) => hasVersion(after) && (!hasVersion(before) || versionAbove(after, before));
// Issue #705 review: a MAXIMUM wipe version wipes devices above it, so one that
// is new or lower wipes more.
const wipeVersionFalls = (before, after) => hasVersion(after) && (!hasVersion(before) || versionAbove(before, after));

// Issue #705: iOS and Android app protection (managedAppPolicy).
/** An ISO 8601 duration (P90D, PT12H) in days, or null when unreadable. */
function isoDurationDays(value) {
  const match = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(value ?? ''));
  if (!match || value === 'P' || String(value).endsWith('T')) return null;
  const [, y, mo, w, d, h, mi, sec] = match.map((part) => Number(part ?? 0));
  return y * 365 + mo * 30 + w * 7 + d + h / 24 + mi / 1440 + sec / 86400;
}
const hasValue = (value) => value !== null && value !== undefined && value !== '';
// The offline period after which the app's work data is wiped. Zero or absent
// means no wipe. Introducing one, or shortening it, wipes data sooner. An
// unreadable period is treated as shorter: the safe direction.
const offlineWipeTightens = (before, after) => {
  if (!hasValue(after)) return false;
  const a = isoDurationDays(after);
  if (a === null) return true;
  if (a <= 0) return false;
  if (!hasValue(before)) return true;
  const b = isoDurationDays(before);
  return b === null || b <= 0 || a < b;
};
// Where work data may be copied, narrowest to widest. Absent means no
// protection policy, which restricts nothing, so only a change from a known
// level is judged: a new policy only ever narrows.
const CLIPBOARD_SHARING = ['blocked', 'managedApps', 'managedAppsWithPasteIn', 'allApps'];
const clipboardWidens = (before, after) => hasValue(before) && widens(CLIPBOARD_SHARING)(before, after);
const DATA_TRANSFER_DESTINATIONS = ['none', 'managedApps', 'allApps'];
const transferWidens = (before, after) => hasValue(before) && widens(DATA_TRANSFER_DESTINATIONS)(before, after);
const increasesFromKnown = (before, after) => typeof before === 'number' && typeof after === 'number' && after > before;
// Every action field (appActionIf..., and the threat defense remediation) set to
// wipe. Read by name, so an action Graph adds later is judged too.
const isAppActionField = (key) => key.startsWith('appActionIf') || key === 'mobileThreatDefenseRemediationAction';
const appActionsThatWipe = (payload) => Object.entries(payload ?? {})
  .filter(([key, value]) => isAppActionField(key) && String(value).toLowerCase() === 'wipe')
  .map(([key]) => key).sort();

/** groupSetting stores its values as [{ name, value }]; address one by name. */
const settingValue = (name) => (payload) => payload?.values?.find?.((entry) => entry?.name === name)?.value;

function valueAt(payload, path) {
  return path.split('.').reduce((value, key) => value?.[key], payload);
}

const rule = (field, effect, when, read = (payload) => valueAt(payload, field), detail = null) => Object.freeze({ field, effect, when, read, detail });

// PR #435 follow-up: a script body compares by its full sha256, so the effect (and
// the digest an approval binds to) names exactly this text without holding it. A
// live body that was not read reads as null: a difference, the safe direction.
const scriptBody = (field) => (payload) => {
  const value = payload?.[field];
  if (typeof value !== 'string' || value.length === 0) return null;
  return `${scriptText(value).length} characters, sha256 ${scriptFingerprint(value, { full: true })}`;
};
const bodyChanges = (before, after) => after !== null && before !== after;
// The text itself, for the people who review the restore (restore and approve holders).
const scriptDetail = (field) => (before, after) => ({ before: scriptText(before?.[field]), after: scriptText(after?.[field]) });

// Restore gaps batch 18: a Win32 app's command lines are plain text; its
// detection and requirement scripts are base64 inside its rules (each of the
// three lists Graph may return), compared by their full sha256.
const commandLine = (field) => (payload) => (typeof payload?.[field] === 'string' && payload[field].length > 0 ? payload[field] : null);
const commandDetail = (field) => (before, after) => ({ before: before?.[field] ?? null, after: after?.[field] ?? null });
function appRuleScriptText(payload) {
  const lists = ['rules', 'detectionRules', 'requirementRules'].map((field) => (Array.isArray(payload?.[field]) ? payload[field] : []));
  const first = lists.find((list) => list.some((item) => typeof item?.scriptContent === 'string' && item.scriptContent.length > 0)) ?? [];
  const scripts = first.map((item) => item?.scriptContent).filter((value) => typeof value === 'string' && value.length > 0);
  return scripts.length > 0 ? scripts.map((value) => scriptText(value)).join('\n\n') : null;
}
const appRuleScripts = (payload) => {
  const text = appRuleScriptText(payload);
  return text === null ? null : `${text.length} characters, sha256 ${scriptFingerprint(text, { full: true })}`;
};
const appRuleScriptDetail = (before, after) => ({ before: appRuleScriptText(before), after: appRuleScriptText(after) });

/**
 * Reviewed types and their dangerous transitions. Field names follow Microsoft
 * Graph's resource schemas. They were declared from those schemas, not measured
 * against a tenant (see docs/roadmap/content-effects.md).
 */
export const CONTENT_EFFECT_RULES = Object.freeze({
  group: { reviewed: true, rules: [
    rule('visibility', 'externally-sharing', becomes('Public')),
  ] },
  groupSetting: { reviewed: true, rules: [
    rule('values[AllowGuestsToAccessGroups]', 'externally-sharing', disabledToEnabled, settingValue('AllowGuestsToAccessGroups')),
    rule('values[AllowToAddGuests]', 'externally-sharing', disabledToEnabled, settingValue('AllowToAddGuests')),
  ] },
  authorizationPolicy: { reviewed: true, rules: [
    rule('allowInvitesFrom', 'externally-sharing', widens(INVITE_SCOPE)),
  ] },
  crossTenantAccessPolicyPartner: { reviewed: true, rules: [
    rule('b2bCollaborationInbound.usersAndGroups.accessType', 'externally-sharing', becomes('allowed')),
    rule('b2bCollaborationOutbound.usersAndGroups.accessType', 'externally-sharing', becomes('allowed')),
    rule('b2bDirectConnectOutbound.usersAndGroups.accessType', 'externally-sharing', becomes('allowed')),
  ] },
  retentionLabel: { reviewed: true, onDelete: 'retention-reducing', rules: [
    rule('retentionDuration.days', 'retention-reducing', decreases),
    rule('actionAfterRetentionPeriod', 'irreversible', becomes('delete')),
  ] },
  ediscoveryHoldPolicy: { reviewed: true, onDelete: 'hold-releasing', rules: [
    rule('isEnabled', 'hold-releasing', enabledToDisabled),
  ] },
  // Reviewed with nothing content-bearing: access configuration only. CA writes
  // stay forced report-only by applyEngine.mjs, exactly as before.
  // Task-103: SharePoint tenant sharing settings (Graph sharepointSettings).
  // Widening external sharing, re-enabling resharing, dropping the domain
  // restriction (allowList < blockList < none), unblocking a domain or allowing a new one all expose content.
  sharepointTenantSettings: { reviewed: true, rules: [
    rule('sharingCapability', 'externally-sharing', widens(SHAREPOINT_SHARING)),
    rule('isResharingByExternalUsersEnabled', 'externally-sharing', disabledToEnabled),
    rule('sharingDomainRestrictionMode', 'externally-sharing', widens(['allowList', 'blockList', 'none'])),
    rule('sharingBlockedDomainList', 'externally-sharing', removesEntry),
    rule('sharingAllowedDomainList', 'externally-sharing', addsEntry),
  ] },
  // Gap 5: a SharePoint site app grant (Sites.Selected). Creating one, or raising
  // its role, gives an application access to the site's content.
  sharepointSiteAppGrant: { reviewed: true, judgesCreates: true, rules: [
    rule('roles', 'externally-sharing', raisesSiteRole),
  ] },
  // Gap 4: a SharePoint group member, site collection admin or role assignment put
  // back on a site. Each gives a person or group access to the site's content; a new
  // empty group or permission level gives no one anything (grantsAccess false).
  sharepointSitePermission: { reviewed: true, judgesCreates: true, rules: [
    rule('grantsAccess', 'externally-sharing', becomes(true)),
  ] },
  // Task-104: Teams team settings. Giving guests channel rights, or making a team
  // discoverable to everyone, widens who reaches the team's content.
  teamsTeamSettings: { reviewed: true, rules: [
    rule('guestSettings.allowCreateUpdateChannels', 'externally-sharing', disabledToEnabled),
    rule('guestSettings.allowDeleteChannels', 'externally-sharing', disabledToEnabled),
    rule('discoverySettings.showInTeamsSearchAndSuggestions', 'externally-sharing', disabledToEnabled),
  ] },
  // Task-104: Teams membership, as { guests: [identity...] }. Adding a guest gives
  // someone outside the organization access to the team's content.
  teamsMembership: { reviewed: true, rules: [
    rule('guests', 'externally-sharing', addsEntry),
  ] },
  // Task-105: Exchange mailbox and organization configuration. Turning a hold off
  // releases mail to deletion; turning single item recovery off or shortening the
  // deleted-item window lets mail be purged sooner; sending automatic replies to
  // everyone outside discloses the reply text externally.
  exchangeMailboxRetention: { reviewed: true, rules: [
    rule('LitigationHoldEnabled', 'hold-releasing', enabledToDisabled),
    rule('RetentionHoldEnabled', 'hold-releasing', enabledToDisabled),
    rule('SingleItemRecoveryEnabled', 'retention-reducing', enabledToDisabled),
    rule('RetainDeletedItemsFor', 'retention-reducing', shortensTimespan),
  ] },
  exchangeMailboxSettings: { reviewed: true, rules: [
    rule('automaticRepliesSetting.externalAudience', 'externally-sharing', widens(AUTOREPLY_AUDIENCE)),
  ] },
  // Protocol access and organization mail tips change how mail is reached, not who
  // can see it or how long it is kept.
  exchangeClientAccess: { reviewed: true, rules: [] },
  exchangeOrganizationConfig: { reviewed: true, rules: [] },
  // Task-106: Purview sensitivity labels. KEEL writes only a label's display text
  // and adds labels to a policy; neither changes who can see content or how long it
  // is kept. A label or policy that reports a preservation lock is refused by the
  // lock check above, before these rules.
  purviewLabel: { reviewed: true, rules: [] },
  purviewLabelPolicy: { reviewed: true, rules: [] },
  conditionalAccessPolicy: { reviewed: true, rules: [] },
  namedLocation: { reviewed: true, rules: [] },
  roleAssignment: { reviewed: true, rules: [] },
  // Live gate Q45 steps 11, 13, 14: application create and restore were refused
  // by the field-name heuristic for `publicClient` and `isFallbackPublicClient`.
  // Reviewed (every field in the application field projection) and found to be
  // sign-in configuration only, with no content effect: publicClient and spa/web
  // redirect URIs, isFallbackPublicClient (token flows without a secret),
  // signInAudience (who may sign in to the app, never who sees this tenant's
  // content), identifierUris, api scopes, appRoles, optionalClaims and
  // requiredResourceAccess (declared permissions; nothing is granted until a
  // separate consent). Credentials never reach a write body (fieldProjection).
  // The restore keeps its own access-affecting approval, as before.
  application: { reviewed: true, rules: [] },
  // Issue #700: an access package catalog. Reviewed (every field the restore
  // writes: displayName, description, state, catalogType, isExternallyVisible). Making it
  // externally visible lets users outside the organization request its access
  // packages, and through them reach the groups, apps and sites they grant, so
  // false -> true needs the separate approval. A recreated catalog is judged too
  // (judgesCreates): restoring it visible exposes it from the moment it exists,
  // while restoring false (not visible) is no effect.
  accessPackageCatalog: { reviewed: true, judgesCreates: true, rules: [
    rule('isExternallyVisible', 'externally-sharing', disabledToEnabled),
  ] },
  // Issue #155: Intune policies. These rules land on DEVICE content, which a
  // policy reaches as soon as it is assigned, whether the policy is new or
  // changed, so these three types judge creates too (judgesCreates). Reviewed
  // and found to be configuration only, not content effects: hotspot and
  // tethering (internetSharingBlocked), app data shared between users of a
  // device (sharedUserAppDataAllowed), work-profile data sharing, storage and
  // removable-media blocks, iCloud backup blocks, and factoryResetBlocked (which
  // PREVENTS a reset). The compliance "block" and "notification" actions, and
  // remoteLock, keep data on the device.
  //  - A compliance policy whose noncompliance actions gain a wipe (factory
  //    reset) or a retire (company data removed) destroys device content.
  //  - A device configuration that introduces or lowers a failed-sign-in wipe
  //    threshold (iOS, Android, Android work profile, Windows) wipes devices
  //    after fewer attempts. A shared PC profile that deletes cached accounts at
  //    sign-out destroys their local data; one that deletes them after fewer
  //    inactive days keeps that data for less time.
  //  - A settings catalog policy is an opaque list of definition ids whose
  //    meaning KEEL cannot read in general; the one wipe setting it knows
  //    (DeviceLock/MaxDevicePasswordFailedAttempts) is classified like the
  //    profile thresholds. Other catalog settings are not classified (doc).
  deviceCompliancePolicy: { reviewed: true, judgesCreates: true, rules: [
    rule('scheduledActionsForRule[actionType]', 'irreversible', addsDeviceDestroyingAction, complianceActionTypes),
  ] },
  // Restore gaps batch 7: settings catalog compliance policies hold the same
  // actions for noncompliance; their settings only judge compliance.
  deviceManagementCompliancePolicy: { reviewed: true, judgesCreates: true, rules: [
    rule('scheduledActionsForRule[actionType]', 'irreversible', addsDeviceDestroyingAction, complianceActionTypes),
  ] },
  deviceConfiguration: { reviewed: true, judgesCreates: true, rules: [
    rule('passcodeSignInFailureCountBeforeWipe', 'irreversible', wipeThresholdTightens),
    rule('passwordSignInFailureCountBeforeFactoryReset', 'irreversible', wipeThresholdTightens),
    rule('workProfilePasswordSignInFailureCountBeforeFactoryReset', 'irreversible', wipeThresholdTightens),
    rule('accountManagerPolicy.accountDeletionPolicy', 'irreversible', becomes('immediately')),
    rule('accountManagerPolicy.inactiveThresholdDays', 'retention-reducing', decreases),
  ] },
  // Gap D3: group expiration deletes Microsoft 365 groups (and their mail,
  // files and chats) that nobody renews in time. Three directions make that
  // happen to more groups: a shorter lifetime, expiry that covers more groups
  // (None < Selected < All), and a renewal notice address the restore drops
  // (groups without an owner are then not renewed). The restore guard writes
  // each only with its approval (tenantPolicyOperations.mjs groupLifecycleReview);
  // a value it cannot compare is never written.
  groupLifecyclePolicy: { reviewed: true, rules: [
    rule('groupLifetimeInDays', 'retention-reducing', decreases),
    rule('managedGroupTypes', 'retention-reducing', widensGroupExpiry),
    rule('alternateNotificationEmails', 'retention-reducing', dropsNoticeAddress),
  ] },
  configurationPolicy: { reviewed: true, judgesCreates: true, rules: [
    rule(`settings[${CATALOG_WIPE_THRESHOLD}]`, 'irreversible', wipeThresholdTightens, catalogSetting(CATALOG_WIPE_THRESHOLD)),
  ] },
  // Restore gaps batch 12: Windows app protection (Edge on unmanaged devices).
  // Reviewed (every field of the beta resource): the data transfer, clipboard,
  // print and threat level settings only restrict where work data may go, and
  // the required and warning versions block or warn, keeping the data. What
  // removes work data from the app is a wipe: a minimum wipe version that is
  // new or higher, a maximum wipe OS version that is new or lower, an offline
  // period before wipe that is new or shorter (compared as durations, so
  // PT2160H equals P90D; P0D means no wipe), or an action that becomes
  // "wipe". Issue #461: a restore assigns a
  // recreated policy too, so a create that is assigned is judged.
  windowsManagedAppProtection: { reviewed: true, judgesCreates: 'when-assigned', rules: [
    rule('minimumWipeAppVersion', 'irreversible', wipeVersionRises),
    rule('minimumWipeOsVersion', 'irreversible', wipeVersionRises),
    rule('minimumWipeSdkVersion', 'irreversible', wipeVersionRises),
    rule('maximumWipeOsVersion', 'irreversible', wipeVersionFalls),
    rule('appActionIfUnableToAuthenticateUser', 'irreversible', becomes('wipe')),
    rule('mobileThreatDefenseRemediationAction', 'irreversible', becomes('wipe')),
    rule('periodOfflineBeforeWipeIsEnforced', 'irreversible', offlineWipeTightens),
  ] },
  // Issue #705: app protection, written whole by the managedAppPolicy writer
  // (engine/restore/intuneOperations.mjs), which creates the iOS and Android
  // kinds. Reviewed (every field of the v1.0 iOS and Android resources):
  //  - What removes work data from the app is a wipe: an offline period before
  //    wipe that is new or shorter, a minimum wipe version that is new or
  //    higher, a maximum wipe OS version that is new or lower, a Company Portal
  //    deferral before wipe that is new or shorter, or an action that becomes
  //    "wipe". Irreversible.
  //  - The two levels that decide which apps work data may go to (send/open-in
  //    destinations and clipboard), widened on an existing policy, plus a
  //    longer clipboard exception, let it leave the managed apps:
  //    externally-sharing. Not on create: a new policy only ever narrows them.
  //  - The finer restriction toggles (save-as and storage locations, backup,
  //    print, exempted apps and protocols, open-in filtering), PIN, encryption
  //    and the required and warning versions are configuration, as in the
  //    Windows review above.
  // A restore assigns a recreated policy too (issue #461), so a create that is
  // assigned is judged. A delete of a policy that is still assigned is refused
  // by the writer (DELETE_POLICY), so deletes carry no effect here.
  managedAppPolicy: { reviewed: true, judgesCreates: 'when-assigned', rules: [
    rule('periodOfflineBeforeWipeIsEnforced', 'irreversible', offlineWipeTightens),
    rule('minimumWipeOsVersion', 'irreversible', wipeVersionRises),
    rule('minimumWipeAppVersion', 'irreversible', wipeVersionRises),
    rule('minimumWipeSdkVersion', 'irreversible', wipeVersionRises),
    rule('minimumWipePatchVersion', 'irreversible', wipeVersionRises),
    rule('minimumWipeCompanyPortalVersion', 'irreversible', wipeVersionRises),
    rule('maximumWipeOsVersion', 'irreversible', wipeVersionFalls),
    rule('wipeAfterCompanyPortalUpdateDeferralInDays', 'irreversible', wipeThresholdTightens),
    rule('appActionIf* (actions that wipe)', 'irreversible', addsEntry, appActionsThatWipe),
    rule('allowedOutboundDataTransferDestinations', 'externally-sharing', transferWidens),
    rule('allowedOutboundClipboardSharingLevel', 'externally-sharing', clipboardWidens),
    rule('allowedOutboundClipboardSharingExceptionLength', 'externally-sharing', increasesFromKnown),
  ] },
  // Restore gaps batch 13: a link between two Intune apps. Reviewed (every
  // field of both beta kinds): a dependency installs or detects another app,
  // and an "update" supersedence upgrades in place, both keeping app data. A
  // supersedence set to "replace" uninstalls the older app on every device the
  // newer one is assigned to, with its local data, so it is judged on create too.
  mobileAppRelationship: { reviewed: true, judgesCreates: true, rules: [
    rule('supersedenceType', 'irreversible', becomes('replace')),
  ] },
  // Restore gaps batch 18: Intune apps. Reviewed (every field of the app kinds
  // KEEL writes, engine/restore/intuneAppKinds.mjs): a Win32 app's install and
  // uninstall commands and its detection and requirement scripts run on every
  // device the app is assigned to, with administrator rights, so changing them
  // on an existing app needs the separate approval, showing the text. Telling
  // Microsoft 365 Apps to remove older Office versions uninstalls them from
  // those devices. A recreated app, or one a restore assigns to more devices, is
  // judged for those devices as if new (issue #461); assignments the restore
  // holds back (no package, uninstall) reach no one, so they are not judged.
  mobileApp: { reviewed: true, judgesCreates: 'when-assigned', rules: [
    rule('installCommandLine', 'runs-on-devices', bodyChanges, commandLine('installCommandLine'), commandDetail('installCommandLine')),
    rule('uninstallCommandLine', 'runs-on-devices', bodyChanges, commandLine('uninstallCommandLine'), commandDetail('uninstallCommandLine')),
    rule('rules (detection and requirement scripts)', 'runs-on-devices', bodyChanges, appRuleScripts, appRuleScriptDetail),
    rule('shouldUninstallOlderVersionsOfOffice', 'irreversible', disabledToEnabled),
  ] },
  // PR #435 follow-up: Intune scripts and remediations. An update that changes a
  // script's text pushes that text to every device the script is assigned to, so it
  // needs the separate approval, showing the text. Which devices it is assigned to
  // is not read here, so every such update is judged as reaching devices. Issue
  // #461: a restore also assigns scripts (batch 14), so a recreated script that is
  // assigned is judged, and so is an existing one assigned to more devices.
  ...Object.fromEntries(Object.entries(SCRIPT_BODY_FIELDS).map(([resourceType, fields]) => [resourceType, {
    reviewed: true,
    judgesCreates: 'when-assigned',
    rules: fields.map((field) => rule(field, 'runs-on-devices', bodyChanges, scriptBody(field), scriptDetail(field))),
  }])),
});

/**
 * Restore approvals: the settings a restore used to write in one direction only.
 * A backup that loosens one of these, or turns on something that acts by itself,
 * was always left for a person. It is now an effect like the ones above: the
 * customer's restore approval setting decides whether a second person approves it
 * first, and the writer sends it only when the promotion checked that approval (or
 * the setting is off). Judged on every type, reviewed or not, and only in the
 * direction the writer used to refuse. Each `when` mirrors that writer's old test.
 * The lockout gate, preservation locks and the trust-field rule are not here: they
 * hold whatever this says.
 */
const isValue = (loose) => (value) => (typeof loose === 'string' ? String(value ?? '').toLowerCase() === loose : value === loose);
// Admin center settings: the backup holds the loose value and live does not (fails closed when live lacks it).
const loosensTo = (loose) => (before, after) => isValue(loose)(after) && !isValue(loose)(before);
// SharePoint settings: whenever live holds the field (null included), exactly as the writer tests it.
const loosensFromKnown = (loose) => (before, after) => after === loose && before !== undefined && before !== loose;
const turnsOn = (before, after) => after === true && before !== true;
const turnsTrueToFalse = (before, after) => after === false && before === true;
const turnsFalseToTrue = (before, after) => after === true && before === false;

export const PROTECTION_EFFECT_RULES = Object.freeze({
  // Entra: SharePoint tenant settings (identityObjectOperations, sharepointAccessRefusal).
  sharepointSettings: { rules: [
    rule('isLegacyAuthProtocolsEnabled', 'weakens-protection', loosensFromKnown(true)),
    rule('isUnmanagedSyncAppForTenantRestricted', 'weakens-protection', loosensFromKnown(false)),
    rule('isRequireAcceptingUserToMatchInvitedUserEnabled', 'weakens-protection', loosensFromKnown(false)),
  ] },
  // Microsoft 365 admin center settings (identityObjectOperations, adminCenterLooseningRefusal).
  formsSettings: { rules: [
    rule('settings.isExternalSendFormEnabled', 'externally-sharing', loosensTo(true)),
    rule('settings.isExternalShareCollaborationEnabled', 'externally-sharing', loosensTo(true)),
    rule('settings.isExternalShareResultEnabled', 'externally-sharing', loosensTo(true)),
    rule('settings.isExternalShareTemplateEnabled', 'externally-sharing', loosensTo(true)),
    rule('settings.isInOrgFormsPhishingScanEnabled', 'weakens-protection', loosensTo(false)),
  ] },
  appsAndServicesSettings: { rules: [
    rule('settings.isOfficeStoreEnabled', 'weakens-protection', loosensTo(true)),
  ] },
  adminReportSettings: { rules: [
    rule('displayConcealedNames', 'weakens-protection', loosensTo(false)),
  ] },
  engageCommunity: { rules: [
    rule('privacy', 'externally-sharing', loosensTo('public')),
  ] },
  // Lifecycle workflows are created off, and an update never turned one on.
  lifecycleWorkflow: { judgesCreates: true, rules: [
    rule('isEnabled', 'acts-on-accounts', turnsOn),
    rule('isSchedulingEnabled', 'acts-on-accounts', turnsOn),
  ] },
  // PIM role settings: each reviewed rule the backup would weaken (adminRoleOperations, ruleWeakening).
  unifiedRoleManagementPolicy: { rules: [], effects: (before, after) => pimRuleWeakenings(after, before)
    .map(({ ruleId, before: from, after: to }) => ({ field: `rules[${ruleId}]`, effect: 'weakens-protection', before: from, after: to })) },
  // Whether a service principal can sign in (identityObjectOperations, servicePrincipalRefusal).
  // The writer's lockout checks still hold: KEEL's own apps, a Microsoft application
  // and a managed identity are never turned off.
  servicePrincipal: { rules: [
    rule('accountEnabled', 'weakens-protection', turnsFalseToTrue),
    rule('accountEnabled', 'blocks-sign-in', turnsTrueToFalse),
  ] },
  // Intune tenant switches (intuneOperations).
  onPremisesConditionalAccessSettings: { rules: [
    rule('enabled', 'acts-on-accounts', turnsOn),
  ] },
  deviceManagementSettings: { rules: [
    rule('settings.secureByDefault', 'weakens-protection', turnsTrueToFalse),
  ] },
  hardwareConfiguration: { rules: [
    rule('perDevicePasswordDisabled', 'weakens-protection', turnsFalseToTrue),
  ] },
});

/**
 * The protection effects of one planned write ({ naturalKey, resourceType, verb,
 * payload, live }), each with its disclosure. Empty for a type with no rules.
 */
export function protectionEffects(resource) {
  const { naturalKey, resourceType, verb } = resource;
  const spec = PROTECTION_EFFECT_RULES[resourceType];
  if (!spec || !verb || verb === 'noop' || verb === 'delete') return [];
  const before = resource.live?.state === undefined || resource.live?.state === 'present' || resource.live?.state === 'soft-deleted'
    ? (resource.live?.payload ?? null) : null;
  const after = resource.payload ?? null;
  if (!after || (!before && !spec.judgesCreates)) return [];
  const found = [];
  for (const entry of spec.rules) {
    const b = entry.read(before ?? {});
    const a = entry.read(after);
    if (JSON.stringify(b ?? null) === JSON.stringify(a ?? null) || !entry.when(b, a)) continue;
    found.push({ field: entry.field, effect: entry.effect, before: b ?? null, after: a ?? null });
  }
  if (spec.effects && before) found.push(...spec.effects(before, after));
  return found.map((item) => ({ naturalKey, resourceType, ...item, disclosure: disclosureFor(item.effect) }));
}

/** True when `approved` (effects whose approval the promotion checked) holds exactly this effect. */
export function effectApproved(effect, approved = []) {
  return (approved ?? []).some((entry) => entry?.effect === effect.effect && entry.naturalKey === effect.naturalKey
    && entry.field === effect.field && canonical(entry.before) === canonical(effect.before) && canonical(entry.after) === canonical(effect.after));
}

/**
 * Whether a writer that found a loose direction may send it: in a dry run (which
 * only simulates), or when the write has protection effects and every one of them
 * was approved. Fails closed: a loose direction with no effect to approve is held.
 */
export function protectionChangeApproved(resource, verb, { mode = 'enforce', approvedContentEffects = [] } = {}) {
  if (mode === 'dry-run') return true;
  const effects = protectionEffects({ ...resource, verb });
  return effects.length > 0 && effects.every((effect) => effectApproved(effect, approvedContentEffects));
}

/** The words a refusal adds when a loose direction waits for its approval. */
export const PROTECTION_APPROVAL_STEP = 'a second person approves it as a high-impact change in Approvals (or an admin turns restore approvals off for this service), then the restore runs again';

// A changed leaf whose NAME suggests content consequences, on a type with no
// review, is refused until classified.
const DANGEROUS_FIELD = /retention|hold|preserv|shar(e|ing)|guest|external|invite|wipe|purge|anonymous|public/i;
// Platform preservation lock markers. Declared, not measured (see the doc).
const LOCK_FIELDS = ['isPreservationLocked', 'preservationLock', 'restrictiveRetention'];

function changedLeaves(before, after, prefix = '') {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changed = [];
  for (const key of keys) {
    if (key.startsWith('@odata')) continue;
    const b = before?.[key];
    const a = after?.[key];
    const path = prefix ? `${prefix}.${key}` : key;
    const bothObjects = b && a && typeof b === 'object' && typeof a === 'object' && !Array.isArray(b) && !Array.isArray(a);
    if (bothObjects) changed.push(...changedLeaves(b, a, path));
    else if (JSON.stringify(b ?? null) !== JSON.stringify(a ?? null)) changed.push(path);
  }
  return changed;
}

function isPreservationLocked(payload) {
  return LOCK_FIELDS.some((field) => truthy(payload?.[field]));
}

const READ_ASSIGNMENTS = new Set(['complete', 'complete-empty']);
/**
 * Issue #461: who a restore's assignment write newly reaches, sorted, or null when
 * no one. A restore plan says so itself (`newAssignments`, attachIntuneAssignments).
 * A resource that carries assignments without that answer is judged as reaching
 * every include target it is assigned to: the safe direction.
 */
function assignmentReach(resource) {
  if (Array.isArray(resource.newAssignments)) return resource.newAssignments.length > 0 ? [...resource.newAssignments].sort() : null;
  const desired = resource.assignments;
  if (!desired || !READ_ASSIGNMENTS.has(desired.outcome)) return null;
  const labels = (desired.targets ?? [])
    .filter((target) => target?.attributes?.targetType !== 'exclusionGroupAssignmentTarget')
    .map((target) => String(target?.targetNaturalKey ?? target?.attributes?.targetType ?? 'a target of unknown kind'));
  return labels.length > 0 ? [...new Set(labels)].sort() : null;
}

/**
 * Classifies the planned writes. `resources` are reconciled restore resources
 * ({ naturalKey, resourceType, verb, payload, live }). Returns ordered
 * `effects` (each with its disclosure) and `refusals` (unclassified dangerous
 * transitions and preservation locks).
 */
export function classifyContentEffects(resources) {
  const effects = [];
  const refusals = [];
  for (const resource of resources) {
    const { naturalKey, resourceType, verb } = resource;
    if (!verb || verb === 'noop') continue;
    const before = resource.live?.state === 'present' || resource.live?.state === 'soft-deleted' ? resource.live.payload : null;
    const after = verb === 'delete' ? null : resource.payload;

    if (before && isPreservationLocked(before) && (verb === 'update' || verb === 'delete')) {
      refusals.push({ naturalKey, reason: `preservation-locked: ${resourceType} is under a platform preservation lock — KEEL never changes or deletes it` });
      continue;
    }

    effects.push(...protectionEffects(resource));
    const review = CONTENT_EFFECT_RULES[resourceType];
    if (review?.reviewed) {
      if (verb === 'delete' && review.onDelete) {
        effects.push({ naturalKey, resourceType, field: '(object deleted)', effect: review.onDelete, before: 'present', after: 'deleted', disclosure: disclosureFor(review.onDelete) });
        continue;
      }
      if (!after) continue;
      // Issue #461: who the restore's assignment write reaches that the object does
      // not reach now (attachIntuneAssignments). Those devices get the object as if
      // it were new, so a type whose effects land on devices judges its rules from
      // nothing for them, even when the setting itself does not change.
      const reach = review.judgesCreates ? assignmentReach(resource) : null;
      // A create starts from nothing, so no existing content changes reach,
      // unless the type's effects land on content outside the object (devices).
      // 'when-assigned': only when the restore also assigns it to someone.
      if (!before && (!review.judgesCreates || (review.judgesCreates === 'when-assigned' && !reach))) continue;
      for (const entry of review.rules) {
        const b = entry.read(before ?? {});
        const a = entry.read(after);
        const changes = JSON.stringify(b ?? null) !== JSON.stringify(a ?? null) && entry.when(b, a);
        if (!changes && !(reach && entry.when(entry.read({}), a))) continue; // unchanged and reaches no one new: benign
        effects.push({
          naturalKey, resourceType, field: entry.field, effect: entry.effect, before: b ?? null, after: a ?? null, disclosure: disclosureFor(entry.effect),
          ...(reach ? { newAssignments: reach } : {}),
          ...(entry.detail ? { script: entry.detail(before, after) } : {}),
        });
      }
      continue;
    }

    // Unreviewed type: any changed content-bearing field refuses until classified.
    // A field a protection rule reviews is judged by that rule, not by its name.
    const reviewedHere = new Set((PROTECTION_EFFECT_RULES[resourceType]?.rules ?? []).map((entry) => entry.field));
    const changed = changedLeaves(before ?? {}, after ?? {})
      .filter((path) => DANGEROUS_FIELD.test(path.split('.').pop()) && !reviewedHere.has(path));
    if (changed.length > 0) {
      refusals.push({
        naturalKey,
        reason: `unclassified-content-effect: ${resourceType} changes ${changed.join(', ')}, which may affect retention, holds or sharing — refused until a content-effect rule classifies it`,
      });
    }
  }
  const order = (e) => `${e.naturalKey}|${e.field}`;
  effects.sort((left, right) => order(left).localeCompare(order(right)));
  return { effects, refusals };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

/** The identity of a set of effects. An approval is bound to exactly this. */
export function contentEffectsDigest(effects) {
  // Who an assignment write newly reaches is bound too (issue #461), only when
  // present, so every effect without it keeps its digest.
  const bound = effects.map(({ naturalKey, resourceType, field, effect, before, after, newAssignments }) => ({
    naturalKey, resourceType, field, effect, before, after, ...(newAssignments ? { newAssignments } : {}),
  }));
  return createHash('sha256').update(canonical(bound)).digest('hex');
}

/** True when a Graph failure is the platform refusing a preservation-locked object. */
export function isPreservationLockFailure(result) {
  const text = JSON.stringify(result?.body ?? result?.error ?? '');
  return /preservation\s*lock|PreservationLock|restrictive\s*retention/i.test(text);
}

export class ContentEffectApprovalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContentEffectApprovalError';
  }
}

/**
 * Records the separate high-impact approval for an artifact's content effects.
 * The approver must currently hold `approve` and must not be the requester.
 * Bound to the effects digest the approver actually reviewed.
 */
// Grants are windowed by the database clock; check them against it (a JS Date
// truncates to milliseconds and can read a just-made grant as not yet active).
// Read as text: pg would hand back a millisecond JS Date and reintroduce the gap.
async function databaseNow(client) {
  const { rows } = await client.query('SELECT now()::text AS now');
  return rows[0].now;
}

export async function approveContentEffects(client, { tenantRef, artifactId, approverId, effectsDigest, justification, at: requestedAt = undefined }) {
  const at = requestedAt ?? await databaseNow(client);
  const { rows: artifacts } = await client.query(
    `SELECT id, requested_by, content_effects FROM restore_dry_run WHERE id::text = $1 AND tenant_ref = $2`,
    [artifactId, tenantRef],
  );
  const artifact = artifacts[0];
  if (!artifact) throw new ContentEffectApprovalError('dry-run artifact not found');
  const effects = artifact.content_effects ?? [];
  if (effects.length === 0) throw new ContentEffectApprovalError('this dry run has no content effects to approve');
  if (contentEffectsDigest(effects) !== effectsDigest) {
    throw new ContentEffectApprovalError('the reviewed content effects no longer match the dry run — review them again');
  }
  if (typeof justification !== 'string' || justification.trim().length === 0) {
    throw new ContentEffectApprovalError('a content-effect approval requires a justification');
  }
  const approver = await findPrincipalById(client, approverId);
  if (!approver || !(await can(client, approver, 'approve', at))) {
    throw new ContentEffectApprovalError('only a principal currently holding approve can approve content effects');
  }
  // Approval mode (govern/approvalMode.mjs): the requester approves their own content
  // effects only in solo mode, and the approval says it was self-approved.
  const selfApproved = String(artifact.requested_by) === String(approverId);
  if (selfApproved && !(await selfApprovalAllowed(client, { tenantRef }))) {
    throw new ContentEffectApprovalError('content effects must be approved by someone other than the requester while approvals need two people');
  }
  if (selfApproved) {
    const problem = selfApprovalReasonProblem(justification);
    if (problem) throw new ContentEffectApprovalError(problem);
  }
  const { rows } = await client.query(
    `INSERT INTO content_effect_approval (tenant_ref, artifact_id, effects_digest, approved_by, justification, approved_at, self_approved)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (artifact_id, effects_digest, approved_by) DO UPDATE SET justification = content_effect_approval.justification
     RETURNING *`,
    [tenantRef, artifact.id, effectsDigest, approverId, justification.trim(), at, selfApproved],
  );
  await appendEvidence(client, {
    tenantRef,
    kind: CONTENT_EFFECT_APPROVAL_EVIDENCE_KIND,
    subject: {
      artifactId: artifact.id, effectsDigest, effects: effects.map(({ naturalKey, field, effect }) => ({ naturalKey, field, effect })),
      ...(selfApproved ? { selfApproved: true, approvalMode: 'solo' } : {}),
    },
    actor: approverId,
  });
  return rows[0];
}

/**
 * Promotion gate: the CURRENT effects must carry a current, separate approval
 * bound to their digest. Returns the approval used; throws otherwise.
 */
export async function assertContentEffectApproval(client, { artifact, effects, at: requestedAt = undefined }) {
  if (effects.length === 0) return null;
  // The customer's restore approval setting: when every effect's service has the
  // approval turned off, the effects are made with the restore. The record says so,
  // so the caller can treat them as cleared (a shorter group lifetime is written).
  const need = await effectsNeedApproval(client, { tenantRef: artifact.tenantRef, effects });
  if (!need.required) {
    return Object.freeze({ notRequired: true, services: need.waived, effectsDigest: contentEffectsDigest(effects) });
  }
  const at = requestedAt ?? await databaseNow(client);
  const digest = contentEffectsDigest(effects);
  const { rows } = await client.query(
    `SELECT * FROM content_effect_approval
      WHERE artifact_id::text = $1 AND effects_digest = $2 AND revoked_at IS NULL
      ORDER BY approved_at DESC`,
    [artifact.id, digest],
  );
  // A self-approval counts only while the approval mode is still solo.
  const soloNow = await selfApprovalAllowed(client, { tenantRef: artifact.tenantRef });
  for (const approval of rows) {
    if (String(approval.approved_by) === String(artifact.requestedBy) && !soloNow) continue;
    const approver = await findPrincipalById(client, approval.approved_by);
    if (approver && await can(client, approver, 'approve', at)) return approval;
  }
  throw new ContentEffectApprovalError(
    `blocked-content-effect: ${effects.length} content effect(s) (${[...new Set(effects.map((e) => e.effect))].join(', ')}) need a separate, current high-impact approval of exactly these effects. `
    + `${soloNow ? 'An approver' : 'Someone other than the requester'} approves them in the portal: Approvals, then "Review content effects" on this restore (${contentEffectsReviewPath(artifact.id)}). Then run the restore again.`,
  );
}

/**
 * Q45: where the portal shows and approves a dry run's content effects, whichever
 * surface (portal or CLI --persist-artifact) made the dry run.
 */
export function contentEffectsReviewPath(artifactId) {
  return `/approvals/content-effects/${artifactId}`;
}

/**
 * Q45: what an approver reviews before approving a dry run's content effects: the
 * persisted effects, the digest an approval binds to, the requester (who may not
 * approve them), and the current approvals of exactly these effects. Tenant-scoped:
 * another tenant's dry run reads as absent. Null when the artifact does not exist.
 */
export async function loadContentEffectReview(client, { tenantRef, artifactId }) {
  const { rows } = await client.query(
    `SELECT id::text AS id, requested_by, status, content_effects, created_at,
            jsonb_array_length(COALESCE(closure_keys, '[]'::jsonb)) AS resources
       FROM restore_dry_run WHERE id::text = $1 AND tenant_ref = $2`,
    [artifactId, tenantRef],
  );
  const artifact = rows[0];
  if (!artifact) return null;
  const effects = artifact.content_effects ?? [];
  const effectsDigest = effects.length > 0 ? contentEffectsDigest(effects) : null;
  const { rows: approvals } = effectsDigest
    ? await client.query(
      `SELECT approved_by, approved_at, self_approved FROM content_effect_approval
        WHERE artifact_id::text = $1 AND effects_digest = $2 AND revoked_at IS NULL ORDER BY approved_at`,
      [artifact.id, effectsDigest],
    )
    : { rows: [] };
  const need = effects.length > 0 ? await effectsNeedApproval(client, { tenantRef, effects }) : { required: false, waived: [] };
  return {
    artifactId: artifact.id,
    // False when the customer turned restore approvals off for every service these
    // effects are in: the restore makes them without a second approver.
    approvalRequired: need.required,
    approvalWaivedFor: need.waived,
    requestedBy: artifact.requested_by == null ? null : String(artifact.requested_by),
    status: artifact.status,
    createdAt: artifact.created_at,
    resources: Number(artifact.resources),
    effects,
    effectsDigest,
    approvals: approvals.map((row) => ({ approvedBy: String(row.approved_by), approvedAt: row.approved_at, selfApproved: row.self_approved === true })),
    // Solo approval mode: the requester may approve these effects themselves.
    selfApprovalAllowed: await selfApprovalAllowed(client, { tenantRef }),
  };
}

const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which of these dry runs still wait on their content-effect approval: they carry
 * content effects and no unrevoked approval of exactly those effects by someone other
 * than the requester, in a service whose restore approval is on. The same test the
 * review page applies. Tenant-scoped, three queries whatever the number of dry runs. Lets the approval inbox list an approved
 * restore whose content effects nobody has approved yet as still waiting.
 */
export async function dryRunsAwaitingContentEffectApproval(client, { tenantRef, artifactIds }) {
  const wanted = [...new Set(artifactIds)].filter((id) => typeof id === 'string' && ARTIFACT_ID.test(id));
  const waiting = new Set();
  if (wanted.length === 0) return waiting;
  const { rows: artifacts } = await client.query(
    `SELECT id::text AS id, requested_by, content_effects FROM restore_dry_run
      WHERE tenant_ref = $1 AND id::text = ANY($2::text[])
        AND jsonb_array_length(COALESCE(content_effects, '[]'::jsonb)) > 0`,
    [tenantRef, wanted],
  );
  if (artifacts.length === 0) return waiting;
  const { rows: approvals } = await client.query(
    `SELECT artifact_id::text AS artifact_id, effects_digest, approved_by FROM content_effect_approval
      WHERE artifact_id::text = ANY($1::text[]) AND revoked_at IS NULL`,
    [artifacts.map((artifact) => artifact.id)],
  );
  const settings = await getRestoreApprovalSettings(client, { tenantRef });
  const soloNow = await selfApprovalAllowed(client, { tenantRef });
  for (const artifact of artifacts) {
    // Effects whose services have restore approvals turned off wait for nobody.
    if (!(await effectsNeedApproval(client, { tenantRef, effects: artifact.content_effects, settings })).required) continue;
    const digest = contentEffectsDigest(artifact.content_effects);
    const approved = approvals.some((approval) => approval.artifact_id === artifact.id
      && approval.effects_digest === digest
      && (soloNow || String(approval.approved_by) !== String(artifact.requested_by)));
    if (!approved) waiting.add(artifact.id);
  }
  return waiting;
}
