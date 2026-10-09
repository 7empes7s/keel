/**
 * Roadmap task-63: the per-operation qualification (fidelity) ledger.
 *
 * One explicit row per catalogue type × operation. It answers, from declared
 * evidence only:
 *  - can this operation be performed (the task-52 capability claim);
 *  - which credential performs it;
 *  - what happens to the object id;
 *  - why a retry is safe;
 *  - whether the operation needs reference remapping, and whether that
 *    remapping is proven;
 *  - what fixture and live evidence back the claim.
 *
 * Three rules, mirroring capabilities.mjs:
 *
 * 1. Every catalogue type has an EXPLICIT decision in TYPE_DECISIONS below:
 *    'automated' (writes registered in capabilities.mjs), 'manual' (recovery
 *    stays a refusal plus human steps, by design) or 'unknown' (not
 *    investigated). buildOperationLedger() throws if a catalogue type is
 *    missing, so a new type can never be silently treated as either.
 * 2. descriptor.remappable is NOT a write gate. Remapping is qualified per
 *    (resourceType, operation), and only where an operation actually rewrites
 *    a reference to a different id. A same-tenant update whose references
 *    resolve to the ids already in the payload remaps nothing and needs no
 *    remapping proof. A rewrite to a different id (a new object, another
 *    tenant) requires a recorded proof for exactly that operation.
 * 3. Nothing here can raise a claim. A decision label, a passing fixture
 *    harness run or a ledger row never changes capabilityFor(); only
 *    capabilities.mjs's explicit registration and qualifyLiveEvidence() can.
 */
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { reviewStateFor } from '../contracts/fieldProjection.mjs';
import {
  EDGE_OPERATIONS, OPERATIONS, capabilityFor, edgeCapabilityKey, isSupportedClaim,
} from './capabilities.mjs';

export const LEDGER_CONTRACT_VERSION = 1;
export const TYPE_DECISION_VALUES = Object.freeze(['automated', 'manual', 'unknown']);

const DOCS = 'https://learn.microsoft.com/en-us/graph/api';
const automated = (resource, reason) => ({ decision: 'automated', docs: `${DOCS}/resources/${resource}?view=graph-rest-1.0`, reason });
const manual = (reason, extra = {}) => ({ decision: 'manual', reason, ...extra });
const unknown = (extra = {}) => ({ decision: 'unknown', reason: 'not yet investigated for automated recovery', ...extra });

/**
 * The explicit per-type decision. Reviewed by hand, never derived from
 * CATALOG paths, descriptor.remappable or a fixture result. `softRestoreCandidate`
 * marks types Graph can restore from deleted items. That is a candidate for
 * investigation, not a capability.
 */
export const TYPE_DECISIONS = Object.freeze({
  organization: manual('the tenant object itself; it is never recreated'),
  domain: manual('requires DNS ownership verification outside Graph'),
  subscribedSku: manual('licences are purchased, not configured'),
  directorySettingTemplate: manual('Microsoft-published template catalogue'),
  groupSetting: automated('groupsetting', 'task-109 subset: update and delete of tenant-wide settings only; the template is never written and a delete needs a complete snapshot observation'),
  user: manual('tenant-bound identity; credentials are never readable', { softRestoreCandidate: true }),
  group: automated('group', 'create/update/delete/restore and member/owner edges are registered'),
  administrativeUnit: automated('administrativeunit', 'task-109 subset: update of displayName and description only; membership and scoped roles are not written'),
  contact: manual('organizational contacts are directory-synchronised and read-only in Graph'),
  application: automated('application', 'task-107 subset: create/update/restore-soft-deleted are registered; delete is not, and credentials are never written'),
  servicePrincipal: automated('serviceprincipal', 'task-107 subset: create only, bound to its application by appId'),
  oauth2PermissionGrant: unknown(),
  identityProvider: manual('client secrets are never readable'),
  certificateBasedAuthConfiguration: unknown(),
  directoryRole: manual('built-in roles are activated from templates, never authored'),
  roleDefinition: unknown(),
  directoryRoleTemplate: manual('Microsoft-published template catalogue'),
  roleAssignment: automated('unifiedroleassignment', 'create/update/delete are registered'),
  roleEligibilitySchedule: unknown(),
  conditionalAccessPolicy: automated('conditionalaccesspolicy', 'create/update/delete are registered; writes are forced report-only'),
  authenticationStrengthPolicy: automated('authenticationstrengthpolicy', 'task-108 subset: create/update of custom strengths only; built-in strengths are immutable and refused, delete is not registered'),
  namedLocation: automated('namedlocation', 'create/update/delete are registered'),
  authenticationContextClassReference: unknown(),
  authenticationMethodsPolicy: automated('authenticationmethodspolicy', 'task-149: update of the policy and its method configurations, only behind the break-glass lockout gate'),
  identitySecurityDefaultsEnforcementPolicy: automated('identitysecuritydefaultsenforcementpolicy', 'task-149: update of isEnabled, only behind the break-glass lockout gate'),
  authorizationPolicy: automated('authorizationpolicy', 'task-149: update of guest, consent and default user permission settings, only behind the break-glass lockout gate'),
  crossTenantAccessPolicy: automated('crosstenantaccesspolicy', 'task-149: update of allowedCloudEndpoints'),
  crossTenantAccessPolicyConfigurationDefault: automated('crosstenantaccesspolicyconfigurationdefault', 'task-149: update of the default B2B, direct connect and inbound trust settings'),
  crossTenantAccessPolicyPartner: automated('crosstenantaccesspolicyconfigurationpartner', 'task-149: create and update; delete is not registered'),
  permissionGrantPolicy: unknown(),
  adminConsentRequestPolicy: automated('adminconsentrequestpolicy', 'task-149: update (PUT) of the whole policy'),
  activityBasedTimeoutPolicy: unknown(),
  claimsMappingPolicy: unknown(),
  homeRealmDiscoveryPolicy: unknown(),
  tokenIssuancePolicy: unknown(),
  tokenLifetimePolicy: unknown(),
  featureRolloutPolicy: unknown(),
  accessReviewScheduleDefinition: unknown(),
  accessPackage: unknown(),
  connectedOrganization: unknown(),
  deviceConfiguration: unknown(),
  deviceCompliancePolicy: unknown(),
  configurationPolicy: unknown(),
  deviceEnrollmentConfiguration: unknown(),
  deviceManagementRoleDefinition: unknown(),
  deviceCategory: unknown(),
  termsAndConditions: unknown(),
  windowsAutopilotDeploymentProfile: unknown(),
  deviceManagementIntent: unknown(),
  managedDevice: manual('device state, enrolled by the device, not configuration'),
  mobileApp: unknown(),
  managedAppPolicy: unknown(),
  targetedManagedAppConfiguration: unknown(),
  mobileAppConfiguration: unknown(),
});

