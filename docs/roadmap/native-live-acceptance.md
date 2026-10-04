# Native recovery credential qualification (roadmap task-115)

Gate: `native-live-acceptance`. Depends on task-64 (native recovery mechanism selection).

## Status — 2026-10-03

**Code half shipped; the gate stays pending live evidence.** The verifier, the
evidence contract, the capture tool and the boundary tests are in place. No
independently captured runner record exists yet, so
`docs/release/qualifications/native-live-acceptance.json` is a
`status: "pending"` placeholder. It fails `verify` with or without
`--require-live`. Nothing in this change marks a native route qualified:
`NATIVE_RECOVERY_ROUTES` in `engine/restore/recoveryMechanism.mjs` is
unchanged, and so is the capability ledger.

### What was built

| Piece | File |
| --- | --- |
| Evidence contract and validator | `engine/restore/nativeRecoveryEvidence.mjs` |
| Gate registration (additive) | `tools/release/qualification.mjs` (`GATE_VALIDATORS['native-live-acceptance']`) |
| Capture tool (offline by default) | `tools/qualification/nativeRecovery.mjs` |
| Pending placeholder | `docs/release/qualifications/native-live-acceptance.json` |
| Boundary tests | `engine/roadmap/native-live-acceptance.test.mjs` (added to CI in `.github/workflows/portal.yml`) |

### The evidence record

A record is a qualification evidence record (contract version 1) with:

- `operation: "native-recovery.live-acceptance"`
- `credentialMode: "restorer"`
- a `subject` holding:
  - `prerequisite`: task-64's retention days and native route names. The
    verifier compares these with the production module, so a record captured
    against a different task-64 fails.
  - `credential`: mode, certificate auth, a config-file **reference** and the
    permissions used. Any key, token, secret or PEM/JWT-shaped value anywhere
    in the record is refused.
  - `bounds`: at most 3 objects and 15 minutes. The capture tool touches 1
    object.
  - `operations`: one entry per route.
    - `automated` entries cover directory soft-delete restore for group, user
      or application. Each must have:
      - a disposable `KEEL-RT-*` / `keel-rehearsal-*` fixture name and its
        object id;
      - `deletedDateTime` and `retentionDeadline`, where the deadline must equal
        `deletedDateTime` + 30 days;
      - `restoredAt` before the deadline;
      - `restoredObjectId` equal to the original id, with `idPreserved: true`;
      - the learn.microsoft.com page checked and its retrieval date, at most 90
        days before capture.
    - Conditional Access policies and named locations must be `manual-handoff`
      entries with a reason. An automated Conditional Access claim is refused
      (operator decision: CA stays manual until its app-only route is
      qualified).
  - `captureSha256`: the digest of the raw capture, inside the signed body.
- `proof.runner`: an HMAC signature by `keel-release-runner`. The key is
  `KEEL_QUALIFICATION_HMAC_KEY` and never in git.
- `proof.artifact`: the raw captured Graph exchanges, cut down to ids, names
  and `deletedDateTime`.

**The runner signature and the artifact are both required for this gate.** The
verifier recomputes the artifact digest and checks that it equals the signed
`captureSha256`. It then checks the artifact itself: it must show the five
exchanges for every automated claim, in this order:

1. `GET` the live object → 200
2. `DELETE` → 204
3. `GET /directory/deletedItems/{id}` → 200, with the same `deletedDateTime`
4. `POST …/restore` → 200, same id
5. read back → 200, same id

The artifact must also carry the same tenant and build as the record.

**What fails:**
- an altered signature or digest;
- a swapped artifact;
- a wrong tenant, build or operation, including a missing expected tenant or
  build;
- a stale observation (default 30 days) or stale documentation;
- a missing or different task-64 prerequisite;
- a missing artifact or signature;
- the pending placeholder;
- a failed or partial run;
- no automated operation;
- a non-fixture object;
- an id that was not preserved;
- a restore after the deadline;
- an automated CA claim;
- exceeded bounds;
- credential material in the record.

**Fixture evidence is never live.** A record with `live-qualified` fails, even
without `--require-live`, when either of these holds:
- it says `synthetic: true` (or anything other than `false`);
- it was signed by the synthetic `keel-fixture-runner`.

The capture tool's offline mode always writes `fixture-tested`,
`synthetic: true`, and signs only as `keel-fixture-runner`.

### Capture tool safety

- **Offline by default.** It uses an in-process fake directory and writes
  nothing anywhere except `--out`.
- **`--live` needs explicit confirmation:** `--confirm-disposable-fixture` must
  equal `--object-id`. It also needs `--target-config`, `--docs-retrieved-at`
  and at least one `--permission`.
