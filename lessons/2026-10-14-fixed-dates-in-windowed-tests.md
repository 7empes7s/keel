# A fixed date in a test expires when the code reads a time window

On 2026-10-14 the portal suite turned red on every branch with no code change: `portal/test/schedules.test.ts`
inserted a failed run at `2026-09-29`, and the load forecast only counts runs from the last 14 days. Once the date
fell out of the window, the forecast stopped counting it.

| Mistake | Rule now |
| --- | --- |
| A fixture timestamp hard-coded to a calendar date, read by code that filters "the last N days" | Any fixture time the code compares with `now()` is built relative to `Date.now()`; assertions use the same value |
