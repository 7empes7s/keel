# Sentinel workspace ingestion qualification (task 117)

Date: 2026-10-04 UTC. Status: the code half is implemented and fixture-tested.
**The gate stays pending.** No live evidence exists. No workspace, DCR or Azure
resource was read, written or created. Sentinel export stays fixture-tested only.

The external admission gate needs things that cannot exist in a builder container:
- a configured TEST Log Analytics workspace with the `KeelEvents_CL` custom table;
- a DCE/DCR for the `Custom-KeelEvents` stream;
- a sender identity with the publishing role on the DCR;
- a separate reader identity, and the receiver query evidence it produces.

The operator has deferred this gate (see `operator-gates.md`). This task builds
everything else:
- the evidence contract and the gate validator;
- the capture tool the operator runs;
- an import seam that turns a verified record into one live-qualified claim;
- the boundary tests.

The checked-in record `docs/release/qualifications/sentinel-live-acceptance.json` is a
placeholder with `status: "pending"`. It fails `verify --require-live`, and it is meant to.

## What was built

### Gate validator (`tools/qualification/sentinelAcceptance.mjs`)

`validateSentinelLiveSubject` is registered additively in
`tools/release/qualification.mjs` as gate `sentinel-live-acceptance`. It is one entry
in `GATE_VALIDATORS`, and the wrapper passes in the runner-proof result. It checks the
record against the production declarations it qualifies, not against a copy:
- the task-80 adapter (`engine/telemetry/adapters/sentinel.mjs`): the stream, the
  table, the column schema, the Logs Ingestion API version and the setup
  prerequisites;
- the task-79 receiver dedup contract (`RECEIVER_DEDUP_CONTRACT`: at-least-once,
  dedup on tenant, destination and event id);
- the task-80 logical dedup view, whose `summarize` line is read from the checked-in
  `ops/sentinel-dedup.kql`.

On top of the generic verifier (schema, gate, tenant, freshness, `--require-live`),
a record passes only when all of these hold.

| Check | Rule |
| --- | --- |
| Identity | Operation `sentinel.workspace-ingestion-qualification`. The build matches the expected build. Credential mode is `sender-ingest+reader-query`. An expected tenant and build are both required. The destination, every probe event, and every raw and logical row carry the record's tenant, the record's destination and the run id. Both KQL queries are scoped to that run, tenant and destination. |
| Proof | Both proofs are needed: a trusted runner signature, and the SHA-256 of the raw capture log. The log digest is also inside the signed subject (`captureLogSha256`), so a log swapped together with its proof digest still fails. |
| Prerequisites | Tasks 79 and 80 are named. A workspace GUID is given. The endpoint, DCR and sender reference leave no task-80 setup prerequisite pending. The stream, table, schema and API version are the ones this build declares. The sender holds Monitoring Metrics Publisher. The reader holds Log Analytics Reader, Microsoft Sentinel Reader or Reader. The two credential references differ. The destination kind is `azure-monitor-sentinel`. Receiver query evidence exists. |
| Probe events | At least 3 `keel.qualification.sentinel-probe` events. Each has a stable `evt_<sha256>` id, with no duplicate ids. Source sequences form one contiguous run. |
| Delivery | Every probe event was accepted on initial delivery by the production adapter. Every non-accepted attempt keeps its error. |
| Restart/replay | A fresh adapter instance (`replay.restartedAdapter`) redelivered at least one event, and the workspace accepted it under the same event id. |
| Logical dedup, never physical uniqueness | Delivery semantics must be `at-least-once`. The dedup key must be `TenantRef, DestinationId, KeelEventId`. The logical query must contain the task-80 dedup view. The logical rows must be exactly that view recomputed over the raw rows: one row per dedup key, with no extra or missing keys. The claims `exactly-once` and `unique-physical-rows` are refused. |
| No missing events | Every probe event id appears in the logical view. A row outside the probe set fails. |
| Actual delay and errors | `results` (probe count, physical rows, logical events, physical duplicates, missing ids, errors by outcome, 429 responses, per-event ingestion delay) is recomputed from the delivery log and the received rows, and must match exactly. A summary that hides an error, drops a failed attempt or invents a delay fails. A row ingested more than 5 minutes before its accepted send fails. |
| Freshness | Every delivery and the final receiver query fall within 24 hours before the record's `observedAt` (5 minutes of clock skew allowed). The generic 30-day record limit applies on top. |
| Documentation | The record gives a retrieval date for the Logs Ingestion API overview, the service limits page and the Log Analytics query API overview (Global Constraint 8). |
| No secrets | No key or value in the record looks like a token, secret, password, private key or JWT. |

