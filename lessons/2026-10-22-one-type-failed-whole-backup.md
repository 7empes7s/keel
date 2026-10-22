# One unreadable type marked every hourly backup Failed (2026-10-22)

After #452 let drift run past a failed type, the hourly backup still showed
"Failed, exit code 1" for 7+ hours on the portal. Every other type was saved;
only `deviceManagementSettings` (#447) answered HTTP 400. The person saw a wall
of red and no hint of which type was missing.

| Mistake | Rule now |
| --- | --- |
| `keel-collect` exited 1 for any failed or partial type, so the job read as a whole-run failure. | Exit 3 when the snapshot holds at least one fully read type and some types are not; print one `incomplete types:` line. Exit 1 only when nothing was read in full or the run crashed. |
| The worker treated every non-zero exit as a failure. | `collect` and `backup` jobs with exit 3 and a readable list finish with `result.partial` and `result.incompleteTypes`; without the list they still fail. |
| A partial backup had no words on the portal. | It shows "Partly done" (amber) and names each missing type. Health (`fullCoverage`) still fails until every type reads in full. |
