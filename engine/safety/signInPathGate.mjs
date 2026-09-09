import { isDeepStrictEqual } from 'node:util';
import { canonicalize } from '../cir/canonicalHash.mjs';

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

  const [conditionalAccessPolicies, authenticationMethodsPolicy, securityDefaults, principalStates, roleAssignments] = await Promise.all([
    collect(reader, '/identity/conditionalAccess/policies'),
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

/** A difference is a hard failure. There is intentionally no override. */
export function compareSignInPaths(before, after) {
  if (isDeepStrictEqual(before, after)) return { allowed: true };

  const changed = [...new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ])].filter((section) => !isDeepStrictEqual(before?.[section], after?.[section]));
  return {
    allowed: false,
    reason: `sign-in path changed: ${changed.join(', ')}`,
    changed,
  };
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
