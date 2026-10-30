/**
 * Wave 2 WKLD: qualified restore of workload settings written by one cmdlet per object:
 * mail flow rules and connectors, the Exchange settings READ-EXO added, Teams org-wide,
 * voice and live event policies, and Purview retention and DLP.
 *
 * One plan covers one workload's recorded collection, or the objects named in it. Each
 * changed object is one DISTINCT operation with its own qualification, outcome and
 * evidence row (writeDeclarations.mjs):
 *  - update: one Set- cmdlet with the declared fields that differ;
 *  - add:    one New- cmdlet for a named Teams policy (`Tag:<name>`) that no longer
 *            exists. A policy name is its identity, so the policy comes back as itself;
 *            who it was assigned to is not restored (it is listed).
 * Everything else stays manual, and nothing is deleted:
 *  - a field KEEL does not write, or whose value the cmdlet transport cannot carry (an
 *    object, a list of non-strings), is listed with both values;
 *  - an object keyed by a Guid that no longer exists is not recreated (it would get a
 *    new Guid, and its conditions are not all typed); one that is new is never deleted;
 *  - a rule's on/off State, set by Enable-/Disable- cmdlets, is listed.
 *
 * Rules:
 *  - Immutable plan, persisted as a restore_dry_run artifact; the task-66 approval and
 *    promotion checks are the existing ones.
 *  - Disabled until qualified, per operation, by the qualification the caller passes
 *    (workloadWriteQualification; qualification.mjs spreads WKLD_WRITE_OPERATIONS).
 *  - Content effect guard. A change that shortens retention, releases a hold, deletes
 *    mail or widens who sees content is a classified effect (WORKLOAD_EFFECT_RULES).
 *    Its operation runs only with the separate, current high-impact approval of
 *    exactly these effects; without it the operation is blocked and nothing is sent.
 *  - Preservation lock. A target, or the policy a rule belongs to, that reports a lock
 *    is refused at plan time and again before writing; a platform lock refusal is
 *    recorded and never retried.
 *  - No overwrite. Every target is re-read first; a change since the plan makes only
 *    that target's operation `stale`.
 *  - Errors are structured; an ambiguous outcome is reconciled by re-reading and is
 *    never sent a second time.
 *  - Test tenant fixtures only (fixtureGuard.mjs). On the test tenant every object
 *    written is a KEEL-RT- fixture, at plan time and again before writing. A tenant-wide
 *    object needs a plan made with the separate tenant-wide option (off by default).
 */
import { createHash, randomUUID } from 'node:crypto';

import { structuredFailure } from '../../collect/workloads/exchange.mjs';
import { lockState } from '../../collect/workloads/purview.mjs';
import { appendEvidence } from '../../govern/evidence.mjs';
import { CmdletError, runCmdlet } from '../../powershell/jobQueue.mjs';
import { assertContentEffectApproval, disclosureFor, isPreservationLockFailure } from '../../safety/contentEffects.mjs';
import { createDryRunArtifact, getDryRunArtifact, validateArtifactForApproval } from '../dryRunArtifact.mjs';
import { TEST_TENANT_REFS, fixtureProblem } from './fixtureGuard.mjs';
import { MANUAL_FAMILIES, WKLD_WRITE_OPERATIONS, isTrustField } from './writeDeclarations.mjs';

export const WORKLOAD_SETTINGS_EVIDENCE_KIND = 'workload-restore';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Fields that name or date the object rather than configure it.
const NOT_COMPARED = new Set(['Identity', 'Guid', 'WhenChangedUTC', 'DistributionStatus', 'IsValidated']);
// Per-resource metadata the collectors store beside the fields.
const META = ['identity', 'kind', 'lock', 'parent', 'parentStatus', 'parentPolicy', 'case'];

function canonical(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const sha256 = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const same = (a, b) => canonical(a ?? null) === canonical(b ?? null);
const truthy = (value) => value === true || value === 'true' || value === 'True';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// ------------------------------------------------------------ content effects

const listOf = (value) => (Array.isArray(value) ? value.map((item) => String(item).toLowerCase()) : value === null || value === undefined || value === '' ? [] : [String(value).toLowerCase()]);
const addsEntry = (before, after) => listOf(after).some((item) => !listOf(before).includes(item));
const changes = (before, after) => !same(before, after);
const enabledToDisabled = (before, after) => truthy(before) && !truthy(after);
const disabledToEnabled = (before, after) => !truthy(before) && truthy(after);
const becomes = (...values) => (before, after) => {
  const wanted = values.map((value) => value.toLowerCase());
  return wanted.includes(String(after ?? '').toLowerCase()) && !wanted.includes(String(before ?? '').toLowerCase());
};
const leaves = (...values) => (before, after) => becomes(...values)(after, before);
const nonEmpty = (value) => listOf(value).length > 0;
/** A duration in days: a number, a day count in a string, or "d.hh:mm:ss"; Infinity for Unlimited; null when unreadable. */
function days(value) {
  if (typeof value === 'number') return value;
  const text = String(value ?? '').trim();
  if (/^unlimited$/i.test(text)) return Infinity;
  if (/^\d+$/.test(text)) return Number(text);
  const match = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})$/.exec(text);
  return match ? Number(match[1] ?? 0) + Number(match[2]) / 24 + Number(match[3]) / 1440 + Number(match[4]) / 86400 : null;
}
// A changed duration that cannot be read is treated as shorter: the safe direction.
const shorterBy = (read) => (before, after) => {
  const b = read(before);
  const a = read(after);
  return b === null || a === null ? true : a < b;
};
const shortens = shorterBy(days);
// Teams recording expiry: -1 means the recording never expires.
const expiryDays = (value) => {
  const read = typeof value === 'string' && /^-\d+$/.test(value.trim()) ? Number(value) : days(value);
  return typeof read === 'number' && read < 0 ? Infinity : read;
};
const expiresSooner = shorterBy(expiryDays);
// An audience that names anyone beyond the invited people in the organization.
const widensAudience = (before, after) => !same(before, after) && /everyone|external|guest|anonym|public/i.test(String(after ?? ''));
const rule = (field, effect, when) => Object.freeze({ field, effect, when });
// A move up an ordered scale, narrowest first; a value off the scale cannot be judged, so it counts.
const widensOn = (order) => (before, after) => {
  if (same(before, after)) return false;
  const rank = (value) => order.findIndex((item) => item.toLowerCase() === String(value ?? '').toLowerCase());
  return rank(before) < 0 || rank(after) < 0 || rank(after) > rank(before);
};
// SharePoint and OneDrive keep a domain list as one text of domains, split by spaces.
const domainsOf = (value) => (Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/)).map((item) => String(item).trim().toLowerCase()).filter(Boolean);
const addsDomain = (before, after) => domainsOf(after).some((item) => !domainsOf(before).includes(item));
const removesDomain = (before, after) => addsDomain(after, before);
// A link or guest expiry in days: 0 (or less) never expires. Longer, or unreadable, counts.
const expiresLater = (before, after) => {
  if (same(before, after)) return false;
  const read = (value) => { const number = Number(value); return Number.isFinite(number) ? (number <= 0 ? Infinity : number) : null; };
  const b = read(before);
  const a = read(after);
  return b === null || a === null || a > b;
};
const SHARING = 'externally-sharing';
const RETENTION = 'retention-reducing';
const HOLD = 'hold-releasing';
const IRREVERSIBLE = 'irreversible';
// `when(before, after, { from, to })`: from and to are the whole object before and after the write.
const whileSet = (field, test) => (before, after, { to }) => test(before, after) && nonEmpty(to?.[field]);

/**
 * The dangerous transitions of each written type. A written field whose NAME looks
 * content-bearing must have a rule here, an object rule below, or a reason in
 * BENIGN_FIELDS (checked at load and by the test), the same discipline as
 * safety/contentEffects.mjs. Declared from Microsoft's documentation, not measured.
 */
