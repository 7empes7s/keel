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
so a read that needs a role the collector lacks (Teams Administrator, Power Platform Administrator)
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

## Admin REST workloads (Power Platform)

`--workload power-platform-settings` reads the Power Platform and Fabric admin APIs, not
PowerShell. The capture runs `readPowerPlatform` through its own read-only transport
(`readOnlyPowerPlatformTransport`: GETs of the declared request shapes only), with the
collector's certificate config, the same `/etc/keel/tenant.json` the scheduled job uses.
There is no module version: the record's `execution` is `{ "transport": "rest-read-only" }`
and each read carries the API version its operation is declared at in
`engine/collect/workloadContract.mjs`, which is the version the ledger checks. A record that
names a PowerShell module, or a read at another API version, fails the gate.
`--powershell-image` and `--site` are refused for it.

```bash
node tools/qualification/workloadReadsLive.mjs plan --workload power-platform-settings
KEEL_QUALIFICATION_HMAC_KEY=... node tools/qualification/workloadReadsLive.mjs capture \
  --workload power-platform-settings --tenant-ref sha256:... --collector-ref app:<collector app id> \
  --collector-config /etc/keel/tenant.json --build "$(git -C /opt/keel-live rev-parse HEAD)" \
  --out docs/release/qualifications/workload-reads-power-platform-settings-live-acceptance.json
```

A refused read is recorded as `HTTP <status>` and is not proof; only that family stays off.

`--workload defender-endpoint-indicators` works the same way: one GET of
`https://api.security.microsoft.com/api/indicators?$top=10000` through
`readOnlyDefenderIndicatorsTransport`, with a token for the legacy audience
`https://api.securitycenter.microsoft.com/`. The collector needs the WindowsDefenderATP
application permission `Ti.Read.All`; without it the read answers 403 and the ledger names that step.

Exit codes: `capture` 0 when the record verifies, 1 when it does not, 2 on a refused
argument (nothing sent). The proof lapses after 30 days, like the other workload proof;
`keel-workload-collect.mjs proof` lists when.
