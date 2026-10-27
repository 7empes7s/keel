# KEEL keelops queue

Work queue between the **coordinator** (the KEEL Developer cloud session) and
**keelops** (the VPS session running as the `keelops` user). It lives only on
branch `claude/keelops-queue` and is never merged to master. This keeps deploys from
being triggered by queue updates.

## Protocol

**Who writes what**
- The coordinator adds and edits items.
- keelops writes only each item's `Status` and `Result` fields.
- The **Operator decisions** section is written only by the human operator. No Claude
  session fills in or changes a decision.

**keelops, on each pass**
1. `git fetch origin claude/keelops-queue` and check out its tip.
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

### K1: Setup check: report the live build and health (read-only)
- Drafted by the "Mulinux Claude operator setup" thread (2026-10-25) to prove the queue wake-up end to end.
- Needs: nothing.
- Status: done
- Result: live build `fa37b06` (`git -c safe.directory=/opt/keel-live -C /opt/keel-live rev-parse --short HEAD`, exit 0); `/api/health` body `{"status":"ok"}`; `[keelops-queue]` message received 2026-10-25 ~13:56 UTC (13:56:21 at pass start). Read-only; nothing changed in the tenant or on the host. No evidence branch. Nothing blocking.
- Do: report `git -C /opt/keel-live rev-parse --short HEAD`, the body of `curl -s http://127.0.0.1:3600/api/health`, and the time you received the `[keelops-queue]` message. Change nothing.
- **Expected:** a short sha and `"status":"ok"`.

Note on K2–K5 (2026-10-27): moved from Q169, Q170, Q172 and Q174 on `claude/operator-queue`, which has had no pass since 2026-10-23. All four are read-only. If a step needs a file your user can't read, mark the item `blocked` and name the file.

**Approval for K2–K7 (2026-10-27 14:37 UTC):** Marouane asked in the project thread that the agents run these checks without him. That covers the read-only `SELECT`s written in K2–K7 against the live DB and the engine read calls they name; never change a row except where an item says so (K3's `enqueue` fallback, K6 restore, K7 own check). The `/etc/keel` read access is queued for keel-operator as Q175 on `claude/operator-queue`; retry K2 and K3 once `/etc/keel/db.env` is readable.

### K2: Live check that Intune tenant settings back up again (fixes #447, after #566 and #570)
- Drafted by the "Live checks for Oct 23–25 merges" thread (2026-10-27). #566 reads `deviceManagementSettings` one field per
  request (the mixed `$select` was routed to the onboarding backend and answered 400). #570 then dropped the retired
  `managedDeviceCleanupSettings` field (its window is backed up as `managedDeviceCleanupRule`), so only `settings` is read.
- Needs: /opt/keel-live at the #570 merge (4b4af63) or later (`grep -q selectEach /opt/keel-live/tools/tenant-probe/catalog.d/intune-leftovers.mjs`).
- Status: blocked
- Result: blocked on `/etc/keel/db.env` (2026-10-27 ~14:35 UTC). Needs check passes: live `e17b36c` has `selectEach`. But `/etc/keel` is `root:root 750` with no ACL for keelops, so db.env cannot be read (and the job rows and collect log behind it with it); ~/agent-src/ROOT-STEPS.md §1 (setfacl on /etc/keel + 8 files) has not been run by root yet. Nothing run, nothing changed in the tenant or on the host. Also for the operator: keelops CLAUDE.md says "read the live DB only through KEEL's own CLI ... never write hand-written SQL against live data"; steps 2-3 are hand-written SELECTs, so they need the operator's explicit OK (or a CLI equivalent) even after the grant.
- **Tenant:** Collector reads only (the normal hourly Tier 1 backup). Nothing is written.
- Do, from `/opt/keel-live` with `set -a; . /etc/keel/db.env; set +a`:
  1. Take the newest Tier 1 snapshot that started after the deploy (the hourly run; do not run the collector by hand unless none
     ran in the last 2 hours, and say which you used). Report its id, start time, outcome, and any `incomplete types` entry for
     `deviceManagementSettings` (from the job result or the collect log).
  2. ```sql
     WITH s AS (SELECT id FROM snapshot ORDER BY started_at DESC LIMIT 1)
     SELECT rv.resource_type, count(*) AS objects,
            bool_and(rv.payload ? 'settings') AS has_settings,
            bool_or(rv.payload ? 'managedDeviceCleanupSettings') AS has_cleanup,
            bool_or(rv.payload ? 'intuneBrand') AS has_brand
       FROM resource_version rv WHERE rv.snapshot_id = (SELECT id FROM s) AND rv.resource_type = 'deviceManagementSettings'
      GROUP BY 1;
     ```
     If the column names differ, report what you ran.
  3. Count the Tier 1 jobs since the deploy that still name `deviceManagementSettings` as failed or partial (expect 0), and
     report the newest snapshot's overall status: is it still "Partly done" for any other type? Name those types.
  4. **What the portal shows** (the page is behind Access, so read what it reads): run `buildCoverageReport` as in Q-items
     before (`engine/coverage/report.mjs`, with `CATALOG` and `DESCRIPTORS`) and report the `deviceManagementSettings` row:
     status, outcome, itemCount, lastCollectedAt, and any detail httpStatus/message. "Backed up" on the page = a complete outcome here.
  5. **Error rows for two other types** (the handover asks for them): for the newest Tier 2 job and the newest job that read Purview,
     report every `incompleteTypes` / failed-type entry with its reason, HTTP status and the request it names, for
     **Settings catalog policy** (`deviceManagementConfigurationPolicy` or the type the job names) and for every **Purview** type or
     workload (e.g. `purview-governance`, `purview-labels`, `purview-retention-dlp`, or Graph Purview kinds). Names masked; no fix, no grant.
- **Expected:** one `deviceManagementSettings` object with `settings`, no cleanup or brand field, no 400 and no "read only part
  of this type". If it still fails, quote the failing request and HTTP status from the job evidence (#570 now names it). Change nothing.
- **Report:** the outputs above and the build. If green, say so: the coordinator will close #447.

### K3: Live check that the content backup tells tenant conditions apart from read errors (after #564)
- Drafted by the "Live checks for Oct 23–25 merges" thread (2026-10-27). #564: a SharePoint site with no pages library (the search
  centre) is no longer a failed read on a 404; OneDrives Microsoft 365 has locked (HTTP 423) are skipped and listed in the new
  `content_run.skipped` column, not counted as errors; a refused group mailbox says "this mailbox only" only when another group
  mailbox read fine. Q167's run `85aeb04b` (before #564) had onedrive partial (10× 423), sharepoint-sites partial (search site 404),
  exchange-mail partial (1 group mailbox 403).
