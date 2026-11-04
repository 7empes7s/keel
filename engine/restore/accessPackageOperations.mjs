/**
 * Issue #992: entitlement management, part 1. Access packages and the
 * resource roles they grant.
 *
 *  - accessPackage: create and update of its name, description and whether it
 *    is hidden. A create puts it in its catalog: the catalog this run restored,
 *    or the live one with the same natural key (the package's `catalog.id`
 *    reference, rewritten by the wave). A catalog in neither is a clear refusal,
 *    and nothing is written. The planner orders the catalog first because the
 *    package references it. A delete is refused (no operation record).
 *  - accessPackageResourceRoleScope: create of one resource role on its package
 *    (POST /accessPackages/{id}/resourceRoleScopes). The group or app it grants
 *    is matched in the target by natural key, never written by an id from
 *    another tenant. The resource must be in the package's catalog first: a
 *    group or app that exists live is added to it (resourceRequests adminAdd);
 *    anything else (a SharePoint site, a group that is not there) is a manual
 *    step that names it. Granting a role changes who can get access, so every
 *    write sits behind the restore approval (approvalHeld.mjs).
 *
 * Assignments stay manual: they are granted through a request, never copied.
 * Routes follow the Graph v1.0 references and are fixture-tested, not
 * live-qualified.
 */
import { remappingFor } from '../coverage/qualification.mjs';
import { VERBATIM_RESOLUTIONS, resolveSymbol } from '../graph/resolver.mjs';
import { createdOnce, readAllPages, withApprovalGate } from './approvalHeld.mjs';
import { isPlannedId } from './plannedIds.mjs';
import { defineRecord, isNotFound, outcomeDetail, readUntil } from './recordWriter.mjs';

const EM = '/identityGovernance/entitlementManagement';
export const ACCESS_PACKAGES = `${EM}/accessPackages`;
const CATALOGS = `${EM}/catalogs`;
const RESOURCE_REQUESTS = `${EM}/resourceRequests`;
const PERMISSION = 'EntitlementManagement.ReadWrite.All';
const DOCS = 'https://learn.microsoft.com/en-us/graph/api';
const v1 = (page) => `${DOCS}/${page}?view=graph-rest-1.0`;
const PORTAL = 'the Entra admin center, under Identity Governance, Entitlement management';

const lower = (value) => String(value ?? '').toLowerCase();
const odataText = (value) => String(value ?? '').replaceAll("'", "''");

// ------------------------------------------------------------ access package

/** Whether the catalog a package names resolves in the target (or nothing tells). */
function catalogReference(resource) {
  return (resource.references ?? []).find((ref) => String(ref?.field ?? '') === 'catalog.id') ?? null;
}

/**
 * A create needs its catalog: the backup must name it, and it must be in the
 * target (live, or restored earlier in this run). Returns a failure text or null.
 */
export function accessPackageCatalogProblem(resource, verb, ctx = {}) {
  if (verb !== 'create') return null;
  const catalogId = resource.payload?.catalog?.id;
  const name = resource.payload?.catalog?.displayName;
  const named = name ? `its catalog "${name}"` : 'its catalog';
  if (typeof catalogId !== 'string' || catalogId.length === 0) {
    return 'the backup does not say which catalog this access package belongs to (it was taken before KEEL read it), so it cannot be created; take a new backup, or create it by hand in ' + PORTAL;
  }
  if (!ctx.referenceContext) return null;
  const ref = catalogReference(resource);
  const resolved = ref?.symbol ? resolveSymbol(ref.symbol, ctx.referenceContext) : { resolved: false };
  if (resolved.resolved) return null;
  return `dependency: ${named} is not in the target and is not restored in this run, so the access package cannot be created there; restore the catalog first (or select it in this restore). Nothing was written`;
}

const sameCatalog = (desired, live) => lower(desired?.id) === lower(live?.id);

export const ACCESS_PACKAGE_RECORD = defineRecord({
  resourceType: 'accessPackage', version: 'v1.0', collection: ACCESS_PACKAGES,
  operations: ['create', 'update'], writable: ['displayName', 'description', 'isHidden'], createOnly: ['catalog'],
  // The catalog is read back with the package, so the create's catalog is checked.
  readQuery: '$expand=catalog', remapsReferences: true,
  // Graph takes the catalog as a reference: its id, nothing else.
  transform: (body) => (body.catalog && typeof body.catalog === 'object' ? { ...body, catalog: { id: body.catalog.id } } : body),
  sameField: (field, desired, live) => (field === 'catalog' ? sameCatalog(desired, live) : null),
  // Graph gives a package a new id on every create: a second restore from the
  // same backup finds the first one's package by name in the same catalog.
  preflight: createdOnce({
    version: 'v1.0', path: `${ACCESS_PACKAGES}?$expand=catalog`, label: 'access package',
    matches: (row, payload) => lower(row?.displayName) === lower(payload.displayName) && sameCatalog(payload.catalog, row?.catalog),
    same: (row, payload) => (row?.description ?? '') === (payload.description ?? '') && Boolean(row?.isHidden) === Boolean(payload.isHidden),
  }),
  permission: PERMISSION, docs: v1('entitlementmanagement-post-accesspackages'),
});

