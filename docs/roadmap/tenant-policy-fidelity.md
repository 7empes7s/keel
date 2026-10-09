# Tenant-wide Entra security policy restore (roadmap task-149)

## Status — 2026-10-09

Implemented and fixture-tested. **Nothing here is live-qualified.** Every claim
below is `fixture-tested`: the production `applyWave()` writer and read-back
verification ran against an in-memory fake Graph. Live qualification follows
the operator gate in issue #148.

## What changed

### Two new catalogue types (54 in total)

| Type | Read | Why it was missing |
| --- | --- | --- |
| `identitySecurityDefaultsEnforcementPolicy` | `GET /policies/identitySecurityDefaultsEnforcementPolicy` | Only the restore sign-in path gate read it; it was never backed up. |
| `crossTenantAccessPolicyConfigurationDefault` | `GET /policies/crossTenantAccessPolicy/default` | The root `crossTenantAccessPolicy` object does not carry the default B2B and inbound-trust settings. |

Both are tenant singletons with a constant natural key. The constant keys (and
the partner `tenantId` key) now live in `naturalKeyFor()`, so a live object read
by the reconciliation plan gets the same key as its snapshot.

### Operation records (`engine/restore/tenantPolicyOperations.mjs`)

| Type | Operation | Route | Writes | Lockout gate | Permission |
| --- | --- | --- | --- | --- | --- |
| authorizationPolicy | update | `PATCH /policies/authorizationPolicy` | guest invitations, SSPR, email sign-up, risky-app consent, MSOnline PowerShell, default user permissions, guest role | yes | Policy.ReadWrite.Authorization |
| authenticationMethodsPolicy | update | `PATCH /policies/authenticationMethodsPolicy` and `PATCH .../authenticationMethodConfigurations/{id}` | registration campaign, suspicious-activity reporting, system-preferred MFA, each method's configuration | yes | Policy.ReadWrite.AuthenticationMethod |
| identitySecurityDefaultsEnforcementPolicy | update | `PATCH /policies/identitySecurityDefaultsEnforcementPolicy` | `isEnabled` | yes | Policy.ReadWrite.SecurityDefaults |
| crossTenantAccessPolicy | update | `PATCH /policies/crossTenantAccessPolicy` | `allowedCloudEndpoints` | no | Policy.ReadWrite.CrossTenantAccess |
| crossTenantAccessPolicyConfigurationDefault | update | `PATCH /policies/crossTenantAccessPolicy/default` | B2B collaboration and direct connect in/out, inbound trust, automatic consent, tenant restrictions, redemption order | no | Policy.ReadWrite.CrossTenantAccess |
| crossTenantAccessPolicyPartner | create | `POST /policies/crossTenantAccessPolicy/partners` | `tenantId` plus the partner settings | no | Policy.ReadWrite.CrossTenantAccess |
| crossTenantAccessPolicyPartner | update | `PATCH /policies/crossTenantAccessPolicy/partners/{tenantId}` | the partner settings | no | Policy.ReadWrite.CrossTenantAccess |
| adminConsentRequestPolicy | update | `PUT /policies/adminConsentRequestPolicy` | every writable field (PUT replaces) | no | Policy.ReadWrite.ConsentRequest |

Proof for all eight: `engine/roadmap/tenant-policy-fidelity.test.mjs`. None of
the permissions is verified as granted to the KEEL Restorer.

Rules every record follows:

- **Allowlist only.** A body is built from the record's writable fields, never
  from the snapshot payload. A PATCH carries only fields whose value differs
  from the live one; a PUT carries every writable field.
- **Method configurations** are written one PATCH each, with the `@odata.type`
  Graph requires restored from a fixed table. A method id outside the table, or
  one missing from the live policy, is refused before any write.
- **Read-back.** After the writes the policy is read once; every written field
  and method configuration must match, comparing order- and null-insensitively.
- **No remapping.** A reference rewritten to a different id (another tenant) is
  refused as `unqualified-remapping`. The admin consent reviewer queries are
  written as observed.
- **No create or delete of a singleton**, and no partner delete.

### The break-glass lockout gate (`engine/safety/lockoutGate.mjs`)

The authentication methods policy, security defaults and the authorization
policy can lock every user out. They are written only when the caller supplies
a lockout gate that allows the write; without one they are **skipped**, not
written.

The gate re-runs task-94's break-glass readiness. Every registered break-glass
account must be `ready` (cloud-only identity, phishing-resistant credential,
excluded from enforced Conditional Access, active Global Administrator,
recently validated) and there must be at least two. For the authentication
methods policy the **proposed** method configurations replace the collected
ones first, so a restore that would switch off the method a break-glass account
relies on is withheld. `unknown` evidence is never `ready`.

`cli/keel-restore.mjs` loads the gate from the database only when such a write
is planned (`lockoutGateFor`). If the readiness inputs cannot be read the gate
refuses every lockout-sensitive write.

### Sign-in path gate

The restore sign-in path gate fails a run when the authentication methods
policy or security defaults change. A tenant policy write that read back
exactly as intended now reports its section, and only that section is left out
of the closing comparison. A change to Conditional Access, a protected account
or its role assignments still fails the run.

## Still not restorable

- `permissionGrantPolicy`: built-in policies are immutable, and the includes
  and excludes of a custom policy are separate collections with no qualified
  writer. It stays research-needed.
- Partner delete, and the identity synchronization settings of a partner.
