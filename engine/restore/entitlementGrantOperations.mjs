/**
 * Issue #1071: entitlement management, part 3. What makes a restored access
 * package work again: the resources its catalog holds, who holds the package,
 * and who manages the catalog.
 *
 *  - accessPackageCatalogResource: a backed-up group, app or SharePoint site
 *    added to its catalog again (POST /resourceRequests, requestType adminAdd).
 *    The catalog and the group or app are matched in the target by natural key;
 *    a site is named by its address. One already in the catalog is a skip.
 *    A resource in a catalog can be put in a package by the catalog's owners,
 *    so the add sits behind the restore approval.
 *  - accessPackageAssignment: never copied. Access is granted again through a
 *    request against the restored policy (POST /assignmentRequests, adminAdd),
 *    for the person, package and policy the backup names, each matched in the
 *    target by natural key. An assignment that had expired, or was never
 *    delivered, is skipped; one the person already holds live is a skip. A
 *    backup that does not name its policy (taken before KEEL read it) is a
 *    manual step. Access ends no later than the backup's end date. Every grant
 *    sits behind the restore approval, and the dry run says who gets which package.
 *  - entitlementManagementRoleAssignment: a catalog owner, catalog reader or
 *    access package manager on a catalog, created again (POST
 *    /roleManagement/entitlementManagement/roleAssignments, beta, as read).
 *    The person and the catalog are matched by natural key; a missing one holds
 *    the assignment. Behind the restore approval ("changes admin access").
 *
 * Only creates are registered: a restore never changes or takes away an
 * existing grant. Routes follow the Graph references and are fixture-tested,
 * not live-qualified.
 */
import { remappingFor } from '../coverage/qualification.mjs';
import { VERBATIM_RESOLUTIONS, resolveSymbol } from '../graph/resolver.mjs';
import { ENTITLEMENT_ROLE_NAMES, assignmentGrantText, assignmentInEffect } from '../safety/entitlementGrantEffects.mjs';
import { readAllPages, withApprovalGate } from './approvalHeld.mjs';
import { defineRecord } from './recordWriter.mjs';

const EM = '/identityGovernance/entitlementManagement';
const CATALOGS = `${EM}/catalogs`;
const RESOURCE_REQUESTS = `${EM}/resourceRequests`;
const ASSIGNMENTS = `${EM}/assignments`;
const ASSIGNMENT_REQUESTS = `${EM}/assignmentRequests`;
const ROLE_ASSIGNMENTS = '/roleManagement/entitlementManagement/roleAssignments';
const PERMISSION = 'EntitlementManagement.ReadWrite.All';
const DOCS = 'https://learn.microsoft.com/en-us/graph/api';
const PORTAL = 'the Entra admin center, under Identity Governance, Entitlement management';

const lower = (value) => String(value ?? '').toLowerCase();
const odataText = (value) => String(value ?? '').replaceAll("'", "''");
const symbolName = (symbol) => (typeof symbol === 'string' && symbol.includes(':') ? symbol.slice(symbol.indexOf(':') + 1) : null);
const referenceAt = (resource, field) => (resource.references ?? []).find((ref) => String(ref?.field ?? '') === field) ?? null;
const getAt = (root, path) => String(path).split('.').reduce((value, key) => value?.[key], root);

/** The target's id for the backup's reference at `field`: { targetId, ref } or { missing, ref }. */
function targetFor(resource, field, ctx) {
  const ref = referenceAt(resource, field);
  if (typeof ref?.symbol !== 'string') return { missing: true, ref };
  const result = resolveSymbol(ref.symbol, ctx.referenceContext);
  if (!result.resolved) return { missing: true, ref };
  return { targetId: VERBATIM_RESOLUTIONS.has(result.via) ? getAt(resource.payload, field) : result.targetId, ref };
}

const failed = (resource, error) => ({ failed: { naturalKey: resource.naturalKey, error } });
const manual = (resource, requirement, fields, description) => ({
  skipped: {
    naturalKey: resource.naturalKey,
    reason: `manual: ${description}`,
    completion: [Object.freeze({ kind: 'manual-setting', requirement, fields: Object.freeze(fields), description })],
  },
});
const noContext = (resource, what) => failed(resource, `no reference context: ${what} cannot be matched in the target, so nothing is written`);

