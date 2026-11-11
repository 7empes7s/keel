# Keel handoff state

Read this first if you are a new session. It says where the live system, the queues and the open work stand.
Keep it current: update it in the same PR as any change to the facts below, and refresh the date.

- **Last updated:** 2026-11-11
- **Older history:** an earlier version of this file (to 2026-10-09) lives on branch `claude/operator-queue`.
  It is out of date; use it only for history.

## Live build

- **Portal:** https://keel.techinsiderbytes.com, behind Cloudflare Access. Served from `/opt/keel-live` on
  Mulinux by `keel-portal`.
- **Status page:** https://keel.techinsiderbytes.com/status/ (rebuilt every 60 s by `keel-status-generate.timer`).
- **Which build is live:**
  - From GitHub: the `keel/live-deploy` commit status on master. `success` marks the commit that is live;
    `failure` says "rolled back to …".
  - On the box: `git -c safe.directory=/opt/keel-live -C /opt/keel-live rev-parse --short HEAD`.
  - Health: `curl -s http://127.0.0.1:3600/api/health` returns `{"status":"ok"}`.
- **Deploys back on since 2026-11-06** (`keel-deploy.timer` was off from 2026-11-04 to 2026-11-06); first
  deploy after: `f057e29 -> b9905c2`, health ok. vps-deployer and keelops-deployer are off on purpose, so
  deploy events are only logged (`WARN: vps-deployer not running`).
