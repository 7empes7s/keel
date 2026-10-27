# Exchange and Purview connected with a config that names no organization (2026-10-22)

Exchange Online and Security & Compliance refuse a certificate sign-in without an
`organization` ("Organization cannot be null for certificate based connections").
The workload collect already used each family's own file (`powershellConfigs` in
`/etc/keel/workload-scope.json`), but three other paths still used the Graph files
(`tenant.json`, `restorer.json`), which have none:

- the purview-labels read in Q99,
- the Discovery cmdlet listing in Q146,
- the restore dry run and promotion in Q149 (#542), so no Exchange or Purview undo could run.

| Mistake | Rule now |
| --- | --- |
| Each caller picked its PowerShell config on its own, and only the collect used the family files. | Every PowerShell connection gets its config from `engine/collect/workloads/powershellConfigs.mjs`: the collector file from `powershellConfigs`, the restorer file from `powershellRestorerConfigs` or the collector file's `-restorer.json` sibling. A new caller uses it too. |