/** A rewrite to other ids needs this operation's remapping proof. */
function unproven(resource, before, after) {
  if (JSON.stringify(before) === JSON.stringify(after) || remappingFor(resource.resourceType, 'create').qualified) return null;
  return failed(resource, `unqualified-remapping: ${resource.resourceType} create would point at different ids, and reference remapping is not proven for this operation`);
}

// ------------------------------------------------------ catalog resources

const SYSTEMS = Object.freeze({ AadGroup: 'group', AadApplication: 'app', SharePointOnline: 'SharePoint site' });
const sameOrigin = (desired, live) => lower(desired?.originId) === lower(live?.originId) && lower(desired?.originSystem) === lower(live?.originSystem);

/** The resource in plain words: its reference's name, the site's address or its own name. */
function catalogResourceName(resource) {
  const payload = resource.backupPayload ?? resource.payload ?? {};
  const kind = SYSTEMS[payload.originSystem] ?? 'resource';
  const name = payload.originSystem === 'SharePointOnline' ? payload.originId
    : symbolName((resource.backupReferences ?? resource.references ?? []).find((ref) => ref?.field === 'originId')?.symbol) ?? payload.displayName;
  return name ? `the ${kind} "${name}"` : `a ${kind} the backup does not name`;
}

/**
 * Points a backed-up catalog resource at the target: its catalog, and the group
 * or app, each found by natural key. A site keeps its address.
 */
function targetCatalogResource(resource, ctx = {}) {
  const payload = resource.payload;
  if (!payload?.originId || !payload?.originSystem) return failed(resource, 'the backup holds no origin for this catalog resource');
  const where = `${PORTAL}, under Catalogs, Resources`;
  if (!SYSTEMS[payload.originSystem]) {
    return manual(resource, 'catalogResource', ['originSystem'], `A restore adds only groups, apps and SharePoint sites to a catalog, so "${payload.displayName ?? 'this resource'}" was not added. Add it by hand in ${where}.`);
  }
  if (!ctx.referenceContext) return noContext(resource, 'its catalog');
  const catalog = targetFor(resource, 'catalogId', ctx);
  if (catalog.missing) return failed(resource, 'dependency: the catalog this resource belongs to is not in the target and is not restored in this run; restore the catalog first. Nothing was written');
  const kept = [catalog.ref];
  let originId = payload.originId;
  if (payload.originSystem !== 'SharePointOnline') {
    const origin = targetFor(resource, 'originId', ctx);
    if (origin.missing) {
      return manual(resource, 'catalogResource', ['originId'], `The backup's catalog holds ${catalogResourceName(resource)}, which does not exist in the target, so it was not added. Restore or create it first, then add it by hand in ${where}.`);
    }
    originId = origin.targetId;
    kept.push(origin.ref);
  }
  const rewritten = { ...payload, catalogId: catalog.targetId, originId };
  const refused = unproven(resource, [payload.catalogId, payload.originId], [rewritten.catalogId, rewritten.originId]);
  if (refused) return refused;
  return { resource: { ...resource, payload: rewritten, backupPayload: resource.backupPayload ?? payload, backupReferences: resource.backupReferences ?? resource.references, references: kept } };
}

/** The catalog's resource with this origin: { found } (null when absent) or { error }. */
async function findInCatalog(io, payload) {
  const listed = await readAllPages(io, 'v1.0', `${CATALOGS}/${encodeURIComponent(payload.catalogId)}/resources?$filter=originId eq '${odataText(payload.originId)}'`);
  if (listed.error) return { error: `the catalog's resources could not be read (${listed.error})` };
  return { found: listed.value.find((row) => sameOrigin(payload, row)) ?? null };
}

async function catalogResourcePreflight(io, { resource, payload }) {
  const inCatalog = await findInCatalog(io, payload);
  if (inCatalog.error) return inCatalog.error;
  return inCatalog.found ? { skipped: `the catalog already holds ${catalogResourceName(resource)}, so nothing is written` } : null;
}

/** adminAdd, then the resource is found by its origin (a request's id is not the resource's). */
async function catalogResourceWrite(io, { payload }) {
  const request = { requestType: 'adminAdd', resource: { originId: payload.originId, originSystem: payload.originSystem }, catalog: { id: payload.catalogId } };
  const added = await io.retryOperation(() => io.writer.write('v1.0', RESOURCE_REQUESTS, { method: 'POST', body: request }));
  return added?.ok ? { ok: true, status: added.status, body: null } : (added ?? { ok: false, error: 'no response to the catalog resource request' });
}

