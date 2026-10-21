/**
 * Wave 2 IDO: restore of identity objects that had no writer.
 *
 *  - servicePrincipal update and delete. An update writes only the reviewed
 *    attributes below; whether the service principal is enabled is reported,
 *    never written (the same rule as a user). A delete is refused for a
 *    Microsoft-owned service principal, a managed identity, and KEEL's own app.
 *  - application owners, service principal owners and app role grants
 *    (application permissions granted to a service principal), ADD ONLY: an
 *    edge the backup holds and the target lacks is added through its
 *    documented route and read back. An edge is never removed.
 *  - recreating a deleted user (past the deleted-items window) with a
 *    credentials checklist. The account is created DISABLED with a random
 *    password nobody ever sees: it is generated in memory, sent once, never
 *    returned, journalled or logged, and the checklist says to issue a new
 *    credential before the account is turned on. A synced or guest user is
 *    never created here.
 *  - the Entra governance types from wave 1 (CAT-ENTRA, PR #259) and the
 *    can be written in full from the backup. A lifecycle workflow is always
 *    created switched off, and a restore never switches one on: that stays a
 *    follow-up step. Attribute sets and custom security attributes are only
 *    updated: one can never be deleted once created, so a create waits for a
 *    review step (IDENTITY_NEEDS_REVIEW).
 *
 * Types the backup cannot drive in full (a terms of use file, an API
 * connector's password, a user flow's attributes, access package policies and
 * assignments, provisioning jobs, access package resource scopes) have no
 * record here; IDENTITY_BEST_EFFORT names them and why.
 *
 * Routes follow the Graph v1.0 references and are fixture-tested, not
 * live-qualified.
 */
import { randomBytes } from 'node:crypto';

import { classifyWriteOutcome, recordPriorState, recordWriteOutcome } from './rollbackJournal.mjs';
import {
  applyRecordWrite, defineRecord, graphFailure, isNotFound, outcomeDetail, readUntil, recordLedger, sameValue, stripGraph,
} from './recordWriter.mjs';
import {
  USER_WRITABLE_FIELDS, assignLicenseBody, isSyncedUser, licencePlan, userPostStateRefusal, userReadPath,
} from './userOperations.mjs';

export const IDENTITY_OBJECT_OPERATIONS_CONTRACT_VERSION = 1;

const DOCS = 'https://learn.microsoft.com/en-us/graph/api';

/** Tenants Microsoft publishes its own first-party applications from. */
export const MICROSOFT_OWNER_TENANTS = Object.freeze([
  'f8cdef31-a31e-4b4a-93e4-5f571e91255a', // Microsoft Services
  '72f988bf-86f1-41af-91ab-2d7cd011db47', // Microsoft
]);

// ------------------------------------------------------- service principal

/** The reviewed service principal attributes an update may write. */
export const SERVICE_PRINCIPAL_WRITABLE_FIELDS = Object.freeze([
  'appRoleAssignmentRequired', 'description', 'homepage', 'loginUrl', 'logoutUrl', 'notes', 'notificationEmailAddresses',
  'preferredSingleSignOnMode', 'samlSingleSignOnSettings', 'tags',
]);

const lower = (value) => String(value ?? '').toLowerCase();

function servicePrincipalDeleteGuard(_io, { payload }) {
  if (payload?.servicePrincipalType && payload.servicePrincipalType !== 'Application') {
    return `manual: this is a ${payload.servicePrincipalType} service principal; only an application's service principal is deleted by a restore`;
  }
  if (MICROSOFT_OWNER_TENANTS.includes(lower(payload?.appOwnerOrganizationId))) {
    return 'manual: this service principal belongs to a Microsoft application; deleting it can break Microsoft 365 services, so it is never deleted by a restore';
  }
  return null;
}

function servicePrincipalRefusal(resource, verb) {
  const payload = verb === 'delete' ? (resource.live?.payload ?? resource.payload) : resource.payload;
  if (verb === 'update' && payload?.accountEnabled !== undefined && resource.live?.payload
    && payload.accountEnabled !== resource.live.payload.accountEnabled
    && SERVICE_PRINCIPAL_WRITABLE_FIELDS.every((field) => sameValue(payload[field], resource.live.payload[field]))) {
    return {
      outcome: 'skipped',
      reason: `manual: the service principal is ${resource.live.payload.accountEnabled ? 'enabled' : 'disabled'} now and ${payload.accountEnabled ? 'enabled' : 'disabled'} in the backup; a restore never turns sign-in on or off, so change it by hand`,
    };
  }
  return null;
}

// ------------------------------------------------ multitenant org template

/**
 * The partner configuration template settings a restore may write. Inbound
 * trust (whether this tenant accepts a partner's MFA and device claims) is
 * never written: a wrong value changes how partner users pass Conditional
 * Access, so a difference is reported for a person to change by hand.
 */
