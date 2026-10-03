# Bounded same-tenant drill and Keel recovery acceptance (task-116, WS10)

Date: 2026-10-03 UTC. Status: the code half is implemented and fixture-tested.
**The gate stays pending until live evidence exists.** No live drill has been
run, nothing was captured from the real tenant, and
`docs/release/qualifications/drill-live-acceptance.json` is a `status: "pending"`
placeholder that fails `--require-live`.

## What was built

All of it is in `tools/release/qualification.mjs`. The verifier contract is
unchanged; this gate adds to it.

- **Gate `drill-live-acceptance`** (`validateDrillLiveAcceptanceSubject`,
  registered in `GATE_VALIDATORS`). The record has operation
  `recovery-drill.bounded-same-tenant` and credential mode
  `collector-restorer-separate`, and is bound to the expected tenant and build.
  Verification without an expected tenant and build fails. The signed
  `subject` binds:
  - `testObject`: the named disposable `group:keel-rehearsal-*` object. Any
    other type or name fails, so active users and tenant-wide policies are
    out of scope.
  - `drillRecord`: the task-72 live drill record exactly as the rehearsal
    evidence row holds it. It must count under task-72's
    `classifyDrillRecord`: live, bounded same-tenant, `passed`, cleanup
    `complete`, elapsed time equal to the recorded finish minus start and
    inside its bound. In addition:
    - it names exactly the declared test object;
    - it created at least one object and nothing outside its allowlist;
    - every created object is in `cleanup.verifiedAbsent` and there are no
      residuals (this is the post-state check);
    - its bounds are within the task-72 ceilings and its write count within
      its bound;
    - it started inside the freshness window and finished before
      `observedAt`.
  - `reconstruction`: the task-68 `reconstructRecovery()` result. It must be
    `ok`, at stage `recovered`, `readOnly`, `writersDisabled`, and for the
    same tenant and build. It must carry the verified evidence checkpoint, be
    fresh, and complete before `observedAt`.
  - `prerequisites`: the task-72 harness identity (manifest version and kind
    from `tools/rehearsal/qualification.mjs`) and the task-76 onboarding
    result. Both read setup and restore setup must be `complete`, with their
    setup run ids.
- **Proof is both a signature and an external capture.** Both are required
  whatever the evidence level:
  - a trusted runner signature (HMAC key from `KEEL_QUALIFICATION_HMAC_KEY`,
    never from git);
  - `proof.artifact`, the raw capture file. Its sha256 must verify, it must
    hold this tenant's `recovery-drill` evidence row (seq and record hash),
    and the signed drill record and reconstruction must equal it exactly.

  A `live-qualified` claim from a synthetic record or a fixture runner fails
  even without `--require-live`. A `status: "pending"` record never verifies.
- **Capture path** (`captureDrillLiveAcceptance`, `loadLatestDrillEvidence`,
  CLI `capture-drill`) builds the record from three inputs:
  - the drill's evidence row, from `--drill-row <file>` or the latest
    `recovery-drill` row for `--tenant` in `--db-url`;
  - the reconstruction result (`--reconstruction`);
  - the onboarding result (`--onboarding`).

  It refuses a drill that does not count (an offline plan, failed cleanup,
  exceeded bound and so on) and a reconstruction that did not recover
  read-only. It writes `<out>.capture.json` next to the record and signs with
  the runner identity it is given. The evidence level follows the runner: a
  synthetic runner always yields `fixture-tested`. The capture never runs a
  drill. The live drill stays task-72's
  `--live --confirm-bounded-drill` path, which is unchanged.

No schema or data migration: drill rows are task-72's existing `evidence`
rows. There is no legacy record for this gate. There is no portal surface:
this task names a CLI and verifier only, so `portal/ui-harness` is unchanged.

## Operator steps

The fixture and evidence needed:

1. **Named disposable same-tenant test object.** The drill creates and
   removes exactly one `group:keel-rehearsal-<startAt>` group in the
   Collector's tenant. Its name is fixed by the manifest's `startAt`. No
   existing user, group or policy is touched (sandbox guardrails).
2. **Onboarding confirmation (task-76).** Both setups (read and restore) are
   complete in Settings › Setup. Write `onboarding.json` as
   `{ "readSetup": "complete", "restoreSetup": "complete", "readSetupRunId": "<id>", "restoreSetupRunId": "<id>" }`
   using the run ids shown in the Setup record layer.
3. **Read-only Keel reconstruction (task-68)** from the independent backup
   artifacts, with the deployment's real recovery authenticator. Write the
   `reconstructRecovery()` result, plus `tenantRef`, `buildRevision` (the
   deployed build) and `completedAt` (ISO time), to `reconstruction.json`.
   Only these fields are read: `ok`, `stage`, `readOnly`, `writersDisabled`,
   `recoveryComplete`, `incomplete`, `recovered.evidence`.

