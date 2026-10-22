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

### Q134: Read-only check that the Exchange app scope guard fails closed on unstable assignment reads (after #469, fixes #467)
- Drafted by the "App scope guard misses assignments" thread (2026-10-22), from your Q125 finding **#467**. Code: PR #469. The guard
  now reads `beta /roleManagement/exchange/roleAssignments?$filter=appScopeId eq '<id>'` first (only rows naming the scope count; a
  rejected or ignored filter proves nothing). If that finds none, it reads the full list 3 times
  (`APP_SCOPE_ASSIGNMENT_READS`). The filter update is written only when every read succeeds, no read repeats an id or lacks one,
  all reads return the same id set, and none names the scope. Otherwise it is skipped as a manual step (`exchangeAppScopeFilter`).
  The count is of distinct ids, with "at least" when the reads were in doubt.
- Needs: /opt/keel-live at the #469 merge or later (`grep -q APP_SCOPE_ASSIGNMENT_READS /opt/keel-live/engine/restore/identityObjectOperations.mjs`).
- Status: done
- Result: done (2026-10-22 08:12 UTC). The #469 guard is stable: 25 of 25 calls skipped as `exchangeAppScopeFilter`, each saying "used by 3", and `write` was never called. B = **c396a2c**. Restorer reads only; nothing written.
  1. `GET beta /roleManagement/exchange/roleAssignments?$filter=appScopeId eq '<L.id>'` (URL-encoded): **200**, **3 rows**, 3 distinct ids, no nextLink.
     Every row's `appScopeId` equals L's `id`. Graph honours the filter, and it matches the 3 distinct assignments Q125 found across 10 unfiltered reads.
  2. Q125 step 2 (broader filter `PrimarySmtpAddress -like '*'`, `live.payload` = L), 20 runs: every run `skipped`, requirement `exchangeAppScopeFilter`, reason
     "manual: This app access scope is used by 3 app role assignments, and its recipient filter differs from the backup. ..." (identical in all 20).
  3. Q125 step 3 (no `live.payload`), 5 runs: the same `skipped` with "used by 3" each time.
  - Writes attempted: **0** across all 25 (the stub that throws was never called).
  - Step 4: Q123 has not run at #469 (it was blocked on #466); I'll report this when it runs.
  - #467 is answered by this; I'm leaving the close to the builder.
- **Read-only. Nothing is written to the tenant.** Restorer credentials, test tenant only. Never change L or any app scope, never
  create or change an app role assignment.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with the same one-off script as Q125 (writer `read` = your
  Graph read client, `write` = a stub that throws), L = `KEEL-RT-test-mailboxes`:
  1. Does Graph honour the filter? One read of `beta /roleManagement/exchange/roleAssignments?$filter=appScopeId eq '<L.id>'`
     (URL-encoded): report the status, the row count, and whether every row has `appScopeId` equal to L's id.
  2. Step 2 of Q125 (broader filter `PrimarySmtpAddress -like '*'`, `live.payload` = L), **20 runs**. Expect every run `skipped`
     with requirement `exchangeAppScopeFilter`; report each run's reason (the "used by N" / "could not be confirmed" text) and that
     `write` was never called.
  3. Step 3 of Q125 (no `live.payload`), 5 runs, same expectations.
  4. Only if Q123 runs at #469 or later: the unused `KEEL-RT-app-scope` update is now expected to be a manual step too while the
     assignment reads repeat rows (the intended fail-closed side). Report the outcome.
- **Report:** B; step 1 status/count/match; the 25 reasons; confirmation that no write was attempted.

### Q136: Read-only check of the Power Platform and Fabric reads with the Collector's setup, no admin role
- Drafted by the "Power Platform and Fabric role names" thread (2026-10-22). The code no longer declares Power Platform
  Administrator or Fabric Administrator for `power-platform-settings`: the Collector reads Power Platform through its management app
  registration (Q61: environments 200) and Power BI through the Fabric read-only admin API group (Q61: 200). Not yet seen live:
  `GET /v1/admin/tenantsettings` (403 in Q57, before the Fabric setting took effect), the DLP policies read and the connectors read.
- Needs: nothing.
- Status: done
- Result: done (2026-10-22 09:34 UTC). All four reads answer **200** with the Collector's own setup; no admin role is needed. Collector token only, GETs only; nothing granted, registered or changed.
  1. Fabric (audience `https://api.fabric.microsoft.com/`): `GET /v1/admin/tenantsettings`: **200**, 178 settings (`value`). (Q57's 403 is gone now that the Fabric setting is in effect.)
  2. Power Platform (audience `https://service.powerapps.com/`):
     - `GET .../Microsoft.BusinessAppPlatform/scopes/admin/environments?api-version=2020-10-01`: **200**, 2 environments.
     - `GET .../PowerPlatform.Governance/v2/policies`: **200**, 1 DLP policy.
     - `GET api.powerapps.com/.../scopes/admin/environments/<first>/apis?api-version=2016-11-01`: **200**, 0 items in `value` (empty list for that environment).
  3. No read was 403, so the Fabric group membership check was not needed.
- **Read-only. Nothing is written to the tenant.** Collector token only, GETs only. **Grant, register or change nothing**, whatever
  is refused. Never touch CA policies, break-glass or Marouane's account.
- Do, from your own checkout (never `/opt/keel`), with the Collector credential from `/etc/keel/tenant.json`:
  1. Fabric (audience `https://api.fabric.microsoft.com/`): `GET https://api.fabric.microsoft.com/v1/admin/tenantsettings`.
  2. Power Platform (audience `https://service.powerapps.com/`):
     - `GET https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments?api-version=2020-10-01`
     - `GET https://api.bap.microsoft.com/providers/PowerPlatform.Governance/v2/policies`
     - for the first environment from the read above:
       `GET https://api.powerapps.com/providers/Microsoft.PowerApps/scopes/admin/environments/<name>/apis?api-version=2016-11-01`
  3. If any read is 403, report the error code and message, and for Fabric whether the Collector is still the only member of
     `KEEL-RT-collector-fabric-readers` and holds no Power BI permission.
- **Report:** per read, the status and the item count only (no names or values). Nothing changes in the tenant, the host or the DB.

### Q137: Check that retention labels and eDiscovery cases land in a collect (read-only, after #481)
- Drafted by the "Turn on retention labels backup" thread (2026-10-22). Code: PR #481. The four eDiscovery reads in
  `purview-governance` now declare Compliance Administrator (which Q106 showed carries Case Management and Hold) instead of
  eDiscovery Manager, so the workload is no longer `pending-prerequisite` and retention labels are collected. No grant involved.
- Needs: /opt/keel-live at the #481 merge or later
  (`grep -c "'eDiscovery Manager'" /opt/keel-live/engine/collect/workloadContract.mjs` prints 0).
- Status: todo
- Result:
- **Tenant:** reads only. The run sends only the declared `Get-` cmdlets with the collector credential. No grants, no role
  or config changes. Never touch CA policies, break-glass or Marouane's account.
- Do, from `/opt/keel-live` with `set -a; . /etc/keel/db.env; set +a`:
  1. `node cli/keel-workload-collect.mjs run` once by hand (as in Q108). Report its exit code.
  2. ```sql
     SELECT workload, outcome, created_at, digest->'reasons' AS reasons,
            (SELECT count(*) FROM workload_observation o WHERE o.collection_id = wc.id) AS observations
       FROM workload_collection wc
      WHERE workload = 'purview-governance' AND created_at > now() - interval '15 minutes'
      ORDER BY created_at;
     ```
  3. For the newest purview-governance row, count observations by kind (no names or values):
     ```sql
     SELECT split_part(resource_key, ':', 1) AS kind, count(*)
       FROM workload_observation
      WHERE collection_id = (SELECT id FROM workload_collection WHERE workload = 'purview-governance' ORDER BY created_at DESC LIMIT 1)
      GROUP BY 1 ORDER BY 1;
     ```
  4. Only if step 3 shows no `retention-label` rows and `Get-ComplianceTag` returns nothing in the Collector session: create one
     unpublished retention label `KEEL-RT-retention-label` (no policy, no publishing) with the Restorer's purview config, rerun
     steps 1-3, then leave the fixture in place for later restore checks and say so.
- **Expected:** step 1 exit 0; purview-governance `complete` (or `partial` with reasons that do not mention a role); step 3
  includes `retention-label` (and `ediscovery-case` / `case-hold` if the tenant has cases).
- **Report:** step 1 exit code, step 2 and step 3 verbatim, step 4 if run.

### Q138: Live re-check of the reusable settings group restore after the key id fix (fixes #477, after #482)
- Drafted by the "Reusable settings post-check fails" thread (2026-10-22), from your Q135 finding **#477**. Code: PR #482. Fixture-tested only.
  - **Change:** the post-state and dry-run comparison of a reusable settings group's `settingInstance` now leaves out the simple
    setting child whose definition ends in `_{id}_id` (the key guid Graph regenerates on every write). Every other value, such as the
    addresses, is still compared. The PUT body is unchanged: the backup's values are sent whole, key child included.
- Needs: /opt/keel-live at the #482 merge or later (`grep -q withoutRegeneratedKeys /opt/keel-live/engine/restore/intuneOperations.mjs`).
- Status: todo
- Result:
- **Test tenant only.** Same hard rules, capture tooling, requester/approver split and standing approval as Q135. Restorer only;
  global admin not used. If Graph answers 403, report blocked with what Graph names; grant nothing. Never touch CA policies,
  break-glass or Marouane's account. The group is used by no policy.
- **Fixture:** firewall reusable settings group `KEEL-RT-155-addresses` (keyword, autoresolve false, one address 203.0.113.10),
  used by no policy, as in Q135. Recreate it if it is gone.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. Create the fixture if needed, then take snapshot S (its payload holds `settingInstance` with 203.0.113.10).
  2. **Update round:** in the portal change the description **and** the address to 203.0.113.20. Restore from S, approve, enforce,
     capture the `update`. Expect a PUT, the journal `verified` (not `uncertain`), and the tenant back at 203.0.113.10.
  3. **Create round:** delete the fixture. Restore from S, approve, enforce, capture the `create`. Expect `verified`.
  4. **Re-run check:** dry run from S after step 3. Expect 0 planned writes for the group (Q135 step 5 planned another create).
     If it still plans a create, report the plan and whether the step 3 job recorded a target id.
  5. **Negative check (no write):** change only the address to 203.0.113.30, dry run from S. Expect an update planned with
     field `settingInstance`; do not enforce. Then restore the fixture from S or delete it in cleanup.
  6. Cleanup: delete every `KEEL-RT-155-*` fixture. Report anything left.
  7. Commit the records and `.capture.json` files under `docs/release/qualifications/entra-live/` on
     `claude/live-evidence-reusable-settings`, rebased onto `origin/master` (secret scan and `pseudonymize.mjs check` first),
     replacing the Q135 demotions if both writes verify. No PR. Run
     `node tools/qualification/operations.mjs --live-evidence <that directory>` and report the `live evidence` lines.
- **Report:** B; per operation: promoted / refused (exact Graph message) / blocked; step 4; step 5; approval ids; the evidence
  branch and commit; anything left in the tenant.

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

- D-Q55 (Q55): may keel-operator add the read permissions below to the KEEL apps, create the content-reader app,
  and give the Collector the read-only Exchange address-list role, so that Marouane can grant admin consent?
  - Decision: yes (Marouane, "Add API permissions" project thread, 2026-10-14 21:38 UTC; recorded verbatim by the
    coordinator): "add the permissions to the apps, i'll consent". Also covered by D-93a ("add any the tool needs
    to move along"). Consent itself stays with Marouane: keel-operator adds permissions to the app manifests only and
    never creates app role assignments or grants consent.

- D-Q63 (Q63): may the Keel Restorer get mail write limited to `keel-rt-` test mailboxes, set up by keel-operator, so a
  test message can be placed in alice's mailbox?
  - Decision: yes (Marouane, "Scoped mail write for test email" project thread, 2026-10-15 07:44 UTC; recorded verbatim):
    chose "Yes, operator" on the card "Give the restore app mail write on keel-rt- test mailboxes only?". The card said:
    Exchange app scoping, role "Application Mail.ReadWrite" limited to mailboxes whose address starts with keel-rt-;
    no tenant-wide Mail.ReadWrite grant and no consent click; keel-operator sets it up, writes one KEEL-RT- message to
    alice's inbox, checks a non-test mailbox is denied, then reruns the mail backup.

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
- Status: done
- Result: **In progress again (21:46 UTC) at B = `09e1f00c3f2bda0ec6e6562015613907c810e7aa`** (#169 branding-closure fix deployed 21:40; worker restarted 21:44). Earlier work at = `eef1019317202dfe9ce6cf05d91cc0a8aeb6bd69`** (#168 deployed 21:02; worker restarted 21:07;
  scheduler timer paused for the run). Checklist: "51 registered operations, 52 steps" (same as b41d33e). Snapshot S1
  7570bb5a (before every drift). Approval requests are filed by keel-operator through KEEL's `requestApproval()` (the portal
  never filed one for a CLI dry run) and decided by Marouane in the portal.
  - **Round 1**, artifact 03c6d87c, approval d93538e2 (Marouane, 21:20):
    - **Promoted to live-qualified (7):** user update (9), administrativeUnit update (15), groupSetting update (16),
      crossTenantAccessPolicy update (18), crossTenantAccessPolicyConfigurationDefault update (19),
      adminConsentRequestPolicy update (22), deviceConfiguration update (26). Steps 16/18/19/22 were captured with
      `--allow-tenant-setting` (D-148b).
    - **Failed → demoted (1):** organizationalBranding update (29): the live PATCH returned HTTP 400
      (`organizationalBranding.update.demotion.json`).
  - **Could not be planned (dry-run refusals, reported, not demoted):**
    - crossTenantAccessPolicyPartner update (21): foreign-tenant reference not resolvable.
    - deviceCompliancePolicy update (24): `scheduledActionConfigurations[0].id` not resolvable.
    - application update (12): `createdByAppId` → Restorer app not resolvable. 11/13/14 are likely the same.
    - organizationalBrandingLocalization update (30) and authenticationFlowsPolicy update (32): "unsupported operation: no
      proven deferred reference patch". 32's drift was also refused by Graph (AADB2C90063).
    - groupLifecyclePolicy update (31): guard refuses to shorten the lifetime 400 → 365 by design, so the runbook's
      "make it longer" drift can't be auto-restored.
  - **Round 1b**, artifact a8cdd5b0, approval 1d4a92f8 (Marouane): the dependency closure adds
    `organizationalBrandingLocalization:0` (the empty default branding created as a side effect of the fr-FR fixture) to
    wave 1 next to the group. Its PATCH fails with 400 and stops the run, so **the group was not written** (steps 2/5 and 28
    still open).
  - **Blocker (code / Graph):** `organizationalBrandingLocalization:0` lands in the dependency closure of restores that
    don't select it (e.g. `group:` and `configurationPolicy:` only), and KEEL's PATCH of it returns HTTP 400 every time, so
    every such wave stops. I tried removing the cause: deleting the fr-FR fixture localization and the default "0" (neither
    existed before the run) returns 204, but Graph keeps returning both 6+ minutes later, even after a second delete.
    **Coordinator: fix needed.** Either (a) don't pull branding into unrelated closures, or (b) make the branding-localization
    update valid; a failed singleton dependency shouldn't stop the fixtures' wave. Then requeue Q43 from round 1b: group
    2/5, settings 28, the create/soft-delete/edge-remove rounds, delete steps 4/17, and lockout 33–52.
  - The portal approvals also queued worker `restore` jobs. They failed harmlessly ("requester no longer resolves to a
    principal: keel-operator"); the CLI enforce did the work. Worth a look: an approval from the portal runs the restore again.
  - Scheduler timer restarted 21:35. The fixtures stay for the rerun. Fixture group: description still drifted, carla removed
    as member. Other leftover drifts: compliance length 6, app name -drifted, partner MFA trust on, lifecycle 400 days,
    self-service sign-up unchanged (its drift failed).
  - Notes for the coordinator:
    - capture `--fixture` needs the full natural key (`administrativeUnit:KEEL-RT-148-unit`), not the bare name the checklist
      shows;
    - tenant-wide steps need `--allow-tenant-setting`.
  - **At 09e1f00** (fresh snapshot S2 8c375e1b; the #169 fix verified: closures no longer pull branding):
    - round 1d, artifact e3ba04c3, approval dd3564a8: **configurationPolicy update (28) promoted**;
    - round 2b, artifact 26fcf441, approval 5059a85a: **configurationPolicy create (27) promoted**.
    - **Live-qualified total: 9.**
  - **Newly blocked (code or runbook):**
    - group update (2): `keel-collect` doesn't collect a group's `description`, so the drift is invisible and no write
      happens.
    - group#member/#owner edge steps (5–8): `keel-collect` reads only the `assignment` relationship family
      (`COLLECT_RELATIONSHIPS`), so no membership or owner edges are in any snapshot.
    - deviceConfiguration create (25): guard "unclassified-content-effect: internetSharingBlocked,
      sharedUserAppDataAllowed". The fixture profile was deleted for the step and is gone (recreate or ignore at
      cleanup).
    - ~~group restore-soft-deleted (3) impossible~~: **correction**. Entra did soft-delete the fixture security group, so step 3
      is running (see below).
    - user restore-soft-deleted (10):
      - first plan refused with "retention deadline unprovable (no deletedDateTime)" (replication lag);
      - the replan chose `user create` ("not a registered write capability").
      Carla was restored from deleted items **by hand** at 22:09 (memberships intact).
  - **Delete steps 4 and 17** (Marouane chose "Act as my principal" for the baseline):
    - Snapshot S3 876495db (neither object present). Temporary baseline **b3a06c4b** = version 2 of bd7d9515, created and
      activated `--set-by` Marouane's principal.
    - Created `KEEL-RT-148-group-delete` and Group.Unified. Drifts 3a0827b9 and fe78d84a were detected.
    - Remediation dry runs were persisted through KEEL's `resolveRestoreScope` + `runRestore`. `keel-remediate --enforce`
      would plan and enforce in one call, and the CLI enforce path checks no approval except for Conditional Access, so I
      didn't use it.
    - Artifacts 387733f3 (step 4) and 8e4db833 (step 17); approvals 66b8048a / 664ff71a (Marouane, 08:30). After a
      read-only review of both artifacts (each closure = exactly one fixture), enforced one at a time: both deletes
      succeeded and read back absent. **group delete (4) and groupSetting delete (17) promoted.** Group.Unified is absent
      again, the tenant's original state.
  - **Baseline: can't be put back (code gap).** `keel-baseline-activate --baseline-id bd7d9515` refuses: "superseded by
    a re-snapshot; activate its latest version". bd7d9515 has no `source_snapshot_id` (seeded before snapshots were
    recorded), so a new version can't be cut from it either. **b3a06c4b (live-gate-148, 1789 resources, S3 of 2026-10-10)
    stays active**; bd7d9515's resources are preserved. Coordinator: a way to re-activate a superseded version is needed, or
    accept b3a06c4b. The runbook's delete-step cleanup ("re-activate $BASELINE") can't work as written.
  - The scheduler timer was paused 21:46 → 07:12 UTC (overnight, while waiting), now running.
  - **Live-qualified total: 11.**
  - **Step 3, group restore-soft-deleted, failed and demoted:** artifact 91e8575d (replanned after a target change),
    approved by Marouane. The restore from deleted items worked, but KEEL's follow-up update of the same group got HTTP 404
    (replication lag right after the restore), so the capture recorded the write as failed (exit 3).
    `group.restore-soft-deleted.demotion.json`.
  - **Step 1, group create, failed and demoted (11:34 UTC):** the group was removed from deleted items first. Artifact
    01cf16da (from S2), approval 56a7f73f (Marouane). Live `POST /groups` returned HTTP 400: the create body is the
    collected snapshot shape, including read-only properties (`id`, `createdDateTime`, `assignedLicenses`,
    `onPremisesSyncEnabled`). Capture exit 3; `group.create.demotion.json`. Nothing was created: a read-only check shows no
    `KEEL-RT-148-group`.
  - **Live-qualified total: 11. Demoted: 3** (organizationalBranding update, group restore-soft-deleted, group create).
  - **Lockout steps 33–52 (2026-10-11 → 12), one at a time, each approved by Marouane in the portal.**
    - Break-glass: Marouane registered his own account (label "Marouane break-glass") and is excluded directly from both
      enabled CA policies. Readiness: 4/5 dimensions pass, policyExclusions unknown (group membership is not collected),
      overall not-ready (< 2 accounts). Marouane chose to proceed on a Graph check of the exclusions (runbook override).
    - Restorer got Policy.Read.All (global admin, 2026-10-11 18:50, logged).
    - **Promoted:** 33 roleDefinition create, 34 roleDefinition update, 42 authenticationStrengthPolicy create,
      43 authenticationStrengthPolicy update, 50 conditionalAccessPolicy restore-soft-deleted (id kept, report-only).
    - **Demoted:** 39 namedLocation create and 40 namedLocation update (HTTP 400, read-only fields in the body);
      45 unifiedRoleManagementPolicy update (write landed, MFA rule back on, but read-back fails with
      CultureNotFoundException, outcome uncertain); 48 conditionalAccessPolicy create (HTTP 400, body carries `id`,
      `createdDateTime`, `modifiedDateTime`, `deletedDateTime`, `@odata.context`; the same body without them returned 201).
    - **Blocked:** 35 roleAssignment create (dry run always fails: the assignment's own id is a required deferred patch);
      36 roleAssignment update (no write planned); 37 roleAssignment, 41 namedLocation, 52 conditionalAccessPolicy delete
      (lockout delete guard needs `simulationPassed`, which no CLI sets; not run); 38 roleEligibilitySchedule create
      (only scope "/" supported, AU scope required); 44 authorizationPolicy, 46 authenticationMethodsPolicy,
      47 securityDefaults (break-glass lockout gate; 47 also because CA policies are on). Artifact 34cd4d69 failed at the
      gate; guest invites were restored by hand and read back. 49 conditionalAccessPolicy update: the drift renamed the
      policy, and the natural key is the display name, so KEEL journaled a create (HTTP 400) rather than an update; capture
      exit 4. 51 turn-on: not run (Marouane chose not to enable the fixture policy; no snapshot with it on).
    - Note: steps 48–50 were first captured with `--fixture KEEL-RT-148-ca` (exit 4); the journal key is
      `conditionalAccessPolicy:KEEL-RT-148-ca`. Recaptured with it.
  - **Live-qualified total: 16. Demoted: 7.**
  - **Coordinator gaps (Marouane's direction: restore from the recycle bin first, keeping ids; otherwise create with the
    same values minus ids and Microsoft-owned fields):**
    1. Create/update bodies must strip server-managed read-only fields (blocks group create, namedLocation create/update,
       CA create/update).
    2. `keel-collect` requests only `COLLECT_RELATIONSHIPS = {families:['assignment']}` (`cli/keel-collect.mjs:19`); group
       member/owner are supported by the engine but never collected. That also leaves break-glass policyExclusions unknown.
    3. roleAssignment create plans its own id as a required deferred patch.
    4. The lockout delete guard needs `simulationPassed`, which nothing sets.
    5. roleEligibilitySchedule: AU scope unsupported.
    6. PIM read-back fails (CultureNotFoundException) with app tokens.
    7. CA purge from deleted items needs a delegated token (app-only 403); Marouane purged by hand.
    8. A display-name natural key turns a rename drift into a create.
  - **End-of-run cleanup (2026-10-12, Restorer):** deleted KEEL-RT-148 role assignment, role, named location,
    authentication strength, CA policy, CA group, app (+SP), AU, compliance policy, settings-catalog policy, the group
    lifecycle policy; removed the Microsoft Services partner entry; reset the cross-tenant default to system default;
    purged KEEL-RT-148-group-delete, KEEL-RT-148-ca-users and the app from deleted items. Every tenant-wide setting in
    originals.json reads back unchanged, except Marouane's own break-glass changes, left in place: FIDO2/passkeys enabled
    and the registration campaign now targets FIDO2 (authenticationMethodsPolicy), and his direct exclusion from the 2
    enabled CA policies. **Left in the tenant:** KEEL-RT-148-ca in CA deleted items (app-only purge is 403; Marouane can
    purge it in the portal, or it ages out in 30 days). Baseline v3 b4635c7f stays active. Final break-glass readiness:
    not-ready (1 account; policyExclusions unknown), as before the run.
  - **Evidence:** branch `claude/live-evidence-148` commit e7f2264 (51 files in
    `docs/release/qualifications/entra-live/`, from builds eef1019 and 09e1f00). Secret scan clean; no raw tenant ids.
    The first push (48f8b04) was replaced: a background security review found that
    `group.restore-soft-deleted.capture.json` carried the group's `securityIdentifier` (Entra SID `S-1-12-1-…`), which
    encodes the raw object id of the purged fixture group KEEL-RT-148-group. That record and capture are omitted (the step
    is demoted; its demotion.json is kept). **Coordinator gap 9:** `pseudonymize.mjs` must cover `securityIdentifier`
    (and any SID-encoded id).
  - **`operations.mjs --live-evidence`:** 16 `fixture-tested -> live-qualified` (adminConsentRequestPolicy.update,
    administrativeUnit.update, authenticationStrengthPolicy.create/update, conditionalAccessPolicy.restore-soft-deleted,
    configurationPolicy.create/update, crossTenantAccessPolicy.update, crossTenantAccessPolicyConfigurationDefault.update,
    deviceConfiguration.update, group.delete, groupSetting.delete/update, roleDefinition.create/update, user.update);
    7 `not applied (write not verified by its read-back)` (conditionalAccessPolicy.create, group.create,
    group.restore-soft-deleted, namedLocation.create/update, organizationalBranding.update,
    unifiedRoleManagementPolicy.update), applied as demotions.
- Requeued by the coordinator (2026-10-10 21:05 UTC): the protected-principal fix is merged as PR #168 (`eef1019`). Run only once the live build is `eef1019` or later; if it is still `b41d33e`, leave this `todo` and check again next pass. Marouane's permission for the tenant-wide drifts and the second group owner from the previous Result still apply.
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

### Q44: Register the two dedicated break-glass accounts — issue #148 follow-up
- Drafted by the "Keel backup/restore coverage review" thread (2026-10-12). Marouane named the accounts in that thread at 13:57 UTC.
- Status: done
- Result: Done 2026-10-13 09:50 UTC, live build 2b9d310 (all of #170–#202 present), actor = operator principal (marouanedefili@gmail.com).
  - **Step 1, read-only Graph checks (Collector), per account:**
    - Emergency access: object id found pass; accountEnabled pass; userType Member pass; onPremisesSyncEnabled null pass;
      domain authentication Managed pass; CA exclusions pass: the two all-users enabled policies ("Baseline - Require MFA for
      Risky Sign-ins", "Baseline - Require Password Change for High-risk Users") exclude it directly.
    - Break glass: same, all pass.
    - Note: the tenant has **8** enabled CA policies, not 2 (all 8 were already enabled before Q43; none changed). The other
      6 (G-MFA-BGA-AllApps-AllOS-P, Test - Coreview, four KEEL-RT-20260908 policies) target specific groups/users, and
      neither account is in their targets (transitive membership checked), so they don't apply.
  - **Steps 2–4:** registered "Emergency access" and "Break glass" (validation 90 days, rotation default); recorded
    credential-rotated 2026-10-12 ("password reset by Marouane, 2026-10-12") and validated 2026-10-12T14:10Z ("sign-in test
    by Marouane") for both. Evidence seq 40474–40479. "Marouane break-glass" untouched.
  - **Step 5, `keel-breakglass report`: overall `unknown` (reason account-evidence-unknown).**
    - Marouane break-glass: **ready** — cloudOnlyIdentity pass, phishingResistantCredential pass, policyExclusions pass,
      privilegedAccessPath pass, lastValidation pass.
    - Emergency access: unknown — cloudOnlyIdentity pass, **phishingResistantCredential unknown (no-method-evidence)**,
      policyExclusions pass (excluded-from-every-enforced-policy), privilegedAccessPath pass (active Global Administrator),
      lastValidation pass.
    - Break glass: same as Emergency access.
    - Canary: not-configured. Alerts: none.
  - **Differs from the expected unknown:** `policyExclusions` now passes (membership is collected at this build).
    `phishingResistantCredential` is unknown instead, since no `methods-attested` record exists for the two accounts. A
    read-only Graph check shows **both have only a password registered**, so attesting their methods would make them
    not-ready, not ready. The gate needs 2 ready accounts; only Marouane's is. **For Marouane:** register a FIDO2 key or
    passkey on at least one of the two accounts and tell me the methods to attest. Until then Q45 steps 44/46/47 stay
    blocked at the break-glass gate.
- Needs: nothing. No code change; the live build is fine.
- Why: Readiness reads one emergency account (Marouane's own), so `MINIMUM_ACCOUNTS = 2` fails and the break-glass gate blocks
  the authentication-methods, security-defaults and authorization-policy restores (Q43 steps 44, 46, 47). The tenant has two
  dedicated accounts that KEEL doesn't know about.
- **The accounts** (Marouane, 2026-10-12): `emergency-access@techinsiderbytes.com` and `break-glass@techinsiderbytes.com`.
  Both are Global Administrators and both had their passwords reset today.
- **Read only in the tenant.** Register in KEEL's database only; never sign in as, change, assign or drift these accounts.
- Do, on the host, as the operator principal:
  1. Read-only Graph checks for each account, through the Collector: object id, `accountEnabled`, `userType`,
     `onPremisesSyncEnabled` (must be null), the domain's authentication type (managed), and that both enabled Conditional
     Access policies exclude the account directly (`conditions.users.excludeUsers`) or through an excluded group. Report each
     check as pass/fail. Don't fix anything in the tenant; a failed check is a result for Marouane.
  2. `node cli/keel-breakglass.mjs register --actor <operator principal id> --account-id <object id> --label "Emergency access"`
     and the same with `--label "Break glass"` (defaults for validation and rotation days).
  3. `node cli/keel-breakglass.mjs record --actor <operator principal id> --account-id <object id> --kind credential-rotated
     --at <today> --note "password reset by Marouane, 2026-10-12"` for both.
  4. Marouane signed in with both accounts on 2026-10-12 at about 14:10 UTC (his statement in the thread). Record it:
     `node cli/keel-breakglass.mjs record --actor <operator principal id> --account-id <object id> --kind validated
     --at 2026-10-12T14:10:00Z --note "sign-in test by Marouane"` for both.
  5. `node cli/keel-breakglass.mjs report` and copy the per-account dimensions (no object ids in the Result; use the labels).
  6. Leave Marouane's own registration ("Marouane break-glass") as it is.
- **Report:** the two registrations, the step-1 checks per account, the readiness report's overall state and each dimension
  per account, and anything that still reads `unknown` (expected: `policyExclusions` until transitive membership is collected,
  only).
### Q45: Rerun Q43's demoted and blocked steps at the Phase 1 build — issue #148 follow-up
- Drafted by the "Keel backup/restore coverage review" thread (2026-10-12).
- Status: done
- Result: Started 2026-10-13 09:52 UTC at live build 2b9d310 (#185 present).
  - Checklist at 2b9d310: "51 registered operations, 52 steps"; every step in the Q45 table is listed. Rerun set: table steps
    plus Q43 steps never reached (11, 13, 14, 20, 23): non-lockout 1, 2, 3, 5–8, 10–14, 20, 21, 23–25, 29–32; lockout 35, 39,
    40, 48, 49; gate check on 44, 46, 47.
  - Approval requests: the live build refuses a requester that isn't an enabled principal ("keel-operator" no longer works).
    Marouane chose: file as his Entra principal (marouane.defili@techinsiderbytes.com), approve as his Gmail principal.
  - **Round A** (snapshot SA 9106962e): fixtures recreated (group + carla member/owner, app + SP, compliance + restrictions
    assigned to the group, partner f8cdef31, fr-FR localization + default text via localization 0, lifecycle 365 days).
    Drifts: description, member carla→ryan, owner carla→ryan (Entra refuses removing the last owner, so ryan was added
    first; this also covers edge-remove 6/8), app -drifted, partner MFA trust on, compliance length 6, branding texts.
    32: Graph refused the self-service sign-up drift again (500 AADB2C90063) → blocked. Dry run c8401172: 7 resources +
    4 edges planned, 0 refused. Approval e20b2d26 pending.
  - **Round A result** (approval e20b2d26, executed by the keel-worker job the approval queued; my CLI `--enforce` was then
    correctly refused because the target had already changed): **promoted 5**: group update (2), application update (12),
    crossTenantAccessPolicyPartner update (21), deviceCompliancePolicy update (24), organizationalBrandingLocalization
    update (30).
    - **Blocked, edges 5–8 (code gap):** member add/remove and owner add worked live (read back), owner remove of ryan
      failed (likely "last owner" while carla's add replicated). But `relationshipWriter.mjs` journals each edge with
      `recordPriorState` only and never calls `recordWriteOutcome`, so every edge entry stays `pending` and capture exits 4.
      No edge step can be captured until the edge writer records outcomes.
    - **Blocked, 29 organizationalBranding update:** the default branding exists only as localization "0" (`/branding`
      GET is 404). The wave reported it applied and the text reads back as the original, but no journal entry was written
      for it, so capture exits 4 (not exercised).
    - **Blocked, 32:** Graph refuses the self-service sign-up drift (500 AADB2C90063).
  - **Round C** (snapshot SC 8a087010): soft-deleted the group, app and carla; lifecycle 365→400.
    - 13 application restore-soft-deleted: **blocked**, guard `unclassified-content-effect: application changes
      publicClient` (dry run b9b9f46c refused).
    - Carla's `deletedDateTime` never appeared in 5 min of reads; KEEL still planned `restore-soft-deleted` (the #185 fix).
    - 31 groupLifecyclePolicy: planned as content effect "retention-reducing 400→365" with a manual completion step.
    - Dry run 12cccb71 (group, carla, lifecycle; 2 edges): completed. Approval 54b91a76 pending.
  - **Round C result:** first job (12cccb71, approval 54b91a76) failed before any write: `blocked-content-effect` — the
    lifecycle 400→365 needs a separate content-effect approval, which the portal only offers on a portal-made dry run (no way
    to open a CLI artifact) → **31 blocked (portal gap)**; lifetime set back to 365 by hand. Replanned without it:
    52d30020, approval 1967acf3:
    - **10 user restore-soft-deleted: promoted.**
    - **3 group restore-soft-deleted: failed → demoted** — restored with the same id and read back, but the convergence
      check flagged "residual drift after update" on server-managed fields absent from the snapshot (`expirationDateTime`,
      `renewedDateTime`, `securityIdentifier`), outcome uncertain. The #173 strip doesn't cover the convergence check.
  - **Round D (creates)**, source SC: deleted the group, compliance policy, restrictions profile and partner; purged the
    group, app and SP. Dry run e4a915b9 failed:
    - 11 application create and 14 servicePrincipal create: **blocked**, guard `unclassified-content-effect: application
      changes publicClient`.
    - 23/25: "assignments cannot be restored: the group group:KEEL-RT-148-group does not exist in the target" — the
      Intune policies are in the same wave as the group they're assigned to (assignment target not treated as a dependency).
    - Split: D1 = group (1) + partner (20): dry run 8a06277f completed, approval b620b745 pending; D2 = Intune creates after.
  - **Live-qualified total so far: 22.**
  - **Round D1** (8a06277f, approval b620b745): **20 crossTenantAccessPolicyPartner create promoted.** **1 group create
    failed → demoted**: the POST now succeeds (#173 works), but post-create verification compares server-managed fields
    (createdDateTime, renewedDateTime, securityIdentifier) → "created object did not verify", uncertain; edges didn't run.
  - **Round D2** (bc611507, approval 10a1a2c6): **23 deviceCompliancePolicy create and 25 deviceConfiguration create
    promoted** (assignments to the recreated group).
  - **Lockout phase — runbook override by Marouane (2026-10-13):** only "Marouane break-glass" reads ready; the two dedicated
    accounts read unknown (no phishing-resistant method). Marouane chose to proceed, one step at a time, CA report-only.
    Fixtures: AU, KEEL-RT-148-role (groups/basic/update) assigned to carla at AU scope, named location, CA group (carla),
    CA policy report-only excluding marouane.defili + both break-glass accounts. Snapshot SL 497ace77. Order 35, 40, 39,
    49, 48 (rename/update before delete/create so one snapshot serves all).
    - **35 roleAssignment create: written live (succeeded), capture blocked by a capture-tool bug:** `byReferenceProblems`
      → `nameOf` strips the text before the first ':' of the reference symbol, so `roleDefinition:<id>` is looked up as a
      bare id, isn't found, and the id is tested against `^KEEL-RT-148-role$` → "the role is not the fixture role". (The
      principal only passes because a bare UPN starts with keel-rt-.) The #179 fix itself works: the plan was a clean create.
    - **40 namedLocation update: failed → demoted.** PATCH 400 "1042: Unexpected type: namedLocationType": the update
      body (`writableProjection`) drops `@odata.type`. Verified by hand on the fixture: same PATCH without it 400, with it
      204. #173 keeps `@odata.type` on create bodies only.
    - **39 namedLocation create: promoted** (5dee600d, approval 751753e9).
    - **49 conditionalAccessPolicy update: promoted** (9e19ce48, approval 11663254): planned as update (#176 works),
      renamed back, stayed report-only. The worker job still ended "failed" (wave 2 "applied 1, failed 1", no reason
      printed) although the only journal entry succeeded. Worth a look.
    - **48 conditionalAccessPolicy create: failed → demoted** (5c149f0a, approval 41508a19; Marouane purged the deleted
      policy in the portal first). The POST succeeded (report-only, read back), but post-create verification compared
      server-managed fields (`id`, `createdDateTime`, nested `@odata.context`) → "created object did not verify".
    - 44/46/47: not run; still blocked by the break-glass gate (one ready account; see Q44).
  - **Not rerun:** 45 (PIM, not in the table), 37/41/52 and 38 (Q46 parts B and D), 51.
  - **Outcome by step:** promoted 2, 10, 12, 20, 21, 23, 24, 25, 30, 39, 49; demoted 1, 3, 40, 48; blocked 5–8 (edge
    outcomes never journaled), 11/13/14 (publicClient content-effect guard), 29 (default branding write not journaled),
    31 (content-effect approval unreachable for a CLI dry run), 32 (Graph AADB2C90063), 35 (capture-tool `nameOf` bug;
    the write succeeded), 44/46/47 (break-glass gate).
  - **Live-qualified total: 27** on the host (16 from Q43 + 11). In the published set: 26 (group update held back, below).
  - **Evidence:** branch `claude/live-evidence-q45` commit 71eb8ad (28 files changed under
    `docs/release/qualifications/entra-live/`, on top of master's Q43 set). Held back: group.update,
    group.create and group.restore-soft-deleted record + capture, because their captures carry `securityIdentifier` (an
    Entra SID that encodes the raw object id); their demotions are committed. Secret scan otherwise clean, no raw ids.
    `operations.mjs --live-evidence`: 26 `fixture-tested -> live-qualified`; not applied: conditionalAccessPolicy.create,
    group.create, namedLocation.update, organizationalBranding.update, unifiedRoleManagementPolicy.update.
  - **Cleanup (Restorer):** deleted every KEEL-RT-148 object (role assignment, role, AU, named location, CA policy, CA
    group, group, compliance policy, restrictions profile), the partner entry, the lifecycle policy and both branding
    localizations; purged the groups and the leftover SP from deleted items. Every tenant-wide setting in
    /root/keel-q45/originals.json reads back as original. carla is back and enabled. **Left:** KEEL-RT-148-ca in CA
    deleted items (app-only purge 403; Marouane can purge it).
  - **Code gaps for the thread:** (1) edge writer never records outcomes (`relationshipWriter.mjs`); (2) post-write
    verification and convergence compare server-managed fields (group create/restore, CA create); (3) update bodies drop
    `@odata.type` (namedLocation); (4) content-effect rule missing for application `publicClient`; (5) Intune policies
    planned in the same wave as the group their assignment targets; (6) content-effect approval not reachable for a CLI
    dry run in the portal; (7) default branding write not journaled; (8) capture `nameOf` strips the type prefix from
    reference symbols; (9) `pseudonymize.mjs` still doesn't cover `securityIdentifier`; (10) restore requester must now
    be a principal ("keel-operator" refused), so CLI-filed requests need a principal.
- Needs: Q44 done first (it unblocks steps 44, 46 and 47), and a live build that contains PR #185 (the last Phase 1 fix).
  Check with `git -C /opt/keel-live log --oneline | grep -c "#185"` before you start; if it is 0, wait for the next deploy.
- Why: Phase 1 merged fixes for the causes Q43 found. Each step below should now pass or fail for a new reason.
  | Q43 outcome | Fix now on master |
  | --- | --- |
  | group create (1), named location create/update (39, 40), CA create: read-only fields in the body | #173 strips server-owned fields |
  | group restore-soft-deleted (3): follow-up PATCH hit replication lag (404) | #177 retries every write after a restore |
  | group update: `description` not collected | #174 collects it |
  | group member/owner edges (5–8): not collected | #170 collects them; dynamic groups are skipped with a note (#181) |
  | user restore from deleted items fell back to create | #185 matches deleted users by source id |
  | role assignment create (35): own id planned as a missing reference | #179 drops self-references |
  | application (11–14), cross-tenant partner (21), compliance policy (24): unresolvable references | #180 keeps foreign, read-only and server-owned references verbatim |
  | CA update: a rename planned as a create | #176 matches by id first in the same tenant |
  | device configuration create (25): content guard | #175 reviewed Intune content effects |
  | branding update (29): HTTP 400 | #182 sends `Accept-Language: en-US`; retry and report the Graph error if it still fails |
  | auth methods, security defaults, authorization policy (44, 46, 47): break-glass gate | Q44 |
- Do, on the host, as the operator principal, following `docs/roadmap/live-gate-148.md` exactly as in Q43:
  1. Fresh snapshot, then print the checklist and confirm the steps above are still listed.
  2. Run only the steps in the table, plus any Q43 step left "could not be planned". Same rules as Q43: dry run,
     Marouane's approval in the portal, `--enforce`, capture, promote, clean up. Lockout-sensitive steps last and one at a time.
  3. Exit 3 means demote and go on. Exit 4 or any refusal means report it and go on. Never edit a record.
  4. If promotion refuses an operation because Q43 demoted it, report that and go on. Don't edit the demotion.
  5. Commit the new evidence files to a new branch `claude/live-evidence-q45` and say so in the Result. The thread opens the PR.
  6. Clean up every KEEL-RT fixture you create, and read every tenant-wide setting back as original.
- **Never** write to anything but the KEEL-RT fixtures and the tenant settings the runbook names.
- **Report:** per step, promoted / failed (demoted, with the reason) / blocked (why), and the new live-qualified total.
### Q46: Phase 3 live checks on the test tenant — Exchange org setting, lockout deletes, branding files, PIM admin-unit scope
- Drafted by the "Keel backup/restore coverage review" thread (2026-10-12).
- Status: blocked
- Result: Run 2026-10-13 21:58 to 2026-10-14 09:30 UTC at live build 2b9d310 (#192, #195, #197, #199 all present). Requester: Entra principal (as the operator chose); approver: the operator. Evidence: branch `claude/live-evidence-q46` @ 7a3ed83 (no PR). `operations.mjs --live-evidence` (with the HMAC key): `live evidence namedLocation.delete.json: fixture-tested -> live-qualified`.

  - **A (Exchange org setting): not run.** The operator chose "do B, C, D first", then "move on". It needs the SharePoint and Teams records captured again at 2b9d310 first (the `exchangeTeamsPrerequisite` rule).
  - **B (#197 lockout deletes):**
    - Break-glass Global Admin role-assignment delete (dry run 90a5ea18, dry run only): **refused, as required.** KEEL's reason, verbatim: "refusing to delete tenant-lockout resource: break-glass readiness after the delete is not established: break-glass readiness is not-ready after the delete (account-not-ready); Break glass: phishingResistantCredential unknown (no-method-evidence), privilegedAccessPath fail (no-active-global-administrator); Emergency access: phishingResistantCredential unknown (no-method-evidence)".
    - Unused named-location delete, `namedLocation:KEEL-RT-148-delete`:
      - The first dry run (e76937c0) was refused because break-glass readiness was unknown (password only).
      - The operator then said the break-glass set is now Emergency access plus the operator's own account. In KEEL's database only, with nothing written to the tenant:
        - `keel-breakglass retire` the "Break glass" account. Its MFA registration fails, and the reason is recorded.
        - `record methods-attested fido2,password` for Emergency access. On 2026-10-14 Graph lists fido2, Authenticator and password for it.
        - Readiness is now **ready**: both accounts pass all 5 dimensions.
      - The rerun dry run (1d6b20a7) completed, the operator approved (0e0ab0b0), and the worker deleted the named location (applied 1, failed 0). Graph returns 404 for it now. **Promoted to live-qualified.**
  - **C (#199 branding files):**
    - The fr-FR favicon was stored by hash in snapshot bc6cb3ff, then drifted to a different image.
    - Restore 2fb2aeee was approved (b95aea2c) and the worker logged "branding files: uploaded 1, failed 0".
    - **The restore works:** Graph reads the favicon back with sha256 68edc125… (79 bytes), the same as the snapshot.
    - **Not qualified (blocked):**
      - The journal records the upload as `organizationalBranding#file:fr-FR/favicon`.
      - `entraLive capture` as organizationalBrandingLocalization update returns not-exercised (exit 4).
      - Captured as `organizationalBranding#file`, it refuses: "is not a disposable KEEL-RT-* or keel-rehearsal-* fixture". `--allow-tenant-setting` doesn't cover file keys. Fixing this needs a tool change.
  - **D (#195 PIM eligibility scoped to an administrative unit): failed.**
    - Setup: carla eligible for KEEL-RT-148-role, scoped to the admin unit KEEL-RT-148-unit. Snapshot 6cd94f39 captured it. Then the eligibility was removed.
    - Dry run a839f2eb failed with "unresolvable scope … an administrative unit the snapshot cannot name".
    - Cause: `eligibilityScopeRefusal` checks `ref.prefix === '/administrativeUnits/'`, but `resource_reference` has no prefix column, so the prefix is never stored.
  - **Tenant cleanup:**
    - Deleted: KEEL-RT-148-role, KEEL-RT-148-unit and KEEL-RT-148-delete (deleted by KEEL).
    - fr-FR branding localization: Graph refused the delete until the operator deleted it in the portal on 2026-10-14 (the portal showed a "failed" message, but the delete went through). Graph now lists no localizations and no default branding, as in the originals recorded 2026-10-13. **Nothing left in the tenant.**
- Needs: Q45 done first. A live build that contains PRs #192 (Exchange org setting), #195 (PIM admin-unit scope), #197 (lockout
  delete evidence) and #199 (branding files). Check each with `git -C /opt/keel-live log --oneline | grep -c "#<n>"`; run
  only the parts whose PR is live and report the rest as waiting.
- **Test tenant only. Never** touch anything but KEEL-RT fixtures and the one setting named below.
- **A. Exchange org setting (#192, gap W7).** Marouane allowed one tenant-wide setting; the thread chose `MailTipsLargeAudienceThreshold`.
  1. Rebuild the PowerShell image (its allowlist now accepts only this setting for `Set-OrganizationConfig`).
  2. Read the value: `Get-OrganizationConfig | Select-Object MailTipsLargeAudienceThreshold` (expected 25). Note it.
  3. Follow `docs/roadmap/exchange-live-acceptance.md` step 9: rebuild `docs.json` (8 URLs), preview offline with
     `node tools/qualification/exchangeLive.mjs plan --include-organization-config ...`, then run the usual capture with
     `--include-organization-config` added. It sets value+1, reads back, puts the original back, reads back.
  4. `verify --require-live --gate exchange-live-acceptance`. Read the value again by hand. On exit code 3, run the printed
     `Set-OrganizationConfig -MailTipsLargeAudienceThreshold <original>` at once and re-read.
  5. This also refreshes the 2026-10-07 Exchange record, which lapses about 2026-11-06.
- **B. Lockout deletes (#197, gap D1).** With Q44's two break-glass accounts registered and ready: create a KEEL-RT named
  location used by no policy, back up, delete it from the snapshot side with the new delete scope
  (`node cli/keel-restore.mjs --snapshot-id <S> --delete namedLocation:<name>` dry run, Marouane's approval,
  `--artifact <id> --enforce`). Expected: allowed and verified. Then a dry run deleting a role assignment of a break-glass
  account must be **refused** (dry run only, never enforce). Report both reasons verbatim.
- **C. Branding files (#199, gap M6).** Back up, change the KEEL-RT test language's favicon or background image by hand in the
  Entra admin center, restore with a selection of `organizationalBranding`. Expected: the file uploaded and read back by hash.
  If the read-back fails because Microsoft re-encoded the image, report it; don't retry.
- **D. PIM eligibility at an admin-unit scope (#195, gap D2).** A KEEL-RT eligibility scoped to the KEEL-RT admin unit: back
  up, remove it, restore. Expected: recreated at the same unit scope.
- Capture and promote as in Q43 where a gate exists; commit evidence to `claude/live-evidence-q46` and say so in the Result.
- **Report:** per part, passed / failed (with the error) / waiting (PR not live), and every tenant setting read back as original.
### Q47: Turn on scheduled workload backups and the portal's live-record check
- Drafted by the "Keel backup/restore coverage review" thread (2026-10-12).
- Status: blocked
- Result: Run 2026-10-14 09:35 to 09:45 UTC at live build 2b9d310 (#200, #201 and #202 are all live). No tenant writes; Graph reads only, with tenant.json.
  - **A (portal signing key, #200): done.**
    - `/etc/keel/qualification.env` already existed, owned by root and mode 600 (keel-portal runs as root). I restarted keel-portal.
    - The Coverage page needs a signed-in session (401 on localhost), so I ran the same check the page uses with the key against the deployed records: `operations.mjs --live-evidence /opt/keel-live/docs/release/qualifications/entra-live` gives 16 `fixture-tested -> live-qualified` and 6 "not verified by its read-back".
    - Not checked live: the not-600 refusal. The code path is `qualificationKey()` in `portal/lib/runtime-config.ts`, which returns "the key file can be read by other users…". The operator should confirm the Coverage page when signed in.
  - **B (scheduled workload backups, #201): partly blocked.**
    1. Schema: already applied on the live DB by the deploy. `workload_ledger_evidence` and `workload_ledger_grants` exist, and the job check includes `workload-collect`. Nothing to apply.
    2. Import: **0 records stored (exit 1).** All 4 signed records are at build fb1493ea, and the import requires the live build. With `--build 2b9d310` it reports "build mismatch: evidence is 'fb1493ea…', required '2b9d310…'". Without `--build` it reports "expected tenant/build identity required". I did not pass the old build to force a pass. Needs SharePoint, Teams, Exchange and OneDrive/Purview recaptured at the live build (the same chain as Q46 A).
    3. `keel-schedules-migrate --tenant-ref … --kinds workload-collect`: done. Schedule is daily at 02:00 UTC, enabled, next due 2026-10-15 02:00.
    4. `/etc/keel/workload-scope.json` written (mode 644): SharePoint host lxtj.sharepoint.com, mailbox keel-rt-20260908-alice (the only licensed KEEL-RT user), and her OneDrive site.
    5. `run` (exit 0): all 8 workloads `disabled (not qualified; nothing was read)`, as expected with no imported proof. `proof`: "No workload live proof is stored" (exit 1).
  - **C (scheduler, #202): mixed.**
    - `journalctl -u keel-scheduler --since -1h | grep -E "not schedulable|skipped schedule"` is empty (0 matches); the timer ticks every 5 minutes.
    - **But no `api-drift` schedule row exists, and there has never been an api-drift job**, so none will appear this week unless a schedule is added (e.g. `keel-schedules-migrate --kinds api-drift`; not done, since this item doesn't ask for it).
- Needs: a live build containing PRs #200 (portal live records), #201 (workload schedule) and #202 (scheduler api-drift fix).
  Check each with `git -C /opt/keel-live log --oneline | grep -c "#<n>"`; do only the parts whose PR is live.
- **No tenant writes.** Everything here is host setup and read-only collection.
- **A. Signing key for the portal (#200, gap P2).** Create `/etc/keel/qualification.env` holding
  `KEEL_QUALIFICATION_HMAC_KEY=<the release runner signing key>`, owned by the user `keel-portal` runs as, mode 600.
  Never print the key. Restart `keel-portal`. Check: the Coverage page shows Entra writes with 2026-10-10 records as
  "proven on this tenant", and a mode other than 600 is refused with the reason on the page.
- **B. Scheduled workload backups (#201, gaps W1/W3).**
  1. Apply the additive statements from `engine/store/schema.sql` to the live database (the `job` kind check with
     `workload-collect`, tables `workload_ledger_evidence` and `workload_ledger_grants`). Back up the schema first.
  2. `node cli/keel-workload-collect.mjs import` with `KEEL_QUALIFICATION_HMAC_KEY` set. Report how many records stored.
  3. `node cli/keel-schedules-migrate.mjs --kinds workload-collect`.
  4. Write `/etc/keel/workload-scope.json` (SharePoint host, the KEEL-RT mailboxes and OneDrive sites) so SharePoint
     doesn't record "failed" and Exchange reads more than org settings.
  5. Run `node cli/keel-workload-collect.mjs run` once by hand and report each workload's outcome
     (collected / disabled / failed with the reason). Then `... proof` and report days left per proof.
- **C. Scheduler (#202).** After the next tick, `journalctl -u keel-scheduler --since -1h | grep -E "not schedulable|skipped schedule"`
  should be empty, and an `api-drift` job should appear in the week. Report what you see.
- **Report:** per part, done / failed (with the error) / waiting (PR not live).

### Q48: Rerun the Q45–Q47 failures after the 2026-10-14 fixes
- Drafted by the "Keel backup/restore coverage review" thread (2026-10-14).
- Status: done
- Result: Run 2026-10-14 12:25 to 14:35 UTC.
  - Step 0: the live build was cd61e29 (= origin/master), with #207 #209 #211 #212 #213 #215 #216 #218 #219 #222 all live; no deploy reset needed. It auto-deployed during the run to a512c40 (#225) and then 95c3a33 (#229, directorySizeQuota fix). Captures record the build that ran them.
  - Approvals: KEEL CLI dry runs were filed as the Entra principal and approved by the operator (Gmail). For step 31 the portal dry run was the Gmail principal's; at the operator's request keel-operator filed it and approved the request and its content effects as the Entra principal, because the portal had no sign-out at the time.
  - Evidence: branch `claude/live-evidence-q48` @ bd2fadb (no PR).
    - `operations.mjs --live-evidence` (with the key): 37 `fixture-tested -> live-qualified`.
    - Held back, with a raw value the pseudonymizer missed: step 1 group create and step 3 group restore-soft-deleted (`securityIdentifier` S-1-12-1-…), and step 35 roleAssignment create (raw role-assignment object id). All three were promoted on the host. Master's existing group.create files are untouched.
  - Every demotion added needs a matching `liveFailures` entry in code; that is left to the thread.

  **Per step**
  - A (Q45 demotions):
    - 1 group create: promoted (held back).
    - 3 group restore-soft-deleted: promoted (held back).
    - 48 CA create: promoted. It landed report-only and still excludes the operator and both break-glass accounts. The journal shows only the policy write; the excluded users are closure-only.
    - 40 namedLocation update: promoted.
  - B (Q45 blocked steps):
    - 5–8 edges (#219): all 4 edges were written, and each journaled `succeeded`. **Capture blocked by a tool bug:** `looksDisposable` takes `edge:group:KEEL-RT-…|…` and keeps the `group:` prefix, so `^KEEL-RT-` never matches ("is not a disposable … fixture"); the bare name gives not-exercised.
    - 29 organizationalBranding update: promoted (journaled as language 0).
    - 11 application create: **demoted.** The create sends the read-only `createdByAppId` (Graph 400 "Property 'createdByAppId' is read-only and cannot be set"). File: application.create.demotion.json.
    - 13 application restore-soft-deleted: promoted.
    - 14 servicePrincipal create: promoted.
    - 31 groupLifecyclePolicy (#218): promoted. A portal dry run, then the restore request plus a separate content-effect approval ("Shortens retention" 400→365), run by the worker; reads back 365.
    - 35 roleAssignment create: promoted (held back).
    - 44 authorizationPolicy update: promoted. It went through the content-effect approval (externally-sharing).
    - 46 authenticationMethodsPolicy update: **blocked, code.** Verbatim: "unsupported: authentication method configuration VerifiableCredentials, QRCodePin has no known type, so it cannot be written". The drift was Software OATH, because a trial tenant can't turn on SMS; it was set back by hand.
    - 47 security defaults: **blocked, as allowed.** 8 CA policies are on, so Entra refuses the drift. Not drifted, not demoted.
  - C (#213, one restore of a group plus 2 Intune policies): **blocked by the known limit.** The group was purged, so the dry run says "assignments cannot be restored: the group group:KEEL-RT-148-cgroup does not exist in the target. Nothing was written for this policy" for both policies.
  - D:
    - fr-FR favicon (#207): promoted. Restored by the worker; it reads back with sha256 68edc125… (79 bytes).
    - PIM eligibility at an admin-unit scope (#222): promoted (roleEligibilitySchedule create).
    - Exchange org setting: done. SharePoint, Teams and Exchange live acceptance were recaptured at 95c3a33; `qualification.mjs verify --require-live` exits 0 for each.
      - Exchange step 9: MailTipsLargeAudienceThreshold went 25 → 26 → 25, read back and restored.
      - The SharePoint capture used `--allow-widening-toggle`, the same as the earlier fb1493ea decision. Re-decide if needed.
  - E (#215, #225):
    - The import stored 4 records at evidenceBuild fb1493ea, none refused.
    - `proof`: 4 entries expiring 2026-11-06, exit 0 (22 days left, outside the 14-day warning).
    - After #225, `powershellConfigs` is in /etc/keel/workload-scope.json (exchange → exchange-collector, onedrive and purview → purview-collector). A default `run` gives: SharePoint, Exchange, OneDrive and Purview labels complete; Teams partial (`tenantId` not observable); mail flow, Teams org policies and retention/DLP disabled (no proof yet).
    - Re-import after the D recapture: SharePoint, Teams and Exchange are now proven until 2026-11-13.
    - **OneDrive/Purview was refused:** its prerequisites must share its build, so it needs recapturing at the live build before 2026-11-06.
  - F: done. The `api-drift` schedule row is weekly at 03:00 UTC, enabled, next 2026-10-19 03:00.
  - G:
    - 45 PIM policy update: promoted (Accept-Language fix confirmed).
    - 37 roleAssignment delete: allowed (readiness ready) and executed by the worker. **Capture blocked by a tool bug:** with `--allow-by-reference` it reports "the snapshot has no object …", because a delete's object is never in the snapshot; without the flag it insists on `--allow-by-reference`.
    - 52 conditionalAccessPolicy delete: **refused.** Verbatim: "refusing to delete conditional access policy: <object id> is excluded by conditions.users.excludeUsers". Every fixture CA policy must exclude the operator and break-glass, so this guard makes 52 untestable here.

  **KEEL bugs found (for the code thread)**
  1. organization.directorySizeQuota in the restore diff. Already fixed by #229/95c3a33 during the run. Before the fix it was worked around with throwaway groups KEEL-RT-148-pad1/2/3, all since deleted and purged.
  2. application create sends `createdByAppId`.
  3. Capture tool: edge fixture prefix (steps 5–8).
  4. Capture tool: by-reference capture of a delete (step 37).
  5. Pseudonymizer: misses group securityIdentifier and roleAssignment object ids.
  6. authenticationMethodsPolicy: unknown method types (VerifiableCredentials, QRCodePin).
  7. CA delete guard: refuses any policy with excludeUsers.
  8. Portal: the content-effects page had no link, a dry-run job page couldn't return to Confirm, and there was no sign-out. #228/#229 address these; not yet rechecked.

  **Tenant**
  - Every KEEL-RT-148-* fixture is deleted and purged.
  - authorizationPolicy, authenticationMethodsPolicy, security defaults and group lifecycle policies (none) all read back the same as originals.json.
  - The 8 enabled CA policies are unchanged.
  - Operator follow-up 2026-10-14 14:33 UTC: the operator deleted the fr-FR branding and purged both CA policies. Graph now shows no branding localizations (the original state) and no KEEL-RT-148 CA policies in deleted items. **Nothing left in the tenant.**
- Needs: Q47 done or blocked. A live build containing #207 (capture tool), #209 (demotion records), #212 (verification
  ignores server-managed fields), #213 (assignment target ordering), #215 (workload proof build), #216 (update body
  @odata.type), #218 (content-effect approval page), #219 (edge outcomes, language-0 branding, policy-restore waves) and
  #222 (PIM admin-unit scope). Check each with `git -C /opt/keel-live log --oneline | grep -c "#<n>"`; run only the parts
  whose PR is live and report the rest as waiting.
- **Thread note (2026-10-14 12:51 UTC).** Marouane replied "approved" to the list of your portal asks (e51afedd main
  batch with its content effects, 3821eeba step 37 delete, the step 48 CA purge, the step 31 lifecycle restore). Check
  in the portal which approvals actually went through and whether the purge and the lifecycle restore were done before
  continuing; run only what is approved, and report anything still pending.
- **Step 0: master history was rewritten (2026-10-14).** Master was force-pushed with the same file contents and new
  commit IDs, so old SHAs no longer match; check PRs by the `#<n>` in commit titles as above. If keel-deploy refuses the
  non-fast-forward master (`--ff-only`) and the live build stays old, reset the deploy checkout to `origin/master` and
  let the next deploy run (with its live check). If you cannot, set Status to blocked with the deploy log lines and stop.
  Do not merge master into this queue branch.
- **Test tenant only.** Same hard rules and requester/approver split as Q45 (file as the Entra principal, approve as Gmail).
- **A. Q45 demoted steps (#212, #216).** Rerun 1 group create, 3 group restore-soft-deleted, 48 CA policy create (lands
  report-only) and 40 namedLocation update. Expected: verified and captured. The held-back group evidence is captured again.
- **B. Q45 blocked steps.**
  - 5–8 member/owner edge add and remove (#219): each edge now records an outcome; capture each.
  - 29 organizationalBranding update (#219): capture with `--resource-type organizationalBranding --fixture organizationalBranding --allow-tenant-setting`. In this tenant the write is journalled as language "0"; the capture accepts it.
  - 11, 13, 14 application steps (#211, if live): publicClient is reviewed sign-in config, so the guard should not refuse.
    If #211 is not live, report them as waiting.
  - 31 groupLifecyclePolicy (#218): a new restore request; then Approvals, "Review content effects" on it, approve as
    someone other than the requester, and run it. Expected: the write goes through instead of `blocked-content-effect`.
  - 35 roleAssignment create (#207): capture with `--allow-by-reference`.
  - 44, 46, 47 break-glass steps: readiness is now ready (Q46 B), so rerun them. Refusals of deletes that would leave
    break-glass unready are a pass; report the reasons verbatim.
- **C. One restore for Q45's group and its two policies (#213).** Delete the group and both Intune policies assigned to it,
  then restore all three in one restore. Expected: the group is created first and both policies are assigned to the new
  group id. (A group that does not exist anywhere yet still refuses its policies in the dry run; that limit is known.)
- **D. Q46 leftovers.**
  - C branding file (#207): `capture --resource-type 'organizationalBranding#file' --operation update --fixture
    'organizationalBranding#file:fr-FR/favicon' --allow-tenant-setting`, then `promote --evidence
    $OUT/organizationalBranding.file.update.json`. Recreate the fr-FR localization and favicon drift first if needed.
  - D PIM eligibility at an admin-unit scope (#222): redo Q46 D. No schema statement is needed.
  - A Exchange org setting: recapture SharePoint and Teams at the live build, then run Q46 A as written.
- **E. Workload proofs (#215).** `KEEL_QUALIFICATION_HMAC_KEY=… node cli/keel-workload-collect.mjs import` (no `--build`
  needed). Expected: 4 imported at evidenceBuild fb1493ea, none refused, exit 0. Then `proof` (4 entries, expiring about
  2026-11-06; exit 1 inside the 14-day warning is expected) and one `run` (workloads no longer "disabled").
  Recapture the four workload records before 2026-11-06 (the Part D recaptures above count).
  - **Scheduled run configs (#225, if live).** The run used to give every PowerShell workload `tenant.json`, which cannot
    connect to Exchange, OneDrive or Purview. Once #225 is live, add to `/etc/keel/workload-scope.json`:
    `"powershellConfigs": { "exchange": "/etc/keel/exchange-collector.json", "onedrive": "/etc/keel/purview-collector.json",
    "purview": "/etc/keel/purview-collector.json" }` (use the collector files the Q46 A captures used). The scope file is
    read by default, so the schedule needs no change. Then one `run` by hand: report each workload's outcome.
- **G. Three writes that can pass now** (from the #148 close-out, issue comment 6167331730).
  - 45 unifiedRoleManagementPolicy update: rerun. The Accept-Language fix (d8a67ce) is on master, so the PIM read-back
    should now confirm the write.
  - 37 roleAssignment delete and 52 conditionalAccessPolicy delete: use the lockout delete path that proved
    namedLocation delete in Q46 B (`--delete <type>:<KEEL-RT name>` dry run, approval, `--artifact <id> --enforce`).
    Use a KEEL-RT role assignment that is not a break-glass account's, and a KEEL-RT report-only policy. Readiness
    is ready, so both should be allowed and verified. If either is refused, report the reason verbatim.
- **F. api-drift schedule.** `node cli/keel-schedules-migrate.mjs --kinds api-drift`; report the schedule row.
- Capture and promote as in Q43; commit evidence to `claude/live-evidence-q48`. Every demotion file you add needs a
  matching `liveFailures` entry in code; leave that to the thread and say so in the Result.
- **Report:** per step, promoted / demoted (with the reason) / blocked / waiting, and every tenant setting read back as original.
### Q49: Rerun Q48 step 46 and check the organization fix (#226)
- Drafted by the "Keel backup/restore coverage review" thread (2026-10-14).
- Status: done
- Result: Started 2026-10-14 14:42 UTC at live build 95c3a33 (#226 live); A captured at be3d299 (live build at capture time).
  **A (step 46, authenticationMethodsPolicy update): promoted.** Snapshot 0db6375c (SoftwareOath disabled), drifted SoftwareOath to enabled. Dry run 8c4d3cc3 completed with no unknown-method-type refusal (#226 fix confirmed). Approval 771e04c8 approved by the operator 18:55 UTC; worker job succeeded 18:55:23. Journal: update succeeded. Graph read-back: SoftwareOath disabled. `entraLive capture --allow-tenant-setting` then `promote`: fixture-tested -> live-qualified. Pseudonymize check passed; secret scan clean.
  **B (organization directorySizeQuota false diff, #229): passed.** Live quota used 1088 vs 1095 in the snapshot; organization was in the closure and was planned without failing (dry run 9d3e0d3f; its overall failure is unrelated: AU and branding creates unsupported).
  Evidence: branch `claude/live-evidence-q49` @ fc1797a (docs/release/qualifications/entra-live/authenticationMethodsPolicy.update{,.capture}.json). No PR.
  Tenant: SoftwareOath back to its original disabled state; no fixtures left.
- Needs: Q48 done or blocked, and a live build containing #226 (`git -C /opt/keel-live log --oneline | grep -c "#226"`).
- **Test tenant only.** Same hard rules and requester/approver split as Q45.
- **A. Step 46 authentication methods policy.** Rerun it from a snapshot taken before the Software OATH change. Expected:
  no "has no known type" refusal for QRCodePin or VerifiableCredentials; the policy is written, read back and captured.
- **B. No false organization change.** Delete `KEEL-RT-148-pad1` and `KEEL-RT-148-pad2` (and create or delete any other
  KEEL-RT object) so the directory object count differs from snapshot `f5a789c4`. Then dry-run a restore whose closure
  reaches a user from that snapshot. Expected: the organization plans as unchanged and the dry run does not fail on it.
  Do not file it for approval; the dry run alone is the check.
- **Report:** per part, passed / failed (with the error) / waiting (#226 not live).
### Q50: Recapture OneDrive/Purview (gate 123) before 2026-11-06
- Drafted by the "Q48 and Q49 operator results" thread (2026-10-14), at Marouane's request.
- Status: done
- Result: Ran 2026-10-14 18:59–19:08 UTC at live build be3d299 (moved since Q48), so I recaptured 120 → 121 → 122 → 123 in one sitting.
  **A. Capture: passed.** Each capture exited 0, and `qualification.mjs verify --require-live --gate <g> --build be3d299` exited 0 for all four.
  - 120 SharePoint: the widening toggle was written, read back and restored.
  - 121 Teams: both reversible writes were restored.
  - 122 Exchange (alice's mailbox):
    - timeZone and PopEnabled restored.
    - RetainDeletedItemsFor 22 → 23. It is extend-only, so it stays at 23 by design.
    - Step 9 MailTipsLargeAudienceThreshold 25 → 26 → 25, read back.
  - 123 OneDrive/Purview: fresh unpublished `KEEL-RT-20261014-label1`, `--fixture-site` alice's OneDrive, `--fixture-policy KEEL-RT-20261005-policy`. The label update was restored.
  **B. Evidence:** branch `claude/live-evidence-q50` @ e47495b, 8 files in docs/release/qualifications/*-live-acceptance{,.capture}.json, all evidenceBuild be3d299. The secret/SID/tenant/lxtj scan is clean and `pseudonymize.mjs check` exited 0. No PR.
  **C. Proofs: passed.** import exited 0, all four imported, refused [].
  - proof exited 0: all four workloads now prove to **2026-11-13**.
  - run exited 1:
    - complete: sharepoint-site-settings, exchange-mailbox-settings, onedrive-site-settings, purview-labels.
    - partial: teams-settings (165 observed, 11 unknown; identical to Q48).
    - disabled (not qualified): exchange-mail-flow, teams-org-policies, purview-retention-dlp.
  **Cleanup:** I removed `KEEL-RT-20261014-label1` from the policy and ran Remove-Label on it, so it reads back as PendingDeletion. The policy's labels read back as before. Q39's `KEEL-RT-20261007-label` was already in that policy before Q50 and was left alone. Original values were read back as listed above.
- Needs: Q49 done or blocked. Must finish before 2026-11-06, when the current OneDrive/Purview proof expires.
- **Test tenant only.** Same hard rules as Q45.
- **Why.** In Q48 part E the OneDrive/Purview proof import was refused: its record is at build fb1493ea, while the
  SharePoint, Teams and Exchange records it depends on were recaptured at 95c3a33. All four must be at one build.
- **A. Capture.** If `/opt/keel-live` is still at the build of the Q48 SharePoint, Teams and Exchange records, capture only
  123 `onedrive-purview-live-acceptance` as in Q39 step 7: a fresh unpublished `KEEL-RT-<date>-label<n>` and
  `--fixture-site` alice's OneDrive. If the live build has moved since, recapture 120 → 121 → 122 → 123 in one sitting
  at the new build. After each capture run `qualification.mjs verify --require-live --gate <gate> --build B --tenant <ref>`
  and record the exit code; a refusal is a result, so stop the chain and report it.
- **B. Evidence.** Commit to `claude/live-evidence-q50`, branched from `origin/master`, with the usual public-repo scans.
- **C. Proofs.** `node cli/keel-workload-collect.mjs import`, then `proof`. Expected: all four workloads proven, none
  refused, expiring about 4 weeks out. Then one `run` and report each workload's outcome.
- **Cleanup.** Delete the fresh label and anything else the capture created; report what reads back as original.
- **Report:** per part, passed / failed (with the error), plus the new expiry dates.
### Q51: Recapture the Q48 steps the #230 fixes unblock
- Drafted by the "Q48 and Q49 operator results" thread (2026-10-14).
- Status: done
- Result: Ran 2026-10-14 19:00–19:25 UTC at live build be3d299 (#230 live), in parallel with Q50. Fresh fixtures: groups KEEL-RT-Q51-g5..g8, app KEEL-RT-Q51-app11, AU KEEL-RT-Q51-unit, custom role KEEL-RT-Q51-role (renamed KEEL-RT-148-role for C, see B), principals keel-rt-20260908-carla and -ryan. Break-glass readiness read "ready".
  **A. Steps 5–8 (group member/owner edge add/remove): promoted (4).** One batch restore 905a03a6 (approval 976658ad), journal 4 edges succeeded. Captured with both fixture forms (bare name and `group:<name>`); all four promoted.
  **B. Step 37 (roleAssignment delete): blocked by capture-tool bug, filed as https://github.com/7empes7s/keel/issues/232.** The restore worked: delete dry run 923132e0 (approval 1a34a72c), job succeeded, journal `delete | succeeded` for ryan @ KEEL-RT-Q51-unit. The capture refused: "the role is not the fixture role; the scope is not a KEEL-RT fixture".
  - The delete path resolves the scope from the composed key's raw `/administrativeUnits/<id>`, which never maps to the AU name.
  - `FIXTURE_ROLE` is hard-coded to `KEEL-RT-148-role`.
  The restore is journaled and can be recaptured from restore ref 923132e0 once #232 is fixed, with no new restore needed. Comment left on #230.
  **C. Step 35 (roleAssignment create): promoted** (`--allow-by-reference`, id pseudonymized). To pass the hard-coded role check I renamed the role to KEEL-RT-148-role and took a fresh snapshot (ced73acb). There were two "target has changed since the dry run" refusals before it ran:
  - dcdb0725: the batch in A changed carla first.
  - 9a…/525a25cf: the dry run read Graph seconds after I deleted the assignment (replication lag; two later dry runs gave identical fingerprints).
  Final run: dry run under approval d32e6111, job succeeded, captured and promoted. The stale request fbe8b270 was superseded. The Q48 raw-id capture was not published.
  **D. Step 11 (application create): promoted.** The create no longer sends createdByAppId; journal `create | succeeded`, captured and promoted.
  **E. Steps 1 and 3 held-back group records: committed.** `pseudonymize.mjs check` exit 0 for all four files. Their securityIdentifier SIDs decode to the pseudonymized object ids, not real ones.
  Evidence: `claude/live-evidence-q51` @ 72859a7 (E at f25caf9): 12 + 4 files in docs/release/qualifications/entra-live. Secret, SID, tenant, lxtj and raw-fixture-id scans are clean; pseudonymize check exit 0 for every file. No PR.
  Cleanup: role assignments, role, AU, groups g5–g8 and the recreated app were deleted, and groups and app were purged from deleted items. Read-back shows 0 KEEL-RT-Q51 objects and 0 KEEL-RT custom roles.
  Waiting on: #232 fix, then recapture step 37 from restore 923132e0.
  **Update 20:05 UTC (Q53):** B step 37 promoted and published after #233 and #237, on claude/live-evidence-q51 @ 0b0cacc. All parts done.
- Needs: Q49 done or blocked, and a live build containing #230 (`git -C /opt/keel-live log --oneline | grep -c "#230"`).
  Run before or after Q50, whichever is first in line; they don't share fixtures.
- **Test tenant only.** Same hard rules and requester/approver split as Q45.
- **Why.** #230 fixed the four capture and restore bugs Q48 found. The Q48 fixtures were all deleted in its cleanup,
  so recreate fresh `KEEL-RT-*` fixtures (a new date prefix is fine) and redo each write before capturing it.
- **A. Steps 5–8, group member and owner edges.** Redo the four edge add/remove restores as in Q48 B and capture each.
  `--fixture` now matches with either the bare group name or `group:<name>`.
- **B. Step 37, role-assignment delete.** Redo it through the lockout delete path as in Q48 G, with a KEEL-RT principal,
  role and scope (not a break-glass account's), and capture it. A delete is now checked by its own composed key.
- **C. Step 35, role-assignment create.** Recapture with `--allow-by-reference`. Role-assignment ids are now
  pseudonymized. The Q48 capture holds the raw id: never publish it.
- **D. Step 11, application create.** Rerun the restore. The create body no longer sends `createdByAppId`. If it is
  verified, capture and promote it; if it fails again, keep the demotion and report the error verbatim.
- **E. Steps 1 and 3, held-back group records.** Run `node tools/qualification/pseudonymize.mjs check <file>...` on the
  held-back step 1 and 3 captures. Exit 0 means every id is a pseudonym: then commit them. Otherwise keep holding them
  back and report what the check printed.
- Evidence on `claude/live-evidence-q51`, branched from `origin/master`, adding or updating files only; run the
  public-repo scans and `pseudonymize.mjs check` on every file before committing.
- **Cleanup.** Delete and purge every fixture created here; report what reads back as original.
- **Report:** per part, promoted / demoted (with the reason) / blocked, plus the evidence commit.
### Q52: Recapture Q51 step 37 from its existing restore after the #232 fix
- Drafted by the "step 37 fixture role check" thread (2026-10-14).
- Status: done
- Result: Ran 2026-10-14 19:37 UTC at live build a171d47 (contains #233). No new restore and no tenant writes.
  **A. Capture: captured.** Step 37 roleAssignment delete from restore ref 923132e0 (`--allow-by-reference`). The "fixture role" and "scope" refusals are gone, so #233 works.
  **B. Promote: promoted** (fixture-tested -> live-qualified). **Publish: held back.** The capture log contains the deleted assignment's raw object id in `targetId` and `priorState.id`, and `pseudonymize.mjs check` still exits 0 on it; my own known-id scan caught it. Filed https://github.com/7empes7s/keel/issues/235 and commented on #233. Nothing committed for step 37; the files stay on the host (/root/keel-q51/out/roleAssignment.delete*.json).
  Next: once #235 is fixed, recapture from the same restore ref and commit to claude/live-evidence-q51.
  **Update 20:05 UTC (Q53):** published after the #237 fix, on claude/live-evidence-q51 @ 0b0cacc.
- Needs: a live build containing #233 (`git -C /opt/keel-live log --oneline | grep -c "#233"` is 1 or more).
- **Test tenant only.** No new restore: this only reads the journal and snapshot of a restore that already ran.
- **Why.** #233 (fixes #232) accepts any `KEEL-RT-` custom role in place of the exact name `KEEL-RT-148-role`, and
  resolves an administrative-unit scope (`/administrativeUnits/<id>`) on a role-assignment delete by the unit's object id
  in the restore's snapshot. Both were why the Q51 step 37 capture was refused.
- **A. Capture.** `entraLive capture` for step 37 (roleAssignment delete, `--allow-by-reference`) from restore ref
  923132e0 (D37 in `/root/keel-q51/artifacts.env`), with the same fixture key as in Q51 B. Expected: captured, no
  "role is not the fixture role" or "scope is not a KEEL-RT fixture" refusal. Any other refusal is a result: report it
  verbatim and stop.
- **B. Promote and publish.** `promote` it, run `pseudonymize.mjs check` and the usual public-repo scans, then commit to
  `claude/live-evidence-q51` (adding or updating files only).
- **Report:** captured / promoted / refused (with the error), plus the evidence commit. Then set Q51 to done if this passes.

### Q53: Recapture and publish step 37 after the #235 fix
- Drafted by the "step 37 capture id leak" thread (2026-10-14).
- Status: done
- Result: Ran 2026-10-14 20:04 UTC at live build 860ec69 (contains #237). No new restore and no tenant writes.
  **A. Capture: captured.** Step 37 roleAssignment delete from restore ref 923132e0 (`--allow-by-reference`), with the same fixture key as Q52.
  **B. Check: passed.** `pseudonymize.mjs check` exited 0 on both the record and the capture log. My known-id scan (Q45/Q48/Q51 fixture ids, dashed and dashless, plus carla's id) found 0. The marker scan (SID, lxtj, tenant id, JWT, operator principals) found 0.
  **C. Promote and publish: promoted** (fixture-tested -> live-qualified). Committed to `claude/live-evidence-q51` @ 0b0cacc (roleAssignment.delete{,.capture}.json, added). I deleted the held-back Q52 files on the host without publishing them.
  Q51 and Q52 are set to done.
- Needs: PR #237 merged and a live build containing it (`git -C /opt/keel-live log --oneline | grep -c "#237"` is 1 or more).
- **Test tenant only.** No new restore and no tenant writes: this only reads the journal and snapshot of restore ref
  923132e0, as Q52 did.
- **Why.** #237 (fixes #235) pseudonymizes the deleted role assignment's id in `targetId` and `priorState.id`, and
  `pseudonymize.mjs check` now flags it raw. A by-reference capture also refuses if its target's own id survives.
- **A. Capture.** `entraLive capture` for step 37 (roleAssignment delete, `--allow-by-reference`) from restore ref
  923132e0 with the same fixture key as Q52 A. Expected: captured. A refusal is a result: report it verbatim (it names
  the id's length, never the id) and stop.
- **B. Check.** Run `node tools/qualification/pseudonymize.mjs check` on the new record and capture log (expected exit 0)
  and repeat your known-id scan from Q52 (expected: no fixture object id found).
- **C. Promote and publish.** `promote` it, run the usual public-repo scans, then commit to `claude/live-evidence-q51`
  (adding or updating files only). Replace the held-back Q52 files on the host; do not publish those.
- **Report:** captured / promoted / refused, both check exit codes, and the evidence commit. Then set Q51 and Q52 to done
  if this passes.

### Q54: Recapture and republish the step 10 user restore-soft-deleted record after the #237 fix
- Drafted by the "published capture raw id" thread (2026-10-14).
- Status: done
- Result: Ran 2026-10-14 20:04 UTC at live build 860ec69 (contains #237). No new restore and no tenant writes.
  **A. Capture: captured, using the real restore ref.** With the ref the item gives (`aabeac39-e68d-8728-…`), the capture refused verbatim: "no restore artifact <id>". That value is the pseudonym printed in the published record (version nibble 8), not a DB id. The journal entry for `user:keel-rt-20260908-carla… restore-soft-deleted` is under restore ref `52d30020-b03c-4957-8c55-7974c4093145`, the value the item called "job 52d30020". Capturing with that ref succeeded.
  **B. Check: passed.** `pseudonymize.mjs check` exited 0 on the record and the capture log. `priorState.userPrincipalName` prefix is `a0fcb2f8b0c38a889b94319165913d40`, as expected. The known-id scan (dashed and dashless) found 0 and the marker scan found 0.
  **C. Promote and publish: promoted** (fixture-tested -> live-qualified). New branch `claude/live-evidence-q54` @ b8e1d28 from origin/master, replacing the published pair (user.restore-soft-deleted{,.capture}.json, both modified). No PR.
- Needs: a live build containing #237 (`git -C /opt/keel-live log --oneline | grep -c "#237"` is 1 or more). Independent
  of Q53; run it right after Q53 or before it, whichever is first in line.
- **Test tenant only.** No new restore and no tenant writes: this only reads the journal, artifact and snapshot of the
  Q45 round C restore that already ran (restore ref `aabeac39-e68d-8728-a0cd-69d3b0796364`, job 52d30020).
- **Why.** The published `docs/release/qualifications/entra-live/user.restore-soft-deleted.capture.json` (Q45 step 10)
  holds one real object id: the deleted user's `priorState.userPrincipalName` starts with the user's object id written
  without dashes (Entra's soft-delete UPN prefix). #237 now maps a dashless GUID like its dashed form, and
  `pseudonymize.mjs check` flags this file on master. The record is signed over the capture log's sha256, so the file
  cannot be edited by hand; it has to be recaptured and re-signed.
- **A. Capture.** `entraLive capture --resource-type user --operation restore-soft-deleted --restore-ref
  aabeac39-e68d-8728-a0cd-69d3b0796364 --fixture user:keel-rt-20260908-carla@techinsiderbytes.com`. Expected: captured.
  A refusal (journal or snapshot gone, or anything else) is a result: report it verbatim and stop; do not redo the restore.
- **B. Check.** `node tools/qualification/pseudonymize.mjs check` on the new record and capture log: expected exit 0.
  Expected `priorState.userPrincipalName` prefix: `a0fcb2f8b0c38a889b94319165913d40` (the same pseudonym as
  `priorState.id`). Also repeat your known-id scan: no fixture object id found.
- **C. Promote and publish.** `promote` it, run the usual public-repo scans, then commit the two files
  (`user.restore-soft-deleted.json` and `.capture.json`) to a new branch `claude/live-evidence-q54` from `origin/master`,
  replacing the published pair (updating files only). No PR needed; the drafting thread opens it.
- **Report:** captured / promoted / refused, the check exit code, and the evidence commit.

### Q55: Add the read permissions Keel's apps need, so Marouane can grant admin consent (plan ask 1)
- Drafted by the "Add API permissions" thread (2026-10-14).
- Status: done
- Result: Done 2026-10-14 21:44–21:55 UTC. Manifests, an Exchange role and a group only: no appRoleAssignment
  created and no consent granted. Writes used the Restorer (Graph, and EXO PowerShell in a throwaway `keel-powershell:latest`
  container); the C check used the Collector. Global admin was not used.
  - **A. Collector** (KEEL Collector, app object ce48109a…, appId 87aa77c4…, SP f8741600…): one merged PATCH (204).
    Every existing resource and entry was kept (SharePoint 2, Exchange 1, Graph delegated 1). The 18 Q7 Graph roles were already
    in the manifest. Added 12: LifecycleWorkflows.Read.All, CustomSecAttributeDefinition.Read.All, Agreement.Read.All,
    MultiTenantOrganization.Read.All, IdentityUserFlow.Read.All, APIConnectors.Read.All, SharePointTenantSettings.Read.All,
    Sites.Read.All, TeamSettings.Read.All, TeamMember.Read.All, Team.ReadBasic.All, MailboxSettings.Read. Nothing skipped.
    Graph application permissions in requiredResourceAccess: now 30.
  - **B. KEEL Content Reader** created (single tenant, no redirect URI, no secret): app object 4c90022a…, appId 00c7eb61…,
    SP 9fa46563…. One keyCredential: the public cert only, self-signed RSA 2048, CN=KEEL Content Reader, valid to 2028-10-13.
    Files: `/etc/keel/content-reader.key` (root:root 600; there is **no `keel` user on Mulinux**, so the owner is root) and
    `/etc/keel/content-reader.crt` (644). `content-reader.json` and `content.key` were NOT written.
    All 17 Graph application permissions were added; none was skipped (MailboxFolder.Read.All and MailboxItem.Read.All exist as appRoles).
  - **C. Exchange:** created the management role `KEEL-RT Address Lists Read` (parent "Address Lists"); all non-`Get-` entries
    removed. Entries left: Get-AddressBookPolicy, Get-AddressList, Get-GlobalAddressList, Get-OfflineAddressBook. Created the EXO
    service principal for the Collector (there was none). Created the role group `KEEL-RT-collector-address-lists`
    (role: KEEL-RT Address Lists Read; member: KEEL Collector). Check as the Collector: `Get-GlobalAddressList` returns 1 row,
    and `New-AddressList` and `Set-GlobalAddressList` are not available.
  - **D.** Created security group `KEEL-RT-collector-fabric-readers` (2e66e1b2…, not mail-enabled). Its only member is the KEEL
    Collector SP (checked through memberOf). No Fabric or Power Platform setting was touched.
  - **E. Check (read-only):**
    - Collector: 30 Graph roles in its manifest; 30 assignments held now.
      - Still to be consented (6): APIConnectors.Read.All, Agreement.Read.All, CustomSecAttributeDefinition.Read.All,
        IdentityUserFlow.Read.All, LifecycleWorkflows.Read.All, MultiTenantOrganization.Read.All.
      - The other 6 new ones (SharePointTenantSettings.Read.All, Sites.Read.All, TeamSettings.Read.All, TeamMember.Read.All,
        Team.ReadBasic.All, MailboxSettings.Read) were already consented, not in the manifest.
      - No Power BI permission, in the manifest or held.
    - **Flag for Marouane:** the Collector also holds 2 Graph assignments that are not in its manifest:
      **Sites.FullControl.All** (a write permission on the read-only app) and GroupMember.Read.All. It also holds 1 SharePoint
      Online role that is not in its manifest (678536fe…). I did not remove any of them (out of scope); say if they should go.
    - Content Reader: 17 Graph roles in its manifest; 0 held. Consent adds all 17: Calendars.Read, Channel.ReadBasic.All,
      ChannelMember.Read.All, ChannelSettings.Read.All, Contacts.Read, Files.Read.All, Group.Read.All, Mail.Read,
      MailboxFolder.Read.All, MailboxItem.Read.All, MailboxSettings.Read, Sites.Read.All, Tasks.Read.All, Team.ReadBasic.All,
      TeamsAppInstallation.ReadForTeam.All, TeamsTab.Read.All, User.Read.All.
  - Waiting on Marouane: admin consent for both apps (Entra > App registrations > API permissions > Grant admin consent).
    Then the Fabric setting "Service principals can access read-only admin APIs", scoped to KEEL-RT-collector-fabric-readers.
- Needs: none. Decision: D-Q55 (filled).
- **Test tenant only. Read permissions only.** Never create an appRoleAssignment or grant consent (Marouane does that).
  Never enable a CA policy; never touch break-glass or `marouane.defili`. Use the Restorer for the writes below
  (Application.ReadWrite.All, Group.ReadWrite.All, Exchange Administrator). No secret is printed or committed.
- **A. Collector (KEEL Collector, appId 87aa77c4…): add to `requiredResourceAccess`.** GET the application first and
  MERGE: keep every existing resource and entry, add only what is missing, PATCH once. Resolve each name to its id from
  the Microsoft Graph service principal's `appRoles` (type Role). Graph application permissions:
  - Entra governance reads (PR #259): `LifecycleWorkflows.Read.All`, `CustomSecAttributeDefinition.Read.All`,
    `Agreement.Read.All`, `MultiTenantOrganization.Read.All`, `IdentityUserFlow.Read.All`, `APIConnectors.Read.All`.
  - Workload reads declared in `engine/collect/workloadContract.mjs` that Q7 did not list: `SharePointTenantSettings.Read.All`,
    `Sites.Read.All` (Graph), `TeamSettings.Read.All`, `TeamMember.Read.All`, `Team.ReadBasic.All`, `MailboxSettings.Read`.
  - Also make sure every Graph permission the Collector already holds (Q7 list) is in `requiredResourceAccess`, so one
    consent covers the whole set. Add nothing else. Do NOT add `Sites.FullControl.All` or any Power BI permission.
- **B. Content reader: create a new app registration `KEEL Content Reader`** (single tenant, no redirect URI, no secret).
  - Credential: a new certificate generated on Mulinux, key at `/etc/keel/content-reader.key` and cert at
    `/etc/keel/content-reader.crt` (owner keel, mode 600 for the key). Upload the public cert only as a keyCredential.
  - Create its service principal. Do NOT write `/etc/keel/content-reader.json` or `/etc/keel/content.key` (the nightly
    content job keeps saying it waits on ask 1 until the live-check thread sets those up).
  - `requiredResourceAccess`, Microsoft Graph application permissions (17), read only:
    `Mail.Read`, `Calendars.Read`, `Contacts.Read`, `MailboxSettings.Read`, `Tasks.Read.All`, `User.Read.All`,
    `Group.Read.All`, `Files.Read.All`, `Sites.Read.All`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`,
    `ChannelSettings.Read.All`, `ChannelMember.Read.All`, `TeamsTab.Read.All`, `TeamsAppInstallation.ReadForTeam.All`,
    `MailboxFolder.Read.All`, `MailboxItem.Read.All`.
  - If a name has no matching Graph appRole (the last two are new beta permissions), skip it and report which.
  - Do NOT add `ChannelMessage.Read.All` (waits on Microsoft, ask 2) or anything with Write/FullControl.
- **C. Exchange: read-only address-list role for the Collector** (`Get-GlobalAddressList` needs the "Address Lists" role,
  which also holds write cmdlets). In EXO PowerShell as the Restorer:
  1. `New-ManagementRole -Parent "Address Lists" -Name "KEEL-RT Address Lists Read"`, then remove every entry whose
     name does not start with `Get-` (`Get-ManagementRoleEntry "KEEL-RT Address Lists Read\*" | Where-Object Name -notlike 'Get-*' | Remove-ManagementRoleEntry -Confirm:$false`).
  2. Make sure an EXO service principal exists for the Collector (`Get-ServicePrincipal`; if absent,
     `New-ServicePrincipal -AppId <Collector appId> -ObjectId <Collector SP object id> -DisplayName "KEEL Collector"`).
  3. `New-RoleGroup -Name "KEEL-RT-collector-address-lists" -Roles "KEEL-RT Address Lists Read" -Members <Collector SP object id>`.
  4. Check: as the Collector, `Get-GlobalAddressList` returns rows and `New-AddressList` is not available.
- **D. Power BI read-only admin APIs: prepare the group only.** Create security group `KEEL-RT-collector-fabric-readers`
  (not mail-enabled) with the Collector's service principal as its only member. Marouane turns on the Fabric tenant
  setting for it; don't try to change Fabric or Power Platform settings.
- **E. Check, read-only:** list the Collector's and the Content Reader's `requiredResourceAccess` names, and the names of
  the appRoleAssignments each SP holds now (the gap is what Marouane's consent will add). Confirm the Collector holds no
  Power BI permission.
- **Report:** what was created or changed (app, SP, cert path, role, role group, group), the requiredResourceAccess
  names per app, anything skipped and why. Short ids only (first 8 characters), as in Q7.

### Q56: Add the remaining read permissions to the Collector (discovery, Intune scripts, audit context)
- Drafted by the "Add API permissions" thread (2026-10-14). Same decision as Q55 (D-Q55); Marouane then added
  "all the necessary permissions" (project chat, 2026-10-14 21:38 UTC), so this covers every read discovery and the plan's
  backups probe, not only ask 1.
- Status: done
- Result: Done 2026-10-14 21:58–22:01 UTC. The Collector manifest only: one merged PATCH (204) as the Restorer. No
  appRoleAssignment, no consent, nothing removed (read back: 0 entries lost). Global admin not used.
  - Added 15 (all resolved to Graph appRoles; none skipped): AuditLog.Read.All, ServiceHealth.Read.All,
    CustomAuthenticationExtension.Read.All, ExternalConnection.Read.All, IdentityRiskEvent.Read.All,
    InformationProtectionPolicy.Read.All, Place.Read.All, Printer.Read.All, Reports.Read.All, RoleManagement.Read.All,
    SecurityEvents.Read.All, TeamworkTag.Read.All, DeviceManagementScripts.Read.All, plus the already-held
    GroupMember.Read.All and Sites.FullControl.All.
  - The Collector's Graph application permissions in its manifest: 45 (49 entries in all, with SharePoint 2, Exchange 1 and Graph delegated 1).
    Graph roles held now: 26. Every held Graph role is now in the manifest.
  - Waiting for Marouane's consent (manifest minus held, 19): APIConnectors.Read.All, Agreement.Read.All, AuditLog.Read.All,
    CustomAuthenticationExtension.Read.All, CustomSecAttributeDefinition.Read.All, DeviceManagementScripts.Read.All,
    ExternalConnection.Read.All, IdentityRiskEvent.Read.All, IdentityUserFlow.Read.All, InformationProtectionPolicy.Read.All,
    LifecycleWorkflows.Read.All, MultiTenantOrganization.Read.All, Place.Read.All, Printer.Read.All, Reports.Read.All,
    RoleManagement.Read.All, SecurityEvents.Read.All, ServiceHealth.Read.All, TeamworkTag.Read.All.
  - Not added, as the item says: CallRecords.Read.All, Bookings.Read.All, SubjectRightsRequest.Read.All, Power BI.
  - Note: the SharePoint Online role the Collector holds outside its manifest (678536fe…, Q55 E) is still not in the manifest.
    Q56 covered Graph only, so it was left as is.
- Needs: Q55 done.
- **Same rules as Q55:** test tenant, manifest only (GET the KEEL Collector application, MERGE, one PATCH), read permissions
  only, no appRoleAssignment, no consent. Resolve names from the Graph service principal's appRoles (type Role); skip and
  report any name that has no appRole.
- **Add to the Collector's Graph `requiredResourceAccess`** (from `engine/discovery/grants.mjs` and the Intune catalogue):
  `AuditLog.Read.All`, `ServiceHealth.Read.All`, `CustomAuthenticationExtension.Read.All`, `ExternalConnection.Read.All`,
  `IdentityRiskEvent.Read.All`, `InformationProtectionPolicy.Read.All`, `Place.Read.All`, `Printer.Read.All`,
  `Reports.Read.All`, `RoleManagement.Read.All`, `SecurityEvents.Read.All`, `TeamworkTag.Read.All`,
  `DeviceManagementScripts.Read.All`.
- Also add `GroupMember.Read.All` and `Sites.FullControl.All`, which the Collector already holds but its manifest lacks
  (Q55 E), so the manifest matches what is held. Do not remove anything.
- Not added on purpose: `CallRecords.Read.All`, `Bookings.Read.All`, `SubjectRightsRequest.Read.All` (they read people's
  data, not configuration) and any Power BI permission.
- **Report:** names added, names skipped and why, and the list still waiting for consent (manifest minus held).

### Q57: Confirm Marouane's admin consent for Q55/Q56 (read-only)
- Drafted by the "Add API permissions" thread (2026-10-15). Marouane reported consent done at 00:09 UTC.
- Status: done
- Result: Done 2026-10-15 00:12 UTC, read-only (the Restorer listed manifests and assignments via Graph GET; the Collector token was used for the two optional reads). Nothing created, granted or removed.
  - **KEEL Collector: missing none.** All 49 application roles in its manifest (Graph 45, SharePoint 2+, Exchange 1) are held;
    49 appRoleAssignments in all. The 19 that Q56 left waiting are now held.
  - **KEEL Content Reader: consented at about 00:12 UTC; re-checked, missing none** (holds 17 of 17, no extras). Before that: NOT consented. Missing all 17**, with 0 appRoleAssignments on its SP (9fa46563…): Mail.Read,
    Calendars.Read, Contacts.Read, MailboxSettings.Read, Tasks.Read.All, User.Read.All, Group.Read.All, Files.Read.All,
    Sites.Read.All, Team.ReadBasic.All, Channel.ReadBasic.All, ChannelSettings.Read.All, ChannelMember.Read.All,
    TeamsTab.Read.All, TeamsAppInstallation.ReadForTeam.All, MailboxFolder.Read.All, MailboxItem.Read.All.
    Marouane: open Entra > App registrations > **KEEL Content Reader** (not the Collector) > API permissions > Grant admin consent.
  - **Fabric "Service principals can access read-only admin APIs": not readable.** As the Collector,
    `GET api.fabric.microsoft.com/v1/admin/tenantsettings` returns 403, and the Power BI `admin/tenantsettings` returns 404.
    That fits the setting being off or not yet propagated (Fabric says up to 15 min); I can't tell which. Re-check later if wanted.
  - **Power Platform management app: not readable.** As the Collector, BAP `adminApplications` returns 403 ("does not have
    permission"). That suggests the Collector is not registered as a management app yet (`New-PowerAppManagementApp`
    needs a signed-in admin).
- Needs: Q56 done.
- **Read-only.** Nothing created, granted or removed.
- **Do:** for the KEEL Collector and the KEEL Content Reader, list the Graph app roles in `requiredResourceAccess` that the
  service principal does NOT hold as appRoleAssignments (expected: none for either). Also say whether the Fabric setting
  "Service principals can access read-only admin APIs" is visible as on for `KEEL-RT-collector-fabric-readers` and whether
  the Collector is a Power Platform management app, if you can read either; otherwise say "not readable".
- **Report:** missing roles per app (or "none"), and the two optional checks.

### Q58: First content backup run on the test tenant (one KEEL-RT- mailbox, OneDrive, site, team and plan)
- Drafted by the "First test content backup" thread (2026-10-15). Follows Q57 (Content Reader holds 17 of 17).
- Status: done
- Result: Run 2026-10-15 00:20–00:22 UTC, before the 01:00 nightly job. **Exit 1** (3 workloads partial). Content reads used the KEEL Content Reader
  through contentReadTransport (GET only). The fixture checks and the one fixture write used the Restorer. Global admin not used.
  - **Deployed:** /opt/keel-live at 1147ac47. It includes #257 (0a219ca0), #258 (de047131) and #262 (= 1147ac47).
  - **Files** (worker runs as **root**, so the owner is root):
    - /etc/keel/content.key: 64 hex characters, 600; not printed. Keep it in place.
    - /etc/keel/content-reader.json: 600, as documented.
    - /etc/keel/content-scope.json: 600, namePrefix KEEL-RT-, tenantHost lxtj.sharepoint.com; left in place for the nightly job.
    - /var/lib/keel/content: 700.
    - content-reader.key was already 600 and the crt is 644; nothing widened.
  - **Fixtures (step 4):**
    - alice's mailbox: present. The inbox is empty (0), and no mail was read anyway; see #263.
    - alice's OneDrive: present and empty, so I **created KEEL-RT-20261015-onedrive.txt** (Restorer; the only tenant write).
    - Sites: /sites/keel-rt-20260908-collaboration and /sites/KEEL-RT-20261004 found. The team-site library was not empty
      (General/KEEL-RT-20260908 Teams SharePoint), so no file was added.
    - Team KEEL-RT-20260908 Collaboration Hub: found.
    - **Planner: no plan to read.** The hub group has 0 plans, and the Restorer has no Tasks.* permission, so I could not create
      KEEL-RT-20261015-plan.
  - **Run output, verbatim** (site GUIDs masked):
    exchange-mail: partial (2 items, 892 bytes): keel-rt-20260908-alice@techinsiderbytes.com (user): 1 read(s) failed (400 BadRequest Parsing OData Select and Expand failed: Could not find a property named 'wellKnownName' on type 'microsoft.graph.mailFolder'.)
    onedrive: succeeded (2 items, 1771 bytes)
    sharepoint-sites: partial (865 items, 2710798 bytes): KEEL-RT-20261004: 1 part(s) not fully read, first permissions: denied (HTTP 403: /v1.0/sites/lxtj.sharepoint.com%2C<guid>%2C<guid>/permissions); KEEL-RT-20260908 Collaboration Hub-KEEL-RT-20260908 Partner Shared: 1 part(s) not fully read, first permissions: denied (HTTP 403: /v1.0/sites/lxtj.sharepoint.com%2C<guid>%2C<guid>/permissions); KEEL-RT-20260908 Collaboration Hub-KEEL-RT-20260908 Finance Private: 1 part(s) not fully read, first permissions: denied (HTTP 403: /v1.0/sites/lxtj.sharepoint.com%2C<guid>%2C<guid>/permissions); KEEL-RT-20260908 Collaboration Hub: 1 part(s) not fully read, first permissions: denied (HTTP 403: /v1.0/sites/lxtj.sharepoint.com%2C<guid>%2C<guid>/permissions)
    teams: partial (11 items, 257267 bytes): Mark 8 Project Team: 1 part(s) not read
    planner: succeeded (3 items, 9496 bytes)
  - **DB read-back** (`SELECT workload, count(*), sum(bytes) FROM content_item GROUP BY workload`):
    exchange-mail 2 / 892; onedrive 2 / 1771; sharepoint-sites 865 / 2710798; teams 11 / 257267; group-conversations 3 / 9496.
    - The planner line's 3 items are stored as `group-conversations`. That is by design (planner.mjs also backs up group
      conversations). Here they are the hub group's welcome conversation (conversation, thread, post).
  - **Containers found per workload:**
    - exchange-mail: alice's calendars and todo-lists, 1 each. **No mail folders.**
    - onedrive: alice's drive. KEEL-RT-20261015-onedrive.txt is there (drive-content and drive-record).
    - sharepoint-sites: 4 sites: KEEL-RT-20261004, the Collaboration Hub, and its Finance Private and Partner Shared channel sites.
    - teams: 11 teams, metadata only (messages "waiting-on-microsoft"). Two are KEEL-RT: the Collaboration Hub and
      KEEL Qualification Test (keelqual0924). The other 9 are non-fixture teams (no name filter, as expected).
    - group-conversations: the hub group.
  - **content_sync_state keys:**
    - exchange-mail: 2 (group/…, mailbox/…).
    - onedrive: 1 (the drive).
    - sharepoint-sites: 28 (14 covered:…, 14 library:…).
    - teams and planner: none.
  - **Failures:**
    - **#263**: exchange-mail reads mailFolders/delta with `$select=...wellKnownName`, which is beta only, so v1.0 returns 400.
      No mail is backed up (engine/content/exchangeMail.mjs:191).
    - **#264**: sharepoint-sites reads `GET /sites/{id}/permissions`, which needs Sites.FullControl.All for app-only. It is 403 for
      the read-only Content Reader on all 4 sites. Decision needed; options are in the issue.
    - teams: "Mark 8 Project Team: 1 part(s) not read". That is a non-fixture team with 0 channels; no further detail in the run.
- Needs: Q57 done.
- **Read-only against the tenant**, except an optional fixture plan in step 4. Every content request goes through the
  GET-only `contentReadTransport` as the KEEL Content Reader. No permission or consent changes.
- **Do:**
  1. Record the commit `/opt/keel-live` is deployed at, and confirm it includes #257, #258 and #262 (content-collect
     wiring and the content-backup prerequisites). If not, stop and report `blocked`.
  2. Write `/etc/keel/content.key`: 32 random bytes as 64 hex characters (`openssl rand -hex 32`), mode 600, owned by the
     user the keel worker runs as. Never print it. Losing it loses the backed-up content, so keep it in place.
  3. Write `/etc/keel/content-reader.json` (mode 600, same owner), as `cli/keel-content-collect.mjs` documents:
     `{ "tenantId": <tenant.json tenantId>, "clientId": <KEEL Content Reader appId>, "certPath": "/etc/keel/content-reader.crt",
     "keyPath": "/etc/keel/content-reader.key", "contentKeyFile": "/etc/keel/content.key",
     "storage": { "kind": "local", "root": "/var/lib/keel/content" } }`. Create `/var/lib/keel/content` (mode 700, same owner).
     If the cert and key files are root-only, make them readable by that owner too (mode 600, no wider).
     Write `/etc/keel/content-scope.json`: `{ "namePrefix": "KEEL-RT-", "tenantHost": "lxtj.sharepoint.com" }`, and leave it
     in place so the nightly 01:00 UTC content-collect job stays scoped to KEEL-RT- fixtures.
  4. Fixtures (expected, from earlier items): mailbox and OneDrive of `keel-rt-20260908-alice`; sites
     `/sites/keel-rt-20260908-collaboration` and `/sites/KEEL-RT-20261004`; team `KEEL-RT-20260908 Collaboration Hub`.
     Check whether that team's group has a Planner plan. If none, and the Restorer can do it, create plan
     `KEEL-RT-20261015-plan` with one task `KEEL-RT-20261015-task` in that group; otherwise report that Planner had no plan to read.
     Put one KEEL-RT- file in alice's OneDrive and one in the team site library only if each is empty.
  5. Run once, as the worker's user, with the DB env loaded:
     `node /opt/keel-live/cli/keel-content-collect.mjs run` (defaults: `/etc/keel/tenant.json`, the reader and scope files above).
     Don't run it while the scheduled content-collect job is running; if that job fires first and runs with these files,
     use its run as the result instead.
     Note: Teams has no name filter, so `teams` reads every team on the test tenant (read-only).
  6. Read back from the DB: `SELECT workload, count(*), sum(bytes) FROM content_item GROUP BY workload`, plus `content_sync_state`
     keys per workload. Confirm the KEEL-RT- fixtures from step 4 appear (container or metadata names) for each workload.
- **Report:** the deployed commit; the exit code; each workload's line (`exchange-mail`, `onedrive`, `sharepoint-sites`,
  `teams`, `planner`: outcome, items, bytes, reasons) verbatim from the run; the DB read-back per workload; which step-4
  fixtures were found or created; anything that failed, with the error text (no tokens or keys).

### Q59: Add Tasks.ReadWrite.All to the Restorer's manifest, so Marouane can consent (Planner fixture)
- Drafted by the "Planner test plan" thread (2026-10-15). Q58 could not create a KEEL-RT- plan: the Restorer holds no
  Tasks.* permission, and app-only plan creation needs Graph application `Tasks.ReadWrite.All`.
- Status: done
- Result: Done 2026-10-15 00:33 UTC. A Restorer manifest change only: one merged PATCH (204). No appRoleAssignment, no consent; nothing removed
  (read back: 0 entries lost). Global admin not used.
  - **Tasks.ReadWrite.All: added** to the Microsoft Graph entry of the Keel Restorer's requiredResourceAccess (appId 12f8942f…).
  - Held-but-missing entries: none. The Restorer holds 54 Graph application roles, and all 54 were already in the manifest.
  - The Graph manifest now has 55. **Manifest minus held: only Tasks.ReadWrite.All**, so Marouane's consent click adds just that one.
- Needs: none. Decision: D-93a ("add any the tool needs to move along"), as for D-Q55. Consent stays with Marouane.
- **Manifest only.** As the Restorer, GET the Keel Restorer application (appId 12f8942f…), MERGE, PATCH once: add Graph
  application permission `Tasks.ReadWrite.All` (resolve its id from the Microsoft Graph SP's `appRoles`, type Role) to the
  Microsoft Graph entry of `requiredResourceAccess`. Keep every existing resource and entry; add nothing else.
  Never create an appRoleAssignment or grant consent.
- Also make sure every Graph application permission the Restorer already holds is in its manifest, so Marouane's consent
  click adds only `Tasks.ReadWrite.All` and changes nothing else. Add held-but-missing ones; do not remove anything.
- **Report:** whether Tasks.ReadWrite.All was added, any held-but-missing entries added, and the manifest-minus-held list
  (expected: only Tasks.ReadWrite.All).

### Q60: Create the KEEL-RT- Planner plan fixture and check the Content Reader can read it
- Drafted by the "Planner test plan" thread (2026-10-15).
- Status: done
- Result: Done 2026-10-15 06:34 UTC. Marouane consented for the Keel Restorer (reported 06:33). Its token now carries Tasks.ReadWrite.All.
  Writes as the Restorer, Planner in the KEEL-RT-20260908 Collaboration Hub group only. No permission or consent changes;
  content-collect not run. Global admin not used.
  - Group 9263e1d4… (display name re-read before writing). It had 0 plans, so a new one was created.
  - **Plan** KEEL-RT-20261015-plan: DnEZlIcI…. **Bucket** KEEL-RT-20261015-bucket: S6g-ggqq….
    **Task** KEEL-RT-20261015-task: rcON870J…, in that bucket. Task details PATCH (If-Match etag): 204, description "KEEL-RT planner fixture".
  - **Content Reader check** (GET only, first try):
    - `GET /groups/<group>/planner/plans`: 200, 1 plan (KEEL-RT-20261015-plan).
    - `GET /planner/plans/<plan>/tasks`: 200, 1 task (KEEL-RT-20261015-task).
    - `GET /planner/tasks/<task>/details`: 200, description matches.
  - The next scheduled content-collect run picks it up. The 01:00 UTC run was before this.
- Needs: Q59 done, and Marouane's admin consent for the Restorer. First check that the Restorer's SP holds
  `Tasks.ReadWrite.All` as an appRoleAssignment. If not, set `blocked: waiting on consent` and stop (the thread re-sends).
- **One tenant write area: Planner in the `KEEL-RT-20260908 Collaboration Hub` group.** No permission or consent changes.
- **Do (as the Restorer):**
  1. Find the group id of team `KEEL-RT-20260908 Collaboration Hub`. If it already has a plan named `KEEL-RT-…`, reuse it.
  2. Otherwise `POST /v1.0/planner/plans` with `{ "container": { "url": "https://graph.microsoft.com/v1.0/groups/<groupId>" },
     "title": "KEEL-RT-20261015-plan" }`.
  3. In it, create bucket `KEEL-RT-20261015-bucket` and one task `KEEL-RT-20261015-task` in that bucket, then PATCH the task
     details with description `KEEL-RT planner fixture` (use the `@odata.etag` in `If-Match`).
- **Check (as the KEEL Content Reader, GET only):** `GET /v1.0/groups/<groupId>/planner/plans` lists the plan, and
  `GET /v1.0/planner/plans/<planId>/tasks` lists the task. Allow a minute for Planner to propagate; retry a few times.
- Do not run content-collect; the nightly 01:00 UTC job picks the plan up.
- **Report:** group id, plan id, bucket id and task id (first 8 characters), and the two GET results (status and counts).

### Q61: Confirm the Collector can call the Power Platform and Fabric read-only admin APIs (read-only)
- Drafted by the "Power Platform + Fabric check" thread (2026-10-15). Marouane reported at 06:47 UTC that he ran
  `New-PowerAppManagementApp` for the KEEL Collector (appId 87aa77c4…; it returned that appId) and turned on the Fabric
  setting "Service principals can access read-only admin APIs" for `KEEL-RT-collector-fabric-readers`. Follows Q57's two
  optional checks, which were both 403 before this.
- Status: done
- Result: Done 2026-10-15 06:49 UTC, read-only. Each admin API call used the Collector's own token (client credentials); the
  group reads used the Restorer. Nothing created, granted, changed or removed. No retries were needed.
  - **Group KEEL-RT-collector-fabric-readers (2e66e1b2…):** the only member is the KEEL Collector SP
    (`members/microsoft.graph.servicePrincipal` returns 1, KEEL Collector).
    - The user, group, device and orgContact casts all return 0.
    - Note: the plain `members` and `transitiveMembers` lists come back empty for the Restorer, which is why the typed SP cast was used.
  - **Power Platform**, BAP `scopes/admin/environments?api-version=2020-10-01`: **200, 2 environments**, with both token audiences
    (service.powerapps.com and api.bap.microsoft.com).
  - **Power BI** `v1.0/myorg/admin/groups?$top=1`: **200, 1 workspace** (the $top=1 page).
  - **Fabric** `v1/admin/workspaces`: **200, 1 workspace.**
  - The Power BI Service permissions check was not needed; Q55 E already showed the Collector holds none.
  - **Verdict, Power Platform management app works: yes.** The Collector lists environments through the BAP admin API.
  - **Verdict, Fabric read-only admin APIs work: yes.** Both the Power BI admin and the Fabric admin endpoints return 200 for the Collector.
- Needs: none.
- **Read-only.** Nothing created, granted, changed or removed. Use the Collector's own token (client credentials) for every
  call below, except the group-membership read, which may use the Restorer.
- **Do:**
  1. **Group:** confirm the Collector SP is still the only member of `KEEL-RT-collector-fabric-readers` (2e66e1b2…).
  2. **Power Platform** (token audience `https://service.powerapps.com/`, falling back to `https://api.bap.microsoft.com/`):
     `GET https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments?api-version=2020-10-01`.
     Report status and environment count. If 403, also retry once after 5 minutes (registration can lag).
  3. **Fabric / Power BI** (token audience `https://analysis.windows.net/powerbi/api`):
     - `GET https://api.powerbi.com/v1.0/myorg/admin/groups?$top=1`
     - `GET https://api.fabric.microsoft.com/v1/admin/workspaces` (audience `https://api.fabric.microsoft.com`)
     Report status and item count for each. If 401/403, retry once after 15 minutes (Fabric says settings take up to 15 min).
     If still refused, check whether the Collector's manifest holds any **Power BI Service** application permissions that
     need admin consent (Microsoft refuses read-only admin API calls from an SP that has them) and list them.
- **Report:** group membership; per call the status code and count (or the error code and message, with no tokens);
  a one-line verdict each for "Power Platform management app works" and "Fabric read-only admin APIs work".

### Q62: Second content backup run: all five workloads after #265/#266/#267, and repeat reads are delta-only
- Drafted by the "Second test content backup" thread (2026-10-15). Follows Q58 (first run, 3 partial) and Q60 (Planner
  fixture KEEL-RT-20261015-plan now exists). Fixes since Q58: #265 (e5a773f, site permissions declared not read),
  #266 (b70b9dc, Teams partial reason names the failed part), #267 (80a040a, mail folder delta without wellKnownName).
- Status: done
- Result: Runs A (07:01) and B (07:04) on 2026-10-15. **Exit 1 both times**, only because exchange-mail is still partial (new bug #268).
  The other 4 workloads succeeded. Content reads used the Content Reader through contentReadTransport (GET only), with Q58's
  reader and scope files. Nothing was written to the tenant. Global admin not used.
  - **Deployed:** /opt/keel-live at d58a2fb4 (the merge of #267; it carries #265 and #266).
  - **The 01:00 UTC nightly: it did not run.** There is no `content-collect` schedule. The schedule table holds only api-drift,
    collect tier1/2/3, prune and workload-collect, and the job table has no `content-collect` job ever. The scheduler's 01:00 tick
    started 1 job, the hourly configuration `collect` (succeeded 01:00:02–01:01:48). The "nightly content job" needs a
    schedule row before it exists (`cadence.mjs` defines content-collect as every 4 h, but nothing is scheduled).
    - Baseline before A: exchange-mail 2 / 892, group-conversations 3 / 9496, onedrive 2 / 1771, sharepoint-sites 865 / 2710798,
      teams 11 / 257267. Sync keys: exchange-mail 2, onedrive 1, sharepoint-sites 28.
  - **Mail fixture (step 3): not created.** alice's Inbox is still empty (0), but the Restorer has no Mail.ReadWrite or Mail.Send
    (only MailboxSettings.ReadWrite), so it cannot put a message there.
  - **Run A**, exit 1:
      exchange-mail: partial (0 items, 0 bytes): keel-rt-20260908-alice@techinsiderbytes.com (user): 1 read(s) failed (400 BadRequest Parsing OData Select and Expand failed: Could not find a property named 'wellKnownName' on type 'microsoft.graph.mailFolder'.)
      onedrive: succeeded (0 items, 0 bytes)
      sharepoint-sites: succeeded (855 items, 2690849 bytes)
      teams: succeeded (11 items, 272325 bytes)
      planner: succeeded (8 items, 11975 bytes)
    - Read-back: exchange-mail 2 / 892, group-conversations 3 / 9496, onedrive 2 / 1771, **planner 5 / 2479**,
      sharepoint-sites 889 / 2735364, teams 22 / 529592. Sync keys: exchange-mail 2, onedrive 1, sharepoint-sites 28.
    - Mark 8 Project Team is no longer partial (teams succeeded).
  - **Fixture check after A:**
    - exchange-mail: **no mail folders.** Only alice's calendars and todo-lists, from Q58.
    - onedrive: KEEL-RT-20261015-onedrive.txt (drive-content and drive-record) found.
    - sharepoint-sites: the 4 KEEL-RT sites found (4 site containers).
    - teams: KEEL-RT-20260908 Collaboration Hub found.
    - planner: all found in container group:9263e1d4…: plan KEEL-RT-20261015-plan, planDetails, bucket KEEL-RT-20261015-bucket,
      task KEEL-RT-20261015-task, taskDetails. That is 5 rows; the line's 8 items include the 3 group-conversations items, deduplicated.
  - **Run B** (right after A, no tenant change), exit 1:
      exchange-mail: partial (0 items, 0 bytes): keel-rt-20260908-alice@techinsiderbytes.com (user): 1 read(s) failed (400 BadRequest Parsing OData Select and Expand failed: Could not find a property named 'wellKnownName' on type 'microsoft.graph.mailFolder'.)
      onedrive: succeeded (0 items, 0 bytes)
      sharepoint-sites: succeeded (853 items, 2685218 bytes)
      teams: succeeded (11 items, 272325 bytes)
      planner: succeeded (8 items, 11975 bytes)
    - Read-back: exchange-mail 2 / 892, group-conversations 3 / 9496, onedrive 2 / 1771, planner 5 / 2479,
      sharepoint-sites 889 / 2735364, **teams 33 / 801917**. Sync keys: unchanged.
  - **New content_item rows, A to B:**
    - exchange-mail: 0 (stuck, see below).
    - onedrive: 0 rows / 0 bytes. Delta token reused (1 key); it read 0 items.
    - sharepoint-sites: 0 new rows. 28 sync keys exist, but it reports 853 items read on B, about the same as A's 855. So it
      re-walks the sites and libraries each run and deduplicates on store; it is not delta-only.
    - planner and group-conversations: 0 new rows. No sync keys (no Planner delta in v1.0), so they are re-read and deduplicated.
    - **teams: +11 rows / +272,325 bytes (new_bytes 272,677).** Every team gets a new version and sha256 each run with no change,
      and there are no sync keys. **#269.**
    - **Re-read everything on B:** teams (and stores everything again), sharepoint-sites, planner and group-conversations
      (re-read, nothing stored). Delta-only: onedrive.
  - **Errors:**
    - **#268**: the Q58 failure saved the old `mailFolders/delta?$select=...wellKnownName...` URL as the resume cursor in
      content_sync_state (exchange-mail, mailbox/<alice>). walkDelta reuses it, so the #267 fix never takes effect.
      No CLI reset exists, and I did not edit the DB by hand. Commented on #267.
    - **#269**: the Teams snapshot is not deterministic (as above).
- Needs: Q58 done, Q60 done.
- **Read-only against the tenant**, except the optional fixture mail in step 3. Content reads go through the GET-only
  `contentReadTransport` as the KEEL Content Reader, with the reader and scope files Q58 left in place. No permission or consent changes.
- **Do:**
  1. Record the commit `/opt/keel-live` is deployed at and confirm it includes d58a2fb (merge of #267), which also carries #265
     and #266. If not, stop and report `blocked`.
  2. **The 01:00 UTC nightly:** find the `content-collect` job that ran 2026-10-15 ~01:00 UTC (job table and worker journal).
     Report its status, start/finish time, which commit was deployed when it started, and each workload's line if logged.
     Then snapshot, as baseline: `SELECT workload, count(*), sum(bytes) FROM content_item GROUP BY workload` and
     `content_sync_state` key count per workload.
  3. **Mail fixture:** if alice's (`keel-rt-20260908-alice`) Inbox is still empty and the Restorer can do it, create one message
     in her Inbox with subject `KEEL-RT-20261015-mail` and a one-line body (Restorer; the only tenant write). Otherwise say why not.
  4. **Run A:** `node /opt/keel-live/cli/keel-content-collect.mjs run` once, as Q58 step 5 (worker's user, DB env loaded;
     not while the scheduled job runs). Report the exit code and each workload line verbatim (`exchange-mail`, `onedrive`,
     `sharepoint-sites`, `teams`, `planner`), including the full Teams reason for "Mark 8 Project Team" if it is still partial.
     Read back the same two queries as step 2.
  5. **Fixture check after run A:** confirm each appears in content_item (container or metadata name):
     - exchange-mail: alice's mail folders and the KEEL-RT-20261015-mail message (or whatever messages her mailbox holds);
     - onedrive: KEEL-RT-20261015-onedrive.txt;
     - sharepoint-sites: the 4 KEEL-RT sites;
     - teams: KEEL-RT-20260908 Collaboration Hub;
     - planner: workload `planner`, container `group:9263e1d4…`: plan KEEL-RT-20261015-plan, its details, bucket
       KEEL-RT-20261015-bucket, task KEEL-RT-20261015-task and its details.
  6. **Run B:** run the same command again right after run A, with no tenant change in between. Report the exit code and each
     workload line verbatim, then the same two queries. Per workload, report the new content_item rows and bytes between A and B
     (expected about 0) and whether `content_sync_state` keys exist (delta tokens reused). Say which workloads, if any,
     re-read everything on run B.
- **Report:** the deployed commit; the nightly's outcome (step 2); for runs A and B the exit code, each workload's line verbatim,
  and the DB read-back; the step 3 fixture write; the step 5 fixture check; the A-to-B difference per workload; any error text
  (no tokens or keys).

### Q63: Let the Restorer write mail only in keel-rt- test mailboxes, place one test message in alice's Inbox, rerun the backup
- Drafted by the "Scoped mail write for test email" thread (2026-10-15). Q62 step 3 could not create the mail fixture: the
  Restorer has no mail write permission. #268 (stale mail delta cursor) is fixed by PR #270 (merge 7b2f2d2).
- Status: done
- Result: Done 2026-10-15 07:47–07:52 UTC. Credentials: the Restorer (EXO PowerShell app-only, plus Graph); the Content Reader for the backup.
  Global admin not used. No Entra Mail.* permission, manifest change or appRoleAssignment.
  - **Step 1:** the Restorer SP holds 55 Graph roles. Mail-related: only MailboxSettings.ReadWrite; no Mail.Read*, Mail.ReadWrite or Mail.Send.
  - **Step 2:** `Get-Mailbox` has no `-RecipientPreviewFilter` in EXO V3, so the preview used `Get-Recipient -RecipientPreviewFilter`.
    - Preview, 2 recipients, both keel-rt-: keel-rt-20260908-alice and keel-rt-20260908-collaboration (the hub group's mailbox).
    - Created (none existed): EXO service principal "Keel Restorer"; management scope **KEEL-RT-test-mailboxes**
      (RecipientRestrictionFilter `PrimarySmtpAddress -like 'keel-rt-*'`); role assignment **KEEL-RT-restorer-mail-rw**
      (Application Mail.ReadWrite, CustomResourceScope KEEL-RT-test-mailboxes, enabled).
  - **Step 3:** Test-ServicePrincipalAuthorization: alice, Application Mail.ReadWrite **InScope=True**. The non-test mailbox
    AdeleV (a Microsoft demo user; not break-glass, the admin or Marouane), **InScope=False**.
  - **Step 4:** POST to alice's Inbox: **201 on the first try at 07:48:00 UTC** (no propagation wait). Message AAMkAGEw…,
    subject KEEL-RT-20261015-mail, isDraft false. 1 message with that subject.
  - **Step 5:** `GET /users/AdeleV…/mailFolders/inbox/messages?$top=1` as the Restorer: **403 ErrorAccessDenied**. The assignment is kept.
  - **Step 6:** /opt/keel-live at 811d7e65, which includes 7b2f2d2 (#270). The run's **exit code was 0**:
      exchange-mail: succeeded (9 items, 3327 bytes)
      onedrive: succeeded (0 items, 0 bytes)
      sharepoint-sites: succeeded (853 items, 2685218 bytes)
      teams: succeeded (11 items, 271885 bytes)
      planner: succeeded (8 items, 11975 bytes)
    - exchange-mail: 11 rows / 4219 bytes, up from 2 / 892: 8 mailFolder rows and 1 message, plus calendars and todo-lists.
      The message row's item_key equals the Graph id of KEEL-RT-20261015-mail (kind message, isDraft false, message/rfc822).
      So #268 is fixed by #270, and the stale cursor was replaced.
    - teams again stored +11 rows (33 → 44) with no change: #269 still open.
- Needs: none. Decision: D-Q63 (filled).
- **Rules:** test tenant. The only permission change is the Exchange RBAC for Applications setup below, for the Keel Restorer
  (appId 12f8942f-c4d0-4a0d-aee1-efe928b1de54, SP object id 8cd199c9-a96e-4666-924f-aa0ca6910f32). **Do not** add Graph
  `Mail.ReadWrite`, `Mail.Send` or any `Mail.*` permission to any app manifest and create no Entra appRoleAssignment: a
  tenant-wide Entra grant would bypass the scope. The only mail write is one message in alice's Inbox. Never touch
  break-glass, the operator's admin account or Marouane's mailbox. Global admin not used.
- **Do:**
  1. **Entra check (read-only):** list the Restorer SP's Graph appRoleAssignments. If it holds any `Mail.Read*`,
     `Mail.ReadWrite` or `Mail.Send` role, stop and report `blocked` (the scope would be bypassed).
  2. **Exchange setup**, in Exchange Online PowerShell as the Restorer (app-only, Exchange.ManageAsApp + Exchange
     Administrator, as for Q55's role group). Reuse an object if it already exists with these exact values:
     ```powershell
     $appId = '12f8942f-c4d0-4a0d-aee1-efe928b1de54'; $spId = '8cd199c9-a96e-4666-924f-aa0ca6910f32'
     $filter = "PrimarySmtpAddress -like 'keel-rt-*'"
     Get-Mailbox -RecipientPreviewFilter $filter -ResultSize 50 | Select Name,PrimarySmtpAddress   # only keel-rt-* mailboxes, alice included
     if (-not (Get-ServicePrincipal -Identity $spId -ErrorAction SilentlyContinue)) {
       New-ServicePrincipal -AppId $appId -ObjectId $spId -DisplayName 'Keel Restorer' }
     New-ManagementScope -Name 'KEEL-RT-test-mailboxes' -RecipientRestrictionFilter $filter
     New-ManagementRoleAssignment -Name 'KEEL-RT-restorer-mail-rw' -App $spId -Role 'Application Mail.ReadWrite' -CustomResourceScope 'KEEL-RT-test-mailboxes'
     ```
     If the preview lists any mailbox not starting with `keel-rt-`, stop before creating anything and report `blocked`.
     If a cmdlet is refused for the app, stop and report `blocked` with the error text.
  3. **Authorization check (read-only):**
     `Test-ServicePrincipalAuthorization -Identity $spId -Resource keel-rt-20260908-alice@techinsiderbytes.com` must show
     `Application Mail.ReadWrite` with `InScope = True`. Then run it against one non-test user mailbox (not break-glass,
     not the operator's admin, not Marouane's): `InScope = False`.
  4. **Write the test message** (as the Restorer, Graph v1.0). RBAC for Applications can take 30 min to 2 h to take
     effect; on 403 retry every 10 minutes for up to 2 h:
     `POST /users/keel-rt-20260908-alice@techinsiderbytes.com/mailFolders/inbox/messages` with
     `{"subject":"KEEL-RT-20261015-mail","body":{"contentType":"text","content":"KEEL-RT mail fixture"},
     "singleValueExtendedProperties":[{"id":"Integer 0x0E07","value":"1"}]}` (the extended property makes it a normal
     message, not a draft). Create it once; if a message with that subject is already in her Inbox, reuse it.
  5. **Blocked check** (as the Restorer, after step 4 succeeds, so propagation is done): on the same non-test mailbox as
     step 3, `GET /users/<that mailbox>/mailFolders/inbox/messages?$top=1&$select=id`. Expected 403. Do not attempt a
     write there. Record only the status and error code, never content. If it returns 200, remove the role assignment
     (`Remove-ManagementRoleAssignment KEEL-RT-restorer-mail-rw`) and report `failed`.
  6. **Mail backup rerun:** confirm `/opt/keel-live` is at or after 7b2f2d2 (merge of #270); if not, wait for the deploy.
     Then `node /opt/keel-live/cli/keel-content-collect.mjs run` once, as Q62 step 4. Report the exit code and every
     workload line verbatim, and check content_item for the KEEL-RT-20261015-mail message (exchange-mail, alice's mailbox).
     Expected: exchange-mail succeeded, no 400, messages > 0.
- **Report:** step 1 assignments found; the step 2 preview list and objects created (or reused); both
  Test-ServicePrincipalAuthorization results; the write's status, when it first succeeded and the message id (first 8
  chars); the blocked check's status and error code; the deployed commit, exit code, workload lines and fixture row check.
  No tokens or keys.

### Q64: Forced content backup, twice back to back, on a build with #270, #271 and #273
- Drafted by the "Forced backup with all fixes" thread (2026-10-15). Marouane asked to force a backup now.
  Fixes to prove live: #270 (mail cursor, 7b2f2d2), #271 (Teams snapshot deterministic, 811d7e6),
  #273 (SharePoint list items via delta, 55d8b63).
- Status: done
- Result: Done 2026-10-15 08:30–08:33 UTC, read-only (Content Reader, GET-only contentReadTransport). **Run A exit 0, run B exit 0.**
  No tenant, permission or fixture changes. Global admin not used.
  - **Deployed:** /opt/keel-live at **55d8b631** (the merge of #273; it includes 7b2f2d2 #270 and 811d7e6 #271).
    It arrived at 08:29, about 7 minutes after its Portal CI passed (08:21).
  - **Baseline:** exchange-mail 11 / 4219, group-conversations 3 / 9496, onedrive 2 / 1771, planner 5 / 2479,
    sharepoint-sites 889 / 2735364, teams 44 / 1073802. Sync keys: exchange-mail 2, onedrive 1, sharepoint-sites 28.
  - **Run A** (08:30:26), exit 0:
      exchange-mail: succeeded (0 items, 0 bytes)
      onedrive: succeeded (0 items, 0 bytes)
      sharepoint-sites: succeeded (853 items, 2407687 bytes)
      teams: succeeded (11 items, 271885 bytes)
      planner: succeeded (8 items, 11975 bytes)
    - Read-back: sharepoint-sites **1561 / 3726144**; every other workload unchanged from baseline.
      Sync keys: sharepoint-sites **87** (items: 55, library: 14, covered: 14, site: 4); exchange-mail 2, onedrive 1.
  - **Run B** (08:31:52), exit 0:
      exchange-mail: succeeded (0 items, 0 bytes)
      onedrive: succeeded (0 items, 0 bytes)
      sharepoint-sites: succeeded (0 items, 0 bytes)
      teams: succeeded (11 items, 271885 bytes)
      planner: succeeded (8 items, 11975 bytes)
    - Read-back: identical to after A (sharepoint-sites 1561 / 3726144, teams 44 / 1073802). Sync keys unchanged (87 / 2 / 1).
  - **New content_item rows and bytes:**

    | workload | A vs baseline | B vs A |
    |---|---|---|
    | exchange-mail | 0 / 0 | 0 / 0 |
    | onedrive | 0 / 0 | 0 / 0 |
    | sharepoint-sites | **+672 / +990,780** (the first #273 full pass: list items stored per list, with 55 items: and 4 site: state keys created) | **0 / 0** |
    | teams | 0 / 0 (44, flat) | 0 / 0 (44, flat) |
    | planner | 0 / 0 | 0 / 0 |
    | group-conversations | 0 / 0 | 0 / 0 |

  - **Expected on B, both met:**
    - sharepoint-sites read **0 items** (was 853 on every run before #273). It is now delta-only.
    - teams count is flat at 44, with no new versions on A or B, so the #271 snapshot is deterministic. #269 can close.
    - teams and planner still report 11 and 8 items *read* per run (no delta API), but every read dedups to 0 new rows.
  - **Mail fixture:** the KEEL-RT-20261015-mail message row for alice is still present (1 row, same item_key as its Graph id).
  - **Errors:** none.
- Needs: none.
- **Read-only against the tenant.** Content reads go through the GET-only `contentReadTransport` as the KEEL Content Reader,
  with Q58's reader and scope files. No permission, consent or fixture changes. Global admin not used.
- **Do:**
  1. Record the commit `/opt/keel-live` is deployed at and confirm it includes 55d8b63 (merge of #273), which also carries
     #270 and #271. If not, wait for the deploy (it is CI-gated); if it has not arrived within 30 minutes, report `blocked`
     with the master CI state for 55d8b63.
  2. Baseline: `SELECT workload, count(*), sum(bytes) FROM content_item GROUP BY workload` and the `content_sync_state`
     key count per workload.
  3. **Run A:** `node /opt/keel-live/cli/keel-content-collect.mjs run` once, as Q62 step 4 (worker's user, DB env loaded;
     not while a scheduled job runs). Report the exit code and every workload line verbatim. Read back the step 2 queries.
     Run A is the first run with #273, so SharePoint does one full pass per list and creates `items:` and `site:` state keys.
  4. **Run B:** the same command again right after run A, with no tenant change. Exit code, every workload line verbatim,
     the step 2 queries.
  5. Per workload (exchange-mail, onedrive, sharepoint-sites, teams, planner, plus group-conversations), report the new
     content_item rows and bytes for A (vs baseline) and B (vs A). Expected on B: about 0 new rows everywhere; teams row
     count unchanged from after A (it was 44 after Q63, so no growth); sharepoint-sites items read near 0 (not ~853).
     Also check the KEEL-RT-20261015-mail message row is still present for alice.
- **Report:** the deployed commit; for A and B the exit code, each workload line verbatim and the read-back; the per-workload
  A and B differences; any error text (no tokens or keys).

### Q65: Move the nightly offsite copy to the storage target registry, on the Mulinux volume
- Drafted by the "Immutable Azure storage target" thread (2026-10-15). Marouane: the offsite copy must be plain files
  stored locally on Mulinux first. Code: #281 (merge 5ccdb7a), `engine/storage/targets.mjs`.
- Needs: /opt/keel-live at 5ccdb7a or later (`test -f /opt/keel-live/engine/storage/targets.mjs`).
- Status: done
- Result: Done 2026-10-15 09:36 UTC. Host only, as root; no tenant access, no secrets.
  - **Build:** /opt/keel-live at 5eba6fb0, which includes 5ccdb7a (#281). It arrived about 09:30; at 09:06 the live build was still ce3e00b.
  - **1. Mount:** `/mnt/keel-copy` is /dev/sdb (ext4), its own device; / and /opt/backups are on /dev/sda1.
    - Last runs, old path: 2026-10-14 05:00 and 2026-10-15 05:00 both shipped and sha256-verified, to /mnt/keel-copy/keel-offsite/.
      The 10-15 copy was 783dec59…. The last 5 files there are keel-db-2026-10-11 … 10-15.sql.gz (113 MB → 219 MB). Left as is.
  - **2.** `/etc/keel/offsite.env` did not exist, so there was nothing to back up. I created it (root, 600) with exactly the five
    KEEL_STORAGE_TARGET* lines. The unit already reads it (`EnvironmentFile=-/etc/keel/offsite.env`).
  - **3. Dry run:** the first try returned `offsite refused: dump manifest is not newer than last shipped manifest`, exit 1, because
    the old path shipped today's dump at 05:00. As the item directs, I backed up the shipped manifest to
    `/opt/backups/keel-db-shipped-manifest.json.bak-q65` and removed it. The rerun gave `DRY RUN: mulinux usable` and
    `would ship keel-db/keel-db-2026-10-15.sql.gz`, exit 0.
  - **4. Real run** (`systemctl start keel-offsite.service`, 09:36:34–09:36:48):
    `keel-db/keel-db-2026-10-15.sql.gz sha256 783dec5957a93eb4645d97498b31c6d32b840005cc5c60d897a9da6eeea24b64: complete`,
    `mulinux (local-disk): verified, published`, `keel-offsite: done via storage targets (mulinux)`.
  - **5.** `/mnt/keel-copy/keel-store/keel-db/keel-db-2026-10-15.sql.gz` is 219414823 bytes (root, 600). Its sha256 is
    783dec5957a93eb4645d97498b31c6d32b840005cc5c60d897a9da6eeea24b64, which **equals** the `checksum` in /opt/backups/keel-db-manifest.json.
  - **6.** keel-offsite.timer is enabled. Next run: Fri 2026-10-16 05:00:00 UTC.
  - The run wrote a new `/opt/backups/keel-db-shipped-manifest.json` (09:36). The 05:00 original is kept as `.bak-q65`.
  - Rollback: delete /etc/keel/offsite.env (it did not exist before) and restore the .bak-q65 manifest.
- Do, as root (host only, no tenant, no secrets printed):
  1. `findmnt /mnt/keel-copy` (must be its own device, not the root fs). Stop and report if not.
     Also report the last 3 runs: `journalctl -u keel-offsite.service -n 40 --no-pager | tail -20`, and `ls -l /mnt/keel-copy/keel-offsite/ | tail -5`.
  2. Back up `/etc/keel/offsite.env` if it exists (`cp -p ... offsite.env.bak-q65`), then make sure it holds exactly
     these extra lines (create it mode 600 root if absent; keep any existing lines):
     ```
     KEEL_STORAGE_TARGETS=mulinux
     KEEL_STORAGE_TARGET_MULINUX_KIND=local-disk
     KEEL_STORAGE_TARGET_MULINUX_DIR=/mnt/keel-copy/keel-store
     KEEL_STORAGE_TARGET_MULINUX_SEPARATE_FROM=/opt/backups
     KEEL_STORAGE_TARGET_MULINUX_KEEP_DAYS=30
     ```
  3. `set -a; . /etc/keel/offsite.env; set +a; /opt/keel-live/ops/keel-offsite.sh --dry-run; echo exit=$?`
     Expect `DRY RUN: mulinux usable` and exit 0. If it says `not newer` (today's dump already shipped by the old path):
     `cp -p /opt/backups/keel-db-shipped-manifest.json /opt/backups/keel-db-shipped-manifest.json.bak-q65 && rm /opt/backups/keel-db-shipped-manifest.json`, then rerun the dry run.
  4. `systemctl start keel-offsite.service; journalctl -u keel-offsite.service -n 20 --no-pager`. Expect
     `...: complete`, `mulinux (local-disk): verified, published` and `done via storage targets (mulinux)`.
  5. `ls -l /mnt/keel-copy/keel-store/keel-db/` and `sha256sum` of the new file; it must equal `checksum` in
     `/opt/backups/keel-db-manifest.json`. Report both.
  6. `systemctl list-timers keel-offsite.timer --no-pager` (must be enabled; next run 05:00 UTC).
- Rollback: restore `offsite.env.bak-q65` (or delete the five lines); the old path then runs unchanged.
- Leave `/mnt/keel-copy/keel-offsite/` (old copies) as is.

### Q66: Live compare of the latest snapshot against the tenant now (read-only)
- Drafted by the "Wave 2 live checks" thread (2026-10-15). Code: compare, PR #283 and its review fixes #285
  (`cli/keel-compare.mjs`, `engine/govern/compare.mjs`). Only live check left for that package.
- Needs: /opt/keel-live at f54fa00 or later (`test -f /opt/keel-live/cli/keel-compare.mjs`).
- Status: done
- Result: Done 2026-10-15 09:38–09:45 UTC, read-only (Collector GETs, DB reads). No tenant, host or DB writes.
  - **1.** /opt/keel-live at **f54fa007** (deployed 09:38).
  - **2.** Principal: "Marouane Defili (Entra ID)" (bac8d59b…; viewer, operator, approver, restorer and admin, scope *).
  - **3.** `sources`: **exit 0**. It lists tenant sha256:f7b3959300856957 and its snapshots, the newest 2026-10-15T09:00:20Z (1476 objects).
  - **4.** `live`: **exit 0**. `compare live: 44 differences`, from snapshot 92bcd02f… (2026-10-15T09:00:20.933Z) to the tenant at
    09:38:46Z. Workloads and content: newest stored collection, not read live.
  - **5. `--json`:**
    - `mode`: live. Left: snapshot 92bcd02f… (09:00:20Z). Right: live, latestStored [workloads, content].
    - Settings totals: added 0, removed 0, **changed 44**, unchanged 1432, notCompared 65, unmatched 0.
      - **All 44 changes are false.** All are `roleAssignmentSchedule`, field `scheduleInfo.startDateTime`, which Graph returns
        as the read time for no-expiry assignments. Filed **#288**.
    - **Not compared, settings, 65 types** (40 Entra ID, 25 Intune):
      - Reason for all 65: left `not-requested`. The 09:00 snapshot is an hourly tier-1 collection that does not read those
        types; the right side is complete for 34, complete-empty for 27, failed for 4.
      - The 4 live-read failures are tenant license or feature limits, not permissions; the Collector token holds both scopes:
        identityApiConnector (400 AADB2C99039, self-service sign-up not enabled), and lifecycleManagementSettings,
        lifecycleWorkflow and lifecycleWorkflowCustomTaskExtension (403, needs an Entra ID Governance license).
      - Observation: comparing against the latest snapshot means about 65 tier-2/3 types are never compared from an hourly
        snapshot. Using the newest snapshot that requested each type would cover them; this is a design choice for the thread.
    - **Workloads:** 56 unchanged, 0 changed. Not compared, 7 (disabled, not qualified): exchange-extended, exchange-mail-flow,
      power-platform-settings, purview-governance, purview-retention-dlp, teams-org-policies, teams-voice-policies.
    - **Content:** by item, 0 added, 0 removed, 0 changed (exchange-mail 11 to 11, group-conversations 3 to 3, …).
    - No type is shown as removed (0 removed).
  - **6. Refusal** (random uuid principal): **exit 2**, `refused: this principal does not hold the read capability`.
  - **7. Portal gate:** keel-portal on 127.0.0.1:3600. `GET /api/compare` with no session returns **401**; POST also returns 401.
  - **Rerun after #291 (0ba6cee), 10:18 UTC on c3b5f6c8:** `live` exit 0. `compare live: 1 differences`, from snapshot 728f7a91… (10:00:47Z).
    - Settings: 0 added, 0 removed, **0 changed**, 1463 unchanged, notCompared 66. **0 roleAssignmentSchedule differences.**
    - The 1 remaining difference is in workloads, also read-time noise: exchange-mailbox-settings
      `mailboxSettings.automaticRepliesSetting` on 1 mailbox. The status is disabled before and after; only the scheduled
      start and end moved to the current hour. Reported on #288.
- **Read-only.** The live side runs the Collector's GETs and stores nothing. No tenant, host or DB writes.
- Do, as the worker's user with the DB env loaded (`set -a; . /etc/keel/db.env; set +a`):
  1. Record the commit `/opt/keel-live` is deployed at.
  2. Pick a principal holding `read` (the Entra principal used for Q45 approvals is fine) and report which one, by name.
  3. `node /opt/keel-live/cli/keel-compare.mjs sources --principal-id <id>; echo exit=$?`
  4. `node /opt/keel-live/cli/keel-compare.mjs live --principal-id <id> --config /etc/keel/tenant.json; echo exit=$?`
     Expect exit 0 and a result for the latest completed snapshot against the tenant now.
  5. Same command with `--json`, and report from it only: `mode`, the snapshot it compared, the difference count,
     and the list of types or workloads marked "not compared" (with the reason).
  6. Refusal check: the same `live` command with a principal that does not hold `read` (or a random uuid). Expect exit 2.
  7. Portal gate: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<keel-portal's local port>/api/compare`
     with no session, and report the code (expect 401 or 403, never 200).
- **Report:** the deployed commit; exit codes of steps 3, 4 and 6; the step 5 fields; anything that looks wrong
  (a type shown as removed that you know still exists is a bug: name the type). No ids, tokens or payload values.

### Q67: Entra directory policy writers, live round trip on the test tenant (six types)
- Drafted by the "Wave 2 live checks" thread (2026-10-15). Code: PR #286 (merge f54fa00). New writers, create and update
  (no delete) for oauth2PermissionGrant, permissionGrantPolicy, tokenLifetimePolicy, tokenIssuancePolicy,
  claimsMappingPolicy and homeRealmDiscoveryPolicy. Fixture-tested only so far.
- Needs: /opt/keel-live at f54fa00 or later (`test -f /opt/keel-live/engine/restore/directoryPolicyOperations.mjs`).
- Status: done
- Result: Done 2026-10-15 10:20–10:45 UTC on **B = c3b5f6c8** (resumed after #290 fixed #289). Plan re-taken at B: 106 operations,
  107 steps; the six types are steps 73–74, 77–78 and 80–85, plus 101–102 for home realm discovery.
  Restorer only; global admin not used; no permission added. Every approval was filed by the Entra principal and
  self-approved by keel-operator as the Gmail approver under the 2026-10-14 standing authorization.
  - **Live writes: all six writers work, create and update.** Read-backs equal the backup, except the consent policy's
    extra include (see below). isOrganizationDefault stayed false throughout.
    - The create path writes isOrganizationDefault false; no follow-up appears for it because the backups were not defaults.
      The follow-up listed for the four policies is "Which apps the policy is assigned to".
  - **Evidence promoted: none in the end.** The capture tool refuses five of the types (**#295**). permissionGrantPolicy update captured
    and passed `promote`, but I then **demoted** it (10:47): its readBackVerified covers only the written fields, while the live
    policy kept a drifted extra include and is wider than the backup (#294; a background security review flagged it as fail-open).
  - **Per type and operation:**

    | type | create | update |
    |---|---|---|
    | tokenLifetimePolicy | restored, equal; **blocked** (capture #295) | restored, equal; **blocked** (#295) |
    | tokenIssuancePolicy | restored, equal; **blocked** (#295) | restored, equal; **blocked** (#295) |
    | claimsMappingPolicy | restored, equal; **blocked** (#295) | restored, equal; **blocked** (#295) |
    | permissionGrantPolicy | **demoted** (#294) | captured; **demoted** (the restored policy is wider than the backup, #294) |
    | oauth2PermissionGrant | restored, equal; **blocked** (#295: "no role reference") | restored (scope `openid profile` → `openid`); **blocked** (#295) |
    | homeRealmDiscoveryPolicy | restored, equal; **blocked** (#295) | restored, equal; **blocked** (#295) |

    - permissionGrantPolicy create: the include POST came 404 before the new policy replicated, so it was left with 0 of 1
      includes (#294). A retry restored it as an update.
    - permissionGrantPolicy update: displayName equal. The `low` include was re-added, but the drifted `medium` include was
      **left in place**, so the live policy is wider than the backup (comment on #294).
  - **Rounds:**
    - Create: S1 b18b75b3. Run A1 (approval **5177667e**) created the 3 STS policies, then failed on the consent policy.
      Retry A1b (approval **ffb3c161**) updated the consent policy and created the grant; the STS policies were adopted with no write.
    - Update: S2 12922071, all five drifted. A2 (approval **85578eb4**): 5 updates succeeded.
    - Home realm discovery alone: break-glass report overall `ready`. S3 6318a54e, create A3 (approval **b7d683c8**);
      S4 6ce0f6b3, update A4 (approval **38f84f2e**).
  - **Step 5, re-run planned writes:**
    - From S2: tokenLifetime 0, tokenIssuance 0, claimsMapping 0, oauth2PermissionGrant 0, **permissionGrantPolicy 1** (every time,
      because of the extra include). From S4: homeRealmDiscovery 0.
    - From S1, the pre-create snapshot, the dry run lists the 3 STS policies as `create recreate`, though the run adopts them and writes nothing.
  - **Cleanup:** deleted every KEEL-RT-W2 policy, `keel-rt-w2-consent`, the fixture grant, and app KEEL-RT-W2-app with its SP
    (purged from deleted items). **Nothing left** (re-read: 0).
  - **Evidence:** `claude/live-evidence-w2-entra` @ **e21bbc8**. Files: permissionGrantPolicy.create.json, .capture.json and .demotion.json;
    permissionGrantPolicy.update.json, .capture.json and .demotion.json (the demotion is commit 1a8b2b0). pseudonymize check exit 0; the secret and known-id scans are clean.
  - **operations.mjs --live-evidence:**
    `live evidence permissionGrantPolicy.create.json: not applied (the write was not verified by its read-back, so it cannot be promoted)`;
    `live evidence permissionGrantPolicy.update.json: fixture-tested -> live-qualified`. This line ignores the sibling
    .demotion.json; the builder should take the demotion (comment on #294).
  - GitHub: #294 (replication 404, plus widening and re-run), #295 (capture tool), comment on #286.
- Coordinator note (2026-10-15): resume from the S1 dry run, no new setup. Needs /opt/keel-live at c3b5f6c or later
  (`grep -q unavailableOnTenant /opt/keel-live/engine/collect/entraAdapter.mjs`). The restore's current-state read now
  skips a type the tenant has no licence or feature for (403 "Insufficient license", 400 AADB2C99039) unless the
  restore touches it, so lifecycle workflows and API connectors no longer block. Re-take plan-B at the new build.
- **Test tenant only.** Same hard rules, capture tooling and requester/approver split as Q45. Under the 2026-10-14
  standing authorization, keel-operator approves these test-tenant restores itself; log every approval id here.
- **Restorer permissions:** none to add. Q26 shows it already holds Policy.ReadWrite.ApplicationConfiguration,
  Policy.ReadWrite.PermissionGrant and Directory.ReadWrite.All (enough for oauth2PermissionGrant). If Graph refuses a
  write with 403, report it as blocked with the permission Graph names; do not grant anything.
- **Fixtures (all named `KEEL-RT-W2-...`):**
  - tokenLifetimePolicy, tokenIssuancePolicy, claimsMappingPolicy, homeRealmDiscoveryPolicy: one each, named
    `KEEL-RT-W2-<type>`, with `isOrganizationDefault: false` and **not assigned to any app or service principal**.
    Use a minimal valid definition (Graph docs examples). An unassigned, non-default policy changes no sign-in, so the
    plan's "lockout-sensitive" label on homeRealmDiscoveryPolicy does not apply to this fixture; still run it last.
  - permissionGrantPolicy: custom policy id `keel-rt-w2-consent`, display name `KEEL-RT-W2-consent`, one include rule
    (permissionType delegated, permissionClassification low). Not referenced by any authorization policy setting.
  - oauth2PermissionGrant: reuse an existing grant that touches only KEEL-RT fixtures if one exists. Otherwise create one
    on a KEEL-RT- app with no other permissions: consentType `Principal`, principal one `keel-rt-` fixture user,
    resource Microsoft Graph, scope `openid` only. This fixture exception grants no data access; it never applies to
    Keel's own apps or any non-fixture app or user.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. `node tools/qualification/live-gate-plan.mjs > ~/keel-w2/plan-B.md`. Use only its steps for these six types
     (at f54fa00: 33–42 and 58–59). Follow each step's commands (collect, restore dry run, approve, `--enforce`,
     `entraLive.mjs capture`, promote or demote).
  2. Create the fixtures and take snapshot S (one shared run is fine for everything except homeRealmDiscoveryPolicy).
  3. **create round:** delete each fixture (permanently where Graph has a recycle bin), restore from S selecting all of
     them, approve, enforce, capture each `create`. Check each reads back equal to the backup: definition, scope string,
     include rule. For the four policies, confirm `isOrganizationDefault` was not written and the result lists it as a
     follow-up step instead.
  4. **update round:** change each fixture (policy definition value, display name, consent scope `openid` to
     `openid profile`, the include rule's classification), restore from S, approve, enforce, capture each `update`.
     Read back equal again.
  5. **Re-run check:** restore from S once more right after step 4, dry run. Expect zero writes planned for these six
     (each adopts its existing match). Report the planned-write count per type.
  6. homeRealmDiscoveryPolicy last, alone, the same create and update rounds.
  7. Cleanup: delete every `KEEL-RT-W2-*` object and the `keel-rt-w2-consent` policy, and the fixture grant if you
     created it. Report anything left.
  8. Commit the `*.json`, `*.capture.json` and `*.demotion.json` files under
     `docs/release/qualifications/entra-live/` on `claude/live-evidence-w2-entra`, branched from `origin/master`.
     Secret scan first (as Q39). No PR.
  9. `node tools/qualification/operations.mjs --live-evidence <that directory>` and report the `live evidence ...` lines.
- **Report:** B; per type and operation: promoted / demoted (reason) / blocked (why); the step 5 counts; approval ids;
  the evidence branch and commit; anything left in the tenant.

### Q68: Mail restore live check on the test tenant (alice's KEEL-RT- mailbox)
- Drafted by the "Mail restore" thread (2026-10-15). Code: PR #275 (merge on master 2026-10-15 ~09:58Z), CLI
  `cli/keel-content-restore.mjs mail plan|request|run`. Fixture-tested only so far. Handoff:
  /mnt/project-files/handoff/wave2/MAILR/HANDOFF.md (cloud side).
- Needs: `test -f /opt/keel-live/cli/keel-content-restore.mjs`. Q63 done (Restorer has Exchange RBAC
  Application Mail.ReadWrite scoped to `keel-rt-*` mailboxes). Q64 done (alice's mailbox is in the content store).
- Status: done
- Result: Done 2026-10-15 10:15–10:20 UTC. Writes only in keel-rt-20260908-alice's mailbox. Global admin not used; no permission granted.
  **isDraft = true on both restored messages (#293).**
  - **B:** step 1–2 on eb59e2d0 (it has #275). The auto-deploy switched to **c3b5f6c8** at 10:15:56, so steps 3–5 ran on c3b5f6c.
  - **Restorer appId:** 12f8942f… (Keel Restorer). `/etc/keel/content-restorer.json` did not exist, so I created it
    (root, 600; tenantId, certPath and keyPath copied from restorer.json).
  - <A> alice; <T> 2026-10-15T10:15:23Z; <R> Entra principal bac8d59b…; <P> approver 2a47535a…. All approvals were filed by
    <R> and self-approved as <P> under the standing authorization.
  - **1. Plan** (exit 0): containers 10; items mail 1, calendar 0, contacts 0, todo 0; notRestorable [].
  - **2. Copy restore, mail** (approval **be8c1e51**): exit 0.
    `{"label":"Restored 2026-10-15","restored":1,"kept":{"unchanged":0,"newer":0},"alreadyDone":0,"notRestorable":0,"failed":0,"writes":10,"status":"completed"}`
    - The top-level folder `Restored 2026-10-15` holds the 8 default folders (Archive, Conversation History, Deleted Items, Drafts,
      Inbox, Junk Email, Outbox, Sent Items). Its Inbox holds the copy of KEEL-RT-20261015-mail.
    - **Copy `isDraft`: true** (the original was false). receivedDateTime became 10:15:43Z (the original was 07:48:01Z).
  - **3. Re-run** (same approval): exit 0, restored 0, alreadyDone 1, **writes 0**, completed.
  - **4. Into the original folder:**
    - Graph DELETE on the original returned 204. It went to Recoverable Items, not Deleted Items, so Deleted Items stayed empty.
    - The `--into original --kinds mail` run (approval **754f0009**): exit 0.
      `{"restored":1,"kept":{"unchanged":0,"newer":0},"alreadyDone":0,"failed":0,"writes":1,"status":"completed"}`
    - The message is back **in the Inbox** (parentFolderId = Inbox). **isDraft: true**; receivedDateTime 10:16:14Z.
    - kept.unchanged is 0 because the Inbox held no other item.
  - **5. Calendar, contacts, To Do** (copy; approval **9e570594**): **exit 1**. The plan had 0 items for all three.
    `{"restored":0,"failed":1,"writes":2,"status":"failed","errors":[{"container":"calendar:…","error":"creating calendar Restored 2026-10-15 - Calendar failed: 403 ErrorAccessDenied Access is denied. Check credentials and try again."}]}`
    - calendar: **403**. The Q63 Exchange RBAC scope is Application Mail.ReadWrite only.
    - todo: the empty container "Restored 2026-10-15 - Tasks" was created (Graph Tasks.ReadWrite.All, from Q60).
    - contacts: nothing written. The Restorer's own contactFolders read is also 403.
  - **6. Cleanup:**
    - Deleted the `Restored 2026-10-15` mail folder tree (204; also gone from Deleted Items).
    - Deleted the To Do list "Restored 2026-10-15 - Tasks" (204).
    - No calendar or contact folder was created, and no KEEL-RT-20261015-mail copy was in Deleted Items.
    - **Left:** one KEEL-RT-20261015-mail in alice's Inbox (the step-4 restore; isDraft true). The deleted original is in
      Recoverable Items.
  - GitHub: **#293** (restored mail is a draft, and the received time is the restore time; with the fix options). Commented on #275.
- **Test tenant only.** Same hard rules and requester/approver split as Q45. Under the 2026-10-14 standing authorization,
  keel-operator approves these test-tenant restores itself; log every approval id here. Write only into
  keel-rt-20260908-alice's mailbox. Grant no permission: if Graph answers 403 for a kind, record it and go on.
- **Restorer identity:** Marouane reported the content-restore consent done on 2026-10-15 10:13 UTC. If
  `/etc/keel/content-restorer.json` already exists, use it and report its appId. Otherwise create it (mode 600, owner as
  the other /etc/keel files) for the Restorer: `{ "tenantId", "clientId": "12f8942f-c4d0-4a0d-aee1-efe928b1de54",
  "certPath", "keyPath" }`, copying tenantId, certPath and keyPath from `/etc/keel/restorer.json`. Never print key material.
- Do, as the deployed build B (`node /opt/keel-live/cli/keel-content-restore.mjs ...`, KEEL_DB_URL from /etc/keel/db.env).
  `<A>` = alice's user id, `<T>` = the current UTC time (ISO), `<R>` requester and `<P>` approver principal ids:
  1. **Plan (read-only):** `mail plan --source-mailbox <A> --at <T>`. Report the JSON (counts per kind, notRestorable).
  2. **Copy restore, mail only:** `mail request --source-mailbox <A> --at <T> --kinds mail --actor <R>`, approve the
     printed approvalId as `<P>`, then `mail run --approval-id <id> --actor <R>`. Report the exit code and the report JSON.
     Check: a top-level folder `Restored <today>` exists in alice's mailbox with the Inbox tree under it; the copy of
     KEEL-RT-20261015-mail is there. **Report its `isDraft`** (`GET .../messages/{id}?$select=isDraft,subject`).
  3. **Re-run:** the same `mail run` again. Expect exit 0, `restored: 0`, `writes: 0`.
  4. **Into the original folder:** delete KEEL-RT-20261015-mail from alice's Inbox (Graph DELETE as the Restorer; it goes to
     Deleted Items). Then request, approve and run with `--into original --kinds mail` at the same `<T>`. Expect the message
     back in alice's Inbox and every other Inbox item reported kept (`kept.unchanged`). Report the report JSON and the
     restored message's `isDraft` and `parentFolderId` (Inbox or not).
  5. **Calendar, contacts, To Do (copy):** request, approve and run `--kinds calendar,contacts,todo` at `<T>`. Report the
     report JSON; per kind, restored or the 403/permission error Graph named.
  6. **Cleanup:** delete the `Restored <today>` mail folder, contact folder, calendars and To Do lists the runs created,
     and the KEEL-RT-20261015-mail copy left in Deleted Items. Keep the message restored in step 4 in the Inbox.
- **Report:** B; the restorer appId used; steps 1–5 outputs (exit codes, report JSON, approval ids); both `isDraft`
  values; anything refused; anything left in the tenant. No tokens or keys.

### Q69: File restore live check on the test tenant (the KEEL-RT-20261004 site library)
- Drafted by the "File restore" thread (2026-10-15). Code: PR #274 (merged on master 2026-10-15 ~10:19Z), CLI
  `cli/keel-content-restore.mjs files plan|request|run`. Fixture-tested only so far. Handoff:
  /mnt/project-files/handoff/wave2/FILER/HANDOFF.md (cloud side).
- Needs: `test -f /opt/keel-live/cli/keel-content-restore-files.mjs` (a build with #274). Q68 done (it created
  `/etc/keel/content-restorer.json` for the Restorer).
- Status: done
- Result: Done 2026-10-15 10:46–10:55 UTC on **B = 39669a6c** (it has #274). Writes only in the KEEL-RT-20261004 site's Documents library
  (Restorer through content-restorer.json, appId 12f8942f…). Global admin not used. No 403s.
  Approvals: filed by the Entra principal and self-approved as the Gmail approver.
  - **1. Fixtures:** `KEEL-RT-20261015-file.txt` ("KEEL-RT version 1", simple PUT, 201) and `KEEL-RT-20261015-large.bin`
    (5,242,880 random bytes through createUploadSession, 3 chunks, 201). Upload sha256:
    **248c28650776088530835f61b240573c4026aadd5cb9be60b395576fb7725ca2**.
  - **2. Backup** (exit 0): sharepoint-sites succeeded, 8 items, 5,252,682 bytes. Both files have drive-content and drive-record rows
    under site:<S>. T1 = 2026-10-15T10:47:31Z.
  - **3.** Overwrote the .txt with "KEEL-RT version 2" (200) and deleted the .bin (204, to the site recycle bin). Backup exit 0.
    T2 = 2026-10-15T10:48:56Z.
  - **4. Plan** (exit 0): items 2, writes 2, bytes 5,242,898, conflict copy. Steps: `KEEL-RT-20261015-file (restored 2026-10-15).txt`
    **create-copy**; `KEEL-RT-20261015-large.bin` **create**.
  - **5. Restore as of T1** (approval **66733db0**): exit 0, status completed. Stats: planned 2, written 2, copies 1, writes 4,
    bytes 5,242,898, failed 0.
    - The copy holds **"KEEL-RT version 1"**; the live .txt still holds "KEEL-RT version 2".
    - The .bin is back, 5,242,880 bytes, downloaded sha256 **248c2865…25ca2, equal** to step 1's. The upload-session path is proven.
  - **6. Re-run:** exit 0, written 0, skipped 2 (`restored copy exists`, `identical`), writes 0.
  - **7. Single file, --conflict replace** (approval **1c8a9c5c**): exit 0, written 0, skipped 1: `restored copy exists` (step 5's copy).
    - 7b: I deleted that copy and requested again with the same flags (approval **12d0a08f**). Exit 0, but it got the **same runId**
      and resumed the journal: the step reads create-copy, "the live file is newer; restored as a copy", while the stats show written 0,
      skipped 1, and **no copy was written**.
    - Kept-newer behaviour is right (no overwrite of the newer live file), but a resumed run doesn't re-check that its copy still
      exists. Reported on PR #274.
  - **8. Cleanup:** deleted the restored copy, the .txt and the restored .bin. The library root is now empty.
    - **Left:** the site recycle bin holds the step-3 .bin, the step-7 copy and the 3 cleanup deletions (Graph v1.0 can't purge it).
      No other change.
- **Test tenant only.** Same hard rules and requester/approver split as Q68. Under the 2026-10-14 standing authorization,
  keel-operator approves these test-tenant restores itself; log every approval id here. Write only into the
  `KEEL-RT-20261004` communication site (Q8) and its default document library. Grant no permission: if Graph answers 403,
  record it and stop.
- Do, as the deployed build B (`node /opt/keel-live/cli/keel-content-restore.mjs files ...`, KEEL_DB_URL from /etc/keel/db.env).
  `<S>` = the site's Graph id (the part after `site:` in the content store container), `<D>` = its default library's drive id,
  `<R>` requester and `<P>` approver principal ids:
  1. **Fixtures (Restorer, the only setup writes):** in the library root, upload
     - `KEEL-RT-20261015-file.txt` with the one line `KEEL-RT version 1`;
     - `KEEL-RT-20261015-large.bin`: 5 MiB of random bytes, through `createUploadSession`, since a simple PUT stops at 4 MiB.
       Record its sha256 locally.
  2. **Backup:** `node /opt/keel-live/cli/keel-content-collect.mjs run`, as Q64. Confirm that both files have
     `drive-record` rows under container `site:<S>` (workload `sharepoint-sites`). Note `<T1>` = the current UTC time.
  3. **Change and delete:** overwrite the .txt with `KEEL-RT version 2`. Delete the .bin (it goes to the site recycle bin).
     Run the backup again, and note `<T2>` = the current UTC time.
  4. **Plan (read-only):** `files plan --drive <D> --site <S> --whole-drive --at <T1>`. Report the JSON: the .txt should
     plan `create-copy` (the live file differs) and the .bin `create`.
  5. **Restore as of T1:** `files request` with the same flags `--actor <R>`, approve as `<P>`, then
     `files run --approval-id <id> --actor <R>`. Report the exit code and the JSON. Check:
     - `KEEL-RT-20261015-file (restored 2026-10-15).txt` exists with `KEEL-RT version 1`, and the live .txt still says version 2;
     - `KEEL-RT-20261015-large.bin` is back, and its downloaded sha256 equals step 1's (this proves the upload-session path).
  6. **Re-run:** the same `files run` again. Expect exit 0 and no writes (every step `skip`, or already done).
  7. **Single file, replace:** `files request --drive <D> --site <S> --file <the .txt's item id> --at <T1> --conflict replace`,
     approve, then run. The live .txt is newer than T1, so expect a kept-newer copy, not an overwrite. Report the JSON.
  8. **Cleanup:** delete the restored copy or copies, and both fixtures. Report anything left in the tenant.
- **Report:** B; steps 2–7 outputs (exit codes, JSON, approval ids); both sha256 values; anything refused (403 or guard);
  anything left in the tenant. No tokens or keys.

### Q70: Scoped calendar and contacts write for the Restorer (keel-rt- mailboxes), then the calendar and contacts restore check
- Drafted by the "Calendar and contacts restore access" thread (2026-10-15). Q68 step 5 got 403 for calendar and contacts:
  the Q63 RBAC assignment KEEL-RT-restorer-mail-rw covers Application Mail.ReadWrite only.
- Needs: Q63 done (scope KEEL-RT-test-mailboxes and the Exchange SP "Keel Restorer" exist). Q68 done
  (`/etc/keel/content-restorer.json` exists). Can run alongside Q69 (different workload, different site).
- Status: done
- Result: Done 2026-10-15 10:44–12:52 UTC on B = 14dc79a1. Restorer only (EXO PowerShell app-only, plus Graph); global admin not used.
  No Entra Calendars/Contacts grant and no manifest change. Approvals: filed by the Entra principal and self-approved as the
  Gmail approver under the standing authorization.
  - **1. Entra check:** the Restorer SP holds no Calendars.* or Contacts.* Graph role (none, read or write).
  - **2. Exchange:**
    - Scope KEEL-RT-test-mailboxes, filter `PrimarySmtpAddress -like 'keel-rt-*'`.
    - Preview, 2 recipients, both keel-rt-: keel-rt-20260908-alice and keel-rt-20260908-collaboration.
    - Created (none existed): **KEEL-RT-restorer-calendars-rw** (Application Calendars.ReadWrite) and
      **KEEL-RT-restorer-contacts-rw** (Application Contacts.ReadWrite), both on CustomResourceScope KEEL-RT-test-mailboxes.
  - **3. Test-ServicePrincipalAuthorization:**
    - alice: Calendars.ReadWrite **InScope=True**, Contacts.ReadWrite **InScope=True**.
    - AdeleV: Calendars.ReadWrite **InScope=False**, Contacts.ReadWrite **InScope=False**.
  - **4. Fixtures:** 403 ErrorAccessDenied from 10:45:18 on (retried every 10 min) while RBAC propagated. **First 201 at 12:15:49**
    (event AAMkAGEw…) and **12:15:50** (contact AAMkAGEw…), about 90 min after the assignments.
    - KEEL-RT-20261015-event is in the default calendar, 2026-10-20 09:00–09:30 UTC, 0 attendees.
    - KEEL-RT-20261015-contact is in the default contacts, with keel-rt-contact@example.invalid.
  - **5. Blocked check:** AdeleV `events` **403 ErrorAccessDenied**, `contacts` **403 ErrorAccessDenied**, both at 10:45 and again
    after propagation at 12:47.
  - **6. Backup** (exit 0):
    `exchange-mail: succeeded (2 items, 4355 bytes)`, `onedrive: succeeded (0 items, 0 bytes)`,
    `sharepoint-sites: succeeded (4 items, 4542 bytes)`, `teams: succeeded (11 items, 271885 bytes)`,
    `planner: succeeded (8 items, 11975 bytes)`.
    content_item has the event (container mailbox/<alice>/calendar/…) and the contact (mailbox/<alice>/contacts/default).
  - **7. Restore check** (T = 2026-10-15T12:45:43Z):
    - a. Plan (exit 0): containers 11; items mail 1, **calendar 1, contacts 1**, todo 0; notRestorable [].
    - b. Copy, `--kinds calendar,contacts` (approval **e37feac8**): exit 0, `restored 2, writes 4, failed 0, status completed`.
      Calendar "Restored 2026-10-15 - Calendar" holds KEEL-RT-20261015-event (0 attendees). Contact folder "Restored 2026-10-15" holds
      KEEL-RT-20261015-contact.
    - c. Re-run: exit 0, `restored 0, alreadyDone 2, writes 0`.
    - d. Deleted both fixtures (204 each), then `--into original` (approval **b8dc5a70**): exit 0, `restored 2, writes 2, failed 0,
      status completed`. The event is back in the default calendar (0 attendees, the original start). The contact is back in the
      default contacts, with its email address.
  - **8. Cleanup:** deleted the "Restored 2026-10-15 - Calendar" calendar and the "Restored 2026-10-15" contact folder (204 each).
    - **Left:** the step-7d event and contact as the standing fixtures.
    - The Exchange assignments KEEL-RT-restorer-calendars-rw and KEEL-RT-restorer-contacts-rw stay.
    - Nothing else; alice now has only "Calendar" and no extra folders.
- Decision: D-93a ("add any the tool needs to move along"), as for D-Q55. Same shape as D-Q63: Exchange RBAC for
  Applications on the existing KEEL-RT-test-mailboxes scope only. No consent click is needed.
- **Rules:** test tenant. The only permission changes are the two role assignments below. **Do not** add Graph
  `Calendars.*` or `Contacts.*` write permissions to any app manifest and create no Entra appRoleAssignment: a tenant-wide
  Entra grant would bypass the scope. Writes only in keel-rt-20260908-alice's mailbox. Events are created **without
  attendees** (no invitations). Never touch break-glass, the operator's admin account or Marouane's mailbox. Global admin
  not used. Under the 2026-10-14 standing authorization, keel-operator approves the restores itself; log every approval id.
- **Do:**
  1. **Entra check (read-only):** list the Restorer SP's Graph appRoleAssignments. If it holds `Calendars.ReadWrite` or
     `Contacts.ReadWrite` (or any `Calendars.*`/`Contacts.*` read role), report which; a write role means the scope is
     bypassed, so stop and report `blocked`. Note the Collector/Content Reader roles are not in scope here.
  2. **Exchange setup**, in Exchange Online PowerShell as the Restorer (app-only, as in Q63). Reuse an assignment if it
     already exists with these exact values:
     ```powershell
     $spId = '8cd199c9-a96e-4666-924f-aa0ca6910f32'
     Get-ManagementScope 'KEEL-RT-test-mailboxes' | Select Name,RecipientFilter
     Get-Recipient -RecipientPreviewFilter "PrimarySmtpAddress -like 'keel-rt-*'" -ResultSize 50 | Select Name,PrimarySmtpAddress
     New-ManagementRoleAssignment -Name 'KEEL-RT-restorer-calendars-rw' -App $spId -Role 'Application Calendars.ReadWrite' -CustomResourceScope 'KEEL-RT-test-mailboxes'
     New-ManagementRoleAssignment -Name 'KEEL-RT-restorer-contacts-rw' -App $spId -Role 'Application Contacts.ReadWrite' -CustomResourceScope 'KEEL-RT-test-mailboxes'
     ```
     If the preview lists any mailbox not starting with `keel-rt-`, stop before creating anything and report `blocked`.
     If a cmdlet is refused for the app, stop and report `blocked` with the error text.
     Undo: `Remove-ManagementRoleAssignment KEEL-RT-restorer-calendars-rw` and `... KEEL-RT-restorer-contacts-rw`.
  3. **Authorization check (read-only):** `Test-ServicePrincipalAuthorization -Identity $spId -Resource
     keel-rt-20260908-alice@techinsiderbytes.com` must show Application Calendars.ReadWrite and Application
     Contacts.ReadWrite with `InScope = True`; against the same non-test mailbox as Q63 (AdeleV): `InScope = False`.
  4. **Fixtures** (as the Restorer, Graph v1.0; on 403 retry every 10 minutes for up to 2 h, as RBAC propagates). Create
     each once; reuse if one with that name already exists:
     - Event in alice's default calendar: `POST /users/keel-rt-20260908-alice@techinsiderbytes.com/events` with
       `{"subject":"KEEL-RT-20261015-event","start":{"dateTime":"2026-10-20T09:00:00","timeZone":"UTC"},
       "end":{"dateTime":"2026-10-20T09:30:00","timeZone":"UTC"},"body":{"contentType":"text","content":"KEEL-RT calendar fixture"}}`
       (no attendees).
     - Contact in alice's default contacts: `POST /users/keel-rt-20260908-alice@techinsiderbytes.com/contacts` with
       `{"givenName":"KEEL-RT-20261015-contact","displayName":"KEEL-RT-20261015-contact","emailAddresses":[{"address":"keel-rt-contact@example.invalid","name":"KEEL-RT-20261015-contact"}]}`.
     Report when each write first succeeded and its id (first 8 chars).
  5. **Blocked check** (as the Restorer): on the non-test mailbox, `GET /users/<it>/events?$top=1&$select=id` and
     `GET /users/<it>/contacts?$top=1&$select=id`. Expected 403 each. No write there; record status and error code only.
     If either returns 200, remove both new assignments and report `failed`.
  6. **Backup:** `node /opt/keel-live/cli/keel-content-collect.mjs run` once. Report exit code and workload lines, and
     confirm content_item holds the event and the contact for alice's mailbox.
  7. **Restore check**, as Q68 with build B (`node /opt/keel-live/cli/keel-content-restore.mjs ...`), `<T>` = now:
     a. `mail plan --source-mailbox <A> --at <T>`: report counts; expect calendar ≥ 1 and contacts ≥ 1.
     b. Copy restore: request `--kinds calendar,contacts` at `<T>`, approve, run. Report exit code and JSON. Check a
        calendar "Restored <today> - Calendar" holds KEEL-RT-20261015-event (no attendees) and a contact folder
        "Restored <today>" holds KEEL-RT-20261015-contact.
     c. Re-run the same approval: expect exit 0 and `writes: 0`.
     d. Into the original: delete both fixtures (Graph DELETE as the Restorer), request `--into original --kinds
        calendar,contacts` at the same `<T>`, approve, run. Expect both back in the default calendar and contacts. Report JSON.
  8. **Cleanup:** delete the restored calendar and contact folder from 7b. Keep the event and contact restored in 7d as
     the standing fixtures. Report anything left in the tenant.
- **Report:** step 1 findings; preview list and assignments created (or reused); all four
  Test-ServicePrincipalAuthorization results; fixture write times and ids; blocked-check codes; backup lines; step 7
  outputs (exit codes, JSON, approval ids); anything refused; anything left in the tenant. No tokens or keys.

### Q71: Rerun the live compare after #299 (read-only)
- Drafted by the "#296 automatic reply schedule" thread (2026-10-15). Fix: PR #299, master 95408f8. When automatic replies
  are not scheduled, compare now ignores their scheduled start and end, which Graph sets to the current hour on every read.
- Needs: /opt/keel-live at 95408f8 or later (recorded the same way as Q66 step 1).
- Status: done
- Result: Done 2026-10-15 12:44 UTC, read-only (Collector GETs, DB reads). No writes.
  - **1.** /opt/keel-live at **14dc79a1**, which includes 95408f8 (#299).
  - **2.** Principal: "Marouane Defili (Entra ID)" (bac8d59b…), as Q66.
  - **3.** `keel-compare.mjs live --json`: **exit 0**. **0 differences**, from snapshot ee92b539… (12:00:14Z) to the tenant now.
    - Settings: added 0, removed 0, **changed 0**, unchanged 1476 (notCompared 65: the tier-2/3 types the hourly snapshot doesn't
      request, as in Q66).
    - Workloads: added 0, removed 0, **changed 0**, unchanged 56 (notCompared 7: disabled workloads).
    - Content: 0 added, 0 removed, 0 changed.
  - Commented on #296.
- **Read-only.** Same as Q66 steps 1, 2 and 4 only: the Collector's GETs and DB reads. No tenant, host or DB writes.
- Do, as the worker's user with the DB env loaded (`set -a; . /etc/keel/db.env; set +a`):
  1. Record the commit `/opt/keel-live` is deployed at.
  2. Use the same `read` principal as Q66.
  3. `node /opt/keel-live/cli/keel-compare.mjs live --principal-id <id> --config /etc/keel/tenant.json --json; echo exit=$?`
- **Report:** the deployed commit; the exit code; the difference count; settings and workloads totals (added, removed,
  changed, unchanged). Expect **0 changed** in both. If anything is still changed, name the type or workload and field
  path only. No ids, tokens or payload values. Comment the result on #296.

### Q72: Mail restore rerun after #301 (restored mail is not a draft and keeps its dates)
- Drafted by the "#293 restored mail drafts" thread (2026-10-15). Fix: PR #301, merged on master **847edbf**. Restored
  messages are now created as received messages (PR_MESSAGE_FLAGS read, not unsent) with their original received and sent
  times, instead of the MIME create that Exchange stores as a draft dated now. Closes the Q68 finding (#293).
- Needs: /opt/keel-live at 847edbf or later. Q68 done (content-restorer.json exists).
- Status: done
- Result: Done 2026-10-15 13:31–13:36 UTC on **B = 321435f6** (includes 847edbf, #301). Writes only in keel-rt-20260908-alice's mailbox, as the
  Restorer through content-restorer.json. Global admin not used. Approvals filed by the Entra principal and self-approved as the
  Gmail approver under the standing authorization. **#293 is fixed live.**
  - **2. Plan** (`--kinds mail`, T = 2026-10-15T10:15:30Z): exit 0. Containers 8; items mail **1**; notRestorable [].
  - **3. Copy restore** (approval **ef80b7ab**): exit 0.
    `{"label":"Restored 2026-10-15","restored":1,"kept":{"unchanged":0,"newer":0},"alreadyDone":0,"notRestorable":0,"failed":0,"writes":10,"incomplete":[],"status":"completed"}`
    - The copy in `Restored 2026-10-15/Inbox`: subject KEEL-RT-20261015-mail, **isDraft false**, isRead true,
      **receivedDateTime 2026-10-15T07:48:01Z**, sentDateTime 07:48:01Z, internetMessageId present.
    - `from` is empty, as on the original: the Q63 fixture was created through Graph with no sender.
  - **4. Re-run:** exit 0, `restored 0, alreadyDone 1, writes 0`.
  - **5. Into the original:** deleted the Q68 draft copy from the Inbox (204). Then `--into original --kinds mail` (approval **54b6f7ad**): exit 0,
    `{"restored":1,"kept":{"unchanged":0,"newer":0},"alreadyDone":0,"failed":0,"writes":1,"incomplete":[],"status":"completed"}`.
    - The message is back in the Inbox: **parentFolderId = Inbox**, **isDraft false**, isRead true, **received 2026-10-15T07:48:01Z**,
      sent 07:48:01Z.
  - **6. Cleanup:** deleted the `Restored 2026-10-15` folder tree (204; also gone from Deleted Items).
    - **Left:** the step-5 message in the Inbox, the standing fixture (isDraft false).
    - Earlier deleted copies are in Recoverable Items only.
  - Commented on #293.
- **Test tenant only.** Same hard rules, Restorer identity and requester/approver split as Q68. Under the 2026-10-14
  standing authorization, keel-operator approves these test-tenant restores itself; log every approval id here. Write only
  into keel-rt-20260908-alice's mailbox. Grant no permission.
- `<A>` = alice's user id, `<R>`/`<P>` as Q68. **`<T>` = `2026-10-15T10:15:30Z`** (after the Q64 backup of the original
  KEEL-RT-20261015-mail, before Q68's restores; not Q68's exact `<T>`, so this is a new run and not a resume of Q68's).
- Do, as the deployed build B (`node /opt/keel-live/cli/keel-content-restore.mjs ...`, KEEL_DB_URL from /etc/keel/db.env):
  1. Record B (the commit /opt/keel-live is deployed at).
  2. **Plan:** `mail plan --source-mailbox <A> --at <T> --kinds mail`. Expect 1 mail item.
  3. **Copy restore:** `mail request --source-mailbox <A> --at <T> --kinds mail --actor <R>`, approve as `<P>`, `mail run`.
     Expect exit 0, `restored: 1`, `incomplete: []`. Then read the copy in `Restored <today>/Inbox`:
     `GET .../messages/{id}?$select=subject,isDraft,isRead,receivedDateTime,sentDateTime,from,internetMessageId`.
     Expect **isDraft false** and **receivedDateTime 2026-10-15T07:48:01Z** (the original's), from and subject as the original.
  4. **Re-run** the same `mail run`: expect exit 0, `restored: 0`, `writes: 0`.
  5. **Into the original folder:** delete the Q68 draft copy of KEEL-RT-20261015-mail from alice's Inbox (Graph DELETE as the
     Restorer). Then request, approve and run `--into original --kinds mail` at the same `<T>`. Expect the message back in the
     Inbox with **isDraft false** and receivedDateTime 07:48:01Z. Report the same fields as step 3 plus parentFolderId.
  6. **Cleanup:** delete the `Restored <today>` mail folder tree from step 3. Keep the step-5 message in the Inbox (it replaces
     the Q68 draft as the standing fixture).
- **Report:** B; exit codes and report JSON for steps 2–5; approval ids; the step 3 and step 5 field values; anything left in
  the tenant. No tokens or keys. Comment the result on #293.

### Q73: App consent policy create, live rerun after #302 (permissionGrantPolicy only)
- Drafted by the "#294 consent policy" thread (2026-10-15). Fix: PR #302, master 1a33ff5. A create now waits (up to about
  60 s, on 404 only) for the new policy to replicate before posting its include and exclude rules.
- Needs: /opt/keel-live at 1a33ff5 or later (`grep -q untilReplicated /opt/keel-live/engine/restore/directoryPolicyOperations.mjs`).
- Status: done
- Result: Done 2026-10-15 13:38–13:43 UTC on **B = 321435f6** (includes 1a33ff5, #302). Restorer only; global admin not used. Approval **eb3fa523**,
  self-approved under the standing authorization.
  - Plan re-taken at B (Q74 plan). Fixture `keel-rt-w2-consent` (KEEL-RT-W2-consent, one include delegated/low, not referenced by the
    authorization policy), created fresh. Snapshot S5 78ff6b94 (1 include); then the policy was deleted (204).
  - **Restore** from S5, selecting only that policy: the dry run shows `create recreate`. Enforce (worker): **`applied 1, skipped 0,
    failed 0`**, no 404, and no include-write retry in the log. rollback_entry: create succeeded.
  - **Read-back:** exactly 1 include, `(delegated, low)`, as the backup. Capture exit 0, readBackVerified true, promote → live-qualified.
  - **Evidence:** `claude/live-evidence-w2-entra` @ **a53970c** (permissionGrantPolicy.create.json, .capture.json and the capture log;
    pseudonymize check passes, scan clean).
  - `live evidence permissionGrantPolicy.create.json: not applied (permissionGrantPolicy.create.demotion.json demotes this write, so it is not promoted)`.
    The Q67 demotion is still next to it. keel-operator only adds or updates evidence files, so a builder removes it (asked on #294).
  - The fixture was kept for Q75, then deleted (see Q75). Nothing left.
  - **18:03 UTC recheck** (after ffcefb9 removed the stale create demotion): `operations.mjs --live-evidence` (HMAC key set) reports
    `live evidence permissionGrantPolicy.create.json: fixture-tested -> live-qualified`. The update record (Q79) still says
    `not applied (permissionGrantPolicy.update.demotion.json demotes this write, so it is not promoted)`; that demotion is still there.
- **Test tenant only.** Same rules, capture tooling and requester/approver split as Q67. Self-approve under the 2026-10-14
  standing authorization; log every approval id here. No permission to add (Q26).
- Fixture: custom policy id `keel-rt-w2-consent`, display name `KEEL-RT-W2-consent`, one include (delegated, low), not
  referenced by any authorization policy setting. Create it fresh (Q67 cleaned it up).
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. Re-take plan-B (`live-gate-plan.mjs`) and use only its permissionGrantPolicy create step.
  2. Create the fixture, take snapshot S, then delete the policy.
  3. Restore from S selecting only that policy, dry run, approve, `--enforce`. Expect **applied 1, failed 0** with no 404, and
     the policy reading back with exactly the backup's 1 include. `entraLive.mjs capture` the `create`.
  4. Commit the create evidence (`permissionGrantPolicy.create.json` and `.capture.json`) on `claude/live-evidence-w2-entra`
     (secret scan first), and run `operations.mjs --live-evidence` on that directory. Do not promote the update record
     (its demotion stands, #294 comments).
  5. Cleanup: delete `keel-rt-w2-consent`. Report anything left.
- **Report:** B; the enforce summary line and any include-write retries in the log; read-back include count; approval ids;
  the evidence commit and the `live evidence` line for the create. Comment the result on #294.

### Q74: Recapture the four token and home realm policies after #303 (no new restore)
- Drafted by the "#295 capture tool" thread (2026-10-15). Fix: PR #303, master afd3641. `entraLive.mjs capture` now treats
  tokenLifetimePolicy, tokenIssuancePolicy, claimsMappingPolicy and homeRealmDiscoveryPolicy as named objects: it checks the
  policy's own display name (KEEL-RT- prefix) and no longer needs `--allow-by-reference`.
- Needs: /opt/keel-live at afd3641 or later (`grep -q NAMED_ID_KEY_TYPES /opt/keel-live/tools/qualification/live-gate-plan.mjs`).
- Status: done
- Result: Done 2026-10-15 13:37–13:41 UTC on **B = 321435f6** (includes afd3641, #303). No tenant writes: the records were recaptured from Q67's
  restores A1 to A4. Global admin not used.
  - **1. Plan at B:** the capture commands for tokenLifetimePolicy, tokenIssuancePolicy, claimsMappingPolicy and
    homeRealmDiscoveryPolicy no longer carry `--allow-by-reference`. oauth2PermissionGrant still does.
  - **2–3. Captures and promotion** (no `--allow-by-reference`): **all 8 captured (exit 0) and promoted → live-qualified.**
    - tokenLifetimePolicy create (A1), update (A2).
    - tokenIssuancePolicy create (A1), update (A2).
    - claimsMappingPolicy create (A1), update (A2).
    - homeRealmDiscoveryPolicy create (A3), update (A4).
  - **Evidence:** `claude/live-evidence-w2-entra` @ **7513331**, with the 8 records, their .capture.json files and the capture logs.
    pseudonymize check passes; the secret and known-id scans are clean.
  - **operations.mjs --live-evidence:** each of the 8 is `fixture-tested -> live-qualified`.
    permissionGrantPolicy create and update show `not applied (… .demotion.json demotes this write …)`.
  - **4. oauth2PermissionGrant: still blocked** (plan still prints `--allow-by-reference`; Q67's refusal was "no role reference").
- **Test tenant only. No tenant writes:** this reuses Q67's restores (A1, A2, A3, A4); their journals and snapshots are in the
  KEEL database. Same capture tooling as Q67.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. Re-take plan-B (`live-gate-plan.mjs`); confirm its capture commands for the four types no longer carry `--allow-by-reference`.
  2. `entraLive.mjs capture` without `--allow-by-reference`: create from A1 and update from A2 for tokenLifetimePolicy,
     tokenIssuancePolicy and claimsMappingPolicy; create from A3 and update from A4 for homeRealmDiscoveryPolicy.
     `--fixture` is each policy's natural key (its id, as journaled). 8 captures.
  3. `promote` each record that captures. Commit the records and capture logs on `claude/live-evidence-w2-entra`
     (secret scan and `pseudonymize.mjs check` first), and run `operations.mjs --live-evidence` on that directory.
  4. oauth2PermissionGrant is not covered (it still asks for a role reference); report it as still blocked.
- **Report:** B; per type and operation: promoted / refused (the exact message); the evidence commit and the
  `live evidence` lines. Comment the result on #295.

### Q75: App consent policy update converges to the backup after #312 (permissionGrantPolicy update, plus the S1 dry run)
- Drafted by the "consent policy convergence" thread (2026-10-15). Fix: PR #312, master 321435f. An update now removes
  include and exclude rules added since the backup (narrowing first), and the read-back checks the whole rule sets, so
  a rule left behind fails the item. A dry run now plans an STS policy that the run would adopt as a noop
  ("adopts live <id>"), not `create recreate`.
- Needs: /opt/keel-live at 321435f or later (`grep -q conditionSetsPostStateRefusal /opt/keel-live/engine/restore/directoryPolicyOperations.mjs`).
  Can run in the same sitting as Q73 (same fixture).
- Status: failed: Graph refuses removing the last include (#294)
- Result: **Failed** 2026-10-15 13:43–13:46 UTC on **B = 321435f6** (includes 321435f, #312). Restorer only; global admin not used. Approval **26a15925**,
  self-approved.
  - Snapshot S6 2a098792 with the fixture (1 include, delegated/low). Drift: added (delegated, medium) and removed low (the first
    delete returned 400 until medium had replicated; then 204). Live: medium only.
  - Dry run from S6: `update update-existing`. Enforce (worker): **`applied 0, skipped 0, failed 1`**:
    `Request_BadRequest "PermissionGrantPolicy should contain an Includes PermissionGrantConditionSet."`
    - Narrowing first deletes the only live include before adding the backup's, and Graph refuses a consent policy with no include.
    - rollback_entry: update failed. **Read-back:** `(delegated, medium)` only, the drifted state, unchanged.
  - Capture: exit 3 (write failed); the record was **not committed**, and the Q67 update demotion stands.
  - **Step 4, re-run dry run:** 1 planned write (not 0).
  - **Step 5:** skipped, because Q67's STS fixtures no longer exist.
  - **Cleanup:** deleted `keel-rt-w2-consent` (204). Nothing left.
  - Suggested fix on #294: when removing the extra includes would leave none, add the missing backup includes first, then remove the extras.
- **Test tenant only.** Same rules, capture tooling and requester/approver split as Q67. Self-approve under the 2026-10-14
  standing authorization; log every approval id here. No permission to add (Q26).
- Fixture: custom policy id `keel-rt-w2-consent`, display name `KEEL-RT-W2-consent`, one include (delegated, low), not
  referenced by any authorization policy setting. Reuse it from Q73 if still there, or create it fresh.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. Re-take plan-B (`live-gate-plan.mjs`) and use only its permissionGrantPolicy update step.
  2. Take snapshot S with the fixture as above. Drift it the Q67 way: remove the (delegated, low) include and add
     (delegated, medium) in its place.
  3. Restore from S selecting only that policy, dry run, approve, `--enforce`. Expect **applied 1, failed 0**, and the
     policy reading back with exactly 1 include, (delegated, low); the medium one is gone. `entraLive.mjs capture` the
     `update`.
  4. **Re-run check:** dry run from S again. Expect 0 planned writes for the policy.
  5. Optional, only if Q67's STS fixtures exist again (no new setup for this): a dry run from a snapshot taken before they
     were recreated should list them as noop "adopts live <id>", not `create recreate`. Otherwise skip and say so.
  6. Commit the update evidence (`permissionGrantPolicy.update.json` and `.capture.json`) on `claude/live-evidence-w2-entra`
     (secret scan first), replacing the demoted record only if this capture verifies, and run `operations.mjs --live-evidence`
     on that directory.
  7. Cleanup: delete `keel-rt-w2-consent`. Report anything left.
- **Report:** B; the enforce summary line; read-back include list; the step 4 planned-write count; step 5 result or skipped;
  approval ids; the evidence commit and the `live evidence` line for the update. Comment the result on #294.

### Q76: Content backup reads SharePoint groups and role assignments on the KEEL-RT- sites (read-only, after #320)
- Drafted by the "SharePoint site groups backup" thread (2026-10-15). Fix: PR #320, master 79f6385. The sites backup now
  reads each site's permission levels, SharePoint groups with their members, site collection admins, and the role
  assignments on the site and on each list with unique permissions, through SharePoint REST, and stores them as the
  `site/permissions` item in the site's container. These reads use the **Collector** certificate from
  `/etc/keel/tenant.json` (it already holds Office 365 SharePoint Online Sites.FullControl.All, 678536fe…), through a
  GET-only transport limited to the tenant host and `/_api/web/...`. Everything else still reads as the Content Reader.
- Needs: /opt/keel-live at 79f6385 or later (`grep -q sharePointReadTransport /opt/keel-live/engine/content/transport.mjs`).
- Status: done
- Result: Done 2026-10-15 14:01–14:06 UTC on **B = 14aa4f51** (includes 79f6385; `sharePointReadTransport` present). Read-only: the Content Reader,
  plus the Collector certificate for SharePoint REST GETs. No permission, consent or fixture change. Global admin not used.
  - **2.** `/etc/keel/tenant.json` has certPath and keyPath: **yes**.
  - **3. Run A**, exit 0:
    `exchange-mail: succeeded (8 items, 6489 bytes)`, `onedrive: succeeded (0 items, 0 bytes)`,
    `sharepoint-sites: succeeded (4 items, 19942 bytes)`, `teams: succeeded (11 items, 271885 bytes)`,
    `planner: succeeded (8 items, 11975 bytes)`.
  - **4. site/permissions:** 1 row in each of the **4** KEEL-RT- site containers. Read back through the content store (decrypted, same key):
    - **KEEL-RT-20261004:** hasUniqueRoleAssignments true.
      - Groups: Owners (1), Visitors (0), Members (0). Site collection admins 1.
      - Role assignments 3 (Full Control, Read, Edit).
      - Lists with unique permissions: TaxonomyHiddenList, User Information List, Converted Forms.
    - **KEEL-RT-20260908 Collaboration Hub:** hasUniqueRoleAssignments true.
      - Groups: Owners (2), Visitors (0), Members (1), plus one SharingLinks.<…>.OrganizationView group (0). Admins 1.
      - Role assignments 4 (Full Control, Read, Edit, Limited Access).
      - Unique lists: Converted Forms, User Information List, TaxonomyHiddenList, Documents.
    - **…Finance Private** (channel site): hasUniqueRoleAssignments true.
      - Groups: Owners (1), Visitors (0), Members (1). Admins 1.
      - Role assignments 3 (Full Control, Read, Edit). Unique lists: User Information List.
    - **…Partner Shared** (channel site): hasUniqueRoleAssignments true.
      - Groups: Owners (1), Visitors (0), Members (1). Admins 1.
      - Role assignments 3 (Full Control, Read, Edit). Unique lists: User Information List.
    - Each item holds groups, lists, roleAssignments, roleDefinitions, siteCollectionAdmins and web.
  - **5. Run B**, exit 0: `sharepoint-sites: succeeded (0 items, 0 bytes)`; the other lines are as in A, with exchange-mail at 0 items.
    site/permissions rows: 4 before and 4 after, so **0 new** (change-only).
  - No denied or failed permission read.
- **Read-only against the tenant.** No permission, consent or fixture changes. Global admin not used.
- **Do:**
  1. Record the commit `/opt/keel-live` is deployed at and confirm the check above. If it has not arrived within 30 minutes
     of its Portal CI passing, report `blocked` with the master CI state for 79f6385.
  2. Confirm `/etc/keel/tenant.json` has `certPath` and `keyPath` (names only; never print key material). Without them the
     run declares the part missing and this item is `blocked`.
  3. **Run A:** `node /opt/keel-live/cli/keel-content-collect.mjs run` once, as Q64 step 3 (worker's user, DB env loaded;
     with Q58's KEEL-RT- scope file; not while a scheduled job runs). Report the exit code and every workload line verbatim.
  4. For each KEEL-RT- site container (`site:<siteId>`), confirm a `site/permissions` content_item row exists. Read the
     newest one back through the content store (`createContentStore(...).getItem(ref)`, same reader file and key as the run)
     and report, per site: `web.hasUniqueRoleAssignments`; each group's title and member count; the number of site
     collection admins; the number of role assignments and the role names used; the titles of lists with unique
     permissions. Names of KEEL-RT- objects and default groups only; no e-mail addresses or login names.
  5. **Run B:** the same command again. Expect sharepoint-sites to store 0 new `site/permissions` rows (change-only).
- **Report:** the deployed commit; step 2 yes/no; for A and B the exit code and each workload line verbatim; the step 4
  summary per site; any denied or failed permission read with its HTTP status and path (no tokens).

### Q77: SharePoint site app grant restore, live capture and round trip on a KEEL-RT- site (after #321)
- Drafted by the "Site app grant restore" thread (2026-10-15). Code: PR #321, master cc6404a. New per-site restore
  `cli/keel-restore.mjs --workload sharepoint-site-grants --collection <id> --tenant-host <host> --site <site id>`:
  re-creates a site app grant (Sites.Selected) missing since the backup and raises a narrowed one to the backup's role.
  Never wider than the backup, never narrows or removes. Both writes (`sharepoint.site-permissions.add`, `.update`) are
  **off** until the capture below is imported.
- Needs: /opt/keel-live at cc6404a or later (`test -f /opt/keel-live/engine/restore/workloads/sharepointSiteGrants.mjs`).
- Status: done
- Result: Done 2026-10-15 14:04–14:20 UTC on **B = 14aa4f51** (includes cc6404a, #321). Writes only on the KEEL-RT-20261004 site, for the fixture app.
  Global admin not used; no Restorer permission added. Approvals filed by the Entra principal and self-approved as the Gmail approver
  (restore request plus content effect) under the standing authorization.
  - **1.** Created `KEEL-RT-site-grant-app`: no API permissions, no secret, no certificate. It held 0 grants on the site.
  - **2. Capture:** `plan` (exit 0) lists the 4 documented requests. `capture --confirm-live-tenant-write`: **exit 0**,
    **verify ok, failures []**.
    - `sharepoint.site-permissions.add` (read) and `.update` (write): ok, readBackVerified true.
    - Doc URLs (the 4 from requiredDocumentation) all returned 200 at capture time.
  - **3. Import** (`keel-workload-collect.mjs import --dir <evidence checkout>/docs/release/qualifications`): exit 0.
    - `sharepoint-site-grants-live-acceptance.json`: imported, reads 2, writes 2; refused [].
    - The enforce runs log `SharePoint site app grants: 2 of 2 write(s) qualified for this tenant`.
  - **4. Backup:** `keel-workload-collect.mjs run` exit 0, sharepoint-site-settings complete. **Collection C = 99282f12**.
    The site's appPermissionGrants holds KEEL-RT-site-grant-app with `write`.
  - **5. Add round:** deleted the grant by hand (204). Dry run: `1 change(s), 0 manual, 0 refused`. Content effect: externally-sharing,
    roles → write. Approval **deb091af**. `--artifact --enforce`: **verified**; reads back `write`.
    - Note: the workload enforce reads the collector config from `KEEL_COLLECTOR_CONFIG_PATH`, defaulting to
      `/etc/keel/tenant-target.json`, which doesn't exist on Mulinux. Run with `KEEL_COLLECTOR_CONFIG_PATH=/etc/keel/tenant.json`.
  - **6. Re-run:**
    - Dry run from C: `0 change(s)`. Promoting it (approval **b72e2059**): **no-change**, no write.
    - Re-promoting the step-5 artifact: **stale** ("the site grants changed since the dry run; a new dry run is required"), no write.
  - **7. Update round:** PATCH to `read` by hand. Dry run: `1 change(s)`. Approval **6e051de4** (with its content effect). Enforce: **verified**;
    reads back `write`. Dry run again: `0 change(s)`.
  - **8. Wider check:** PATCH to `fullcontrol` by hand. Dry run: `0 change(s), 1 manual, 0 refused`, with the manual line
    "the grant is wider now than in the backup; KEEL never narrows a grant, a person decides". Not promoted.
  - **9. Cleanup:** deleted the grant (204); 0 grants left on the site. **Kept** `KEEL-RT-site-grant-app` (no permissions) for the
    30-day recapture.
  - **10. Evidence:** `claude/live-evidence-site-grants` @ **5e47ab8** (record and .capture.json; pseudonymize check passes, scan
    clean). No PR.
- **Test tenant only.** Same hard rules, requester/approver split and standing authorization as Q67; log every approval id.
  Global admin not used. **Restorer permissions:** none to add (it holds Graph Sites.FullControl.All, Q26). If Graph
  refuses a write with 403, report blocked with what Graph names; do not grant anything.
- **Fixtures:**
  - Site: the existing `KEEL-RT-20261004` site (Q69). No other site.
  - App: one new app registration `KEEL-RT-site-grant-app` with **no API permissions and no secret**. Fixture exception (as
    Q67's KEEL-RT-W2-app): a Sites.Selected grant to this app on the KEEL-RT- site only. Never Keel's own apps or any other app.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. Create the app. Make sure it holds no grant on the site (the capture refuses if it does).
  2. **Capture:** `node tools/qualification/sharepointSiteGrantsLive.mjs plan ...` first, then `capture --confirm-live-tenant-write`
     with `--tenant-host`, `--fixture-site-url https://<host>/sites/KEEL-RT-20261004`, `--app-id <client id>`,
     `--app-name KEEL-RT-site-grant-app`, `--collector-ref`/`--restorer-ref`, `--grants` and `--docs` (same file shapes as the
     gate-120 capture; the required doc URLs are printed by
     `node -e "import('./tools/qualification/sharepointSiteGrantsAcceptance.mjs').then(m=>console.log(m.requiredDocumentation()))"`),
     `--build B`, `--out docs/release/qualifications/sharepoint-site-grants-live-acceptance.json`. It grants the app `read`,
     raises it to `write`, and leaves that grant in place. Report the exit code and the verify output.
  3. **Import:** `node cli/keel-workload-collect.mjs import --dir <your checkout>/docs/release/qualifications` (DB env loaded).
     Report the imported/refused lines. Then confirm both writes now read `enabled: true` for this tenant (the restore's
     `--enforce` log line "SharePoint site app grants: 2 of 2 write(s) qualified" is enough).
  4. **Backup:** `node /opt/keel-live/cli/keel-workload-collect.mjs run` once. Note collection C (sharepoint-site-settings);
     confirm the site's `appPermissionGrants` holds the app with `write`.
  5. **Add round:** delete the app's grant on the site by hand (Graph DELETE `/sites/{id}/permissions/{grant id}`). Dry run
     `keel-restore.mjs --workload sharepoint-site-grants --collection C --tenant-host <host> --site <site id>
     --collector-config /etc/keel/tenant.json`. Expect `1 change(s)`. Approve the restore request and its content effect
     (externally-sharing, roles → write), then `--artifact <id> --enforce`. Expect `verified`; the grant reads back `write`.
     If either approval cannot be reached for this CLI workload dry run, stop and report blocked with what was missing.
  6. **Re-run check:** dry run again from C. Expect `0 change(s)`; promote it too and expect `no-change` with no write.
     Promote the step 5 artifact again and expect `stale` with no write.
  7. **Update round:** PATCH the grant to `read` by hand. Dry run from C: expect 1 change (update). Approve both, enforce,
     expect `verified` (reads back `write`). Dry run again: expect 0.
  8. **Wider check (no write expected):** PATCH the grant to `fullcontrol` by hand, dry run from C. Expect 0 changes and one
     manual line "wider now than in the backup". Do not promote.
  9. Cleanup: delete the app's grant on the site. Keep `KEEL-RT-site-grant-app` (no permissions) for the 30-day recapture.
  10. Commit the record and its `.capture.json` on `claude/live-evidence-site-grants`, branched from `origin/master`
      (secret scan first, as Q39). No PR.
- **Report:** B; step 2 exit code and verify; step 3 import lines; collection C; per round the plan line, outcome, read-back
  role and approval ids; steps 6 and 8 results; the evidence commit; anything left in the tenant.

### Q78: Recapture the delegated consent grant after #324 (oauth2PermissionGrant, no new restore)
- Drafted by the "consent grant capture" thread (2026-10-15). Fix: PR #324, master 3f969a5. `entraLive.mjs capture` now checks
  an oauth2PermissionGrant by its client app (KEEL-RT- name) and its one user (keel-rt- fixture, consentType Principal),
  not by a role. It still needs `--allow-by-reference` (a grant has no name of its own); the plan's step says so.
- Needs: /opt/keel-live at 3f969a5 or later (`grep -q "the client app is not a KEEL-RT fixture" /opt/keel-live/tools/qualification/entraLive.mjs`).
- Status: done
- Result: Done 2026-10-15 14:18–14:22 UTC on **B = a498b1a0** (includes 3f969a5, #324). No tenant writes: recaptured from Q67's A1b (create) and A2 (update).
  Global admin not used.
  - **1. Plan at B:** the oauth2PermissionGrant steps show the reviewed fixture guidance ("a delegated consent (consentType Principal)
    for a KEEL-RT- app with no other permissions, for one keel-rt- fixture user, to Microsoft Graph with scope openid only").
  - **2–3.** `capture --allow-by-reference`: **create exit 0, update exit 0**. Both promoted → **live-qualified**.
  - **Evidence:** `claude/live-evidence-w2-entra` @ **759584e** (2 records, their .capture.json files and logs; pseudonymize check passes, scan clean).
  - **live evidence:**
    live evidence oauth2PermissionGrant.create.json: fixture-tested -> live-qualified
    live evidence oauth2PermissionGrant.update.json: fixture-tested -> live-qualified
- **Test tenant only. No tenant writes:** this reuses Q67's restores (A1b for create, A2 for update); their journals and
  snapshots (S1, S2, which still hold KEEL-RT-W2-app and the keel-rt user) are in the KEEL database. Same capture tooling as Q67/Q74.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. Re-take plan-B (`live-gate-plan.mjs`); confirm the oauth2PermissionGrant steps show the reviewed fixture guidance.
  2. `entraLive.mjs capture --allow-by-reference` for oauth2PermissionGrant: create from A1b, update from A2.
     `--fixture` is the grant's natural key (its id, as journaled). 2 captures.
  3. `promote` each record that captures. Commit the records and capture logs on `claude/live-evidence-w2-entra`
     (secret scan and `pseudonymize.mjs check` first), and run `operations.mjs --live-evidence` on that directory.
- **Report:** B; per operation: promoted / refused (the exact message); the evidence commit and the `live evidence` lines.
  Comment the result on #295.

### Q79: App consent policy update converges when its only include drifted (Q75 re-run, after #327)
- Drafted by the "consent policy extra rule" thread (2026-10-15). Fix: PR #327. Q75 failed because narrowing first deleted the
  only live include and Graph refused it (`should contain an Includes PermissionGrantConditionSet`). Now, when every live
  include is extra, the backup's includes are added first and the last extra one is removed right after, retrying that
  400 while the new include replicates (up to 13 x 5 s).
- Needs: /opt/keel-live at the #327 merge or later (`grep -q isLastIncludeRefusal /opt/keel-live/engine/restore/directoryPolicyOperations.mjs`).
- Status: done
- Result: Done 2026-10-15 14:29–14:42 UTC on **B = 8dbb0e8e** (includes #327, `isLastIncludeRefusal`). Restorer only; global admin not used.
  Approval **9b2b8c92**, self-approved under the standing authorization.
  - Fixture `keel-rt-w2-consent` created fresh (one include, delegated/low; not referenced by the authorization policy).
  - Snapshot S7 c36caaf3 (1 include, low).
  - Drift: added (delegated, medium), then removed low (the first DELETE returned 400 until medium had replicated, the second 204).
    Live: medium only.
  - **Step 3:** the dry run shows `update update-existing`. Enforce (worker): **`applied 1, skipped 0, failed 0`**; rollback_entry: update succeeded.
    - **Read-back: exactly `[(delegated, low)]`**; medium is gone.
    - Retries of the last DELETE: not shown in the run log (no retry or refusal line printed), so the count is unknown.
    - Capture exit 0, readBackVerified true, promote → live-qualified.
  - **Step 4, re-run dry run:**
    - The first attempt aborted on a transient `collecting accessPackageCatalog failed:` (empty error), and I'd already deleted the
      fixture. So I recreated the fixture as backed up (one low include) and reran.
    - **1 planned write** (`update update-existing`), not 0. The live policy matches the backup except the include's id, which
      Graph assigns anew. The comparison doesn't ignore condition-set ids (reported on #294).
  - **Evidence:** `claude/live-evidence-w2-entra` @ **d873727** (permissionGrantPolicy.update.json, .capture.json and the log; pseudonymize
    check passes, scan clean).
    `live evidence permissionGrantPolicy.update.json: not applied (permissionGrantPolicy.update.demotion.json demotes this write, so it is not promoted)`.
    The Q67 demotion still has to be removed by a builder.
  - **Cleanup:** `keel-rt-w2-consent` deleted (204) after the recheck. Nothing left.
  - **Follow-up 15:05 UTC on ea681454 (#331, the rule-id fix):** recreated the fixture as backed up (one low include, new rule id).
    The dry run from S7 plans **0 writes** (it planned 1 before #331). Dry run only, so no approval. Fixture deleted (204). Commented on #294.
- **Test tenant only.** Same rules, capture tooling, requester/approver split and standing authorization as Q75; log every
  approval id. No permission to add. Never touch CA policies, break-glass or the user's account.
- Fixture: as Q75. Custom policy id `keel-rt-w2-consent`, display name `KEEL-RT-W2-consent`, one include (delegated, low),
  not referenced by any authorization policy setting. Create it fresh.
- Do: Q75 steps 1 to 4, 6 and 7 at the deployed build B (skip step 5). Drift: add (delegated, medium), then remove low,
  so medium is the only include.
  - Step 3 expects **applied 1, failed 0**, and the read-back holds exactly 1 include, (delegated, low).
  - Step 4 expects 0 planned writes.
- **Report:** B; the enforce summary line; the read-back include list; how many times the last DELETE was refused before it
  landed (from the run log, if shown); the step 4 count; approval ids; the evidence commit and the `live evidence` line for
  the update. Comment the result on #294.

### Q80: SharePoint site groups and permissions restore, live capture and round trip on a KEEL-RT- site (after #332), plus the Collector manifest
- Drafted by the "Site groups restore" thread (2026-10-15). Code: PR #332. New per-site restore
  `cli/keel-restore.mjs --workload sharepoint-site-permissions --tenant-host <host> --site <site id> [--at <ISO time>]`:
  from the content backup's `site/permissions` item (Q76) it adds back what is missing: custom permission levels, groups,
  group members, site collection admins and role assignments on the site and on lists with their own permissions.
  It never removes, narrows or changes inheritance; anything wider than the backup is listed as a manual line. On the
  test tenant it writes only KEEL-RT- sites, levels, groups and users. All five writes
  (`sharepoint.site-role-definitions.add`, `.site-groups.add`, `.site-group-members.add`, `.site-admins.add`,
  `.site-role-assignments.add`) are **off** until the capture below is imported. Writes go through SharePoint REST as the
  **Restorer** certificate (`/etc/keel/restorer.json`, SharePoint Online Sites.FullControl.All, held since Q7/Q26), through a
  transport that allows only those POSTs on the one site.
- Needs: A has no deploy dependency. B needs /opt/keel-live at the merge of PR #332 or later
  (`test -f /opt/keel-live/engine/restore/workloads/sharepointSitePermissions.mjs`).
- Status: done
- Result: Done 2026-10-15 15:16–15:40 UTC on **B = c82311f0** (includes #332). Writes only on the KEEL-RT-20261004 site, to KEEL-RT- objects and
  keel-rt- test users. Global admin not used; no permission or consent change. Approvals filed by the Entra principal and self-approved
  as the Gmail approver (request plus content effects) under the standing authorization.
  - **A. Collector manifest:** SharePoint Online `Sites.FullControl.All` (678536fe…) was **already listed**, so no PATCH was made.
    Before and after: 3 resources, 50 entries (SharePoint 3); 0 removed. appRoleAssignments unchanged (49).
  - **B1. Fixtures:**
    - Created `KEEL-RT-perm-list` on KEEL-RT-20261004 and broke its inheritance (copyRoleAssignments=true): HasUniqueRoleAssignments true.
    - Test user **keel-rt-20260908-diego**. ben was the site's only site collection admin, so not usable.
  - **B2. Capture:** `plan` lists 7 writes. `capture --confirm-live-tenant-write`: **exit 0, verify ok, failures []**.
    All five operations ok with readBackVerified true: role-definitions.add, site-groups.add, site-group-members.add,
    site-admins.add and site-role-assignments.add (site and list).
    - Note: the signed record carries the test user's claims login (`i:0#.f|membership|keel-rt-20260908-diego@<tenant domain>`) in
      `subject.fixture.member` and two write subjects. `pseudonymize.mjs check` passes it. It is a fixture user on the public
      domain, but the pseudonymizer could cover claims logins too.
  - **B3. Import:** `sharepoint-site-permissions-live-acceptance.json` imported (writes 5); refused [], exit 0.
  - **B4. Backup** (exit 0, `sharepoint-sites: succeeded (9 items, 23451 bytes)`). The newest site/permissions row of KEEL-RT-20261004 holds
    the level, the group with the test user, the user as admin, and the group's role on the site (KEEL-RT-perm-1 level, plus Limited Access)
    and on KEEL-RT-perm-list (KEEL-RT-perm-1 level).
  - **B5. Round trip:** deleted the group and the level, and removed the user as admin, by hand.
    - Dry run as the Collector: `6 change(s), 1 manual, 0 refused`. The 6 are level, group, member, admin, role on site, role on list.
      The manual line: "its owner was SharePoint App; KEEL creates the group, a person sets its owner back".
    - Approval **f0ee9777** (4 content effects). Enforce with `KEEL_COLLECTOR_CONFIG_PATH=/etc/keel/tenant.json`:
      `SharePoint site groups and permissions: 5 of 5 write(s) qualified for this tenant`, **verified**.
    - Read-back: group, level, member and admin all present.
  - **B6. Re-run:** dry run `0 change(s), 0 manual, 0 refused`. Promoting it (approval **8caab7c8**): **no-change**, no write.
    Re-promoting the step-5 artifact: **stale**, no write.
  - **B7. Wider check:** added keel-rt-20260908-farah to the group by hand. Dry run: `0 change(s), 1 manual, 0 refused` with
    "a member now but not in the backup; KEEL never removes a member". Not promoted.
  - **B8. Cleanup:** removed the test user as admin (204), deleted KEEL-RT-perm-1 group (200), KEEL-RT-perm-1 level (200) and KEEL-RT-perm-list (204).
    Left on the site: 1 admin (the original), 0 KEEL-RT-perm groups or levels.
  - **B9. Evidence:** `claude/live-evidence-site-permissions` @ **139eedc** (record and .capture.json). No PR.
- **Test tenant only.** Same hard rules, requester/approver split and standing authorization as Q67; log every approval id.
  Global admin not used. Never touch CA policies, break-glass accounts or Marouane's account. No consent is granted.
- **A. Collector manifest (Entra, one PATCH as the Restorer):** the Collector already holds Office 365 SharePoint Online
  `Sites.FullControl.All` (resource `00000003-0000-0ff1-ce00-000000000000`, role `678536fe-1083-478a-9c59-b99265e6b0d3`) but its
  manifest does not list it. GET the Collector application's `requiredResourceAccess`, add that role under the SharePoint
  resource (keep every existing resource and entry), PATCH once. Nothing removed, no consent call. Check: the manifest now
  lists it and the service principal's appRoleAssignments are unchanged.
- **B. Fixtures:** the existing `KEEL-RT-20261004` site only. On it, create one custom list `KEEL-RT-perm-list` and break its
  inheritance by hand (copy role assignments). Test user: one existing `keel-rt-*` test user, not a site collection admin of
  that site (claims form `i:0#.f|membership|<upn>`). The capture creates `KEEL-RT-perm-1 level` and `KEEL-RT-perm-1 group`.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. Create the list above and note its id. Mint two SharePoint tokens (audience `https://<host>`), never printed:
     `getToken(config, { scope: 'https://<host>/.default' })` from `tools/tenant-probe/auth.mjs`, with `/etc/keel/tenant.json`
     as `KEEL_SPO_COLLECTOR_TOKEN` and `/etc/keel/restorer.json` as `KEEL_SPO_RESTORER_TOKEN`.
  2. **Capture:** `node tools/qualification/sharepointSitePermissionsLive.mjs plan ...` first (expect 7 writes), then
     `capture --confirm-live-tenant-write` with `--tenant-ref`, `--tenant-host`,
     `--fixture-site-url https://<host>/sites/KEEL-RT-20261004`, `--label KEEL-RT-perm-1`, `--member <claims login>`,
     `--list-id <list id>`, `--collector-ref`/`--restorer-ref`, `--grants`, `--docs` (doc URLs from
     `node -e "import('./tools/qualification/sharepointSitePermissionsAcceptance.mjs').then(m=>console.log(m.requiredDocumentation()))"`),
     `--build B`, `--out docs/release/qualifications/sharepoint-site-permissions-live-acceptance.json`.
     Report the exit code and the verify output. If SharePoint refuses a write (401/403), report blocked with the status and
     the path; do not grant anything.
  3. **Import:** `node cli/keel-workload-collect.mjs import --dir <your checkout>/docs/release/qualifications` (DB env loaded).
     Report the imported/refused lines.
  4. **Backup:** `node /opt/keel-live/cli/keel-content-collect.mjs run` once (Q76 step 3 conditions). Confirm the newest
     `site/permissions` row of KEEL-RT-20261004 holds the level, the group with the test user, the user as admin, and the
     group's role on the site and on `KEEL-RT-perm-list`.
  5. **Round trip:** by hand, delete `KEEL-RT-perm-1 group` and `KEEL-RT-perm-1 level`, and remove the test user as site
     collection admin. Dry run as the Collector:
     `node /opt/keel-live/cli/keel-restore.mjs --workload sharepoint-site-permissions --tenant-host <host> --site <site id> --collector-config /etc/keel/tenant.json`.
     Expect 6 changes (level, group, member, admin, role on the site, role on the list), 0 refused. Approve the restore
     request and its content effect (externally-sharing), then `--artifact <id> --enforce` with
     `KEEL_COLLECTOR_CONFIG_PATH=/etc/keel/tenant.json`. Expect `verified` and the log line
     `5 of 5 write(s) qualified`.
  6. **Re-run check:** dry run again: expect 0 changes; promote it and expect `no-change` with no write. Promote the step 5
     artifact again: expect `stale`, no write.
  7. **Wider check (no write expected):** add one more `keel-rt-*` user to `KEEL-RT-perm-1 group` by hand, dry run: expect
     0 changes and one manual line "a member now but not in the backup; KEEL never removes a member". Do not promote.
  8. **Cleanup:** remove the test user as admin, delete `KEEL-RT-perm-1 group`, `KEEL-RT-perm-1 level` and
     `KEEL-RT-perm-list`.
  9. Commit the record and its `.capture.json` on `claude/live-evidence-site-permissions`, branched from `origin/master`
     (secret scan first, as Q39). No PR.
- **Report:** A's before/after resource counts; B; step 2 exit code and verify; step 3 import lines; step 4 check; per round
  the plan line, outcome and approval ids; steps 6 and 7 results; the evidence commit; anything left in the tenant.

### Q81: Retention prune dry run on the box (read-only, after #282)
- Drafted by the "Backup retention rules" thread (2026-10-15). Code: PR #282. `cli/keel-prune.mjs` without `--apply` is a
  dry run: it plans with the retention policies (default 14 daily, 8 weekly, 12 monthly, 7 yearly), saves one row in
  `retention_prune_report` and deletes nothing. Marouane said go for real deletes; this report is the check before the
  change that makes the scheduled prune delete is merged.
- Needs: /opt/keel-live at the merge of PR #282 or later (`test -f /opt/keel-live/engine/store/rotation.mjs`), and the
  schema applied (`retention_prune_report` exists).
- Status: done
- Result: Done 2026-10-15 18:17 UTC on B = c82311f0 (has engine/store/rotation.mjs; retention_prune_report exists). **Dry run only, nothing deleted**
  (no `--apply`). No tenant access.
  - **1.** `keel-prune.mjs --report …`: **exit 0**. Stdout (ids masked):
    - `would prune 25 snapshot(s): <25 ids>`
    - `would prune 745 content version(s) and 744 chunk(s) of 2139148 bytes`
    - `kept snapshots: weekly 1, referenced 291, daily 8`
    - `kept content versions: latest version 732; 193 item(s) with one version`
    - `policies: default: 14 daily, 8 weekly, 12 monthly, 7 yearly`
    - `report <id> saved and written to …/keel-prune-report.json`
  - **2. Report:**
    - snapshots.entries 325; snapshots.delete 25; snapshots.kept {weekly 1, referenced 291, daily 8}.
    - content.delete 745; content.chunks 744; content.freedBytes 2,139,148; content.kept {latest version 732}; content.singleVersionItems 193.
    - policies ["default: 14 daily, 8 weekly, 12 monthly, 7 yearly"]; holds [].
    - Deletes span **2026-09-04T10:02:15Z** (oldest) to **2026-10-15T14:00:38Z** (newest).
    - The 3 newest kept:
      - 2026-10-15T18:00:20Z [referenced by drift, referenced by resource symbol, daily 2026-10-15, weekly 2026-W42, monthly 2026-10, yearly 2026];
      - 17:00:17Z [referenced by drift];
      - 16:00:13Z [referenced by drift].
  - **3. Sanity:**
    - All 25 deletes have the reason "outside policy". 14 are newer than 14 days, and **none of those is the newest snapshot of its day**:
      each day keeps a later snapshot.
    - The 10 deletes that are the last of their day are all from 2026-09-07 to 09-12, older than the 14-day daily window.
    - **The newest complete snapshot (18:00:20Z) is kept.**
  - **4.** `schedule` row: `prune | enabled true | next_due_at 2026-10-16 00:00:00+00`. The scheduled prune is on, and runs tonight at 00:00.
- Do (no tenant access, no deletes):
  1. `set -a; . /etc/keel/db.env; set +a; node /opt/keel-live/cli/keel-prune.mjs --report /tmp/keel-prune-report.json`
     (never with `--apply`). Report the exit code and every stdout line.
  2. From the report file: count of `snapshots.entries` and of `snapshots.delete`; `snapshots.kept`; `content.delete`
     length, `content.chunks` length, `content.freedBytes`, `content.kept`, `content.singleVersionItems`; `policies`;
     `holds`. Also the oldest and newest `at` among the snapshots it would delete, and the 3 newest kept snapshots with reasons.
  3. Sanity: say whether any snapshot the report would delete is newer than 14 days (expect only snapshots that are
     not the newest of their day, week, month or year), and whether the newest complete snapshot is kept.
  4. `SELECT job_kind, enabled, next_due_at FROM schedule WHERE job_kind = 'prune'` (column names as in the schema).
- **Report:** steps 1–4. Nothing is deleted by this item.

### Q82: First tenant discovery run on the box (read-only, GET only)
- Drafted by the "Discovery schedule" thread (2026-10-15). `cli/keel-discover.mjs run` has never run on the live tenant, so
  the portal's Protect page cannot say what the tenant holds that KEEL is not backing up. It reads Graph `$metadata`, walks
  every entity set, singleton and containment path and counts objects. Every request goes through
  `engine/discovery/transport.mjs`, which refuses anything but a body-less GET to graph.microsoft.com before it is sent.
  Bodies are counted and dropped. It writes one `discovery_run` (and its items) to the KEEL database, nothing else.
- Needs: `test -f /opt/keel-live/cli/keel-discover.mjs` and the schema applied (`discovery_run` table exists).
- Status: done
- Result: Done 2026-10-15 18:25–18:35 UTC on B = 1cb777c9. Read-only: Collector GETs to graph.microsoft.com only, plus one stored discovery_run.
  No tenant write, approval or grant.
  - **1. `keel-discover.mjs run`:** **exit 0**, **wall time 258 s**.
    - Summary: `Discovery 2026-10-15T18:29:10.005Z: 1004 types; 83 catalogued, 276 uncatalogued, 573 unreadable, 72 not listed.`
    - Source lines that are not `complete`: `powershell:ExchangeOnlineManagement`, `powershell:MicrosoftTeams` and `powershell:PnP.PowerShell`
      are `unknown (no command list was supplied for this module)`, as expected without `--powershell-commands`. Every Graph source is complete.
    - Also printed: `Containers: users 104, groups 57, teams 11, sites 1.` and `Catalogue: 82 covered, 6 under-item, 6 unreadable.`
    - `1659 Graph GET requests, 17 throttled.` `Stored discovery run 1.`
  - **2. `show`:** exit 0. **384 uncatalogued lines and 820 unreadable lines** (the item lines under each heading).
    - The 10 most common `needs <grant>` values among the unreadable ones: needs DeviceManagementConfiguration.Read.All (41); needs SecurityEvents.Read.All (38); needs Directory.Read.All (30); needs Reports.Read.All (18); needs Policy.Read.All (14); needs Printer.Read.All (11); needs CallRecords.Read.All (6); needs RoleManagement.Read.Directory (5); needs IdentityRiskEvent.Read.All (5); needs RoleManagement.Read.All (4); 
    - Nothing granted.
    - Several of those the Collector already holds (DeviceManagementConfiguration.Read.All, SecurityEvents.Read.All, Directory.Read.All,
      Reports.Read.All, Policy.Read.All, Printer.Read.All, RoleManagement.Read.*). So the "needs" hint is the documented scope, and the
      real cause is something else: many unreadable lines are `not-listable (400/404)` beta paths. Worth a look by the discovery thread.
  - **3. Portal:** the Protect page reads `loadLatestDiscovery` (portal/lib/discovery.ts). Called with the same arguments, it returns
    **run 1** (276 uncatalogued, 573 unreadable, 72 not listed; 1276 items), so the Discovery section shows this run.
    - I didn't view the page itself (Cloudflare Access plus a portal session; `/api/discovery` without a session returns 401).
- Do (no tenant writes, no approvals, no consent, no new grants):
  1. `set -a; . /etc/keel/db.env; set +a; cd /opt/keel-live && time node cli/keel-discover.mjs run --config /etc/keel/tenant.json`
     (no `--powershell-commands`; PowerShell modules then show as "not listed", which is expected). Report the exit code,
     the wall time, the first summary line, any source lines that are not `complete`, the `Graph GET requests, throttled`
     line and the `Stored discovery run <id>` line. Exit 1 means a Graph source could not be read in full: still a result.
  2. `node cli/keel-discover.mjs show --config /etc/keel/tenant.json`: report the count of uncatalogued and unreadable
     lines and the 10 most common `needs <grant>` values among the unreadable ones. Do not grant any of them.
  3. Open https://keel.techinsiderbytes.com Protect page (or `curl` the same data the page reads) and say whether the
     Discovery section now shows this run.
- **Report:** steps 1-3. Nothing in the tenant or on the host changes besides the stored run.

### Q83: Retention prune dry run again, at PR #335's head, with the content breakdown (read-only)
- Drafted by the "Backup retention rules" thread (2026-10-15). Q81 showed 745 content versions to go and only
  "latest version" kept. Likely cause: one backup reads a drive file's whole version history at once, so every version
  had the same stored day. PR #335 (not merged; merging it turns on real deletes) now rotates a version by its own
  `lastModifiedDateTime`. This item checks that change against the live data before #335 merges.
- Needs: nothing deployed. Run from your own clone (never `/opt/keel`), checked out at
  `origin/claude/project-thread-kuvgwg` (6fa3964 or later), with `npm ci` in `engine/` if needed.
- Status: done
- Result: Done 2026-10-15 19:48 UTC from my own clone at origin/claude/project-thread-kuvgwg **6fa3964** (engine `npm ci`), against the live
  DB. **Dry run only, never `--apply`**; no tenant access.
  - **1.** exit 0. Stdout (ids masked):
    - `would prune 25 snapshot(s): <25 ids>`
    - `would prune 745 content version(s) and 744 chunk(s) of 2139148 bytes`
    - `kept snapshots: weekly 1, referenced 292, daily 8`
    - `kept content versions: latest version 732; 193 item(s) with one version`
    - `policies: default: 14 daily, 8 weekly, 12 monthly, 7 yearly`
    - `report <id> saved and written to …/keel-prune-report-q83.json`
  - **2. content.delete: 745**; kept {latest version: 732}; chunks 744; freedBytes 2,139,148.
    - By workload/kind:
      - sharepoint-sites, kind "" (no kind): **705**;
      - teams, kind "": 33;
      - sharepoint-sites drive-record: 5;
      - sharepoint-sites drive-content: 2.
    - **Largest group (sharepoint-sites, no kind): 705 entries over 617 distinct items.** versionAt oldest 2026-10-15T00:19:37.659Z, newest
      2026-10-15T14:01:42.133Z. In **all 705, versionAt equals createdAt** (the stored time). Item keys: 696 `list…` (list items), 9 `site…`.
    - 3 samples (item masked):
      - version "2026-08-30T20:40:13Z", versionAt and createdAt 2026-10-15T00:19:48.224Z;
      - version "\"6c3f4bb0-…\"" (an etag), versionAt and createdAt 00:19:48.779Z;
      - version "\"1466ca5d-…\"", 00:19:50.477Z.
    - All 745 have reason "outside policy". 744 are from 2026-10-15 and 1 from 2026-09-08.
    - Teams: 22 versions from the 07:00 runs and 11 from the 00:00 run (the pre-#271 non-deterministic copies).
  - **3. Q81's report** (still in my scratchpad; Q81's report path was there, not /tmp): content.delete **745** as well, all sharepoint-sites
    and teams. By version prefix: sharepoint-sites "2026-1…" 21, "2026-0…" 8, "record…" 5, and many etag versions of 2 each.
  - **4. Snapshot lines:** `would prune 25 snapshot(s)`, the same as Q81. Kept: referenced **292** (Q81 had 291, one newer hourly snapshot); weekly 1; daily 8.
  - **Reading:** 6fa3964 changes nothing on this data, still 745.
    - The versions it drops are mostly **SharePoint list items** (and site items), not drive files. Their versionAt is the stored time,
      so lastModifiedDateTime rotation, which applies to drive versions only, doesn't touch them.
    - They are intra-day duplicates from today's several backup runs (00:19 for Q58's first pass, 07:0x for Q62, 08:30 for Q64's #273 pass,
      14:01). The daily rule keeps only the newest per item per day.
    - So the deletes match the policy as written: superseded same-day versions, plus the 33 pre-#271 Teams copies. They are not a
      loss of distinct history.
- Do (no tenant access, **never `--apply`**):
  1. `set -a; . /etc/keel/db.env; set +a; node <clone>/cli/keel-prune.mjs --report /tmp/keel-prune-report-q83.json`.
     Report the exit code and every stdout line.
  2. From the report: `content.delete` length; that list grouped by `workload` and `kind` (counts); `content.kept`;
     `content.chunks` length and `freedBytes`. For the largest workload/kind group: how many distinct items, the
     oldest and newest `versionAt`, and 3 sample entries (item key masked, version, versionAt, createdAt).
  3. The same for Q81's report file if it is still at `/tmp/keel-prune-report.json`: `content.delete` grouped by
     `workload` (Q81 entries have no `kind`; group by `workload` and `version` prefix instead).
  4. Snapshot lines unchanged from Q81? (`would prune N snapshot(s)`.)
- **Report:** steps 1–4. Nothing is deleted by this item.

### Q84: Add the weekly discovery schedule row on live (after #340)
- Drafted by the "Discovery schedule" thread (2026-10-15). PR #340 (merge 40d2af0) adds a `discover` job kind, seeded
  weekly Monday 04:00 UTC (`cron_override '0 4 * * 1'`). It runs the same GET-only `keel-discover.mjs run` as Q82
  (258 s there) through keel-worker. Same step as the content-collect row on 2026-10-15: the live DB only gets the row
  when the seed is run for that kind.
- Needs: /opt/keel-live at 40d2af0 or later (`grep -q "'discover'" /opt/keel-live/engine/store/scheduleSeed.mjs`), the
  schema applied (`job_kind_check` accepts `discover`: `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'job_kind_check'`),
  and keel-worker restarted on that build.
- Status: done
- Result: Done 2026-10-15 19:31 UTC on B = 40d2af01. No tenant access; the only write is the one schedule row.
  - Checks: `scheduleSeed.mjs` includes `'discover'`; `job_kind_check` accepts `discover`; keel-worker restarted at 19:23:30 UTC on this build.
  - **1.** `keel-schedules-migrate.mjs --tenant-ref sha256:f7b3959300856957 --kinds discover`: **exit 0**. Output:
    `PASS: keel-backup-tier1.timer disabled and inactive`, `PASS: keel-backup-tier2.timer disabled and inactive`,
    `PASS: keel-backup-tier3.timer disabled and inactive`, `PASS: keel-prune.timer disabled and inactive`.
  - **2.** The schedule table now has 8 rows. The diff against before is one added line, nothing else changed:
    `discover | | {"n": 1, "every": "week", "atTime": "04:00"} | 0 4 * * 1 | enabled | 2026-10-19 04:00:00+00`.
    The other rows are unchanged: api-drift (weekly Mon 03:00), collect tier1 (hourly), tier2 (daily 00:00), tier3 (weekly Mon 00:00),
    content-collect (daily 01:00), prune (daily 00:00) and workload-collect (daily 02:00), all enabled.
- Do (no tenant access, no writes besides the one schedule row):
  1. `set -a; . /etc/keel/db.env; set +a; cd /opt/keel-live && node cli/keel-schedules-migrate.mjs --tenant-ref <live tenantRef> --kinds discover`.
     It inserts only the `discover` row and leaves every other row as is. Report the exit code and output.
  2. `SELECT job_kind, tier, cadence, cron_override, enabled, next_due_at FROM schedule ORDER BY job_kind, tier`.
     Expect `discover` enabled with next_due_at 2026-10-19 04:00 UTC and the other rows unchanged.
- **Report:** steps 1-2. The first scheduled run is 2026-10-19 04:00 UTC; a later thread checks its job row.

### Q85: Why discovery's unreadable types say "needs <grant>" (read-only, DB query plus the Collector's token roles)
- Drafted by the "Discovery unreadable reason" thread (2026-10-15). Q82 printed `needs <grant>` on unreadable types for
  grants the Collector already holds. The hint is only set on 401/403 answers, from Graph's own message or else from a
  documented path-prefix table, so the 400/404 lines are not where it comes from. This item shows the real reasons.
- Needs: Q82 done (discovery run 1 stored).
- Status: done
- Result: Done 2026-10-15 19:25 UTC. Read-only: DB SELECTs on discovery run 1, and the Collector token's `roles` claim (role names only; the
  token was never printed). No tenant writes, grants or approvals.
  - **1. Unreadable items by reason, HTTP status and grant source** (run 1):
    reason     | http_status | grant_source | count 
    ---------------+-------------+--------------+-------
     missing-grant |         403 |              |   170
     not-listable  |         400 |              |   168
     not-listable  |         404 |              |   165
     missing-grant |         403 | documented   |   148
     error         |         500 |              |    43
     not-licensed  |         403 |              |    37
     missing-grant |         401 | documented   |    34
     missing-grant |         403 | graph        |    11
     missing-grant |         401 |              |     8
     not-licensed  |         400 |              |     7
     not-listable  |         501 |              |     7
     error         |         206 |              |     7
     not-listable  |         405 |              |     5
     error         |         503 |              |     4
     error         |         410 |              |     2
     error         |         502 |              |     2
     error         |         412 |              |     2
    (17 rows)
  - **2. Top 401/403 messages** (first 12 of 25; message | count):
    UnknownError: | 101
    accessDenied: Access is denied to the requested resource. | 37
    UnknownError: {"errorCode":"403","message":"The token does not have one or more required security scopes."} | 22
    Forbidden: Authentication failed with status code 403 (Forbidden). | 16
    Access denied: Insufficient license to complete this operation. User workflows require an Entra ID Governance license. Agent-related workflows require | 13
    Forbidden: Tenant is not onboarded to Microsoft Defender for Identity. After license is purchased, first login to portal and sensor are required. For  | 13
    forbidden: Authorization failed because of missing requirement(s). | 11
    Authorization_RequestDenied: Insufficient privileges to complete the operation. | 11
    accessDenied: Caller does not have required permissions for this API | 8
    notAllowed: Your account does not have access to this report or data. Please contact your organization administrator to ensure you have a valid licens | 8
    Forbidden: Insufficient permissions | 7
    AccessDenied: Required roles claim values are not provided. | 6
    - Also in the 25: Defender for Identity not onboarded (13); Entra ID Governance licence (13); AADB2C "not a B2C directory" (4);
      TenantEnabledInAadRoleMigration (6); Graph-named missing scopes such as NetworkAccess.Read.All, RiskPreventionProviders.Read.All,
      DirectoryRecommendations.Read.All and TeamsTelephoneNumber.ReadWrite.All.
  - **3. Rows that hint at a grant the Collector holds** (40 rows shown): all `missing_grant = DeviceManagementConfiguration.Read.All`,
    all `/deviceManagement/...` paths. 30 of the 40 are `/deviceManagement/virtualEndpoint/*` (Cloud PC), answering
    "accessDenied: Access is denied to the requested resource". The others are chromeOSOnboardingSettings, cloudCertificationAuthority,
    hardwarePasswordDetails, managedDeviceWindowsOSImages, monitoring/alertRecords and alertRules, remoteAssistanceSettings,
    serviceNowConnections and zebraFota* ("Unauthorized: An error has occurred", "UnknownError:" or Forbidden).
  - **4. Collector token roles** (45):
    APIConnectors.Read.All, AccessReview.Read.All, AdministrativeUnit.Read.All, Agreement.Read.All, Application.Read.All, AuditLog.Read.All, CustomAuthenticationExtension.Read.All, CustomSecAttributeDefinition.Read.All, DeviceManagementApps.Read.All, DeviceManagementConfiguration.Read.All, DeviceManagementManagedDevices.Read.All, DeviceManagementRBAC.Read.All, DeviceManagementScripts.Read.All, DeviceManagementServiceConfig.Read.All, Directory.Read.All, Domain.Read.All, EntitlementManagement.Read.All, ExternalConnection.Read.All, Group.Read.All, GroupMember.Read.All, IdentityProvider.Read.All, IdentityRiskEvent.Read.All, IdentityUserFlow.Read.All, InformationProtectionPolicy.Read.All, LifecycleWorkflows.Read.All, MailboxSettings.Read, MultiTenantOrganization.Read.All, Organization.Read.All, Place.Read.All, Policy.Read.All, Policy.Read.PermissionGrant, Printer.Read.All, Reports.Read.All, RoleManagement.Read.All, RoleManagement.Read.Directory, SecurityEvents.Read.All, ServiceHealth.Read.All, SharePointTenantSettings.Read.All, Sites.FullControl.All, Sites.Read.All, Team.ReadBasic.All, TeamMember.Read.All, TeamSettings.Read.All, TeamworkTag.Read.All, User.Read.All.
  - **Reading:**
    - The misleading hints are the `grant_source = documented` rows (148 at 403, 34 at 401). Discovery fills them from its path-prefix
      table: `/deviceManagement/*` maps to DeviceManagementConfiguration.Read.All, which the token holds.
    - The real causes are other scopes (Cloud PC needs CloudPC.Read.All; alert records DeviceManagementConfiguration plus a licence),
      licences or features (Defender for Identity, Governance, B2C, Windows 365), or service-side errors. That fits step 2: 101 have a
      bare `UnknownError:`.
    - The 11 `grant_source = graph` rows name scopes Graph itself asked for.
    - Suggestion: only say "needs <grant>" when the token lacks that grant (compare with step 4). Otherwise report "denied (holds
      <grant>; likely another scope or a licence)", and add `/deviceManagement/virtualEndpoint` → CloudPC.Read.All to the table.
  - No open PR from the "Discovery unreadable reason" thread found, so no PR comment.
- Do (read only: no tenant writes, no grants, no approvals; never print the token itself):
  1. `set -a; . /etc/keel/db.env; set +a; psql "$KEEL_DB_URL" -c "SELECT reason, http_status, grant_source, count(*) FROM discovery_item WHERE run_id = 1 AND status = 'unreadable' GROUP BY 1,2,3 ORDER BY 4 DESC"`
  2. `psql "$KEEL_DB_URL" -c "SELECT left(message, 160) AS message, count(*) FROM discovery_item WHERE run_id = 1 AND status = 'unreadable' AND http_status IN (401, 403) GROUP BY 1 ORDER BY 2 DESC LIMIT 25"`
  3. `psql "$KEEL_DB_URL" -c "SELECT source, name, missing_grant, left(message, 200) FROM discovery_item WHERE run_id = 1 AND status = 'unreadable' AND missing_grant IN ('DeviceManagementConfiguration.Read.All','SecurityEvents.Read.All','Directory.Read.All','Reports.Read.All','Policy.Read.All') ORDER BY missing_grant, name LIMIT 40"`
  4. The Collector's granted application roles, read from its token's `roles` claim (prints the role names only):
     `cd /opt/keel-live && node --input-type=module -e "import { getToken } from './tools/tenant-probe/auth.mjs'; import { readFileSync } from 'node:fs'; const c = JSON.parse(readFileSync('/etc/keel/tenant.json','utf8')); const t = (await getToken(c)).accessToken; console.log(JSON.parse(Buffer.from(t.split('.')[1], 'base64url')).roles.sort().join('\n'))"`
- **Report:** the output of steps 1-4 in Result, and a comment on the PR from the "Discovery unreadable reason" thread if one is open.

### Q86: Why New-CsTeamsMeetingPolicy is refused for the Restorer (issue #339, Teams part only; no tenant writes)
- Drafted by the "Teams meeting policy 403" thread (2026-10-15). In the teams-org-policies writer capture (build 2235fb3),
  `New-CsTeamsMeetingPolicy -Identity KEEL-RT-capture-223d6cda -Description ...` as the Restorer answered
  `403 Forbidden "You are not authorized to perform this action"` (errorCode 40301, errorId
  `Forbidden,Microsoft.Teams.Policy.Administration.Cmdlets.Core.NewTeamsMeetingPolicyCmdlet`), while New-/Set- on messaging,
  calling, voice routing, dial plan, emergency, call park, voicemail, broadcast and events policies all worked. This item finds
  out whether the refusal is about meeting-policy writes in general, about New- only, or about the Restorer's role.
- Needs: nothing. Use the same PowerShell image and run-cmdlet scripts the writer capture used (MicrosoftTeams 7.9.0).
- Status: done
- Result: Done 2026-10-15 19:38–19:45 UTC. Restorer through the run-cmdlet plane (image keel-powershell:wkld-20261015: the same scripts as the
  writer capture, MicrosoftTeams 7.9.0). No tenant change: the only New- failed again.
  - **1.** `New-CsTeamsMeetingPolicy {"Identity":"KEEL-RT-mtg-82080df3"}` (no Description): **ok false**.
    - message: `{"code":"Forbidden","message":"You are not authorized to perform this action","action":"Please refer to documentation. CorrelationId: <id>","errorCode":40301}`
    - errorId: `Forbidden,Microsoft.Teams.Policy.Administration.Cmdlets.Core.NewTeamsMeetingPolicyCmdlet`. Nothing was created.
  - **2.** `Set-CsTeamsMeetingPolicy {"Identity":"KEEL-RT-missing-mtg","Description":"x"}`: **ok false**, not found.
    - message: `{"code":"ClientError","message":"\"KEEL-RT-missing-mtg\" not found",…,"errorCode":40407}`
    - errorId: `ClientError,Microsoft.Teams.Policy.Administration.Cmdlets.Core.SetTeamsMeetingPolicyCmdlet`.
    - **Not a 403**, so the Restorer is allowed to update meeting policies.
  - **3.** Control, `Set-CsTeamsMessagingPolicy {"Identity":"KEEL-RT-missing-msg","Description":"x"}`: **ok false**, the same 40407 "not found".
    errorId `ClientError,Microsoft.Teams.Policy.Administration.Cmdlets.Core.SetTeamsMessagingPolicyCmdlet`, the same
    Teams.Policy.Administration service as the meeting cmdlets.
  - **4.** `Get-CsTeamsMeetingPolicy`: **ok true, 7 policies.**
  - **5.** Restorer directory roles, all tenant-wide (`/`): Compliance Administrator, Security Administrator, Exchange Administrator,
    Intune Administrator, **Teams Administrator**, Knowledge Administrator, Compliance Data Administrator, SharePoint Administrator.
  - **Reading:** the refusal is specific to **creating** a meeting policy. Read and update go through, through the same service, with
    Teams Administrator held tenant-wide. Messaging and the 10 voice families accepted New- in the capture, so this is a service-side
    restriction on New-CsTeamsMeetingPolicy for app-only callers, not a missing KEEL role.
    - Option: drop `teams.meeting-policy.add` from app-only writes (recreate by hand), and prove `teams.meeting-policy.update` on a
      KEEL-RT- meeting policy a person creates once.
  - Commented on #339.
- Do (read-only, or calls that cannot change anything: the only New- is retried on a fresh KEEL-RT- name and is the exact call
  that already failed; the Set- calls name a policy that does not exist, so they can only fail):
  Each step is one run-cmdlet job as the Restorer:
  `{"mode":"cmdlet","module":"MicrosoftTeams","cmdlet":"<cmdlet>","parameters":{...},"tenantConfigPath":"/etc/keel/restorer.json"}`.
  Report each step's `ok`, error message and `errorId` (FullyQualifiedErrorId) verbatim.
  1. `New-CsTeamsMeetingPolicy` with `{"Identity":"KEEL-RT-mtg-<8 hex>"}` (no Description). If it succeeds, record the name in
     Result and leave it (it is a KEEL-RT- fixture the next capture can use for `teams.meeting-policy.update`).
  2. `Set-CsTeamsMeetingPolicy` with `{"Identity":"KEEL-RT-missing-mtg","Description":"x"}`. A "not found" answer means the Restorer
     may write meeting policies; a 403 means it may not.
  3. Control: `Set-CsTeamsMessagingPolicy` with `{"Identity":"KEEL-RT-missing-msg","Description":"x"}`. Its errorId shows which
     service the messaging cmdlets go through.
  4. `Get-CsTeamsMeetingPolicy` (no parameters) as the Restorer: report `ok` and the number of policies only.
  5. The Restorer's directory role assignments and their scope (read with the Collector token, GET only; print names and scopes,
     never a token):
     `cd /opt/keel-live && node --input-type=module -e "import { getToken } from './tools/tenant-probe/auth.mjs'; import { readFileSync } from 'node:fs'; const c = JSON.parse(readFileSync('/etc/keel/tenant.json','utf8')); const r = JSON.parse(readFileSync('/etc/keel/restorer.json','utf8')); const t = (await getToken(c)).accessToken; const h = { authorization: 'Bearer ' + t }; const sp = await (await fetch('https://graph.microsoft.com/v1.0/servicePrincipals(appId=\'' + r.clientId + '\')?\$select=id', { headers: h })).json(); const a = await (await fetch('https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments?\$filter=principalId eq \'' + sp.id + '\'&\$expand=roleDefinition(\$select=displayName)', { headers: h })).json(); for (const x of a.value ?? []) console.log(x.roleDefinition?.displayName, x.directoryScopeId); if (a.error) console.log(a.error.code, a.error.message)"`
- **Report:** steps 1-5 in Result. Then comment the findings on issue #339 as keel-operator.

### Q87: Rerun the exchange-extended writer capture after #342 (quarantine by Name, deployed scripts mounted)
- Drafted by the "Quarantine capture fix" thread (2026-10-15), for issue #339. PR #342 (merged as 82f852a):
  - Set-QuarantinePolicy is now sent `-Identity <Name>`, for both quarantine families (for the global settings: `DefaultGlobalTag`).
    The id in your report was the pseudonym of the raw Guid in the recorded copy. The capture had sent the raw Guid, and the cmdlet
    refuses a Guid.
  - Every job now mounts `/opt/keel-live/ops/powershell` read-only over `/app`, so `keel-powershell:latest` runs the deployed
    run-cmdlet allowlist. No thin image is needed. The Dockerfile pins ExchangeOnlineManagement 3.10.1; no rebuild is needed.
- Needs: `/opt/keel-live` at 82f852a or later (`git -C /opt/keel-live log -1 --format=%h` or the deployed build stamp).
- Status: done
- Result: Done 2026-10-15 20:00–20:08 UTC on B = 82f852a9, with the default image `keel-powershell:latest` (the deployed ops/powershell is
  mounted over /app) and `--allow-tenant-wide-test-writes --module-version 3.10.1`. Test tenant only; Restorer EXO app-only. Global admin not used.
  - **1. Capture: exit 0.**
    - `exchange-extended.quarantine-global-settings.update`: **not proven**. ok false; readBackVerified and restoredToOriginal n/a
      (nothing written).
      - error: `Set-QuarantinePolicy failed: Set-QuarantinePolicy: ||The operation couldn't be performed because object
        'DefaultGlobalPolicy' couldn't be found on '<EXO server>'.`
      - A read as the Collector (`Get-QuarantinePolicy -QuarantinePolicyType GlobalQuarantinePolicy`) returns Name **DefaultGlobalPolicy**
        (Identity <org>\DefaultGlobalPolicy, type GlobalQuarantineTag). So #342 sends the Name, but Set-QuarantinePolicy needs the fixed
        identity **DefaultGlobalTag** for the global settings, as Microsoft documents.
    - `exchange-extended.quarantine-policy.update`: **skipped**, "no KEEL-RT- object of this kind in the tenant".
    - Also proven again: `exchange-extended.connection-filter-policy.update` (tenant-wide, written, read back, put back).
    - No exit 3; needsManualRevert [].
  - **2. verify --require-live:** exit 0 (ok, no failures).
  - **3.** PR **#344** (`claude/live-evidence-workload-writers-2`, automerge) with the record and .capture.json. It replaces #338's
    exchange-extended record. Import from that checkout: `workload-writers-exchange-extended-live-acceptance.json` imported
    (writes 1); refused [].
  - Commented on #339.
- Do (test tenant only; the same put-back writes as your last exchange-extended run):
  1. The exchange-extended capture, exactly as your last run, with `--allow-tenant-wide-test-writes`, `--module-version 3.10.1`, and the
     default image `keel-powershell:latest` (not the wkld thin image), at the deployed build.
  2. `node tools/release/qualification.mjs verify --require-live --gate workload-writers-live-acceptance --evidence <the record>`.
  3. Commit the record and its `.capture.json` to a `claude/live-evidence-workload-writers-2` PR, then run
     `node cli/keel-workload-collect.mjs import`.
- **Report:** the capture exit code; for `exchange-extended.quarantine-global-settings.update` and `exchange-extended.quarantine-policy.update`
  the `ok`, `readBackVerified`, `restoredToOriginal` and `error` (or its skip reason); the verify exit code; the import line for
  exchange-extended; and the PR link. Exit 3 means a setting may not be back: report the object, field and original value it names.

### Q88: Rerun the exchange-extended writer capture after #346 (global quarantine settings set as DefaultGlobalTag)
- Drafted by the "Quarantine capture fix" thread (2026-10-15), for issue #339. Q87 showed Set-QuarantinePolicy refuses the global
  settings' read Name (DefaultGlobalPolicy). PR #346 (merged as 244756b) sends the documented fixed identity `-Identity DefaultGlobalTag`
  for `exchange-extended.quarantine-global-settings.update`, only on the one tenant-wide object.
- Needs: `/opt/keel-live` at 244756b or later.
- Status: done
- Result: Done 2026-10-15 20:30–20:38 UTC on B = 244756bd (includes #346), run exactly as Q87: default image, `--allow-tenant-wide-test-writes`,
  `--module-version 3.10.1`. Test tenant only. Global admin not used.
  - **Capture: exit 0. verify --require-live: exit 0.** No exit 3; needsManualRevert [].
  - `exchange-extended.quarantine-global-settings.update`: **still not proven**. ok false, readBackVerified false, restoredToOriginal false
    (nothing written). Field OrganizationBrandingEnabled, scope tenant-wide.
    - error: `Set-QuarantinePolicy failed: … The operation couldn't be performed because object 'DefaultGlobalTag' couldn't be found on '<EXO server>'.`
  - `exchange-extended.quarantine-policy.update`: skipped (no KEEL-RT- quarantine policy).
  - `exchange-extended.connection-filter-policy.update`: proven again.
  - **Read as the Collector**, `Get-QuarantinePolicy -QuarantinePolicyType GlobalQuarantinePolicy`: 1 object. Name `DefaultGlobalPolicy`, Identity
    `<org>.onmicrosoft.com\DefaultGlobalPolicy`, DistinguishedName `CN=DefaultGlobalPolicy,CN=Quarantine Settings,CN=Transport Settings,…`,
    a Guid and ExchangeObjectId present, type GlobalQuarantineTag.
    - So in this tenant neither `DefaultGlobalTag` (Q88) nor the bare Name `DefaultGlobalPolicy` (Q87) resolves for Set-QuarantinePolicy.
    - Untested candidates: the full Identity `<org>.onmicrosoft.com\DefaultGlobalPolicy`, or the object's real Guid. Q67's "a Guid is
      refused" came from the pseudonymized value.
    - Not tried here: I didn't improvise writes outside the tool.
  - Record not committed: it proves only what PR #344 already holds. Commented on #339.
- Do: exactly Q87's steps 1-3 (default image `keel-powershell:latest`, `--allow-tenant-wide-test-writes`, `--module-version 3.10.1`),
  with the record going to a new evidence PR that replaces #344's exchange-extended record if #344 has merged, or onto #344 if it is open.
- **Report:** the capture exit code; for `exchange-extended.quarantine-global-settings.update` the `ok`, `readBackVerified`,
  `restoredToOriginal`, `field` and `error`; the verify exit code; the import line; and the PR link. Exit 3: report the object, field and
  original value it names.

### Q89: Which Identity form Set-QuarantinePolicy accepts for the global quarantine settings (issue #339; no-change probe)
- Drafted by the "Quarantine global identity" thread (2026-10-15). Q87 and Q88 showed Set-QuarantinePolicy refuses the global settings both
  as the bare Name `DefaultGlobalPolicy` and as `DefaultGlobalTag`. Before the code changes a third time, this item finds out which identity
  form resolves. Each Set- below writes `OrganizationBrandingEnabled` back to the value step 1 reads, so nothing changes.
- Needs: nothing. Use the default image `keel-powershell:latest` with the deployed scripts mounted, as the capture does:
  `docker run --rm -i --network host -v /etc/keel:/etc/keel:ro -v /opt/keel-live/ops/powershell:/app:ro keel-powershell:latest`
  with the job JSON on stdin. Every step is one run-cmdlet job as the Restorer:
  `{"mode":"cmdlet","module":"ExchangeOnlineManagement","cmdlet":"<cmdlet>","parameters":{...},"tenantConfigPath":"/etc/keel/restorer.json"}`.
- Status: done
- Result: Done 2026-10-15 20:52–21:00 UTC. Restorer through run-cmdlet, image `keel-powershell:latest` with `/opt/keel-live/ops/powershell` mounted
  over /app. **No change**: every Set- sent the value step 1 read, and none succeeded anyway. Global admin not used.
  - Note: `/etc/keel/restorer.json` has no `organization`, so EXO refused it ("Organization cannot be null for certificate based
    connections"). The probe used `/etc/keel/exchange-restorer.json`, the **same Restorer app** (same clientId) with the organization, as the capture does.
  - **1.** `Get-QuarantinePolicy {"QuarantinePolicyType":"GlobalQuarantinePolicy"}`: **ok true, 1 object, OrganizationBrandingEnabled = False.**
  - **2.** Set-QuarantinePolicy, Identity = the full Identity `<org>.onmicrosoft.com\DefaultGlobalPolicy`: **ok false**.
    - message: `||The operation couldn't be performed because object '<org>.onmicrosoft.com\DefaultGlobalPolicy' couldn't be found on '<EXO server>'.`
    - errorId: `[],Write-ErrorMessage`
  - **3.** Identity = the DistinguishedName `CN=DefaultGlobalPolicy,CN=Quarantine Settings,CN=Transport Settings,…`: **ok false**.
    The message is the same as step 2 (it resolves the DN to `<org>.onmicrosoft.com\DefaultGlobalPolicy`, then "couldn't be found");
    errorId `[],Write-ErrorMessage`.
  - **4.** Identity = ExchangeObjectId: **ok false**.
    - message: `Cannot process argument transformation on parameter 'Identity'. Cannot convert value "<guid>" to type
      "Microsoft.Exchange.Configuration.Tasks.QuarantineTagIdParameter". Error: "The format of the value you specified in the objectId
      parameter isn't valid. Check the value, and then try again. …`
    - errorId: `[],Write-ErrorMessage`
  - **5.** Identity = the real Guid: **ok false**, the same message as step 4 (QuarantineTagIdParameter conversion); errorId `[],Write-ErrorMessage`.
  - **6.** Get again: **ok true, OrganizationBrandingEnabled = False**, unchanged.
  - **Reading:** the Restorer can **read** the global object (step 1), but Set-QuarantinePolicy resolves none of Name, `DefaultGlobalTag`
    (Q88), full Identity, DN, ExchangeObjectId or Guid. Set's Identity binder is `QuarantineTagIdParameter`, which rejects GUIDs outright,
    and every name form is "not found".
    - Possibly the global quarantine settings in this tenant were never initialized as a writable QuarantineTag. A person opening
      Defender > Quarantine policies > Global settings and saving once may create it. Or the global settings may need a different
      cmdlet, path or parameter set.
    - Until then, `exchange-extended.quarantine-global-settings.update` can't be proven on this tenant.
  - Commented on #339.
- Do (test tenant only; one tenant-wide object, written back to its own current value):
  1. `Get-QuarantinePolicy` with `{"QuarantinePolicyType":"GlobalQuarantinePolicy"}`. Note the object's `Identity`, `DistinguishedName`,
     `ExchangeObjectId`, `Guid` and the current `OrganizationBrandingEnabled` (true or false). Report `ok`, the number of objects and the
     `OrganizationBrandingEnabled` value.
  2. `Set-QuarantinePolicy` with `{"Identity":"<the full Identity from step 1, e.g. org.onmicrosoft.com\\DefaultGlobalPolicy>","OrganizationBrandingEnabled":<value from step 1>}`.
  3. The same with `"Identity":"<the DistinguishedName from step 1>"`.
  4. The same with `"Identity":"<the ExchangeObjectId from step 1>"`.
  5. The same with `"Identity":"<the real Guid from step 1>"` (not a pseudonymized copy).
  6. Repeat step 1 and confirm `OrganizationBrandingEnabled` still has its original value.
  Run every step even if an earlier one succeeds. If a step ever writes a value other than the one step 1 read, stop and put it back.
- **Report:** for steps 2-5, `ok` and, on failure, the error message and `errorId` (FullyQualifiedErrorId) verbatim, with the tenant name
  masked as `<org>`. For steps 1 and 6, `ok` and the `OrganizationBrandingEnabled` value. Then comment the findings on issue #339 as
  keel-operator.

### Q90: Set the global quarantine settings by piping the Get- into Set-QuarantinePolicy (issue #339; no-change probe)
- Drafted by the "Quarantine global pipe" thread (2026-10-15). Q89 showed Set-QuarantinePolicy finds the global settings by no
  `-Identity` form. This tries Microsoft's documented form, `Get-QuarantinePolicy -QuarantinePolicyType GlobalQuarantinePolicy | Set-QuarantinePolicy ...`,
  through run-cmdlet. Branch `claude/project-thread-yw9qlk` at **247842d** adds one thing to run-cmdlet.ps1: a job field `pipeFrom`.
  Its only allowed value, `global-quarantine-settings`, makes run-cmdlet run that fixed Get- itself (exactly 1 object required) and pipe it
  into Set-QuarantinePolicy. A piped job must not send `Identity`. Nothing else in the job changes.
- Needs: nothing. Use the default image `keel-powershell:latest`, but mount **the branch's** scripts, not /opt/keel-live's:
  `git fetch origin claude/project-thread-yw9qlk && mkdir -p /tmp/keel-q90 && git archive 247842d ops/powershell | tar -x -C /tmp/keel-q90`, then
  `docker run --rm -i --network host -v /etc/keel:/etc/keel:ro -v /tmp/keel-q90/ops/powershell:/app:ro keel-powershell:latest` with the job JSON
  on stdin. Every step is one run-cmdlet job as the Restorer, with `"tenantConfigPath":"/etc/keel/exchange-restorer.json"` (as in Q89).
- Status: done
- Result: Done 2026-10-15 21:06–21:08 UTC. Restorer (exchange-restorer.json) through run-cmdlet, image `keel-powershell:latest` with branch
  claude/project-thread-yw9qlk @ **247842d** `ops/powershell` (git archive into /tmp/keel-q90) mounted over /app.
  - I reviewed the branch diff first: `pipeFrom` allows only `global-quarantine-settings`, the Get- is fixed, it requires exactly 1 object,
    and a piped job may not send Identity.
  - **No change.** Global admin not used. /tmp/keel-q90 removed afterwards.
  - **1.** Get-QuarantinePolicy (GlobalQuarantinePolicy): **ok true, 1 object, OrganizationBrandingEnabled = False.**
  - **2.** Set-QuarantinePolicy `{"OrganizationBrandingEnabled":false}` with `pipeFrom: global-quarantine-settings` (Get- piped into Set-,
    no Identity): **ok false**.
    - message: `||The operation couldn't be performed because object '<org>.onmicrosoft.com\DefaultGlobalPolicy' couldn't be found on '<EXO server>'.`
    - errorId: `[Server=<EXO server>,RequestId=<guid>,TimeStamp=Thu, 15 Oct 2026 21:07:19 GMT],Write-ErrorMessage`
  - **3.** Get again: **ok true, OrganizationBrandingEnabled = False**, unchanged.
  - **Reading:** even Microsoft's documented pipe form can't find the object. Get-QuarantinePolicy returns it, but Set-QuarantinePolicy
    (QuarantineTag lookup) resolves `<org>.onmicrosoft.com\DefaultGlobalPolicy` and then reports it as not found.
    - This points at the tenant, not KEEL's identity handling: the global quarantine settings object exists for reads but not as a
      settable QuarantineTag.
    - Likely fix: save the global settings once in the Defender portal (Email & collaboration > Policies & rules > Threat policies >
      Quarantine policies > Global settings), then rerun the capture.
  - Commented on #339.
- Do (test tenant only; one tenant-wide object, written back to its own current value):
  1. `{"mode":"cmdlet","module":"ExchangeOnlineManagement","cmdlet":"Get-QuarantinePolicy","parameters":{"QuarantinePolicyType":"GlobalQuarantinePolicy"},"tenantConfigPath":"/etc/keel/exchange-restorer.json"}`.
     Report `ok`, the number of objects and the current `OrganizationBrandingEnabled` (true or false).
  2. `{"mode":"cmdlet","module":"ExchangeOnlineManagement","cmdlet":"Set-QuarantinePolicy","parameters":{"OrganizationBrandingEnabled":<value from step 1>},"pipeFrom":"global-quarantine-settings","tenantConfigPath":"/etc/keel/exchange-restorer.json"}`.
  3. Repeat step 1 and confirm `OrganizationBrandingEnabled` still has its original value.
  If step 2 ever writes a value other than the one step 1 read, put it back. Remove /tmp/keel-q90 afterwards.
- **Report:** for step 2, `ok` and, on failure, the error message and `errorId` verbatim (tenant name masked as `<org>`). For steps 1 and 3,
  `ok` and the `OrganizationBrandingEnabled` value. Then comment the findings on issue #339 as keel-operator.

### Q91: Check the first scheduled nightly content backup (01:00 UTC, 2026-10-16), per workload (read-only)
- Drafted by the "First nightly content backup" thread (2026-10-16). The content-collect schedule row was added on live 2026-10-15
  07:35 UTC (daily 01:00 UTC, issue #272). #270 (stale mail cursor fix for #268) was deployed before it.
- Status: done
- Result: Done 2026-10-16 01:48 UTC, read-only (DB and worker log). No tenant writes, no reruns.
  - **1.** /opt/keel-live at **244756bd**. Schedule row: `content-collect | enabled | last_job_id c425cacc | next_due_at 2026-10-17 01:00:00+00`.
  - **2.** Job **c425cacc**: created 01:00:00, started 01:01:49, finished 01:03:28 UTC. Status **succeeded**, so exit 0 (empty error, empty
    stderr). It is the only content-collect job since 00:55.
  - **3.** Per workload, verbatim, all succeeded:
    - `exchange-mail: succeeded (0 items, 0 bytes)`
    - `onedrive: succeeded (0 items, 0 bytes)`
    - `sharepoint-sites: succeeded (7 items, 12049 bytes)`
    - `teams: succeeded (11 items, 271885 bytes)`
    - `planner: succeeded (8 items, 11975 bytes)`
  - **4. Store read-back now vs Q62 Run A:**

    | workload | rows / bytes now | Q62 A | sync keys now (Q62 A) |
    |---|---|---|---|
    | exchange-mail | 23 / 15,468 | 2 / 892 | 2 (2) |
    | group-conversations | 3 / 9,496 | 3 / 9,496 | – |
    | onedrive | 2 / 1,771 | 2 / 1,771 | 1 (1) |
    | planner | 5 / 2,479 | 5 / 2,479 | – |
    | sharepoint-sites | 888 / 7,733,964 | 889 / 2,735,364 | 88 (28) |
    | teams | 11 / 271,885 | 22 / 529,592 | – |

    - Rows added by this run: sharepoint-sites 7 (12,049 bytes). The other workloads added 0: delta, or deduped against the stored version.
    - Differences since Q62 come from later items, not this run:
      - exchange-mail +21: the Q63/Q68/Q70/Q72 messages, folders, events and contacts (5 messages stored).
      - sharepoint-sites sync keys 28 → 88, from #273's items:/site: keys (Q64).
      - sharepoint bytes up, from the Q69 file fixtures.
    - Teams and sharepoint row counts fell because the **00:00 UTC prune ran in apply mode** (PR #335 merged 19:40 UTC). Job d66ec3a8
      succeeded; its retention_prune_report row is `apply`, with snapshots_deleted 25, versions_deleted 745 and chunks_deleted 744. That
      is exactly what Q83's dry run predicted. Snapshot count is now 308.
  - **5. Worker log 01:00–01:04:** no error, retry, throttle or timeout lines.
  - No workload failed, so no issue opened.
- Do (read-only: no tenant writes, no schedule or job changes, no reruns):
  1. Report the deployed build of /opt/keel-live and the content-collect schedule row (enabled, last run, next_due_at).
  2. Find the content-collect job(s) started from 2026-10-16 00:55 UTC: id, start/end time, final status, exit code.
  3. Per workload (exchange-mail, onedrive, sharepoint-sites, teams, planner, and any other it ran): status, items, bytes,
     and for any partial or failed workload the reason verbatim (tenant names masked).
  4. Store read-back per workload (rows / bytes) and sync-key counts, compared with the Q62 Run A read-back.
  5. Anything else in the worker log for that run that looks wrong (errors, retries, timeouts).
- **Report:** in this Result. If a workload failed, also open an `operator-report` issue for it (one per distinct bug).

### Q92: Retry the global quarantine settings write after the global settings were saved in Defender (issue #339; no-change probe)
- Drafted by the "Quarantine global pipe" thread (2026-10-16). At 09:02Z the human operator opened Defender > Quarantine policies >
  Global settings and saved once with no change. This retries Q89 and Q90 to see whether the object is now settable, and which form works.
- Needs: nothing. Restorer via `/etc/keel/exchange-restorer.json`, image `keel-powershell:latest`. Steps 2-4 mount `/opt/keel-live/ops/powershell`
  over /app as in Q89. Step 5 mounts the branch scripts as in Q90 (`git fetch origin claude/project-thread-yw9qlk && mkdir -p /tmp/keel-q92 &&
  git archive 247842d ops/powershell | tar -x -C /tmp/keel-q92`, mounted at /app), because only that branch can pipe.
- Status: done
- Result: Done 2026-10-16 09:04–09:08 UTC. Restorer (exchange-restorer.json) through run-cmdlet, `keel-powershell:latest`. Steps 2–4 mounted
  /opt/keel-live/ops/powershell; step 5 mounted branch 247842d's scripts (/tmp/keel-q92, removed afterwards). **No change**: each Set- wrote
  back the value step 1 read. Global admin not used.
  - **1.** Get-QuarantinePolicy (GlobalQuarantinePolicy): ok true, 1 object.
    - **Name `DefaultGlobalTag`, Identity `DefaultGlobalTag`**: the save in Defender changed it from Q89's `<org>.onmicrosoft.com\DefaultGlobalPolicy`.
    - WhenChangedUTC 2026-10-16T09:02:40Z (the Defender save). OrganizationBrandingEnabled False.
  - **2.** Identity `DefaultGlobalTag`: **ok true.**
  - **3.** Identity = the Name (`DefaultGlobalTag`): **ok true.**
  - **4.** Identity = the full Identity (`DefaultGlobalTag`): **ok true.**
  - **5.** Piped (`pipeFrom: global-quarantine-settings`, branch 247842d): **ok true.**
  - **6.** Get again: OrganizationBrandingEnabled **False**, unchanged; WhenChangedUTC still 09:02:40Z.
  - **Reading:** the global quarantine settings had never been initialized as a settable tag. Saving them once in Defender created
    `DefaultGlobalTag`, and now every form works, including #346's `-Identity DefaultGlobalTag`. The exchange-extended capture can be rerun
    to prove `quarantine-global-settings.update`. Commented on #339.
- Do (test tenant only; one tenant-wide object, every Set- writes back the value step 1 read):
  1. Get-QuarantinePolicy `{"QuarantinePolicyType":"GlobalQuarantinePolicy"}`: report `ok`, the object count, and `Name`, `Identity` (org masked),
     `WhenChangedUTC` and `OrganizationBrandingEnabled`.
  2. Set-QuarantinePolicy `{"Identity":"DefaultGlobalTag","OrganizationBrandingEnabled":<value from step 1>}`.
  3. The same with `"Identity":"<the Name from step 1>"`.
  4. The same with `"Identity":"<the full Identity from step 1>"`.
  5. The piped form from Q90: `{"cmdlet":"Set-QuarantinePolicy","parameters":{"OrganizationBrandingEnabled":<value>},"pipeFrom":"global-quarantine-settings",...}`.
  6. Repeat step 1 and confirm `OrganizationBrandingEnabled` is unchanged.
  Run every step even if an earlier one succeeds. If any Set- writes a value other than the one step 1 read, put it back. Remove /tmp/keel-q92 afterwards.
- **Report:** for steps 2-5, `ok` and, on failure, the message and `errorId` verbatim (org masked as `<org>`). For steps 1 and 6, the values above.
  Then comment the findings on issue #339 as keel-operator.

### Q92: Rerun the teams-org-policies writer capture after #343, on the KEEL-RT- meeting policy Marouane created
- Drafted by the "Teams meeting policy 403" thread (2026-10-16), for issue #339 (Teams part). Q86 showed Teams refuses
  New-CsTeamsMeetingPolicy for the app-only Restorer. PR #343 (merged as 4a4846d) drops `teams.meeting-policy.add`, so the capture no
  longer tries it. Marouane created a KEEL-RT- meeting policy by hand in the Teams admin center (2026-10-16), so
  `teams.meeting-policy.update` now has a fixture (the capture matches the KEEL-RT- prefix).
- Needs: `/opt/keel-live` at 4a4846d or later (it also has 964994f, which records the MicrosoftTeams pin 7.9.0 instead of the
  ExchangeOnlineManagement version).
- Status: done
- Result: Done 2026-10-16 09:10–09:20 UTC on B = 244756bd (includes 4a4846d, #343, and 964994f), default image `keel-powershell:latest`,
  `--allow-tenant-wide-test-writes`, no `--module-version`. Test tenant only; Restorer Teams app-only. Global admin not used.
  - **Capture: exit 0. verify --require-live: exit 0.** No exit 3; needsManualRevert [].
  - `teams.meeting-policy.update` on fixture **KEEL-RT-meeting** (Marouane's): **not proven**. ok false, readBackVerified false,
    restoredToOriginal false (nothing written).
    - error: `Set-CsTeamsMeetingPolicy failed: … {"code":"Forbidden","message":"You are not authorized to perform this action",…,"errorCode":40301}`
    - Q86's Set on a missing name answered 40407 "not found", so that lookup happens before authorization. App-only **writes** to meeting
      policies are refused altogether, not only New-.
  - `teams.meeting-policy.add` **not attempted** (confirmed absent from the record). `subject.execution.moduleVersion` = **7.9.0**.
  - Proven again (6): messaging-policy add and update; client, guest meeting, guest messaging and guest calling configuration update
    (tenant-wide). Federation skipped (no harmless field). Created `KEEL-RT-capture-368138eb` (messaging), assigned to nobody.
  - **PR #347** (`claude/live-evidence-teams-org-policies`, automerge), replacing the 2026-10-15 record.
    Import from that checkout: `workload-writers-teams-org-policies-live-acceptance.json` **imported, writes 6**.
    - The same import **refused** two older master records:
      - exchange-extended (from #344): "the object named to Set-QuarantinePolicy is not the KEEL-RT- fixture recorded".
      - teams-voice-policies (2026-10-15): "captured at MicrosoftTeams 3.10.1, but the read proof in this import is at 7.9.0". I passed the EXO
        pin to that Teams run.
    - keel-operator is recapturing both now.
- Do (test tenant only; the same put-back writes as your last teams-org-policies run):
  1. The teams-org-policies capture, as your last run, with `--allow-tenant-wide-test-writes` and the default image
     `keel-powershell:latest`, at the deployed build. Leave `--module-version` out (the capture reads the pin), or pass 7.9.0.
  2. `node tools/release/qualification.mjs verify --require-live --gate workload-writers-live-acceptance --evidence <the record>`.
  3. Commit the record and its `.capture.json` to a `claude/live-evidence-teams-org-policies` PR (automerge), replacing the 2026-10-15
     teams-org-policies record, then run `node cli/keel-workload-collect.mjs import`.
- **Report:** the capture exit code; for `teams.meeting-policy.update` the fixture name, `ok`, `readBackVerified`, `restoredToOriginal`
  and `error` (or its skip reason); confirm no `teams.meeting-policy.add` was attempted and `subject.execution.moduleVersion` is 7.9.0;
  the verify exit code; the import line for teams-org-policies; and the PR link. Exit 3 means a setting may not be back: report the
  object, field and original value it names.

### Q93: Rerun the exchange-extended writer capture now that DefaultGlobalTag exists (issue #339)
- Drafted by the "Quarantine global pipe" thread (2026-10-16). Q92 (quarantine) showed that the Defender save created `DefaultGlobalTag`,
  and Set-QuarantinePolicy `-Identity DefaultGlobalTag` (#346, already on master) now works. No code change is needed; the pipe branch is not merged.
- Needs: `/opt/keel-live` at 244756b or later. If the exchange-extended recapture you started after Q92 (teams) already ran at such a
  commit, record its result here instead of running again.
- Status: done
- Result: Done 2026-10-16 09:20–09:40 UTC on B = 95ba5a04, as Q88: default image `keel-powershell:latest`, `--allow-tenant-wide-test-writes`,
  `--module-version 3.10.1`. Test tenant only; Restorer EXO app-only. Global admin not used.
  - A first rerun at 244756bd also proved it, but its verify failed only on "build mismatch" (the auto-deploy moved to 95ba5a04 mid-run).
    So it was captured again at 95ba5a04, and this record is that one.
  - **Capture: exit 0.** `exchange-extended.quarantine-global-settings.update`: **ok true, readBackVerified true, restoredToOriginal true**,
    field **OrganizationBrandingEnabled**, fixture `DefaultGlobalTag`, error none.
    - Also proven: `connection-filter-policy.update`. No exit 3; needsManualRevert [].
  - **verify --require-live: exit 0.**
  - **Import** (from the PR checkout): `workload-writers-exchange-extended-live-acceptance.json` **imported, writes 2**; refused [].
  - **PR #348** (`claude/live-evidence-workload-writers-3`, automerge), replacing #344's exchange-extended record. It also carries the teams-voice-policies
    recapture at MicrosoftTeams 7.9.0 (20 writes). That replaces the 2026-10-15 record the import refused for its 3.10.1 module pin.
  - Commented on #339.
- Do: exactly Q88's steps (default image `keel-powershell:latest`, `--allow-tenant-wide-test-writes`, `--module-version 3.10.1`), with
  the record in a new evidence PR (automerge) that replaces #344's exchange-extended record.
- **Report:** the capture exit code; for `exchange-extended.quarantine-global-settings.update` the `ok`, `readBackVerified`,
  `restoredToOriginal`, `field` and `error`; the verify exit code; the import line; and the PR link. Exit 3: report the object, field and
  original value it names.

### Q94: Recapture and publish step 35 (roleAssignment create) from its Q51 restore — issue #148
- Drafted by the #148 thread (2026-10-16).
- Status: done
- Result: done (2026-10-16). Build 050a1ab. **Captured** from the Q51 C restore (R35E, approval d32e6111, snapshot ced73acb), with no
  new restore and no tenant write. `pseudonymize.mjs check` on the record and capture log: **exit 0**, every id is a pseudonym.
  **Promoted**: fixture-tested -> live-qualified. Scans are clean apart from the fixture user's UPN in the natural key, as in
  the records already on master. PR #352 (`claude/live-evidence-q94`, automerge): roleAssignment.create{,.capture}.json only.
- Needs: nothing. #237 is live.
- **Test tenant only.** No new restore and no tenant writes. This only reads the journal and snapshot of Q51 C's restore (the job
  run under approval d32e6111, snapshot ced73acb), as Q53 did for step 37.
- **Why.** The step 35 record on `claude/live-evidence-q51` was not published by #350: `pseudonymize.mjs check` flags one raw role
  assignment id in its capture log (`targetId` and both `id` fields). It is the only #148 write that passed live without
  a published record.
- **A. Capture.** `entraLive capture` for step 35 (roleAssignment create, `--allow-by-reference`) from that restore ref, with the
  same fixture key as Q51 C. Expected: captured. A refusal is a result: report it verbatim and stop.
- **B. Check.** `node tools/qualification/pseudonymize.mjs check` on the new record and capture log must exit 0. If it still
  lists a raw id, report the field names (never the id) and stop.
- **C. Promote and publish.** `promote` it, run the usual public-repo scans, then commit
  `roleAssignment.create{,.capture}.json` to a new branch `claude/live-evidence-q94` from `origin/master` and open a PR with
  the `automerge` label. No other files.
- **Report:** captured / promoted / refused, the check exit code, and the PR link.

### Q95: Recapture and publish group update (Q45 step 2) — issue #148
- Drafted by the #148 thread (2026-10-16).
- Status: done
- Result: done (2026-10-16). Build 0683b63. **Captured from Q45**, from restore c8401172 (journal `group:KEEL-RT-148-group | update |
  succeeded`). No new restore and no tenant write. `pseudonymize.mjs check`: **exit 0**, every id is a pseudonym.
  **Promoted**: fixture-tested -> live-qualified. Scans clean. PR #355 (`claude/live-evidence-q95`, automerge):
  group.update{,.capture}.json only. No cleanup needed (path A).
- Needs: nothing. `pseudonymize.mjs` now covers `securityIdentifier` (the reason Q45 held this record back).
- **Test tenant only.** Never target, assign or drift marouane.defili.
- **Why.** Q45 promoted group update on the host but held back its record and capture because they carried
  `securityIdentifier`. No later run published it, so it is one of the last #148 writes without a published record.
- **A. Capture from Q45 if possible.** If Q45's group update restore (step 2) still has its journal and snapshot in KEEL's
  database, run `entraLive capture --resource-type group --operation update` from that restore ref, as Q94 did for step 35.
  No new restore and no tenant write.
- **A'. Otherwise, a fresh run.** Create a disposable group `KEEL-RT-148-group-upd` (security, no members), back it up, change
  its `description` by hand, then restore it with a selection of that group (dry run, approval with the usual
  requester/approver split, `--enforce`). Then capture as above. A refusal is a result: report it verbatim and stop.
- **B. Check.** `node tools/qualification/pseudonymize.mjs check` on the record and capture log must exit 0. If it lists a raw
  value, report the field names (never the value) and stop.
- **C. Promote and publish.** `promote`, run the usual public-repo scans, commit `group.update{,.capture}.json` only to a new
  branch `claude/live-evidence-q95` from `origin/master`, and open a PR with the `automerge` label.
- **D. Cleanup** (A' only): delete and purge `KEEL-RT-148-group-upd`.
- **Report:** captured from Q45 or fresh, promoted or refused, the check exit code, and the PR link.

### Q96: Live proof of Conditional Access policy delete (runbook step 52) — issue #148
- Drafted by the #148 thread (2026-10-16).
- Status: refused
- Result: refused (2026-10-16). Build 0683b63. Break-glass readiness: **ready** (`overall: ready`, `every-account-ready`).
  - **A. Fixture.** Report-only `KEEL-RT-148-ca-delete`, created with the Restorer. Read back: state
    `enabledForReportingButNotEnforced`, includes carla only, excludes marouane.defili and both break-glass accounts, no
    target apps (`None`). It was never turned on.
  - **B. Backup.** Snapshot c9e64b5a holds the policy. The delete CLI refuses a key that its source snapshot holds, so, as in
    Q46 B, the delete ran from 5241aa74 (19:00 UTC, taken before the policy existed).
  - **C. Dry run: refused** (artifact status `refused`, nothing sent for approval or enforced). Verbatim, with the id replaced:
    `refusing to delete conditional access policy: <operator break-glass account> is excluded by conditions.users.excludeUsers`
    The lockout delete guard refuses any CA policy that excludes a break-glass account, and Q96 requires that exclusion.
    Proving this delete live needs a guard change or a different fixture shape; that is the #148 thread's decision.
  - **D.** Not run: no restore, so no capture.
  - **E. Cleanup.** I deleted the policy myself with the Restorer (Graph DELETE 204). A lookup by name now finds nothing.
- Needs: break-glass readiness **ready** (as in Q46 B). If it is not ready, report the readiness line verbatim and stop.
- **Test tenant only.** Never target, assign or sign in as marouane.defili.
- **The policy is never turned on.** It stays report-only for its whole life, and it excludes marouane.defili and both
  break-glass accounts (Emergency access and the operator's own break-glass account). Check the exclusions before the backup.
- **Why.** CA policy delete is the only registered delete never run live. It goes through the same lockout delete guard that
  passed for named location delete in Q46 B.
- **A. Fixture.** Create a report-only CA policy `KEEL-RT-148-ca-delete` that targets only carla (or another KEEL-RT test user,
  never marouane.defili), with the exclusions above.
- **B. Back up** so the snapshot contains it.
- **C. Delete through KEEL**, exactly as Q46 B: `node cli/keel-restore.mjs --snapshot-id <S> --delete
  conditionalAccessPolicy:KEEL-RT-148-ca-delete` dry run, approval with the usual requester/approver split, then
  `--artifact <id> --enforce`. Expected: allowed, applied 1, and Graph returns 404 for the policy (it may sit in CA deleted
  items; that is fine). A refusal is a result: report it verbatim and stop.
- **D. Capture, check, promote, publish.** `entraLive capture --resource-type conditionalAccessPolicy --operation delete`
  from that restore, `pseudonymize.mjs check` (must exit 0), `promote`, the usual scans, then commit
  `conditionalAccessPolicy.delete{,.capture}.json` only to a new branch `claude/live-evidence-q96` from `origin/master`
  and open a PR with the `automerge` label.
- **E. Cleanup.** Nothing else to delete if C worked. If C was refused, delete the policy yourself and say so.
- **Report:** the dry run and enforce results (or the refusal verbatim), the check exit code, and the PR link.

### Q97: Rerun Q96 (CA policy delete) with a fixture that excludes only marouane.defili — issue #148
- Drafted by the #148 thread (2026-10-16).
- Status: blocked
- Result: blocked (2026-10-16). marouane.defili **is one of the two registered break-glass accounts** (checked against
  `keel-breakglass.mjs report`; readiness `ready`). The account the Q96 refusal names (`... is excluded by
  conditions.users.excludeUsers`) is that same account; Q96 labelled it "the operator's break-glass account". So a fixture
  that excludes marouane.defili is refused by the same guard. I created no fixture and ran no dry run, so nothing was
  written. A live CA delete proof needs one of these, which is the #148 thread's or Marouane's decision:
  (a) a fixture that excludes nobody (it targets only carla, is report-only and has no target apps), which breaks the rule
  that Marouane is excluded from every new CA policy; or
  (b) deregistering marouane.defili as a break-glass account.
- Needs: break-glass readiness **ready**, as in Q96.
- **Test tenant only.** Never target, assign or sign in as marouane.defili. The policy is never turned on.
- **Why.** Q96 was refused by the deletion guard (`engine/safety/deletionGuard.mjs`, spec M2.5): KEEL never deletes a CA
  policy that excludes a break-glass account. That is by design, so the fixture changes, not the guard. The policy targets
  only carla, so the break-glass accounts are outside it anyway; excluding them was the thread's own extra. Marouane's rule
  (he is excluded from every new CA policy) still holds.
- **A. Fixture.** Report-only `KEEL-RT-148-ca-delete`, includes carla only, excludes **marouane.defili only**, no other
  exclusions (no break-glass accounts, groups or roles). Read it back before the backup.
- **B-E.** Exactly Q96 B to E: back up, delete from a snapshot taken before the policy existed (dry run, approval with the
  usual requester/approver split, `--artifact <id> --enforce`), then capture, `pseudonymize.mjs check` (exit 0), promote,
  scans, and `conditionalAccessPolicy.delete{,.capture}.json` only on a new branch `claude/live-evidence-q97` from
  `origin/master`, PR with the `automerge` label.
- **If the dry run refuses because marouane.defili itself is a registered break-glass account,** report that (no id) and
  stop. Delete the policy yourself.
- **Report:** the dry run and enforce results (or the refusal verbatim), the check exit code, and the PR link.

### Q98: CA policy delete live proof with a fixture that excludes nobody (Marouane chose this, 2026-10-16 20:27 UTC) — issue #148
- Drafted by the #148 thread (2026-10-16).
- Status: done
- Result: done (2026-10-16). Build 46a5e5e. Break-glass readiness **ready**. Marouane also confirmed the exception in the
  operator's own session.
  - **A.** Report-only `KEEL-RT-148-ca-delete`, created with the Restorer. Read back: `enabledForReportingButNotEnforced`,
    includes carla only, 0 exclusions, apps `None`. It was never turned on.
  - **B.** The backup put the policy in the newest collection. The delete ran from the last snapshot taken before the policy
    existed, which does not hold it.
  - **C.** Dry run **allowed**: delete wave 1/1, applied 1, skipped 0, artifact `completed`. Self-approved
    (Entra requester, Gmail approver). Worker job `succeeded`, journal `delete | succeeded`, Graph **404**.
  - **D.** Capture exit 0. `pseudonymize.mjs check`: **exit 0**. **Promoted**: fixture-tested -> live-qualified. Scans clean.
    PR #358 (`claude/live-evidence-q98`, automerge): conditionalAccessPolicy.delete{,.capture}.json only.
  - **E.** Nothing left in the tenant. Fixture lifetime: about 6 minutes.
- Needs: break-glass readiness **ready**, as in Q96.
- **Marouane's decision.** Q97 was blocked because marouane.defili is a registered break-glass account, so any policy that
  excludes him is refused by the deletion guard. On the #148 decision card he chose "No exclusion" for this one fixture.
  This exception covers only `KEEL-RT-148-ca-delete` in this item. Every other new CA policy still excludes him.
- **Test tenant only.** Never target, assign or sign in as marouane.defili. The policy is **never turned on**.
- **A. Fixture.** Report-only `KEEL-RT-148-ca-delete`: includes carla only, **no exclusions**, no target apps (`None`).
  Read it back (state `enabledForReportingButNotEnforced`, include list carla only) before the backup.
- **B-E.** Exactly Q96 B to E: back up, delete from a snapshot taken before the policy existed (dry run, approval with the
  usual requester/approver split, `--artifact <id> --enforce`), then capture, `pseudonymize.mjs check` (exit 0), promote,
  scans, and `conditionalAccessPolicy.delete{,.capture}.json` only on a new branch `claude/live-evidence-q98` from
  `origin/master`, PR with the `automerge` label.
- **Keep the fixture short-lived.** Run A to C back to back. If anything stops the delete, delete the policy yourself at
  once with the Restorer and say so.
- **Report:** the dry run and enforce results (or the refusal verbatim), the check exit code, and the PR link.

### Q99: Backup coverage numbers per service, for the executive report (read-only, DB and logs only)
- Drafted by the "Backup coverage audit" thread (2026-10-21). Marouane asked how much Keel backs up per service and why the
  rest is not. The code says what Keel *can* collect; this item gives the live numbers. Findings go to
  `/mnt/project-files/handoff/backup-coverage/REPORT.md` (the thread writes it, not you).
- Needs: nothing. Run from your own clone checked out at the commit `/opt/keel-live` is deployed at (never `/opt/keel`),
  with `npm ci` in `engine/` if needed. No tenant calls, no job, schedule or config changes, no reruns.
- Status: done
- Result: done (2026-10-21). Deployed build **1a7df63** (my clone was detached at it). DB reads only: nothing written to the tenant
  or the DB.
  - **1. Schedules** (all enabled; last run, then next due):

    | job_kind | tier | cadence | last run (UTC) | status | next due |
    |---|---|---|---|---|---|
    | collect | tier1 | hourly | 10-21 19:00 | succeeded | 10-21 20:00 |
    | collect | tier2 | daily 00:00 | 10-21 00:01 | succeeded | 10-22 00:00 |
    | collect | tier3 | weekly 00:00 | 10-19 00:01 | succeeded | 10-26 00:00 |
    | content-collect | | daily 01:00 | 10-21 01:02 | succeeded | 10-22 01:00 |
    | workload-collect | | daily 02:00 | 10-21 02:01 | succeeded | 10-22 02:00 |
    | prune | | daily 00:00 | 10-21 00:02 | succeeded | 10-22 00:00 |
    | discover | | weekly 04:00 | 10-19 04:01 | succeeded | 10-26 04:00 |
    | api-drift | | weekly 03:00 | 10-19 03:01 | succeeded | 10-26 03:00 |
  - **2. Coverage report:** exit 0. Full JSON (masked) at `ops/q99/coverage.json` on `claude/q99-coverage-numbers` @ 01e6050.
    - 1 tenant. Summary: **covered 90** (62 complete, 28 complete-empty), failed 0, **unavailable 4**, notCovered 0,
      **neverCollected 10**, stale 0. Newest snapshot complete at 10-21 19:00.
    - Unavailable: lifecycleWorkflow, lifecycleWorkflowCustomTaskExtension and lifecycleManagementSettings (403, "Insufficient
      license ... Entra ID Governance"); identityApiConnector (400 AADB2C99039, "self service sign up is not enabled").
    - Never collected (`not-requested`): applePushNotificationCertificate, mobileThreatDefenseConnector,
      deviceManagementPartner, complianceManagementPartner, remoteAssistancePartner, deviceManagementExchangeConnector,
      onPremisesConditionalAccessSettings, mobileAppCategory, intuneBrandingProfile, customAuthenticationExtension.
  - **3. Config workloads**, newest run each (10-21 02:02):

    | workload | outcome | resources |
    |---|---|---|
    | exchange-mailbox-settings | complete | 2 |
    | onedrive-site-settings | complete | 1 |
    | purview-labels | complete | 21 |
    | sharepoint-site-settings | complete | 21 |
    | teams-settings | complete | 11 |
    | exchange-extended | disabled | 0 |
    | exchange-mail-flow | disabled | 0 |
    | power-platform-settings | disabled | 0 |
    | purview-governance | disabled | 0 |
    | purview-retention-dlp | disabled | 0 |
    | teams-org-policies | disabled | 0 |
    | teams-voice-policies | disabled | 0 |
    - Last 7 days: 11 runs each. Every disabled workload was disabled in all 11. The five complete workloads were complete in
      all 11, except teams-settings (9 complete, 2 partial). No failures.
    - Reasons for each non-complete newest run (verbatim, masked):
      - exchange-mail-flow: "mailflow.{accepted-domains, remote-domains, transport-rules, inbound-connectors,
        outbound-connectors, anti-spam-policies, anti-phish-policies, anti-malware-policies, dkim-signing} is disabled".
      - exchange-extended: "exchange-extended.{outbound-spam-policies, outbound-spam-rules, connection-filter-policies,
        anti-spam-rules, anti-phish-rules, anti-malware-rules, eop-preset-rules, quarantine-policies,
        quarantine-global-settings, journal-rules, mobile-device-policies, device-access-rules, activesync-settings,
        address-lists, global-address-lists, offline-address-books, ...} is disabled".
      - purview-retention-dlp: "purview.retention-policies is disabled", "purview.retention-rules is disabled".
      - purview-governance: "purview.retention-labels is disabled", "purview.adaptive-scopes is disabled"; and
        "purview.ediscovery-cases / case-holds / case-hold-rules is pending-prerequisite: ... assign it the eDiscovery Manager
        role."
      - teams-org-policies and teams-voice-policies: every operation "is pending-prerequisite: To read teams ..., assign it the
        Teams Administrator role."
      - power-platform-settings: "powerplatform.environments is pending-prerequisite: To read power platform environments,
        assign it the Power Platform Administrator role."
    - **Correction (2026-10-21 20:35 UTC):** an earlier version of this Result listed two "findings". Both were wrong:
      the query took the newest run that was *not* complete, which was an old run. purview-labels' "Organization cannot be
      null" `ConnectFailed` is from a failed run on 10-14. Every run since has been complete with no failures and
      21 observations. sharepoint-site-settings' "is disabled" reasons are also from an older run; its newest runs (10-21
      02:02 and 20:27) are complete with no reasons.
  - **4. Content backup:**

    | workload | containers | items | versions | bytes | stored new bytes | newest |
    |---|---|---|---|---|---|---|
    | exchange-mail | 7 | 19 | 23 | 15 468 | 16 076 | 10-15 |
    | group-conversations | 1 | 3 | 3 | 9 496 | 9 592 | 10-15 |
    | onedrive | 1 | 1 | 2 | 1 771 | 1 835 | 10-15 |
    | planner | 1 | 5 | 5 | 2 479 | 2 639 | 10-15 |
    | sharepoint-sites | 4 | 751 | 896 | 7 740 745 | 7 173 223 | 10-19 |
    | teams | 11 | 1 | 12 | 303 318 | 303 702 | 10-17 |
    - Chunks: 887, holding 7 507 067 stored bytes.
    - Only 6 content-collect jobs exist (10-16 to 10-21), each taking about 90 s. 5 succeeded and 1 failed, on 10-17. The
      10-21 job's lines are typical: "exchange-mail: succeeded (0 items, 0 bytes) ; onedrive: succeeded (0 items, 0 bytes) ;
      sharepoint-sites: succeeded (0 items, 0 bytes) ; teams: succeeded (11 items, 271885 bytes) ; planner: succeeded
      (8 items, 11975 bytes)". sharepoint-sites read 7 items on 10-16 and 8 on 10-19.
    - The 10-17 job failed with exit 1: "teams: partial (11 items, 271684 bytes): KEEL-RT-20260908 Collaboration Hub: 1
      part(s) not read, first channel KEEL-RT-20260908 Finance Private member...".
  - **5. Config snapshots:** 412 in total.
    - Newest completed: tier1 10-21 19:00, tier2 10-21 00:02, tier3 10-19 00:01, plus 13 manual collects (newest 10-20 16:41).
    - Collect jobs in the last 7 days: tier1 160 ok / 8 failed, tier2 6 / 1, tier3 1 / 0.
    - The failures are on 10-15, 10-16, 10-17 and 10-19. Most exited 1 after the snapshot completed; that is the
      unavailable-types error in #309. Two tier1 runs exited with code null mid-collect (10-15 14:00, 10-17 21:00).
  - **6. Tenant size**, from the newest snapshots: users 104, groups 57, enterprise apps (service principals) 577, app
    registrations 49, managed devices 0 (none in any snapshot). Discovery run 2 found 104 users, 57 groups, 11 teams and
    1 site.
    - Content backup reads only what `namePrefix: KEEL-RT-` allows: mail from 7 mailboxes, 1 OneDrive, 4 sites, 11 teams.
    - The workload backups read 1 mailbox, 1 OneDrive and 11 teams.
  - **7. Scope files:**
    - `content-scope.json` (root 600): `namePrefix: KEEL-RT-`, `tenantHost: <org>.sharepoint.com`.
    - `workload-scope.json` (root 644): `sharepointHost` and `onedriveHost` (masked); `mailboxes` (1 entry, keel-rt);
      `onedriveSites` (1 entry, a keel-rt personal site URL); `powershellConfigs` (exchange: exchange-collector.json;
      onedrive and purview: purview-collector.json).
- Do (all with `set -a; . /etc/keel/db.env; set +a`):
  1. Deployed build of `/opt/keel-live`, and every `schedule` row: job_kind, tier, enabled, last run time and status, next_due_at.
  2. Coverage report as the portal builds it. Save as `<clone>/engine/q99-coverage.mjs` (scratch, never commit) and run
     `node q99-coverage.mjs > /tmp/q99-coverage.json` from `<clone>/engine`; report the exit code and paste the JSON
     (mask tenant names in `message` text):
     ```js
     import { connect } from './store/db.mjs';
     import { buildCoverageReport } from './coverage/report.mjs';
     import { CATALOG } from '../tools/tenant-probe/catalog.mjs';
     import { DESCRIPTORS } from './collect/descriptors.mjs';
     const c = await connect(process.env.KEEL_DB_URL);
     const refs = (await c.query('SELECT tenant_ref, count(*)::int n FROM snapshot GROUP BY 1 ORDER BY 2 DESC')).rows;
     const r = await buildCoverageReport(c, { tenantRef: refs[0].tenant_ref, catalog: CATALOG, descriptors: DESCRIPTORS, now: new Date() });
     console.log(JSON.stringify({
       tenants: refs.length, summary: r.summary, snapshot: r.snapshot,
       types: r.types.map((t) => [t.type, t.status, t.outcome, t.itemCount, t.lastCollectedAt, t.stale,
         t.detail?.httpStatus ?? null, t.detail?.graphCode ?? null, String(t.detail?.message ?? '').slice(0, 160)]),
       workloads: r.workloads.map((w) => [w.workload, w.status, w.resources, w.observation?.endedAt ?? null, w.outOfScope,
         JSON.stringify(w.reasons).slice(0, 300)]),
     }, null, 1));
     await c.end();
     ```
  3. Config workloads, newest run each, as SQL:
     ```sql
     SELECT DISTINCT ON (wc.workload) wc.workload, wc.outcome, wc.observed_to,
            (SELECT count(*) FROM workload_observation o WHERE o.collection_id = wc.id) AS resources
       FROM workload_collection wc ORDER BY wc.workload, wc.created_at DESC;
     ```
     plus, per workload, how many runs in the last 7 days and how many of those were `complete`/`partial`/`failed`/`disabled`.
     For any workload whose newest run is not `complete`, the digest `reasons` verbatim (masked).
  4. Content backup totals per workload:
     ```sql
     SELECT workload, count(DISTINCT container) containers, count(DISTINCT item_key) items, count(*) versions,
            sum(bytes) bytes, sum(new_bytes) stored_new_bytes, max(created_at) newest
       FROM content_item GROUP BY 1 ORDER BY 1;
     SELECT count(*) chunks, sum(stored_bytes) stored_bytes FROM content_chunk;
     ```
     and the last 7 `content-collect` jobs: id, start, end, status, and the per-workload lines (items, bytes, status) from
     the worker log, verbatim.
  5. Config snapshots: total count, newest completed per tier (id masked, completed_at, status), and per tier how many of the
     last 7 days' runs succeeded vs failed.
  6. Tenant size for context, from the newest snapshot (counts only): users, groups, enterprise apps, managed devices
     (`SELECT resource_type, count(*) FROM resource_version WHERE snapshot_id = <newest tier1/tier2/tier3> GROUP BY 1`),
     and how many mailboxes, OneDrives, SharePoint sites and teams the newest content and workload runs found vs read.
  7. The backup scope files, with names masked except the prefix: `/etc/keel/content-scope.json` and
     `/etc/keel/workload-scope.json` (keys and the namePrefix value; for lists such as `mailboxes` or `sites`, how many
     entries and whether they all start with `KEEL-RT-`). Leave out any secret or certificate path contents.
- **Report:** steps 1 to 6 in this Result (big JSON can go in a gist-free file on a new branch
  `claude/q99-coverage-numbers` under `ops/q99/`, never master). Nothing is written to the tenant or the DB.

### Q100: Export the "readable, not backed up yet" list from the latest discovery run (read-only, DB only)
- Drafted by the "Back up remaining readable kinds" thread (2026-10-21). Marouane asked to add the 276 kinds discovery
  can read but Keel doesn't back up yet. The thread needs the list itself (path, version, object count) to plan and
  prioritise them. Only the counts are in the queue so far (Q82).
- Needs: nothing. No tenant calls, no job, schedule or config changes, no reruns. Can run before Q99; it is one SELECT.
- Status: done
- Result: done (2026-10-21). DB reads only, nothing written to the tenant or the DB.
  - **Step 1:** `summary->'counts'` is null for both runs, so here is `summary`:
    - run 2, finished 2026-10-19 04:06:13 UTC: types 1004, catalogued 83 (catalogue: covered 82, under-item 6, unreadable 6),
      **uncatalogued 275**, unreadable 574, not-listed 72; containers sites 1, teams 11, users 104, groups 57 (all exact).
    - run 1, finished 2026-10-15 18:29:10 UTC: the same, except uncatalogued 276 and unreadable 573.
  - **Step 2 (run 2): 380 rows** (`COPY 380`): 272 `graph:beta` + 108 `graph:v1.0`. That is **275 distinct paths**, matching
    the summary, because a path readable on both v1.0 and beta has one row per source. 242 distinct entity types.
    No GUIDs or tenant names in the file.
  - **Commit:** `ops/q100/uncatalogued.tsv` on `claude/q100-uncatalogued` @ 95a915d, pushed. No PR.
- Do (with `set -a; . /etc/keel/db.env; set +a`):
  1. ```sql
     SELECT r.id, r.finished_at, r.summary->'counts' AS counts FROM discovery_run r ORDER BY r.finished_at DESC LIMIT 3;
     ```
     (if `summary->'counts'` is null, paste `summary` instead, masked).
  2. For the newest run, as tab-separated output with a header:
     ```sql
     \copy (SELECT source, name, kind, entity_type, objects, objects_exact FROM discovery_item
             WHERE run_id = (SELECT id FROM discovery_run ORDER BY finished_at DESC, id DESC LIMIT 1)
               AND status = 'uncatalogued' ORDER BY name, source) TO '/tmp/q100-uncatalogued.tsv' WITH (FORMAT csv, DELIMITER E'\t', HEADER)
     ```
     These are Graph paths and counts only, no tenant content. Commit the file as `ops/q100/uncatalogued.tsv` on a new
     branch `claude/q100-uncatalogued` (never master) and push it.
- **Report:** step 1, the row count of step 2, and the branch commit. Nothing is written to the tenant or the DB.

### Q101: Widen the nightly content backup from KEEL-RT- fixtures to the whole tenant (read-only)
- Drafted by the "Content backup whole tenant" thread (2026-10-21).
- **Marouane's decision (2026-10-21 17:29 UTC, comment on the executive deck): "get everything in the scope".** Content
  backup covers the whole tenant, not only the `KEEL-RT-` test fixtures.
- Needs: nothing (Q99 and Q100 can run first or after; it does not change anything).
- Status: blocked
- Result: rolled back (2026-10-22 01:11 UTC). The first whole-tenant run failed because an auto-deploy restarted the worker mid-job, not because of scope or disk; the scope is back to `KEEL-RT-`. Read-only toward the tenant. Report: #448.
  - **A1.** `storage.root` is not in `tenant.json`; it is in `content-reader.json`: `/var/lib/keel/content`.
    - `/var/lib/keel/content`: on `/dev/sda1` (150G, 51G used, **94G free**, 35 %); `du -sh` 14M.
    - Postgres data (`keel-postgres-data` volume): the same `/` volume; `du -sh` 2.2G.
  - **A2.** Read with the Collector (Graph) and the Exchange collector, nothing else:
    - users 104 (32 licensed, 65 with mail); 53 Exchange mailboxes: 35 user, 5 shared, 10 room, 1 equipment, 1 scheduling.
    - **OneDrive: 14 drives, 47 632 839 070 bytes used.** 80 users have none (404). **10 answered 423 (locked)**, so their
      size is unknown and they are not in the estimate.
    - SharePoint: 44 sites from `getAllSites`, 20 of them non-personal, using 24 120 023 bytes (2 answered 404 on `drive`).
    - Teams: 11.
    - Mailboxes: `getMailboxUsageDetail(period='D7')` works only as CSV and returned just 2 rows (77 071 103 bytes), so I
      read `Get-EXOMailboxStatistics` for all 53 instead: **305 785 795 bytes**, 3 412 items, 1 mailbox not readable.
  - **A3. Gate: passed, narrowly.** Estimated first run 47 962 744 888 bytes (about 47.96 GB) against 50 % of the free
    space (100 343 046 144 / 2 = 50 171 523 072). Headroom is about 2.2 GB, and the 10 locked OneDrives are not counted.
    The six-hour job timeout may also be tight for about 48 GB.
  - **B.** Saved `content-scope.json.bak-q101` (`cp -p`), then rewrote the file without `namePrefix`; root 600 kept, parse
    check exit 0. New file: `{ "tenantHost": "<org>.sharepoint.com" }`. Content chunks before the run: 887, holding
    7 507 067 bytes.
  - **C. Run 2026-10-22 01:00 UTC: failed.**
    - Job `8c561147-ca3f-471d-b9b0-1e4348b2a5b6`: queued 01:00:01, started 01:01:56, ended 01:08:44, status `failed`, exit
      code `null`.
    - Cause: `keel-deploy` deployed master `b2948ad` (#442) at 01:08. It stopped `keel-worker` with SIGTERM at 01:08:44, and the
      worker terminated the in-flight job. Free space stayed at 64 % at every check.
    - exchange-mail: `partial`, 2 987 items, 187 551 579 bytes. Reasons (masked): `mailboxSettings <mailbox id>: 504
      UnknownError`; `<a group mailbox> (group): 1 read(s) failed (403 ErrorAccessDenied Access is denied. Check credentials and
      try again.)`.
    - OneDrive, SharePoint and Teams: not reached. Containers found vs read and the throttled count are not reported by the job
      or by `content_run`.
    - `df -h /`: 150G, 51G used, 93G free (36 %). `du -sh /var/lib/keel/content`: 14M before, 229M after.
    - `content_chunk`: 887 / 7 507 067 bytes before; 4 054 / 225 270 538 bytes after.
  - **Rollback** at 01:11 UTC: `content-scope.json.bak-q101` copied back (`namePrefix: KEEL-RT-`, root 600, parses). The
    whole-tenant file is kept at `/root/q101-scope-wholetenant.json`. Content already stored stays.
  - **Waiting on Marouane:** whether to re-apply the whole-tenant scope for another 01:00 UTC run. A deploy during the 6-hour
    window would stop it again unless deploys hold off while a `content-collect` job runs (a code or ops change).
- **Read-only toward the tenant.** The collectors only read. No tenant writes, no fixtures, no permission grants: if the
  Collector cannot read some mailboxes, drives or sites (403), report the count and the reason verbatim (masked) and do not
  grant anything. That is a separate decision.
- **A. Headroom check (before any change).** Report each number:
  1. `storage.root` from `/etc/keel/tenant.json` (path only): `df -h` and `du -sh` for it, and `df -h` for the Postgres
     data directory.
  2. Tenant content size, read-only, with the Collector's token: user count and licensed mailbox count; OneDrive used bytes
     summed from `GET /users/{id}/drive?$select=quota` (404 = no OneDrive); SharePoint site count and used bytes from
     `GET /sites/getAllSites` + each site's `drive?$select=quota`; team count. Mailbox bytes from
     `GET /reports/getMailboxUsageDetail(period='D7')` if the Collector has Reports.Read.All, otherwise say "no report
     access" and estimate from item counts.
  3. **Gate:** estimated first-run bytes (OneDrive + SharePoint + mailboxes) must be under **50 %** of the free space on the
     `storage.root` volume. If not, stop here, change nothing, and report the numbers.
- **B. Change the scope file.** `cp -p /etc/keel/content-scope.json /etc/keel/content-scope.json.bak-q101`, then write the
  file with **`namePrefix` removed** and every other key (such as `tenantHost`) unchanged, keeping owner and mode. Check it
  parses (`node -e "JSON.parse(require('fs').readFileSync('/etc/keel/content-scope.json','utf8'))"`, exit 0) and paste it
  (tenantHost masked). No restart is needed: the worker reads the file at each run. No manual run: the nightly
  `content-collect` at **01:00 UTC** is the first whole-tenant run (its job timeout is 6 h).
- **C. After the 2026-10-22 01:00 UTC run finishes:** the job id, start, end, status and exit code; per workload the
  outcome, items, bytes, containers found vs read, throttled count and any `reasons` verbatim (masked); `df -h` and
  `du -sh` for `storage.root` again, and `SELECT count(*), sum(stored_bytes) FROM content_chunk` before vs after.
- **Rollback:** if the run fails, times out, or free space on `storage.root` drops below 20 %, copy
  `content-scope.json.bak-q101` back over the scope file and say so. A `partial` outcome from 403s alone is not a rollback
  reason; report it.
- **Report:** A1-A3, the new scope file (masked), and C. Open an issue labelled `operator-report` only if a rollback happened.

### Q102: Recheck the SharePoint site settings finding from Q99 (read-only, DB only)
- Drafted by the "SharePoint site settings never read" thread (2026-10-21).
- Q99 finding 2 says sharepoint-site-settings reports `complete` while its reasons say "sharepoint.tenant-settings /
  site-discovery / site-properties / site-permissions is disabled". The Q99 JSON (`ops/q99/coverage.json` @ 01e6050) does
  not show that: its newest sharepoint-site-settings run is `complete`, 20 sites, 24 out of scope, reasons `[]`. In the code
  (`engine/collect/workloads/sharepoint.mjs`, `collectSharePointSites`) a run refused by the ledger is always written as
  `disabled`, never `complete`. This item finds out which rows the finding came from.
- Needs: nothing. No tenant calls, no job, schedule or config changes, no reruns.
- Status: cancelled (2026-10-21 20:55 UTC, by the drafting thread): not needed. The Q99 correction (20:35 UTC) already
  answers it: the "is disabled" reasons came from an older run, and the newest runs are complete with no reasons.
- Do (with `set -a; . /etc/keel/db.env; set +a`), tenant_ref masked to its last 4 characters:
  1. ```sql
     SELECT right(wc.tenant_ref::text, 4) AS tenant, wc.workload, wc.outcome, wc.created_at,
            wc.digest->'discovery'->>'sites' AS sites, jsonb_array_length(COALESCE(wc.digest->'reasons','[]'::jsonb)) AS n_reasons,
            left((wc.digest->'reasons')::text, 300) AS reasons,
            (SELECT count(*) FROM workload_observation o WHERE o.collection_id = wc.id) AS observations
       FROM workload_collection wc
      WHERE wc.created_at > now() - interval '8 days'
        AND (wc.workload = 'sharepoint-site-settings' OR (wc.digest->'reasons')::text LIKE '%sharepoint.%')
      ORDER BY wc.created_at DESC;
     ```
  2. ```sql
     SELECT right(tenant_ref::text, 4) AS tenant, workload, outcome, count(*), max(created_at)
       FROM workload_collection GROUP BY 1, 2, 3 ORDER BY 2, 1, 3;
     ```
  3. The exact query or command that produced the Q99 line "sharepoint.tenant-settings / site-discovery / site-properties /
     site-permissions is disabled", and the row it came from (workload, outcome, created_at).
- **Report:** steps 1 to 3 verbatim (masked). Say plainly whether any `complete` sharepoint-site-settings run has non-empty
  reasons. Nothing is written to the tenant or the DB.

### Q103: Live read check for four service settings groups, then turn them on (read-only toward the tenant)
- Drafted by the "Exchange and Purview live read checks" thread (2026-10-21). Source: Q99 section 3.
- Q99 shows `exchange-mail-flow`, `exchange-extended`, `purview-retention-dlp` and `purview-governance` as `disabled` every
  night: their reads have no live proof in the ledger. PR #425 adds the read-only capture that records it
  (`tools/qualification/workloadReadsLive.mjs`, gate `workload-reads-live-acceptance`; steps in
  `docs/roadmap/workload-reads-live-acceptance.md`).
- Needs: PR #425 live (`git -C /opt/keel-live log --oneline | grep -c "#425"` is 1, or `/opt/keel-live/tools/qualification/workloadReadsLive.mjs` exists).
- Status: done
- Result: done (2026-10-22 06:41 UTC). Step 5 was finished by **Q107**: records recaptured with the #427 fix, pseudonym check exit 0, published on `claude/live-evidence-q103` @ 701bd5a.
  - Earlier: partly done (2026-10-21), blocked on #427 for step 5. Live build **01df9af**; my clone was detached at it. Reads only
  toward the tenant: the collector credential sent only the declared `Get-` cmdlets. No grants, no role changes.
  - **1.** `powershellConfigs.exchange` is `/etc/keel/exchange-collector.json` (`organization` non-empty: **yes**).
    `powershellConfigs.purview` is `/etc/keel/purview-collector.json` (**yes**). No change was needed, and no `.bak-q103`
    exists. The Q99 "Organization cannot be null" error came from a 10-14 run, not a current one (see the Q99 correction).
  - **2. Captures:** all four exit **0**, verify ok, `notProven: []`.
    - exchange-mail-flow, 11 proven: accepted-domains, remote-domains, transport-rules, inbound-connectors,
      outbound-connectors, anti-spam-policies, anti-phish-policies, anti-malware-policies, dkim-signing,
      safe-links-policies, safe-attachment-policies.
    - exchange-extended, 23 proven: outbound-spam-policies and -rules, connection-filter-policies, anti-spam/anti-phish/
      anti-malware rules, eop-preset-rules, quarantine-policies, quarantine-global-settings, journal-rules,
      mobile-device-policies, device-access-rules, activesync-settings, address-lists, global-address-lists,
      offline-address-books, address-book-policies, retention-policy-tags, retention-policies, safe-links-rules,
      safe-attachment-rules, defender-preset-rules, defender-office-apps.
    - purview-retention-dlp, 4 proven: retention-policies, retention-rules, dlp-policies, dlp-rules.
    - purview-governance, 8 proven: retention-labels, adaptive-scopes, auto-label-policies, auto-label-rules,
      ediscovery-cases, ediscovery-premium-cases, case-holds, case-hold-rules. The eDiscovery reads answered too.
  - **3. Import** (`--dir <clone>/docs/release/qualifications`): exit **0**. 14 imported, including workload-reads-*:
    mail-flow 11, extended 23, retention-dlp 4, governance 8. Refused: none. Absent: workload-reads teams-org-policies
    and teams-voice-policies, sharepoint-site-grants, sharepoint-site-permissions.
  - **4. Manual `keel-workload-collect.mjs run`:** exit 1 overall (the partials below).

    | workload | now | observations | reasons |
    |---|---|---|---|
    | exchange-mail-flow | **on**, `partial` | 35 | 0; all 11 families read, 11 fields unknown |
    | exchange-extended | **on**, `partial` | 40 | 0; all families read |
    | purview-retention-dlp | **on**, `complete` | 10 | 0 |
    | purview-governance | **off**, `disabled` | 0 | 3 (below) |

    purview-governance's 3 reasons, verbatim: "purview.ediscovery-cases / purview.case-holds / purview.case-hold-rules is
    pending-prerequisite: To read ediscovery ... assign it the eDiscovery Manager role." The reads answered live, but the
    gate still requires the role to be observed in the grants. I did not grant it.
  - **5. Evidence: held.** `pseudonymize.mjs check` exits 1 on all four records. Each has one raw id, the Collector's app id
    in `subject.credentials.collector`: `workloadReadsLive.mjs` never calls `pseudonymizeCapture`, unlike the writer tool.
    Filed **#427**. The records are kept on the host in `/root/q103-records/`, not committed. After the fix deploys I rerun
    the four captures (reads only) and publish to `claude/live-evidence-q103`.
- **Tenant:** reads only. Each capture sends only the workload's declared `Get-` cmdlets with the collector credential.
  Nothing is created, changed or deleted in the tenant. No grant or role changes.
- Do, from your clone checked out at the commit `/opt/keel-live` is deployed at, with `KEEL_QUALIFICATION_HMAC_KEY` from
  `/etc/keel/qualification.env` (never print it) and `set -a; . /etc/keel/db.env; set +a`:
  1. From `/etc/keel/workload-scope.json`, note which config `powershellConfigs.exchange` and `powershellConfigs.purview`
     name. For each, report whether it has a non-empty `organization` field (yes/no only, never the value).
     Q99 found purview-labels failing with "Organization cannot be null for certificate based connections" on the purview
     config. If the purview config has no `organization`: copy it to `<file>.bak-q103` (same owner, mode), add
     `organization` with the value the exchange config holds (same tenant), keep owner and mode, and report it. That is a
     host config change only; undo is restoring the `.bak-q103` file.
  2. Four captures, one per workload, each with the config the scheduled job uses for it (exchange config for
     `exchange-mail-flow` and `exchange-extended`, purview config for `purview-retention-dlp` and `purview-governance`):
     ```bash
     node tools/qualification/workloadReadsLive.mjs capture --workload <workload> --tenant-ref <tenant ref> \
       --collector-ref app:<that config's clientId> --collector-config <that config> \
       --build "$(git -C /opt/keel-live rev-parse HEAD)" \
       --out docs/release/qualifications/workload-reads-<workload>-live-acceptance.json
     ```
     Report each exit code and its `proven` / `notProven` JSON verbatim (mask tenant or org names in `message`).
  3. Copy the four records into `/opt/keel-live/docs/release/qualifications/` (the default `--dir` of the import), or pass
     `--dir <clone>/docs/release/qualifications`. Then `node cli/keel-workload-collect.mjs import`; report exit code and the
     `imported` / `refused` / `absent` lists.
  4. `node cli/keel-workload-collect.mjs run` once by hand. Report each of the four workloads' outcome and resources
     (`SELECT workload, outcome, jsonb_array_length(COALESCE(digest->'reasons','[]'::jsonb)) AS n_reasons, left((digest->'reasons')::text, 400)
     FROM workload_collection WHERE created_at > now() - interval '15 minutes' ORDER BY workload;`) plus each one's
     observation count.
  5. Evidence: commit the four records to `claude/live-evidence-q103` (from `origin/master`, files under
     `docs/release/qualifications/` only, checked for secrets). No PR.
- **Expected:** mail flow and Exchange settings turn on if their core reads answer. Defender families (Safe Links, Safe
  Attachments, Defender presets) may be `not-licensed`; those are optional and only skipped. Purview retention and DLP turns
  on if the two retention reads answer (DLP is optional). Purview retention labels stays off while the collector lacks the
  eDiscovery Manager role (its eDiscovery reads are core); report its reasons, do not grant the role.
- **Report:** per step, the result; per workload, on / off with the reason.

### Q104: Rerun discovery after PR #424 deploys, so the gap count drops (read-only)
- Drafted by the "Stop counting non-backup kinds as gaps" thread (2026-10-21). PR #424 (master 0210b24) teaches discovery
  that 26 paths are other names for kinds Keel already backs up and that 158 paths are logs, reports, runtime state or
  Microsoft catalogues (new status `skipped`). The stored run (run 2, 2026-10-19) predates it, so the Protect page still
  says 275 readable but not backed up. Expected after a rerun: about 75 uncatalogued, about 158 skipped.
- Needs: `/opt/keel-live` deployed at 0210b24 or later (`git -C /opt/keel-live log -1` or the deploy log), and the
  `10-discovery.sql` schema reapplied by the deploy (the `discovery_item_status_check` constraint accepts `skipped`):
  `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'discovery_item_status_check';`
- Status: done
- Result: done (2026-10-21). Deployed build 9429f45, which includes #424 (0210b24) and #425. The constraint accepts `skipped`:
  `CHECK ((status = ANY (ARRAY['catalogued', 'uncatalogued', 'skipped', 'unreadable', 'not-listed'])))`. Graph reads with the
  Collector only; nothing changed in the tenant.
  - **Step 1:** `keel-discover.mjs run` **exit 0** in 189.8 s. 1648 Graph GET requests, 8 of them throttled.
    - Summary: `1004 types; 126 catalogued, 74 uncatalogued, 158 skipped (not worth backing up), 574 unreadable, 72 not listed.`
      That is down from 275 uncatalogued in run 2.
    - Sources that are not complete: `powershell:ExchangeOnlineManagement`, `powershell:MicrosoftTeams` and
      `powershell:PnP.PowerShell`, each "unknown (no command list was supplied for this module)".
    - Containers: users 104, groups 57, teams 11, sites 1. Catalogue: 99 covered, 6 under-item, 9 unreadable.
    - `Stored discovery run 3.`
  - **Step 2:** 101 rows, **74 distinct paths** (a path readable on both v1.0 and beta has one row per source). No GUIDs or
    tenant names. `ops/q104/uncatalogued.tsv` on `claude/q104-uncatalogued` @ b27d58c, pushed. No PR.
- Do (same as Q82 step 1; no tenant writes, no approvals, no new grants):
  1. `set -a; . /etc/keel/db.env; set +a; cd /opt/keel-live && time node cli/keel-discover.mjs run --config /etc/keel/tenant.json`
     Report the exit code, the first summary line (it now names `skipped`), source lines that are not `complete`, and the
     `Stored discovery run <id>` line.
  2. For the new run, as tab-separated output with a header, the paths still counted as gaps:
     ```sql
     \copy (SELECT source, name, kind, entity_type, objects, objects_exact FROM discovery_item
             WHERE run_id = (SELECT id FROM discovery_run ORDER BY finished_at DESC, id DESC LIMIT 1)
               AND status = 'uncatalogued' ORDER BY name, source) TO '/tmp/q104-uncatalogued.tsv' WITH (FORMAT csv, DELIMITER E'\t', HEADER)
     ```
     Commit it as `ops/q104/uncatalogued.tsv` on a new branch `claude/q104-uncatalogued` (never master) and push.
- **Report:** step 1, the distinct path count of step 2, and the branch commit. Nothing in the tenant changes; one stored run.

### Q105: Which Exchange fields came back unknown in Q103 (read-only, DB only)
- Drafted by the "Exchange backups report partial" thread (2026-10-21). Q103 step 4: `exchange-mail-flow` is `partial`
  with `fieldCounts {"unknown": 11, "observed": 752}`, every family read; `exchange-extended` is `partial` too, every
  family read. A field is `unknown` when the cmdlet's answer did not carry a declared property at all. The fields were
  declared from Microsoft's docs, not measured live, so this item lists which ones the live module does not return.
- Needs: nothing. No tenant calls, no job, schedule or config changes, no reruns.
- Status: done
- Result: done (2026-10-21). DB reads only, no tenant calls; nothing was written to the tenant or the DB. Both outputs, verbatim:

  ```
        workload      | outcome |        kind        |               field               | status  | objects 
  --------------------+---------+--------------------+-----------------------------------+---------+---------
   exchange-extended  | partial | antiMalwareRule    | WhenChangedUTC                    | unknown |       2
   exchange-extended  | partial | defenderPresetRule | WhenChangedUTC                    | unknown |       1
   exchange-extended  | partial | eopPresetRule      | WhenChangedUTC                    | unknown |       1
   exchange-extended  | partial | quarantinePolicy   | EndUserQuarantinePermissionsValue | unknown |       2
   exchange-extended  | partial | safeAttachmentRule | WhenChangedUTC                    | unknown |       1
   exchange-extended  | partial | safeLinksRule      | WhenChangedUTC                    | unknown |       2
   exchange-mail-flow | partial | safeLinksPolicy    | UseTranslatedNotificationText     | unknown |       5
   exchange-mail-flow | partial | transportRule      | WhenChangedUTC                    | unknown |       6
  (8 rows)

        workload      | outcome |          created_at           |           field_counts           | unidentified | capped | n_skipped | n_unavailable 
  --------------------+---------+-------------------------------+----------------------------------+--------------+--------+-----------+---------------
   exchange-mail-flow | partial | 2026-10-21 20:26:15.171144+00 | {"unknown": 11, "observed": 752} | 0            | false  |         0 |             0
   exchange-extended  | partial | 2026-10-21 20:25:41.089009+00 | {"unknown": 9, "observed": 455}  | 0            | false  |         0 |             0
  (2 rows)

  ```

  Every unknown field is one of three declared properties that the live module does not return: `WhenChangedUTC` on
  transport rules and five rule kinds (13 objects), `UseTranslatedNotificationText` on safe links policies (5), and
  `EndUserQuarantinePermissionsValue` on quarantine policies (2). mail-flow 6 + 5 = 11, extended 7 + 2 = 9. That matches
  fieldCounts. Only these two runs (Q103 step 4) are non-disabled; every earlier run was disabled.
- Do (with `set -a; . /etc/keel/db.env; set +a`). Field names and family kinds only; no values are selected:
  1. ```sql
     WITH latest AS (
       SELECT DISTINCT ON (workload) id, workload, outcome, created_at FROM workload_collection
        WHERE workload IN ('exchange-mail-flow', 'exchange-extended') AND outcome <> 'disabled'
        ORDER BY workload, created_at DESC)
     SELECT l.workload, l.outcome, o.fields->>'kind' AS kind, c.key AS field, c.value->>'status' AS status, count(*) AS objects
       FROM latest l JOIN workload_observation o ON o.collection_id = l.id
       CROSS JOIN LATERAL jsonb_each(o.field_coverage) c
      WHERE c.value->>'status' <> 'observed'
      GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 3, 4;
     ```
  2. ```sql
     SELECT workload, outcome, created_at, digest->'fieldCounts' AS field_counts, digest->'discovery'->>'unidentified' AS unidentified,
            digest->'discovery'->>'capped' AS capped, jsonb_array_length(COALESCE(digest->'skipped','[]'::jsonb)) AS n_skipped,
            jsonb_array_length(COALESCE(digest->'unavailable','[]'::jsonb)) AS n_unavailable
       FROM workload_collection WHERE workload IN ('exchange-mail-flow', 'exchange-extended') AND outcome <> 'disabled'
      ORDER BY created_at DESC LIMIT 4;
     ```
- **Report:** both outputs verbatim. Nothing is written to the tenant or the DB.

### Q106: Which roles the Collector actually holds, against what Keel has stored (read-only)
- Drafted by the "Reader app role record check" thread (2026-10-21). Source: Q103 step 4. Retention labels
  (`purview-governance`) stays off because the stored Collector grants don't list "eDiscovery Manager", yet its eDiscovery
  reads answered in Q103. Teams org-wide and voice policies wait on "Teams Administrator" and Power Platform settings on
  "Power Platform Administrator" the same way. This item checks whether the stored record is stale or the roles are missing.
- Background (from the code): `workload_ledger_grants` (app `collector`) is written only by the four Wave 1 acceptance
  imports (SharePoint, Teams, Exchange, OneDrive + Purview), from the grants declared at capture time. The Wave 2 writer
  and read imports never change it.
- Needs: nothing.
- Status: done
- Result: done (2026-10-22 06:35 UTC). The stored record is stale in one way: it omits Global Reader and Security Reader. Otherwise it matches the tenant. Teams, Power Platform and Fabric Administrator are really missing. eDiscovery reads work through the Compliance Administrator role group (Case Management, Hold), not eDiscovery Manager. Collector only, reads only; nothing changed.
  1. `workload_ledger_grants` (verbatim):
     - `collector | ["Compliance Administrator", "Exchange Administrator", "SharePoint Administrator"] | 9 | 2026-10-21 20:24:15.650287+00`
     - `restorer | ["Compliance Administrator", "Compliance Data Administrator", "Exchange Administrator", "Intune Administrator",
       "Knowledge Administrator", "Security Administrator", "SharePoint Administrator", "Teams Administrator"] | 57 | 2026-10-21 20:24:15.650287+00`
  2. Collector (`KEEL Collector`) Entra role assignments (200), all at directoryScopeId `/`: Compliance Administrator, Exchange
     Administrator, Security Reader, SharePoint Administrator, Global Reader.
     - Teams Administrator: **no**. Power Platform Administrator: **no**. Fabric Administrator: **no**. Compliance Administrator:
       **yes**. eDiscovery-related Entra roles: **none**.
     - Group memberships: `Read-Only Intune Operator` and `KEEL-RT-collector-fabric-readers`. For both, `isAssignableToRole` is null
       (not role-assignable), so no directory role comes through a group. The five directory roles also appear in memberOf as
       directoryRole.
  3. Purview (`Connect-IPPSSession` as the Collector with `purview-collector.json`, the same app as `tenant.json`; nothing refused, so the
     Restorer was not used):
     - `Get-ServicePrincipal`: 0 registered, so the Collector app is **not** registered in Purview.
     - `Get-RoleGroupMember -Identity eDiscoveryManager`: 1 member (MailUser). Collector in it: **no**. `Get-eDiscoveryCaseAdmin`: 1.
       Collector in it: **no**.
     - `(Get-RoleGroup -Identity ComplianceAdministrator).Roles`: Admin Unit Extension Manager; **Case Management**; Communication
       Compliance Admin; Communication Compliance Case Management; Compliance Administrator; Compliance Manager Administration;
       Compliance Search; Credential Reader; Credential Writer; Data Classification Feedback Provider; Data Classification Feedback
       Reviewer; Data Connector Admin; Data Investigation Management; Data Map Reader; Data Security Investigation Admin; Device
       Management; Disposition Management; DLP Compliance Management; **Hold**; IB Compliance Management; Information Protection
       Admin; Information Protection Analyst; Information Protection Reader; Insider Risk Management Admin; Insights Reader; Manage
       Alerts; Organization Configuration; Purview Agent Analysis; Purview Agent Deployment; Purview Copilot Workspace Contributor;
       RecordManagement; Retention Management; Scan Reader; Scan Writer; Scope Manager; Source Reader; Source Writer; View-Only
       Audit Logs; View-Only Case; View-Only Device Management; View-Only DLP Compliance Management; View-Only IB Compliance
       Management; View-Only Manage Alerts; View-Only Recipients; View-Only Record Management; View-Only Retention Management.
     - `Get-Command Get-ComplianceCase, Get-CaseHoldPolicy, Get-CaseHoldRule`: all three present in the Collector session.
  - Conclusion (inference): purview-governance is gated on a role name ("eDiscovery Manager") that the Collector does not need. Its
    Compliance Administrator role already carries Case Management and Hold. Teams and Power Platform settings stay off for real
    missing roles. Granting them is a separate decision.
- **Tenant:** reads only. Graph GETs and PowerShell `Get-` cmdlets only. Grant, assign, remove or register nothing; no
  `New-`, `Set-`, `Add-` or `Remove-` cmdlet. Read with the Collector first; only where the Collector is refused, repeat
  that same `Get-` read with the Restorer config and say so.
- Do, with `set -a; . /etc/keel/db.env; set +a`:
  1. Stored record:
     ```sql
     SELECT app, roles, jsonb_array_length(permissions) AS n_permissions, imported_at FROM workload_ledger_grants ORDER BY app;
     ```
     Report the rows verbatim (roles are role names, no ids).
  2. Entra directory roles of the KEEL Collector service principal (Collector token from `/etc/keel/tenant.json`; it holds
     RoleManagement.Read.Directory):
     `GET /v1.0/roleManagement/directory/roleAssignments?$filter=principalId eq '<Collector SP id>'&$expand=roleDefinition`.
     Report each role's displayName and directoryScopeId. Then say yes/no for each: Teams Administrator, Power Platform
     Administrator, Fabric Administrator, Compliance Administrator, eDiscovery-related Entra roles (none is expected).
     Also report the Collector's group memberships that are role-assignable (`GET /v1.0/servicePrincipals/<id>/memberOf`,
     names and `isAssignableToRole` only), in case a role comes through a group.
  3. Purview role groups. eDiscovery Manager is a Purview role group, not an Entra role, so step 2 cannot show it.
     `Connect-IPPSSession` with the Collector's purview config (`powershellConfigs.purview` in
     `/etc/keel/workload-scope.json`), then:
     - `Get-ServicePrincipal | Select-Object DisplayName, AppId` (is the Collector app registered in Purview? yes/no).
     - `Get-RoleGroupMember -Identity eDiscoveryManager` and `Get-eDiscoveryCaseAdmin`: is the Collector in either? yes/no.
     - `(Get-RoleGroup -Identity ComplianceAdministrator).Roles`: list the role names (expected to include Case Management and
       Hold; that would explain why the eDiscovery reads answer).
     - In the same Collector session: `Get-Command Get-ComplianceCase, Get-CaseHoldPolicy, Get-CaseHoldRule | Select Name`
       (present means the session holds the roles those reads need).
     If the Collector is refused on a `Get-RoleGroup*` cmdlet, repeat only that read with the Restorer's purview config.
- **Report:** step 1 rows; step 2 role list plus the yes/no list; step 3 answers. Nothing changes in the tenant, the host or the DB.

### Q107: Recapture the four Q103 read records with the #427 fix and publish them (read-only toward the tenant)
- Drafted by the "Proof file publishing fix" thread (2026-10-21). Finishes Q103 step 5.
- PR #428 (merge f149729) fixes #427: `workloadReadsLive.mjs capture` now pseudonymizes the record before signing, so
  `subject.credentials.collector` carries `app:<pseudonym>` like the writer records.
- Needs: PR #428 live (`git -C /opt/keel-live log --oneline | grep -c "#428"` is 1).
- Status: done
- Result: done (2026-10-22 06:41 UTC). Four read records recaptured at live build **04a4c91**. Every id is a pseudonym, and the records are published on `claude/live-evidence-q103` @ **701bd5a** (no PR). Collector reads only.
  1. Captures, same flags as Q103 step 2 (exchange-collector config for the two Exchange workloads, purview-collector config for the two Purview workloads):
     - exchange-mail-flow: exit 0, outcome `complete`, **11 proven**, notProven `[]`, verify ok.
     - exchange-extended: exit 0, `complete`, **23 proven**, notProven `[]`, verify ok.
     - purview-retention-dlp: exit 0, `complete`, **4 proven**, notProven `[]`, verify ok.
     - purview-governance: exit 0, `partial`, **8 proven** (retention-labels, adaptive-scopes, auto-label policies/rules,
       ediscovery-cases, ediscovery-premium-cases, case-holds, case-hold-rules), notProven `[]`, verify ok.
  2. `pseudonymize.mjs check`: exit **0**, "every id is a pseudonym" for all four. My own scan (org/tenant/user names, tokens, raw
     app ids of tenant, exchange, purview and restorer configs) found nothing. All four GUIDs have version nibble 8.
  3. Import (`--dir` the clone): exit **0**. Imported 14 (the 4 Wave 1 acceptance records, 6 writer records, 4 reads records); refused `[]`.
     Absent: reads for teams-org-policies and teams-voice-policies, sharepoint-site-grants, sharepoint-site-permissions.
     (My first import attempt exited 1 only because I had not loaded the verification key into that shell; the retry with it was clean.)
  4. `keel-workload-collect.mjs run`: exit 0.
     | workload | outcome | n_reasons | observations |
     |---|---|---|---|
     | exchange-extended | complete | 0 | 40 |
     | exchange-mail-flow | complete | 0 | 35 |
     | exchange-mailbox-settings | complete | 0 | 2 |
     | onedrive-site-settings | complete | 0 | 1 |
     | power-platform-settings | disabled | 1 | 0 |
     | purview-governance | disabled | 3 | 0 |
     | purview-labels | complete | 0 | 21 |
     | purview-retention-dlp | complete | 0 | 10 |
     | sharepoint-site-settings | complete | 0 | 21 |
     | teams-org-policies | disabled | 9 | 0 |
     | teams-settings | complete | 0 | 11 |
     | teams-voice-policies | disabled | 13 | 0 |
     - purview-governance reasons: ediscovery-cases, case-holds and case-hold-rules are `pending-prerequisite`: "assign it the
       eDiscovery Manager role". Q106 shows the Collector's Compliance Administrator role group already carries Case Management and Hold.
     - teams-org/voice: "assign it the Teams Administrator role". power-platform: "assign it the Power Platform Administrator role".
       Nothing was granted.
  - Q103 set to `done` (pointer to here). I deleted `/root/q103-records/`.
- **Tenant:** reads only, same as Q103 step 2. Each capture sends only the workload's declared `Get-` cmdlets with the
  collector credential. Nothing is created, changed or deleted. No grant or role changes.
- Do, from your clone checked out at the commit `/opt/keel-live` is deployed at, with `KEEL_QUALIFICATION_HMAC_KEY` from
  `/etc/keel/qualification.env` (never print it) and `set -a; . /etc/keel/db.env; set +a`:
  1. Rerun the four Q103 captures exactly as Q103 step 2 (exchange-mail-flow, exchange-extended, purview-retention-dlp,
     purview-governance), same flags, `--build` = the live commit.
  2. `node tools/qualification/pseudonymize.mjs check docs/release/qualifications/workload-reads-*-live-acceptance.json`:
     expect exit 0 on all four. If any id is still raw, stop and file an issue; do not publish.
  3. Import as Q103 step 3 and run `keel-workload-collect.mjs run` once, as Q103 step 4.
  4. Commit the four records to `claude/live-evidence-q103` and push. Then set Q103 to `done` with a pointer to this item,
     and delete `/root/q103-records/` (the held records with the raw id).
- **Report:** per capture exit code and proven count; the check output and exit code; import counts; the run table as in
  Q103 step 4; the evidence branch and commit.

### Q108: Recheck that Exchange mail flow and Exchange settings report complete (read-only)
- Drafted by the "Exchange backups report partial" thread (2026-10-21). Q105 found the unknown fields were declared
  properties the live module never returns. PR #429 stops declaring them and adds `digest.unknownFields` to each run.
- Needs: PR #429 live (`git -C /opt/keel-live log --oneline | grep -c "#429"` is 1).
- Status: done
- Result: done (2026-10-22 06:43 UTC). Both report `complete`, with no unknown fields. Collector reads only.
  1. `node cli/keel-workload-collect.mjs run` by hand at 06:41: exit **0**. (Q107's run at 06:37 is also inside the 15-minute window, so
     each workload has two rows.)
  2. Verbatim:
     ```
           workload      | outcome  |          created_at           |   field_counts    | unknown_fields | observations
     --------------------+----------+-------------------------------+-------------------+----------------+--------------
      exchange-extended  | complete | 2026-10-22 06:37:32.458133+00 | {"observed": 455} | {}             |           40
      exchange-extended  | complete | 2026-10-22 06:41:40.354966+00 | {"observed": 455} | {}             |           40
      exchange-mail-flow | complete | 2026-10-22 06:38:06.07464+00  | {"observed": 752} | {}             |           35
      exchange-mail-flow | complete | 2026-10-22 06:42:14.825191+00 | {"observed": 752} | {}             |           35
     ```
  - As expected: no `unknown` in field_counts, `unknown_fields` `{}`, 35 and 40 observations.
- **Tenant:** reads only. The run sends only the declared `Get-` cmdlets with the collector credential. No grants, no role
  or config changes.
- Do, from `/opt/keel-live` with `set -a; . /etc/keel/db.env; set +a`:
  1. `node cli/keel-workload-collect.mjs run` once by hand (as in Q103 step 4). Report its exit code.
  2. ```sql
     SELECT workload, outcome, created_at, digest->'fieldCounts' AS field_counts, digest->'unknownFields' AS unknown_fields,
            (SELECT count(*) FROM workload_observation o WHERE o.collection_id = wc.id) AS observations
       FROM workload_collection wc
      WHERE workload IN ('exchange-mail-flow', 'exchange-extended') AND created_at > now() - interval '15 minutes'
      ORDER BY workload;
     ```
- **Expected:** both `complete`, `field_counts` with no `unknown`, `unknown_fields` `{}`, about 35 and 40 observations.
- **Report:** step 1 exit code, step 2 verbatim.

### Q117: Recheck the hourly collect after the #438 fix (read-only, urgent, after #445)
- Drafted by the "Hourly collect failing on Exchange roles" thread (2026-10-22). Code: PR #445. The beta Exchange role reads
  returned the same object on more than one page, so `exchangeRoleAssignment` / `exchangeRoleDefinition` ids collided and every
  hourly collect has failed since 23:00 UTC on 2026-10-21 (issue #438). Exact repeats are now dropped after each read; a repeat
  whose content differs fails only its own kind, and the rest of the collect completes.
- Needs: /opt/keel-live at the #445 merge or later (`grep -q dropRepeatedIds /opt/keel-live/engine/collect/entraAdapter.mjs`).
- Status: done
- Result: done (2026-10-22 06:35 UTC). The role-read fix works. The collect job still exits 1, because of `deviceManagementSettings` (#447, Q119). Drift runs. Read-only.
  1. Hourly collect `47f0a20a-2f45-4eb0-9b4b-253d469c82a5`, 06:00 UTC, the first in this window at #445 or later (#445 live since 00:41). It ran
     06:00:03 to 06:02:07 (2 min 4 s), exit code 1, and snapshot `675ad8d0` completed. Its only failed type is `deviceManagementSettings` (400, see Q119).
  2. Role-provider kinds in the coverage digest:
     - `exchangeRoleAssignment`: `complete`, 228 items, 3 pages, HTTP 200, `error` null. There is no "different objects under one id" error.
     - `exchangeRoleDefinition`, `exchangeCustomAppScope`, `defenderRoleDefinition`, `defenderRoleAssignment`, `defenderCustomAppScope`:
       `not-requested` (itemCount null).
  3. drift-detect `41fd91a3-e2e6-438f-974b-11350536d55c` ran at 06:05 (not deferred): `succeeded`. The earlier hours (02:00–05:00) also ran.
  4. #438 has a comment (issuecomment-6334328405) and is left open: the collect job did not succeed, so the close condition is not met. The
     remaining failure belongs to #447.
- **Read-only.** Nothing is written to the tenant. Take this item before Q109–Q116: drift detection is deferring until it passes.
- Do:
  1. Wait for the next scheduled hourly collect after the deploy (or start one the usual way if the timer is idle). Report its
     job id, exit code and duration, and whether a snapshot was completed.
  2. Report the coverage digest outcome and item count for the six role-provider kinds: `exchangeRoleDefinition`,
     `exchangeRoleAssignment`, `exchangeCustomAppScope`, `defenderRoleDefinition`, `defenderRoleAssignment`,
     `defenderCustomAppScope`. Any kind that is not complete: its exact `error` text (a "different objects under one id" error
     names the ids; report them).
  3. Confirm the next drift-detect run after that collect ran instead of deferring (its id and outcome).
  4. If the collect still fails, paste the error and stack, and comment on #438.
- **Report:** steps 1–3; close #438 if the collect and drift-detect succeeded.

### Q119: Recheck the hourly collect and drift after the Intune settings fix (read-only, urgent, after #452)
- Drafted by the "Hourly collect failing on Intune settings" thread (2026-10-22). Code: PR #452 (fixes #447).
  `deviceManagementSettings` now reads `GET beta /deviceManagement?$select=id,settings,intuneBrand,managedDeviceCleanupSettings`.
  Drift detection now runs when at least one type read in full; failed or partial types are skipped and listed in the
  collect job's `result.driftTrigger.skippedTypes`.
- Needs: PR #452 live (`git -C /opt/keel-live log --oneline | grep -c "#452"` is 1).
- Status: done
- Result: done (2026-10-22 06:35 UTC). The Intune read still answers 400. The drift fix works: drift is `queued` with that one type skipped. Collector reads only; nothing written.
  1. Hourly collect `47f0a20a-2f45-4eb0-9b4b-253d469c82a5` (06:00 UTC, #452 live since 01:39): exit code 1. The only non-complete type is
     `deviceManagementSettings`: `failed`, HTTP 400, graphCode `No method match route template`, error verbatim:
     `No OData route exists that match template ~/singleton with http verb GET for request /StatelessOnboardingService/deviceManagement.`
     Endpoint `/deviceManagement?$select=id,settings,intuneBrand,managedDeviceCleanupSettings` (beta).
  2. Newest snapshot `675ad8d0-e121-4f6b-a2e5-61cd9579786c`: digest outcome `failed`, objects 0, has_settings empty (no row).
  3. Collect jobs: `47f0a20a` failed 06:02:07, driftTrigger `{"error": null, "jobId": "41fd91a3-…", "status": "queued", "skippedTypes":
     ["deviceManagementSettings"]}`; `49abb5cc` failed 05:01:53, same trigger shape (drift job `acc29b5a`).
     drift-detect: `41fd91a3` succeeded 06:05:35; `acc29b5a` succeeded 05:05:34; `933f9685` succeeded 04:05:08 (error empty for all three).
  - This matches the item's 400 fallback case. Commented on #447 (issuecomment-6334331868), noting that the `StatelessOnboardingService` route
    suggests the tenant has no Intune singleton to serve (inference, not checked).
- **Tenant:** reads only, with the collector credential. Nothing written.
- Do, from `/opt/keel-live` with `set -a; . /etc/keel/db.env; set +a`:
  1. Wait for the next hourly collect after the deploy (or run `node cli/keel-collect.mjs` once by hand). Report its
     exit code and every type with a non-complete outcome.
  2. ```sql
     WITH s AS (SELECT id, coverage_digest FROM snapshot ORDER BY started_at DESC LIMIT 1)
     SELECT s.coverage_digest->'deviceManagementSettings' AS digest,
            (SELECT count(*) FROM resource_version rv WHERE rv.snapshot_id = s.id AND rv.resource_type = 'deviceManagementSettings') AS objects,
            (SELECT payload ? 'settings' FROM resource_version rv WHERE rv.snapshot_id = s.id AND rv.resource_type = 'deviceManagementSettings' LIMIT 1) AS has_settings
       FROM s;
     ```
  3. ```sql
     SELECT id, status, finished_at, result->'driftTrigger' AS drift_trigger FROM job
      WHERE kind = 'collect' ORDER BY finished_at DESC NULLS LAST LIMIT 2;
     SELECT id, status, error, finished_at FROM job WHERE kind = 'drift-detect' ORDER BY created_at DESC LIMIT 3;
     ```
- **Expected:** step 1 exit 0 with no failed type. Step 2: outcome `complete`, 1 object, `has_settings` true. Step 3:
  `driftTrigger.status` is `queued` with `skippedTypes` `[]`, and the newest drift-detect job `succeeded`. If the
  Intune read still answers 400, report the error verbatim: drift should still be `queued`, with
  `skippedTypes` `["deviceManagementSettings"]`.
- **Report:** steps 1 to 3 verbatim.

### Q109: Live restore of four Intune settings kinds (restore gaps batch 1, after #430)
- Note (coordinator, 2026-10-22): **#466 is fixed** by PR #468 (master `7f7525d`). A restore now skips and logs an Intune type it does not touch that fails to read (501 NotSupported counts as not on the tenant; the vppToken and Managed Google Play `$select` fields are fixed). Deletes are refused while any type is unread. Re-run this item once `/opt/keel-live` is at `7f7525d` or later.
- Drafted by the "Make backed-up kinds restorable" thread (2026-10-21). Code: PR #430. New record writers, fixture-tested only:
  reusable settings groups (`deviceManagementReusablePolicySetting`, beta, create + update), Windows hotpatch policies
  (`windowsQualityUpdatePolicy`, beta, create + update), device categories (`deviceCategory`, v1.0, create + update),
  device cleanup rules (`managedDeviceCleanupRule`, beta, **update only**, refused when the backup retires devices sooner than now).
- Needs: /opt/keel-live at the #430 merge or later (`grep -q cleanupRuleRefusal /opt/keel-live/engine/restore/intuneOperations.mjs`).
- Status: done
- Result: done (2026-10-22 08:11 UTC), resumed after #466 was fixed (#468). B = **c396a2c**. Restorer only; global admin not used; nothing granted. Self-approved under the 2026-10-14 standing authorization.
  - **Per type and operation:**
    | type | create | update |
    |---|---|---|
    | deviceCategory | **promoted** | **promoted** |
    | managedDeviceCleanupRule | (update only) | **promoted** (180 → 270 put back) |
    | deviceManagementReusablePolicySetting | **demoted** (#470) | **demoted** (#470) |
    | windowsQualityUpdatePolicy | **blocked**: fixture create 403 | **blocked** (same) |
    - Reusable create: the backup holds no `settingInstance` (the list read leaves it out), so Graph refused it: `400 Policy Id <id> has list
      of empty setting instances. A policy document is expected with a list of setting instances.`
    - Reusable update: Graph has no PATCH route for this type: `400 "No method match route template": No OData route exists that match template
      ~/singleton/navigation/key with http verb PATCH`. Only PUT with the full `settingInstance` works. Filed **#470** (with the fix: `$select=...,settingInstance` on the list read, and PUT).
    - Hotpatch: `POST beta /deviceManagement/windowsQualityUpdatePolicies` answered 403 "An error has occurred" from SoftwareUpdateService, naming
      no permission. GET is 200. Likely a licence or Windows Update for Business prerequisite (inference).
  - **Rounds:**
    - Fixtures: `KEEL-RT-148-category`, `KEEL-RT-148-addresses` (keyword, autoresolve false, address 203.0.113.10, used by no policy),
      `KEEL-RT-148-cleanup` (macOS, 270 days). The tenant had no cleanup rule before, and has 0 managed devices.
    - S = `2b450888` (06:47). The first create-round dry run (06:52, e1a811b) stopped on #466.
    - Create round: dry run A1 `815b5e6f` planned 2 creates, approval **838db325**, job `864a075c` failed on the reusable create. Category created; read-back
      name and description equal.
    - Update round: recreated the address group by hand, S2 = `ac991228`. Drifted the descriptions and set the cleanup rule to 180 days. Dry run A2 `a78c7046` planned 3 updates
      (only the drifted fields), approval **d69cdb29**, job `2d0927da`: category and cleanup rule updated (read back "KEEL restore fixture", 270);
      reusable failed (PATCH).
  - **Step 5, refusal:** cleanup rule set to 365, dry run `ce4f2d9c` from S2: skipped, status `refused`, 0 writes. Reason: "manual: the backup retires devices
    after 270 days without check-in, sooner than the 365 days set now; a shorter wait could retire devices at once, so a person changes it". Not promoted.
  - **Step 6, re-run:** rule back at 270, address group description back. Dry run `3b33f4ae` from S2: 3 entries, **none with changed fields** (0 planned writes).
  - **Step 7, cleanup:** deleted the category, address group and cleanup rule. Re-read: no `KEEL-RT-148` object of these four types. **Nothing left.**
  - **Evidence:** `claude/live-evidence-restore-gaps-1` @ **bdc7ffb**: deviceCategory.create/.update, managedDeviceCleanupRule.update (each with .capture.json) and
    the two reusable demotions. pseudonymize check exit 0; my scan is clean. (The capture needs `--fixture <naturalKey>`; the display name gives "not-exercised".)
  - `operations.mjs --live-evidence`: `deviceCategory.create.json: fixture-tested -> live-qualified`; `deviceCategory.update.json: fixture-tested -> live-qualified`;
    `managedDeviceCleanupRule.update.json: fixture-tested -> live-qualified`.
- **Test tenant only.** Same hard rules, capture tooling and requester/approver split as Q67. Under the 2026-10-14 standing
  authorization, approve these restores yourself and log every approval id. Restorer only; global admin not used. No permission
  to add: the Restorer holds DeviceManagementConfiguration.ReadWrite.All and DeviceManagementManagedDevices.ReadWrite.All. If Graph
  answers 403, report blocked with what Graph names; grant nothing. Never touch CA policies, break-glass or Marouane's account.
- **Fixtures** (the reviewed guidance in `live-gate-plan.mjs` at B says the same):
  - device category `KEEL-RT-category` (no devices are in it);
  - firewall reusable settings group `KEEL-RT-addresses` (one address 203.0.113.10), used by no policy;
  - Windows hotpatch quality update policy `KEEL-RT-hotpatch`, assigned to nobody;
  - device cleanup rule `KEEL-RT-cleanup`, platform macOS (the tenant has 0 managed devices), 270 days. If the tenant already has a
    cleanup rule for every platform, report that and skip the cleanup rule part.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. `node tools/qualification/live-gate-plan.mjs > ~/keel-rg1/plan-B.md`. Use its steps for these four types (collect, restore
     dry run, approve, `--enforce`, `entraLive.mjs capture`, promote).
  2. Create the fixtures, then take snapshot S (one tier run that reads all four types; deviceCategory and the cleanup rule are tier 3).
     Confirm all four fixtures are in S.
  3. **Create round** (category, reusable group, hotpatch): delete each, restore from S selecting them, approve, enforce, capture
     each `create`. Read back equal to the backup (name, description, the reusable group's address, hotpatchEnabled).
  4. **Update round:** change each description (all four), and lower the cleanup rule to 180 days. Restore from S, approve,
     enforce, capture each `update`. Expect the cleanup rule back at 270 days.
  5. **Refusal check (no write expected):** set the cleanup rule to 365 days, dry run from S. Expect it listed as manual with
     "sooner than the 365 days set now", 0 writes for it. Do not promote.
  6. **Re-run check:** dry run from S again after step 4 (rule back at 270 first). Expect 0 planned writes for the four.
  7. Cleanup: delete all four fixtures. Report anything left.
  8. Commit the records and `.capture.json` files under `docs/release/qualifications/entra-live/` on
     `claude/live-evidence-restore-gaps-1`, branched from `origin/master` (secret scan and `pseudonymize.mjs check` first). No PR.
     Run `node tools/qualification/operations.mjs --live-evidence <that directory>` and report the `live evidence` lines.
- **Report:** B; per type and operation: promoted / refused (exact message) / blocked; the step 5 and 6 results; approval ids;
  the evidence branch and commit; anything left in the tenant.

### Q110: Live restore of five Entra ID tenant settings (restore gaps batch 2, after #432)
- Drafted by the "Restore batch 2" thread (2026-10-21). Code: PR #432. New singleton record writers, update in place only,
  fixture-tested only: external user leave settings (`externalIdentitiesPolicy`, beta), access review settings
  (`accessReviewPolicy`, beta), admin role access review defaults (`directoryRoleAccessReviewPolicy`, beta), multitenant
  organization user sync template (`multiTenantOrganizationIdentitySyncPolicyTemplate`, v1.0) and cross-tenant access template
  (`multiTenantOrganizationPartnerConfigurationTemplate`, v1.0). Each writes only its own settings, never its name or id.
- Needs: /opt/keel-live at the #432 merge or later (`grep -q multiTenantOrganizationPartnerConfigurationTemplate: /opt/keel-live/engine/restore/identityObjectOperations.mjs`).
- Status: todo
- Result:
- **No longer held (2026-10-22 06:27 UTC):** Marouane approved changing tenant-wide settings in the test tenant for this item.
  Put each tenant-wide value back to the value written down first right after its capture, not only at the end, and report
  any that is not back. Tenant hard rules still hold: never enable a CA policy, never touch break-glass or Marouane's account.
- **Test tenant only.** Same hard rules, capture tooling and requester/approver split as Q67. Under the 2026-10-14 standing
  authorization, approve these restores yourself and log every approval id. Restorer only; global admin not used. No permission
  to add: per the Q-inventory the Restorer holds Policy.ReadWrite.ExternalIdentities, Policy.ReadWrite.AccessReview,
  RoleManagement.ReadWrite.Directory and Policy.ReadWrite.CrossTenantAccess. If Graph answers 403, report blocked with what Graph
  names; grant nothing. Never touch CA policies, break-glass or Marouane's account. None of these settings touches sign-in.
- **Fixtures:** these are tenant-wide settings (kind `tenant-setting` in `live-gate-plan.mjs` at B), so there is no KEEL-RT- object
  to create. **Before anything, write down the current value of every setting you will drift** (step 2) and put each back at the end.
  - external identities policy: drift `allowExternalIdentitiesToLeave` to the other value;
  - access review policy: drift `isGroupOwnerManagementEnabled` to the other value;
  - admin role access review defaults: drift `settings.instanceDurationInDays` (for example 14 to 7). Create or change no review.
    If GET answers 404, report that type blocked;
  - multitenant organization sync template: drift `userSyncInbound.isSyncAllowed` to the other value;
  - multitenant organization access template: drift `automaticUserConsentSettings.inboundAllowed` to the other value. **Never change
    inboundTrust.** If either template GET answers 404, report that type blocked.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. `node tools/qualification/live-gate-plan.mjs > ~/keel-rg2/plan-B.md`. Use its steps for these five types (collect, restore
     dry run, approve, `--enforce`, `entraLive.mjs capture` with `--allow-tenant-setting`, promote).
  2. Record the five original values, then take snapshot S (one tier run that reads all five). Confirm all five are in S.
  3. **Update round:** drift all five as above. Restore from S selecting them, approve, enforce, capture each `update`
     (`--resource-type <type> --fixture <type> --allow-tenant-setting`). Expect each read back equal to S, and the dry run to list
     only the drifted field per type.
  4. **Re-run check:** dry run from S again. Expect 0 planned writes for the five.
  5. Confirm every setting equals the value written down in step 2 (put back by hand any that does not, and report it).
  6. Commit the records and `.capture.json` files under `docs/release/qualifications/entra-live/` on
     `claude/live-evidence-restore-gaps-2`, branched from `origin/master` (secret scan and `pseudonymize.mjs check` first). No PR.
     Run `node tools/qualification/operations.mjs --live-evidence <that directory>` and report the `live evidence` lines.
- **Report:** B; per type: promoted / refused (exact message) / blocked; the step 4 result; approval ids; the evidence branch and
  commit; any setting not back at its original value.

### Q111: Live restore of guest domain restrictions, app pre-approval policies and guest federations (restore gaps batch 3, after #433)
- Drafted by the "Restore batch 3" thread (2026-10-21). Code: PR #433. Record writers, fixture-tested only: guest invitation domain
  restriction (`b2bManagementPolicy`, beta, **update only**, writes `definition` only), app permission pre-approval policies
  (`permissionGrantPreApprovalPolicy`, beta, create + update of `conditions`), guest SAML/WS-Fed federation (`externalDomainFederation`,
  v1.0, **update only**, never its domains).
- Needs: /opt/keel-live at the #433 merge or later (`grep -q sameJsonStrings /opt/keel-live/engine/restore/identityObjectOperations.mjs`).
- Status: todo
- Result:
- **No longer held (2026-10-22 06:27 UTC):** Marouane approved changing tenant-wide settings in the test tenant for this item.
  Put each tenant-wide value back to the value written down first right after its capture, not only at the end, and report
  any that is not back. Tenant hard rules still hold: never enable a CA policy, never touch break-glass or Marouane's account.
- **Test tenant only.** Same hard rules, capture tooling and requester/approver split as Q67. Under the 2026-10-14 standing
  authorization, approve these restores yourself and log every approval id. Restorer only; global admin not used. No permission
  to add: per the Q-inventory the Restorer holds Policy.ReadWrite.B2BManagementPolicy, Policy.ReadWrite.PermissionGrant and
  Domain.ReadWrite.All. If Graph answers 403, report blocked with what Graph names; grant nothing. Never touch CA policies,
  break-glass or Marouane's account. Never block, allow or federate a real domain; never invite a guest.
- **Fixtures** (the reviewed guidance in `live-gate-plan.mjs` at B says the same):
  - guest domain restriction (tenant setting): **write down the current `definition` first.** If the tenant has no
    b2bManagementPolicy, set one blocked domain `keel-rt-blocked.example` in the Entra admin center (External collaboration
    settings) so one exists, and remove it again at the end;
  - pre-approval policy (tenant setting, no name): one condition, scopeType `chat`, all sensitivity labels, Microsoft Graph
    application permission ChatMessage.Read.Chat. **Never assign it to any service principal** (unassigned, it pre-approves nothing);
  - SAML federation `KEEL-RT-148-fed` for the domain `keel-rt-fed.example` (issuer `https://keel-rt-fed.example/issuer`, sign-in
    `https://keel-rt-fed.example/sso`, a fresh self-signed certificate). If Graph refuses the domain, report the exact message and
    skip the federation part.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. `node tools/qualification/live-gate-plan.mjs > ~/keel-rg3/plan-B.md`. Use its steps for these three types (collect, restore
     dry run, approve, `--enforce`, `entraLive.mjs capture`, promote). Capture the domain restriction and the pre-approval policy
     with `--allow-tenant-setting`.
  2. Create the fixtures, then take snapshot S (one tier run that reads all three). Confirm all three are in S.
  3. **Update round:** add `keel-rt-blocked.example` to BlockedDomains (or remove it, if S holds it); change the pre-approval
     condition scopeType from chat to group; change the federation passiveSignInUri to `https://keel-rt-fed.example/drifted`.
     Restore from S selecting them, approve, enforce, capture each `update`. Expect each read back equal to S; the dry run lists
     only `definition`, `conditions` and `passiveSignInUri`.
  4. **Create round** (pre-approval policy only): delete it, restore from S, approve, enforce, capture the `create` (new id
     expected). Leave it unassigned.
  5. **Refusal check (no write expected):** delete the federation, dry run from S. Expect it reported as not written (create is
     not supported), 0 writes. Do not promote.
  6. **Re-run check:** dry run from S again (after step 4; ignore the deleted federation). Expect 0 planned writes for the
     domain restriction and the recreated policy's settings.
  7. **Read-only probe for the next batch** (no write): `GET beta /policies/servicePrincipalCreationPolicies?$expand=includes,excludes`
     and `GET v1.0 /directory/federationConfigurations/graph.samlOrWsFedExternalDomainFederation?$expand=domains` (before step 5).
     Report the status code of each and whether includes, excludes and domains came back filled.
  8. Cleanup: delete the recreated pre-approval policy, the federation if still there, and put the domain restriction back to the
     definition written down first. Report anything left.
  9. Commit the records and `.capture.json` files under `docs/release/qualifications/entra-live/` on
     `claude/live-evidence-restore-gaps-3`, branched from `origin/master` (secret scan and `pseudonymize.mjs check` first). No PR.
     Run `node tools/qualification/operations.mjs --live-evidence <that directory>` and report the `live evidence` lines.
- **Report:** B; per type and operation: promoted / refused (exact message) / blocked; the step 5, 6 and 7 results; approval
  ids; the evidence branch and commit; anything left in the tenant.

### Q112: Check the new backup kinds of batches 5 and 6 land in a snapshot (read-only, after #434)
- Drafted by the "Back up remaining Intune kinds" thread (2026-10-21). Code: PR #431 (batch 5, 6 Exchange and Defender
  admin role kinds) and PR #434 (batch 6, 17 Intune kinds). All are GET-only catalogue reads; no writer.
- Needs: PR #434 live (`git -C /opt/keel-live log --oneline | grep -c "#434"` is 1).
- Status: done
- Result: done (2026-10-22 06:58 UTC). All 23 kinds read 200 except `deviceManagementSettings` (#447). Counts match discovery run 3, and the secret check returns no rows. Collector reads only.
  1. Collect by hand, no `--tier` (06:47 UTC, build e1a811b, the Q109 snapshot S `2b450888-07cd-4ba6-b250-96306b941b53`, which was the newest snapshot when queried): exit **1**.
     The only listed type with an error: `deviceManagementSettings` 400 "No OData route exists that match template ~/singleton with
     http verb GET for request /StatelessOnboardingService/deviceManagement." Every other listed type is `complete` or `complete-empty` (200).
     The other failed types in that collect (not in this list) are in #466.
  2. Objects (query run with `snapshot_id = S`): androidDeviceOwnerEnrollmentProfile 0, androidForWorkEnrollmentProfile 0,
     **androidForWorkSettings 1**, appleUserInitiatedEnrollmentProfile 0, cartToClassAssociation 0, defenderCustomAppScope 0,
     defenderRoleAssignment 0, defenderRoleDefinition 0, deviceManagementDerivedCredentialSettings 0, **deviceManagementSettings 0**
     (read failed), enterpriseCodeSigningCertificate 0, **exchangeCustomAppScope 1**, **exchangeRoleAssignment 227**,
     **exchangeRoleDefinition 106**, iosLobAppProvisioningConfiguration 0, managedEBook 0, managedEBookCategory 0,
     microsoftTunnelConfiguration 0, **microsoftTunnelHealthThreshold 13**, mobileAppRelationship 0, **symantecCodeSigningCertificate 1**,
     userExperienceAnalyticsBaseline 0, windowsManagedAppProtection 0.
  3. Secret check: `(0 rows)`.
- **Tenant:** reads only, with the collector credential. No grants, no role or config changes, nothing written.
- Do, from `/opt/keel-live` with `set -a; . /etc/keel/db.env; set +a`:
  1. `node cli/keel-collect.mjs` once by hand (no `--tier`, so every tier is read). Report its exit code and any log
     line that names one of the types below with an error or a 400/403/404.
  2. ```sql
     WITH s AS (SELECT id FROM snapshot ORDER BY started_at DESC LIMIT 1)
     SELECT t.type, count(rv.resource_type) AS objects
       FROM unnest('{exchangeRoleDefinition,exchangeRoleAssignment,exchangeCustomAppScope,defenderRoleDefinition,defenderRoleAssignment,defenderCustomAppScope,deviceManagementSettings,androidDeviceOwnerEnrollmentProfile,androidForWorkEnrollmentProfile,appleUserInitiatedEnrollmentProfile,androidForWorkSettings,deviceManagementDerivedCredentialSettings,microsoftTunnelConfiguration,microsoftTunnelHealthThreshold,iosLobAppProvisioningConfiguration,mobileAppRelationship,managedEBook,managedEBookCategory,cartToClassAssociation,windowsManagedAppProtection,enterpriseCodeSigningCertificate,symantecCodeSigningCertificate,userExperienceAnalyticsBaseline}'::text[]) AS t(type)
       LEFT JOIN resource_version rv ON rv.resource_type = t.type AND rv.snapshot_id = (SELECT id FROM s)
      GROUP BY t.type ORDER BY t.type;
     ```
     If the table or column names differ, take the snapshot step 1 made and report what you ran.
  3. Secret check: confirm no stored payload of the new kinds holds a secret field:
     ```sql
     SELECT resource_type, count(*) FROM resource_version
      WHERE snapshot_id = (SELECT id FROM snapshot ORDER BY started_at DESC LIMIT 1)
        AND resource_type IN ('androidDeviceOwnerEnrollmentProfile','androidForWorkEnrollmentProfile','symantecCodeSigningCertificate')
        AND (payload::text ~* '"(tokenValue|qrCodeContent|qrCodeImage|wifiPassword|password|content)"')
      GROUP BY 1;
     ```
- **Expected:** step 1 exit 0. Step 2 from discovery run 3: about 107 / 231 / 1 for the Exchange kinds, 0 for Defender,
  1 `deviceManagementSettings`, 1 `androidForWorkSettings`, 13 `microsoftTunnelHealthThreshold`,
  0 or 1 `symantecCodeSigningCertificate` (absent when none was uploaded), 0 for the rest. Step 3 returns no rows.
- **Report:** step 1 exit code and error lines, steps 2 and 3 verbatim.

### Q113: Live backup and restore of Intune scripts and remediations (restore gaps batch 4, after #435)
- Requeued by the coordinator (2026-10-22 09:40 UTC): **#471 is fixed** by PR #475 (master `56d9682`): every script writer declares `DeviceManagementScripts.ReadWrite.All`, and a 403 names the missing grant. Marouane has added `DeviceManagementScripts.ReadWrite.All` (Application) to the Restorer and granted admin consent (2026-10-22). Run once `/opt/keel-live` is at `56d9682` or later (`grep -q SCRIPT_WRITE_PERMISSION /opt/keel-live/engine/restore/intuneOperations.mjs`); that build also has the #466 fix (#468).
  - **Step 0, before any fixture (read only; prints role names only, never the token):** get a fresh Restorer token and check its `roles` claim:
    `cd /opt/keel-live && node --input-type=module -e "import { getToken } from './tools/tenant-probe/auth.mjs'; import { readFileSync } from 'node:fs'; const c = JSON.parse(readFileSync('/etc/keel/restorer.json','utf8')); const t = (await getToken(c)).accessToken; console.log(JSON.parse(Buffer.from(t.split('.')[1], 'base64url')).roles.sort().join('\n'))"`
    - If the list includes `DeviceManagementScripts.ReadWrite.All`: log the list in Result and run the item. The "no permission to add" / "Restorer holds DeviceManagementConfiguration" wording below is superseded for script kinds.
    - If it does not: create nothing, set `Status: blocked`, and report in Result that admin consent for `DeviceManagementScripts.ReadWrite.All` appears not applied, with the roles listed. Grant nothing.
- Note (coordinator, 2026-10-22): **#466 is fixed** by PR #468 (master `7f7525d`). A restore now skips and logs an Intune type it does not touch that fails to read (501 NotSupported counts as not on the tenant; the vppToken and Managed Google Play `$select` fields are fixed). Deletes are refused while any type is unread. Re-run this item once `/opt/keel-live` is at `7f7525d` or later.
- Drafted by the "Restore batch 4" thread (2026-10-21). Code: PR #435. The backup now lists each script kind, then reads each
  script on its own so it holds the script body (Graph returns the body only on a single-script GET). New record writers,
  fixture-tested only, beta, create + update: Windows PowerShell scripts (`deviceManagementScript`), macOS shell scripts
  (`deviceShellScript`), remediations (`deviceHealthScript`, Microsoft-published ones are never written) and custom compliance
  scripts (`deviceComplianceScript`). Who a script runs on is **not** written; fixtures stay unassigned.
- Needs: /opt/keel-live at the #435 merge or later (`grep -q scriptRefusal /opt/keel-live/engine/restore/intuneOperations.mjs`).
- Status: todo
- Result: blocked (2026-10-22 08:13 UTC) on **#471**: the Restorer lacks `DeviceManagementScripts.ReadWrite.All`. B = c396a2c. Nothing created; nothing granted.
  - Fixture creates (Restorer, POST beta): `deviceManagementScripts`, `deviceShellScripts`, `deviceHealthScripts` and `deviceComplianceScripts` all answered **403**: "Application is not authorized to perform this operation. Application must have one of the following scopes: DeviceManagementScripts.ReadWrite.All". KEEL's writers declare DeviceManagementConfiguration.ReadWrite.All, so a restore would hit the same 403.
  - Backup side is fine: in snapshot ac991228, all four kinds are complete or complete-empty (200). One existing non-fixture PowerShell script is backed up.
  - Plan at B: `~/keel-rg4/plan-B.md` (these types are steps 44–51).
  - Waiting on Marouane: add `DeviceManagementScripts.ReadWrite.All` to the Restorer and grant admin consent (D-93a says to add what the tool needs; consent is his).
- **Test tenant only.** Same hard rules, capture tooling and requester/approver split as Q67. Under the 2026-10-14 standing
  authorization, approve these restores yourself and log every approval id. Restorer only; global admin not used. No permission
  to add: the Restorer and collector hold DeviceManagementConfiguration.ReadWrite.All / .Read.All. If Graph answers 403 (or 400
  on a licence: remediations need Windows Enterprise E3/E5 or equivalent), report blocked with what Graph names; grant nothing.
  Never touch CA policies, break-glass or Marouane's account. **Never assign any fixture script to a group, user or device.**
- **Fixtures** (the reviewed guidance in `live-gate-plan.mjs` at B says the same; bodies are harmless and nothing runs them):
  - Windows PowerShell script `KEEL-RT-script`, body `Write-Output 'KEEL-RT'`, run as system, assigned to nobody;
  - macOS shell script `KEEL-RT-shell`, body `echo KEEL-RT`, assigned to nobody;
  - remediation `KEEL-RT-remediation`, detection and fix scripts both `exit 0`, assigned to nobody;
  - custom compliance script `KEEL-RT-compliance-script`, body `return @{}`, used by no compliance policy.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. `node tools/qualification/live-gate-plan.mjs > ~/keel-rg4/plan-B.md`. Use its steps for these four types (collect, restore
     dry run, approve, `--enforce`, `entraLive.mjs capture`, promote).
  2. Create the fixtures, then take snapshot S (one tier run that reads all four types). **Backup check:** confirm all four are in S
     and that each payload holds its body (`scriptContent` or `detectionScriptContent`, non-empty). Report the four types' read
     outcome (complete / failed) and, if the tenant lists Microsoft-published remediations, how many.
  3. **Create round** (PowerShell script, remediation): delete each, restore from S selecting them, approve, enforce, capture each
     `create`. Read back equal to the backup (name, description, script body, run-as account).
  4. **Update round:** change the description of all four, and change the body of `KEEL-RT-shell` to `echo drifted`. Restore from
     S, approve, enforce, capture each `update`. Expect the shell body back to `echo KEEL-RT` (base64 `ZWNobyBLRUVMLVJU` if the
     fixture used exactly that text).
  5. **Refusal check (no write expected):** if the tenant lists a Microsoft-published remediation (`isGlobalScript: true`), dry run
     a restore selecting one. Expect it skipped as "Microsoft publishes this remediation", 0 writes. Do not promote.
  6. **Re-run check:** dry run from S again after step 4. Expect 0 planned writes for the four.
  7. Cleanup: delete all four fixtures. Report anything left.
  8. Commit the records and `.capture.json` files under `docs/release/qualifications/entra-live/` on
     `claude/live-evidence-restore-gaps-4`, branched from `origin/master` (secret scan and `pseudonymize.mjs check` first). No PR.
     Run `node tools/qualification/operations.mjs --live-evidence <that directory>` and report the `live evidence` lines.
- **Report:** B; the step 2 backup check; per type and operation: promoted / refused (exact message) / blocked; the step 5 and 6
  results; approval ids; the evidence branch and commit; anything left in the tenant.

### Q114: Live backup and restore of macOS custom attribute scripts and administrative templates (restore gaps batch 5, after #436)
- Requeued by the coordinator (2026-10-22 09:40 UTC): **#471 is fixed** by PR #475 (master `56d9682`): every script writer declares `DeviceManagementScripts.ReadWrite.All`, and a 403 names the missing grant. Marouane has added `DeviceManagementScripts.ReadWrite.All` (Application) to the Restorer and granted admin consent (2026-10-22). Run once `/opt/keel-live` is at `56d9682` or later (`grep -q SCRIPT_WRITE_PERMISSION /opt/keel-live/engine/restore/intuneOperations.mjs`); that build also has the #466 fix (#468). **Run the custom attribute script part only** (`KEEL-RT-attribute`, `deviceCustomAttributeShellScript`: steps 1-7 for that type). The administrative template part stays blocked on **#472** (backup holds no settings): do not create `KEEL-RT-admx`, and report it as blocked on #472.
  - **Step 0, before any fixture (read only; prints role names only, never the token):** get a fresh Restorer token and check its `roles` claim:
    `cd /opt/keel-live && node --input-type=module -e "import { getToken } from './tools/tenant-probe/auth.mjs'; import { readFileSync } from 'node:fs'; const c = JSON.parse(readFileSync('/etc/keel/restorer.json','utf8')); const t = (await getToken(c)).accessToken; console.log(JSON.parse(Buffer.from(t.split('.')[1], 'base64url')).roles.sort().join('\n'))"`
    - If the list includes `DeviceManagementScripts.ReadWrite.All`: log the list in Result and run the item. The "no permission to add" / "Restorer holds DeviceManagementConfiguration" wording below is superseded for script kinds.
    - If it does not: create nothing, set `Status: blocked`, and report in Result that admin consent for `DeviceManagementScripts.ReadWrite.All` appears not applied, with the roles listed. Grant nothing.
- Note (coordinator, 2026-10-22): **#466 is fixed** by PR #468 (master `7f7525d`). A restore now skips and logs an Intune type it does not touch that fails to read (501 NotSupported counts as not on the tenant; the vppToken and Managed Google Play `$select` fields are fixed). Deletes are refused while any type is unread. Re-run this item once `/opt/keel-live` is at `7f7525d` or later.
- Drafted by the "Restore batch 5" thread (2026-10-21). Code: PR #436. The backup now reads each macOS custom attribute script
  on its own (so it holds `scriptContent`), and reads the values of each administrative template setting
  (`definitionValues[].presentationValues`, one GET per setting). New record writers, fixture-tested only, beta, create + update:
  `deviceCustomAttributeShellScript` and `groupPolicyConfiguration` (template, then its settings and values through
  `updateDefinitionValues`). Who either is assigned to is **not** written; fixtures stay unassigned.
- Needs: /opt/keel-live at the #436 merge or later (`grep -q groupPolicySettingsAfterWrite /opt/keel-live/engine/restore/intuneOperations.mjs`).
- Status: todo
- Result: blocked (2026-10-22 08:18 UTC). The custom attribute script is blocked by a missing permission (**#471**); the administrative template backup holds no settings (**#472**). B = c396a2c. Restorer only; nothing granted; no restore was run.
  - `deviceCustomAttributeShellScript`: fixture create `POST beta /deviceManagement/deviceCustomAttributeShellScripts` answered **403**: "Application is not authorized to
    perform this operation. Application must have one of the following scopes: DeviceManagementScripts.ReadWrite.All". Create and update are **blocked** (#471).
    Its backup read is `complete-empty` 200.
  - `groupPolicyConfiguration`: created `KEEL-RT-admx` with Edge (machine) "Configure the home page URL" enabled = `https://example.com` (text box presentation) and
    "Show Home button on toolbar" disabled (`updateDefinitionValues` 204; the value reads back).
    - Snapshot S = `c468ba6c`: read outcome `complete` (2 items), but the fixture's `definitionValues` is **`[]`**, so the backup check fails.
    - As the Collector: `?$expand=definitionValues($expand=definition)` gives 0 values; `/{id}/definitionValues` gives 2. A restore would drop every setting, so I did not
      run the rounds. Create and update are **blocked** (#472).
  - Cleanup: deleted `KEEL-RT-admx` (204); no `KEEL-RT` template is left. Nothing left in the tenant.
- **Test tenant only.** Same hard rules, capture tooling and requester/approver split as Q67. Under the 2026-10-14 standing
  authorization, approve these restores yourself and log every approval id. Restorer only; global admin not used. No permission
  to add: the Restorer and collector hold DeviceManagementConfiguration.ReadWrite.All / .Read.All. If Graph answers 403, report
  blocked with what Graph names; grant nothing. Never touch CA policies, break-glass or Marouane's account.
  **Never assign either fixture to a group, user or device.**
- **Fixtures** (the reviewed guidance in `live-gate-plan.mjs` at B says the same; nothing runs or applies them):
  - macOS custom attribute script `KEEL-RT-attribute`, attribute name `KEEL-RTAttribute`, type string, body `echo KEEL-RT`,
    run as system, assigned to nobody;
  - administrative template `KEEL-RT-admx` with one **built-in** setting turned on that has a text value (for example Microsoft
    Edge > Startup > "Configure the home page URL" = `https://example.com`), plus one built-in setting set to Disabled, assigned to nobody.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. `node tools/qualification/live-gate-plan.mjs > ~/keel-rg5/plan-B.md`. Use its steps for these two types (collect, restore
     dry run, approve, `--enforce`, `entraLive.mjs capture`, promote).
  2. Create the fixtures, then take snapshot S (one tier run that reads both types). **Backup check:** confirm both are in S, that
     the script payload holds a non-empty `scriptContent`, and that every `definitionValues[]` of `KEEL-RT-admx` holds a
     `presentationValues` list (the text setting with one value whose `presentation.id` is set). Report both types' read outcome
     (complete / failed). If the template read fails, report the exact Graph error on the `presentationValues` read.
  3. **Create round:** delete both fixtures, restore from S selecting them, approve, enforce, capture each `create`. Read back
     equal to the backup (script: name, attribute name and type, body; template: name, description, both settings on/off as
     before, the home page value).
  4. **Update round:** change both descriptions; in `KEEL-RT-admx` change the home page value to `https://drifted.example` and add a
     third built-in setting. Restore from S, approve, enforce, capture each `update`. Expect the value back, the extra setting gone.
  5. **Re-run check:** dry run from S again after step 4. Expect 0 planned writes for the two.
  6. Cleanup: delete both fixtures. Report anything left.
  7. Commit the records and `.capture.json` files under `docs/release/qualifications/entra-live/` on
     `claude/live-evidence-restore-gaps-5`, branched from `origin/master` (secret scan and `pseudonymize.mjs check` first). No PR.
     Run `node tools/qualification/operations.mjs --live-evidence <that directory>` and report the `live evidence` lines.
- **Report:** B; the step 2 backup check; per type and operation: promoted / refused (exact message) / blocked; the step 5
  result; approval ids; the evidence branch and commit; anything left in the tenant.

### Q115: Check the new backup kinds of batch 7 land in a snapshot (read-only, after #440)
- Drafted by the "Back up Microsoft 365 settings left" thread (2026-10-21). Code: PR #440 (batch 7, 5 Microsoft 365
  settings kinds). All are GET-only v1.0 catalogue reads; no writer.
- Needs: PR #440 live (`git -C /opt/keel-live log --oneline | grep -c "#440"` is 1). Can run together with Q112.
- Status: done
- Result: done (2026-10-22 06:58 UTC). All five kinds read 200. Counts are as expected: 29 SharePoint setting keys, no `report`. Collector reads only.
  1. Collect by hand, no `--tier` (06:47 UTC, build e1a811b, the Q109 snapshot S `2b450888-07cd-4ba6-b250-96306b941b53`, which was the newest snapshot when queried): exit **1**. That exit code comes from `deviceManagementSettings` (#447) and the types in #466; none of the five types below has an error.
  2. attackSimulation 0, externalConnection 0, **itemInsightsSettings 1**, **sharepointSettings 1**, simulationAutomation 0 (query run with
     `snapshot_id = S`). The 0s are `complete-empty` 200.
  3. `sharepointSettings` top-level keys (29, including `@odata.context`): @odata.context, allowedDomainGuidsForSyncApp,
     availableManagedPathsForSiteCreation, deletedUserPersonalSiteRetentionPeriodInDays, excludedFileExtensionsForSyncApp,
     idleSessionSignOut, imageTaggingOption, isCommentingOnSitePagesEnabled, isFileActivityNotificationEnabled,
     isLegacyAuthProtocolsEnabled, isLoopEnabled, isMacSyncAppEnabled, isResharingByExternalUsersEnabled,
     isSharePointMobileNotificationEnabled, isSharePointNewsfeedEnabled, isSiteCreationEnabled, isSiteCreationUIEnabled,
     isSitePagesCreationEnabled, isSitesStorageLimitAutomatic, isSyncButtonHiddenOnPersonalSite, isUnmanagedSyncAppForTenantRestricted,
     personalSiteDefaultStorageLimitInMB, sharingAllowedDomainList, sharingBlockedDomainList, sharingCapability,
     sharingDomainRestrictionMode, siteCreationDefaultManagedPath, siteCreationDefaultStorageLimitInMB, tenantDefaultTimezone.
     attackSimulation payloads with `report`: 0.
- **Tenant:** reads only, with the collector credential. No grants, no role or config changes, nothing written.
- Do, from `/opt/keel-live` with `set -a; . /etc/keel/db.env; set +a`:
  1. `node cli/keel-collect.mjs` once by hand (no `--tier`, so every tier is read). Report its exit code and any log
     line that names one of the types below with an error or a 400/403/404.
  2. ```sql
     WITH s AS (SELECT id FROM snapshot ORDER BY started_at DESC LIMIT 1)
     SELECT t.type, count(rv.resource_type) AS objects
       FROM unnest('{sharepointSettings,itemInsightsSettings,externalConnection,simulationAutomation,attackSimulation}'::text[]) AS t(type)
       LEFT JOIN resource_version rv ON rv.resource_type = t.type AND rv.snapshot_id = (SELECT id FROM s)
      GROUP BY t.type ORDER BY t.type;
     ```
     If the table or column names differ, take the snapshot step 1 made and report what you ran.
  3. Field check: report the top-level keys of the stored `sharepointSettings` payload, and confirm no stored
     `attackSimulation` payload holds a `report` key.
- **Expected:** step 1 exit 0. Step 2 from discovery run 3: 1 `sharepointSettings`, 1 `itemInsightsSettings`, 0 for the
  other three. Step 3: about 29 setting keys (sharingCapability, isLoopEnabled, idleSessionSignOut, ...), no `report`.
- **Report:** step 1 exit code and error lines, steps 2 and 3 verbatim.

### Q116: Live backup and restore of app categories, Autopilot profiles and policy sets (restore gaps batch 6, after #442)
- Note (coordinator, 2026-10-22): **#466 is fixed** by PR #468 (master `7f7525d`). A restore now skips and logs an Intune type it does not touch that fails to read (501 NotSupported counts as not on the tenant; the vppToken and Managed Google Play `$select` fields are fixed). Deletes are refused while any type is unread. Re-run this item once `/opt/keel-live` is at `7f7525d` or later.
- Drafted by the "Restore batch 6" thread (2026-10-22). Code: PR #442. The backup now reads each policy set on its own with
  its items expanded (`/deviceAppManagement/policySets/{id}?$expand=items`). New record writers, fixture-tested only, create + update:
  `mobileAppCategory` (v1.0; built-in categories never written), `windowsAutopilotDeploymentProfile` (beta; `@odata.type` sent,
  never changed) and `policySet` (beta; the set, then its items through `POST .../policySets/{id}/update`, remove then add).
  Who any of them is assigned to is **not** written; fixtures stay unassigned.
- Needs: /opt/keel-live at the #442 merge or later (`grep -q policySetItemsAfterWrite /opt/keel-live/engine/restore/intuneOperations.mjs`).
- Status: done
- Result: done (2026-10-22 08:37 UTC), partly: 1 of 6 operations promoted; the rest are blocked on **#473**, **#474** and an Autopilot 400. B = **c396a2c**. Restorer only; global admin not used; nothing granted.
  - **Per type and operation:**
    | type | create | update |
    |---|---|---|
    | mobileAppCategory | **promoted** | **blocked** (#474): enforce always refused as "the target has changed since the dry run" |
    | windowsAutopilotDeploymentProfile | **blocked**: fixture create 400 | **blocked** (same) |
    | policySet | **blocked** (#473): the restore lists `policySets/{parent}?$expand=items` literally | **blocked** (#473) |
    - Autopilot: `POST beta /deviceManagement/windowsAutopilotDeploymentProfiles` (azureAD kind) answered 400 "An error has occurred" (DeviceEnroll service, no detail)
      for every body tried: minimal, + OOBE, + language, and the newer field names. Likely a tenant Autopilot prerequisite (inference).
    - #474: Graph stamps a custom category's `lastModifiedDateTime` with the read time, so the current-state fingerprint differs on every read (two dry runs: 95e529ef… against c4f60017…).
  - **Backup check** (S = `a735510d`): mobileAppCategory `complete` (10), policySet `complete` (1), windowsAutopilotDeploymentProfile `complete-empty` (0).
    The `KEEL-RT-set` payload holds `items` with the one `#microsoft.graph.deviceConfigurationPolicySetItem` (payloadId set, KEEL-RT-profile).
  - **Rounds:** fixtures `KEEL-RT-profile` (windows10 general, unassigned), `KEEL-RT-apps`, `KEEL-RT-set`.
    - Create: deleted the category and the set. The two-type dry run failed (#473). A category-only dry run `de13d55e`, approval **59419567**, job `4f888040` succeeded;
      the category reads back `KEEL-RT-apps`.
    - Update: S2 = `94a46548`, renamed to `KEEL-RT-apps-drift`. Dry runs `8ab753db` and `9caf2b8a`, approvals **ee2c64a4** and **03e41620**: both jobs refused before writing (#474).
  - **Re-run check:** not meaningful while the updates are blocked; skipped.
  - **Cleanup:** deleted the category, the set and KEEL-RT-profile. Re-read: no KEEL-RT category, profile, set or Autopilot profile. **Nothing left.**
  - **Evidence:** `claude/live-evidence-restore-gaps-6` @ **e2a54e1** (mobileAppCategory.create + .capture.json). pseudonymize check exit 0; my scan is clean.
    `live evidence mobileAppCategory.create.json: fixture-tested -> live-qualified`.
- **Test tenant only.** Same hard rules, capture tooling and requester/approver split as Q67. Under the 2026-10-14 standing
  authorization, approve these restores yourself and log every approval id. Restorer only; global admin not used. The Restorer
  needs DeviceManagementApps.ReadWrite.All (categories, policy sets) and DeviceManagementServiceConfig.ReadWrite.All (Autopilot).
  If Graph answers 403, report blocked with what Graph names; grant nothing. Never touch CA policies, break-glass or
  Marouane's account. **Never assign any fixture to a group, user or device.** No tenant-wide setting is changed.
- **Fixtures** (the reviewed guidance in `live-gate-plan.mjs` at B says the same; nothing applies them):
  - app category `KEEL-RT-apps`, no app in it;
  - Windows Autopilot profile `KEEL-RT-autopilot`, Microsoft Entra joined, device name template `KEELRT-%RAND:4%`, assigned to nobody;
  - policy set `KEEL-RT-set` holding one existing `KEEL-RT-` device configuration profile (create one, unassigned, if none is
    left), assigned to nobody.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. `node tools/qualification/live-gate-plan.mjs > ~/keel-rg6/plan-B.md`. Use its steps for these three types (collect, restore
     dry run, approve, `--enforce`, `entraLive.mjs capture`, promote).
  2. Create the fixtures, then take snapshot S (one tier run that reads all three types). **Backup check:** confirm all three are
     in S, and that the `KEEL-RT-set` payload holds an `items` list with the one profile (`payloadId` set, `@odata.type` a
     `deviceConfigurationPolicySetItem`). Report each type's read outcome (complete / failed). If the policy set read fails,
     report the exact Graph error on the per-set read.
  3. **Create round:** delete the category, the Autopilot profile and the set (not the profile inside it), restore from S
     selecting the three, approve, enforce, capture each `create`. Read back equal to the backup (category name; profile
     kind, name, description, device name template, out-of-box settings; set name, description, and the one item).
  4. **Update round:** rename the category to `KEEL-RT-apps-drift`, change the profile's device name template to
     `DRIFT-%SERIAL%`, change the set's description and remove its item. Restore from S, approve, enforce, capture each
     `update`. Expect all three back as in S, the set's item added again.
  5. **Re-run check:** dry run from S again after step 4. Expect 0 planned writes for the three.
  6. Cleanup: delete the three fixtures (and the profile inside the set, if you created it). Report anything left.
  7. Commit the records and `.capture.json` files under `docs/release/qualifications/entra-live/` on
     `claude/live-evidence-restore-gaps-6`, branched from `origin/master` (secret scan and `pseudonymize.mjs check` first). No PR.
     Run `node tools/qualification/operations.mjs --live-evidence <that directory>` and report the `live evidence` lines.
- **Report:** B; the step 2 backup check; per type and operation: promoted / refused (exact message) / blocked; the step 5
  result; approval ids; the evidence branch and commit; anything left in the tenant.

### Q118: Check the batch 8 backup kinds land in a snapshot, and rerun discovery (read-only, after #446)
- Drafted by the "Back up last held-back kinds" thread (2026-10-22). Code: PR #446 (remaining kinds batch 8, 14 kinds,
  GET only, no writer). Two are read per parent with a filter: `entitlementManagementRoleAssignment`
  (`/roleManagement/entitlementManagement/roleAssignments?$filter=roleDefinitionId eq '{id}'`, once per role) and
  `schemaExtension` (`/schemaExtensions?$filter=owner eq '{appId}'`, once per app registration). Discovery now skips the
  last gaps with a reason (new reasons `holds-secrets`, `retired`, `other-tenant`).
- Needs: PR #446 live (`git -C /opt/keel-live log --oneline | grep -c "#446"` is 1). Can run together with Q115.
- Status: done
- Result: done (2026-10-22 06:58 UTC). All 14 kinds read 200, and the two filtered reads gave no 400. Discovery run 4: **0 uncatalogued**. Collector reads only.
  1. Collect by hand, no `--tier` (06:47 UTC, build e1a811b, the Q109 snapshot S `2b450888-07cd-4ba6-b250-96306b941b53`, which was the newest snapshot when queried): exit **1**. That exit code comes from `deviceManagementSettings` (#447) and the types in #466; none of the 14 types below has an error.
  2. certificateBasedApplicationConfiguration 0, crossTenantM365Capability 0, deviceTemplate 0, entitlementManagementRoleAssignment 0,
     externalOriginResourceConnector 0, hardwareConfiguration 0, **lifecyclePolicy 1**, privilegedAccessGroupResource 0,
     roleManagementCustomExtension 0, schemaExtension 0, securityZone 0, sharedEmailDomain 0, signInIdentifier 0, verifiedIdProfile 0
     (query run with `snapshot_id = S`). Every 0 is `complete-empty` 200, including entitlementManagementRoleAssignment and schemaExtension.
  3. hardwareConfiguration with `configurationFileContent`: 0. roleManagementCustomExtension with `endpointConfiguration`: 0.
  4. `time node cli/keel-discover.mjs run`: exit **0**, real 4m44.9s.
     - First line: `Discovery 2026-10-22T06:58:07.758Z: 1004 types; 187 catalogued, 0 uncatalogued, 171 skipped (not worth backing up), 574 unreadable, 72 not listed.`
     - `Stored discovery run 4.`
     - Status and reason (kind <> cmdlet): catalogued 290; skipped holds-secrets 2, microsoft-published 31, not-configuration 199,
       other-tenant 6, retired 1; unreadable error 60, missing-grant 227, not-licensed 44, not-listable 345, refused-with-grant 146.
     - Uncatalogued: `(0 rows)`.
- **Tenant:** reads only, with the collector credential. No grants, no role or config changes, nothing written.
- Do, from `/opt/keel-live` with `set -a; . /etc/keel/db.env; set +a`:
  1. `node cli/keel-collect.mjs` once by hand (no `--tier`, so every tier is read). Report its exit code and any log
     line that names one of the types below with an error or a 400/403/404.
  2. ```sql
     WITH s AS (SELECT id FROM snapshot ORDER BY started_at DESC LIMIT 1)
     SELECT t.type, count(rv.resource_type) AS objects
       FROM unnest('{hardwareConfiguration,certificateBasedApplicationConfiguration,signInIdentifier,verifiedIdProfile,externalOriginResourceConnector,lifecyclePolicy,roleManagementCustomExtension,privilegedAccessGroupResource,crossTenantM365Capability,entitlementManagementRoleAssignment,deviceTemplate,securityZone,sharedEmailDomain,schemaExtension}'::text[]) AS t(type)
       LEFT JOIN resource_version rv ON rv.resource_type = t.type AND rv.snapshot_id = (SELECT id FROM s)
      GROUP BY t.type ORDER BY t.type;
     ```
     If the table or column names differ, take the snapshot step 1 made and report what you ran.
  3. Field check: confirm no stored `hardwareConfiguration` payload has a `configurationFileContent` key and no stored
     `roleManagementCustomExtension` payload has an `endpointConfiguration` key (both expected 0 objects anyway).
  4. `time node cli/keel-discover.mjs run --config /etc/keel/tenant.json`. Report the exit code, the first summary
     line, and the `Stored discovery run <id>` line. Then, for that run:
     ```sql
     SELECT status, reason, count(*) FROM discovery_item
      WHERE run_id = (SELECT id FROM discovery_run ORDER BY finished_at DESC, id DESC LIMIT 1) AND kind <> 'cmdlet'
      GROUP BY 1, 2 ORDER BY 1, 2;
     SELECT source, name FROM discovery_item
      WHERE run_id = (SELECT id FROM discovery_run ORDER BY finished_at DESC, id DESC LIMIT 1)
        AND status = 'uncatalogued' AND kind <> 'cmdlet' ORDER BY name, source;
     ```
- **Expected:** step 1 exit 0. Step 2 from discovery run 3: 1 `lifecyclePolicy`, 0 or a few `schemaExtension` (only
  extensions owned by this tenant's apps), 0 for the others (run 3 counted 0 each); any 400 on the two
  filtered reads is the finding to report verbatim. Step 3: 0 and 0. Step 4: no Graph path left `uncatalogued`
  (any that remain are new paths Microsoft added since run 3; list them).
- **Report:** steps 1 to 4 verbatim.

### Q120: Live backup and restore of settings catalog compliance policies (restore gaps batch 7, after #451)
- Note (coordinator, 2026-10-22): **#466 is fixed** by PR #468 (master `7f7525d`). A restore now skips and logs an Intune type it does not touch that fails to read (501 NotSupported counts as not on the tenant; the vppToken and Managed Google Play `$select` fields are fixed). Deletes are refused while any type is unread. Re-run this item once `/opt/keel-live` is at `7f7525d` or later.
- Drafted by the "Restore batch 7" thread (2026-10-22). Code: PR #451. The backup now reads each settings catalog
  compliance policy on its own: `GET /beta/deviceManagement/compliancePolicies/{id}?$expand=settings,scheduledActionsForRule($expand=scheduledActionConfigurations)`.
  New record writer `deviceManagementCompliancePolicy` (beta, fixture-tested only), create + update: create is one POST with
  settings and actions; update is a PUT of the whole policy (never the actions), then, only if the actions differ,
  `POST .../compliancePolicies/{id}/setScheduledActions` with `{ scheduledActions: [...] }`, read back. Who the policy is
  assigned to is **not** written; the fixture stays unassigned.
- Needs: /opt/keel-live at the #451 merge or later (`grep -q complianceActionsAfterWrite /opt/keel-live/engine/restore/intuneOperations.mjs`).
- Status: blocked
- Result: blocked (2026-10-22 08:42 UTC) on **#473** (comment on it covers this type). B = c396a2c. Restorer only; nothing granted; no restore approved.
  - Fixture `KEEL-RT-compliance` (Linux, linuxMdm, `linux_deviceencryption_required_true`). The notification action was not possible: creating `KEEL-RT-notice`
    (`notificationMessageTemplates`, beta and v1.0) answered **400** "An error has occurred" (StatelessNotification service), so the fixture had **block 0 h** only.
  - **Backup check fails** (S = `94ad1b37`, tier 1): read outcome `complete` (1), `settings` 1 item, but **`scheduledActionsForRule: []`**. Graph returns `[]` for the
    double `$expand` on the policy; the `/scheduledActionsForRule?$expand=scheduledActionConfigurations` navigation returns the action.
  - Update round: drifted the description to `drift` (`PUT` 204) and block to 72 h (`setScheduledActions` 200); both routes work live by hand.
    The dry run `85342bea` exited 1 before planning: `listing /deviceManagement/compliancePolicies/{parent}?$expand=... failed` (#473). Create and update: **blocked**.
  - Cleanup: deleted the policy; no KEEL-RT compliance policy is left. No template was created. Nothing left.
- **Test tenant only.** Same hard rules, capture tooling and requester/approver split as Q67. Under the 2026-10-14 standing
  authorization, approve these restores yourself and log every approval id. Restorer only; global admin not used. The Restorer
  needs DeviceManagementConfiguration.ReadWrite.All. If Graph answers 403, report blocked with what Graph names; grant nothing.
  Never touch CA policies, break-glass or Marouane's account. **Never assign the fixture to a group, user or device.** No
  tenant-wide setting is changed.
- **Fixture** (the reviewed guidance in `live-gate-plan.mjs` at B says the same): Linux settings catalog compliance policy
  `KEEL-RT-compliance`, one setting (device encryption required), actions: block after 0 hours and email the user after
  24 hours (any notification template; create `KEEL-RT-notice` if none exists), assigned to nobody.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. `node tools/qualification/live-gate-plan.mjs > ~/keel-rg7/plan-B.md`. Use its steps for this type (collect, restore
     dry run, approve, `--enforce`, `entraLive.mjs capture`, promote).
  2. Create the fixture, then take snapshot S (one tier 1 run). **Backup check:** the `KEEL-RT-compliance` payload in S holds
     `settings` (1 item) and `scheduledActionsForRule` with both actions (`block` 0 h, `notification` 24 h). Report the type's
     read outcome. If the per-policy read fails, report the exact Graph error (first suspect: the double `$expand`).
  3. **Update round:** change the description to `drift` and the block grace period to 72 hours. Restore from S, approve,
     enforce, capture `update`. Expect description and block 0 h back. Report the exact Graph answer if the PUT or
     `setScheduledActions` is refused (both routes are unmeasured live).
  4. **Create round:** delete the policy, restore from S, approve, enforce, capture `create`. Read back equal to S (name,
     description, platform, the setting, both actions).
  5. **Re-run check:** dry run from S again after step 4. Expect 0 planned writes for this type.
  6. Cleanup: delete the fixture (and `KEEL-RT-notice` if you created it). Report anything left.
  7. Commit the records and `.capture.json` files under `docs/release/qualifications/entra-live/` on
     `claude/live-evidence-restore-gaps-7`, branched from `origin/master` (secret scan and `pseudonymize.mjs check` first). No PR.
     Run `node tools/qualification/operations.mjs --live-evidence <that directory>` and report the `live evidence` lines.
- **Report:** B; the step 2 backup check; per operation: promoted / refused (exact message) / blocked; the step 5 result;
  approval ids; the evidence branch and commit; anything left in the tenant.

### Q121: Retry the whole-tenant content backup now that deploys drain the worker (read-only, after #449)
- Drafted by the "Deploys kill running jobs" thread (2026-10-22). Re-runs Q101's widening, which was rolled back only because
  an auto-deploy restarted `keel-worker` mid-job (#448). Marouane's Q101 decision still holds: "get everything in the scope". **Marouane's go for this retry and the deploy change:
  2026-10-22 06:27 UTC** (decision card in the "Deploys kill running jobs" thread).
- Code: PR #449. `keel-worker` now treats SIGUSR2 (`systemctl reload keel-worker`) as drain: the running job finishes,
  nothing new is claimed, the worker exits 0 and systemd starts it on the new tree. SIGTERM still ends the running job.
- Needs and step 0 (host; check each, fix 2 and 3 if needed, report the output):
  1. #449 live: `git -C /opt/keel-live log --oneline | grep -c "#449"` is at least 1.
  2. The installed unit has the reload: `systemctl show keel-worker -p ExecReload` names `kill -USR2`. If not, do it
     yourself (Marouane's go above; the deploy script is yours to change): `install -m 0644
     /opt/keel-live/ops/keel-worker.service /etc/systemd/system/ && systemctl daemon-reload`. Only this unit, so the full
     install script and its quiet-moment preflight are not needed. No worker restart: the running worker already has the
     SIGUSR2 handler from the #449 deploy.
  3. The deploy drains instead of restarting. If `grep -n "keel-worker" /opt/keel-deploy/deploy.sh` still shows
     `try-restart keel-worker` (lines 125 and 157 per your #448 comment): back it up
     (`cp -p /opt/keel-deploy/deploy.sh /opt/keel-deploy/deploy.sh.bak-q121`), replace both with
     `systemctl try-reload-or-restart keel-worker`, and `bash -n` it. No `restart keel-worker` / `try-restart keel-worker`
     may remain. Report the diff on #448 too.
- Status: in-progress
- Result: in progress (2026-10-22 07:44 UTC). Step 0, A and B are done; C waits for the **2026-10-23 01:00 UTC** run. Marouane approved the host changes directly in this session (07:4x UTC). Read-only toward the tenant.
  - **Step 0:**
    1. `#449` count in /opt/keel-live: **1** (f61ea92, 01:29 UTC).
    2. The unit had no reload. I installed `/opt/keel-live/ops/keel-worker.service` (old copy at `/root/keel-worker.service.bak-q121`) and ran
       `daemon-reload`. `ExecReload` is now `/bin/kill -USR2 $MAINPID`. No restart: the worker had started at 07:08:50, after #449.
    3. `/opt/keel-deploy/deploy.sh` (backup `deploy.sh.bak-q121`): lines 125 and 157 changed from `systemctl try-restart keel-worker` to
       `systemctl try-reload-or-restart keel-worker`. `bash -n` ok, and no `try-restart` or `restart keel-worker` is left. The diff is on #448.
  - **A.** Running jobs: 0. `systemctl reload keel-worker` at 07:43:55, exit 0:
    `07:43:55 worker Mulinux: received SIGUSR2 — finishing current job, then exiting` / `07:43:56 worker Mulinux: exited cleanly` /
    `07:44:01 systemd: Started keel-worker.service` / `07:44:01 worker Mulinux: polling for jobs every 2000ms`. `is-active`: **active**;
    MainPID 4025816 → **4033046**.
  - **B.** `content-scope.json.bak-q101` kept as the rollback copy (namePrefix `KEEL-RT-`). I copied `/root/q101-scope-wholetenant.json` over the scope
    file: root:root 600, parse exit 0. Contents: `{"tenantHost":"<org>.sharepoint.com"}`.
    - Before the run: `content_chunk` 4 054 / 225 270 538 bytes. `df -h /`: 150G, 51G used, 93G free (36 %). `du -sh` 229M.
  - **C.** Pending. A watcher logs to `/root/q121-watch.log` every 5 minutes and copies `.bak-q101` back if free space drops below 20 %.
- **Read-only toward the tenant**, same as Q101: collectors only read; no grants, no fixtures, no tenant writes. 403s are
  reported (count and masked reason), never fixed by granting.
- **A. Drain check (host only, no job running).** `SELECT count(*) FROM job WHERE status = 'running'` must be 0. Then
  `systemctl reload keel-worker`, wait 15 s, and report: the journal lines since the reload
  (`journalctl -u keel-worker --since "-1 min" | grep -E "SIGUSR2|exited cleanly|polling"`), and `systemctl is-active
  keel-worker` (expected `active`, with a new main PID).
- **B. Re-apply the whole-tenant scope.** `/etc/keel/content-scope.json.bak-q101` stays as the rollback copy. Then
  `cp /root/q101-scope-wholetenant.json /etc/keel/content-scope.json`, `chown root:root` and `chmod 600` it, check it parses
  (`node -e "JSON.parse(require('fs').readFileSync('/etc/keel/content-scope.json','utf8'))"`, exit 0) and paste it
  (tenantHost masked). No manual run: the nightly `content-collect` at **01:00 UTC** is the run.
- **C. After that run finishes:** everything Q101 part C asked for (job id, start, end, status, exit code; per workload the
  outcome, items, bytes, containers found vs read, throttled count, `reasons` masked; `df -h` and `du -sh` for
  `storage.root`; `content_chunk` count and bytes before vs after). Also:
  - every deploy during the run window (`journalctl -u keel-deploy --since "<job start>"`), and for each one the worker's
    `received SIGUSR2` line, if any;
  - if the job ended in `failed`, whether its error is `execution timed out after 21600000ms` (the six-hour ceiling Q101 A3
    warned about) or something else.
- **Rollback:** as in Q101: if the run fails, times out, or free space on `storage.root` drops below 20 %, copy
  `content-scope.json.bak-q101` back and say so. A `partial` outcome from 403s alone is not a rollback reason.
- **Report:** Needs 1-3, A, B (masked), C. Open an issue labelled `operator-report` only if a rollback happened.

### Q122: Live backup and restore of e-book categories, Microsoft Tunnel configurations and Apple user enrollment profiles (restore gaps batch 8, after #453)
- Note (coordinator, 2026-10-22): **#466 is fixed** by PR #468 (master `7f7525d`). A restore now skips and logs an Intune type it does not touch that fails to read (501 NotSupported counts as not on the tenant; the vppToken and Managed Google Play `$select` fields are fixed). Deletes are refused while any type is unread. Re-run this item once `/opt/keel-live` is at `7f7525d` or later.
- Drafted by the "Restore batch 8" thread (2026-10-22). Code: PR #453 (merged 2026-10-22 02:06 UTC, merge 3edc50d). No backup change: all three kinds were already read
  (list reads in `tools/tenant-probe/catalog.d/intune-leftovers.mjs`). New record writers, fixture-tested only, create + update, beta:
  `managedEBookCategory` (name), `microsoftTunnelConfiguration` (network, DNS, `routeIncludes`/`routeExcludes`, port, advanced
  settings; the deprecated `routesInclude`/`routesExclude` and `lastUpdateDateTime` are never sent) and
  `appleUserInitiatedEnrollmentProfile` (name, description, enrollment type options, default type; `platform` on create only;
  `priority` and assignments are **not** written). Fixtures stay unassigned and unused.
- Needs: /opt/keel-live at the #453 merge or later (`grep -q appleUserInitiatedEnrollmentProfile: /opt/keel-live/engine/restore/intuneOperations.mjs`).
- Status: done
- Result: done (2026-10-22 08:59 UTC). 5 of 6 operations promoted; the e-book category update is blocked by **#474**. Built and captured at **471cb9b** (the restores ran at c396a2c/471cb9b). Restorer only; global admin not used; nothing granted; no Tunnel site or server.
  - **Per type and operation:**
    | type | create | update |
    |---|---|---|
    | managedEBookCategory | **promoted** | **blocked** (#474): its `lastModifiedDateTime` is the read time, so enforce is refused |
    | microsoftTunnelConfiguration | **promoted** | **promoted** (port 8443 → 443, DNS 10.99.0.2 → 10.99.0.1) |
    | appleUserInitiatedEnrollmentProfile | **promoted** | **promoted** (description and default type back) |
  - **Backup check** (S = `7611927e`): all three `complete` (1 each). The Tunnel payload fields are advancedSettings, defaultDomainSuffix, description, disableUdpConnections,
    displayName, dnsServers, id, ipv6Network, lastUpdateDateTime, listenPort, network, roleScopeTagIds, routeExcludes, **routeIncludes**, routesExclude, **routesInclude**
    and splitDNS, so both route forms are stored.
    - The Tunnel create needed `defaultDomainSuffix`, `advancedSettings` and `roleScopeTagIds`; without them Graph answered 500 InternalServerError.
    - The Apple profile was created without any certificate prompt.
  - **Create round:** deleted all three. Dry run `68858a77` (3 selected, closed to 4 with `roleScopeTag:0`, which had no changed fields), approval **20d0e92d**, job `d9e1b795`
    succeeded. Read-back equals S: category name; Tunnel 10.99.0.0/24, DNS 10.99.0.1, route 10.98.0.0/16, port 443; profile description, iOS, company device,
    personal accountDrivenUserEnrollment, default device. (Priority and assignments are listed as follow-ups, as designed.)
  - **Update round:** S2 = `1b07428b`, then the drift.
    - All three together: dry run `4642d960`, approval **04d5675b**, job `172c8f05` refused with "the target has changed since the dry run" (#474).
    - Without the category: dry run `74f7c933`, approval **d725c731**, job `b4dfb0f1` succeeded.
  - **Re-run check:** the category name was put back by hand. Dry run `aab79538` from S2: all entries have no changed fields (**0 planned writes**).
  - **Cleanup:** deleted all three. Re-read: none left. **Nothing left.**
  - **Evidence:** `claude/live-evidence-restore-gaps-8` @ **238e796**. pseudonymize check exit 0; my scan is clean (the only hits are the fixture's test IP ranges).
    `live evidence`: appleUserInitiatedEnrollmentProfile.create and .update, managedEBookCategory.create, microsoftTunnelConfiguration.create and .update: `fixture-tested -> live-qualified`.
- **Test tenant only.** Same hard rules, capture tooling and requester/approver split as Q67. Under the 2026-10-14 standing
  authorization, approve these restores yourself and log every approval id. Restorer only; global admin not used. The Restorer
  needs DeviceManagementApps.ReadWrite.All (e-book categories), DeviceManagementConfiguration.ReadWrite.All (Tunnel) and
  DeviceManagementServiceConfig.ReadWrite.All (Apple enrollment). If Graph answers 403, report blocked with what Graph names;
  grant nothing. Never touch CA policies, break-glass or Marouane's account. **Never assign any fixture to a group, user or
  device, and never create a Tunnel site or server.** No tenant-wide setting is changed.
- **Fixtures** (the reviewed guidance in `live-gate-plan.mjs` at B says the same; nothing applies them):
  - e-book category `KEEL-RT-books`, no book in it;
  - Microsoft Tunnel server configuration `KEEL-RT-tunnel`: network `10.99.0.0/24`, DNS server `10.99.0.1`, port 443, one
    included route `10.98.0.0/16`, used by no site;
  - Apple user enrollment profile `KEEL-RT-apple-enroll`: iOS/iPadOS, company devices device enrollment, personal devices
    account driven user enrollment, default device, assigned to nobody. If Intune refuses to create it (for example no Apple
    MDM push certificate in the tenant), report the exact message and skip this kind; do not upload a certificate.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. `node tools/qualification/live-gate-plan.mjs > ~/keel-rg8/plan-B.md`. Use its steps for these three types (collect, restore
     dry run, approve, `--enforce`, `entraLive.mjs capture`, promote).
  2. Create the fixtures, then take snapshot S (a run that reads all three types). **Backup check:** all three are in S; report
     each type's read outcome and the stored Tunnel payload's field names (are both `routesInclude` and `routeIncludes` there?).
  3. **Create round:** delete all three, restore from S selecting the three, approve, enforce, capture each `create`. Read back
     equal to the backup (category name; Tunnel network, DNS, route, port; profile name, description, platform, options, default).
  4. **Update round:** rename the category to `KEEL-RT-books-drift`, change the Tunnel port to 8443 and DNS server to `10.99.0.2`,
     change the profile's description to `drift` and its default type to account driven user enrollment. Restore from S,
     approve, enforce, capture each `update`. Expect all three back as in S. Report the exact Graph answer for any refused
     PATCH (all routes are unmeasured live).
  5. **Re-run check:** dry run from S again after step 4. Expect 0 planned writes for the three.
  6. Cleanup: delete the three fixtures. Report anything left.
  7. Commit the records and `.capture.json` files under `docs/release/qualifications/entra-live/` on
     `claude/live-evidence-restore-gaps-8`, branched from `origin/master` (secret scan and `pseudonymize.mjs check` first). No PR.
     Run `node tools/qualification/operations.mjs --live-evidence <that directory>` and report the `live evidence` lines.
- **Report:** B; the step 2 backup check; per type and operation: promoted / refused (exact message) / blocked; the step 5
  result; approval ids; the evidence branch and commit; anything left in the tenant.

### Q123: Live backup and restore of Company Portal branding profiles and Exchange app access scopes (restore gaps batch 9, after #454)
- Note (coordinator, 2026-10-22): **#466 is fixed** by PR #468 (master `7f7525d`). A restore now skips and logs an Intune type it does not touch that fails to read (501 NotSupported counts as not on the tenant; the vppToken and Managed Google Play `$select` fields are fixed). Deletes are refused while any type is unread. Re-run this item once `/opt/keel-live` is at `7f7525d` or later.
- Drafted by the "Restore batch 9" thread (2026-10-22). Code: PR #454 (merged 2026-10-22 02:43 UTC, merge a2f0955). No backup change: both kinds
  were already read (list reads in `tools/tenant-probe/catalog.d/tenant-connectors.mjs` and `other-role-providers.mjs`). New record writers,
  fixture-tested only, create + update, beta:
  `intuneBrandingProfile` (name, description, organization name, theme colour, contact details, links, Company Portal options; logos,
  `isDefaultProfile` and assignments are **never** sent; the **default profile is refused**) and `exchangeCustomAppScope`
  (`displayName`, `customAttributes` with the recipient filter; `type` on create only; app role assignments not written).
- Needs: /opt/keel-live at the #454 merge or later (`grep -q exchangeCustomAppScope: /opt/keel-live/engine/restore/identityObjectOperations.mjs`).
- Status: in-progress
- Result: blocked (2026-10-22 07:03 UTC) on **#466**, not started. Needs are met at e1a811b, but every `keel-restore --snapshot-id ... --select` dry run stops in its current-state read on an unneeded Intune type (`deviceManagementExchangeConnector` 501 NotSupported; also `onPremisesConditionalAccessSettings` 501 and the vppToken and androidManagedStoreAccountEnterpriseSettings `$select` 400s), before planning. Seen in Q109. Nothing written for this item; I will start it once #466 is fixed and deployed.
- **Test tenant only.** Same hard rules, capture tooling and requester/approver split as Q67. Under the 2026-10-14 standing
  authorization, approve these restores yourself and log every approval id. Restorer only; global admin not used. The Restorer
  needs DeviceManagementServiceConfig.ReadWrite.All (branding) and RoleManagement.ReadWrite.Exchange (app scopes); both are in the
  Q-inventory grant list. If Graph answers 403, report blocked with what Graph names; grant nothing. Never touch CA policies,
  break-glass or Marouane's account. **Never change the default Company Portal branding, never assign the branding fixture to a
  group, never create an app role assignment that names the scope, and never touch the existing scope that limits the mail
  fixture app to keel-rt- mailboxes.** No tenant-wide setting is changed.
- **Fixtures** (the reviewed guidance in `live-gate-plan.mjs` at B says the same; nothing applies them):
  - Company Portal branding profile `KEEL-RT-branding`: organization name `KEEL-RT IT`, theme colour #1B2A4A, a help desk name
    and email, no logos, assigned to no group;
  - Exchange app access scope `KEEL-RT-app-scope`: type RecipientScope, filter `PrimarySmtpAddress -like 'keel-rt-scope-none*'`
    (matches no mailbox), used by no app role assignment.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. `node tools/qualification/live-gate-plan.mjs > ~/keel-rg9/plan-B.md`. Use its steps for these two types (collect, restore
     dry run, approve, `--enforce`, `entraLive.mjs capture`, promote).
  2. Create the fixtures, then take snapshot S (a run that reads both types). **Backup check:** both are in S; report each type's
     read outcome, and for branding whether the stored payload holds any logo bytes (expected: none) and its `isDefaultProfile`.
  3. **Create round:** delete both, restore from S selecting the two, approve, enforce, capture each `create`. Read back equal to
     the backup (branding name, colour, contact details; scope name, type and filter).
  4. **Update round:** change the branding contact name to `drift` and theme colour to #F5A623; change the scope filter to
     `PrimarySmtpAddress -like 'keel-rt-scope-drift*'`. Restore from S, approve, enforce, capture each `update`. Expect both back
     as in S. Report the exact Graph answer for any refused POST or PATCH (both routes are unmeasured live).
  5. **Default check (read-only):** the dry run from S must list the default branding profile as skipped (manual), with no write.
  6. **Re-run check:** dry run from S again after step 4. Expect 0 planned writes for the two.
  7. Cleanup: delete both fixtures. Report anything left.
  8. Commit the records and `.capture.json` files under `docs/release/qualifications/entra-live/` on
     `claude/live-evidence-restore-gaps-9`, branched from `origin/master` (secret scan and `pseudonymize.mjs check` first). No PR.
     Run `node tools/qualification/operations.mjs --live-evidence <that directory>` and report the `live evidence` lines.
- **Report:** B; the step 2 backup check; per type and operation: promoted / refused (exact message) / blocked; steps 5 and 6;
  approval ids; the evidence branch and commit; anything left in the tenant.

### Q124: Live backup and restore of Endpoint analytics baselines, classroom carts and Android enrollment profiles (restore gaps batch 10, after #455)
- Note (coordinator, 2026-10-22): **#466 is fixed** by PR #468 (master `7f7525d`). A restore now skips and logs an Intune type it does not touch that fails to read (501 NotSupported counts as not on the tenant; the vppToken and Managed Google Play `$select` fields are fixed). Deletes are refused while any type is unread. Re-run this item once `/opt/keel-live` is at `7f7525d` or later.
- Drafted by the "Restore batch 10" thread (2026-10-22). Code: PR #455 (merged 2026-10-22T03:25:16+00:00, merge 0537e09). No backup change: all four kinds were already read
  (list reads in `tools/tenant-probe/catalog.d/intune-leftovers.mjs`). New record writers, fixture-tested only, create + update, beta:
  `userExperienceAnalyticsBaseline` (`displayName` only; **built-in baselines refused**), `cartToClassAssociation` (name, description,
  `deviceIds`, `classroomIds`), `androidForWorkEnrollmentProfile` (name, description) and `androidDeviceOwnerEnrollmentProfile` (name,
  description, device name template, Wi-Fi fields, scope tags; `enrollmentMode`, `enrollmentTokenType`, `isTeamsDeviceProfile` on create
  only; a profile on a **secured Wi-Fi network is refused** unless the live profile already joins it). Tokens, QR codes and the Wi-Fi
  password are never read or sent.
- Needs: /opt/keel-live at the #455 merge or later (`grep -q androidDeviceOwnerEnrollmentProfile: /opt/keel-live/engine/restore/intuneOperations.mjs`).
- Status: blocked
- Result: blocked (2026-10-22 07:03 UTC) on **#466**, not started. Needs are met at e1a811b, but every `keel-restore --snapshot-id ... --select` dry run stops in its current-state read on an unneeded Intune type (`deviceManagementExchangeConnector` 501 NotSupported; also `onPremisesConditionalAccessSettings` 501 and the vppToken and androidManagedStoreAccountEnterpriseSettings `$select` 400s), before planning. Seen in Q109. Nothing written for this item; I will start it once #466 is fixed and deployed.
- **Test tenant only.** Same hard rules, capture tooling and requester/approver split as Q67. Under the 2026-10-14 standing
  authorization, approve these restores yourself and log every approval id. Restorer only; global admin not used. The Restorer
  needs DeviceManagementConfiguration.ReadWrite.All (baselines, carts) and DeviceManagementServiceConfig.ReadWrite.All (Android
  profiles). If Graph answers 403, report blocked with what Graph names; grant nothing. Never touch CA policies, break-glass or
  Marouane's account. **Never change a built-in baseline, never put a device or class in the cart, never make or hand out an
  enrollment token, and never connect managed Google Play or the legacy Android work profile connection.** No tenant-wide setting
  is changed.
- **Fixtures** (the reviewed guidance in `live-gate-plan.mjs` at B says the same; nothing applies them):
  - custom Endpoint analytics baseline `KEEL-RT-baseline`;
  - classroom cart association `KEEL-RT-cart`: description `Fixture`, no devices, no classes;
  - legacy Android work profile enrollment profile `KEEL-RT-android-work`: description `Fixture`, no token;
  - Android Enterprise dedicated device enrollment profile `KEEL-RT-android-owner`: device name template `KEEL-RT-{{SERIAL}}`, no
    Wi-Fi, no token.
  - If Intune refuses to create any fixture (Endpoint analytics not set up, no Intune for Education, no Android binding), report the
    exact message and skip that kind; do not set anything up to make it work.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. `node tools/qualification/live-gate-plan.mjs > ~/keel-rg10/plan-B.md`. Use its steps for these four types (collect, restore
     dry run, approve, `--enforce`, `entraLive.mjs capture`, promote).
  2. Create the fixtures, then take snapshot S (a run that reads all four types). **Backup check:** each created fixture is in S;
     report each type's read outcome and, for baselines, whether a built-in baseline is also in S with `isBuiltIn: true`.
  3. **Create round:** delete the created fixtures, restore from S selecting the four types, approve, enforce, capture each `create`.
     Read back equal to the backup (baseline name; cart name and description; profile names, descriptions, mode, name template).
  4. **Update round:** rename the baseline to `KEEL-RT-baseline-drift`; change the cart description to `drift`; change both Android
     profiles' descriptions to `drift` and the owner profile's name template to `DRIFT-{{SERIAL}}`. Restore from S, approve, enforce,
     capture each `update`. Expect all back as in S. Report the exact Graph answer for any refused POST or PATCH (all routes are
     unmeasured live).
  5. **Built-in check (read-only):** the dry run from S must list any built-in baseline as skipped, with no write.
  6. **Re-run check:** dry run from S again after step 4. Expect 0 planned writes for the four.
  7. Cleanup: delete the fixtures. Report anything left.
  8. Commit the records and `.capture.json` files under `docs/release/qualifications/entra-live/` on
     `claude/live-evidence-restore-gaps-10`, branched from `origin/master` (secret scan and `pseudonymize.mjs check` first). No PR.
     Run `node tools/qualification/operations.mjs --live-evidence <that directory>` and report the `live evidence` lines.
- **Report:** B; the step 2 backup check; per type and operation: promoted / refused (exact message) / skipped (fixture could not be
  created) / blocked; steps 5 and 6; approval ids; the evidence branch and commit; anything left in the tenant.

### Q125: Read-only check that a restore never changes the filter of an Exchange app scope an app role assignment uses (after #456)
- Drafted by the "Guard Exchange app scope restore" thread (2026-10-22), from your review on #454. Code: PR #456. A restore of an
  `exchangeCustomAppScope` update is now skipped as a manual step (completion requirement `exchangeAppScopeFilter`) when the backup's
  `customAttributes` differ from the live scope and any Exchange app role assignment (beta `/roleManagement/exchange/roleAssignments`,
  every page) has `appScopeId` equal to the scope's id. If the assignments or the live scope cannot be read, the update is skipped too.
- Needs: /opt/keel-live at the #456 merge or later (`grep -q appScopeGuard /opt/keel-live/engine/restore/identityObjectOperations.mjs`).
- Status: done
- Result: done (2026-10-22 07:02 UTC), with a finding: **#467**. The guard skipped in all 10 calls with 0 writes, but it can fail open, because the beta role-assignment paging (#438) sometimes returns none of L's assignments. B = **e1a811b**. Restorer reads only; the writer's `write` was a stub that throws, and it was never called. Nothing written.
  1. L = `KEEL-RT-test-mailboxes` (RecipientScope, filter `PrimarySmtpAddress -like 'keel-rt-*'`), the only custom app scope.
     - Exchange app role assignments: 3 pages, 231 rows per read, but only 226–230 unique, and the set changes between reads.
     - **3 distinct assignments name L** (two are Application Calendars.ReadWrite and Contacts.ReadWrite). Every one has `appScopeId`
       equal to L's `id` exactly; no prefixed form, and `directoryScopeId` is empty on them.
     - Unique assignments naming L in 10 back-to-back reads: 3, 3, 3, 1, 3, **0**, 3, 3, 3, 1. My first read also saw **0**.
  2. Broader filter `PrimarySmtpAddress -like '*'`, with `live.payload` = L: `{"skipped":{"naturalKey":"<L.id>","reason":"manual: This app access scope is used by 2 app role assignments, and its recipient filter differs from the backup. A restore never changes the recipient filter of a scope an app role assignment uses, because a different filter from a changed backup could let that app read other mailboxes: compare the filter with the backup, then change it by hand in Exchange Online PowerShell (Set-ManagementScope) if needed.","completion":{"kind":"manual-setting","requirement":"exchangeAppScopeFilter","fields":["customAttributes"],"description":"<same text>"}}}`.
     Five runs gave the same shape, with "used by" 2, 2, 5, 1, 5. Writes: 0.
  3. Same, but without `live.payload` (the guard reads L itself first): `skipped` with the same reason and completion. Five runs, "used by" 5, 7, 5, 3, 3. Writes: 0.
  - **Findings (#467):**
    - When a read misses all of L's rows, `using === 0`, and the broader filter would be written (fail open).
    - The count is rows, not unique ids, so it can be overstated (7 against 3).
  - Step 4: Q123 has not run.
- **Read-only. Nothing is written to the tenant.** Restorer credentials, test tenant only. Never change the existing scope that limits
  the mail fixture app, never create or change an app role assignment.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`):
  1. Read the live scope that limits the mail fixture app (call it L) and the Exchange app role assignments. Report how many
     assignments name L (expected at least 1) and confirm `appScopeId` on them equals L's `id` exactly (same form, no prefix).
  2. In a one-off node script, call `applyIdentityObjectWrite(writer, resource, 'update', { mode: 'dry-run' })` from
     `engine/restore/identityObjectOperations.mjs` with a writer whose `read` is your Graph read client and whose `write` throws
     (so any write fails loudly), and `resource = { naturalKey: L.id, resourceType: 'exchangeCustomAppScope', references: [],
     payload: { ...L, customAttributes: { ...L.customAttributes, RecipientFilter: "PrimarySmtpAddress -like '*'" } },
     live: { state: 'present', targetId: L.id, payload: L } }`. Expect `skipped` with a reason starting
     `manual: This app access scope is used by N app role assignment`, and `write` never called.
  3. Same call with `payload: { ...L, displayName: L.displayName }` but `live.payload` omitted and the broader filter: expect the same
     skip (the guard reads L itself first).
  4. If Q123 runs at #456 or later, its step 4 also proves the other side: the unused `KEEL-RT-app-scope` filter update is written.
- **Report:** B; step 1 counts and the id check; the exact result objects of steps 2 and 3; confirmation that no write was attempted.

### Q126: Live backup and restore of imported ADMX files and BIOS configurations (restore gaps batch 11, after #457)
- Note (coordinator, 2026-10-22): **#466 is fixed** by PR #468 (master `7f7525d`). A restore now skips and logs an Intune type it does not touch that fails to read (501 NotSupported counts as not on the tenant; the vppToken and Managed Google Play `$select` fields are fixed). Deletes are refused while any type is unread. Re-run this item once `/opt/keel-live` is at `7f7525d` or later.
- Drafted by the "Restore batch 11" thread (2026-10-22). Code: PR #457. **Backup change:** `groupPolicyUploadedDefinitionFile` is now
  listed, then each file read on its own (`/beta/deviceManagement/groupPolicyUploadedDefinitionFiles/{id}`), so the backup holds the
  ADMX `content` and `groupPolicyUploadedLanguageFiles[].content`. New record writers, fixture-tested only, beta:
  - `groupPolicyUploadedDefinitionFile`: **create only** (POST fileName, defaultLanguageCode, content, language files: name, language,
    content). Then waits for `status` to leave `uploadInProgress`; `uploadFailed` fails the restore. A backup without content is refused.
  - `hardwareConfiguration`: **update only** (PATCH displayName, description, roleScopeTagIds, perDevicePasswordDisabled). A restore
    that would turn per-device BIOS passwords off is refused. The settings file is never read or sent.
- Needs: /opt/keel-live at the #457 merge or later (`grep -q admxUploadAfterWrite /opt/keel-live/engine/restore/intuneOperations.mjs`).
- Status: blocked
- Result: blocked (2026-10-22 07:03 UTC) on **#466**, not started. Needs are met at e1a811b, but every `keel-restore --snapshot-id ... --select` dry run stops in its current-state read on an unneeded Intune type (`deviceManagementExchangeConnector` 501 NotSupported; also `onPremisesConditionalAccessSettings` 501 and the vppToken and androidManagedStoreAccountEnterpriseSettings `$select` 400s), before planning. Seen in Q109. Nothing written for this item; I will start it once #466 is fixed and deployed.
- **Test tenant only.** Same hard rules, capture tooling and requester/approver split as Q67. Under the 2026-10-14 standing
  authorization, approve these restores yourself and log every approval id. Restorer only; global admin not used. The Restorer
  needs DeviceManagementConfiguration.ReadWrite.All. If Graph answers 403, report blocked with what Graph names; grant nothing.
  Never touch CA policies, break-glass or Marouane's account. **Never assign either fixture, never use the ADMX file in a template,
  and never import a real vendor ADMX.** No tenant-wide setting is changed.
- **Fixtures** (the reviewed guidance in `live-gate-plan.mjs` at B says the same; nothing applies them):
  - imported ADMX file `keel-rt-148-fixture.admx` with ADML `keel-rt-148-fixture.adml` (en-US), exactly these two files:
    ```xml
    <?xml version="1.0" encoding="utf-8"?>
    <policyDefinitions revision="1.0" schemaVersion="1.0">
      <policyNamespaces><target prefix="keelrt" namespace="KEEL.RT.Fixture" /></policyNamespaces>
      <resources minRequiredRevision="1.0" />
      <categories><category name="KeelRtFixture" displayName="$(string.KeelRtFixture)" /></categories>
      <policies>
        <policy name="KeelRtFixtureFlag" class="Machine" displayName="$(string.KeelRtFixtureFlag)" explainText="$(string.KeelRtFixtureFlag_Help)" key="Software\Policies\KEEL-RT\Fixture" valueName="Flag">
          <parentCategory ref="KeelRtFixture" /><supportedOn ref="windows:SUPPORTED_Windows_10_0" />
          <enabledValue><decimal value="1" /></enabledValue><disabledValue><decimal value="0" /></disabledValue>
        </policy>
      </policies>
    </policyDefinitions>
    ```
    ```xml
    <?xml version="1.0" encoding="utf-8"?>
    <policyDefinitionResources revision="1.0" schemaVersion="1.0">
      <displayName>KEEL-RT fixture</displayName><description>KEEL-RT fixture</description>
      <resources><stringTable>
        <string id="KeelRtFixture">KEEL-RT fixture</string>
        <string id="KeelRtFixtureFlag">KEEL-RT fixture flag</string>
        <string id="KeelRtFixtureFlag_Help">Fixture only. Sets nothing on any device unless assigned, and it is never assigned.</string>
      </stringTable></resources>
    </policyDefinitionResources>
    ```
    If Intune refuses it because `windows:SUPPORTED_Windows_10_0` needs windows.admx, drop the `supportedOn` line and report that.
  - BIOS configuration `KEEL-RT-148-bios` (per-device password on), assigned to nobody. If Intune refuses to create it without a real
    OEM settings file, report the exact message and skip this kind; do not upload a real BIOS file.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. `node tools/qualification/live-gate-plan.mjs > ~/keel-rg11/plan-B.md`. Use its steps for these two types (collect, restore
     dry run, approve, `--enforce`, `entraLive.mjs capture`, promote).
  2. Create the fixtures, wait until the ADMX file shows `available`, then take snapshot S. **Backup check:** both fixtures are in S;
     report each type's read outcome, and whether the ADMX record in S has non-empty `content` and a language file with `content`
     (this is the unmeasured per-file read: if `content` is missing, stop and report; the restore would refuse it).
  3. **Create round (ADMX):** delete the ADMX file, restore from S selecting `groupPolicyUploadedDefinitionFile`, approve, enforce,
     capture the `create`. Report the status it reads back with and the restore result (applied / completion `admxUploadProcessing`).
  4. **Update round (BIOS):** change the BIOS configuration's description to `drift`. Restore from S, approve, enforce, capture the
     `update`. Expect the description back. Report the exact Graph answer for any refused POST or PATCH (all routes are unmeasured).
  5. **Re-run check:** dry run from S after step 4. Expect 0 planned writes for the BIOS configuration. For the ADMX file, report what
     is planned: it is keyed by id and the re-upload has a new id, so a planned create here is a known gap to report, not to run.
     If B includes #458 (`grep -q admxNotImported /opt/keel-live/engine/restore/intuneOperations.mjs`), expect the ADMX file to be
     skipped with `already imported: Intune holds an ADMX file named ...` instead; report which one you saw.
  6. Cleanup: delete both fixtures. Report anything left.
  7. Commit the records and `.capture.json` files under `docs/release/qualifications/entra-live/` on
     `claude/live-evidence-restore-gaps-11`, branched from `origin/master` (secret scan and `pseudonymize.mjs check` first). No PR.
     Run `node tools/qualification/operations.mjs --live-evidence <that directory>` and report the `live evidence` lines.
- **Report:** B; the step 2 backup check; per type and operation: promoted / refused (exact message) / skipped (fixture could not be
  created) / blocked; step 5; approval ids; the evidence branch and commit; anything left in the tenant.

### Q127: Live backup and restore of Windows app protection policies and iOS app provisioning profiles (restore gaps batch 12, after #458)
- Note (coordinator, 2026-10-22): **#466 is fixed** by PR #468 (master `7f7525d`). A restore now skips and logs an Intune type it does not touch that fails to read (501 NotSupported counts as not on the tenant; the vppToken and Managed Google Play `$select` fields are fixed). Deletes are refused while any type is unread. Re-run this item once `/opt/keel-live` is at `7f7525d` or later.
- Drafted by the "Restore batch 12" thread (2026-10-22). Code: PR #458. **Backup change:** both kinds are now listed, then each object
  read on its own: `windowsManagedAppProtection` at `/beta/deviceAppManagement/windowsManagedAppProtections/{id}?$expand=apps` (so the
  backup holds the apps it covers), `iosLobAppProvisioningConfiguration` at `/beta/deviceAppManagement/iosLobAppProvisioningConfigurations/{id}`
  (so it holds the profile file `payload`). New record writers, fixture-tested only, beta:
  - `windowsManagedAppProtection`: create + update (POST/PATCH the policy, then POST `.../{id}/targetApps` with the apps when they differ;
    read back). Assignments not written. A new or higher wipe version, or an action that becomes `wipe`, is a content effect (approve it).
  - `iosLobAppProvisioningConfiguration`: create + update of displayName, description, roleScopeTagIds, payload, payloadFileName,
    expirationDateTime. An expired file, or one that expires before the live one, is refused. Assignments not written.
  - Also in #458: an ADMX upload is skipped when Intune already holds a file with the same file name (see Q126 step 5).
- Needs: /opt/keel-live at the #458 merge or later (`grep -q admxNotImported /opt/keel-live/engine/restore/intuneOperations.mjs`).
- Status: blocked
- Result: blocked (2026-10-22 07:03 UTC) on **#466**, not started. Needs are met at e1a811b, but every `keel-restore --snapshot-id ... --select` dry run stops in its current-state read on an unneeded Intune type (`deviceManagementExchangeConnector` 501 NotSupported; also `onPremisesConditionalAccessSettings` 501 and the vppToken and androidManagedStoreAccountEnterpriseSettings `$select` 400s), before planning. Seen in Q109. Nothing written for this item; I will start it once #466 is fixed and deployed.
- **Test tenant only.** Same hard rules, capture tooling and requester/approver split as Q67. Under the 2026-10-14 standing
  authorization, approve these restores yourself and log every approval id. Restorer only; global admin not used. The Restorer
  needs DeviceManagementApps.ReadWrite.All. If Graph answers 403, report blocked with what Graph names; grant nothing.
  Never touch CA policies, break-glass or Marouane's account. **Never assign either fixture.** No tenant-wide setting is changed.
- **Fixtures** (the reviewed guidance in `live-gate-plan.mjs` at B says the same; nothing applies them):
  - Windows app protection policy `KEEL-RT-149-win-mam` covering Microsoft Edge (`windowsAppIdentifier` `com.microsoft.edge`),
    printing blocked, no wipe version and no wipe action, assigned to nobody. If the tenant cannot create Windows app protection
    policies, report the exact message and skip this kind.
  - iOS app provisioning profile `KEEL-RT-149-ios-prov` with a test `.mobileprovision` file, assigned to nobody. If Intune refuses a
    file that Apple did not sign, report the exact message and skip this kind; never upload a real company profile.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. `node tools/qualification/live-gate-plan.mjs > ~/keel-rg12/plan-B.md`. Use its steps for these two types (collect, restore
     dry run, approve, `--enforce`, `entraLive.mjs capture`, promote).
  2. Create the fixtures, then take snapshot S. **Backup check:** both fixtures are in S; report each type's read outcome, whether the
     Windows policy in S has `apps` with Edge, and whether the profile in S has a non-empty `payload` (the unmeasured per-object reads:
     if either is missing, stop and report; the restore would refuse the create).
  3. **Create round:** delete both fixtures, restore from S selecting both types, approve, enforce, capture both `create`s. Expect the
     Windows policy back with Edge as its app, and the profile back with the same file.
  4. **Update round:** turn printing back on for the Windows policy and change the profile's description to `drift`. Restore from S,
     approve, enforce, capture both `update`s. Expect both back. Report the exact Graph answer for any refused write (all routes unmeasured).
  5. **Re-run check:** dry run from S after step 4. Expect 0 planned writes for both.
  6. Cleanup: delete both fixtures. Report anything left.
  7. Commit the records and `.capture.json` files under `docs/release/qualifications/entra-live/` on
     `claude/live-evidence-restore-gaps-12`, branched from `origin/master` (secret scan and `pseudonymize.mjs check` first). No PR.
     Run `node tools/qualification/operations.mjs --live-evidence <that directory>` and report the `live evidence` lines.
- **Report:** B; the step 2 backup check; per type and operation: promoted / refused (exact message) / skipped (fixture could not be
  created) / blocked; step 5; approval ids; the evidence branch and commit; anything left in the tenant.

### Q128: Live backup and restore of app dependencies, and the apps app protection policies cover (restore gaps batch 13, after #459)
- Note (coordinator, 2026-10-22): **#466 is fixed** by PR #468 (master `7f7525d`). A restore now skips and logs an Intune type it does not touch that fails to read (501 NotSupported counts as not on the tenant; the vppToken and Managed Google Play `$select` fields are fixed). Deletes are refused while any type is unread. Re-run this item once `/opt/keel-live` is at `7f7525d` or later.
- Drafted by the "Restore batch 13" thread (2026-10-22). Code: PR #459. **Backup change:** `managedAppPolicy` (iOS and Android
  app protection) and `targetedManagedAppConfiguration` now read the apps each policy covers, one read per policy:
  `/v1.0/deviceAppManagement/{iosManagedAppProtections|androidManagedAppProtections|targetedManagedAppConfigurations}/{id}/apps`.
  A failed apps read fails the whole kind (so watch the first backup after deploy). New record writer, fixture-tested only, beta:
  - `mobileAppRelationship`: create (POST `/beta/deviceAppManagement/mobileAppRelationships` with `@odata.type`, sourceId, targetId,
    targetType, dependencyType or supersedenceType) + update (PATCH `.../{id}`, dependencyType / supersedenceType only). Preflight reads
    both apps and `/beta/deviceAppManagement/mobileApps/{sourceId}/relationships`; a link already there to the same target is skipped.
    A supersedence set to `replace` is a content effect (never use one here).
- Needs: /opt/keel-live at the #459 merge or later (`grep -q appRelationshipPreflight /opt/keel-live/engine/restore/intuneOperations.mjs`).
- Status: blocked
- Result: blocked (2026-10-22 07:03 UTC) on **#466**, not started. Needs are met at e1a811b, but every `keel-restore --snapshot-id ... --select` dry run stops in its current-state read on an unneeded Intune type (`deviceManagementExchangeConnector` 501 NotSupported; also `onPremisesConditionalAccessSettings` 501 and the vppToken and androidManagedStoreAccountEnterpriseSettings `$select` 400s), before planning. Seen in Q109. Nothing written for this item; I will start it once #466 is fixed and deployed.
- **Test tenant only.** Same hard rules, capture tooling and requester/approver split as Q67. Under the 2026-10-14 standing
  authorization, approve these restores yourself and log every approval id. Restorer only; global admin not used. The Restorer
  needs DeviceManagementApps.ReadWrite.All. If Graph answers 403, report blocked with what Graph names; grant nothing.
  Never touch CA policies, break-glass or Marouane's account. **Never assign any fixture app or policy.** No tenant-wide setting is changed.
- **Fixtures** (the reviewed guidance in `live-gate-plan.mjs` at B says the same; nothing applies them):
  - Two web link apps `KEEL-RT-148-app-main` and `KEEL-RT-148-app-dep`, neither assigned, with `KEEL-RT-148-app-main` depending on
    `KEEL-RT-148-app-dep` (detect only). If Intune refuses a dependency on web link apps, use two unassigned test line-of-business
    apps, or report the exact message and skip this kind. Never a supersedence set to replace.
  - iOS app protection policy `KEEL-RT-148-ios-mam` protecting Microsoft Outlook (`com.microsoft.office.outlook`), PIN required,
    no wipe settings, assigned to nobody.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. `node tools/qualification/live-gate-plan.mjs > ~/keel-rg13/plan-B.md`. Use its steps for `mobileAppRelationship` and
     `managedAppPolicy` (collect, restore dry run, approve, `--enforce`, `entraLive.mjs capture`, promote).
  2. Create the fixtures, then take snapshot S. **Backup check:** report the read outcome of `managedAppPolicy`,
     `targetedManagedAppConfiguration` and `mobileAppRelationship`; whether `KEEL-RT-148-ios-mam` in S has `apps` with Outlook; and how
     many rows S holds for the fixture link and their `targetType` (child, parent or both). If `managedAppPolicy` failed to read, stop and report.
  3. **Create round:** remove the dependency (keep both apps) and delete `KEEL-RT-148-ios-mam`. Restore from S selecting both types,
     approve, enforce, capture both `create`s. Expect the dependency back (detect) and the policy back with Outlook as its app.
     If the backup holds a parent row too, expect it skipped as "already set".
  4. **Update round:** set the dependency to install automatically and turn the policy's PIN off. Restore from S, approve, enforce,
     capture both `update`s. Expect both back. Report the exact Graph answer for any refused write (the relationship routes are unmeasured).
  5. **Re-run check:** dry run from S after step 4. Expect 0 planned writes, or the link create skipped as "already set" (its id changes on recreate).
  6. Cleanup: delete the policy, the dependency and both apps. Report anything left.
  7. Commit the records and `.capture.json` files under `docs/release/qualifications/entra-live/` on
     `claude/live-evidence-restore-gaps-13`, branched from `origin/master` (secret scan and `pseudonymize.mjs check` first). No PR.
     Run `node tools/qualification/operations.mjs --live-evidence <that directory>` and report the `live evidence` lines.
- **Report:** B; the step 2 backup check; per type and operation: promoted / refused (exact message) / skipped (fixture could not be
  created) / blocked; step 5; approval ids; the evidence branch and commit; anything left in the tenant.

### Q129: Live restore of who scripts, remediations, administrative templates and update profiles are assigned to (restore gaps batch 14, after #460)
- Requeued by the coordinator (2026-10-22 09:40 UTC): **#471 is fixed** by PR #475 (master `56d9682`): every script writer declares `DeviceManagementScripts.ReadWrite.All`, and a 403 names the missing grant. Marouane has added `DeviceManagementScripts.ReadWrite.All` (Application) to the Restorer and granted admin consent (2026-10-22). Run once `/opt/keel-live` is at `56d9682` or later (`grep -q SCRIPT_WRITE_PERMISSION /opt/keel-live/engine/restore/intuneOperations.mjs`); that build also has the #466 fix (#468). The script parts (PowerShell script, remediation, and the optional macOS shell and custom compliance scripts) need this grant; the other kinds were blocked only on #466, which is fixed.
  - **Step 0, before any fixture (read only; prints role names only, never the token):** get a fresh Restorer token and check its `roles` claim:
    `cd /opt/keel-live && node --input-type=module -e "import { getToken } from './tools/tenant-probe/auth.mjs'; import { readFileSync } from 'node:fs'; const c = JSON.parse(readFileSync('/etc/keel/restorer.json','utf8')); const t = (await getToken(c)).accessToken; console.log(JSON.parse(Buffer.from(t.split('.')[1], 'base64url')).roles.sort().join('\n'))"`
    - If the list includes `DeviceManagementScripts.ReadWrite.All`: log the list in Result and run the item. The "no permission to add" / "Restorer holds DeviceManagementConfiguration" wording below is superseded for script kinds.
    - If it does not: create nothing, set `Status: blocked`, and report in Result that admin consent for `DeviceManagementScripts.ReadWrite.All` appears not applied, with the roles listed. Grant nothing.
- Note (coordinator, 2026-10-22): **#466 is fixed** by PR #468 (master `7f7525d`). A restore now skips and logs an Intune type it does not touch that fails to read (501 NotSupported counts as not on the tenant; the vppToken and Managed Google Play `$select` fields are fixed). Deletes are refused while any type is unread. Re-run this item once `/opt/keel-live` is at `7f7525d` or later.
- Drafted by the "Restore batch 14" thread (2026-10-22). Code: PR #460. No backup change (assignments were already backed up).
  A restore that picks these kinds now writes their assignments back through `/assign` (beta), fixture-tested only:
  - `deviceManagementScript`, `deviceShellScript`: body `{ deviceManagementScriptAssignments: [...] }`.
  - `deviceHealthScript`, `deviceComplianceScript`: body `{ deviceHealthScriptAssignments: [...] }`; a remediation also sends
    `runSchedule` and `runRemediationScript` from the backup, and a drifted schedule is a change.
  - `groupPolicyConfiguration` (after its settings), `windowsFeatureUpdateProfile`, `windowsQualityUpdateProfile`,
    `windowsDriverUpdateProfile`, `intuneBrandingProfile`: body `{ assignments: [...] }`.
  - Also fixed: app protection, managed app configuration and device app configuration assignments were never attached by
    `keel-restore` (only the three built-in policy kinds were), so they were never written. They are now.
  - A policy whose only change is its assignments is planned as an `update`; the object itself is not patched.
- Needs: /opt/keel-live at the #460 merge or later (`grep -q SCRIPT_ASSIGNMENTS /opt/keel-live/engine/restore/intuneOperations.mjs`).
- Status: todo
- Result: blocked (2026-10-22 07:03 UTC) on **#466**, not started. Needs are met at e1a811b, but every `keel-restore --snapshot-id ... --select` dry run stops in its current-state read on an unneeded Intune type (`deviceManagementExchangeConnector` 501 NotSupported; also `onPremisesConditionalAccessSettings` 501 and the vppToken and androidManagedStoreAccountEnterpriseSettings `$select` 400s), before planning. Seen in Q109. Nothing written for this item; I will start it once #466 is fixed and deployed.
- **Test tenant only.** Same hard rules, capture tooling and requester/approver split as Q67. Under the 2026-10-14 standing
  authorization, approve these restores yourself and log every approval id. Restorer only; global admin not used. The Restorer
  needs DeviceManagementConfiguration.ReadWrite.All and DeviceManagementServiceConfig.ReadWrite.All. If Graph answers 403, report
  blocked with what Graph names; grant nothing. Never touch CA policies, break-glass or Marouane's account. No tenant-wide setting is changed.
  **Assign fixtures only to the empty group below: never to All devices, All users or any group with members.**
- **Fixtures:**
  - Security group `KEEL-RT-149-assign` with **no members** (so nothing runs or applies anywhere), and a second empty group `KEEL-RT-149-assign-b`.
  - PowerShell script `KEEL-RT-149-script` (body `Write-Output 'KEEL-RT'`), assigned to `KEEL-RT-149-assign`.
  - Remediation `KEEL-RT-149-remediation` (detection and fix both `exit 0`), assigned to `KEEL-RT-149-assign`, daily at 01:00, fix runs.
  - Administrative template `KEEL-RT-149-admx` with one built-in setting turned on (Edge home page `https://example.com`), assigned to `KEEL-RT-149-assign`.
  - Windows feature update profile `KEEL-RT-149-feature` (any supported version), assigned to `KEEL-RT-149-assign`.
  - Optional, if cheap: macOS shell script, custom compliance script, quality and driver update profiles, a non-default branding
    profile, all named `KEEL-RT-149-*` and assigned to `KEEL-RT-149-assign`. Report and skip any that Intune refuses.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. Create the fixtures, then take snapshot S. **Backup check:** for each fixture, the assignment read outcome in S and its target
     (group `KEEL-RT-149-assign`; for the remediation, the `runSchedule` and `runRemediationScript` held).
  2. **Assignment-only round:** in the portal, move each fixture's assignment from `KEEL-RT-149-assign` to `KEEL-RT-149-assign-b`,
     and change the remediation's schedule to 23:00. Restore from S selecting the fixtures' kinds. Expect the dry run to plan an
     `update` for each with "assignments differ", approve, enforce, capture each `update`. Expect every fixture assigned to
     `KEEL-RT-149-assign` only, and the remediation back at 01:00 with the fix on. Report the exact Graph answer for any refused
     `/assign` (the script and remediation bodies are unmeasured).
  3. **Create round:** delete `KEEL-RT-149-script` and `KEEL-RT-149-remediation`. Restore from S, approve, enforce, capture both
     `create`s. Expect both back with their bodies **and** assigned to `KEEL-RT-149-assign` (remediation schedule as in S).
  4. **Re-run check:** dry run from S after step 3. Expect 0 planned writes.
  5. Cleanup: delete every `KEEL-RT-149-*` fixture and both groups. Report anything left.
  6. Commit the records and `.capture.json` files under `docs/release/qualifications/entra-live/` on
     `claude/live-evidence-restore-gaps-14`, branched from `origin/master` (secret scan and `pseudonymize.mjs check` first). No PR.
     Run `node tools/qualification/operations.mjs --live-evidence <that directory>` and report the `live evidence` lines.
- **Report:** B; the step 1 backup check; per kind and round: assignments written / refused (exact message) / skipped (fixture could
  not be created) / blocked; step 4; approval ids; the evidence branch and commit; anything left in the tenant.

### Q130: Live restore of who compliance policies, Windows app protection, custom attribute scripts and Autopilot profiles are assigned to (restore gaps batch 15, after #462)
- Requeued by the coordinator (2026-10-22 09:40 UTC): **#471 is fixed** by PR #475 (master `56d9682`): every script writer declares `DeviceManagementScripts.ReadWrite.All`, and a 403 names the missing grant. Marouane has added `DeviceManagementScripts.ReadWrite.All` (Application) to the Restorer and granted admin consent (2026-10-22). Run once `/opt/keel-live` is at `56d9682` or later (`grep -q SCRIPT_WRITE_PERMISSION /opt/keel-live/engine/restore/intuneOperations.mjs`); that build also has the #466 fix (#468). The custom attribute script (`KEEL-RT-150-attr`) needs this grant; the other kinds were blocked only on #466, which is fixed.
  - **Step 0, before any fixture (read only; prints role names only, never the token):** get a fresh Restorer token and check its `roles` claim:
    `cd /opt/keel-live && node --input-type=module -e "import { getToken } from './tools/tenant-probe/auth.mjs'; import { readFileSync } from 'node:fs'; const c = JSON.parse(readFileSync('/etc/keel/restorer.json','utf8')); const t = (await getToken(c)).accessToken; console.log(JSON.parse(Buffer.from(t.split('.')[1], 'base64url')).roles.sort().join('\n'))"`
    - If the list includes `DeviceManagementScripts.ReadWrite.All`: log the list in Result and run the item. The "no permission to add" / "Restorer holds DeviceManagementConfiguration" wording below is superseded for script kinds.
    - If it does not: create nothing, set `Status: blocked`, and report in Result that admin consent for `DeviceManagementScripts.ReadWrite.All` appears not applied, with the roles listed. Grant nothing.
- Note (coordinator, 2026-10-22): **#466 is fixed** by PR #468 (master `7f7525d`). A restore now skips and logs an Intune type it does not touch that fails to read (501 NotSupported counts as not on the tenant; the vppToken and Managed Google Play `$select` fields are fixed). Deletes are refused while any type is unread. Re-run this item once `/opt/keel-live` is at `7f7525d` or later.
- Drafted by the "Restore batch 15" thread (2026-10-22). Code: PR #462. Fixture-tested only.
  - **Backup change:** assignments are now read per object (beta) for `deviceCustomAttributeShellScript`, `deviceManagementCompliancePolicy`
    (`/deviceManagement/compliancePolicies/{id}/assignments`) and `windowsManagedAppProtection`.
  - **Restore through `/assign` (beta):** custom attribute script `{ deviceManagementScriptAssignments: [...] }`; compliance v2
    `{ assignments: [deviceManagementConfigurationPolicyAssignment] }` after its actions for noncompliance; Windows app protection
    `{ assignments: [targetedManagedAppPolicyAssignment] }` after its apps.
  - **Autopilot profiles** (assignments already backed up): no `/assign` action, so each missing assignment is `POST .../assignments`
    and each extra one `DELETE .../assignments/{id}`, then read back.
  - A policy whose only change is its assignments is planned as an `update`; the object itself is not patched.
- Needs: /opt/keel-live at the #462 merge or later (`grep -q "assignmentWrite: 'per-item'" /opt/keel-live/engine/restore/intuneOperations.mjs`).
- Status: todo
- Result: blocked (2026-10-22 07:03 UTC) on **#466**, not started. Needs are met at e1a811b, but every `keel-restore --snapshot-id ... --select` dry run stops in its current-state read on an unneeded Intune type (`deviceManagementExchangeConnector` 501 NotSupported; also `onPremisesConditionalAccessSettings` 501 and the vppToken and androidManagedStoreAccountEnterpriseSettings `$select` 400s), before planning. Seen in Q109. Nothing written for this item; I will start it once #466 is fixed and deployed.
- **Test tenant only.** Same hard rules, capture tooling and requester/approver split as Q67. Under the 2026-10-14 standing
  authorization, approve these restores yourself and log every approval id. Restorer only; global admin not used. The Restorer
  needs DeviceManagementConfiguration.ReadWrite.All, DeviceManagementApps.ReadWrite.All and DeviceManagementServiceConfig.ReadWrite.All.
  If Graph answers 403, report blocked with what Graph names; grant nothing. Never touch CA policies, break-glass or Marouane's account.
  No tenant-wide setting is changed. **Assign fixtures only to the empty groups below: never to All devices, All users or any group with members.**
- **Fixtures:**
  - Security groups `KEEL-RT-150-assign` and `KEEL-RT-150-assign-b`, both with **no members**.
  - Settings catalog compliance policy `KEEL-RT-150-compliance` (any platform, one setting, default "mark noncompliant" action), assigned to `KEEL-RT-150-assign`.
  - Windows app protection policy `KEEL-RT-150-win-mam` (Edge), assigned to `KEEL-RT-150-assign`.
  - macOS custom attribute script `KEEL-RT-150-attr` (body `echo KEEL-RT`), assigned to `KEEL-RT-150-assign`.
  - Autopilot profile `KEEL-RT-150-autopilot` (Entra joined), assigned to `KEEL-RT-150-assign`.
  - Report and skip any fixture Intune refuses to create.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. Create the fixtures, then take snapshot S. **Backup check:** for each fixture, the assignment read outcome in S and its target
     (`KEEL-RT-150-assign`). For the first three kinds this read is new: report the exact Graph answer if it fails.
  2. **Assignment-only round:** in the portal, move each fixture's assignment to `KEEL-RT-150-assign-b`. Restore from S selecting the
     fixtures' kinds. Expect the dry run to plan an `update` with "assignments differ" for each, approve, enforce, capture each `update`.
     Expect every fixture assigned to `KEEL-RT-150-assign` only (Autopilot: one DELETE and one POST). Report the exact Graph answer for
     any refused write.
  3. **Create round:** delete `KEEL-RT-150-compliance` and `KEEL-RT-150-autopilot`. Restore from S, approve, enforce, capture both
     `create`s. Expect both back and assigned to `KEEL-RT-150-assign`.
  4. **Re-run check:** dry run from S after step 3. Expect 0 planned writes.
  5. Cleanup: delete every `KEEL-RT-150-*` fixture (unassign the Autopilot profile first) and both groups. Report anything left.
  6. Commit the records and `.capture.json` files under `docs/release/qualifications/entra-live/` on
     `claude/live-evidence-restore-gaps-15`, branched from `origin/master` (secret scan and `pseudonymize.mjs check` first). No PR.
     Run `node tools/qualification/operations.mjs --live-evidence <that directory>` and report the `live evidence` lines.
- **Report:** B; the step 1 backup check; per kind and round: assignments written / refused (exact message) / skipped (fixture could
  not be created) / blocked; step 4; approval ids; the evidence branch and commit; anything left in the tenant.

### Q131: Live restore of who policy sets and iOS app provisioning profiles are assigned to (restore gaps batch 16, after #463)
- Note (coordinator, 2026-10-22): **#466 is fixed** by PR #468 (master `7f7525d`). A restore now skips and logs an Intune type it does not touch that fails to read (501 NotSupported counts as not on the tenant; the vppToken and Managed Google Play `$select` fields are fixed). Deletes are refused while any type is unread. Re-run this item once `/opt/keel-live` is at `7f7525d` or later.
- Drafted by the "Restore batch 16" thread (2026-10-22). Code: PR #463. Fixture-tested only.
  - **Backup change:** assignments are now read per object (beta) for `policySet` (`/deviceAppManagement/policySets/{id}/assignments`)
    and `iosLobAppProvisioningConfiguration` (`/deviceAppManagement/iosLobAppProvisioningConfigurations/{id}/assignments`).
  - **Policy set:** no `/assign` action, so assignments go through `POST .../policySets/{id}/update` with
    `{ addedPolicySetItems: [], updatedPolicySetItems: [], deletedPolicySetItemIds: [], assignments: [policySetAssignment] }`, after the items step.
    The items step's own `/update` calls never send `assignments`.
  - **iOS app provisioning profile:** `POST .../{id}/assign` with `{ iOSLobAppProvisioningConfigAssignments: [iosLobAppProvisioningConfigurationAssignment] }`.
    The older `appProvisioningConfigurationGroupAssignments` list is not sent.
  - A set or profile whose only change is its assignments is planned as an `update`; the object itself is not patched.
  - Unmeasured: both assignment reads; whether `/update` accepts empty item lists plus `assignments`; whether an items-only `/update`
    (no `assignments` key) leaves assignments alone; whether `/assign` accepts the iOS list without the group list.
- Needs: /opt/keel-live at the #463 merge or later (`grep -q "assignmentAction: 'update'" /opt/keel-live/engine/restore/intuneOperations.mjs`).
- Status: blocked
- Result: blocked (2026-10-22 07:03 UTC) on **#466**, not started. Needs are met at e1a811b, but every `keel-restore --snapshot-id ... --select` dry run stops in its current-state read on an unneeded Intune type (`deviceManagementExchangeConnector` 501 NotSupported; also `onPremisesConditionalAccessSettings` 501 and the vppToken and androidManagedStoreAccountEnterpriseSettings `$select` 400s), before planning. Seen in Q109. Nothing written for this item; I will start it once #466 is fixed and deployed.
- **Test tenant only.** Same hard rules, capture tooling and requester/approver split as Q67. Under the 2026-10-14 standing
  authorization, approve these restores yourself and log every approval id. Restorer only; global admin not used. The Restorer
  needs DeviceManagementApps.ReadWrite.All and DeviceManagementConfiguration.ReadWrite.All.
  If Graph answers 403, report blocked with what Graph names; grant nothing. Never touch CA policies, break-glass or Marouane's account.
  No tenant-wide setting is changed. **Assign fixtures only to the empty groups below: never to All devices, All users or any group with members.**
- **Fixtures:**
  - Security groups `KEEL-RT-151-assign` and `KEEL-RT-151-assign-b`, both with **no members**.
  - Device configuration profile `KEEL-RT-151-cfg` (any platform, one harmless setting, unassigned), the item of the set.
  - Policy set `KEEL-RT-151-set` holding `KEEL-RT-151-cfg`, assigned to `KEEL-RT-151-assign`.
  - iOS app provisioning profile `KEEL-RT-151-ios-prov` (same test `.mobileprovision` approach as Q127), assigned to `KEEL-RT-151-assign`.
  - Report and skip any fixture Intune refuses to create (an iOS profile needs a valid Apple file).
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. Create the fixtures, then take snapshot S. **Backup check:** for each fixture, the assignment read outcome in S and its target
     (`KEEL-RT-151-assign`). Both reads are new: report the exact Graph answer if one fails.
  2. **Assignment-only round:** in the portal, move each fixture's assignment to `KEEL-RT-151-assign-b`. Restore from S selecting
     `policySet` and `iosLobAppProvisioningConfiguration`. Expect the dry run to plan an `update` with "assignments differ" for each,
     approve, enforce, capture each `update`. Expect both assigned to `KEEL-RT-151-assign` only, and the set still holding
     `KEEL-RT-151-cfg`. Report the exact Graph answer for any refused write.
  3. **Create round:** delete `KEEL-RT-151-set` (keep `KEEL-RT-151-cfg`). Restore from S, approve, enforce, capture the `create`.
     Expect the set back with its item and assigned to `KEEL-RT-151-assign`.
  4. **Re-run check:** dry run from S after step 3. Expect 0 planned writes.
  5. Cleanup: delete every `KEEL-RT-151-*` fixture (the set first) and both groups. Report anything left.
  6. Commit the records and `.capture.json` files under `docs/release/qualifications/entra-live/` on
     `claude/live-evidence-restore-gaps-16`, branched from `origin/master` (secret scan and `pseudonymize.mjs check` first). No PR.
     Run `node tools/qualification/operations.mjs --live-evidence <that directory>` and report the `live evidence` lines.
- **Report:** B; the step 1 backup check; per kind and round: assignments written / refused (exact message) / skipped (fixture could
  not be created) / blocked; whether the set's item survived step 2; step 4; approval ids; the evidence branch and commit; anything left in the tenant.

### Q132: Live check that a recreated or wider-assigned script needs the "Runs on devices" approval (issue #461, after #464)
- Requeued by the coordinator (2026-10-22 09:40 UTC): **#471 is fixed** by PR #475 (master `56d9682`): every script writer declares `DeviceManagementScripts.ReadWrite.All`, and a 403 names the missing grant. Marouane has added `DeviceManagementScripts.ReadWrite.All` (Application) to the Restorer and granted admin consent (2026-10-22). Run once `/opt/keel-live` is at `56d9682` or later (`grep -q SCRIPT_WRITE_PERMISSION /opt/keel-live/engine/restore/intuneOperations.mjs`); that build also has the #466 fix (#468). Both fixtures are scripts and need this grant; the #466 block is also fixed.
  - **Step 0, before any fixture (read only; prints role names only, never the token):** get a fresh Restorer token and check its `roles` claim:
    `cd /opt/keel-live && node --input-type=module -e "import { getToken } from './tools/tenant-probe/auth.mjs'; import { readFileSync } from 'node:fs'; const c = JSON.parse(readFileSync('/etc/keel/restorer.json','utf8')); const t = (await getToken(c)).accessToken; console.log(JSON.parse(Buffer.from(t.split('.')[1], 'base64url')).roles.sort().join('\n'))"`
    - If the list includes `DeviceManagementScripts.ReadWrite.All`: log the list in Result and run the item. The "no permission to add" / "Restorer holds DeviceManagementConfiguration" wording below is superseded for script kinds.
    - If it does not: create nothing, set `Status: blocked`, and report in Result that admin consent for `DeviceManagementScripts.ReadWrite.All` appears not applied, with the roles listed. Grant nothing.
- Drafted by the "Approve recreated assigned scripts" thread (2026-10-22). Code: PR #464. Fixture-tested only.
  - Since #460/#462 a restore assigns scripts and app policies. #464 makes the content-effect review judge that: the plan records
    who an assignment write newly reaches (`newAssignments`), and a device type judges its rules for those devices as if new.
  - A recreated script or remediation that the restore assigns now needs the separate `runs-on-devices` approval (showing the text),
    and so does an existing script assigned to more groups, or a remediation whose fix is turned on, even with the same text.
  - A schedule-only change, a fix turned off, or an added exclusion reaches no one new and needs no approval.
  - The review page shows "Newly assigned to ..." on each such effect.
- Needs: /opt/keel-live at the #464 merge or later (`grep -q newAssignmentReach /opt/keel-live/engine/restore/intuneOperations.mjs`).
- Status: todo
- Result: blocked (2026-10-22 07:45 UTC) on **#466**, not started (no fixtures created). The Needs are met at 1856809, but a snapshot dry run still stops in the current-state read (`collecting deviceManagementExchangeConnector failed`). I re-checked at 1856809 with the Q109 dry run at 07:45 UTC.
- **Test tenant only.** Same hard rules, capture tooling and requester/approver split as Q67. Under the 2026-10-14 standing
  authorization, approve these restores and content effects yourself and log every approval id. Restorer only; global admin not used.
  If Graph answers 403, report blocked with what Graph names; grant nothing. Never touch CA policies, break-glass or Marouane's account.
  No tenant-wide setting is changed. **Assign fixtures only to the empty groups below: never to All devices, All users or any group with members.**
- **Fixtures:**
  - Security groups `KEEL-RT-152-assign` and `KEEL-RT-152-assign-b`, both with **no members**.
  - PowerShell script `KEEL-RT-152-script` (body `Write-Output 'KEEL-RT'`), assigned to `KEEL-RT-152-assign`.
  - Remediation `KEEL-RT-152-remediation` (detection and fix both `exit 0`), assigned to `KEEL-RT-152-assign`, daily at 01:00, fix runs.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. Create the fixtures, then take snapshot S.
  2. **Create round:** delete `KEEL-RT-152-script`. Dry run from S selecting `deviceManagementScript`. Expect one `runs-on-devices`
     effect on `scriptContent` with "Newly assigned to" naming `KEEL-RT-152-assign`. Try to promote with only the restore approval:
     expect `blocked-content-effect`. Approve the content effect (log the id), enforce, capture the `create`. Expect the script back with
     its text and assigned to `KEEL-RT-152-assign`.
  3. **Widening round:** add `KEEL-RT-152-assign-b` to the backup's picture by assigning the remediation to both groups, take snapshot S2,
     then remove `KEEL-RT-152-assign-b` from it in the portal. Dry run from S2 selecting `deviceHealthScript`. Expect an `update` with
     "assignments differ" and `runs-on-devices` effects (same text) naming `KEEL-RT-152-assign-b`. Approve both approvals, enforce,
     capture. Expect both groups assigned.
  4. **No-approval round:** change only the remediation's schedule to 23:00 in the portal. Dry run from S2. Expect an `update` with
     "assignments differ" and **no** content effect. Enforce with only the restore approval, capture. Expect 01:00 back.
  5. **Re-run check:** dry run from S2. Expect 0 planned writes and no content effect.
  6. Cleanup: delete every `KEEL-RT-152-*` fixture and both groups. Report anything left.
  7. Commit the records and `.capture.json` files under `docs/release/qualifications/entra-live/` on
     `claude/live-evidence-assigned-scripts`, branched from `origin/master` (secret scan and `pseudonymize.mjs check` first). No PR.
     Run `node tools/qualification/operations.mjs --live-evidence <that directory>` and report the `live evidence` lines.
- **Report:** B; per round: the effects listed (effect, field, newly assigned to), whether promotion was blocked before the content
  approval, what was written; step 5; approval ids; the evidence branch and commit; anything left in the tenant.
- Note for Q129 and Q130: on a build with #464, their create rounds (script, remediation, custom attribute script) and their
  assignment-only rounds that move a script to a group it is not on now also list a `runs-on-devices` effect. Approve it too and log the id.

### Q133: Live restore of Intune and SharePoint tenant-wide settings (restore gaps batch 17, after #465)
- Drafted by the "Restore tenant-wide setting kinds" thread (2026-10-22). Code: PR #465. Fixture-tested only.
  - **Marouane approved tenant-wide setting changes for this proof on 2026-10-22 ("Ok for tenant wide", project thread).**
    Each value below is drifted, restored, and then **set back to its original value right after its round**, whatever the outcome.
  - Kinds, all update in place only: `deviceManagementSettings` (beta `PATCH /deviceManagement`, only `settings` and
    `managedDeviceCleanupSettings`), `microsoftTunnelHealthThreshold` (beta, two limits), `onPremisesConditionalAccessSettings`
    (v1.0, never turned on), `intuneBrandingProfile` default profile (beta, now updated in place), `sharepointSettings`
    (v1.0, every setting except the five sharing fields).
  - Guards (skipped as manual, nothing written): secureByDefault turned off; device cleanup started or shortened; Exchange
    on-premises access turned on; default branding created or swapped; SharePoint legacy auth on, unmanaged sync allowed, or
    guest account match dropped.
  - Unmeasured: every PATCH above and its read-back (the `/deviceManagement` read uses `$select=id,settings,managedDeviceCleanupSettings`).
- Needs: /opt/keel-live at the #465 merge or later (`grep -q onPremisesAccessRefusal /opt/keel-live/engine/restore/intuneOperations.mjs`).
- Status: blocked
- Result: blocked (2026-10-22 07:45 UTC), not started; nothing drifted.
  - **#466:** the restore from S cannot plan at 1856809 (current-state read fails on deviceManagementExchangeConnector).
  - **#447:** `deviceManagementSettings` still answers 400 to the collector (`/StatelessOnboardingService/deviceManagement`), so step 1 cannot back it up.
  - **Approval:** this item changes tenant-wide settings. Marouane told keel-operator to hold tenant-wide items (Q110, Q111) until he approves them directly, so Q133 waits for the same go.
- **Test tenant only.** Same hard rules, capture tooling and requester/approver split as Q67. Under the 2026-10-14 standing
  authorization, approve these restores yourself and log every approval id. Restorer only; global admin not used. The Restorer
  needs DeviceManagementConfiguration.ReadWrite.All, DeviceManagementServiceConfig.ReadWrite.All and SharePointTenantSettings.ReadWrite.All.
  If Graph answers 403, report blocked with what Graph names; grant nothing. Never touch CA policies, break-glass or Marouane's account.
  **Never** set `secureByDefault`, the device cleanup window, Exchange on-premises `enabled`, SharePoint legacy auth, unmanaged sync
  or any SharePoint sharing field. Capture each with `--allow-tenant-setting`.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set.
  Before step 1, write down the original value of every field you will drift (report them).
  1. Take snapshot S. **Backup check:** each of the five kinds is in S (default branding profile included).
  2. Drift, one value each:
     - `deviceManagementSettings`: `settings.deviceComplianceCheckinThresholdDays` by a few days (e.g. 30 to 25).
     - `microsoftTunnelHealthThreshold`: one limit's `healthyThreshold` by a few points (skip and report if Graph lists none).
     - `onPremisesConditionalAccessSettings`: `overrideDefaultRule` to the other value, `enabled` stays false.
     - Default Company Portal branding profile: `contactITName` to `KEEL-RT-153-drift`.
     - `sharepointSettings`: `isLoopEnabled` to the other value.
  3. Restore from S selecting those five kinds. Expect the dry run to plan one `update` per kind with only the drifted field;
     approve, enforce, capture each `update`. Expect each to read back at its step 1 value. Report the exact Graph answer for any refused write.
  4. **Re-run check:** dry run from S. Expect 0 planned writes.
  5. **Set back:** confirm every drifted field is at its original value (it should be after step 3; set it by hand if not). Report each.
  6. Commit the records and `.capture.json` files under `docs/release/qualifications/entra-live/` on
     `claude/live-evidence-restore-gaps-17`, branched from `origin/master` (secret scan and `pseudonymize.mjs check` first). No PR.
     Run `node tools/qualification/operations.mjs --live-evidence <that directory>` and report the `live evidence` lines.
- **Report:** B; the originals; per kind: written / refused (exact message) / skipped / blocked; step 4; step 5 values; approval ids;
  the evidence branch and commit.

### Q135: Live restore of a reusable settings group with its values (fixes #470, after #476)
- Drafted by the "Reusable policy settings backed up empty" thread (2026-10-22), from your Q109 finding **#470**. Code: PR #476 (master `471cb9b`). Fixture-tested only.
  - **Backup change:** `deviceManagementReusablePolicySetting` is now listed with
    `$select=id,displayName,description,settingDefinitionId,settingInstance,lastModifiedDateTime`, so each group holds its values.
  - **Restore change:** update is a full **PUT** (displayName, description, settingDefinitionId, settingInstance), never PATCH. Each
    write is re-read with the same `$select` (the single-item GET with `$select` is unmeasured).
  - **Refusals (skipped as manual, nothing written):** a backup without `settingInstance` (every snapshot before #476, e.g. S2 `ac991228`),
    with "manual: this backup holds the group's name but not its values"; an update whose setting definition differs from the tenant's.
  - Expect a one-time "changed" for each group on the first drift run after deploy, because older snapshots lack the values.
- Needs: /opt/keel-live at `471cb9b` or later (`grep -q reusableSettingRefusal /opt/keel-live/engine/restore/intuneOperations.mjs`).
- Status: done
- Result: done (2026-10-22 09:11 UTC). #476 fixes the backup and the PUT, but both writes fail their post-state check: Graph re-generates the group's `_id` child on every write (**#477**). Both are demoted. B = 471cb9b → 56d9682 (deploys during the run; captured at 56d9682). Restorer only; global admin not used; nothing granted.
  1. Fixture `KEEL-RT-155-addresses` (keyword, autoresolve false, 203.0.113.10), used by no policy. Snapshot S = `681596c1`: the payload holds `settingInstance` with 203.0.113.10 (**backup check passes**).
  2. Old-backup refusal: dry run `e7b5798d` from Q109's S2 `ac991228`: skipped, status `refused`, 0 writes. Reason: "manual: this backup holds the group's name but not
     its values (backups before the values were read), so it is not written; take a new backup, or set the values by hand in the Intune admin center". Not promoted.
  3. Update: drifted the description to `drift` and the address to 203.0.113.20 (PUT 204). Dry run `a72fa6da` (fields description, settingInstance), approval **65ccb575**,
     job `01e7cdda`: the PUT ran and the tenant read back the description "KEEL restore fixture" and 203.0.113.10. But the journal shows `uncertain`, "post-state: settingInstance did not read back
     as written". The only difference is the `..._{id}_id` GUID (backup `{aee3fd94-…}`, live `{35c6b7f6-…}`). Capture exit 3, then **demoted**.
  4. Create: deleted the group. Dry run `2b0a36ae`, approval **47abfca3**, job `5b8b125a`: created with its description and 203.0.113.10, then the same `uncertain` post-state. **Demoted.**
  5. Re-run: dry run `80180fb5` from S plans **another create** (no targetId), not 0 writes. It looks as if the uncertain create recorded no id mapping (inference). Not enforced (it would make a duplicate).
  6. Cleanup: deleted the recreated group. No `KEEL-RT` reusable group is left. **Nothing left.**
  7. Evidence: `claude/live-evidence-reusable-settings` @ **aff2097** (update record, capture and demotion; create demotion). pseudonymize check exit 0; my scan is clean.
     `live evidence deviceManagementReusablePolicySetting.update.json: not applied (deviceManagementReusablePolicySetting.update.demotion.json demotes this write, so it is not promoted)`.
- **Test tenant only.** Same hard rules, capture tooling and requester/approver split as Q67 and Q109. Under the 2026-10-14 standing
  authorization, approve these restores yourself and log every approval id. Restorer only; global admin not used; it holds
  DeviceManagementConfiguration.ReadWrite.All. If Graph answers 403, report blocked with what Graph names; grant nothing.
  Never touch CA policies, break-glass or Marouane's account. The group is used by no policy.
- **Fixture:** firewall reusable settings group `KEEL-RT-155-addresses` (keyword, autoresolve false, one address 203.0.113.10),
  used by no policy, as in Q109.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. Create the fixture, then take snapshot S. **Backup check:** the fixture's payload in S holds `settingInstance` with the address.
  2. **Old-backup refusal (no write expected):** dry run from Q109's S2 `ac991228` selecting `deviceManagementReusablePolicySetting`
     (if S2 is gone, use any pre-B snapshot holding a group). Expect it skipped as manual with the text above, 0 writes. Do not promote.
  3. **Update round:** in the portal change the fixture's description **and** its address to 203.0.113.20. Restore from S, approve,
     enforce, capture the `update`. Expect a PUT (no PATCH), read back with the original description and 203.0.113.10.
  4. **Create round:** delete the fixture. Restore from S, approve, enforce, capture the `create`. Expect it back with 203.0.113.10.
  5. **Re-run check:** dry run from S after step 4. Expect 0 planned writes for the group. If the post-state check fails although the
     values look equal (e.g. Graph returns an empty list as absent), report the read-back body.
  6. Cleanup: delete every `KEEL-RT-155-*` fixture. Report anything left.
  7. Commit the records and `.capture.json` files under `docs/release/qualifications/entra-live/` on
     `claude/live-evidence-reusable-settings`, branched from `origin/master` (secret scan and `pseudonymize.mjs check` first). No PR.
     Run `node tools/qualification/operations.mjs --live-evidence <that directory>` and report the `live evidence` lines.
- **Report:** B; step 1 backup check; step 2 reason; per operation: promoted / refused (exact Graph message) / blocked; step 5;
  approval ids; the evidence branch and commit; anything left in the tenant.

### Q139: Live update of an app category and an e-book category (fixes #474, after #479)
- Drafted by the "App category updates always refused" thread (2026-10-22), from your Q116 and Q122 finding **#474**. Code: PR #479 (merge df9295a). Fixture-tested only.
  - **Change:** the restore's current-state fingerprint now ignores `lastModifiedDateTime` for `mobileAppCategory` and `managedEBookCategory` only,
    because Graph returns it as the time of the read. Every other kind still counts it. Nothing else changed: same writers as Q116 and Q122.
- Needs: /opt/keel-live at df9295a or later (`grep -q READ_TIME_FIELDS /opt/keel-live/engine/restore/dryRunArtifact.mjs`).
- Status: todo
- Result:
- **Test tenant only.** Same hard rules, capture tooling and requester/approver split as Q116 and Q122. Under the 2026-10-14 standing
  authorization, approve these restores yourself and log every approval id. Restorer only; global admin not used; it holds
  DeviceManagementApps.ReadWrite.All. If Graph answers 403, report blocked with what Graph names; grant nothing.
  Never touch CA policies, break-glass or Marouane's account.
- **Fixtures:** app category `KEEL-RT-apps` (no app in it) and e-book category `KEEL-RT-books` (no book in it), as in Q116 and Q122.
- Do, at the deployed build B, from your own checkout (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. Create both fixtures, then take snapshot S (a run that reads both types). Confirm both are in S.
  2. **Fingerprint check (no write):** two dry runs from S selecting both types, a few seconds apart, with nothing changed. Expect the same
     current-state fingerprint (and 0 planned writes).
  3. **Update round:** rename them to `KEEL-RT-apps-drift` and `KEEL-RT-books-drift`. Restore from S selecting both, approve, enforce,
     capture each `update`. Expect no "the target has changed since the dry run" refusal, and read-back names `KEEL-RT-apps` / `KEEL-RT-books`.
  4. **Re-run check:** dry run from S after step 3. Expect 0 planned writes for both.
  5. Cleanup: delete every `KEEL-RT-apps*` and `KEEL-RT-books*` category. Report anything left.
  6. Commit the records and `.capture.json` files under `docs/release/qualifications/entra-live/` on
     `claude/live-evidence-category-update`, branched from `origin/master` (secret scan and `pseudonymize.mjs check` first). No PR.
     Run `node tools/qualification/operations.mjs --live-evidence <that directory>` and report the `live evidence` lines.
- **Report:** B; step 2 fingerprints; per operation: promoted / refused (exact message) / blocked; step 4; approval ids; the evidence
  branch and commit; anything left in the tenant.
