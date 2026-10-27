# Changes listed with nothing changed (2026-10-27)

Live check K10 found Ask listing 51 role assignment schedules and 12 app consent
policies as "modified" with no changed fields. On 2026-10-15 one field of each type was
classified as set by Microsoft (#288 `scheduleInfo.startDateTime`, #294 the rule `id`s).
Baselines captured before that kept hashes that still counted the field. The next drift
detection compared an old hash with a new one and recorded a change for every one of
those objects, though their content was the same. This is the second time a stored hash
outlived its rules: Q48 (`organization.directorySizeQuota`) hit the same thing in the
restore dry run.

| Mistake | Rule now |
| --- | --- |
| Drift detection treated unequal stored hashes as a change. A hash records the field rules of the day it was stored. | Where both payloads are stored, decide "changed" with `sameContent` (`engine/cir/canonicalHash.mjs`), which hashes both again under today's rules. Never compare a stored hash alone with a newer one. |
| A field rule changed with no step for rows already recorded under the old rule. | Rows already recorded are kept and marked (`drift.same_content`); every list of changes uses `RECORDED_CHANGE_PREDICATE` or `OPEN_DRIFT_PREDICATE` (`engine/store/openDrift.mjs`). A new list of changes must use one of them. |
