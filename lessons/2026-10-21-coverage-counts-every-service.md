# A coverage or change count reads every service, not only `types` (2026-10-21)

The engine's coverage report keeps the Entra ID and Intune kinds in `report.types` and the
Microsoft 365 service settings reads in `report.workloads`. Changes live in two tables too:
`drift` (approved-setup changes, Entra ID and Intune) and `workload_drift` (service setting
changes). Three pages in a row counted only the first half, so they showed Entra ID and
Intune alone: What's protected (#397), Changes (#400) and the Overview (this fix).

| Mistake | Rule now |
| --- | --- |
| A page counted `report.types` and `report.summary` only. | Count `getCoverageData().workloads` too, the way What's protected does (`withWorkloadKinds`, `withWorkloadCoverage`). |
| A page counted the `drift` table only. | Add `loadServiceChanges` (lib/service-changes.ts) beside it. |
| A list of job kinds named `collect` but not `workload-collect` or `content-collect`. | Name all three backup job kinds wherever backups are listed. |