// Why a retried operation can never double-apply — each names the mechanism in
// applyEngine.mjs / relationshipWriter.mjs that makes it so.
const IDEMPOTENCY = Object.freeze({
  create: 'natural-key reconciled: the target is re-collected before every run, so an existing object is updated, never re-created',
  update: 'full-state PATCH verified by read-back; repeating it converges',
  delete: 'verified by a read-back 404; an already-absent object is a no-op',
  'restore-soft-deleted': 'verified present after restore; an already-restored object takes the update path',
  'edge-add': 'precondition read; an ambiguous outcome is re-read, never re-sent',
  'edge-remove': 'precondition read; an ambiguous outcome is re-read, never re-sent',
});

// Which operations ever rewrite references in their payload (applyEngine.mjs's
// rewriteReferences call sites). Delete and edge operations write no payload.
const REWRITES_REFERENCES = new Set(['create', 'update', 'restore-soft-deleted']);

// resourceType -> Map<operation, { proofRef }>
const REMAPPING_PROOFS = new Map();

/**
 * Records that rewriting references to a DIFFERENT id has been proven for
 * exactly this (resourceType, operation), through the production applyWave
 * path. A proof for one operation never covers another.
 */
export function recordRemappingProof(resourceType, operation, proofRef) {
  if (!REWRITES_REFERENCES.has(operation)) {
    throw new TypeError(`${resourceType} ${operation}: this operation writes no references, so there is nothing to remap`);
  }
  if (!isSupportedClaim(capabilityFor(resourceType, operation).claim)) {
    throw new Error(`${resourceType} ${operation}: remapping proof requires a registered write capability first`);
  }
  if (typeof proofRef !== 'string' || proofRef.length === 0) {
    throw new TypeError(`${resourceType} ${operation}: remapping proof requires a proofRef`);
  }
  if (!REMAPPING_PROOFS.has(resourceType)) REMAPPING_PROOFS.set(resourceType, new Map());
  REMAPPING_PROOFS.get(resourceType).set(operation, Object.freeze({ proofRef }));
}

/** The remapping qualification applyWave consults when a rewrite changes an id. */
export function remappingFor(resourceType, operation) {
  if (!REWRITES_REFERENCES.has(operation)) return Object.freeze({ requirement: 'none', qualified: true, proofRef: null });
  const proof = REMAPPING_PROOFS.get(resourceType)?.get(operation) ?? null;
  return Object.freeze({ requirement: 'when-a-reference-id-changes', qualified: proof !== null, proofRef: proof?.proofRef ?? null });
}

// Remapping proven against the production applyWave path. Each proofRef names
// the test that rewrites a reference to a different target id for exactly this
// operation and asserts the written payload carries it.
recordRemappingProof('group', 'create', 'engine/restore/applyPatches.test.mjs');
recordRemappingProof('roleAssignment', 'create', 'engine/restore/applyEngine.test.mjs');
recordRemappingProof('conditionalAccessPolicy', 'create', 'cli/keel-restore.test.mjs');
recordRemappingProof('conditionalAccessPolicy', 'update', 'engine/roadmap/fidelity-ledger.test.mjs');
// Roadmap task-107: a service principal created for an application recreated in
// the same run carries that application's NEW appId (EXPLICIT_REFERENCES below).
recordRemappingProof('servicePrincipal', 'create', 'engine/roadmap/fidelity-expansion.test.mjs');

function sourceFor(type, decision) {
  const entry = CATALOG.find((candidate) => candidate.type === type);
  return Object.freeze({
    graphPath: entry?.path ?? null,
    apiVersion: entry?.version ?? null,
    docs: decision.docs ?? null,
  });
}

function rowFor(resourceType, operation, { capabilityKey = resourceType, decision }) {
  const capability = capabilityFor(capabilityKey, operation);
  const supported = isSupportedClaim(capability.claim);
  const remapping = supported ? remappingFor(capabilityKey, operation) : null;
  return Object.freeze({
    resourceType: capabilityKey,
    operation,
    // A row is 'supported' only through a registered capability; otherwise the
    // type's explicit decision ('manual' or 'unknown') stands for the operation.
    decision: supported ? 'supported' : decision.decision === 'automated' ? 'unsupported' : decision.decision,
    claim: capability.claim,
    credentialMode: capability.credentialMode,
    idOutcome: capability.idOutcome,
    idempotency: supported ? IDEMPOTENCY[operation] : null,
    remapping,
    fieldClassification: reviewStateFor(resourceType),
    fixture: capability.claim === 'fixture-tested' || capability.claim === 'live-qualified'
      ? { result: 'passed', proofRef: capability.claim === 'fixture-tested' ? capability.proofRef : null }
      : { result: 'none', proofRef: null },
    live: capability.claim === 'live-qualified' ? { result: 'qualified', proofRef: capability.proofRef } : { result: 'none', proofRef: null },
    softRestoreCandidate: operation === 'restore-soft-deleted' && decision.softRestoreCandidate === true && !supported,
  });
}

/**
 * The full ledger: every catalogue type (and every collecting descriptor) ×
 * OPERATIONS, plus the registered relationship edge operations. Throws when
 * any type lacks an explicit decision.
 */
export function buildOperationLedger({ decisions = TYPE_DECISIONS } = {}) {
  const types = [...new Set([...CATALOG.map((entry) => entry.type), ...DESCRIPTORS.map((descriptor) => descriptor.type)])];
  const missing = types.filter((type) => !decisions[type]);
  if (missing.length > 0) throw new Error(`no explicit qualification decision for: ${missing.join(', ')}`);
  for (const [type, decision] of Object.entries(decisions)) {
    if (!TYPE_DECISION_VALUES.includes(decision.decision)) throw new Error(`${type}: invalid decision ${decision.decision}`);
  }

  const rows = types.map((type) => {
    const decision = decisions[type];
    const operations = OPERATIONS.map((operation) => rowFor(type, operation, { decision }));
    if (decision.decision === 'automated') {
      // A type marked automated must actually have at least one registered
      // operation; the label alone proves nothing.
      if (!operations.some((row) => row.decision === 'supported')) {
        throw new Error(`${type} is marked automated but has no registered write capability`);
      }
    } else if (operations.some((row) => row.decision === 'supported')) {
      throw new Error(`${type} has a registered write capability but is marked ${decision.decision}`);
    }
    return Object.freeze({
      resourceType: type,
      decision: decision.decision,
      reason: decision.reason,
      softRestoreCandidate: decision.softRestoreCandidate === true,
      source: sourceFor(type, decision),
      operations: Object.freeze(operations),
    });
  });

  const edges = ['member', 'owner'].flatMap((family) => EDGE_OPERATIONS.map((operation) => rowFor('group', operation, {
    capabilityKey: edgeCapabilityKey('group', family), decision: decisions.group,
  })));

  return Object.freeze({ contractVersion: LEDGER_CONTRACT_VERSION, types: Object.freeze(rows), edges: Object.freeze(edges) });
}