async function catalogResourceRead(io, { payload, targetId }) {
  const listed = await findInCatalog(io, payload);
  if (listed.error) return { ok: false, status: null, body: { error: listed.error } };
  const row = listed.found && (!targetId || lower(listed.found.id) === lower(targetId)) ? listed.found : null;
  return row ? { ok: true, status: 200, body: { ...row, catalogId: payload.catalogId } } : { ok: false, status: 404, body: null };
}

export const CATALOG_RESOURCE_RECORD = defineRecord({
  resourceType: 'accessPackageCatalogResource', version: 'v1.0', collection: RESOURCE_REQUESTS,
  operations: ['create'], writable: ['catalogId', 'originId', 'originSystem'],
  sameField: (field, desired, live) => (field === 'catalogId' || field === 'originId' ? lower(desired) === lower(live) : null),
  refusal: withApprovalGate(), preflight: catalogResourcePreflight,
  writeVia: catalogResourceWrite, readVia: catalogResourceRead, writeRoute: RESOURCE_REQUESTS,
  permission: PERMISSION, docs: `${DOCS}/entitlementmanagement-post-resourcerequests?view=graph-rest-1.0`,
});

// ------------------------------------------------------------ assignments

/**
 * Points a backed-up assignment at the target's person, package and policy.
 * Returns { resource }, { failed } or { skipped }.
 */
function targetAssignment(resource, ctx = {}) {
  const payload = resource.payload;
  if (!payload || typeof payload !== 'object') return failed(resource, 'the backup holds no assignment to grant again');
  if (!assignmentInEffect(payload, ctx.now ?? Date.now())) {
    return { skipped: { naturalKey: resource.naturalKey, reason: `the assignment was not in effect (${payload.state ?? 'no state'}${payload.state === 'delivered' ? ', past its end date' : ''}), so no access is granted` } };
  }
  if (!payload.assignmentPolicy?.id) {
    return manual(resource, 'accessPackageAssignment', ['assignmentPolicy'], `The backup does not say which policy gave ${assignmentGrantText(payload)} (it was taken before KEEL read it), so the package was not assigned again. Take a new backup, or assign the package by hand in ${PORTAL}, under Access packages, Assignments.`);
  }
  if (!ctx.referenceContext) return noContext(resource, 'the person, package and policy');
  const pkg = targetFor(resource, 'accessPackage.id', ctx);
  if (pkg.missing) return failed(resource, 'dependency: the access package is not in the target and is not restored in this run; restore the package first. Nothing was written');
  const policy = targetFor(resource, 'assignmentPolicy.id', ctx);
  if (policy.missing) return failed(resource, 'dependency: the policy that granted this assignment is not in the target and is not restored in this run; restore the policy first. Nothing was written');
  const target = targetFor(resource, 'target.objectId', ctx);
  if (target.missing) {
    return manual(resource, 'accessPackageAssignment', ['target'], `The backup gives ${assignmentGrantText(payload)}, but that person does not exist in the target, so the package was not assigned. Restore or create them first, or assign the package by hand in ${PORTAL}, under Access packages, Assignments.`);
  }
  const rewritten = {
    ...payload,
    target: { ...payload.target, objectId: target.targetId },
    accessPackage: { ...payload.accessPackage, id: pkg.targetId },
    assignmentPolicy: { ...payload.assignmentPolicy, id: policy.targetId },
  };
  const ids = (value) => [value.target.objectId, value.accessPackage.id, value.assignmentPolicy.id];
  const refused = unproven(resource, ids(payload), ids(rewritten));
  if (refused) return refused;
  return { resource: { ...resource, payload: rewritten, backupPayload: resource.backupPayload ?? payload, backupReferences: resource.backupReferences ?? resource.references, references: [pkg.ref, policy.ref, target.ref] } };
}

const ACTIVE_STATES = new Set(['delivering', 'delivered', 'partiallydelivered', 'pendingapproval']);

