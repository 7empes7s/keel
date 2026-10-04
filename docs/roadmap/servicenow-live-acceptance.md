# ServiceNow non-default workflow qualification (task-118)

Date: 2026-10-04 UTC. **Status: the code half is built and fixture-tested. The gate stays
pending live evidence.** No ServiceNow instance was contacted. No credential was read. The
checked-in record `docs/release/qualifications/servicenow-live-acceptance.json` is a
`status: "pending"` placeholder, and it fails `verify --require-live`. D6 (a ServiceNow
workflow proven live) stays pending until the operator runs the capture below against the
non-production instance and the signed record verifies.

## The rule being qualified

KEEL holds the one canonical decision (task-96). A ServiceNow record mirrors it, through the
task-97 adapter. An approval in ServiceNow only asks KEEL to decide. It decides only for the
record's current plan version and digest, and only through a mapped KEEL principal who may
approve that request now. Task-118 proves this against a real, non-default workflow. Proof
needs both directions, a lost callback, a duplicate callback, a conflict and a revoked
approver, with one canonical KEEL action each time.

## What was built

- **`tools/qualification/servicenowAcceptance.mjs`**: the evidence contract and the gate
  validator `validateServiceNowLiveSubject`. It is registered with one line in
  `GATE_VALIDATORS` (`tools/release/qualification.mjs`) as `servicenow-live-acceptance`.
  Beyond the generic verifier (signature, gate, tenant, freshness, `--require-live`), it
  requires:
  - **Both proofs**: the `keel-release-runner` signature over the record, and the
    digest-verified raw capture log. The log's digest must also be bound into the signed
    subject.
  - **Identity**:
    - operation `servicenow.non-default-workflow-qualification`;
    - credential mode `keel-oauth-reference+test-user-references`;
    - the expected build;
    - every scenario's KEEL records belong to the record's tenant.
  - **Prerequisites**:
    - tasks 96 and 97 are named;
    - the instance was declared non-production by a named operator, for exactly this
      host, within the capture window;
    - the instance did not report `glide.installation.production=true`;
    - the workflow mapping passes this build's `serviceNowConfigProblems`;
    - the workflow is **not** the out-of-the-box `change_request.approval` with
      `approved`/`rejected`;
    - callbacks are signed, and a relay table is named;
    - at least two distinct test users are mapped to distinct KEEL principals. Each acts
      under its own `env:` credential reference, never KEEL's. The KEEL requester and
      portal approver are not test-user principals.
  - **Scenarios.** All four must be present, each on its own instance record. In every
    scenario, KEEL's plan was delivered and read back before anyone decided. One declared
    test user then set an approved value, and the instance names that user as approver.
    | Scenario | What must hold |
    |---|---|
    | `callback-duplicate` | Callbacks `[applied, applied (duplicate)]` under one event id. One `itsm` decision from that callback, by the test user's principal. One job. The decision is written back. |
    | `lost-callback` | One callback withheld. Polls `[applied, applied (duplicate)]`, then the withheld callback arrives late as `already-decided`. One `reconcile:` decision. One job. |
    | `conflict` | KEEL's portal approver rejected first. The instance approval is a `conflict`. The `portal` rejection stands. Zero jobs. The instance shows "KEEL's decision stands". |
    | `revoked-approver` | The deciding test user's KEEL grant was revoked first. The approval is `refused-not-eligible`. The external approved state is on the record, but the KEEL request stays `pending`, with zero decisions and zero jobs. |
    No scenario may have more than one job.
  - **The capture log** (read back from its verified bytes) must show:
    - every call went to the declared host;
    - only KEEL and declared test users called;
    - each test user used their own credential reference;
    - KEEL never wrote the approval state field;
    - each instance decision is a successful PATCH of the state field by that test user.
  - **Documentation and secrets.** Retrieval of the Table API documentation is recorded.
    No credential material appears anywhere in the record (`secretProblems`).
