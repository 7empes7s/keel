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
- A stale queued job that preflight lists can be withdrawn with
  `node cli/keel-schedules-host.mjs cancel --job ID --reason TEXT`. The job row keeps the reason and
  shows as cancelled; running or finished jobs are left alone.
- `--root` is the tree the units run from; the unit files say `/opt/keel-live` and are installed with
  that prefix replaced.
- Only `collect` schedules are seeded by default. Add prune and offsite later with
  `node cli/keel-schedules-migrate.mjs --tenant-ref REF --kinds prune,offsite`; rows already there
  are kept.
- The migration retires only the old timers that the seeded kinds replace. The per-tier backup
  timers and `keel-prune.timer` are always disabled. `keel-offsite.timer` is left alone unless
  `offsite` is seeded, because until then it is what runs the daily vol2 copy.
- `keel-worker` is long-running, so a deploy that moves the tree should also run
  `systemctl try-reload-or-restart keel-worker` (a no-op when it is not running). Do not use
  `restart` or `try-restart`: those send SIGTERM, which ends the running job (a nightly content
  backup takes hours, issue #448). Reload sends SIGUSR2: the worker finishes its running job,
  claims nothing new, exits 0, and systemd starts it again on the new tree. Queued jobs wait for
  the new worker. After changing `keel-worker.service`, re-install it and run
  `systemctl daemon-reload`, or reload falls back to a restart.

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

Every copy that leaves the host is **encrypted with [age](https://age-encryption.org)** first and
ships as `keel-db-<date>.sql.gz.age`; the ciphertext's sha256 is what the target copy is checked
against, and it is recorded in `keel-db-shipped-manifest.json` (`shipped.sha256`) beside the
dump's own hash. The public recipients (`age1...`, one per line) are read from
`/etc/keel/offsite-age-recipients.txt` (or `KEEL_OFFSITE_AGE_RECIPIENTS`). The matching private
identity is kept **off this host** (the operator's password manager): if the VPS is lost, the
identity must not be lost with it. Nothing ships when `age` is missing, the recipients file is
missing or empty, or it holds a private key (`AGE-SECRET-KEY-...`). To restore from a copy:
`age -d -i IDENTITY keel-db-<date>.sql.gz.age > keel-db.sql.gz`. Copies shipped before
encryption (plain `.sql.gz`) age out with the 30-day prune.

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

Every prune run first saves a report (`retention_prune_report`): what would go, what stays and
why. The scheduled run passes `--apply` (Marouane's go, 2026-10-15) and deletes exactly what its own
report lists, in the same transaction. `keel-prune.mjs` without `--apply` is a dry run.

What routine retention keeps is a rotation policy (`engine/store/rotation.mjs`), per tenant,
workload, container or item; the most specific one wins:

| Rule | Keeps |
| --- | --- |
| daily / weekly / monthly / yearly N | the newest backup of each of the newest N days, ISO weeks, months, years that have one |
| keep within N days | every backup newer than N days |
| keep forever | everything in scope |

The default, until a policy is set, is 14 daily, 8 weekly, 12 monthly, 7 yearly. Settings
snapshots rotate per tier (workload `config`, container `tier1`..`tier3`); an unfinished snapshot is
kept for a week, then goes. Content rotates per item over its stored versions, each kind of row
(file bytes, metadata record, removal tombstone) on its own; the newest row of each kind is always kept, and a chunk goes only when no kept item (of any tenant) still lists it.
Pruned chunks leave the index; their storage objects stay until the storage adapters can delete.

A legal hold (`legal_hold`, set with `placeLegalHold`) keeps everything in its scope (tenant,
workload, container or item) until it is released with a reason.

A snapshot is always kept while any of these point at it: a baseline (active or superseded), a
drift (open or dispositioned), a plan, a restore dry run, a resource symbol or lineage alias
(including the last sighting of a since-deleted object), or an active incident retention pin.
`engine/store/retention.test.mjs` fails if a new table gains a foreign key into snapshots that
the prune does not account for.

To see what the next prune would delete, without deleting anything:

```sh
set -a; . /etc/keel/db.env; set +a
node /opt/keel/cli/keel-prune.mjs --report /tmp/keel-prune-report.json
```

To stop pruning, turn the `prune` schedule off on the Schedules page.

## Round-trip rehearsal

`tools/rehearsal/roundTrip.mjs` exercises a real tenant through Graph while writing KEEL's own
governance state to `keel_test`; it defaults to `KEEL_DB_TEST_URL` and refuses to start against
`KEEL_DB_URL` (use `--db-url` only for another non-production database). Production baselines must
only ever be set by an operator because the public status page reports them.

## Caddy admin API

Caddy's admin API takes unauthenticated POSTs (`/load`, `/stop`, `/config/...`). With no global
`admin` option it listens on `localhost:2019`, where any local process can rewrite or stop the web
server for every site on the host (operator item Q195 found it open). It must stay off TCP:

- The Caddyfile starts with a global block that puts the API on a unix socket:

  ```
  {
  	admin unix//run/caddy/admin.sock
  }
  ```

- `ops/caddy-admin-socket.conf` goes in `/etc/systemd/system/caddy.service.d/keel-admin-socket.conf`.
  It makes systemd create `/run/caddy` (mode 0700, owned by Caddy's user) on each start, so only
  Caddy and root can reach the socket.
- `systemctl reload caddy` keeps working: `caddy reload` takes the admin address from the config.
  Scripts that call `curl localhost:2019/...` or `caddy reload --address localhost:2019` stop working
  and must drop the address. `admin off` also closes the API, but then every config change needs a
  `systemctl restart caddy`, which drops connections on every site, so the socket is the default.
- First switch, in this order (operator item Q201), with no restart:
  1. install the drop-in and run `systemctl daemon-reload`;
  2. `install -d -m 700 -o caddy -g caddy /run/caddy` (systemd only creates it on the next start);
  3. add the global block and run `caddy validate --config /etc/caddy/Caddyfile`;
  4. `caddy reload --config /etc/caddy/Caddyfile --address localhost:2019` (a plain `systemctl reload caddy`
     fails here, because it sends to the new socket while the running Caddy still listens on 2019);
  5. run the check below, then `systemctl reload caddy` to prove later reloads use the socket.

  Never change the Caddyfile and restart before the drop-in is in place: without `/run/caddy` Caddy
  cannot create the socket and fails to start, taking every site down.
- After any change to the Caddyfile or the caddy unit, run as root:
  `node /opt/keel-live/ops/caddy-admin-check.mjs` (exit 0 = no admin API on TCP, socket directory
  private). It only connects to port 2019 and never sends a request.