/** The target's live assignment of this package to this person: { found } or { error }. */
async function findAssignment(io, payload) {
  const filter = `accessPackage/id eq '${odataText(payload.accessPackage.id)}' and target/objectId eq '${odataText(payload.target.objectId)}'`;
  const listed = await readAllPages(io, 'v1.0', `${ASSIGNMENTS}?$filter=${filter}&$expand=target,accessPackage,assignmentPolicy`);
  if (listed.error) return { error: `the access package's assignments could not be read (${listed.error})` };
  return {
    found: listed.value.find((row) => lower(row?.target?.objectId) === lower(payload.target.objectId)
      && lower(row?.accessPackage?.id) === lower(payload.accessPackage.id) && ACTIVE_STATES.has(lower(row?.state))) ?? null,
  };
}

async function assignmentPreflight(io, { resource, payload }) {
  const live = await findAssignment(io, payload);
  if (live.error) return live.error;
  return live.found ? { skipped: `the target already gives ${assignmentGrantText(resource.backupPayload ?? payload)}, so nothing is granted` } : null;
}

/** The request: access granted through the policy, ending no later than the backup's end date. */
async function assignmentWrite(io, { payload }) {
  const end = payload.schedule?.expiration?.type === 'afterDateTime' ? payload.schedule.expiration.endDateTime : null;
  const request = {
    requestType: 'adminAdd',
    assignment: { targetId: payload.target.objectId, assignmentPolicyId: payload.assignmentPolicy.id, accessPackageId: payload.accessPackage.id },
    ...(end ? { schedule: { startDateTime: new Date().toISOString(), expiration: { type: 'afterDateTime', endDateTime: end } } } : {}),
  };
  const sent = await io.retryOperation(() => io.writer.write('v1.0', ASSIGNMENT_REQUESTS, { method: 'POST', body: request }));
  // The answer is the request; the assignment is found by person and package.
  return sent?.ok ? { ok: true, status: sent.status, body: null } : (sent ?? { ok: false, error: 'no response to the assignment request' });
}

async function assignmentRead(io, { payload, targetId }) {
  const live = await findAssignment(io, payload);
  if (live.error) return { ok: false, status: null, body: { error: live.error } };
  const row = live.found && (!targetId || lower(live.found.id) === lower(targetId)) ? live.found : null;
  return row ? { ok: true, status: 200, body: row } : { ok: false, status: 404, body: null };
}

const sameAssignmentPart = { target: (value) => lower(value?.objectId), accessPackage: (value) => lower(value?.id), assignmentPolicy: (value) => lower(value?.id) };

export const ASSIGNMENT_RECORD = defineRecord({
  resourceType: 'accessPackageAssignment', version: 'v1.0', collection: ASSIGNMENT_REQUESTS,
  operations: ['create'], writable: ['target', 'accessPackage', 'assignmentPolicy'],
  // The request names each by id, nothing else.
  transform: (body) => ({ target: { objectId: body.target?.objectId }, accessPackage: { id: body.accessPackage?.id }, assignmentPolicy: { id: body.assignmentPolicy?.id } }),
  sameField: (field, desired, live) => (sameAssignmentPart[field] ? sameAssignmentPart[field](desired) === sameAssignmentPart[field](live) : null),
  refusal: withApprovalGate(), preflight: assignmentPreflight,
  planChanges: async (_io, { resource }) => ({ grants: `gives ${assignmentGrantText(resource.backupPayload ?? resource.payload)}` }),
  writeVia: assignmentWrite, readVia: assignmentRead, writeRoute: ASSIGNMENT_REQUESTS,
  permission: PERMISSION, docs: `${DOCS}/entitlementmanagement-post-assignmentrequests?view=graph-rest-1.0`,
});

// ------------------------------------------- entitlement management roles

const CATALOG_SCOPE = /^\/AccessPackageCatalog\/([0-9a-f-]{36})$/i;