- **`tools/qualification/servicenowLive.mjs`**: the capture, import and offline-plan tool
  that the operator runs.
  - **Refusals before anything is sent** (`serviceNowCaptureRefusals`):
    - the configured host is not the one declared non-production on the command line, or
      `--declared-by` is missing;
    - any missing mapping;
    - no signed callbacks;
    - the out-of-the-box `change_request` approval;
    - fewer than two test users;
    - a test user without its own `env:` reference, a duplicate test user, or a value in
      place of a reference.

    `serviceNowDatabaseRefusals` refuses a KEEL database that is `KEEL_DB_URL` or not
    named `…_qualification`/`…_test`. The capture then reads
    `glide.installation.production` and refuses `true` before creating anything.
  - **The capture drives the production code.** It uses `createServiceNowAdapter`,
    `mirrorApprovalRequest`, `drainItsmOutbox`, `handleServiceNowCallback`,
    `runServiceNowCycle` and `reconcileRecord` in a dedicated KEEL qualification database.
    `prepareServiceNowQualification` creates the qualification principals there, maps each
    test user and saves the config. Each scenario's approval request names a placeholder
    plan: its one job exists only in the qualification database, and nothing runs it. Test
    users decide with their own tokens. KEEL's token creates the records and writes only
    KEEL's fields. Signed callbacks are read from the relay table and handed to KEEL
    exactly as the instance signed them.
  - **What is logged.** Every instance call is logged with its actor, credential
    reference, method, path, record and the names of the fields written. Headers, values
    and tokens are never logged.
  - **Output.** `writeServiceNowAcceptanceFiles` writes the record and its
    `.capture.json` side by side and signs the record only when
    `KEEL_QUALIFICATION_HMAC_KEY` is set.
  - **Import.** `serviceNowQualificationFromAcceptance` turns only a record that verifies
    with `--require-live` into a `live-qualified` claim. Nothing in production consumes it
    yet.
- **`ops/servicenow/keel-callback-relay.js`**: the instance-side half of the signed
  callback that task-97 left to this task. It is an after-update business rule on the
  mapped table that fires when the state field changes. It signs
  `t=<unix>,v1=<base64 HMAC-SHA256 of "t.body">` with
  `GlideCertificateEncryption.generateMac`, and writes the signature and body into the
  relay table `u_keel_callback_relay`. No outbound REST message and no public KEEL ingress
  are needed. The operator installs it by hand. KEEL never changes an instance's
  configuration.
- **`docs/release/qualifications/servicenow-live-acceptance.json`**: a `status: "pending"`,
  `synthetic: true` placeholder.
- **CI**: the new suite is in the engine step of `.github/workflows/portal.yml`.

No schema change: the capture writes only through existing task-96/97 tables, in the
qualification database. There is no UI change. The Integrations panel keeps saying "Not yet
proven against a real ServiceNow instance.", which stays true until a record verifies.

## Acceptance evidence (`engine/roadmap/servicenow-live-acceptance.test.mjs`, 11 tests)

All tests run against a fake non-production instance behind an injected `fetch`, which
emulates:
- the Table API, with POST, GET and PATCH on records;
- `sys_properties`;
- the relay table;
- two test users with their own tokens, who may set only the gate;
- the workflow naming the decider;
- the relay rule signing each state change.

The KEEL side is the real task-96/97 code on an isolated test database.

1. A valid capture verifies with `--require-live`. It shows both directions, the four
   scenario outcomes above and one job in each approved scenario. Only KEEL and the two
   test users called the instance. No token or secret value is in the record or log.
2. Refusals happen before anything is sent:
   - an undeclared host, a mismatched host or no operator;
   - the default workflow, no signed callbacks or an incomplete mapping;
   - one test user, a shared credential, a value in place of a reference, an extra key or
     a duplicate user.

   A production flag of `true` stops the capture after one read, with no record or
   principal created. The database refusals also hold.
3. These fail: an altered signature, a forged signature, a capture log edited after
   signing, a record without its log, and a subject digest not bound to the log.
4. These fail: a wrong tenant, build (or none), operation, credential mode or gate, and
   one scenario captured for another tenant.
5. These fail as stale: an observation 40 days old, scenario steps re-dated three days
   before the record, and an old non-production declaration.
6. A missing prerequisite fails:
   - task-97 not named;
   - no declaration, or a declaration for another host;
   - a production flag;
   - the default workflow or an unmapped approver field;
   - unsigned callbacks;
   - one test user, an unmapped test user or a shared credential;
   - a missing scenario or missing documentation;
   - a token in the record.
