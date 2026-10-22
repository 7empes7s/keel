# One new kind blocked drift detection for the whole tenant (2026-10-22)

Two nights in a row a single collect type failed every hourly collect: first the
Exchange role kinds (#438), then `deviceManagementSettings` (#447), whose `$select`
named fields Graph serves from another Intune backend, so the read got HTTP 400.
Because drift detection waited for every type to read in full, no drift ran for
hours although every other type read fine.

| Mistake | Rule now |
| --- | --- |
| A `$select` on the `/deviceManagement` singleton mixed core fields with fields from other Intune services. | Select only fields of the core Intune object; read anything else from its own route, as its own type. |
| One failed type deferred drift detection for the tenant. | Drift runs when at least one type read in full and compares only fully read types (`snapshotReadyForDrift`). Health still reports the failed type. |
