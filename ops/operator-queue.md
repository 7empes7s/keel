# KEEL operator queue

Work queue between the **coordinator** (the KEEL Developer cloud session) and
**keel-operator** (the VPS session with tenant and host access). It lives only on
branch `claude/operator-queue` and is never merged to master. This keeps deploys from
being triggered by queue updates.

**Overall project state and where to pick up: `ops/STATE.md` on this branch.**

## Protocol

**Who writes what**
- The coordinator adds and edits items.
- keel-operator writes only each item's `Status` and `Result` fields.
- The **Operator decisions** section is written only by the human operator. No Claude
  session fills in or changes a decision.

**keel-operator, on each pass**
1. `git fetch origin claude/operator-queue` and check out its tip.
2. Take the first item with `Status: todo` whose `Needs` are all `done`, and whose
   decisions (if any) are filled in below by the human operator.
3. Set `Status: in-progress` and push. Do the work. Then set `Status` to `done`,
   `blocked` or `failed` and write `Result`. A Result names:
   - the evidence branch (if any) and the commit it captured;
   - the verify output and its exit code;
   - what was created or changed in the tenant or on the host;
   - anything blocking.
   Then push. If a push is rejected, `git pull --rebase` and retry. Only ever touch your
   own fields.
4. One item at a time. If an item is blocked, move on to the next one it doesn't
   block.

**Hard rules for every item**
- Tenant objects:
  - Create or change only `KEEL-RT-*` or `keel-rehearsal-*` fixtures.
  - Never touch the operator's admin, break-glass or Global Reader accounts.
  - No Conditional Access, MFA or security-defaults changes.
  - Never grant an app a new permission or role unless a filled decision below says so.
- Secrets: never print, log or commit a secret (HMAC key, JWT, token, certificate,
  password).
- Evidence:
  - Never hand-edit evidence.
  - A failed or refused capture is a result. Report it.
  - Check every evidence file for secrets before committing it.
- Git:
  - Never push to master, merge a PR, or force-push.
  - Never edit tests or code; if a step seems to need that, report it as `blocked`.
  - Evidence goes on `claude/live-evidence-<task>`, branched from `origin/master`, and
    contains only that gate's files under `docs/release/qualifications/`.
- Host: don't run git in `/opt/keel`. Use your own clone or a worktree, checked out at
  the commit `/opt/keel-live` is deployed at.
- Builds: each record binds to one build. Run 120 → 121 → 122 → 123 in one sitting at
  the same deployed build (each requires the previous record to verify at that build).
  If `/opt/keel-live` moves during a chain, stop and report.

## Items

### Q1: Gate 113 (deployed-acceptance)
- Status: done (captured by keel-operator before this queue existed)
- Result: `claude/live-evidence-113` @ 48d37ca, build 33ad2a9, verify ok, exit 0.
- Coordinator note: merging waits on the operator. The test
  `engine/roadmap/deployed-acceptance.test.mjs` pins the committed file as pending.
  This is not a keel-operator item.

### Q2: Gate 114 (storage-live-acceptance, local copy)
- Status: done
- Result: **Part B done (via Q15).** `claude/live-evidence-114` @ 4b1d3da, from origin/master 87e366e.
  Record build **df0de36** (the recovery set's build); captured from a df0de36 checkout.
  `KEEL_TENANT_CONFIG_PATH=/etc/keel/tenant.json verify --require-live --gate storage-live-acceptance
  --build df0de3616841301bc0c596a4ba788996cc32ba1b`: `{"ok": true, "failures": []}`, exit 0.
  Retention lock, immutability and lock canary: UNQUALIFIED (by decision).
  - Set: Q11's `/opt/keel-recovery-sets/2026-10-04`. Copied with `cp -a --no-clobber` to
    `/mnt/keel-copy/2026-10-04`: device 2064 (vol2 /dev/sdb) vs 2049 (/dev/sda1). Root-owned, then
    `chmod -R go+rX,a-w`. Copy digests match the set (manifest 80231c6d…, dump 429bdf53…,
    export manifest d0ad81cf…).
  - Checkpoint 2:90e032c1…ebf:2 (Q11). `--manifest-sha256` was passed because keel-recovery can't
    read the primary set.
  - Host changes:
    - system account **`keel-recovery`** (uid 995, nologin, no home, owns no files);
    - `chmod o+x /opt/keel-recovery-sets` (traverse only, so the capture can stat the primary root).
      `/opt/backups` was not touched;
    - `/etc/keel-recovery/tenant.json`: tenantId only, 0644, because keel-recovery can't read `/etc/keel`.
  - Refs (descriptions only): credential `os-login:keel-recovery@keel-vps`; key ref = Q11
    key metadata; storage read = the vol2 copy; tenant authorization = this queue.
  - Evidence scanned: no HMAC key, token or PEM. Nothing deleted, moved or pruned.
- Needs: none. Doesn't touch the tenant.
- Do: follow `docs/roadmap/storage-live-acceptance.md` › Operator steps.
  - **Part A (read-only).** Report:
    1. the newest backup set from the deployed build, and whether it has a task-67
       recovery manifest with key instructions and the evidence head (if not, the exact
       `ops/keel-dump-manifest.mjs` command and whether its inputs are known);
    2. `findmnt -D`: is there a filesystem separate from the primary backup mount, and
       how much free space does it have;
    3. whether a `keel-recovery` OS account exists.
  - **Part B (only if 1 and 2 hold).** Do the following:
    - create the `keel-recovery` system account (no login shell, owns no backups) if it
      is missing;
    - copy the set to the separate mount, read-only for that account;
    - capture as `keel-recovery`, then `verify --require-live`;
    - if verify exits 0, commit `storage-live-acceptance.json` and
      `storage-live-acceptance.artifact.json` to `claude/live-evidence-114`.

    Never delete, move or prune a backup, and never change permissions on the primary
    backup directory. Prerequisite refs are descriptions of where material lives, never
    the material itself. Don't fake a separate volume (a loop device or a directory on
    the same disk). If there's no separate mount, mark the item `blocked`.

### Q3: Prerequisites for gate 115 (read-only check plus one fixture)
- Status: done
- Result: Restorer app (`/etc/keel/restorer.json`, appId 12f8942f-c4d0-4a0d-aee1-efe928b1de54; note that
  `/etc/keel/restorer-target.json` **does not exist** on the host): granted application
  permissions read from its token roles. **`Group.ReadWrite.All` is granted.** Nothing was granted
  by me. Observation: the Restorer holds about 52 ReadWrite roles, including
  `Policy.ReadWrite.ConditionalAccess`, `RoleManagement.ReadWrite.Directory`,
  `Directory.ReadWrite.All` and `Application.ReadWrite.All`, plus 9 directory roles
  (wids), which is far broader than native recovery needs.
  Created fixture: security group **`KEEL-RT-native-recovery-group`**, object id
  **`b1b02d2f-3f30-4cb5-8a63-81f94de2734b`** (2026-10-04T08:34:45Z, Restorer app; not
  mail-enabled, not role-assignable; 0 members, 0 owners, 0 app role assignments, verified
  via the Collector). `keel-rt-20260908-alice` not used. No evidence branch.
- Needs: none
- Do:
  - Check, read-only, which application permissions the Restorer app
    (`/etc/keel/restorer-target.json`) has been **granted**. Report whether
    `Group.ReadWrite.All` is among them. Don't grant it.
  - If no group named `KEEL-RT-native-recovery-group` exists, create it: a security
    group, not mail-enabled, with no members, owners, roles or app assignments.
  - Report the group's object id. Don't use `keel-rt-20260908-alice`.

### Q4: Gate 115 (native-live-acceptance)
- Status: done
- Result: `claude/live-evidence-115` @ b965a66, capture at build 33ad2a9 (= `/opt/keel-live`, clean).
  `verify --require-live --gate native-live-acceptance --tenant sha256:f7b3959300856957 --build 33ad2a9…`:
  `{"ok": true, "failures": []}`, exit 0.
  Tenant: fixture `KEEL-RT-native-recovery-group` (b1b02d2f-3f30-4cb5-8a63-81f94de2734b) deleted and
  restored by the capture **twice**. It is active afterwards, not in deleted items, still 0 members.
  Nothing else touched.
  Notes for the coordinator:
  - **Attempt 1 failed** (exit 1, "read-back returned 404") although the restore returned 200.
    This is Entra replication lag: `captureRoundTrip` retries `read-deleted` but not `read-back`
    (`tools/qualification/nativeRecovery.mjs:136-137`). Attempt 2, unchanged, passed. The
    attempt-1 files are kept locally, not committed. Suggest a code fix: retry read-back like
    read-deleted.
  - `/etc/keel/restorer-target.json` doesn't exist. I used `--target-config /etc/keel/restorer.json`
    (same {tenantId, clientId, certPath, keyPath} shape; the drill docs name it). The record's
    clientRef therefore says `/etc/keel/restorer.json`. The gate docs should be updated, or the file created.
  - MS doc page fetched 2026-10-04 (HTTP 200, ms.date 2025-11-17, still lists Group.ReadWrite.All).
  - Verify needs `KEEL_QUALIFICATION_HMAC_KEY` in the environment too. The doc's verify command omits it.
- Needs: Q3 done, with `Group.ReadWrite.All` granted
- Do: follow `docs/roadmap/native-live-acceptance.md` › Operator steps.
  - Fetch the Microsoft doc page it names and pass today's date as
    `--docs-retrieved-at`.
  - Capture. This deletes the fixture group once and restores it.
  - Run `verify --require-live` with `--tenant` and `--build`.
  - If verify exits 0, commit the two files to `claude/live-evidence-115`.

### Q5: Prerequisites for gate 116 (read-only)
- Status: done
- Result: Read-only check; nothing created. **Not everything is present, so Q6 is blocked.**
  - **Settings › Setup** (portal `GET /api/setup` with an operator Access session, 08:38 UTC):
    **neither setup is complete.** Read (plan-7be023537ea46afe) and restore
    (plan-91167945a1d01ae0) both show `observed: false`, `run: null`, all steps
    `not-checked`. **No task-76 run ids exist.** The live DB has no `bootstrap_plan` or
    `bootstrap_event` tables (journal not set up). Note: the Collector already holds its
    read scopes in Entra (Q3 token roles), but no setup run was ever recorded.
  - **task-68 reconstruction:** can't run with a real authenticator today.
    `tools/recovery/reconstruct.mjs` refuses without an injected independent authenticator,
    and the only non-test one is `journeys.mjs:605` (`async () => true`, a fixture). No
    deployment authenticator is wired. It also needs a task-67 recovery manifest (none
    exists; see Q2), the config export, the evidence checkpoint, a disposable target DB and
    the 3 prerequisite refs.
  - `/etc/keel/tenant.json`: exists. `/etc/keel/restorer.json`: exists.
  - `KEEL_DB_TEST_URL` (from `/etc/keel/db.env`): `postgres://keel:***@127.0.0.1:5433/keel_test`.
    That's the `keel_test` database on the `keel-postgres` container (19 tables), not
    production `keel`. Note: same server as production, and `db.env` defines
    `KEEL_DB_TEST_URL` twice (same value).
  Blocking for Q6: complete read and restore setups with run ids (task-76), a deployment
  recovery authenticator, and a task-67 manifest (Q2).
- Needs: none
- Do: report each of the following, read-only. Create nothing.
  - Whether Settings › Setup shows the read and restore setups complete, and their
    task-76 run ids.
  - Whether a task-68 read-only reconstruction (`reconstructRecovery()`) can run with
    the deployment's real recovery authenticator, and what it needs.
  - Whether `/etc/keel/tenant.json` and `/etc/keel/restorer.json` exist.
  - Which `KEEL_DB_TEST_URL` the drill would use. Never the production database.

### Q6: Gate 116 (drill-live-acceptance)
- Status: blocked
- Result: Not started. Q5 found prerequisites missing: no completed setups or run ids, no recovery
  authenticator, no task-67 manifest. No drill was run and no `keel-rehearsal-*` group was created.
- Needs: Q5 done with everything present
- Do: follow `docs/roadmap/drill-live-acceptance.md` › Operator steps.
  - Run, in order: build-manifest, the offline plan check, then the live bounded drill.
    The drill creates and removes one `keel-rehearsal-<startAt>` group.
  - Then run `capture-drill` and `verify --require-live`.
  - If verify exits 0, commit both files to `claude/live-evidence-116`.
  - If the drill leaves a residual, report it right away. Don't clean up anything except
    that one `keel-rehearsal-*` group.

### Q7: Read-only inventory for the 120–123 decisions
- Status: done
- Result: Read-only; nothing created or granted. Reads used the Collector, except where marked
  (Restorer, GET only, because the Collector lacks the scope).
  - **Collector** (KEEL Collector, appId 87aa77c4…, SP f8741600…)
    - Graph (18): DeviceManagement{ManagedDevices,ServiceConfig,RBAC,Configuration,Apps}.Read.All,
      Policy.Read.PermissionGrant, Policy.Read.All, RoleManagement.Read.Directory, Group.Read.All,
      AdministrativeUnit.Read.All, EntitlementManagement.Read.All, Directory.Read.All,
      User.Read.All, Domain.Read.All, IdentityProvider.Read.All, AccessReview.Read.All,
      Organization.Read.All, Application.Read.All.
    - SharePoint Online: Sites.Read.All, TermStore.Read.All. Exchange Online: **Exchange.ManageAsApp**.
    - Directory roles: **Global Reader, Security Reader**.
  - **Restorer** (Keel Restorer, appId 12f8942f…, SP 8cd199c9…)
    - Graph (52 ReadWrite roles; full list in Q3), incl. TeamSettings.ReadWrite.All,
      TeamMember.ReadWrite.All, ChannelMember.ReadWrite.All, Sites.FullControl.All,
      Files.ReadWrite.All, MailboxSettings.ReadWrite, Directory.ReadWrite.All,
      Policy.ReadWrite.ConditionalAccess.
    - SharePoint Online: Sites.FullControl.All, TermStore.ReadWrite.All. Exchange Online: **Exchange.ManageAsApp**.
    - Directory roles: **Compliance Administrator, Compliance Data Administrator, Exchange
      Administrator, Intune Administrator, Knowledge Administrator, Security Administrator,
      SharePoint Administrator, Teams Administrator**.
    - Note for D-121b/D-122a/D-123a/D-123b: much of what those decisions ask about is
      **already granted** (the Teams write set, Exchange.ManageAsApp plus Exchange Admin,
      Compliance Admin, Sites.FullControl.All plus SharePoint Admin, all on the Restorer).
      The Collector already has Exchange.ManageAsApp but no Compliance or SharePoint admin role.
  - **`isResharingByExternalUsersEnabled` = false.** SPO admin REST (Restorer, GET):
    `PreventExternalUsersFromResharing: true`, `SharingCapability: 1`. The Graph
    `/admin/sharepoint/settings` call is 403 for both apps (no SharePointTenantSettings.Read.All),
    so a capture through Graph would need that scope. D-120's `--allow-widening-toggle` case applies.
  - **KEEL-RT communication site: none.** The KEEL-RT sites are
    `/sites/keel-rt-20260908-collaboration` (WebTemplate GROUP, the team site) and two
    TEAMCHANNEL sites (Finance Private, Partner Shared).
  - **Private KEEL-RT team: exists.** `KEEL-RT-20260908 Collaboration Hub`
    (9263e1d4-7494-4141-b1b6-2012c98a7543, Private). Members: alice, emma, hugo, maya, priya.
  - **keel-rt users not in that team: 13**: ben, carla, diego, farah, grace, iris, jon, kelly,
    liam, noah, olivia, quinn, ryan (`keel-rt-20260908-*@techinsiderbytes.com`, all enabled).
  - **keel-rt-20260908-alice:** `RetainDeletedItemsFor` = **14.00:00:00** (14 days),
    SingleItemRecovery on, no litigation hold (EXO admin API `Get-Mailbox`, Collector). OneDrive:
    **not provisioned** (Graph `/users/{id}/drive` returns 404 "User's mysite not found", Restorer GET).
  - **KEEL-RT labels/policies: none.** 13 labels and 1 label policy in the tenant; none
    named KEEL-RT* (`Get-Label`/`Get-LabelPolicy` via Connect-IPPSSession, Collector cert,
    throwaway container from the current image).
  - **PowerShell image:** `keel-powershell:latest` (231757b7ed3a, built 2026-09-08) has
    only `probe-workloads.ps1` and `run-job.sh` in `/app`. **`run-cmdlet.ps1` is missing**,
    though `ops/powershell/Dockerfile` copies it now. Q9 applies.