7. Authority and the one-action rule hold. Each of these fails:
   - a revoked approver's approval that changed the request or minted a job, was applied,
     or came without a revocation;
   - a conflict that minted a job, or did not tell the instance;
   - a duplicate that acted twice or recorded two decisions;
   - a lost callback that was never withheld, or a second poll that acted again;
   - a decision by someone not a declared test user;
   - a plan that never read back.
8. The capture log binds who acted. A rebound log fails on any of these: a call by
   someone else, a test user under another credential, a KEEL write to the state field, a
   missing test-user PATCH, or a call to another host. An unchanged rebound log verifies.
9. **Honest failure.** If the instance's relay signs with another key, the callbacks are
   `refused-bad-signature`. Polling still decides once, through KEEL's own read, and the
   record fails verification. If the relay writes nothing, the capture stops with no
   record.
10. Fixture evidence never elevates. A record signed as `keel-fixture-runner`, or marked
    `synthetic`, fails even without `--require-live`. The import seam gives no claim for
    it, or for another tenant. The checked-in pending placeholder fails, as do a pending
    status on any record, no subject, an absent file and no verification key.
11. The CLI `plan` is offline and lists the refusals. `capture` refuses (exit 2) without a
    declaration, a qualification database or a build. In that case it never connects to
    the database or contacts an instance.

## Required mutation checks

Each mutation was applied to `tools/qualification/servicenowAcceptance.mjs`. Each made the
named test fail, and each was reverted. The restored suite passes 11 of 11.

1. **Accept missing external evidence.** The gate no longer requires the capture log
   (`artifact.ok`). Test 3 fails: a signed record without its capture log verifies.
   Removing the gate's own `status: "pending"` refusal leaves the suite green, because the
   generic verifier refuses a pending record first. That is a second layer, not the only
   one.
2. **Accept mismatched tenant or operation.**
   - Removing the operation check fails test 4: a record re-signed with the task-97
     operation verifies.
   - Removing the per-scenario tenant check fails test 4: a scenario for another tenant
     verifies.
3. **Elevate fixture evidence to live-qualified.** Removing the gate's
   synthetic/fixture-runner refusal fails test 10: a `keel-fixture-runner` record passes
   the gate.

Two capture-side safety mutations in `tools/qualification/servicenowLive.mjs` were also
checked. Each made test 2 fail and was reverted:
- accepting a host other than the declared one;
- ignoring `glide.installation.production=true`.

## Validation run

```bash
KEEL_DB_TEST_URL=postgres://keel@localhost:5432/keel_test KEEL_TENANT_CONFIG_PATH=<tenant file> \
node --test engine/roadmap/servicenow-live-acceptance.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs
# tests 16, pass 16, fail 0
node tools/release/qualification.mjs verify --require-live --gate servicenow-live-acceptance \
  --evidence docs/release/qualifications/servicenow-live-acceptance.json
# { "ok": false, "failures": ["servicenow-live-acceptance external runner evidence pending"] }  (exit 1, expected)
```

The final `verify --require-live` step can pass only after the operator steps below.

## Operator steps

**What is needed.** All of this lives in the non-production instance from the 2026-09-30
operator decision (OAuth app and credentials in `/etc/keel/servicenow.env`, outside git):

1. **A non-default workflow on one table.** Use a custom table, or a custom state field or
   values, not the stock `change_request.approval`. It needs:
   - a state field whose approved value a test user may set;
   - an approver field that the workflow sets to the deciding user (`sys_updated_by`
     works only if no later write changes it before the callback is read);
   - four string fields for KEEL's plan version, plan digest, request id and decision.

   Write the KEEL adapter config for it (the `itsm_adapter_config.config` shape from
   `docs/roadmap/servicenow.md`), with `credential.tokenRef` and `callback.secretRef` as
   `env:` references. Check it offline:
   `node tools/qualification/servicenow.mjs check --config servicenow-config.json`.
