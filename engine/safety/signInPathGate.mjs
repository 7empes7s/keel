import { isDeepStrictEqual } from 'node:util';
import { canonicalize } from '../cir/canonicalHash.mjs';

export const NAMED_LOCATIONS_PATH = '/identity/conditionalAccess/namedLocations';

/**
 * §10.3's replacement for What If evaluation. Graph permits this complete
 * sign-in-path inventory to the Collector application credential, so evidence
 * is gathered by an identity that cannot make restore changes.
 */
export async function snapshotSignInPath(reader, { protectedPrincipalIds }) {
  const principalIds = [...new Set(protectedPrincipalIds ?? [])].sort();
  if (principalIds.length === 0) {
    throw new Error('sign-in path gate requires at least one protected principal');
  }

  const [conditionalAccessPolicies, namedLocations, authenticationMethodsPolicy, securityDefaults, principalStates, roleAssignments] = await Promise.all([
    collect(reader, '/identity/conditionalAccess/policies'),
    // Security audit run 1, finding 2: a named location decides which networks
    // and countries the policies above trust, so a change to one is a sign-in
    // path change too.
    collect(reader, NAMED_LOCATIONS_PATH),
    get(reader, '/policies/authenticationMethodsPolicy'),
    get(reader, '/policies/identitySecurityDefaultsEnforcementPolicy'),
    Promise.all(principalIds.map(async (principalId) => [
      principalId,
      await accountState(reader, principalId),
    ])),
    Promise.all(principalIds.map((principalId) => collect(
      reader,
      `/roleManagement/directory/roleAssignments?${new URLSearchParams({ '$filter': `principalId eq '${principalId}'` })}`,
    ))),
  ]);

  return {
    conditionalAccessPolicies: normaliseCollection(conditionalAccessPolicies, 'conditionalAccessPolicy'),
    namedLocations: normaliseCollection(namedLocations, 'namedLocation'),
    authenticationMethodsPolicy: normalise(authenticationMethodsPolicy, 'authenticationMethodsPolicy'),
    // Security defaults is a singleton policy, not a collected resource type.
    // It has no type-specific server-owned fields; this deliberately reuses
    // the authentication-methods policy's existing generic classification
    // instead of creating another server-owned-field judgement here.
    securityDefaults: normalise(securityDefaults, 'authenticationMethodsPolicy'),
    principalStates: Object.fromEntries(principalStates),
    roleAssignments: normaliseCollection(roleAssignments.flat(), 'roleAssignment'),
  };
}

/**
 * A difference is a hard failure. There is intentionally no override.
 *
 * Roadmap task-149: `intendedSections` names sections this run changed ON
 * PURPOSE through a tenant policy write that read back exactly as written
 * (authenticationMethodsPolicy, securityDefaults). Only those sections are
 * left out; any change anywhere else still fails.
 */
export function compareSignInPaths(before, after, { intendedSections = [] } = {}) {
  if (isDeepStrictEqual(before, after)) return { allowed: true };

  const intended = new Set(intendedSections);
  const changed = [...new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ])].filter((section) => !intended.has(section) && !isDeepStrictEqual(before?.[section], after?.[section]));
  if (changed.length === 0) return { allowed: true, intended: [...intended] };
  return {
    allowed: false,
    reason: `sign-in path changed: ${changed.join(', ')}`,
    changed,
  };
}

/**
 * Gap register D1: reads the sign-in path once and keeps the raw reads, so the
 * state after deleting objects can be replayed without reading again.
 *
 *  - `snapshot`: the same result snapshotSignInPath() returns.
 *  - `without(ids)`: the snapshot with every collected item whose id is in `ids` left out.
 *  - `holds(id)`: whether a collected item has this id.
 *  - `itemOf(id)`: a copy of the collected item with this id, or null.
 *  - `usersOf(id, gone)`: what still names this id once `id` and `gone` are left
 *    out (a policy's display name, or the section of the read).
 */
export async function recordSignInPath(reader, { protectedPrincipalIds }) {
  const seen = new Map();
  const recording = {
    async collect(version, path) {
      const result = await reader.collect(version, path);
      seen.set(`collect ${path}`, structuredClone(result));
      return result;
    },
    async get(version, path) {
      const result = await reader.get(version, path);
      seen.set(`get ${path}`, structuredClone(result));
      return result;
    },
  };
  const snapshot = await snapshotSignInPath(recording, { protectedPrincipalIds });
  const lower = (ids) => new Set([...ids].map((id) => String(id).toLowerCase()));
  const idOf = (item) => String(item?.id ?? '').toLowerCase();
  const collected = () => [...seen.entries()]
    .filter(([key, result]) => key.startsWith('collect ') && Array.isArray(result?.items))
    .flatMap(([key, result]) => result.items.map((item) => ({ path: key.slice('collect '.length), item })));
  const replay = (ids) => ({
    async collect(_version, path) {
      const result = structuredClone(seen.get(`collect ${path}`));
      if (!Array.isArray(result?.items)) return result;
      return { ...result, items: result.items.filter((item) => !ids.has(idOf(item))) };
    },
    async get(_version, path) {
      return structuredClone(seen.get(`get ${path}`));
    },
  });
  return Object.freeze({
    snapshot,
    without: (ids) => snapshotSignInPath(replay(lower(ids)), { protectedPrincipalIds }),
    holds: (id) => collected().some(({ item }) => idOf(item) === String(id).toLowerCase()),
    /** The raw collected item with this id, or null. */
    itemOf: (id) => structuredClone(collected().find(({ item }) => idOf(item) === String(id).toLowerCase())?.item ?? null),
    usersOf(id, gone = []) {
      const needle = String(id).toLowerCase();
      const skip = lower([...gone, id]);
      const named = (value) => JSON.stringify(value ?? null).toLowerCase().includes(needle);
      const users = collected()
        .filter(({ item }) => !skip.has(idOf(item)) && named(item))
        .map(({ path, item }) => item?.displayName ?? path.split('?')[0]);
      for (const [key, result] of seen.entries()) {
        if (key.startsWith('get ') && named(result?.body)) users.push(key.slice('get '.length).split('?')[0]);
      }
      return [...new Set(users)];
    },
  });
}

async function collect(reader, path) {
  const result = await reader.collect('v1.0', path);
  if (result.error) throw new Error(`sign-in path gate read ${path} failed: ${result.error.error ?? result.error.status}`);
  if (result.capped) throw new Error(`sign-in path gate read ${path} was incomplete`);
  return result.items;
}

async function get(reader, path) {
  const result = await reader.get('v1.0', path);
  if (!result.ok) throw new Error(`sign-in path gate read ${path} failed: ${result.error ?? result.status}`);
  return result.body;
}

async function accountState(reader, principalId) {
  const path = `/users/${encodeURIComponent(principalId)}?$select=id,accountEnabled`;
  const result = await reader.get('v1.0', path);
  if (result.status === 404) return null;
  if (!result.ok) throw new Error(`sign-in path gate read ${path} failed: ${result.error ?? result.status}`);
  return normalise({ accountEnabled: result.body.accountEnabled }, 'user');
}

function normaliseCollection(items, resourceType) {
  return items.map((item) => normalise(item, resourceType)).sort(compareJson);
}

function normalise(value, resourceType) {
  return sortCollections(canonicalize(value, resourceType));
}

function sortCollections(value) {
  if (Array.isArray(value)) return value.map(sortCollections).sort(compareJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sortCollections(item)]));
}

function compareJson(a, b) {
  return JSON.stringify(a).localeCompare(JSON.stringify(b));
}
