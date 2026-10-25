import { SERVER_OWNED, fieldClass } from '../cir/serverOwned.mjs';

/** Resolution order per spec §8.2 — order is load-bearing, tested explicitly.
 * Task 50 adds an optional 5th tier, `lineage` (engine/store/resourceLineage.mjs's
 * resolveNaturalKey / recovery chain, precomputed by the caller into a
 * Map<symbol, { targetId } | { ambiguous: true }>), consulted only after every
 * higher-priority source misses. A lineage match is always reported
 * `stale: true` — it resolves the target, but never as fresh current
 * authorization the way exact-match/mapping-table/prior-restore are. An
 * `ambiguous` entry (the "unrelated name reuse" case: more than one distinct
 * lineage ever held this name) always refuses rather than guessing. */
export function resolveSymbol(symbol, { targetIndex, mappingTable, runProvenance, lineage }) {
  if (symbol === null) return { resolved: false, reason: 'unresolvable-at-collection' };
  if (symbol.startsWith('global:')) return { resolved: true, targetId: symbol, via: 'global-constant' };
  // A foreign tenant id (a cross-tenant partner's tenantId) is written verbatim: by
  // definition it is never an object of the target tenant, so a lookup there is
  // meaningless. A read-only field (createdByAppId) is never written at all. Both
  // resolve like a global constant: the value stays as it is and nothing is gated.
  if (symbol.startsWith('foreignTenant:')) return { resolved: true, targetId: symbol, via: 'foreign-tenant' };
  if (symbol.startsWith('readOnly:')) return { resolved: true, targetId: symbol, via: 'read-only' };
  // An app's requiredResourceAccess (and a Conditional Access policy's app list)
  // names an app by appId, and each permission by the id its API publishes.
  // canonicalize.mjs gives them index-only symbols (`object:<appId>`,
  // `permission:<appId>/role:…`) that no restored resource has as a key, so they
  // never matched and every app that asks for a permission failed to restore.
  // A permission id belongs to its API and is the same wherever the API exists, so
  // it is written as stored; whether the API exists is the appId reference's check.
  // An appId is written as stored when the target has that app or its service
  // principal (both are always read), or as the new appId when this run recreated
  // the app. Anything else still refuses: a missing API is never written blind.
  if (symbol.startsWith('permission:')) return { resolved: true, targetId: symbol, via: 'resource-permission' };
  const appId = appIdOf(symbol);
  if (appId) {
    const recreated = runProvenance.get(`application:${appId}#appId`);
    if (typeof recreated === 'string' && recreated.length > 0) return { resolved: true, targetId: recreated, via: 'prior-restore' };
    if (targetIndex.has(`application:${appId}`) || targetIndex.has(`servicePrincipal:${appId}`)) {
      return { resolved: true, targetId: symbol, via: 'app-id' };
    }
    return { resolved: false, reason: 'not-found-in-target' };
  }
  if (targetIndex.has(symbol)) return { resolved: true, targetId: targetIndex.get(symbol), via: 'exact-match' };
  if (mappingTable.has(symbol)) {
    const mapped = mappingTable.get(symbol);
    if (targetIndex.has(mapped)) return { resolved: true, targetId: targetIndex.get(mapped), via: 'mapping-table' };
    return { resolved: false, reason: `mapping-table points at ${mapped}, not found in target` };
  }
  if (runProvenance.has(symbol)) return { resolved: true, targetId: runProvenance.get(symbol), via: 'prior-restore' };
  if (lineage?.has(symbol)) {
    const entry = lineage.get(symbol);
    if (entry.ambiguous) return { resolved: false, reason: 'ambiguous-alias' };
    return { resolved: true, targetId: entry.targetId, via: 'lineage-recovery', stale: true };
  }
  return { resolved: false, reason: 'not-found-in-target' };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The appId an `object:<appId>` symbol holds, or null. Only a GUID body: an
 * `object:` symbol built from a display name is never written into an id field. */
function appIdOf(symbol) {
  if (typeof symbol !== 'string' || !symbol.startsWith('object:')) return null;
  const body = symbol.slice('object:'.length);
  return GUID.test(body) ? body.toLowerCase() : null;
}

/** Resolutions whose targetId is the symbol itself: the field keeps its source value. */
export const VERBATIM_RESOLUTIONS = new Set(['global-constant', 'foreign-tenant', 'read-only', 'resource-permission', 'app-id']);

/** Symbols that never name a target-tenant object, so they never gate a wave,
 * never pull a dependency into a selection and never count as unresolved. */
export function isVerbatimSymbol(symbol) {
  return typeof symbol === 'string'
    && (symbol.startsWith('global:') || symbol.startsWith('foreignTenant:') || symbol.startsWith('readOnly:')
      || symbol.startsWith('permission:'));
}

/**
 * The resource a reference waits for, among `nodes` (natural keys). An appId
 * (`object:<appId>`) names the app registration `application:<appId>` when the
 * same restore holds it, so the app is written first and a recreated app's new
 * appId is known before anything that names it. A service principal is never a
 * dependency this way: a first-party API's principal (Microsoft Graph) is not
 * something a restore of an app puts back. Returns null when nothing in `nodes`
 * is named.
 */
export function dependencySymbol(symbol, nodes) {
  if (!symbol || isVerbatimSymbol(symbol)) return null;
  const appId = appIdOf(symbol);
  if (appId) return nodes.has(`application:${appId}`) ? `application:${appId}` : null;
  return nodes.has(symbol) ? symbol : null;
}

/** An appId reference the restore resolves against the target when it is written,
 * not a key a backup ever holds, so it is never listed as missing from one. */
export function isAppIdSymbol(symbol) {
  return appIdOf(symbol) !== null;
}

/** A reference whose field is server-owned (engine/cir/serverOwned.mjs) sits in a
 * field no write ever carries, so whether it resolves cannot matter: an Intune
 * child id, say, is regenerated by the target on every create. Array indices are
 * dropped so "a[0].b[1].id" is classified as "a.b.id", the form SERVER_OWNED uses.
 * A type serverOwned.mjs does not know keeps every reference. */
export function isServerOwnedReference(ref, resourceType) {
  if (!resourceType || !SERVER_OWNED.has(resourceType) || typeof ref?.field !== 'string') return false;
  return fieldClass(ref.field.replace(/\[\d+\]/g, ''), resourceType) === 'serverOwned';
}

export function resolvePlan(resources, ctx) {
  const resolved = [];
  const unresolved = [];
  for (const resource of resources) {
    const resolvedReferences = [];
    for (const ref of resource.references) {
      if (isServerOwnedReference(ref, resource.resourceType)) continue;
      const result = resolveSymbol(ref.symbol, ctx);
      if (result.resolved) {
        resolvedReferences.push({ ...ref, targetId: result.targetId, via: result.via });
      } else {
        unresolved.push({ naturalKey: resource.naturalKey, field: ref.field, symbol: ref.symbol, required: ref.required, reason: result.reason });
      }
    }
    resolved.push({ ...resource, resolvedReferences });
  }
  return { resolved, unresolved };
}
