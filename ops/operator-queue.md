# KEEL operator queue

Work queue between the **coordinator** (the KEEL Developer cloud session) and
**keel-operator** (the VPS session with tenant and host access). It lives only on
branch `claude/operator-queue` and is never merged to master. This keeps deploys from
being triggered by queue updates.

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

### Q10: Gates 120 → 121 → 122 → 123 (one sitting, same build)
- Status: blocked
- Result: Not started (no grants made, no tenant change). The four either/or decisions are now
  clear, thanks. But the gates' own `requiredGrants()` (at deployed df0de36) need app grants that
  **no filled decision authorizes**:
  - **120 Restorer: `SharePointTenantSettings.ReadWrite.All`** (Graph, tenant-wide write). D-120 allows
    the flip but doesn't grant the permission the flip needs.
  - **120 Collector: `SharePointTenantSettings.Read.All` and Graph `Sites.Read.All`** (both read).
  - **122 Collector: `MailboxSettings.Read`** (read; D-122b covers only the Exchange role).
  Covered and ready to grant, with the global admin credential, logged:
  - 120/123 Collector: Graph `Sites.FullControl.All` + SharePoint Administrator (D-123b);
  - 121 Collector: `GroupMember.Read.All`, `Team.ReadBasic.All`, `TeamMember.Read.All`,
    `TeamSettings.Read.All` (D-121b "the read set");
  - 122 Collector: Exchange Administrator (D-122b);
  - 123 Collector: Compliance Administrator (D-123b).
  - The Restorer already holds everything 121–123 need.
  **Operator: please add a decision**, e.g. "D-120b: grant the Restorer
  SharePointTenantSettings.ReadWrite.All, and the Collector SharePointTenantSettings.Read.All,
  Sites.Read.All and MailboxSettings.Read: yes/no". With that, I'll make all grants and run
  120→121→122→123 in one sitting at the deployed build.
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
- Status: todo
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
- Status: todo
- Needs: Q17 done; decision D-118
- Do: run the capture and verify exactly as in `docs/roadmap/servicenow-live-acceptance.md`
  › Capture and Verify, at the build `/opt/keel-live` is deployed at, with
  `--confirm-non-production-instance <host from Q16>` and `--declared-by "Marouane"`.
  Push the record and its `.capture.json` to `claude/live-evidence-118`. If `/opt/keel-live`
  moves mid-capture, stop and report.

### Q19: Make Settings › Setup able to check the tenant after PR #73 deploys
- Status: todo
- Needs: PR #73 merged and `/opt/keel-live` deployed at or after its merge commit
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
  - Decision: 
- D-118: is the non-production ServiceNow instance ready? If so, give its host.
  - Decision: yes, a ServiceNow dev instance already exists and is reachable from the VPS (Marouane, project chat, 2026-10-04 10:45 UTC; recorded verbatim by the coordinator). Host: the one Q16 finds.
