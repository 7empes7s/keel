# A JS Date is millisecond precision; Postgres now() is microsecond precision

On 2026-10-15 master's Portal CI went red (#307): `audit-ingestion.test.mjs` failed with "not authorized for
audit ingestion". The fixture granted a role (`active_from` defaults to Postgres `now()`, e.g. `.411537`) and the
check ran `can(..., at = new Date())` in the same millisecond (`.411`). `.411 < .411537`, so the grant read as
not yet active. Locally 749 of 2000 grant-then-check pairs failed this way.

| Mistake | Rule now |
| --- | --- |
| Comparing a JS `Date` parameter with a Postgres timestamp written by `now()` | Compare at millisecond precision (`date_trunc('milliseconds', col)`), or let SQL use `now()` on both sides |
