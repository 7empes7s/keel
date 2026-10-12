# References that cannot exist in the target are never required dependencies

Date: 2026-10-12. Scope: restore planning (`engine/graph`, `engine/restore`).

## What happened

On the live test tenant three updates could not be planned. The planner treats
every unresolved reference as fatal, and three references can never resolve in
a target tenant:

- `application.createdByAppId` is read-only: it names the app that created the
  object and is never written.
- `crossTenantAccessPolicyPartner.tenantId` is the partner's own tenant. It is
  foreign by definition and must be written verbatim.
- `deviceCompliancePolicy.scheduledActionsForRule[].scheduledActionConfigurations[].id`
  is an Intune child id, assigned by the service on every create. It was
  already marked server-owned but was still extracted as a reference.

The collector classed the first two correctly (`readOnly:`, `foreignTenant:`)
and the resolver still looked them up in the target, where they never are.

## Rule

A reference whose value cannot exist in the target tenant is not a dependency:

1. `readOnly:` and `foreignTenant:` symbols resolve verbatim, like `global:`.
   They never gate a wave, never pull a resource into a selection closure and
   never count as unresolved (`isVerbatimSymbol` in `engine/graph/resolver.mjs`).
2. A reference in a server-owned field (`fieldClass(...) === 'serverOwned'`) is
   skipped by `resolvePlan` and `rewriteReferences`: no write carries the field,
   so it cannot dangle.
3. A child id the service assigns belongs in `CHILD_IDENTITY_FIELDS`
   (`tools/tenant-probe/references.mjs`), so it is identity, not a reference.

When a new type's restore is blocked by "not resolvable", check these three
classes before adding a lookup. Proof: `engine/restore/unresolvableReferences.test.mjs`.