export const PARTNER_TEMPLATE_WRITABLE_FIELDS = Object.freeze([
  'templateApplicationLevel', 'automaticUserConsentSettings',
  'b2bCollaborationInbound', 'b2bCollaborationOutbound', 'b2bDirectConnectInbound', 'b2bDirectConnectOutbound',
]);

const INBOUND_TRUST_STEP = 'Inbound trust (accepting a partner tenant\'s MFA, compliant device or hybrid joined device claims) differs from the backup. A restore never changes it: review it in Entra admin center > External Identities > Cross-tenant access settings, and change it by hand if needed.';

const inboundTrustDiffers = (resource) => resource.live?.payload
  && resource.payload?.inboundTrust !== undefined
  && !sameValue(resource.payload.inboundTrust, resource.live.payload.inboundTrust);

function partnerTemplateRefusal(resource, verb) {
  if (verb !== 'update' || !inboundTrustDiffers(resource)) return null;
  if (!PARTNER_TEMPLATE_WRITABLE_FIELDS.every((field) => sameValue(resource.payload[field], resource.live.payload[field]))) return null;
  return { outcome: 'skipped', reason: `manual: ${INBOUND_TRUST_STEP}` };
}

function partnerTemplateAfterWrite(_io, { resource }) {
  return { completion: inboundTrustDiffers(resource) ? [{ kind: 'enforcement', requirement: 'inboundTrust', description: INBOUND_TRUST_STEP }] : [] };
}

// ------------------------------------------------------------- governance

/** Lifecycle workflow fields Entra computes, or that are read separately. */
const WORKFLOW_SERVER_FIELDS = ['createdBy', 'lastModifiedBy', 'version', 'nextScheduleRunDateTime', 'runs', 'taskReports',
  'userProcessingResults', 'versions', 'executionScope', 'insights'];
const TASK_SERVER_FIELDS = new Set(['id', 'createdDateTime', 'lastModifiedDateTime', 'taskProcessingResults']);

function workflowTasks(tasks) {
  return (tasks ?? []).map((task) => Object.fromEntries(Object.entries(task ?? {})
    .filter(([key]) => !TASK_SERVER_FIELDS.has(key) && !key.includes('@odata.'))));
}

/**
 * A workflow is created off; an update can switch it off but never on. Tasks,
 * conditions and category change only through a new version (afterWrite).
 */
function workflowBody(body, { verb, payload }) {
  const out = { ...body };
  if (verb === 'create') {
    out.isEnabled = false;
    out.isSchedulingEnabled = false;
    out.tasks = workflowTasks(payload?.tasks);
    return out;
  }
  for (const field of ['isEnabled', 'isSchedulingEnabled']) if (payload?.[field] !== false) delete out[field];
  return out;
}

const WORKFLOW_VERSIONED = ['category', 'executionConditions', 'tasks'];

async function workflowAfterWrite(io, { payload, verb, targetId, live, before }) {
  const completion = [];
  for (const field of ['isEnabled', 'isSchedulingEnabled']) {
    if (payload?.[field] === true && live?.[field] !== true) {
      completion.push({
        kind: 'enforcement', requirement: field,
        description: `The workflow is ${field === 'isEnabled' ? 'off' : 'not scheduled'} in the target and ${field === 'isEnabled' ? 'on' : 'scheduled'} in the backup. A restore never turns a workflow on: review its scope and tasks, then turn it on in Entra admin center > Identity governance > Lifecycle workflows.`,
      });
    }
  }
  if (verb === 'create' || !before) return { completion };
  const stale = WORKFLOW_VERSIONED.filter((field) => !sameValue(
    field === 'tasks' ? workflowTasks(payload?.tasks) : payload?.[field],
    field === 'tasks' ? workflowTasks(live?.tasks) : live?.[field],
  ));
  if (stale.length === 0) return { completion };
  const path = `/identityGovernance/lifecycleWorkflows/workflows/${encodeURIComponent(targetId)}`;
  const workflow = {
    category: payload.category, displayName: payload.displayName, description: payload.description ?? null,
    isEnabled: live?.isEnabled === true && payload.isEnabled !== false,
    isSchedulingEnabled: live?.isSchedulingEnabled === true && payload.isSchedulingEnabled !== false,
    executionConditions: payload.executionConditions, tasks: workflowTasks(payload.tasks),
  };
  const result = await io.retryOperation(() => io.writer.write('v1.0', `${path}/createNewVersion`, { method: 'POST', body: { workflow } }));
  if (!result.ok) return { error: `writing a new version of the workflow (${stale.join(', ')}) failed: ${outcomeDetail(result)}` };
  const check = await readUntil(io, 'v1.0', `${path}?$expand=tasks`, (r) => isNotFound(r)
    || (r?.ok === true && !sameValue(workflowTasks(r.body?.tasks), workflow.tasks)), io.readOptions);
  if (check?.ok !== true || !sameValue(workflowTasks(check.body?.tasks), workflow.tasks)
    || !sameValue(check.body?.executionConditions, workflow.executionConditions)) {
    return { error: 'post-state: the new workflow version did not read back as written' };
  }
  return { completion, live: check.body, changes: { newVersion: stale } };
}