- Needs: none
- Do: report each of the following, read-only. Create and grant nothing.
  - The application permissions and directory roles each KEEL app (Collector, Restorer)
    has been granted.
  - The current value of SharePoint's tenant-wide `isResharingByExternalUsersEnabled`.
  - Whether these exist:
    - a `KEEL-RT-*` communication site;
    - a private `KEEL-RT-*` team;
    - a `keel-rt-*` user that isn't already a member of that team.
  - The deleted-item retention of `keel-rt-20260908-alice`, and whether that user has a
    provisioned OneDrive.
  - Whether any `KEEL-RT-*` sensitivity label or label policy exists.
  - Whether the KEEL PowerShell image includes `run-cmdlet.ps1`.

### Q8: Fixtures for 120 and 121 (decision-free parts)
- Status: done
- Result: Created only what Q7 found missing (Restorer app, SPO `Sites.FullControl.All`, 08:41 UTC):
  - **Communication site `KEEL-RT-20261004`**: https://lxtj.sharepoint.com/sites/KEEL-RT-20261004
    (WebTemplate SITEPAGEPUBLISHING, empty, ShareByEmail off). Site collection id
    cb253964-965b-42a8-b684-faaf83d1435d, web id 4eb9a131-7455-4f9d-bd6c-b33562be5cab, Graph id
    `lxtj.sharepoint.com,cb253964-965b-42a8-b684-faaf83d1435d,4eb9a131-7455-4f9d-bd6c-b33562be5cab`.
    App-only creation needs an owner; the owner is fixture user `keel-rt-20260908-ben` (not alice).
  - **Private team: not created.** It already exists: `KEEL-RT-20260908 Collaboration Hub`
    (group/team id 9263e1d4-7494-4141-b1b6-2012c98a7543, Private, site
    https://lxtj.sharepoint.com/sites/keel-rt-20260908-collaboration). Its name is dated 20260908, not
    today. If the 121 doc needs a `KEEL-RT-<today>` team, the coordinator should say so.
  - The 121 member account waits on D-121a. Candidates not in the team: ben, carla, diego, farah,
    grace, iris, jon, kelly, liam, noah, olivia, quinn, ryan (Q7).
- Needs: Q7 done
- Do: create only what Q7 found missing:
  - a `KEEL-RT-<yyyymmdd>` communication site;
  - a private `KEEL-RT-<yyyymmdd>` team.

  Report their URL and ids. The 121 member account waits on decision D-121a.

### Q9: Rebuild the KEEL PowerShell image
- Status: done
- Result: Rebuilt `keel-powershell:latest` from `ops/powershell/Dockerfile` at deployed build 33ad2a9.
  Context: a clean `git archive` of `ops/powershell`. Command: `docker build -t keel-powershell:latest .`
  (the tag `engine/powershell/jobQueue.mjs` DEFAULT_IMAGE uses). Build exit 0.
  - **New image id: `sha256:0af11b0f3f9a389f8ae03c42454ddecee652d364dd337f11a11b83e6d99e49f8`.**
    `/app` now has `run-cmdlet.ps1`, `probe-workloads.ps1` and `run-job.sh`.
    Modules: ExchangeOnlineManagement 3.10.1, MicrosoftTeams 7.9.0, PnP.PowerShell 3.4.1.
  - The previous image (231757b7ed3a, 2026-09-08) is kept as `keel-powershell:pre-q9` for rollback.
  - No services restarted or redeployed. Jobs use `docker run --rm` per job, so they pick up the
    new image on their next run. Note: `/opt/keel-deploy/deploy.sh` never builds this image, so it
    will go stale again after future `ops/powershell` changes. This needs an ops or deploy follow-up.
- Needs: Q7 shows `run-cmdlet.ps1` missing from the image
- Do: rebuild the image from `ops/powershell/Dockerfile` at the deployed build, the same
  way the deploy builds it. Don't restart or redeploy services beyond what the normal
  image rebuild does. Report the image id.

### Q10: Gates 120 → 121 → 122 → 123 (one sitting, same build) — issue #84
- Coordinator note (12:28 UTC): **#108 is merged as `248b12c`**. Once master CI is green and `/opt/keel-live` is
  deployed at `248b12c`, set this to in-progress and rerun 120 → 121 → 122 → 123 at that build, same pre-checks, with a
  fresh unpublished `KEEL-RT-<date>-label` for 123. Please poll every 5 minutes while this is queued or running.
- Coordinator note (12:20 UTC): thanks. Fix is PR #108 (`claude/purview-label-action-fields`): the capture lists the
  LabelActions fields Get-Label didn't return in `notQualifiedFields.label` and the verifier accepts only those.
  Keep this **blocked** until I add a note with #108's merge commit; then rerun 120 → 123 at that build once deployed
  (alice retention 19/30). Yes, create a fresh unpublished `KEEL-RT-<date>-label` just before 123 (D-123d); the anchor
  and policy stay. The 121 HTTP 400 on an owner-link DELETE: please paste its error body (no secrets) in the Result.
- Coordinator note (11:12 UTC): **#107 is merged as `4d8c1ec`**. Once master CI is green and `/opt/keel-live` is
  deployed at `4d8c1ec`, set this to in-progress and rerun 120 → 121 → 122 → 123 at that build, same pre-checks.
- Coordinator note (10:10 UTC): thanks for the clean-up and the clear diagnosis. Fix is PR #107
  (`claude/teams-member-link`): every restore read that shows carla in the group's members re-issues
  `DELETE /groups/{id}/members/{user}/$ref` (404 = gone), as #104 does for owners. Keep this **blocked** until I add a
  note with #107's merge commit; then rerun 120 → 123 at that build once deployed (alice retention 18/30).
- Coordinator note (09:15 UTC): **#106 is merged as `c3bd35d`**. Once master CI is green and `/opt/keel-live` is
  deployed at `c3bd35d`, set this to in-progress and rerun 120 → 121 → 122 → 123 at that build, same pre-checks.
- Coordinator note (09:10 UTC): thanks, right diagnosis again. Fix is PR #106 (`claude/purview-location-objects`): the
  fixture-only check reads an object location entry's `Name` (an object without one always fails). Keep this **blocked**
  until I add a note with #106's merge commit; then rerun 120 → 121 → 122 → 123 at that build once it is deployed
  (alice retention 18/30). Leave the 123 fixtures in place. The keel-powershell image rebuild waits until the chain passes.
- Coordinator note (08:10 UTC): **#105 is merged as `38979f6`**. Once master CI is green and `/opt/keel-live` is
  deployed at `38979f6`, set this to in-progress and rerun 120 → 121 → 122 → 123 at that build, same pre-checks.
- Coordinator note (07:40 UTC): thanks, clear diagnosis. Fix is PR #105 (`claude/pwsh-warning-stream`): `runJob`
  takes the last non-empty stdout line as the answer when the whole isn't JSON (earlier lines go to stderr), so it
  works with the normal deploy and **no image rebuild is needed** for 123. `run-cmdlet.ps1` also adds `3>$null`
  (applies at the next image rebuild; not required now). 120 @ d046168, 121 @ 64279c2 and 122 @ 897f412 (94ddb0a)
  are superseded once the chain reruns; don't merge them. Keep the 123 fixtures in place. When #105 is merged and
  `/opt/keel-live` is deployed at its merge commit, rerun 120 → 121 → 122 → 123 at that build (alice retention
  17/30; timeZone stays UTC).
- Coordinator note (06:35 UTC): thanks, 120 @ d046168 and 121 @ 64279c2 look right; I'll review them with 122/123.
  For 122, take **(b), one-time fixture prep**, as the coordinator's choice (it is a keel-rt fixture mailbox, so it
  is in scope; (a) would make the tool write a null back, which Graph may not accept, and (c) changes the fixture
  every other record names). Marouane can overrule in the thread.
  1. Restorer, Graph: `PATCH /users/keel-rt-20260908-alice/mailboxSettings { "timeZone": "UTC" }` and read it back.
     If Graph refuses because the mailbox's regional settings were never set, use EXO instead:
     `Set-MailboxRegionalConfiguration -Identity keel-rt-20260908-alice -TimeZone "UTC" -Language en-US
     -DateFormat "yyyy-MM-dd" -TimeFormat "HH:mm"` (only this mailbox), then re-read via Graph.
     Record the before (null) and after values in the Result. Touch no other mailbox or setting.
  2. Still at build `94ddb0a` with no deploy in between: rerun **122** (capture, then verify with 120 and 121
     beside it), then **123**. 120 and 121 don't need a rerun unless verify reports them stale; if it does, rerun
     the whole chain at `94ddb0a`.
  3. Retention will go to 16/30 days on this retry; that's fine. If 122 fails again, stop and report before a third
     retry.
- Coordinator note (05:45 UTC): **#104 is merged as `94ddb0a`** (no other open PRs). Once master CI is green and
  `/opt/keel-live` is deployed at `94ddb0a`, set this to in-progress and rerun 120 → 121 → 122 → 123 at that
  build, same pre-checks (carla absent from roster, group owners and group members before 121).
- Coordinator note (02:55 UTC): thanks for the clean-up and the timeline. Fix is PR #104
  (`claude/teams-owner-async`), your option (b): every restore read that shows carla as a group owner re-issues
  the owner-ref DELETE (404 = not yet), and if the read after the settle delay isn't clean the round repeats (at
  most 3 rounds of ~3 min poll + 20 s settle). `claude/live-evidence-120` @ 427633d (6fee591) is superseded once
  the chain reruns; don't merge it alone. When #104 is merged and `/opt/keel-live` is deployed at its merge
  commit, rerun 120 → 121 → 122 → 123 at that build, same pre-checks.
- Coordinator note (02:15 UTC): #101 and #102 merged too; **master is `6fee591` with no open PRs**. Run the chain at
  `6fee591` once master CI is green and it is deployed. Nothing else will merge until Q10 finishes.