// --------------------------------------------------- resource role scopes

const SYSTEMS = Object.freeze({
  AadGroup: 'group',
  AadApplication: 'app',
  SharePointOnline: 'SharePoint site',
});
/** Kinds whose resource a restore may add to a catalog (adminAdd) when it exists live. */
const ADDABLE = new Set(['AadGroup', 'AadApplication']);

const kindOf = (payload) => SYSTEMS[payload?.scope?.originSystem ?? payload?.role?.originSystem] ?? 'resource';

/** A plain-English name for what the role is on: the backup's name for it, never an id. */
function resourceName(resource) {
  const payload = resource.backupPayload ?? resource.payload ?? {};
  const kind = kindOf(payload);
  const ref = (resource.references ?? []).find((entry) => entry?.field === 'scope.originId' && typeof entry.symbol === 'string');
  const key = ref ? ref.symbol.slice(ref.symbol.indexOf(':') + 1) : null;
  const site = kind === 'SharePoint site' ? payload.scope?.originId : null;
  const name = site ?? key ?? payload.resourceDisplayName ?? null;
  const role = payload.role?.displayName ? `the ${payload.role.displayName} role of ` : '';
  return name ? `${role}the ${kind} "${name}"` : `${role}a ${kind} the backup does not name`;
}

const manualStep = (resource, why) => {
  const description = `${why} Add ${resourceName(resource)} to the access package by hand in ${PORTAL}, under Access packages, Resource roles.`;
  return Object.freeze({
    outcome: 'skipped',
    reason: `manual: ${description}`,
    completion: Object.freeze([Object.freeze({ kind: 'manual-setting', requirement: 'resourceRole', fields: Object.freeze(['role', 'scope']), description })]),
  });
};

function setAt(root, path, value) {
  const segments = String(path).split(/\.|\[|\]/).filter(Boolean).map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
  const walk = (node, index) => {
    const copy = Array.isArray(node) ? node.slice() : { ...(node ?? {}) };
    const key = segments[index];
    copy[key] = index === segments.length - 1 ? value : walk(node?.[key], index + 1);
    return copy;
  };
  return segments.length ? walk(root, 0) : root;
}

/**
 * Points a backed-up resource role at the target: its access package and the
 * group or app it grants, each found by natural key (`ctx.referenceContext`).
 * Returns { resource } (the payload rewritten, the backup kept as
 * `backupPayload` for the approval gate), or { failed } / { skipped }.
 */
export function targetRoleScope(resource, ctx = {}) {
  const { naturalKey } = resource;
  const payload = resource.payload;
  if (!payload?.role || !payload?.scope) return { failed: { naturalKey, error: 'the backup holds no role or scope for this resource role' } };
  if (!ctx.referenceContext) return { failed: { naturalKey, error: 'no reference context: the group or app cannot be matched in the target, so nothing is written' } };
  const system = payload.scope.originSystem ?? payload.role.originSystem;
  let rewritten = payload;
  const kept = [];
  let packageResolved = false;
  let scopeResolved = false;
  for (const ref of resource.references ?? []) {
    if (typeof ref?.symbol !== 'string') continue;
    const field = String(ref.field ?? '');
    const result = resolveSymbol(ref.symbol, ctx.referenceContext);
    if (!result.resolved) {
      if (field === 'accessPackageId') {
        return { failed: { naturalKey, error: 'dependency: the access package this role belongs to is not in the target and is not restored in this run; restore the package first. Nothing was written' } };
      }
      if (field === 'scope.originId') return { skipped: manualStep(resource, `The ${kindOf(payload)} this role grants does not exist in the target, so it cannot be added to the catalog or granted.`) };
      continue;
    }
    if (!VERBATIM_RESOLUTIONS.has(result.via)) rewritten = setAt(rewritten, field, result.targetId);
    if (field === 'accessPackageId') packageResolved = true;
    if (field === 'scope.originId') scopeResolved = true;
    kept.push(ref);
  }
  if (!packageResolved) {
    return { failed: { naturalKey, error: 'dependency: the backup does not link this role to an access package KEEL can find in the target; restore the package first. Nothing was written' } };
  }
  if (ADDABLE.has(system) && !scopeResolved) {
    return { skipped: manualStep(resource, `The ${kindOf(payload)} this role grants is not in the backup, so KEEL cannot find it in the target by name.`) };
  }
  // A group's role is named by the group's id ("Member_<id>"): it follows the group.
  if (system === 'AadGroup' && typeof payload.role.originId === 'string') {
    const [prefix] = payload.role.originId.split('_');
    rewritten = setAt(rewritten, 'role.originId', `${prefix}_${rewritten.scope.originId}`);
  }
  const moved = ['accessPackageId', 'scope.originId'].some((field) => lower(field.split('.').reduce((v, k) => v?.[k], payload)) !== lower(field.split('.').reduce((v, k) => v?.[k], rewritten)));
  if (moved && !remappingFor(resource.resourceType, 'create').qualified) {
    return { failed: { naturalKey, error: 'unqualified-remapping: accessPackageResourceRoleScope create would point at a different id, and reference remapping is not proven for this operation' } };
  }
  return { resource: { ...resource, payload: rewritten, backupPayload: resource.backupPayload ?? payload, references: kept } };
}

