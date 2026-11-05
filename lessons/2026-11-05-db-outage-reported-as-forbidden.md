# DB outage reported as forbidden (2026-11-05)

From about 13:30 on 2026-11-05 every sign-in to the live portal got `{"error":"forbidden"}` (HTTP 403),
for both of the manager's accounts. Issue #1005.

What Part 1 of the fix found on Mulinux:

- Postgres itself was fine. `keel-postgres` had been up 40 hours, with no OOM kill and no restarts. Both
  principals existed, with admin grants.
- Docker's port forward for the container (`127.0.0.1:5433 -> 5432`) had died at 2026-11-04 22:45:14 UTC.
  dockerd logged "Userland proxy exited early" without any daemon shutdown. After that nothing listened on
  5433, and every connection got `connect ECONNREFUSED 127.0.0.1:5433`. `docker ps` still showed the port
  mapping, and `/api/health` stayed 200, because it reads no database.
- `proxy.ts` swallowed every sign-in check error except "busy", so the outage was reported as "you're not
  allowed in". `keel-scheduler` failed every 5 minutes for the same reason, and nobody noticed.
- Fix on live: `docker restart keel-postgres`, which recreated the port forward, then
  `systemctl restart keel-portal`. Restored at 14:10 UTC. The restart policy was already `unless-stopped`,
  and that policy does not cover a dead port forward.

| Mistake | Rule now |
| --- | --- |
| The sign-in check turned any database error into 403 "forbidden". | A database that can't be reached is a 503 that says so, and it is logged with its reason, path and cf-ray (`databaseUnreachableReason` in `portal/lib/db.ts`). 403 means only "this email has no principal". Every other unexpected error is logged before it is refused. |
| "Container up" and "health 200" were taken to mean "database reachable". | When diagnosing, test the actual port the app uses (`ss -ltn \| grep 5433`, or a connect from the host), not the container status. |
