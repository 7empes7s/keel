# A list read left out the field a create needs (2026-10-22)

The reusable settings group backup (#470) held only the group's name. Graph's
list read leaves `settingInstance` out unless it is selected, so a restore
create was refused (400, "empty setting instances"). The same type also has no
PATCH route; only a full PUT works. Scripts (batch 4), policy sets and settings
catalog compliance policies hit the same gap earlier.

| Mistake | Rule now |
| --- | --- |
| A writer was added for a type without checking that the backup holds every field its create needs. | Before a writer ships, compare a real backup payload with the documented create body. Select or read per item whatever the list leaves out, and refuse a write from a backup that lacks it. |
| The update method was assumed to be PATCH. | Take the update method from a live proof, not from the docs page alone. |
