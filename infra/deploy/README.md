# Live deploy (Mulinux VPS)

These files are copies of what runs on the VPS, kept here so changes are reviewed. The host copies are
authoritative at runtime. After a change merges, install it by hand.

| File | Installed at |
|---|---|
| `deploy.sh` | `/opt/keel-deploy/deploy.sh` |
| `notify-agent.sh` | `/opt/keel-deploy/notify-agent.sh` |
| `keel-deploy.service`, `keel-deploy.timer`, `keel-portal.service` | `/etc/systemd/system/` |

## What a deploy does

`keel-deploy.timer` runs `deploy.sh` 5 minutes after each run finishes.

1. **Wait for something to deploy.** It does nothing unless `origin/master` differs from the live
   tree (`/opt/keel-live`) and the `portal.yml` push run on that exact commit concluded `success`.
2. **Refuse unsafe changes.** It refuses when the live tree has hand edits, or when the schema diff
   adds `DROP`/`TRUNCATE`/`DELETE FROM`.
3. **Save the previous release.** The running tree is copied to `/opt/keel-live.prev`.
   `/var/lib/keel-deploy/prev-sha` is written only after the copy completes.
4. **Install the new release.** Steps run in this order:
   1. `checkout --detach <sha>`
   2. `npm ci` and build
   3. a `pg_dump` if the schema changed
   4. apply the idempotent `schema.sql`
   5. restart `keel-portal`
5. **Check health.** Health means two things, retried for about 60 s:
   - `http://127.0.0.1:3600/api/health` returns `{"status":"ok"}`
   - `https://keel.techinsiderbytes.com/status/` returns 200
6. **On success:** posts the `keel/live-deploy` status as `success`, and hands a `deployed` event to the
   vps-deployer Claude session.
7. **On any failure:** rolls back.
   - It stops the portal, moves the failed tree to `/opt/keel-live.failed`, moves `.prev` back to
     `/opt/keel-live`, starts the portal and re-checks health. No rebuild is needed.
   - If there is no usable saved copy, it falls back to rebuilding the previous commit.
   - It then marks the commit in `/var/lib/keel-deploy/failed/` and posts `keel/live-deploy` = failure
     ("rolled back to …").
   - It writes the event to `/opt/ai-vault/daily/<date>.md` and notifies the agent.
   - If the rollback itself fails, it logs and posts `CRITICAL` instead.

Schema changes are additive and idempotent, so a rollback does not revert them. Destructive schema is
never applied automatically.

## Operating

- **Log:** `/var/log/keel-deploy.log`.
- **Retry a failed commit:** `rm /var/lib/keel-deploy/failed/<sha>`.
- **Prove the rollback path:** run `KEEL_DEPLOY_FORCE_HEALTH_FAIL=1 /opt/keel-deploy/deploy.sh` while
  a deployable commit is pending. The new release's health check is forced to fail, so the script must
  restore the previous release. The vps-deployer hand-off is skipped and the log says `TEST`. Then
  `rm` the failed marker and let the timer deploy normally.
- **Disk:** each deploy keeps one extra copy of the tree (about 1 GB in `.prev`, plus `.failed` after a
  rollback).