A record with `status: "pending"` fails before any other check. A record that claims
`live-qualified` while synthetic (or unlabelled), or that is signed by
`keel-fixture-runner`, fails even without `--require-live`.

### Capture tool (`tools/qualification/sentinelLive.mjs`)

- **`plan` (the default)** is offline. It prints every delivery and both queries a
  capture would send.
- **`capture`** refuses to run (exit 2, nothing sent) without
  `--confirm-live-workspace-ingest`. It also refuses before any request when:
  - the tenant ref, destination id or run id cannot go into a KQL string literal
    verbatim (only `[A-Za-z0-9_.:-]`);
  - a task-80 setup prerequisite is pending (endpoint, DCR, sender reference, cloud);
  - the workspace id is not a GUID;
  - the reader reference is missing or equals the sender's;
  - the tokens are not in the environment, or `--build` is missing.
- **What it does, in order:**
  1. It builds N probe events (default 5, from 3 to 50) with the task-77 envelope
     builder. They share one run id as their correlation id, so each has its stable
     KEEL event id.
  2. It delivers each event through the **production** `createSentinelAdapter`.
     A `retry` or `uncertain` outcome is retried under the same event id, up to
     4 attempts, honouring Retry-After. Every attempt is logged with its outcome and
     error.
  3. **Restart/replay.** A fresh adapter instance redelivers every event from
     `--replay-from-seq` (default 0) under the same event ids. This is the
     redelivery the task-79 outbox replay performs.
  4. With the separate reader token, it polls the Log Analytics query API with two
     read-only KQL queries: the raw rows with `ingestion_time()`, and the task-80
     dedup view. It polls up to 20 times, 30 s apart, until every probe is visible
     logically.
- **Nothing else is written.** No Azure resource is created or changed.
- **Tokens and proof.** Tokens are read from `KEEL_SENTINEL_SENDER_TOKEN` (Monitor
  audience) and `KEEL_SENTINEL_READER_TOKEN` (Log Analytics API audience), and are
  never written. The record holds credential references only. The tool writes the
  record and its raw log (`*.capture.json`) side by side, and binds the log's digest
  as the artifact proof. With `KEEL_QUALIFICATION_HMAC_KEY` set, it signs the record
  as `keel-release-runner`. It then runs the gate verifier and prints the result.
- **Exit codes:** 0 verified; 1 captured but not verified (for example a missing
  event, which the record keeps as observed); 2 refused before any request.

### Import seam (`sentinelQualificationFromAcceptance`)

A record that passes the gate with `--require-live` becomes one claim:
- `state: live-qualified`, `deliverySemantics: at-least-once`, `dedup: logical`;
- the tenant, build and destination it was captured for;
- its maximum delay and the physical duplicate count;
- `proofRef: sentinel-live-acceptance@<log digest>`.

Anything that fails verification becomes nothing. Nothing in production consumes
the seam yet.

## Server, CLI and UI integration

- **CLI.** The release CLI verifies the new gate:
  `node tools/release/qualification.mjs verify --gate sentinel-live-acceptance ...`.
  The capture tool is the operator CLI. The task-80 offline config check
  (`tools/qualification/sentinel.mjs check`) is unchanged and remains fixture-tested.
  It can never satisfy this gate, because its operation is different and it is
  always synthetic.
- **Server and UI.** None in this task. There is no evidence to show yet, and the
  task-79/80 outbox status already reports delivery state. Showing the claim in the
  portal is follow-up work once a verified record exists.

## Migration and legacy reads

- No schema change and no data change.
- The release CLI keeps its existing behaviour for every other gate. The Sentinel
  checks apply only when `gate` is `sentinel-live-acceptance`.
- The task-80 check record (gate `sentinel-ingestion`) is a different gate. It is
  not migrated and is not accepted here. Any record without the fields above fails
  closed.

## Operator steps

These steps clear the gate. Only the operator runs them, from `/opt/keel` at the build
being qualified, and only after deciding to take the gate up. Builders must not run
them.

1. **Test workspace (operator-provisioned; the tool never creates anything).** Do
   this in a test subscription:
   - Create a Log Analytics workspace (Sentinel may be enabled on it).
   - Create the `KeelEvents_CL` table from `ops/sentinel-schema.json`.
   - Create a DCE and a DCR for the `Custom-KeelEvents` stream that writes to it.

   Note the workspace id (GUID), the ingestion endpoint and the DCR immutable id.
