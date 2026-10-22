# A re-run after a create planned the create again (2026-10-22)

The operator restored a deleted `KEEL-RT-branding` Company Portal profile (Q123),
then ran a second dry run from the same snapshot. It planned a full create again.
Enforcing it would have made a duplicate (#485). The same happened to a reusable
settings group in Q135.

| Mistake | Rule now |
| --- | --- |
| Kinds keyed by id lose their key on a create: Microsoft gives the new object a new id, so the backup's key matches nothing live. | Planning reads the journal's creates for the target tenant (`loadCreatedTargetIds`) and maps each backup key to the id its create recorded. A create that recorded no id adopts the one live object of that kind with the backup's name, never one of two. |
| Earlier gates checked "re-run plans 0 writes" with a snapshot taken after the create, which already held the new id. | A re-run check after a create uses the same snapshot the create came from. |