/** The compact per-type decision the coverage report and portal show. */
export function qualificationFor(resourceType, { decisions = TYPE_DECISIONS } = {}) {
  const decision = decisions[resourceType];
  if (!decision) return Object.freeze({ decision: 'unknown', reason: 'no explicit decision recorded', softRestoreCandidate: false, remapping: {} });
  const remapping = {};
  for (const operation of REWRITES_REFERENCES) {
    if (isSupportedClaim(capabilityFor(resourceType, operation).claim)) remapping[operation] = remappingFor(resourceType, operation).qualified;
  }
  return Object.freeze({
    decision: decision.decision,
    reason: decision.reason,
    softRestoreCandidate: decision.softRestoreCandidate === true,
    remapping: Object.freeze(remapping),
    // Roadmap task-107: the type's expansion batch and its derived restore scope.
    expansion: expansionFor(resourceType),
  });
}

/**
 * Roadmap task-103: workload configuration WRITES, qualified per operation.
 *
 * These are not catalogue types and never enter TYPE_DECISIONS or the Entra
 * capability registry. Each declared write is disabled until:
 *  - the read it verifies through is enabled in the task-101 workload ledger
 *    (live-qualified, grants confirmed); and
 *  - a non-synthetic live write capture from THIS tenant, at the version in use,
 *    no older than 30 days, wrote the setting and read it back.
 * A fixture run proves the code path only: it yields `fixture-tested`, which is
 * still disabled. Nothing here sends a request.
 */
export const WORKLOAD_WRITE_EVIDENCE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const WORKLOAD_WRITE_OPERATIONS = Object.freeze({
  'sharepoint.tenant-settings.update': Object.freeze({
    workload: 'sharepoint-site-settings',
    resourceType: 'sharepointTenantSettings',
    method: 'PATCH',
    endpoint: '/admin/sharepoint/settings',
    version: 'v1.0',
    readBack: 'sharepoint.tenant-settings',
    fields: Object.freeze([
      'sharingCapability', 'sharingDomainRestrictionMode', 'sharingAllowedDomainList', 'sharingBlockedDomainList',
      'isResharingByExternalUsersEnabled',
    ]),
    rbac: Object.freeze({ permissions: ['SharePointTenantSettings.ReadWrite.All'], roles: ['SharePoint Administrator'] }),
    source: `${DOCS}/sharepointsettings-update?view=graph-rest-1.0`,
  }),
  // Roadmap task-104: Teams settings and structural membership. Each is its own
  // operation with its own proof. `requires` names the SharePoint write: Teams
  // activates only after SharePoint is qualified, and SharePoint proof is never
  // Teams proof (evidence counts only for the operationId it names).
  'teams.settings.update': Object.freeze({
    workload: 'teams-settings',
    resourceType: 'teamsTeamSettings',
    method: 'PATCH',
    endpoint: '/teams/{team-id}',
    version: 'v1.0',
    readBack: 'teams.settings',
    fields: Object.freeze(['memberSettings', 'guestSettings', 'messagingSettings', 'funSettings', 'discoverySettings']),
    rbac: Object.freeze({ permissions: ['TeamSettings.ReadWrite.All'], roles: [] }),
    requires: Object.freeze(['sharepoint.tenant-settings.update']),
    source: `${DOCS}/team-update?view=graph-rest-1.0`,
  }),
  'teams.membership.add': Object.freeze({
    workload: 'teams-settings',
    resourceType: 'teamsMembership',
    method: 'POST',
    endpoint: '/teams/{team-id}/members',
    version: 'v1.0',
    readBack: 'teams.membership',
    fields: Object.freeze(['roles']),
    rbac: Object.freeze({ permissions: ['TeamMember.ReadWrite.All'], roles: [] }),
    requires: Object.freeze(['sharepoint.tenant-settings.update']),
    source: `${DOCS}/team-post-members?view=graph-rest-1.0`,
  }),
  'teams.membership.update': Object.freeze({
    workload: 'teams-settings',
    resourceType: 'teamsMembership',
    method: 'PATCH',
    endpoint: '/teams/{team-id}/members/{membership-id}',
    version: 'v1.0',
    readBack: 'teams.membership',
    fields: Object.freeze(['roles']),
    rbac: Object.freeze({ permissions: ['TeamMember.ReadWrite.All'], roles: [] }),
    requires: Object.freeze(['sharepoint.tenant-settings.update']),
    source: `${DOCS}/team-update-members?view=graph-rest-1.0`,
  }),
  'teams.membership.remove': Object.freeze({
    workload: 'teams-settings',
    resourceType: 'teamsMembership',
    method: 'DELETE',
    endpoint: '/teams/{team-id}/members/{membership-id}',
    version: 'v1.0',
    readBack: 'teams.membership',
    fields: Object.freeze([]),
    rbac: Object.freeze({ permissions: ['TeamMember.ReadWrite.All'], roles: [] }),
    requires: Object.freeze(['sharepoint.tenant-settings.update']),
    source: `${DOCS}/team-delete-members?view=graph-rest-1.0`,
  }),
  // Roadmap task-105: Exchange mailbox and organization configuration. Four
  // distinct operations, each with its own proof. Every one requires the Teams
  // settings write first (which itself requires SharePoint), and every one needs
  // the restorer's grants OBSERVED (`grantsRequired`): unknown RBAC blocks the write.
  // Cmdlet writes are bound to the ExchangeOnlineManagement version in use.
  'exchange.mailbox-settings.update': Object.freeze({
    workload: 'exchange-mailbox-settings',
    resourceType: 'exchangeMailboxSettings',
    method: 'PATCH',
    endpoint: '/users/{user-id}/mailboxSettings',
    version: 'v1.0',
    readBack: 'exchange.mailbox-settings',
    fields: Object.freeze(['automaticRepliesSetting', 'timeZone', 'language', 'workingHours', 'dateFormat', 'timeFormat', 'delegateMeetingMessageDeliveryOptions']),
    rbac: Object.freeze({ permissions: ['MailboxSettings.ReadWrite'], roles: [] }),
    grantsRequired: true,
    requires: Object.freeze(['teams.settings.update']),
    source: `${DOCS}/user-update-mailboxsettings?view=graph-rest-1.0`,
  }),
  'exchange.client-access.update': Object.freeze({
    workload: 'exchange-mailbox-settings',
    resourceType: 'exchangeClientAccess',
    kind: 'cmdlet',
    method: 'Set-CASMailbox',
    module: 'ExchangeOnlineManagement',
    readBack: 'exchange.client-access',
    fields: Object.freeze(['OWAEnabled', 'ActiveSyncEnabled', 'PopEnabled', 'ImapEnabled', 'MAPIEnabled', 'EwsEnabled', 'SmtpClientAuthenticationDisabled']),
    rbac: Object.freeze({ permissions: ['Exchange.ManageAsApp'], roles: ['Exchange Administrator'] }),
    grantsRequired: true,
    requires: Object.freeze(['teams.settings.update']),
    source: 'https://learn.microsoft.com/en-us/powershell/module/exchange/set-casmailbox',
  }),
  'exchange.mailbox-retention.update': Object.freeze({
    workload: 'exchange-mailbox-settings',
    resourceType: 'exchangeMailboxRetention',
    kind: 'cmdlet',
    method: 'Set-Mailbox',
    module: 'ExchangeOnlineManagement',
    readBack: 'exchange.mailbox-hold',
    fields: Object.freeze(['LitigationHoldEnabled', 'RetentionHoldEnabled', 'SingleItemRecoveryEnabled', 'RetainDeletedItemsFor']),
    rbac: Object.freeze({ permissions: ['Exchange.ManageAsApp'], roles: ['Exchange Administrator'] }),
    grantsRequired: true,
    requires: Object.freeze(['teams.settings.update']),
    source: 'https://learn.microsoft.com/en-us/powershell/module/exchange/set-mailbox',
  }),
  'exchange.organization-config.update': Object.freeze({
    workload: 'exchange-mailbox-settings',
    resourceType: 'exchangeOrganizationConfig',
    kind: 'cmdlet',
    method: 'Set-OrganizationConfig',
    module: 'ExchangeOnlineManagement',
    readBack: 'exchange.organization-config',
    fields: Object.freeze([
      'FocusedInboxOn', 'MailTipsAllTipsEnabled', 'MailTipsExternalRecipientsTipsEnabled', 'MailTipsGroupMetricsEnabled',
      'MailTipsLargeAudienceThreshold', 'OAuth2ClientProfileEnabled', 'SmtpActionableMessagesEnabled', 'ConnectorsEnabled',
    ]),
    rbac: Object.freeze({ permissions: ['Exchange.ManageAsApp'], roles: ['Exchange Administrator'] }),
    grantsRequired: true,
    requires: Object.freeze(['teams.settings.update']),
    source: 'https://learn.microsoft.com/en-us/powershell/module/exchange/set-organizationconfig',
  }),
  // Roadmap task-106: Purview sensitivity label configuration. Two operations, each
  // with its own proof. They run in the Security & Compliance session of the same
  // module, so they require the Exchange cmdlet write first (which requires Teams,
  // then SharePoint); Exchange proof is never Purview proof. Only display text and
  // adding a label to a policy are writable: nothing KEEL writes can weaken a label's
  // protection or unpublish a label. No OneDrive write is declared.
  'purview.label.update': Object.freeze({
    workload: 'purview-labels',
    resourceType: 'purviewLabel',
    kind: 'cmdlet',
    method: 'Set-Label',
    module: 'ExchangeOnlineManagement',
    readBack: 'purview.label-definitions',
    fields: Object.freeze(['DisplayName', 'Tooltip', 'Comment']),
    rbac: Object.freeze({ permissions: ['Exchange.ManageAsApp'], roles: ['Compliance Administrator'] }),
    grantsRequired: true,
    requires: Object.freeze(['exchange.client-access.update']),
    source: 'https://learn.microsoft.com/en-us/powershell/module/exchange/set-label',
  }),
  'purview.label-policy.update': Object.freeze({
    workload: 'purview-labels',
    resourceType: 'purviewLabelPolicy',
    kind: 'cmdlet',
    method: 'Set-LabelPolicy',
    module: 'ExchangeOnlineManagement',
    readBack: 'purview.label-publication',
    fields: Object.freeze(['AddLabels']),
    rbac: Object.freeze({ permissions: ['Exchange.ManageAsApp'], roles: ['Compliance Administrator'] }),
    grantsRequired: true,
    requires: Object.freeze(['exchange.client-access.update']),
    source: 'https://learn.microsoft.com/en-us/powershell/module/exchange/set-labelpolicy',
  }),
});