2. **The relay.**
   - A table `u_keel_callback_relay` with string fields `u_record`, `u_signature` and
     `u_body` (`u_body` at least 4000 characters).
   - A `password2` system property `x_keel.callback_signing_key_b64`, holding the base64
     of the value `callback.secretRef` resolves to.
   - The business rule `ops/servicenow/keel-callback-relay.js`, with its `FIELDS` set to
     the config's field names.
3. **Two test users.** Use ServiceNow accounts that exist only for testing, and are not
   people, who may set the state field. Each needs their own OAuth token in its own
   environment variable. Put them in `servicenow-test-users.json`:
   `[{"externalUser":"<approver field value for user 1>","credentialRef":"env:KEEL_SN_TEST_USER_ONE"}, {…two…}]`.
4. **A qualification KEEL database.** It must be empty or reused only for this, and named
   `…_qualification`, for example `keel_servicenow_qualification`. Put its URL in
   `KEEL_SERVICENOW_QUALIFICATION_DB_URL`. It must never be the production database.
5. **Documentation retrieval.** Record when you retrieved the Table API page in
   `docs.json`:
   `[{"url":"https://www.servicenow.com/docs/r/api-reference/rest-apis/c_TableAPI.html","retrievedAt":"<ISO time>"}]`.

**Capture.** Run it from `/opt/keel` at the build being qualified, with the referenced
tokens and `KEEL_QUALIFICATION_HMAC_KEY` exported (never on the command line):

```bash
node tools/qualification/servicenowLive.mjs plan --config servicenow-config.json \
  --test-users servicenow-test-users.json            # offline: refusals and every step
node tools/qualification/servicenowLive.mjs capture \
  --confirm-non-production-instance <instance>.service-now.com --declared-by "<your name>" \
  --config servicenow-config.json --test-users servicenow-test-users.json \
  --tenant-ref <tenant_ref> \
  --docs docs.json --build "$(git rev-parse HEAD)" \
  --out docs/release/qualifications/servicenow-live-acceptance.json
```

Add `--record-template template.json` if the table has no `short_description` field.
`<tenant_ref>` is the host tenant's reference (`configuredTenantRef()` in
`tools/release/qualification.mjs`, read from `KEEL_TENANT_CONFIG_PATH`).

The capture creates four records in the mapped table, plus their relay rows; delete them
afterwards if you wish. It makes four test-user approvals in the instance, and revokes the
second test user's KEEL grant in the qualification database only. It mints two
placeholder jobs, in the qualification database only. A refused or failed capture is a
result: report it, and never edit a record by hand.

**Verify.**

```bash
node tools/release/qualification.mjs verify --require-live --gate servicenow-live-acceptance \
  --tenant <tenant_ref> --evidence docs/release/qualifications/servicenow-live-acceptance.json
```

The record is valid for 30 days, and only for the build and tenant it names. Commit the
record and its `servicenow-live-acceptance.capture.json` together.

## Limits

- **Not live.** Everything is proven against a fake instance. These are all unproven until
  the capture runs:
  - real Table API responses (status codes, the `sys_properties` read, encoded queries on
    the relay table);
  - `GlideCertificateEncryption.generateMac`'s key format (base64 assumed, from the search
    index of the official docs) and `current.getElement` dot-walking in the business rule;
  - OAuth behaviour.
- **The workflow's approver field is the operator's choice.** If KEEL's own decision write
  changes it (for example `sys_updated_by`), a callback read after that write is
  `refused-instance-mismatch`. The capture orders steps so that each callback is handed
  over before KEEL writes again.
- **The relay is qualification plumbing.** Production callbacks still have no public HTTP
  ingress (task-97 limit), and polling stays the working inbound path. The relay table
  proves the instance can sign callbacks that KEEL verifies. It is not a production
  delivery channel.
- **Test users are declared, not detected.** KEEL cannot tell a test account from a person.
  The capture acts only as the declared users and with their own tokens, and the log
  proves it did. Choosing accounts that are not people is the operator's duty.
- **The non-production declaration is the operator's.** The production-flag read is a
  second check, not proof: `absent` and `unreadable` are recorded as observed and do not
  block.
- **The import seam has no consumer.** No portal or engine path reads the live claim yet,
  so the Integrations panel's "not yet proven" sentence is static.
