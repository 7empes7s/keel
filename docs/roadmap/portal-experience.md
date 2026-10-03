# Portal experience contract

Date: 2026-10-03 UTC. Status: authoritative for every portal task from this date.
Supersedes Global Constraint 9 in `COMPLETE-ROADMAP-PLAN.md` and any per-task UI
instruction that conflicts with it, including task-54's capability matrix layout.

## Why this exists

The 2026-10-03 review found the portal technically honest and visually competent
but written for its builders. An administrator opening Policies saw identifiers
that meant nothing to them. Coverage was a 52-row, 11-column evidence taxonomy.
Approvals described the thing to be approved as an action code and a JSON blob.
Jobs used a UUID as the page subtitle. Every success state was hedged. The data to
do better already exists in the readers; the portal simply rendered rows instead
of answers.

Two readers must be served by the same page, in this order:

1. **The executive glance.** Someone who does not know KEEL's vocabulary must read
   the first screen of any page and know, in one sentence, whether things are fine
   and what, if anything, needs a decision.
2. **The technical record.** An engineer or auditor must be able to open the
   details of any object and find every identifier, hash, timestamp and raw
   parameter, each labelled with what it is and where it is used.

Neither reader may be served at the other's expense. Honesty is kept in full; it
moves from the headline into the record.

## The three layers

Every page and every object card is built in three layers, top to bottom. A
layer may be omitted only when it would be empty.

| Layer | Who it is for | What it contains | Markup |
|---|---|---|---|
| Verdict | Executive | One plain sentence of at most 25 words answering the page's question, one tone (good / attention / critical), the one number that matters, and at most one primary action. | `[data-layer="verdict"]` |
| Explanation | Operator | The named things behind the verdict: what changed, who did it, when, what happens next. Names, counts, relative times, badges. Secondary actions. | `[data-layer="explanation"]` |
| Record | Engineer / auditor | Identifiers, hashes, sequence numbers, raw parameters, raw results, endpoints, evidence provenance, CLI equivalents. Collapsed by default under a disclosure titled "Technical details". | `[data-layer="record"]` |

The verdict and explanation layers must fit a 1440 by 900 viewport without
scrolling on every page in the UI harness. On a 390-wide phone the verdict alone
must fit the first screen.

## Identification rules

These rules exist because an administrator was shown policy identifiers with no
meaning. They apply to every object KEEL has: policy, principal, role grant,
approval request, job, baseline, snapshot, drift record, disposition, evidence
record, dry-run artifact, channel, subscription, destination, schedule.

1. **Name first, always.** Every object is referred to by its human name wherever
   it appears outside the record layer. Objects with a name column (`policy.name`,
   `baseline.label`, `principal.display_name` or `email`, `channel` name) use it.
   Objects without one get a generated sentence from their own fields:
   - Job: `Backed up Tier 1 · 412 resources` / `Dry run of restore from the
     2 Oct 09:12 snapshot` / `Rolled back 3 drifted resources`. Built from `kind`,
     `params` and `result`, never shown as `backup` or `restore-dry-run`.
   - Approval request: `Restore 12 resources from the 2 Oct 09:12 snapshot,
     including 2 Conditional Access policies` / `Activate baseline
     "Post-migration golden state"`. Built from `action` and `params` resolved to
     names.
   - Evidence record: `Marouane approved a restore request` / `Collection of
     142 types finished with 4,812 items`. Built from `kind`, `actor` and
     `subject`.
   - Drift record: `Block legacy auth (Conditional Access policy) was modified`.
     The natural key is split into its type and display name; the raw key goes
     in the record layer.
   - Role grant: `Admin since 1 Sep 2026` not `g-01 · admin · 2026-09-01T00:00:00Z`.
2. **References resolve to names.** A field that holds another object's
   identifier (`policy.run_as_principal_id`, `approval_request.params.baselineId`,
   `job.params.artifactId`, `drift.baseline_id`) renders as that object's name,
   linked to its page. Readers in `portal/lib` return a `Ref` for every such field:

   ```ts
   interface Ref { kind: string; id: string; name: string; href: string | null }
   ```

   A `Ref` whose target cannot be read renders its kind and a short id with the
   words "no longer readable", never a bare UUID. Resolution happens server-side
   in the reader, in one query per page, never per row.