- **The object is read first.** Unless its `displayName` (or
  `userPrincipalName` for a user) matches `KEEL-RT-*` / `keel-rehearsal-*`, the
  run is refused before any write.
- **Only group, user or application.** Any other type, including Conditional
  Access, is refused before any write.
- **A failed step stops the run.** The tool records `outcome: "failed"` and
  exits 1, and that record never verifies. If the failure came after the
  delete, the message tells the operator to restore manually within retention.
- **Reads after a write are re-tried, within a bound.** Entra replication lag
  can 404 the deleted-items read and the post-restore read-back for a few
  seconds. Each is read at most 5 times with a 2s, 4s, 6s, 8s backoff. The
  artifact keeps every attempt's status in the exchange's `attempts`; a read
  that still fails after 5 tries stops the run as above.

### Limits

- **Microsoft documentation wasn't checked here.** learn.microsoft.com was not
  reachable from the build environment (egress-blocked on 2026-10-03), so the
  Graph contract was not re-checked here. The runner records the docs URL and
  its retrieval date; the verifier only checks that the URL is a
  learn.microsoft.com page retrieved within 90 days. The contract encoded here
  is the one for Graph v1.0 directory deleted items:
  - `DELETE` returns 204;
  - `GET /directory/deletedItems/{id}` carries `deletedDateTime`;
  - `POST /directory/deletedItems/{id}/restore` returns 200 with the same id;
  - retention is 30 days.

  The operator should confirm it on the live docs page when capturing.
- **Group, user and application only.** The only automated route is directory
  soft-delete restore for these three types. The Conditional Access native
  routes stay manual handoffs.
- **The tests use a stand-in for the tenant.** They drive the capture tool's
  `--live` path against an injected Microsoft-shaped fake, so they prove the
  verifier and the tool's behaviour, not Microsoft support or real recovery.
- **No server or UI surface was added.** The integration for this gate is the
  CLI (capture and `qualification.mjs verify`). Turning verified evidence into
  a qualified route (`NATIVE_RECOVERY_ROUTES` / capability claims) is
  deliberately not automatic. It is a reviewed change after evidence exists.
- **Not all of the Validate command was run.** Its `node --test` part passes
  in this container. The final
  `node tools/release/qualification.mjs verify --require-live …` step was
  **not** run as a qualification, because the evidence file is the pending
  placeholder. Run against it, the step fails with
  `native-live-acceptance external runner evidence pending`, as it should.

## Operator steps

**What is needed**
- One named disposable fixture in the managed tenant: a group whose
  `displayName` starts with `KEEL-RT-`. Recommended:
  `KEEL-RT-native-recovery-group`, a security group with no members and no
  role or app assignments. A `keel-rehearsal-*` group, user or application
  also qualifies. Don't use the Exchange fixture user
  `keel-rt-20260908-alice`: deleting it would disturb task-122.
- The KEEL Restorer credential (`/etc/keel/restorer.json`, certificate
  auth) with `Group.ReadWrite.All`, or the matching permission for the type.
- `KEEL_QUALIFICATION_HMAC_KEY` for the release runner, kept outside git.
- A fresh look at
  <https://learn.microsoft.com/en-us/graph/api/directory-deleteditems-restore?view=graph-rest-1.0>.
  Pass its retrieval date to the capture tool.

**Capture.** This command deletes the fixture group once and restores it from
deleted items. It touches nothing else.

```bash
export KEEL_QUALIFICATION_HMAC_KEY=...   # release runner key, not in git
node tools/qualification/nativeRecovery.mjs capture --live \
  --resource-type group --object-id <fixture-object-id> \
  --confirm-disposable-fixture <fixture-object-id> \
  --target-config /etc/keel/restorer.json \
  --docs-retrieved-at <YYYY-MM-DD> --permission Group.ReadWrite.All \
  --out docs/release/qualifications
```

This writes two files:
- `docs/release/qualifications/native-live-acceptance.json`, replacing the
  pending placeholder;
- `docs/release/qualifications/native-live-acceptance.artifact.json`.

Capture on the commit you will verify against: the record binds to
`git rev-parse HEAD`, or to `--build`.

**Verify.** This is the task's final Validate step:

`verify --require-live` checks the runner signature, so the same key must be
in the environment:

```bash
KEEL_QUALIFICATION_HMAC_KEY=... node tools/release/qualification.mjs verify --require-live \
  --gate native-live-acceptance \
  --evidence docs/release/qualifications/native-live-acceptance.json \
  --tenant <sha256:… tenant ref> --build <commit the capture ran on>
```

`--build` matters once the evidence is committed. Committing moves `HEAD`
past the build the record names, and without `--build` the verifier uses the
current `HEAD`.

Conditional Access stays manual: no capture or verify step changes that.