- **Database watchdog installed 2026-11-06** (`keel-db-watchdog.timer`, every minute; #1018).
- **Host housekeeping 2026-11-06 (#1024):** `/opt/keel-deploy` holds the repo copies of `deploy.sh` and
  `notify-agent.sh` (database probe and quiet notify; old copies `*.bak-20261106`). The nightly backup
  (`mimule-backup.timer`, 04:00 UTC) runs the repo's `ops/mimule-backup.sh` from `/usr/local/bin`: it keeps
  the newest 7 dated folders `/opt/backups/<YYYY-MM-DD>/` (was 3), deletes nothing else, and moves the
  KEEL dump into place only once verified, so a failed run never overwrites that day's good dump.
- Cloud sessions cannot open portal pages (Access). Check pages with the Playwright harness
  (`portal`, `npm run test:ui`) on fixtures, and live data through a queue item.

## Deploy path

1. A PR lands on `master` through the **Merge gate** workflow (`automerge` label, every check green,
   Portal passed on the head commit, no blocking review).
2. `keel-deploy.timer` runs `/opt/keel-deploy/deploy.sh` (source: `ops/keel-deploy/`) 5 minutes after
   each run. It deploys only when `origin/master` differs from the live tree and the `portal.yml` run on
   that exact commit succeeded.
3. It refuses hand edits in the live tree and destructive schema (`DROP`, `TRUNCATE`, `DELETE FROM`).
4. It saves the running tree to `/opt/keel-live.prev`, checks out the commit, builds, dumps the database if
   the schema changed, applies `schema.sql`, restarts `keel-portal`.
5. Health check (local `/api/health` and the public `/status/`, about 60 s). On failure it rolls back to
   `.prev` and posts `keel/live-deploy` = failure. Log: `/var/log/keel-deploy.log`.
6. A deploy event goes to vps-deployer and, through the host copy of `notify-agent.sh`, to keelops too.

The deploy scripts live in `ops/keel-deploy/`; the host copies in `/opt/keel-deploy` are the ones that run
(see "Operator steps waiting" until they match). `keel-worker` is long-running: after a deploy use `systemctl try-reload-or-restart keel-worker`,
never `restart` (it would end a running backup, #448). Details in `ops/README.md`.

## Who does what

| Who | Where it runs | What it does | How to reach it |
|---|---|---|---|
| Cloud threads (project "Keel") | Cloud sessions | Code, PRs, independent review, queue items | Project chat |
| **keel-operator** | Mulinux, root, `/opt/rc-keel-operator` | Tenant and host work from the root queue | Root queue only |
| **vps-deployer** | Mulinux, root | Reviews each deploy; owns `deploy.sh` changes and rollbacks | Deploy events |
| **keelops** | Mulinux, user `keelops`, `keelops-deployer.service` | Second operator and deploy reporter, on the second subscription (keel-operator and vps-deployer use the first). Now does most live checks | keelops queue only |
| Marouane | Phone | Decisions, approvals the agents can't give, logins | Project chat |

- Cloud threads cannot message the box sessions. Add queue items instead; don't ask Marouane to paste
  messages unless an operator has clearly stopped.
- keelops reports deploys only: notes go to `/opt/ai-vault/daily/<date>-keelops.md`. Fixes and rollbacks
  stay with vps-deployer, so the two never both act on the box.
- keelops cannot open portal pages (Access). Its live-DB reads go through Keel's own CLI or engine calls;
  hand-written SQL needs Marouane's OK written into the item.
- keelops can read `/etc/keel` (it ran K2–K5 with it), so the ACL step Q175 was marked not needed.

## The two queues

Both use the same item format and protocol (stated at the top of each file). Neither is ever merged to master,
so queue edits never deploy.

| Queue | Branch | Worked by | Items |
|---|---|---|---|
| `ops/operator-queue.md` | `claude/operator-queue` | keel-operator | `Q<n>` |
| `ops/keelops-queue.md` | `claude/keelops-queue` | keelops | `K<n>` |

- Both operators poll every 20 minutes and take the first `todo` item whose `Needs` are met. They write only
  `Status` and `Result`.
- Never put the same item in both queues. To move one, copy it to the new queue and mark it
  `moved (to K<n>)` in the old one (as Q169–Q174 were moved to K2–K7).
- Name every test fixture with the `KEEL-RT-` prefix. Tools match on the prefix, never on exact names.
- Waiting on a queue item: check back with a delay that fits the action (minutes for quick checks). Never
  poll in a loop.

## Who approves what

- **Standing authorization (2026-10-14):** keel-operator may self-approve test-tenant restores and content
  effects, logging each approval id in the item's Result.
- **Tenant-wide settings (2026-10-22):** allowed in the test tenant, if each value is put back right after.
- **keelops:** acts as an approver only on Marouane's own line under the queue's **Operator decisions**
  section (human only). A note in the item written by another session is not enough (see K6). Bundle any
  such asks into one line for Marouane.
- **Always, for everyone:** never write to a real tenant from a cloud session; never enable a Conditional
  Access policy; never touch break-glass or Marouane's account; never grant admin consent or new app
  permissions without a written decision; restore writers never send trust, federation, certificate or
  sign-in endpoint fields.
- Grants already in place (check the tenant before saying one is missing): Collector has Teams, Compliance,
  Exchange and SharePoint Administrator, Global Reader, Security Reader and the Power Platform management
  app; Restorer has `DeviceManagementScripts.ReadWrite.All` and keeps its full write set while developing.

## Operator steps waiting

**Database watchdog (#1010): done 2026-11-06 (#1018).** Kept for a reinstall. As root on Mulinux:

```sh
cd /opt/keel-live
install -m 644 ops/keel-db-watchdog.service ops/keel-db-watchdog.timer ops/keel-scheduler.service /etc/systemd/system/
systemctl daemon-reload
systemctl start keel-db-watchdog.service && journalctl -u keel-db-watchdog -n 5 --no-pager   # exit 0, nothing logged
systemctl enable --now keel-db-watchdog.timer
systemctl list-timers keel-db-watchdog.timer --no-pager                                        # next run within a minute
```

`keel-scheduler.service` gains only `StateDirectory=keel-scheduler`. For an alert to reach a person, a
channel needs a rule that takes alerts (`*`, or `database.*`, at warning or above) on the Notifications page.

**Deploy script in the repo (#1017, merged as #1019): installed 2026-11-06 (#1024).** Kept for a reinstall.
`deploy.sh` and `notify-agent.sh` now live in `ops/keel-deploy/` (vps-deployer, which owned them, is off). The
repo copy adds the database probe to `healthy()` (a release whose database does not answer rolls back; a tree
from before #1010 has no probe and skips it) and makes `notify-agent.sh` a silent no-op when the agent session
it wakes is not running. `keel-deploy.timer` runs the host copy in `/opt/keel-deploy`, which a deploy never
replaces, so a change to these scripts needs these steps again. As root on Mulinux:

```sh
D=$(mktemp -d); git -C /opt/keel-live fetch -q origin master
for f in deploy.sh notify-agent.sh; do git -C /opt/keel-live show "origin/master:ops/keel-deploy/$f" > "$D/$f"; done
diff /opt/keel-deploy/deploy.sh "$D/deploy.sh"              # only the DB probe
diff /opt/keel-deploy/notify-agent.sh "$D/notify-agent.sh"  # only the no-op
install -m 755 "$D"/*.sh /opt/keel-deploy/
systemctl is-active keel-deploy.timer                       # already active since 2026-11-06
```

Change these scripts in the repo from now on, never in `/opt/keel-deploy`.

## Open live gates

The release sign-off (task-124, #985) is generated: `node tools/release/readiness.mjs signoff --build <candidate>`.
The full pending list, by objective, is `docs/roadmap/PENDING.md`; the live batches are #1025, #1026 and #1027.
On 2026-11-06 (#1051, on Mulinux with the key), at the frozen candidate `128b0e3b84` it says **pending**: 45 of 49
gates and 127 of 223 Entra writes are live-qualified; deployed acceptance and ServiceNow are stale and the Defender
indicators read has no record. The freeze is lifted and `/opt/keel-candidate` is removed. #1054 and #1062 changed
engine code after the candidate, so the next sign-off needs a new frozen candidate:

- Recheck 2 (#1050, 2026-11-06) recaptured every non-Entra gate it could at the frozen candidate `128b0e3b84`:
  storage, drill, native recovery, NIST, ScubaGear, gates 120–123, the 7 writer families, 22 reads and the 6
  separate writers. `sharepoint-structure.site-template.update` is refused before sending (#1052). Still held:
  deployed acceptance (needs an operator `cloudflared access login`), ServiceNow (the dev instance refuses the
  stored admin login, 401) and the Defender indicators read (403, `Ti.Read.All`). Sentinel (117) is an accepted gap.
  The recovery set is `/opt/backups/2026-11-06/recovery-set-r1050`, copied to `/mnt/keel-copy/2026-11-06-r1050`.
- Entra (#148): 223 registered writes. Recheck 1 (#1049, 2026-11-06) proved 127 at the frozen build `128b0e3b`
  (`multiTenantOrganization.update`, the deletes, SharePoint Loop, entitlement settings and the Tunnel limit among
  them). `accessReviewScheduleDefinition.create` failed again (#1039's scope match misses Graph's `/v1.0/` prefix)
  and `configurationPolicy.delete` failed (Graph answers 400 ResourceNotFound after the delete). 35 have a record
  from another build and 60 have none, mostly lockout-sensitive or missing Restorer permissions. Left on the test
  tenant: the MTO description `KEEL-RT drift (#1031)` (Graph can't clear it) and the KEEL-RT-1031 and KEEL-RT-1049
  administrative units in deleted items (app-only purge 404; they age out in 30 days).
- User flows (#995, fixture-tested only): capture `b2xIdentityUserFlow` create/update and
  `identityUserFlowAttribute` create/update on a `B2X_1_KEEL-RT-148-flow` flow that asks for one custom
  attribute `KEEL-RT-148Attr` (`FIXTURE_GUIDANCE` in `tools/qualification/live-gate-plan.mjs`). Check the
  `$expand=apiConnectorConfiguration/...` read and `setOrder` against the live tenant.
- `roleAssignmentSchedule.create` (#991, time-limited active admin roles) has no live record yet: capture it with
  a KEEL-RT- fixture (carla, the fixture role, the fixture unit, ending in 2 days), approved as "Changes admin access".
- Writer families not fully proven: `sharepoint-structure` 5 of 7, `exchange-extended` 12 of 21, and others in
  `docs/roadmap/release-signoff.md`.
- Sign-in settings (#994, fixture-tested only): authentication context upsert and staged rollout create and
  update need live captures. Contexts: a `KEEL-RT-994-context` in a slot nothing uses, left not available.
  Rollout: `KEEL-RT-994-rollout` (switched off) applied to the empty group `KEEL-RT-994-rollout-group`, behind
  the lockout gate with its "Changes sign-in" effects approved. `authenticationMethodsPolicy.update` now writes
  less (no x509 binding or mode fields); its existing record still holds.
- Entitlement management part 1 (#992): `accessPackage` create and update and
  `accessPackageResourceRoleScope` create are fixture-tested with no live record yet. Capture needs a
  KEEL-RT-992-catalog holding one KEEL-RT group (steps in the #992 PR body); the role write is approval-held.
- Entitlement management part 2 (#993): `connectedOrganization` and `accessPackageAssignmentPolicy` create
  and update are fixture-tested with no live record yet. Capture needs KEEL-RT-993-org (proposed, one
  operator-owned domain) and KEEL-RT-993-policy on KEEL-RT-992-package (steps in the #993 PR body); both
  writes are approval-held.
- Defender, Intune connector and Microsoft 365 settings (#1074): `defenderDetectionRule` and `securityZone` and
  `externalConnection` create and update, and `defenderIdentitySensor`, `itemInsightsSettings`, `todoSettings`, the
  three Intune partner kinds and `deviceManagementDerivedCredentialSettings` update are fixture-tested with no live
  record yet. Capture needs KEEL-RT-148-rule (no response actions, off), KEEL-RT-148-zone and keelrtconnection; the
  rest are tenant settings (steps in the #1074 PR body). Skip a partner or sensor kind the test tenant does not have.
- Entitlement management part 3 (#1071): `accessPackageCatalogResource`, `accessPackageAssignment` and
  `entitlementManagementRoleAssignment` create are fixture-tested with no live record yet. Capture needs the
  KEEL-RT-148-group in KEEL-RT-992-catalog, carla assigned KEEL-RT-992-package through KEEL-RT-993-policy and
  carla as Catalog reader (steps in the #1071 PR body); all three are approval-held. First check a new backup
  names each assignment's policy (`$expand=assignmentPolicy`). Outside connectors stay by hand (their sign-in).
- Attack simulations (#1073): `attackSimulation` create and update, always as a draft, are fixture-tested with
  no live record yet. The backup now reads each simulation's payload, login page and landing page; check a new
  backup names them and that the Restorer holds `AttackSimulation.ReadWrite.All`. Capture needs the draft
  KEEL-RT-1073-simulation on KEEL-RT-1073-payload targeting only carla (steps in the #1073 PR body); never
  launch it. Payloads, pages, notifications and automations stay by hand (Graph cannot write them).
- Access review series (#1007): `accessReviewScheduleDefinition` create is fixture-tested with no live record
  yet. Capture needs KEEL-RT-1007-review of the empty KEEL-RT-148-group reviewed by carla, auto-apply off
  (steps in the #1007 PR body); the write is approval-held and needs `AccessReview.ReadWrite.All` granted.
- Terms of use (#1007): `agreement` create and update are fixture-tested with no live record yet. First check a
  backup holds each PDF (fileData shows a sha256, not null; the Graph reference shows null) and that the
  Restorer's `Agreement.ReadWrite.All` application grant is accepted; then capture KEEL-RT-1007-terms (steps in
  the #1007 PR body). Approval-held; PDFs live in `agreement_file_blob`, which prune does not touch yet.
- Idle sign-out policies and API connectors (#1008): `activityBasedTimeoutPolicy` and `identityApiConnector`
  create and update are fixture-tested with no live record yet. Capture needs KEEL-RT-idle (never the
  organization default) and KEEL-RT-connector on no user flow (steps in the #1008 PR body); the connector
  write and any write into the live organization default idle sign-out policy are approval-held.
- Sign-in extensions (#1072): `customAuthenticationExtension` update (a create updates the live one with the
  same name) and `authenticationEventListener` create and update are fixture-tested with no live record yet.
  Capture needs KEEL-RT-1072-claims calling https://keel-rt.invalid/api/claims and its listener on the
  KEEL-RT-148-app (steps in the #1072 PR body); listener writes and token claim changes are approval-held.
- App provisioning (#1016): `synchronizationJob` schema update and create of a stopped job are fixture-tested
  with no live record yet. The backup now reads each job's schema: check the Collector holds
  `Synchronization.Read.All` (a 403 on the jobs read means it does not) and the Restorer
  `Synchronization.ReadWrite.All`. Capture needs KEEL-RT-1016-scim (steps in the #1016 PR body); the schema
  write is approval-held and the job is never started.
- Permanent writes (#1015): `attributeSet` and `customSecurityAttributeDefinition` create, and
  `crossTenantIdentitySyncPolicyPartner` create and update, are fixture-tested with no live record yet. Never
  run a create or turn sync on live (each leaves something for good): capture the sync update on the D-148b
  partner with sync off, and check the dry runs list "Can't be undone" (steps in the #1015 PR body).
- What to run: `node tools/release/readiness.mjs recapture-plan --build <candidate>` lists every capture and
  verify command (the operator runs it; builders never do). Whether the existing records verify, and which
  build is live, **needs the operator** (the key and the live tree are on the server).

Queue items open on 2026-10-27 (K6/K13, K14/K15, Q188, portal visuals for #572-#579): their fixes (#548, #563,
#565, #596) are merged and #542 is closed; whether each queue item is done **needs the operator** (the queues
live on their own branches).

## Open issues

Five open (2026-11-06): #1023 (this pending plan), #1024 (Mulinux ops: install the deploy script, dump
rotation, prune and offsite review), #1025, #1026 and #1027 (live proof batches 1 to 3: Entra writes, workload
writers and reads, deployed acceptance and the sign-off at one build). #985, #983, #982, #981, #980 and #979
are closed.

## Parked work

The list of parked items, and of everything still pending, is `docs/roadmap/PENDING.md`.

- **Redesign Track A (Insights):** A1 to A10 shipped (A9 names-not-ids in #970, A10 alerts from flags in #966 / PR #978).
- **Host (owner decisions, #1024):**
  - **Prune** (`keel-prune.timer` off): the 2026-11-06 dry run (one tenant, 653 snapshots) would delete 10,
    all tier1 hourly snapshots from that day that are neither the day's newest nor referenced; tier2 and
    tier3 lose none, no content versions go. That matches the default policy (14 daily, 8 weekly,
    12 monthly, 7 yearly). Before enabling: point `ExecStart` in `ops/keel-prune.service` and the installed
    unit at `/opt/keel-live` (both still run the stopped `/opt/keel` checkout), then decide.
  - **Offsite** (`keel-offsite.timer`): on and green, shipping each night's encrypted dump to the vol2
    volume (`/mnt/keel-copy`, separate disk). The old Hostinger target (187.124.7.67) does not answer
    from Mulinux at all (no ping, port 22 times out; key `/root/.ssh/playground_vps` and its known_hosts
    entry are present), so the cause is that host or its firewall, not the key. A second, remote target
    needs that host fixed first (Hostinger panel), then `KEEL_OFFSITE_REMOTE` in `/etc/keel/offsite.env`.

## Shared notes for threads

Briefs, handoff notes and screenshots live in the project's shared files under `handoff/<topic>/`. The ranked
next-work list is `docs/roadmap/PENDING.md` in this repo (it replaces `handoff/next-work/PLAN.md`); the keelops
setup is `handoff/keelops/`.
