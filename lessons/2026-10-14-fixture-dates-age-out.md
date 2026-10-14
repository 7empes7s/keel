# A fixture inside a time window must be dated relative to now (2026-10-14)

Found when master went red with no code change: `portal/test/schedules.test.ts` inserted its failed tier 1
run at a fixed `2026-09-29T10:00:00Z`. The load forecast it checks reads only the last 14 days, so on
2026-10-13 that run left the window, `unmeasuredRuns` dropped from 1 to 0, and every PR's Portal check failed.

| Mistake | Rule now |
| --- | --- |
| A test fixture that a time-windowed reader must see was given a fixed calendar date. | A fixture a windowed query must include is dated from `Date.now()` (for example, 6 hours ago), and the test asserts against that value, not a literal. |
| The failure appeared on unrelated PRs and looked like their bug. | When a PR's check fails in code it does not touch, run the same test on `master` first; a red `master` means fix `master`, on its own branch. |