export const WORKLOAD_EFFECT_RULES = Object.freeze({
  // One OneDrive site's sharing: anything that lets more people, or people outside, reach
  // its files, or keeps their access longer, discloses content.
  onedriveSiteSettings: [
    rule('SharingCapability', SHARING, widensOn(['Disabled', 'ExistingExternalUserSharingOnly', 'ExternalUserSharingOnly', 'ExternalUserAndGuestSharing'])),
    rule('SharingDomainRestrictionMode', SHARING, widensOn(['AllowList', 'BlockList', 'None'])),
    rule('SharingAllowedDomainList', SHARING, addsDomain),
    rule('SharingBlockedDomainList', SHARING, removesDomain),
    rule('DefaultSharingLinkType', SHARING, widensOn(['Direct', 'Internal', 'AnonymousAccess'])),
    rule('DefaultLinkPermission', SHARING, widensOn(['View', 'Edit'])),
    rule('OverrideTenantExternalUserExpirationPolicy', SHARING, changes),
    rule('ExternalUserExpirationInDays', SHARING, expiresLater),
    rule('OverrideTenantAnonymousLinkExpirationPolicy', SHARING, changes),
    rule('AnonymousLinkExpirationInDays', SHARING, expiresLater),
  ],
  // Mail that a rule deletes, or copies, reports or sends to someone new, is lost or
  // disclosed. Every other change to a rule that carries such an action is judged by
  // the object rule below.
  exchangeTransportRule: [
    rule('DeleteMessage', IRREVERSIBLE, disabledToEnabled),
    rule('RedirectMessageTo', SHARING, addsEntry),
    rule('BlindCopyTo', SHARING, addsEntry),
    rule('AddToRecipients', SHARING, addsEntry),
    rule('ModerateMessageByUser', SHARING, addsEntry),
    rule('GenerateIncidentReport', SHARING, changes),
    rule('RouteMessageOutboundConnector', SHARING, changes),
    // Quarantined mail is purged when quarantine retention ends; rejected mail is never delivered.
    rule('Quarantine', IRREVERSIBLE, disabledToEnabled),
    rule('RejectMessageReasonText', IRREVERSIBLE, (before, after) => !nonEmpty(before) && nonEmpty(after)),
    rule('RejectMessageEnhancedStatusCode', IRREVERSIBLE, (before, after) => !nonEmpty(before) && nonEmpty(after)),
    // Mail the rule stops encrypting, or may send without TLS, is readable outside.
    rule('ApplyRightsProtectionTemplate', SHARING, changes),
    rule('RouteMessageOutboundRequireTls', SHARING, enabledToDisabled),
  ],
  // Recipients a connector scans and drops lose that mail, from the moment it is on.
  exchangeInboundConnector: [
    rule('ScanAndDropRecipients', IRREVERSIBLE, addsEntry),
    rule('Enabled', IRREVERSIBLE, whileSet('ScanAndDropRecipients', disabledToEnabled)),
  ],
  // A connector routes mail through the hosts it names; each of these sends more mail there.
  exchangeOutboundConnector: [
    rule('Enabled', SHARING, disabledToEnabled),
    rule('RecipientDomains', SHARING, changes),
    rule('IsTransportRuleScoped', SHARING, enabledToDisabled),
    rule('UseMXRecord', SHARING, enabledToDisabled),
    rule('RouteAllMessagesViaOnPremises', SHARING, changes),
    rule('AllAcceptedDomains', SHARING, changes),
    // SmartHosts, TlsSettings and TlsDomain are never written (TRUST_FIELDS), so they need no rule.
  ],
  // Mail protection that flags more mail sends it to junk or quarantine, or rejects it;
  // quarantine is purged when its retention ends. Each switch turned on, each action
  // moved to quarantine or delete, and each allowed domain taken away can do that.
  exchangeAntiPhishPolicy: [
    rule('EnableSpoofIntelligence', IRREVERSIBLE, disabledToEnabled),
    rule('HonorDmarcPolicy', IRREVERSIBLE, disabledToEnabled),
  ],
  exchangeAntiSpamPolicy: [
    rule('PhishSpamAction', IRREVERSIBLE, becomes('Quarantine', 'Delete')),
    rule('HighConfidencePhishAction', IRREVERSIBLE, becomes('Quarantine', 'Delete')),
    rule('PhishZapEnabled', IRREVERSIBLE, disabledToEnabled),
    rule('AllowedSenderDomains', IRREVERSIBLE, (before, after) => addsEntry(after, before)),
  ],
  exchangeAntiMalwarePolicy: [
    rule('EnableFileFilter', IRREVERSIBLE, disabledToEnabled),
    rule('ZapEnabled', IRREVERSIBLE, disabledToEnabled),
  ],
  exchangeOutboundSpamPolicy: [
    rule('AutoForwardingMode', SHARING, becomes('On')),
    rule('BccSuspiciousOutboundAdditionalRecipients', SHARING, addsEntry),
    rule('BccSuspiciousOutboundMail', SHARING, whileSet('BccSuspiciousOutboundAdditionalRecipients', disabledToEnabled)),
  ],
  // A journal rule copies every matching message to its journal address.
  exchangeJournalRule: [rule('JournalEmailAddress', SHARING, changes), rule('Recipient', SHARING, changes), rule('Scope', SHARING, changes)],
  exchangeRetentionPolicyTag: [
    rule('AgeLimitForRetention', RETENTION, shortens),
    rule('RetentionAction', IRREVERSIBLE, becomes('DeleteAndAllowRecovery', 'PermanentlyDelete')),
    rule('RetentionEnabled', RETENTION, disabledToEnabled),
  ],
  // Which tags apply decides what is deleted when; KEEL does not judge a new set.
  exchangeRetentionPolicy: [rule('RetentionPolicyTagLinks', RETENTION, changes)],
  teamsGuestMeetingConfiguration: [rule('AllowTranscription', SHARING, disabledToEnabled)],
  // Letting people delete messages and chats lets content go before retention sees it.
  teamsMessagingPolicy: [
    rule('AllowUserDeleteMessage', IRREVERSIBLE, disabledToEnabled),
    rule('AllowUserDeleteChat', IRREVERSIBLE, disabledToEnabled),
    rule('AllowOwnerDeleteMessage', IRREVERSIBLE, disabledToEnabled),
    rule('AllowFullChatPermissionUserToDeleteAnyMessage', IRREVERSIBLE, disabledToEnabled),
    rule('AllowGroupChatJoinLinks', SHARING, disabledToEnabled),
  ],
  teamsGuestMessagingConfiguration: [
    rule('AllowUserDeleteMessage', IRREVERSIBLE, disabledToEnabled),
    rule('AllowUserDeleteChat', IRREVERSIBLE, disabledToEnabled),
  ],
  teamsFederationConfiguration: [
    // AllowFederatedUsers and the domain lists are never written (TRUST_FIELDS), so they need no rule.
    rule('AllowTeamsConsumer', SHARING, disabledToEnabled),
    rule('AllowTeamsConsumerInbound', SHARING, disabledToEnabled),
    rule('RestrictTeamsConsumerToExternalUserProfiles', SHARING, enabledToDisabled),
    rule('BlockAllSubdomains', SHARING, enabledToDisabled),
    rule('ExternalAccessWithTrialTenants', SHARING, becomes('Allowed')),
  ],
  // Guest access, mail into channels and third-party storage move content outside.
  teamsClientConfiguration: [
    rule('AllowGuestUser', SHARING, disabledToEnabled),
    rule('AllowEmailIntoChannel', SHARING, disabledToEnabled),
    rule('RestrictedSenderList', SHARING, changes),
    ...['AllowDropBox', 'AllowBox', 'AllowGoogleDrive', 'AllowShareFile', 'AllowEgnyte'].map((field) => rule(field, SHARING, disabledToEnabled)),
  ],
  teamsCallingPolicy: [
    rule('CallRecordingExpirationDays', RETENTION, expiresSooner),
    rule('AllowCallForwardingToPhone', SHARING, disabledToEnabled),
    rule('AllowCallForwardingToUser', SHARING, disabledToEnabled),
    rule('AllowCallRedirect', SHARING, changes),
    rule('AllowCloudRecordingForCalls', SHARING, disabledToEnabled),
    rule('AllowTranscriptionForCalling', SHARING, disabledToEnabled),
  ],
  // A voicemail transcript is mailed as text; a translation sends it to a translation service.
  teamsVoicemailPolicy: [
    rule('EnableTranscription', SHARING, disabledToEnabled),
    rule('EnableTranscriptionTranslation', SHARING, disabledToEnabled),
  ],
  teamsLiveEventsPolicy: [
    rule('BroadcastAttendeeVisibilityMode', SHARING, widensAudience),
    rule('BroadcastRecordingMode', SHARING, changes),
    rule('AllowBroadcastTranscription', SHARING, disabledToEnabled),
  ],
  teamsEventsPolicy: [
    rule('EventAccessType', SHARING, widensAudience),
    rule('TownhallEventAttendeeAccess', SHARING, widensAudience),
    ...['RecordingForTownhall', 'RecordingForWebinar', 'TranscriptionForTownhall', 'TranscriptionForWebinar'].map((field) => rule(field, SHARING, changes)),
  ],
  // Turning a retention policy or rule off releases what it preserved.
  purviewRetentionPolicy: [rule('Enabled', HOLD, enabledToDisabled)],
  purviewRetentionRule: [
    rule('RetentionDuration', RETENTION, shortens),
    // Any move to a deleting action, or away from keeping, deletes or stops preserving content.
    rule('RetentionComplianceAction', IRREVERSIBLE, (before, after) => /delete/i.test(String(after ?? '')) || (/keep/i.test(String(before ?? '')) && !/keep/i.test(String(after ?? '')))),
    rule('ExpirationDateOption', RETENTION, changes),
    rule('ContentMatchQuery', RETENTION, changes),
  ],
  // A DLP policy or rule that stops blocking, lets users override, or reports to someone new lets content out.
  purviewDlpPolicy: [rule('Mode', SHARING, leaves('Enable')), rule('Priority', SHARING, changes)],
  purviewDlpRule: [
    rule('Disabled', SHARING, disabledToEnabled),
    rule('BlockAccess', SHARING, enabledToDisabled),
    rule('BlockAccessScope', SHARING, changes),
    rule('NotifyAllowOverride', SHARING, addsEntry),
    rule('NotifyUser', SHARING, addsEntry),
    rule('GenerateAlert', SHARING, addsEntry),
    rule('GenerateIncidentReport', SHARING, addsEntry),
    rule('IncidentReportContent', SHARING, changes),
    rule('StopPolicyProcessing', SHARING, disabledToEnabled),
    rule('Priority', SHARING, changes),
  ],
  purviewRetentionLabel: [rule('RetentionDuration', RETENTION, shortens)],
});

