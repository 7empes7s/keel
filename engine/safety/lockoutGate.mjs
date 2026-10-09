/**
 * Roadmap task-149: the break-glass lockout gate for tenant-wide policy writes.
 *
 * The authentication methods policy, security defaults and the authorization
 * policy can lock every user out of a tenant. KEEL writes them only when the
 * tenant's registered break-glass accounts are READY (all five task-94
 * dimensions pass, at least two accounts) and stay ready under the proposed
 * policy. For the authentication methods policy the proposed method
 * configurations replace the collected ones before the accounts are
 * re-evaluated, so a restore that would switch off the phishing-resistant
 * method a break-glass account relies on is withheld, and a restore that
 * narrows who may use that method is withheld too. For the authorization
 * policy and security defaults the gate checks readiness as collected; it does
 * not model the proposed setting.
 *
 * The gate is pure over its inputs and never calls Microsoft. `unknown` is
 * never `ready`: missing evidence withholds the write.
 */
import { isDeepStrictEqual } from 'node:util';

import { comparable } from '../restore/tenantPolicyOperations.mjs';
import { evaluateAccountReadiness, tenantReadiness } from './breakGlassReadiness.mjs';

function proposedInventory(inventory, { resourceType, desired }) {
  if (resourceType !== 'authenticationMethodsPolicy') return inventory;
  const current = inventory.authenticationMethodsPolicy;
  if (!current || current.status !== 'covered' || !current.resources.length) return inventory;
  const [policy, ...rest] = current.resources;
  const merged = { ...policy.payload, ...desired };
  return { ...inventory, authenticationMethodsPolicy: { ...current, resources: [{ ...policy, payload: merged }, ...rest] } };
}

// The methods-policy entries a break-glass phishing-resistant credential relies on.
const BREAK_GLASS_METHODS = Object.freeze(['fido2', 'x509certificate']);

function sameTargets(left, right) {
  return isDeepStrictEqual(comparable(left ?? []), comparable(right ?? []));
}

/**
 * Readiness reads only a method's state, not who it targets. A proposed change
 * to the targets of a method break-glass accounts rely on is therefore allowed
 * only when it keeps the method open to every user: includeTargets holds
 * all_users and nothing is excluded. Anything narrower cannot be shown to keep
 * the accounts in scope, so it is withheld.
 */
function narrowedTargets(inventory, { resourceType, desired }) {
  if (resourceType !== 'authenticationMethodsPolicy') return [];
  const current = inventory.authenticationMethodsPolicy?.resources?.[0]?.payload?.authenticationMethodConfigurations ?? [];
  const narrowed = [];
  for (const config of desired?.authenticationMethodConfigurations ?? []) {
    const id = String(config?.id ?? '').toLowerCase();
    if (!BREAK_GLASS_METHODS.includes(id)) continue;
    const before = current.find((entry) => String(entry?.id ?? '').toLowerCase() === id);
    const unchanged = before
      && (!Object.hasOwn(config, 'includeTargets') || sameTargets(config.includeTargets, before.includeTargets))
      && (!Object.hasOwn(config, 'excludeTargets') || sameTargets(config.excludeTargets, before.excludeTargets));
    if (unchanged) continue;
    const allUsers = (config.includeTargets ?? []).some((target) => String(target?.id ?? '').toLowerCase() === 'all_users');
    const noneExcluded = (config.excludeTargets ?? []).length === 0;
    if (!allUsers || !noneExcluded) narrowed.push(config.id);
  }
  return narrowed;
}

/**
 * Builds the gate from loadLockoutGateInputs()'s result (or the same shape in a
 * test): `accounts` are the registered accounts before evaluation, `inventory`
 * the newest covered collections, `groupMembers` the membership lookup.
 */
export function breakGlassLockoutGate({ configured = true, accounts = [], inventory = {}, groupMembers = () => null, now = new Date() } = {}) {
  return Object.freeze({
    evaluate({ resourceType, desired }) {
      if (!configured) return { allowed: false, reason: 'break-glass accounts are not configured for this tenant' };
      const narrowed = narrowedTargets(inventory, { resourceType, desired });
      if (narrowed.length > 0) {
        return { allowed: false, reason: `the proposed policy changes who may use ${narrowed.join(', ')} to less than every user, so break-glass access cannot be shown to survive it` };
      }
      const proposed = proposedInventory(inventory, { resourceType, desired });
      const evaluated = accounts.map((account) => ({ ...account, ...evaluateAccountReadiness({ account, inventory: proposed, groupMembers, now }) }));
      const verdict = tenantReadiness(evaluated);
      if (verdict.overall === 'ready') return { allowed: true, reason: 'every break-glass account stays ready under the proposed policy' };
      const blocking = evaluated
        .filter((account) => account.overall !== 'ready')
        .map((account) => `${account.label ?? account.accountId}: ${Object.entries(account.dimensions ?? {})
          .filter(([, dimension]) => dimension.status !== 'pass')
          .map(([name, dimension]) => `${name} ${dimension.status} (${dimension.reason})`).join(', ')}`);
      return {
        allowed: false,
        reason: `break-glass readiness is ${verdict.overall} under the proposed policy (${verdict.reason})${blocking.length ? `; ${blocking.join('; ')}` : ''}`,
      };
    },
  });
}

/** A gate that refuses everything, for callers that could not load the inputs. */
export function closedLockoutGate(reason) {
  return Object.freeze({ evaluate: () => ({ allowed: false, reason }) });
}