2. **KEEL destination.** Register (or reuse) an `azure-monitor-sentinel` destination
   for the tenant, with that config. Note its id. The probe rows carry it as
   `DestinationId`.
3. **Credentials.** Use two separate app registrations.
   - **Sender:** Monitoring Metrics Publisher on the DCR. It is referenced by the
     destination's `credentialRef`.
   - **Reader:** Log Analytics Reader on the workspace only.

   Put what each actually holds into `roles.json`:
   `{ "sender": ["Monitoring Metrics Publisher"], "reader": ["Log Analytics Reader"] }`.
   Acquire a token for each: the sender for `https://monitor.azure.com/.default`, the
   reader for `https://api.loganalytics.io/.default`.
4. **Documentation.** Re-read the three pages and record each URL with its retrieval
   time in `docs.json`: `[{ "url": "...", "retrievedAt": "<ISO time>" }]`. The URLs
   are printed by:
   ```bash
   node -e "import('./tools/qualification/sentinelAcceptance.mjs').then(m => console.log(m.sentinelRequiredDocumentation().join('\n')))"
   ```
5. **Preview, offline:**
   ```bash
   node tools/qualification/sentinelLive.mjs plan --tenant-ref <tenant_ref> --destination-id <destination id>
   ```
6. **Capture:**
   ```bash
   KEEL_SENTINEL_SENDER_TOKEN=... KEEL_SENTINEL_READER_TOKEN=... KEEL_QUALIFICATION_HMAC_KEY=... \
   node tools/qualification/sentinelLive.mjs capture --confirm-live-workspace-ingest \
     --tenant-ref <tenant_ref> --destination-id <destination id> \
     --workspace-id <workspace guid> --endpoint https://<dce>.ingest.monitor.azure.com \
     --dcr-immutable-id dcr-... --sender-ref env:<credential var> --reader-ref app:<reader app id> \
     --roles roles.json --docs docs.json --build "$(git rev-parse HEAD)" \
     --out docs/release/qualifications/sentinel-live-acceptance.json
   ```
   This replaces the pending placeholder, and writes
   `sentinel-live-acceptance.capture.json` next to it. Ingestion can take minutes. If
   the run exits 1 with a missing event, keep the record as the observed result.
   Rerun later as a new capture; never edit the record.
