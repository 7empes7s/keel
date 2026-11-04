# A newest-first walk is only cheap when the answer is near the top (2026-11-04)

PR #957 made the Alerts page's two name reads walk a tenant's backups newest first and stop at
the first that holds each key. On live it was still 1.2–1.9 s per read (operator queue Q313):
a local copy where every backup held every kind hid two long walks.

| Mistake | Rule now |
| --- | --- |
| The local copy had one kind of backup, so every walk stopped at the first backup. Live has hourly, daily and weekly backups, so a weekly kind's walk probed up to a week of hourly backups first. | Build the local copy with the live backup tiers (hourly, daily, weekly, as separate backups) before measuring a walk over backups. |
| "No version has a name, look at older ones" walked every backup for kinds that never carry a name (app consent, role assignments, owners), reading each version. | Bound every walk: probe the newest few backups, then read the key's own versions (`newestBackupWithKeySql`), and ask an index first whether there is anything to find (`resource_version_named_key_idx`). |
