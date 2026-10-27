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
- Status: done
- Result: GREEN (retried 2026-10-27 15:25 UTC once /etc/keel became readable; supersedes the earlier blocked note). Build `d040d6c` (#570 live since `e17b36c`, deployed 2026-10-25 14:25:27 UTC). Read-only: queries ran in `READ ONLY` transactions via node+pg with /etc/keel/db.env; `buildCoverageReport` with tenant.json for tenantRef `sha256:f7b3959300856957`. Collector not run by hand. **1.** Newest Tier 1 snapshot `ebe55d4c-38ce-414b-a661-4a7491d110cf` (job `9e6b2398`, hourly, started 2026-10-27 15:00:02, succeeded); snapshot status `complete`; digest for deviceManagementSettings: outcome `complete`, HTTP 200, 1 request, 1 item, `/deviceManagement` beta; no `incomplete types` entry in the job output. **2.** `deviceManagementSettings | objects 1 | has_settings true | has_cleanup false | has_brand false` (query as written). **3.** Tier 1 collects since the deploy: 52, all `succeeded`, 0 naming deviceManagementSettings as failed or partial (the only non-complete rows are 4 midnight tier2/tier3 snapshots where the type is `not-requested`). For comparison, 16 of 16 collects on 2026-10-25 before the deploy were partial on it. Newest snapshot: no type failed or partial (3 `complete-empty`, the rest `complete` or `not-requested` for this tier); 40 snapshots since the deploy, all `complete`. **4.** Coverage report row: status `covered`, outcome `complete`, itemCount 1, lastCollectedAt 2026-10-27T15:00:20.078Z, detail httpStatus 200, message null (liveRecords passed as null: the qualification key is not granted). **5.** Newest Tier 2 job `f7e3d6b9` (2026-10-27 00:02, snapshot `a0bfcaf2`): settings catalog `configurationPolicy` `complete`, HTTP 200, `/deviceManagement/configurationPolicies?$expand=settings`. Its other non-complete types are `unavailable` tenant conditions: identityApiConnector 400 AADB2C99039 (self-service sign-up not enabled), lifecycleWorkflow and lifecycleWorkflowCustomTaskExtension 403 (Entra ID Governance licence), onPremisesConditionalAccessSettings 501 NotSupported. Newest Purview job `workload-collect` `ff07aaeb` (2026-10-27 02:01): purview-labels `complete`, purview-retention-dlp `complete`, purview-governance `partial`: "4 settings: not read (unknown)", httpStatus null; the 4 are `EventType` and `MultiStageReviewProperty` on 2 retention labels (`retention-label:661c293b…`, `retention-label:bf23056c…`), operation `purview.retention-labels`, status `unknown`, no failing request named. No Graph Purview kinds in the Tier 1/2 digests. Nothing written in the tenant or on the host; no evidence branch. #447 can close.
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
- Status: done
- Result: Mostly GREEN; exchange-mail differs from the expected outcome (see below). Retried 2026-10-27 ~15:35 UTC once /etc/keel became readable; supersedes the earlier blocked note. Build `d040d6c` (#564 live since `fa37b06`, 2026-10-25 13:29:22 UTC). Read-only SELECTs in `READ ONLY` transactions with /etc/keel/db.env. **Nothing enqueued**: used the scheduled `content-collect` runs after the deploy, the newest being job `39000f6e-4324-4c1e-af15-aab122419994` (2026-10-27 01:01:43 to 01:07:29, `succeeded`, requested_by the scheduler principal `70d2ea67…`, result keys stderr/stdout/durationMs, no `partial`/`incompleteTypes`, error null; worker line `job 39000f6e-…: succeeded (345969ms)`). **content_run, last 30 h** (workload | outcome | items | reasons | skipped | completed_at): planner succeeded 80 0 0 01:07:29 · teams succeeded 11 0 0 01:07:20 · sharepoint-sites succeeded 0 0 0 01:06:09 · onedrive succeeded 0 0 **10** 01:03:46 · exchange-mail succeeded 21 0 0 01:03:34 (all 2026-10-27). **OneDrive:** `succeeded`; 10 skipped entries, all `<user>: OneDrive locked in Microsoft 365` (10/10 match, 10 distinct); no errors counted. As expected. **SharePoint sites:** no reason for the search site on 10-26 (43 items) or 10-27; the 404 is gone. As expected. **Exchange mail:** on 10-27 it is `succeeded` with 0 reasons, so the one group mailbox was not refused (expected: still partial). On the previous run (job `181da29e`, 2026-10-26 01:01, already on #564) it was `partial`, 24 items, reason `<group mailbox> (group): Microsoft 365 refused access to this mailbox only; other group mailboxes read fine (403 ErrorAccessDenied Access is denied. Check credentials and try again.)`. That wording names the tenant condition and does not blame a missing app permission. The refusal looks intermittent on the Microsoft side; nothing was changed or granted. Nothing written in the tenant or on the host; no evidence branch.
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
- Status: failed
- Result: FAILED: 4 of 16 questions throw `canceling statement due to statement timeout` (5 s, the engine's `BUDGET.statementTimeoutMs` in `readOnly`). Reproduced on a second run at 15:17:39 UTC (5067/5021/5046/5021 ms): `What changed since the beginning of the month?`, `What changed since 17/10?`, `What changed in Azure AD this month?`, `Which admins changed this month?`. So the expected `assumed` reading for admins and the month-long periods could not be checked. The other 12 meet the expectations: duplicates 0 and zeroWidth 0 on every answer; modifiedWithoutFields 0; sign-in logs answered in words (refusal `unsupported`, "KEEL does not back up sign-in logs…"); "Who changed…" says what and when but not who; MFA `assumed` names the concept reading; CA policies understood as `conditionalAccessPolicy` (no `assumed` entry, the kind is direct). "Which users have changed?" defaults to this week (assumed `period`): total 0, gap not-compared-yet. Extra read-only question "Which users have changed this month?": total 104, all on 2026-10-10 (102 modified, 2 added), every modified row lists fields (businessPhones, city, companyName, country, department, employeeType, givenName, jobTitle…, moreFields true), window 10-09 00:00 to 10-10 00:00 (not zero-width). So the 10 Oct mass change shows with its settings. Build `d040d6c`. Ran `answerQuestion` from `/opt/keel-live/engine/query/execute.mjs` (its own READ ONLY transaction) with /etc/keel/db.env and tenantRef `sha256:f7b3959300856957`, scope {central:true, entities:[]}; record fields `naturalKey`, `window.from/to`, `changeType`, `fields` as in the item. Portal visuals (sorting, Columns picker, folding) cannot be checked from the box: not checked. Nothing written. JSON lines verbatim (first run 15:16:57 UTC; no names in them):
  `{"question":"Which users have changed?","status":"partial","understood":"Changes to user detected between 2026-10-26T00:00:00.000Z and 2026-10-27T15:16:57.405Z","assumed":["period"],"ignored":[],"total":0,"shown":0,"duplicates":0,"zeroWidth":0,"modifiedWithoutFields":0,"gaps":[{"from":"2026-10-27T00:02:33.276Z","to":"2026-10-27T15:16:57.405Z","reason":"not-compared-yet"}],"sentence":"No matching changes were found up to 2026-10-27T00:02:33.276Z. Part of this period is not known yet, so this may not be everything.","refusal":null}`
  `{"question":"What changed since the beginning of the month?","error":"canceling statement due to statement timeout"}`
  `{"question":"What changed since 17/10?","error":"canceling statement due to statement timeout"}`
  `{"question":"What changed between Oct 20 and Oct 25?","status":"answered","understood":"Changes detected between 2026-10-20T00:00:00.000Z and 2026-10-26T00:00:00.000Z","assumed":[],"ignored":[],"total":396,"shown":396,"duplicates":0,"zeroWidth":0,"modifiedWithoutFields":0,"gaps":[],"sentence":"396 matching changes found in this period.","refusal":null}`
  `{"question":"What changed 3 days ago?","status":"answered","understood":"Changes detected between 2026-10-24T00:00:00.000Z and 2026-10-25T00:00:00.000Z","assumed":[],"ignored":[],"total":2,"shown":2,"duplicates":0,"zeroWidth":0,"modifiedWithoutFields":0,"gaps":[],"sentence":"2 matching changes found in this period.","refusal":null}`
  `{"question":"What changed in the last 48 hours?","status":"partial","understood":"Changes detected between 2026-10-25T15:17:13.068Z and 2026-10-27T15:17:13.068Z","assumed":[],"ignored":[],"total":45,"shown":45,"duplicates":0,"zeroWidth":0,"modifiedWithoutFields":0,"gaps":[{"from":"2026-10-27T15:00:20.078Z","to":"2026-10-27T15:17:13.068Z","reason":"not-compared-yet"}],"sentence":"45 matching changes found up to 2026-10-27T15:00:20.078Z. Part of this period is not known yet, so this may not be everything.","refusal":null}`
  `{"question":"What changed in Azure AD this month?","error":"canceling statement due to statement timeout"}`
  `{"question":"What changed in Endpoint Manager last week?","status":"answered","understood":"Changes to 65 kinds detected between 2026-10-19T00:00:00.000Z and 2026-10-26T00:00:00.000Z","assumed":[],"ignored":[],"total":38,"shown":38,"duplicates":0,"zeroWidth":0,"modifiedWithoutFields":0,"gaps":[],"sentence":"38 matching changes found in this period.","refusal":null}`
  `{"question":"Which CA policies changed this month?","status":"partial","understood":"Changes to conditionalAccessPolicy detected between 2026-10-01T00:00:00.000Z and 2026-10-27T15:17:19.731Z","assumed":[],"ignored":[],"total":5,"shown":5,"duplicates":0,"zeroWidth":0,"modifiedWithoutFields":0,"gaps":[{"from":"2026-10-01T00:00:00.000Z","to":"2026-10-05T14:09:06.825Z","reason":"before-history"},{"from":"2026-10-27T15:00:20.078Z","to":"2026-10-27T15:17:19.731Z","reason":"not-compared-yet"}],"sentence":"5 matching changes found up to 2026-10-27T15:00:20.078Z. Part of this period is not known yet, so this may not be everything.","refusal":null}`
  `{"question":"What MFA settings changed this month?","status":"partial","understood":"Changes to 4 kinds detected between 2026-10-01T00:00:00.000Z and 2026-10-27T15:17:20.220Z","assumed":["Read “MFA” as sign-in method settings, authentication strengths, Conditional Access policies and security defaults."],"ignored":[],"total":8,"shown":8,"duplicates":0,"zeroWidth":0,"modifiedWithoutFields":0,"gaps":[{"from":"2026-10-01T00:00:00.000Z","to":"2026-10-05T14:09:06.825Z","reason":"before-history"},{"from":"2026-10-27T15:00:20.078Z","to":"2026-10-27T15:17:20.220Z","reason":"not-compared-yet"}],"sentence":"8 matching changes found up to 2026-10-27T15:00:20.078Z. Part of this period is not known yet, so this may not be everything.","refusal":null}`
  `{"question":"Which admins changed this month?","error":"canceling statement due to statement timeout"}`
  `{"question":"Who changed the Exchange transport rules?","status":"unknown","understood":"Changes to exchange-mail-flow detected between 2026-10-26T00:00:00.000Z and 2026-10-27T15:17:25.431Z","assumed":["KEEL compares backups, so it shows what changed and when, but not who made the change.","period"],"ignored":[],"total":0,"shown":0,"duplicates":0,"zeroWidth":0,"modifiedWithoutFields":0,"gaps":[{"from":"2026-10-26T00:00:00.000Z","to":"2026-10-27T15:17:25.431Z","reason":"no-history"}],"sentence":"Not known: KEEL has not compared any collection in this period, so it cannot say whether anything changed.","refusal":null}`
  `{"question":"Show me the sign-in logs","status":"unknown","understood":null,"total":0,"shown":0,"duplicates":0,"zeroWidth":0,"modifiedWithoutFields":0,"gaps":[],"sentence":"KEEL does not back up sign-in logs. It answers questions about changes, backup coverage and failed jobs for the settings it backs up.","refusal":"unsupported"}`
  `{"question":"What does the backup hold for Teams?","status":"answered","understood":"What the latest backup holds","assumed":[],"ignored":[],"total":3,"shown":3,"duplicates":0,"zeroWidth":0,"modifiedWithoutFields":0,"gaps":[],"sentence":"The latest backups hold 3 kinds of resource you may see.","refusal":null}`
  `{"question":"Which jobs failed this week?","status":"answered","understood":"Jobs that failed between 2026-10-26T00:00:00.000Z and 2026-10-27T15:17:25.661Z","assumed":[],"ignored":[],"total":0,"shown":0,"duplicates":0,"zeroWidth":0,"modifiedWithoutFields":0,"gaps":[],"sentence":"No failed jobs were found in this period.","refusal":null}`
  `{"question":"How many groups are covered?","status":"answered","understood":"What the latest backup holds for group","assumed":[],"ignored":["many"],"total":1,"shown":1,"duplicates":0,"zeroWidth":0,"modifiedWithoutFields":0,"gaps":[],"sentence":"The latest backups hold 1 kind of resource you may see.","refusal":null}`
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
- Result: blocked: needs the operator's own decision before any tenant write (2026-10-27 ~15:25 UTC). The approval note in this item was written by the coordinator session; the **Operator decisions** section (human only) is empty. This item creates a tenant app and files and approves restores as Marouane's Entra and Gmail principals (the Q45 requester/approver split). keelops will not act as the human approver on a relayed approval. To unblock: Marouane writes e.g. `K6: yes, keelops may create KEEL-RT-app-perms and file/approve its restores as my Entra/Gmail principals` under Operator decisions, or tells keelops directly. **Step 1 (read-only, done):** build `d040d6c`; `countOpenCompletionSteps` 93, `listOpenCompletionWork(limit 500)` length 28, raw `SELECT count(*) FROM recovery_completion_item WHERE tenant_ref=… AND state='pending'` 93 (at 2026-10-27T15:19:15Z). The open count is **not** lower than the raw count (expected lower if the same objects were restored more than once); the list length is lower. Restorer has `Application.ReadWrite.All` (workload_ledger_grants), so the write path exists. Nothing written in the tenant or the DB; no fixture created.
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
- Result: blocked after the read-only steps: steps 2, 3 and 5 need the operator's own decision (2026-10-27 ~15:30 UTC). They create and remove a check as a human principal that holds `configuration` (permanent `compliance-own-check` evidence entries in that person's name) and run `runComplianceChecks`, which rewrites the live compliance results. The approval note in this item was written by the coordinator; the **Operator decisions** section is empty. Same reason as K6. To unblock: Marouane writes `K7: yes` under Operator decisions (and names the principal to use), or tells keelops directly. **Read-only results, build `d040d6c`:** **1.** `compliance_own_check` exists: id, tenant_ref, standard, name, resource_type, field, operator, expected (jsonb), applies_to, severity, created_by, created_at, removed_at, removed_by; 0 rows for this tenant. `ownCheckChoices`: snapshotId + 31 types, e.g. application (49 objects; fields api.acceptMappedClaims, api.requestedAccessTokenVersion, appId…), authenticationMethodsPolicy (1), authenticationStrengthPolicy (4). `identitySecurityDefaultsEnforcementPolicy` is offered, with field `isEnabled` values `[false]`, so the planned check would compare `false`. **4.** Standards, computed like `standardCoverage` in portal/lib/compliance-view.ts over `complianceFindings` (9 findings: 5 failing, 4 passing): CISA SCuBA: 43 policies, Keel checks 3, 40 not checked; 0 pass, 1 passes in part, 2 do not, 0 could not be checked. NIST SP 800-53: 3 controls mapped, all checked; 0 pass, 2 pass in part, 1 does not. Nothing written.
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
- Status: done
- Result: GREEN, one observation (2026-10-27 ~16:08 UTC; supersedes the earlier blocked note). **1.** Build `b42bb09` (contains #573 a043642), deployed 2026-10-27 15:31:25 UTC; both Needs greps pass. **2.** `complianceFindings` (engine read call, READ ONLY transaction): summary `{"controls":9,"exposed":5,"excepted":0,"expiredExceptions":0,"incompleteExceptions":0,"notConfigured":0,"passing":4,"unknown":0,"notApplicable":0}`; every finding evaluatedAt 2026-10-27T16:05:04.261Z (scheduled run after the 16:00 backup; after the deploy). No checks run by hand. **3.** `keel-custom.conditional-access.block-legacy`: verdict `fail`, reason `null`, evaluatorVersion 2, evaluatedAt 16:05:04.261Z. Collector `GET /v1.0/identity/conditionalAccess/policies` → 200, 24 policies; the ones with `block` and EAS/other: (i) `<masked>`, state `enabledForReportingButNotEnforced`, clientAppTypes [exchangeActiveSync, other], includeUsers All yes, includeApplications All yes; (ii) `KEEL-RT-20260908 Block Legacy Authentication`, state `enabled`, [exchangeActiveSync, other], includeUsers All **no**, includeApplications All yes. Under the #572 rule neither qualifies: (i) is report-only and (ii) does not cover All users. Blocking policies exist, so the result is `fail` (not `not-configured`). This **matches** Keel. **4.** (a) failing with most lines: `keel-custom.defender-email.safe-links-email` fail, 18 lines, ok:true 13 / ok:false 5, all ok:false before ok:true: yes; first 3: `{"ok":false,"value":true,"setting":"AllowClickThrough","subject":"<masked>","expected":false}` ×3. (b) passing: `keel-custom.defender-email.anti-phish-spoof-protection` pass, 12 lines, ok:true 12 / ok:false 0; first 3: `{"ok":true,"value":true,"setting":"EnableSpoofIntelligence","subject":"<masked>","expected":true}`, `{… "setting":"HonorDmarcPolicy" …}`, `{… "setting":"EnableUnauthenticatedSender" …}`. (c) own checks in force: none. Lines per control (controlId, verdict, lines): block-legacy fail 0 · anti-phish-spoof-protection pass 12 · anti-spam-no-allowed-domains fail 3 · anti-spam-phish-quarantined fail 9 · malware-file-filter pass 10 · safe-links-email fail 18 · role-assignable-not-synced pass 1 · no-untrusted-all-countries pass 2 · admin-count-at-most fail 1. None over 50, none exactly 50. **5.** passing findings with only ok:false lines: 0; legacy findings after the deploy at evaluatorVersion 1: 0. **Observation:** the legacy sign-in control fails with **0 detail lines**, so the page has no expected-vs-current values to show for it (the item did not state an expectation here; flagging for the coordinator). Portal pages (390/1440 px, light/dark) not opened from the box. Nothing written in the tenant or the DB (one Collector GET).
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

### K9: Live check that the nightly settings backup is no longer partial from Purview retention labels (after #576)
- Drafted by the "Stop Purview showing partial nightly" thread (2026-10-27). Q168 found every `workload-collect` job `partial`
  only because of `purview-governance`: "4 settings: not read (unknown)", which were `EventType` and `MultiStageReviewProperty`
  missing from the 2 retention labels. #576: a retention label missing those is stored as `null` with coverage
  `{status: observed, notSet: true}` (EventType only when `RetentionType` is not `EventAgeInDays`), so the run is `complete`.
  Any setting still not returned is now named ("Retention label: event type was not returned (2 objects)").
- Needs: /opt/keel-live at the #576 merge or later (`grep -q NOT_SET_REASON /opt/keel-live/engine/collect/workloads/cmdletFamilies.mjs`),
  and a scheduled `workload-collect` (02:00 UTC) that started after that deploy. If the next one is more than 2 hours away, use the
  Schedules page "Run now" on the settings backup or the same engine `enqueue` call Q168 used (kind `workload-collect`, `{tenantRef}`,
  scheduler principal, key `keelops:k9:<date>`), and say which. Never run the CLI by hand.
- Status: done
- Result: GREEN (2026-10-27 16:31 UTC). Build `4fca536` (#576 `edbf664`, deployed 16:24:11 UTC; `NOT_SET_REASON` grep passes). The next scheduled 02:00 run was ~9.5 h away, so keelops queued the same read-only job with the engine `enqueue` (kind `workload-collect`, `{tenantRef}`, scheduler principal `70d2ea67…`, key `keelops:k9:2026-10-27`); the worker ran it; the CLI was not run by hand. **1.** `d36d32a0-4c00-4e84-8018-2df6317c7909 | succeeded | 16:25:14.166 | 16:30:45.789 | error null | partial null | incomplete null` (the result has no `partial`/`incompleteTypes` keys; worker line `job d36d32a0-…: succeeded`). All 13 workload runs from it are `complete` except power-platform-settings `disabled` (as configured). **2.** `7fce48b3-d3c6-4a00-ba28-5f0576b4cf0d | complete | fieldCounts {"observed":36} | unknownFields {}`. **3.** Label 1: RetentionType `TaggedAgeInDays`, EventType `{"notSet":true,"reason":"not set: Microsoft leaves this setting out when it is not set","status":"observed","operation":"purview.retention-labels"}`, MultiStageReviewProperty the same. Label 2: RetentionType `CreationAgeInDays`, EventType and MultiStageReviewProperty the same `{notSet:true, status:observed}`. Neither label is event-based, so there is no real gap. Tenant: Collector reads only (the normal settings backup). Keel DB: the one queued job row (plus the rows the job itself writes). Nothing else written.
- **Tenant:** Collector reads only (the normal settings-by-service backup). No grants, no fixtures, no writes.
- Do, from `/opt/keel-live` with `set -a; . /etc/keel/db.env; set +a` (read-only SELECTs):
  1. Report the build and the job: `SELECT id, status, started_at, finished_at, error, result->'partial' AS partial, result->'incompleteTypes' AS incomplete FROM job WHERE kind = 'workload-collect' ORDER BY created_at DESC LIMIT 1;`
  2. Report the newest `purview-governance` run: `SELECT id, outcome, digest->'fieldCounts', digest->'unknownFields' FROM workload_collection WHERE workload = 'purview-governance' ORDER BY observed_to DESC LIMIT 1;`
  3. For that run's retention labels (`resource_key LIKE 'retention-label:%'`), report per label (number them, no names unless `KEEL-RT-`):
     `fields->>'RetentionType'`, and `field_coverage->'EventType'` and `field_coverage->'MultiStageReviewProperty'`.
- **Expected:** job `succeeded` with `partial` false (or, if another workload is partial, `purview-governance` not in `incomplete`);
  run `outcome = complete`, no `unknown` in `fieldCounts`; each label's two settings `{"status":"observed","notSet":true,...}`
  unless its RetentionType is `EventAgeInDays`.
- **Report:** the three outputs and the build. If a label is event-based and its EventType is still `unknown`, say so; that is a
  real gap, not this fix failing.

### K10: Live re-check that the month-long Ask questions answer within the 5 s budget (after #577)
- Drafted by the "Fix Ask timeouts on month questions" thread (2026-10-27). K5 found 4 of 16 Ask questions always cancelled by the
  5 s statement timeout. #577 adds index `snapshot_complete_time_idx` (`engine/store/schema.d/76-snapshot-complete-time.sql`, applied
  by the deploy's schema step) and reads each change's window start with an ordered walk on it. Locally: 6.8 s to 0.5 s, same answers.
- Needs: /opt/keel-live at the #577 merge or later (`test -f /opt/keel-live/engine/store/schema.d/76-snapshot-complete-time.sql`).
- Status: in-progress
- Result:
- **Tenant:** nothing. Read-only against Keel's own database.
- Do, from `/opt/keel-live` with `set -a; . /etc/keel/db.env; set +a`, tenantRef and scope as in K5:
  1. Report the build and its deploy time, and that the index exists:
     `SELECT indexname, indexdef FROM pg_indexes WHERE indexname = 'snapshot_complete_time_idx';` (expect 1 row).
  2. Run K5's script (same `answerQuestion` call, same JSON line per question, plus `ms` = elapsed time around the call) for:
     `What changed since the beginning of the month?`, `What changed since 17/10?`, `What changed in Azure AD this month?`,
     `Which admins changed this month?`, and as controls `What changed between Oct 20 and Oct 25?` and `Which users have changed this month?`.
     Run the list twice and report both runs' `ms`.
- **Expected:** no `statement timeout`; every question well under 5000 ms (target under 1500 ms); `duplicates` 0 and `zeroWidth` 0;
  modified rows list fields; the admins question shows its `assumed` reading; the two controls match K5's totals
  (396 for Oct 20–25, 104 for users this month) unless new changes arrived since. If the index row is missing, the schema step
  did not run: mark `blocked` and say so.
- **Report:** the outputs above and the build. Change nothing.

## Operator decisions (human operator only)

Write `yes`, `no` or your instructions after each one. If a decision is blank, every
item that needs it stays untouched.
