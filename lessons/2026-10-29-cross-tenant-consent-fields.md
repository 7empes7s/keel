# Entra writers sent cross-tenant consent and guest domain fields (2026-10-29)

The trust-field rule (`TRUST_FIELDS` and `isTrustField` in `writeDeclarations.mjs`) was only
checked by the Exchange and Teams writers (`declare()`). The Entra record writers
(`defineRecord()`) did not use it, so two of them sent fields that decide which outside
tenants and domains are trusted:

- the multitenant organization partner template sent `automaticUserConsentSettings`
  (invitations skip the consent prompt) and the four `b2bCollaboration*` and
  `b2bDirectConnect*` lists (which partner users and apps get in, and where ours go);
- `b2bManagementPolicy` sent its `definition`, the guest invitation allow and block lists.

A reviewer of the stranded live evidence (PR #690) spotted it.

| Mistake | Rule now |
| --- | --- |
| The trust rule was enforced for one family of writers only. | `defineRecord()` checks `writable` and `createOnly` with `isTrustField` and throws at load, as `declare()` does. |
| Only `inboundTrust` was treated as trust on cross-tenant settings. | Consent suppression and the B2B access lists are trust too: they decide who from another tenant reaches this one. They are in `TRUST_FIELDS`, and a difference is a `crossTenantAccess` manual step. |
| A domain allow or block list was written because it looked like plain settings. | Domain lists that decide who can come in are trust fields, like the Teams federation domain lists. `b2bManagementPolicy` is now a manual kind with no writer. |

Follow-up the same day: the tenant default and partner writers (`tenantPolicyOperations.mjs`,
`CROSS_TENANT_SETTINGS`) still sent the same consent and B2B fields. The fix had covered one
writer of the setting, not every writer of it.

| Mistake | Rule now |
| --- | --- |
| A trust field was gated on one resource type while two other types carry the same field. | `CROSS_TENANT_TRUST_FIELDS` is shared by the template, the default and the partner in `TRUST_FIELDS`. The tenant policy `record()` throws at load when a record lists one of its type's trust fields. When a field is made a trust field, search every writer for it. |
