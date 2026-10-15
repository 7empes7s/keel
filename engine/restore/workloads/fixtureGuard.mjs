/**
 * Issue #317: on the test tenant a workload restore writes only to KEEL-RT- fixtures,
 * the same rule content restores keep (content/restore/gate.mjs#targetProblems).
 *
 * Qualification is per operation, not per object, so once a capture on a KEEL-RT-
 * fixture enables an operation, nothing else would stop it writing a Global policy,
 * a connector or a DLP policy. This guard runs at plan time and again before each write.
 *  - Off the test tenant it does nothing: a customer restore is not limited to fixtures.
 *  - A target is a fixture when one of its names starts with KEEL-RT- (case-insensitive).
 *    Matching is on the prefix only, never an exact name.
 *  - A tenant-wide object (a Global policy, a tenant configuration, a default policy)
 *    cannot carry a fixture name. It is refused unless the plan was made with the
 *    separate tenant-wide option, which is off by default and which the operator's
 *    standing approval does not cover (govern/approvalPolicy.mjs).
 */
import { TEST_FIXTURE_PREFIX } from '../../content/restore/gate.mjs';
import { TEST_TENANT_REFS } from '../../govern/approvalPolicy.mjs';

export { TEST_FIXTURE_PREFIX, TEST_TENANT_REFS };
export const TENANT_WIDE_OPTION = '--allow-tenant-wide-test-writes';

export function onTestTenant(tenantRef, testTenantRefs = TEST_TENANT_REFS) {
  if (!Array.isArray(testTenantRefs)) throw new TypeError('the fixture guard needs the test tenant list');
  if (typeof tenantRef !== 'string' || !tenantRef) throw new TypeError('the fixture guard needs the tenant');
  return testTenantRefs.includes(tenantRef);
}

export function isFixtureName(name) {
  return typeof name === 'string' && name.toUpperCase().startsWith(TEST_FIXTURE_PREFIX.toUpperCase());
}

/**
 * Why this target may not be written, or null. `names` are the names the target is
 * known by; every one given must be a fixture name, and there must be at least one.
 */
export function fixtureProblem({ tenantRef, testTenantRefs = TEST_TENANT_REFS, label, names = [], tenantWide = false, allowTenantWide = false }) {
  if (!onTestTenant(tenantRef, testTenantRefs)) return null;
  if (tenantWide) {
    return allowTenantWide ? null
      : `on the test tenant KEEL writes only ${TEST_FIXTURE_PREFIX} fixtures; ${label} is tenant-wide and needs a dry run made with ${TENANT_WIDE_OPTION}`;
  }
  const named = names.filter((name) => typeof name === 'string' && name);
  if (named.length && named.every(isFixtureName)) return null;
  return `on the test tenant KEEL writes only ${TEST_FIXTURE_PREFIX} fixtures; ${label} (${named.join(', ') || 'no name'}) is not one`;
}
