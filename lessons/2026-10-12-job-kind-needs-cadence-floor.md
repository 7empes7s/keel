# A new scheduled job kind needs its cadence floor

Date: 2026-10-12. Scope: scheduler (`engine/schedules/cadence.mjs`, `cli/keel-scheduler.mjs`).

## What happened

`api-drift` was added to the job schema, the capability map, the worker and the
schedule seed (weekly), but not to `MINIMUM_INTERVAL_MS`. The scheduler refused the
seeded row as "not schedulable" and, because the tick ran every due row in one
transaction, the whole tick rolled back: nothing scheduled ran. The test that would
have caught it (`cli/keel-scheduler.test.mjs`) was excluded from CI for unrelated
path assumptions (`cwd: '/opt/keel'`), so the gap stayed hidden.

| Mistake | Rule now |
| --- | --- |
| New job kind seeded without a cadence floor | Every kind in `scheduleSeed.mjs` has an entry in `MINIMUM_INTERVAL_MS`; `cli/keel-scheduler.test.mjs` seeds all kinds and ticks them. |
| One bad schedule row rolled back every other due row | The tick skips and reports an invalid row, and commits the rest. |
| Test excluded from CI for host paths, then never looked at | Tests run child commands from the repo root, not a host path; an excluded test is fixed, not left. |