/** The body Graph takes: the role and scope by origin, nothing the service sets. */
function roleScopeBody(body) {
  const role = body.role ?? {};
  const scope = body.scope ?? {};
  const out = {};
  if (body.role) {
    out.role = Object.fromEntries(Object.entries({
      displayName: role.displayName, originId: role.originId, originSystem: role.originSystem,
      resource: { originId: scope.originId, originSystem: scope.originSystem ?? role.originSystem },
    }).filter(([, value]) => value !== undefined && value !== null));
  }
  if (body.scope) {
    out.scope = Object.fromEntries(Object.entries({
      displayName: scope.displayName, description: scope.description, originId: scope.originId, originSystem: scope.originSystem, isRootScope: scope.isRootScope,
    }).filter(([, value]) => value !== undefined && value !== null));
  }
  return out;
}

/** A role or scope is the same when its origin is: Graph adds ids and dates of its own. */
const sameOrigin = (desired, live) => lower(desired?.originId) === lower(live?.originId) && lower(desired?.originSystem) === lower(live?.originSystem);
const sameRoleScope = (row, payload) => sameOrigin(payload.role, row?.role) && sameOrigin(payload.scope, row?.scope);

const packagePath = (packageId) => `${ACCESS_PACKAGES}/${encodeURIComponent(packageId)}`;

/** The package's catalog id and its resource roles: { catalogId, scopes } or { error }. */
async function readPackage(io, packageId) {
  const result = await io.retryOperation(() => io.writer.read('v1.0', `${packagePath(packageId)}?$expand=catalog,resourceRoleScopes($expand=role,scope)`));
  if (isNotFound(result)) return { error: 'the access package is not in the target', status: 404 };
  if (result?.ok !== true) return { error: `the access package could not be read (${outcomeDetail(result)})`, status: result?.status };
  const catalogId = result.body?.catalog?.id;
  if (typeof catalogId !== 'string' || catalogId.length === 0) return { error: 'the access package read back with no catalog' };
  return { catalogId, scopes: Array.isArray(result.body?.resourceRoleScopes) ? result.body.resourceRoleScopes : [] };
}

/** The catalog's resource with this origin: { found } (null when absent) or { error }. */
async function findCatalogResource(io, catalogId, scope) {
  const listed = await readAllPages(io, 'v1.0', `${CATALOGS}/${encodeURIComponent(catalogId)}/resources?$filter=originId eq '${odataText(scope.originId)}'`);
  if (listed.error) return { error: `the catalog's resources could not be read (${listed.error})` };
  return { found: listed.value.find((row) => sameOrigin(scope, row)) ?? null };
}

/**
 * Before a create (and in a dry run): the package is there, the role is not
 * on it already, and its resource is in the catalog or can be added to it.
 */
async function roleScopePreflight(io, { resource, payload, verb }) {
  if (verb !== 'create') return null;
  const pkg = await readPackage(io, payload.accessPackageId);
  if (pkg.error) return pkg.error;
  const done = pkg.scopes.find((row) => sameRoleScope(row, payload));
  if (done) return { skipped: `the access package already grants ${resourceName(resource)}, so nothing is written` };
  const inCatalog = await findCatalogResource(io, pkg.catalogId, payload.scope);
  if (inCatalog.error) return inCatalog.error;
  if (!inCatalog.found && !ADDABLE.has(payload.scope.originSystem)) {
    const step = manualStep(resource, `The ${kindOf(payload)} is not in the access package's catalog, and a restore adds only groups and apps to a catalog.`);
    return { skipped: step.reason, completion: step.completion };
  }
  return null;
}