/**
 * Object rules: every change to an object whose job is to act on mail. A transport
 * rule always carries an action, and not every action is a written parameter (CopyTo,
 * a manager as recipient, removing encryption), so any change to its Mode, conditions,
 * exceptions or order can reach more mail: all of them need the approval. A spam
 * rule decides which mailboxes its policy (auto-forwarding, deleting spam) covers,
 * and so do anti-phish and Safe Attachments rules (deleting or quarantining).
 */
const TRANSPORT_LOSSES = ['RejectMessageReasonText', 'RejectMessageEnhancedStatusCode'];
const LOSS_TEXT = /delete|quarantine|reject/i;
const everyChange = (effectOf) => Object.freeze({
  covers: 'every written field but Comments',
  effects(from, to, changed) {
    const effect = effectOf(from, to);
    return changed.filter((field) => field !== 'Comments').map((field) => ({ field, effect }));
  },
});
export const WORKLOAD_OBJECT_EFFECTS = Object.freeze({
  exchangeTransportRule: everyChange((from, to) => {
    const loses = [from, to].some((side) => ['DeleteMessage', 'Quarantine'].some((field) => truthy(side?.[field]))
      || TRANSPORT_LOSSES.some((field) => nonEmpty(side?.[field]))
      || LOSS_TEXT.test(canonical(side?.Actions ?? null)));
    return loses ? IRREVERSIBLE : SHARING;
  }),
  exchangeOutboundSpamRule: everyChange(() => SHARING),
  exchangeAntiSpamRule: everyChange(() => IRREVERSIBLE),
  // Their policies can delete or quarantine the mail they flag.
  exchangeAntiPhishRule: everyChange(() => IRREVERSIBLE),
  exchangeSafeAttachmentRule: everyChange(() => IRREVERSIBLE),
});

// Written fields whose names look content-bearing but are not, and why.
export const BENIGN_FIELDS = Object.freeze({
  RecipientLimitExternalPerHour: 'a sending rate limit; it never deletes or discloses mail',
  ExternalLocationLookupMode: 'emergency address lookup for remote workers',
  ExternalAccessPrefix: 'the digit dialled for an outside line',
  RetentionDurationDisplayHint: 'the unit the portal shows a retention duration in',
  ActionWhenThresholdReached: 'what happens to a sender over the outbound limit ("threshold", not a hold)',
  AllowPowerPointSharing: 'presenting slides to the people already in the meeting',
  AllowWatermarkForScreenSharing: 'a watermark on a shared screen; it only adds protection',
  MusicOnHoldEnabledType: 'music played to a caller on hold; no content is kept or disclosed',
  AllowEngagementReport: 'an attendance report for the organizer of their own meeting',
  AllowCommunicationComplianceEndUserReporting: 'lets users report a message to their own compliance team',
  AllowSecurityEndUserReporting: 'lets users report a message to their own security team',
  NotifyOutboundSpam: 'notifies the administrators named in the policy; no message content leaves the tenant',
  NotifyOutboundSpamRecipients: 'the administrators told that a sender was blocked; no message content is sent',
  ReportSeverityLevel: 'the severity shown on a DLP alert inside the tenant',
  UseMicrosoftECDN: 'which network delivers a town hall stream to its own audience',
  RecipientLimitInternalPerHour: 'a sending rate limit; it never deletes or discloses mail',
  RecipientLimitPerDay: 'a sending rate limit; it never deletes or discloses mail',
  IPBlockList: 'addresses whose inbound mail is refused; no content is deleted or sent out',
  // Conditions: on a transport rule that acts on content, the object rule judges every change to them.
  RecipientDomainIs: 'which recipients a rule covers; alone it never deletes or sends content',
  ExceptIfRecipientDomainIs: 'which recipients a rule skips; alone it never deletes or sends content',
  FromScope: 'whether a rule matches senders inside or outside; alone it never deletes or sends content',
  SentToScope: 'whether a rule matches recipients inside or outside; alone it never deletes or sends content',
  IncludeMessagesFromBlockedSenderAddress: 'whether a user\'s own quarantine notice lists mail from blocked senders',
  AdminMailRecipients: 'administrators told that a device was quarantined; no message content is sent',
  RecipientFilter: 'which directory entries an address list shows; no mail content',
  IncludedRecipients: 'which recipient types an address list shows; no mail content',
  AllowScopedPeopleSearchandAccess: 'limits people search to the user\'s address book; it only narrows',
  EnableTranscriptionProfanityMasking: 'masks words in a transcript; it only removes',
  EnableUserOverride: 'lets a user hide their own number on outbound calls; it only withholds',
  EnableSafeLinksForEmail: 'checks the links in mail when clicked; no mail is deleted, kept or sent out',
  BlockIncomingPstnCallerID: 'hides the caller\'s number from the person called; it only withholds',
});
// The field-name heuristic of safety/contentEffects.mjs (unreviewed types), widened
// with the ways these workloads delete, forward, copy, report or route content.
const DANGEROUS_FIELD = /retention|hold|preserv|shar(e|ing)|guest|external|invite|wipe|purge|anonymous|public|delete|forward|redirect|copy|bcc|journal|report|regist|stream|link|route|drop|smarthost|record|transcri|recipient|scope|override|block/i;