/** The version a write runs under now: its Graph version, or its module's version. */
function writeVersion(declared, runtime) {
  if (declared.kind === 'cmdlet') return runtime?.modules?.[declared.module] ?? null;
  return declared.version;
}

function writeEvidenceProblems(item, { tenantRef, version, now }) {
  const problems = [];
  if (item.synthetic !== false) problems.push('synthetic evidence (a fixture run) is never live qualification');
  if (item.kind !== 'live-write-capture') problems.push(`${item.kind ?? 'unlabelled'} evidence is not a live write capture`);
  if (!tenantRef || item.tenantRef !== tenantRef) problems.push('captured in a different tenant, or no tenant was named');
  const at = Date.parse(item.capturedAt ?? '');
  if (Number.isNaN(at)) problems.push('no capture time');
  else if (at > now.getTime()) problems.push('captured in the future');
  else if (now.getTime() - at > WORKLOAD_WRITE_EVIDENCE_MAX_AGE_MS) problems.push('older than 30 days');
  if (version === null) problems.push('the version in use now is unknown');
  else if (item.version !== version) problems.push(`captured at version ${item.version ?? 'unknown'}, not ${version}`);
  if (item.ok !== true) problems.push('the write failed');
  if (item.readBackVerified !== true) problems.push('the write was not read back and verified');
  return problems;
}

/**
 * Whether one workload write may run. `readLedger` is the task-101 ledger;
 * `evidence` is every fixture result and write capture for this operation.
 */
/**
 * `runtime.modules` gives the module versions in use now (a cmdlet write is bound
 * to its module version). `grants` is what the RESTORER app is observed to hold
 * ({ permissions, roles }); a write declared `grantsRequired` stays disabled while
 * it is unknown or short of the declared RBAC.
 */