/** Allowed values of a custom security attribute: added or (de)activated, never removed (Graph cannot). */
async function allowedValuesAfterWrite(io, { payload, verb, targetId, live }) {
  if (verb === 'create' || !Array.isArray(payload?.allowedValues)) return null;
  const path = `/directory/customSecurityAttributeDefinitions/${encodeURIComponent(targetId)}/allowedValues`;
  const have = new Map((live?.allowedValues ?? []).map((value) => [value.id, value]));
  const written = [];
  for (const value of payload.allowedValues) {
    const current = have.get(value.id);
    if (current && current.isActive === value.isActive) continue;
    const request = current
      ? { path: `${path}/${encodeURIComponent(value.id)}`, method: 'PATCH', body: { isActive: value.isActive } }
      : { path, method: 'POST', body: { id: value.id, isActive: value.isActive } };
    const result = await io.retryOperation(() => io.writer.write('v1.0', request.path, { method: request.method, body: request.body }));
    if (!result.ok) return { error: `writing the allowed value ${value.id} failed: ${outcomeDetail(result)}` };
    written.push(value.id);
  }
  if (written.length === 0) return null;
  const check = await io.retryOperation(() => io.writer.read('v1.0', path));
  const got = new Map((check?.body?.value ?? []).map((value) => [value.id, value.isActive]));
  const wrong = payload.allowedValues.filter((value) => got.get(value.id) !== value.isActive).map((value) => value.id);
  if (check?.ok !== true || wrong.length > 0) return { error: `post-state: allowed values ${wrong.join(', ') || '(unreadable)'} did not read back as written` };
  return { changes: { allowedValues: written } };
}

const v1 = (page) => `${DOCS}/${page}?view=graph-rest-1.0`;
const beta = (page) => `${DOCS}/${page}?view=graph-rest-beta`;

const FEDERATIONS = '/directory/federationConfigurations/graph.samlOrWsFedExternalDomainFederation';

const parsedOrRaw = (entry) => {
  try {
    return JSON.parse(entry);
  } catch {
    return entry;
  }
};

/** Two lists of JSON strings are the same when each entry parses to the same value (Graph may change the spacing). */
export function sameJsonStrings(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return sameValue(left, right);
  return left.length === right.length && left.every((entry, index) => sameValue(parsedOrRaw(entry), parsedOrRaw(right[index])));
}

