# The same slow query shape lived in a second name lookup (2026-11-04)

PR #949 fixed the Changes feed's name lookup (`engine/insights/names.mjs`), which read every
saved version of each id to find the newest one. The Alerts page names its settings with a
second lookup, `savedNames` (`portal/lib/saved-names.ts`), which had the same shape:
`DISTINCT ON (natural_key) ... ORDER BY ..., started_at DESC` over every version. After #949
deployed it led the Alerts page at 9.2 s on live (operator queue Q307).

| Mistake | Rule now |
| --- | --- |
| A slow query shape was fixed in one file only. | When you fix a slow shape, search the repo for the same shape (`DISTINCT ON (...natural_key)` over `resource_version`, or `min()`/`max()` over every later backup) and fix or list each use in the PR. |
| `min(started_at)` over every later backup checked each one's coverage for every key. | Use `ORDER BY started_at LIMIT 1` when only the first match is wanted, so the scan stops at it. |