export function workloadWriteQualification(operationId, { readLedger = null, evidence = [], tenantRef = null, now = new Date(), runtime = {}, grants = null, _seen = new Set() } = {}) {
  const declared = WORKLOAD_WRITE_OPERATIONS[operationId];
  if (!declared) {
    return Object.freeze({ operationId, state: 'undeclared', enabled: false, reasons: [`${operationId} is not a declared workload write`], proof: { fixture: null, live: null } });
  }
  const mine = evidence.filter((item) => item.operationId === operationId);
  const fixture = mine.find((item) => item.kind === 'fixture' && item.ok === true) ?? null;
  const reasons = [];
  let live = null;
  for (const item of mine.filter((candidate) => candidate.kind !== 'fixture')) {
    const problems = writeEvidenceProblems(item, { tenantRef, version: writeVersion(declared, runtime), now });
    if (problems.length === 0) { live = item; break; }
    reasons.push(`${item.proofRef ?? 'capture'}: ${problems.join('; ')}`);
  }
  const readRow = (readLedger?.rows ?? []).find((row) => row.id === declared.readBack) ?? null;
  const readEnabled = readRow?.enabled === true && (!tenantRef || readLedger?.tenantRef === tenantRef);
  if (!readEnabled) reasons.push(`${declared.readBack} (the read-back) is ${readRow?.state ?? 'not in the ledger'}, not enabled for this tenant`);
  // A prerequisite workload write must itself be enabled. Its proof is evaluated
  // for its own operationId and never transfers to this one.
  let prerequisitesEnabled = true;
  for (const required of declared.requires ?? []) {
    if (_seen.has(required)) throw new Error(`${operationId}: circular workload write prerequisite ${required}`);
    const prerequisite = workloadWriteQualification(required, { readLedger, evidence, tenantRef, now, runtime, grants, _seen: new Set([..._seen, operationId]) });
    if (!prerequisite.enabled) {
      prerequisitesEnabled = false;
      reasons.push(`${required} must be live-qualified first (it is ${prerequisite.state})`);
    }
  }

  // Task-105: unknown RBAC blocks a write that declares it needs observed grants.
  let grantsSatisfied = true;
  if (declared.grantsRequired) {
    if (!grants || !Array.isArray(grants.permissions) || !Array.isArray(grants.roles)) {
      grantsSatisfied = false;
      reasons.push('the restorer\'s grants are unknown; its permissions and roles must be observed before this write');
    } else {
      const missing = [
        ...declared.rbac.permissions.filter((name) => !grants.permissions.includes(name)),
        ...declared.rbac.roles.filter((name) => !grants.roles.includes(name)),
      ];
      if (missing.length) {
        grantsSatisfied = false;
        reasons.push(`the restorer lacks ${missing.join(', ')}`);
      }
    }
  }

  let state;
  if (live) state = 'live-qualified';
  else if (fixture) { state = 'fixture-tested'; reasons.push('fixture proof only: a live write capture from this tenant is required'); }
  else { state = 'disabled'; reasons.push('no proof yet'); }
  return Object.freeze({
    operationId,
    state,
    enabled: state === 'live-qualified' && readEnabled && prerequisitesEnabled && grantsSatisfied,
    reasons: Object.freeze(reasons),
    proof: Object.freeze({
      fixture: fixture ? { proofRef: fixture.proofRef ?? null } : null,
      live: live ? { proofRef: live.proofRef ?? null, capturedAt: live.capturedAt } : null,
    }),
  });
}

// ---------------------------------------------------------------------------
// Roadmap task-107: measured Entra operation expansion batches.
//
// Every catalogue type is placed in exactly one batch with an explicit status:
//   qualified-subset — at least one operation is registered in capabilities.mjs
//                      (derived from the registry, never declared here);
//   manual           — recovery is a human step by design (TYPE_DECISIONS);
//   unsupported      — no Graph write route exists for the configuration;
//   research-needed  — a route may exist but its API, permission or safety
//                      contract has not been checked for KEEL.
// A non-qualified entry must name the API and permission reason. A status can
// never be raised by editing this table: buildExpansionInventory() throws when
// an entry claims more than the registry proves, and an entry carries no
// "restorable" flag at all — the restore scope is derived from registered
// operations only.

export const EXPANSION_CONTRACT_VERSION = 1;
export const EXPANSION_STATUSES = Object.freeze(['qualified-subset', 'manual', 'unsupported', 'research-needed']);

export const EXPANSION_BATCHES = Object.freeze([
  Object.freeze({ id: 'identity-application', label: 'Identity and applications', task: 'task-107' }),
  Object.freeze({ id: 'policy', label: 'Policies', task: 'task-108' }),
  Object.freeze({ id: 'administrative-configuration', label: 'Administrative configuration', task: 'task-109' }),
  // Intune is not an Entra family; it is accounted for here so no catalogue type
  // is silently left out, and no Entra batch is responsible for it.
  Object.freeze({ id: 'device-management', label: 'Device management (Intune, outside the Entra batches)', task: null }),
]);

const APP_RW = 'Application.ReadWrite.All (restorer); not verified as granted to the KEEL Restorer';
const research = (batch, api, permission, reason) => ({ batch, status: 'research-needed', api, permission, reason });
const notWritable = (batch, api, permission, reason) => ({ batch, status: 'unsupported', api, permission, reason });
const byHand = (batch, api, permission, reason) => ({ batch, status: 'manual', api, permission, reason });
const subset = (batch, api, permission, reason) => ({ batch, status: 'qualified-subset', api, permission, reason });

/**
 * The reviewed inventory. `api` names the Graph route a write would use (null
 * when none exists); `permission` names the least privilege a writer would need.
 * Documentation was not re-fetched in the task-107 session (learn.microsoft.com
 * is blocked from the build container), so every route here is a declaration
 * to confirm before any live qualification — see docs/roadmap/fidelity-expansion.md.
 */
