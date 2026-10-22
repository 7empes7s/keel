# Deploys drain the worker instead of restarting it (2026-10-22)

The first whole-tenant content backup (Q101) ran for seven minutes, then an auto-deploy ran
`systemctl try-restart keel-worker`. SIGTERM made the worker terminate the running job, the job
failed, and the scope was rolled back. Content backups and restores run for hours, and master
deploys many times a day, so any restart during the night window kills them (issue #448).

| Mistake | Rule now |
| --- | --- |
| The deploy restarted `keel-worker` (SIGTERM ends the running job). | The deploy runs `systemctl try-reload-or-restart keel-worker`. Reload sends SIGUSR2: the running job finishes, nothing new is claimed, the worker exits 0 and systemd starts it on the new tree. |
| Nothing tested how the worker leaves. | `cli/keel-worker-drain.test.mjs` checks drain vs stop, and that the unit maps reload to SIGUSR2. |
