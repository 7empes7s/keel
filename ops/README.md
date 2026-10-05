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
nightly by `/opt/mimoun/backup.sh`) off the VPS root disk, to `/mnt/keel-copy/keel-offsite/` on
"vol2": the persistent Hetzner volume (`/dev/disk/by-id/scsi-0HC_Volume_107029601`) mounted at
`/mnt/keel-copy`. The volume outlives the server, so a rebuilt or deleted VPS doesn't take the only
copy of the backup with it. The earlier target, a Hostinger VPS at `187.124.7.67`, stopped answering
(issue #89).

Because the volume is mounted with `nofail`, a missing volume leaves `/mnt/keel-copy` as an empty
directory on the root disk. The script refuses to ship unless `/mnt/keel-copy` is on a different
filesystem from `/opt/backups`.

It verifies the dump twice: `gzip -t` plus a `>= 5` `^COPY public` block count *before* shipping
(a corrupt dump shipped offsite is worse than none, because it looks like protection), and a
sha256 of the staged copy compared against the local one *after* transfer (the copy's exit code
alone is not trusted). It stages the copy under a `.partial` name and only `mv`s it into place once the
hash matches; a mismatch deletes the partial copy and fails loudly rather than leaving a
silently-truncated file behind. Copies are root-only (`umask 077`). Offsite copies older than 30
days are pruned on each successful run.
Every failure path is `set -euo pipefail` and exits non-zero — nothing is swallowed with
`|| true`. Run `keel-offsite.sh --dry-run` to verify the current dump, check that the target is
usable, and report what would ship without copying anything. A dry run fails when the target
is unusable, because a real run would too.

Settings, all optional, go in `/etc/keel/offsite.env`, which the unit reads when it exists:
`KEEL_OFFSITE_DIR` (destination, default `/mnt/keel-copy/keel-offsite`), and `KEEL_OFFSITE_REMOTE=user@host`
with `KEEL_OFFSITE_SSH_KEY` to ship over SSH to another host instead.

Not installed or enabled by the build. The unit runs the script from `/opt/keel-live`, the tree
`keel-deploy.timer` keeps current; `/opt/keel` on the VPS is an old, stopped checkout whose script
still targets the retired host:

```sh
sudo install -m 0644 /opt/keel-live/ops/keel-offsite.service /opt/keel-live/ops/keel-offsite.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo /opt/keel-live/ops/keel-offsite.sh --dry-run   # must pass before enabling the timer
sudo systemctl enable --now keel-offsite.timer
```

A run exits 1 when the dump manifest is no newer than the last shipped one. That is deliberate: if
the nightly dump stops being produced, the offsite unit fails visibly instead of passing quietly. A
second run on the same day (for example the timer's catch-up after a manual run) fails the same way;
clear it with `systemctl reset-failed keel-offsite.service`.

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