export const EXPANSION_INVENTORY = Object.freeze({
  // ---- identity and applications (task-107)
  application: subset('identity-application', 'POST /applications; PATCH /applications/{id}; POST /directory/deletedItems/{id}/restore', APP_RW,
    'create, update and soft-delete restore are fixture-tested; delete is refused; secrets and certificates are never written and a recreate opens credential completion items'),
  servicePrincipal: subset('identity-application', 'POST /servicePrincipals', APP_RW,
    'create is fixture-tested and takes the appId of its application (remapped when the application was recreated); update, delete and soft-delete restore are not qualified'),
  user: byHand('identity-application', 'POST /users', 'User.ReadWrite.All', 'tenant-bound identity; passwords and MFA methods are never readable'),
  group: subset('identity-application', 'POST/PATCH/DELETE /groups', 'Group.ReadWrite.All', 'registered before task-107'),
  contact: byHand('identity-application', null, 'none', 'organizational contacts are directory-synchronised and read-only in Graph'),
  oauth2PermissionGrant: research('identity-application', 'POST /oauth2PermissionGrants', 'DelegatedPermissionGrant.ReadWrite.All',
    'delegated consent is a grant decision, not configuration; re-granting needs an approval contract that does not exist yet'),
  identityProvider: byHand('identity-application', 'POST /identity/identityProviders', 'IdentityProvider.ReadWrite.All', 'client secrets are never readable'),
  certificateBasedAuthConfiguration: research('identity-application', 'POST /organization/{id}/certificateBasedAuthConfiguration', 'Organization.ReadWrite.All',
    'tenant-lockout blast radius; no simulation gate for certificate trust changes exists'),
  directoryRole: byHand('identity-application', 'POST /directoryRoles (activate from template)', 'RoleManagement.ReadWrite.Directory', 'built-in roles are activated from templates, never authored'),
  roleDefinition: research('identity-application', 'POST /roleManagement/directory/roleDefinitions', 'RoleManagement.ReadWrite.Directory',
    'custom roles need a licence check and a privilege-escalation review before any write'),
  directoryRoleTemplate: byHand('identity-application', null, 'none', 'Microsoft-published template catalogue'),
  roleAssignment: subset('identity-application', 'POST/DELETE /roleManagement/directory/roleAssignments', 'RoleManagement.ReadWrite.Directory', 'registered before task-107'),
  roleEligibilitySchedule: research('identity-application', 'POST /roleManagement/directory/roleEligibilityScheduleRequests', 'RoleEligibilitySchedule.ReadWrite.Directory',
    'PIM writes go through schedule requests with their own approval and expiry semantics'),
  accessReviewScheduleDefinition: research('identity-application', 'POST /identityGovernance/accessReviews/definitions', 'AccessReview.ReadWrite.All',
    'review history and decisions cannot be recreated; only the definition could be'),
  accessPackage: research('identity-application', 'POST /identityGovernance/entitlementManagement/accessPackages', 'EntitlementManagement.ReadWrite.All',
    'depends on catalogs, policies and resource roles that are not collected'),
  connectedOrganization: research('identity-application', 'POST /identityGovernance/entitlementManagement/connectedOrganizations', 'EntitlementManagement.ReadWrite.All',
    'identity sources reference external tenants that cannot be verified from this tenant'),
  // ---- policies (task-108)
  conditionalAccessPolicy: subset('policy', 'POST/PATCH/DELETE /identity/conditionalAccess/policies', 'Policy.ReadWrite.ConditionalAccess', 'registered before task-107; forced report-only'),
  namedLocation: subset('policy', 'POST/PATCH/DELETE /identity/conditionalAccess/namedLocations', 'Policy.ReadWrite.ConditionalAccess', 'registered before task-107'),
  // Roadmap task-108: the custom-strength subset; the operation records, their
  // subtype and field-projection binding live in engine/restore/policyOperations.mjs.
  authenticationStrengthPolicy: subset('policy', 'POST /policies/authenticationStrengthPolicies; PATCH /policies/authenticationStrengthPolicies/{id}', 'Policy.ReadWrite.ConditionalAccess',
    'create and update of custom strengths are fixture-tested; built-in strengths are immutable and refused; allowedCombinations changes only through updateAllowedCombinations, which is not qualified, so its drift is reported not remediable; delete is refused'),
  // The remaining policy family ledger after task-108: each stays research-needed
  // for the reason named, and every write to it is refused.
  authenticationContextClassReference: research('policy', 'PATCH /identity/conditionalAccess/authenticationContextClassReferences/{id}', 'Policy.ReadWrite.ConditionalAccess',
    'ids c1..c99 are fixed per tenant and referenced by CA policies and SharePoint labels; an upsert contract and a check of what consumes each id do not exist'),
  // Roadmap task-149: the tenant-wide security policies. Records, routes and the
  // lockout gate binding live in engine/restore/tenantPolicyOperations.mjs.
  authenticationMethodsPolicy: subset('policy', 'PATCH /policies/authenticationMethodsPolicy; PATCH /policies/authenticationMethodsPolicy/authenticationMethodConfigurations/{id}', 'Policy.ReadWrite.AuthenticationMethod',
    'update of the root settings and of existing method configurations is fixture-tested and runs only when the break-glass accounts stay ready under the proposed policy; a method missing from the live policy is refused'),
  identitySecurityDefaultsEnforcementPolicy: subset('policy', 'PATCH /policies/identitySecurityDefaultsEnforcementPolicy', 'Policy.ReadWrite.SecurityDefaults',
    'update of isEnabled is fixture-tested and runs only behind the break-glass lockout gate'),
  authorizationPolicy: subset('policy', 'PATCH /policies/authorizationPolicy', 'Policy.ReadWrite.Authorization',
    'update of guest invitation, self-service, consent and default user permission settings is fixture-tested and runs only behind the break-glass lockout gate'),
  crossTenantAccessPolicy: subset('policy', 'PATCH /policies/crossTenantAccessPolicy', 'Policy.ReadWrite.CrossTenantAccess',
    'update of allowedCloudEndpoints is fixture-tested; the default and partner settings are their own types'),
  crossTenantAccessPolicyConfigurationDefault: subset('policy', 'PATCH /policies/crossTenantAccessPolicy/default', 'Policy.ReadWrite.CrossTenantAccess',
    'update of the default B2B collaboration, direct connect, inbound trust, consent and tenant restriction settings is fixture-tested'),
  crossTenantAccessPolicyPartner: subset('policy', 'POST /policies/crossTenantAccessPolicy/partners; PATCH /policies/crossTenantAccessPolicy/partners/{tenantId}', 'Policy.ReadWrite.CrossTenantAccess',
    'create and update are fixture-tested and keyed by the partner tenantId; Graph refuses a tenantId that does not exist; delete is refused'),
  permissionGrantPolicy: research('policy', 'POST /policies/permissionGrantPolicies', 'Policy.ReadWrite.PermissionGrant',
    'built-in microsoft-* policies are immutable; includes and excludes are separate collections with no qualified writer'),
  adminConsentRequestPolicy: subset('policy', 'PUT /policies/adminConsentRequestPolicy', 'Policy.ReadWrite.ConsentRequest',
    'update (a PUT of every writable field) is fixture-tested for the same tenant; reviewer queries are written as observed and are never remapped to another tenant'),
  activityBasedTimeoutPolicy: research('policy', 'POST /policies/activityBasedTimeoutPolicies', 'Policy.ReadWrite.ApplicationConfiguration',
    'definition is a JSON string KEEL does not parse; a tenant-wide default and per-application assignment are not distinguished'),
  claimsMappingPolicy: research('policy', 'POST /policies/claimsMappingPolicies', 'Policy.ReadWrite.ApplicationConfiguration',
    'assignment to service principals is a separate edge with no qualified writer; the definition string is unparsed'),
  homeRealmDiscoveryPolicy: research('policy', 'POST /policies/homeRealmDiscoveryPolicies', 'Policy.ReadWrite.ApplicationConfiguration',
    'changes federated sign-in routing; assignment is a separate edge; definition string is unparsed'),
  tokenIssuancePolicy: research('policy', 'POST /policies/tokenIssuancePolicies', 'Policy.ReadWrite.ApplicationConfiguration',
    'assignment to applications is a separate edge; the definition string is unparsed'),
  tokenLifetimePolicy: research('policy', 'POST /policies/tokenLifetimePolicies', 'Policy.ReadWrite.ApplicationConfiguration',
    'a tenant-wide default and per-application assignment are not distinguished; the definition string is unparsed'),
  featureRolloutPolicy: research('policy', 'POST /policies/featureRolloutPolicies', 'Policy.ReadWrite.FeatureRollout',
    'staged rollout of sign-in features; applies-to group membership is a separate edge with no qualified writer'),
  // ---- administrative configuration (task-109)
  organization: byHand('administrative-configuration', null, 'none', 'the tenant object itself; it is never recreated'),
  domain: byHand('administrative-configuration', 'POST /domains', 'Domain.ReadWrite.All', 'requires DNS ownership verification outside Graph'),
  subscribedSku: notWritable('administrative-configuration', null, 'none', 'licences are purchased, not configured'),
  directorySettingTemplate: byHand('administrative-configuration', null, 'none', 'Microsoft-published template catalogue; a global reference template is never written'),
  // Roadmap task-109: the operation records and their parent, dependency and
  // source-authority checks live in engine/restore/administrativeOperations.mjs.
  groupSetting: subset('administrative-configuration', 'PATCH /groupSettings/{id}; DELETE /groupSettings/{id}', 'GroupSettings.ReadWrite.All',
    'update and delete of tenant-wide settings are fixture-tested; the template is never written; create and group-scoped settings are not qualified'),
  administrativeUnit: subset('administrative-configuration', 'PATCH /directory/administrativeUnits/{id}', 'AdministrativeUnit.ReadWrite.All',
    'update of displayName and description is fixture-tested; create, delete, soft-delete restore, membership and scoped role members are not qualified'),
  // ---- device management (outside the Entra batches)
  deviceConfiguration: research('device-management', 'POST /deviceManagement/deviceConfigurations', 'DeviceManagementConfiguration.ReadWrite.All', 'Intune; no Intune restore workstream is scheduled'),
  deviceCompliancePolicy: research('device-management', 'POST /deviceManagement/deviceCompliancePolicies', 'DeviceManagementConfiguration.ReadWrite.All', 'Intune; scheduled actions are required on create'),
  configurationPolicy: research('device-management', 'POST /deviceManagement/configurationPolicies (beta)', 'DeviceManagementConfiguration.ReadWrite.All', 'Intune settings catalog is beta-only'),
  deviceEnrollmentConfiguration: research('device-management', 'POST /deviceManagement/deviceEnrollmentConfigurations', 'DeviceManagementServiceConfig.ReadWrite.All', 'Intune; default configurations cannot be recreated'),
  deviceManagementRoleDefinition: research('device-management', 'POST /deviceManagement/roleDefinitions', 'DeviceManagementRBAC.ReadWrite.All', 'Intune RBAC; privilege review needed'),
  deviceCategory: research('device-management', 'POST /deviceManagement/deviceCategories', 'DeviceManagementManagedDevices.ReadWrite.All', 'Intune'),
  termsAndConditions: research('device-management', 'POST /deviceManagement/termsAndConditions', 'DeviceManagementServiceConfig.ReadWrite.All', 'Intune; acceptance history cannot be recreated'),
  windowsAutopilotDeploymentProfile: research('device-management', 'POST /deviceManagement/windowsAutopilotDeploymentProfiles (beta)', 'DeviceManagementServiceConfig.ReadWrite.All', 'Intune; beta-only'),
  deviceManagementIntent: research('device-management', 'POST /deviceManagement/intents (beta)', 'DeviceManagementConfiguration.ReadWrite.All', 'Intune; beta-only and deprecated by the settings catalog'),
  managedDevice: byHand('device-management', null, 'none', 'device state, enrolled by the device, not configuration'),
  mobileApp: research('device-management', 'POST /deviceAppManagement/mobileApps', 'DeviceManagementApps.ReadWrite.All', 'Intune; app binaries are content, not configuration'),
  managedAppPolicy: research('device-management', 'POST /deviceAppManagement/managedAppPolicies', 'DeviceManagementApps.ReadWrite.All', 'Intune'),
  targetedManagedAppConfiguration: research('device-management', 'POST /deviceAppManagement/targetedManagedAppConfigurations', 'DeviceManagementApps.ReadWrite.All', 'Intune'),
  mobileAppConfiguration: research('device-management', 'POST /deviceAppManagement/mobileAppConfigurations', 'DeviceManagementApps.ReadWrite.All', 'Intune'),
});

