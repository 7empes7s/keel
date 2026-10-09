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
 * method a break-glass account relies on is withheld.
 *
 * The gate is pure over its inputs and never calls Microsoft. `unknown` is
 * never `ready`: missing evidence withholds the write.
 */
import { evaluateAccountReadiness, tenantReadiness } from './breakGlassReadiness.mjs';

function proposedInventory(inventory, { resourceType, desired }) {
  if (resourceType !== 'authenticationMethodsPolicy') return inventory;
  const current = inventory.authenticationMethodsPolicy;
  if (!current || current.status !== 'covered' || !current.resources.length) return inventory;
  const [policy, ...rest] = current.resources;
  const merged = { ...policy.payload, ...desired };
  return { ...inventory, authenticationMethodsPolicy: { ...current, resources: [{ ...policy, payload: merged }, ...rest] } };
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