/** The records, one per type this module writes through recordWriter. */
export const IDENTITY_RECORDS = Object.freeze({
  servicePrincipal: defineRecord({
    resourceType: 'servicePrincipal', version: 'v1.0', collection: '/servicePrincipals', operations: ['update', 'delete'],
    writable: SERVICE_PRINCIPAL_WRITABLE_FIELDS, refusal: servicePrincipalRefusal, deleteGuard: servicePrincipalDeleteGuard,
    permission: 'Application.ReadWrite.All', docs: v1('serviceprincipal-update'),
  }),
  lifecycleWorkflow: defineRecord({
    resourceType: 'lifecycleWorkflow', version: 'v1.0', collection: '/identityGovernance/lifecycleWorkflows/workflows',
    operations: ['create', 'update'], readQuery: '$expand=tasks', excluded: WORKFLOW_SERVER_FIELDS, createOnly: WORKFLOW_VERSIONED,
    transform: workflowBody, afterWrite: workflowAfterWrite, permission: 'LifecycleWorkflows.ReadWrite.All', docs: v1('identitygovernance-lifecycleworkflowscontainer-post-workflows'),
  }),
  lifecycleWorkflowCustomTaskExtension: defineRecord({
    resourceType: 'lifecycleWorkflowCustomTaskExtension', version: 'v1.0', collection: '/identityGovernance/lifecycleWorkflows/customTaskExtensions',
    operations: ['create', 'update'], excluded: ['createdBy', 'lastModifiedBy'], odataType: 'keep',
    permission: 'LifecycleWorkflows.ReadWrite.All', docs: v1('identitygovernance-lifecycleworkflowscontainer-post-customtaskextensions'),
  }),
  lifecycleManagementSettings: defineRecord({
    resourceType: 'lifecycleManagementSettings', version: 'v1.0', collection: '/identityGovernance/lifecycleWorkflows/settings',
    singleton: true, operations: ['update'], permission: 'LifecycleWorkflows.ReadWrite.All', docs: v1('identitygovernance-lifecyclemanagementsettings-update'),
  }),
  attributeSet: defineRecord({
    resourceType: 'attributeSet', version: 'v1.0', collection: '/directory/attributeSets',
    operations: ['update'], permission: 'CustomSecAttributeDefinition.ReadWrite.All', docs: v1('directory-post-attributesets'),
  }),
  customSecurityAttributeDefinition: defineRecord({
    resourceType: 'customSecurityAttributeDefinition', version: 'v1.0', collection: '/directory/customSecurityAttributeDefinitions',
    operations: ['update'], readQuery: '$expand=allowedValues',
    createOnly: ['attributeSet', 'name', 'isCollection', 'isSearchable', 'type', 'allowedValues'],
    afterWrite: allowedValuesAfterWrite, permission: 'CustomSecAttributeDefinition.ReadWrite.All', docs: v1('directory-post-customsecurityattributedefinitions'),
  }),
  accessPackageCatalog: defineRecord({
    resourceType: 'accessPackageCatalog', version: 'v1.0', collection: '/identityGovernance/entitlementManagement/catalogs',
    operations: ['create', 'update'], excluded: ['accessPackages', 'resources', 'resourceRoles', 'resourceScopes', 'customWorkflowExtensions'],
    permission: 'EntitlementManagement.ReadWrite.All', docs: v1('entitlementmanagement-post-catalogs'),
  }),
  entitlementManagementSettings: defineRecord({
    resourceType: 'entitlementManagementSettings', version: 'v1.0', collection: '/identityGovernance/entitlementManagement/settings',
    singleton: true, operations: ['update'], permission: 'EntitlementManagement.ReadWrite.All', docs: v1('entitlementmanagementsettings-update'),
  }),
  appManagementPolicy: defineRecord({
    resourceType: 'appManagementPolicy', version: 'v1.0', collection: '/policies/appManagementPolicies',
    operations: ['create', 'update'], excluded: ['appliesTo'], permission: 'Policy.ReadWrite.ApplicationConfiguration', docs: v1('appmanagementpolicy-post'),
  }),
  multiTenantOrganization: defineRecord({
    resourceType: 'multiTenantOrganization', version: 'v1.0', collection: '/tenantRelationships/multiTenantOrganization',
    singleton: true, operations: ['update'], writable: ['displayName', 'description'],
    permission: 'MultiTenantOrganization.ReadWrite.All', docs: v1('multitenantorganization-update'),
  }),
  // Restore gaps, batch 2: Entra ID tenant settings that are one object per
  // tenant. Each is only updated in place, and only its settings are written
  // (its name and description are Microsoft's).
  externalIdentitiesPolicy: defineRecord({
    resourceType: 'externalIdentitiesPolicy', version: 'beta', collection: '/policies/externalIdentitiesPolicy',
    singleton: true, operations: ['update'], writable: ['allowExternalIdentitiesToLeave', 'allowDeletedIdentitiesDataRemoval'],
    permission: 'Policy.ReadWrite.ExternalIdentities', docs: beta('externalidentitiespolicy-update'),
  }),
  accessReviewPolicy: defineRecord({
    resourceType: 'accessReviewPolicy', version: 'beta', collection: '/policies/accessReviewPolicy',
    singleton: true, operations: ['update'], writable: ['isGroupOwnerManagementEnabled'],
    permission: 'Policy.ReadWrite.AccessReview', docs: beta('accessreviewpolicy-update'),
  }),
  directoryRoleAccessReviewPolicy: defineRecord({
    resourceType: 'directoryRoleAccessReviewPolicy', version: 'beta', collection: '/policies/directoryRoleAccessReviewPolicy',
    singleton: true, operations: ['update'], writable: ['settings'],
    permission: 'RoleManagement.ReadWrite.Directory', docs: beta('directoryroleaccessreviewpolicy-update'),
  }),
  // The multitenant organization templates only shape the settings a tenant
  // gets when it joins later; partners already in place keep their own.
  multiTenantOrganizationIdentitySyncPolicyTemplate: defineRecord({
    resourceType: 'multiTenantOrganizationIdentitySyncPolicyTemplate', version: 'v1.0',
    collection: '/policies/crossTenantAccessPolicy/templates/multiTenantOrganizationIdentitySynchronization',
    singleton: true, operations: ['update'], writable: ['templateApplicationLevel', 'userSyncInbound'],
    permission: 'Policy.ReadWrite.CrossTenantAccess', docs: v1('multitenantorganizationidentitysyncpolicytemplate-update'),
  }),
  multiTenantOrganizationPartnerConfigurationTemplate: defineRecord({
    resourceType: 'multiTenantOrganizationPartnerConfigurationTemplate', version: 'v1.0',
    collection: '/policies/crossTenantAccessPolicy/templates/multiTenantOrganizationPartnerConfiguration',
    singleton: true, operations: ['update'], writable: PARTNER_TEMPLATE_WRITABLE_FIELDS,
    refusal: partnerTemplateRefusal, afterWrite: partnerTemplateAfterWrite,
    permission: 'Policy.ReadWrite.CrossTenantAccess', docs: v1('multitenantorganizationpartnerconfigurationtemplate-update'),
  }),
  // Restore gaps, batch 3: guest and app consent settings.
  // The guest invitation domain lists live in `definition`, a list of JSON
  // strings. Only the definition is written, in place: the tenant keeps one
  // such policy, and its name and default flag are left as they are.
  b2bManagementPolicy: defineRecord({
    resourceType: 'b2bManagementPolicy', version: 'beta', collection: '/policies/b2bManagementPolicies',
    operations: ['update'], writable: ['definition'], sameField: (field, left, right) => (field === 'definition' ? sameJsonStrings(left, right) : null),
    permission: 'Policy.ReadWrite.B2BManagementPolicy', docs: beta('b2bmanagementpolicy-update'),
  }),
  // A pre-approval policy does nothing until it is assigned to an app's
  // service principal; that assignment is not backed up, so it stays a step.
  permissionGrantPreApprovalPolicy: defineRecord({
    resourceType: 'permissionGrantPreApprovalPolicy', version: 'beta', collection: '/policies/permissionGrantPreApprovalPolicies',
    operations: ['create', 'update'], writable: ['conditions'],
    permission: 'Policy.ReadWrite.PermissionGrant', docs: beta('permissiongrantpreapprovalpolicy-post'),
  }),
  // A guest federation's settings are updated in place. Its domains are a
  // separate collection the backup does not read yet, so a deleted federation
  // is set up again by hand.
  externalDomainFederation: defineRecord({
    resourceType: 'externalDomainFederation', version: 'v1.0', collection: FEDERATIONS,
    collectionFor: (payload) => (payload?.['@odata.type'] === undefined || stripGraph(payload['@odata.type']) === 'samlOrWsFedExternalDomainFederation'
      ? FEDERATIONS : null),
    operations: ['update'],
    writable: ['displayName', 'issuerUri', 'metadataExchangeUri', 'passiveSignInUri', 'preferredAuthenticationProtocol', 'signingCertificate'],
    permission: 'Domain.ReadWrite.All', docs: v1('samlorwsfedexternaldomainfederation-update'),
  }),
});