const INVENTORY_FIELDS = new Set(['batch', 'status', 'api', 'permission', 'reason']);

/**
 * The restore scope a type has, derived from the registry alone:
 * 'full' only when every object operation is registered, 'partial' when some
 * are, 'none' otherwise. Nothing in EXPANSION_INVENTORY can set it.
 */
export function restoreScopeFor(resourceType) {
  const supported = OPERATIONS.filter((operation) => isSupportedClaim(capabilityFor(resourceType, operation).claim));
  if (supported.length === 0) return 'none';
  return supported.length === OPERATIONS.length ? 'full' : 'partial';
}

/**
 * Validates and expands EXPANSION_INVENTORY into one record per catalogue type.
 * Throws when a type is missing or in two places, an entry carries an unknown
 * field, a status disagrees with the registry or TYPE_DECISIONS, or a
 * non-qualified entry lacks its API/permission reason.
 */
export function buildExpansionInventory({ inventory = EXPANSION_INVENTORY, decisions = TYPE_DECISIONS } = {}) {
  const types = [...new Set([...CATALOG.map((entry) => entry.type), ...DESCRIPTORS.map((descriptor) => descriptor.type)])];
  const missing = types.filter((type) => !inventory[type]);
  if (missing.length > 0) throw new Error(`no expansion batch entry for: ${missing.join(', ')}`);
  const extra = Object.keys(inventory).filter((type) => !types.includes(type));
  if (extra.length > 0) throw new Error(`expansion entries for types not in the catalogue: ${extra.join(', ')}`);
  const batchIds = new Set(EXPANSION_BATCHES.map((batch) => batch.id));

  const entries = types.map((type) => {
    const entry = inventory[type];
    const unknownKeys = Object.keys(entry).filter((key) => !INVENTORY_FIELDS.has(key));
    if (unknownKeys.length > 0) throw new Error(`${type}: expansion entry carries unrecognised fields ${unknownKeys.join(', ')} — a restore scope is derived, never declared`);
    if (!batchIds.has(entry.batch)) throw new Error(`${type}: unknown batch ${entry.batch}`);
    if (!EXPANSION_STATUSES.includes(entry.status)) throw new Error(`${type}: invalid status ${entry.status}`);
    if (typeof entry.reason !== 'string' || entry.reason.length === 0) throw new Error(`${type}: entry has no reason`);
    if (typeof entry.permission !== 'string' || entry.permission.length === 0) throw new Error(`${type}: entry has no permission reason`);
    if (entry.api !== null && (typeof entry.api !== 'string' || entry.api.length === 0)) throw new Error(`${type}: api must be a route or null`);

    const scope = restoreScopeFor(type);
    const registered = scope !== 'none';
    if (entry.status === 'qualified-subset' && !registered) {
      throw new Error(`${type} is marked qualified-subset but has no registered write capability`);
    }
    if (entry.status !== 'qualified-subset' && registered) {
      throw new Error(`${type} has a registered write capability but is marked ${entry.status}`);
    }
    const decision = decisions[type]?.decision;
    if (entry.status === 'manual' && decision !== 'manual') throw new Error(`${type} is manual in its batch but ${decision} in TYPE_DECISIONS`);
    if ((entry.status === 'research-needed' || entry.status === 'unsupported') && decision === 'automated') {
      throw new Error(`${type} is ${entry.status} in its batch but automated in TYPE_DECISIONS`);
    }
    if (entry.status === 'research-needed' && entry.api === null) {
      throw new Error(`${type}: a research-needed entry must name the API route to investigate`);
    }

    return Object.freeze({
      resourceType: type,
      batch: entry.batch,
      status: entry.status,
      restoreScope: scope,
      supportedOperations: Object.freeze(OPERATIONS.filter((operation) => isSupportedClaim(capabilityFor(type, operation).claim))),
      unsupportedOperations: Object.freeze(OPERATIONS.filter((operation) => !isSupportedClaim(capabilityFor(type, operation).claim))),
      api: entry.api,
      permission: entry.permission,
      reason: entry.reason,
    });
  });

  return Object.freeze({
    contractVersion: EXPANSION_CONTRACT_VERSION,
    batches: Object.freeze(EXPANSION_BATCHES.map((batch) => Object.freeze({
      ...batch,
      types: Object.freeze(entries.filter((entry) => entry.batch === batch.id)),
    }))),
  });
}

