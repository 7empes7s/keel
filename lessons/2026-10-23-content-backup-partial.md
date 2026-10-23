# The partial rule reached settings backups but not content backups (2026-10-23)

The first whole-tenant content backup (operator queue Q121) saved 36.7 GB and every
workload finished, yet the job read "Failed, exit code 1". Only 10 OneDrives locked
by Microsoft (HTTP 423), one group mailbox (403) and one site page (404) were not
read. The fix for settings backups (#447, the lesson of 2026-10-22) had covered
`keel-collect` only.

| Mistake | Rule now |
| --- | --- |
| A fix for "partial is not failed" covered one job kind and left the other backup job with the same exit-1 rule. | When a job's outcome rule changes, search every job kind that writes a backup (`collect`, `backup`, `workload-collect`, `content-collect`) and apply it to each, or open a thread for the rest. |
| `keel-content-collect` exited 1 when any workload was partial. | Exit 3 when no workload failed and some are partial, with one `incomplete types:` line naming each workload and its unread items. Any failed workload still exits 1. |
| The Job page showed one 500-character error line per workload. | It lists each mailbox, OneDrive or site not read, with a plain cause; the raw error waits behind a click. |