/**
 * Types whose write is safe to build but was decided to need a person's review
 * first; they stay manual until an approval step exists for them.
 */
export const IDENTITY_NEEDS_REVIEW = Object.freeze({
  attributeSet: 'create only: an attribute set can never be deleted once created (update is written)',
  customSecurityAttributeDefinition: 'create only: a definition can never be deleted once created (update is written)',
  tenantAppManagementPolicy: 'a stricter default can stop every app from adding a secret or certificate',
  crossTenantIdentitySyncPolicyPartner: 'it lets a partner tenant sync its users into this one',
});

/** Types read in wave 1 that no record here can write in full, and why. */
export const IDENTITY_BEST_EFFORT = Object.freeze({
  agreement: 'the terms of use file (PDF) is never returned by Graph',
  identityApiConnector: 'the connector password or certificate is never returned by Graph',
  b2xIdentityUserFlow: 'the user flow\'s identity providers and attributes are separate routes that are not backed up',
  accessPackageAssignmentPolicy: 'it references its access package, requestors and approvers by id; remapping them is not qualified',
  accessPackageAssignment: 'an assignment is granted by a request through its policy, never copied',
  synchronizationJob: 'a provisioning job needs its template, schema and the target system\'s credentials',
  accessPackageResourceRoleScope: 'a resource role scope is added by a resource request on its catalog, never copied',
});

// ------------------------------------------------------------------- users

/** A password nobody sees: 48 random characters plus one of each class Entra requires. */
export function unseenPassword() {
  return `${randomBytes(36).toString('base64url')}aZ9!`;
}

function userCreateRefusal(resource) {
  const payload = resource.payload;
  if (!payload || typeof payload !== 'object') return { outcome: 'failed', reason: 'the backup holds no user to write' };
  if (isSyncedUser(payload)) {
    return { outcome: 'skipped', reason: 'source of authority is on-premises Active Directory (onPremisesSyncEnabled or onPremisesImmutableId) — recreate it there and let sync bring it back' };
  }
  if (payload.userType === 'Guest' || /#EXT#@/i.test(payload.userPrincipalName ?? '')) {
    return { outcome: 'skipped', reason: 'manual: a guest is recreated by inviting them again, never by creating an account' };
  }
  if (typeof payload.userPrincipalName !== 'string' || payload.userPrincipalName.length === 0
    || typeof payload.displayName !== 'string' || payload.displayName.length === 0) {
    return { outcome: 'failed', reason: 'the backup does not hold the user\'s sign-in name and display name, which Graph needs to create one' };
  }
  return null;
}

/** The user create body without the password (journalled, verified, shown in a dry run). */
export function userCreateBody(payload) {
  const body = {
    accountEnabled: false,
    displayName: payload.displayName,
    userPrincipalName: payload.userPrincipalName,
    mailNickname: payload.mailNickname ?? payload.userPrincipalName.split('@')[0],
  };
  for (const field of USER_WRITABLE_FIELDS) {
    if (field === 'displayName' || payload[field] === undefined || payload[field] === null) continue;
    body[field] = payload[field];
  }
  return body;
}