/**
 * Roadmap task-109: what KEEL cannot recover for a type of the administrative
 * batch, configuration and relationships alike. Kept apart from
 * EXPANSION_INVENTORY (whose entries refuse unrecognised fields), reviewed by
 * hand, and never summarised into a percentage. A type without an entry has
 * not been assessed, which is not the same as "nothing is lost".
 */
const lost = (kind, name, reason) => Object.freeze({ kind, name, reason });
export const UNRECOVERABLE_CONFIGURATION = Object.freeze({
  administrativeUnit: Object.freeze([
    lost('relationship', 'members', 'unit membership is a separate edge with no qualified writer; it is listed for manual repair'),
    lost('relationship', 'scopedRoleMembers', 'role assignments scoped to the unit are separate edges with no qualified writer'),
    lost('configuration', 'visibility, isMemberManagementRestricted', 'set only when a unit is created; drift is reported not remediable'),
    lost('configuration', 'membershipType, membershipRule, membershipRuleProcessingState', 'dynamic membership is not qualified for writing; drift is reported not remediable'),
    lost('configuration', 'deleted unit', 'create and soft-delete restore are not qualified; a missing unit is recreated by hand'),
  ]),
  groupSetting: Object.freeze([
    lost('relationship', 'templateId', 'bound to a Microsoft-published template for life; a setting on a different template is refused'),
    lost('configuration', 'values the snapshot never observed', 'a value the template gained after the snapshot would be reset by a write, so the update is refused'),
    lost('configuration', 'deleted setting', 'create is not qualified; a missing tenant-wide setting is recreated by hand from its template'),
    lost('relationship', 'group-scoped settings', 'settings under /groups/{id}/settings are not collected or written'),
  ]),
  directorySettingTemplate: Object.freeze([
    lost('configuration', 'template catalogue', 'Microsoft-published and identical in every tenant; never written'),
  ]),
  organization: Object.freeze([
    lost('configuration', 'tenant object', 'the tenant itself is never recreated or written'),
  ]),
  domain: Object.freeze([
    lost('configuration', 'domains', 'adding a domain needs DNS ownership verification outside Graph'),
  ]),
  subscribedSku: Object.freeze([
    lost('configuration', 'licences', 'licences are purchased, not configured'),
  ]),
});

/** The compact batch record the coverage report and portal show for one type. */
export function expansionFor(resourceType) {
  const entry = EXPANSION_INVENTORY[resourceType];
  if (!entry) return null;
  const batch = EXPANSION_BATCHES.find((candidate) => candidate.id === entry.batch);
  return Object.freeze({
    batch: entry.batch,
    batchLabel: batch?.label ?? entry.batch,
    status: entry.status,
    restoreScope: restoreScopeFor(resourceType),
    // Roadmap task-108: the subtypes registered operations are limited to
    // (e.g. custom authentication strengths), read from the registry.
    qualifiedSubtypes: qualifiedSubtypesFor(resourceType),
    // Roadmap task-109: null when the type has not been assessed.
    unrecoverable: UNRECOVERABLE_CONFIGURATION[resourceType] ?? null,
    reason: entry.reason,
  });
}

/** Distinct subtypes the type's registered operations are bound to; [] when none is. */
export function qualifiedSubtypesFor(resourceType) {
  const subtypes = OPERATIONS
    .map((operation) => capabilityFor(resourceType, operation))
    .filter((capability) => isSupportedClaim(capability.claim) && typeof capability.subtype === 'string')
    .map((capability) => capability.subtype);
  return Object.freeze([...new Set(subtypes)].sort());
}

// ---- write-path contracts for the task-107 subset

/**
 * Fields a create body never carries for a type, beyond the server-owned ones:
 * identifiers Entra assigns and credential material KEEL cannot read back.
 */
export const CREATE_EXCLUDED_FIELDS = Object.freeze({
  application: Object.freeze(['appId', 'publisherDomain', 'passwordCredentials', 'keyCredentials']),
  // Roadmap task-108: computed by Entra from allowedCombinations; never sent.
  authenticationStrengthPolicy: Object.freeze(['policyType', 'requirementsSatisfied']),
  servicePrincipal: Object.freeze([
    'appDisplayName', 'appOwnerOrganizationId', 'servicePrincipalNames', 'servicePrincipalType',
    'signInAudience', 'appRoles', 'oauth2PermissionScopes', 'passwordCredentials', 'keyCredentials',
  ]),
});

/** The identifiers a created object reports beyond its object id, by type. */
export const ALTERNATE_IDENTIFIERS = Object.freeze({ application: Object.freeze(['appId']) });

/**
 * References the snapshot's GUID walk cannot see, declared explicitly. A
 * service principal points at its application by appId, not by object id;
 * the application's natural key is that appId, so the symbol is derived from
 * the payload. `identifier` says which of the target's identifiers the field
 * holds.
 */
export const EXPLICIT_REFERENCES = Object.freeze({
  servicePrincipal: Object.freeze([Object.freeze({ field: 'appId', targetType: 'application', identifier: 'appId' })]),
});

/** The resource's references plus its explicit ones (never duplicating a field). */
export function withExplicitReferences(resource) {
  const declared = EXPLICIT_REFERENCES[resource?.resourceType];
  const references = resource?.references ?? [];
  if (!declared || !resource.payload) return references;
  const extra = [];
  for (const ref of declared) {
    const value = resource.payload[ref.field];
    if (typeof value !== 'string' || value.length === 0) continue;
    if (references.some((existing) => existing.field === ref.field)) continue;
    extra.push({ field: ref.field, symbol: `${ref.targetType}:${value}`, required: true, identifier: ref.identifier });
  }
  return extra.length === 0 ? references : [...references, ...extra];
}
