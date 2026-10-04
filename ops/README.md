# KEEL scheduled collection

Tier 1/2/3 collection runs from `schedule` rows: `keel-scheduler.timer` turns due rows into jobs
every five minutes, and `keel-worker` runs them through `cli/keel-collect.mjs --tier tierN`.
The per-tier `keel-backup-tier*.timer` units are the older trigger; `keel-schedules-migrate.mjs`
keeps them disabled, and they should not be enabled alongside the scheduler.

Nothing is installed by the build. On the host, as root, from the deployed tree:

```sh
bash ops/keel-schedules-install.sh --root /opt/keel-live   # preflight, units, collect schedules, enable
node cli/keel-schedules-host.mjs run-now                   # one collection per tier now
node cli/keel-schedules-host.mjs health                    # after those jobs finish; exit 0 = all tiers healthy
```

- The install stops before changing anything when `preflight` finds queued or running jobs (no
  worker has run them, and a new worker would), enabled auto-remediate policies, or enabled
  schedules for another tenant. `preflight` is read-only and can be run on its own.
- `--root` is the tree the units run from; the unit files say `/opt/keel` and are installed with
  that prefix replaced.
- Only `collect` schedules are seeded by default. Add prune and offsite later with
  `node cli/keel-schedules-migrate.mjs --tenant-ref REF --kinds prune,offsite`; rows already there
  are kept.
- `keel-worker` is long-running, so a deploy that moves the tree should also run
  `systemctl try-restart keel-worker` (a no-op when it is not installed).

## KEEL status dashboard

`keel-status-generate.timer` runs `status/generate.mjs` every 60s, publishing
`status/out/index.html` (served by Caddy at keel.techinsiderbytes.com). It authenticates as the
read-only `keel_status` Postgres role via `/etc/keel/status-db.env`.

If that credential is ever lost, rotated, or the role's password needs resetting, re-run Task 6
in `/root/docs/superpowers/plans/2026-09-07-keel-status-dashboard.md` (generates a new
random password, re-applies `status/setupRole.sql`, rewrites `/etc/keel/status-db.env`). Do NOT run this
project's own test suite (`status/*.test.mjs`) against production credentials to "check" anything —
they operate against a separate `keel_status_test` role scoped to the disposable `keel_test`
database only, and are safe to run freely for that reason.

## Offsite database replication

`keel-offsite.sh` ships the most recent `/opt/backups/<YYYY-MM-DD>/keel-db.sql.gz` (produced
nightly by `/opt/mimoun/backup.sh`) to a second, independent host — Hostinger at `187.124.7.67`,
reached via `ssh -i /root/.ssh/playground_vps`, under `/opt/keel-offsite/` there. A dump on the same
host as the database it protects is not a backup: if this VPS is lost, every tenant baseline goes
with it unless a copy exists elsewhere.

It verifies the dump twice: `gzip -t` plus a `>= 5` `^COPY public` block count *before* shipping
(a corrupt dump shipped offsite is worse than none, because it looks like protection), and a
remote-computed sha256 compared against the local one *after* transfer (scp's exit code alone is
not trusted). It stages the copy under a `.partial` name and only `mv`s it into place once the
hash matches; a mismatch deletes the partial copy and fails loudly rather than leaving a
silently-truncated file behind. Remote copies older than 30 days are pruned on each successful run.
Every failure path is `set -euo pipefail` and exits non-zero — nothing is swallowed with
`|| true`. Run `keel-offsite.sh --dry-run` to verify the current dump and report what would ship
without transferring anything.

Not installed or enabled by the build, matching the tiered backup units above:

```sh
sudo install -m 0755 ops/keel-offsite.sh /opt/keel/ops/keel-offsite.sh
sudo install -m 0644 ops/keel-offsite.service ops/keel-offsite.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now keel-offsite.timer
```

## Round-trip rehearsal

`tools/rehearsal/roundTrip.mjs` exercises a real tenant through Graph while writing KEEL's own
governance state to `keel_test`; it defaults to `KEEL_DB_TEST_URL` and refuses to start against
`KEEL_DB_URL` (use `--db-url` only for another non-production database). Production baselines must
only ever be set by an operator because the public status page reports them.