/** The checklist a recreated user needs before anyone can use the account. */
export function userCredentialChecklist(payload, targetId) {
  const items = [
    { kind: 'credential', requirement: 'password', description: 'Issue a Temporary Access Pass or reset the password in Entra admin center > Users, and give it to the user out of band. KEEL set a random password nobody knows.' },
    { kind: 'credential', requirement: 'mfa', description: 'Have the user register MFA methods again: methods are never backed up.' },
  ];
  if (payload.accountEnabled !== false) {
    items.push({ kind: 'enforcement', requirement: 'accountEnabled', description: 'The account was created disabled. Turn sign-in on once the user has a credential.' });
  }
  items.push({ kind: 'integration', requirement: 'objectId', description: `The user has a new object id (${targetId}). Systems outside the tenant that stored the old id must be updated.` });
  items.push({ kind: 'integration', requirement: 'content', description: 'Mailbox and OneDrive content come back only through a content restore to the new account.' });
  return items;
}

/**
 * Recreates a deleted user (verb 'create'). Disabled, with an unseen
 * password, the reviewed attributes and add-only direct licences; read back
 * and verified; returns the credentials checklist as `completion`.
 */
export async function applyUserRecreate(writer, resource, verb, ctx = {}) {
  const { naturalKey } = resource;
  const retryOperation = ctx.retryOperation ?? ((operation) => operation());
  if (verb !== 'create') return { failed: { naturalKey, error: `unsupported operation: user ${verb} is not handled by the recreate writer` } };
  const refusal = userCreateRefusal(resource);
  if (refusal) {
    return refusal.outcome === 'skipped' ? { skipped: { naturalKey, reason: refusal.reason } } : { failed: { naturalKey, error: refusal.reason } };
  }
  const payload = resource.payload;
  const body = userCreateBody(payload);
  const licences = licencePlan(payload, null);
  const fields = Object.keys(body);

  const existingId = ctx.existingTargetIds?.get(naturalKey);
  if (existingId) {
    return { failed: { naturalKey, error: 'conflict: a user with this sign-in name exists in the target — restore it as an update instead' } };
  }
  if (ctx.mode === 'dry-run') {
    return {
      applied: {
        naturalKey, targetId: null,
        changes: { fields, licences: licences.add.map((licence) => licence.skuId) },
        completion: userCredentialChecklist(payload, '(assigned on create)'),
      },
    };
  }

  let entryId = null;
  if (ctx.rollbackClient) {
    try {
      const id = await recordPriorState(ctx.rollbackClient, ctx.restoreRef
        ? {
          runId: ctx.runId, naturalKey, priorState: null, restoreRef: ctx.restoreRef,
          resourceType: 'user', operation: 'create', targetId: null, blastRadius: resource.blastRadius ?? null, intendedState: body,
        }
        : { runId: ctx.runId, naturalKey, priorState: null });
      entryId = ctx.restoreRef ? id : null;
    } catch {
      return { failed: { naturalKey, error: 'refusing to create: rollback journal write failed' } };
    }
  }
  const note = async (outcome, extras = {}) => {
    if (!ctx.rollbackClient || !entryId) return;
    try { await recordWriteOutcome(ctx.rollbackClient, { entryId, outcome, ...extras }); } catch { /* left pending */ }
  };

  // The password exists only inside this request.
  const result = await retryOperation(() => writer.write('v1.0', '/users', {
    method: 'POST',
    body: { ...body, passwordProfile: { forceChangePasswordNextSignIn: true, password: unseenPassword() } },
  }));
  if (!result.ok) {
    await note(classifyWriteOutcome(result), { detail: outcomeDetail(result) });
    return { failed: graphFailure(naturalKey, result) };
  }
  const targetId = result.body?.id;
  if (typeof targetId !== 'string' || targetId.length === 0) {
    await note('uncertain', { detail: 'create returned no id' });
    return { failed: { naturalKey, error: 'create returned no user id' } };
  }
  const io = { writer, retryOperation, readOptions: ctx.readAfterWriteOptions ?? {} };

  if (licences.add.length > 0) {
    const assigned = await retryOperation(() => writer.write('v1.0', `/users/${encodeURIComponent(targetId)}/assignLicense`, {
      method: 'POST', body: assignLicenseBody(licences.add),
    }));
    if (!assigned.ok) {
      await note('uncertain', { targetId, detail: `created; licences ${outcomeDetail(assigned)}` });
      return { failed: { naturalKey, error: `the user was created (disabled), but assigning licences failed: ${outcomeDetail(assigned)}`, completion: userCredentialChecklist(payload, targetId) } };
    }
  }
  const readBack = (live) => userPostStateRefusal({ ...body }, live, {
    fields: fields.filter((field) => field !== 'mailNickname' && field !== 'userPrincipalName'),
    licences: licences.add,
  }) ?? (lower(live?.userPrincipalName ?? body.userPrincipalName) !== lower(body.userPrincipalName) ? 'post-state: userPrincipalName did not read back as written' : null);
  const reRead = await readUntil(io, 'v1.0', userReadPath(targetId), (r) => isNotFound(r) || (r?.ok === true && readBack(r.body) !== null), io.readOptions);
  if (reRead?.ok !== true) {
    await note('uncertain', { targetId, detail: 'created user could not be re-read' });
    return { failed: graphFailure(naturalKey, reRead) };
  }
  const postState = readBack(reRead.body);
  if (postState) {
    await note('uncertain', { targetId, postState: reRead.body, detail: 'created user did not verify' });
    return { failed: { naturalKey, error: postState } };
  }
  await note('succeeded', { targetId, postState: reRead.body });
  return {
    applied: {
      naturalKey, targetId,
      changes: { fields, licences: licences.add.map((licence) => licence.skuId) },
      completion: userCredentialChecklist(payload, targetId),
    },
  };
}