- Coordinator note (02:10 UTC): master is now `c99a9f2` (#95, #96, #97, #99, #100 also merged). #101 and #102 are
  still open. Run the chain at the deployed head as below. Q24 (scheduler install, #97) and the other host items
  stay on hold until Q10 finishes, so nothing starts a worker or restarts the portal mid-chain.
- Coordinator note (02:05 UTC): master moved on after #103 (#98 as `76e503e`, #94 as `c4e24ac`), and more merges
  may follow. Run the chain at whatever master head `/opt/keel-live` is deployed at when you start (CI green for
  that commit), record that SHA, and don't let a deploy land mid-chain: if one does, stop and restart at the new
  build. Q30 (#92) doesn't start until Q10 finishes.
- Coordinator note (02:00 UTC, 2026-10-05): **#103 is merged as `5a7f58c`** (master CI running). Once master CI
  is green and `/opt/keel-live` is deployed at `5a7f58c`, set this to in-progress and rerun 120 → 121 → 122 →
  123 at that build. Same pre-checks as before (carla absent from roster, group owners and group members
  before 121). Don't run anything that restarts the portal while this runs.
- Coordinator note (22:35 UTC): thanks; the roster lag is fixed in PR #103 (`claude/teams-roster-settle`):
  removal read-backs and the final absent check now poll for up to ~3 min (37 × 5 s) before the 20 s settle
  delay. `claude/live-evidence-120` @ 12d3547 (df4082a) is superseded once the chain reruns; don't merge it on
  its own. When #103 is merged and `/opt/keel-live` is deployed at its merge commit, rerun 120 → 121 → 122 →
  123 at that build (same pre-checks as before).
- Coordinator note (21:45 UTC): **#83 is merged as `df4082a`** (on top of the operator's b81a41d). Once
  master CI is green and `/opt/keel-live` is deployed at `df4082a`, set this to in-progress and rerun
  120 → 121 → 122 → 123 at that build. Before 121, confirm carla is absent from the Teams roster, group owners
  and group members. Don't run anything that restarts the portal (Q24, Q27-style items) while this runs. When
  you set Status, message the coordinator thread.
- Coordinator note (13:50 UTC): the three URLs are fixed in PR #74 (`claude/fix-dead-doc-urls`).
  When #74 is merged and `/opt/keel-live` is deployed at or after its merge commit, set this back to
  in-progress and run 120 → 121 → 122 → 123 at that build. D-120b was given by the operator in your
  session (12:47 and 12:55 UTC).
- Coordinator note (14:30 UTC): #74 is merged. Master is `124fbc6` (#75 evidence merge `359ec7c`,
  then #74). Wait until `/opt/keel-live` is deployed at `124fbc6` (master CI must go green first), then
  set this to in-progress and run 120 → 121 → 122 → 123 at that build. Nothing else will merge to master
  until the chain is done.
- Coordinator note (18:00 UTC): thanks for catching the owner residual. The Teams tool fix is PR #83
  (`claude/teams-owner-restore`): it reads `/groups/{id}/owners` before writing, removes the fixture user's
  own owner link after the round trip (`DELETE /groups/{id}/owners/{user}/$ref`, restorer), and decides the
  restore from roster + group owners + group members read after a 20 s settle delay. Confirm carla is absent
  from all three before you run. `claude/live-evidence-121` @ 9ec0e2f is void and won't be merged. When #83
  is merged and `/opt/keel-live` is deployed at its merge commit, rerun 120 → 121 → 122 → 123 at that build
  and message the coordinator thread.
- Coordinator note (17:13 UTC): #82 is merged as `ffa05cd`. Once `/opt/keel-live` is deployed at `ffa05cd`, set this
  to in-progress and rerun 120 → 121 → 122 → 123 at that build, then message the coordinator thread.
- Coordinator note (16:50 UTC): the 122 org-tenant check is fixed in PR #82 (`claude/exchange-tenant-proof`):
  when `ExternalDirectoryOrganizationId` is empty, the collector Graph token's `tid` stands in (recorded as
  `organization.tenantIdSource: collector-token`). The CLI reads `tid` from `KEEL_EXCHANGE_COLLECTOR_TOKEN`
  and `KEEL_EXCHANGE_RESTORER_TOKEN` itself; no new flag. Master also moved to 34f550b (#78, #79) after your
  2b2c338 run, so 120 and 121 must be recaptured anyway. When #82 is merged and `/opt/keel-live` is deployed
  at its merge commit, rerun 120 → 121 → 122 → 123 at that build. **When you set Status, also send the
  coordinator thread a one-line note** so the result is picked up straight away.
- Coordinator note (15:22 UTC): #77 is merged as `2b2c338`. Once `/opt/keel-live` is deployed at `2b2c338`,
  set this to in-progress and rerun 120 → 121 → 122 → 123 at that build (120 recaptured).
- Coordinator note (15:05 UTC): the 121 tenant check is fixed in PR #77 (`claude/teams-tenant-proof`):
  when Graph omits the team's `tenantId`, the collector token's `tid` stands in (recorded as
  `tenantIdSource: collector-token`). The CLI reads `tid` from `KEEL_TEAMS_COLLECTOR_TOKEN` and
  `KEEL_TEAMS_RESTORER_TOKEN` itself; no new flag. When #77 is merged and `/opt/keel-live` is deployed at
  its merge commit, rerun 120 → 121 → 122 → 123 at that build (120 recaptured).
- Status: done
- Result: **Done: all four gates verified at one build, 248b12c (PR #108).** `/opt/keel-live` = master = 248b12c (clean,
  deployed 12:36 UTC), unchanged throughout. Grants unchanged; all 25 doc URLs 200; carla absent before 121.
  | Gate | Branch @ commit | Capture | verify --require-live --build 248b12c (all four records side by side) |
  |---|---|---|---|
  | 120 SharePoint | `claude/live-evidence-120` @ **60683a5** | exit 0 | ok, exit 0 |
  | 121 Teams | `claude/live-evidence-121` @ **211a372** | exit 0 | ok, exit 0 |
  | 122 Exchange | `claude/live-evidence-122` @ **da8a341** | exit 0 | ok, exit 0 |
  | 123 OneDrive/Purview | `claude/live-evidence-123` @ **eeac328** (new) | exit 0 | ok, exit 0 |
  - Each branch holds only its gate's two files; they supersede all earlier records on 120–122. Each record verifies
    only with the earlier gates' records beside it, so **merge the four together**. The branches were cut from
    different master commits (124fbc6, 2b2c338, 94ddb0a, 248b12c); only the evidence files differ.
  - Evidence secret-scanned (HMAC key, JWT, PEM, bearer, DB URL): clean.
  - **Tenant state after the chain:**
    - SharePoint `isResharingByExternalUsersEnabled` back to false ("isResharingByExternalUsersEnabled": false).
    - Team 9263e1d4: carla absent from roster, owners and members (5 checks 12:37–12:40). The 121 record notes one
      intermediate "member link removal failed (HTTP 400)", but the restore verified.
    - alice mailbox: timeZone **UTC**, PopEnabled restored, retention **19.00:00:00** (D-122d).
    - Purview: `KEEL-RT-20261005-label2` (created 12:30 for this run, D-123d) is now published by
      `KEEL-RT-20261005-policy` (scoped to alice only) with its Comment restored. Fixtures KEEL-RT-20261005-anchor,
      -label, -label2 and -policy remain.
  - Earlier attempts and their hand cleanups are in the vault daily log (2026-10-04/05).
- Needs:
  - Q8 done;
  - Q9 done (or not needed);
  - decisions D-120, D-121a, D-121b, D-122a to D-122d and D-123a to D-123d filled in
    below.
- Do: for each gate in order, follow the doc's Operator steps:
  - run `plan` (offline) first;
  - then `capture`;
  - then `verify --require-live`;
  - commit each gate's files to `claude/live-evidence-<task>`.

  Stop at the first failure. Do only what the filled decisions allow.

  - Coordinator note (12:55 UTC): Q10 reviewed, evidence combined in PR #110 for Marouane to merge. Released Q34, Q30,
    Q33, Q26, Q24 and Q31 to queued; please work them **in that order** (Q34 feeds #109). Q29 follows Q24, Q32 follows
    Q33. Poll every 5 minutes and write each Result as soon as an item finishes.

### Q11: Build a recovery set for gate 114 (new tool from PR #70)
- Status: done
- Result: **Recovery set made: `/opt/keel-recovery-sets/2026-10-04/`** (66 MB, root-only dirs). Made by
  `ops/keel-recovery-set.mjs` from a detached worktree at deployed **df0de36**. Dry run first
  (exit 0), then the real run (exit 0).
  - Source: `/opt/backups/2026-10-04/keel-db.sql.gz` (nightly 04:04 UTC) and
    `/opt/backups/keel-db-manifest.json`. Only read; nothing in `/opt/backups` changed.
  - The set was made at 09:09, not right after the backup. Consistency check: the live
    `evidence_head` was last updated 2026-10-03 15:50 with 0 evidence rows since the dump, and
    `schema.sql` is identical across 61e21af (the dump's build) → df0de36. So the dump, schema
    pin and head agree.
  - `recovery-set.json`:
    - build `df0de3616841301bc0c596a4ba788996cc32ba1b`, schema pin `2a20d4ae…2e34fb`;
    - tenant `sha256:f7b3959300856957`, snapshot `f74b0fac-a1ee-4f94-9cd2-d889e98dae55` (22 observation ids);
    - **evidence head `2:90e032c183f167c2520ca0bcb40789ebae8fd97de35f5b4f518bc7dcecc48ebf:2`**;
    - sha256: manifest `80231c6d…7e35e3`, dump `429bdf53…698ef1` (= the nightly checksum),
      export manifest `d0ad81cf…00227e`.
  - `keel-dump-manifest.mjs --verify` on the set: "verified … (recovery complete)", exit 0.
  - **Key metadata** (references only; `/root/keel-key-metadata.json`): the dump is gzip only, with
    no encryption key on the host. So I recorded what recovery actually needs:
    - instructions: `ops/recovery-runbook.md`, and that the dump is unencrypted;
    - heldBy: "KEEL operator (root on the Hetzner VPS)";
    - location: `/etc/keel/db.env` (Postgres credential) and `/root/.ssh/playground_vps` (offsite
      SSH key), plus "no separate offline copy exists yet".
    The operator may want a real offline-held reference instead.
  - Not copied anywhere. Q2 stays blocked until a real second volume is attached. Then resume Q2
    Part B with this set (`--primary-root /opt/keel-recovery-sets/2026-10-04`, checkpoint from
    the evidence head above, capture from a df0de36 checkout).
- Needs:
  - `/opt/keel-live` at or after df0de36 (PR #70 merged; it adds `ops/keel-recovery-set.mjs`);
  - run from a checkout at the deployed build.
- Do:
  1. Run `ops/keel-recovery-set.mjs --dry-run` against the newest `/opt/backups/<date>/keel-db.sql.gz`.
     Follow `docs/roadmap/storage-live-acceptance.md` › Operator steps.
  2. Then run it for real with `--out /opt/keel-recovery-sets/<date>`. Make the set right after a
     nightly backup if you can, because the evidence head comes from the live DB.
  3. Key metadata is references only (where material lives and who holds it), never key
     material. Use what actually exists on the host, and say in Result what you used.
  4. Report the summary (`recovery-set.json`: build, tenant ref, evidence head, digests).
- Don't copy the set to a "separate volume" on the same disk. Q2 stays blocked until the operator
  attaches a real second volume. When one exists, resume Q2 Part B with this set.

### Q12: Report how the deploy builds images (read-only)
- Status: done
- Result: Read-only. Script not changed; no secrets printed.
  **How it works today:** `keel-deploy.timer` runs `/opt/keel-deploy/deploy.sh` 5 minutes after the
  previous run ends (oneshot, `TimeoutStartSec=20min`, `flock` against overlap). Each run:
  1. `git fetch` in `/opt/keel-live`. If origin/master equals HEAD, it exits. If
     `/var/lib/keel-deploy/failed/<sha>` exists, it skips.
  2. **CI gate:** the newest `portal.yml` push run on that exact sha must be completed/success.
     portal.yml runs on every master push with no path filter, so ops-only commits are gated too.
  3. Refuses if the live tree has local edits (other than `portal/next-env.d.ts`), or if the
     `engine/store/schema.sql` diff adds DROP/TRUNCATE/DELETE.
  4. `build_at`: `git checkout --detach <sha>`, `npm ci` in engine, `npm ci && npm run build` in portal.
  5. If schema.sql changed: `pg_dump` to /root/backups/keel-deploy (keeps 5). Then it **always**
     applies schema.sql in one transaction.
  6. `systemctl restart keel-portal`, then polls `/api/health` (20 × 3s).
  7. Any failure: rollback (rebuild + restart the previous sha, mark the target failed, post a
     GitHub status, notify vps-deployer).
  **What it builds or restarts:** only the Node trees (engine, portal) and the `keel-portal` unit.
  It **never builds any Docker image** and never touches other units. Note: no `keel-worker`,
  `keel-scheduler` or `keel-backup-tier*` units from `ops/` are installed on the host (only
  keel-portal, keel-deploy and keel-status-generate).
  **Can a `keel-powershell:latest` rebuild be added safely? Yes**, with these constraints:
  - Gate on `git diff --quiet "$CURRENT" "$TARGET" -- ops/powershell` so it runs only on change.
  - Build from the checked-out tree, after `build_at` and before the restart, to a staging tag:
    `docker build -t keel-powershell:candidate ops/powershell`. On success, tag the current
    `:latest` as `:previous`, then `:candidate` as `:latest`. Nothing runs long-lived from the
    image (`jobQueue.mjs` uses `docker run --rm` per job), so retagging needs no restart;
    in-flight jobs finish on the old image.
  - `rollback()` must also restore `:previous` → `:latest`. Otherwise a rolled-back portal is paired
    with a newer image.
  - The build pulls modules from PSGallery or the network (about 1–2 min here). A transient
    failure should probably be fatal (rollback, so code and image stay consistent), or at least
    call `agent` loudly. It fits within the 20-minute unit timeout.
  - Prune afterwards (`docker image prune -f` for dangling layers): `/` is 87% used (13 GB free).
  FYI: deploy moved `/opt/keel-live` to **df0de36** (PR #70) at 09:07:28 UTC today.
- Needs: none
- Do: report how `/opt/keel-deploy/deploy.sh` decides what to build and restart, without printing
  secrets. Say whether a step that rebuilds `keel-powershell:latest` when `ops/powershell/**`
  changes could be added safely. Don't change the script; the coordinator will propose the
  change.

### Q14: What running the Settings › Setup flows would do (read-only report)
- Status: done
- Result: Read-only (code at deployed df0de36 plus a GET of the live `/api/setup`). Nothing was run.
  **Bottom line: on this deployment, running either Setup flow does nothing to the tenant and
  records no run.** `portal/lib/setup-host.ts` `setupHost()` returns `NO_SETUP_HOST`
  (readers, adapters, credentials and build all null), and the repo ships no implementation. Live
  `/api/setup` reports `canCheck: false, canProvision: false`. `POST /api/actions/setup`
  (`portal/lib/action.ts:597ff`) therefore returns **409 `provisioning_unavailable`** right after
  the auth checks (configuration + approve, recorded as an attempt). That happens before
  `migrateBootstrapJournal`, so not even the `bootstrap_plan`/`bootstrap_event` tables get
  created. `cli/keel-bootstrap.mjs` supports offline `--mode plan --fixture` only.
  **What a run would do if a host supplied qualified adapters** (`engine/bootstrap/execute.mjs`):
  - Plan steps (live GET):
    - read (entra-collect, intune-collect): `registration` collector create-registration
      (keel-collector, 6 scopes); `graph-permission` grant-consent (admin consent for those 6
      scopes); `workload-rbac` Intune "Read Only Operator" (**manual**);
      `keel-app-permission` keel.collect.
    - restore (entra-restore): `registration` keel-restorer (3 scopes); `graph-permission`
      grant-consent; `pim-activation` Privileged Role Administrator (**manual**);
      `keel-app-permission` keel.restore.
  - Flow: approve (`approveBootstrapPlan`: checks the plan intent against a fresh derivation,
    needs separate collector/restorer reference-only credentials and the kill switch off, then writes
    `bootstrap_plan`). Execute: manual steps are observed first and stop as `pending-manual` if
    unsatisfied. Then each step is desired, observed, and if not satisfied, qualified (a restorer
    credential qualified for that op/build) and `adapters.ensure()`, then re-observed and verified.
    Finally everything is re-observed and the run is `complete`.
  - **Tenant effects, through the adapters only:** it **would create app registrations and service
    principals** (create-registration), **grant admin consent / app-role assignments**
    (grant-consent), and configure KEEL-side app permissions. It doesn't itself assign Entra roles
    or activate PIM (manual: it waits for the operator). No tenant-wide settings are in the step
    kinds. Graph calls are adapter-defined and none exist in the repo. Observations persist only
    object, app and service-principal ids.
  - **Records:** the task-76 "run id" is the approval's `artifact_id` in `bootstrap_plan`, with per-step
    events in `bootstrap_event`. `complete`, `stopped` or `pending-manual` are the run states the
    page and Q5/Q6 need.
  - Note: since KEEL Collector/Restorer already exist with consent, a qualified host would mostly
    observe "satisfied" and journal it, except the Restorer's 52-role grant set vs the plan's 3
    scopes, which it wouldn't reduce.
  **Consequence for Q6/116:** task-76 run ids can't exist until a deployment supplies readers,
  adapters and credentials to `setupHost()`. That's a code or deploy change, not an operator step.
- Needs: none
- Do: read-only. Report what the read setup and the restore setup would actually do if run from
  the portal:
  - which Graph or Entra calls each makes;
  - whether either would create apps, grant permissions or consent, or change tenant settings;
  - what it records (task-76 run ids).
  Use the code in `engine/bootstrap/` and the portal Setup routes. Run nothing.

### Q15: Mount the new second volume, then resume Q2 (gate 114) Part B
- Status: done
- Result: Volume `/dev/disk/by-id/scsi-0HC_Volume_107029601` (= /dev/sdb, ext4 UUID
  4a0c67f6-c1be-4cb3-9232-fd7c19e62776, 97.9G) was already formatted and Hetzner had auto-mounted it
  at `/mnt/HC_Volume_107029601`, with fstab line 13. It was empty (only `lost+found`). No mkfs.
  **Changed that existing fstab entry's mount point** (no duplicate added; backup
  `/etc/fstab.bak-q15-*`) to
  `/dev/disk/by-id/scsi-0HC_Volume_107029601 /mnt/keel-copy ext4 discard,nofail,defaults 0 0`.
  Then unmounted the old path, removed the empty directory, `daemon-reload` and `mount -a`.
  `findmnt -D`: `/dev/sdb ext4 97.9G at /mnt/keel-copy`, a different filesystem from `/dev/sda1`
  (`/`, which holds `/opt/backups` and `/opt/keel-recovery-sets`).
  Q2 Part B resumed and is **done**: see Q2 (`claude/live-evidence-114` @ 4b1d3da, verify ok, exit 0).
- Needs: none. The operator created and formatted the volume (ext4) at
  `/dev/disk/by-id/scsi-0HC_Volume_107029601`.
- Do:
  1. Check that it's ext4 and empty (`blkid`, `lsblk -f`). Don't run mkfs again.
  2. Mount it at `/mnt/keel-copy` with a persistent fstab entry, using
     `/dev/disk/by-id/scsi-0HC_Volume_107029601 /mnt/keel-copy ext4 discard,nofail,defaults 0 0`
     (or its UUID). Then `mount -a`, and confirm with `findmnt -D` that it's a different
     filesystem from the one holding `/opt/backups` and `/opt/keel-recovery-sets`.
  3. Resume **Q2 Part B** with the Q11 set (`/opt/keel-recovery-sets/2026-10-04`, built at df0de36):
     - create `keel-recovery`;
     - copy the set to `/mnt/keel-copy/2026-10-04`, read-only for that account;
     - capture as `keel-recovery` from a checkout at the build the set was made with;
     - run `verify --require-live`;
     - commit to `claude/live-evidence-114`.

     Set Q2's Status and Result as you go. Use the evidence head recorded in Q11.

### Q16: Locate the ServiceNow dev instance and inventory gate 118 prerequisites (read-only)
- Status: done
- Result: Done. Instance **`https://dev426571.service-now.com`**. Credentials: `/etc/keel/servicenow.env`
  (root 0600): `SERVICENOW_INSTANCE_URL`, `SERVICENOW_OAUTH_CLIENT_ID`/`_SECRET`, and
  `SERVICENOW_ADMIN_USER`/`_PASSWORD` (added by the operator 11:21 UTC). Working auth: **OAuth
  `password` grant** (inbound client plus admin). `client_credentials` and basic auth both return 401.
  - **`glide.installation.production` read `true`.** The operator stated in session (11:22 UTC):
    "it is not a production system; it's a dev instance", and explicitly authorized me to set it to
    `false` (the gate's verifier refuses `true`, `servicenowAcceptance.mjs:115`). **Changed:**
    `sys_properties` d245a2a7c61122c200eb1327535071bf `glide.installation.production` from
    `true` to `false` (re-read: false). Nothing else changed. The operator also confirmed D-118 in
    session (dev instance, host above).
  - Inventory (all **missing**):
    - no `u_keel_*` table (so no non-default workflow table and no `u_keel_callback_relay`);
    - no `x_keel.*` property;
    - no business rule named like keel;
    - no `keel*` users;
    - host: no adapter config, no `servicenow-test-users.json`, no `docs.json`, no
      `…_qualification` DB.
    - `servicenow.mjs check` not run (no config yet).
- Needs: none
- Do: read-only. The operator says a ServiceNow developer instance already exists and is reachable
  from this VPS. Find it and report, naming paths and variable names only, never values:
  - the instance host, and where its credentials live (expected `/etc/keel/servicenow.env`;
    otherwise search `/etc/keel`, `/root` and the vault notes for the host name);
  - one authenticated GET of `sys_properties?name=glide.installation.production`: its value must
    be `false`; if it is `true` or unreadable, stop and report;
  - for each item in `docs/roadmap/servicenow-live-acceptance.md` › Operator steps, whether it
    exists: a non-default workflow table, the KEEL adapter config file, the
    `u_keel_callback_relay` table, the `x_keel.callback_signing_key_b64` property, the
    `keel-callback-relay` business rule, two non-person test users with their own tokens, a
    `…_qualification` KEEL database, and `docs.json`;
  - if an adapter config exists, the result of
    `node tools/qualification/servicenow.mjs check --config <file>` (offline).

### Q17: Set up the missing gate 118 pieces in the ServiceNow dev instance
- Status: done
- Result: **Done.** The operator created the two ACLs in the UI (12:20 and 12:23 UTC): `u_keel_change`
  read and write, role `u_keel_change_user`. Re-check on a probe record:
  - keel-rt-sn-one: GET 200; PATCH `u_state=gate_passed` returns 200 with `u_approver=keel-rt-sn-one`.
  - keel-rt-sn-two: PATCH `gate_withdrawn` returns 200 with `u_approver=keel-rt-sn-two`.
  - Two relay rows were written (mod 1 and 2). Probe and relay rows deleted.

  Setup (unchanged from the earlier result):
  **Almost done; blocked on one manual step: two ACLs.** D-118 was confirmed by the operator in
  session, 11:22 UTC. Created in **dev426571** (admin via OAuth password grant):
  - table **`u_keel_change`** ("KEEL qualification change", sys_id ddd2b3dc…e3b4), string fields
    `u_title`, `u_state` (40), `u_approver` (100), `u_plan_rev`, `u_plan_hash`, `u_keel_request`,
    `u_keel_decision` (255). Non-default states: approved `gate_passed`; rejected `gate_blocked`,
    `gate_withdrawn`. Not `change_request`.
  - table **`u_keel_callback_relay`** (4a53f390…e3fc): `u_record` (64), `u_signature` (255),
    `u_body` (8000).
  - property **`x_keel.callback_signing_key_b64`** (password2, 92e3ffd0…e362) = base64 of the
    secret.
  - business rule **`keel-callback-relay`** (f9343b14…e3cd): after update on u_keel_change, condition
    `current.u_state.changes()`, script = `ops/servicenow/keel-callback-relay.js` with FIELDS =
    u_state/u_approver/u_plan_rev/u_plan_hash.
  - business rule **`keel-qualification-approver`** (6724f714…e39f): before update, same condition,
    `current.u_approver = gs.getUserName()`. This is the doc's step 1 "approver field that the
    workflow sets to the deciding user". `sys_updated_by` would be overwritten by KEEL's own
    write-back in the lost-callback and duplicate scenarios.
  - role **`u_keel_change_user`** (d18337d0…e30e). Test users **`keel-rt-sn-one`** (6f9337d0…e37a)
    and **`keel-rt-sn-two`** (32a33f90…e38b): "KEEL RT / ServiceNow test N", no email, not people,
    with that role.
  - Also changed (Q16): `glide.installation.production` set to false, as the operator authorized.
  - **Probe:** an admin PATCH on a probe record set u_approver, the relay row was written, and **its
    signature matches a local HMAC-SHA256 with the KEEL secret**. So the password2 property,
    `generateMac` and the base64 key are proven. The probe record and relay row were deleted.
  Host (all root 0600; nothing printed or committed):
  - `/etc/keel/servicenow-qualification.env`: `KEEL_SN_TEST_USER_ONE_PASSWORD`,
    `KEEL_SN_TEST_USER_TWO_PASSWORD`, `KEEL_SN_CALLBACK_SECRET`,
    `KEEL_SERVICENOW_QUALIFICATION_DB_URL`.
  - `/etc/keel/servicenow-qualification/`: `servicenow-config.json` (tokenRef
    `env:KEEL_SN_TOKEN`, secretRef `env:KEEL_SN_CALLBACK_SECRET`), `servicenow-test-users.json`
    (`env:KEEL_SN_TEST_USER_ONE` / `_TWO`), `record-template.json` (`u_title`; the table has no
    short_description), `docs.json` (Table API page HTTP 200, retrieved 11:34Z; refreshed at
    capture).
  - Bearer tokens (KEEL = admin, test users = their own) are minted by password grant at capture
    time into those env vars.
  - Postgres: new empty DB **`keel_servicenow_qualification`** (0 tables; the capture applies the
    schema). Not production.
  - `servicenow.mjs check`: ok, `problems: []`, exit 0. `servicenowLive.mjs plan`: exit 0. The only
    refusals are `--confirm-non-production-instance` and `--declared-by`, which the capture passes.
  **Blocker:** the test users get **404 "ACL restricts the record retrieval"** on u_keel_change.
  The API created the table without ACLs, and inserting `sys_security_acl` via REST returns 403
  (needs an elevated security_admin session, UI only). I won't work around that control.
  **Operator, in the dev426571 UI** (elevate security_admin; System Security › Access Control › New),
  create two ACLs: Type `record`, Name `u_keel_change` (field: none), Operation **read**, then
  **write**, Requires role **`u_keel_change_user`**. Then I'll check the test-user PATCH and run Q18.
- Coordinator note (11:40 UTC): the operator reports "we fixed servicenow", i.e. the two
  `u_keel_change` ACLs (read, write; role `u_keel_change_user`) should now exist. Re-check: as each
  test user, GET and PATCH a probe record (delete it after). If both work, mark Q17 done and go
  straight on to Q18. If not, mark blocked again with the exact error.
- Previous status: blocked
- Needs: Q16 done, with `glide.installation.production=false`; decision D-118
- Do: create only what Q16 reported missing, in the dev instance and on the host, following
  `docs/roadmap/servicenow-live-acceptance.md` › Operator steps 1–5. Rules:
  - Instance objects only: a custom `u_keel_*` table (never the stock `change_request`),
    the relay table, the signing property, the business rule from
    `ops/servicenow/keel-callback-relay.js`, and two test users named `keel-rt-sn-*` that
    are not people.
  - Secrets (OAuth tokens, signing key) go only in root-only env files under `/etc/keel/`
    and are referenced as `env:` refs; never printed, logged or committed.
  - The qualification database is a new, empty `keel_servicenow_qualification` database,
    never the production KEEL database.
  - Report each object created and each file path written. Then run `servicenowLive.mjs plan`
    (offline) and report its output.

### Q18: Gate 118 (servicenow-live-acceptance)
- Status: done
- Result: **Done.** `claude/live-evidence-118` @ 4ec37c1 (from origin/master 87e366e). Build **87e366e** =
  `/opt/keel-live`, unchanged during the capture (12:24–12:25 UTC).
  `verify --require-live --gate servicenow-live-acceptance --tenant sha256:f7b3959300856957`:
  `{"ok": true, "failures": []}`, exit 0.
  - Capture run from a worktree at 87e366e (engine `npm ci`), with
    `--confirm-non-production-instance dev426571.service-now.com`, `--declared-by "Marouane"`, the
    configs in `/etc/keel/servicenow-qualification/`, `--record-template` and fresh `docs.json`.
    KEEL and each test user used their own bearer token (OAuth password grant, minted into env at run
    time, never written). Exit 0.
  - Scenarios (all as designed):
    - **callback-duplicate**: mirrored, read-back match; callback applied ×2 (second idempotent);
      decision delivered.
    - **lost-callback**: callback withheld; poll applied; late callback `already-decided`.
    - **conflict**: portal rejected first; instance approval gives callback `conflict`; conflict delivered.
    - **revoked-approver**: grant revoked; callback `refused-not-eligible`.
  - Instance writes: 4 `u_keel_change` records plus their relay rows (left in place; deletable), and 4
    test-user approvals. Qualification DB `keel_servicenow_qualification`: schema, principals, 4
    approval requests, 2 placeholder jobs (nothing runs them), and one revoked grant (test user 2).
    Production KEEL DB untouched.
  - Evidence scanned for every env-file secret, the base64 key, JWT/PEM/bearer patterns and DB URLs:
    none found.
- Needs: Q17 done; decision D-118
- Do: run the capture and verify exactly as in `docs/roadmap/servicenow-live-acceptance.md`
  › Capture and Verify, at the build `/opt/keel-live` is deployed at, with
  `--confirm-non-production-instance <host from Q16>` and `--declared-by "Marouane"`.
  Push the record and its `.capture.json` to `claude/live-evidence-118`. If `/opt/keel-live`
  moves mid-capture, stop and report.

### Q19: Make Settings › Setup able to check the tenant after PR #73 deploys
- Status: done
- Result: **Done** at deployed 2e8a5b9 (PR #73).
  1. `keel-portal` (systemd) loads `EnvironmentFile=/etc/keel/db.env` and `/etc/keel/portal.env`.
     Neither set `KEEL_COLLECTOR_CONFIG_PATH` nor `KEEL_RESTORER_CONFIG_PATH`. Neither default
     exists (`/etc/keel/tenant-target.json`, `/etc/keel/restorer-target.json`), nor does `/etc/keel/setup.json`.
  2. Backed up `/etc/keel/portal.env` as `portal.env.bak-q19-*`. Appended
     `KEEL_COLLECTOR_CONFIG_PATH=/etc/keel/tenant.json` and
     `KEEL_RESTORER_CONFIG_PATH=/etc/keel/restorer.json`, then restarted `keel-portal` (health ok).
     Nothing else changed; **no setup.json created**. Note: the same two variables also feed the
     restore dry-run route's worker paths (`portal/lib/restore-config.ts`).
  3. `GET /api/setup`: **`canCheck: true`, `canProvision: true`** (expected false). Why: the
     composed host has readers, adapters, credentials and build, so a run can be *started*. But with
     no setup.json, `operations` is `{}`, so `qualify()` returns null and `ensure()` throws for every
     write; `create-registration` and `configure-keel-permission` are always refused
     (`engine/bootstrap/graphHost.mjs`). **No tenant write is possible.** A Setup run now observes and
     journals: it creates `bootstrap_plan`/`bootstrap_event` and gets a run id, then stops at
     pending-manual or at the first unqualified write.
     - Live check now: read scope `observed: true`, keel-collector, consent and keel.collect
       **done**, Intune "Read Only Operator" `not-checked`.
     - Restore scope `observed: true`, keel-restorer, consent and keel.restore **done**, Privileged
       Role Administrator (PIM) `waiting-for-you`.
- Needs: PR #73 merged (**merged 13:34 UTC as `2e8a5b9`**) and `/opt/keel-live` deployed at or after that commit
- Do: PR #73 builds the setup host from the Collector and Restorer credential files. It finds
  them at `KEEL_COLLECTOR_CONFIG_PATH` (default `/etc/keel/tenant-target.json`) and
  `KEEL_RESTORER_CONFIG_PATH` (default `/etc/keel/restorer-target.json`, which does not exist on
  this host; the Restorer file is `/etc/keel/restorer.json`). If either is missing, Setup stays
  "provisioning unavailable".
  1. Read-only: report which of those env vars the `keel-portal` service sets, and whether both
     default paths exist (names and paths only).
  2. If the Restorer path doesn't resolve, add `KEEL_RESTORER_CONFIG_PATH=/etc/keel/restorer.json`
     (and the collector path if needed) to the portal's env file, back the file up first, and
     restart `keel-portal`. Change nothing else; don't create `/etc/keel/setup.json`, so every
     write operation stays disabled.
  3. Report `canCheck` and `canProvision` from a GET of `/api/setup`. Expected: `canCheck: true`,
     `canProvision: false`.

### Q20: Gate 116 recovery key: generate and enroll (operator-directed)
- Status: done
- Result: **Done** with the deployed build 2e8a5b9 tools (sandbox shortcut per the PR #72 review: the private
  key is on this server).
  - Key pair: `/root/keel-recovery-key/` (dir 0700). `officer.pem` is the private key (0600, root;
    never printed, logged or committed). `officer.pub.pem` is the public key (0644).
  - **Key id `officer-2026-10`**, principal `recovery-officer@keel.local`. **Public key fingerprint
    (sha256 of officer.pub.pem): `47854c27116f850a6e80a5e4286126aea39b01b490f7286abb995538b344a8f6`.**
  - Trust store: **`/etc/keel/recovery-authenticators.json`** (root:root 0644): version 1, one
    principal (recovery-officer@keel.local / officer-2026-10).
  - Replay dir: **`/var/lib/keel/recovery-replay`** (0700).
  - Backup-path check: none of `/root/keel-recovery-key`, `/etc/keel` or `/var/lib/keel` is a
    source of any backup job.
    - `mimule-backup` (`/opt/mimoun/backup.sh` writes to `/opt/backups`): newsbites content,
      `/opt/mimoun/openclaw-config`, mimule scripts, the Caddyfile, the paperclip and keel DB dumps,
      `/opt/keel` ops/ and cli/, and named systemd unit files.
    - `keel-offsite`: ships only the keel DB dump.
    - `keel-backup-tier1-3` and `keel-prune`: KEEL collection and pruning, no file backups.
    - Recovery-set builder (`ops/keel-recovery-set.mjs`) inputs: the dump, the dump manifest,
      `tenant.json` (read only, not copied), and key metadata. It writes only into its `--out`.
    - **Correction:** `/root` is a git work tree (`7empes7s/mimule`). Both PEMs were already
      ignored by its `.gitignore` `*.pem`. I added `/keel-recovery-key/` and `/keel-key-metadata.json`
      (Q11) to `/root/.git/info/exclude` (local only; the repo is unchanged), so `git status` shows
      neither. `/etc/keel` is not in any git work tree.
  - No assertion signed and no reconstruction run (that's Q6).
- Needs: none (the recovery authenticator from PR #72 is already deployed)
- Operator instruction: Marouane, project chat 2026-10-04 13:37 UTC: "Send 3 to the operator to do"
  (item 3 = generate and enroll the gate 116 recovery key). Sandbox shortcut accepted in PR #72's
  review: the private key lives on this server instead of an offline machine.
- Do: follow `docs/roadmap/keel-recovery.md` › Operator steps 1–2 at the deployed build:
  1. `install -d -m 700 /root/keel-recovery-key`, then
     `node tools/recovery/recovery-assertion.mjs keygen --private-out /root/keel-recovery-key/officer.pem --public-out /root/keel-recovery-key/officer.pub.pem`
     and `chmod 600` the private key. It must stay outside every backup path, git, evidence and logs.
     Never print it.
  2. `node tools/recovery/recovery-assertion.mjs enroll --principal recovery-officer@keel.local --key-id officer-2026-10 --public-key /root/keel-recovery-key/officer.pub.pem --trust-store /etc/keel/recovery-authenticators.json`
     (root-owned, mode 644, outside the backup set), then `install -d -m 700 /var/lib/keel/recovery-replay`.
  3. Check that neither `/root/keel-recovery-key` nor the trust store is under any backup source path
     (`/opt/backups`, the recovery-set builder's inputs). Report the paths, the key id and the public
     key's fingerprint (sha256 of the public PEM), never the private key.
  Don't sign an assertion or run a reconstruction yet; that's Q6, after the Setup run.

### Q21: Re-check gate 116 prerequisites now that Setup and the recovery key exist (read-only)
- Status: done
- Result: Read-only at deployed 2e8a5b9; nothing written, no Setup run started.
  - **Run ids needed:** two task-76 runs, one read setup and one restore setup, both ending **`complete`**.
    `capture-drill`/verify require `onboarding.readSetup === 'complete'` and `restoreSetup === 'complete'`
    plus both run ids (`tools/release/qualification.mjs:519-522`). **A `pending-manual` run is not
    accepted.** The run id is the `bootstrap_plan.artifact_id`; I can read it from the DB afterwards.
  - **Collector read grants:** already held: `Application.Read.All`, `RoleManagement.Read.Directory`,
    `DeviceManagementRBAC.Read.All`. Intune role definitions read OK (200). Nothing to grant.
  - **Why the manual steps don't pass today:**
    - Intune "Read Only Operator": the KEEL Collector SP is in **no group** (`transitiveMemberOf` is
      empty), so it holds no Intune role assignment.
    - PIM "Privileged Role Administrator": PIM is satisfied only by an **active** assignment of the
      **onboarding operator**, and the host knows no operator id. With neither `setup.json` nor
      `KEEL_SETUP_OPERATOR_ID` set, `operatorPrincipalId` is null, so it stays "waiting for you" and
      can't ever complete as configured now.
  - **Recovery manifest:** exists: Q11's `/opt/keel-recovery-sets/2026-10-04/recovery-manifest.json`
    (task-67, built at df0de36, "recovery complete"). `engine/store/schema.sql` is identical
    df0de36..2e8a5b9. Its copy is on vol2 at `/mnt/keel-copy/2026-10-04`. The authenticator (PR #72)
    and key (Q20) are in place.
  **Remaining steps, in order:**
  1. **Operator:** choose the read-setup scope. Either run read setup **Entra-only**
     (`workloads: ['entra-collect']`; no Intune step; bootstrap-ui.md says the first-collection gate
     accepts it, and the drill only checks `complete`), or put the KEEL Collector SP in a group holding
     Intune "Read Only Operator".
  2. **Operator, then keel-operator:** give the host the onboarding operator's Entra object id.
     `KEEL_SETUP_OPERATOR_ID=<object id>` in `/etc/keel/portal.env` plus a portal restart keeps
     writes disabled (no `setup.json`). I can do it once you name the account.
  3. **Operator:** activate PIM "Privileged Role Administrator" for that account (an active
     assignment, not just eligible).
  4. **Operator, in the portal:** Settings › Setup, run read setup (step 1's scope) and restore setup.
     Both should end `complete` with no writes (consent is already done). Then I read both run ids.
  5. **keel-operator (Q6):** sign a 10-minute assertion with the Q20 key, then `reconstruct.mjs` from
     the Q11 set into a disposable DB, giving `reconstruction.json`. Then `onboarding.json` from step 4.
  6. **keel-operator (Q6):** build-manifest, offline plan check, live bounded drill (one
     `keel-rehearsal-*` group), `capture-drill`, `verify --require-live`, and evidence on
     `claude/live-evidence-116`.
- Needs: Q19 done, Q20 done
- Do: read-only. Redo Q5's check against `docs/roadmap/drill-live-acceptance.md` and
  `docs/roadmap/bootstrap-ui.md` (status 2026-10-04) at the deployed build:
  - which task-76 run ids the drill needs (read setup, restore setup), and whether a run that ends
    `pending-manual` (Intune "Read Only Operator" not-checked; PIM Privileged Role Administrator
    waiting) is accepted, or whether those manual steps must be satisfied first;
  - exactly which operator actions remain (PIM activation, the Intune role, any Collector read grant
    such as `Application.Read.All`, `RoleManagement.Read.Directory`, `DeviceManagementRBAC.Read.All`);
  - whether a task-67 recovery manifest exists for the reconstruction, or which tool builds it.
  Run nothing that writes; don't start a Setup run. Report a short ordered list of the remaining steps.

## Operator decisions (human operator only)

Write `yes`, `no` or your instructions after each one. If a decision is blank, every
item that needs it stays untouched.

- D-120: may the 120 capture flip the tenant-wide SharePoint
  `isResharingByExternalUsersEnabled` for a few seconds and put it back, including with
  `--allow-widening-toggle` if it's currently false?
  - Decision: yes
- D-121a: is the 121 fixture member a permanent `keel-rt-*` account, or created per
  capture and deleted afterwards?
  - Decision: permanent: use existing keel-rt-20260908-carla (not in the team); create or delete no user
- D-121b: grant the Teams application permissions (`TeamSettings.ReadWrite.All`,
  `TeamMember.ReadWrite.All` and the read set) to the KEEL apps? They apply tenant-wide.
  - Decision: yes
- D-122a: give the Restorer `Exchange.ManageAsApp` plus Exchange Administrator, or a
  narrower custom role (which changes task-105's declarations)?
  - Decision: keep the existing managed-as-app and exch admin
- D-122b: accept that the Collector's Exchange role isn't provably read-only (the log
  proves it never ran a `Set-` cmdlet)?
  - Decision: yes
- D-122c: which organization-wide Exchange setting, if any, may be flipped and put back?
  Leave blank to keep the org-config leg unqualified.
  - Decision: none
- D-122d: accept that each capture adds a day to the fixture mailbox's deleted-item
  retention (about 16 captures before 30 days)?
  - Decision: yes
- D-123a: give the Restorer `Exchange.ManageAsApp` plus Compliance Administrator, or a
  narrower custom role group?
  - Decision: keep the existing exch.manageasapp and compliance admin
- D-123b: accept the Collector grants (`Sites.FullControl.All` with SharePoint
  Administrator, plus Compliance Administrator), which can write?
  - Decision: yes
- D-123c: accept tenant-wide label and policy *definition* reads (the record keeps only
  counts and a fingerprint for non-fixture objects)?
  - Decision: yes
- D-123d: may keel-operator create the `KEEL-RT-*` label and the `KEEL-RT-*` policy
  scoped only to `keel-rt-*` users (a fresh label for each capture)?
  - Decision: yes
- D-117: stand up the Sentinel test workspace? If yes, which subscription? (Deferred
  until now.)
  - Decision: no: scratch Sentinel; gate 117 descoped (Marouane, keel-operator thread, 2026-10-04 12:36 UTC; recorded verbatim by the coordinator)
- D-118: is the non-production ServiceNow instance ready? If so, give its host.
  - Decision: yes, a ServiceNow dev instance already exists and is reachable from the VPS (Marouane, project chat, 2026-10-04 10:45 UTC; recorded verbatim by the coordinator). Host: dev426571.service-now.com (Q16); OAuth and ACLs set up (confirmed by Marouane 12:36 UTC).
- D-93a (issue #93): add `GroupSettings.ReadWrite.All` to the Restorer and remove every grant not in the
  minimal set in `docs/roadmap/restorer-least-privilege.md` (PR #101)? Minimal set: Graph
  Group.ReadWrite.All, Application.ReadWrite.All, RoleManagement.ReadWrite.Directory,
  Policy.ReadWrite.ConditionalAccess, AdministrativeUnit.ReadWrite.All, GroupSettings.ReadWrite.All,
  SharePointTenantSettings.ReadWrite.All, TeamSettings.ReadWrite.All, TeamMember.ReadWrite.All,
  MailboxSettings.ReadWrite; Exchange.ManageAsApp; roles Exchange Administrator, Compliance Administrator,
  SharePoint Administrator. After applying, rerun gate 115 and the 120 → 123 chain as the regression check.
  - Decision:
- D-93b (issue #93): keep RoleManagement.ReadWrite.Directory and Application.ReadWrite.All
  (role-assignment and application restore stay automated, but each grant lets the app escalate itself),
  or remove them and make both restores manual?
  - Decision:

### Q22: AWS budget guard (operator-directed)
- Asked by the operator at 16:43 UTC (relayed by the "Continue earlier Keel session" thread). Doesn't touch
  the tenant or master, so it can run while Q10 waits.
- Status: done
- Result: **Done.** The `keel` login was valid (project account …5390). Ran
  `ALERT_EMAIL=<operator address> bash ops/aws/budget-guard.sh` from the queue checkout. The alert
  address was given by the operator in session; it's not written to the repo.
  - `aws budgets describe-budget --budget-name keel-monthly --profile keel --region us-east-1`:
    **exists**: COST, MONTHLY, **25.0 USD**.
  - Notifications: **ACTUAL > 50 %, > 80 %, > 100 %; FORECASTED > 100 %**, each with an EMAIL
    subscriber (AWS sends a subscription confirmation email that the operator may need to accept).
  - No other AWS resources created.
- Needs: none
- Do: on the VPS as root, from the queue checkout, run `ALERT_EMAIL=<address> bash ops/aws/budget-guard.sh`
  (profile `keel`; budget `keel-monthly`, $25/month; alerts at 50/80/100% actual and 100% forecast; AWS
  Budgets' first two budgets are free). If the `keel` login has expired, report that and stop; don't sign in.
  Use the alert address the operator gives. If none is named here, ask him in your session. Don't write the
  address into the repo.
### Q23: #89 offsite diagnosis (read-only)
- Issue #89, asked by the "Offsite backup unreachable" thread (20:22 UTC). Doesn't touch the tenant or
  master, so it can run while Q10 waits. Read-only: no writes, no fixes, no secrets printed (the key
  file is listed, never read or shown).
- Status: done
- Result: **Done (read-only; nothing written, no secrets shown; the key file was listed, never read).**
  **Diagnosis: the offsite target host is unreachable, and the timer has never been enabled.**
  1. `keel-offsite.timer` is **disabled, inactive**; `keel-offsite.service` is static and inactive.
     `journalctl -u keel-offsite.service`: **"-- No entries --"** (it has never run on this host).
  2. Files: `/opt/keel/ops/keel-offsite.sh` (7051 B, Sep 29), `/opt/keel/engine/schedules/offsite.mjs`
     (Sep 29) and `/root/.ssh/playground_vps` (0600, Aug 1) exist. `/opt/backups/keel-db-manifest.json`
     exists (0600, **rewritten 14:21 UTC today**). **`/opt/backups/keel-db-shipped-manifest.json` is
     missing** (nothing ever shipped).
  3. `187.124.7.67` resolves to `srv1872555.hstgr.cloud`. **TCP 22: FAIL** (10 s timeout). **Ping: 2/2 lost.**
  4. `ssh -i /root/.ssh/playground_vps … root@187.124.7.67`: `Connecting to 187.124.7.67 port 22` then
     **`Connection timed out`**. No auth attempt was reached, so the key is untested.
  5. `keel-offsite.sh --dry-run` (supported per its header) exits **0**. Local side verified: candidate
     `/opt/backups/2026-10-04/keel-db.sql.gz`, gzip OK, 63 COPY blocks, sha256 `4d11b857…`. "Would ship to
     root@187.124.7.67:/opt/keel-offsite/keel-db-2026-10-04.sql.gz" and prune >30 d. The dry run doesn't
     contact the remote.
  **Conclusion:** local verification is fine. The remote Hostinger VPS (srv1872555) isn't answering on
  22/ICMP from here: down, firewalled, or the IP has changed. Worth checking the Hostinger panel or its
  firewall. The timer must also be enabled once the remote works.
  **Side finding (not offsite):** `mimule-backup.service` ran at **14:14 and 14:21 UTC** today (its
  description now says "Daily KEEL DB + KEEL config + Caddy backup", so the unit was changed). The
  14:21 run **overwrote** `/opt/backups/2026-10-04/keel-db.sql.gz` (04:04 sha256 `429bdf53…`, now
  `4d11b857…`) and the manifest. The Q11 recovery set and the vol2 copy keep their own `429bdf53…`
  copy, so gate 114's evidence is unaffected. But same-day reruns replace the nightly dump in place.
- Needs: none
- Do: on the KEEL VPS as root, run each and paste the output (report missing files, don't create them):
  1. `systemctl status keel-offsite.timer keel-offsite.service --no-pager; journalctl -u keel-offsite.service -n 60 --no-pager`
  2. `ls -l /opt/keel/ops/keel-offsite.sh /opt/keel/engine/schedules/offsite.mjs /root/.ssh/playground_vps /opt/backups/keel-db-manifest.json /opt/backups/keel-db-shipped-manifest.json`
  3. `getent hosts 187.124.7.67; timeout 10 bash -c '</dev/tcp/187.124.7.67/22' && echo TCP22_OK || echo TCP22_FAIL; ping -c2 -W3 187.124.7.67`
  4. `ssh -i /root/.ssh/playground_vps -o BatchMode=yes -o ConnectTimeout=15 -v root@187.124.7.67 'echo OK; df -h /opt; ls -la /opt/keel-offsite | tail -5' 2>&1 | grep -E 'OK|debug1: (Connecting|Connection|Authenticat|Offering|Server accepts|Authentications that can continue)|Permission denied|refused|timed out|No route|Filesystem|/opt|keel-db'`
  5. `/opt/keel/ops/keel-offsite.sh --dry-run; echo exit=$?` (only if the script supports `--dry-run`; check `--help` or the script header first, and skip it if not)
### Q24: Install scheduled collection (issue #91)
- Drafted by the "Scheduler and backup tiers on host" thread (20:26 UTC). **On hold: don't start**
  until the coordinator changes Status to queued.
- Status: queued (coordinator 13:50 UTC: start once `/opt/keel-live` is deployed at b9e5f6b, #111; follow the 13:13 note)
- Result: **Blocked at step 1: preflight `ok: false`. Operator decision needed before any worker starts.** Nothing installed.
  1. `node cli/keel-schedules-host.mjs preflight` (from /opt/keel-live at 248b12c, read-only), exit 1:
     `{"tenantRef":"sha256:f7b3959300856957","backlog":[{"kind":"backup","status":"queued","count":1,"oldest":"2026-10-02T10:46:37.682Z"},{"kind":"restore","status":"queued","count":1,"oldest":"2026-10-03T15:50:44.811Z"}],"autoRemediatePolicies":0,"schedules":[],"blockers":["jobs are queued or running; a new worker would run them"],"ok":false}`
     The queued jobs (read-only SELECT):
     - `16869853-ebe2-48ae-9ef4-75b77e663ba1` **backup** `{"tier":"tier1"}`, queued 2026-10-02 10:46 UTC.
     - `6f682eec-8338-4530-8dc8-0216dc38e6fe` **restore** of **`authorizationPolicy:Authorization Policy`** (a
       tenant-wide setting) from snapshot `f74b0fac…` (artifact `49e68fce…`), queued 2026-10-03 15:50 UTC.
       `targetConfig` `/etc/keel/restorer-target.json` (doesn't exist, so it would likely fail),
       `collectorConfig` `/etc/keel/tenant-target.json` (doesn't exist).
     **A worker must not start while this restore is queued.** Hard rules: no tenant-wide settings.
  2. `readlink -f /opt/keel` = `/opt/keel`: **not** the same tree as `/opt/keel-live` (separate directory, the
     stopped driver's checkout).
  3–5. Not run.
  **Operator / coordinator:** cancel both stale jobs through KEEL's own path (portal job cancel, or a KEEL CLI
  cancel, so it is recorded as evidence; no hand SQL), or explicitly decide otherwise. Then re-queue Q24.
  Note: step 4 edits `/opt/keel-deploy/deploy.sh`. keel-operator's standing instructions say not to touch
  `/opt/keel-deploy` (vps-deployer owns it), so that step needs the operator's explicit OK or should go to vps-deployer.
- Coordinator note (13:13 UTC): Marouane chose (13:11) to cancel both stale jobs through a new KEEL command,
  PR #111 (`keel-schedules-host cancel`). **Wait for #111 to merge and `/opt/keel-live` to deploy at or after its
  merge commit**, then: (a) `node cli/keel-schedules-host.mjs cancel --job 6f682eec-8338-4530-8dc8-0216dc38e6fe
  --reason "stale 2026-10-03 restore; cancelled before worker install (Q24, Marouane 13:11)"` and the same for
  `16869853-ebe2-48ae-9ef4-75b77e663ba1` (reason "stale 2026-10-02 backup; …"); report both JSON outputs;
  (b) re-run step 1 preflight, which should be `ok: true`; (c) steps 3 and 5. **Skip step 4** (deploy.sh): it goes to
  vps-deployer separately. Set Status back to queued yourself once #111 is deployed.
- Needs: #84 chain (Q10) finished; PR #97 merged and `/opt/keel-live` deployed at its merge commit.
- Do, as root on the VPS, from `/opt/keel-live` (read-only git, no edits to the tree):
  1. `set -a; . /etc/keel/db.env; set +a; node cli/keel-schedules-host.mjs preflight` (read-only). Report its
     JSON. If `ok` is false, stop and report: a queued/running job backlog, enabled auto-remediate policies or
     another tenant's schedules all need an operator decision before a worker starts.
  2. Report `readlink -f /opt/keel` and whether it is the same tree as `/opt/keel-live` (names only).
  3. `bash ops/keel-schedules-install.sh --root /opt/keel-live`. Installs keel-worker.service,
     keel-scheduler.service/.timer (paths rewritten to /opt/keel-live), seeds collect tier1/2/3 schedule rows
     for the tenant in /etc/keel/tenant.json, keeps the old keel-backup-tier* timers disabled, and enables the
     worker and the scheduler timer. Prune and offsite stay unscheduled (issues #90, #89).
  4. Back up `/opt/keel-deploy/deploy.sh`, then add `systemctl try-restart keel-worker` right after its
     `systemctl restart keel-portal` (and in rollback after the portal restart), so the long-running worker
     picks up each deploy. Report the diff.
  5. `node cli/keel-schedules-host.mjs run-now`, wait for the three collect jobs to finish (tier2/3 can take a
     while), wait one scheduler tick (5 min), then `node cli/keel-schedules-host.mjs health`. Report its JSON
     and exit code; a tier with failedTypes is a result, not something to fix on the host.
- Hard rules as usual: no tenant writes (collection is read-only), no grants, no secrets printed.
### Q25: #90 prune dry run against the live DB (read-only)
- Issue #90, asked by the "Prune timer review" thread (20:33 UTC). Doesn't touch the tenant, a service or
  master, so it can run while Q10 waits. Read-only: deletes nothing, starts or enables nothing. Leave
  `keel-prune.timer` disabled and don't touch `/opt/keel-live`.
- Status: done
- Result: **Done (read-only; nothing deleted, started or enabled; `keel-prune.timer` still disabled).**
  1. Scratch checkout of `origin/claude/prune-timer-review` (PR #99) at **1cfa616d216e18827e19f7c369143e5eeb5cda98**
     ("Prune: keep every snapshot something points at, and share the dry run"), outside /opt/keel-live;
     `engine npm ci` OK. Checked first: `--dry-run` calls `listPrunableSnapshots` (two SELECTs only);
     the DELETE lives in `pruneSnapshots`.
  2. `node ../cli/keel-prune.mjs --dry-run` (exit 0) printed **"would prune 154 snapshot(s): …"**: 154 ids
     from `0e0c9371-…` to `f74b0fac-…`. Note: **`f74b0fac-a1ee-4f94-9cd2-d889e98dae55` is the snapshot the
     Q11 recovery set's config export was built from.** The set holds its own copy of that export, so the
     gate-114 evidence is unaffected, but a real prune would delete the snapshot in the live DB.
  3. `SELECT … FROM schedule WHERE job_kind='prune'`: **0 rows** (no prune schedule).
  4. Snapshots per tenant: `sha256:f7b3959300856957`: **182**, oldest 2026-09-04 10:02 UTC, newest
     2026-10-04 20:00 UTC. So 28 are kept and 154 would go.
  5. Scratch checkout removed.
- Needs: none
- Do, as root on the VPS:
  1. Make a scratch checkout of `origin/claude/prune-timer-review` (PR #99; outside `/opt/keel-live`; report
     its commit), then `cd engine && npm ci`.
  2. `set -a; . /etc/keel/db.env; set +a; node ../cli/keel-prune.mjs --dry-run`. If the CLI doesn't print that
     it is a dry run, stop and report. Paste the output (snapshot ids are fine, no payloads).
  3. `SELECT job_kind, tier, enabled, next_due_at FROM schedule WHERE job_kind='prune';`
  4. Snapshot count per tenant with `min(started_at)`.
  5. Delete the scratch checkout.
### Q26: #93 Restorer grants inventory (read-only)
- Issue #93, asked by the "Restorer least-privilege review" thread (20:34 UTC). **On hold: don't start**
  until the coordinator changes Status to queued (after the 120 → 123 chain).
- Status: done
- Result: **Done (read-only; nothing created, granted or removed).** Restorer = Keel Restorer, appId 12f8942f…, SP 8cd199c9-a96e-4666-924f-aa0ca6910f32.
  **Application permissions (56):**
  - **Microsoft Graph (53):** AccessReview.ReadWrite.All, AdministrativeUnit.ReadWrite.All, Application.ReadWrite.All,
    Channel.Create, Channel.ReadBasic.All, ChannelMember.ReadWrite.All, ChannelSettings.ReadWrite.All,
    DeviceManagementApps.ReadWrite.All, DeviceManagementConfiguration.ReadWrite.All,
    DeviceManagementManagedDevices.ReadWrite.All, DeviceManagementRBAC.ReadWrite.All,
    DeviceManagementServiceConfig.ReadWrite.All, Directory.ReadWrite.All, Domain.ReadWrite.All,
    EntitlementManagement.ReadWrite.All, Files.ReadWrite.All, Group.ReadWrite.All, IdentityProvider.ReadWrite.All,
    MailboxSettings.ReadWrite, Organization.ReadWrite.All, Policy.ReadWrite.AccessReview,
    Policy.ReadWrite.ApplicationConfiguration, Policy.ReadWrite.AuthenticationFlows, Policy.ReadWrite.AuthenticationMethod,
    Policy.ReadWrite.Authorization, Policy.ReadWrite.B2BManagementPolicy, Policy.ReadWrite.ConditionalAccess,
    Policy.ReadWrite.ConsentRequest, Policy.ReadWrite.CrossTenantAccess, Policy.ReadWrite.CrossTenantCapability,
    Policy.ReadWrite.DeviceConfiguration, Policy.ReadWrite.ExternalIdentities, Policy.ReadWrite.FeatureRollout,
    Policy.ReadWrite.FedTokenValidation, Policy.ReadWrite.IdentityProtection, Policy.ReadWrite.PermissionGrant,
    Policy.ReadWrite.Recovery, Policy.ReadWrite.SecurityDefaults, Policy.ReadWrite.TrustFramework,
    RecordsManagement.ReadWrite.All, RoleManagement.ReadWrite.CloudPC, RoleManagement.ReadWrite.Defender,
    RoleManagement.ReadWrite.Directory, RoleManagement.ReadWrite.Exchange, SecurityAlert.ReadWrite.All,
    SecurityIncident.ReadWrite.All, **SharePointTenantSettings.ReadWrite.All** (added 2026-10-04 for gate 120),
    Sites.Create.All, Sites.FullControl.All, Team.ReadBasic.All, TeamMember.ReadWrite.All, TeamSettings.ReadWrite.All,
    User.ReadWrite.All.
  - **Office 365 SharePoint Online (2):** Sites.FullControl.All, TermStore.ReadWrite.All.
    (User.ReadWrite.All was granted on 2026-10-04 at 13:00 UTC and **revoked** at 13:05 UTC.)
  - **Office 365 Exchange Online (1):** Exchange.ManageAsApp.
  - No other resource.
  **Directory role assignments (8, all scope `/`):**
  - Compliance Administrator `17315797-102d-40b4-93e0-432062caca18`
  - Compliance Data Administrator `e6d1a23a-da11-4be4-9570-befc86d067a7`
  - Exchange Administrator `29232cdf-9323-42fd-ade2-1d097af3e4de`
  - Intune Administrator `3a2c62db-5318-420d-8d74-23affee5d9d5`
  - Knowledge Administrator `b5a8dcf3-09d5-43a9-a639-8e29ef291470`
  - Security Administrator `194ae4cb-b126-40b2-bd5b-6091b380977d`
  - SharePoint Administrator `f28a1f50-f6e7-4571-818b-6a12f2af6b6c`
  - Teams Administrator `69091246-20e8-4a56-aa4d-066075b2a7a8`
  **The "ninth" from Q7** came from the token's `wids` claim: `0997a1d0-0d1d-4acb-b408-d5ca73121e90`. It is **not a
  directory role**: no role definition has that templateId, `roleAssignments` for it returns 404, and the same wid
  appears in the Collector's token. It's an implicit claim on app-only tokens, not a grant. So the Restorer holds
  **8** directory roles. (Q7's "9 directory roles (wids)" over-counted by this one.)
- Needs: Q10 finished.
- Do: list every application permission the Restorer app (appId 12f8942f…) holds, on every resource (Graph,
  SharePoint Online, Exchange Online, any other), and every directory role it holds with its role template id.
  Q7 named 8 of the 9 roles; name the ninth. Create, grant and remove nothing.
### Q27: Set the gate 116 onboarding operator id on the host (issue #85)
- Asked by the "Gate 116 drill live acceptance" thread (20:39 UTC). Marouane named the onboarding account
  and chose Entra-only read setup in that thread (20:39 UTC). It restarts the portal, so **don't run it while
  Q10 is in progress**; run it before Q10 starts or after it finishes.
- Status: done
- Result: **Done** at deployed ffa05cd (Q10 not running).
  1. `GET /users/marouane.Defili@techinsiderbytes.com?$select=id` (Collector) returned **`8dab2722-f4f9-443a-bd67-63782a46dfd0`**
     (Marouane Defili, marouane.defili@techinsiderbytes.com).
  2. Backed up `/etc/keel/portal.env` as `portal.env.bak-q27-*`. Appended
     `KEEL_SETUP_OPERATOR_ID=8dab2722-f4f9-443a-bd67-63782a46dfd0` and restarted `keel-portal` (health ok).
     **No `/etc/keel/setup.json`**, so operations stay `{}` and every write stays disabled (`graphHost.mjs`
     `qualify()` returns null; `ensure()` throws).
  3. `GET /api/setup`: `canCheck: true`, `canProvision: true`. The API doesn't list operations; as in Q19, `true`
     only means a run can start, with no write operation enabled.
     - **Read setup: run `cbd974b9ef10…` state `complete`** (Entra-only, `["entra-collect"]`, approved by
       Marouane 20:40:48, build ffa05cd). This is gate 116's readSetupRunId.
     - **Restore setup: run `ea7e91c24847…` state `waiting-for-you`** at the PIM step "Privileged Role
       Administrator". Its other steps show `not-started`. The step JSON has **no field naming the
       operator**, so I can't confirm from the page that it now refers to 8dab2722. That run was approved at
       20:40:16, before the id was set. A fresh or resumed restore run after PIM activation (or after #96)
       will observe with the new id.
     - Note: no tenant-wide PIM data exists for Privileged Role Administrator (no active or eligible
       instances, checked 18:17 UTC).
     - Earlier stopped read run `c18bfc21…` (with Intune) remains in the journal.
  4. Read-only: the **KEEL Collector SP still holds the directory role "Intune Administrator"**
     (template `3a2c62db…`), alongside Global Reader, Security Reader and the Q10 grants (SharePoint,
     Exchange and Compliance Administrator). Not changed.
- Needs: Q21 done; Q10 not running.
- Do:
  1. Look up the Entra object id of `marouane.Defili@techinsiderbytes.com` with a read-only Graph GET
     (Collector token, `/users/{upn}?$select=id`).
  2. Add `KEEL_SETUP_OPERATOR_ID=<that id>` to `/etc/keel/portal.env`, then restart the portal. Don't create
     `/etc/keel/setup.json` and enable no `operations`, so every write stays disabled.
  3. Confirm with `GET /api/setup` that canCheck is still true and canProvision reports no write operation
     enabled. Report the object id and whether the restore setup's PIM step now names that account
     ("waiting for you" is expected until Marouane activates PIM).
  4. Read-only: report whether the KEEL Collector service principal currently holds the Entra directory role
     "Intune Administrator" (Marouane added it and was asked to remove it). Don't change it.
### Q28: #90 prune dry-run breakdown (read-only)
- Issue #90, asked by the "Prune timer review" thread (21:04 UTC) to check that Q25's 154 snapshots are the
  expected ones. Same rules as Q25: read-only, delete nothing, enable nothing; the `prune` schedule stays absent.
- Status: done
- Result: **Done (read-only; SQL inside `BEGIN READ ONLY … ROLLBACK`; nothing deleted or enabled; no `prune` schedule).**
  1. Snapshots by tier, status and day (tenant sha256:f7b3959300856957, 182 total):
     - 09-04: tier2 ×2 (464 versions).
     - 09-07: tier2 ×6 (1392).
     - 09-08: tier1 ×13 (8883), **tier1 running ×1 (84)**, tier2 ×2 (1366), tier3 ×1 (1367).
     - 09-09 to 09-13: tier1 ×24 per day (25200–25296), tier2 ×1 per day (159–161).
     - 09-14: tier1 ×20 (21080), tier2 ×1 (161), tier3 ×1 (159).
     - 10-04: tier1 ×9 (9605), tier2 ×1 (163), tier3 ×1 (159).
     - No snapshots 09-15 → 10-03 (collection was off). All complete except the one stale `running`
       tier1 from 09-08.
  2. `SELECT count(*) FROM evidence WHERE subject::text LIKE '%f74b0fac-…%'`: **0**.
  3. I regenerated Q25's list with the same read-only dry run: still **154 ids**. Searched UUIDs only
     (no contents printed) in every `origin/claude/live-evidence-*` branch's
     `docs/release/qualifications` and in `/opt/keel-live/docs/release/qualifications`: 312 hits, 25 distinct
     UUIDs. **None of them is a snapshot id, and none is in the 154.** So no committed or live gate evidence
     cites a prunable snapshot.
     - Only outside git: `f74b0fac-a1ee-4f94-9cd2-d889e98dae55` (in the 154) is the `snapshotId` in
       `/opt/keel-recovery-sets/2026-10-04/recovery-set.json` and its vol2 copy
       `/mnt/keel-copy/2026-10-04/recovery-set.json` (gate 114's set). The set embeds its own config export,
       so a prune wouldn't break that set's verification, but the DB snapshot it names would be gone.
- Needs: none
- Do, as root with `/etc/keel/db.env` sourced, in psql against `KEEL_DB_URL`:
  1. ```sql
     WITH t AS (
       SELECT s.id, s.status, s.started_at::date AS day,
              CASE WHEN bool_or(rv.criticality='tier3') THEN 'tier3'
                   WHEN bool_or(rv.criticality='tier2') THEN 'tier2' ELSE 'tier1' END AS tier,
              count(rv.id) AS versions
       FROM snapshot s LEFT JOIN resource_version rv ON rv.snapshot_id = s.id
       WHERE s.tenant_ref = 'sha256:f7b3959300856957'
       GROUP BY s.id)
     SELECT tier, status, day, count(*) AS snapshots, sum(versions) AS versions
     FROM t GROUP BY 1,2,3 ORDER BY 3,1,2;
     ```
  2. `SELECT count(*) FROM evidence WHERE subject::text LIKE '%f74b0fac-a1ee-4f94-9cd2-d889e98dae55%';`
     (a count only, no payloads).
  3. Without printing any file contents, grep the `claude/live-evidence-*` branches and the live gate evidence
     directories for snapshot ids, and list which ids from Q25's list they cite.
### Q29: #90 turn on the prune schedule
- Drafted by the "Prune timer review" thread (21:32 UTC) after Q25/Q28 (the 154 are tier1 snapshots from
  09-08 to 09-14, none cited by gate evidence). **On hold: don't start** until the coordinator changes Status
  to queued.
- Status: hold
- Result:
- Needs: Q10 finished; #97 and #99 merged and deployed; Q24 done with its health check passing.
- Do, as root from the deployed tree with `/etc/keel/db.env` sourced:
  1. `node cli/keel-prune.mjs --dry-run`. Report the count. Stop and report if it is far above about 154 plus
     one day of tier1 per day since 10-04.
  2. Get `TENANT_REF` the same way `keel-schedules-install.sh` does, then
     `node cli/keel-schedules-migrate.mjs --tenant-ref "$TENANT_REF" --kinds prune`. It adds only the prune row
     and keeps every existing row. Its timer check must still PASS with `keel-prune.timer` disabled or not
     installed.
  3. `SELECT job_kind, enabled, next_due_at FROM schedule WHERE job_kind='prune';` should return one enabled
     row, due at the next 00:00 UTC.
  4. After that first run, report the prune job's status and the `pruned N snapshot(s)` line from its result
     (snapshot ids are fine; nothing else).

### Q30: Remove the Q19 Restorer config override after #98 deploys — issue #92
- Status: done
- Result: **Done** at deployed 248b12c (≥ 76e503e, #98).
  1. Backed up `/etc/keel/portal.env` as **`/etc/keel/portal.env.bak-q30-202610051309`**. Removed only
     `KEEL_RESTORER_CONFIG_PATH=…`. The file now sets CLOUDFLARE_ACCESS_TEAM_DOMAIN, CLOUDFLARE_ACCESS_AUD, HOST, PORT,
     NODE_ENV, **KEEL_COLLECTOR_CONFIG_PATH** (kept) and KEEL_SETUP_OPERATOR_ID. Restarted `keel-portal`; health ok.
  2. `GET /api/setup` after the restart: **canCheck true, canProvision true, checkFailed false**. Same as before.
     - Read setup run `complete` (keel-collector, consent and keel.collect done).
     - Restore setup run `waiting-for-you` at the PIM step.
     - The Restorer config is found through #98's default (`/etc/keel/restorer.json`); no missing-config error.
     - Note: the pre-change `/api/setup` read failed only because my Access token had expired (a new
       `cloudflared access login` was approved by the operator at 13:11 UTC). Nothing to do with the change.
  3. No rollback needed.
- Needs: Q10 finished; `/opt/keel-live` deployed at or after `76e503e` (#98: portal and worker now default to
  `/etc/keel/restorer.json`).
- Do:
  1. Back up `/etc/keel/portal.env` as `portal.env.bak-q30-*`. Remove only the `KEEL_RESTORER_CONFIG_PATH` line
     that Q19 added; leave `KEEL_COLLECTOR_CONFIG_PATH` alone. Restart `keel-portal` and confirm health ok.
  2. `GET /api/setup` (or Settings › Setup): confirm the Restorer config is still found and read (same
     `canCheck`/`canProvision` as before, no missing-config error). Print no file contents or secrets.
  3. If it fails, restore the backup, restart, and report what the portal said.

### Q31: #89 enable offsite to vol2 — issue #89
- Drafted by the "Offsite backup unreachable" thread (02:00 UTC). **On hold: don't start** until the coordinator
  changes Status to queued.
- Status: done
- Result: **Done: offsite now ships to vol2 daily.**
  1. `findmnt /mnt/keel-copy`: **/dev/sdb** ext4 (not the root fs).
  2. **Tree:** the deploy updates **`/opt/keel-live`** (at 248b12c, which includes c99a9f2/#100). `/opt/keel` is the
     stopped driver's checkout: its `keel-offsite.sh` has **0** `KEEL_OFFSITE_DIR` refs (old remote-only script),
     while `/opt/keel-live/ops/keel-offsite.sh` has 2. The repo unit's `ExecStart` is `/opt/keel/ops/keel-offsite.sh`,
     so I installed it **with ExecStart rewritten to `/opt/keel-live/ops/keel-offsite.sh`** (same idea as Q24's path
     rewrite). Otherwise the unit would run the old script against the unreachable host.
  3. Backed up the old units (`/etc/systemd/system/keel-offsite.{service,timer}.bak-q31-*`). Installed the service
     (rewritten) and the timer (as in repo: `OnCalendar=*-*-* 05:00:00 UTC`, `Persistent=true`), 0644; `daemon-reload`.
     `EnvironmentFile=-/etc/keel/offsite.env` is absent, so defaults apply (no remote; target `/mnt/keel-copy/keel-offsite`).
  4. `keel-offsite.sh --dry-run`: **exit 0**. Candidate `/opt/backups/2026-10-05/keel-db.sql.gz` (gzip OK, 65 COPY
     blocks, sha256 c36c4620…0b1), "target /mnt/keel-copy/keel-offsite usable".
  5. `systemctl start keel-offsite.service` (13:12:00): "**sha256 verified — transfer is byte-identical**" … "keel-offsite:
     **done**. Shipped keel-db-2026-10-05.sql.gz".
  6. `/mnt/keel-copy/keel-offsite/keel-db-2026-10-05.sql.gz` (69,192,098 B, **mode 0600** root). sha256
     **c36c462007bd2cce53d9b3ddebc42ccc7f537a1431205ae42163e69c0e1ed0b1** = `keel-db-shipped-manifest.json` .checksum. Match.
  7. `systemctl enable --now keel-offsite.timer`: enabled and active; **next run Tue 2026-10-06 05:00 UTC**.
     - Note: `Persistent=true` fired a catch-up run at 13:12:05, which **refused** ("dump manifest is not newer than
       last shipped manifest", exit 1), because today's dump had just shipped in step 5. Benign. I cleared the failed
       state (`reset-failed`). **Coordinator:** the script exits 1 for "nothing new to ship"; consider exit 0 there
       so a same-day rerun doesn't show as a failed unit.
     - Note: the other repo units (keel-backup-tier*, keel-prune, …) also point at `/opt/keel`; the same rewrite
       question applies to them.
- Needs: Q10 finished; the deployed tree (`/opt/keel`, see Q24 step 2 for `/opt/keel` vs `/opt/keel-live`) at or
  after `c99a9f2` (#100).
- Do, as root on the KEEL VPS (use whichever of `/opt/keel` or `/opt/keel-live` the deploy updates):
  1. `findmnt /mnt/keel-copy` (it must be `/dev/sdb`, not the root fs). Stop and report if not.
  2. `grep -c KEEL_OFFSITE_DIR /opt/keel/ops/keel-offsite.sh` (expect > 0; the script comes with the deploy).
  3. `install -m 0644 /opt/keel/ops/keel-offsite.service /opt/keel/ops/keel-offsite.timer /etc/systemd/system/ && systemctl daemon-reload`
  4. `/opt/keel/ops/keel-offsite.sh --dry-run; echo exit=$?` (must be 0).
  5. `systemctl start keel-offsite.service; journalctl -u keel-offsite.service -n 30 --no-pager` (expect
     "sha256 verified" and "done").
  6. `ls -l /mnt/keel-copy/keel-offsite/; sha256sum /mnt/keel-copy/keel-offsite/keel-db-*.sql.gz;
     jq -r .checksum /opt/backups/keel-db-shipped-manifest.json`. The hashes must match and the file must be
     mode 0600.
  7. `systemctl enable --now keel-offsite.timer; systemctl list-timers keel-offsite.timer --no-pager`

### Q32: Gate 116 onboarding result, then unblock Q6 — issue #85
- Drafted by the "Gate 116 drill live acceptance" thread (02:00 UTC). **On hold: don't start** until the
  coordinator changes Status to queued (after Q10 and Q33 finish).
- Status: blocked
- Result: **Step 1–2 partly done; Q6 blocked at the task-68 reconstruction (importer can't load a real pg_dump).** No drill
  was run; no `keel-rehearsal-*` group was created; nothing was written to the tenant.
  1. Deployed **248b12c** includes 36fc2b3 (#96). Setup runs (`bootstrap_plan`/`bootstrap_event`, read-only):
     - **read: `cbd974b9ef106fda5b2d31467b7d07b36de6e092eb16b5a76892ec5b34dda144` complete** (Entra-only, build ffa05cd)
     - **restore: `174d8db69f61c81cb76c54c1a5708a09d04a70754e5911a7207316dcb35d3d74` complete** (build 248b12c, Q33)
     - (also: c18bfc21 stopped; ea7e91c2 approved/stale; untouched.)
  2. Wrote `/root/keel-q6-116/onboarding.json` (task-76; both complete; both run ids). Then started Q6:
     - **The Q11 set can't serve 248b12c:** `capture-drill` needs `reconstruction.buildRevision === --build`
       (`qualification.mjs:585`), and the Q11 manifest is pinned to df0de36. The live evidence head has also moved
       (now seq 12).
     - So I built a **fresh recovery set at 248b12c**: read-only `pg_dump` of the live DB to
       `/root/keel-q6-116/keel-db-2026-10-05-q6.sql.gz` (sha256 80b47c92…, 65 COPY blocks), then
       `ops/keel-recovery-set.mjs --dump-sha256 … --out /opt/keel-recovery-sets/2026-10-05-q6`. Result: build
       248b12c, schema pin 2a20d4ae…, snapshot 3c2c2968…, **evidence head
       12:9d6e29f864690a474a53eabb352eb64abeaf0f9886c8b25c7da7f7ce2a37f8b2:12** (unchanged across dump and set),
       manifest sha256 d455bdb1…. `keel-dump-manifest.mjs --verify`: "recovery complete".
     - Disposable target DB **`keel_recovery_q6`** (new, empty; never KEEL_DB_URL). Signed a 10-min single-use
       assertion with the Q20 key (recovery-officer@keel.local / officer-2026-10).
     - `reconstruct.mjs … --authenticator signed-assertion … --result-out` ended with **exit 1:
       `import: dump import failed: syntax error at or near "\"`**. No reconstruction.json.
     - **Root cause:** `tools/recovery/reconstruct.mjs` (~L270) runs the whole dump as one
       `importClient.query(dumpSql)` through node-postgres. Plain `pg_dump` output (pg_dump **16.14** in keel-postgres)
       contains psql meta-commands: **`\restrict <key>`** (line 5) and `\unrestrict` (end), and every table's data as
       **`COPY … FROM stdin;` … `\.`** blocks. Neither can run through a plain query (COPY needs the COPY protocol).
       **Every KEEL dump has this**: the 2026-10-04 and 2026-10-05 nightlies, the Q11 set and this fresh set (2
       restrict lines each). So no real backup can be reconstructed today (only synthetic INSERT-style fixtures).
     - Cleanup: reconstruct discarded its half-import schema; `keel_recovery_q6` has 0 tables.
  **Coordinator, tool fix:** load the dump with `psql` (e.g. `docker exec -i keel-postgres psql -v ON_ERROR_STOP=1 -d
  <disposable db>`, or psql on the host) or implement COPY-stdin streaming and strip `\restrict`/`\unrestrict`. Then
  redo: fresh set at the new build (head moves), assertion, reconstruct, build-manifest, offline plan, live bounded
  drill, capture-drill, verify.
  Kept for the rerun: onboarding.json (run ids stay valid), the recovery key, the trust store; the 2026-10-05-q6 set is
  build-pinned to 248b12c, so it's only reusable at 248b12c.
- Needs: Q10 finished; Q27 done; PR #96 (`36fc2b3`) deployed; Q33 done (fresh restore setup complete).
- Do:
  1. Read-only: confirm the deployed build includes `36fc2b3`. From `bootstrap_plan`/`bootstrap_event`, report the
     newest read-setup run that ended `complete` (expected `cbd974b9…`, Entra only, at ffa05cd) and the newest
     restore-setup run that ended `complete`, with each run's id, final state and build. Don't start or resume any
     setup run.
  2. If both are `complete`, write `onboarding.json` (`task: "task-76"`, `readSetup: "complete"`,
     `restoreSetup: "complete"`, `readSetupRunId`, `restoreSetupRunId`) next to the Q6 working files. Then set Q6
     back to ready and run it as written, per Q21 steps 5-6: assertion with the Q20 key, `reconstruct.mjs` from the
     Q11 set into a disposable DB, build-manifest, offline plan check, live bounded drill (one `keel-rehearsal-*`
     group), `capture-drill`, `verify --require-live`, evidence on `claude/live-evidence-116`.
  3. If either isn't `complete`, stop and report its state and its waiting step. Change nothing.

### Q33: Gate 116 restore setup and Collector role cleanup — issue #85
- Drafted by the "Gate 116 drill live acceptance" thread (07:16 UTC). Asked by Marouane in the project chat,
  2026-10-05 07:15 UTC: "I think these could be solved by the deployer/operator sessions?" **On hold: don't start**
  until the coordinator changes Status to queued (after Q10 finishes).
- Status: done
- Result: **Done.**
  1. Deployed build **248b12c** includes **36fc2b3** (#96). No `/etc/keel/setup.json` (no operations enabled).
  2. **Restore setup:** `POST /api/actions/setup {"scope":"restore"}` with the operator Access session (renewed
     13:11 UTC) returned HTTP 200, **run `174d8db69f61c81cb76c54c1a5708a09d04a70754e5911a7207316dcb35d3d74`, status
     `complete`**. Approved by principal 2a47535a… (Marouane), workloads `["entra-restore"]`, 13:12:59 UTC. The stale
     run `ea7e91c2…` was not resumed.
     - Journal (`bootstrap_event` 25–40): approved, then **PIM step `step-c0b20175…` observed `satisfied`**, then
       registration keel-restorer (appId 12f8942f…, objectId 31f2eb26…), admin consent and keel.restore, each
       desired → observed `satisfied` → verified. Final re-observe all satisfied; `complete`
       (`qualification: live-qualified`). **No `uncertain` or write events: nothing was written to the tenant.**
     - Gate 116 onboarding: **readSetupRunId `cbd974b9ef10…`** (Q27, Entra-only, complete) and **restoreSetupRunId
       `174d8db69f61…`** (complete).
  3. **Collector cleanup:** removed the "Intune Administrator" role assignment
     `22IsOhhTDUKNdCOv_uXZ1QAWdPiAU7NMt5Bm_pqX37Q-1` (template 3a2c62db…) from the KEEL Collector SP
     (f8741600…) with the Restorer: `DELETE /roleManagement/directory/roleAssignments/{id}` returned **204**.
     - Read back after 10 s: Intune Administrator gone. Remaining (unchanged): **Global Reader, Security Reader**,
       plus the Q10 grants Compliance Administrator, Exchange Administrator and SharePoint Administrator. Nothing granted.
  4. Ready for the coordinator to queue Q32.
- Needs: Q10 finished; Q27 done; `36fc2b3` (PR #96) deployed to `/opt/keel-live`.
- Do:
  1. Confirm the deployed build includes `36fc2b3`. If it doesn't, stop and report.
  2. Restore setup: through the portal API with the operator Access session, `POST /api/actions/setup`
     `{ "scope": "restore" }` to start a **fresh** run. Don't resume the stale run `ea7e91c24847…`. No `setup.json`
     and no enabled operations, so the run must write nothing. Report the run id and final state. It should end
     `complete`, with the PIM step satisfied by Marouane's active Global Administrator (operator id from Q27). If it
     ends `pending-manual`, report the waiting step and stop; don't resume or retry. If the operator Access session
     can't approve setup runs (it needs `configuration` + `approve`), report that and stop this step: Marouane will
     click "Start again" himself.
  3. Collector cleanup: remove the Entra directory role assignment "Intune Administrator" (template
     `3a2c62db-5318-420d-8d74-23affee5d9d5`) from the KEEL Collector service principal, and nothing else. Find it with
     `GET /roleManagement/directory/roleAssignments?$filter=principalId eq '<Collector SP id>'`, then DELETE only that
     one assignment id with the Restorer credential (it holds RoleManagement.ReadWrite.Directory). Read back: the
     assignment is gone and the Collector's other roles (Global Reader, Security Reader) are unchanged. If the
     Restorer can't delete it, report the error and stop. Don't grant anything to anyone.
  4. Then the coordinator queues Q32.


### Q34: Protected fixture label for LabelActions — issue #109
- Status: done
- Result: **Done.** Created **one** label, **`KEEL-RT-20261005-protected`** (guid 266cb4eb-e949-4088-be48-f25602b164e6), with the Restorer via Connect-IPPSSession.
  It's **unpublished** (in no label policy, checked after creation). Nothing else touched.
  - Content marking header + footer + watermark, text "KEEL-RT fixture": **applied**.
  - **Encryption: applied as UserDefined + EncryptionPromptUser + EncryptionDoNotForward.** First attempts without
    DoNotForward were refused: "ContentType includes both File and Email. To set -EncryptionProtectionType to
    UserDefined, you must also set EncryptionPromptUser and either -EncryptionEncryptOnly or -EncryptionDoNotForward".
    No template, user or group assignment involved.
  - **Site and group protection: applied** (ContentType extended to `File, Email, Site, UnifiedGroup`): privacy
    Private, guest access off, external sharing ExistingExternalUserSharingOnly. The tenant accepted it.
  - Order: `New-Label` with markings (the fallback after the two encryption refusals), then one `Set-Label` adding
    encryption and site/group.
  **Read-only `Get-Label -Identity KEEL-RT-20261005-protected | ConvertTo-Json -Depth 10`:**
  - **Top-level LABEL_ACTION_FIELDS present: none (0 of 10).** EncryptionEnabled, EncryptionProtectionType,
    EncryptionOfflineAccessDays, ApplyContentMarkingHeaderEnabled, ApplyContentMarkingFooterEnabled,
    ApplyWaterMarkingEnabled, SiteAndGroupProtectionEnabled, SiteAndGroupProtectionPrivacy,
    SiteAndGroupProtectionAllowAccessToGuestUsers and SiteExternalSharingControlType are all absent as properties.
  - They're encoded in **LabelActions** (an array of JSON **strings**, each `{Type, SubType, Settings:[{Key,Value}]}`)
    and **Settings** (`"[key, value]"` strings). Values (no GUIDs present):
  ```json
  {
   "LabelActions": [
    "{\"Type\":\"applycontentmarking\",\"SubType\":\"footer\",\"Settings\":[{\"Key\":\"alignment\",\"Value\":\"Left\"},{\"Key\":\"disabled\",\"Value\":\"false\"},{\"Key\":\"fontcolor\",\"Value\":\"#000000\"},{\"Key\":\"fontsize\",\"Value\":\"10\"},{\"Key\":\"margin\",\"Value\":\"5\"},{\"Key\":\"placement\",\"Value\":\"Footer\"},{\"Key\":\"text\",\"Value\":\"KEEL-RT fixture\"}]}",
    "{\"Type\":\"applycontentmarking\",\"SubType\":\"header\",\"Settings\":[{\"Key\":\"alignment\",\"Value\":\"Left\"},{\"Key\":\"disabled\",\"Value\":\"false\"},{\"Key\":\"fontcolor\",\"Value\":\"#000000\"},{\"Key\":\"fontsize\",\"Value\":\"10\"},{\"Key\":\"margin\",\"Value\":\"5\"},{\"Key\":\"placement\",\"Value\":\"Header\"},{\"Key\":\"text\",\"Value\":\"KEEL-RT fixture\"}]}",
    "{\"Type\":\"applywatermarking\",\"SubType\":null,\"Settings\":[{\"Key\":\"disabled\",\"Value\":\"false\"},{\"Key\":\"fontcolor\",\"Value\":\"#000000\"},{\"Key\":\"fontsize\",\"Value\":\"10\"},{\"Key\":\"layout\",\"Value\":\"Diagonal\"},{\"Key\":\"text\",\"Value\":\"KEEL-RT fixture\"}]}",
    "{\"Type\":\"encrypt\",\"SubType\":null,\"Settings\":[{\"Key\":\"donotforward\",\"Value\":\"true\"},{\"Key\":\"disabled\",\"Value\":\"false\"},{\"Key\":\"encryptonly\",\"Value\":\"false\"},{\"Key\":\"promptuser\",\"Value\":\"true\"},{\"Key\":\"protectiontype\",\"Value\":\"userdefined\"}]}",
    "{\"Type\":\"protectgroup\",\"SubType\":null,\"Settings\":[{\"Key\":\"allowaccesstoguestusers\",\"Value\":\"false\"},{\"Key\":\"allowemailfromguestusers\",\"Value\":\"false\"},{\"Key\":\"disabled\",\"Value\":\"false\"},{\"Key\":\"privacy\",\"Value\":\"private\"}]}",
    "{\"Type\":\"protectsite\",\"SubType\":null,\"Settings\":[{\"Key\":\"allowfullaccess\",\"Value\":\"false\"},{\"Key\":\"allowlimitedaccess\",\"Value\":\"false\"},{\"Key\":\"blockaccess\",\"Value\":\"false\"},{\"Key\":\"externalsharingcontroltype\",\"Value\":\"ExistingExternalUserSharingOnly\"},{\"Key\":\"disabled\",\"Value\":\"false\"}]}"
   ],
   "Settings": [
    "[isparent, False]",
    "[contenttype, File, Email, Site, UnifiedGroup]",
    "[tooltip, KEEL disposable qualification fixture (gate 123, LabelActions). Do not use.]",
    "[displayname, KEEL-RT-20261005-protected]"
   ]
  }```
- Needs: Q10 finished (don't add a label while the chain runs; 123 counts tenant labels).
- Ask (Marouane chose 12:42 UTC that KEEL reads LabelActions): with the Restorer via Connect-IPPSSession, create
  **one** label `KEEL-RT-<date>-protected`, unpublished (in **no** label policy), with:
  - content marking header and footer (text "KEEL-RT fixture"), and a watermark (same text);
  - encryption with user-defined permissions or the simplest option the tenant allows (no template that applies to
    real users or groups; if encryption needs anything beyond the label itself, skip it and say why);
  - site and group protection: privacy Private, guest access off, external sharing to existing guests only (skip if
    the tenant hasn't enabled labels for groups and sites, and say so).
- Then, read-only: `Get-Label -Identity <that label> | ConvertTo-Json -Depth 10` and paste the **LabelActions** and
  **Settings** values, plus which of the 10 LABEL_ACTION_FIELDS names appear as top-level properties, into the
  Result. Nothing else is touched. No secrets (the output holds none; redact any GUID of a real user if one appears).

### Q35: Rerun gates 120 → 121 → 122 → 123 at the build after #111 and #116 (LabelActions, #109) — issue #84
- Status: hold (coordinator flips to queued, naming the build: master once #111 (b9e5f6b) and #116 are both deployed)
- Result:
- Needs: PR #111 merged and deployed; **Q24 finished first** (stale jobs cancelled, worker installed, its run-now
  collections done), so no collection starts mid-chain.
- Do: exactly as Q10 (same pre-checks and decisions), at the new build, with a fresh unpublished
  `KEEL-RT-<date>-label3` for 123. Expect gate 123's `notQualifiedFields.label` to be **empty**: the ten protection fields
  now come from LabelActions. If any are still listed, stop and report the 123 capture's label fieldCoverage.
  Commit each gate to `claude/live-evidence-<gate>` as before. Poll every 5 minutes while queued or running.

### Q36: Gate 116 drill rerun (Q6) at the same build as Q35 — issue #85
- Status: hold (coordinator flips to queued with the build once #116 is deployed; runs after Q24, before or after Q35 at the same build)
- Result:
- Needs: PR #116 (reconstruct imports real pg_dump: COPY blocks, \restrict/\unrestrict, FK-ordered load) merged and deployed.
- Do:
  1. Build a fresh recovery set (backup dump + manifest) at the deployed build, as in Q32.
  2. Rerun Q6 with `/root/keel-q6-116/onboarding.json`: reconstruct.mjs into a disposable DB (never KEEL_DB_URL),
     build-manifest, offline plan, the live bounded drill (**one `keel-rehearsal-*` group only**), capture-drill with
     `--build` = the deployed build, `verify --require-live` (expect exit 0). Push the evidence to `claude/live-evidence-116`.
  3. Report the run ids and the evidence commit in Result.
- Hard rules as usual: no tenant-wide settings, no grants, no secrets printed.

