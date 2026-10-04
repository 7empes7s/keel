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

## Snapshot retention prune

Prune runs as the `prune` schedule ("Clean-up of old snapshots" on the Schedules page), which
`keel-scheduler.timer` hands to `keel-worker` daily at 00:00 UTC. `keel-prune.timer` is the
trigger from before the schedules migration: `cli/keel-schedules-migrate.mjs` disables it, and
`keel-schedules-check-timers.sh` fails while it is enabled. Do not enable it; that would run the
prune twice and break the check. `keel-prune.service` stays installed for a manual run.

A prune deletes a snapshot (with its resource versions, references and relationship
observations) only when the snapshot is older than its tier's window and nothing else points at
it.

| Tier | Captured | Kept in the database | Snapshots kept |
| --- | --- | --- | --- |
| tier1 | hourly | 7 days | about 168 |
| tier2 | daily | 90 days | about 90 |
| tier3 | weekly | 365 days | about 52 |

A snapshot's tier is the highest criticality among its resources; an empty or failed snapshot
counts as tier1. Once the offsite timer above is running, its 30-day copies of the nightly
database dump still hold a pruned tier1 snapshot, so the oldest tier1 recovery point is about a
month there, but only a week inside KEEL itself.

A snapshot is always kept while any of these point at it: a baseline (active or superseded), a
drift (open or dispositioned), a plan, a restore dry run, a resource symbol or lineage alias
(including the last sighting of a since-deleted object), or an active incident retention pin.
`engine/store/retention.test.mjs` fails if a new table gains a foreign key into snapshots that
the prune does not account for.

To see what the next prune would delete, without deleting anything:

```sh
set -a; . /etc/keel/db.env; set +a
node /opt/keel/cli/keel-prune.mjs --dry-run
```

To stop pruning, turn the `prune` schedule off on the Schedules page.

## Round-trip rehearsal

`tools/rehearsal/roundTrip.mjs` exercises a real tenant through Graph while writing KEEL's own
governance state to `keel_test`; it defaults to `KEEL_DB_TEST_URL` and refuses to start against
`KEEL_DB_URL` (use `--db-url` only for another non-production database). Production baselines must
only ever be set by an operator because the public status page reports them.
