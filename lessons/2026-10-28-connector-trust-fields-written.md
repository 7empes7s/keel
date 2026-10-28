# Restore writers sent connector trust and certificate fields (2026-10-28)

The rule "a restore writer never sends trust, federation, certificate or sign-in endpoint
fields" was missed a third time. The Exchange inbound connector writer declared
`TlsSenderCertificateName`, `RestrictDomainsToCertificate`, `RequireTls`,
`TreatMessagesAsInternal`, `TrustedOrganizations`, `SenderIPAddresses`,
`RestrictDomainsToIPAddresses` and `EFSkipIPs` as writable, and `run-cmdlet.ps1` allowed
them. The outbound connector writer did the same with `TlsSettings` and `TlsDomain`.
A backup that differed from live (a planted value, or one from before a partner
certificate rotation) would make the connector trust another certificate or IP range,
or treat outside mail as internal, as an ordinary restore. A security audit found it.

| Mistake | Rule now |
| --- | --- |
| The rule lived only in CLAUDE.md, so each new writer had to remember it. | `writeDeclarations.mjs` has `TRUST_FIELDS` and `TRUST_FIELD_PATTERN`; `declare()` throws at load if a write declares one. |
| A field was declared writable because Microsoft's `Set-` cmdlet takes it. | A trust, certificate, sender-IP or sign-in field is never declared. A difference becomes a manual entry (`trust: true`) that tells an administrator where to set it. |
| Only the identity writer (federation) had a regression test for this. | `workload-writers.test.mjs` plans and runs a restore whose backup differs in every connector trust field and checks nothing but the harmless field is sent. A new writer adds its resource type to `TRUST_FIELDS` and the same kind of test. |