3. **Identifiers live in the record layer only**, and each one carries three
   things: its kind in words ("Policy ID", "Job ID", "Evidence sequence"), a
   copy affordance, and where it is accepted ("use with `keel-policy-evaluate
   --policy <id>`", "`GET /api/jobs/<id>`"). A short form (first 8 characters)
   may appear in the explanation layer only as a disambiguator between two
   objects with the same name, suffixed to the name.
4. **No enum values on screen.** Stored enum strings (`auto_remediate`,
   `dispose-accept`, `restore-dry-run`, `access-affecting`, `require_approval`,
   `drift.detected`) are rendered through one display map in
   `portal/lib/presentation.ts`. A value missing from the map renders as its
   words with hyphens and underscores replaced and a test fails.
5. **One time per fact.** A timestamp is shown once per card, as a relative age
   with the absolute UTC time in a `title` and in the record layer. "Set at" and
   "Age" columns side by side are not allowed.
6. **Status is a sentence, not a chip beside a chip.** "Running, 2 minutes in"
   rather than `RUNNING` beside `queued` beside a heartbeat timestamp. Chips may
   accompany the sentence in tables.

### Worked example: a policy

As rendered on 2026-10-03:

```
Auto-accept cosmetic drift
STATUS            Enabled YES · Paused at Not paused · Run-as repair required NO · Run-as principal 3f9c2b1e-…
ACTION AND LIMITS Action dispose-accept · Maximum blast radius cosmetic · Rate limit 50 actions / 3600 seconds
MATCH CONDITIONS  Resource type Any · Blast radius match cosmetic · Natural key glob Any · Change type modified
RECORD            Policy ID 7a1d… · Created by … · Created at 2026-09-12T08:00:00Z
Banner: "Automation kill switch inactive"
```

As required by this contract:

```
Verdict      Auto-accept cosmetic drift · Running
             Accepts cosmetic changes to any resource automatically, up to 50 an hour,
             acting as svc-policy@contoso.com. Last acted 2 hours ago on the named
             location "Branch offices".                                   [Pause]
Explanation  What it matches: modified resources of any type whose change is cosmetic.
             What it may do: accept the change without asking. Never touches anything
             rated access-affecting or tenant-lockout.
             Limits: 50 actions an hour, then it pauses itself until an operator resumes it.
             History: 14 actions this week · [View actions]
Record       ▸ Technical details
               Policy ID        7a1d0f3e-…  [copy]   keel-policy-evaluate --policy 7a1d0f3e-…
               Run-as principal svc-policy@contoso.com · Principal ID 3f9c2b1e-… [copy]
               Action code      dispose-accept · Max blast radius cosmetic
               Match            resource_type=any · blast_radius=cosmetic · natural_key_glob=* · change_type=modified
               Created          2026-09-12T08:00:00Z by marouanedefili@gmail.com
Page banner  "Automation is on." / "Automation halted since 09:40 by the kill switch at /etc/keel/…"
```

The same transformation applies to every object listed above. Task-130 carries
the per-object specifications.

### Object names and records (task-130)

Each object's generated name or sentence, and what its "Technical details"
record holds. The sentences come from `portal/lib/sentences.ts` and the page
components named here, so every page words them the same way.

| Object | Name or sentence outside the record | Record fields |
| --- | --- | --- |
| Policy (`policy-state.tsx`) | `policy.name`; "Rolls back cosmetic changes to any resource automatically, up to 50 an hour, acting as Policy service."; state ("Running", "Paused 2 hours ago after reaching its limit", "Turned off"); last action and actions this week | Policy ID (with CLI and API use), run-as principal ID, action code and maximum impact code, match fields, rate limit in seconds, raw state, last action, created by and when |
| Person (`principal-details.tsx`) | display name or email; "Can approve, restore and 3 more"; each grant as "Admin since 1 Sep 2026" | Principal ID (with API use), effective capabilities, disabled at, each grant's ID with its role code and active range |
| Approval request (`approval-inbox.tsx`) | "Restore 12 resources from the snapshot of 2 Oct 2026, 09:12 UTC" / "Activate baseline “Post-migration golden state”" / "Roll back 3 changes, including Finance (group)"; requester and decider by name; reason; worst impact; expiry in words; link to the dry run or baseline | Request ID, action code, params JSON, requester and decider principal IDs, dry run, baseline and change IDs, raw status, created, decided and expiry times |
| Job (`job-table.tsx`, `job-detail.tsx`) | "Backup of Tier 1" / "Restore of 12 resources from the snapshot of …" / "Roll back of 1 change, including Finance (group)"; status as a sentence ("Finished 3 minutes ago after 2 minutes"); requester by name; "What went wrong" only when there is an error | Job ID (with API use), kind and status codes, requester principal ID, times, params and result JSON, full error, worker ID, heartbeat, idempotency key, dry run ID |
| Audit-record entry (`activity-timeline.tsx`) | "ops@contoso.com asked for approval: restore"; actor by name; age | Evidence sequence, kind code, actor, occurred at, subject JSON; the integrity note's record holds the verification result, the anchored sequence and the CLI it was checked with |
| Baseline (`baseline-register.tsx`) | label and description; set by name, one relative time; state in words | Baseline ID (with API use), set at, set-by principal ID |
| Channel, rule, sent alert (`notification-console.tsx`) | "Webhook to hooks.contoso.com" / "Email to secops@contoso.com"; "Sends every change alert rated critical or above to …"; sent alerts as sentences | Channel ID and config JSON; subscription ID, channel ID, pattern and severity codes; delivery ID, channel ID, event and status codes, next attempt |
| Destination (`integration-console.tsx`) | `destination.name`; kind and target in words ("CEF over HTTPS to siem.contoso.com"); status in plain words | Destination ID, kind code, config JSON (with the credential reference), created by and when, delivery checkpoint, held-back event ID |

A reference whose target cannot be read renders "<Kind> <short id> (no longer
readable)". Resolution runs in `engine/govern/references.mjs`, with one query per
reference kind per page.

## Vocabulary

Words permitted outside the record layer: backup, snapshot, baseline, change
(for drift), restore, dry run, approval, undo, evidence, protected, verified,
schedule, policy, job, principal (only on the Principals page; elsewhere
"person" or "account"), tier (only beside its plain meaning: "Tier 1, the
critical settings").

Words that must not appear outside the record layer, with the replacement to
use:

| Internal term | On screen |
|---|---|
| natural key | the resource's name, with its type in words |
| disposition | decision (accept / ignore / roll back) |
| fidelity, fidelity evidence | "restore proven on <date>" or "restore not yet proven" |
| qualification, qualified, live-qualified, fixture-tested | "proven on this tenant" / "not yet proven on this tenant" |
| capability (authz) | "what you can do here" / "you can approve, restore" |
| capability (coverage) | "can be backed up / restored / recreated" |
| closure, dependency-closed | "and everything it depends on" |
| projection, field class, irrecoverable fields | "fields Microsoft sets itself and KEEL cannot restore" |
| blast radius | "impact: could lock out admins / affects access / cosmetic" |
| guard refusal | "KEEL refused to change X because …" |
| wave, verb | omitted; "order" and "update / create / delete" if needed |
| artifact, dry-run artifact | "the plan" / "the dry run" |
| promotion, enforce | "run the restore" |
| compensation | "undo" |
| observation, observation window | "collected at" / "collected between" |
| descriptor, adapter, serving adapter | "collector" |
| catalog type | "configuration type" |
| evidence chain, anchor, checkpoint | "audit record intact / verified against an external copy" |
| kill switch inactive | "automation is on" |
| tenant_ref, CIR, symbol, lineage | record layer only |
| Postgres, worker, heartbeat, run-as repair | record layer only |

A banned word in the verdict or explanation layer is a test failure (see
"Mechanical checks").

## Information architecture

Seven entries, one map. The page eyebrow is the nav group it sits in and nothing
else; the two taxonomies in force on 2026-10-03 (nav "Posture" / eyebrow
"Governance" for the same page) are retired.

| Nav entry | Absorbs | Page question |
|---|---|---|
| Overview | Dashboard, coverage summary | Is this tenant protected right now, and what needs me? |
| Protect | Backups, Schedules, per-type coverage drawer | Is everything being backed up, and how often? |
| Changes | Drift, Baselines (as a tab) | What changed since the baseline, and what do I do about it? |
| Restore | Restore wizard, undo, recovery completion | Put these things back. |
| Approvals | Approval inbox, decision history | What is waiting on my decision? |
| Activity | Jobs, Evidence, notification deliveries (as one timeline) | What has KEEL done, and who decided what? |
| Settings | Policies, Principals, Notification channels, Integrations (as tabs) | How is KEEL configured, and who can use it? |

Pages that later tasks add (resilience, setup, alerts, benchmarks, readiness,
reports, ask) join one of these seven or justify an eighth in their task text;
the index never grows past eight.

## The memorable number

Overview leads with one sentence an executive can repeat, computed from real
readers and honest when the data is absent:

- When a drill or live restore has succeeded: "KEEL can restore 48 of 52
  configuration types today. Last proven restore: 20 Sept 2026."
- When none has: "KEEL backs up 52 configuration types. No restore has been
  proven on this tenant yet." with the primary action leading to the drill.
- When collection is failing or stale: "3 configuration types have not been
  backed up since <time>." with the primary action leading to Protect.

The dashboard's healthy state is "Protected" with the sentence above, not "No
issues detected". The hedge belongs in the record: "Checked: baseline, last
collection, coverage, audit record. Not checked: …".

## Copy voice

- Sentences, in the second person, present tense, under 20 words. The status
  page (`status/render.mjs`) is the reference voice: "Nothing has been
  collected. KEEL holds no snapshot of this tenant, so there is nothing to
  restore from."
- Say what happens next, not what the system guarantees. "Sent to approvers.
  Nothing changes until one of them approves." replaces the 40-word promotion
  paragraph.
- Error states name the thing in the user's words and the next step. "KEEL
  could not read its database. Reload in a minute; if this persists, check the
  portal service." Never the engine name.
- No double negatives for the normal state. No "kill switch inactive".
- Caveats attach to the object they qualify, in the explanation or record layer,
  never as a page-level aside above the content. "Declaration is not
  verification." is removed as a heading and expressed per type as "restore
  not yet proven".
- Success is stated plainly when it was checked: "Backup finished, 412 resources."

## Page requirements

Each existing page, what its verdict sentence is, and what moves to the record.

| Page | Verdict (example) | Explanation | Moves to record |
|---|---|---|---|
| Overview | The memorable number. | Needs-attention list (existing alert copy is kept), baseline name, last backup age, open changes with impact bar, approvals waiting. | Evidence chain length, raw collection status, duplicate timestamps, "Catalog honesty" caption. |
| Protect | "All 52 configuration types were backed up in the last 6 hours." or "3 types failed their last backup." | Tier cards with next run and last result in words; failed and stale types listed by name with a retry action; per-type drawer: protected / partially / cannot be restored / restore not yet proven, in one sentence each. | The 11-column matrix: adapter id, endpoint, pagination evidence, prerequisite diagnosis, projection, proof reference, credential mode, observation id. |
| Changes | "37 changes since the baseline set 2 days ago; 2 could lock out administrators." | Table of named resources with impact and age; field diff in words; accept / ignore / roll back on selection. | Natural keys, change kind codes, payload JSON, planned verbs, waves, deferred references, guard refusal codes. |
| Restore | Step title, e.g. "Step 3 of 5: review what will change." | Named resources, what each restore does in words (existing mechanism and content-effect labels are kept), who must approve. | Artifact and dry-run ids, credential file paths (never editable on screen), closure keys, CLI narration. |
| Approvals | "2 requests are waiting for you." | Each request as a sentence with the requester, reason, what changes, impact, link to the dry run, expiry in words; Approve and Reject. | Request id, action code, params JSON, dry-run id. |
| Activity | "KEEL ran 14 jobs today; one backup failed." | One timeline of jobs, decisions and notifications as sentences with actor and age; filters by kind in words. | Job id, worker, heartbeat, params and result JSON, evidence sequence, hashes, anchor state. |
| Settings › Policies | Per policy, the worked example above. Page: "Automation is on. 3 policies, 1 paused." | Match, action, limits in sentences; history; pause / resume / edit. | IDs, enum codes, created-at ISO. |
| Settings › Principals | "4 people can use KEEL; 2 can approve." | Each person by name and email with their roles in words and since when; grant / revoke / disable. | Principal id, grant ids, ISO times. |
| Settings › Notifications, Integrations | "Alerts go to secops@contoso.com and the ops webhook." | Channels and destinations by name with delivery health in words; forms with labelled fields, not JSON textareas. | Channel id, config JSON, event globs, sequence numbers. |

## Mechanical checks

Every portal task adds or extends these checks in `portal/ui-harness/ui.spec.ts`
and the harness fixtures. They run on every route in the harness in both
themes.

1. **Glance test.** At 1440 by 900, before any scroll, the page has one `h1`
   and one element `[data-layer="verdict"]` whose text is at most 25 words and
   contains no digit sequence longer than 6 characters and no character from
   the set `{}[]"`.
2. **Identifier test.** No text matching a UUID, a 32-plus hex string or a
   `key:value` natural key appears outside `[data-layer="record"]`.
3. **Vocabulary test.** No banned term from the table above appears outside
   `[data-layer="record"]`, case-insensitive, whole word.
4. **Reference test.** Every fixture `Ref` renders as a link whose text is the
   name, not the id.
5. **Enum test.** Every enum value in the display map has a non-identical
   display string, and every enum value used in fixtures is in the map.
6. **Single primary action.** At most one `button.primary` or `a.primary` in
   the verdict layer per page.
7. **Record completeness.** Every identifier the fixture carries for an object
   appears, labelled, inside that object's record layer. Honesty is not lost by
   being moved.
8. Existing axe, screenshot and interaction checks continue to run.

Mutation checks for every UI task: strip `data-layer="record"` from one
identifier → test 2 fails; swap a verdict sentence for an enum code → tests 1
and 5 fail; render a `Ref` by id → test 4 fails.

## What is kept

The review found these right; tasks must not regress them: the three-tone
posture hero; the dashboard alert copy in `portal/lib/portal-data.ts`; the
coverage ring, sparkline and impact bar; the restore stepper; the recovery
mechanism and content-effect labels; the undo plan's "will be undone / cannot
be undone" headings; the command palette; skeletons and toasts; confirmations
on destructive actions; the empty-state copy on Restore and Baselines; the
status page's voice; the type scale and spacing tokens.

## Out of scope

This contract changes what the portal shows and says. It does not change
authorization, the approval model, artifact-only restore promotion, evidence
hashing, or any engine reader's data. Where a reader must return a name beside
an id (the `Ref` shape), that is an additive change to `portal/lib` readers and
the engine functions they call, covered by each task's boundary test.

## Status

### 2026-10-03: task-129 shipped (shell, navigation, Overview, mechanical checks)

- **Navigation.** The sidebar has the seven entries, in contract order
  (`portal/components/nav-links.tsx`, `NAV_MAP`).
  - Each entry absorbs existing pages, which keep their routes and appear as
    tabs inside the entry (`SectionTabs`). For example, Protect holds Backups,
    Schedules and Configuration types, and Restore holds Restore and Incidents.
  - An entry links to the first page the viewer may open, and is hidden when
    there is none.
  - The command palette lists every page under its section and still finds a
    page by its former name ("evidence", "coverage", "drift", "principals").
- **Eyebrow.** `PageHeader` takes a typed `section` instead of free text.
  `portal/test/experience-contract.test.ts` checks that every page passes the
  section that owns its route.
- **Overview.**
  - The verdict is the memorable number, computed by
    `engine/coverage/protectionHeadline.mjs` from the same coverage report the
    page reads, plus fidelity-drill evidence. It is never a constant.
  - The three states read "N configuration types have not been backed up since
    …" (or "failed their last backup" / "have never been backed up"), "KEEL can
    restore N of M configuration types today. Last proven restore: …" and "KEEL
    backs up M configuration types. No restore has been proven on this tenant
    yet."
  - The headline is "Protected" only when a restore has been proven. Before
    that it is "Backed up", so the page does not overclaim.
  - Alerts can only make the tone worse. They never replace the number.
  - The hedge (what was and was not checked), raw statuses, the evidence chain
    length and the timestamps are under "Technical details for this overview".
  - The duplicate timestamps and the "Catalog honesty" caption are removed.
- **Copy.**
  - `DataUnavailable` no longer names the database engine.
  - The sidebar says what the viewer can do in words ("You can approve, restore,
    undo and 9 more") instead of a capability count.
  - Stored codes go through `displayEnum()` in `portal/lib/presentation.ts`.
- **Mechanical checks.** Checks 1 to 4, 6 and 7 run on every UI-harness route
  (`portal/ui-harness/ui.spec.ts`). Check 5 and the eyebrow check run in
  `portal/test/experience-contract.test.ts`, and check 8 is the existing axe,
  screenshot and interaction suites.
  - Overview, Incidents and the shell pass.
  - Fifteen routes were allowlisted until task-130 and task-131 rebuild them
    (task-130 removed eleven; see below).
    The allowlist's size is asserted, so it can only shrink.

**Limits and decisions:**

- **No merged pages yet.** The absorbed pages are not yet merged into single
  pages, so `/protect`, `/changes`, `/activity` and `/settings` do not exist.
  Their sections link to the first member page instead of redirecting to a
  merged page. Merging is task-131's job (Protect, Changes, Restore) and
  task-130's (Activity, Settings). No route was removed, so nothing needed a
  redirect.
- **Alert copy reworded.** "What is kept" lists the dashboard alert copy, but
  that copy used banned terms ("catalog type", "evidence chain", "blast
  radius"). The alerts keep their meaning and severity, reworded into the
  vocabulary table.
- **Overview number has no live data yet.** Without fidelity-drill evidence, the
  number reads in its "no restore has been proven" form. Live drills arrive with
  tasks 72 and 73.

### 2026-10-03: task-130 shipped (named objects and labelled records)

- **Engine readers resolve names.** `engine/govern/references.mjs` resolves
  people, baselines, dry runs, changes and snapshots in one query per kind for a
  whole page of rows. Callers:
  - `listPolicies` and the new `getPolicy` (in `engine/policy/evaluate.mjs`)
    return the run-as principal as `{ id, email, name, readable }`, plus the last
    automatic action and the count for the last seven days.
  - `summarizeApprovalRequests` (approvals) and `summarizeJobs` (jobs) attach
    those references to each row.
  - A principal that cannot be read comes back `readable: false`, and a non-UUID
    actor ("scheduler") is named as itself.
  - Covered by `engine/roadmap/named-objects.test.mjs`: tenant scoping,
    unreadable dry runs, foreign baselines and the per-kind query bound.
- **Pages.**
  - Policies follow the worked example, with an automation banner ("Automation is
    on", or when and by which halt file it stopped) and Resume / Turn off / Turn
    on through the existing guarded routes.
  - The People page lists each person by name with their access in words.
  - Approvals are cards with sentences.
  - Baselines show one time per fact.
  - Notifications and Integrations have labelled fields, with config JSON in the
    record.
  - Every page has one verdict sentence.
- **Activity.** `/activity` merges jobs and audit-record entries into one
  timeline, with Show and Kind filters in words, a date range, paging and the
  audit record's integrity note. `/jobs` and `/evidence` redirect there after
  the same read-access check. A job's page links back to Activity.
- **Checks.**
  - The harness allowlist no longer holds any task-130 route; only task-131's
    four remain, and the maximum is 4.
  - Two checks were added to the contract run: a snake_case enum-code check in
    the plain-text test, and a per-route list of fixture IDs that the record
    layer must contain (check 7).
  - The three required mutations each fail a test:
    - run-as returned without its resolved reference → `named-objects.test.mjs`;
    - `policy.action` rendered raw → the enum check on `policy` and `policies`;
    - Policy ID dropped from the record → the record check on both routes.

**Limits and decisions:**

- **No policy edit form.** The portal has no policy edit route. Policies are
  created and changed with `keel-policy` and the existing API. The card offers
  pause, resume and on/off only.
- **Deliveries stay on Notifications.** Sent alerts stay on Notifications as
  sentences rather than joining the Activity timeline, because they belong to
  channel configuration.
- **Restore follow-up panels.** The restore follow-up and undo panels on a
  restore job's page (`RecoveryCompletion`, `CompensationPanel`) pass the checks
  unchanged. Their deeper rewording belongs with task-131's Restore work.
- **Old timeline component kept.** `components/evidence-timeline.tsx` is no
  longer used by a page. It stays because its integrity indicator is still
  unit-tested, and task-131 or later cleanup can remove it.

### 2026-10-03: task-131 shipped (Protect, Changes and Restore in plain words)

- **Protect.** `/protect` merges Backups and the per-type report; `/coverage` and
  `/backups` redirect there after the same read check. Schedules stays a Protect tab.
  - The verdict comes from the coverage reader (`protectVerdict` in
    `portal/lib/protect-view.ts`): "N types failed their last backup.", "… have not
    been backed up recently enough.", "… have never been backed up." or "All N
    configuration types were backed up in the last 6 hours."
  - Tier cards show the schedule reader's next run and last result in words, with
    "Back up Tier N" and, for configuration principals, "Change schedule".
  - Failed, out-of-date and never-backed-up types are listed by name, each with a
    retry that queues its tier's backup.
  - Every type has one drawer: a sentence on whether it is protected, partially
    protected, cannot be restored or has no proven restore; its backup in words;
    what KEEL can do to put it back. The whole task-54 matrix is in the drawer's
    record (see `coverage-ui.md`).
  - Schedules show what runs and how often in words. Job-kind codes, cron
    expressions, schedule and job IDs and the last error are in each schedule's record.
- **Changes.** The verdict is "N changes since the baseline set 2 days ago; 2 could
  lock out administrators." (`changesVerdict` in `portal/lib/changes-view.ts`).
  - The table names each resource and its type in words. Natural keys, drift IDs and
    detection times are in a record per row.
  - The comparison names each setting in words ("Conditions › users › exclude
    groups") with values in words. Field paths and both payloads are in the record.
  - "Disposition" is "decision" everywhere: Accept, Ignore, "Why is this decision right?".
  - The roll-back preview says what KEEL would do to each resource ("Put the baseline
    settings back"). Planned verbs, waves, deferred references, drift IDs and raw
    refusal reasons are in its record. A refusal reads "KEEL refused to change
    Finance (group) because it is synced from on-premises Active Directory, which
    owns it." (`refusalSentence`). Sending it reads "Sent to approvers. Nothing
    changes until one of them approves."
  - Baselines stay the second Changes tab.
- **Restore.**
  - The step title is the verdict ("Step 1 of 5: choose what to put back." through
    "Step 5 of 5: sent to approvers. Nothing changes until one of them approves.").
  - The promotion paragraph, the CLI narration and the closure counts are gone.
    What will be restored is named: "Block legacy auth and everything it depends on",
    and each added resource says what depends on it.
  - Closure keys, the snapshot ID, dry run and job IDs, the effects digest, raw
    results and refusal reasons are in records.
  - The mechanism, content-effect and undo labels are kept. Resources in the
    mechanism table and content effects are named, not keyed.
- **Credential paths are server configuration.** The wizard has no credential-path
  inputs. `POST /api/actions/restore/dry-run` refuses a request that supplies
  `collectorConfig` or `targetConfig`, and gives the worker the server's paths
  (`KEEL_COLLECTOR_CONFIG_PATH` / `KEEL_RESTORER_CONFIG_PATH`, defaulting to the
  `/etc/keel` files the worker already falls back to). Covered by
  `portal/test/restore.test.ts` and `engine/roadmap/protect-page.test.mjs`.
- **Checks.**
  - The harness allowlist is empty and its maximum is 0. Protect, Schedules,
    Changes and Restore pass checks 1 to 7, with per-route record IDs (proof
    references, observation, schedule and drift IDs).
  - The restore wizard's interaction test also runs the plain-text check at the
    review step and confirms there is no credential-path input.
  - A new interaction test covers the roll-back preview's refusal sentence.
  - A failing plain-text check now names the text that matched.
  - The three required mutations each fail a test:
    - proof reference removed from the drawer's record → `coverage-ui.test.mjs`
      and the record check on `protect`;
    - a natural key rendered in the Changes table → the identifier check on `drift`;
    - credential-path inputs put back → `protect-page.test.mjs`.

**Limits and decisions:**

- **Schedules stay a tab.** Protect shows each tier's schedule on its card. The full
  schedule table (prune, off-site copy, Microsoft API check) stays on the Schedules
  tab rather than lengthening Protect.
- **Recent backups list only on-demand jobs.** Protect keeps the old Backups rule
  (`BACKUP_JOB_KINDS = ["backup"]`). Scheduled tier runs show on the tier cards
  and in Activity.
- **Refusal reasons are matched, not rewritten at source.** `refusalSentence` turns
  known guard reasons into words. A coded reason it does not recognise says the
  reason is in Technical details, rather than putting the code on screen.
- **Undo plan still shows natural keys.** On a failed restore's job page, the undo
  plan (`CompensationPanel`) keeps its "will be undone / cannot be undone" headings,
  which the contract lists as kept, and now uses the named content-effect list.
  Its other rows still name resources by natural key once "Plan undo" is pressed.
  The contract check runs on that page before planning, so it does not catch them.
  Rewording that plan is left for a follow-up.

