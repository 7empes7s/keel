# A fixture inside a rolling time window must be dated relative to now (2026-10-14)

Found while upgrading Next.js: `portal/test/schedules.test.ts` (task-110 forecast test) started failing on every branch
on 2026-10-13. Its setup inserts a failed collect run dated `2026-09-29`, and the forecast only counts runs from the last
14 days, so the run silently aged out of the window and `unmeasuredRuns` dropped from 1 to 0. Master CI was green only
because it last ran on 2026-10-12.

| Mistake | Rule now |
| --- | --- |
| A test row that a time-windowed query must see had a fixed calendar date. | Rows a "last N days" query must count are dated relative to `now()`. Fixed dates are only for values the test asserts verbatim. The task-110 test now moves the failed run to four hours ago before reading the forecast. |
| A test passed on the day it was written and nobody checked when it would stop passing. | When a fixture date meets a window, check the test still passes with the clock moved forward past the window. |
