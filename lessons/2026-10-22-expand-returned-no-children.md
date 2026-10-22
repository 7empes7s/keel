# An $expand returned no children, and the backup looked complete (2026-10-22)

The administrative template backup (#472) read each template with
`$expand=definitionValues($expand=definition)`. Graph answered 200 with
`definitionValues: []` for templates that had settings, so the read counted as
`complete` while holding nothing, and a restore would have removed every
setting. The settings only come back from `/{id}/definitionValues`. This is the
same gap as #470 (a list read that leaves a field out), one level down.

| Mistake | Rule now |
| --- | --- |
| A nested collection was read through `$expand` without checking a live answer against the collection's own route. | Read a child collection from its own route (`itemReads`/`childReads`) unless a live proof shows the `$expand` returns the same items. |
| A restore trusted an empty list in the backup. | When a backup shape is known to hide children, refuse a write from it instead of writing "no children" over the target. |
