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
- Status: superseded (gate 116 passed via Q36 at 04d213d, #126; recaptured at fb1493e in Q39)
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
  - Decision: no. Keep full permissions, and add any the tool needs to move along (Marouane, #84 thread, 2026-10-08
    09:25 UTC). Scoping comes later, once the solution is complete: separate app registrations per workload or permission
    level, created automatically at tenant onboarding.
- D-93b (issue #93): keep RoleManagement.ReadWrite.Directory and Application.ReadWrite.All
  (role-assignment and application restore stay automated, but each grant lets the app escalate itself),
  or remove them and make both restores manual?
  - Decision: keep both (Marouane, 2026-10-08 09:25 UTC, same decision as D-93a).
- D-148a (issue #148, Q43): may keel-operator run the lockout-sensitive steps on the test tenant? These are:
  - create and change the fixture custom role `KEEL-RT-148-role` (one harmless permission: group names and
    descriptions), assign it to `keel-rt-20260908-carla` and make her eligible for it, both scoped to the fixture
    administrative unit `KEEL-RT-148-unit`. Never a built-in privileged role, never a break-glass principal;
  - create, change and delete a named location and a custom authentication strength that no policy uses;
  - drift the authorization policy's guest-invitation setting;
  - turn off "MFA on activation" in the PIM settings of the fixture role `KEEL-RT-148-role`;
  - switch one authentication method that no break-glass account uses;
  - try security defaults;
  - create, change, delete and restore a report-only Conditional Access policy scoped to one fixture group;
  - turn that policy **on by hand**, for `keel-rt-20260908-carla` only, **before the snapshot** of the soft-delete
    restore step, so that the backup has it on;
  - let KEEL turn it **on** again, for `keel-rt-20260908-carla` only, in the enforcement step.

  KEEL restores each one behind the break-glass lockout gate. You stay signed in as a second Global Administrator
  while these steps run.
  - Decision: yes (Marouane, #147 thread, 2026-10-10 14:55 UTC): "yes, leave marouane.defili alone; there are other
    admins and users you could target. Make sure I'm whitelisted from any new CAs." So: never target, assign, drift or
    sign in as `marouane.defili`, and every Conditional Access policy the gate creates or turns on lists that account
    under excluded users (as well as the break-glass accounts).
- D-148b (issue #148, Q43): may keel-operator drift these tenant-wide settings on the test tenant and let KEEL put them
  back?
  - the Group.Unified directory setting, including deleting it for the delete step (the restore cannot recreate it,
    so it is recreated by hand from the values written down first);
  - the cross-tenant access defaults and `allowedCloudEndpoints`;
  - the admin consent request policy;
  - a cross-tenant partner entry for a tenant you name;
  - the company branding and one branding localization (sign-in page text; fr-FR is added if none exists);
  - the group expiration policy (the lifetime is made longer, never shorter);
  - the self-service sign-up switch for external users.
  - Decision: yes (Marouane, #147 thread, 2026-10-10 14:55 UTC).
  - Partner tenant (Marouane, 2026-10-10 14:56 UTC): "there are existing configs, but I don't know if they're still
    active/functional. I don't have another tenant tho."
  - Follow-up (Marouane, 2026-10-10 15:53 UTC): "no, they're not being used." So:
    - the fixture is one of the EXISTING partner entries (pick one, write down all its settings first);
    - drift its inbound MFA trust, let KEEL restore it, capture and promote;
    - leave it in place afterwards, set back to the values written down. No new partner entry is created, and the
      other existing entries are not touched.

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
- Status: done
- Result: **Done** (13:13 note: cancel both, preflight, steps 3 and 5; **step 4 skipped**, deploy.sh goes to vps-deployer).
  Started at `/opt/keel-live` = **b9e5f6b** (#111).
  - (a) `keel-schedules-host cancel`, both returned `{"status":"cancelled","ok":true}` with `job.cancelled` events:
    - `6f682eec-8338-4530-8dc8-0216dc38e6fe` (restore of authorizationPolicy), reason "stale 2026-10-03 restore;
      cancelled before worker install (Q24, Marouane 13:11)".
    - `16869853-ebe2-48ae-9ef4-75b77e663ba1` (backup tier1), reason "stale 2026-10-02 backup; …".
  - (b) preflight: `{"backlog":[],"autoRemediatePolicies":0,"schedules":[],"blockers":[],"ok":true}`, exit 0.
  - Step 2 (earlier): `/opt/keel` is not `/opt/keel-live`.
  - Step 3 `bash ops/keel-schedules-install.sh --root /opt/keel-live` exit 0: installed `keel-worker.service`,
    `keel-scheduler.service/.timer` (ExecStart/WorkingDirectory under /opt/keel-live), seeded collect schedules for
    sha256:f7b3959300856957, enabled the worker and the scheduler timer (both active).
    - **Note:** before install, `keel-backup-tier1/2/3.timer` were **enabled and active** (not disabled as assumed);
      the migrate step disabled them (PASS lines).
    - **Note: it also disabled `keel-offsite.timer`**, which Q31 had enabled at 13:12 today. The daily vol2
      offsite copy is **now off** (the script keeps offsite unscheduled, #89). Left as the installer set it.
      Coordinator: decide whether offsite runs via its own timer (re-enable) or a scheduler job.
  - Step 5 `run-now` queued tier1 `993a8d4c…`, tier2 `6d0cdf49…`, tier3 `841a12a7…`. All **succeeded**
    (14:09:07 / 14:09:19 / 14:09:21; snapshots 328ac529… / 1062d201… / c82fddf2…). After one scheduler tick,
    `health`: **ok true, exit 0**. Every tier: scheduled, lastRunSucceeded, fullCoverage, driftQueued all true,
    **failedTypes []**. nextDueAt: tier1 2026-10-05T15:00Z (hourly), tier2 2026-10-06T00:00Z, tier3 2026-10-12T00:00Z.
  - **Note:** `/opt/keel-live` was deployed to **ab074dc** during the wait. Because step 4 (worker try-restart in
    deploy.sh) is pending with vps-deployer, the long-running worker (active since Mon 2026-10-05 14:08:49 UTC) still runs the b9e5f6b code
    until it's restarted.
- Coordinator note (13:13 UTC): Marouane chose (13:11) to cancel both stale jobs through a new KEEL command,
  PR #111 (`keel-schedules-host cancel`). **Wait for #111 to merge and `/opt/keel-live` to deploy at or after its
  merge commit**, then: (a) `node cli/keel-schedules-host.mjs cancel --job 6f682eec-8338-4530-8dc8-0216dc38e6fe
  --reason "stale 2026-10-03 restore; cancelled before worker install (Q24, Marouane 13:11)"` and the same for
  `16869853-ebe2-48ae-9ef4-75b77e663ba1` (reason "stale 2026-10-02 backup; …"); report both JSON outputs;
  (b) re-run step 1 preflight, which should be `ok: true`; (c) steps 3 and 5. **Skip step 4** (deploy.sh): it goes to
  vps-deployer separately. Set Status back to queued yourself once #111 is deployed.
- Coordinator note (14:13 UTC): step 3's `keel-schedules-install.sh` currently **disables `keel-offsite.timer`** (fixed in
  #112, not yet deployed). Q37 re-enables it right after Q24; don't run the installer again until #112 is deployed.
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
- Coordinator note (15:08 UTC): Marouane chose to keep prune off until the gate 116 drill (Q36) passes. Stays **hold**.
- Coordinator note (16:35 UTC): gate 116 passed (Q36, 04d213d), so per Marouane's 15:08 choice this is released. Run it as written (dry run first; stop and report if the count is far above expectation).
- Status: done
- Result: **Done.** Prune schedule on; the first scheduled run pruned the expected 154 snapshots.
  1. `node cli/keel-prune.mjs --dry-run` (from `/opt/keel-live`, db.env sourced): **would prune 154 snapshot(s)**, which
     is exactly the Q25/Q28 count and nowhere near the stop threshold. The first ids are 0e0c9371…, 2d8c9c62…, 27ed0918…; the last is f74b0fac….
  2. TENANT_REF derived as in `keel-schedules-install.sh` (`tenantRefFor(tenant.json tenantId)`) = `sha256:f7b3959300856957`.
     `node cli/keel-schedules-migrate.mjs --tenant-ref … --kinds prune`: exit 0. Timer check **PASS** for
     keel-backup-tier1/2/3.timer and **keel-prune.timer (disabled and inactive)**. keel-offsite.timer was left alone (still
     enabled, since prune only was seeded).
  3. `SELECT job_kind, enabled, next_due_at FROM schedule WHERE job_kind='prune'` returns **`prune | t | 2026-10-06
     00:00:00+00`** (one row). The 3 existing collect rows are kept.
  4. **First run:** prune job `88ed8324-8188-4bc1-8526-421b0086a0a4` **succeeded** (created 2026-10-06 00:00:01,
     started 00:00:16, finished 00:00:34 UTC, no error). Result: **`pruned 154 snapshot(s): 0e0c9371…, 2d8c9c62…, 27ed0918…, …`**,
     the same set as the dry run. The schedule row moved on to `next_due_at 2026-10-07 00:00:00+00`.
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
- Status: superseded (gate 116 passed via Q36 at 04d213d, #126; recaptured at fb1493e in Q39)
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
- Coordinator note (15:00 UTC): reviewed and combined into PR #121 (8 record files, byte-identical to the four branch tips; gate tests 63/63). Thanks. Retention 20/30 is expected: gate 122 only extends, never shortens; ten more runs fit.
- Status: done
- Result: **Done: 120, 121, 122 and 123 all verified at one build, 76ee9b5** (the coordinator's 14:30 build; contains af926b4/#117,
  #116, #111, plus #112, #113). `/opt/keel-live` = master = 76ee9b5 (clean, deployed 14:39:58), unchanged throughout.
  - **Worker restarted** before the chain: `keel-worker` active since **Mon 2026-10-05 14:41:06 UTC** (runs 76ee9b5). No queued or running jobs at start.
  - Pre-checks: grants unchanged; all 25 doc URLs 200; carla absent from roster, owners and members before 121.
  | Gate | Branch @ commit | Capture | verify --require-live --build 76ee9b5 (all four side by side) |
  |---|---|---|---|
  | 120 SharePoint | `claude/live-evidence-120` @ **9f83a9a** | 0 | ok, exit 0 |
  | 121 Teams | `claude/live-evidence-121` @ **1102578** | 0 | ok, exit 0 |
  | 122 Exchange | `claude/live-evidence-122` @ **72e2036** | 0 | ok, exit 0 |
  | 123 OneDrive/Purview | `claude/live-evidence-123` @ **41de485** | 0 | ok, exit 0 |
  - **Gate 123 `notQualifiedFields`: `{"label": []}`, empty as expected** (protection fields read from LabelActions).
    Fixture label: fresh `KEEL-RT-20261005-label3` (created 14:30, unpublished before the capture; now published by
    KEEL-RT-20261005-policy, alice only, Comment restored).
  - 121: the record notes one intermediate "removing the fixture user's group member link failed (HTTP 400)", but the
    restore verified, and my re-checks 14:42 → 14:46 (5×) show roster, owners and members all 0.
  - After: SharePoint resharing back to false ("isResharingByExternalUsersEnabled": false). Alice timeZone UTC, client access restored, retention **20.00:00:00** (D-122d).
  - Secret scan of all eight files: clean. These supersede the 248b12c records (merge the four together).
- Needs: PR #111 merged and deployed; **Q24 finished first** (stale jobs cancelled, worker installed, its run-now
  collections done), so no collection starts mid-chain.
- Before the chain: `systemctl restart keel-worker` once `/opt/keel-live` is at the named build, so the worker runs it too
  (deploy.sh doesn't restart it yet; Q24 step 4 is with vps-deployer). Report `systemctl status keel-worker` start time.
- Do: exactly as Q10 (same pre-checks and decisions), at the new build, with a fresh unpublished
  `KEEL-RT-<date>-label3` for 123. Expect gate 123's `notQualifiedFields.label` to be **empty**: the ten protection fields
  now come from LabelActions. If any are still listed, stop and report the 123 capture's label fieldCoverage.
  Commit each gate to `claude/live-evidence-<gate>` as before. Poll every 5 minutes while queued or running.

### Q36: Gate 116 drill rerun (Q6) at the same build as Q35 — issue #85
- Coordinator note (15:00 UTC): right diagnosis. The Gate 116 thread (#85) owns the fix (schema.sql or reconstruction runs the bootstrap journal migration). Keep this **blocked** until I add a note with the fix's merge commit; then rerun from step 1 at that build once deployed. Master is unfrozen meanwhile.
- Coordinator note (15:00 UTC, #2): fix is PR #122 (reconstruction runs KEEL's runtime migrations after schema.sql). **You can run
  this read-only pre-check now** (it writes nothing but /tmp) and put its output in the Result. If it prints any table
  name, stop and report it; the drill doesn't rerun until it prints nothing. The dump is the Q36 one
  (`/root/keel-q6-116/keel-db-2026-10-05-q36.sql.gz`; use the copy in the recovery set if that's where it is):
  ```
  zcat /root/keel-q6-116/keel-db-2026-10-05-q36.sql.gz | grep -oE '^COPY public\.[a-z_0-9]+' | cut -d. -f2 | sort -u > /tmp/dump-tables.txt
  echo "alert alert_escalation_rule alert_event_receipt alert_transition api_drift_candidate api_drift_source approval_request audit_change_fact audit_ingest_event audit_ingest_run audit_ingest_state audit_sign_in_fact auto_remediation_execution baseline baseline_resource benchmark_evaluation benchmark_exception bootstrap_event bootstrap_plan breakglass_account breakglass_lifecycle_event change_intent change_intent_event channel content_effect_approval delivery disposition drift evidence evidence_head incident incident_compromise_interval incident_recovery_override incident_snapshot_assessment itsm_adapter_config itsm_decision itsm_identity_map itsm_inbox itsm_outbox_event itsm_record itsm_record_version job plan policy policy_activation policy_activation_preview principal recovery_completion_event recovery_completion_item relationship_edge relationship_edge_set resource_lineage resource_lineage_alias resource_lineage_recovery resource_ownership_evidence resource_reference resource_symbol resource_version restore_dry_run retention_pin role_grant rollback_entry schedule siem_destination siem_outbox_event siem_replay_checkpoint snapshot subscription workload_collection workload_observation" | tr ' ' '\n' | sort -u > /tmp/recon-tables.txt
  comm -23 /tmp/dump-tables.txt /tmp/recon-tables.txt   # must print nothing
  wc -l < /tmp/dump-tables.txt
  ```
  Once #122 is merged and deployed I'll add a note with its build; then rerun Q36 from step 1 (fresh recovery set) at that build.
- Coordinator note (15:10 UTC, #3): **#122 is merged as `0cbf9f7`.** Once master CI is green and `/opt/keel-live` is deployed at `0cbf9f7` (or any later master that contains it; #121 is evidence only), set this to in-progress and rerun from step 1 at the deployed build: run the read-only table pre-check from note #2 first (stop if it prints a table), then a fresh recovery set, reconstruction, the bounded drill, and evidence to `claude/live-evidence-116`. Record the build you ran at.
- Coordinator note (15:16 UTC, #4): #121 (evidence only) merged as `fcd9610` right after `0cbf9f7`. Run at **`fcd9610`** so its deploy (which restarts keel-worker) doesn't land mid-drill.
- Coordinator note (15:33 UTC, #5): thanks, good stop. Neither (a) nor (b): leave `keel_test` untouched and give the drill
  its own fresh DB (the drill and capture-drill already take `--db-url`; the only guard refuses KEEL_DB_URL). Same build
  fcd9610; master stays frozen. Steps 1-3 (set q36b, reconstruction.json, onboarding.json) stay valid.
  1. Create a fresh disposable DB `keel_drill_q36` the same way `keel_recovery_q6` was made (never KEEL_DB_URL); set
     `DRILL_URL` to it.
  2. From `/opt/keel-live`: `psql "$DRILL_URL" -v ON_ERROR_STOP=1 -f engine/store/schema.sql`.
  3. Then the runtime migrations, from `/opt/keel-live`:
     `node -e "import('./tools/recovery/reconstruct.mjs').then(async m=>{const pg=(await import('pg')).default;const c=new pg.Client({connectionString:process.env.DRILL_URL});await c.connect();for(const f of m.RUNTIME_MIGRATIONS)await f(c);await c.end()})"`
  4. Rerun from build-manifest (a new `keel-rehearsal-*` group for this run is expected), the offline plan and the live
     drill with `--db-url "$DRILL_URL"`; then `capture-drill --db-url "$DRILL_URL" --tenant <ref> --build fcd9610…`,
     then `verify --require-live` (must exit 0). Push the evidence to `claude/live-evidence-116`. Set Status in-progress
     when you start.
- Coordinator note (15:56 UTC, #6): thanks. This is a code bug (applyEngine rollback reports residual drift with an empty diff); the Gate 116 thread (#85) owns the fix. Stays **blocked** until I add a note with the fix's deployed build; then rerun from step 1 (fresh set, reconstruct, fresh drill DB as in note #5) at that build. Master is unfrozen meanwhile.
- Coordinator note (16:06 UTC, #7): the rollback fix is **PR #125**. Once #125 is merged and `/opt/keel-live` is deployed
  at a build that contains it (check: `git -C /opt/keel-live log --oneline | grep -m1 "#125"`, or a later coordinator
  note naming the sha), set this to in-progress and rerun **every step** at that build (capture-drill requires the
  reconstruction build to match): table pre-check, fresh recovery set, reconstruct, a fresh drill DB (new name, e.g.
  `keel_drill_q36b`; schema.sql + RUNTIME_MIGRATIONS as in note #5), build-manifest, offline plan, the live drill and
  capture-drill (both `--db-url "$DRILL_URL"`), `verify --require-live` (exit 0), evidence to `claude/live-evidence-116`.
  If a deploy lands mid-run, stop and restart from the recovery set at the new build.
- Coordinator note (16:16 UTC, #8): **#125 is merged as `04d213d`** (on top of #124 `e3d9563` and #120 `3f31f85`). Run note #7 at `04d213d` once `/opt/keel-live` is deployed there. Master is frozen until Q36 finishes.
- Coordinator note (16:35 UTC): thanks, clean run. Evidence goes to the Gate 116 thread (#85) for review and its PR. The leftover disposable DBs (`keel_drill_q36`, `keel_recovery_q6`) can stay until the next cleanup pass.
- Status: done
- Result: **Done. Gate 116 (drill-live-acceptance) is live-qualified at `04d213d`: evidence `claude/live-evidence-116` @ `3bb5e20`
  (`verify --require-live`: `{"ok":true,"failures":[]}`, exit 0).** The build stayed 04d213d for the whole run (checked
  before each stage); keel-worker was on it since 16:25.
  - **Table pre-check** (fresh dump): `comm -23` printed nothing; 65 dump tables.
  - **Fresh recovery set** `/opt/keel-recovery-sets/2026-10-05-q36c`: dump sha256 33ebb5d4…, manifest sha256 6e2b7e74…,
    schema pin 2a20d4ae…, snapshot 3b235127…, **evidence head
    496:d5909bd0722217c7a760f2390730a4f773c9f0d8aa817b9fdd5ba414ad6b7c85:496** (stable across dump and set). `--verify`:
    recovery complete.
  - **Reconstruction** (signed-assertion, Q20 key) into a fresh disposable `keel_recovery_q36c` (never KEEL_DB_URL): exit 0;
    ok, stage recovered, readOnly, writersDisabled, recoveryComplete, incomplete [], buildRevision 04d213d…, completedAt
    2026-10-05T16:29:32.858Z; 496 records, chain ok.
  - **Drill DB** `keel_drill_q36b` (fresh; schema.sql + 2 RUNTIME_MIGRATIONS; 70 tables).
  - **build-manifest:** one object `group:keel-rehearsal-2026-10-05T16-29-47-942Z`, bounds 900000 ms / 30 writes.
    **Offline plan:** ok, no findings.
  - **Live drill: exit 0, outcome `passed`, `countsAsRecoveryDrill: true`**, 63.5 s, 10 writes. Group
    4f4f42c0-9032-4c6d-9fce-7dbaec6772cc created → baseline eaeed3bf (snapshot df2eaecb, hash 93723a09…) → drift →
    drift 11345f82 detected → **rollback applied 1, failed 0** → restored hash = baseline hash → immutable-field probes
    (mailNickname 204; mailEnabled, securityEnabled, groupTypes 400 as expected) → deleted; **cleanup complete,
    verifiedAbsent, residuals []**. Re-checked: `/groups/4f4f42c0…` and `/directory/deletedItems/4f4f42c0…` both 404, 0
    `keel-rehearsal*` groups.
  - **capture-drill** `--db-url keel_drill_q36b --build 04d213d…`: evidenceLevel live-qualified. Committed
    `drill-live-acceptance.json` + `.capture.json` (secret scan clean: no HMAC key, DB credential, JWT or PEM).
  - Run ids (onboarding.json): read setup `cbd974b9ef106fda5b2d31467b7d07b36de6e092eb16b5a76892ec5b34dda144`, restore
    setup `174d8db69f61c81cb76c54c1a5708a09d04a70754e5911a7207316dcb35d3d74`.
  - Credentials: Collector (tenant.json) + Restorer (restorer.json); no global admin. Earlier failed attempts (fcd9610)
    left no tenant residue; their disposable DBs `keel_test` (untouched), `keel_drill_q36`, `keel_recovery_q6` remain.
- Needs: PR #116 (reconstruct imports real pg_dump: COPY blocks, \restrict/\unrestrict, FK-ordered load) merged and deployed.
- Do:
  1. Build a fresh recovery set (backup dump + manifest) at the deployed build, as in Q32.
  2. Rerun Q6 with `/root/keel-q6-116/onboarding.json`: reconstruct.mjs into a disposable DB (never KEEL_DB_URL),
     build-manifest, offline plan, the live bounded drill (**one `keel-rehearsal-*` group only**), capture-drill with
     `--build` = the deployed build, `verify --require-live` (expect exit 0). Push the evidence to `claude/live-evidence-116`.
  3. Report the run ids and the evidence commit in Result.
- Hard rules as usual: no tenant-wide settings, no grants, no secrets printed.

### Q37: Re-enable the offsite timer after Q24 — issue #89
- Status: done
- Result: **Done.** `systemctl enable --now keel-offsite.timer` re-created the timers.target.wants link.
  `systemctl list-timers keel-offsite.timer`: **NEXT Tue 2026-10-06 05:00:00 UTC**, LAST Mon 2026-10-05 13:12:05 UTC
  (no catch-up run fired this time). `is-enabled`: **enabled**; `is-active`: active. The service unit still has
  `ExecStart=/opt/keel-live/ops/keel-offsite.sh` (Q31). Nothing else changed; installer not re-run.
- Why: the Q24 installer (before #112) turns `keel-offsite.timer` off; Q31 had it enabled for vol2.
- Do, as root: `systemctl enable --now keel-offsite.timer`, then `systemctl list-timers keel-offsite.timer`. Report the
  next run (expect 2026-10-06 05:00 UTC) and `systemctl is-enabled keel-offsite.timer`. Nothing else.
- Don't re-run `keel-schedules-install.sh` until #112 is deployed.


### Q38: Drop the throwaway drill and recovery databases — issues #84, #85
- Status: done
- Result: **Done.** Step 1 listed 4 databases: `keel_drill_q36`, `keel_drill_q36b`, `keel_recovery_q36c`, `keel_recovery_q6`.
  Each was dropped on its own with `DROP DATABASE` (all succeeded). Rerunning the step 1 query: **0 rows**. Remaining
  databases: `postgres`, `keel` (live), `keel_test`, `keel_servicenow_qualification`, all untouched.
- Why: the gate 116 attempts left disposable databases on the host (keel_drill_q36, keel_drill_q36b,
  keel_recovery_q36c and older keel_recovery_* ones). Gate 116 evidence is merged (#126), so none is needed.
- Do, as root with `/etc/keel/db.env` sourced:
  1. List them: `SELECT datname FROM pg_database WHERE datname LIKE 'keel\_drill\_%' OR datname LIKE 'keel\_recovery\_%';`
  2. `DROP DATABASE` each listed name, one at a time. Only names matching those two patterns. Never the live
     database, `keel_test`, or anything else.
  3. Rerun the query from step 1 (expect 0 rows) and report the names you dropped.

### Q39: Gate 124 recapture: every live gate at one frozen build, then the release ledger — issue #86
- Drafted by the "Gate 124 release ledger" thread (#86). Released 2026-10-07 10:37 UTC (see the coordinator note).
- Coordinator note (10:37 UTC): every prerequisite is merged and deployed. #137 (119 capture) deployed as ace227a,
  #139 as 2a01d0a, and #140 as **fb1493e** (deployed 10:29 UTC, health ok). B is fb1493e unless /opt/keel-live has moved;
  report B first. **Master is frozen from now until the ledger runs.** For 123 follow
  docs/roadmap/onedrive-purview-live-acceptance.md step 7 at B (`--fixture-site <OneDrive URL>` is required and checked
  against the chain's host or its pseudonym). Recapture 120 → 123 together in this run. Released by the #84 thread.
- Coordinator decision (11:30 UTC, #84 thread): **(a), retry 121 once at B unchanged.** The settings fingerprint code is
  the same as when 121 passed at 76ee9b5 (d6825c9 only pseudonymizes ids). The final read stops as soon as the toggle
  matches, so another team field lagging behind the revert is the likely cause. Steps:
  1. Keep `keel-scheduler.timer` stopped. Read the fixture team once (read-only) and confirm the four setting groups are at
     the original values and the fixture member is gone.
  2. Run 121 → 122 → 123 at B, exactly as this run's 120–123 chain (123 with `KEEL-RT-20261007-label` and
     `--fixture-site`). 120 stays as committed (`-124-120` @ 5583e75), so don't recapture it.
  3. If 121 fails again with the same settings mismatch: stop, keep both failed 121 captures uncommitted, run
     `systemctl start keel-scheduler.timer`, and report. That means (b): a code fix and a new B, which the #84 thread
     will open.
  4. If 121–123 verify: commit each to `claude/live-evidence-124-<gate>` with the same evidence tests and scan.
     Run `systemctl start keel-scheduler.timer` **before** the ledger, report the time, then run the journeys and the
     ledger at B as below.
- Status: done
- Result: **Done. All ten live gates are live-qualified at B = `fb1493ea6a54d48fca03429409a35991a6386871`, and the ledger ran at B.**
    /opt/keel-live stayed at B, clean, for the whole run. Master can unfreeze.
  - keel-worker restarted at B: **2026-10-07 10:48:53 UTC**.
  - NIST pre-check (`node --test roadmap/nist-benchmark-acceptance.test.mjs`): **7/7 pass, 0 skipped**. The file at B
    defines exactly 7 tests, not 8 as the entry says.
  - **No collection mid-chain:** the hourly collect row (`021c5ced…`) ran at 11:00:07–11:00:16 and was next due at 12:00.
    No KEEL CLI pauses one row, so I **stopped `keel-scheduler.timer`** (still enabled) at 11:01 for the chain. I'll
    restart it before the ledger.
  - One fresh recovery set at B for 114 and 116: `/opt/keel-recovery-sets/2026-10-07-q39` (dump sha256 3415e2c8…,
    manifest 52595909…, evidence head 4656:267fbacd…:4656, stable).
  - 113 deployed-acceptance: verify ok, exit 0 → `claude/live-evidence-124-113` @ 321a0b3. (Access login renewed with the operator.)
  - 114 storage-live-acceptance: copy `/mnt/keel-copy/2026-10-07-q39` (dev 2064 vs 2049, digests match), captured as
    keel-recovery, checkpoint 4656: verify ok, exit 0 → `-124-114` @ 018c708.
  - 115 native-live-acceptance: `KEEL-RT-native-recovery-group` deleted and restored once; active again, not in deleted
    items, 0 members: verify ok, exit 0 → `-124-115` @ e7d9b84.
  - 116 drill-live-acceptance: reconstruction into fresh `keel_recovery_q39` (4656 records, chain ok); fresh drill DB
    `keel_drill_q39`; drill `group:keel-rehearsal-2026-10-07T11-06-54-685Z` passed, 9 writes, cleanup complete:
    verify ok, exit 0 → `-124-116` @ 44846fb.
  - 118 servicenow-live-acceptance (dev426571): verify ok, exit 0 → `-124-118` @ c43936c.
  - 119 nist-benchmark-acceptance (principal marouanedefili@…, read-only): verify ok, exit 0 → `-124-119` @ b13ca2a.
  - The committed-evidence tests for 113/114/115/116/118 pass. 116/118 ran on a throwaway `keel_test_q39`; keel_test was
    untouched. The secret and raw-id scan of every file is clean.
  - 120 sharepoint-live-acceptance (`--allow-widening-toggle`, as Q35): verify ok, exit 0 → `-124-120` @ 5583e75. Resharing
    is back to false. The committed-evidence test and scan are clean.
  - **121 first attempt (11:08): capture exit 1.** `verify.failures`: `teams.settings.update: the final settings do not match
    the starting settings`.
    - settingsWrite (funSettings.allowCustomMemes): ok, readBackVerified, **restoredToOriginal true**, but
      preFingerprint 3f11b60c… ≠ finalFingerprint 436d0427….
    - Membership add/update/remove: all ok and read back; membership and owner fingerprints are equal before and after;
      ownerLinkRemoved true.
    - `teamSettingsFingerprint` hashes the **whole** team GET body (every non-@odata key), not just the setting groups,
      and the capture log keeps no bodies. So some other field of the team object differed between the first and the
      final read. Most likely this is Graph read inconsistency, or a field Microsoft updates on any write. I can't tell
      which from the log.
    - The team now (11:15, read-only): all four setting groups at the expected values (allowCustomMemes true), not
      archived. Fixture member roster/owners/members = 0 at 11:10, 11:11 and 11:12. **No residue in the tenant.**
    - Failed 121 files kept locally (scratchpad `q39-121-fail/`), not committed; never edited.
  - **121 retry (decision a, 11:27):** fixture team pre-read showed all four setting groups at their original values and
    the member gone. Capture exit 0; **verify ok, exit 0** → `-124-121` @ 9b096b5. A non-fatal log line, "removing the
    fixture user's group member link failed (HTTP 400)": the link was already gone. Roster, owners and members were all
    0 at 11:29–11:32 (5×). The first failed capture stays local and uncommitted.
  - 122 exchange-live-acceptance: verify ok, exit 0 → `-124-122` @ 026e505 (readBackVerified ×3, restoredToOriginal ×2).
  - 123 onedrive-purview-live-acceptance, with fresh unpublished `KEEL-RT-20261007-label` (created 10:55, not in
    `KEEL-RT-20261005-policy`) and `--fixture-site` alice's OneDrive: verify ok, exit 0 → `-124-123` @ b4500ce.
  - The evidence tests for 121/122/123 pass (14/10/11) and the scans are clean.
  - **`keel-scheduler.timer` restarted at 11:37:44 UTC**, before the ledger (stopped 11:01–11:37; it ran its tick at once).
  - **Ledger at B**, run from the B worktree (same commit as /opt/keel; I didn't run git there):
    - Journeys: `journeys.mjs run --db-url <fresh keel_journeys_q39>` → exit 0, 6 journeys.
    - Ledger: `qualification.mjs ledger --fixture journeys-B.json --tenant sha256:f7b3959300856957 --build fb1493e…
      --qualifications <the eleven new records>` → exit 0. Copies are in `/root/keel-q39/{ledger,journeys}-B.json`.
    - **readiness.label: `pending`**. readiness.reasons, 17 lines: `objective D1 is gap`, D2, D3, D4, D5, D7, D8, D9, D10,
      G1, G2, G3, G4, G5, G6, G7, G8 (each "objective X is gap"; D6 is not listed).
    - **acceptedGaps**: "sentinel-live-acceptance (task-117) is pending, an accepted gap: descoped by operator decision
      2026-10-04 12:36 UTC (D-117: no Sentinel test workspace); Sentinel export ships live-unqualified".
    - **live[]**: deployed, storage, native, drill, servicenow, nist-benchmark, sharepoint, teams, exchange and
      onedrive-purview are **live-qualified**; sentinel-live-acceptance is **pending**, the accepted gap. As expected.
  - Leftover disposable DBs: keel_recovery_q39, keel_drill_q39, keel_test_q39, keel_journeys_q39 (drop with a Q38-style
    item). Credentials: Collector, Restorer, Exchange/Purview app configs, ServiceNow dev; no global admin.
- Needs: #137 (119 capture, merged 09:57) and #140 (follow-up to #139, merged 10:12: pseudonymizes the raw
  tenant GUID, client ids, object ids and Teams membership ids in the 120→123 capture tools and validators) both
  merged and deployed. The
  keel-powershell rebuild is done (13df115, 2026-10-07 09:55).
- The build **B** is whatever `/opt/keel-live` is at when this starts (`git -C /opt/keel-live rev-parse HEAD`).
  Report B before starting.
- Pre-check on the host at B: `cd engine && node --test roadmap/nist-benchmark-acceptance.test.mjs` (needs the
  pinned catalog). All 7 tests must pass; otherwise stop and report.
- **Master freeze**: no merge to master from the first capture until the ledger runs. Restart
  `keel-worker` at B before starting and report its start time. No collection may run mid-chain (same as Q35).
- Why: every gate is qualified today, but at six different builds (113/115 `33ad2a9`, 114 `df0de36`,
  116 `04d213d`, 118 `87e366e`, 119 `efeb7af`, 120-123 `76ee9b5`). The ledger verifies every record against one
  `--build`, so all of them must be recaptured at B. 117 is descoped (accepted gap), so nothing is needed for it.
- Do, in this order, each exactly as its last successful run (same fixtures, decisions and guardrails;
  steps in `docs/roadmap/operator-gates.md`), with `--build B`:
  1. 113 deployed-acceptance (no tenant writes).
  2. 114 storage-live-acceptance from the `/mnt/keel-copy` copy (no tenant writes).
  3. 115 native-live-acceptance (one disposable `KEEL-RT-native-recovery-group`).
  4. 116 drill-live-acceptance, as Q36 (reconstruction and onboarding results at B).
  5. 118 servicenow-live-acceptance (non-production instance only).
  6. 119 nist-benchmark-acceptance (needs #137 merged and deployed):
     `KEEL_QUALIFICATION_HMAC_KEY=... node tools/qualification/nistLive.mjs capture --live --db-url "$KEEL_DB_URL" --principal-email <operator email> --tenant <ref> --build B --out <dir>/nist-benchmark-acceptance.json`.
     It reads only principal and role-grant rows and calls no tenant API. The principal needs `configuration`. The
     pinned catalog must be at `/var/lib/keel/reference-data/nist-sp800-53-rev5.2.0-catalog.json`.
  7. 120 → 121 → 122 → 123 as Q35 (a fresh unpublished `KEEL-RT-<date>-label<n>` for 123).
     Pseudonyms are keyed on tenantRef, so 120 → 123 must all be recaptured in this same run. The OneDrive CLI now refuses a raw chain, and the 123
     capture takes the real site host via `--fixture-site` (exact flags in #139/#140's docs).
- After each capture, run `qualification.mjs verify --require-live --gate <gate> --build B --tenant <ref>` and
  record the exit code. A refusal or failure is a result: report it and stop the chain. Never edit a record by hand.
- Commit each gate to `claude/live-evidence-124-<gate>`. **The repo is public**: run the committed-evidence
  check (`engine/test/committedEvidence.mjs` rule) and a secret scan on every file before committing; no
  credential material, tokens, or anything beyond what the current committed records already contain.
- Then at B, from `/opt/keel`:
  - `node tools/release/journeys.mjs run --db-url <isolated test URL> --out /tmp/journeys-B.json` (never `KEEL_DB_URL`).
  - `KEEL_QUALIFICATION_HMAC_KEY=... node tools/release/qualification.mjs ledger --fixture /tmp/journeys-B.json --tenant <ref> --build B --qualifications <dir holding the eleven new records> --out /tmp/ledger-B.json`
  - Report `readiness.label`, every line of `readiness.reasons` and `readiness.acceptedGaps`, and each `live[].status`.
    Expected: every gate `live-qualified`, 117 listed as an accepted gap, and the label still `pending` only
    because of the objective gaps (D1-D10, G1-G8), unless that decision has been made by then.
- Poll every 5 minutes while queued or running.

### Q40: Drop the Q39 throwaway databases — issues #84, #86
- Status: done
- Result: **Done.** Step 1 listed all four: `keel_drill_q39`, `keel_journeys_q39`, `keel_recovery_q39`, `keel_test_q39`.
  Each was dropped on its own (all succeeded). Rerunning the step 1 query: **0 rows**. Remaining databases: `postgres`,
  `keel` (live), `keel_test`, `keel_servicenow_qualification`, all untouched. `/opt/keel-recovery-sets/2026-10-07-q39`
  and `/root/keel-q39/` are kept until the gate 124 evidence PR is merged.
- Why: Q39 (gate 124 recapture) is done, and its evidence lives in the `claude/live-evidence-124-*` records. It left four
  disposable databases on the host: `keel_recovery_q39`, `keel_drill_q39`, `keel_test_q39`, `keel_journeys_q39`.
  None of them is needed any more.
- Do, as root with `/etc/keel/db.env` sourced, the same way as Q38:
  1. List them: `SELECT datname FROM pg_database WHERE datname IN ('keel_recovery_q39','keel_drill_q39','keel_test_q39','keel_journeys_q39');`
  2. `DROP DATABASE` each listed name, one at a time. Drop only those four names. Never touch the live database,
     `keel_test`, `keel_servicenow_qualification`, or anything else.
  3. Rerun the query from step 1 (expect 0 rows) and report the names you dropped.

### Q41: Remove the Q39 recovery set — issues #84, #86
- Status: done
- Result: **Done.** #142 confirmed merged (`7a9dc08`). Removed exactly two directories, each holding config-export,
  keel-db.sql.gz, recovery-manifest.json and recovery-set.json: `/opt/keel-recovery-sets/2026-10-07-q39` and
  `/mnt/keel-copy/2026-10-07-q39`. Both are gone.
  - Left in `/opt/keel-recovery-sets/`: `2026-10-04`, `2026-10-05-q36`, `2026-10-05-q36b`, `2026-10-05-q36c`,
    `2026-10-05-q6`.
  - Left in `/mnt/keel-copy/`: `2026-10-04`, `keel-offsite`, `lost+found`.
  - Kept `/root/keel-q39/` (`ledger-B.json`, `journeys-B.json`, plus `keel-db.sql.gz`, the Q39 dump I left there).
- Why: the gate 124 evidence is merged (#142, master `7a9dc08`, #86 closed), so the Q39 recovery set is no longer needed.
- Do:
  1. Remove `/opt/keel-recovery-sets/2026-10-07-q39` and its copy `/mnt/keel-copy/2026-10-07-q39`. Remove only those two
     directories.
  2. List what's left in `/opt/keel-recovery-sets/` and `/mnt/keel-copy/`, and report it.
  3. Keep `/root/keel-q39/` (the ledger copies).

### Q42: Copy the D1-D10 and G1-G8 release objective definitions into the repo — issue #86 follow-up
- Drafted by the "Gate 124 release ledger" thread. Marouane chose "Supply definitions" on 2026-10-08 14:28 UTC. Released by the #84 thread.
- Status: done
- Result: **Done: `claude/release-objectives-source` @ e1896b4**, which adds only `docs/release/objectives-source.md`. No PR.
  - Spec `/root/docs/superpowers/specs/2026-09-15-keel-roadmap-final-review.md` (212 lines, mtime 2026-09-15 09:22), sha256
    **acdc51c7b4cc220d9fb88bcb0f90a0875cf71e06f961ef2f14e92d220126b3e1**.
  - **The spec has no definition sections.** D1-D10 and G1-G8 appear only in its "Gap/decision" traceability table (spec lines
    168-187): id, short title, and owner task numbers (sometimes with a qualifier such as "manual until proven"). There is no
    longer definition or acceptance/"done when" text. Line 36 says the defining text is in "parent workstreams/G1-G8/D1-D10".
    So I copied that table verbatim, and the file says so.
  - **Objectives found: 18 of 18** (G1-G8, D1-D10), each once. None missing, none defined twice. (D6 and D3 are included
    too, although the ledger doesn't list them as gaps.)
  - **Step 1 grep** (`\b(D10|G8)\b` under /root/docs/superpowers/), every file that matches; I didn't pick one:
    - `plans/2026-09-15-keel-roadmap-tasks.json`
    - `plans/2026-09-15-keel-complete-roadmap.md`
    - `specs/2026-09-15-keel-roadmap-final-review.md` (the one copied)
    - `specs/2026-09-14-keel-ws2-codex-review.md`
    - `specs/2026-09-14-keel-vision-codex-review.md`
    - `specs/2026-09-14-keel-final-app-map.md`
    - `specs/2026-09-14-keel-vision-merge-check.md`
    - `specs/2026-09-14-keel-holistic-portal-vision.md`

    The fuller definitions are probably in one of these, most likely the complete-roadmap plan or the holistic vision.
    **Coordinator: name one if you want its definitions copied as well.**
  - **Redactions: 0.** The copied lines hold no id, GUID, email, host, IP, credential, token, `/etc` path or tenant name. The
    source path is already public in `docs/roadmap/COMPLETE-ROADMAP-PLAN.md`. The secret scan (HMAC key, JWT, PEM, Bearer, DB
    URL, GUID, email, `/etc`, IP) is clean.
  - Read only: no tenant calls, no service changes.
- **Why:** the release ledger stays `pending` on 17 objectives (D1, D2, D4, D5, D7-D10, G1-G8; D3 has no live gate). Their text exists only in
  `/root/docs/superpowers/specs/2026-09-15-keel-roadmap-final-review.md` on Mulinux (see `docs/roadmap/COMPLETE-ROADMAP-PLAN.md:64`).
  Once the text is in the repo, the builder can map each objective to its owners, tests and gates in `tools/release/acceptanceLedger.mjs`.
- **Read only.** No tenant calls and no service restarts. Nothing is written except one new file on a new branch.
- **Do:**
  1. In that spec, find the section(s) that define D1-D10 and G1-G8. If they're not there, run
     `grep -rln -E '\b(D10|G8)\b' /root/docs/superpowers/` and report every file that matches. **Don't** pick one.
  2. Copy each objective's id, title and full definition text **verbatim** into a new file at `docs/release/objectives-source.md`.
     Include any acceptance or "done when" lines the spec gives for each one.
     - Start the file with: the source path, the spec's own date, `sha256sum` of the spec file, and the time of the copy.
     - Copy nothing else from the spec: no findings, decisions or other sections.
  3. **The repo is public. Sanitize before committing:**
     - Replace any tenant id, directory id, GUID, email address, hostname or IP that isn't already in the public repo with `<redacted>`.
     - Remove any credential, token, path under `/etc`, or customer or tenant name.
     - List every redaction at the end of the file as "line N: <kind> redacted". List only the kind, never the value.
     - Run the same secret scan as Q39 on the file.
  4. Commit only that file to `claude/release-objectives-source` and push it. Don't open a PR; the builder thread will.
- **Report:** the branch and commit, the spec's sha256, the number of objectives found (expected 18: D1-D10 and G1-G8), any objective that's
  missing or defined twice, and the redaction count.
  - If the spec doesn't define all 18, still commit what it has and say which ids are missing.

### Q43: Entra live gate: run every registered Entra write once on the test tenant — issue #148
- Drafted by the #148 thread (builder, 2026-10-09). The tools and runbook are in the #148 PR.
- Status: blocked
- Result: **Blocked before the first restore (20:23 UTC, B = `b41d33e`).** No restore ran, so there is nothing to capture,
  promote or demote yet. Checklist first line: "Generated from the operation ledger: 51 registered operations, 52 steps."
  - **Blocker 1: code defect, not configuration.** Every restore stops in the apply wave with `Error: sign-in path gate
    requires at least one protected principal` (`engine/safety/signInPathGate.mjs:12`). `cli/keel-restore.mjs`
    (~L503 and ~L1108, the same filter in each restore path) derives `protectedPrincipalIds` from roleAssignment
    resources whose **natural key contains `GlobalAdministrator`**. Today's natural keys name the role by definition id
    (`roleAssignment:roleDefinition:62e90394-69f5-4237-9190-012177145e10@user:…@/`; 62e90394 is the Global Administrator
    template), so the filter never matches, the list is always empty, and every restore throws. Registering break-glass
    accounts (`breakglass_account`, empty) does not feed this gate (Marouane said "CONFIGURE THE ACCOUNTS" at 20:25 UTC; it
    would not clear it).
    **Coordinator: code fix needed.** Match the Global Administrator role definition id (or the role's templateId) instead
    of the display text, in every place that filter appears. Then requeue Q43.
  - **Blocker 2 (operator host):** this session's tool permission system refused two kinds of tenant-wide write, so I did
    not retry them:
    - the default company branding sign-in text (step 29: no default branding existed; a fixture text was needed);
    - the D-148b drifts for steps 18 (`allowedCloudEndpoints`), 19 (default inbound MFA trust), 22 (admin consent request
      duration) and 32 (self-service sign-up).

    These need Marouane to allow them for this session, or to make them himself. The lockout steps (33–52) will likely
    hit the same refusal.
  - **Steps 7 and 8 (owner edges) are blocked by design:** Entra keeps the last owner of the fixture group ("must have at
    least one owner"), and carla is the only fixture user allowed. Adding the fixture service principal as an owner did not
    count.
  - **Done so far:**
    - Scheduler: paused 20:16–20:24, now running again.
    - Fixtures created with the Restorer (no Global Admin): `KEEL-RT-148-group` (carla member and owner), `KEEL-RT-148-app`
      plus its service principal, `KEEL-RT-148-unit`, the Group.Unified setting (none existed), a partner entry for the
      Microsoft Services tenant (the 2 existing partners untouched), `KEEL-RT-148-compliance`, `-restrictions`, `-settings`
      (assigned to the fixture group only), branding localization fr-FR (this also created an empty default branding "0"),
      and a group expiration policy (Selected, 365 days, fixture group).
    - Snapshot S1 7570bb5a (pre-drift). Drifts were applied to the fixtures (descriptions/names, carla removed as member,
      compliance length 6, camera blocked, settings off, fr-FR text, lifecycle 400 days, partner MFA trust on,
      Group.Unified creation off). Carla's department was drifted and then **put back**.
    - Dry-run artifact 0049a1fa was not created (the restore failed before the persist).
  - **Left in the tenant:** all the fixtures above, in their drifted state. They are kept for a rerun and get the
    checklist's end-of-run cleanup. No tenant-wide setting outside the fixtures was changed. Originals are recorded in
    `/root/keel-148/originals.json` (root-only).
- Needs:
  - The #148 PR merged and deployed. Check: `/opt/keel-live/tools/qualification/live-gate-plan.mjs` exists.
  - Decisions D-148a and D-148b: both answered yes (2026-10-10), including how the cross-tenant partner step is done.
  - Marouane is available to approve each restore in the portal. The operator can never approve its own.
- Why: every registered Entra write (and the #155 Intune writes) is only fixture-tested. #148 is done when each one has
  a real capture from the test tenant, promoted through `qualifyLiveEvidence`, and the ledger shows `live-qualified`.
  An operation that fails live is demoted, with the reason recorded.
- **Test tenant only.** `entraLive.mjs capture` refuses any tenant that is not the test tenant. Captures are
  pseudonymized (#138); never paste an id into the Result.
- Do, at the deployed build B (your own checkout, never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. Generate the checklist: `node tools/qualification/live-gate-plan.mjs > ~/keel-148/plan-B.md`. Report its first
     line (expected at the time of writing: 51 registered operations, 52 steps, including the four #156 updates; a later
     build may list more).
  2. Follow `docs/roadmap/live-gate-148.md` and the checklist, in its order. For each step: set up the fixture, run the
     restore (dry run, Marouane's approval, `--enforce`), capture, promote, clean up.
     - Steps that are not lockout-sensitive may share one snapshot and one restore that selects several fixtures (one
       approval).
     - Lockout-sensitive steps run last and one at a time, each only after its break-glass precondition holds.
  3. A capture that exits 3 (the write failed): run the step's demote command and go on. Exit 4 (blocked: no such write,
     no recorded outcome yet, or recorded as done but the read-back is not verified): report the step as blocked, do
     not demote, and go on. Any refusal: report it and go on. Never edit a record.
  4. If a Conditional Access step says "may be ON", turn the policy off by hand at once, stop the run and report.
  5. Do the checklist's "End of run" cleanup.
  6. Commit every `*.json`, `*.capture.json` and `*.demotion.json` from the evidence directory under
     `docs/release/qualifications/entra-live/` on `claude/live-evidence-148`, branched from `origin/master`. Secret scan
     first (as Q39). Don't open a PR; the #148 thread will.
  7. With the key set: `node tools/qualification/operations.mjs --live-evidence <that directory>` and report the
     `live evidence ...` lines.
- Hard rules: the queue's rules apply. These are the only exceptions, and only as far as D-148a and D-148b allow:
  the Conditional Access, authentication method, authorization policy, security defaults and PIM steps, and the
  tenant-wide settings. Fixtures are `KEEL-RT-148-*` and the existing `keel-rt-20260908-carla`. Never touch the
  break-glass, admin or Global Reader accounts.
- **Marouane's account (D-148a):** never target, assign, drift or sign in as `marouane.defili`. Before any Conditional
  Access policy is created, restored or turned on, check that its excluded users list that account and the
  break-glass accounts; if not, add them by hand first and report it. A policy without the exclusion is never turned on.
- **Report:**
  - B and the checklist's first line.
  - Per step: captured / promoted / failed (demoted, with the reason) / blocked (why).
  - The evidence branch and commit.
  - The `--live-evidence` output.
  - Anything left in the tenant.