Capture (on the release runner, which holds `KEEL_QUALIFICATION_HMAC_KEY`):

```bash
node tools/rehearsal/qualification.mjs --build-manifest --config /etc/keel/tenant.json --out drill.json
node tools/rehearsal/qualification.mjs --manifest drill.json --config /etc/keel/tenant.json \
  --restorer-config /etc/keel/restorer.json --db-url "$KEEL_DB_TEST_URL"          # offline plan check
node tools/rehearsal/qualification.mjs --live --confirm-bounded-drill --manifest drill.json \
  --config /etc/keel/tenant.json --restorer-config /etc/keel/restorer.json --db-url "$KEEL_DB_TEST_URL"
node tools/release/qualification.mjs capture-drill --out docs/release/qualifications/drill-live-acceptance.json \
  --db-url "$KEEL_DB_TEST_URL" --tenant "$KEEL_QUALIFICATION_TENANT_REF" \
  --reconstruction reconstruction.json --onboarding onboarding.json --build "$(git rev-parse HEAD)"
```

Verify (the task's final Validate step):

```bash
KEEL_QUALIFICATION_TENANT_REF=<tenant ref> node tools/release/qualification.mjs verify --require-live \
  --gate drill-live-acceptance --evidence docs/release/qualifications/drill-live-acceptance.json
```

Commit both `drill-live-acceptance.json` and `drill-live-acceptance.capture.json`.
If the drill fails, leaves a residual or exceeds its bound, the capture refuses.
Report that outcome; never edit the record by hand.

## Implementation and proof limitations

- Fixture-tested only. The tests run the real task-72 harness in live mode
  against a fake Graph tenant and the isolated test database, and sign with a
  test-only key. A passing test proves verifier and capture behavior, not
  Microsoft recovery. No signed test record is written to the repository.
- The reconstruction input is the `reconstructRecovery()` result shape. The
  tests use that shape, not a real reconstruction (task-68's own suite covers
  that). The reconstruction CLI prints only counts, so the operator saves the
  programmatic result.
- The onboarding confirmation is the operator's statement of the task-76 run
  ids, signed by the runner. The verifier does not read the setup journal.
- Signature trust is the HMAC key's custody. Anyone holding the release key
  can sign. The capture artifact binds the record to the evidence row's seq
  and record hash, but it does not re-verify the rehearsal database's chain.
- The drill proves one disposable group's round trip on one tenant at one
  time. It is not tenant-wide recovery and not an RTO for real incidents.

## Boundary tests and mutation checks

`engine/roadmap/drill-live-acceptance.test.mjs` (8 tests, in the CI engine
step) covers the acceptance cases:

- a valid independently captured record verifies;
- an altered signature, field, artifact bytes or digest fails, and so does a
  re-signed subject that no longer equals the capture;
- a wrong tenant, build, operation or credential mode fails, including a
  foreign drill row or reconstruction;
- stale evidence fails, and a fresh `observedAt` cannot refresh an old drill
  or reconstruction;
- a missing prerequisite or missing external evidence fails (onboarding,
  harness, drill record, reconstruction, artifact, runner proof, and the
  pending placeholder through both the file and the CLI);
- offline, residual, non-disposable, tenant-wide, over-bound and unobserved
  drills fail, and capture refuses them;
- fixture evidence is never elevated to `live-qualified`;
- the capture and verify CLIs work end to end.

Required mutation checks, each confirmed to fail a test and reverted
(2026-10-03):

| Mutation | Where | Result |
| --- | --- | --- |
| Accept missing external evidence | pending placeholder accepted; separately, missing or unverifiable capture artifact accepted; separately, missing runner proof accepted | 1 test fails each |
| Accept mismatched tenant or operation | operation check removed; separately, the drill record, reconstruction or generic tenant checks removed | 1 test fails each |
| Elevate fixture evidence to live-qualified | capture always writes `live-qualified`, `synthetic: false`; separately, the gate's synthetic live-claim refusal removed | 2 tests and 1 test fail |

## Validation notes (2026-10-03)

The validate command's `node --test` part passes 13/13. It ran with a local
PostgreSQL 16, `KEEL_DB_TEST_URL` and `KEEL_TENANT_CONFIG_PATH` exported
instead of sourcing `/etc/keel/db.env`. The final
`verify --require-live --gate drill-live-acceptance` step exits 1 with
"external execution/cleanup evidence pending". That is the expected result
until the operator steps above produce authentic evidence.
