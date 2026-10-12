# Content-effect guard: a writable type must be reviewed (2026-10-12)

Live gate Q43, step 25: creating an Intune device configuration profile was refused with
`unclassified-content-effect: internetSharingBlocked, sharedUserAppDataAllowed`. Neither field
touches content. The guard's field-name heuristic (`shar(e|ing)`, `wipe`, ...) runs on every type
without a reviewed rule set, and on a create every field counts as changed, so the first live
create of an unreviewed type is refused by its field names.

| Mistake | Rule now |
| --- | --- |
| Intune restore (#155) made `deviceCompliancePolicy`, `deviceConfiguration` and `configurationPolicy` writable without an entry in `CONTENT_EFFECT_RULES`. | Every type that gains a write capability gets a reviewed entry in `engine/safety/contentEffects.mjs` in the same PR, with its real content effects as rules and a comment naming the fields reviewed and found benign. |
| The type's fixtures were tested only through `applyWave`, which never runs the guard, so the refusal appeared live. | A new writable type adds a `classifyContentEffects` case to `engine/roadmap/content-effects.test.mjs` with a create and an update of its real fixture payload. |
| "Creates are benign" was applied to a policy whose effect lands on devices, not on the object. | A type whose effects reach content outside the object (devices) sets `judgesCreates: true`; its rules run on creates against an empty before. |
