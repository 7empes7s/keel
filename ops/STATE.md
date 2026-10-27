# Keel handoff state

Read this first if you are a new session. It says where the live system, the queues and the open work stand.
Keep it current: update it in the same PR as any change to the facts below, and refresh the date.

- **Last updated:** 2026-10-27
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
- Cloud sessions cannot open portal pages (Access). Check pages with the Playwright harness
  (`portal`, `npm run test:ui`) on fixtures, and live data through a queue item.

## Deploy path

1. A PR lands on `master` through the **Merge gate** workflow (`automerge` label, every check green,
   Portal passed on the head commit, no blocking review).
2. `keel-deploy.timer` runs `/opt/keel-deploy/deploy.sh` 5 minutes after each run. It deploys only when
   `origin/master` differs from the live tree and the `portal.yml` run on that exact commit succeeded.
3. It refuses hand edits in the live tree and destructive schema (`DROP`, `TRUNCATE`, `DELETE FROM`).
4. It saves the running tree to `/opt/keel-live.prev`, checks out the commit, builds, dumps the database if
   the schema changed, applies `schema.sql`, restarts `keel-portal`.
5. Health check (local `/api/health` and the public `/status/`, about 60 s). On failure it rolls back to
   `.prev` and posts `keel/live-deploy` = failure. Log: `/var/log/keel-deploy.log`.
6. A deploy event goes to vps-deployer and, through the host copy of `notify-agent.sh`, to keelops too.

The deploy scripts are copied in `infra/deploy/` on branch `claude/deploy-rollback`; the host copies are the
ones that run. `keel-worker` is long-running: after a deploy use `systemctl try-reload-or-restart keel-worker`,
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

## Open live gates

| Gate | Queue items | State | Needs |
|---|---|---|---|
| Exchange undo and Defender "Make it pass" (#548, closes #542) | K14 then K15 (moved from root Q159 step 4 and Q161) | `todo` on the keelops queue | Marouane's K14 and K15 lines under Operator decisions |
| App with API permissions restores; replaced follow-up steps drop off (#563, #565) | K6 via K13 | In progress; decision filled in | keelops result |
| Portal visuals for #572–#575, #577–#579 | none | Not seen live (keelops can't open pages) | Playwright screenshots at 390 and 1440, light and dark |

Done on keelops: K1 (2026-10-25), K2–K4 and K7–K12 (2026-10-27) (K7, own compliance checks for #567, green at 20:11 UTC). K5 (Ask month questions) failed on the 5 s
budget and passed on re-check K10 after #577.

## Open issues

Four open (2026-10-27). The other operator reports were triaged and closed that day.

- #542 Exchange/Purview undo uses the wrong PowerShell config (fix #548 is live; closes on the K14/K15 gate above).
- #411 Run now routes accept arbitrary config and scope file paths (security).
- #294 Consent policy create fails live: the include condition set is posted before the new policy replicates.
- #148 Prove Entra restore on the test tenant (task).

## Parked work

- **Backlog (after the redesign):** guided-setup browser extension, training center and page Companion;
  permissions exposure (oversharing report, sharing-link drift, owner access review).
- **Redesign Track A (Insights):** A1 taxonomy (#354) shipped and object names exist. Not started: A3
  anonymity setting (next, no dependencies), A4 change feed, A5 grouped changes, A6 risk flags, A7 "where to
  start" panel, A8 Insights page, A9 names-not-ids everywhere, A10 alerts from flags.
- **Track E:** automation center. **Track F:** notifications. Both wait on the shell redesign and saved reports.
- **Host:** the prune schedule is not enabled (needs review first); the nightly database dump outside Keel
  overwrites its file in place.

## Shared notes for threads

Briefs, handoff notes and screenshots live in the project's shared files under `handoff/<topic>/`. The ranked
next-work list is `handoff/next-work/PLAN.md`; the keelops setup is `handoff/keelops/`.
