# Nested method fields skipped the trust-field check

The authentication methods policy writer checked its record's top-level fields
against `TRUST_FIELDS`, but the per-method allowlist
(`METHOD_CONFIGURATION_FIELDS`) was never checked. The certificate-based
authentication method listed `certificateUserBindings` and
`authenticationModeConfiguration`, so a restore could PATCH which certificate
field names a user and whether a certificate sign-in counts as MFA. This is the
third time the "restores never send trust, certificate or sign-in fields" rule
was nearly missed (lessons of 2026-10-21 and the connector and named location
lessons of 2026-10-28). Issue #994.

Rule: every list of fields a writer may send goes through the same trust check,
including lists nested under a record (method configurations, child objects,
settings blocks). Build such a list with a function that throws on a trust
field (`checkedMethodFields`), never as a plain literal. A trust field that
differs is a step for a person that shows backup and live values. Prove it with
a test that fails when the check is reverted.
