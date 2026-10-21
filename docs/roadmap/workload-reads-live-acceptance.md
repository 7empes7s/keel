# Wave 2 read live capture (`workload-reads-live-acceptance`)

The Wave 2 cmdlet workloads (mail flow, Exchange settings, Teams org-wide and voice
policies, Purview retention and DLP, retention labels) read nothing until each core read is
live-qualified in the task-101 ledger. The scheduled `workload-collect` job rebuilds that
ledger only from signed records that `keel-workload-collect.mjs import` stores, and until
this gate no record carried these reads. `tools/qualification/workloadReadsLive.mjs` takes
that proof, one record per workload.

## What a capture does

- Runs the workload's own collector once with the **collector** credential, through the
  bounded cmdlet job and the production allowlists. Only the workload's declared `Get-`
  cmdlets are sent. Nothing is written to the tenant.
- Records, per read: its operation, family, status, object count and module version, plus
  the error code when it failed. No object, value, name, tenant id or error message is kept.
  The operator output prints each failed read's message for diagnosis.
- A read is proof only when its family answered in full (`read`); an empty answer counts.
  A failed, denied or not-licensed read is not proof, and a workload whose core read failed
  stays off.

The import seam stores one live capture per read that answered, bound to the module version
the PowerShell image pins. It leaves the collector's grants as the other records stored them,
so a read that needs a role the collector lacks (eDiscovery Manager, Teams Administrator)
stays `pending-prerequisite`.

## Operator steps

```bash
# Offline preview: the cmdlets a capture would send.
node tools/qualification/workloadReadsLive.mjs plan --workload exchange-mail-flow

# One capture per workload, with the config the scheduled job uses for it
# (workload-scope.json powershellConfigs: exchange for the two Exchange workloads,
# purview for the two Purview ones, teams for the two Teams ones).
KEEL_QUALIFICATION_HMAC_KEY=... node tools/qualification/workloadReadsLive.mjs capture \
  --workload exchange-mail-flow --tenant-ref sha256:... --collector-ref app:<collector app id> \
  --collector-config /etc/keel/exchange-collector.json --build "$(git -C /opt/keel-live rev-parse HEAD)" \
  --out docs/release/qualifications/workload-reads-exchange-mail-flow-live-acceptance.json

# Store the proof, then run the scheduled job once by hand.
KEEL_QUALIFICATION_HMAC_KEY=... node cli/keel-workload-collect.mjs import
node cli/keel-workload-collect.mjs run
```

Exit codes: `capture` 0 when the record verifies, 1 when it does not, 2 on a refused
argument (nothing sent). The proof lapses after 30 days, like the other workload proof;
`keel-workload-collect.mjs proof` lists when.