7. **Verify** (the task's final Validate step):
   ```bash
   KEEL_QUALIFICATION_HMAC_KEY=... KEEL_QUALIFICATION_TENANT_REF=<tenant_ref> \
   node tools/release/qualification.mjs verify --require-live --gate sentinel-live-acceptance \
     --evidence docs/release/qualifications/sentinel-live-acceptance.json --build <capture commit>
   ```
   The record is valid for 30 days, and only for the build and tenant it names.

## Proof

`engine/roadmap/sentinel-live-acceptance.test.mjs` has 11 tests and needs no
database. The capture tool drives the production task-80 adapter and the production
query transport against an in-memory fake workspace:
- the ingestion endpoint appends one physical row per accepted request, so a
  redelivery is a second physical row;
- the query API runs the two capture queries, including the dedup view.

The fake can throttle (429), lose an acknowledgement after the row lands, drop an
event, reject one (400) or refuse redeliveries (503). Records are signed with a
test-only key in a temporary directory and never kept.

- **A valid capture verifies.** 5 probes give 10 physical rows and 5 logical events,
  the replay is accepted under the same event ids, and the diagnostic request id
  differs per request. The delay is recorded, and no token appears in the record or
  the log.
- **Errors and delay are preserved.** A throttled first send and a lost
  acknowledgement still verify, with `retry: 1`, `uncertain: 1`, one 429 and 11
  physical rows. Each of these fails: hiding an error, dropping failed attempts,
  faking the delay, blanking an error string, or a row ingested before it was sent.
- **An altered signature, an edited field, an edited capture log, or a swapped log
  with its own digest** each fail.
- **Wrong tenant, build, operation, credential mode or gate** each fail, even when
  re-signed by the trusted runner. So does any of these: a destination, probe or row
  in another tenant; a row for another destination or run; a query not scoped to the
  tenant; shared credentials; another API version.
- **Stale evidence fails:** an old record; an old delivery or receiver query inside a
  fresh record; a query after the record; an undated documentation entry.
- **A missing prerequisite fails:** task 79 or 80 not named; no workspace id, DCR or
  https endpoint; another stream or table; a changed schema; a sender or reader
  without its role; no sender reference; no receiver evidence; the wrong destination
  kind; fewer than 3 probes; no restart; no replay; a replay the workspace refused.
- **Logical dedup only.** Each of these fails: raw rows passed off as the logical
  view; a logical view that does not match its raw rows; an `exactly-once` or
  `unique-physical-rows` claim; `exactly-once` semantics; a dedup key other than the
  event identity; a rewritten physical-row count; a logical query without the dedup
  view; duplicate or unstable probe ids.
- **A missing event fails.** A dropped event is recorded in `missingEventIds` and
  fails, after the receiver is polled to its budget. A poisoned event fails as never
  accepted, and missing. Hiding an event's rows fails. A foreign row fails.
- **Missing external evidence fails.** The checked-in pending record fails, with or
  without `--require-live`, and the release CLI exits 1 on it. An absent file fails.
  So does a record without its capture log, or without a runner signature.
- **Fixture evidence is never elevated.** Each of these fails, and the import seam
  yields no claim for them: a fixture-runner signature, a synthetic or unlabelled
  record, a `fixture-tested` level. The task-80 offline check record, even re-signed
  for this gate, fails too. A verified record yields one claim, for its own tenant
  and build only.
- **The tool.** `plan` and an unconfirmed `capture` send nothing. KQL-unsafe ids,
  missing tokens, a shared sender/reader and a missing DCR are refused before any
  request. The CLI end to end writes a record that verifies. Without the runner key,
  it exits 1.

Required mutations were each applied alone and then restored (2026-10-04):

| Mutation | Pass | Fail |
| --- | --- | --- |
| Accept missing external evidence (no capture log required) | 9 | 2 |
| Accept missing external evidence (no receiver query evidence) | 10 | 1 |
| Accept missing external evidence (a missing event accepted) | 10 | 1 |
| Accept mismatched operation (no operation check) | 9 | 2 |
| Accept mismatched tenant (destination in another tenant) | 10 | 1 |
| Accept mismatched tenant (received rows in another tenant) | 10 | 1 |
| Elevate fixture evidence to live-qualified (no fixture-claim check) | 10 | 1 |
| Elevate fixture evidence to live-qualified (import seam without `--require-live`) | 10 | 1 |

**Validation:**
- The new suite gives 11 pass, 0 fail.
- The final `verify --require-live` step was run on the pending placeholder. It exits
  1 with "sentinel-live-acceptance external runner evidence pending", as it must
  until the operator captures evidence. Without `--require-live` it also exits 1.
- Portal: `npm run typecheck` is clean.
- **Not run against a database.** The builder's local Postgres could not be started
  in this session. So in the Validate command, the `engine/authz` and `engine/jobs`
  suites, and the database-backed suites in the CI restore-engine step, failed only
  with `ECONNREFUSED`. That step otherwise gave 157 pass and 89 fail, every failure a
  connection refusal. The new suite needs no database and passes inside that step.
  CI's Postgres service runs the full set.

## Limitations

- **No live proof.** This task proves the gate's code behaviour only. These stay
  unknown until a capture runs: whether the deployed DCR accepts the stream as
  declared, the real ingestion delay, real throttling, and how Log Analytics stores
  duplicates.
- **Deferred by operator decision.** The gate cannot clear until the operator stands
  up the test workspace, DCE/DCR and the two identities.
- **Documentation not re-fetched.** learn.microsoft.com is not reachable from this
  environment. The ingestion URLs come from task 80. The Log Analytics query API
  overview URL, the query hosts (`api.loganalytics.io`, `.azure.cn`, `.us`) and the
  reader audience come from prior knowledge. The capture requires the operator to
  re-read all three pages, and a mismatch is a capture failure, not a code change
  made blind.
- **Replay is the adapter path, not the outbox transaction.** The live capture
  redelivers through a fresh production adapter instance under the same event ids.
  That is what the task-79 outbox replay sends. The outbox's checkpoint and replay
  transaction itself stays proven by the task-79/80 fixture suites against an
  isolated database, not by this live capture.
- **Logical, not physical.** The gate proves that the dedup view yields one logical
  event per event id, with none missing, for the probe run. It never proves, or lets
  a record claim, unique physical rows or exactly-once ingestion. Physical
  duplicates are recorded as observed.
- **Small probe run.** By default this is 5 events (at most 50), one destination and
  one tenant. It is not a throughput, limit or long-run loss measurement. The
  service limits page is recorded, not exercised.
- **Delay is one sample.** It is measured from the accepted send's local clock to
  `ingestion_time()`. Clock skew between the runner and Azure is tolerated up to
  5 minutes and is not corrected.
- **Nothing is wired yet.** No worker job or portal view consumes the import seam.
