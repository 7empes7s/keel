# KEEL backup timers

The tiered backup units are deliberately not installed or started by the build. An operator may
install and enable them after confirming the Collector registration and `/etc/keel/db.env` are
configured for the intended tenant:

```sh
sudo install -m 0644 ops/keel-backup-tier1.service ops/keel-backup-tier1.timer /etc/systemd/system/
sudo install -m 0644 ops/keel-backup-tier2.service ops/keel-backup-tier2.timer /etc/systemd/system/
sudo install -m 0644 ops/keel-backup-tier3.service ops/keel-backup-tier3.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now keel-backup-tier1.timer keel-backup-tier2.timer keel-backup-tier3.timer
```

## KEEL status dashboard

`keel-status-generate.timer` runs `status/generate.mjs` every 60s, publishing
`status/out/index.html` (served by Caddy at keel.techinsiderbytes.com). It authenticates as the
read-only `keel_status` Postgres role via `/etc/keel/status-db.env`.

If that credential is ever lost, rotated, or the role's password needs resetting, re-run Task 6
Step 1 of `.superpowers/sdd/2026-09-07-keel-status-dashboard/task-6-brief.md` (generates a new
random password, re-applies `status/setupRole.sql`, rewrites `/etc/keel/status-db.env`). Do NOT run this
project's own test suite (`status/*.test.mjs`) against production credentials to "check" anything —
they operate against a separate `keel_status_test` role scoped to the disposable `keel_test`
database only, and are safe to run freely for that reason.