/** Points a backed-up role assignment at the target's person and catalog. */
function targetRoleAssignment(resource, ctx = {}) {
  const payload = resource.payload;
  if (!payload?.principalId || !payload?.roleDefinitionId) return failed(resource, 'the backup holds no person or role for this role assignment');
  const where = `${PORTAL}, under Catalogs, Roles and administrators`;
  const role = ENTITLEMENT_ROLE_NAMES[lower(payload.roleDefinitionId)];
  if (!role) return manual(resource, 'entitlementRole', ['roleDefinitionId'], `A restore puts back only catalog owners, catalog readers and access package managers, so this role assignment was not restored. Add it by hand in ${where}.`);
  const catalogId = CATALOG_SCOPE.exec(String(payload.appScopeId ?? ''))?.[1];
  if (!catalogId) return manual(resource, 'entitlementRole', ['appScopeId'], `This ${role} role is not on one catalog, so it was not restored. Add it by hand in ${where}.`);
  if (!ctx.referenceContext) return noContext(resource, 'the person and the catalog');
  // A catalog is keyed by its id: its scope names that key.
  const catalog = resolveSymbol(`accessPackageCatalog:${catalogId}`, ctx.referenceContext);
  if (!catalog.resolved) return failed(resource, `dependency: the catalog this ${role} role covers is not in the target and is not restored in this run; restore the catalog first. Nothing was written`);
  const principal = targetFor(resource, 'principalId', ctx);
  if (principal.missing) {
    const name = symbolName(principal.ref?.symbol);
    return manual(resource, 'entitlementRole', ['principalId'], `The ${role} ${name ? `"${name}"` : 'that the backup names'} does not exist in the target, so the role was not given. Restore or create them first, or add the role by hand in ${where}.`);
  }
  const rewritten = {
    ...payload,
    principalId: principal.targetId,
    appScopeId: `/AccessPackageCatalog/${VERBATIM_RESOLUTIONS.has(catalog.via) ? catalogId : catalog.targetId}`,
  };
  const refused = unproven(resource, [payload.principalId, payload.appScopeId], [rewritten.principalId, rewritten.appScopeId]);
  if (refused) return refused;
  // Only the person's reference is kept: the role is built in, the same id in every tenant.
  return { resource: { ...resource, payload: rewritten, backupPayload: resource.backupPayload ?? payload, backupReferences: resource.backupReferences ?? resource.references, references: [principal.ref] } };
}

const sameRoleAssignment = (row, payload) => lower(row?.principalId) === lower(payload.principalId)
  && lower(row?.roleDefinitionId) === lower(payload.roleDefinitionId) && lower(row?.appScopeId) === lower(payload.appScopeId);

async function roleAssignmentPreflight(io, { payload }) {
  // Listed one role at a time, as Graph requires (and as the backup reads it).
  const listed = await readAllPages(io, 'beta', `${ROLE_ASSIGNMENTS}?$filter=roleDefinitionId eq '${odataText(payload.roleDefinitionId)}'`);
  if (listed.error) return `could not list the role's assignments to look for this one (${listed.error})`;
  const role = ENTITLEMENT_ROLE_NAMES[lower(payload.roleDefinitionId)];
  return listed.value.some((row) => sameRoleAssignment(row, payload)) ? { skipped: `the person already holds the ${role} role on the catalog, so nothing is written` } : null;
}

export const ROLE_ASSIGNMENT_RECORD = defineRecord({
  resourceType: 'entitlementManagementRoleAssignment', version: 'beta', collection: ROLE_ASSIGNMENTS,
  operations: ['create'], writable: ['principalId', 'roleDefinitionId', 'appScopeId'],
  sameField: (_field, desired, live) => lower(desired) === lower(live),
  refusal: withApprovalGate(), preflight: roleAssignmentPreflight,
  permission: PERMISSION, docs: `${DOCS}/rbacapplication-post-roleassignments?view=graph-rest-beta`,
});

/** The writes of this module: each target is worked out first, then the record writes. */
export function entitlementGrantDispatch(resource, verb, ctx = {}) {
  const route = {
    accessPackageCatalogResource: [CATALOG_RESOURCE_RECORD, targetCatalogResource],
    accessPackageAssignment: [ASSIGNMENT_RECORD, targetAssignment],
    entitlementManagementRoleAssignment: [ROLE_ASSIGNMENT_RECORD, targetRoleAssignment],
  }[resource.resourceType];
  if (!route) return null;
  const [record, target] = route;
  if (!record.operations.includes(verb)) return { record, resource };
  const targeted = target(resource, ctx);
  if (targeted.failed) return { done: { failed: targeted.failed } };
  if (targeted.skipped) return { done: { skipped: targeted.skipped } };
  return { record, resource: targeted.resource };
}
