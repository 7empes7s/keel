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
- Status: done
- Result: Done (2026-10-27 19:50–21:04 UTC) under the filled decision "K6: yes, keelops may create KEEL-RT-app-perms and file and approve its restores as my Entra/Gmail principals" (commit f9485171, GitHub web UI as 7empes7s); supersedes the earlier blocked note. **#565 passes. #563 could not be shown with this fixture (see step 5).** B = `74f18b8`, CLI and engine from keelops's checkout `~/keel-b-74f18b8` (engine node_modules linked read-only from /opt/keel-live); live moved to `469b288` at 20:53, after all writes. Restorer (`/etc/keel/restorer.json`) for writes, Collector for reads; global admin not used; nothing consented or granted. **1.** (earlier) open steps 93, open-work list 28, raw pending 93. **2.** Created `KEEL-RT-app-perms` 19:50:10 (object `ba39f644-876e-4163-aa3d-11a722074708`, appId `683460cc-daec-4ec9-88b2-23789f8d6208`): AzureADMyOrg, no redirect URI, no password or key credentials; Graph `requiredResourceAccess` User.Read (Scope) and User.Read.All (Role); no service principal, not consented. Snapshot S = `882b4917-f2f8-4c90-a7be-6aa4c7bc044e` (hourly Tier 1, 20:00): holds `application:683460cc-…` with 2 `resourceAccess` entries. **3.** Renamed to `KEEL-RT-app-perms-drift`. Dry run `426d25d0-a478-4d2d-b5c8-d1caa1f29246`: status completed, guard_refusals [], 1 recovery mechanism (application update-existing, id retained, restorer), no missing-reference lines, **no `not-found-in-target`**. The selection closed to 2 resources: wave 1 `domain:techinsiderbytes.com` (a real domain, pulled in as a dependency), wave 2 the app. Before approving, keelops checked that the live domain equals S on all 12 fields, so the restore leaves it alone (`applyEngine` writes nothing when live already matches); the journal confirms no domain entry. **4.** Approval `5b21e30b-b6a7-4b8f-94c5-ad34a832632a`: requested by Entra principal `bac8d59b…`, approved by Gmail principal `2a47535a…`, executor `cli`. `keel-restore --artifact 426d25d0… --enforce` exit 0; journal `application:683460cc… update succeeded` (only entry). Read-back: name `KEEL-RT-app-perms`, `requiredResourceAccess` unchanged (same 2 entries), no credentials, no service principal, so no consent grants or app role assignments (0). **5.** Round 2: rename again; dry run `c28c7481-b864-4ad6-b8e0-6d1055cfab57` (same result); approval `cef3efd2-9381-45e7-ae3b-6ebb8ffd02c1` (Entra → Gmail); enforce exit 0, journal 1 entry `update succeeded`; read-back identical. `listCompletionItems` for both restores: **[] and []**. An in-place app update opens no follow-up steps, so there is no `replacedBy` to show; counts after were unchanged (93 / 28 / 93 at 20:09 and 21:03). The #563 check needs a restore type that opens steps (for example an app create with credentials or consent). **6.** Deleted the app 20:10 and purged it from deleted items; Graph shows no app, deleted item or service principal named `KEEL-RT-app-perms*`. Collect: snapshot `4910ecca-c945-4dcc-bfc5-376c7fd64ef6` (21:00, complete, application outcome complete, 49 apps) holds 0 `KEEL-RT-app-perms*`. Follow-up steps: none existed. **Left in the tenant: nothing.** Keel DB: the two dry-run artifacts, two approvals with their evidence, two journal entries, and the app's `added` drift row (its `removed` row comes with the next drift-detect).
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
- Status: done
- Result: GREEN (2026-10-27 20:11 UTC, under the filled decision "K7: yes, use my portal principal"; supersedes the earlier blocked note). Build B `74f18b8` (contains #567), engine calls from keelops's checkout at B (`~/keel-b-74f18b8`), /etc/keel/db.env. **Principal:** `bac8d59b…` "Marouane Defili (Entra ID)". It is the principal behind the portal's recent `action-attempt` evidence (604, 2026-10-17 to 10-25; the Gmail principal's 60 end 10-22), and it holds `configuration` centrally. **1.** (from the earlier read-only pass) `compliance_own_check` exists; 0 rows before; `ownCheckChoices` offers 31 types including `identitySecurityDefaultsEnforcementPolicy` with `isEnabled` values `[false]`. **2.** `createOwnCheck` → id `0a81b223-8fb5-4520-b7b7-08492044ee56`, standard `KEEL-RT standard`, name `KEEL-RT security defaults off`, identitySecurityDefaultsEnforcementPolicy / isEnabled / equals / `false` / every / low, created_by bac8d59b…, 20:11:24.363Z. **3.** `runComplianceChecks({actor:"keel-operator"})` → checked 10, pass 5, fail 5, unknown 0, notApplicable 0, notConfigured 0. The new check `own.0a81b223…`: **pass**, reason null, detail `{"ok":true,"value":false,"setting":"isEnabled","subject":"Security Defaults","expected":false}`. It compared `false` with the tenant's value `false` (matches step 1). Keel's own checks before → after: fail 5 / pass 4 → fail 5 / pass 4 (9 results both times). **4.** (from the earlier pass) CISA SCuBA: Keel checks 3 of 43 policies; 0 pass, 1 passes in part, 2 do not. NIST SP 800-53: 3 controls mapped; 0 pass, 2 in part, 1 does not. **5.** `removeOwnCheck` → row `removed_at` 2026-10-27T20:11:24.637Z, removed_by bac8d59b…; evidence `compliance-own-check` seq 326457 `created` (20:11:24.369Z) and seq 326468 `removed` (20:11:24.640Z), actor bac8d59b…. No call threw. Tenant: nothing written. Keel DB: the check row (kept, marked removed), its 2 evidence entries, and one compliance evaluation run.
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
- Status: done
- Result: GREEN on the timeout fix, one explained exception (2026-10-27 ~16:56 UTC). **1.** Build `9317f47` (#577), deployed 2026-10-27 16:51:41 UTC. Index present: `snapshot_complete_time_idx`: `CREATE INDEX snapshot_complete_time_idx ON public.snapshot USING btree (tenant_ref, completed_at DESC) WHERE (status = 'complete'::text)`. **2.** No statement timeout; every call under 1 s (target 1500 ms). ms run 1 / run 2: since beginning of month 957/845 · since 17/10 394/367 · Azure AD this month 886/861 · admins this month 241/258 · Oct 20–25 217/235 · users this month 324/199. duplicates 0 and zeroWidth 0 on all. The admins question shows assumed `Read “admins” as admin roles and who holds them, in Entra, Intune, Exchange and Defender.` Controls match K5: Oct 20–25 total 396 (answered), users this month 104 (all 2026-10-10). **Exception: modified rows without fields.** 37 / 37 / 63 / 51 rows on the four month questions (0 on the controls). All of them are `roleAssignmentSchedule` (51) or `permissionGrantPolicy` (12), seen 2026-10-17 11:00 (window 10:00–11:00). The `drift` rows behind them have **identical before/after payloads with different hashes** (sample `02ed6302…`). On 2026-10-17: permissionGrantPolicy 12/12 same payload, roleAssignmentSchedule 561/1023 same payload, 0 same hash. So these are hash-only "changes" (looks like a re-hash), not real setting changes, and the Ask page lists them as modified with nothing changed. This predates #577; flagging for the coordinator. The three broad questions are `truncated` at 1000 shown (totals 1912 / 1212 / 1471). Nothing written. Run 1 JSON lines (no names):
  `{"ms": 957, "question": "What changed since the beginning of the month?", "status": "partial", "assumed": [], "total": 1912, "shown": 1000, "duplicates": 0, "zeroWidth": 0, "modifiedWithoutFields": 37, "gaps": [{"from": "2026-10-01T00:00:00.000Z", "to": "2026-10-05T14:09:06.825Z", "reason": "before-history"}, {"from": "2026-10-27T16:00:19.537Z", "to": "2026-10-27T16:51:59.728Z", "reason": "not-compared-yet"}], "sentence": "1912 matching changes found up to 2026-10-27T16:00:19.537Z. Part of this period is not known yet, so this may not be everything. Showing the newest 1000.", "refusal": null}`
  `{"ms": 394, "question": "What changed since 17/10?", "status": "partial", "assumed": [], "total": 1212, "shown": 1000, "duplicates": 0, "zeroWidth": 0, "modifiedWithoutFields": 37, "gaps": [{"from": "2026-10-27T16:00:19.537Z", "to": "2026-10-27T16:52:00.686Z", "reason": "not-compared-yet"}], "sentence": "1212 matching changes found up to 2026-10-27T16:00:19.537Z. Part of this period is not known yet, so this may not be everything. Showing the newest 1000.", "refusal": null}`
  `{"ms": 886, "question": "What changed in Azure AD this month?", "status": "partial", "assumed": [], "total": 1471, "shown": 1000, "duplicates": 0, "zeroWidth": 0, "modifiedWithoutFields": 63, "gaps": [{"from": "2026-10-01T00:00:00.000Z", "to": "2026-10-05T14:09:06.825Z", "reason": "before-history"}, {"from": "2026-10-27T16:00:19.537Z", "to": "2026-10-27T16:52:01.080Z", "reason": "not-compared-yet"}], "sentence": "1471 matching changes found up to 2026-10-27T16:00:19.537Z. Part of this period is not known yet, so this may not be everything. Showing the newest 1000.", "refusal": null}`
  `{"ms": 241, "question": "Which admins changed this month?", "status": "partial", "assumed": ["Read “admins” as admin roles and who holds them, in Entra, Intune, Exchange and Defender."], "total": 476, "shown": 476, "duplicates": 0, "zeroWidth": 0, "modifiedWithoutFields": 51, "gaps": [{"from": "2026-10-01T00:00:00.000Z", "to": "2026-10-05T14:09:06.825Z", "reason": "before-history"}, {"from": "2026-10-27T16:00:19.537Z", "to": "2026-10-27T16:52:01.967Z", "reason": "not-compared-yet"}], "sentence": "476 matching changes found up to 2026-10-27T16:00:19.537Z. Part of this period is not known yet, so this may not be everything.", "refusal": null}`
  `{"ms": 217, "question": "What changed between Oct 20 and Oct 25?", "status": "answered", "assumed": [], "total": 396, "shown": 396, "duplicates": 0, "zeroWidth": 0, "modifiedWithoutFields": 0, "gaps": [], "sentence": "396 matching changes found in this period.", "refusal": null}`
  `{"ms": 324, "question": "Which users have changed this month?", "status": "partial", "assumed": [], "total": 104, "shown": 104, "duplicates": 0, "zeroWidth": 0, "modifiedWithoutFields": 0, "gaps": [{"from": "2026-10-01T00:00:00.000Z", "to": "2026-10-05T14:09:19.827Z", "reason": "before-history"}, {"from": "2026-10-27T00:02:33.276Z", "to": "2026-10-27T16:52:02.425Z", "reason": "not-compared-yet"}], "sentence": "104 matching changes found up to 2026-10-27T00:02:33.276Z. Part of this period is not known yet, so this may not be everything.", "refusal": null}`
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

### K11: Live re-check that "Legacy authentication is blocked" names each sign-in rule it looks at (after #578)
- Drafted by the "Show why legacy auth check fails" thread (2026-10-27). K8 found `keel-custom.conditional-access.block-legacy` failing
  with **0 detail lines**. #578: the control now stores 4 lines per CA policy whose `grantControls.builtInControls` has `block` and whose
  `clientAppTypes` has `exchangeActiveSync` or `other`: `state` (expected `enabled`), `includeUsers` (value `All` / `Only some` / `None`,
  expected `All`; groups, roles or guests count as `Only some`), `includeApplications` (same words, expected `All`), `clientAppTypes`
  (the legacy types it blocks, expected `["exchangeActiveSync","other"]`). On a fail every such policy is listed, failing lines first; on a
  pass only the enforcing policy. No user, group or app ids in any line. The verdict rule is unchanged (evaluatorVersion stays 2).
- Needs: /opt/keel-live at the #578 merge or later (`grep -q "Unnamed sign-in rule" /opt/keel-live/engine/benchmarks/registry.mjs`),
  and a scheduled check run after that deploy (the checks run after each backup). Do **not** run checks by hand.
- Status: done
- Result: GREEN (2026-10-27 ~18:07 UTC). **1.** Build `6744ab3` (#578), deployed 2026-10-27 17:44:05 UTC; the `Unnamed sign-in rule` grep passes. **2.** `complianceFindings` (engine read call, READ ONLY transaction); no checks run by hand. `keel-custom.conditional-access.block-legacy`: verdict `fail`, reason `null`, evaluatorVersion 2, evaluatedAt 2026-10-27T18:05:02.598Z (scheduled run after the 18:00 backup, after the deploy), detailCounts `{"checked":8,"failing":2}`, details.length 8, lines containing a GUID 0. Both failing lines come first and match expectations: the report-only policy's state `enabledForReportingButNotEnforced`, and `KEEL-RT-20260908 Block Legacy Authentication` includeUsers `Only some`. All other 6 lines are ok true. Matches the expected result exactly. Portal panel (390/1440 px, light/dark) not opened from the box. Nothing written. Lines verbatim (non-KEEL-RT subject masked):
  `{"ok":false,"value":"enabledForReportingButNotEnforced","setting":"state","subject":"<masked>","expected":"enabled"}`
  `{"ok":false,"value":"Only some","setting":"includeUsers","subject":"KEEL-RT-20260908 Block Legacy Authentication","expected":"All"}`
  `{"ok":true,"value":"All","setting":"includeUsers","subject":"<masked>","expected":"All"}`
  `{"ok":true,"value":"All","setting":"includeApplications","subject":"<masked>","expected":"All"}`
  `{"ok":true,"value":["exchangeActiveSync","other"],"setting":"clientAppTypes","subject":"<masked>","expected":["exchangeActiveSync","other"]}`
  `{"ok":true,"value":"enabled","setting":"state","subject":"KEEL-RT-20260908 Block Legacy Authentication","expected":"enabled"}`
  `{"ok":true,"value":"All","setting":"includeApplications","subject":"KEEL-RT-20260908 Block Legacy Authentication","expected":"All"}`
  `{"ok":true,"value":["exchangeActiveSync","other"],"setting":"clientAppTypes","subject":"KEEL-RT-20260908 Block Legacy Authentication","expected":["exchangeActiveSync","other"]}`
- **Tenant:** nothing (Collector reads not needed). Read-only against Keel's own database, engine read calls only, as in K8.
- Do, from `/opt/keel-live` with `set -a; . /etc/keel/db.env; set +a`, tenantRef as in K5:
  1. Report the build and its deploy time.
  2. `const { findings } = await complianceFindings(c, { tenantRef })`. For the `keel-custom.conditional-access.block-legacy` finding report
     `verdict`, `reason`, `evaluatorVersion`, `evaluatedAt` (must be **after** the deploy; if not, set `blocked` with the time and retry on
     a later pass), `detailCounts`, `details.length`, and every line verbatim (mask subjects that are not `KEEL-RT-`).
- **Expected:** verdict `fail`, reason `null`, evaluatorVersion 2, `details.length` 8 (2 policies x 4 lines), `detailCounts`
  `{"checked":8,"failing":2}`; failing lines first: the report-only policy's `state` = `enabledForReportingButNotEnforced` (ok false) and
  `KEEL-RT-20260908 Block Legacy Authentication`'s `includeUsers` = `Only some` (ok false); all other lines ok true. No line holds an id
  (GUID). If the policies changed since K8, report what the lines show instead; a mismatch is a result: quote it and change nothing.
- **Report:** the outputs above and the build. The portal panel (390/1440 px, light/dark) can't be opened from the box; say so.

### K12: Live re-check that changes with nothing changed are gone (after #579)
- Drafted by the "Stop listing changes with nothing changed" thread (2026-10-27). K10 found Ask listing `roleAssignmentSchedule` (51) and
  `permissionGrantPolicy` (12) rows as modified with no changed fields: hashes stored before the 2026-10-15 server-owned rules (#288, #294).
  #579 compares content, not stored hashes. Old rows are kept and marked with the new column `drift.same_content`
  (`engine/store/schema.d/77-drift-same-content.sql`, applied by the deploy's schema step; it marks equal payloads at once). The next
  drift detection (hourly) or policy evaluation checks the rest. Every list of changes leaves marked rows out.
- Needs: /opt/keel-live at the #579 merge `37e5cfb` or later (`test -f /opt/keel-live/engine/store/schema.d/77-drift-same-content.sql`), and one
  scheduled `drift-detect` job that succeeded after that deploy (`SELECT id, status, finished_at FROM job WHERE kind = 'drift-detect' ORDER BY created_at DESC LIMIT 1;`).
  Wait for the scheduled one; do not queue a job.
- Status: done
- Result: GREEN (2026-10-27 ~19:10 UTC), with notes on the totals. **1.** Build `74f18b8` (contains #579 `37e5cfb`, first live 18:16:14 UTC; 74f18b8 deployed 18:58:19). Newest `drift-detect`: `d70c8366-639c-4e56-ba91-2dd995171b6f | succeeded | 2026-10-27T19:05:25.242Z` (scheduled; none queued). **2.** permissionGrantPolicy `true` 24 · roleAssignmentSchedule `true` 8628 (no `false` or NULL rows for either type). All modified: `false` 70481 · `true` 9252 · NULL 0. Modified rows with both payloads and NULL same_content: 0. **3.** 0. **4.** Run once, same script as K10. modifiedWithoutFields **0** on all six; no timeout; every call under 1500 ms; duplicates 0, zeroWidth 0. Totals now vs K10: since beginning of month 1887 (was 1912, −25), since 17/10 1107 (1212, −105), Azure AD this month 1453 (1471, −18), admins this month 476 (476, ±0), controls Oct 20–25 396 (=) and users this month 104 (=). The month drops are smaller than the 37/63 hidden rows, because the month-to-date windows also picked up ~2 h of new hourly changes since K10. Admins stayed at exactly 476. Comparing K10's and K12's answer rows: 93 `roleAssignmentSchedule` rows from 2026-10-17 11:00 left (the 51 field-less ones plus 42 now marked same content), and 93 different `roleAssignmentSchedule` `added` rows from 2026-10-10 21:00 came in. So the admins answer looks capped at 476 rows while `truncated` is false and shown = total. Flagging this for the coordinator; the same-content fix itself works. **5.** `getOpenDriftCounts` (status/queries.mjs): added/access-affecting 13858, added/cosmetic 196, added/tenant-lockout 11148, modified/access-affecting 69859, modified/tenant-lockout 622, removed/access-affecting 443, removed/tenant-lockout 111. No before numbers kept from earlier passes. Nothing written. JSON lines (no names):
  `{"ms": 928, "question": "What changed since the beginning of the month?", "status": "partial", "assumed": [], "total": 1887, "shown": 1000, "duplicates": 0, "zeroWidth": 0, "modifiedWithoutFields": 0, "gaps": [{"from": "2026-10-01T00:00:00.000Z", "to": "2026-10-05T14:09:06.825Z", "reason": "before-history"}, {"from": "2026-10-27T19:00:26.439Z", "to": "2026-10-27T19:07:51.150Z", "reason": "not-compared-yet"}], "sentence": "1887 matching changes found up to 2026-10-27T19:00:26.439Z. Part of this period is not known yet, so this may not be everything. Showing the newest 1000.", "refusal": null}`
  `{"ms": 426, "question": "What changed since 17/10?", "status": "partial", "assumed": [], "total": 1107, "shown": 1000, "duplicates": 0, "zeroWidth": 0, "modifiedWithoutFields": 0, "gaps": [{"from": "2026-10-27T19:00:26.439Z", "to": "2026-10-27T19:07:52.079Z", "reason": "not-compared-yet"}], "sentence": "1107 matching changes found up to 2026-10-27T19:00:26.439Z. Part of this period is not known yet, so this may not be everything. Showing the newest 1000.", "refusal": null}`
  `{"ms": 870, "question": "What changed in Azure AD this month?", "status": "partial", "assumed": [], "total": 1453, "shown": 1000, "duplicates": 0, "zeroWidth": 0, "modifiedWithoutFields": 0, "gaps": [{"from": "2026-10-01T00:00:00.000Z", "to": "2026-10-05T14:09:06.825Z", "reason": "before-history"}, {"from": "2026-10-27T19:00:26.439Z", "to": "2026-10-27T19:07:52.505Z", "reason": "not-compared-yet"}], "sentence": "1453 matching changes found up to 2026-10-27T19:00:26.439Z. Part of this period is not known yet, so this may not be everything. Showing the newest 1000.", "refusal": null}`
  `{"ms": 249, "question": "Which admins changed this month?", "status": "partial", "assumed": ["Read “admins” as admin roles and who holds them, in Entra, Intune, Exchange and Defender."], "total": 476, "shown": 476, "duplicates": 0, "zeroWidth": 0, "modifiedWithoutFields": 0, "gaps": [{"from": "2026-10-01T00:00:00.000Z", "to": "2026-10-05T14:09:06.825Z", "reason": "before-history"}, {"from": "2026-10-27T19:00:26.439Z", "to": "2026-10-27T19:07:53.375Z", "reason": "not-compared-yet"}], "sentence": "476 matching changes found up to 2026-10-27T19:00:26.439Z. Part of this period is not known yet, so this may not be everything.", "refusal": null}`
  `{"ms": 264, "question": "What changed between Oct 20 and Oct 25?", "status": "answered", "assumed": [], "total": 396, "shown": 396, "duplicates": 0, "zeroWidth": 0, "modifiedWithoutFields": 0, "gaps": [], "sentence": "396 matching changes found in this period.", "refusal": null}`
  `{"ms": 229, "question": "Which users have changed this month?", "status": "partial", "assumed": [], "total": 104, "shown": 104, "duplicates": 0, "zeroWidth": 0, "modifiedWithoutFields": 0, "gaps": [{"from": "2026-10-01T00:00:00.000Z", "to": "2026-10-05T14:09:19.827Z", "reason": "before-history"}, {"from": "2026-10-27T00:02:33.276Z", "to": "2026-10-27T19:07:53.889Z", "reason": "not-compared-yet"}], "sentence": "104 matching changes found up to 2026-10-27T00:02:33.276Z. Part of this period is not known yet, so this may not be everything.", "refusal": null}`
- **Tenant:** nothing. Read-only against Keel's own database.
- Do, from `/opt/keel-live` with `set -a; . /etc/keel/db.env; set +a` (read-only SELECTs), tenantRef and scope as in K5:
  1. Report the build, its deploy time, and the newest `drift-detect` job (id, status, finished_at).
  2. `SELECT resource_type, same_content, count(*) FROM drift WHERE change_type = 'modified' AND resource_type IN ('roleAssignmentSchedule', 'permissionGrantPolicy') GROUP BY 1, 2 ORDER BY 1, 2;`
     and `SELECT same_content, count(*) FROM drift WHERE change_type = 'modified' GROUP BY 1 ORDER BY 1;`
  3. `SELECT count(*) FROM drift WHERE change_type = 'modified' AND before_payload IS NOT NULL AND before_payload = after_payload AND same_content IS NOT TRUE;` (expect 0).
  4. Run K10's script (same `answerQuestion` call and JSON line per question, with `ms` and `modifiedWithoutFields`) for the same six questions, once.
  5. Report `getOpenDriftCounts` (`status/queries.mjs`) for the tenant, and the same with `before` numbers if you still have them from earlier.
- **Expected:** step 2 shows the 2026-10-17 rows as `same_content = true` (12 permissionGrantPolicy; about 1023 roleAssignmentSchedule,
  less any with a real change), and no `NULL` left for modified rows that have both payloads. Step 3 is 0. Step 4: `modifiedWithoutFields` 0 on
  every question, no timeout, every call under 1500 ms; totals drop by about the hidden rows (K10: 1912 / 1212 / 1471 / 476; controls 396 and 104
  should not change unless new changes arrived).
- **Report:** the outputs and the build. If any `modifiedWithoutFields` is above 0, give 3 sample drift ids and their `resource_type` and
  `same_content`. Change nothing.

### K13: Run K6 and K7 now that their decisions are filled in
- Drafted by the "Live checks for Oct 23–25 merges" thread (2026-10-27). Marouane filled in the K6 and K7 lines under **Operator decisions**.
- Needs: nothing.
- Status: done
- Result: Done 2026-10-27 21:05 UTC: K6 `done` (#565 passes; #563 not demonstrable with this fixture: no follow-up steps opened) and K7 `done` (own check passes, removed, 2 evidence entries). Details in each item.
- Do: run K6 from step 2 (step 1 is done) and then K7 steps 2, 3 and 5, exactly as written in those items and within the decisions' wording.
  Write each item's own `Status` and `Result`. Set this item to `done` when both have a final status.

### K14: Finish Q159 step 4: Defender "Make it pass" enforce on KEEL-RT-mailfix-spam, then put it back (after #548)
- **keelops, 21:40 UTC:** this item and K15 have been `todo` with filled decisions since 20:55 UTC, while K17–K21 ran. Take K14 next, then K15.
  If you can't run one, set it `blocked` and say why in its Result (for example a file you can't read), so it can be routed.
- **Scope: only the 2026-10-27 addendum "finish step 4 only" plus step 5.** Steps 1–3 and the old step 4 dry run are done; do not redo them.
- Moved 2026-10-27 by the "Finish Exchange undo live checks" thread: the root keel-operator has not taken an item since 2026-10-23.
  The text below the line `Copied from` is the root item, verbatim. Where it says keel-operator, read keelops. Where it says the portal
  (behind Access), use the CLI or the engine/API calls the item names, as in K7. If a step needs a file or command your user can't
  read or run (for example writing an `/etc/keel` file), mark the item `blocked` and name it; change nothing else.
  Items it refers to (Q149, Q45) are in `ops/operator-queue.md` on `claude/operator-queue`; read them there.
- If any step fails with "Organization cannot be null", "names another tenant" or "separate Restorer", stop and report the exact message.
- Known bug (#592, not yet live, 2026-10-27 21:17 UTC): a **workload** restore dry run started as a worker job from the Restore page files its
  approval with `executor: 'cli'`, so approving it queues no restore job. Compliance-fix dry runs are not affected. If, after you approve,
  no worker restore job appears within a few minutes, do not enforce by hand: set the item `blocked`, and report the artifact id, the
  approval id and the approval request's `executor`. It will be re-queued once #592 is live.
- Needs: `grep -q workloadPowershellConfigPath /opt/keel-live/cli/keel-restore.mjs`.
- Decision: needs the **K14** line under **Operator decisions** (human only). If it is blank, leave this item `todo`.
- Status: blocked
- Result: blocked (2026-10-27 ~22:00 UTC): the decision names only the approver. Needs check passes (live `f9d302a` has `workloadPowershellConfigPath`). Nothing run, nothing written. (keelops read the decisions at 20:52 UTC, before the K14/K15 lines landed at 20:55; sorry for the gap.) **What keelops can do:** the CLI dry run cannot run as keelops, because it reads with `/etc/keel/exchange-collector.json`, which keelops cannot read (and the enforce uses `exchange-restorer.json`). The portal's route works, though: `portal/lib/compliance-fix.ts` enqueues a worker `restore` job `{complianceFix:{controlId,naturalKey}, collectorConfig, targetConfig, artifactId}`, and the worker runs as root with those files. **What is missing:** approval refuses self-approval (`approveRequest`: approver must differ from requester), and the K14 line only says approve "as my Entra principal". The requester (who presses Make it pass and files the request) is not named; keelops will not pick your Gmail principal on its own. To unblock, add e.g. `K14: … file the dry run and the request as my Gmail principal, approve as my Entra principal` (or the reverse). The content-effect approval is then also by the Entra principal.

Copied from `ops/operator-queue.md` on `claude/operator-queue` (Q159):

- Drafted by the "Fixes for Defender email checks" thread (2026-10-22). Code: PR #543 (merged as a499c2d). New declared writes on the
  `exchange-mail-flow` workload: `mailflow.anti-phish-policy.update` (Set-AntiPhishPolicy), `mailflow.anti-spam-policy.update`
  (Set-HostedContentFilterPolicy), `mailflow.anti-malware-policy.update` (Set-MalwareFilterPolicy), `mailflow.safe-links-policy.update`
  (Set-SafeLinksPolicy). They stay off until a live writer capture is imported. Compliance's Defender email checks then offer
  "Make it pass" per failing setting; the fix is a one-setting workload restore (dry run, approval, content-effect approval, write, read-back).
- Needs: /opt/keel-live at a499c2d or later (`grep -q mailflow.anti-spam-policy /opt/keel-live/engine/restore/workloads/writeDeclarations.mjs`).
- Status (on Q159/Q161, before the move): todo
- Earlier result (keel-operator, on the root queue): blocked (2026-10-22 21:35 UTC) for the enforce in step 4: it waits for **#548** (fixes #542) to deploy (live is 3010d22, `workloadPowershellConfigPath` absent). Steps 1–3 and the step 4 dry run are done. B = **3010d22**. Restorer (Exchange) for writes; Collector for reads; global admin not used.
  1. Fixtures (no rules, apply to nobody; no rule found for any of them): `KEEL-RT-mailfix-spam` guid 839e8b32-… created (PhishSpamAction MoveToJmf, PhishZapEnabled false); `KEEL-RT-mailfix-phish` f56f609e-… created;
     `KEEL-RT-mailfix-malware` 6dd556b7-… created; `KEEL-RT-mailfix-links` f309e049-… created (Safe Links is licensed).
  2. Writer capture: capture exit **0**, `verify --require-live --gate workload-writers-live-acceptance` exit **0**.
     - **Proven** (written, read back, put back): `mailflow.anti-phish-policy.update`, `mailflow.anti-spam-policy.update`, `mailflow.safe-links-policy.update` (plus transport-rule and inbound-connector).
     - **Not proven:** `mailflow.anti-malware-policy.update`, error `Set-MalwareFilterPolicy failed: … CustomFromAddress: The CustomFromAddress value is not set. Custom notifications cannot be enabled without a valid CustomFromAddress.`
       The switch the capture picks needs a sender address.
     - Skipped: outbound connector (no KEEL-RT- object). `needsManualRevert` `[]`, so nothing is left changed.
  3. Evidence: `claude/live-evidence-workload-writers-mailfix` @ 7488c53c, **PR #555** with `automerge`. pseudonymize check exit 0; my scan is clean.
     Import from that checkout: exit 0, `workload-writers-exchange-mail-flow-live-acceptance.json` imported (5 writes, build 3010d22); refused `[]`.
  4. `workload-collect run` (21:33): exchange-mail-flow `complete`, 4 new changes (the four fixtures); `compliance checks: 9 run (5 pass, 4 fail, 0 could not check)`.
     - "Anti-spam policies quarantine phishing" (`keel-custom.defender-email.anti-spam-phish-quarantined`) **fails**, with KEEL-RT-mailfix-spam rows `PhishSpamAction MoveToJmf → expected Quarantine` and `PhishZapEnabled false → expected true` (and the Default policy, which I did not touch).
     - Make it pass, by CLI: `keel-restore --compliance-fix keel-custom.defender-email.anti-spam-phish-quarantined --object 'anti-spam-policy:<guid>#PhishSpamAction'`. Dry run **5776fc9b**: 1 change, `Set-HostedContentFilterPolicy` PhishSpamAction MoveToJmf → Quarantine, and 1 content effect (`irreversible`).
     - **Not approved or enforced:** the worker enforce reconnects with restorer.json (#542) and would fail as in Q149. Run it once #548 is live. (Note: the object key needs the `#<setting>` suffix; the bare key is refused with "does not name a setting this control's fix changes".)
  5. Not needed yet: PhishSpamAction is still MoveToJmf. The four KEEL-RT-mailfix-* policies are left in place, as the item asks.
- **Test tenant only. KEEL-RT- policies only, each with NO rule, so it applies to nobody.** Never change a Default or built-in policy, a
  rule, a CA policy, break-glass or Marouane's account. Restorer for writes, Collector for reads; global admin not used. Under the
  2026-10-14 standing authorization approve the restore and its content effects yourself and log both approval ids. No tenant-wide
  setting is changed.
- Do, from your clone at the deployed commit B, with `KEEL_QUALIFICATION_HMAC_KEY` from `/etc/keel/qualification.env` (never print it)
  and `set -a; . /etc/keel/db.env; set +a`:
  1. **Fixtures** (Exchange Online PowerShell as the Restorer; create only the policy, never a `New-*Rule`). Report each `Name`, `Guid` and
     whether it was created:
     - `New-HostedContentFilterPolicy -Name KEEL-RT-mailfix-spam -PhishSpamAction MoveToJmf -PhishZapEnabled $false`
     - `New-AntiPhishPolicy -Name KEEL-RT-mailfix-phish`
     - `New-MalwareFilterPolicy -Name KEEL-RT-mailfix-malware`
     - `New-SafeLinksPolicy -Name KEEL-RT-mailfix-links -AllowClickThrough $true` (skip and say so if Safe Links is not licensed)
  2. **Writer capture** for `exchange-mail-flow`, as the tool's header documents: `plan --workload exchange-mail-flow` first, then
     `capture --confirm-live-tenant-write --workload exchange-mail-flow ... --out docs/release/qualifications/workload-writers-exchange-mail-flow-live-acceptance.json`
     (all the usual flags, default image, deployed scripts). It flips one harmless switch on each KEEL-RT- policy and puts it back.
     Then `node tools/release/qualification.mjs verify --require-live --gate workload-writers-live-acceptance --evidence <the record>`.
     Report the exit codes, and per new operation `ok`, `readBackVerified`, `restoredToOriginal` and `error` or skip reason.
     Exit 3 means a value may not be back: report object, field and original value.
  3. Commit the record and `.capture.json` to `claude/live-evidence-workload-writers-mailfix` (from origin/master, secret scan and
     `pseudonymize.mjs check` first), open a PR with `automerge`, and run `node cli/keel-workload-collect.mjs import` from that checkout.
     Report the import line for exchange-mail-flow.
  4. **Make it pass, end to end:** `node cli/keel-workload-collect.mjs run` once, then Check now on Compliance (or
     `node cli/keel-compliance-check.mjs` if that is how you run it). Confirm "Anti-spam policies quarantine phishing" fails with
     KEEL-RT-mailfix-spam rows for "Phishing goes to" and "Pulls back delivered phishing". In the portal (or the API), press
     **Make it pass** on the KEEL-RT-mailfix-spam "Phishing goes to" row, give a reason, ask for approval, approve the restore and its
     content effect (quarantine) yourself, and let the worker run it. Report the dry-run artifact id, job ids, approval ids, the
     outcome (`verified` expected) and that only `PhishSpamAction` changed (Get-HostedContentFilterPolicy KEEL-RT-mailfix-spam).
  5. **Put back:** `Set-HostedContentFilterPolicy -Identity <KEEL-RT-mailfix-spam Guid> -PhishSpamAction MoveToJmf` so the fixture keeps
     failing for the next proof. Leave the four KEEL-RT-mailfix-* policies in place (no rule, they apply to nobody).
- **Report:** B; steps 1-5 as above; anything left changed in the tenant.
- **Addendum (2026-10-22 22:05, PR #559):** the anti-malware capture failed only because it flipped `CustomNotifications` (needs a
  CustomFromAddress). After #559 is live (`grep -q "'AdminDisplayName', 'EnableFileFilter'" /opt/keel-live/engine/restore/workloads/writeDeclarations.mjs`),
  re-run step 2 (writer capture for `exchange-mail-flow`; it now writes the description of KEEL-RT-mailfix-malware and puts it back) and
  step 3 (evidence PR plus import), and report `mailflow.anti-malware-policy.update` `ok`, `readBackVerified`, `restoredToOriginal`.
  Then finish step 4 once #548 is live, as already noted.
- **Addendum (2026-10-27, finish step 4 only):** #548 is merged. Needs: `grep -q workloadPowershellConfigPath /opt/keel-live/cli/keel-restore.mjs`
  (if it fails, wait for the deploy; do not set this item blocked). Steps 1–3 and the step 4 dry run are done; do not redo them.
  The Make it pass dry run now also reads with the family collector file. Make a **new** dry run (the old 5776fc9b predates #548),
  then approve the restore and its content effect yourself, let the worker enforce, and do step 5 (put PhishSpamAction back to MoveToJmf).
  Report the dry-run artifact id, the log line `PowerShell connects as the collector with /etc/keel/exchange-collector.json`,
  approval ids, job id, outcome (`verified` expected), the enforce log line naming `/etc/keel/exchange-restorer.json`, and that only
  PhishSpamAction changed. If it fails with "Organization cannot be null", "names another tenant" or "separate Restorer", report the exact message.

### K15: Live re-check of the Exchange undo and the Exchange / Purview Discovery listing (fixes #542, after #548)
- **Scope:** all of Q161 (steps 1–4).
- Moved 2026-10-27 by the "Finish Exchange undo live checks" thread: the root keel-operator has not taken an item since 2026-10-23.
  The text below the line `Copied from` is the root item, verbatim. Where it says keel-operator, read keelops. Where it says the portal
  (behind Access), use the CLI or the engine/API calls the item names, as in K7. If a step needs a file or command your user can't
  read or run (for example writing an `/etc/keel` file), mark the item `blocked` and name it; change nothing else.
  Items it refers to (Q149, Q45) are in `ops/operator-queue.md` on `claude/operator-queue`; read them there.
- If any step fails with "Organization cannot be null", "names another tenant" or "separate Restorer", stop and report the exact message.
- Known bug (#592, not yet live, 2026-10-27 21:17 UTC): a **workload** restore dry run started as a worker job from the Restore page files its
  approval with `executor: 'cli'`, so approving it queues no restore job. Compliance-fix dry runs are not affected. If, after you approve,
  no worker restore job appears within a few minutes, do not enforce by hand: set the item `blocked`, and report the artifact id, the
  approval id and the approval request's `executor`. It will be re-queued once #592 is live.
- Needs: `grep -q workloadPowershellConfigPath /opt/keel-live/cli/keel-restore.mjs`. Run after K14 (both use exchange-restorer.json).
- Decision: needs the **K15** line under **Operator decisions** (human only). If it is blank, leave this item `todo`.
- Status: blocked
- Result: blocked on files keelops cannot read (2026-10-27 ~22:00 UTC). Needs check passes (live `f9d302a`). Nothing run, nothing written. **Step 1** (host check of `/etc/keel/exchange-restorer.json`, `/etc/keel/purview-restorer.json` against every `-collector.json` and tenant.json, and possibly adding `tenantId` to a restorer file) needs read on `exchange-restorer.json`, `purview-restorer.json`, `exchange-collector.json`, `purview-collector.json` and `workload-scope.json` (the last is readable). Editing a root-owned `/etc/keel` file is a root step either way. **Step 2** (`node cli/keel-discover.mjs run --no-store`) connects PowerShell with `exchange-collector.json`, which is unreadable. Step 3 could go through worker jobs, but it depends on step 1. To unblock: root runs step 1 (yes/no answers only) and grants keelops read on the four files plus their cert/key paths, or root's keel-operator runs K15.

Copied from `ops/operator-queue.md` on `claude/operator-queue` (Q161):

- Drafted by the "Exchange and Purview organization missing" thread (2026-10-22). Code: PR #548. Fixture-tested only.
  - **Change:** the workload restore (dry run and enforce) and the Discovery cmdlet listing now connect PowerShell with the family's
    own config, like the collect: `powershellConfigs[family]` for the dry run and Discovery; for the enforce,
    `powershellRestorerConfigs[family]` in `/etc/keel/workload-scope.json` if set, else the collector file's `-restorer.json`
    sibling (`exchange-collector.json` gives `exchange-restorer.json`, `purview-collector.json` gives `purview-restorer.json`).
    Graph still uses `tenant.json` / `restorer.json`. The enforce logs `PowerShell connects as the restorer with <path>`.
- Needs: /opt/keel-live at the #548 merge or later (`grep -q workloadPowershellConfigPath /opt/keel-live/cli/keel-restore.mjs`).
- Status (on Q159/Q161, before the move): todo
- Earlier result (keel-operator, on the root queue): (none)
- **Test tenant only.** Same hard rules and standing approval as Q149: approve the restore yourself and log the approval id.
  Collector for reads, Restorer for the write. Grant nothing. Never touch CA policies, break-glass or Marouane's account.
- **Fixture:** one Exchange transport rule `KEEL-RT-svc-change`, created **disabled**, as in Q149 (condition
  RecipientAddressContainsWords `keel-rt-nobody`, PrependSubject `[KEEL-RT] `, Mode Audit).
- Do, at the deployed build B, from your own checkout (never `/opt/keel`):
  1. **Host check:** report yes/no only (never values): `/etc/keel/exchange-restorer.json` and `/etc/keel/purview-restorer.json`
     exist, are readable by the user the worker runs as, name `organization`, name `tenantId`, and have a different `clientId`,
     `certPath` and `keyPath` from **every** `-collector.json` listed in `powershellConfigs` (#548 now refuses a restorer that shares an app or
     certificate with any family's collector) and from `/etc/keel/tenant.json`. #548 refuses a restorer file
     with no `tenantId`: if one has none, copy it to `<file>.bak-q161` (same owner and mode), add `tenantId` with the value
     `/etc/keel/tenant.json` holds, keep owner and mode, and report it (undo: restore the `.bak-q161`). If
     `exchange-restorer.json` is missing, stop and report.
  2. **Discovery:** `node cli/keel-discover.mjs run --no-store --versions v1.0` (and the default stored run if cheap). Expect
     `PowerShell ExchangeOnlineManagement: listed N Get cmdlets.` (no "Organization cannot be null"). Report the PowerShell lines verbatim.
  3. **Undo (the Q149 step that failed):** create the fixture (Mode Audit), collect, accept the `added` row as in Q149 step 2.
     Set Mode `Enforce`, collect, note the `modified` row's `previous_collection_id`.
     Dry run **without** `--collector-config`:
     `node cli/keel-restore.mjs --workload exchange-mail-flow --collection <previous_collection_id> --target transport-rule:KEEL-RT-svc-change --persist-artifact <uuid>`.
     Expect `1 change(s)`: `Set-TransportRule` Mode Enforce to Audit, and the log line `PowerShell connects as the collector with /etc/keel/exchange-collector.json`.
     Approve (log the id) and let the worker enforce. Expect outcome `verified`, the log line naming `/etc/keel/exchange-restorer.json`,
     and the live rule at Mode Audit. Collect: no new row for the rule; its alert `resolved`.
  4. Cleanup: delete the rule; collect; accept the `removed` row; collect again: 0 changes.
- **Report:** B; step 1 yes/no; step 2 lines; step 3 artifact, approval and job ids, the job outcome and the two log lines; what is left in the tenant.
  If any step fails with "Organization cannot be null", "names another tenant" or "separate Restorer", file an issue with the exact message.

### K16: Read the publishing status of the KEEL-RT- retention and DLP fixtures (#339 leftovers, read-only)
- Drafted by the "Clear stale consent policy evidence" thread (2026-10-27). #339's code fixes are live-proven (Q93, #348); what is
  left is Microsoft refusing to publish the two Purview fixtures. If both now read `Success`, a later item recaptures
  purview-retention-dlp.
- Needs: nothing.
- Status: blocked
- Result: blocked on `/etc/keel/purview-collector.json` (2026-10-27 ~20:55 UTC): not readable by keelops (not among the 8 files granted in Q175). The Purview PowerShell read needs it. Build `74f18b8`. Nothing run, nothing changed. To unblock: root grants keelops read on purview-collector.json (and its certificate/key files) — listed in ~/agent-src/ROOT-STEPS.md.
- **Tenant:** Collector reads only. Nothing is written, nothing is granted.
- Do, with the Collector's Purview PowerShell config (`/etc/keel/purview-collector.json`, the one the purview-retention-dlp
  collect uses; never print its contents):
  1. `Get-RetentionCompliancePolicy -Identity KEEL-RT-retention -DistributionDetail | Format-List Name,Enabled,Mode,DistributionStatus,DistributionResults,WhenChanged`
  2. `Get-DlpCompliancePolicy -Identity KEEL-RT-dlp -DistributionDetail | Format-List Name,Enabled,Mode,DistributionStatus,DistributionResults,WhenChanged`
  If a policy is not found, try a prefix match (`Get-RetentionCompliancePolicy | Where-Object Name -like 'KEEL-RT-*'`, same for DLP)
  and report what exists.
- **Expected:** `DistributionStatus` for each (`Success`, `Pending` or `Error`).
- **Report:** the build, both outputs (names only for `KEEL-RT-` objects), and any error verbatim. If either is `Error`, quote its
  `DistributionResults` text.

### K17: Report the latest SharePoint site permission and site grant read results (#264 follow-on, read-only)
- Drafted by the "Clear stale consent policy evidence" thread (2026-10-27). The `sharepoint-site-permissions` and
  `sharepoint-site-grants` reads have no live record: they are absent from every evidence import since Q103. We need to know whether
  they run at all and, if so, what they return.
- Needs: nothing.
- Status: done
- Result: Done (2026-10-27 ~21:00 UTC). Build `74f18b8`. Read-only SELECTs in `READ ONLY` transactions, /etc/keel/db.env. **1.** Newest `sharepoint-site-settings` run `d8c8ac99-b346-4cc9-9a24-c7855e122502`, outcome `complete`, observed_to 2026-10-27T16:29:11.776Z (from keelops's K9 workload-collect). Its digest has only `reasons` `[]`, `fieldCounts` `{"observed":145}`, `discovery` `{"pages":1,"sites":20,"capped":false,"status":"observed","maxSites":500}`, `outOfScope` (24 entries), `tenantHost`; **no per-operation entries** (no status, HTTP status or count per operation in the digest). From its `workload_observation.field_coverage`, per operation: `sharepoint.site-permissions` observed on 20 (one per site; 20 site objects), `sharepoint.site-properties` observed 120, `sharepoint.site-sharing` observed 19 + unknown 1, `sharepoint.tenant-settings` observed 5, plus 80 coverage entries with no operation and status `unknown`. No site **grants** operation appears at all. So the site permission read runs nightly inside sharepoint-site-settings and is observed; the site-grants read does not run. **2.** No rows (no workload named like site-perm or site-grant). **3.** `workload_ledger_evidence`: `sharepoint.site-permissions.update` live-write-capture ok true, read_back_verified true, 2026-10-15T14:06:51.505Z · `sharepoint.site-permissions.add` live-write-capture ok true, rbv true, 14:06:51.267Z · `sharepoint.site-permissions` live-capture ok true (rbv null) on 2026-10-15T14:06:51.109Z, 10-14T18:58:57.417Z, 10-14T14:24:52.334Z, 10-07T11:09:29.790Z; error null on all. Nothing for site-grants. **4.** Jobs naming them (all `restore`, workload sharepoint-site-permissions, 2026-10-15): `ab80f821` succeeded 15:29:30; `1e12df5f` failed 15:29:14, `Error: SharePoint site groups and permissions restore stale: the site permissions changed since the dry run; a new dry run is required`; `2334e1ac` 14:09:55, `33a9852e` 14:09:32 and `67ccac3e` 14:08:35 failed `Error: ENOENT: no such file or directory, open '/etc/keel/tenant-target.json'`. None since 10-15. Nothing written; no secret in any output.
- **Tenant:** nothing. Database reads only.
- Do, from `/opt/keel-live` with `set -a; . /etc/keel/db.env; set +a` (read-only SELECTs, in a `READ ONLY` transaction):
  1. Newest `sharepoint-site-settings` run and what its site permission read returned:
     `SELECT id, outcome, observed_to, digest FROM workload_collection WHERE workload = 'sharepoint-site-settings' ORDER BY created_at DESC LIMIT 1;`
     Report the outcome and the digest entries for `sharepoint.site-permissions` (and any site grants operation): status, HTTP status,
     item count and reason. Do not paste the whole digest if it is large.
  2. Every workload run name the database knows that mentions site permissions or grants:
     `SELECT workload, outcome, max(created_at) FROM workload_collection WHERE workload ILIKE '%site-perm%' OR workload ILIKE '%site-grant%' GROUP BY 1, 2;`
  3. Their evidence rows: `SELECT operation_id, kind, ok, read_back_verified, captured_at, error FROM workload_ledger_evidence WHERE operation_id ILIKE '%site-perm%' OR operation_id ILIKE '%site-grant%' ORDER BY captured_at DESC;`
  4. The newest jobs that name them: `SELECT id, kind, status, created_at, error FROM job WHERE params::text ILIKE '%sharepoint-site-permissions%' OR params::text ILIKE '%sharepoint-site-grants%' ORDER BY created_at DESC LIMIT 5;`
- **Expected:** either a run with an outcome and reasons, or no rows (the reads never ran).
- **Report:** the build and each step's rows (or "no rows"). Name any reason or error verbatim. Never print a secret.

### K18: Confirm the consent policy update reads live-qualified after the stale demotion was removed (#294, read-only)
- Drafted by the "Clear stale consent policy evidence" thread (2026-10-27). Commit `03f8c51b` on `claude/live-evidence-w2-entra`
  removed `permissionGrantPolicy.update.demotion.json` (Q67); the passing Q79 record supersedes it. Only the signing key can show the
  record verifies, and builders don't have it.
- Needs: nothing.
- Status: blocked
- Result: blocked on `/etc/keel/qualification.env` (2026-10-27 ~20:55 UTC): not readable by keelops (deliberately not granted per keelops CLAUDE.md). The verify needs `KEEL_QUALIFICATION_HMAC_KEY` from it. Build `74f18b8`. Nothing run, nothing changed. To unblock: the operator grants keelops read on qualification.env, or root's keel-operator runs this item.
- **Tenant:** nothing. Host read only.
- Do, from your own checkout at the deployed build B (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` from
  `/etc/keel/qualification.env` (never print it):
  1. `git fetch origin claude/live-evidence-w2-entra` and export its `docs/release/qualifications/entra-live` into a scratch dir
     (for example `git archive origin/claude/live-evidence-w2-entra docs/release/qualifications/entra-live | tar -x -C <tmp>`).
  2. `node tools/qualification/operations.mjs --live-evidence <tmp>/docs/release/qualifications/entra-live 2>&1 | grep permissionGrantPolicy`
- **Expected:** `permissionGrantPolicy.create.json: fixture-tested -> live-qualified` and
  `permissionGrantPolicy.update.json: fixture-tested -> live-qualified`.
- **Report:** B, the evidence branch commit, and the two lines verbatim. If either says `not applied`, quote the reason.

### K19: Confirm both SharePoint site permission reads run (follow-up to K17, read-only)
- Drafted by the "Get SharePoint site grants read running" thread (2026-10-27). K17 read "no site grants operation" as "the site
  grants read never runs". It does run: the site **app grants** read is the operation `sharepoint.site-permissions` inside
  `sharepoint-site-settings` (K17 saw it observed on 20 sites). `sharepoint-site-grants` is only the name of the restore that writes
  those grants back. The other restore, `sharepoint-site-permissions` (groups, members, admins, levels, role assignments), reads from
  the nightly **content** backup (`sharepoint-sites`), item key `site/permissions`, which K17 did not look at. This item checks both.
- Needs: nothing.
- Status: done
- Result: GREEN (2026-10-27 ~21:15 UTC). Build `1e7d51a`. Read-only SELECTs in `READ ONLY` transactions, /etc/keel/db.env. Both reads run. (Correction to K17: its "the site-grants read does not run" was wrong. The app grants read is `sharepoint.site-permissions`, as this item says.) **1.** Newest settings run `d8c8ac99-b346-4cc9-9a24-c7855e122502` `complete`, observed_to 2026-10-27T16:29:11.776Z; `field_coverage` entries with operation `sharepoint.site-permissions`: **20, all `observed`**. **2.** `sharepoint-sites` content runs: `succeeded`, items 0, reasons [], 2026-10-27T01:06:09.014Z · `succeeded`, 43, [], 2026-10-26T01:06:26.691Z · `succeeded`, 0, [], 2026-10-25T01:06:27.522Z. The newest is within the last day. **3.** `content_item` `site/permissions`: sites **20**, versions 25, newest 2026-10-23T01:48:05.072Z (stored only on change; no change since 10-23). The REST transport is present; nothing reports `site-groups-and-user-permissions` missing. Nothing written; no errors.
- **Tenant:** nothing. Database reads only, the same kind of read-only SELECTs as K17, each in a `READ ONLY` transaction.
- Do, from `/opt/keel-live` with `set -a; . /etc/keel/db.env; set +a`:
  1. App grants in the newest settings run: `SELECT c.id, c.outcome, c.observed_to FROM workload_collection c WHERE c.workload = 'sharepoint-site-settings' ORDER BY c.created_at DESC LIMIT 1;`
     then report, from that run's `workload_observation.field_coverage`, how many entries have operation `sharepoint.site-permissions` and their statuses (as in K17).
  2. Newest content runs for sites: `SELECT outcome, items, reasons, completed_at FROM content_run WHERE workload = 'sharepoint-sites' ORDER BY completed_at DESC LIMIT 3;`
  3. Site groups and permissions stored by the content backup (stored only when they change):
     `SELECT count(DISTINCT container) AS sites, count(*) AS versions, max(created_at) AS newest FROM content_item WHERE workload = 'sharepoint-sites' AND item_key = 'site/permissions';`
- **Expected:** 1. 20 entries, all `observed`. 2. `succeeded` runs within the last day. 3. `sites` > 0 (about 20) with a `newest` date.
  If 3 has 0 rows, the content backup has no SharePoint REST transport (the Collector certificate is not in the content config) and
  says `site-groups-and-user-permissions` is missing; report that.
- **Report:** the build and each step's rows. Name any reason or error verbatim. Never print a secret.

### K20: Recapture the SharePoint site app grant and site permissions writer records (Q77 and Q80 again, before 2026-11-14)
- Drafted by the "Merge SharePoint restore proof before it expires" thread (2026-10-27). The Q77 and Q80 records (2026-10-15) land on
  master through PR #591, but they pass the 30-day limit on 2026-11-14, after which both restores (`sharepoint-site-grants`, 5 writes of
  `sharepoint-site-permissions`) stop being live-qualified. This item takes fresh records so they stay qualified past that date.
- Needs: PR #591 merged (`git cat-file -e origin/master:docs/release/qualifications/sharepoint-site-grants-live-acceptance.json`).
- **Tenant:** captures only, no restore round trip, so no approval is filed. Same fixtures and limits as Q77 and Q80 on
  `claude/operator-queue` (read those items for the full flags):
  - Q77 fixture exception: the existing `KEEL-RT-site-grant-app` (no API permissions, no secret, kept for this recapture) gets a
    Sites.Selected grant on the `KEEL-RT-20261004` site only, then you delete that grant. Never Keel's own apps, never another site.
  - Q80: the capture creates `KEEL-RT-perm-1 level` and `KEEL-RT-perm-1 group` on `KEEL-RT-20261004`, with one `keel-rt-*` test user
    that is not a site collection admin, and a `KEEL-RT-perm-list` with broken inheritance. Delete them all afterwards.
  - Covered by Marouane's standing authorization for test-tenant captures and KEEL-RT- fixtures (2026-10-14, 2026-10-16). No new
    permission for Keel's apps; if SharePoint or Graph refuses a write (401/403), report blocked with the status and path.
- Do, at the deployed build B, from your own checkout at B (never `/opt/keel`), with `KEEL_QUALIFICATION_HMAC_KEY` set:
  1. **Site grants:** make sure `KEEL-RT-site-grant-app` holds no grant on the site (recreate the app as in Q77 step 1 if it is gone).
     `node tools/qualification/sharepointSiteGrantsLive.mjs plan ...`, then `capture --confirm-live-tenant-write` with the Q77 step 2
     flags, `--build B`, `--out docs/release/qualifications/sharepoint-site-grants-live-acceptance.json`. Then delete the app's grant.
  2. **Site permissions:** create `KEEL-RT-perm-list` and break its inheritance (copy role assignments). Mint the two SharePoint tokens
     as Q80 step 1 (never printed). `node tools/qualification/sharepointSitePermissionsLive.mjs plan ...` (expect 7 writes), then
     `capture --confirm-live-tenant-write` with the Q80 step 2 flags, `--build B`,
     `--out docs/release/qualifications/sharepoint-site-permissions-live-acceptance.json`. Then do the Q80 step 8 cleanup.
  3. **Evidence:** secret scan and `node tools/qualification/pseudonymize.mjs check` on all four files, commit the two records and
     their `.capture.json` on `claude/live-evidence-sharepoint-recapture` from `origin/master`, open a PR with the `automerge` label.
  4. **Import:** `node cli/keel-workload-collect.mjs import --dir <that checkout>/docs/release/qualifications` (DB env loaded).
- Status: blocked
- Result: blocked on `/etc/keel/qualification.env` (2026-10-27 ~21:36 UTC): both captures need `KEEL_QUALIFICATION_HMAC_KEY`, and keelops cannot read that file (withheld on purpose; only on the operator's explicit say-so). Needs check passes (PR #591 on master). Build `d40bc9c`. Nothing run; no fixture touched; nothing written. To unblock: the operator grants keelops read on qualification.env, or root's keel-operator runs this item. Deadline in the item: before 2026-11-14.
- **Expected:** both captures exit 0 with verify ok and failures []; every write ok with readBackVerified true; import lines
  `sharepoint-site-grants-live-acceptance.json` imported (writes 2) and `sharepoint-site-permissions-live-acceptance.json` imported
  (writes 5), refused []; nothing left on the site but the kept `KEEL-RT-site-grant-app` (with no grant).
- **Report:** B; per capture the exit code, verify output and per-write ok/readBackVerified; the evidence commit and PR; the import
  lines; anything left in the tenant. Never print a secret.

### K21: Live check that a later restore replaces stacked follow-up steps (#563, after K6)
- Drafted by the "Prove follow-up steps fix live" thread (2026-10-27). K6 could not show #563: an in-place app update opens no
  follow-up steps. A **soft-delete restore** of an application always opens one step (`service-validation` / `signIn`, "Confirm a
  real sign-in or token request succeeds", `engine/restore/completion.mjs` `COMPLETION_RULES.application.validation`) with the
  natural key `application:<appId>`, and the appId is kept by a soft-delete restore. So two delete-and-restore rounds of the same
  app from the same snapshot open the same step twice: the first restore's step must read `replacedBy` = the second restore and
  drop out of the counts. No credentials, permissions or consent are needed.
- Needs: /opt/keel-live at the #563 merge or later (`grep -q countOpenCompletionSteps /opt/keel-live/engine/restore/completion.mjs`), and the K21 decision below filled in.
- Status: in-progress
- **Tenant:** standing authorization (2026-10-14) for test-tenant restores: self-approve and log each approval id. Restorer
  (`/etc/keel/restorer.json`) writes only the fixture below; Collector reads. **No API permissions, no secret or certificate, never
  admin consent**, no service principal. No CA, no break-glass, not Marouane's account. Never purge the fixture until step 6.
- **Fixture:** app registration `KEEL-RT-app-steps` (AzureADMyOrg, no redirect URI, no credentials, empty `requiredResourceAccess`).
- Do, at the deployed build B, from your own checkout at B (as in K6):
  1. **Before** (read-only): `countOpenCompletionSteps(c,{tenantRef})`, the length of `listOpenCompletionWork(c,{tenantRef,limit:500})`,
     and `SELECT count(*) FROM recovery_completion_item WHERE tenant_ref = $1 AND state = 'pending'`. (K6 read 93 / 28 / 93.)
  2. Create the fixture. Wait for the next hourly Tier 1 snapshot S (do not run the collector by hand unless none ran in 2 hours)
     and confirm S holds `application:<its appId>` named `KEEL-RT-app-steps`.
  3. **Round 1:** delete the app (soft delete only; it must show under `/directory/deletedItems/microsoft.graph.application`).
     Dry run `node cli/keel-restore.mjs --snapshot-id <S> --select application:<appId> --collector-config /etc/keel/tenant.json --target-config /etc/keel/restorer.json --persist-artifact <uuid R1>`.
     Report status, guard refusals and the mechanism (expect `soft-delete-restore`, id retained, a deadline about 30 days out).
     If a dependency such as a domain is pulled in, check it equals S as in K6 before approving. If the mechanism is anything other
     than `soft-delete-restore` or `none` for that dependency, stop and report (do not approve a `recreate`).
     Approve (Entra principal requests, Gmail principal approves), then `keel-restore --artifact <R1> --enforce`. Report the exit code,
     the journal, and the log line `completion: N item(s) open`. Read back: app live, same object id and appId, name `KEEL-RT-app-steps`.
  4. **Round 2:** repeat step 3 exactly with a new artifact R2 (delete again, dry run from the same S, approve, enforce, read back).
  5. **Check #563** (read-only):
     - `listCompletionItems(c,{tenantRef,restoreRef:R1})` and `(…R2)`: each has the `service-validation` / `signIn` step for
       `application:<appId>`, both `pending`. **Expect R1's `replacedBy` = R2 and R2's `replacedBy` = null.**
     - The three counts from step 1 again. **Expect:** raw pending = before + 2; `countOpenCompletionSteps` = before + 1;
       open-work list = before + 1, and it contains R2 but not R1.
     - If the portal is reachable from the host: the Overview "waiting" count equals `countOpenCompletionSteps`. Say if not checked.
  6. **Cleanup:** delete the app and purge it from deleted items. Close both steps with `completeItem` as Marouane's Entra principal,
     evidence `{ type: 'attestation', reference: 'keelops-queue K21: KEEL-RT-app-steps test fixture, deleted and purged', note: 'test fixture for #563; no service to check' }`
     (R1's step can be closed even though it is replaced). Then the counts once more: expect back to the step 1 values.
     Collect, and report no `KEEL-RT-app-steps` live, in deleted items, or as a service principal.
- **Expected:** both restores exit 0 as `soft-delete-restore`; R1's step `replacedBy` R2; the open count rises by 1 for 2 restores;
  after cleanup the counts are back to the step 1 values and nothing is left in the tenant.
  If a write or approval refuses, quote it verbatim and stop (clean up the fixture, change nothing else).
- **Report:** B, S, R1, R2, approval ids, every count, both `listCompletionItems` outputs (ids, kind, requirement, state, replacedBy),
  the closed item ids, and what is left in the tenant. Never print a secret.

### K22: Run K14 now that its decision names the requester
- Drafted by the "Finish Exchange undo live checks" thread (2026-10-27). Marouane added the K14 line at 22:27 UTC: file the Make it pass dry run
  and request as his Gmail principal, approve it and its content effect as his Entra principal.
- Needs: nothing.
- Status: todo
- Result:
- Do: run K14 as written (the newer K14 line under **Operator decisions** applies), through the portal's worker route you described in its Result.
  Write K14's own `Status` and `Result`. Set this item to `done` when K14 has a final status. K15 stays with root's keel-operator.

## Operator decisions (human operator only)

Write `yes`, `no` or your instructions after each one. If a decision is blank, every item that needs it stays untouched.

K6: yes, keelops may create KEEL-RT-app-perms and file and approve its restores as my Entra/Gmail principals.
K7: yes, use my portal principal.
K14: yes, keelops may run the Make it pass restore on KEEL-RT-mailfix-spam and approve it and its content effect as my Entra principal.
K15: yes, keelops may create, change and delete the disabled KEEL-RT-svc-change transport rule and approve its restores as my Entra principal.
K21: yes, keelops may create, delete, restore and purge KEEL-RT-app-steps, file and approve its restores as my Entra/Gmail principals, and close its follow-up steps as my Entra principal.
K14: yes, keelops may file the Make it pass dry run and request on KEEL-RT-mailfix-spam as my Gmail principal, and approve it and its content effect as my Entra principal.