// ------------------------------------------------------------------- edges

const DIRECTORY_OBJECT = 'https://graph.microsoft.com/v1.0/directoryObjects';

/** The identity edge families with an add route; never a remove route. */
export const IDENTITY_EDGE_FAMILIES = Object.freeze({
  appOwner: Object.freeze({ parentType: 'application', collection: '/applications', kind: 'owner' }),
  servicePrincipalOwner: Object.freeze({ parentType: 'servicePrincipal', collection: '/servicePrincipals', kind: 'owner' }),
  appRoleGrant: Object.freeze({ parentType: 'servicePrincipal', collection: '/servicePrincipals', kind: 'appRoleGrant' }),
});

const isComplete = (outcome) => outcome === 'complete' || outcome === 'complete-empty' || outcome === 'partial';
const appRoleOf = (edge) => lower(edge?.edgeKey?.split(':')[1]);

/**
 * Plans add-only edge operations. `parents`: { naturalKey, resourceType,
 * liveTargetId }. `desired`: loadSnapshotRelationships output; `live`: Map
 * `${naturalKey}|${family}` -> live observation; `resolve(naturalKey)`: target
 * id or null. A target that does not resolve refuses its edge (never written
 * by its source id). A live edge missing from the backup is left in place.
 */
export function planIdentityEdges({ parents, desired, live = new Map(), resolve = () => null }) {
  const operations = [];
  const refusals = [];
  for (const parent of parents ?? []) {
    if (parent.verb === 'delete') continue;
    for (const [family, spec] of Object.entries(IDENTITY_EDGE_FAMILIES)) {
      if (spec.parentType !== parent.resourceType) continue;
      const key = `${parent.naturalKey}|${family}`;
      const want = desired?.get(key);
      if (!want || !isComplete(want.outcome)) continue;
      const have = live.get(key);
      const haveKeys = new Set((have?.targets ?? []).map((edge) => (spec.kind === 'owner' ? lower(edge.targetId) : `${lower(edge.targetId)}:${appRoleOf(edge)}`)));
      for (const edge of want.targets ?? []) {
        const targetId = edge.targetNaturalKey ? resolve(edge.targetNaturalKey) : null;
        if (typeof targetId !== 'string' || targetId.length === 0) {
          refusals.push({ naturalKey: `edge:${key}`, reason: `${edge.targetNaturalKey ?? 'an object not in the backup'} does not exist in the target, so the ${spec.kind === 'owner' ? 'owner' : 'app role grant'} is not added` });
          continue;
        }
        const identity = spec.kind === 'owner' ? lower(targetId) : `${lower(targetId)}:${appRoleOf(edge)}`;
        if (haveKeys.has(identity)) continue;
        operations.push({
          family, parentNaturalKey: parent.naturalKey, parentTargetId: parent.liveTargetId ?? null,
          targetNaturalKey: edge.targetNaturalKey, targetId, appRoleId: spec.kind === 'appRoleGrant' ? appRoleOf(edge) : null,
        });
      }
    }
  }
  return { operations, refusals };
}

/** The request that adds one edge. */
export function identityEdgeRequest(op, parentTargetId) {
  const spec = IDENTITY_EDGE_FAMILIES[op.family];
  if (!spec) throw new Error(`no add route for identity edge family ${op.family}`);
  const base = `${spec.collection}/${encodeURIComponent(parentTargetId)}`;
  if (spec.kind === 'owner') {
    return { path: `${base}/owners/$ref`, body: { '@odata.id': `${DIRECTORY_OBJECT}/${encodeURIComponent(op.targetId)}` }, readPath: `${base}/owners?$select=id` };
  }
  return {
    path: `${base}/appRoleAssignments`,
    body: { principalId: parentTargetId, resourceId: op.targetId, appRoleId: op.appRoleId },
    readPath: `${base}/appRoleAssignments`,
  };
}

const edgeKey = (op) => `edge:${op.parentNaturalKey}|${op.family}|add|${op.targetNaturalKey ?? op.targetId}`;

function edgePresent(op, items) {
  return (items ?? []).some((item) => (op.appRoleId
    ? lower(item.resourceId) === lower(op.targetId) && lower(item.appRoleId) === lower(op.appRoleId)
    : lower(item.id) === lower(op.targetId)));
}

/**
 * Adds planned edges: journalled, written, re-read. An edge already present
 * (another run, or a lost response) is never sent again. `appliedIds` names
 * parents this run created.
 */