/** Every declared written field whose name looks content-bearing and has neither a rule nor a reason. */
export function unreviewedWrittenFields(declarations = WKLD_WRITE_OPERATIONS, rules = WORKLOAD_EFFECT_RULES) {
  const missing = [];
  for (const [id, write] of Object.entries(declarations)) {
    const covered = new Set((rules[write.resourceType] ?? []).map((entry) => entry.field));
    for (const field of write.fields) if (DANGEROUS_FIELD.test(field) && !covered.has(field) && !BENIGN_FIELDS[field]) missing.push(`${id}:${field}`);
  }
  return missing;
}
{
  const missing = unreviewedWrittenFields();
  if (missing.length) throw new Error(`written fields with no content-effect review: ${missing.join(', ')}`);
}

/** Classified effects of planned operations ({ naturalKey, resourceType, verb, payload, live }). Creates are not judged: a new policy is assigned to nobody. */
export function classifyWorkloadEffects(resources) {
  const effects = [];
  for (const { naturalKey, resourceType, verb, payload, live } of resources) {
    if (verb !== 'update') continue;
    const from = live?.payload ?? {};
    const to = payload ?? {};
    const push = (field, effect) => {
      if (effects.some((item) => item.naturalKey === naturalKey && item.field === field)) return;
      effects.push({ naturalKey, resourceType, field, effect, before: from[field] ?? null, after: to[field] ?? null, disclosure: disclosureFor(effect) });
    };
    for (const entry of WORKLOAD_EFFECT_RULES[resourceType] ?? []) {
      const before = from[entry.field] ?? null;
      const after = to[entry.field] ?? null;
      if (!same(before, after) && entry.when(before, after, { from, to })) push(entry.field, entry.effect);
    }
    const object = WORKLOAD_OBJECT_EFFECTS[resourceType];
    if (object) {
      const changed = Object.keys(to).filter((field) => !same(from[field] ?? null, to[field] ?? null));
      for (const { field, effect } of object.effects(from, to, changed)) push(field, effect);
    }
  }
  const order = (effect) => `${effect.naturalKey}|${effect.field}`;
  return effects.sort((left, right) => order(left).localeCompare(order(right)));
}

// ------------------------------------------------------------ declarations

/** The families of one workload KEEL writes: { family: { update, add } } by operation id. */
export function writeFamilies(workload, declarations = WKLD_WRITE_OPERATIONS) {
  const families = {};
  for (const [id, write] of Object.entries(declarations)) {
    if (write.workload !== workload) continue;
    families[write.family] ??= { update: null, add: null };
    families[write.family][id.endsWith('.add') ? 'add' : 'update'] = id;
  }
  return families;
}

/** The families a restore re-reads live: the written ones, and the ones it only lists for an administrator. */
export function restoreReadFamilies(workload) {
  return [...Object.keys(writeFamilies(workload)), ...Object.keys(MANUAL_FAMILIES[workload] ?? {})];
}

/** The write cmdlets, the parameters each may take, and their module: what run-cmdlet.ps1 allows. */
export function writeCmdletParameters(declarations = WKLD_WRITE_OPERATIONS) {
  const cmdlets = {};
  for (const write of Object.values(declarations)) {
    const entry = cmdlets[write.method] ??= { module: write.module, session: write.session, parameters: new Set(['Identity']) };
    if (entry.session !== write.session) throw new Error(`${write.method} is declared in two sessions`);
    for (const field of write.fields) entry.parameters.add(field);
  }
  return Object.fromEntries(Object.entries(cmdlets).map(([name, entry]) => [name, { ...entry, parameters: [...entry.parameters].sort() }]));
}
const WRITE_CMDLETS = writeCmdletParameters();

export class WorkloadWriteScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkloadWriteScopeError';
  }
}

/**
 * Purview saved the change but reports that deploying the policy to its locations failed
 * (PolicyDeploymentException). The value lands all the same (operator queue Q260: every
 * Set-RetentionCompliancePolicy on a policy whose deployment times out errors after saving),
 * so the outcome is read back, never assumed and never resent.
 */
export function isSavedButNotDeployed(detail) {
  return /PolicyDeploymentException/.test(`${detail?.message ?? ''} ${detail?.errorId ?? ''}`);
}

/** Purview refuses a change while an earlier one to the same policy is still deploying (Q260). */
export function isPolicyStillDeploying(detail) {
  return /PolicyLockConflictException|Previous changes to the policy .* are being deployed/s.test(`${detail?.message ?? ''} ${detail?.errorId ?? ''}`);
}

/** Runs one declared write cmdlet through the bounded job transport; anything else is refused unsent. */
export async function workloadWriteCmdlet({ cmdlet, parameters = {} }, powershell = {}) {
  const allowed = WRITE_CMDLETS[cmdlet];
  if (!allowed) throw new WorkloadWriteScopeError(`${cmdlet} is not a workload write KEEL runs`);
  for (const name of Object.keys(parameters)) {
    if (!allowed.parameters.includes(name)) throw new WorkloadWriteScopeError(`${cmdlet} does not take ${name} from KEEL`);
  }
  const { tenantConfigPath = null, ...options } = powershell;
  return runCmdlet({ module: allowed.module, cmdlet, parameters, tenantConfigPath }, { ...options, allowedCmdlets: new Set([cmdlet]) });
}