- Needs: /opt/keel-live at the #564 merge (9c59b96) or later (`grep -q skipped /opt/keel-live/engine/store/schema.d/73-content-run.sql`).
- Status: blocked
- Result: blocked on `/etc/keel/db.env` (2026-10-27 ~14:40 UTC). Needs check passes: live `e17b36c` has `skipped` in 73-content-run.sql. `/etc/keel` is `root:root 750`, so db.env is unreadable until root runs ~/agent-src/ROOT-STEPS.md §1; content_run, the job row and the worker line all sit behind it. Nothing run, nothing enqueued, nothing changed in the tenant or on the host. For the operator: steps 2 SQL is hand-written (keelops CLAUDE.md allows live-DB reads only through KEEL's CLI), and the step 1 fallback `enqueue` is a DB write; both need your explicit OK.
- **Tenant:** content reader reads only (the normal nightly content backup). No grants, no writes. A 403 is reported, never fixed by granting.
- Do, from `/opt/keel-live` with `set -a; . /etc/keel/db.env; set +a`:
  1. Use the newest scheduled `content-collect` that ran after the deploy (01:00 UTC). If none ran, queue the same read-only job
     through `enqueue` (kind content-collect, scheduler principal, an `operator:` key, as keel-operator did for Q167) and say which you used.
  2. Report:
     ```sql
     SELECT workload, outcome, items, jsonb_array_length(reasons) AS reasons, jsonb_array_length(skipped) AS skipped, completed_at
       FROM content_run WHERE completed_at > now() - interval '30 hours' ORDER BY completed_at DESC, workload;
     ```
     and, for the newest run, the reasons of every non-complete workload and the skipped entries (names masked, keep the HTTP code and the words).
  3. The job row and worker line as in Q167 step 2.
- **Expected:** onedrive `complete` (or partial only for a non-423 cause) with about 10 `skipped` entries saying locked; sharepoint-sites
  with no reason for the search site; exchange-mail still `partial` for the one group mailbox (that one is a tenant condition), with a
  reason that does not blame a missing app permission. If any expected point fails, quote the raw reason. Change nothing.
- **Report:** the outputs above (names masked) and the build.

### K4: Live check that keel-worker no longer puts the database password on the command line (after #571)
- Drafted by the "Live checks for Oct 23–25 merges" thread (2026-10-27). #571: the worker passed `--db-url postgres://user:password@…`
  to every job, visible in `ps`. It now sets `KEEL_DB_URL` in the child's environment.
- Needs: /opt/keel-live at the #571 merge (e17b36c) or later (`grep -q KEEL_DB_URL /opt/keel-live/cli/keel-worker.mjs`).
- Status: done
- Result: build `e17b36c` at start, `d040d6c` from 14:59:37 UTC (deploy mid-sample; both contain #571 `KEEL_DB_URL`). **Step 1:** `pgrep -c -f -- --db-url` sampled every ~2 s from 14:38:50 to 15:12:00 UTC 2026-10-27: 0 every sample (no args printed). That window covers the 15:00 Tier 1 `collect` (job 9e6b2398, 15:00:02-15:01:58, succeeded) and the 15:05 `drift-detect` (job 640a0095, succeeded; seen as 1 worker child at 15:05:08). The worker unit itself runs `node /opt/keel-live/cli/keel-worker.mjs` with no `--db-url`. Caveat: the sampler saw no worker child process during the 15:00 collect, so that job may run without a separate child; either way no process on the host had `--db-url`. **Step 2:** `/etc/keel/db.env` is unreadable (Q175), so the `job` SELECT was not run; from the keel-worker journal instead (2026-10-25 14:25:24 to 2026-10-27 15:12): 114 jobs, 0 failed. collect 52 succeeded, drift-detect 52 succeeded, backup 2, prune 2, api-drift 1, discover 1 succeeded; content-collect 1 succeeded + 1 partly (content:exchange-mail); workload-collect 2 partly (workload:purview-governance). Both partial kinds were already partial before the deploy (e.g. 2026-10-25 01:07 and 02:07), so there is no new failure kind. Nothing changed in the tenant or on the host. No evidence branch. The exact SQL table can be re-run once Q175 lands.
- **Tenant:** nothing. Host reads only.
- Do:
  1. While any worker job runs (the hourly Tier 1 collect is enough), run `ps -eo pid,args | grep -c -- '--db-url'` a few times and report the
     counts (expect 0; ignore the grep line itself). **Never print the args or the URL.**
  2. Report the job kinds and outcomes the worker finished since the deploy: `SELECT kind, status, count(*) FROM job WHERE finished_at > '<deploy time>' GROUP BY 1,2`.
     Expect no new failure kind that did not fail before the deploy; if one did, quote its error (redact any URL).
- **Report:** the counts, the table and the build.

### K5: Live check of the Ask page answers on the real data (after #568 and #569)
- Drafted by the "Live checks for Oct 23–25 merges" thread (2026-10-27). #569: more periods read (no period = this week with a note,
  "since the beginning of the month", 17/10, "3 days ago", "between X and Y" including Y), each change listed once per resource,
  windows open at the last backup that read that kind (users were zero-width), modified rows list the changed settings, up to 1,000 rows.
  #568: Microsoft cloud words, old names and concepts (AAD, MEM, CA policy, MFA, PIM, guests…), "who changed" and not-held topics answered
  in words instead of refused. The portal is behind Access from the box, so this runs the same engine call the page makes.
- Needs: /opt/keel-live at the #568 merge (6783d4d) or later (`test -f /opt/keel-live/engine/query/vocabulary.mjs`).
- Status: blocked
- Result: blocked on `/etc/keel/db.env` and `/etc/keel/tenant.json` (for tenantRef). `/etc/keel` is still `root:root 750` with no keelops ACL (checked 2026-10-27 ~15:15 UTC); root's access step is queued as Q175 on claude/operator-queue (~/agent-src/ROOT-STEPS.md §1). Live build `d040d6c`; Needs check passes. Nothing run, nothing changed in the tenant or on the host. Retry once the files are readable.
- **Tenant:** nothing. Read-only against Keel's own database.
- Do, from `/opt/keel-live` with `set -a; . /etc/keel/db.env; set +a`, with tenantRef = `sha256:` + the first 16 hex of sha256(tenant.json `tenantId`)
  (as `portal/lib/runtime-config.ts` does), scope `{central:true, entities:[]}`:
  ```js
  import pg from 'pg'; import { answerQuestion } from './engine/query/execute.mjs';
  const c = new pg.Client(process.env.KEEL_DB_URL); await c.connect();
  for (const question of QUESTIONS) {
    const a = await answerQuestion(c, { tenantRef, scope: { central: true, entities: [] }, question });
    const keys = a.records.map((r) => r.naturalKey ?? r.id);
    const zero = a.records.filter((r) => r.window?.from && r.window.from === r.window.to).length;
    console.log(JSON.stringify({ question, status: a.status, understood: a.understood, assumed: a.assumed, ignored: a.ignored,
      total: a.total, shown: a.shown, duplicates: keys.length - new Set(keys).size, zeroWidth: zero,
      modifiedWithoutFields: a.records.filter((r) => r.changeType === 'modified' && !(r.fields?.length)).length,
      gaps: a.gaps, sentence: a.sentence, refusal: a.refusal?.code ?? null }));
  }
  await c.end();
  ```
  (If the record field names for the window or changed settings differ, read them from `engine/query/execute.mjs` and say what you used.)
  QUESTIONS:
  `Which users have changed?` · `What changed since the beginning of the month?` · `What changed since 17/10?` · `What changed between Oct 20 and Oct 25?` ·
  `What changed 3 days ago?` · `What changed in the last 48 hours?` · `What changed in Azure AD this month?` · `What changed in Endpoint Manager last week?` ·
  `Which CA policies changed this month?` · `What MFA settings changed this month?` · `Which admins changed this month?` · `Who changed the Exchange transport rules?` ·
  `Show me the sign-in logs` · `What does the backup hold for Teams?` · `Which jobs failed this week?` · `How many groups are covered?`
- **Expected:** none refused except where the answer names why in words (sign-in logs: not backed up; "who": says what and when but not who).
  `duplicates` 0 and `zeroWidth` 0 on every answer; `modifiedWithoutFields` 0 or explained; `assumed` names the concept reading for MFA / admins / CA.
  For "Which users have changed?" report total and whether the 10 Oct mass change shows (with its settings).
- **Report:** the JSON lines verbatim (names masked) and the build. Portal visuals (sorting, Columns picker, folding) can't be checked from the box; say so.

### K6: Live check that an app requesting API permissions restores, and that replaced follow-up steps drop off (after #563 and #565)
- Drafted by the "Live checks for Oct 23–25 merges" thread (2026-10-27). #565: `permission:<appId>/role:X` and `object:<appId>`
  references (an app's `requiredResourceAccess`) now resolve, so restoring an app that asks for API permissions no longer throws
  `not-found-in-target`, and the preview no longer lists each permission as missing. #563: a pending follow-up step counts as
  replaced when a later restore of the same object opens the same step; `countOpenCompletionSteps` and the open-work list leave it out.
- Needs: /opt/keel-live at the #565 merge (576295e) or later (`grep -q app-id /opt/keel-live/engine/graph/resolver.mjs`).
- Approval: Marouane approved on 2026-10-27 (14:36 UTC, in the project thread) that keelops may run this item under the operator queue's test-tenant restore rules: self-approve, log each approval id, KEEL-RT- fixtures only.
- Status: blocked
- Result: blocked on `/etc/keel/db.env`, `/etc/keel/tenant.json` and `/etc/keel/restorer.json` (+ `keel-restorer.*`). No fixture created. `/etc/keel` is still `root:root 750` with no keelops ACL (checked 2026-10-27 ~15:15 UTC); root's access step is queued as Q175 on claude/operator-queue (~/agent-src/ROOT-STEPS.md §1). Live build `d040d6c`; Needs check passes. Nothing run, nothing changed in the tenant or on the host. Retry once the files are readable.
- **Tenant:** standing authorization (2026-10-14): self-approve and log the approval id. Restorer writes only the fixture below;
  Collector reads. **Never grant admin consent** and never add a secret or certificate to the fixture. No CA, no break-glass, not Marouane's account.
- **Fixture:** app registration `KEEL-RT-app-perms` (single tenant, no redirect URI, no credentials), requesting Microsoft Graph
  delegated `User.Read` and application `User.Read.All` in `requiredResourceAccess`, **not consented**.
- Do, at the deployed build B, from your own checkout:
  1. **Before** (read-only): with the engine against the live DB, report `countOpenCompletionSteps(c,{tenantRef})`, the length of
     `listOpenCompletionWork(c,{tenantRef,limit:500})`, and the raw count
     `SELECT count(*) FROM <completion item table> WHERE state = 'pending'` (find the table in `engine/restore/completion.mjs`).
     Expect the first two to be clearly lower than the raw count when the same objects were restored more than once.
  2. Create the fixture. Take a snapshot S (one Tier 1 run or the type's tier) and confirm S holds `application:KEEL-RT-app-perms`
     with 2 `resourceAccess` entries.
  3. Rename it to `KEEL-RT-app-perms-drift` in the tenant. Dry run
     `node cli/keel-restore.mjs --snapshot-id <S> --select <its natural key> --collector-config /etc/keel/tenant.json --target-config /etc/keel/restorer.json --persist-artifact <uuid>`.
     Report the planned operations, any refusal, and the preview's missing-reference lines (expect none for Graph).
  4. Approve, enforce. Read back: name `KEEL-RT-app-perms`, `requiredResourceAccess` unchanged (same 2 entries), still no consent grant
     (`/oauth2PermissionGrants` and app role assignments for its service principal, if any: 0).
  5. Repeat steps 3–4 once (a second restore of the same app). Then report `listCompletionItems` for both restores: the first restore's
     pending steps should carry `replacedBy` = the second restore; `countOpenCompletionSteps` should count only the second's.
  6. Cleanup: delete the app (and its service principal if one was made). Collect; report no `KEEL-RT-app-perms*` left. Close or leave the
     follow-up steps as they are; report which.
- **Expected:** no `not-found-in-target`, write succeeds, permissions unchanged, nothing consented, replaced steps left out of the counts.
  If the write refuses, quote the refusal and stop (change nothing else).
- **Report:** the outputs above, approval ids, and the build.

### K7: Live check of "write your own check" and the known standards on Compliance (after #567)
- Drafted by the "Live checks for Oct 23–25 merges" thread (2026-10-27). #567 adds tenant-written compliance checks
  (`compliance_own_check`, run with Keel's checks after every backup) and the CISA SCuBA and NIST standards sections.
- Needs: /opt/keel-live at the #567 merge (fa37b06) or later (`test -f /opt/keel-live/engine/store/schema.d/74-own-checks.sql`).
- Approval: Marouane approved on 2026-10-27 (14:36 UTC, in the project thread) that keelops may run this item under the operator queue's test-tenant restore rules: self-approve, log each approval id, KEEL-RT- fixtures only.
- Status: blocked
- Result: blocked on `/etc/keel/db.env` (and `tenant.json` for tenantRef). No own check created. `/etc/keel` is still `root:root 750` with no keelops ACL (checked 2026-10-27 ~15:15 UTC); root's access step is queued as Q175 on claude/operator-queue (~/agent-src/ROOT-STEPS.md §1). Live build `d040d6c`; Needs check passes. Nothing run, nothing changed in the tenant or on the host. Retry once the files are readable.
- **Tenant:** nothing is written to the tenant. Keel's own database only: one test check, removed at the end.
- Do, from your own checkout at B, against the live DB:
  1. Report `\d compliance_own_check` (the table exists) and `ownCheckChoices(c,{tenantRef})`: the number of types offered and a few sample fields.
  2. Create one check with `createOwnCheck(c,{principalId,tenantRef,input})`, using a principal that already holds `configuration`
     (the one approvals use; if none does, mark `blocked` and grant nothing). Input:
     `{standard:'KEEL-RT standard', name:'KEEL-RT security defaults off', resourceType:'identitySecurityDefaultsEnforcementPolicy', field:'isEnabled', operator:'equals', expected:false, appliesTo:'every', severity:'low'}`
     (if that type is not offered in step 1, pick any offered type and a field whose value you can see, and say which).
  3. Run `runComplianceChecks(c,{tenantRef,actor:'keel-operator'})`. Report the new check's result (pass / fail / could not check)
     and the value it compared, and that Keel's own checks still produced their results (count by result before and after).
     Also report the new check's `details` lines with `ok` (after #573: one line per object read, failing first; K8 step 4).
  4. Report the standards view the page uses: for SCuBA and NIST, how many policies Keel checks, how many pass/fail, how many not checked yet
     (from `engine/benchmarks/standards.mjs` + the newest results; report what you ran).
  5. Remove the check with `removeOwnCheck`. Report the row has `removed_at` set and two `compliance-own-check` evidence entries (created, removed).
- **Expected:** all five steps work with no error; the check's result matches the tenant's value. If any call throws, quote the error and stop.
- **Report:** the outputs above and the build.

### K8: Live check of the Compliance score fixes and the expected-vs-current values (after #572 and #573)
- Drafted by the "Live check compliance page changes" thread (2026-10-27). #572: "Legacy authentication is blocked"
  (`keel-custom.conditional-access.block-legacy`, evaluatorVersion 2) now passes only for an **enabled** CA policy that blocks
  both `exchangeActiveSync` and `other` for **All users and All apps** (exclusions allowed); no blocking policy at all is
  "not set up yet" (`reason: not-configured`). #573: every result now stores every setting it checked as a detail line
  `{subject, setting, value, expected, ok}`, failing lines first, at most 50 lines per result; a passing "any" own check keeps
  only the lines that meet it. Results stored before the deploy only hold failing lines (no `ok`) until the next check run.
- Needs: Q175 (`/etc/keel/db.env` and `tenant.json` readable), and /opt/keel-live at the #573 merge (a043642) or later:
  `grep -q 'ok: line?.ok === true' /opt/keel-live/engine/govern/baselineCompliance.mjs` and
  `grep -A15 "title: 'Legacy authentication is blocked'" /opt/keel-live/engine/benchmarks/registry.mjs | grep -q 'evaluatorVersion: 2'`.
- Status: todo
- **Tenant:** Collector **reads** only (one Graph GET in step 3). Nothing is written to the tenant or to Keel's database.
  No hand-written SQL: engine read calls only, as in K5. Do **not** run checks by hand (no `runComplianceChecks`, no "Check now").
- Do, from `/opt/keel-live` with `set -a; . /etc/keel/db.env; set +a`, tenantRef as in K5:
  1. Report the build (`git -c safe.directory=/opt/keel-live -C /opt/keel-live rev-parse --short HEAD`) and when it was deployed.
  2. `const { findings, summary } = await complianceFindings(c, { tenantRef })` (`engine/govern/baselineCompliance.mjs`).
     Report `summary`, and the newest `evaluatedAt`. It must be **after** the deploy (the scheduled checks run after each backup).
     If it is not, set `blocked` with that time and retry on a later pass; do not run checks yourself.
  3. **Legacy sign-in (#572):** for the `keel-custom.conditional-access.block-legacy` finding report `verdict`, `reason`,
     `evaluatorVersion` (expect 2) and `evaluatedAt`. Cross-check with a Collector read of
     `GET /identity/conditionalAccess/policies` (the Graph client and `/etc/keel/tenant.json`, as `keel-collect` uses them):
     for every policy whose `grantControls.builtInControls` has `block` and whose `conditions.clientAppTypes` has
     `exchangeActiveSync` or `other`, report name (mask any that is not `KEEL-RT-`), `state`, `clientAppTypes`, whether
     `includeUsers` has `All`, whether `includeApplications` has `All`. Say which verdict those facts give under the rule above
     and whether it matches Keel's.
  4. **Values (#573):** pick (a) one failing Keel control with the most detail lines, (b) one passing Keel control with at least one
     detail line, (c) every own check in force (`finding.own` not null; none is fine, say so). For each report `controlId`, `verdict`,
     `details.length`, the count of `ok:true` and `ok:false`, whether every `ok:false` line comes before every `ok:true` line,
     and the first 3 lines verbatim (subjects masked unless `KEEL-RT-`). Expect: (a) has its failing lines first and, where the
     control checks several objects, passing lines after them; (b) only `ok:true` lines; no result over 50 lines (name any that is
     exactly 50: the page shows "or more" / "first 50 kept" there).
  5. Count findings whose `details` are non-empty and all `ok:false` while `verdict` is `pass` (expect 0), and findings evaluated
     after the deploy with `evaluatorVersion` 1 for the legacy control (expect 0).
- **Expected:** steps 2–5 as above, no call throws. A mismatch is a result: quote it and stop (change nothing).
- **Report:** the outputs above and the build. The portal pages (390 and 1440 px, light and dark) can't be opened from the box; say so.

## Operator decisions (human operator only)

Write `yes`, `no` or your instructions after each one. If a decision is blank, every
item that needs it stays untouched.