export async function applyIdentityEdges(writer, operations, ctx = {}) {
  const retryOperation = ctx.retryOperation ?? ((operation) => operation());
  const io = { writer, retryOperation, readOptions: ctx.readAfterWriteOptions ?? {} };
  const applied = [];
  const failed = [];
  for (const op of operations ?? []) {
    const naturalKey = edgeKey(op);
    const parentTargetId = op.parentTargetId ?? ctx.appliedIds?.get(op.parentNaturalKey) ?? null;
    if (!parentTargetId) {
      failed.push({ naturalKey, error: `${op.parentNaturalKey} does not exist in the target, so its edges were not added` });
      continue;
    }
    if (ctx.mode === 'dry-run') {
      applied.push({ naturalKey });
      continue;
    }
    const request = identityEdgeRequest(op, parentTargetId);
    const current = await retryOperation(() => writer.read('v1.0', request.readPath));
    if (current?.ok !== true) {
      failed.push({ naturalKey, error: `the current ${op.family} set could not be read (${outcomeDetail(current)}), so nothing was added` });
      continue;
    }
    if (edgePresent(op, current.body?.value)) {
      applied.push({ naturalKey, already: true });
      continue;
    }
    let entryId = null;
    if (ctx.rollbackClient) {
      try {
        const id = await recordPriorState(ctx.rollbackClient, ctx.restoreRef
          ? {
            runId: ctx.runId, naturalKey, priorState: { present: false }, restoreRef: ctx.restoreRef,
            resourceType: `${IDENTITY_EDGE_FAMILIES[op.family].parentType}#${op.family}`, operation: 'edge-add', targetId: op.targetId,
            blastRadius: 'access-affecting', intendedState: { present: true },
          }
          : { runId: ctx.runId, naturalKey, priorState: { present: false } });
        entryId = ctx.restoreRef ? id : null;
      } catch {
        failed.push({ naturalKey, error: 'refusing to add: rollback journal write failed' });
        continue;
      }
    }
    const note = async (outcome, extras = {}) => {
      if (!ctx.rollbackClient || !entryId) return;
      try { await recordWriteOutcome(ctx.rollbackClient, { entryId, outcome, ...extras }); } catch { /* left pending */ }
    };
    const result = await retryOperation(() => writer.write('v1.0', request.path, { method: 'POST', body: request.body }));
    if (!result.ok) {
      await note(classifyWriteOutcome(result), { detail: outcomeDetail(result) });
      failed.push(graphFailure(naturalKey, result));
      continue;
    }
    const check = await readUntil(io, 'v1.0', request.readPath, (r) => r?.ok === true && !edgePresent(op, r.body?.value), io.readOptions);
    if (check?.ok !== true || !edgePresent(op, check.body?.value)) {
      await note('uncertain', { detail: 'edge did not read back' });
      failed.push({ naturalKey, error: 'post-state: the edge did not read back after it was added' });
      continue;
    }
    await note('succeeded', {});
    applied.push({ naturalKey });
  }
  return { applied, failed };
}

// ---------------------------------------------------------------- dispatch

/** One write of a type this module owns. */
export async function applyIdentityObjectWrite(writer, resource, verb, ctx = {}) {
  if (resource.resourceType === 'user') return applyUserRecreate(writer, resource, verb, ctx);
  const record = IDENTITY_RECORDS[resource.resourceType];
  if (!record) return { failed: { naturalKey: resource.naturalKey, error: `${resource.resourceType} has no identity object record` } };
  return applyRecordWrite(writer, record, resource, verb, ctx);
}

/** (resourceType, operation) pairs this module writes. */
export function identityObjectOperations() {
  return Object.freeze([
    ...Object.values(IDENTITY_RECORDS).flatMap((record) => record.operations.map((operation) => Object.freeze({
      resourceType: record.resourceType, operation, path: record.collection,
    }))),
    Object.freeze({ resourceType: 'user', operation: 'create', path: '/users' }),
  ]);
}

export function buildIdentityObjectLedger() {
  return Object.freeze({
    contractVersion: IDENTITY_OBJECT_OPERATIONS_CONTRACT_VERSION,
    operations: Object.freeze([
      ...recordLedger(Object.values(IDENTITY_RECORDS)),
      Object.freeze({ resourceType: 'user', operation: 'create', version: 'v1.0', method: 'POST', route: '/users', permission: 'User.ReadWrite.All' }),
      ...Object.entries(IDENTITY_EDGE_FAMILIES).map(([family, spec]) => Object.freeze({
        resourceType: `${spec.parentType}#${family}`, operation: 'edge-add', version: 'v1.0', method: 'POST',
        route: spec.kind === 'owner' ? `${spec.collection}/{id}/owners/$ref` : `${spec.collection}/{id}/appRoleAssignments`,
        permission: spec.kind === 'owner' ? 'Application.ReadWrite.All' : 'AppRoleAssignment.ReadWrite.All',
      })),
    ]),
  });
}