async function roleScopePlan(io, { payload }) {
  // A package this run only plans to create has no Graph id to read yet.
  if (isPlannedId(payload.accessPackageId)) return null;
  const pkg = await readPackage(io, payload.accessPackageId);
  if (pkg.error) return null;
  const inCatalog = await findCatalogResource(io, pkg.catalogId, payload.scope);
  return inCatalog.found || inCatalog.error ? null : { addedToCatalog: [payload.scope.originSystem] };
}

/**
 * The write: the resource is added to the catalog first when it is missing
 * there (adminAdd, then read until it is listed), then the role is added to the
 * package with the catalog's resource id.
 */
async function roleScopeWrite(io, { payload, body }) {
  const pkg = await readPackage(io, payload.accessPackageId);
  if (pkg.error) return { ok: false, status: pkg.status ?? null, error: pkg.error };
  let found = await findCatalogResource(io, pkg.catalogId, payload.scope);
  if (found.error) return { ok: false, error: found.error };
  if (!found.found) {
    if (!ADDABLE.has(payload.scope.originSystem)) return { ok: false, skipped: `the ${kindOf(payload)} is not in the access package's catalog` };
    const request = {
      requestType: 'adminAdd',
      resource: { originId: payload.scope.originId, originSystem: payload.scope.originSystem },
      catalog: { id: pkg.catalogId },
    };
    const added = await io.retryOperation(() => io.writer.write('v1.0', RESOURCE_REQUESTS, { method: 'POST', body: request }));
    if (!added?.ok) return added ?? { ok: false, error: 'no response to the catalog resource request' };
    const listed = await readUntil(io, 'v1.0', `${CATALOGS}/${encodeURIComponent(pkg.catalogId)}/resources?$filter=originId eq '${odataText(payload.scope.originId)}'`,
      (r) => r?.ok === true && !(r.body?.value ?? []).some((row) => sameOrigin(payload.scope, row)), io.readOptions);
    found = { found: (listed?.body?.value ?? []).find((row) => sameOrigin(payload.scope, row)) ?? null };
    if (!found.found) return { ok: false, error: `the ${kindOf(payload)} was requested for the catalog but did not appear in it` };
  }
  const sent = { ...body, role: { ...body.role, resource: { ...(body.role?.resource ?? {}), id: found.found.id } } };
  return io.retryOperation(() => io.writer.write('v1.0', `${packagePath(payload.accessPackageId)}/resourceRoleScopes`, { method: 'POST', body: sent }));
}

/** One resource role read back from its package: by id once known, else by origin. */
async function roleScopeRead(io, { payload, targetId }) {
  const pkg = await readPackage(io, payload.accessPackageId);
  if (pkg.error) return { ok: false, status: pkg.status ?? null, body: { error: pkg.error } };
  const row = targetId ? pkg.scopes.find((scope) => lower(scope?.id) === lower(targetId)) : pkg.scopes.find((scope) => sameRoleScope(scope, payload));
  return row ? { ok: true, status: 200, body: row } : { ok: false, status: 404, body: null };
}

export const ROLE_SCOPE_RECORD = defineRecord({
  resourceType: 'accessPackageResourceRoleScope', version: 'v1.0', collection: ACCESS_PACKAGES,
  operations: ['create'], writable: ['role', 'scope'], transform: roleScopeBody,
  sameField: (field, desired, live) => (field === 'role' || field === 'scope' ? sameOrigin(desired, live) : null),
  // Only a create is registered: a role is never changed or taken off by a restore.
  refusal: withApprovalGate(), preflight: roleScopePreflight, planChanges: roleScopePlan,
  writeVia: roleScopeWrite, readVia: roleScopeRead, writeRoute: `${ACCESS_PACKAGES}/{id}/resourceRoleScopes`,
  permission: PERMISSION, docs: v1('accesspackage-post-resourcerolescopes'),
});

/** The writes of this module: the package (its catalog checked first) and its resource roles. */
export function accessPackageDispatch(resource, verb, ctx) {
  if (resource.resourceType === 'accessPackage') {
    const problem = accessPackageCatalogProblem(resource, verb, ctx);
    return problem ? { done: { failed: { naturalKey: resource.naturalKey, error: problem } } } : { record: ACCESS_PACKAGE_RECORD, resource };
  }
  if (resource.resourceType === 'accessPackageResourceRoleScope') {
    if (verb !== 'create') return { record: ROLE_SCOPE_RECORD, resource };
    const targeted = targetRoleScope(resource, ctx);
    if (targeted.failed) return { done: { failed: targeted.failed } };
    if (targeted.skipped) {
      const { reason, completion } = targeted.skipped;
      return { done: { skipped: { naturalKey: resource.naturalKey, reason, completion } } };
    }
    return { record: ROLE_SCOPE_RECORD, resource: targeted.resource };
  }
  return null;
}