/** True when the cmdlet transport can carry the value: a scalar, or a list of strings. */
function sendable(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

// ------------------------------------------------------------ source and live

/** A recorded collection of `workload`, as the planner reads it, or null. */
export async function loadWorkloadSource(client, { tenantRef, collectionId, workload }) {
  const { rows: [run] } = await client.query(
    `SELECT * FROM workload_collection WHERE id::text = $1 AND tenant_ref = $2 AND workload = $3`,
    [String(collectionId), tenantRef, workload],
  );
  if (!run) return null;
  const { rows } = await client.query(
    `SELECT resource_key, fields, field_coverage FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key`,
    [run.id],
  );
  return {
    collectionId: run.id,
    outcome: run.outcome,
    observedTo: new Date(run.observed_to).toISOString(),
    observations: rows.map((row) => {
      const fields = { ...row.fields };
      const meta = {};
      for (const key of META) if (key in fields) { meta[key] = fields[key]; delete fields[key]; }
      return { resourceKey: row.resource_key, ...meta, fields, fieldCoverage: row.field_coverage ?? {} };
    }),
  };
}

const fingerprint = (entry) => sha256({ fields: entry.fields, fieldCoverage: entry.fieldCoverage, lock: entry.lock ?? null });
// A OneDrive (SharePoint) site lock: read-only or no access. KEEL never changes or unlocks a locked site.
const siteLocked = (fields) => typeof fields?.LockState === 'string' && !/^unlock$/i.test(fields.LockState);
const isLocked = (entry) => entry?.lock === 'locked' || lockState(entry?.fields) === 'locked' || siteLocked(entry?.fields);
// A site is written only when its lock state was read and says Unlock: a lock KEEL could not read counts as one.
const siteOpen = (entry) => entry?.fieldCoverage?.LockState?.status === 'observed' && typeof entry?.fields?.LockState === 'string'
  && /^unlock$/i.test(entry.fields.LockState);
/** The family read failed or was not available, so nothing in it is known now. */
function familyGap(live, family) {
  const gap = [...(live?.failures ?? []), ...(live?.unavailable ?? [])].find((item) => item.family === family) ?? null;
  if (gap) return gap;
  // A read stopped at its object limit may have missed this object; nothing absent from it is known.
  return live?.discovery?.capped ? { family, status: 'capped at its object limit' } : null;
}
function liveEntry(live, key) {
  return (live?.resources ?? []).find((item) => item.resourceKey === key) ?? null;
}
/**
 * The lock of the policy a retention or DLP rule belongs to: 'none' (no parent),
 * 'locked', 'clear', or 'unknown' when the parent is not in the live read, so its
 * lock cannot be known and the rule is never changed.
 */
function parentLock(live, entry) {
  // A retention or DLP rule always has a policy: one the collector could not name has an unknown lock.
  if (!entry?.parentPolicy) return entry?.parentStatus ? 'unknown' : 'none';
  const parent = (live?.resources ?? []).find((item) => item.identity === entry.parentPolicy && !String(item.kind).endsWith('Rule'));
  if (!parent) return 'unknown';
  return isLocked(parent) ? 'locked' : 'clear';
}

// Exchange objects there is one of per tenant. Teams ones are found by their identity.
const TENANT_WIDE_FAMILIES = new Set(['activeSyncSettings', 'globalQuarantineSettings', 'defenderForOffice']);

/**
 * How the fixture guard sees one object: its names, and whether it is tenant-wide (a
 * Teams `Global` policy or configuration, an Exchange organization setting, or a
 * default policy that covers everyone).
 */
export function workloadTarget(write, family, entry) {
  const fields = entry?.fields ?? {};
  // A OneDrive site belongs to one person: named by its owner and its personal address.
  if (write.identity === 'url') {
    const address = String(fields.url ?? entry?.url ?? '');
    const person = /\/personal\/([^/]+)/i.exec(address)?.[1] ?? null;
    return { tenantWide: false, names: [fields.Owner, person].filter((name) => typeof name === 'string' && name) };
  }
  const identity = String(fields.Identity ?? entry?.identity ?? '');
  // Exchange and Purview objects are named by their Name, whether the cmdlet takes their Guid or that Name.
  const exchange = ['guid', 'object-name', 'fixed'].includes(write.identity);
  const tenantWide = TENANT_WIDE_FAMILIES.has(family)
    || (!exchange && !/^tag:/i.test(identity))
    || ['IsDefault', 'IsDefaultGlobalAddressList', 'IsBuiltInProtection'].some((field) => truthy(fields[field]));
  const names = exchange ? [fields.Name] : [identity.replace(/^tag:/i, '')];
  return { tenantWide, names };
}

/** The guard over every object an operation writes: the live one and the one the source restores it to. */
function targetProblem(write, family, entries, { key, tenantRef, testTenantRefs, allowTenantWide }) {
  for (const entry of entries) {
    const { tenantWide, names } = workloadTarget(write, family, entry);
    const problem = fixtureProblem({ tenantRef, testTenantRefs, label: key, names, tenantWide, allowTenantWide });
    if (problem) return problem;
  }
  return null;
}

function identityParameters(write, observation) {
  if (write.identity === 'guid') return { Identity: observation.identity };
  if (write.identity === 'object-name') return { Identity: observation.fields.Name };
  if (write.identity === 'fixed') return { Identity: write.fixedIdentity };
  if (write.identity === 'name') return { Identity: String(observation.fields.Identity).replace(/^tag:/i, '') };
  if (write.identity === 'url') return { Identity: observation.fields?.url ?? observation.url };
  return { Identity: observation.fields.Identity };
}

// ------------------------------------------------------------ planning

export function workloadSettingsPlanDigest(plan) {
  const { digest, ...rest } = plan;
  return sha256(rest);
}

// ------------------------------------------------------------ weakening

// How strongly a spam or phish action deals with the mail: higher is stricter. An
// action not named here cannot be compared, so a move to or from it is never written.
// Redirect sends the mail to whoever the policy names, so it ranks below junk.
const ACTION_STRENGTH = Object.freeze({ delete: 4, quarantine: 4, movetojmf: 3, redirect: 2, modifysubject: 1, addxheader: 1, noaction: 0 });
const strength = (value) => ACTION_STRENGTH[String(value ?? '').toLowerCase()] ?? -1;
const weakerAction = (before, after) => !same(before, after) && (strength(before) < 0 || strength(after) < strength(before));
// A protection switch is written only as a literal boolean in the stricter direction.
// Anything else (1, 'TRUE', null) could bind as on or off in PowerShell, so it is
// treated as the weaker value: listed, never written.
const switchedOff = (before, after) => !same(before, after) && after !== true;
const switchedOn = (before, after) => !same(before, after) && after !== false;

/**
 * The changes that would weaken mail protection, by written type. A restore source is
 * a backup, and a tampered or old backup must not be able to open the filters: such a
 * change is listed for an administrator and never written. Only the stricter
 * direction is written, which is the only direction a compliance fix takes.
 */
export const WEAKENING_RULES = Object.freeze({
  exchangeAntiPhishPolicy: Object.freeze({
    EnableSpoofIntelligence: switchedOff,
    HonorDmarcPolicy: switchedOff,
    EnableUnauthenticatedSender: switchedOff,
  }),
  exchangeAntiSpamPolicy: Object.freeze({
    PhishSpamAction: weakerAction,
    HighConfidencePhishAction: weakerAction,
    PhishZapEnabled: switchedOff,
    InlineSafetyTipsEnabled: switchedOff,
    AllowedSenderDomains: addsEntry,
  }),
  exchangeAntiMalwarePolicy: Object.freeze({
    EnableFileFilter: switchedOff,
    ZapEnabled: switchedOff,
  }),
  exchangeSafeLinksPolicy: Object.freeze({
    EnableSafeLinksForEmail: switchedOff,
    ScanUrls: switchedOff,
    AllowClickThrough: switchedOn,
  }),
});

/** Whether writing `after` over `before` would weaken the protection of this type. */
export function weakensMailProtection(resourceType, field, before, after) {
  const test = WEAKENING_RULES[resourceType]?.[field];
  return typeof test === 'function' && test(before ?? null, after ?? null) === true;
}

// What each type's trust fields decide, and where an administrator sets them.
const CONNECTOR_TRUST = ['which senders, certificates, partners or relay hosts the connector trusts', 'the Exchange admin center > Mail flow > Connectors'];
const TRUST_WHERE = Object.freeze({
  exchangeInboundConnector: CONNECTOR_TRUST,
  exchangeOutboundConnector: CONNECTOR_TRUST,
  exchangeConnectionFilterPolicy: ['which sender IP ranges skip spam filtering',
    'the Microsoft Defender portal > Email & collaboration > Policies & rules > Threat policies > Anti-spam > Connection filter policy'],
  teamsFederationConfiguration: ['which outside organizations and domains Teams users can chat and meet with',
    'the Teams admin center > Users > External access'],
});
const trustReason = (resourceType) => {
  const [what, where] = TRUST_WHERE[resourceType] ?? ['who or what the service trusts', 'the admin center'];
  return `this decides ${what}; a restore never changes it, so a changed backup cannot make it trust someone else. `
    + `An administrator confirms the value and sets it in ${where}`;
};
const WEAKENING_REASON = 'this would weaken mail protection; KEEL only writes the stricter direction, so an administrator decides and applies it';

/** The changes for one present object, and the manual entries it adds. */
function planFields(write, { observation, current, manual }) {
  const changes = [];
  const writable = new Set(write.fields);
  for (const field of Object.keys(observation.fieldCoverage).sort()) {
    if (NOT_COMPARED.has(field)) continue;
    const sourceStatus = observation.fieldCoverage[field]?.status ?? 'unknown';
    const liveStatus = current.fieldCoverage?.[field]?.status ?? 'unknown';
    const before = current.fields?.[field] ?? null;
    const after = observation.fields?.[field] ?? null;
    if (sourceStatus !== 'observed' || liveStatus !== 'observed') {
      if (sourceStatus === liveStatus && same(before, after)) continue;
      manual.push({ resourceKey: observation.resourceKey, field, reason: `${sourceStatus} in the source and ${liveStatus} in the live read, so there is no value KEEL can compare` });
      continue;
    }
    if (same(before, after)) continue;
    // A value the site took from the tenant default is not the site's own: writing it would
    // pin today's default on the site (OneDrive, onedrive.mjs inheritance).
    // A OneDrive value is written only when the backup shows it as the site's own; an
    // undetermined or untracked origin may be the tenant default.
    const inheritance = observation.fieldCoverage[field]?.inheritance;
    if (inheritance === 'inherited' || (write.identity === 'url' && writable.has(field) && inheritance !== 'explicit')) {
      manual.push({ resourceKey: observation.resourceKey, field, before, after, reason: inheritance === 'inherited'
        ? 'the backup shows the tenant default here, not a value of the site\'s own; KEEL does not pin it on the site, and the tenant default is changed in the SharePoint admin center'
        : 'the backup cannot tell whether this is the site\'s own value or the tenant default, so KEEL does not pin it on the site; an administrator applies it' });
      continue;
    }
    if (isTrustField(write.resourceType, field)) {
      manual.push({ resourceKey: observation.resourceKey, field, before, after, reason: trustReason(write.resourceType), trust: true });
      continue;
    }
    if (!writable.has(field)) {
      manual.push({ resourceKey: observation.resourceKey, field, before, after, reason: field === 'State' || field === 'Enabled'
        ? 'turning this on or off is a separate Enable-/Disable- step an administrator takes'
        : 'KEEL does not write this setting; an administrator applies it' });
      continue;
    }
    if (!sendable(after)) {
      manual.push({ resourceKey: observation.resourceKey, field, before, after, reason: 'the value is structured, and KEEL only sends text, numbers, switches and lists of text; an administrator applies it' });
      continue;
    }
    if (weakensMailProtection(write.resourceType, field, before, after)) {
      manual.push({ resourceKey: observation.resourceKey, field, before, after, reason: WEAKENING_REASON, weakensProtection: true });
      continue;
    }
    changes.push({ field, before, after });
  }
  return changes;
}

/** The fields a re-created policy is sent with: every written field the source observed and KEEL can send. */
function createFields(write, observation, manual) {
  const fields = [];
  for (const field of write.fields) {
    if (observation.fieldCoverage[field]?.status !== 'observed') continue;
    const after = observation.fields[field] ?? null;
    if (!sendable(after)) {
      manual.push({ resourceKey: observation.resourceKey, field, after, reason: 'the value is structured, so the re-created policy is sent without it; an administrator applies it' });
      continue;
    }
    if (after === null) continue;
    fields.push({ field, before: null, after });
  }
  return fields;
}

/**
 * Turns each `--target` into the resource key it names. Most objects (rules,
 * connectors, policies) are keyed by Guid, so a target written with the object's name
 * (`transport-rule:KEEL-RT-x`) would match nothing and quietly plan no change. When a
 * target is not a key, it is matched case-insensitively on Name against the source and
 * the live read, within the same kind of object (the part before the colon): one Guid
 * found replaces it; two or more refuse the plan, naming each Guid key. A target that
 * matches nothing is kept, so the plan lists it as found nowhere.
 */
export function resolveNamedTargets(targets, observations = [], liveResources = []) {
  const items = [...observations, ...liveResources];
  const known = new Set(items.map((item) => item.resourceKey));
  const resolved = [];
  for (const raw of targets ?? []) {
    const target = String(raw).toLowerCase();
    const colon = target.indexOf(':');
    const name = target.slice(colon + 1);
    if (known.has(target) || colon <= 0 || !name) { resolved.push(target); continue; }
    const prefix = target.slice(0, colon + 1);
    const matches = [...new Set(items
      .filter((item) => String(item.resourceKey).startsWith(prefix)
        && GUID_RE.test(String(item.resourceKey).slice(prefix.length))
        && String(item.fields?.Name ?? '').toLowerCase() === name)
      .map((item) => item.resourceKey))].sort();
    if (matches.length > 1) {
      throw new Error(`${raw} names ${matches.length} objects; these are keyed by Guid, so name one of them: ${matches.map((key) => `--target ${key}`).join(', ')}`);
    }
    resolved.push(matches[0] ?? target);
  }
  return [...new Set(resolved)];
}

/**
 * Builds the frozen plan. `source` is a recorded collection of `workload`
 * (loadWorkloadSource); `live` is the workload's read run now. `targets` names
 * resource keys to restore; empty means every object of a written family in the source.
 * `tenantRef` decides the fixture guard; `allowTenantWide` is the separate tenant-wide
 * option, recorded in the plan.
 */
export function planWorkloadSettingsRestore({
  workload, source, live, tenantId, tenantRef, targets = [], declarations = WKLD_WRITE_OPERATIONS,
  testTenantRefs = TEST_TENANT_REFS, allowTenantWide = false,
}) {
  if (!source?.collectionId) throw new TypeError('a workload restore needs a recorded source collection');
  if (typeof tenantRef !== 'string' || !tenantRef) throw new TypeError('a workload restore plan needs the tenant');
  if (typeof tenantId !== 'string' || !GUID_RE.test(tenantId)) throw new TypeError('tenantId must be the managed tenant\'s directory id');
  if (!['complete', 'complete-empty', 'partial'].includes(source.outcome)) throw new Error(`a ${source.outcome} collection is not a restore source`);
  const families = writeFamilies(workload, declarations);
  const manualOnly = MANUAL_FAMILIES[workload] ?? {};
  if (Object.keys(families).length === 0) throw new Error(`KEEL declares no write for ${workload}`);
  const observations = source.observations ?? [];
  const named = resolveNamedTargets(targets, observations, live?.resources ?? []);
  const keys = named.length
    ? named
    : [...new Set([
      ...observations.filter((item) => families[item.kind] || manualOnly[item.kind]).map((item) => item.resourceKey),
      ...(live?.resources ?? []).filter((item) => families[item.kind] || manualOnly[item.kind]).map((item) => item.resourceKey),
    ])].sort();

  const manual = [];
  const operations = [];
  const resources = [];
  const refusals = [];
  const liveFingerprints = {};
  for (const key of keys) {
    const observation = observations.find((item) => item.resourceKey === key) ?? null;
    const current = liveEntry(live, key);
    const family = observation?.kind ?? current?.kind ?? null;
    const ops = family ? families[family] : null;
    if (!ops?.update && manualOnly[family]) {
      // Backed up and compared, but the service refuses KEEL's writes: every difference is listed.
      const gap = familyGap(live, family);
      if (gap) manual.push({ resourceKey: key, field: null, reason: `the live ${family} read was ${gap.status}, so nothing is compared`, error: gap.error ?? null });
      else if (!observation) manual.push({ resourceKey: key, field: null, reason: 'the source has no observation of this object (it is newer); KEEL never deletes it' });
      else if (!current) manual.push({ resourceKey: key, field: null, reason: `it no longer exists. ${manualOnly[family]}; an administrator re-creates it` });
      else {
        const listed = [];
        planFields({ fields: [] }, { observation, current, manual: listed });
        for (const item of listed) manual.push('before' in item ? { ...item, reason: `${manualOnly[family]}; an administrator applies it` } : item);
      }
      continue;
    }
    if (!ops?.update) {
      manual.push({ resourceKey: key, field: null, reason: observation || current ? 'KEEL has no writer for this kind of object; an administrator restores it' : 'neither the source nor the live read has this object' });
      continue;
    }
    const gap = familyGap(live, family);
    if (gap) {
      manual.push({ resourceKey: key, field: null, reason: `the live ${family} read was ${gap.status}, so no change is planned`, error: gap.error ?? null });
      liveFingerprints[key] = null;
      continue;
    }
    liveFingerprints[key] = current ? fingerprint(current) : 'absent';
    if (current && (isLocked(current) || parentLock(live, current) === 'locked')) {
      refusals.push({ naturalKey: `${workload}:${key}`, reason: siteLocked(current.fields)
        ? `site-locked: ${key} is locked (LockState ${current.fields.LockState}); KEEL never changes or unlocks it`
        : `preservation-locked: ${key} or its policy is under a platform preservation lock; KEEL never changes it` });
      continue;
    }
    if (current && declarations[ops.update]?.identity === 'url' && !siteOpen(current)) {
      manual.push({ resourceKey: key, field: null, reason: 'the site\'s lock state was not read, so KEEL cannot tell it is unlocked; no change is planned' });
      continue;
    }
    if (current && parentLock(live, current) === 'unknown') {
      manual.push({ resourceKey: key, field: null, reason: `its policy ${current.parentPolicy} was not in the live read, so its preservation lock is unknown; no change is planned` });
      continue;
    }
    if (!observation) {
      manual.push({ resourceKey: key, field: null, reason: 'the source has no observation of this object (it is newer); KEEL never deletes it' });
      continue;
    }
    const write = declarations[ops.update];
    let op;
    if (!current) {
      const policyName = ops.add && /^tag:/i.test(String(observation.fields.Identity ?? ''));
      if (!policyName) {
        manual.push({ resourceKey: key, field: null, reason: 'it no longer exists; KEEL does not re-create it (it would get a new identity, and not every condition is held); an administrator re-creates it' });
        continue;
      }
      const add = declarations[ops.add];
      const fields = createFields(add, observation, manual);
      manual.push({ resourceKey: key, field: null, reason: 'the re-created policy is assigned to nobody; an administrator assigns it again' });
      op = { kind: 'add', operationId: ops.add, cmdlet: add.method, changes: fields, parameters: { ...identityParameters(add, observation), ...Object.fromEntries(fields.map(({ field, after }) => [field, after])) } };
    } else {
      const fields = planFields(write, { observation, current, manual });
      if (!fields.length) continue;
      op = { kind: 'update', operationId: ops.update, cmdlet: write.method, changes: fields, parameters: { ...identityParameters(write, current), ...Object.fromEntries(fields.map(({ field, after }) => [field, after])) } };
    }
    const naturalKey = `${workload}:${key}`;
    const notFixture = targetProblem(write, family, [current, observation].filter(Boolean), { key, tenantRef, testTenantRefs, allowTenantWide });
    if (notFixture) {
      refusals.push({ naturalKey, reason: `not-a-fixture: ${notFixture}` });
      continue;
    }
    operations.push({ key, family, resourceKey: key, naturalKey, ...op });
    resources.push({
      naturalKey, resourceType: write.resourceType, verb: op.kind,
      payload: { ...(current?.fields ?? {}), ...Object.fromEntries(op.changes.map(({ field, after }) => [field, after])) },
      live: current ? { state: 'present', payload: current.fields } : { state: 'absent' },
    });
  }

  const plan = {
    workload,
    tenantId: tenantId.toLowerCase(),
    targets: keys,
    source: { collectionId: source.collectionId, observedTo: source.observedTo ?? null, outcome: source.outcome },
    operations,
    manual,
    excluded: [],
    contentEffects: classifyWorkloadEffects(resources),
    refusals,
    liveFingerprints,
    // Only a plan made with the option carries it, so other plans keep their digest.
    ...(allowTenantWide === true ? { allowTenantWide: true } : {}),
  };
  plan.digest = workloadSettingsPlanDigest(plan);
  return deepFreeze(plan);
}

/** Persists the plan as an immutable dry-run artifact. */
export async function createWorkloadSettingsArtifact(client, { tenantRef, plan, requestedBy, id = randomUUID() }) {
  const configPath = `workload:${plan.workload}`;
  return createDryRunArtifact(client, {
    id,
    tenantRef,
    snapshotId: null,
    selection: plan.targets.map((key) => `${plan.workload}:${key}`),
    closureKeys: [...new Set([...plan.targets.map((key) => `${plan.workload}:${key}`), ...plan.operations.map((op) => op.naturalKey)])],
    targetTenantId: plan.tenantId,
    collectorConfigPath: configPath,
    targetConfigPath: configPath,
    reconciliationResources: null,
    waves: [],
    patches: [],
    guardRefusals: plan.refusals,
    results: { operations: plan.operations.length, manual: plan.manual.length },
    currentStateFingerprint: sha256(plan.liveFingerprints),
    digest: plan.digest,
    status: plan.refusals.length ? 'refused' : 'completed',
    requestedBy,
    contentEffects: plan.contentEffects,
    workloadRestore: plan,
    complianceFix: plan.complianceFix ?? null,
  });
}

// ------------------------------------------------------------ execution

/**
 * Promotes one approved artifact. `read({ powershell })` re-reads the workload live;
 * `qualifications` maps each write operationId to its qualification.
 * Plan outcomes: refused, no-change, disabled, blocked-content-effect, verified, partial.
 * Operation outcomes: disabled, blocked-content-effect, refused, stale, failed,
 * verification-failed, verified.
 */
export async function executeWorkloadSettingsRestore(client, {
  tenantRef, artifactId, tenantId, workload, read, powershell = {}, qualifications = {}, actor = null,
  testTenantRefs = TEST_TENANT_REFS, declarations = WKLD_WRITE_OPERATIONS,
}) {
  const artifact = await getDryRunArtifact(client, { id: artifactId, tenantRef });
  const by = actor ?? artifact?.requestedBy ?? 'keel';
  const finish = async (result) => {
    await appendEvidence(client, {
      tenantRef, kind: WORKLOAD_SETTINGS_EVIDENCE_KIND,
      subject: { artifactId, operationId: `${workload}.restore`, outcome: result.outcome, operations: result.operations.map(({ key, outcome }) => ({ key, outcome })), reasons: result.reasons ?? [] },
      actor: by,
    });
    return result;
  };
  const refuse = (reason) => finish({ outcome: 'refused', operations: [], reasons: [reason] });

  const plan = artifact?.workloadRestore ?? null;
  if (!plan || plan.workload !== workload) return refuse(`no ${workload} restore plan with this id`);
  const promotable = validateArtifactForApproval(artifact);
  if (!promotable.ok) return refuse(promotable.reason);
  if (workloadSettingsPlanDigest(plan) !== plan.digest || artifact.digest !== plan.digest || !same(artifact.contentEffects ?? [], plan.contentEffects)) {
    return refuse('the stored plan no longer matches its digest; a new dry run is required');
  }
  if (String(tenantId ?? '').toLowerCase() !== plan.tenantId) return refuse(`the plan targets tenant ${plan.tenantId}, not ${tenantId}`);
  if (plan.operations.length === 0) return finish({ outcome: 'no-change', operations: [], reasons: ['the live configuration already matches the source'] });

  const results = new Map();
  const settle = async (op, result) => {
    const full = { writes: 0, verified: [], ...result };
    results.set(op.key, { key: op.key, kind: op.kind, operationId: op.operationId, ...full });
    await appendEvidence(client, {
      tenantRef,
      kind: WORKLOAD_SETTINGS_EVIDENCE_KIND,
      subject: {
        artifactId, operationId: op.operationId, kind: op.kind, target: op.resourceKey,
        outcome: full.outcome, writes: full.writes, attempts: full.attempts ?? full.writes, verified: full.verified, reasons: full.reasons, error: full.error ?? null,
      },
      actor: by,
    });
  };

  let runnable = [];
  for (const op of plan.operations) {
    const qualification = qualifications[op.operationId];
    if (qualification?.operationId !== op.operationId || qualification.enabled !== true) {
      await settle(op, { outcome: 'disabled', reasons: [...(qualification?.reasons ?? [`no write qualification was supplied for ${op.operationId}`])] });
    } else runnable.push(op);
  }
  const affected = (op) => plan.contentEffects.some((effect) => effect.naturalKey === op.naturalKey);
  if (runnable.some(affected)) {
    try {
      await assertContentEffectApproval(client, { artifact, effects: plan.contentEffects });
    } catch (error) {
      for (const op of runnable.filter(affected)) await settle(op, { outcome: 'blocked-content-effect', reasons: [error.message] });
      runnable = runnable.filter((op) => !affected(op));
    }
  }
  // Re-read just before each write: nothing it touches may have changed since the dry run.
  for (const op of runnable) {
    const family = op.family;
    let live = null;
    try { live = await read({ powershell }); } catch { live = null; }
    const entry = !live || familyGap(live, family) ? undefined : liveEntry(live, op.resourceKey);
    const now = entry === undefined ? null : entry ? fingerprint(entry) : 'absent';
    const parent = entry ? parentLock(live, entry) : 'none';
    if (now === null || now !== plan.liveFingerprints[op.resourceKey] || parent === 'unknown') {
      await settle(op, { outcome: 'stale', reasons: [`the live ${family} or its policy changed since the dry run, or could not be re-read; a new dry run is required`] });
      continue;
    }
    if (entry && (isLocked(entry) || parent === 'locked')) {
      await settle(op, { outcome: 'refused', reasons: [siteLocked(entry.fields) ? 'the site is now locked; KEEL never changes or unlocks it' : 'the object or its policy now reports a preservation lock; KEEL never changes it'] });
      continue;
    }
    // The fixture guard again, on what is about to be written: the object read now, or
    // for a re-created policy the name it is created with.
    const write = declarations[op.operationId];
    if (write?.identity === 'url' && !siteOpen(entry)) {
      await settle(op, { outcome: 'refused', reasons: ['the site\'s lock state could not be read now; KEEL never writes a site it cannot tell is unlocked'] });
      continue;
    }
    const writing = entry ?? { fields: { Identity: `Tag:${op.parameters?.Identity ?? ''}` } };
    const notFixture = write
      ? targetProblem(write, family, [writing], { key: op.resourceKey, tenantRef, testTenantRefs, allowTenantWide: plan.allowTenantWide === true })
      : `${op.operationId} is not a declared write`;
    if (notFixture) {
      await settle(op, { outcome: 'refused', reasons: [notFixture] });
      continue;
    }
    // The weakening guard again, on the values about to be sent over the object read now.
    const weakened = entry && write ? op.changes.filter(({ field }) => weakensMailProtection(write.resourceType, field, entry.fields?.[field], op.parameters?.[field])) : [];
    if (weakened.length) {
      await settle(op, { outcome: 'refused', reasons: [`${weakened.map(({ field }) => field).join(', ')}: ${WEAKENING_REASON}`] });
      continue;
    }
    await runOperation(op, { powershell, read, settle });
  }

  const operations = plan.operations.map((op) => results.get(op.key));
  const outcomes = new Set(operations.map((op) => op.outcome));
  let outcome = 'partial';
  for (const single of ['verified', 'disabled', 'blocked-content-effect']) if (outcomes.size === 1 && outcomes.has(single)) outcome = single;
  return finish({ outcome, operations, reasons: [] });
}

// A list cleared with $null (the documented way to empty one) reads back as an empty list.
const readsBackAs = (read, written) => same(read, written) || (written === null && Array.isArray(read) && read.length === 0);

async function verify(op, { powershell, read, settle }, { ambiguous, cause }) {
  let entry = null;
  try {
    const live = await read({ powershell });
    entry = familyGap(live, op.family) ? null : liveEntry(live, op.resourceKey);
  } catch (error) {
    cause = cause ?? error.message;
  }
  if (!entry) {
    await settle(op, { outcome: ambiguous ? 'failed' : 'verification-failed', writes: 1, attempts: 1, reasons: [`the write ${ambiguous ? `had an unknown outcome (${cause}) and was not resent;` : 'was sent, but'} the object could not be read back`] });
    return;
  }
  const verified = [];
  const mismatched = [];
  for (const { field, after } of op.changes) {
    (entry.fieldCoverage?.[field]?.status === 'observed' && readsBackAs(entry.fields[field], after) ? verified : mismatched).push(field);
  }
  if (!mismatched.length) {
    await settle(op, {
      outcome: 'verified', writes: 1, attempts: 1, verified,
      reasons: ambiguous ? [`the write outcome was unknown (${cause}); the re-read shows it applied, so it was not resent`] : [],
    });
    return;
  }
  await settle(op, {
    outcome: ambiguous ? 'failed' : 'verification-failed', writes: 1, attempts: 1, verified,
    reasons: ambiguous
      ? [`the write outcome was unknown (${cause}) and the re-read does not show it; it was not resent`]
      : mismatched.map((field) => `${field} did not read back as written`),
  });
}

async function runOperation(op, context) {
  try {
    await workloadWriteCmdlet({ cmdlet: op.cmdlet, parameters: op.parameters }, context.powershell);
  } catch (error) {
    if (error instanceof CmdletError && error.detail.code === 'CMDLET_ERROR' && isSavedButNotDeployed(error.detail)) {
      await verify(op, context, { ambiguous: true, cause: 'Microsoft saved the change but reported that deploying the policy failed' });
      return;
    }
    if (error instanceof CmdletError && error.detail.code === 'CMDLET_ERROR') {
      const failed = structuredFailure(error);
      if (isPolicyStillDeploying(error.detail)) {
        await context.settle(op, {
          outcome: 'failed', writes: 1, attempts: 1,
          reasons: ['Microsoft is still deploying an earlier change to this policy and refused this one; run the restore again once that finishes'], error: failed.error,
        });
        return;
      }
      if (isPreservationLockFailure({ error: error.detail })) {
        await context.settle(op, { outcome: 'refused', writes: 1, attempts: 1, reasons: ['the platform refused the change because of a preservation lock; KEEL never retries or works around it'], error: failed.error });
        return;
      }
      await context.settle(op, {
        outcome: failed.status === 'denied' ? 'refused' : 'failed', writes: 1, attempts: 1,
        reasons: [`${op.cmdlet} failed: ${error.detail.message}; nothing is retried automatically`], error: failed.error,
      });
      return;
    }
    if (error instanceof WorkloadWriteScopeError || error instanceof TypeError) {
      await context.settle(op, { outcome: 'refused', reasons: [error.message] });
      return;
    }
    // No answer (timeout, crash, malformed output): reconcile by reading, never resend.
    await verify(op, context, { ambiguous: true, cause: error.message });
    return;
  }
  await verify(op, context, { ambiguous: false, cause: null });
}

// ------------------------------------------------------------ dispatch entries

/**
 * The dispatch.mjs entry for one workload. `read({ powershell, families })` is the
 * workload's own read-only collector; only the families KEEL writes or lists are re-read.
 */
export function workloadSettingsRestore({ workload, label, read }) {
  const families = restoreReadFamilies(workload);
  const readWritten = ({ powershell }) => read({ powershell, families });
  return Object.freeze({
    label,
    operations: Object.freeze(Object.keys(WKLD_WRITE_OPERATIONS).filter((id) => WKLD_WRITE_OPERATIONS[id].workload === workload)),
    usage: '--collection <id> [--target <key> ...]',
    // The live read of the written families, for a plan made from the live state
    // (Compliance "Make it pass", benchmarks/workloadFix.mjs).
    read: readWritten,
    async plan(client, { tenantRef, tenantId, request, connection }) {
      if (typeof request.collectionId !== 'string' || !request.collectionId) throw new Error('--collection <id> is required for this workload');
      const source = await loadWorkloadSource(client, { tenantRef, collectionId: request.collectionId, workload });
      if (!source) throw new Error(`no recorded ${label} collection ${request.collectionId} for this tenant`);
      const live = await readWritten({ powershell: connection.powershell });
      return planWorkloadSettingsRestore({
        workload, source, live, tenantId, tenantRef, targets: request.targets ?? [], allowTenantWide: request.allowTenantWide === true,
      });
    },
    create: createWorkloadSettingsArtifact,
    execute: (client, { tenantRef, artifactId, tenantId, connection, qualifications }) => executeWorkloadSettingsRestore(client, {
      tenantRef, artifactId, tenantId, workload, read: readWritten, powershell: connection.powershell, qualifications,
    }),
  });
}
