# Tenant-wide settings bypassed the test tenant guard (2026-10-29)

The vps-deployer review of #673 found five admin center settings written through the
record writer with no test tenant fixture guard; #675 gated those five. The same gap held
for every other one-per-tenant record: the Entra governance, guest and cross-tenant
settings, the SharePoint tenant settings, the guest domain policy and the batch 17 Intune
tenant settings. The workload writers had the guard (`fixtureGuard.mjs`), but the record
writer only got it when someone remembered to mark a record.

| Mistake | Rule now |
| --- | --- |
| A tenant-wide record was gated only if its author marked it. | Every record marked `singleton` must also be `tenantWide` (`engine/restore/tenantWideRecords.test.mjs` fails otherwise). A kind that is tenant-wide for some objects only (the default branding profile) marks it with a function of the resource. |
| The batch 17 live proofs had no way to pass the tenant-wide option to a Graph restore. | `keel-restore --snapshot-id ... --allow-tenant-wide-test-writes` (test tenant only) records the option in the dry run, binds it into the digest, and the promotion uses it. The live gate plan adds the flag for every tenant-wide record. |
