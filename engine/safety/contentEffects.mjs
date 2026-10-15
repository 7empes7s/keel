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

export const CONTENT_EFFECTS = Object.freeze(['retention-reducing', 'hold-releasing', 'externally-sharing', 'irreversible']);
export const CONTENT_EFFECT_APPROVAL_EVIDENCE_KIND = 'content-effect-approval';

const NOT_BACKED_UP = 'KEEL backs up configuration, not content: content deleted or disclosed while this setting is in effect is not recoverable by KEEL, and restoring the previous setting later does not bring it back.';

const DISCLOSURES = Object.freeze({
  'retention-reducing': `Content older than the new retention period can be permanently deleted. ${NOT_BACKED_UP}`,
  'hold-releasing': `Content released from the hold can be deleted by users or by retention. ${NOT_BACKED_UP}`,
  'externally-sharing': `Content becomes visible to people outside its current audience. ${NOT_BACKED_UP}`,
  irreversible: `This change destroys content when it takes effect. ${NOT_BACKED_UP}`,
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

/** groupSetting stores its values as [{ name, value }]; address one by name. */
const settingValue = (name) => (payload) => payload?.values?.find?.((entry) => entry?.name === name)?.value;

function valueAt(payload, path) {
  return path.split('.').reduce((value, key) => value?.[key], payload);
}

const rule = (field, effect, when, read = (payload) => valueAt(payload, field)) => Object.freeze({ field, effect, when, read });

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
  deviceConfiguration: { reviewed: true, judgesCreates: true, rules: [
    rule('passcodeSignInFailureCountBeforeWipe', 'irreversible', wipeThresholdTightens),
    rule('passwordSignInFailureCountBeforeFactoryReset', 'irreversible', wipeThresholdTightens),
    rule('workProfilePasswordSignInFailureCountBeforeFactoryReset', 'irreversible', wipeThresholdTightens),
    rule('accountManagerPolicy.accountDeletionPolicy', 'irreversible', becomes('immediately')),
    rule('accountManagerPolicy.inactiveThresholdDays', 'retention-reducing', decreases),
  ] },
  // Gap D3: a shorter group lifetime expires and deletes Microsoft 365 groups
  // (and their mail, files and chats) that nobody renews in time. The restore
  // guard refuses it unless this effect carries its separate high-impact
  // approval (tenantPolicyOperations.mjs). Which groups are covered and the
  // notice addresses stay plain refusals of that guard, never approvable here.
  groupLifecyclePolicy: { reviewed: true, rules: [
    rule('groupLifetimeInDays', 'retention-reducing', decreases),
  ] },
  configurationPolicy: { reviewed: true, judgesCreates: true, rules: [
    rule(`settings[${CATALOG_WIPE_THRESHOLD}]`, 'irreversible', wipeThresholdTightens, catalogSetting(CATALOG_WIPE_THRESHOLD)),
  ] },
});

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

    const review = CONTENT_EFFECT_RULES[resourceType];
    if (review?.reviewed) {
      if (verb === 'delete' && review.onDelete) {
        effects.push({ naturalKey, resourceType, field: '(object deleted)', effect: review.onDelete, before: 'present', after: 'deleted', disclosure: disclosureFor(review.onDelete) });
        continue;
      }
      if (!after) continue;
      // A create starts from nothing, so no existing content changes reach,
      // unless the type's effects land on content outside the object (devices).
      if (!before && !review.judgesCreates) continue;
      for (const entry of review.rules) {
        const b = entry.read(before ?? {});
        const a = entry.read(after);
        if (JSON.stringify(b ?? null) === JSON.stringify(a ?? null)) continue; // unchanged: benign
        if (entry.when(b, a)) {
          effects.push({ naturalKey, resourceType, field: entry.field, effect: entry.effect, before: b ?? null, after: a ?? null, disclosure: disclosureFor(entry.effect) });
        }
      }
      continue;
    }

    // Unreviewed type: any changed content-bearing field refuses until classified.
    const changed = changedLeaves(before ?? {}, after ?? {}).filter((path) => DANGEROUS_FIELD.test(path.split('.').pop()));
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
  const bound = effects.map(({ naturalKey, resourceType, field, effect, before, after }) => ({ naturalKey, resourceType, field, effect, before, after }));
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
  if (String(artifact.requested_by) === String(approverId)) {
    throw new ContentEffectApprovalError('content effects must be approved by someone other than the requester');
  }
  const { rows } = await client.query(
    `INSERT INTO content_effect_approval (tenant_ref, artifact_id, effects_digest, approved_by, justification, approved_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (artifact_id, effects_digest, approved_by) DO UPDATE SET justification = content_effect_approval.justification
     RETURNING *`,
    [tenantRef, artifact.id, effectsDigest, approverId, justification.trim(), at],
  );
  await appendEvidence(client, {
    tenantRef,
    kind: CONTENT_EFFECT_APPROVAL_EVIDENCE_KIND,
    subject: { artifactId: artifact.id, effectsDigest, effects: effects.map(({ naturalKey, field, effect }) => ({ naturalKey, field, effect })) },
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
  const at = requestedAt ?? await databaseNow(client);
  const digest = contentEffectsDigest(effects);
  const { rows } = await client.query(
    `SELECT * FROM content_effect_approval
      WHERE artifact_id::text = $1 AND effects_digest = $2 AND revoked_at IS NULL
      ORDER BY approved_at DESC`,
    [artifact.id, digest],
  );
  for (const approval of rows) {
    if (String(approval.approved_by) === String(artifact.requestedBy)) continue;
    const approver = await findPrincipalById(client, approval.approved_by);
    if (approver && await can(client, approver, 'approve', at)) return approval;
  }
  throw new ContentEffectApprovalError(
    `blocked-content-effect: ${effects.length} content effect(s) (${[...new Set(effects.map((e) => e.effect))].join(', ')}) need a separate, current high-impact approval of exactly these effects. `
    + `Someone other than the requester approves them in the portal: Approvals, then "Review content effects" on this restore (${contentEffectsReviewPath(artifact.id)}). Then run the restore again.`,
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
      `SELECT approved_by, approved_at FROM content_effect_approval
        WHERE artifact_id::text = $1 AND effects_digest = $2 AND revoked_at IS NULL ORDER BY approved_at`,
      [artifact.id, effectsDigest],
    )
    : { rows: [] };
  return {
    artifactId: artifact.id,
    requestedBy: artifact.requested_by == null ? null : String(artifact.requested_by),
    status: artifact.status,
    createdAt: artifact.created_at,
    resources: Number(artifact.resources),
    effects,
    effectsDigest,
    approvals: approvals.map((row) => ({ approvedBy: String(row.approved_by), approvedAt: row.approved_at })),
  };
}

const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which of these dry runs still wait on their content-effect approval: they carry
 * content effects and no unrevoked approval of exactly those effects by someone other
 * than the requester. The same test the review page applies. Tenant-scoped, two
 * queries whatever the number of dry runs. Lets the approval inbox list an approved
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
  for (const artifact of artifacts) {
    const digest = contentEffectsDigest(artifact.content_effects);
    const approved = approvals.some((approval) => approval.artifact_id === artifact.id
      && approval.effects_digest === digest
      && String(approval.approved_by) !== String(artifact.requested_by));
    if (!approved) waiting.add(artifact.id);
  }
  return waiting;
}
